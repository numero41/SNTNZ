// ============================================================================
// SN-TN-Z: UI.JS
// ----------------------------------------------------------------------------
// Manages all DOM interactions, event listeners, and rendering logic for the
// application. This module exports functions to be called by client.js in
// response to server events and user actions.
// ============================================================================

import { addTooltipEvents, renderContributorsDropdown, startSealCountdown, throttle } from './shared-ui.js';

// --- MODULE STATE ---
// These variables hold the state of the UI throughout the application's lifecycle.
// ----------------------------------------------------------------------------
let socket = null; // The main WebSocket connection instance.
let CFG = null; // The application configuration object from the server.
let currentWordsArray = []; // A client-side cache of the words currently displayed.
let selectedStyles = { bold: false, italic: false, underline: false, newline: false }; // Tracks active text styles for submission.
let feedbackTimeout; // A timeout ID for hiding feedback messages.
let lastScrollHeight = 0; // Stores the scroll height to detect changes.
let isLoadingMore = false; // A flag to prevent multiple history loads simultaneously.
let noMoreHistory = false; // A flag to indicate if all history has been loaded.
let isBooting = true; // A flag to manage initial scroll behavior on load.
let currentUser = { loggedIn: false, username: null }; // Stores the current user's status.
let userVotes = {}; // Tracks the user's own votes ('up' or 'down') for each word.
let latestImageUrlOnLoad = null; // Default image URL
let imageTimeline = []; // Store image data in memory.
let isImageGenerating = false;
let pendingImageUrl = null;

// --- DOM ELEMENT REFERENCES ---
// Caching DOM elements for performance to avoid repeated queries.
// ----------------------------------------------------------------------------
const latestImageContainer = document.getElementById('latestImageContainer');
const timerElement = document.getElementById('sealTimerContainer');
const imageModal = document.getElementById('imageModal');
const fullSizeImage = document.getElementById('fullSizeImage');
const currentTextContainer = document.getElementById('currentTextContainer');
const currentTextWrapper = document.getElementById('currentTextWrapper');
const btnUp = document.getElementById('btnScrollUp');
const btnDown = document.getElementById('btnScrollDown');
const btnCurrent = document.getElementById('btnScrollCurrent');
const btnOpenHistory = document.getElementById('btnOpenHistory');
const liveFeedList = document.getElementById('liveFeedList');
const wordForm = document.getElementById('wordForm');
const wordInput = document.getElementById('wordInput');
const timerDisplay = document.getElementById('timer');
const styleOptions = document.getElementById('styleOptions');
const styleButtons = Array.from(document.querySelectorAll('[data-style="bold"], [data-style="italic"], [data-style="underline"], [data-style="newline"]'));
const feedbackMessage = document.getElementById('feedbackMessage');
const tooltip = document.getElementById('wordTooltip');
const btnInfo = document.getElementById('btnInfo');
const infoModal = document.getElementById('infoModal');
const userStatusEl = document.getElementById('userStatus');
const mainContributorsContainer = document.getElementById('mainContributorsContainer');
const modalOverlay = infoModal ? infoModal.querySelector('.modal-overlay') : null;
const modalClose = infoModal ? infoModal.querySelector('.modal-close') : null;

// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

/**
 * Initializes the UI module, sets up all event listeners.
 * This is the entry point for the UI logic, called once from client.js.
 * @param {Socket} socketInstance - The main Socket.IO instance.
 * @param {Object} config - The application configuration object.
 */
export function init(socketInstance, config) {
  // --- Store Core Instances ---
  socket = socketInstance;
  CFG = config;

  // --- Attach Event Listeners ---
  // Delegates the setup of all event listeners to dedicated functions.
  addNavEvents();
  addTooltipEvents(currentTextContainer, tooltip);
  addInfoModalEvents();
  addImageModalEvents();
  addFormAndStyleEvents();
  initSealCountdown(CFG.HISTORY_CHUNK_SCHEDULE_CRON);
}


// ============================================================================
// --- RENDER FUNCTIONS ---
// These functions are responsible for updating the DOM.
// ============================================================================

/**
 * Renders the initial state of the application on first load.
 * @param {Object} initialState - The full initial state object from the server.
 */
