/**
 * history.js
 * ----------
 * Main logic for the history page.
 * Fetches data from the API and uses the history-ui module to render the page.
 */

import * as ui from './history-ui.js';
let currentDayHistory = [];

(async function() {
  // --- DOM Element References ---
  const historyContainer = document.getElementById('historyContainer');
  const tooltip = document.getElementById('wordTooltip');
  const paginationContainer = document.getElementById('paginationContainer');
  const contributorsContainer = document.getElementById('contributorsContainer');

  if (!historyContainer || !tooltip || !paginationContainer) {
    console.error('A required DOM element is missing.');
    return;
  }

  // Helper to get today's date in YYYY-MM-DD format
  const getTodayDateString = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // --- Main Application Logic ---
  try {
    // 1. Fetch all available dates
    const allDates = await (await fetch('/api/history/dates')).json();
    if (!allDates || allDates.length === 0) {
      throw new Error('No history is available yet.');
    }

    // 2. Determine the target date
    const urlParams = new URLSearchParams(window.location.search);
    const requestedDate = urlParams.get('date');
    const todayDate = getTodayDateString();
    let targetDate;

    if (requestedDate && allDates.includes(requestedDate)) {
      // If a valid date is in the URL, use it
      targetDate = requestedDate;
    } else if (allDates.includes(todayDate)) {
      // Otherwise, if history for today exists, use today's date
      targetDate = todayDate;
    } else {
      // Fallback to the most recent date available
      targetDate = allDates[0];
    }

    // 3. Fetch the history data for the target date
    const historyRes = await fetch(`/api/history/${targetDate}`, { cache: 'no-store' });
    if (!historyRes.ok) {
      throw new Error(`Could not load history for ${targetDate}.`);
    }
    const chunks = await historyRes.json();
    const allWords = chunks.flatMap(chunk => chunk.words || []);

    // 4. Use the UI module to render the page content
    ui.renderHistory(historyContainer, chunks);
    ui.renderContributorsDropdown(contributorsContainer, allWords, historyContainer);
    ui.renderPagination(paginationContainer, allDates, targetDate);
    ui.setupEventListeners(historyContainer, tooltip);

  } catch (error) {
    historyContainer.innerHTML = `<p class="history-error">${error.message}</p>`;
  }
})();