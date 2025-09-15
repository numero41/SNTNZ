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
const cron = require('node-cron');          // A task scheduler for running jobs at specific times (e.g., sealing chapters).

// --- Security & Utility Modules ---
const helmet = require('helmet');           // Provides important security headers to protect against common vulnerabilities.
const rateLimit = require('express-rate-limit'); // Middleware to limit repeated requests to public APIs.
const cors = require('cors');               // Enables and configures Cross-Origin Resource Sharing.
const pinoHttp = require('pino-http');      // A very fast and efficient JSON logger for HTTP requests.
const passport = require('passport');       // The authentication framework, used here for session management with Socket.IO.
const logger = require('./logger');         // The logging helper
const { notifyError, flushNow } = require('./mailer'); // The error notifier

// --- Database Module ---
const { MongoClient, ServerApiVersion } = require('mongodb'); // The official MongoDB driver for Node.js.

// --- Custom Application Modules ---
const constants = require('./constants');   // Centralized application constants and configuration.
const { AllProfanity } = require('allprofanity'); // A library for filtering out offensive words.
const { initializeAuth, createAuthRouter, sessionMiddleware } = require('./auth'); // All user authentication and session logic.
const { initBots, runBotSubmission, generateAndUploadImage, pushBotContext } = require('./bots'); // AI logic for Gemini and Imagen.
const { initSocial, postEverywhere, checkAndRefreshFbLongToken, formatPostText } = require('./social'); // Social media posting logic.

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
let liveWords = new Map();          // A map of currently submitted words for the active round.
let nextTickTimestamp = computeNextRoundEndTime(); // The timestamp for when the current round ends.
let botContext = [];                // The context buffer for the Gemini bot.
let botQueue = [];                  // The word queue for the Gemini bot's current sentence.
let shuttingDown = false;           // A flag to prevent multiple shutdown procedures from running.
let botMustWriteTitle = false;      // Signals that the bot must write a title for a new chapter.
let botMustStartChapter = false;    // Signals that the bot must start a new chapter.
let botMustContinueChapter = false; // Signals that the bot must start a new chapter.
let botIsRunning = false;           // A lock to prevent the bot from running multiple times at once.
let botHasSubmitted = false;        // A lock to prevent the bot from submitting multiple words in the same round.
let botIsConcluding = false;        // A lock to prevent the bot from running multiple times when concluding.
let submissionIsLocked = false;     // Prevents users from writing during the sealing process until the bot has finished generating a title
let liveChapterId = null;           // Stores the MongoDB _id of the current live chapter document.
let isImageGenerating = false;      // Tracks if an image is currently being generated.
let mustSeal = false;
const TARGET_CHAPTER_WORD_COUNT = Math.floor(((constants.CHAPTER_DURATION_MINUTES * 60) / constants.ROUND_DURATION_SECONDS));


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
let usersCollection, wordsCollection, chaptersCollection;

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
    chaptersCollection = db.collection('chapters');
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

/**
 * Calculates how many words the bot should write to complete a chapter
 * precisely at the next scheduled seal time.
 * @returns {number} The number of words the bot should generate.
 */
function calculateWordsUntilNextSeal() {
  // First, calculate the total target size of the chapter based on time.
  const minutesRemaining = calculateMinutesUntilNextSeal(constants.HISTORY_CHAPTER_SCHEDULE_CRON);
  const targetWordCount = Math.floor(((minutesRemaining * 60) / constants.ROUND_DURATION_SECONDS) * 0.9);

  // Ensure the bot always writes at least a couple of words.
  return Math.max(2, targetWordCount);
}

// ============================================================================
// --- CORE GAME & HISTORY LOGIC ---
// ============================================================================

/**
 * Decides if the bot should act for the current round and triggers its logic.
 * This version uses a proper async/await structure to prevent race conditions.
 */