export function renderInitialState({ currentText: initialChunks, liveSubmissions, latestImageUrl }) {
  currentTextContainer.innerHTML = '';
  imageTimeline = []; // Clear the timeline on re-init
  currentWordsArray = []; // Clear the words array

  // Process each chunk to render words and build the timeline
  initialChunks.forEach(chunk => {
      if (!chunk.words || chunk.words.length === 0) return;

      renderWords(chunk.words); // Render the words from the chunk
      currentWordsArray.push(...chunk.words); // Add words to our flat array for other features

      // If the chunk has an image, add its time range to our timeline
      if (chunk.imageUrl) {
          imageTimeline.push({
              start_ts: chunk.words[0].ts,
              end_ts: chunk.words[chunk.words.length - 1].ts,
              imageUrl: chunk.imageUrl
          });
      }
  });

  latestImageUrlOnLoad = latestImageUrl;
  renderLiveFeed(liveSubmissions);
  renderContributorsDropdown(mainContributorsContainer, currentWordsArray, currentTextContainer);
  renderLatestImage(latestImageUrl);

  // --- Force Scroll to Bottom ---
  // This complex sequence ensures the view starts at the most recent word,
  // even on browsers that might interfere with simple scroll assignments on load.
  const el = currentTextContainer;
  const prevBehavior = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto'; // Temporarily disable smooth scrolling for an instant jump.

  // Using requestAnimationFrame ensures these DOM manipulations happen after the
  // browser has finished its current paint cycle, preventing race conditions.
  requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight; // Jump to the bottom.
      requestAnimationFrame(() => {
          // A second frame is used as a fallback for tricky rendering engines.
          el.scrollTop = el.scrollHeight;
          el.style.scrollBehavior = prevBehavior; // Restore original scroll behavior.
          lastScrollHeight = el.scrollHeight;
          isBooting = false; // Mark the boot process as complete.
          updateScrollEffects(); // Update UI elements like scroll fades.
      });
  });
}

/**
 * Renders the latest AI-generated image at the top of the page.
 * If no image URL is provided, it displays a placeholder message.
 * @param {string|null} imageUrl - The public URL of the image.
 */
export function renderLatestImage(imageUrl) {
  if (!latestImageContainer) return;

  const currentImg = latestImageContainer.querySelector('img');

  if (imageUrl) {
    // Avoid reloading the same image
    if (currentImg && currentImg.src === imageUrl) {
      return;
    }

    // Preload, then swap in and fade via .loaded
    const img = new Image();
    img.alt = 'AI-generated image for the current story chunk';
    img.onload = () => {
      latestImageContainer.innerHTML = '';
      latestImageContainer.appendChild(img);
    };
    img.src = imageUrl; // start loading
  } else {
    latestImageContainer.innerHTML = `<div class="image-placeholder-text">No image for this chunk</div>`;
  }
}

/**
 * Displays a "Generating..." placeholder in the image container, but only
 * if the currently displayed image is the most recent one.
 */
export function showImageGenerationPlaceholder() {
  if (!latestImageContainer) return;
  isImageGenerating = true;

  const currentImg = latestImageContainer.querySelector('img');

  // We only want to show the placeholder if the user is looking at the "live"
  // edge of the story. We check this by seeing if the currently displayed
  // image source matches our record of the latest available image.
  if (currentImg && currentImg.src === latestImageUrlOnLoad) {
    latestImageContainer.innerHTML = `<div class="image-generating-text">Generating new image...</div>`;
  }
}

/**
 * Appends a new word to the main text display and handles scrolling.
 * @param {Array<Object>} newCurrentText - The full, updated text array from the server.
 */
export function appendNewWord(newCurrentText) {
    // --- Determine Scroll Position ---
    const el = currentTextContainer;
    const scrollBuffer = 5; // A small buffer to account for rendering inconsistencies.
    // Check if the user is scrolled to the very bottom before the new word is added.
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= scrollBuffer;

    // --- Get New Word and Validate ---
    const newWord = newCurrentText[newCurrentText.length - 1];
    const lastWordInClientArray = currentWordsArray[currentWordsArray.length - 1];

    // Prevent rendering if the new word is missing or is a duplicate of the last one.
    // This can happen due to network latency or server-side race conditions.
    if (!newWord || (lastWordInClientArray && lastWordInClientArray.ts === newWord.ts)) {
        return;
    }

    // --- Render and Manage Content ---
    // Render only the single new word for efficiency.
    renderWords([newWord]);

    const newHeight = el.scrollHeight;
    // If the user was at the bottom and the container grew, remove the top line
    // to maintain a consistent amount of content and prevent infinite growth.
    if (wasAtBottom && lastScrollHeight > 0 && newHeight > lastScrollHeight) {
        removeFirstRenderedLine();
    }

    // --- Update State ---
    currentWordsArray.push(newWord); // Add the new word to our client-side array.
    renderContributorsDropdown(mainContributorsContainer, currentWordsArray, currentTextContainer);
    lastScrollHeight = el.scrollHeight;

    // --- Auto-scroll if Necessary ---
    // If the user was at the bottom, keep them there by scrolling down again.
    if (wasAtBottom) {
        el.scrollTop = el.scrollHeight;
    }
}


