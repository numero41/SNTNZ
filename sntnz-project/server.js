// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

require('dotenv').config();                 // Load .env file into process.env for local dev
const express = require('express');         // Web framework: routing, static files, JSON parsing
const http = require('http');               // Raw Node HTTP server (Socket.IO attaches to this)
const { Server } = require('socket.io');    // Realtime events over WebSocket (w/ graceful fallbacks)
const crypto = require('crypto');           // Hashing functions

const fs = require('fs');                   // Sync/streaming file ops (createReadStream, existsSync, appendFile)
const fsPromises = require('fs').promises;  // Promise-based fs APIs (readFile, access) for async/await flows

// Login and users
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const connectedUsers = new Map();

// Google Generative AI SDK (Gemini)
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Mongo database for user data and usage tracking
const { MongoClient, ServerApiVersion } = require('mongodb');

// Hardening helpers
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const pinoHttp = require('pino-http');

const app = express();
const server = http.createServer(app);

// Make shutdowns snappier under load (optional)
server.keepAliveTimeout = 5000;
server.headersTimeout = 7000;

// Trust proxy when behind nginx/caddy/etc.
if (String(process.env.TRUST_PROXY || '') === '1') app.set('trust proxy', 1);

// Use env or default localhost in dev
const ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Prefer pure websockets; add sane timeouts/buffers; set CORS
const io = new Server(server, {
  transports: ['websocket'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 10_000,
  cors: { origin: ORIGINS, methods: ['GET'] } // Socket.IO supports array
});

// Use the platform-assigned port in prod (Render/Heroku/Railway/etc.)
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ============================================================================
// --- CONFIG ---
// ============================================================================
const path = require('path');
const constants = require('./constants');
const { AllProfanity } = require('allprofanity');
const profanityFilter = new AllProfanity();

// ============================================================================
// --- DATABASE SETUP ---
// ============================================================================
const client = new MongoClient(process.env.DATABASE_URL, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

let usersCollection;
let wordsCollection;
let chunksCollection;

async function connectToDatabase() {
  try {
    await client.connect();
    const db = client.db();
    usersCollection = db.collection('users');
    wordsCollection = db.collection('words');
    chunksCollection = db.collection('chunks');
    console.log("[db] Successfully connected to MongoDB Atlas!");
  } catch (err) {
    console.error("[db] Failed to connect to MongoDB", err);
    process.exit(1);
  }
}

// ============================================================================
// --- GOOGLE AI SETUP ---
// ============================================================================
const API_KEY = process.env.GOOGLE_API_KEY; // Securely load the key
const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});
const botBufferMax = constants.CURRENT_TEXT_LENGTH * constants.BOT_LOOKBACK_MULTIPLIER;
let botContext = [];
let botQueue = [];

// ============================================================================
// --- STATE MANAGEMENT ---
// ============================================================================
let currentText = [];
let liveWords = new Map();
let nextTickTimestamp = Date.now() + (constants.ROUND_DURATION_SECONDS * 1000);
let lastBotPostTimestamp = 0;
let users = new Map();
const anonUsage = new Map();
let shuttingDown = false;
let characterCount = 0;


// ============================================================================
// --- HELPER FUNCTIONS ---
// ============================================================================
/**
 * Creates a unique key for a word and its styles.
 * @param {{word: string, styles: object}} wordData
 * @returns {string} A unique composite key.
 */
function getCompositeKey(wordData) {
  const styleKey = `b:${!!wordData.styles.bold}-i:${!!wordData.styles.italic}-u:${!!wordData.styles.underline}-n:${!!wordData.styles.newline}`;
  return `${wordData.word.toLowerCase()}-${styleKey}`;
}

/**
 * Calculates scores and returns a sorted array for the client.
 * @param {string} [requestingUserId] - Optional user ID to determine their vote status.
 * @returns {Array<object>} The sorted live feed state.
 */
function getLiveFeedState(requestingUserId) {
  const feed = [];
  for (const [compositeKey, data] of liveWords.entries()) {
    // Calculate the net score by summing the votes (1 for up, -1 for down)
    const score = Array.from(data.votes.values()).reduce((acc, vote) => acc + vote, 0);

    // Determine the requesting user's vote for this item
    let userVote = null;
    if (requestingUserId && data.votes.has(requestingUserId)) {
      userVote = data.votes.get(requestingUserId) === 1 ? 'up' : 'down';
    }

    feed.push({
      word: data.word,
      styles: data.styles,
      username: data.submitterName,
      count: score,
      ts: data.ts,
      compositeKey: compositeKey,
      userVote: userVote, // Add user's vote status for the client UI
    });
  }

  // Sort by score (descending), then by submission time (ascending) as a tie-breaker
  return feed.sort((a, b) => {
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    return a.ts - b.ts;
  });
}

/**
 * Broadcasts the latest live feed state to all connected clients.
 * Each client receives a personalized list showing their own votes.
 */
function broadcastLiveFeed() {
    for (const [socketId, socket] of io.of("/").sockets) {
        const user = socket.request.user;
        const userId = user ? user.googleId : socket.id;
        socket.emit('liveFeedUpdated', getLiveFeedState(userId));
    }
}

/**
 * validateSubmission
 * ------------------
 * Validates a single token submission:
 *  - Ensures it's a single "word-like" token (letters, digits, hyphen, apostrophe),
 *    optionally ending with punctuation (.,!?;:…).
 *  - Rejects offensive words via bad-words filter.
 *
 * @param {string} word - The submitted token.
 * @returns {{ valid: boolean, reason?: string }}
 *   An object indicating validity and an optional failure reason.
 *
 * @example
 * validateSubmission("Hello!");
 * // -> { valid: true }
 */
