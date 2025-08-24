// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

require('dotenv').config();                 // Load .env file into process.env for local dev
const express = require('express');         // Web framework: routing, static files, JSON parsing
const http = require('http');               // Raw Node HTTP server (Socket.IO attaches to this)
const { Server } = require('socket.io');    // Realtime events over WebSocket (w/ graceful fallbacks)
const Filter = require('bad-words');        // Profanity filter for user-submitted tokens

const fs = require('fs');                   // Sync/streaming file ops (createReadStream, existsSync, appendFile)
const fsPromises = require('fs').promises;  // Promise-based fs APIs (readFile, access) for async/await flows

// Google Generative AI SDK (Gemini)
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Hardening helpers
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const pinoHttp = require('pino-http');

const app = express();
const server = http.createServer(app);

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
const historyDir = path.join(process.cwd(), 'history');

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
let submissionsBySocketId = new Map();
let nextTickTimestamp = Date.now() + (constants.ROUND_DURATION_SECONDS * 1000);

// ============================================================================
// --- HELPER FUNCTIONS ---
// ============================================================================
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
    // Check if the file exists
    await fsPromises.access(file);

    const data = await fsPromises.readFile(file, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      console.log('[history] History file is empty.');
      return;
    }

    // Parse all lines and immediately filter out any null/undefined entries
    const historyRecords = lines.map(line => JSON.parse(line)).filter(Boolean);

    // Take the last N records, where N is the text length constant
    const latestWords = historyRecords.slice(-constants.CURRENT_TEXT_LENGTH);

    // Directly assign the full objects.
    currentText = latestWords;

    console.log(`[history] Successfully loaded ${currentText.length} words.`);

  } catch (error) {
    // This is expected if the file doesn't exist, so we just log it.
    if (error.code === 'ENOENT') {
      console.log('[history] No history file for today. Starting with a blank slate.');
    } else {
      console.error('[history] Failed to load initial text:', error);
    }
  }
}

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
  const allCurrentSubmissions = Array.from(submissionsBySocketId.values());
  if (allCurrentSubmissions.length === 0) return [];
  const voteCounts = allCurrentSubmissions.reduce((counts, submission) => {
    const styleKey = `b:${submission.styles.bold}-i:${submission.styles.italic}-u:${submission.styles.underline}`;
    const compositeKey = `${submission.word.toLowerCase()}-${styleKey}`;
    if (!counts[compositeKey]) {
      counts[compositeKey] = { word: submission.word, count: 0, styles: submission.styles };
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
  submissionsBySocketId.clear();
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
        pct: Number(pct.toFixed(4)),
        count,
        total
    };

    // Use the single winnerRow object for both the in-memory array and the file log
    currentText.push(winnerRow);
    if (currentText.length > constants.CURRENT_TEXT_LENGTH) currentText.shift();

    pushBotContext(winner.word);
    appendHistoryLine(winnerRow);
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
 * // -> Emitted 'liveFeedUpdated' with the bot's token added to submissionsBySocketId
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
    submissionsBySocketId.set(botKey, {
      word: planned,
      styles: { bold: false, italic: false, underline: false }
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
  const noRepeats = s => {
    const toks = s.toLowerCase().replace(/[.!?]$/, '').split(/\s+/);
    const seen = new Set();
    for (const t of toks) { if (seen.has(t)) return false; seen.add(t); }
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
  submissionsBySocketId.set(botKey, {
    word,
    styles: { bold: false, italic: false, underline: false }
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

  // Half-way mark with display-friendly timing:
  const halfSec = Math.floor(constants.ROUND_DURATION_SECONDS / 2);
  const remFloor = Math.max(0, Math.floor(remainingMs / 1000));
  const remCeil  = Math.max(0, Math.ceil(remainingMs / 1000));

  if (!botFiredThisRound && submissionsBySocketId.size === 0) {
    if (remCeil === (halfSec)) {
      runBotSubmission();
      botFiredThisRound = true;
    } else if (remFloor === 1) {
      runBotSubmission();
      botFiredThisRound = true;
    }
  }

  // Election boundary
  if (remainingMs <= 0) {
    endRoundAndElectWinner();
    botFiredThisRound = false; // reset for the next round
  }
}, 100);

// ============================================================================
// --- ARCHIVE (NDJSON) SETUP ---
// ============================================================================
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
 * GET /api/history/before
 * -----------------------
 * Returns a batch of history records that occurred before a given timestamp.
 * Used for infinite scrolling upwards.
 * Query params:
 * - ts: The Unix timestamp (in ms) to fetch records before.
 * - limit: The maximum number of records to return. Defaults to 50.
 */
app.get('/api/history/before', async (req, res) => {
  const ts = parseInt(req.query.ts, 10);
  const limit = parseInt(req.query.limit, 10) || 50;
  if (!ts || !Number.isFinite(ts)) {
    return res.status(400).json({ error: 'A valid `ts` query parameter is required.' });
  }

  const oneDay = 24 * 60 * 60 * 1000;
  let cursorTs = ts;
  const out = [];

  // Helper: read a file and push records < cutoffTs (if provided)
  async function collectFromFile(filePath, cutoffTs, take = limit - out.length) {
    try {
      await fsPromises.access(filePath);
    } catch {
      return; // file for that day doesn't exist, just skip
    }
    const data = await fsPromises.readFile(filePath, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    const all = lines.map(line => JSON.parse(line));

    const picked = all
      .filter(r => (cutoffTs ? r.ts < cutoffTs : true))
      .sort((a, b) => b.ts - a.ts) // newest-first
      .slice(0, take);

    out.push(...picked);
  }

  // 1) Try same-day file first with strict ts cutoff.
  await collectFromFile(dayFilePath(cursorTs), cursorTs);

  // 2) If not enough, walk back day-by-day, no cutoff (all are older by construction).
  while (out.length < limit) {
    cursorTs -= oneDay;
    // Stop if we walked back an unreasonable amount (e.g., 365 days)
    if (ts - cursorTs > 365 * oneDay) break;
    await collectFromFile(dayFilePath(cursorTs), null);
    if (out.length === 0 && !(await fsPromises
      .access(dayFilePath(cursorTs))
      .then(() => true)
      .catch(() => false))) {
      // No file for that day; keep walking
      continue;
    }
    if (out.length >= limit) break;
    // If the previous day's file existed but contributed less than needed,
    // keep looping to even earlier days.
  }

  res.json(out.slice(0, limit));
});

/**
 * GET /api/history/:date
 * ----------------------
 * Streams the NDJSON file for a specific date.
 * The date parameter must be in YYYY-MM-DD format.
 */
app.get('/api/history/:date', (req, res) => {
  const { date } = req.params;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  // Security: Validate the date format to prevent directory traversal
  if (!dateRegex.test(date)) {
    return res.status(400).send('Invalid date format. Use YYYY-MM-DD.');
  }

  ensureHistoryDir();
  const file = path.join(historyDir, `${date}.ndjson`);

  if (!fs.existsSync(file)) {
    return res.status(404).send(`No history found for date: ${date}`);
  }

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  fs.createReadStream(file).pipe(res);
});

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
 * appendHistoryLine
 * -----------------
 * Appends one JSON line to today's NDJSON file. Creates the file/day if needed.
 *
 * @param {object} rec - Record with ts, minute, word, styles, pct, count, total, weight? (optional)
 *
 * @example
 * appendHistoryLine({ ts: Date.now(), minute: 29123456, word:"cloud", styles:{bold:false,italic:false,underline:false}, pct:62.5, count:5, total:8 });
 */
function appendHistoryLine(rec) {
  ensureHistoryDir();
  const file = dayFilePath(rec.ts);
  const line = JSON.stringify(rec) + '\n';
  fs.appendFile(file, line, 'utf8', (err) => {
    if (err) console.error('[archive] append failed:', err);
  });
}

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
// --- SERVER SETUP ---
// ============================================================================

// Basic hardening & logs
app.use(pinoHttp());
app.use(helmet({ crossOriginResourcePolicy: false }));
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

// Static files
app.use(express.static(require('path').join(__dirname, 'public')));

// Health checks (for uptime monitors / load balancers)
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Returns shared constants (no secrets)
app.get('/config', (_req, res) => {
  res.json(constants);
});


// ============================================================================
// --- SOCKET.IO EVENT HANDLERS ---
// ============================================================================
// Handles client lifecycle:
//  - On connection: send initial state (text, live feed, next tick)
//  - On wordSubmitted: validate, register/update submission, broadcast live feed
//  - On disconnect: remove pending submission and broadcast live feed
io.on('connection', (socket) => {
  console.log('A user connected');
  socket.emit('initialState', { currentText, liveSubmissions: getLiveFeedState(), nextTickTimestamp });
  socket.on('wordSubmitted', (wordData) => {
    const validation = validateSubmission(wordData.word);
    if (!validation.valid) {
      socket.emit('submissionFailed', { message: validation.reason });
      return;
    }

    // If a human submits a word, interrupt the bot's planned sentence.
    if (botQueue.length > 0) {
      console.log('[Bot] Human intervention detected. Clearing planned sentence.');
      botQueue = [];
    }
    submissionsBySocketId.set(socket.id, wordData);
    io.emit('liveFeedUpdated', getLiveFeedState());
  });
  socket.on('disconnect', () => {
    console.log('A user disconnected');
    if (submissionsBySocketId.has(socket.id)) {
      submissionsBySocketId.delete(socket.id);
      io.emit('liveFeedUpdated', getLiveFeedState());
    }
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
  await loadInitialTextFromHistory();
  server.listen(PORT, () => {
    console.log(`snTnz server is running at http://localhost:${PORT}`);
  });
}

/**
 * shutdown
 * --------
 * Gracefully stops the server when an OS signal is received.
 * - Stops accepting new HTTP connections.
 * - Closes all Socket.IO connections.
 * - Forces exit after 10s if cleanup hangs.
 *
 * @param {string} sig - Signal name (e.g., "SIGINT", "SIGTERM").
 * @returns {void}
 *
 * @example
 * process.on('SIGINT',  () => shutdown('SIGINT'));
 * process.on('SIGTERM', () => shutdown('SIGTERM'));
 */
function shutdown(sig){
  console.log(`[shutdown] ${sig} received`);
  io.close(() => console.log('[shutdown] sockets closed'));
  server.close(() => { console.log('[shutdown] http closed'); process.exit(0); });
  setTimeout(() => { console.warn('[shutdown] forcing exit'); process.exit(1); }, 10_000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer();