/**
 * Renders an array of words by appending them to the container.
 * @param {Array<Object>} wordsArray - The array of word data to render.
 */
export function renderWords(wordsArray) {
  wordsArray.forEach((wordData) => {
    // --- Handle Newlines ---
    // If the word object has the newline style, insert a <br> element.
    if (wordData.styles && wordData.styles.newline) {
        const br = document.createElement('br');
        currentTextContainer.appendChild(br);
    }

    // --- Create Word Element ---
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';

    // --- Set Data Attributes ---
    // Store metadata directly on the element for tooltips and other interactions.
    wordSpan.dataset.ts = wordData.ts;
    wordSpan.dataset.username = wordData.username;
    wordSpan.dataset.count = wordData.count;
    wordSpan.dataset.total = wordData.total;
    wordSpan.dataset.pct = wordData.pct;

    // --- Set Content and Styles ---
    wordSpan.textContent = wordData.word; // Add a space for separation.
    wordSpan.style.fontWeight = wordData.styles.bold ? 'bold' : 'normal';
    wordSpan.style.fontStyle = wordData.styles.italic ? 'italic' : 'normal';
    wordSpan.style.textDecoration = wordData.styles.underline ? 'underline' : 'none';

    // --- Append to DOM ---
    currentTextContainer.appendChild(wordSpan);
    currentTextContainer.appendChild(document.createTextNode(' '));
  });
  // After adding words, update any related UI elements like scroll fades.
  updateScrollEffects();
}

/**
 * Renders the live submissions feed with upvote/downvote controls.
 * This function is now simpler: it just displays the data sent by the server.
 * @param {Array<Object>} feedData - Array of live feed items from the server.
 * Each item includes a `userVote` property ('up', 'down', or null).
 */
export function renderLiveFeed(feedData) {
  liveFeedList.innerHTML = ''; // Clear the list before re-rendering.

  // --- Handle Empty State ---
  if (feedData.length === 0) {
    const placeholder = document.createElement('li');
    placeholder.textContent = 'No words submitted by anyone yet';
    placeholder.className = 'placeholder';
    liveFeedList.appendChild(placeholder);
    return;
  }

  const maxVotes = feedData.length > 0 ? feedData[0].count : 1;

  // --- Iterate and Render Each Item ---
  feedData.forEach(item => {
    const newWordItem = document.createElement('li');
    newWordItem.className = 'live-feed-item';

    // --- Create all visual elements ---
    const voteControls = document.createElement('div');
    voteControls.className = 'vote-controls';
    const upvoteBtn = document.createElement('button');
    upvoteBtn.className = 'vote-btn upvote';
    upvoteBtn.textContent = '▲';
    const countSpan = document.createElement('span');
    countSpan.className = 'vote-count';
    countSpan.textContent = item.count;
    const downvoteBtn = document.createElement('button');
    downvoteBtn.className = 'vote-btn downvote';
    downvoteBtn.textContent = '▼';
    const wordContent = document.createElement('div');
    wordContent.className = 'word-content';
    if (item.styles.newline) {
      const newlineSpan = document.createElement('span');
      newlineSpan.textContent = '↵';
      newlineSpan.style.marginRight = '0.25rem';
      newlineSpan.style.color = 'var(--color-grey2)';
      wordContent.appendChild(newlineSpan);
    }
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word-text';
    wordSpan.textContent = item.word;
    wordSpan.style.fontWeight = item.styles.bold ? 'bold' : 'normal';
    wordSpan.style.fontStyle = item.styles.italic ? 'italic' : 'normal';
    wordSpan.style.textDecoration = item.styles.underline ? 'underline' : 'none';
    const authorSpan = document.createElement('span');
    authorSpan.textContent = ` (by ${item.username})`;
    authorSpan.className = 'word-submit-details';

    // --- Check data from server to highlight the user's current vote ---
    if (item.userVote === 'up') {
      upvoteBtn.classList.add('active');
    } else if (item.userVote === 'down') {
      downvoteBtn.classList.add('active');
    }

    // --- Disable buttons on the user's own word ---
    if (currentUser.loggedIn && item.username === currentUser.username) {
      upvoteBtn.disabled = true;
      downvoteBtn.disabled = true;
      voteControls.title = "You cannot vote on your own word.";
    }

    // --- Event listeners ONLY tell the server what happened ---
    upvoteBtn.addEventListener('click', () => {
      socket.emit('castVote', { compositeKey: item.compositeKey, direction: 'up' });
    });

    downvoteBtn.addEventListener('click', () => {
      socket.emit('castVote', { compositeKey: item.compositeKey, direction: 'down' });
    });

    // --- Assemble and append all elements ---
    const voteRatio = Math.max(0, item.count / maxVotes);
    const lightness = (1 - voteRatio) * 75;
    wordContent.style.color = `hsl(0, 0%, ${lightness}%)`;
    voteControls.appendChild(upvoteBtn);
    voteControls.appendChild(countSpan);
    voteControls.appendChild(downvoteBtn);
    wordContent.appendChild(wordSpan);
    wordContent.appendChild(authorSpan);
    newWordItem.appendChild(voteControls);
    newWordItem.appendChild(wordContent);
    liveFeedList.appendChild(newWordItem);
  });
}