function validateSubmission(word) {
  if (typeof word !== 'string') return { valid: false, reason: 'Invalid input' };
  word = word.trim();
  if (word.length === 0 || word.length > constants.INPUT_MAX_CHARS) {
    return { valid: false, reason: '1–25 chars only' };
  }
  const punctuationRegex = new RegExp(constants.PUNCTUATION_REGEX_STRING);
  if (!punctuationRegex.test(word)) return { valid: false, reason: 'No spaces or misplaced punctuation' };

  // If the word is profane according to EITHER filter, reject it.
  if (profanityFilter.check(word)) {
    return { valid: false, reason: 'Offensive words are not allowed' };
  }

  return { valid: true };
}

/**
 * endRoundAndElectWinner
 * ----------------------
 * Ends the current round by prioritizing the next round's timer for a responsive
 * UI, then processes and broadcasts the results of the round that just concluded.
 *
 * @returns {void}
 */
async function endRoundAndElectWinner() {
  // Immediately calculate and broadcast the timestamp for the NEXT round.
  nextTickTimestamp = Date.now() + (constants.ROUND_DURATION_SECONDS * 1000);
  io.emit('nextTick', { nextTickTimestamp });

  // Capture the final state of the round that just finished.
  const liveFeed = getLiveFeedState();

  // Reset the live submission state for the new round.
  liveWords.clear();
  broadcastLiveFeed(); // This function sends the new, empty list to all clients.

  // Filter for potential winners (score > 0).
  const potentialWinners = liveFeed.filter(item => item.count > 0);

  // Only proceed if there is at least one valid winner.
  if (potentialWinners.length > 0) {
    let winner = potentialWinners[0];
    const total = liveFeed.reduce((acc, item) => acc + Math.max(0, item.count), 0);

    // Automatically capitalize the word if it starts a new sentence.
    if (currentText.length > 0) {
        const lastWordInSentence = currentText[currentText.length - 1].word;
        if (/[.!?]$/.test(lastWordInSentence) ) {
            winner.word = winner.word.charAt(0).toUpperCase() + winner.word.slice(1);
        }
    }

    // Create the final, structured data object for the winning word.
    const winnerRow = {
        ts: Date.now(),
        minute: Math.floor(Date.now() / 60000),
        word: winner.word,
        styles: winner.styles,
        username: winner.username,
        pct: total > 0 ? (winner.count / total) * 100 : 0,
        count: winner.count,
        total: total,
        chunkId: null // Every new word starts as un-chunked
    };

    // 1. Save the winning word directly to the 'words' collection.
    try {
        await wordsCollection.insertOne(winnerRow);
    } catch (err) {
        console.error("[db] Failed to save word to database:", err);
    }

    // 2. Update the application's in-memory state.
    currentText.push(winnerRow);
    if (currentText.length > constants.CURRENT_TEXT_LENGTH) currentText.shift();
    pushBotContext(winner.word);

    // 3. Update the character count and check if it's time to seal a chunk.
    characterCount += winner.word.length + 1;
    if (characterCount >= constants.HISTORY_CHUNK_LENGTH) {
      sealNewChunk(); // Trigger the sealing process
    }
  }

  // Check if the bot's submission was rejected to force a new sentence
  const botSubmittedWord = liveFeed.find(item => item.username === constants.BOT_NAME);
  const winner = potentialWinners.length > 0 ? potentialWinners[0] : null;

  if (botSubmittedWord && (!winner || winner.username !== constants.BOT_NAME)) {
    console.log('[bot] Submission was not chosen. Clearing sentence queue.');
    botQueue = []; // This forces the bot to generate a fresh sentence next time
  }

  // Broadcast the updated story text to all clients.
  io.emit('currentTextUpdated', currentText);
}

// ============================================================================
// --- BOT ---
// ============================================================================

/**
 * pushBotContext
 * --------------
 * Appends a word to the context ring; trims to BOT_BUFFER_MAX.
 *
 * @param {string} w - word just appended to the sentence
 */
function pushBotContext(w){
  botContext.push(String(w || ''));
  if (botContext.length > botBufferMax) botContext.shift();
}

/**
 * pickBotWord
 * -----------
 * Picks a plausible next word based on a simple bigram from the context buffer.
 * Falls back to a neutral seed if no bigram found.
 *
 * @returns {string} candidate word
 */
function pickBotWord(){
  if (botContext.length < 2) return pickSeed();

  const last = botContext[botContext.length - 1].toLowerCase();
  const counts = new Map();

  for (let i = 0; i < botContext.length - 1; i++){
    const a = String(botContext[i]).toLowerCase();
    const b = String(botContext[i+1]).toLowerCase();
    if (a === last){
      counts.set(b, (counts.get(b) || 0) + 1);
    }
  }
  // choose most common follower
  let best = null, bestC = 0;
  for (const [w,c] of counts) if (c > bestC) { best = w; bestC = c; }
  return best || pickSeed();
}

/**
 * pickSeed
 * --------
 * Tries a Markov "next word" from the last word; if none, picks from constants.BOT_SEEDS.
 * @returns {string}
 */
