// ============================================================================
// --- INITIALIZATION ---
// ============================================================================
const socket = io({ transports: ['websocket'] });

// ============================================================================
// CONFIG BOOTSTRAP (client side)
// ============================================================================
let CFG = null;
(async function boot(){
  await loadConfig();
  const currentTextLength = CFG.CURRENT_TEXT_LENGTH;
  const roundDurationSeconds = CFG.ROUND_DURATION_SECONDS;
})();


// ============================================================================
// --- DOM ELEMENT REFERENCES ---
// ============================================================================
const currentTextContainer = document.getElementById('currentTextContainer');
const currentTextWrapper = document.getElementById('currentTextWrapper');
const loadingSpinner = document.getElementById('loadingSpinner');

const btnUp = document.getElementById('btnScrollUp');
const btnDown = document.getElementById('btnScrollDown');
const btnCurrent = document.getElementById('btnScrollCurrent');
const btnOpenHistory = document.getElementById('btnOpenHistory');

const liveFeedList = document.getElementById('liveFeedList');
const form = document.getElementById('wordForm');
const input = document.getElementById('wordInput');
const timerDisplay = document.getElementById('timer');
const styleOptions = document.getElementById('styleOptions');
const submitButton = document.getElementById('submitButton');
const feedbackMessage = document.getElementById('feedbackMessage');

addNavEvents()

// ============================================================================
// --- CLIENT-SIDE STATE ---
// ============================================================================
let currentWordsArray = [];
let selectedStyles = { bold: false, italic: false, underline: false };
let nextTickTimestamp = 0;
let feedbackTimeout;
let lastScrollHeight = 0;
let isLoadingMore = false;
let noMoreHistory = false;
let isBooting = true;
const charsFadedInCount = 100;

// ============================================================================
// --- HELPER FUNCTIONS ---
// ============================================================================
/**
 * loadConfig
 * ----------
 * Fetches shared constants from the server so the client and server agree
 * on round duration, sentence length, etc.
 */
async function loadConfig(){
  const r = await fetch('/config', { cache: 'no-store' });
  CFG = await r.json();
}

/**
 * showFeedback
 * ------------
 * Displays a temporary feedback message to the user.
 * The message fades out automatically after 3 seconds.
 *
 * @param {string} message - The feedback message to display.
 *
 * @example
 * showFeedback("Invalid submission.");
 */
function showFeedback(message) {
  feedbackMessage.textContent = message;
  feedbackMessage.classList.add('visible');
  clearTimeout(feedbackTimeout);
  feedbackTimeout = setTimeout(() => {
    feedbackMessage.classList.remove('visible');
  }, 3000);
}


/**
 * addNavEvents
 * -------------
 * Attach click handlers for history navigation buttons.
 * - ▲ Scroll up smoothly by 200px
 * - ▼ Scroll down smoothly by 200px
 * - ● Jump to the bottom ("current")
 * - ⧉ Open the full history page in a new tab
 *
 * Also triggers `updateScrollEffects()` after each action so
 * the down/current buttons hide when already at the bottom.
 */
function addNavEvents() {
  // Scroll up by 80% of the container's visible height
  btnUp.addEventListener('click', () => {
    currentTextContainer.scrollBy({ top: -currentTextContainer.clientHeight * 0.5, behavior: 'smooth' });
  });

  // Scroll down by 80% of the container's visible height
  btnDown.addEventListener('click', () => {
    currentTextContainer.scrollBy({ top: currentTextContainer.clientHeight * 0.5, behavior: 'smooth' });
  });

  // Jump to current (bottom of container)
  btnCurrent.addEventListener('click', () => {
    currentTextContainer.scrollTo({ top: currentTextContainer.scrollHeight, behavior: 'smooth' });
  });

  // Open history page in a new tab
  btnOpenHistory.addEventListener('click', () => {
    window.open('/history.html', '_blank');
  });

  // Add scroll events to the container to update button states
  currentTextContainer.addEventListener('scroll', updateScrollEffects);
}

/**
 * updateScrollEffects
 * -------------------
 * Manages the state of scroll-related UI elements based on the
 * container's scroll position.
 */
function updateScrollEffects() {
  const el = currentTextContainer;
  const buffer = 1; // A 1px buffer for more reliable calculations

  // Always show the top fade
  const showTopFade = true;

  // Trigger "load more" when scrolled to the top
  if (el.scrollTop < 50 && !isBooting) { // Using a 50px threshold from the top
    loadMoreHistory();
  }

  // Show the bottom fade if there is more content to scroll to
  const showBottomFade = el.scrollHeight - el.scrollTop > el.clientHeight + buffer;

  // Apply the classes based on the conditions
  currentTextWrapper.classList.toggle('show-top-fade', showTopFade);
  currentTextWrapper.classList.toggle('show-bottom-fade', showBottomFade);

  // Also update the navigation buttons
  const isAtBottom = !showBottomFade;
  btnDown.disabled = isAtBottom;
  btnCurrent.disabled = isAtBottom;
}

