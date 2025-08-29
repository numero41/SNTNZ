// ============================================================================
// SN-TN-Z: UI.JS
// ----------------------------------------------------------------------------
// Manages all DOM interactions, event listeners, and rendering logic for the
// application. This module exports functions to be called by client.js in
// response to server events and user actions.
// ============================================================================

import { addTooltipEvents } from './shared-ui.js';

// --- MODULE STATE ---
let socket = null;
let CFG = null;
let currentWordsArray = [];
let selectedStyles = { bold: false, italic: false, underline: false };
let feedbackTimeout;
let lastScrollHeight = 0;
let isLoadingMore = false;
let isBooting = true;
let currentUser = { loggedIn: false, username: null };

// --- DOM ELEMENT REFERENCES ---
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
const feedbackMessage = document.getElementById('feedbackMessage');
const tooltip = document.getElementById('wordTooltip');
const btnInfo = document.getElementById('btnInfo');
const infoModal = document.getElementById('infoModal');
const userStatusEl = document.getElementById('userStatus');
const modalOverlay = infoModal ? infoModal.querySelector('.modal-overlay') : null;
const modalClose = infoModal ? infoModal.querySelector('.modal-close') : null;

// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

/**
 * Initializes the UI module, sets up all event listeners.
 * @param {Socket} socketInstance - The main Socket.IO instance.
 * @param {Object} config - The application configuration object.
 */
export function init(socketInstance, config) {
  socket = socketInstance;
  CFG = config;
  addNavEvents();
  addTooltipEvents(currentTextContainer, tooltip);
  addInfoModalEvents();
  addFormAndStyleEvents();
}


// ============================================================================
// --- RENDER FUNCTIONS ---
// ============================================================================

/**
 * Renders the initial state of the application on first load.
 * @param {Array<Object>} currentText - The initial array of word objects.
 * @param {Array<Object>} liveSubmissions - The initial array of live submissions.
 */
export function renderInitialState(currentText, liveSubmissions) {
    currentTextContainer.innerHTML = '';
    renderWords(currentText);
    currentWordsArray = currentText;

    renderLiveFeed(liveSubmissions);

    // Jump to the bottom, avoiding smooth scroll interference.
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
            updateScrollEffects();
        });
    });
}

/**
 * Appends a new word to the main text display and handles scrolling.
 * @param {Array<Object>} newCurrentText - The full, updated text array from the server.
 */
export function appendNewWord(newCurrentText) {
    const el = currentTextContainer;
    const scrollBuffer = 5;
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= scrollBuffer;

    const newWord = newCurrentText[newCurrentText.length - 1];

    const lastWordInClientArray = currentWordsArray[currentWordsArray.length - 1];
    if (!newWord || (lastWordInClientArray && lastWordInClientArray.ts === newWord.ts)) {
        return; // Do nothing if the word is missing or a duplicate.
    }

    renderWords([newWord]);

    const newHeight = el.scrollHeight;
    if (wasAtBottom && lastScrollHeight > 0 && newHeight > lastScrollHeight) {
        removeFirstRenderedLine();
    }

    currentWordsArray.push(newWord);
    lastScrollHeight = el.scrollHeight;

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
    const wordSpan = document.createElement('span');
    wordSpan.className = 'word';
    wordSpan.dataset.ts = wordData.ts;
    wordSpan.dataset.username = wordData.username;
    wordSpan.dataset.count = wordData.count;
    wordSpan.dataset.total = wordData.total;
    wordSpan.dataset.pct = wordData.pct;
    wordSpan.textContent = wordData.word + ' ';
    wordSpan.style.fontWeight = wordData.styles.bold ? 'bold' : 'normal';
    wordSpan.style.fontStyle = wordData.styles.italic ? 'italic' : 'normal';
    wordSpan.style.textDecoration = wordData.styles.underline ? 'underline' : 'none';
    currentTextContainer.appendChild(wordSpan);
  });
  updateScrollEffects();
}

/**
 * Renders the live submissions feed.
 * @param {Array<Object>} feedData - Array of live feed items.
 */