function pickSeed(){
  // Try a Markov one-step continuation first
  const model = buildMarkovModel(botContext);
  const last = currentText.length ? currentText[currentText.length - 1].word : '';
  const next = markovNext(model, last);
  if (next) return next;

  // Fallback to static seeds
  const seeds = (constants && constants.BOT_SEEDS)
    ? constants.BOT_SEEDS
    : ["echo","neon","murmur","flux","orbit","paper","glass","river","quiet","amber","stone","cloud","pulse","still","north","velvet"];
  return seeds[(Math.random() * seeds.length) | 0];
}

/**
 * runBotSubmission
 *
 * Generates a short, coherent sentence and plays it out word-by-word.
 * - Preserves a token queue (botQueue) so the bot's planned sentence unfolds across rounds.
 * - Bans recent words + offensive words found in the existing text (if profanityFilter is available).
 * - Avoids repeating the previous bot sentence or starting with its first bigram.
 * - Logs prompt + raw reply for easy debugging.
 *
 * @returns {Promise<void>} Resolves after the bot enqueues/submits its next token and emits updates.
 *
 * @example
 * await runBotSubmission();
 * // -> Emitted 'liveFeedUpdated' with the bot's token
 */
async function runBotSubmission() {
  //========================================
  // 0) EARLY PLAY: use queued token if available
  //  - If the bot has a previously generated sentence, keep streaming it token by token.
  //========================================
  const allWords = currentText.map(w => w.word);
  if (botQueue.length > 0) {
    const planned = botQueue.shift();
    botPlannedToken = planned;

    const botWordData = {
      word: planned,
      styles: { bold: false, italic: false, underline: false, newline: false }
    };
    const compositeKey = getCompositeKey(botWordData);
    if (!liveWords.has(compositeKey)) {
        liveWords.set(compositeKey, {
            ...botWordData,
            submitterId: 'sntnz_bot',
            submitterName: constants.BOT_NAME,
            ts: Date.now(),
            votes: new Map([['sntnz_bot', 1]]) // Bot's own upvote
        });
    }
    broadcastLiveFeed();
    return;
  }

  //========================================
  // 1) CONTEXT & BAN LIST (recent words + offensive words)
  //  - Build a dynamic ban list from recent tokens, profanity, and optional external lists.
  //========================================
  // Last 10 unique recent words (normalized)
  const recent = allWords
    .slice(-10)
    .map(w => w.toLowerCase().replace(/[.,!?;:…]+$/u, ''))
    .filter(Boolean);
  const uniqRecent = [...new Set(recent)];

  // Offensive words found in the text so far (if profanityFilter is present)
  let offensiveFound = [];
  if (typeof profanityFilter?.isProfane === 'function') {
    offensiveFound = [...new Set(
      allWords
        .map(w => w.toLowerCase().replace(/[.,!?;:…]+$/u, ''))
        .filter(w => w && profanityFilter.isProfane(w))
    )];
  }

  // Extra banned words from env or globals (optional)
  const extraEnvBanned = (process.env.EXTRA_BANNED_WORDS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const extraGlobalBanned = Array.isArray(globalThis?.OFFENSIVE_WORDS)
    ? globalThis.OFFENSIVE_WORDS.map(w => String(w).toLowerCase().trim()).filter(Boolean)
    : [];

  const banPool = [...new Set([
    ...uniqRecent,
    ...offensiveFound,
    ...extraEnvBanned,
    ...extraGlobalBanned,
    'please','pls','plz'
  ])];

  const banListForPrompt = banPool.length
    ? `[${banPool.join(', ')}]`
    : `[please, pls, plz]`;

  //========================================
  // 2) ANTI-REPEAT (cross-sentence)
  //  - Avoid repeating last bot sentence or starting with same bigram.
  //========================================
  const normalizeSentence = s =>
    s.toLowerCase()
     .replace(/[“”"‘’'`]+/g, '')
     .replace(/[^\p{L}\p{N}\s.!?-]/gu, '')
     .replace(/\s+/g, ' ')
     .trim();

  const prevSig = globalThis.__lastBotSentenceSig || null;
  const prevStart = globalThis.__lastBotSentenceStart || null; // e.g., "sunlight warmed"

  //========================================
  // 3) PROMPT BUILDER
  //  - Creates the strict instruction set for the LLM, including ban list and context.
  //========================================
  function buildPrompt(violationNote = "") {
    // Add explicit “forbidden starts” & “no same sentence” guidance
    const forbiddenStartsLine = prevStart
      ? `Do NOT start with: "${prevStart}".`
      : ``;
    const noSameSentenceLine = prevSig
      ? `Do NOT repeat the previous sentence or its phrasing.`
      : ``;

    return `
      You will write EXACTLY ONE complete sentence that continues the text coherently, and tell a global story.
      ${violationNote}

      Hard rules (all must be met):
      1) Length: 4–${constants.BOT_SENTENCE_MAX_WORDS} words total.
      2) Include at least one concrete noun and one verb.
      3) Do NOT use any of these words in ANY form: ${banListForPrompt}
      4) Try to NOT repeat any word within this sentence, and try to avoid repeating words from the previous text.
      5) No interjections or filler words; avoid adjective lists without action.
      6) End with proper punctuation (. ! or ?).
      7) Style and story: You are a surrealist poet contributing to a collective story.
      Your goal is to add a single word that is unexpected, dream-like, and poetically strange, almost chaotical.
      It should connect to the previous words in an abstract or subconscious way, not a logical one, but still be grammatically correct.
      Avoid clichés and pure nonsense. Your contribution should be creatively bizarre.
      8) ${noSameSentenceLine}
      9) ${forbiddenStartsLine}

      Context (recent excerpt):
      "${botContext.join(' ')}"

      Output ONLY the one sentence. No quotes, no preface.
      `.trim();
  }

  //========================================
  // 4) VALIDATION HELPERS (kept inline)
  //  - Self-checks to ensure the sentence respects the in-prompt constraints.
  //========================================
  const wordCount = s => (s.trim().match(/\S+/g) || []).length;
  const endsPunct = s => /[.!?]$/.test(s.trim());
  const stopWords = new Set(constants.BOT_STOP_WORDS);
  const noRepeats = s => {
    const toks = s.toLowerCase().replace(/[.!?]$/, '').replace(/,/g, '').split(/\s+/);
    const seen = new Set();
    for (const t of toks) {
      // Only check for repeats if the word is NOT a common stop word.
      if (!stopWords.has(t)) {
        if (seen.has(t)) {
          console.log(`[bot] Sentence rejected due to repeated word: "${t}"`);
          return false; // A meaningful word was repeated
        }
        seen.add(t);
      }
    }
    return true;
  };
  const notSameAsPrev = s => {
    if (!prevSig) return true;
    return normalizeSentence(s) !== prevSig;
  };
  const notStartingLikePrev = s => {
    if (!prevStart) return true;
    const firstTwo = normalizeSentence(s).split(' ').slice(0, 2).join(' ');
    return firstTwo !== prevStart;
  };
  const validSentence = s =>
    wordCount(s) >= 4 &&
    wordCount(s) <= constants.BOT_SENTENCE_MAX_WORDS &&
    endsPunct(s) &&
    noRepeats(s) &&
    notSameAsPrev(s) &&
    notStartingLikePrev(s);

  //========================================
  // 5) GENERATE + RETRY + FALLBACK (tolerant repeat-guard + longer timeout)
  //========================================
  const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 12000);

  const withTimeout = (p, ms = AI_TIMEOUT_MS) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  async function generateOnce(prompt) {
    const result = await withTimeout(model.generateContent(prompt));
    const raw = (result?.response?.text() || "").trim();
    // keep only the first sentence so we don't overflow token rules
    return (raw.match(/^[^.!?]*[.!?]/) || [raw])[0].trim();
  }

  // simple repeat/loop checks
  const looksLooped = (s) => /\b(\w+)\b(?:\s+\1){2,}/i.test(s); // "glass glass glass"
  function tooSimilarToLast(s) {
    const ns = normalizeSentence(s);
    const lastSig = globalThis.__lastBotSentenceSig || '';
    const lastStart = (globalThis.__lastBotSentenceStart || '').trim();
    const sameSig = ns === lastSig;
    const sameStart = lastStart && ns.startsWith(lastStart + ' ');
    // allow ONE repeat before rejecting (reduces false positives)
    const prevStreak = globalThis.__repeatStreak || 0;
    const reject = (sameSig || sameStart) && prevStreak >= 1;
    globalThis.__repeatStreak = (sameSig || sameStart) ? prevStreak + 1 : 0;
    return reject;
  }

  let sentence = '';
  try {
    sentence = await generateOnce(buildPrompt());
    if (!validSentence(sentence) || looksLooped(sentence) || tooSimilarToLast(sentence)) {
      const note = 'Avoid repeating earlier sentences; vary vocabulary and structure.';
      sentence = await generateOnce(buildPrompt(note));
    }
  } catch (e) {
    console.warn('[bot] model error (AI):', e?.message || e);
  }
  console.log('[bot] Generated sentence:', sentence || '(none)');

  if (!validSentence(sentence) || looksLooped(sentence) || tooSimilarToLast(sentence)) {
    const len = 8 + ((Math.random() * 5) | 0);
    console.log('[bot] Generated sentence has been rejected; falling back to Markov.');
    sentence = generateMarkovSentence(len);
  }

  // Persist signatures for the NEXT call
  const sig = normalizeSentence(sentence);
  const firstTwo = sig.split(' ').slice(0, 2).join(' ');
  globalThis.__lastBotSentenceSig = sig;
  globalThis.__lastBotSentenceStart = firstTwo;

  botQueue = sentence.trim().split(/\s+/);
  botPlannedToken = botQueue[0] || null;


  //========================================
  // 6) SUBMIT NOW: take the first token of the planned sentence
  //    If for any reason the queue is empty, fall back to a contextual pick.
  //========================================
  const PUNC_ONLY = /^[.,!?;:…]$/u;

  // Prefer planned sentence
  let word = (botQueue.length > 0) ? botQueue.shift() : pickBotWord();
  botPlannedToken = botQueue[0] || null;

  // Capitalize if starting a new sentence (but never change punctuation-only)
  const lastWord = currentText.length ? currentText[currentText.length - 1].word : '';
  const startingNewSentence = !lastWord || /[.!?]$/.test(lastWord);
  if (!PUNC_ONLY.test(word)) {
    word = startingNewSentence
      ? word.charAt(0).toUpperCase() + word.slice(1)
      : word.toLowerCase();
  }

  // Submit like a normal user
  const botWordData = {
    word: word,
    styles: { bold: false, italic: false, underline: false, newline: false }
  };
  const compositeKey = getCompositeKey(botWordData);
  if (!liveWords.has(compositeKey)) {
      liveWords.set(compositeKey, {
          ...botWordData,
          submitterId: 'sntnz_bot',
          submitterName: constants.BOT_NAME,
          ts: Date.now(),
          votes: new Map([['sntnz_bot', 1]]) // Bot's own upvote
      });
  }

  // Broadcast the refreshed live feed
  broadcastLiveFeed();
}

// ============================================================================
// BOT MARKOV HELPERS (fallback generator)
// ----------------------------------------------------------------------------
// We build a tiny 1st-order Markov model from the last ~N words (botContext).
// - markovNext(model, last): pick the most frequent follower of `last`
// - generateMarkovSentence(maxTokens): build a short phrase starting from the
//   last sentence word; punctuation-only tokens are allowed to end early.
// ============================================================================

/**
 * buildMarkovModel
 * ----------------
 * Builds a { head: Map<nextWord, count> } style model from context words.
 * @param {string[]} words - Recent words (already pushed via pushBotContext).
 * @returns {Map<string, Map<string, number>>}
 */
function buildMarkovModel(words){
  const model = new Map();
  for (let i = 0; i < words.length - 1; i++){
    const a = String(words[i] || '').toLowerCase();
    const b = String(words[i+1] || '').toLowerCase();
    if (!a || !b) continue;
    if (/\s/.test(a) || /\s/.test(b)) continue;
    let m = model.get(a);
    if (!m) { m = new Map(); model.set(a, m); }
    m.set(b, (m.get(b) || 0) + 1);
  }
  return model;
}

/**
 * markovNext
 * ----------
 * Picks the most frequent follower of `head`. If none, returns null.
 * @param {Map<string, Map<string, number>>} model
 * @param {string} head
 * @returns {string|null}
 */
function markovNext(model, head){
  const m = model.get(String(head || '').toLowerCase());
  if (!m || m.size === 0) return null;
  let best = null, bestC = 0;
  for (const [w,c] of m) { if (c > bestC) { best = w; bestC = c; } }
  return best;
}

/**
 * generateMarkovSentence
 * ----------------------
 * Generates a short phrase (8–12 tokens) starting from the last word in the
 * current sentence (or a safe seed if none). Falls back gracefully.
 * @param {number} maxTokens
 * @returns {string} a space-separated phrase
 */
function generateMarkovSentence(maxTokens = 10){
  const last = currentText.length ? currentText[currentText.length - 1].word : '';
  const model = buildMarkovModel(botContext);
  const tokens = [];
  const seen = new Set();
  const toLower = s => String(s || '').toLowerCase();

  let head = toLower(last) || toLower(pickSeed());

  for (let i = 0; i < maxTokens; i++){
    const m = model.get(head);
    let candidate = null, bestC = 0;

    // choose the best follower that is NOT the same as head and not already used
    if (m && m.size){
      for (const [w,c] of m){
        if (w === head) continue;        // no self-loop A -> A
        if (seen.has(w)) continue;       // no repeats within one sentence
        if (c > bestC){ candidate = w; bestC = c; }
      }
    }

    if (!candidate) break;
    tokens.push(candidate);
    seen.add(candidate);
    head = toLower(candidate);
  }

  // pad to a minimum length with unique safe seeds
  if (tokens.length < 4){
    const seeds = (constants && constants.BOT_SEEDS)
      ? constants.BOT_SEEDS
      : ["echo","neon","murmur","flux","orbit","paper","glass","river","quiet","amber","stone","cloud","pulse","still","north","velvet"];
    for (const s of seeds){
      const w = toLower(s);
      if (!seen.has(w)) { tokens.push(w); seen.add(w); }
      if (tokens.length >= 4) break;
    }
  }

  // ensure the last token carries punctuation (no separate "." token)
  if (tokens.length === 0) return pickSeed();
  tokens[tokens.length - 1] = tokens[tokens.length - 1] + '.';
  return tokens.join(' ');
}


// ============================================================================
// --- CORE GAME LOOP ---
// ----------------------------------------------------------------------------
// Drive the round strictly by nextTickTimestamp to align exactly with the UI.
// - Fire the bot once when we pass half time and there are no submissions.
// - Elect the winner exactly when now >= nextTickTimestamp.
// ============================================================================
let botFiredThisRound = false;

setInterval(() => {
  const now = Date.now();
  const remainingMs = nextTickTimestamp - now;
  if (!Number.isFinite(remainingMs)) return;

  const halfSec = Math.floor(constants.ROUND_DURATION_SECONDS / 2);
  const remFloor = Math.max(0, Math.floor(remainingMs / 1000));
  const remCeil  = Math.max(0, Math.ceil(remainingMs / 1000));

  // BOT: Check if an hour has passed since the last bot post
  const botPostInterval = constants.BOT_INTERVAL_MINUTES * 60 * 1000; // 1 hour in milliseconds
  const canBotPost = now - lastBotPostTimestamp > botPostInterval;

  if (canBotPost && !botFiredThisRound && liveWords.size === 0) {
    if (remCeil === (halfSec)) {
      runBotSubmission();
      botFiredThisRound = true;
      lastBotPostTimestamp = now; // Update the timestamp
    } else if (remFloor === 1) {
      runBotSubmission();
      botFiredThisRound = true;
      lastBotPostTimestamp = now; // Also update the timestamp here
    }
  }

  if (remainingMs <= 0) {
    endRoundAndElectWinner();
    botFiredThisRound = false;
  }
}, 100);

// ============================================================================
// --- Periodically clean up old entries from the anonymous usage tracker
// ============================================================================
setInterval(() => {
  const oneHour = 60 * 60 * 1000;
  for (const [ip, usage] of anonUsage.entries()) {
    if (Date.now() - usage.firstPostTime > oneHour) {
      anonUsage.delete(ip);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes

// ============================================================================
// --- HISTORY AND CHUNKS SETUP ---
// ============================================================================

/**
 * @summary Seals all un-chunked words into a new, permanent chunk document.
 * @description This function reads all words that haven't been assigned to a chunk,
 * generates a cryptographic hash from them, saves the new chunk to the 'chunks'
 * collection, and then updates the original word documents to link them to the new chunk.
 */
async function sealNewChunk() {
  try {
    // 1. Find all words that have not been chunked yet.
    const wordsToChunk = await wordsCollection.find({ chunkId: null }).sort({ ts: 1 }).toArray();

    if (wordsToChunk.length === 0) {
      console.log('[history] No words to chunk.');
      return;
    }

    console.log(`[history] Sealing new chunk with ${wordsToChunk.length} words.`);

    // 2. Create the chunk object and its hash.
    const dataToHash = JSON.stringify(wordsToChunk);
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');
    const chunkText = wordsToChunk.map(w => w.word).join(' ');

    const newChunk = {
      ts: wordsToChunk[0].ts,
      hash: hash,
      text: chunkText,
      words: wordsToChunk,
    };

    // 3. Save the new chunk to the 'chunks' collection.
    const insertedChunk = await chunksCollection.insertOne(newChunk);
    const newChunkId = insertedChunk.insertedId;

    // 4. Update the original words to mark them as chunked.
    const wordIdsToUpdate = wordsToChunk.map(w => w._id);
    await wordsCollection.updateMany(
      { _id: { $in: wordIdsToUpdate } },
      { $set: { chunkId: newChunkId } }
    );

    // 5. Reset the in-memory character count.
    characterCount = 0;
    console.log(`[history] Successfully sealed chunk ${hash.substring(0, 12)}`);

  } catch (err) {
    console.error('[history] Error sealing new chunk:', err);
  }
}

/**
 * loadInitialTextFromHistory
 * --------------------------
 * Reads the latest entries from today's history file to pre-populate
 * the current text when the server starts.
 */
async function loadInitialTextFromHistory() {
  console.log('[history] Loading initial text from database...');
  try {
    // Load the most recent words for the live display
    const recentWords = await wordsCollection.find()
      .sort({ ts: -1 })
      .limit(constants.CURRENT_TEXT_LENGTH)
      .toArray();
    currentText = recentWords.reverse();
    console.log(`[history] Successfully loaded ${currentText.length} live words.`);
    currentText.forEach(w => pushBotContext(w.word));

    // Separately, calculate the character count of ALL un-chunked words
    const unchunkedWords = await wordsCollection.find({ chunkId: null }).toArray();
    characterCount = unchunkedWords.reduce((acc, word) => acc + word.word.length + 1, 0);
    console.log(`[history] Initialized un-chunked character count to: ${characterCount}`);

  } catch (error) {
    console.error('[history] Failed to load initial text:', error);
  }
}

/**
 * GET /api/history/:date
 * ----------------------
 * Returns an array of history chunks for a specific date.
 * The date parameter must be in YYYY-MM-DD format.
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

    // Find all permanent chunks within the given date range
    const chunks = await chunksCollection.find({
      ts: { $gte: startOfDay.getTime(), $lte: endOfDay.getTime() }
    }).sort({ ts: 1 }).toArray();

    res.json(chunks);
  } catch (error) {
    console.error(`[api] Error reading history for ${date}:`, error);
    res.status(500).json({ error: 'Failed to retrieve history.' });
  }
});


// ============================================================================
// --- AUTHENTICATION & SESSION MIDDLEWARE ---
// ============================================================================

/**
 * sessionMiddleware
 * -----------------
 * Configures express-session to manage user login states. The secret should
 * be a long, random string stored in an environment variable for production.
 */
const sessionMiddleware = session({
  // A secret used to sign the session ID cookie.
  secret: process.env.SESSION_SECRET || 'a-very-secret-key-for-development',
  // Don't save session if unmodified.
  resave: false,
  // Don't create session until something is stored.
  saveUninitialized: false,
  // Use secure cookies in production (requires HTTPS).
  cookie: { secure: process.env.NODE_ENV === 'production' }
});

// ============================================================================
// --- PASSPORT STRATEGY & SERIALIZATION ---
// ============================================================================

/**
 * passport.use(new GoogleStrategy(...))
 * --------------------------------------
 * Configures the strategy for authenticating users with their Google account.
 * This tells Passport how to use the client ID and secret to talk to Google.
 */
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      // Look for an existing user in the database
      let user = await usersCollection.findOne({ googleId: profile.id });

      if (!user) {
        // If the user doesn't exist, create a new one in the database
        const newUser = {
          googleId: profile.id,
          googleProfile: profile,
          username: null,
        };
        await usersCollection.insertOne(newUser);
        console.log(`[auth] New user created with Google ID: ${profile.id}`);
        return done(null, newUser);
      }
      // If user exists, return them
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }
));

/**
 * passport.serializeUser
 * ----------------------
 * Stores the user's Google ID in the session. This is the key we use
 * to look up the user in our in-memory `users` map.
 */
passport.serializeUser((user, done) => {
  done(null, user.googleId);
});

/**
 * passport.deserializeUser
 * ------------------------
 * Retrieves the full user object (including custom username) from our
 * `users` map using the Google ID stored in the session.
 */
passport.deserializeUser(async (googleId, done) => {
  try {
    const user = await usersCollection.findOne({ googleId: googleId });
    done(null, user || null);
  } catch (err) {
    done(err);
  }
});

// ============================================================================
// --- USERNAME MIDDLEWARE ---
// ============================================================================

/**
 * checkUsername
 * -------------
 * An Express middleware that checks if a logged-in user has set their
 * username. If they haven't, it redirects them to the /username.html page.
 * This should be applied to all routes that require a username.
 *
 * @param {object} req - The request object.
 * @param {object} res - The response object.
 * @param {function} next - The next middleware function.
 */
function checkUsername(req, res, next) {
  console.log(`[DEBUG] checkUsername for path: ${req.path} | Authenticated: ${req.isAuthenticated()}`);
  // Allow unauthenticated users to pass through.
  // Also, don't block the user from accessing the username page itself or the API to set it.
  if (!req.isAuthenticated() || req.path.startsWith('/username') || req.path.startsWith('/api') || req.path === '/config') {
    return next();
  }

  // If the user is authenticated but has no username, redirect them.
  if (!req.user.username) {
    return res.redirect('/username.html');
  }

  // If they have a username, proceed.
  next();
}

// ============================================================================
// --- SERVER SETUP & MIDDLEWARE ---
// ============================================================================

// Basic hardening & logs
app.use(pinoHttp());
app.use(
  helmet({
    hsts: false, // Keep HSTS disabled for local development
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": [
          "'self'",
          "https://www.googletagmanager.com",
          "'sha256-OA2+WwO3QgUk7M9ZSzbg29s8IVv30EukCadh8Y7SQYw='", // Your inline script
        ],
        // ADD THIS NEW DIRECTIVE:
        "connect-src": [
          "'self'",
          "https://region1.google-analytics.com",
        ],
      },
    },
  })
);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    cb(null, ORIGINS.includes(origin));
  }
}));