// ============================================================================
// --- UI HELPERS & STATE UPDATERS ---
// These functions manage smaller UI pieces and internal state.
// ============================================================================

/**
 * Updates the timer display with the remaining seconds.
 * @param {number} seconds - The remaining seconds in the round.
 */
export function updateTimerDisplay(seconds) {
    timerDisplay.textContent = seconds;
}

/**
 * Fetches user data and updates the UI to show login/logout status.
 * For logged-in users, it creates a dropdown with logout and delete options.
 */
export async function updateUserStatus() {
  if (!userStatusEl) return;

  try {
    // --- Fetch User Data ---
    const response = await fetch('/api/user');
    const user = await response.json();
    currentUser = user; // Update module-level user state.

    // --- Define Icons ---
    const loginIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"></path></svg>`;
    const downArrowIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M7 10l5 5 5-5H7z"/></svg>`;

    // --- Render Based on Login State ---
    if (user.loggedIn) {
      // --- Logged-In View: Create Dropdown Menu ---
      userStatusEl.innerHTML = `
        <div class="user-menu-container">
          <a href="#" id="userMenuBtn" role="button" aria-haspopup="true" aria-expanded="false">
            <span>${user.username}</span>
            ${downArrowIcon}
          </a>
          <div id="userDropdown" class="user-dropdown-content">
            <a href="/logout">Logout</a>
            <a href="#" id="deleteAccountBtn">Delete</a>
          </div>
        </div>
      `;

      // --- Add Event Listeners for the New Dropdown ---
      const menuBtn = document.getElementById('userMenuBtn');
      const dropdown = document.getElementById('userDropdown');
      const deleteBtn = document.getElementById('deleteAccountBtn');

      // Toggle dropdown visibility on click.
      menuBtn.addEventListener('click', (e) => {
        e.preventDefault(); // Prevent link from navigating.
        e.stopPropagation(); // Prevent the window click listener from firing immediately.
        const isExpanded = dropdown.classList.toggle('show-dropdown');
        menuBtn.setAttribute('aria-expanded', isExpanded); // For accessibility.
      });

      // Handle account deletion.
      deleteBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const confirmation = "Are you sure you want to permanently delete your account? This action cannot be undone.";
        if (window.confirm(confirmation)) {
          try {
            const res = await fetch('/api/user', { method: 'DELETE' });
            if (res.ok) {
              alert('Account deleted successfully.');
              window.location.href = '/'; // Redirect to home page.
            } else {
              const error = await res.json();
              alert(`Error: ${error.message}`);
            }
          } catch (err) {
            alert('An error occurred. Please try again.');
          }
        }
      });

      // Close dropdown if the user clicks anywhere else on the page.
      window.addEventListener('click', (e) => {
        if (!menuBtn.contains(e.target)) {
          dropdown.classList.remove('show-dropdown');
          menuBtn.setAttribute('aria-expanded', 'false');
        }
      });

    } else {
      // --- Logged-Out View: Show Login Link ---
      userStatusEl.innerHTML = `<a href="/login.html"><span>Login</span>${loginIcon}</a>`;
    }
  } catch (error) {
    // --- Handle Fetch Error ---
    console.error('Failed to fetch user status:', error);
    userStatusEl.innerHTML = ``; // Clear the element on error.
  }
}

