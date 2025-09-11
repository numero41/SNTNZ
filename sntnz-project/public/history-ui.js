/**
 * history-ui.js
 * -------------
 * Handles all DOM rendering and event listeners for the history page.
 * It imports shared UI components like the tooltip.
 */

import { addTooltipEvents, startSealCountdown } from './shared-ui.js';
export { renderContributorsDropdown } from './shared-ui.js';

/**
 * Renders the complete history by iterating through server-generated chunks.
 * @param {HTMLElement} container - The main history container element.
 * @param {Array<Object>} chunks - The array of chunk data objects.
 * @param {string} cronSchedule - The cron schedule for the next seal.
 */
export function renderHistory(container, chunks, cronSchedule) {
  // --- Handle No Data ---
  // If the server returns no chunks, display a user-friendly message.
  if (!chunks || chunks.length === 0) {
    container.innerHTML = `<p class="history-error">No history found for this day.</p>`;
    return;
  }

  // --- Use a Document Fragment for Performance ---
  // Appending elements to the DOM one by one can be slow because it triggers
  // a "reflow" each time. A DocumentFragment is an in-memory container where
  // we can build our content first, and then append it to the DOM in a single operation.
  const fragment = document.createDocumentFragment();

  // --- Create and Append Chunk Elements ---
  chunks.forEach(chunk => {
    const chunkElement = createChunkElement(chunk);
    if (chunkElement) {
      fragment.appendChild(chunkElement);
    }
  });

  // --- Render to the DOM ---
  container.innerHTML = ''; // Clear any existing content (like a loading spinner).
  container.appendChild(fragment); // Append the fully constructed content.

  // --- After rendering, find the timer element and start the countdown ---
  const timerElement = container.querySelector('.chunk-seal-timer');
  if (timerElement && cronSchedule) {
    startSealCountdown(timerElement, cronSchedule);
  }
}

/**
 * Creates an HTML span for a single word object.
 * @param {object} wordData - The data for one word.
 * @returns {string} The HTML string for the span.
 */
function createWordSpan(wordData) {
  const wordSpan = document.createElement('span');
  wordSpan.className = 'word';

  // Set Data Attributes
  wordSpan.dataset.ts = wordData.ts;
  wordSpan.dataset.username = wordData.username;
  wordSpan.dataset.pct = wordData.pct.toFixed(2);
  wordSpan.dataset.count = wordData.count;
  wordSpan.dataset.total = wordData.total;

  // Set Content and Styles securely
  wordSpan.textContent = wordData.word; // <-- The secure part
  wordSpan.style.fontWeight = wordData.styles.bold ? 'bold' : 'normal';
  wordSpan.style.fontStyle = wordData.styles.italic ? 'italic' : 'normal';
  wordSpan.style.textDecoration = wordData.styles.underline ? 'underline' : 'none';

  return wordSpan;
}

/**
 * Appends a single word to the existing live chunk without a full page reload.
 * @param {object} wordData - The data for the new word.
 */
export function appendWordToLiveChunk(wordData) {
  // Find the text block of the live chunk (which contains the countdown timer).
  const timerElement = document.querySelector('.chunk-seal-timer');
  if (!timerElement) return; // No live chunk on the page (e.g., viewing an old day)

  const liveTextBlock = timerElement.closest('.history-chunk')?.querySelector('.history-text-block');
  if (!liveTextBlock) return;

  // Create the new word element securely
  const wordSpan = createWordSpan(wordData);

  // Handle newlines before appending the word
  if (wordData.styles.newline) {
      liveTextBlock.appendChild(document.createElement('br'));
  }
  // Append a space
  liveTextBlock.appendChild(document.createTextNode(' '));

  // Add the word
  liveTextBlock.appendChild(wordSpan);
}

/**
 * Creates the HTML element for a single history chunk.
 * @param {Object} chunkData - The data for one chunk.
 * @returns {HTMLElement | null} The fully constructed div element or null if data is invalid.
 */
