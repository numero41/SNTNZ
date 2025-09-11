/**
 * history.js
 * ----------
 * Main logic for the history page.
 * Fetches data from the API and uses the history-ui module to render the page.
 */

import * as ui from './history-ui.js';

(async function() {
  // --- DOM Element References ---
  const historyContainer = document.getElementById('historyContainer');
  const tooltip = document.getElementById('wordTooltip');
  const paginationContainer = document.getElementById('paginationContainer');
  const contributorsContainer = document.getElementById('contributorsContainer');
  const imageModal = document.getElementById('imageModal');
  const fullSizeImage = document.getElementById('fullSizeImage');
  let lastWordTimestamp = 0;

  if (!historyContainer || !tooltip || !paginationContainer || !imageModal) {
    console.error('A required DOM element is missing.');
    return;
  }

  /**
   * Fetches the latest data from the API and re-renders the entire page content.
   * This function is called on initial load and then periodically by the poller.
   */
  async function fetchAndRenderHistory() {
    try {
      // 1. Fetch the application configuration (which includes the cron schedule)
      const configResponse = await fetch('/config');
      const CFG = await configResponse.json();
      const cronSchedule = CFG.HISTORY_CHUNK_SCHEDULE_CRON;

      // 2. Fetch all available dates for pagination
      const allDates = await (await fetch('/api/history/dates')).json();
      if (!allDates || allDates.length === 0) {
        // Keep this check for the case where there is no history at all.
        throw new Error('No history is available yet.');
      }

      // 3. Determine the target date
      const urlParams = new URLSearchParams(window.location.search);
      let targetDate = urlParams.get('date');

      // If no date is in the URL, default to the current UTC date.
      // This is the key change to ensure we request the correct "today".
      if (!targetDate) {
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        targetDate = `${year}-${month}-${day}`;
      }

      // 4. Fetch the history data for the target date
      const historyRes = await fetch(`/api/history/${targetDate}`, { cache: 'no-store' });
      if (!historyRes.ok) {
        throw new Error(`Could not load history for ${targetDate}.`);
      }
      const chunks = await historyRes.json();
      const allWords = chunks.flatMap(chunk => chunk.words || []);

      // 5. Find the timestamp of the very last word on the page.
      if (allWords.length > 0) {
        lastWordTimestamp = allWords[allWords.length - 1].ts;
      }

      // Preserve scroll position...
      const scrollPosition = window.scrollY;

      // 6. Use the UI module to render the page content (no change here)
      ui.renderHistory(historyContainer, chunks, cronSchedule);
      ui.renderContributorsDropdown(contributorsContainer, allWords, historyContainer);
      ui.renderPagination(paginationContainer, allDates, targetDate);

      // Restore the user's scroll position
      window.scrollTo(0, scrollPosition);

    } catch (error) {
      historyContainer.innerHTML = `<p class="history-error">${error.message}</p>`;
    }
  }

  // --- Initial Load, Listeners & Polling ---

  // 1. Load the initial data.
  await fetchAndRenderHistory();

  // 2. Set up event listeners for tooltips and sharing (from history-ui.js).
  ui.setupEventListeners(historyContainer, tooltip);

  // 3. Checks if the URL has a hash (e.g., #a1b2c3d4g...) and scrolls to it.
  if (window.location.hash) {
    // Use a short timeout to ensure the DOM has fully rendered.
    setTimeout(() => {
      const chunkId = window.location.hash.substring(1); // Remove the '#'
      const targetChunk = document.getElementById(chunkId);

      if (targetChunk) {
        // Scroll the element into the middle of the viewport.
        targetChunk.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });

        // Add a temporary highlight to make it obvious.
        targetChunk.style.backgroundColor = 'var(--color-user-highlight)';
        setTimeout(() => {
          targetChunk.style.backgroundColor = ''; // Remove highlight after 3 seconds
        }, 3000);
      }
    }, 500);
  }

  // 4. Add event listeners for the new image modal.
  if (imageModal) {
    const overlay = imageModal.querySelector('.modal-overlay');
    const closeBtn = imageModal.querySelector('.modal-close');
    const fullResBtn = imageModal.querySelector('#fullResBtn');

    // Open modal on image click
    historyContainer.addEventListener('click', (e) => {
      const clickedImage = e.target.closest('.chunk-image');
      if (clickedImage) {
        const imgSrc = clickedImage.src;
        fullSizeImage.src = imgSrc;
        fullResBtn.href = imgSrc;
        imageModal.classList.add('visible');
      }
    });

    // Close modal listeners
    closeBtn.addEventListener('click', () => imageModal.classList.remove('visible'));
    overlay.addEventListener('click', () => imageModal.classList.remove('visible'));
  }

  // 5. Connect to the WebSocket server
  const socket = io({ transports: ['websocket'] });

  socket.on('connect', () => {
    socket.emit('joinHistoryRoom');
  });

  // 6. Listen for live updates
  socket.on('currentTextUpdated', (newCurrentText) => {
    // The server sends an array of recent words. The newest is always the last one.
    if (!Array.isArray(newCurrentText) || newCurrentText.length === 0) {
      return;
    }
    const latestWord = newCurrentText[newCurrentText.length - 1];

    // If the latest word is newer than the last one we've shown, append it.
    if (latestWord && latestWord.ts > lastWordTimestamp) {
      ui.appendWordToLiveChunk(latestWord);
      lastWordTimestamp = latestWord.ts; // Update our tracker to prevent duplicates.
    }
  });

  // 7. Listen for newly sealed chunks and refresh the page data
  socket.on('newImageSealed', () => {
    // Check if the user is currently viewing today's date.
    const urlParams = new URLSearchParams(window.location.search);
    const requestedDate = urlParams.get('date');
    const todayDate = new Date().toISOString().split('T')[0];

    // Only refresh if the user is on the main history page (no date) or today's date.
    if (!requestedDate || requestedDate === todayDate) {
      // Re-run the main fetch function to get the latest data without a full page reload.
      fetchAndRenderHistory();
    }
  });
})();