/**
 * loadMoreHistory
 * ---------------
 * Fetches older words from the server and prepends them to the display.
 * Manages the scroll position to provide a seamless experience.
 */
async function loadMoreHistory() {
  if (isLoadingMore || noMoreHistory || currentWordsArray.length === 0) return;

  isLoadingMore = true;
  //loadingSpinner.style.display = 'block';

  const oldestWord = currentWordsArray[0];
  const oldestTimestamp = oldestWord.ts;

  try {
    const response = await fetch(`/api/history/before?ts=${oldestTimestamp}&limit=50`);
    const olderWords = await response.json();

    if (olderWords.length === 0) {
      noMoreHistory = true; // No more data to load
      console.log("Reached the beginning of the history.");
      return;
    }

    // --- The key to preventing scroll jump ---
    const container = currentTextContainer;
    const oldScrollHeight = container.scrollHeight;

    // Prepend the new words. We reverse them because the server sends them newest-first.
    olderWords.reverse().forEach(wordData => {
      const wordSpan = document.createElement('span');
      wordSpan.textContent = wordData.word + ' ';
      wordSpan.style.fontWeight = wordData.styles.bold ? 'bold' : 'normal';
      wordSpan.style.fontStyle = wordData.styles.italic ? 'italic' : 'normal';
      wordSpan.style.textDecoration = wordData.styles.underline ? 'underline' : 'none';
      container.prepend(wordSpan);
    });

    // Update the client-side state
    currentWordsArray = [...olderWords, ...currentWordsArray];

    // Adjust scroll position to keep the user's view stable
    const newScrollHeight = container.scrollHeight;
    container.scrollTop = newScrollHeight - oldScrollHeight;
    lastScrollHeight = container.scrollHeight;

  } catch (error) {
    console.error("Failed to load more history:", error);
  } finally {
    isLoadingMore = false;
    //loadingSpinner.style.display = 'none';
  }
}

// ============================================================================
// --- RENDER FUNCTIONS ---
// ============================================================================

/**
 * renderWords
 * -----------
 * Renders an array of words by appending them to the container.
 *
 * @param {Array<{word: string, styles: object}>} wordsArray
 */
function renderWords(wordsArray) {
  // Create and append a styled span for each word
  wordsArray.forEach((wordData) => {
    const wordSpan = document.createElement('span');

    wordSpan.textContent = wordData.word + ' ';

    wordSpan.style.fontWeight = wordData.styles.bold ? 'bold' : 'normal';
    wordSpan.style.fontStyle = wordData.styles.italic ? 'italic' : 'normal';
    wordSpan.style.textDecoration = wordData.styles.underline ? 'underline' : 'none';

    currentTextContainer.appendChild(wordSpan);
  });

  // Update the scroll effects after rendering
  updateScrollEffects();
}

/**
 * removeFirstRenderedLine
 * -----------------------
 * Identifies all <span> elements on the first rendered line of the text container
 * and removes them. It works by comparing the vertical position of each element.
 */
function removeFirstRenderedLine() {
  const container = currentTextContainer;
  if (!container.firstChild) return;

  // Get all the word <span> elements currently in the container
  const children = Array.from(container.children);
  if (children.length === 0) return;

  // Determine the top position of the very first line
  const firstLineTop = children[0].getBoundingClientRect().top;
  const spansToRemove = [];

  for (const span of children) {
    // An element is on the first line if its top position is the same.
    // We use a small buffer (2px) to account for tiny rendering variations.
    if (Math.abs(span.getBoundingClientRect().top - firstLineTop) < 2) {
      spansToRemove.push(span);
    } else {
      // As soon as we find a span on a different line, we can stop.
      break;
    }
  }

  // Remove all the spans that were identified as being on the first line.
  spansToRemove.forEach(span => span.remove());
}

/**
 * renderLiveFeed
 * --------------
 * Renders the live submissions feed:
 * - Shows each word, styled with bold/italic/underline if selected.
 * - Shows vote counts in brackets.
 * - Shades text color based on vote ratio (darker for top votes).
 * - Adds click-to-resubmit behavior.
 *
 * @param {Array<{word: string, count: number, styles: {bold: boolean, italic: boolean, underline: boolean}}>} feedData
 *   Array of live feed items.
 *
 * @example
 * renderLiveFeed([{ word: "world", count: 2, styles: { bold: false, italic: true, underline: false } }]);
 */
