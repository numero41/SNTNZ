// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

require('dotenv').config();                 // Load .env file into process.env for local dev
const express = require('express');         // Web framework: routing, static files, JSON parsing
const http = require('http');               // Raw Node HTTP server (Socket.IO attaches to this)
const { Server } = require('socket.io');    // Realtime events over WebSocket (w/ graceful fallbacks)
const Filter = require('bad-words');        // Profanity filter for user-submitted tokens
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
const profanityFilter = new Filter();

// Use the Render disk path on Render, otherwise use the local path from .env
const dataDir = process.env.DATA_PATH;

// Add a check to ensure a path is configured
if (!dataDir) {
  console.error("FATAL ERROR: No data directory path. Set DATA_PATH in .env.");
  process.exit(1); // Exit if no path is found
}

console.log(`[Storage] Using data directory: ${dataDir}`);

const historyDir = path.join(dataDir, 'history');
const usersFilePath = path.join(dataDir, 'users.json');

// Ensure directories exist on startup
if (!fs.existsSync(historyDir)) {
  fs.mkdirSync(historyDir, { recursive: true });
  console.log(`[Storage] Created storage directory: ${historyDir}`);
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
let submissionsByUserId = new Map();
let nextTickTimestamp = Date.now() + (constants.ROUND_DURATION_SECONDS * 1000);
let historyBuffer = [];
let characterCount = 0;
let lastBotPostTimestamp = 0;
let users = new Map();
let shuttingDown = false;

// ============================================================================
// --- HELPER FUNCTIONS ---
// ============================================================================
/**
 * getLiveFeedState
 * -----------------
 * Aggregates the live submissions (per-socket) into a deduplicated, counted list
 * keyed by lowercased word + style signature. Returns the list sorted by count descending.
 *
 * @returns {Array<{word: string, count: number, styles: {bold: boolean, italic: boolean, underline: boolean}}>}
 *   The current live feed "vote" state.
 *
 * @example
 * const state = getLiveFeedState();
 * // -> [{ word: "Hello", count: 3, styles: { bold:false, italic:false, underline:false } }, ...]
 */
function getLiveFeedState() {
  const allCurrentSubmissions = Array.from(submissionsByUserId.values());
  if (allCurrentSubmissions.length === 0) return [];
  const voteCounts = allCurrentSubmissions.reduce((counts, submission) => {
    const styleKey = `b:${submission.styles.bold}-i:${submission.styles.italic}-u:${submission.styles.underline}`;
    const compositeKey = `${submission.word.toLowerCase()}-${styleKey}`;
    if (!counts[compositeKey]) {
      counts[compositeKey] = {
        word: submission.word,
        count: 0,
        styles: submission.styles,
        username: submission.username
      };
    }
    counts[compositeKey].count++;
    return counts;
  }, {});
  return Object.values(voteCounts).sort((a, b) => b.count - a.count);
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
    return { valid: false, reason: '1–40 chars only' };
  }
  const punctuationRegex = new RegExp(constants.PUNCTUATION_REGEX_STRING);
  if (!punctuationRegex.test(word)) return { valid: false, reason: 'No spaces or misplaced punctuation' };
  if (profanityFilter.isProfane(word)) return { valid: false, reason: 'Offensive words are not allowed' };
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
function endRoundAndElectWinner() {
  // Immediately calculate and broadcast the timestamp for the *next* round.
  nextTickTimestamp = Date.now() + (constants.ROUND_DURATION_SECONDS * 1000);
  io.emit('nextTick', { nextTickTimestamp });

  // STEP 2: Capture the state of the round that just finished.
  const liveFeed = getLiveFeedState();

  // STEP 3: Reset the live submission state for the new round.
  submissionsByUserId.clear();
  io.emit('liveFeedUpdated', []); // Tell clients to clear their live feed display.

  // STEP 4: Now, process the winner from the captured state.
  const total = liveFeed.reduce((acc, item) => acc + item.count, 0);
  let winnerRow = null;

if (liveFeed.length > 0) {
    let winner = liveFeed[0];

    // Capitalize if previous sentence ended with punctuation
    if (currentText.length > 0) {
        const lastWordInSentence = currentText[currentText.length - 1].word;
        if (/[.!?]$/.test(lastWordInSentence)) {
            winner.word = winner.word.charAt(0).toUpperCase() + winner.word.slice(1);
        }
    }

    // Define all constants
    const ts = Date.now();
    const count = winner.count;
    const minute = Math.floor(ts / 60000);
    const pct = total > 0 ? (count / total) * 100 : 0;

    // Create the full, consistent data object
    winnerRow = {
        ts,
        minute,
        word: winner.word,
        styles: {
            bold: !!winner.styles.bold,
            italic: !!winner.styles.italic,
            underline: !!winner.styles.underline
        },
        username: winner.username,
        pct: Number(pct.toFixed(4)),
        count,
        total
    };

    // Use the single winnerRow object for both the in-memory array and the file log
    currentText.push(winnerRow);
    if (currentText.length > constants.CURRENT_TEXT_LENGTH) currentText.shift();

    pushBotContext(winner.word);
    addWordToHistoryBuffer(winnerRow);
}

  // STEP 5: FINALLY, broadcast the updated text from the completed round.
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
 * // -> Emitted 'liveFeedUpdated' with the bot's token added to submissionsByUserId
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

    const botKey = `bot_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    submissionsByUserId.set(botKey, {
      word: planned,
      styles: { bold: false, italic: false, underline: false },
      username: constants.BOT_NAME
    });
    io.emit('liveFeedUpdated', getLiveFeedState());
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
      7) Style and story: telling a global story with many fictional characters like a novel.
      inspired by the epic voices of Hugo, Dumas, Verne, Balzac, Melville, Poe, Hawthorne, Stevenson, Byron, Shelley, Coleridge, Goethe, Cervantes, Defoe, Swift, Conrad, Tolstoy, Dostoevsky, Dickens, Agatha Christie and related.
      You must NOT reuse their characters names, but rather invent new ones.
      MANDATORY: The story must EVOLVE related to the previous content in order to have a global meaning. You need to AVOID repeating the same story over and over.
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
  const botKey = `bot_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  submissionsByUserId.set(botKey, {
    word,
    styles: { bold: false, italic: false, underline: false },
    username: constants.BOT_NAME
  });

  // Broadcast the refreshed live feed
  io.emit('liveFeedUpdated', getLiveFeedState());
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

  if (canBotPost && !botFiredThisRound && submissionsByUserId.size === 0) {
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
// --- USERS STORAGE ---
// ============================================================================

/**
 * saveUsersToFile
 * ---------------
 * Saves the current in-memory users map to a JSON file on disk.
 */
async function saveUsersToFile() {
  // Convert Map to an array of [key, value] pairs for JSON compatibility
  const usersArray = Array.from(users.entries());
  try {
    await fsPromises.writeFile(usersFilePath, JSON.stringify(usersArray, null, 2));
  } catch (err) {
    console.error('[db] Error saving users to file:', err);
  }
}

/**
 * loadUsersFromFile
 * -----------------
 * Loads the users from the JSON file into the in-memory map on startup.
 */
async function loadUsersFromFile() {
  try {
    await fsPromises.access(usersFilePath);
    const data = await fsPromises.readFile(usersFilePath, 'utf8');
    const usersArray = JSON.parse(data);
    // Convert the array back into a Map
    users = new Map(usersArray);
    console.log(`[db] Successfully loaded ${users.size} users from disk.`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('[db] users.json not found. Starting with an empty user database.');
    } else {
      console.error('[db] Error loading users from file:', err);
    }
  }
}

// ============================================================================
// --- HISTORY AND CHUNKS SETUP ---
// ============================================================================

/**
 * ensureHistoryDir
 * ----------------
 * Lazily ensures the ./history directory exists.
 *
 * @example
 * ensureHistoryDir();
 */
function ensureHistoryDir() {
  if (!fs.existsSync( historyDir)) {
    fs.mkdirSync( historyDir, { recursive: true });
  }
}

/**
 * dayFilePath
 * -----------
 * Returns the NDJSON file path for a given timestamp's UTC date.
 *
 * @param {number} tsMs - Unix epoch in milliseconds.
 * @returns {string} - Full path like ./history/2025-08-23.ndjson
 *
 * @example
 * const p = dayFilePath(Date.now());
 */
function dayFilePath(tsMs) {
  const d = new Date(tsMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return path.join( historyDir, `${yyyy}-${mm}-${dd}.ndjson`);
}

/**
 * finalizeAndSaveChunk
 * --------------------
 * Hashes and saves the current history buffer to a file.
 */
async function finalizeAndSaveChunk() {
  if (historyBuffer.length === 0) return;

  console.log(`[history] Finalizing chunk with ${characterCount} chars.`);

  // Create a canonical string representation of the word data, including styles.
  // Hashing this ensures the integrity of the content and its formatting.
  const dataToHash = JSON.stringify(historyBuffer);
  const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');

  const chunkText = historyBuffer.map(w => w.word).join(' ');

  // The final chunk object to be saved.
  const chunkObject = {
    ts: historyBuffer[0].ts,
    hash: hash,
    text: chunkText,
    words: [...historyBuffer], // Full word data for rich client-side rendering
  };

  const file = dayFilePath(chunkObject.ts);
  const line = JSON.stringify(chunkObject) + '\n';

  try {
    await fsPromises.appendFile(file, line, 'utf8');
    console.log(`[history] Successfully saved chunk ${hash.substring(0, 7)}`);
  } catch (err) {
    console.error('[archive] append failed:', err);
  }

  // Reset the buffer for the next chunk.
  historyBuffer = [];
  characterCount = 0;
}

/**
 * finalizeAndSaveChunkSync
 * ------------------------
 * Synchronous fallback to persist the current history buffer when the process
 * is being terminated and async I/O may not complete in time.
 * - Writes the same shape as finalizeAndSaveChunk()
 * - Resets the in-memory buffer like the async version
 *
 * @returns {void}
 *
 * @example
 * finalizeAndSaveChunkSync();
 */
function finalizeAndSaveChunkSync() {
  try {
    if (historyBuffer.length === 0) return;

    // Build canonical payload (same as async version)
    const dataToHash = JSON.stringify(historyBuffer);
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');
    const chunkText = historyBuffer.map(w => w.word).join(' ');

    const chunkObject = {
      ts: historyBuffer[0].ts,
      hash: hash,
      text: chunkText,
      words: [...historyBuffer], // full word data for rich rendering
    };

    // Ensure directory exists and append synchronously
    ensureHistoryDir();
    const file = dayFilePath(chunkObject.ts);
    const line = JSON.stringify(chunkObject) + '\n';
    fs.appendFileSync(file, line, 'utf8');

    // Reset buffers (mirror async behavior)
    historyBuffer = [];
    characterCount = 0;

    console.log(`[history] Sync-saved final chunk ${hash.substring(0, 7)}`);
  } catch (err) {
    console.error('[history] Sync save failed:', err);
  }
}

/**
 * addWordToHistoryBuffer
 * ----------------------
 * Adds a winning word to the history buffer and finalizes a chunk if full.
 * @param {Object} wordObject - The winning word object.
 */
async function addWordToHistoryBuffer(wordObject) {
  const wordLength = wordObject.word.length + 1; // +1 for the space

  // If adding the new word would exceed the chunk length, save the current chunk first.
  if (historyBuffer.length > 0 && characterCount + wordLength > constants.HISTORY_CHUNK_LENGTH) {
    await finalizeAndSaveChunk();
  }

  historyBuffer.push(wordObject);
  characterCount += wordLength;
}

/**
 * GET /api/history/dates
 * ----------------------
 * Returns a sorted list of dates for which history files are available.
 * The dates are in YYYY-MM-DD format, from most to least recent.
 */
app.get('/api/history/dates', (req, res) => {
  ensureHistoryDir();
  fs.readdir(historyDir, (err, files) => {
    if (err) {
      console.error('[api] Failed to read history directory:', err);
      return res.status(500).json({ error: 'Could not list history files.' });
    }
    const dates = files
      .filter(file => file.endsWith('.ndjson'))
      .map(file => file.replace('.ndjson', ''))
      .sort()
    res.json(dates);
  });
});

/**
 * loadInitialTextFromHistory
 * --------------------------
 * Reads the latest entries from today's history file to pre-populate
 * the current text when the server starts.
 */
async function loadInitialTextFromHistory() {
  console.log('[history] Loading initial text from archive...');
  try {
    const file = dayFilePath(Date.now());
    await fsPromises.access(file); // Check if the file exists

    const data = await fsPromises.readFile(file, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      console.log('[history] History file is empty.');
      return;
    }

    // CORRECT LOGIC: Extract words from chunks, then take the last N words.
    const allWordsFromChunks = lines
      .map(line => {
        try { return JSON.parse(line); } catch { return null; } // Safely parse JSON
      })
      .filter(chunk => chunk && Array.isArray(chunk.words)) // Ensure it's a valid chunk
      .flatMap(chunk => chunk.words); // Flatten all 'words' arrays into one

    // Take the last N words for the initial state.
    currentText = allWordsFromChunks.slice(-constants.CURRENT_TEXT_LENGTH);

    console.log(`[history] Successfully loaded ${currentText.length} words.`);
    // Also populate the bot context from this loaded history
    currentText.forEach(w => pushBotContext(w.word));

  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[history] No history file for today. Starting with a blank slate.');
    } else {
      console.error('[history] Failed to load initial text:', error);
    }
  }
}

/**
 * GET /api/history/before
 * -----------------------
 * Returns a batch of word objects that occurred before a given timestamp.
 * Used for the main page's infinite scroll.
 */
app.get('/api/history/before', async (req, res) => {
  const ts = parseInt(req.query.ts, 10);
  const limit = parseInt(req.query.limit, 10) || 50;
  if (!ts || !Number.isFinite(ts)) {
    return res.status(400).json({ error: 'A valid `ts` query parameter is required.' });
  }

  const oneDay = 24 * 60 * 60 * 1000;
  let cursorTs = ts;
  let results = [];

  // Helper to read a file and extract all words from its chunks
  async function collectWordsFromFile(filePath) {
    try {
      await fsPromises.access(filePath);
      const data = await fsPromises.readFile(filePath, 'utf8');
      const lines = data.trim().split('\n').filter(Boolean);
      const chunks = lines.map(line => JSON.parse(line));
      // Use flatMap to get all words from all chunks in the file
      // It safely handles old "word" objects by returning [] for them.
      return chunks.flatMap(chunk => chunk.words || []);
    } catch {
      return []; // Return empty array if file doesn't exist or fails
    }
  }

  // Keep searching backwards day-by-day until we find enough older words
  for (let i = 0; i < 365; i++) { // Limit search to 1 year
    const wordsFromFile = await collectWordsFromFile(dayFilePath(cursorTs));

    // Find words in this file that are ACTUALLY older than our timestamp
    const olderWordsInFile = wordsFromFile.filter(word => word.ts < ts);
    results.push(...olderWordsInFile);

    // If we have found enough, we can stop searching.
    if (results.length >= limit) {
      break;
    }

    // Move to the previous day for the next iteration
    cursorTs -= oneDay;
  }

  // Sort and slice the final combined list of words
  const finalResults = results
    .sort((a, b) => b.ts - a.ts) // Newest first
    .slice(0, limit);

  res.json(finalResults);
});

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

  ensureHistoryDir();
  const file = path.join(historyDir, `${date}.ndjson`);

  try {
    await fsPromises.access(file); // Check if file exists
    const fileContent = await fsPromises.readFile(file, 'utf-8');
    if (!fileContent.trim()) return res.json([]); // Handle empty file

    const lines = fileContent.trim().split('\n');
    const chunks = lines.map(line => JSON.parse(line));
    res.json(chunks);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: `No history found for date: ${date}` });
    }
    console.error(`[api] Error reading history for ${date}:`, error);
    res.status(500).json({ error: 'Failed to retrieve history.' });
  }
});

