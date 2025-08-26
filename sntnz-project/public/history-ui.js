/**
 * history-ui.js
 * -------------
 * Handles all DOM rendering and event listeners for the history page.
 * It imports shared UI components like the tooltip.
 */

import { addTooltipEvents } from './shared-ui.js';

/**
 * Renders the complete history by iterating through server-generated chunks.
 * @param {HTMLElement} container - The main history container element.
 * @param {Array<Object>} chunks - The array of chunk data objects.
 */
export function renderHistory(container, chunks) {
  if (!chunks || chunks.length === 0) {
    container.innerHTML = `<p class="history-error">No history found for this day.</p>`;
    return;
  }
  const fragment = document.createDocumentFragment();
  chunks.forEach(chunk => {
    const chunkElement = createChunkElement(chunk);
    if (chunkElement) {
      fragment.appendChild(chunkElement);
    }
  });
  container.innerHTML = ''; // Clear previous content
  container.appendChild(fragment);
}

/**
 * Creates the HTML element for a single history chunk.
 * @param {Object} chunkData - The data for one chunk.
 * @returns {HTMLElement | null} The fully constructed div element or null if data is invalid.
 */
function createChunkElement(chunkData) {
  const el = document.createElement('div');
  el.className = 'history-chunk';

  const date = new Date(chunkData.ts);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  const textContent = chunkData.words.map(wordData => {
    const styleOpen = `${wordData.styles.bold ? '<b>':''}${wordData.styles.italic ? '<i>':''}${wordData.styles.underline ? '<u>':''}`;
    const styleClose = `${wordData.styles.underline ? '</u>':''}${wordData.styles.italic ? '</i>':''}${wordData.styles.bold ? '</b>':''}`;
    return `<span class="word"
      data-ts="${wordData.ts}"
      data-username="${wordData.username}"
      data-pct="${wordData.pct}"
      data-count="${wordData.count}"
      data-total="${wordData.total}">
        ${styleOpen}${wordData.word}${styleClose}
    </span>`;
  }).join(' ');

  const shareIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3z"></path></svg>`;

  el.innerHTML = `
    <div class="chunk-meta">
      <div class="chunk-info">
        <span class="chunk-time">${time}</span>
        <span class="chunk-hash" title="Copy Hash" data-hash="${chunkData.hash}">${chunkData.hash.substring(0, 12)}...</span>
      </div>
      <div class="chunk-actions">
        <button class="share-btn" data-text="${chunkData.text}">
          ${shareIcon} Share
        </button>
      </div>
    </div>
    <div class="history-text-block">${textContent}</div>
  `;
  return el;
}

/**
 * Renders the pagination links at the bottom of the page.
 * @param {HTMLElement} container - The pagination container element.
 * @param {Array<string>} dates - All available dates.
 * @param {string} currentDate - The currently selected date.
 */
export function renderPagination(container, dates, currentDate) {
  if (dates.length <= 3) {
    const linksHtml = dates.map(date => `<a href="?date=${date}" class="${date === currentDate ? 'current' : ''}">${date}</a>`).join('');
    container.innerHTML = linksHtml;
    return;
  }
  const windowSize = 3;
  const currentIndex = dates.indexOf(currentDate);
  let start = Math.max(0, currentIndex - Math.floor(windowSize / 2));
  start = Math.min(start, dates.length - windowSize);
  const datesToShow = dates.slice(start, start + windowSize);
  const firstLink = dates[0];
  const prevLink = dates[Math.max(0, currentIndex - 1)];
  const nextLink = dates[Math.min(dates.length - 1, currentIndex + 1)];
  const lastLink = dates[dates.length - 1];
  const isAtStart = currentIndex === 0;
  const isAtEnd = currentIndex === dates.length - 1;
  const firstButton = `<a href="?date=${firstLink}" class="nav-arrow" ${isAtStart ? 'disabled' : ''}>&lt;&lt;</a>`;
  const prevButton = `<a href="?date=${prevLink}" class="nav-arrow" ${isAtStart ? 'disabled' : ''}>&lt;</a>`;
  const dateLinks = datesToShow.map(date => `<a href="?date=${date}" class="${date === currentDate ? 'current' : ''}">${date}</a>`).join('');
  const nextButton = `<a href="?date=${nextLink}" class="nav-arrow" ${isAtEnd ? 'disabled' : ''}>&gt;</a>`;
  const lastButton = `<a href="?date=${lastLink}" class="nav-arrow" ${isAtEnd ? 'disabled' : ''}>&gt;&gt;</a>`;
  container.innerHTML = firstButton + prevButton + dateLinks + nextButton + lastButton;
}

/**
 * Sets up all event listeners for the page (tooltips, sharing, copy hash).
 * @param {HTMLElement} historyContainer - The main history container element.
 * @param {HTMLElement} tooltip - The tooltip element.
 */
export function setupEventListeners(historyContainer, tooltip) {
  addTooltipEvents(historyContainer, tooltip);

  historyContainer.addEventListener('click', async (e) => {
    // --- Share Button Logic ---
    const shareButton = e.target.closest('.share-btn');
    if (shareButton) {
      const textToShare = shareButton.dataset.text;
      const url = window.location.href;
      const shareData = { title: 'snTnz History Chunk', text: `"${textToShare}"`, url: url };
      if (navigator.share) {
        try { await navigator.share(shareData); } catch (err) { console.error("Share failed:", err.message); }
      } else {
        const fallbackText = `"${textToShare}"\n\nFrom the snTnz project history:\n${url}`;
        await navigator.clipboard.writeText(fallbackText);
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
      const originalText = hashSpan.textContent;
      hashSpan.textContent = 'Copied!';
      setTimeout(() => { hashSpan.textContent = originalText; }, 1500);
    }
  });
}