function renderLiveFeed(feedData) {
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
    newWordItem.appendChild(wordSpan);
    newWordItem.appendChild(countSpan);
    const voteRatio = item.count / maxVotes;
    const lightness = (1 - voteRatio) * 75;
    newWordItem.style.color = `hsl(0, 0%, ${lightness}%)`;
    newWordItem.style.cursor = 'pointer';
    newWordItem.addEventListener('click', () => {
      // Click-to-submit now works again because the form is not disabled
      socket.emit('wordSubmitted', { word: item.word, styles: item.styles });
    });
    liveFeedList.appendChild(newWordItem);
  });
}

// ============================================================================
// --- UI EVENT LISTENERS ---
// ============================================================================

styleOptions.addEventListener('click', (event) => {
  const target = event.target;
  if (!target.classList.contains('style-btn')) return;
  const style = target.dataset.style;
  if (style) {
    target.classList.toggle('active');
    selectedStyles[style] = target.classList.contains('active');
    input.style.fontWeight = selectedStyles.bold ? 'bold' : 'normal';
    input.style.fontStyle = selectedStyles.italic ? 'italic' : 'normal';
    input.style.textDecoration = selectedStyles.underline ? 'underline' : 'none';
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();

  const wordToSubmit = input.value;
  if (wordToSubmit) {
    const punctuationRegex = new RegExp(CFG.PUNCTUATION_REGEX_STRING);
    if (!punctuationRegex.test(wordToSubmit)) {
      showFeedback("Invalid format. Please submit a single, word-like token without spaces and optional punctuation.");
      return;
    }

    // If validation passes, emit and clear the input. Do NOT disable the form.
    socket.emit('wordSubmitted', { word: wordToSubmit, styles: selectedStyles });
    input.value = '';
  }
});

// ============================================================================
// --- SYNCHRONIZED TIMER LOGIC ---
// ============================================================================
// Updates the countdown timer every 500ms based on server's nextTickTimestamp.
let clearedAtZero = false;
let clearedMainAtZero = false;

setInterval(() => {
  if (nextTickTimestamp === 0) return;
  const remainingMs = nextTickTimestamp - Date.now();
  if (remainingMs <= 0) {
    return;
  }

  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  timerDisplay.textContent = remainingSeconds;

  if (remainingSeconds === 0 && !clearedAtZero) {
    try { renderLiveFeed([]); } catch {}
    clearedAtZero = true;
  }
}, 50);


// ============================================================================
// --- SOCKET.IO EVENT LISTENERS ---
// ============================================================================

socket.on('initialState', ({ currentText, liveSubmissions, nextTickTimestamp: serverTimestamp }) => {
  // On initial load, clear the container and render the full text once.
  currentTextContainer.innerHTML = '';
  renderWords(currentText);
  currentWordsArray = currentText; // Set the initial state

  try { renderLiveFeed(liveSubmissions); } catch (e) { console.error('renderLiveFeed failed', e); }
  nextTickTimestamp = serverTimestamp;

  //Then jump to bottom (twice) with smooth disabled to avoid CSS interference
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
});

socket.on('nextTick', ({ nextTickTimestamp: serverTimestamp }) => {
  nextTickTimestamp = serverTimestamp;
  clearedAtZero = false;
  clearedMainAtZero = false;
});

socket.on('liveFeedUpdated', (feedData) => {
  renderLiveFeed(feedData);
});

socket.on('currentTextUpdated', (newCurrentText) => {
  const el = currentTextContainer;
  const scrollBuffer = 5;
  const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= scrollBuffer;

  // Get the single new word. It's always the last one in the server's array.
  const newWord = newCurrentText[newCurrentText.length - 1];

  // Make sure we don't already have this word (prevents rare race conditions)
  const lastWordInClientArray = currentWordsArray[currentWordsArray.length - 1];
  if (!newWord || (lastWordInClientArray && lastWordInClientArray.ts === newWord.ts)) {
    return; // Do nothing if the word is missing or a duplicate.
  }

  // Render just the new word by appending it to the container.
  renderWords([newWord]);

  // Check if the new word created a new line and remove the top one if needed.
  const newHeight = el.scrollHeight;
  if (wasAtBottom && lastScrollHeight > 0 && newHeight > lastScrollHeight) {
    removeFirstRenderedLine();
  }

  // Append the new word to our array
  currentWordsArray.push(newWord);
  lastScrollHeight = el.scrollHeight; // Update height *after* potential removal.

  // Keep the user at the bottom if they were there before.
  if (wasAtBottom) {
    el.scrollTop = el.scrollHeight;
  }
});

socket.on('submissionFailed', (data) => {
  showFeedback(data.message);
});