/**
 * GET /history/today.ndjson
 * -------------------------
 * Streams today's NDJSON file if it exists.
 */
app.get('/history/today.ndjson', (req, res) => {
  ensureHistoryDir();
  const file = dayFilePath(Date.now());
  if (!fs.existsSync(file)) return res.status(404).send('No history yet.');
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  fs.createReadStream(file).pipe(res);
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
    // Credentials from the Google Cloud Console.
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // The URL Google will redirect to after the user grants permission.
    callbackURL: "/auth/google/callback"
  },
  (accessToken, refreshToken, profile, done) => {
    // Find or create a user in our "database"
    let user = users.get(profile.id);

    if (!user) {
      // If the user doesn't exist, create a new record for them.
      // The `username` is initially null.
      user = {
        googleId: profile.id,
        googleProfile: profile, // Store the original profile
        username: null,
      };
      users.set(profile.id, user);
      saveUsersToFile();
      console.log(`[auth] New user created with Google ID: ${profile.id}`);
    }

    // Pass the user object to the `done` callback.
    return done(null, user);
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
passport.deserializeUser((googleId, done) => {
  const user = users.get(googleId);
  console.log('[DEBUG] Deserializing user:', user);
  done(null, user || null);
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
          "'sha256-GgZ3hhZKwUu/qF2+i/fRQjMZt6bwv8t41R8t9vHbIJE='", // Your inline script
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
app.post('/api/username', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: 'You must be logged in.' });
  }

  if (req.user.username) {
    return res.status(400).json({ message: 'Username has already been set.' });
  }

  // Get the username
  const { username } = req.body;

  // Validation
  if (!username || typeof username !== 'string' || username.length < 3 || username.length > 20) {
    return res.status(400).json({ message: 'Username must be 3-20 characters long.' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ message: 'Username can only contain letters, numbers, and underscores.' });
  }

  // Check for uniqueness
  for (const u of users.values()) {
    if (u.username && u.username.toLowerCase() === username.toLowerCase()) {
      return res.status(409).json({ message: 'Username is already taken.' });
    }
  }

  // Save the username
  req.user.username = username;
  users.set(req.user.googleId, req.user);

  // Explicitly save the session before responding
  req.session.save((err) => {
    if (err) {
      console.error('[auth] Session save error:', err);
      return res.status(500).json({ message: 'Error saving session.' });
    }
    console.log(`[auth] User ${req.user.googleId} set username to: ${username}`);
    saveUsersToFile();
    res.status(200).json({ message: 'Username saved successfully!' });
  });
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
    // Remove the user from the in-memory map
    if (users.has(googleId)) {
      users.delete(googleId);
      await saveUsersToFile(); // Persist the change
      console.log(`[auth] User account deleted: ${googleId}`);
    }

    // Log the user out completely
    req.logout((err) => {
      if (err) {
        console.error('[auth] Logout error during account deletion:', err);
        // Continue to destroy session even if logout has an error
      }
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

  // Get the user object from the socket's handshake request.
  // This is available because of the middleware we just added.
  const user = socket.request.user;

  // Track the user if they are logged in
  if (user && user.username) {
    connectedUsers.set(socket.id, {
      username: user.username,
      googleId: user.googleId,
    });
    // Broadcast the new user list to everyone
    io.emit('userListUpdated', Array.from(connectedUsers.values()));
  }

  // Send the initial state of the application to the newly connected client.
  socket.emit('initialState', { currentText, liveSubmissions: getLiveFeedState(), nextTickTimestamp });

  /**
   * socket.on('wordSubmitted', ...)
   * -------------------------------
   * Handles a word submission from a client. It validates the user's
   * authentication status and the word itself before adding it to the live feed.
   * If the user is not logged in, the submission is attributed to "anonymous".
   */
  socket.on('wordSubmitted', (wordData) => {
    // Validate the submitted word format first.
    const validation = validateSubmission(wordData.word);
    if (!validation.valid) {
      socket.emit('submissionFailed', { message: validation.reason });
      return;
    }

    // Determine the user and a unique ID for this round's submission.
    const user = socket.request.user;
    const isAnonymous = !user || !user.username;
    const username = isAnonymous ? 'anonymous' : user.username;
    // Use Google ID for logged-in users, or socket ID for anonymous ones.
    const submissionId = isAnonymous ? socket.id : user.googleId;

    // If a human submits, clear any planned sentence from the bot.
    if (botQueue.length > 0) {
      console.log('[Bot] Human intervention detected. Clearing planned sentence.');
      botQueue = [];
    }

    // Create the submission object.
    const submission = {
      word: wordData.word,
      styles: wordData.styles,
      username: username
    };

    submissionsByUserId.set(submissionId, submission);
    io.emit('liveFeedUpdated', getLiveFeedState());
  });

  /**
   * socket.on('disconnect', ...)
   * ----------------------------
   * Cleans up when a user disconnects by removing their pending word submission.
   */
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
  await loadUsersFromFile();
  await loadInitialTextFromHistory();
  server.listen(PORT, () => {
    console.log(`snTnz server is running at http://localhost:${PORT}`);
  });
}

/**
 * shutdown
 * --------
 * Gracefully stops the server when an OS signal is received.
 * - Stops accepting new HTTP connections and closes Socket.IO.
 * - Immediately attempts to persist any pending history.
 * - Uses async finalize with a short timeout, then sync fallback if needed.
 * - Forces exit after a safety window if cleanup hangs.
 *
 * @param {string} sig - Signal name (e.g., "SIGINT", "SIGTERM").
 * @returns {void}
 *
 * @example
 * process.once('SIGINT',  () => shutdown('SIGINT'));
 * process.once('SIGTERM', () => shutdown('SIGTERM'));
 */
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[shutdown] ${sig} received`);

  // 1) Stop taking new work as early as possible
  try {
    io.close(() => console.log('[shutdown] sockets closed'));
  } catch (e) {
    console.warn('[shutdown] io.close error:', e?.message || e);
  }

  try {
    server.close(() => console.log('[shutdown] http server closed'));
  } catch (e) {
    console.warn('[shutdown] server.close error:', e?.message || e);
  }

  // 2) Persist any partial history right away
  try {
    const FINALIZE_TIMEOUT_MS = 2500; // short budget before Render’s hard kill
    await Promise.race([
      finalizeAndSaveChunk(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('finalize-timeout')), FINALIZE_TIMEOUT_MS)),
    ]);
    console.log('[shutdown] Final history chunk saved (async).');
  } catch (e) {
    console.warn('[shutdown] Async finalize failed or timed out, using sync fallback:', e?.message || e);
    finalizeAndSaveChunkSync();
  }

  // 3) Safety exit: allow pending closes to settle, then exit
  const FORCE_EXIT_AFTER_MS = 25000; // stay under typical PaaS 30s kill window
  setTimeout(() => {
    console.warn('[shutdown] Graceful shutdown timed out. Exiting.');
    process.exit(0);
  }, FORCE_EXIT_AFTER_MS);
}

process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Crash guards: Ensure we don't lose the current chunk on unexpected crashes.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  try { finalizeAndSaveChunkSync(); } finally { process.exit(1); }
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  try { finalizeAndSaveChunkSync(); } finally { process.exit(1); }
});

startServer();
