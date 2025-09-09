/**
 * ============================================================================
 * --- Main Server File (server.js) ---
 * ============================================================================
 *
 * This file is the central entry point and orchestrator for the snTnz application.
 * Its primary responsibilities include:
 * - Initializing the Express server and Socket.IO.
 * - Establishing a connection to the MongoDB database.
 * - Setting up all essential middleware (security, CORS, logging, rate limiting).
 * - Importing and integrating modularized routes and services (auth, bots, social).
 * - Managing the core real-time game loop and round logic.
 * - Handling all Socket.IO events for client-server communication.
 * - Implementing graceful shutdown procedures.
 */

// ============================================================================
// --- INITIALIZATION & IMPORTS ---
// ============================================================================

// Load environment variables from the .env file into process.env
require('dotenv').config();

// --- Core Node.js & Express Modules ---
const express = require('express');         // The web framework for routing and middleware.
const http = require('http');               // The raw Node.js HTTP server that Express and Socket.IO use.
const { Server } = require('socket.io');    // The real-time WebSocket communication library.
const crypto = require('crypto');           // Node.js module for cryptographic functions like hashing.
const cron = require('node-cron');          // A task scheduler for running jobs at specific times (e.g., sealing chunks).

// --- Security & Utility Modules ---
const helmet = require('helmet');           // Provides important security headers to protect against common vulnerabilities.
const rateLimit = require('express-rate-limit'); // Middleware to limit repeated requests to public APIs.
const cors = require('cors');               // Enables and configures Cross-Origin Resource Sharing.
const pinoHttp = require('pino-http');      // A very fast and efficient JSON logger for HTTP requests.
const passport = require('passport');       // The authentication framework, used here for session management with Socket.IO.
const logger = require('./logger');         // The logging helper

// --- Database Module ---
const { MongoClient, ServerApiVersion } = require('mongodb'); // The official MongoDB driver for Node.js.

// --- Custom Application Modules ---
const constants = require('./constants');   // Centralized application constants and configuration.
const { AllProfanity } = require('allprofanity'); // A library for filtering out offensive words.
const { initializeAuth, createAuthRouter, sessionMiddleware } = require('./auth'); // All user authentication and session logic.
const { initBots, runBotSubmission, generateAndUploadImage, pushBotContext } = require('./bots'); // AI logic for Gemini and Imagen.
const { initSocial, postEverywhere, checkAndRefreshFbLongToken } = require('./social'); // Social media posting logic.

// ============================================================================
// --- CONFIGURATION & SERVER SETUP ---
// ============================================================================

const app = express();
const server = http.createServer(app);

// Optimizes server for faster shutdown under heavy load by setting keep-alive timeouts.
server.keepAliveTimeout = 5000;
server.headersTimeout = 7000;

// When running behind a reverse proxy (like Nginx, Heroku, or Render), this tells
// Express to trust the X-Forwarded-* headers to correctly identify the client's IP.
if (String(process.env.TRUST_PROXY || '') === '1') app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';
const profanityFilter = new AllProfanity();

// Define the allowed origins for CORS. This is a crucial security measure.
const ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Initialize Socket.IO with specific settings for performance and security.
const io = new Server(server, {
  transports: ['websocket'],      // Prioritize pure WebSocket connections for lower latency.
  pingInterval: 25000,            // How often to send a heartbeat ping.
  pingTimeout: 20000,             // How long to wait for a pong response before considering the connection dropped.
  maxHttpBufferSize: 10_000,      // The maximum size of a single message.
  cors: { origin: ORIGINS, methods: ['GET'] } // Enforce CORS for Socket.IO connections.
});

// Use the port assigned by the hosting platform (like Render/Heroku) in production,
// or default to 3000 for local development.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ============================================================================
// --- GLOBAL STATE MANAGEMENT ---
// ============================================================================
// These variables hold the in-memory state of the application.

let currentText = [];               // An array holding the most recent winning words.
let currentWritingStyle = null;     // The current writing style
let liveWords = new Map();          // A map of currently submitted words for the active round.
let nextTickTimestamp = computeNextRoundEndTime(); // The timestamp for when the current round ends.
let botContext = [];                // The context buffer for the Gemini bot.
let botQueue = [];                  // The word queue for the Gemini bot's current sentence.
let shuttingDown = false;           // A flag to prevent multiple shutdown procedures from running.
let botIsWritingChapterTitle = false; // Signals that the bot is currently writing a chapter title.
let botMustStartNewChapter = false; // Signals that the bot must start a new chapter.
let botHasFinishedChapter = false;  // Tracks if the bot has done its job for the current chunk..
let botIsRunning = false;           // A lock to prevent the bot from running multiple times at once.
let mustSeal = false;
const TARGET_CHUNK_WORD_COUNT = Math.floor(((constants.CHUNK_DURATION_MINUTES * 60) / constants.ROUND_DURATION_SECONDS));


