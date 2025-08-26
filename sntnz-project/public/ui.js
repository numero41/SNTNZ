// ============================================================================
// SN-TN-Z: UI.JS
// ----------------------------------------------------------------------------
// Manages all DOM interactions, event listeners, and rendering logic for the
// application. This module exports functions to be called by client.js in
// response to server events and user actions.
// ============================================================================

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
const usernameForm = document.getElementById('usernameForm');
const usernameInput = document.getElementById('usernameInput');
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
const modalOverlay = infoModal.querySelector('.modal-overlay');
const modalClose = infoModal.querySelector('.modal-close');

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
  addTooltipEvents();
  addInfoModalEvents();
  addFormAndStyleEvents();
  addUsernameFormEvents();
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
 */
export async function updateUserStatus() {
  const userStatusEl = document.getElementById('userStatus');
  if (!userStatusEl) return;

  try {
    const response = await fetch('/api/user');
    const user = await response.json();
    currentUser = user;

    const loginIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"></path></svg>`;
    const logoutIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"></path></svg>`;

    if (user.loggedIn) {
      userStatusEl.innerHTML = `<a href="/logout"><span>${user.username}</span>${logoutIcon}</a>`;
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
 */
export function showFeedback(message) {
  feedbackMessage.textContent = message;
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
            showFeedback("You must be logged in to submit a word.");
            return;
        }
        const wordToSubmit = wordInput.value.trim();
        if (wordToSubmit) {
            const punctuationRegex = new RegExp(CFG.PUNCTUATION_REGEX_STRING);
            if (!punctuationRegex.test(wordToSubmit)) {
                showFeedback("Invalid format. Please submit a single, word-like token without spaces and optional punctuation.");
                return;
            }
            socket.emit('wordSubmitted', { word: wordToSubmit, styles: selectedStyles });
            wordInput.value = '';
        }
    });
}

/**
 * Adds event listeners to show a tooltip on word click.
 */
function addTooltipEvents() {
  currentTextContainer.addEventListener('click', (e) => {
    const wordSpan = e.target.closest('.word');
    if (wordSpan && tooltip) {
      const data = wordSpan.dataset;
      const date = new Date(parseInt(data.ts));
      const localTimeString = date.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
      const utcTimeString = date.toUTCString();

      tooltip.innerHTML = `
        <strong>Author:</strong> ${data.username}<br>
        <strong>Time (Local):</strong> ${localTimeString}<br>
        <strong>Time (UTC):</strong> ${utcTimeString}<br>
        <strong>Votes:</strong> ${data.count} / ${data.total} (${data.pct}%)`;

      const tooltipWidth = tooltip.offsetWidth;
      const windowWidth = window.innerWidth;
      const margin = 15;
      let newLeft = e.pageX - (tooltipWidth / 2);
      let newTop = e.pageY + margin;

      if (newLeft < margin) newLeft = margin;
      if (newLeft + tooltipWidth > windowWidth - margin) {
        newLeft = windowWidth - tooltipWidth - margin;
      }

      tooltip.style.left = `${newLeft}px`;
      tooltip.style.top = `${newTop}px`;
      tooltip.classList.add('visible');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.word') && tooltip) {
      tooltip.classList.remove('visible');
    }
  }, true);
}

/**
 * Adds event listener for the username selection form.
 */
function addUsernameFormEvents() {
  // If the form doesn't exist on the page, do nothing.
  if (!usernameForm) return;

  usernameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = usernameInput.value.trim();

    if (!username) {
      showFeedback("Username cannot be empty."); // Uses the existing feedback function
      return;
    }

    try {
      const response = await fetch('/api/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });

      const result = await response.json();

      if (response.ok) {
        showFeedback('Username saved! Redirecting...');
        // Redirect to the main page to reload with the new username
        setTimeout(() => {
          window.location.href = '/';
        }, 1500);
      } else {
        // Show the error message from the server
        showFeedback(result.message || 'An unknown error occurred.');
      }
    } catch (error) {
      console.error('Failed to set username:', error);
      showFeedback('A network error occurred. Please try again.');
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