/**
 * Displays a temporary feedback message to the user.
 * @param {string} message - The feedback message to display.
 * @param {('info'|'warning'|'error')} [type='info'] - The type of message, for styling.
 */
export function showFeedback(message, type = 'info') {
  feedbackMessage.textContent = message;

  // --- Reset and Apply Style Classes ---
  feedbackMessage.classList.remove('visible', 'feedback-info', 'feedback-warning', 'feedback-error');
  feedbackMessage.classList.add(`feedback-${type}`);

  // --- Force Animation Restart ---
  // This is a reflow trick. Accessing offsetWidth forces the browser to recalculate layout,
  // allowing the CSS animation to restart if the 'visible' class is re-added immediately.
  void feedbackMessage.offsetWidth;
  feedbackMessage.classList.add('visible');

  // --- Set Timeout to Hide ---
  clearTimeout(feedbackTimeout); // Clear any existing timeout.
  feedbackTimeout = setTimeout(() => {
    feedbackMessage.classList.remove('visible');
  }, 3000);
}

/**
 * Manages the state of scroll-related UI elements (fades, buttons)
 * and updates the main image to accurately match the currently viewed text.
 */
export function updateScrollEffects() {
  const el = currentTextContainer;
  if (!el) return;
  const buffer = 1;

  // --- Infinite Scroll Trigger ---
  if (el.scrollTop < 50 && !isBooting) {
    loadMoreHistory();
  }

  // --- Toggle Fades ---
  const showBottomFade = el.scrollHeight - el.scrollTop > el.clientHeight + buffer;
  currentTextWrapper.classList.toggle('show-top-fade', true);
  currentTextWrapper.classList.toggle('show-bottom-fade', showBottomFade);

  // --- Update Button States ---
  const isAtBottom = !showBottomFade;
  btnDown.disabled = isAtBottom;
  btnCurrent.disabled = isAtBottom;

  // ========================================================================
  // === UPDATE MAIN IMAGE
  // ========================================================================
  // If the user is at the bottom, always show the latest live image
  if (isImageGenerating) {
    return;
  }
  if (isAtBottom) {
    renderLatestImage(latestImageUrlOnLoad);
    return;
  }

  const allWords = Array.from(el.querySelectorAll('.word'));
  if (allWords.length === 0) return;

  // --- 1. Find all words currently visible in the container ---
  const containerRect = el.getBoundingClientRect();
  const visibleWords = allWords.filter(word => {
    const wordRect = word.getBoundingClientRect();
    // A word is visible if its top is above the container's bottom
    // and its bottom is below the container's top.
    return wordRect.top < containerRect.bottom && wordRect.bottom > containerRect.top;
  });

  if (visibleWords.length === 0) {
    // If no words are visible for any reason, don't change the image.
    return;
  }

  // --- 2. Tally the votes for each chunk based on visible words ---
  const chunkVotes = new Map();
  let liveWordCount = 0; // Counter for words newer than any image chunk
  const lastImageChunk = imageTimeline.length > 0 ? imageTimeline[imageTimeline.length - 1] : null;

  visibleWords.forEach(word => {
    const timestamp = parseInt(word.dataset.ts, 10);
    const timelineEntry = imageTimeline.find(entry =>
      timestamp >= entry.start_ts && timestamp <= entry.end_ts
    );

    if (timelineEntry) {
      // If the word belongs to a chunk with an image, add a vote for that image.
      const imageUrl = timelineEntry.imageUrl;
      chunkVotes.set(imageUrl, (chunkVotes.get(imageUrl) || 0) + 1);
    } else if (lastImageChunk && timestamp > lastImageChunk.end_ts) {
      // If the word is newer than our last known image, it's a "live" word.
      liveWordCount++;
    }
  });

  // --- 3. Determine the winning chunk ---
  let winningImageUrl = null;
  let maxVotes = 0;

  // Find the historical chunk with the most visible words.
  for (const [imageUrl, votes] of chunkVotes.entries()) {
    if (votes > maxVotes) {
      maxVotes = votes;
      winningImageUrl = imageUrl;
    }
  }

  // --- 4. Compare the winner with "live" words and set the final image ---
  let finalImageUrl = null;
  if (liveWordCount > maxVotes) {
    // If there are more live words on screen than words from any single
    // historical chunk, show the most recent image.
    finalImageUrl = latestImageUrlOnLoad;
  } else {
    // Otherwise, show the image from the historical chunk that won the vote.
    // This will be null if only old, imageless chunks are visible.
    finalImageUrl = winningImageUrl;
  }

  renderLatestImage(finalImageUrl);
}