// Narrow parsers + limits (future-proof)
app.use(express.json({ limit: '2kb' }));
app.use(express.urlencoded({ extended: false, limit: '2kb' }));

// Gentle rate limit for public APIs
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(['/config', '/api', '/history'], apiLimiter);

// Initialize session and Passport AFTER other middleware
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

// Initialize static files
app.use(express.static(require('path').join(__dirname, 'public')));

// Apply the username check middleware globally after auth middleware.
// This ensures that any subsequent route handlers for authenticated users
// will only run if the user has a username.
app.use(checkUsername);

// ============================================================================
// --- APP ROUTES ---
// ============================================================================

// Health checks (for uptime monitors / load balancers)
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Returns shared constants (no secrets)
app.get('/config', (_req, res) => {
  res.json(constants);
});

// --- AUTHENTICATION ROUTES ---

/**
 * GET /auth/google
 * ----------------
 * The first step in Google authentication. Redirects the user to Google's
 * consent screen to ask for permission.
 */
app.get('/auth/google', passport.authenticate('google', { scope: ['profile'], prompt: 'select_account' }));

/**
 * GET /auth/google/callback
 * -------------------------
 * Google redirects the user back to this URL after they have authenticated.
 * Passport middleware completes the login process.
 */
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login.html' }),
  (req, res) => {
    // After successful authentication, check if the user needs to set a username.
    if (req.user && !req.user.username) {
      // If they don't have a username, send them directly to the username page.
      res.redirect('/username.html');
    } else {
      // Otherwise, send them to the main application page.
      res.redirect('/');
    }
  }
);

