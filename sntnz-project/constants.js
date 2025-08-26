// ============================================================================
// constants.js
// ----------------------------------------------------------------------------
// Shared configuration for server and client. Server imports this file directly,
// and also exposes its JSON form at GET /config so the client can fetch it.
// ============================================================================

module.exports = {
  // --- Round / sentence ---
  ROUND_DURATION_SECONDS: 60,       // Round duration in seconds
  CURRENT_TEXT_LENGTH: 100,         // Words visible in the rolling sentence

  // --- Client UX ---
  INPUT_MAX_CHARS: 40,              // Max characters in input box

  // --- Bot / seeding ---
  ANONYMOUS_NAME: "Anonymous",      // Anonymous username
  BOT_NAME: "SNTNZ_BOT",            // bot username
  BOT_LOOKBACK_MULTIPLIER: 1,       // bot scan
  BOT_SENTENCE_MAX_WORDS: 50,       // bot generation
  BOT_INTERVAL_MINUTES: 3,          // min time between bot posts
  BOT_SEEDS: ["echo","neon","murmur","flux","orbit","paper","glass","river","quiet",
               "amber","stone","cloud","pulse","still","north","velvet"],
  BOT_STOP_WORDS:['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'of', 'by', 'is', 'am', 'are', 'was', 'were', 'his', 'her', 'its', 'like'],

  // --- Validation ---
  PUNCTUATION_REGEX_STRING: "^[(\"'*_]*[a-zA-Z0-9'-]+[.,!?;:...\"'_)]*$",

  // --- History / NDJSON ---
  HISTORY_CHUNK_LENGTH: 250,        // words per block in history view
  HISTORY_DIR: "history",           // folder for daily NDJSON files
};