// ============================================================================
// --- DATABASE CONNECTION ---
// ============================================================================

const DATABASE_URL = isProduction ? process.env.DATABASE_URL_PROD : process.env.DATABASE_URL_DEV;
if (!DATABASE_URL) {
  logger.error("FATAL: Database URL is not defined. Check your .env file.");
  process.exit(1);
}
const client = new MongoClient(DATABASE_URL, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// These variables will be assigned after the database connection is established.
let usersCollection, wordsCollection, chunksCollection;

/**
 * Establishes a connection to the MongoDB Atlas cluster and initializes
 * collection handles for use throughout the application. Exits if connection fails.
 */
async function connectToDatabase() {
  try {
    await client.connect();
    const db = client.db();
    usersCollection = db.collection('users');
    wordsCollection = db.collection('words');
    chunksCollection = db.collection('chunks');
    logger.info("[db] Successfully connected to MongoDB Atlas!");
  } catch (err) {
    logger.error({ err }, "[db] Failed to connect to MongoDB");
    process.exit(1);
  }
}

// ============================================================================
// --- HELPER FUNCTIONS ---
// ============================================================================

/**
 * Creates a unique, deterministic key for a word based on its content and applied styles.
 * This is used as the key in the `liveWords` map to identify submissions.
 * Example: 'hello-b:false-i:true-u:false-n:false'
 * @param {{word: string, styles: object}} wordData - The word and its styling.
 * @returns {string} A unique composite key.
 */
function getCompositeKey(wordData) {
  const styleKey = `b:${!!wordData.styles.bold}-i:${!!wordData.styles.italic}-u:${!!wordData.styles.underline}-n:${!!wordData.styles.newline}`;
  return `${wordData.word.toLowerCase()}-${styleKey}`;
}

/**
 * Computes the epoch timestamp (in ms) for the next round end, aligned to the
 * official clock boundaries rather than relative to Date.now().
 *
 * @returns {number} Epoch time in milliseconds for the next round end.
 */
function computeNextRoundEndTime() {
  const period = constants.ROUND_DURATION_SECONDS || 60;
  const now = new Date();

  // Start of the *current* minute
  const base = new Date(now);
  base.setSeconds(0, 0);

  // Add periods until strictly in the future
  let candidate = base.getTime();
  while (candidate <= now.getTime()) {
    candidate += period * 1000;
  }
  return Math.floor(candidate);
}


/**
 * Calculates scores for all live words and returns a sorted array for the client.
 * Each client receives a personalized list showing their own vote status.
 * @param {string} [requestingUserId] - The ID of the user requesting the feed, to personalize their vote status.
 * @returns {Array<object>} The sorted live feed state.
 */
function getLiveFeedState(requestingUserId) {
  const feed = [];
  for (const [compositeKey, data] of liveWords.entries()) {
    // Sum all votes (upvotes are 1, downvotes are -1).
    const score = Array.from(data.votes.values()).reduce((acc, vote) => acc + vote, 0);

    // Determine if the requesting user has voted on this item.
    let userVote = null;
    if (requestingUserId && data.votes.has(requestingUserId)) {
      userVote = data.votes.get(requestingUserId) === 1 ? 'up' : 'down';
    }

    feed.push({
      word: data.word,
      styles: data.styles,
      isTitle: data.isTitle || false,
      username: data.submitterName,
      count: score,
      ts: data.ts,
      compositeKey:
      compositeKey,
      userVote: userVote,
    });
  }
  // Sort by score (descending), then by submission time (ascending) as a tie-breaker.
  return feed.sort((a, b) => (a.count !== b.count) ? b.count - a.count : a.ts - b.ts);
}

/**
 * Broadcasts the latest live feed state to all connected clients.
 * This is called whenever a submission or vote changes the state.
 */
function broadcastLiveFeed() {
    for (const [, socket] of io.of("/").sockets) {
        const user = socket.request.user;
        const userId = user ? user.googleId : socket.id;
        socket.emit('liveFeedUpdated', getLiveFeedState(userId));
    }
}

/**
 * Validates a single word submission against a set of rules.
 * @param {string} word - The submitted word.
 * @returns {{ valid: boolean, reason?: string }} An object indicating validity and an optional failure reason.
 */
function validateSubmission(word) {
  if (typeof word !== 'string') return { valid: false, reason: 'Invalid input' };
  word = word.trim();
  if (word.length === 0 || word.length > constants.INPUT_MAX_CHARS) {
    return { valid: false, reason: '1–25 chars only' };
  }
  const punctuationRegex = new RegExp(constants.PUNCTUATION_REGEX_STRING);
  if (!punctuationRegex.test(word)) return { valid: false, reason: 'No spaces or misplaced punctuation' };
  if (profanityFilter.check(word)) {
    return { valid: false, reason: 'Offensive words are not allowed' };
  }
  return { valid: true };
}

/**
 * Calculates the number of minutes until the next scheduled event based on a cron string.
 * @param {string} cronSchedule - The cron schedule string.
 * @returns {number} The whole number of minutes until the next seal.
 */
function calculateMinutesUntilNextSeal(cronSchedule) {
  const parts = cronSchedule.split(' ');
  const minutePart = parts[0];
  const hourPart = parts[1];
  const now = new Date();

  const nextSealDate = new Date();
  nextSealDate.setSeconds(0, 0);

  if (minutePart.startsWith('*/')) {
    const interval = parseInt(minutePart.substring(2), 10);
    const remainder = now.getMinutes() % interval;
    nextSealDate.setMinutes(now.getMinutes() + (interval - remainder));
  } else {
    const scheduledMinute = parseInt(minutePart, 10);
    const scheduledHours = hourPart.split(',').map(h => parseInt(h, 10)).sort((a, b) => a - b);
    let nextHour = scheduledHours.find(h => h > now.getHours() || (h === now.getHours() && scheduledMinute > now.getMinutes()));

    if (nextHour !== undefined) {
        nextSealDate.setHours(nextHour, scheduledMinute);
    } else {
        nextSealDate.setDate(now.getDate() + 1);
        nextSealDate.setHours(scheduledHours[0], scheduledMinute);
    }
  }

  const diffMs = nextSealDate - now;
  return Math.ceil(diffMs / (1000 * 60)); // Return minutes, rounded up.
}

// ============================================================================
// --- CORE GAME & HISTORY LOGIC ---
// ============================================================================

/**
 * @summary Ends the current round, elects a winning word, and saves it to the database.
 * @description This function is the heart of the round transition. It determines the winner,
 * updates the story, and prepares the game for the next round.
 */
async function endRoundAndElectWinner() {
  // 1. Immediately schedule the next round's end time.
  nextTickTimestamp = computeNextRoundEndTime();
  io.emit('nextTick', { nextTickTimestamp });

  // 2. Capture and clear the live submissions.
  const finalLiveFeed = getLiveFeedState();
  liveWords.clear();
  broadcastLiveFeed();

  // 3. Determine the winner and the previous word.
  const winner = finalLiveFeed.find(item => item.count > 0);
  const lastWinningWord = currentText.length > 0 ? currentText[currentText.length - 1] : null;

  // 5. Process the winner, if one exists.
  if (winner) {

    // Rule 1: Force a newline after a chapter title.
    if (lastWinningWord && lastWinningWord.isTitle) {
      if (!winner.styles) winner.styles = {};
      winner.styles.newline = true;
    }

    // Rule 2: Automatically capitalize a new sentence.
    const lastWordText = lastWinningWord ? lastWinningWord.word : '';
    if (!lastWordText || /[.!?]$/.test(lastWordText)) {
      winner.word = winner.word.charAt(0).toUpperCase() + winner.word.slice(1);
    }

    const totalVotes = finalLiveFeed.reduce((acc, item) => acc + Math.max(0, item.count), 0);
    const winnerRow = {
      ts: Date.now(), word: winner.word, styles: winner.styles, isTitle: winner.isTitle || false,
      username: winner.username, pct: totalVotes > 0 ? (winner.count / totalVotes) * 100 : 0,
      count: winner.count, total: totalVotes, chunkId: null
    };

    // 6. Save to database and update in-memory state.
    try {
      await wordsCollection.insertOne(winnerRow);
      currentText.push(winnerRow);
      if (currentText.length > constants.CURRENT_TEXT_LENGTH) currentText.shift();
      botContext = pushBotContext(winner.word, botContext);
      io.emit('currentTextUpdated', currentText);
    } catch (err) {
      logger.error({ err }, "[db] Failed to save word to database");
    }

    // 7. Unlock for users if the bot was writing a title
    // The lock is released only if it was ON, the last word was a title,
    // and a new winner exists that is NOT a title word.
    if (botIsWritingChapterTitle && winner.isTitle) {
      botIsWritingChapterTitle = false;
      logger.info('[server] Title sequence complete. Releasing user submission lock.');
    }

    // 8. If the winner is not the bot, clear the bot's queue so it doesn't keep a stale plan.
    if (winner.username !== constants.BOT_NAME) {
      logger.info({}, '[bot] A user won the round. Clearing bot queue and allowing a fresh turn.');
      botQueue = [];
      botHasFinishedChapter = false;
    }
    logger.info({winner: winner.word}, '[server] A word has been chosen.');
  }

  // After finishing the round, run sealing if scheduled
  if (mustSeal) {
    mustSeal = false;
    await sealNewChunk();
  }
}

/**
 * @summary Archives un-chunked words into a new, permanent chunk document with a generated image.
 * @description This function runs on a schedule. It uses a two-phase process to atomically
 * claim unsealed words before processing them, preventing race conditions with the history API.
 */
async function sealNewChunk() {
  let claimedWordsCount = 0;

  try {
    // ------------------------------------------------------------------------
    // LOCK DURING SEAL
    // Prevent user submissions while we seal and prepare the next chapter title.
    // ------------------------------------------------------------------------
    botIsWritingChapterTitle = true;
    logger.info('[history] Sealing new chunk: User submissions are now locked.');
    io.emit('imageGenerationStarted');

    // ------------------------------------------------------------------------
    // PHASE 2: FETCH PENDING WORDS (ordered)
    // Grab all words that haven’t yet been sealed (chunkId: null).
    // ------------------------------------------------------------------------
    let wordsToChunk = await wordsCollection
      .find({ chunkId: null })
      .sort({ ts: 1 })
      .toArray();

    claimedWordsCount = wordsToChunk.length;
    if (claimedWordsCount === 0) {
      logger.info('[history] No words to seal, skipping.');
      return;
    }

    // ------------------------------------------------------------------------
    // PHASE 3: BUILD CHUNK METADATA (hash, text, title)
    // ------------------------------------------------------------------------
    const dataToHash = JSON.stringify(wordsToChunk);
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');

    const chunkText = wordsToChunk.reduce((acc, w) => {
      const sep = w.styles?.newline ? '\n' : (acc ? ' ' : '');
      return acc + sep + w.word;
    }, '').trim();

    // Extract title from the first word if flagged as title
    let chunkTitle = 'Untitled';
    if (wordsToChunk[0].isTitle && wordsToChunk[0].word.startsWith('Chapter')) {
      chunkTitle = wordsToChunk[0].word;
    }

    // ------------------------------------------------------------------------
    // PHASE 4: OPTIONAL IMAGE GENERATION & CROSS-POST
    // ------------------------------------------------------------------------
    let imageUrl = null;
    if (isProduction) {
      imageUrl = await generateAndUploadImage(chunkText, isProduction);
    }

    const newChunk = {
      ts: wordsToChunk[0].ts, // timestamp of first word
      hash,
      title: chunkTitle,
      text: chunkText,
      words: wordsToChunk,
      imageUrl,
      style: currentWritingStyle ? currentWritingStyle.name : 'User-Initiated',
    };

    if (newChunk.imageUrl && isProduction) {
      const shareableUrl = `https://www.sntnz.com/chunk/${newChunk.hash}`;
      const crossText = `${newChunk.text.substring(0, 180)}...\n\nRead more at:\n${shareableUrl}`;
      await postEverywhere(crossText, newChunk.imageUrl, isProduction);
    }

    // ------------------------------------------------------------------------
    // PHASE 5: SAVE CHUNK & FINALIZE WORDS
    // ------------------------------------------------------------------------
    const insertedChunk = await chunksCollection.insertOne(newChunk);
    const newChunkId = insertedChunk.insertedId;

    await wordsCollection.updateMany(
      { _id: { $in: wordsToChunk.map(w => w._id) } },
      { $set: { chunkId: newChunkId } }
    );

    if (newChunk.imageUrl) {
      io.emit('newImageSealed', { imageUrl: newChunk.imageUrl });
    }

    logger.info({ chunkHash: hash.substring(0, 12) }, '[history] Successfully sealed chunk');

    // ------------------------------------------------------------------------
    // PHASE 6: ENTER TITLE MODE & INVALIDATE STALE BOT WORK
    // ------------------------------------------------------------------------
    botMustStartNewChapter = true;
    botHasFinishedChapter = false;
    botIsWritingChapterTitle = true; // stays true until endRound unlocks
    botQueue = [];
    botGenEpoch = (typeof botGenEpoch === 'number' ? botGenEpoch + 1 : 1);

  } catch (err) {
    // ------------------------------------------------------------------------
    // ERROR HANDLING: ROLLBACK CLAIMS
    // ------------------------------------------------------------------------
    logger.error({ err }, '[history] Error sealing new chunk');

    if (claimedWordsCount > 0) {
      await wordsCollection.updateMany(
        { chunkId: null },
        { $set: { chunkId: null } }
      );
      logger.warn(`[history] Rolled back ${claimedWordsCount} words from processing state.`);
    }

  } finally {
    // ------------------------------------------------------------------------
    // SIGNAL BOT STATE (post-attempt)
    // ------------------------------------------------------------------------
    botMustStartNewChapter = true;
    botHasFinishedChapter = false;
    currentWritingStyle = null;
    // Do NOT reset botIsWritingChapterTitle here; it will be released in endRound
  }
}



/**
 * Loads the most recent words from the database on server startup
 * to populate the in-memory `currentText` array.
 */
async function loadInitialTextFromHistory() {
  logger.info('[history] Loading initial text from database...');
  try {
    const recentWords = await wordsCollection.find().sort({ ts: -1 }).limit(constants.CURRENT_TEXT_LENGTH).toArray();
    currentText = recentWords.reverse();
    logger.info({ wordCount: currentText.length }, '[history] Successfully loaded live words');
    currentText.forEach(w => {
      botContext = pushBotContext(w.word, botContext);
    });
  } catch (error) {
    logger.error({ err: error }, '[history] Failed to load initial text');
  }
}

// ============================================================================
// --- GAME LOOP ---
// ============================================================================
// This interval is the main heartbeat of the application.
setInterval(() => {
  const now = Date.now();
  const remainingMs = nextTickTimestamp - now;
  if (!Number.isFinite(remainingMs)) return;

  // --- Bot Trigger Logic ---
  // Calculate round timing to trigger the bot at the halfway point.
  const roundDurationMs = constants.ROUND_DURATION_SECONDS * 1000;
  const timeElapsedInRound = roundDurationMs - remainingMs;
  const isPastHalfway = timeElapsedInRound >= (roundDurationMs / 2);

  // Check if any users have submitted. The bot only acts if the round is empty.
  const noUsersHaveSubmitted = liveWords.size === 0;

  // Check if the bot already has a submission in the current live round.
  const botHasAlreadySubmitted = Array.from(liveWords.values()).some(sub => sub.submitterName === constants.BOT_NAME);

  // The bot should run immediately if we just sealed a chunk and need a title,
  // otherwise it falls back to the usual halfway trigger.
  const shouldRunImmediatelyForTitle = botMustStartNewChapter && !botHasFinishedChapter;

  // Run if (A) we need a title right now OR (B) the usual halfway/no-user-submission rule.
  if (!botIsRunning && (shouldRunImmediatelyForTitle || (isPastHalfway && noUsersHaveSubmitted && !botHasAlreadySubmitted))) {
    // Set the lock immediately to prevent re-entry.
    botIsRunning = true;

    Promise.all([
        // Query 1: Get all words that have not yet been sealed into a permanent chunk.
        // This represents the current, live portion of the story.
        wordsCollection.find({ chunkId: null }).sort({ ts: 1 }).toArray(),

        // Query 2: Get a total count of all previously sealed chunks (chapters).
        chunksCollection.countDocuments(),

        // Query 3: Get the text of the last 50 chunks to check for recent titles.
        chunksCollection.find({}, { projection: { text: 1 } }).sort({ ts: -1 }).limit(50).toArray()

    ]).then(([currentChunkWords, totalChunkCount, recentChunks]) => {
      // This block executes after all three database queries are complete.

      // Immediately set the lock for users if no words have been submitted, meaning the bot will
      botIsWritingChapterTitle = shouldRunImmediatelyForTitle;

      // Extract just the titles from the raw chunk text using a regular expression.
      // This creates a list for the bot to check against to avoid duplicate titles.
      const recentTitles = recentChunks.map(chunk => chunk.title).filter(Boolean);

      // Set a default target word count for the bot.
      let dynamicTargetWordCount = TARGET_CHUNK_WORD_COUNT;

      // If the server signals that a new chapter must start (e.g., after a seal),
      // calculate the target word count dynamically based on the actual time remaining.
      if (botMustStartNewChapter || currentChunkWords.length === 0) {
        const minutesRemaining = calculateMinutesUntilNextSeal(constants.HISTORY_CHUNK_SCHEDULE_CRON);
        // The formula converts remaining minutes into a word count, applying a 10% safety margin.
        dynamicTargetWordCount = Math.floor(((minutesRemaining * 60) / constants.ROUND_DURATION_SECONDS) * 0.8);
      }

      // Bundle all current game data and flags into a single state object.
      // This object will be passed to the main bot logic function.
      const botState = {
          liveWords,
          currentText,
          botContext,
          botQueue,
          profanityFilter,
          broadcastLiveFeed,
          getCompositeKey,
          currentWritingStyle,
          currentChunkWords,
          totalChunkCount,
          botMustStartNewChapter,
          botHasFinishedChapter,
          recentTitles,
          dynamicTargetWordCount
      };

      // Call the bot's main logic function with the prepared state and chain the promise.
      return runBotSubmission(botState);
    })
    .then(result => {
        // This block runs only after the bot's async 'runBotSubmission' function has finished.
        // It synchronizes the main server's state with the results of the bot's actions.
        botQueue = result.botQueue;
        botMustStartNewChapter = result.botMustStartNewChapter;
        botHasFinishedChapter = result.botHasFinishedChapter;
        currentWritingStyle = result.currentWritingStyle;
    })
    .catch(err => {
        logger.error({ err }, '[bot] Failed to fetch state for bot submission');
    })
    .finally(() => {
        // Whether it succeeded or failed, release the lock so the bot can run in a future round.
        botIsRunning = false;
    });
  }

  // --- Round Ending Logic ---
  if (remainingMs <= 0) {
    endRoundAndElectWinner();
  }
}, 500);

// ============================================================================
// --- SERVER SETUP & MIDDLEWARE ---
// ============================================================================

// Logger for all HTTP requests, with custom serializers for cleaner output.
app.use(pinoHttp({
  logger,
  autoLogging: {
    // This rule still ignores the noisy Chrome DevTools requests
    ignore: (req) => req.url.includes('.well-known'),
  },
  // Add this 'serializers' block to control what gets logged
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
}));


app.use(helmet({    // Security headers.
    hsts: false, crossOriginResourcePolicy: false,
    contentSecurityPolicy: { directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://www.googletagmanager.com", "'sha256-OA2+WwO3QgUk7M9ZSzbg29s8IVv30EukCadh8Y7SQYw='"],
        "connect-src": ["'self'", "https://region1.google-analytics.com"],
        "img-src": ["'self'", "data:", "lh3.googleusercontent.com", "storage.googleapis.com"],
    }},
}));
app.use(cors({ origin(origin, cb) { cb(null, !origin || ORIGINS.includes(origin)); } })); // CORS policy.
app.use(express.json({ limit: '2kb' })); // JSON body parser with size limit.
app.use(express.urlencoded({ extended: false, limit: '2kb' })); // URL-encoded body parser.