/**
 * GET /logout
 * -----------
 * Logs the user out by destroying their session and redirects to the home page.
 */
app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    // Destroy the session completely
    req.session.destroy((err) => {
      if (err) {
        return next(err);
      }
      // Clear the cookie and redirect
      res.clearCookie('connect.sid');
      res.redirect('/');
    });
  });
});

/**
 * GET /api/user
 * -------------
 * An API endpoint for the client-side to check if a user is currently logged in
 * and get their display name.
 */
app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    // If user is logged in, send back their name.
    res.json({ username: req.user.username, loggedIn: true });
  } else {
    // If not logged in, send back null.
    res.json({ username: null, loggedIn: false });
  }
});

/**
 * POST /api/username
 * ------------------
 * Allows a new user to set their unique username.
 */
app.post('/api/username', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  if (req.user.username) {
    return res.status(400).json({ message: 'Username has already been set.' });
  }

  const { username } = req.body;

  // Validation
  if (!username || typeof username !== 'string' || username.length < 3 || username.length > 20) {
    return res.status(400).json({ message: 'Username must be 3-20 characters long.' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ message: 'Username can only contain letters, numbers, and underscores.' });
  }

  try {
    // Check for uniqueness (case-insensitive) in the database
    const existingUser = await usersCollection.findOne({ username: { $regex: `^${username}$`, $options: 'i' } });
    if (existingUser) {
      return res.status(409).json({ message: 'Username is already taken.' });
    }

    // Save the username to the user's document in the database
    await usersCollection.updateOne(
      { googleId: req.user.googleId },
      { $set: { username: username } }
    );

    console.log(`[auth] User ${req.user.googleId} set username to: ${username}`);
    res.status(200).json({ message: 'Username saved successfully!' });
  } catch (err) {
      console.error('[auth] Error setting username:', err);
      res.status(500).json({ message: 'Error saving username.' });
  }
});