export function renderLiveFeed(feedData) {
  liveFeedList.innerHTML = '';
  if (feedData.length === 0) {
    const placeholder = document.createElement('li');
    placeholder.textContent = 'No words submitted by anyone yet';
    placeholder.className = 'placeholder';
    liveFeedList.appendChild(placeholder);
    return;
  }
  const maxVotes = feedData[0].count;
  feedData.forEach(item => {
    const newWordItem = document.createElement('li');
    const wordSpan = document.createElement('span');
    wordSpan.textContent = item.word;
    wordSpan.style.fontWeight = item.styles.bold ? 'bold' : 'normal';
    wordSpan.style.fontStyle = item.styles.italic ? 'italic' : 'normal';
    wordSpan.style.textDecoration = item.styles.underline ? 'underline' : 'none';

    const countSpan = document.createElement('span');
    countSpan.textContent = ` [${item.count}]`;
    countSpan.className = 'word-submit-details';

    const authorSpan = document.createElement('span');
    authorSpan.textContent = ` (by ${item.username})`;
    authorSpan.className = 'word-submit-details';

    newWordItem.appendChild(wordSpan);
    newWordItem.appendChild(authorSpan);
    newWordItem.appendChild(countSpan);

    const voteRatio = item.count / maxVotes;
    const lightness = (1 - voteRatio) * 75;
    newWordItem.style.color = `hsl(0, 0%, ${lightness}%)`;
    newWordItem.style.cursor = 'pointer';
    newWordItem.addEventListener('click', () => {
      socket.emit('wordSubmitted', { word: item.word, styles: item.styles });
    });
    liveFeedList.appendChild(newWordItem);
  });
}


// ============================================================================
// --- UI HELPERS & STATE UPDATERS ---
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
  const userStatusEl = document.getElementById('userStatus'); // Moved declaration to the top
  if (!userStatusEl) return;

  try {
    const response = await fetch('/api/user');
    const user = await response.json();
    currentUser = user;

    const loginIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"></path></svg>`;
    const downArrowIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px" fill="currentColor"><path d="M7 10l5 5 5-5H7z"/></svg>`;

    if (user.loggedIn) {
      // Create a dropdown menu that looks like the login link
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

      // Add event listeners for the new dropdown
      const menuBtn = document.getElementById('userMenuBtn');
      const dropdown = document.getElementById('userDropdown');
      const deleteBtn = document.getElementById('deleteAccountBtn');

      menuBtn.addEventListener('click', (e) => {
        e.preventDefault(); // Prevent link from navigating
        e.stopPropagation();
        const isExpanded = dropdown.classList.toggle('show-dropdown');
        menuBtn.setAttribute('aria-expanded', isExpanded); // For accessibility
      });

      deleteBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const confirmation = "Are you sure you want to permanently delete your account? This action cannot be undone.";
        if (window.confirm(confirmation)) {
          try {
            const res = await fetch('/api/user', { method: 'DELETE' });
            if (res.ok) {
              alert('Account deleted successfully.');
              window.location.href = '/'; // Redirect to home page
            } else {
              const error = await res.json();
              alert(`Error: ${error.message}`);
            }
          } catch (err) {
            alert('An error occurred. Please try again.');
          }
        }
      });

      // Close dropdown if user clicks anywhere else
      window.addEventListener('click', (e) => {
        if (!menuBtn.contains(e.target)) {
          dropdown.classList.remove('show-dropdown');
          menuBtn.setAttribute('aria-expanded', 'false');
        }
      });

    } else {
      userStatusEl.innerHTML = `<a href="/login.html"><span>Login</span>${loginIcon}</a>`;
    }
  } catch (error) {
    console.error('Failed to fetch user status:', error);
    userStatusEl.innerHTML = ``;
  }
}

/**
 * Displays a temporary feedback message to the user.
 * @param {string} message - The feedback message to display.
 * @param {('info'|'warning'|'error')} [type='info'] - The type of message, for styling.
 */
export function showFeedback(message, type = 'info') {
  feedbackMessage.textContent = message;

  // Reset classes and apply the new one for coloring
  feedbackMessage.classList.remove('visible', 'feedback-info', 'feedback-warning', 'feedback-error');
  feedbackMessage.classList.add(`feedback-${type}`);

  // Use a reflow trick to restart the animation if the message is already visible
  void feedbackMessage.offsetWidth;

  feedbackMessage.classList.add('visible');

  clearTimeout(feedbackTimeout);
  feedbackTimeout = setTimeout(() => {
    feedbackMessage.classList.remove('visible');
  }, 3000);
}

/**
 * Manages the state of scroll-related UI elements.
 */
export function updateScrollEffects() {
  const el = currentTextContainer;
  const buffer = 1;

  if (el.scrollTop < 50 && !isBooting) {
    loadMoreHistory();
  }

  const showBottomFade = el.scrollHeight - el.scrollTop > el.clientHeight + buffer;
  currentTextWrapper.classList.toggle('show-top-fade', true);
  currentTextWrapper.classList.toggle('show-bottom-fade', showBottomFade);

  const isAtBottom = !showBottomFade;
  btnDown.disabled = isAtBottom;
  btnCurrent.disabled = isAtBottom;
}

/**
 * Removes all `<span>` elements on the first rendered line of the text container.
 */