/**
 * Handles the arrival of a new sealed image from the server.
 * It only updates the visible image if the user is currently scrolled to the bottom.
 * This prevents the image from changing unexpectedly while a user is reading past history.
 * @param {string} imageUrl - The URL of the newly generated image.
 */
export function handleNewSealedImage(imageUrl) {
  pendingImageUrl = imageUrl;

  // Preload the image, then atomically swap it in.
  const img = new Image();
  img.alt = 'AI-generated image for the current story chunk';
  img.onload = () => {
    const el = currentTextContainer;
    const scrollBuffer = 5;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= scrollBuffer;

    // Update state unconditionally
    latestImageUrlOnLoad = imageUrl;
    isImageGenerating = false;

    // Only swap the placeholder immediately if user is at bottom
    if (isAtBottom && latestImageContainer) {
      latestImageContainer.innerHTML = '';
      latestImageContainer.appendChild(img);
    }
  };
  img.src = imageUrl;
}


/**
 * Removes all `<span>` or `<br>` elements on the first rendered line of the text container.
 * This is a performance optimization to keep the DOM from growing infinitely large.
 */
function removeFirstRenderedLine() {
  const container = currentTextContainer;
  if (!container.firstChild) return;

  const children = Array.from(container.children);
  if (children.length === 0) return;

  // --- Identify Elements on the First Line ---
  const firstLineTop = children[0].getBoundingClientRect().top;
  const elementsToRemove = [];

  // Loop through child elements and collect all that share the same vertical position as the first one.
  for (const child of children) {
    // A small tolerance (< 2px) accounts for minor rendering differences.
    if (Math.abs(child.getBoundingClientRect().top - firstLineTop) < 2) {
      elementsToRemove.push(child);
    } else {
      // Once we find an element on a different line, we can stop.
      break;
    }
  }

  // --- Remove Identified Elements ---
  elementsToRemove.forEach(el => el.remove());
}


// ============================================================================
// --- EVENT LISTENER SETUP ---
// Functions dedicated to attaching specific event listeners.
// ============================================================================

/**
 * Attaches click handlers for history navigation buttons.
 */
function addNavEvents() {
  btnUp.addEventListener('click', () => {
    currentTextContainer.scrollBy({ top: -currentTextContainer.clientHeight * 0.5, behavior: 'smooth' });
  });
  btnDown.addEventListener('click', () => {
    currentTextContainer.scrollBy({ top: currentTextContainer.clientHeight * 0.5, behavior: 'smooth' });
  });
  btnCurrent.addEventListener('click', () => {
    currentTextContainer.scrollTo({ top: currentTextContainer.scrollHeight, behavior: 'smooth' });
  });
  btnOpenHistory.addEventListener('click', () => {
    window.location.href = '/history.html';
  });
  // The scroll effects need to be updated continuously as the user scrolls.
  // Throttle the scroll handler to run at most once every 50ms
  const throttledScrollHandler = throttle(updateScrollEffects, 50);
  currentTextContainer.addEventListener('scroll', throttledScrollHandler);
}

/**
 * Attaches click handlers to open and close the information modal.
 */
function addInfoModalEvents() {
  if (!btnInfo || !infoModal) return; // Defensive check in case elements are missing.
  btnInfo.addEventListener('click', () => infoModal.classList.add('visible'));
  modalClose.addEventListener('click', () => infoModal.classList.remove('visible'));
  modalOverlay.addEventListener('click', () => infoModal.classList.remove('visible'));
}

/**
 * Attaches click handlers to open and close the image modal.
 */