// Rate limit public APIs to prevent abuse.
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(['/config', '/api', '/history', '/chunk'], apiLimiter);

// Session and Passport middleware must come before routes that use them.
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// ============================================================================
// --- HTTP ROUTES ---
// ============================================================================

// Health check endpoint for uptime monitors.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
// Endpoint for the client to fetch shared constants.
app.get('/config', (_req, res) => res.json(constants));

// --- Auth & User Routes ---
// The auth module provides a router for all user-related endpoints.
// We pass it the users collection so it can interact with the database.
app.use('/', createAuthRouter());

// --- History & Chunk API Routes ---
// These routes allow the client to fetch historical data.

/**
 * GET /api/history/before
 * -----------------------
 * Fetches a batch of words from before a given timestamp for infinite scroll.
 * Returns data grouped by chunks, including image URLs.
 */
app.get('/api/history/before', async (req, res) => {
  try {
    const oldestTimestamp = parseInt(req.query.ts, 10);
    const limit = parseInt(req.query.limit, 10) || 50;

    if (isNaN(oldestTimestamp)) {
      return res.status(400).json({ error: 'Invalid timestamp provided.' });
    }

    // 1. Find the older words as before.
    const olderWords = await wordsCollection.find({ ts: { $lt: oldestTimestamp } })
      .sort({ ts: -1 })
      .limit(limit)
      .toArray();

    if (olderWords.length === 0) {
      return res.json([]); // No more history, return empty array.
    }

    // 2. Get the unique, non-null chunk IDs from these words.
    const chunkIds = [...new Set(olderWords.map(w => w.chunkId).filter(id => id))];

    // 3. Fetch the corresponding chunks to get their image URLs.
    const chunks = await chunksCollection.find({ _id: { $in: chunkIds } }).toArray();
    const chunkMap = new Map(chunks.map(c => [c._id.toString(), c]));

    // 4. Group the words by their chunkId.
    const groupedByChunk = olderWords.reduce((acc, word) => {
      const id = word.chunkId ? word.chunkId.toString() : 'unsealed';
      if (!acc[id]) acc[id] = [];
      acc[id].push(word);
      return acc;
    }, {});

    // 5. Build the final structured response.
    const responseData = Object.keys(groupedByChunk).map(chunkId => {
      const chunkInfo = chunkMap.get(chunkId);
      return {
        // Reverse words to be in chronological order for prepending on the client
        words: groupedByChunk[chunkId].reverse(),
        // Add imageUrl if the chunk exists and has one
        imageUrl: chunkInfo ? chunkInfo.imageUrl : null,
      };
    }).reverse(); // Reverse the chunks themselves to maintain chronological order

    res.json(responseData);

  } catch (error) {
    console.error('[api] Error fetching older history:', error);
    res.status(500).json({ error: 'Failed to retrieve history.' });
  }
});

