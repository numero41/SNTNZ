// ============================================================================
// constants.js
// ----------------------------------------------------------------------------
// Shared configuration for server and client. Server imports this file directly,
// and also exposes its JSON form at GET /config so the client can fetch it.
// ============================================================================

const ROUND_DURATION_SECONDS = 10;

module.exports = {
  // --- Round / sentence ---
  ROUND_DURATION_SECONDS: 60,       // round duration
  CURRENT_TEXT_LENGTH: 500,         // words visible in the rolling sentence

  // --- Client UX ---
  INPUT_MAX_CHARS: 40,              // enforce client + server

  // --- Bot / seeding ---
  BOT_LOOKBACK_MULTIPLIER: 1,       // bot scan
  BOT_SENTENCE_MAX_WORDS: 50,       // bot generation
  BOT_SEEDS: ["echo","neon","murmur","flux","orbit","paper","glass","river","quiet",
               "amber","stone","cloud","pulse","still","north","velvet"],

  // --- Validation ---
  PUNCTUATION_REGEX_STRING: "^[(\"'*_]*[a-zA-Z0-9'-]+[.,!?;:...\"'_)]*$",

  // --- History / NDJSON ---
  HISTORY_DIR: "history",           // folder for daily NDJSON files
};