function createChunkElement(chunkData) {
  // 1. CREATE THE MAIN CONTAINER
  //    We start by creating the main 'div' that will hold everything for this chunk.
  const el = document.createElement('div');
  el.className = 'history-chunk';
  //    Assign the chunk's unique hash as the element's ID. This allows for deep-linking (e.g., page.html#hash).
  el.id = chunkData.hash;
  //    Also store the hash in a data attribute, which is a standard way to attach data for JS to read easily.
  el.dataset.hash = chunkData.hash;

  // 2. FORMAT METADATA
  //    Convert the raw timestamp (a number) into a human-readable HH:MM format.
  const date = new Date(chunkData.ts);
  const hh = String(date.getHours()).padStart(2, '0'); // padStart ensures we get '09' instead of '9'.
  const mm = String(date.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  // 3. DEFINE STATIC ASSETS AND CONDITIONAL HTML
  //    Store SVG icon markup in a variable for reusability.
  const shareIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3z"></path></svg>`;

  //    Determine what to display for the hash. If the chunk is "live" (not yet sealed),
  //    show a countdown timer. Otherwise, show the shortened, clickable hash.
  const hashDisplay = chunkData.isLive
    ? `<span class="chunk-seal-timer" title="These words are not yet sealed.">Calculating...</span>`
    : `<span class="chunk-hash" title="Copy Hash" data-hash="${chunkData.hash}">${chunkData.hash.substring(0, 12)}...</span>`;

  // Create the share button if the chunk is sealed
  const shareButtonHtml = chunkData.isLive ? '' : `
    <button class="share-btn">
      ${shareIcon} Share
    </button>
  `;

  //    If an imageUrl exists for this chunk, prepare the image HTML. Otherwise, this remains an empty string.
  let imageHtml = '';
  if (chunkData.imageUrl) {
    const altText = `AI image for chunk: ${chunkData.text.substring(0, 100)}...`;
    imageHtml = `
      <div class="image-container">
        <img src="${chunkData.imageUrl}" alt="${altText}" class="chunk-image">
      </div>
    `;
  }

  // 4. ASSEMBLE THE STATIC (NON-USER-GENERATED) PARTS
  //    We use '.innerHTML' here, which is safe because all the content (`time`, `hashDisplay`, `shareIcon`, `imageHtml`)
  //    is generated by our own code, not by users. This is more efficient than creating each of these elements one by one.
  el.innerHTML = `
    <div class="chunk-meta">
      <div class="chunk-info">
        <span class="chunk-time">${time}</span>
        ${hashDisplay}
      </div>
      <div class="chunk-actions">
        ${shareButtonHtml}
        </button>
      </div>
    </div>
    ${imageHtml}
  `;

  // 5. **SECURELY** BUILD AND APPEND THE TEXT BLOCK
  //    This is the most critical part for security. We will now build the story text
  //    element by element, never using '.innerHTML' with user-provided content.
  const textBlock = document.createElement('div');
  textBlock.className = 'history-text-block';

  //    Loop through every word object in the chunk's data.
  chunkData.words.forEach(wordData => {
    //    First, check if this word is meant to start a new line.
    if (wordData.styles.newline) {
      //      If so, append a <br> element.
      textBlock.appendChild(document.createElement('br'));
    }

    //    Next, call our secure `createWordSpan` function. This function returns a fully-formed,
    //    safe `<span>` element where the word content has been set using '.textContent'.
    const wordSpan = createWordSpan(wordData);
    textBlock.appendChild(wordSpan); // Append the safe element to our text block.

    //    Finally, add a space after each word. We use `createTextNode` to ensure the space is treated as text.
    textBlock.appendChild(document.createTextNode(' '));
  });

  // Remove the first empty line
  if (textBlock.firstChild && textBlock.firstChild.tagName === 'BR') {
    textBlock.removeChild(textBlock.firstChild);
  }
  // 6. FINALIZE AND RETURN
  //    Append the now fully-populated (and secure) text block to our main chunk element.
  el.appendChild(textBlock);
  //    Return the complete, safe-to-render chunk element.
  return el;
}

/**
 * Renders the pagination links at the bottom of the page.
 * @param {HTMLElement} container - The pagination container element.
 * @param {Array<string>} dates - All available dates (e.g., ["2025-08-29", "2025-08-30"]).
 * @param {string} currentDate - The currently selected date.
 */
export function renderPagination(container, dates, currentDate) {
  // If there are 3 or fewer dates, we just display them all in chronological order.
  if (dates.length <= 3) {
    const linksHtml = [...dates].reverse().map(date => `<a href="?date=${date}" class="${date === currentDate ? 'current' : ''}">${date}</a>`).join('');
    container.innerHTML = linksHtml;
    return;
  }

  // --- Complex Case: Create a "sliding window" of dates ---
  const windowSize = 3;
  const currentIndex = dates.indexOf(currentDate);

  let start = Math.max(0, currentIndex - Math.floor(windowSize / 2));
  start = Math.min(start, dates.length - windowSize);

  const datesToShow = dates.slice(start, start + windowSize);

  // --- Define Navigation Links ---
  // Remember: dates array is newest-to-oldest.
  const newestLink = dates[0];
  const oldestLink = dates[dates.length - 1];

  // A "newer" date has a smaller index, an "older" date has a larger index.
  const newerDateLink = dates[Math.max(0, currentIndex - 1)];
  const olderDateLink = dates[Math.min(dates.length - 1, currentIndex + 1)];

  // --- Determine if Arrow Buttons Should be Disabled ---
  const isAtNewest = currentIndex === 0;
  const isAtOldest = currentIndex === dates.length - 1;

  // --- Build HTML for each part of the pagination control ---
  // '<<' should go to the OLDEST date.
  const firstButton = `<a href="?date=${oldestLink}" class="nav-arrow" ${isAtOldest ? 'disabled' : ''}>&lt;&lt;</a>`;
  // '<' should go to an OLDER date.
  const prevButton = `<a href="?date=${olderDateLink}" class="nav-arrow" ${isAtOldest ? 'disabled' : ''}>&lt;</a>`;

  // Reverse the display slice to show dates chronologically (oldest, middle, newest).
  const dateLinks = datesToShow.reverse().map(date => `<a href="?date=${date}" class="${date === currentDate ? 'current' : ''}">${date}</a>`).join('');

  // '>' should go to a NEWER date.
  const nextButton = `<a href="?date=${newerDateLink}" class="nav-arrow" ${isAtNewest ? 'disabled' : ''}>&gt;</a>`;
  // '>>' should go to the NEWEST date.
  const lastButton = `<a href="?date=${newestLink}" class="nav-arrow" ${isAtNewest ? 'disabled' : ''}>&gt;&gt;</a>`;

  // --- Assemble and Render the Final HTML ---
  container.innerHTML = firstButton + prevButton + dateLinks + nextButton + lastButton;
}

/**
 * Sets up all event listeners for the page (tooltips, sharing, copy hash).
 * @param {HTMLElement} historyContainer - The main history container element.
 * @param {HTMLElement} tooltip - The tooltip element.
 */
export function setupEventListeners(historyContainer, tooltip) {
  // --- Initialize Shared Tooltip Logic ---
  addTooltipEvents(historyContainer, tooltip);

  // --- Use Event Delegation for Dynamic Content ---
  // Instead of adding a listener to every button, we add one to the parent container.
  // This is more efficient and works for content added to the page at any time.
  historyContainer.addEventListener('click', async (e) => {

    // --- Share Button Logic ---
    // e.target.closest() finds the nearest ancestor that matches the selector.
    const shareButton = e.target.closest('.share-btn');
    if (shareButton) {
      // Find the parent chunk element to get its hash
      const chunkElement = shareButton.closest('.history-chunk');
      const chunkHash = chunkElement.dataset.hash;
      if (!chunkHash) return;

      // --- Fetch the formatted text from the server ---
      let textToShare = "Read this story from the sntnz project."; // A default fallback text
      try {
        const response = await fetch(`/api/share-text/${chunkHash}`);
        const data = await response.json();
        if (data.shareText) {
          textToShare = data.shareText;
        }
      } catch (err) {
        console.error("Failed to fetch share text:", err);
      }

      const shortHash = chunkHash.substring(0, 12);
      const url = `${window.location.origin}/chunk/${shortHash}`;
      const shareData = { title: 'snTnz Story Chunk', text: textToShare, url: url };

      // Use the modern Web Share API if available.
      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch (err) { /* User likely cancelled the share */ }
      } else {
        // Fallback: If Share API isn't supported, copy the text to the clipboard.
        await navigator.clipboard.writeText(textToShare);

        const originalButtonText = shareButton.innerHTML;
        shareButton.innerHTML = 'Copied!';
        setTimeout(() => { shareButton.innerHTML = originalButtonText; }, 2000);
      }
      return;
    }

    // --- Copy Hash Logic ---
    const hashSpan = e.target.closest('.chunk-hash');
    if (hashSpan) {
      const fullHash = hashSpan.dataset.hash;
      await navigator.clipboard.writeText(fullHash);

      // Provide visual feedback.
      const originalText = hashSpan.textContent;
      hashSpan.textContent = 'Copied!';
      setTimeout(() => { hashSpan.textContent = originalText; }, 1500);
    }
  });
}