/**
 * GET /api/history/dates
 * ----------------------
 * Returns a sorted list of unique dates for which history chunks are available in the database.
 */
app.get('/api/history/dates', async (req, res) => {
  try {
    // This query finds all chunks, groups them by their UTC date, and returns the unique dates.
    const dates = await chunksCollection.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: { $toDate: "$ts" } } }
        }
      },
      { $sort: { _id: -1 } } // Sort dates newest to oldest
    ]).toArray();

    // Extract just the date strings from the result
    const dateStrings = dates.map(d => d._id);
    res.json(dateStrings);
  } catch (err) {
    console.error('[api] Failed to get history dates from DB:', err);
    res.status(500).json({ error: 'Could not list history dates.' });
  }
});

/**
 * GET /api/history/:date
 * ----------------------
 * Returns an array of history chunks for a specific date.
 * This now includes both sealed chunks and a "live" chunk of unsealed words.
 */
app.get('/api/history/:date', async (req, res) => {
  const { date } = req.params;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  if (!dateRegex.test(date)) {
    return res.status(400).send('Invalid date format. Use YYYY-MM-DD.');
  }

  try {
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    // Query 1: Get all permanently sealed chunks for the given date.
    const sealedChunks = await chunksCollection.find({
      ts: {
        $gte: startOfDay.getTime(),
        $lte: endOfDay.getTime(),
      },
    }).sort({ ts: 1 }).toArray();

    // Query 2: Get all unsealed words for the given date.
    const unsealedWords = await wordsCollection.find({
      chunkId: null,
      ts: {
        $gte: startOfDay.getTime(),
        $lte: endOfDay.getTime(),
      }
    }).sort({ ts: 1 }).toArray();

    let allChunks = [...sealedChunks];

    // If there are unsealed words, package them into a temporary "live" chunk.
    if (unsealedWords.length > 0) {
      const liveChunk = {
        ts: unsealedWords[0].ts, // Timestamp of the first word in the series
        hash: 'Pending...',      // A placeholder hash
        text: unsealedWords.map(w => w.word).join(' '),
        words: unsealedWords,
        isLive: true           // A flag for the front-end to identify this chunk
      };
      allChunks.push(liveChunk);
    }

    res.json(allChunks);
  } catch (error) {
    console.error(`[api] Error reading history for ${date}:`, error);
    res.status(500).json({ error: 'Failed to retrieve history.' });
  }
});

