// ============================================================================
// SN-TN-Z: CLIENT.JS
// ----------------------------------------------------------------------------
// Main application entry point. Handles server communication via Socket.IO,
// manages core application state, and orchestrates UI updates by calling
// functions from the dedicated ui.js module.
// ============================================================================

import * as ui from './main-ui.js';

// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

const socket = io({ transports: ['websocket'] });
let CFG = null; // Holds config values fetched from the server.
let nextTickTimestamp = 0;

/**
 * Main boot function to initialize the application.
 */
(async function boot() {
  const response = await fetch('/config', { cache: 'no-store' });
  CFG = await response.json();

  ui.init(socket, CFG); // Initialize all UI components and event listeners.
  await ui.updateUserStatus();
})();


// ============================================================================
// --- SYNCHRONIZED TIMER LOGIC ---
// ============================================================================

let clearedAtZero = false;

// Updates the countdown timer every 50ms based on server's nextTickTimestamp.
setInterval(() => {
  if (nextTickTimestamp === 0) return;

  const remainingMs = nextTickTimestamp - Date.now();
  if (remainingMs <= 0) return;

  const remainingSeconds = Math.min(
    CFG.ROUND_DURATION_SECONDS,
    Math.max(0, Math.ceil(remainingMs / 1000))
  );

  ui.updateTimerDisplay(remainingSeconds);

  // Clear the live feed when the timer hits zero.
  if (remainingSeconds === 0 && !clearedAtZero) {
    ui.renderLiveFeed([]);
    clearedAtZero = true;
  }
}, 50);


// ============================================================================
// --- SOCKET.IO EVENT LISTENERS ---
// ============================================================================

/**
 * Fired once on connection to receive the complete initial state.
 */
socket.on('initialState', ({ initialChapters, liveSubmissions, nextTickTimestamp: serverTimestamp, latestImageUrl }) => {
  ui.renderInitialState({ currentText: initialChapters, liveSubmissions, latestImageUrl });
  nextTickTimestamp = serverTimestamp;
});

/**
 * Fired at the start of each new round with the timestamp for the next tick.
 */
socket.on('nextTick', ({ nextTickTimestamp: serverTimestamp }) => {
  nextTickTimestamp = serverTimestamp;
  clearedAtZero = false;
});

/**
 * Fired whenever the list of live submissions changes.
 */
socket.on('liveFeedUpdated', (feedData) => {
  ui.renderLiveFeed(feedData);
});

/**
 * Fired when the server begins generating a new image.
 */
socket.on('imageGenerationStarted', () => {
  ui.showImageGenerationPlaceholder();
});

/**
 * Fired when a new chapter is sealed and a new image is available.
 */
socket.on('newImageSealed', ({ imageUrl }) => {
  ui.handleNewSealedImage(imageUrl);
});

/**
 * Fired when the winning word is added to the story.
 */
socket.on('currentTextUpdated', (newCurrentText) => {
  ui.appendNewWord(newCurrentText);
});

/**
 * Fired if the server rejects a user's word submission.
 */
socket.on('submissionFailed', (data) => {
  ui.showFeedback(data.message, "error");
});