function addImageModalEvents() {
  if (!imageModal || !latestImageContainer) return;

  const overlay = imageModal.querySelector('.modal-overlay');
  const closeBtn = imageModal.querySelector('.modal-close');
  const fullResBtn = imageModal.querySelector('#fullResBtn');

  // Open modal when an image is clicked
  latestImageContainer.addEventListener('click', (e) => {
    if (e.target.tagName === 'IMG') {
      const imgSrc = e.target.src;
      fullSizeImage.src = imgSrc;
      fullResBtn.href = imgSrc;
      imageModal.classList.add('visible');
    }
  });

  // Close modal listeners
  closeBtn.addEventListener('click', () => imageModal.classList.remove('visible'));
  overlay.addEventListener('click', () => imageModal.classList.remove('visible'));
}

/**
 * Adds event listeners for the word submission form and style buttons.
 */
function addFormAndStyleEvents() {
    // --- Style Button Clicks ---
    // Use event delegation on the parent container for efficiency.
    styleOptions.addEventListener('click', (event) => {
        const target = event.target.closest('.style-btn');
        if (!target) return; // Ignore clicks that aren't on a button.

        const style = target.dataset.style;
        const noStyleButton = document.querySelector('[data-style="none"]');

        // --- Toggle Logic ---
        if (style === 'none') {
            // If "none" is clicked, deactivate all other style buttons.
            styleButtons.forEach(btn => btn.classList.remove('active'));
            target.classList.add('active'); // Activate the "none" button.
        } else {
            // If a specific style is clicked, deactivate "none" and toggle the clicked style.
            noStyleButton.classList.remove('active');
            target.classList.toggle('active');
        }

        // Ensure "none" is active if no other styles are selected.
        const isAnyStyleActive = styleButtons.some(btn => btn.classList.contains('active'));
        if (!isAnyStyleActive) {
            noStyleButton.classList.add('active');
        }

        // --- Update State and Input Field Style ---
        // Sync the `selectedStyles` object with the active classes on the buttons.
        selectedStyles.bold = document.querySelector('[data-style="bold"]').classList.contains('active');
        selectedStyles.italic = document.querySelector('[data-style="italic"]').classList.contains('active');
        selectedStyles.underline = document.querySelector('[data-style="underline"]').classList.contains('active');
        selectedStyles.newline = document.querySelector('[data-style="newline"]').classList.contains('active');

        // Apply styles directly to the input field for visual feedback.
        wordForm.classList.toggle('newline-selected', selectedStyles.newline);
        wordInput.style.fontWeight = selectedStyles.bold ? 'bold' : 'normal';
        wordInput.style.fontStyle = selectedStyles.italic ? 'italic' : 'normal';
        wordInput.style.textDecoration = selectedStyles.underline ? 'underline' : 'none';
    });

    // --- Form Submission ---
    wordForm.addEventListener('submit', (event) => {
        event.preventDefault(); // Prevent default page reload.
        const wordToSubmit = wordInput.value.trim();

        if (wordToSubmit) {
            // --- Client-side Validation ---
            const punctuationRegex = new RegExp(CFG.PUNCTUATION_REGEX_STRING);
            if (!punctuationRegex.test(wordToSubmit)) {
                showFeedback("Invalid format. Please submit a single, word-like token without spaces and optional punctuation.", "warning");
                return;
            }
            // --- Emit to Server ---
            socket.emit('wordSubmitted', { word: wordToSubmit, styles: selectedStyles });
            wordInput.value = ''; // Clear the input field after submission.
        }
    });
}

// ============================================================================
// --- ASYNC DATA FETCHING ---
// ============================================================================

/**
 * Fetches older words from the server and prepends them to the display.
 * This function implements the "infinite scroll" feature for browsing history
 * and updates the in-memory image timeline.
 */