/**
 * DELETE /api/user
 * ----------------
 * Allows a logged-in user to permanently delete their account.
 */
app.delete('/api/user', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'You must be logged in to delete your account.' });
  }

  const { googleId } = req.user;
  try {
    // Remove the user from the database
    await usersCollection.deleteOne({ googleId: googleId });
    console.log(`[auth] User account deleted: ${googleId}`);

    // Log the user out completely
    req.logout((err) => {
      if (err) { console.error('[auth] Logout error during account deletion:', err); }
      req.session.destroy((err) => {
        if (err) {
          console.error('[auth] Session destruction error during account deletion:', err);
          return res.status(500).json({ message: 'Error clearing session.' });
        }
        res.clearCookie('connect.sid');
        res.status(200).json({ message: 'Account deleted successfully.' });
      });
    });
  } catch (err) {
    console.error('[auth] Error during account deletion:', err);
    res.status(500).json({ message: 'An internal error occurred while deleting the account.' });
  }
});

// ============================================================================
// --- SOCKET.IO EVENT HANDLERS ---
// ============================================================================

/**
 * wrap
 * ----
 * A helper function to adapt Express middleware for use with Socket.IO.
 * @param {Function} middleware - The Express middleware to adapt.
 */
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

// Share the Express session and Passport context with Socket.IO
io.use(wrap(sessionMiddleware));
io.use(wrap(passport.initialize()));
io.use(wrap(passport.session()));