/**
 * GET /chunk/:hash
 * ----------------
 * Provides a canonical, shareable URL for a single chunk.
 * - For social media crawlers, it serves an HTML page with Open Graph meta tags.
 * - For regular users, it redirects to the correct daily history page with a
 * URL fragment to scroll the user to the specific chunk.
 */
app.get('/chunk/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    if (!hash || hash.length !== 64) { // SHA-256 hashes are 64 hex characters
      return res.status(400).send('Invalid chunk hash.');
    }

    // 1. Find the chunk in the database using its unique hash.
    const chunk = await chunksCollection.findOne({ hash });

    if (!chunk) {
      return res.status(404).send('Chunk not found.');
    }

    // 2. Check the User-Agent to see if the visitor is a social media crawler.
    const userAgent = req.headers['user-agent'] || '';
    const isCrawler = /facebookexternalhit|Twitterbot|Discordbot|LinkedInBot|Pinterest/i.test(userAgent);

    if (isCrawler) {
      // 3. If it's a crawler, serve a minimal HTML page with meta tags for the preview.
      console.log(`[share] Crawler detected (${userAgent}), serving meta tags for chunk ${hash.substring(0,12)}.`);
      const title = `snTnz Story Chunk`;
      const description = `"${chunk.text.substring(0, 150)}..."`;
      const url = `${req.protocol}://${req.get('host')}/chunk/${hash}`;

      res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>${title}</title>
          <meta name="description" content="${description}">
          <meta property="og:type" content="website">
          <meta property="og:url" content="${url}">
          <meta property="og:title" content="${title}">
          <meta property="og:description" content="${description}">
          <meta property="og:image" content="${chunk.imageUrl}">
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:url" content="${url}">
          <meta name="twitter:title" content="${title}">
          <meta name="twitter:description" content="${description}">
          <meta name="twitter:image" content="${chunk.imageUrl}">
        </head>
        <body>
          <h1>${title}</h1>
          <p>${chunk.text}</p>
          <img src="${chunk.imageUrl}" alt="AI generated image for chunk">
        </body>
        </html>
      `);
    } else {
      // 4. If it's a regular user, redirect them to the correct history page.
      const date = new Date(chunk.ts);
      const dateString = date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
      const redirectUrl = `/history.html?date=${dateString}#${chunk.hash}`;

      console.log(`[share] User detected, redirecting to: ${redirectUrl}`);
      res.redirect(302, redirectUrl);
    }

  } catch (error) {
    console.error('[share] Error handling chunk request:', error);
    res.status(500).send('Internal Server Error');
  }
});

