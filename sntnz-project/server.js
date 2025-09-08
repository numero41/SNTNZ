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

let currentText = [];             // An array holding the most recent winning words.
let liveWords = new Map();        // A map of currently submitted words for the active round.
let nextTickTimestamp = Date.now() + (constants.ROUND_DURATION_SECONDS * 1000); // The timestamp for when the current round ends.
let lastBotPostTimestamp = 0;     // Tracks when the bot last submitted a word to manage its cooldown.
let botContext = [];              // The context buffer for the Gemini bot.
let botQueue = [];                // The word queue for the Gemini bot's current sentence.
let shuttingDown = false;         // A flag to prevent multiple shutdown procedures from running.

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
      word: data.word, styles: data.styles, username: data.submitterName,
      count: score, ts: data.ts, compositeKey: compositeKey, userVote: userVote,
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


// ============================================================================
// --- CORE GAME & HISTORY LOGIC ---
// ============================================================================

/**
 * @summary Ends the current round, elects a winning word, and saves it to the database.
 * @description This function is the heart of the round transition. It determines the winner,
 * updates the story, and prepares the game for the next round.
 */
async function endRoundAndElectWinner() {
  // 1. Immediately schedule the next round's end time for UI responsiveness.
  nextTickTimestamp = Date.now() + (constants.ROUND_DURATION_SECONDS * 1000);
  io.emit('nextTick', { nextTickTimestamp });

  // 2. Capture the final state of the round that just ended.
  const finalLiveFeed = getLiveFeedState();

  // 3. Clear the live submissions for the new round and broadcast the empty state.
  liveWords.clear();
  broadcastLiveFeed();

  // 4. Determine the winner from the captured state. A winner must have a positive score.
  const winner = finalLiveFeed.find(item => item.count > 0);

  // 5. Process the winner, if one exists.
  if (winner) {
    // Automatically capitalize the word if it's the start of a new sentence.
    const lastWord = currentText.length > 0 ? currentText[currentText.length - 1].word : '';
    if (!lastWord || /[.!?]$/.test(lastWord)) {
      winner.word = winner.word.charAt(0).toUpperCase() + winner.word.slice(1);
    }
    const totalVotes = finalLiveFeed.reduce((acc, item) => acc + Math.max(0, item.count), 0);
    const winnerRow = {
      ts: Date.now(),
      word: winner.word, styles: winner.styles, username: winner.username,
      pct: totalVotes > 0 ? (winner.count / totalVotes) * 100 : 0,
      count: winner.count, total: totalVotes, chunkId: null
    };

    // 6. Save to database and update in-memory state.
    try {
      await wordsCollection.insertOne(winnerRow);
      currentText.push(winnerRow);
      if (currentText.length > constants.CURRENT_TEXT_LENGTH) currentText.shift();
      botContext = pushBotContext(winner.word, botContext);
      // Notify clients subscribed to history updates.
      io.to('history-room').emit('liveHistoryUpdate', winnerRow);
      io.emit('currentTextUpdated', currentText);
    } catch (err) {
      logger.error({ err }, "[db] Failed to save word to database");
    }
  }

  // 7. Check if the bot's submission lost. If so, clear its queue to force a new sentence.
  const botSubmittedWord = finalLiveFeed.find(item => item.username === constants.BOT_NAME);
  if (botSubmittedWord && (!winner || winner.username !== constants.BOT_NAME)) {
    logger.info('[bot] Submission was not chosen. Clearing sentence queue.');
    botQueue = [];
  }
}

/**
 * @summary Archives un-chunked words into a new, permanent chunk document with a generated image.
 * @description This function runs on a schedule (e.g., daily). It gathers all words written
 * since the last chunk, generates an AI image for them, saves them as a permanent "chunk"
 * in the database, and cross-posts the result to social media.
 */
async function sealNewChunk() {
  try {
    const wordsToChunk = await wordsCollection.find({ chunkId: null }).sort({ ts: 1 }).toArray();

    // Only create a chunk if there's a meaningful amount of text.
    if (wordsToChunk.length < constants.BOT_SENTENCE_MIN_WORDS) {
      logger.info({ wordsPending: wordsToChunk.length, min: constants.BOT_SENTENCE_MIN_WORDS }, '[history] Not enough words to seal chunk');
      return;
    }
    logger.info({ wordCount: wordsToChunk.length }, '[history] Sealing new chunk');
    io.emit('imageGenerationStarted'); // Notify clients that an image is being created.

    // Create a unique, verifiable hash for the chunk's content.
    const dataToHash = JSON.stringify(wordsToChunk);
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');
    const chunkText = wordsToChunk.map(w => w.word).join(' ');

    // Generate the image and create the new chunk document.
    const imageUrl = await generateAndUploadImage(chunkText, isProduction);
    const newChunk = { ts: wordsToChunk[0].ts, hash, text: chunkText, words: wordsToChunk, imageUrl };

    // If image generation was successful, post to social media (only in production mode).
    if (newChunk.imageUrl && isProduction) {
      const shareableUrl = `https://www.sntnz.com/chunk/${newChunk.hash}`;
      const crossText = `${newChunk.text.substring(0, 250)}...\n\n${shareableUrl}`;
      await postEverywhere(crossText, newChunk.imageUrl, isProduction);
    }

    // Save the new chunk to the 'chunks' collection and update the original words.
    const insertedChunk = await chunksCollection.insertOne(newChunk);
    const newChunkId = insertedChunk.insertedId;
    await wordsCollection.updateMany({ _id: { $in: wordsToChunk.map(w => w._id) } }, { $set: { chunkId: newChunkId } });

    if (newChunk.imageUrl) io.emit('newImageSealed', { imageUrl: newChunk.imageUrl });
    logger.info({ chunkHash: hash.substring(0, 12) }, '[history] Successfully sealed chunk');
  } catch (err) {
    logger.error({ err }, '[history] Error sealing new chunk');
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
  const botPostInterval = (constants.BOT_INTERVAL_MINUTES || 3) * 60 * 1000;
  const timeSinceLastBotPost = now - lastBotPostTimestamp;
  const botHasAlreadySubmitted = Array.from(liveWords.values()).some(sub => sub.submitterName === constants.BOT_NAME);

  // The bot runs only if its cooldown has passed, no humans have submitted, and it hasn't already submitted.
  if (timeSinceLastBotPost > botPostInterval && liveWords.size === 0 && !botHasAlreadySubmitted) {
    runBotSubmission({
        liveWords, currentText, botContext, botQueue, profanityFilter,
        broadcastLiveFeed, getCompositeKey
    }).then(result => {
        botQueue = result.botQueue; // Update server's botQueue state from the bot's operation.
    });
    lastBotPostTimestamp = now; // Reset the bot's personal timer.
  }

  // --- Round Ending Logic ---
  if (remainingMs <= 0) {
    endRoundAndElectWinner();
  }
}, 500); // The loop runs every 500ms for responsiveness.

// ============================================================================
// --- SERVER SETUP & MIDDLEWARE ---
// ============================================================================

app.use(pinoHttp({ logger })); // Logger for all HTTP requests.
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

// Fetches a batch of words from before a given timestamp for infinite scroll.
app.get('/api/history/before', async (req, res) => { /* ... (code from original file) ... */ });

// Returns a sorted list of unique dates for which history chunks are available.
app.get('/api/history/dates', async (req, res) => { /* ... (code from original file) ... */ });

// Returns an array of history chunks for a specific date.
app.get('/api/history/:date', async (req, res) => { /* ... (code from original file) ... */ });

// Provides a canonical, shareable URL for a single chunk.
app.get('/chunk/:hash', async (req, res) => { /* ... (code from original file) ... */ });


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
    logger.info('[cron] Trigger: sealing new chunk...');
    sealNewChunk();
  }, { scheduled: true, timezone: "Europe/Paris" });

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