/**
 * io.on('connection', ...)
 * ------------------------
 * Handles the main lifecycle of a client's real-time connection.
 */
io.on('connection', (socket) => {
  console.log('A user connected');
  const user = socket.request.user;
  const userId = user ? user.googleId : socket.id;

  // Send the initial state, personalized with the user's votes
  socket.emit('initialState', {
    currentText,
    liveSubmissions: getLiveFeedState(userId),
    nextTickTimestamp
  });

  /**
   * Handles a new word submission.
   */
  socket.on('wordSubmitted', (wordData) => {
    const validation = validateSubmission(wordData.word);
    if (!validation.valid) {
      socket.emit('submissionFailed', { message: validation.reason });
      return;
    }

    const user = socket.request.user;
    const userId = user ? user.googleId : socket.id;
    const username = user ? user.username : 'anonymous';

    // Remove user's previous submission
    // Iterate over the liveWords map to find and remove any existing
    // submission from this specific user before adding their new one.
    for (const [key, entry] of liveWords.entries()) {
      if (entry.submitterId === userId) {
        liveWords.delete(key);
        break; // A user can only have one submission, so we can stop searching.
      }
    }

    const compositeKey = getCompositeKey(wordData);

    // If the word doesn't exist yet, add it. This is still needed in case
    // multiple different users submit the exact same word.
    if (!liveWords.has(compositeKey)) {
      liveWords.set(compositeKey, {
        word: wordData.word,
        styles: wordData.styles,
        submitterId: userId,
        submitterName: username,
        ts: Date.now(),
        votes: new Map(),
      });
    }

    // A submission always counts as an upvote from the submitter.
    const wordEntry = liveWords.get(compositeKey);
    wordEntry.votes.set(userId, 1); // Set vote to +1 (upvote)

    broadcastLiveFeed();
  });

  /**
   * Handles an upvote or downvote action from a client.
   */
  socket.on('castVote', ({ compositeKey, direction }) => {
    const wordEntry = liveWords.get(compositeKey);
    if (!wordEntry) return; // Word might have been removed already

    // A user cannot vote on their own submitted word.
    if (wordEntry.submitterId === userId) return;

    const currentVote = wordEntry.votes.get(userId) || 0;
    let newVote = 0;

    // Determine the new vote based on the clicked direction and current vote
    if (direction === 'up') {
      newVote = (currentVote === 1) ? 0 : 1; // Toggle upvote
    } else if (direction === 'down') {
      newVote = (currentVote === -1) ? 0 : -1; // Toggle downvote
    }

    // Update or remove the user's vote in the map
    if (newVote === 0) {
      wordEntry.votes.delete(userId);
    } else {
      wordEntry.votes.set(userId, newVote);
    }

    // Recalculate the word's total score
    const totalScore = Array.from(wordEntry.votes.values()).reduce((acc, v) => acc + v, 0);

    broadcastLiveFeed();
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected');
  });
});