// --- Static Files ---
// Serves the client-side HTML, CSS, and JavaScript files from the 'public' directory.
// This should come after all API routes.
app.use(express.static(require('path').join(__dirname, 'public')));


// ============================================================================
// --- SOCKET.IO EVENT HANDLERS ---
// ============================================================================

// A helper to adapt Express middleware for use with Socket.IO.
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);
// Share the Express session and Passport context with Socket.IO.
io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));

// This block handles the main lifecycle of a client's real-time connection.
io.on('connection', async (socket) => {
  logger.info('A user connected');
  const user = socket.request.user;
  const userId = user ? user.googleId : socket.id;

  // Send the initial state to the newly connected client.
  const recentWords = await wordsCollection.find().sort({ ts: -1 }).limit(constants.CURRENT_TEXT_LENGTH).toArray();
  const initialChunks = [{
      words: recentWords.reverse(),
      // We can use the timestamp of the last word as a stand-in for the chunk's timestamp
      ts: recentWords.length > 0 ? recentWords[recentWords.length - 1].ts : Date.now(),
  }];
  const latestChunkWithImage = await chunksCollection.findOne({ imageUrl: { $exists: true, $ne: null } }, { sort: { ts: -1 } });

  socket.emit('initialState', {
    initialChunks,
    liveSubmissions: getLiveFeedState(userId),
    nextTickTimestamp,
    latestImageUrl: latestChunkWithImage?.imageUrl || null
  });

  // Handles a client joining the history room for real-time updates.
  socket.on('joinHistoryRoom', () => socket.join('history-room'));

  // Handles a new word submission from a client.
  socket.on('wordSubmitted', (wordData) => {
    const validation = validateSubmission(wordData.word);
    if (!validation.valid) return socket.emit('submissionFailed', { message: validation.reason });

    const user = socket.request.user;
    const userId = user ? user.googleId : socket.id;
    const username = user ? user.username : 'anonymous';

    // Prevent from submitting if the bot is writing the chapter title.
    if (botIsWritingChapterTitle) {
      return socket.emit('submissionFailed', { message: 'Please wait for the bot to finish the next chapter title.' });
    }

    // Remove the user's previous submission before adding the new one.
    for (const [key, entry] of liveWords.entries()) {
      if (entry.submitterId === userId) {
        liveWords.delete(key);
        break;
      }
    }

    const compositeKey = getCompositeKey(wordData);
    if (!liveWords.has(compositeKey)) {
      liveWords.set(compositeKey, {
        word: wordData.word, styles: wordData.styles,
        submitterId: userId, submitterName: username,
        ts: Date.now(), votes: new Map(),
      });
    }
    // A submission always counts as an upvote from the submitter.
    liveWords.get(compositeKey).votes.set(userId, 1);
    broadcastLiveFeed();
  });

  // Handles an upvote or downvote from a client.
  socket.on('castVote', ({ compositeKey, direction }) => {
    const wordEntry = liveWords.get(compositeKey);
    // Users cannot vote on their own words.
    if (!wordEntry || wordEntry.submitterId === userId) return;

    const currentVote = wordEntry.votes.get(userId) || 0;
    let newVote = 0;
    if (direction === 'up') newVote = (currentVote === 1) ? 0 : 1; // Toggle upvote
    else if (direction === 'down') newVote = (currentVote === -1) ? 0 : -1; // Toggle downvote

    if (newVote === 0) wordEntry.votes.delete(userId); // Remove vote if toggled off
    else wordEntry.votes.set(userId, newVote);

    broadcastLiveFeed();
  });

  socket.on('disconnect', () => logger.info('A user disconnected'));
});

