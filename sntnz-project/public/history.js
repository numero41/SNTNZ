/**
 * history.js
 * ----------
 * This script fetches and renders the full text history for a specific day.
 * - It determines which day to show from the URL (?date=YYYY-MM-DD).
 * - It defaults to the most recent day if no date is specified.
 * - It groups words into blocks based on the story's "cycle" length.
 * - It makes each word clickable to show statistics in a tooltip.
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

    // 3. Fetch the config and the history data for the target date
    const [config, historyRes] = await Promise.all([
      fetch('/config').then(res => res.json()),
      fetch(`/api/history/${targetDate}`, { cache: 'no-store' })
    ]);
    if (!historyRes.ok) {
      throw new Error(`Could not load history for ${targetDate}.`);
    }

    const text = await historyRes.text();
    const lines = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

    // 4. Render the page content
    renderHistory(lines, config);
    renderPagination(allDates, targetDate);
    setupTooltip();

  } catch (error) {
    historyContainer.innerHTML = `<p class="history-error">${error.message}</p>`;
  }

  /**
   * Renders the complete history content for a given day.
   * @param {Array<Object>} lines - The array of word data objects from the NDJSON file.
   * @param {Object} config - The application configuration object.
   */
  function renderHistory(lines, config) {
    let wordBuffer = [];

    lines.forEach((line, index) => {
      // A new block starts every CURRENT_TEXT_LENGTH words
      const isNewBlock = index % config.CURRENT_TEXT_LENGTH === 0;

      if (isNewBlock && wordBuffer.length > 0) {
        renderTextBlock(wordBuffer);
        wordBuffer = []; // Reset the buffer for the next block
      }

      // Add a time marker at the beginning of each new block
      if (isNewBlock) {
        const date = new Date(line.ts);
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        const timeMarker = document.createElement('div');
        timeMarker.className = 'history-time-marker';
        timeMarker.innerHTML = `<div class="history-gutter">${hh}:${mm}</div>`;
        historyContainer.appendChild(timeMarker);
      }

      wordBuffer.push(line);
    });

    // Render the final block if any words are left in the buffer
    if (wordBuffer.length > 0) {
      renderTextBlock(wordBuffer);
    }
  }

  /**
   * Renders a single block of text.
   * @param {Array<Object>} wordArray - An array of word objects for this block.
   */
  function renderTextBlock(wordArray) {
    const blockEl = document.createElement('div');
    blockEl.className = 'history-row';

    // Create a styled, clickable span for each word
    const textContent = wordArray.map(wordData => {
      const styleOpen = `${wordData.styles.bold ? '<b>':''}${wordData.styles.italic ? '<i>':''}${wordData.styles.underline ? '<u>':''}`;
      const styleClose = `${wordData.styles.underline ? '</u>':''}${wordData.styles.italic ? '</i>':''}${wordData.styles.bold ? '</b>':''}`;

      return `<span class="word"
        data-ts="${wordData.ts}"
        data-pct="${wordData.pct}"
        data-count="${wordData.count}"
        data-total="${wordData.total}">
          ${styleOpen}${wordData.word}${styleClose}
      </span>`;
    }).join(' ');

    blockEl.innerHTML = `
      <div class="history-gutter"></div>
      <div class="history-text-block">${textContent}</div>
    `;
    historyContainer.appendChild(blockEl);
  }

  /**
   * Renders the pagination links at the bottom of the page.
   * Displays a "sliding window" of 3 dates and navigation arrows.
   * @param {Array<string>} dates - A sorted list of all available dates (oldest to newest).
   * @param {string} currentDate - The date currently being viewed.
   */
  function renderPagination(dates, currentDate) {
    // If there are 3 or fewer dates, just show them all without complex navigation.
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

    // --- Calculate which 3 dates to show in the window ---
    // Try to center the current date, but don't go out of bounds.
    let start = Math.max(0, currentIndex - Math.floor(windowSize / 2));
    start = Math.min(start, dates.length - windowSize); // Ensure the window doesn't overflow at the end.

    const datesToShow = dates.slice(start, start + windowSize);

    // --- Create Navigation Button Links ---
    const firstLink = dates[0];
    const prevLink = dates[Math.max(0, currentIndex - 1)];
    const nextLink = dates[Math.min(dates.length - 1, currentIndex + 1)];
    const lastLink = dates[dates.length - 1];

    // Determine if the << < or > >> buttons should be disabled.
    const isAtStart = currentIndex === 0;
    const isAtEnd = currentIndex === dates.length - 1;

    // --- Generate the final HTML for the navigation ---
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
   * Sets up event listeners for the word tooltip.
   * Uses event delegation for efficiency.
   */
  function setupTooltip() {
    // Show tooltip on word click
    historyContainer.addEventListener('click', (e) => {
      const wordSpan = e.target.closest('.word'); // Use closest to handle clicks on <b> etc.
      if (wordSpan) {
        const data = wordSpan.dataset;
        const date = new Date(parseInt(data.ts));

        tooltip.innerHTML = `
          <strong>Time:</strong> ${date.toLocaleTimeString()}<br>
          <strong>Votes:</strong> ${data.count} / ${data.total} (${data.pct}%)
        `;

        tooltip.style.left = `${e.pageX + 10}px`;
        tooltip.style.top = `${e.pageY + 10}px`;
        tooltip.classList.add('visible');
      }
    });

    // Hide tooltip on any other click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.word')) {
        tooltip.classList.remove('visible');
      }
    }, true); // Use capture phase to ensure this runs first
  }

})();