async function triggerBot() {
  const hasWorkToDo = botQueue.length > 0 || botMustWriteTitle || botMustStartChapter || botMustContinueChapter;

  // Guard against concurrent execution.
  if (!botIsRunning && hasWorkToDo) {
    botIsRunning = true; // Engage the safety lock.

    try {
      // 1. Await all necessary data from the database.
      let liveChapter = null;
      let currentChapterWords = [];
      if (liveChapterId) {
          liveChapter = await chaptersCollection.findOne({ _id: liveChapterId });
          currentChapterWords = await wordsCollection.find({ chapterId: liveChapterId }).sort({ ts: 1 }).toArray();
      }

      const sealedChapterQuery = { hash: { $ne: null, $exists: true } };

      const [totalChapterCount, recentChapters] = await Promise.all([
        chaptersCollection.countDocuments(sealedChapterQuery),
        chaptersCollection.find(sealedChapterQuery, { projection: { title: 1 } }).sort({ ts: -1 }).limit(50).toArray(),
      ]);

      // 2. Assemble the complete state object to pass to the bot.
      const recentTitles = recentChapters.map(chapter => chapter.title).filter(Boolean);
      const targetWordCount = calculateWordsUntilNextSeal();
      const styleName = liveChapter ? liveChapter.style : null;
      const fullWritingStyleObject = styleName
        ? constants.WRITING_STYLES.find(s => s.name === styleName)
        : null;

    const botState = {
        liveWords,
        botContext,
        botQueue,
        broadcastLiveFeed,
        getCompositeKey,
        currentTitle: liveChapter ? liveChapter.title : null,
        currentWritingStyle: fullWritingStyleObject,
        currentChapterWords,
        totalChapterCount,
        botMustWriteTitle,
        botMustStartChapter,
        botMustContinueChapter,
        recentTitles,
        targetWordCount,
      };

      // 3. Await the bot's action and get the result.
      const result = await runBotSubmission(botState);

      // 4. Synchronize the server's state with the result.
      botQueue = result.botQueue;
      botMustWriteTitle = result.botMustWriteTitle;
      botMustStartChapter = result.botMustStartChapter;
      botMustContinueChapter = result.botMustContinueChapter;

      // Set the submission flag only if the bot reports it was successful.
      if (result.submissionMade) {
          botHasSubmitted = true;
      }

    } catch (err) {
      logger.error({ err }, '[bot] Bot execution promise chain failed');
    } finally {
      // 5. Always release the lock when done.
      botIsRunning = false;
    }
  }
}

/**
 * @summary Ends the current round, elects a winning word, and saves it to the database.
 * @description This function is the heart of the round transition. It determines the winner,
 * updates the story, and prepares the game for the next round.
 */
async function endRoundAndElectWinner() {
  // 1. Immediately schedule the next round's end time.
  nextTickTimestamp = computeNextRoundEndTime();
  io.emit('nextTick', { nextTickTimestamp });
  botHasSubmitted = false;

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
      count: winner.count, total: totalVotes, chapterId: liveChapterId
    };

    // 6. Save to database and update in-memory state.
    try {
      // If the winning word is a title, create the new chapter document first.
      if (winner.isTitle) {
          // A new chapter begins. We find the style chosen by the bot for this title.
          const style = constants.WRITING_STYLES.find(s => s.name === winner.writingStyle) || { name: 'User-Initiated' };

          const newChapterDoc = {
              ts: winnerRow.ts,
              title: winner.word,
              style: style.name, // Store the style name
              hash: null,
              imageUrl: null,
              text: '',
              words: []
          };
          const insertedChapter = await chaptersCollection.insertOne(newChapterDoc);
          liveChapterId = insertedChapter.insertedId;
          logger.info({ chapterId: liveChapterId, title: newChapterDoc.title }, '[db] New live chapter created.');
      }

      // All words now get the current live chapter's ID.
      winnerRow.chapterId = liveChapterId;
      if (!liveChapterId) {
          logger.error({ winner: winner.word }, "[db] CRITICAL: liveChapterId is null. Cannot save word.");
          return; // Prevent saving a word without a chapter.
      }

      await wordsCollection.insertOne(winnerRow);
      currentText.push(winnerRow);
      if (currentText.length > constants.CURRENT_TEXT_LENGTH) currentText.shift();
      botContext = pushBotContext(winner.word, botContext);
      io.emit('currentTextUpdated', currentText);
    } catch (err) {
      logger.error({ err }, "[db] Failed to save word to database");
    }

    // 7. Unlock for users if a title has just won the round.
    if (submissionIsLocked && winner.isTitle) {
      submissionIsLocked = false;
      logger.info('[server] Title sequence complete. Releasing user submission lock.');
    }

    // 8. If the winner is not the bot AND we are NOT in conclusion mode, clear the bot's queue.
    if (winner.username !== constants.BOT_NAME && !botIsConcluding) {
      logger.info({}, '[bot] A user won the round. Clearing bot queue and allowing a fresh turn.');
      botQueue = [];
      botMustStartChapter = false;
      botMustContinueChapter = true;
    }
    logger.info({winner: winner.word}, '[server] A word has been chosen.');
  }

  // After processing the winner, check if a seal is needed.
  if (mustSeal) {
    mustSeal = false;
    botQueue = [];
    await finalizeAndSealChapter();
    return;
  }

  // --- Bot Trigger Logic for a Round ---
  const needsToGenerateNewContent = botMustContinueChapter || botMustStartChapter || botMustWriteTitle;
  if (needsToGenerateNewContent) {
    await triggerBot();
  }
}

/**
 * @summary Finalizes the current live chapter, sealing it with a hash and image.
 * @description This function is now an UPDATE operation. It finds the chapter marked as
 * unsealed, calculates its final content and hash, generates an image, and updates
 * the document in the database to mark it as sealed.
 */
async function finalizeAndSealChapter() {
  if (!liveChapterId) {
    logger.warn('[history] Seal triggered, but there is no live chapter to seal. Aborting.');
    // Reset bot state to ensure it starts a new chapter next time.
    botMustWriteTitle = true;
    botMustStartChapter = false;
    botMustContinueChapter = false;
    await triggerBot();
    return;
  }

  submissionIsLocked = true;
  isImageGenerating = true;
  logger.info('[history] Finalizing chapter: User submissions are now locked.');

  try {
    io.emit('imageGenerationStarted');

    // --- 1. FETCH THE LIVE CHAPTER AND ITS WORDS ---
    const chapterToSeal = await chaptersCollection.findOne({ _id: liveChapterId });
    const wordsToChapter = await wordsCollection
      .find({ chapterId: liveChapterId })
      .sort({ ts: 1 })
      .toArray();

    if (!chapterToSeal || wordsToChapter.length === 0) {
      logger.warn('[history] Live chapter is empty. Forcing new chapter start.');
      if (chapterToSeal) {
        await chaptersCollection.deleteOne({ _id: liveChapterId }); // Clean up empty chapter
      }
      // The rest of the state reset is in the `finally` block.
      return;
    }

    // --- 2. BUILD CHAPTER METADATA (hash, text) ---
    const dataToHash = JSON.stringify(wordsToChapter);
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');

    const chapterText = wordsToChapter.reduce((acc, w) => {
      const sep = w.styles?.newline ? '\n' : (acc ? ' ' : '');
      return acc + sep + w.word;
    }, '').trim();

    // --- 3. GENERATE IMAGE & CROSS-POST ---
    let imageUrl = null;
    const shareableUrl = `https://www.sntnz.com/chapter/${hash}`;
    //if (isProduction) {
      imageUrl = await generateAndUploadImage(chapterText, chapterToSeal.title, hash, isProduction);
      //await postEverywhere(chapterText, shareableUrl, imageUrl);
    //}

    // --- 4. FINALIZE THE CHAPTER IN THE DATABASE (UPDATE) ---
    const updateResult = await chaptersCollection.updateOne(
      { _id: liveChapterId },
      {
        $set: {
          hash,
          text: chapterText,
          words: wordsToChapter, // Embed the final word array
          imageUrl,
        },
      }
    );

    // After updating, fetch the complete, finalized chapter document
    const sealedChapter = await chaptersCollection.findOne({ _id: liveChapterId });

    if (sealedChapter) {
      io.emit('chapterSealed', { sealedChapter });
    }

    logger.info({ chapterHash: hash }, '[history] Successfully sealed chapter');

  } catch (err) {
    logger.error({ err }, '[history] Error finalizing chapter');
  } finally {
    // --- 5. RESET STATE FOR THE NEXT CHAPTER ---
    isImageGenerating = false;
    botIsConcluding = false;
    botMustWriteTitle = true; // Signal the bot to create the next title
    botMustStartChapter = false;
    botMustContinueChapter = false;
    botQueue = [];
    liveChapterId = null; // Clear the old live chapter ID

    // --- 6. TRIGGER BOT & UNLOCK SUBMISSIONS ---
    logger.info('[history] Triggering bot for new chapter title.');
    await triggerBot(); // This will generate the title for the *next* chapter
    submissionIsLocked = false;
    logger.info('[history] Seal process complete. User submissions unlocked.');
  }
}

/**
 * Loads the state of the live (unsealed) chapter from the database on server startup.
 */
async function loadInitialTextFromHistory() {
  logger.info('[history] Attempting to restore live state from database...');

  try {
    // Find the one chapter that was left unsealed.
    const liveChapter = await chaptersCollection.findOne({ hash: null });

    if (liveChapter) {
      liveChapterId = liveChapter._id;
      const restoredWords = await wordsCollection.find({ chapterId: liveChapterId }).sort({ ts: 1 }).toArray();

      logger.info(`[history] Restoring ${restoredWords.length} unsealed words for chapter '${liveChapter.title}'.`);

      // 1. Restore the core story and bot context
      currentText = restoredWords.slice(-constants.CURRENT_TEXT_LENGTH);
      restoredWords.forEach(w => {
        botContext = pushBotContext(w.word, botContext);
      });

      // 2. Restore the bot's queue if it was saved in the chapter document (optional feature)
      botQueue = liveChapter.botQueue || [];

      // 3. Set the bot's next action based on the restored state
      const hasTitle = restoredWords.some(w => w.isTitle);
      if (!hasTitle || restoredWords.length === 0) {
        botMustWriteTitle = true;
      } else if (restoredWords.length === 1 && hasTitle) {
        botMustStartChapter = true;
      } else {
        botMustContinueChapter = true;
      }
      logger.info({
          mustWriteTitle: botMustWriteTitle,
          mustStartChapter: botMustStartChapter,
          mustContinueChapter: botMustContinueChapter
      }, '[history] Bot action flags set.');

    } else {
      logger.info('[history] No unsealed chapter found. Starting fresh.');
      botMustWriteTitle = true; // No history, so the bot must start a new story.
    }
  } catch (error) {
    logger.error({ err: error }, '[history] Failed to load initial state');
    botMustWriteTitle = true; // On failure, ensure the bot starts over.
  }
}

// ============================================================================
// --- GAME LOOP ---
// ============================================================================
setInterval(() => {
  // --- Round Ending Logic ---
  // This is the interval's PRIMARY job. If the round is over, end it.
  if (Date.now() >= nextTickTimestamp) {
    endRoundAndElectWinner();
    return; // Exit this tick immediately after ending the round.
  }

  // --- Proactive Bot Trigger at half round ---
  const roundMidpointTimestamp = nextTickTimestamp - (constants.ROUND_DURATION_SECONDS * 1000 / 2);
  const isPastMidpoint = Date.now() >= roundMidpointTimestamp;
  const botShouldSubmit =
    isPastMidpoint &&
    botQueue.length > 0 &&
    !botHasSubmitted &&
    !botIsRunning;

  if (botShouldSubmit) {
    logger.info('[bot] Midpoint reached. Attempting proactive submission.');
    triggerBot();
  }

  // --- "Conclusion Mode" Check ---
  // This is the interval's TERTIARY job. It runs on ticks where the round is not ending.
  // It checks if it's time for the bot to PREPARE its concluding sentences.

  // Calculate the time threshold for conclusion mode (5% of total chapter duration).
  const conclusionThresholdMinutes = Math.floor(constants.CHAPTER_DURATION_MINUTES * 0.05);
  const minutesRemaining = calculateMinutesUntilNextSeal(constants.HISTORY_CHAPTER_SCHEDULE_CRON);

  const botShouldReviewConclusion =
    minutesRemaining <= conclusionThresholdMinutes &&
    minutesRemaining > 10 &&
    botMustContinueChapter &&
    !botIsConcluding;

  if (botShouldReviewConclusion) {
    botIsConcluding = true; // Lock in conclusion mode so this only runs once per chapter.
    logger.info({ threshold: conclusionThresholdMinutes }, '[bot] Seal is imminent. Engaging conclusion mode to finish the chapter.');

    // Trigger the bot ONCE to generate the full conclusion and put it in its queue.
    // The bot will then submit those words one by one during its normal turn in endRoundAndElectWinner.
    botQueue = [];
    triggerBot();
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
        "img-src": ["'self'", "data:", "lh3.googleusercontent.com", "storage.googleapis.com", "https://www.googletagmanager.com"],
    }},
}));
app.use(cors({ origin(origin, cb) { cb(null, !origin || ORIGINS.includes(origin)); } })); // CORS policy.
app.use(express.json({ limit: '2kb' })); // JSON body parser with size limit.
app.use(express.urlencoded({ extended: false, limit: '2kb' })); // URL-encoded body parser.

// Rate limit public APIs to prevent abuse.
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(['/config', '/api', '/history', '/chapter'], apiLimiter);

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

// --- History & Chapter API Routes ---
// These routes allow the client to fetch historical data.
/**
 * GET /api/share-text/:hash
 * -------------------------
 * Generates the canonical, truncated, and formatted text for a given
 * chapter, suitable for sharing on social media like X.
 */
app.get('/api/share-text/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    if (!hash) {
      return res.status(400).json({ error: 'A chapter hash is required.' });
    }

    // Find the chapter using the potentially short hash
    const chapter = await chaptersCollection.findOne({ hash: new RegExp(`^${hash}`) });
    if (!chapter) {
      return res.status(404).json({ error: 'Chapter not found.' });
    }

    // Reuse the exact same logic as the social media posts
    const shareableUrl = `https://www.sntnz.com/chapter/${chapter.hash}`;

    const shareText = formatPostText(
      chapter.text,
      shareableUrl,
      constants.SOCIAL_X_HASHTAGS || '',
      constants.TWITTER_MAX_CHARS,
      23 // Use the standard 23 characters for Twitter's URL length
    );

    res.json({ shareText, chapterTitle: chapter.title });

  } catch (error) {
    logger.error({ err: error }, '[api] Error generating share text');
    res.status(500).json({ error: 'Failed to generate share text.' });
  }
});

/**
 * GET /api/history/before
 * -----------------------
 * Fetches a batch of whole, ordered chapters from before a given timestamp.
 * This is the new, robust method for infinite scroll.
 */
app.get('/api/history/before', async (req, res) => {
  try {
    const oldestTimestamp = parseInt(req.query.ts, 10);
    const limit = 3;

    if (isNaN(oldestTimestamp)) {
      return res.status(400).json({ error: 'Invalid timestamp provided.' });
    }

    const olderChapters = await chaptersCollection.find({ ts: { $lt: oldestTimestamp }, hash: { $ne: null } })
      .sort({ ts: -1, _id: -1 })
      .limit(limit)
      .toArray();

    res.json(olderChapters);

  } catch (error) {
    console.error('[api] Error fetching older history chapters:', error);
    res.status(500).json({ error: 'Failed to retrieve history.' });
  }
});

/**
 * GET /api/history/latest
 * -----------------------
 * Always returns the chapters for the server's current UTC date, including the live chapter.
 * Also returns the date string it used, so the client can update its state.
 */
app.get('/api/history/latest', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${today}T00:00:00.000Z`);
    const endOfDay = new Date(`${today}T23:59:59.999Z`);

    // Get all chapters for today, sealed or not
    const chaptersForToday = await chaptersCollection.find({
      ts: { $gte: startOfDay.getTime(), $lte: endOfDay.getTime() },
    }).sort({ ts: 1 }).toArray();

    // The live chapter might not be fully populated with its `words` array yet.
    // We need to fetch them manually for the response.
    const populatedChapters = await Promise.all(chaptersForToday.map(async (chapter) => {
      if (!chapter.hash) {
        const words = await wordsCollection.find({ chapterId: chapter._id }).sort({ ts: 1 }).toArray();
        return {
          ...chapter,
          words,
          hash: 'Pending...', // Override hash for client display
          isLive: true,
        };
      }
      return chapter;
    }));

    res.json({ date: today, chapters: populatedChapters });

  } catch (error) {
    console.error(`[api] Error fetching latest history:`, error);
    res.status(500).json({ error: 'Failed to retrieve history.' });
  }
});

/**
 * GET /api/history/dates
 * ----------------------
 * Returns a sorted list of unique dates for which history chapters are available in the database.
 */
app.get('/api/history/dates', async (req, res) => {
  try {
    // This query now correctly includes the date of the unsealed chapter.
    const dates = await chaptersCollection.aggregate([
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: { $toDate: "$ts" } } }
        }
      },
      { $sort: { _id: -1 } } // Sort dates newest to oldest
    ]).toArray();

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
 * Returns an array of history chapters for a specific date.
 * This now includes both sealed chapters and a "live" chapter of unsealed words.
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

    // Query for all chapters on the given date, sealed or not.
    const chaptersForDate = await chaptersCollection.find({
      ts: {
        $gte: startOfDay.getTime(),
        $lte: endOfDay.getTime(),
      },
    }).sort({ ts: 1 }).toArray();

    // For any unsealed chapter, fetch its words and format it as a "live" chapter for the client.
    const populatedChapters = await Promise.all(chaptersForDate.map(async (chapter) => {
      if (!chapter.hash) {
        const words = await wordsCollection.find({ chapterId: chapter._id }).sort({ ts: 1 }).toArray();
        return {
          ...chapter,
          words,
          hash: 'Pending...',
          isLive: true,
        };
      }
      return chapter;
    }));

    res.json(populatedChapters);
  } catch (error) {
    console.error(`[api] Error reading history for ${date}:`, error);
    res.status(500).json({ error: 'Failed to retrieve history.' });
  }
});

/**
 * GET /chapter/:hash
 * ----------------
 * Provides a canonical, shareable URL for a single chapter.
 * - For social media crawlers, it serves an HTML page with Open Graph meta tags.
 * - For regular users, it redirects to the correct daily history page with a
 * URL fragment to scroll the user to the specific chapter.
 */
app.get('/chapter/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    if (!hash || hash.length !== 64) { // SHA-256 hashes are 64 hex characters
      return res.status(400).send('Invalid chapter hash.');
    }

    // 1. Find the chapter in the database using its unique hash.
    const chapter = await chaptersCollection.findOne({ hash });

    if (!chapter) {
      return res.status(404).send('Chapter not found.');
    }

    // 2. Check the User-Agent to see if the visitor is a social media crawler.
    const userAgent = req.headers['user-agent'] || '';
    const isCrawler = /facebookexternalhit|Twitterbot|Discordbot|LinkedInBot|Pinterest/i.test(userAgent);

    if (isCrawler) {
      // 3. If it's a crawler, serve a minimal HTML page with meta tags for the preview.
      console.log(`[share] Crawler detected (${userAgent}), serving meta tags for chapter ${hash.substring(0,12)}.`);
      const title = `snTnz Story Chapter`;
      const description = `"${chapter.text.substring(0, 150)}..."`;
      const url = `${req.protocol}://${req.get('host')}/chapter/${hash}`;

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
          <meta property="og:image" content="${chapter.imageUrl}">
          <meta name="twitter:card" content="summary_large_image">
          <meta name="twitter:url" content="${url}">
          <meta name="twitter:title" content="${title}">
          <meta name="twitter:description" content="${description}">
          <meta name="twitter:image" content="${chapter.imageUrl}">
        </head>
        <body>
          <h1>${title}</h1>
          <p>${chapter.text}</p>
          <img src="${chapter.imageUrl}" alt="AI generated image for chapter">
        </body>
        </html>
      `);
    } else {
      // 4. If it's a regular user, redirect them to the correct history page.
      const date = new Date(chapter.ts);
      const dateString = date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
      const redirectUrl = `/history.html?date=${dateString}#${chapter.hash}`;

      console.log(`[share] User detected, redirecting to: ${redirectUrl}`);
      res.redirect(302, redirectUrl);
    }

  } catch (error) {
    console.error('[share] Error handling chapter request:', error);
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

  try {
    const initialChapters = [];
    let initialImageUrl = null;

    // 1. Find the current live (unsealed) chapter.
    const liveChapter = await chaptersCollection.findOne({ hash: null });

    // 2. Find the most recent sealed chapter to show before the live one.
    const previousSealedChapter = await chaptersCollection.findOne(
      { hash: { $ne: null } },
      { sort: { ts: -1 } }
    );

    // 3. Add the previous sealed chapter to our payload if it exists.
    // The 'words' array is already embedded in sealed chapters.
    if (previousSealedChapter) {
      initialChapters.push(previousSealedChapter);
      // This will be the default image unless a newer one is found.
      initialImageUrl = previousSealedChapter.imageUrl || null;
    }

    // 4. If a live chapter exists, fetch all its words and add it.
    if (liveChapter) {
      const liveChapterWords = await wordsCollection
        .find({ chapterId: liveChapter._id })
        .sort({ ts: 1 })
        .toArray();

      // The live chapter doesn't have its 'words' array populated yet, so we add it.
      initialChapters.push({
        ...liveChapter,
        words: liveChapterWords,
        isLive: true,
      });

      // The latest image could be from the chapter *before* the live one.
      // So, we find the most recent sealed chapter with an image overall.
      const lastChapterWithImage = await chaptersCollection.findOne(
        {
          hash: { $ne: null },
          imageUrl: { $ne: null, $exists: true }
        },
        { sort: { ts: -1 } }
      );
      initialImageUrl = lastChapterWithImage?.imageUrl || null;
    }

    socket.emit('initialState', {
      initialChapters,
      liveSubmissions: getLiveFeedState(userId),
      nextTickTimestamp,
      latestImageUrl: initialImageUrl,
      isImageGenerating: isImageGenerating
    });

  } catch (err) {
    logger.error({ err }, "[socket] Failed to prepare and send initialState");
    // Send a fallback state to the client so it doesn't just hang.
    socket.emit('initialState', {
      initialChapters: [{ words: [] }],
      liveSubmissions: [],
      nextTickTimestamp: computeNextRoundEndTime(),
      latestImageUrl: null,
      isImageGenerating: false
    });
  }

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
    if (submissionIsLocked) {
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

  // Schedule the daily chapter sealing job.
  cron.schedule(constants.HISTORY_CHAPTER_SCHEDULE_CRON, () => {
    logger.info('[history] Seal scheduled at next round end');
    mustSeal = true;
  }, { scheduled: true, timezone: 'UTC' });

  // Schedule the daily Facebook token refresh check.
  cron.schedule(constants.FB_USER_TOKEN_REFRESH_SCHEDULE_CRON, () => {
    logger.info('[cron] Trigger: checking FB token...');
    checkAndRefreshFbLongToken(7, isProduction).catch(err => {
      logger.error({ err }, '[cron] Token refresh failed');
    });
  }, { scheduled: true, timezone: 'UTC' });

  // Start listening for connections.
  server.listen(PORT, () => logger.info({ port: PORT }, 'Server is running'));
}

/**
 * @summary Gracefully stops the server upon receiving an OS signal (e.g., Ctrl+C).
 * @description Ensures a clean shutdown by closing servers and database connections.
 * The live state is already persisted after each round, so no final save is needed.
 * @param {string} sig - The name of the OS signal that triggered the shutdown.
 */
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal: sig }, '[shutdown] Received signal. State is already saved.');

  // Set a failsafe timeout to force exit if anything hangs.
  const timeoutId = setTimeout(() => {
    logger.warn('[shutdown] Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 5000);

  try {
    // 1. Stop taking new work.
    io.close();
    server.close(() => {
        logger.info('[shutdown] Sockets and HTTP server closed.');
    });

    // 2. IMPORTANT: Close the database connection.
    await client.close();
    logger.info('[shutdown] MongoDB connection closed.');

    // 3. Clear the failsafe and exit cleanly.
    clearTimeout(timeoutId);
    logger.info('[shutdown] Shutdown complete. Exiting.');
    process.exit(0);

  } catch (err) {
    logger.error({ err }, '[shutdown] An error occurred during shutdown.');
    clearTimeout(timeoutId);
    process.exit(1);
  }
}

// Listen for shutdown signals.
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  notifyError(`[unhandledRejection] ${msg}`);
});

process.on('uncaughtException', (err) => {
  notifyError(`[uncaughtException] ${err.stack || err.message || String(err)}`);
});

process.on('beforeExit', () => {
  // Try to send any buffered errors before the process exits.
  flushNow();
});

startServer();