// ============================================================================
// --- SERVER START & SHUTDOWN ---
// ============================================================================

/**
 * Initializes all necessary components and starts the server.
 */
async function startServer() {
  await connectToDatabase();
  initializeAuth(usersCollection); // Pass the users collection to the auth module.
  initBots();
  initSocial();
  await loadInitialTextFromHistory();

  // Schedule the daily chunk sealing job.
  cron.schedule(constants.HISTORY_CHUNK_SCHEDULE_CRON, () => {
    logger.info('[history] Seal scheduled at next round end');
    mustSeal = true;
  });

  // Schedule the daily Facebook token refresh check.
  cron.schedule(constants.FB_USER_TOKEN_REFRESH_SCHEDULE_CRON, () => {
    logger.info('[cron] Trigger: checking FB token...');
    checkAndRefreshFbLongToken(7, isProduction).catch(err => {
      logger.error({ err }, '[cron] Token refresh failed');
    });
  }, { scheduled: true, timezone: 'Europe/Paris' });

  // Start listening for connections.
  server.listen(PORT, () => logger.info({ port: PORT }, 'Server is running'));
}

/**
 * @summary Gracefully stops the server upon receiving an OS signal (e.g., Ctrl+C).
 * @description Ensures a clean shutdown by closing servers and attempting a final data save.
 * @param {string} sig - The name of the OS signal that triggered the shutdown.
 */
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal: sig }, '[shutdown] Received signal');

  // Stop taking new work.
  io.close(() => logger.info('[shutdown] sockets closed'));
  server.close(() => logger.info('[shutdown] http server closed'));

  // Attempt to seal any remaining words into a final chunk.
  try {
    logger.info('[shutdown] Attempting to seal final chunk...');
    await sealNewChunk();
  } catch (err) {
    logger.error({ err }, '[shutdown] Final chunk seal failed');
  }

  // Set a timeout to force exit if shutdown hangs.
  setTimeout(() => {
    logger.warn('[shutdown] Graceful shutdown timed out. Exiting.');
    process.exit(0);
  }, 5000);
}

// Listen for shutdown signals.
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer();