/**
 * history.js
 * ----------
 * Main logic for the history page.
 * Fetches data from the API and uses the history-ui module to render the page.
 */

import * as ui from './history-ui.js';
import { addImageModalEvents } from './shared-ui.js';

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
      // 1. Fetch application configuration and all available dates for pagination
      const configResponse = await fetch('/config');
      const CFG = await configResponse.json();
      const cronSchedule = CFG.HISTORY_CHAPTER_SCHEDULE_CRON;
      const allDates = await (await fetch('/api/history/dates')).json();

      // 2. Determine which data to fetch based on the URL
      const urlParams = new URLSearchParams(window.location.search);
      const requestedDate = urlParams.get('date');
      let chapters, targetDate;

      if (requestedDate) {
        // Case A: A specific date is in the URL, so we fetch it directly.
        targetDate = requestedDate;
        const historyRes = await fetch(`/api/history/${targetDate}`, { cache: 'no-store' });
        if (!historyRes.ok) throw new Error(`Could not load history for ${targetDate}.`);
        chapters = await historyRes.json();
      } else {
        // Case B: No date is in the URL. We ask the server for the "latest" content.
        // This avoids timezone and clock-drift issues.
        const latestRes = await fetch(`/api/history/latest`, { cache: 'no-store' });
        if (!latestRes.ok) throw new Error('Could not load latest history.');
        const latestData = await latestRes.json();

        chapters = latestData.chapters;
        targetDate = latestData.date; // Use the date the server told us is "today"

        // Update the browser's URL to include the specific date without reloading the page.
        // This makes the state clean and allows for bookmarking or refreshing.
        const newUrl = `${window.location.pathname}?date=${targetDate}`;
        history.pushState({ path: newUrl }, '', newUrl);
      }

      // 3. Process the fetched data
      if (!chapters || (Array.isArray(chapters) && chapters.length === 0)) {
        throw new Error('No history is available for this day.');
      }
      const allWords = chapters.flatMap(chapter => chapter.words || []);

      // 4. Find the timestamp of the very last word on the page (for live updates)
      if (allWords.length > 0) {
        lastWordTimestamp = allWords[allWords.length - 1].ts;
      }

      // 5. Preserve the user's scroll position before re-rendering
      const scrollPosition = window.scrollY;

      // 6. Use the UI module to render all page components
      ui.renderHistory(historyContainer, chapters, cronSchedule);
      ui.renderContributorsDropdown(contributorsContainer, allWords, historyContainer);
      ui.renderPagination(paginationContainer, allDates, targetDate);

      // 7. Restore the user's scroll position
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

  // 3. Set up event listeners for the new image modal.
  addImageModalEvents(historyContainer, imageModal, fullSizeImage);

  // 4. Checks if the URL has a hash (e.g., #a1b2c3d4g...) and scrolls to it.
  if (window.location.hash) {
    // Use a short timeout to ensure the DOM has fully rendered.
    setTimeout(() => {
      const chapterId = window.location.hash.substring(1); // Remove the '#'
      const targetChapter = document.getElementById(chapterId);

      if (targetChapter) {
        // Scroll the element into the middle of the viewport.
        targetChapter.scrollIntoView({
          behavior: 'smooth',
          block: 'center'
        });

        // Add a temporary highlight to make it obvious.
        targetChapter.style.backgroundColor = 'var(--color-user-highlight)';
        setTimeout(() => {
          targetChapter.style.backgroundColor = ''; // Remove highlight after 3 seconds
        }, 3000);
      }
    }, 500);
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
      ui.appendWordToLiveChapter(latestWord);
      lastWordTimestamp = latestWord.ts; // Update our tracker to prevent duplicates.
    }
  });

  // 7. Listen for newly sealed chapters and refresh the page data
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