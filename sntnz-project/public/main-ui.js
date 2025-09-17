// ============================================================================
// SN-TN-Z: UI.JS
// ----------------------------------------------------------------------------
// Manages all DOM interactions, event listeners, and rendering logic for the
// application. This module exports functions to be called by client.js in
// response to server events and user actions.
// ============================================================================

import { renderWord, addTooltipEvents, renderContributorsDropdown, startSealCountdown, addImageModalEvents, throttle, debounce } from './shared-ui.js';

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
let latestImageUrlOnLoad = null; // Default image URL
let imageTimeline = []; // Store image data in memory.
let isImageGenerating = false;

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
  addImageModalEvents(latestImageContainer, imageModal, fullSizeImage);
  addFormAndStyleEvents();
  initSealCountdown(CFG.HISTORY_CHAPTER_SCHEDULE_CRON);
}


// ============================================================================
// --- RENDER FUNCTIONS ---
// These functions are responsible for updating the DOM.
// ============================================================================

/**
 * Renders the initial state of the application on first load.
 * @param {Object} initialState - The full initial state object from the server.
 */
export function renderInitialState({ currentText: initialChapters, liveSubmissions, latestImageUrl, isImageGenerating }) {
  currentTextContainer.innerHTML = '';
  imageTimeline = []; // Clear the timeline on re-init
  currentWordsArray = []; // Clear the words array

  // Process each chapter to render words and build the timeline
  initialChapters.forEach(chapter => {
      if (!chapter.words || chapter.words.length === 0) return;

      renderWords(chapter.words); // Render the words from the chapter
      currentWordsArray.push(...chapter.words); // Add words to our flat array for other features

      // If the chapter has an image, add its time range to our timeline
      if (chapter.imageUrl) {
          imageTimeline.push({
              start_ts: chapter.words[0].ts,
              end_ts: chapter.words[chapter.words.length - 1].ts,
              imageUrl: chapter.imageUrl
          });
      }
  });

  latestImageUrlOnLoad = latestImageUrl;
  renderLiveFeed(liveSubmissions);
  renderContributorsDropdown(mainContributorsContainer, currentWordsArray, currentTextContainer);

  // --- Force Scroll to Bottom ---
  const el = currentTextContainer;
  const prevBehavior = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';

  requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
          el.style.scrollBehavior = prevBehavior;
          lastScrollHeight = el.scrollHeight;
          isBooting = false;
          updateScrollEffects(); // This will set the initial image correctly.
      });
  });
}

/**
 * Renders an image or placeholder with a graceful cross-fade effect between
 * the old and new images.
 */
export function renderImage(imageUrl) {
  if (!latestImageContainer) return;

  // --- CASE 1: Display a placeholder ---
  if (!imageUrl) {
    if (isImageGenerating) {
      showImageGenerationPlaceholder();
    } else {
      latestImageContainer.innerHTML = `<div class="image-placeholder-text">No image for this chapter</div>`;
    }
    return;
  }

  // --- CASE 2: Display an image ---
  // Find the currently visible image (one that isn't already loading/transparent).
  const currentImg = latestImageContainer.querySelector('img:not(.image-loading)');

  // If the correct image is already fully visible, do nothing.
  if (currentImg && currentImg.src === imageUrl) {
    return;
  }

  // Immediately remove any text-based placeholders.
  const placeholder = latestImageContainer.querySelector('.image-generating-text, .image-placeholder-text');
  if (placeholder) {
    placeholder.remove();
  }

  const newImg = document.createElement('img');
  newImg.alt = 'AI-generated image for the current story chapter';
  newImg.className = 'image-loading'; // Start new image transparent
  latestImageContainer.appendChild(newImg);

  newImg.onload = () => {
    // Force the browser to apply styles before transitioning.
    void newImg.offsetWidth;
    setTimeout(() => {
      // 1. Fade IN the new image by removing its loading class.
      newImg.classList.remove('image-loading');

      // 2. Fade OUT the old image (if it exists) by adding the same class.
      if (currentImg) {
        currentImg.classList.add('image-loading');

        // 3. IMPORTANT: Remove the old image from the DOM only AFTER its
        //    fade-out transition has finished.
        currentImg.addEventListener('transitionend', () => {
          currentImg.remove();
        }, { once: true }); // { once: true } is a modern way to auto-cleanup the listener.
      }
    }, 0);
  };

  newImg.onerror = () => {
    latestImageContainer.innerHTML = `<div class="image-placeholder-text">Error loading image</div>`;
  };

  newImg.src = imageUrl;
}