async function loadMoreHistory() {
  // --- PRE-FLIGHT CHECKS ---
  // If we are already in the middle of loading, or if we know there's no more history,
  // or if the initial text array is empty, exit immediately to prevent errors or duplicate requests.
  if (isLoadingMore || noMoreHistory || currentWordsArray.length === 0) {
    return;
  }

  // --- SET LOADING STATE ---
  // Set the flag to true to prevent this function from being called again while this request is in progress.
  isLoadingMore = true;

  // Get the timestamp of the very first (oldest) word currently displayed on the client.
  // This will be used as a cursor to ask the server for words *before* this point.
  const oldestTimestamp = currentWordsArray[0].ts;

  try {
    // --- API REQUEST ---
    // Fetch the older history from the server, passing our oldest timestamp as a query parameter.
    // The server will return data already grouped by chunks.
    const response = await fetch(`/api/history/before?ts=${oldestTimestamp}&limit=50`);
    const chunkGroups = await response.json(); // Data is an array of objects: [{imageUrl, words}, ...]

    // --- PROCESS RESPONSE ---
    // Check if the server returned any new chunk groups.
    if (chunkGroups.length > 0) {
      const container = currentTextContainer;

      // Store the container's scroll height *before* adding new content.
      // This is crucial for maintaining the user's scroll position so their view doesn't jump.
      const oldScrollHeight = container.scrollHeight;

      // This will temporarily hold the timeline data for the new chunks we just loaded.
      const newTimelineEntries = [];

      // --- RENDER NEW CONTENT & PREPARE TIMELINE DATA ---
      // Loop through each chunk group returned by the server.
      chunkGroups.forEach(group => {
        // First, prepend all the words from this chunk to the text container.
        group.words.forEach(wordData => {
            // Defensively create a 'styles' object to prevent errors if it's missing on old data.
            const styles = wordData.styles || {};
            const wordSpan = document.createElement('span');
            wordSpan.className = 'word';

            // Store all metadata on the element itself using data-* attributes for the tooltip.
            wordSpan.dataset.ts = wordData.ts;
            wordSpan.dataset.username = wordData.username;
            wordSpan.dataset.count = wordData.count;
            wordSpan.dataset.total = wordData.total;
            wordSpan.dataset.pct = wordData.pct;

            // Handle newlines by prepending a <br> tag before the word.
            if (styles.newline) {
                container.prepend(document.createElement('br'));
            }

            // Set the text content and apply styles using our safe 'styles' object.
            wordSpan.textContent = wordData.word;
            wordSpan.style.fontWeight = styles.bold ? 'bold' : 'normal';
            wordSpan.style.fontStyle = styles.italic ? 'italic' : 'normal';
            wordSpan.style.textDecoration = styles.underline ? 'underline' : 'none';

            // Prepend a space for separation, then prepend the word span itself.
            // Using prepend() correctly builds the content in reverse order at the top.
            container.prepend(document.createTextNode(' '));
            container.prepend(wordSpan);
        });

        // Next, if this chunk has an image, create a timeline entry for it.
        if (group.imageUrl && group.words.length > 0) {
            newTimelineEntries.push({
                start_ts: group.words[0].ts, // Timestamp of the first word in this chunk
                end_ts: group.words[group.words.length - 1].ts, // Timestamp of the last word
                imageUrl: group.imageUrl
            });
        }
      });

      // --- UPDATE CLIENT STATE ---
      // Prepend the new timeline entries to our main in-memory timeline.
      imageTimeline = [...newTimelineEntries, ...imageTimeline];

      // Flatten the words from all new chunks into a single array.
      const allNewWords = chunkGroups.flatMap(g => g.words);
      // Prepend this new array of words to our main client-side word array.
      currentWordsArray = [...allNewWords, ...currentWordsArray];
      // Re-render the contributors dropdown with the updated list of authors.
      renderContributorsDropdown(mainContributorsContainer, currentWordsArray, container);

      // --- MAINTAIN SCROLL POSITION ---
      // Calculate the new total height of the content.
      const newScrollHeight = container.scrollHeight;
      // Adjust the scroll position so the user's view remains on the same word they were looking at.
      container.scrollTop = newScrollHeight - oldScrollHeight;

    } else {
      // If the server returns an empty array, it means we've reached the beginning of history.
      noMoreHistory = true; // Set this flag to prevent future requests.
    }
  } catch (error) {
    console.error("Failed to load more history:", error);
  } finally {
    // --- RESET LOADING STATE ---
    // Whether the request succeeded or failed, reset the loading flag so the user can trigger it again.
    isLoadingMore = false;
  }
}

/**
 * Finds the seal timer container on the main page and starts the countdown.
 * @param {string} cronSchedule - The cron schedule for the next seal.
 */
export function initSealCountdown(cronSchedule) {
  if (timerElement && cronSchedule) {
    // Call the shared countdown function
    startSealCountdown(timerElement, cronSchedule);
  }
}
