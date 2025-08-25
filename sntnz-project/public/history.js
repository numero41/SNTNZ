/**
 * history.js
 * ----------
 * This script fetches and renders pre-chunked history for a specific day.
 * - It determines the day to show from the URL (?date=YYYY-MM-DD).
 * - It renders each chunk with its timestamp, hash, and social share buttons.
 * - It makes individual words in the text clickable to show stats.
 * - It generates pagination links to navigate between available dates.
 */
(async function() {
  // --- DOM Element References ---
  const historyContainer = document.getElementById('historyContainer');
  const tooltip = document.getElementById('wordTooltip');
  const paginationContainer = document.getElementById('paginationContainer');

  if (!historyContainer || !tooltip || !paginationContainer) {
    console.error('A required DOM element is missing.');
    return;
  }

  // --- Main Application Logic ---
  try {
    // 1. Fetch all available dates to determine which date to load
    const allDates = await (await fetch('/api/history/dates')).json();
    if (!allDates || allDates.length === 0) {
      throw new Error('No history is available yet.');
    }

    // 2. Determine the target date from the URL or default to the latest
    const urlParams = new URLSearchParams(window.location.search);
    const requestedDate = urlParams.get('date');
    const targetDate = allDates.includes(requestedDate) ? requestedDate : allDates[0];
    const subheader = document.querySelector('.history-subheader');
    if (subheader) subheader.textContent += ` (${targetDate})`;

    // 3. Fetch the history data (now an array of chunks) for the target date
    const historyRes = await fetch(`/api/history/${targetDate}`, { cache: 'no-store' });
    if (!historyRes.ok) {
      throw new Error(`Could not load history for ${targetDate}.`);
    }
    const chunks = await historyRes.json();

    // 4. Render the page content
    renderHistory(chunks);
    renderPagination(allDates, targetDate);
    setupEventListeners();

  } catch (error) {
    historyContainer.innerHTML = `<p class="history-error">${error.message}</p>`;
  }

  /**
   * renderHistory
   * -------------
   * Renders the complete history by iterating through server-generated chunks.
   * @param {Array<Object>} chunks - The array of chunk data objects.
   */
  function renderHistory(chunks) {
    if (!chunks || chunks.length === 0) {
      historyContainer.innerHTML = `<p class="history-error">No history found for this day.</p>`;
      return;
    }
    // Create a document fragment for efficient DOM manipulation
    const fragment = document.createDocumentFragment();
    chunks.forEach(chunk => {
      const chunkElement = createChunkElement(chunk);
      if (chunkElement) { // Add this check
        fragment.appendChild(chunkElement);
      }
    });
    historyContainer.appendChild(fragment);
  }

  /**
   * createChunkElement
   * ------------------
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
   * renderPagination
   * ----------------
   * Renders the pagination links at the bottom of the page.
   * (This function remains unchanged from your original file)
   */
  function renderPagination(dates, currentDate) {
     if (dates.length <= 3) {
      const linksHtml = dates.map(date => {
        const isCurrent = date === currentDate;
        return `<a href="?date=${date}" class="${isCurrent ? 'current' : ''}">${date}</a>`;
      }).join('');
      paginationContainer.innerHTML = linksHtml;
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
    const dateLinks = datesToShow.map(date => {
      const isCurrent = date === currentDate;
      return `<a href="?date=${date}" class="${isCurrent ? 'current' : ''}">${date}</a>`;
    }).join('');
    const nextButton = `<a href="?date=${nextLink}" class="nav-arrow" ${isAtEnd ? 'disabled' : ''}>&gt;</a>`;
    const lastButton = `<a href="?date=${lastLink}" class="nav-arrow" ${isAtEnd ? 'disabled' : ''}>&gt;&gt;</a>`;
    paginationContainer.innerHTML = firstButton + prevButton + dateLinks + nextButton + lastButton;
  }

  /**
   * setupEventListeners
   * -------------------
   * Sets up all event listeners for the page (tooltips, sharing, copy hash).
   */
  function setupEventListeners() {
    historyContainer.addEventListener('click', async (e) => {
      // --- Word Tooltip Logic ---
      const wordSpan = e.target.closest('.word');
      if (wordSpan) {
        const data = wordSpan.dataset;
        const date = new Date(parseInt(data.ts));

        // Format date and time separately
        const dateString = date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        const timeString = date.toLocaleTimeString();

        // 1. Populate the tooltip's content
        tooltip.innerHTML = `
          <strong>Author:</strong> ${data.username}<br>
          <strong>Date:</strong> ${dateString}<br>
          <strong>Time:</strong> ${timeString}<br>
          <strong>Votes:</strong> ${data.count} / ${data.total} (${data.pct}%)
        `;

        // 2. Get dimensions
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;
        const windowWidth = window.innerWidth;
        const margin = 15;

        // 3. Positioning logic
        let newLeft = e.pageX - (tooltipWidth / 2);
        let newTop = e.pageY + margin;

        if (newLeft < margin) {
          newLeft = margin;
        }
        if (newLeft + tooltipWidth > windowWidth - margin) {
          newLeft = windowWidth - tooltipWidth - margin;
        }

        // 4. Apply final position and make visible
        tooltip.style.left = `${newLeft}px`;
        tooltip.style.top = `${newTop}px`;
        tooltip.classList.add('visible');
        return;
      }

      // --- Share Button Logic (IMPROVED) ---
      const shareButton = e.target.closest('.share-btn');
      if (shareButton) {
        const textToShare = shareButton.dataset.text;
        const url = window.location.href;
        const shareData = {
          title: 'snTnz History Chunk',
          text: `"${textToShare}"`,
          url: url,
        };

        if (navigator.share) {
          // Use the modern Web Share API on supported devices (mobile)
          try {
            await navigator.share(shareData);
          } catch (err) {
            console.error("Share failed:", err.message);
          }
        } else {
          // Fallback for desktop: copy text to clipboard and give feedback.
          const fallbackText = `"${textToShare}"\n\nFrom the snTnz project history:\n${url}`;
          await navigator.clipboard.writeText(fallbackText);

          // Visual feedback
          const originalButtonText = shareButton.innerHTML;
          shareButton.innerHTML = 'Copied!';
          setTimeout(() => { shareButton.innerHTML = originalButtonText; }, 2000);
        }
        return;
      }

      // --- Copy Hash Logic (remains the same) ---
      const hashSpan = e.target.closest('.chunk-hash');
      if (hashSpan) {
        // ... (your existing copy hash logic is correct)
        const fullHash = hashSpan.dataset.hash;
        await navigator.clipboard.writeText(fullHash);
        const originalText = hashSpan.textContent;
        hashSpan.textContent = 'Copied!';
        setTimeout(() => { hashSpan.textContent = originalText; }, 1500);
      }
    });

    // --- Hide Tooltip Logic (remains the same) ---
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.word')) {
        tooltip.classList.remove('visible');
      }
    }, true);
  }

})();