/**
 * Displays a "Generating..." placeholder in the image container.
 * This is triggered by the server when a new chapter seal begins.
 */
export function showImageGenerationPlaceholder() {
  if (!latestImageContainer) return;
  isImageGenerating = true;
  latestImageContainer.innerHTML = `<div class="image-generating-text">Generating Image...</div>`;
}

/**
 * Appends a new word to the main text display and handles scrolling.
 * @param {Array<Object>} newCurrentText - The full, updated text array from the server.
 */
export function appendNewWord(newCurrentText) {
  // --- 1. STATE VALIDATION & SETUP ---
  const el = currentTextContainer;
  const scrollBuffer = 5;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= scrollBuffer;

  // Validate that the new word is actually new to prevent duplicates.
  const newWord = newCurrentText[newCurrentText.length - 1];
  const lastWordInClientArray = currentWordsArray[currentWordsArray.length - 1];
  if (!newWord || (lastWordInClientArray && lastWordInClientArray.ts === newWord.ts)) {
    return;
  }

  // --- 2. RENDER THE NEW WORD & MANAGE SCROLL ---
  renderWord(newWord, el);

  // If the user was scrolled to the bottom, keep the content window from
  // growing infinitely by removing the top-most line.
  const newHeight = el.scrollHeight;
  if (wasAtBottom && lastScrollHeight > 0 && newHeight > lastScrollHeight) {
    removeFirstRenderedLine();
  }

  // --- 3. UPDATE CLIENT-SIDE STATE ---
  currentWordsArray.push(newWord);
  renderContributorsDropdown(mainContributorsContainer, currentWordsArray, currentTextContainer);
  lastScrollHeight = el.scrollHeight;

  // If the user was at the bottom, keep them scrolled to the bottom.
  if (wasAtBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

/**
 * Renders an array of words by appending them to the container.
 * @param {Array<Object>} wordsArray - The array of word data to render.
 */
export function renderWords(wordsArray) {
  // Loop through the array and delegate each word to the shared renderer.
  wordsArray.forEach((wordData) => {
    renderWord(wordData, currentTextContainer);
  });

  // Update any UI elements that depend on the text container's state.
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
 * Manages scroll-related UI and updates the main image to match the currently viewed text.
 */
export function updateScrollEffects() {
  const el = currentTextContainer;
  if (!el) return;
  const buffer = 5; // A small buffer for detecting scroll position

  // --- Manage infinite scroll and UI fades ---
  if (el.scrollTop < 200 && !isBooting) {
    loadMoreHistory();
  }
  const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= buffer;
  currentTextWrapper.classList.toggle('show-top-fade', true);
  currentTextWrapper.classList.toggle('show-bottom-fade', !isAtBottom);
  btnDown.disabled = isAtBottom;
  btnCurrent.disabled = isAtBottom;

  // === IMAGE LOGIC

  // --- MODE 2: HISTORY VIEW ---
  // If we are scrolled up, find the image for the chapter in the viewport.
  const allWords = Array.from(el.querySelectorAll('.word'));
  if (allWords.length === 0) return;

  const containerRect = el.getBoundingClientRect();
  const visibleWords = allWords.filter(word => {
    const wordRect = word.getBoundingClientRect();
    return wordRect.top < containerRect.bottom && wordRect.bottom > containerRect.top;
  });
  if (visibleWords.length === 0) return;

  // Tally "votes" for which chapter's image should be displayed.
  const chapterVotes = new Map();
  visibleWords.forEach(word => {
    const timestamp = parseInt(word.dataset.ts, 10);
    const timelineEntry = imageTimeline.find(entry =>
      timestamp >= entry.start_ts && timestamp <= entry.end_ts
    );
    if (timelineEntry) {
      chapterVotes.set(timelineEntry.imageUrl, (chapterVotes.get(timelineEntry.imageUrl) || 0) + 1);
    }
  });

  // Find the image URL that has the most visible words.
  let winningImageUrl = latestImageUrlOnLoad;
  let maxVotes = 0;
  for (const [imageUrl, votes] of chapterVotes.entries()) {
    if (votes > maxVotes) {
      maxVotes = votes;
      winningImageUrl = imageUrl;
    }
  }

  // Render the winner. If no chapter with an image is visible, winningImageUrl
  // will be null, and renderImage will correctly show the placeholder.
  renderImage(winningImageUrl);
}

/**
 * Handles the arrival of a newly sealed chapter. This version updates the state
 * and then directly forces the new image to render, bypassing complex calculations.
 */
export function handleChapterSealed(sealedChapter) {
  if (!sealedChapter || !sealedChapter.imageUrl) return;

  // 1. Update the state (this is still important for future scrolling)
  if (sealedChapter.words && sealedChapter.words.length > 0) {
    imageTimeline.push({
        start_ts: sealedChapter.words[0].ts,
        end_ts: sealedChapter.words[sealedChapter.words.length - 1].ts,
        imageUrl: sealedChapter.imageUrl
    });
  }
  latestImageUrlOnLoad = sealedChapter.imageUrl;
  isImageGenerating = false;

  // 2. Render the new image.
  renderImage(sealedChapter.imageUrl);
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
  // Use debounce to ensure the final scroll position is always processed.
  const debouncedScrollHandler = debounce(updateScrollEffects, 100); // A 100ms delay feels smooth
  currentTextContainer.addEventListener('scroll', debouncedScrollHandler);
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
 * Fetches older chapters from the server and prepends them to the display.
 * This function implements the "infinite scroll" feature for browsing history
 * and updates the in-memory image timeline.
 */
async function loadMoreHistory() {
  // --- 1. PRE-FETCH CHECKS ---
  if (isLoadingMore || noMoreHistory || currentWordsArray.length === 0) {
    return;
  }
  isLoadingMore = true;

  const oldestTimestamp = currentWordsArray[0].ts;

  try {
    // --- 2. FETCH & PROCESS OLDER CHAPTERS ---
    const response = await fetch(`/api/history/before?ts=${oldestTimestamp}`);
    const chapterGroups = await response.json();

    if (chapterGroups.length > 0) {
      const container = currentTextContainer;
      const oldScrollHeight = container.scrollHeight;
      const newTimelineEntries = [];

      // --- RENDER CONTENT ---
      chapterGroups.forEach(group => {
        // Words are chronological. Loop backwards to PREPEND them in the correct order.
        for (let i = group.words.length - 1; i >= 0; i--) {
          const wordData = group.words[i];
          // Use the shared renderer with the `prepend: true` option.
          renderWord(wordData, container, { prepend: true });
        }

        // --- Update Image Timeline ---
        if (group.imageUrl && group.words.length > 0) {
            newTimelineEntries.push({
                start_ts: group.words[0].ts,
                end_ts: group.words[group.words.length - 1].ts,
                imageUrl: group.imageUrl
            });
        }
      });

      // --- 3. UPDATE CLIENT STATE & SCROLL POSITION ---
      const reversedChapterGroups = [...chapterGroups].reverse();
      const allNewWords = reversedChapterGroups.flatMap(g => g.words);
      currentWordsArray = [...allNewWords, ...currentWordsArray];
      imageTimeline = [...newTimelineEntries.reverse(), ...imageTimeline];
      renderContributorsDropdown(mainContributorsContainer, currentWordsArray, container);

      // Maintain the user's scroll position relative to the old content.
      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - oldScrollHeight;
      updateScrollEffects();
    } else {
      noMoreHistory = true;
    }
  } catch (error) {
    console.error("Failed to load more history:", error);
  } finally {
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