function removeFirstRenderedLine() {
  const container = currentTextContainer;
  if (!container.firstChild) return;
  const children = Array.from(container.children);
  if (children.length === 0) return;

  const firstLineTop = children[0].getBoundingClientRect().top;
  const spansToRemove = [];

  for (const span of children) {
    if (Math.abs(span.getBoundingClientRect().top - firstLineTop) < 2) {
      spansToRemove.push(span);
    } else {
      break;
    }
  }
  spansToRemove.forEach(span => span.remove());
}


// ============================================================================
// --- EVENT LISTENER SETUP ---
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
    window.open('/history.html', '_blank');
  });
  currentTextContainer.addEventListener('scroll', updateScrollEffects);
}

/**
 * Attaches click handlers to open and close the information modal.
 */
function addInfoModalEvents() {
  if (!btnInfo || !infoModal) return;
  btnInfo.addEventListener('click', () => infoModal.classList.add('visible'));
  modalClose.addEventListener('click', () => infoModal.classList.remove('visible'));
  modalOverlay.addEventListener('click', () => infoModal.classList.remove('visible'));
}

/**
 * Adds event listeners for the word submission form and style buttons.
 */
function addFormAndStyleEvents() {
    styleOptions.addEventListener('click', (event) => {
        const target = event.target.closest('.style-btn');
        if (!target) return;

        const style = target.dataset.style;
        const noStyleButton = document.querySelector('[data-style="none"]');
        const styleButtons = Array.from(document.querySelectorAll('[data-style="bold"], [data-style="italic"], [data-style="underline"]'));

        if (style === 'none') {
            styleButtons.forEach(btn => btn.classList.remove('active'));
            target.classList.add('active');
        } else {
            noStyleButton.classList.remove('active');
            target.classList.toggle('active');
        }

        const isAnyStyleActive = styleButtons.some(btn => btn.classList.contains('active'));
        if (!isAnyStyleActive) {
            noStyleButton.classList.add('active');
        }

        selectedStyles.bold = document.querySelector('[data-style="bold"]').classList.contains('active');
        selectedStyles.italic = document.querySelector('[data-style="italic"]').classList.contains('active');
        selectedStyles.underline = document.querySelector('[data-style="underline"]').classList.contains('active');

        wordInput.style.fontWeight = selectedStyles.bold ? 'bold' : 'normal';
        wordInput.style.fontStyle = selectedStyles.italic ? 'italic' : 'normal';
        wordInput.style.textDecoration = selectedStyles.underline ? 'underline' : 'none';
    });

    wordForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!currentUser.loggedIn) {
            showFeedback("Word will be submitted as \"anonymous\".", "info");
        }
        const wordToSubmit = wordInput.value.trim();
        if (wordToSubmit) {
            const punctuationRegex = new RegExp(CFG.PUNCTUATION_REGEX_STRING);
            if (!punctuationRegex.test(wordToSubmit)) {
                showFeedback("Invalid format. Please submit a single, word-like token without spaces and optional punctuation.", "warning");
                return;
            }
            socket.emit('wordSubmitted', { word: wordToSubmit, styles: selectedStyles });
            wordInput.value = '';
        }
    });
}

// ============================================================================
// --- ASYNC DATA FETCHING ---
// ============================================================================

/**
 * Fetches older words from the server and prepends them to the display.
 */
async function loadMoreHistory() {
  if (isLoadingMore || currentWordsArray.length === 0) return;
  isLoadingMore = true;

  const oldestTimestamp = currentWordsArray[0].ts;

  try {
    const response = await fetch(`/api/history/before?ts=${oldestTimestamp}&limit=50`);
    const olderWords = await response.json();

    if (olderWords.length > 0) {
      const container = currentTextContainer;
      const oldScrollHeight = container.scrollHeight;

      olderWords.forEach(wordData => {
        const wordSpan = document.createElement('span');
        wordSpan.className = 'word';
        wordSpan.dataset.ts = wordData.ts;
        wordSpan.dataset.username = wordData.username;
        wordSpan.dataset.count = wordData.count;
        wordSpan.dataset.total = wordData.total;
        wordSpan.dataset.pct = wordData.pct;
        wordSpan.textContent = wordData.word + ' ';
        wordSpan.style.fontWeight = wordData.styles.bold ? 'bold' : 'normal';
        wordSpan.style.fontStyle = wordData.styles.italic ? 'italic' : 'normal';
        wordSpan.style.textDecoration = wordData.styles.underline ? 'underline' : 'none';
        container.prepend(wordSpan);
      });

      const correctlyOrderedOlderWords = olderWords.reverse();
      currentWordsArray = [...correctlyOrderedOlderWords, ...currentWordsArray];

      const newScrollHeight = container.scrollHeight;
      container.scrollTop = newScrollHeight - oldScrollHeight;
    }
  } catch (error) {
    console.error("Failed to load more history:", error);
  } finally {
    isLoadingMore = false;
  }
}