// ============================================================================
// --- SERVER LISTEN ---
// ============================================================================

/**
 * startServer
 * -----------
 * Initializes necessary data (like loading from history) before starting
 * the main server listener.
 */
async function startServer() {
  await connectToDatabase(); // Connect to the database before anything else
  await loadInitialTextFromHistory();
  server.listen(PORT, () => {
    console.log(`snTnz server is running at http://localhost:${PORT}`);
  });
}

/**
 * @summary Gracefully stops the server upon receiving an OS signal.
 * @description This function ensures a clean shutdown by closing active servers,
 * attempting a final save of any pending history data from memory to the
 * database, and setting a timeout to force an exit if the shutdown process hangs.
 * It's designed to prevent data loss during planned restarts or deployments.
 * @param {string} sig - The name of the OS signal that triggered the shutdown (e.g., "SIGINT", "SIGTERM").
 * @returns {void}
 * @example
 * process.once('SIGINT', () => shutdown('SIGINT'));
 */
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${sig} received`);

  // Stop taking new work
  io.close(() => console.log('[shutdown] sockets closed'));
  server.close(() => console.log('[shutdown] http server closed'));

  // Attempt to seal any remaining words into a final chunk
  try {
    console.log('[shutdown] Attempting to seal final chunk...');
    await sealNewChunk();
  } catch (err) {
    console.error('[shutdown] Final chunk seal failed:', err);
  }

  // Safety exit
  setTimeout(() => {
    console.warn('[shutdown] Graceful shutdown timed out. Exiting.');
    process.exit(0);
  }, 5000);
}

startServer();
