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

  if (!historyContainer || !tooltip || !paginationContainer) {
    console.error('A required DOM element is missing.');
    return;
  }

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
    const targetDate = allDates.includes(requestedDate) ? requestedDate : allDates[0];
    const subheader = document.querySelector('.history-subheader');
    if (subheader) subheader.textContent += ` (${targetDate})`;

    // 3. Fetch the history data for the target date
    const historyRes = await fetch(`/api/history/${targetDate}`, { cache: 'no-store' });
    if (!historyRes.ok) {
      throw new Error(`Could not load history for ${targetDate}.`);
    }
    const chunks = await historyRes.json();

    // 4. Use the UI module to render the page content
    ui.renderHistory(historyContainer, chunks);
    ui.renderPagination(paginationContainer, allDates, targetDate);
    ui.setupEventListeners(historyContainer, tooltip);

  } catch (error) {
    historyContainer.innerHTML = `<p class="history-error">${error.message}</p>`;
  }
})();
