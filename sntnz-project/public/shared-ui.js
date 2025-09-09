/**
 * shared-ui.js
 * ------------
 * Contains UI functions that are shared across different pages,
 * like the main app and the history page.
 */

/**
 * Adds event listeners to a container to show a tooltip on word click.
 * This function uses event delegation for efficiency.
 * @param {HTMLElement} containerElement - The element to listen for clicks on (e.g., the main text container or history container).
 * @param {HTMLElement} tooltipElement - The tooltip element to show/hide.
 */
export function addTooltipEvents(containerElement, tooltipElement) {
  // --- Initial Check ---
  // Exit early if the required elements don't exist in the DOM.
  if (!containerElement || !tooltipElement) return;

  // --- Listener to SHOW the Tooltip ---
  // We add a single listener to the parent container. This is more efficient
  // than adding a listener to every single word span.
  containerElement.addEventListener('click', (e) => {
    // Find the word that was clicked on, if any.
    const wordSpan = e.target.closest('.word');

    // If a word was indeed clicked...
    if (wordSpan) {
      // --- 1. Extract Data ---
      // Get all the data-* attributes from the clicked element.
      const data = wordSpan.dataset;
      const date = new Date(parseInt(data.ts)); // Convert timestamp string to a Date object.

      // --- 2. Format Date and Time ---
      // Define a consistent format for displaying timestamps.
      const dateFormatOptions = {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false, // Use 24-hour format for clarity.
      };

      // Format the date for both the user's local timezone and UTC.
      // Showing both helps provide context for a global audience.
      const localTimeString = date.toLocaleString(undefined, dateFormatOptions);
      const utcTimeString = date.toLocaleString(undefined, {
        ...dateFormatOptions,
        timeZone: 'UTC',
      });

      // --- 3. Populate Tooltip Content ---
      tooltipElement.innerHTML = '';
      const authorLine = document.createElement('div');
      const authorStrong = document.createElement('strong');
      authorStrong.textContent = 'Author: ';
      authorLine.appendChild(authorStrong);
      authorLine.appendChild(document.createTextNode(data.username)); // Securely append username as text

      const timeLocalLine = document.createElement('div');
      timeLocalLine.innerHTML = `<strong>Time (Local):</strong> ${localTimeString}`; // Safe, not user content

      const timeUtcLine = document.createElement('div');
      timeUtcLine.innerHTML = `<strong>Time (UTC):</strong> ${utcTimeString}`; // Safe, not user content

      const votesLine = document.createElement('div');
      votesLine.innerHTML = `<strong>Votes:</strong> ${data.count} / ${data.total} (${data.pct}%)`; // Safe, not user content

      // Append all lines to the tooltip
      tooltipElement.appendChild(authorLine);
      tooltipElement.appendChild(timeLocalLine);
      tooltipElement.appendChild(timeUtcLine);
      tooltipElement.appendChild(votesLine);

      // --- 4. Calculate Tooltip Position ---
      // Get dimensions and position needed for calculations.
      const tooltipWidth = tooltipElement.offsetWidth;
      const windowWidth = window.innerWidth;
      const margin = 15; // A small margin to keep the tooltip from touching the window edges.

      // Center the tooltip horizontally based on the mouse click position (e.pageX).
      let newLeft = e.pageX - (tooltipWidth / 2);
      // Position the tooltip just below the mouse click position (e.pageY).
      let newTop = e.pageY + margin;

      // --- 5. Perform Boundary Checks ---
      // These checks prevent the tooltip from rendering off-screen.
      // If it's too far left, push it to the right.
      if (newLeft < margin) {
        newLeft = margin;
      }
      // If it's too far right, push it to the left.
      if (newLeft + tooltipWidth > windowWidth - margin) {
        newLeft = windowWidth - tooltipWidth - margin;
      }

      // --- 6. Apply Styles and Show Tooltip ---
      tooltipElement.style.left = `${newLeft}px`;
      tooltipElement.style.top = `${newTop}px`;
      tooltipElement.classList.add('visible');
    }
  });

  // --- Listener to HIDE the Tooltip ---
  // This listener is attached to the entire document.
  document.addEventListener('click', (e) => {
    // If the user clicks anywhere that is NOT a word, hide the tooltip.
    if (!e.target.closest('.word') && tooltipElement) {
      tooltipElement.classList.remove('visible');
    }
  }, true); // The 'true' argument is important!
  // It sets the listener to use the "capture" phase. This means it fires
  // on the way DOWN the DOM tree, before the event reaches the target.
  // This ensures that when you click outside a word, this "hide" logic
  // runs before any other click listener (like our "show" logic) can fire,
  // preventing the tooltip from flickering.
}

/**
 * Creates a custom dropdown of unique contributors, sorted by contribution count,
 * and adds an event listener to highlight their words.
 * @param {HTMLElement} dropdownContainer - The element to add the dropdown into.
 * @param {Array<Object>} wordArray - A flat array of word objects.
 * @param {HTMLElement} textContainer - The container holding all the word spans to be highlighted.
 */
export function renderContributorsDropdown(dropdownContainer, wordArray, textContainer) {
  if (!dropdownContainer || !wordArray || wordArray.length === 0) {
    if (dropdownContainer) dropdownContainer.innerHTML = '';
    return;
  }

  // --- 1. Count contributions for each user ---
  const contributionCounts = new Map();
  wordArray.forEach(word => {
    const username = word.username;
    contributionCounts.set(username, (contributionCounts.get(username) || 0) + 1);
  });

  // --- 2. Get a list of contributors and sort it by contribution count (descending) ---
  const contributors = [...contributionCounts.keys()].sort((a, b) => {
    return contributionCounts.get(b) - contributionCounts.get(a);
  });

  // --- 3. Build the custom dropdown HTML ---
  const downArrowIcon = `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 0 24 24" width="20px" fill="currentColor"><path d="M7 10l5 5 5-5H7z"/></svg>`;

  // Render the static parts of the dropdown
  dropdownContainer.innerHTML = `
    <label>Highlight:</label>
    <div class="contributors-dropdown">
      <button class="contributors-dropdown-btn" aria-haspopup="true" aria-expanded="false">
        <span>None</span>
        ${downArrowIcon}
      </button>
      <div class="contributors-dropdown-content">
        <a href="#" data-username="">None</a>
      </div>
    </div>
  `;

  // Now, securely create and append the contributor links
  const contentContainer = dropdownContainer.querySelector('.contributors-dropdown-content');

  contributors.forEach(name => {
      const count = contributionCounts.get(name);
      const link = document.createElement('a');
      link.href = '#';
      link.dataset.username = name;
      link.textContent = `${name} (${count})`; // <-- The secure part
      contentContainer.appendChild(link);
  });

  // --- 4. Add event listeners (no changes needed here) ---
  const dropdown = dropdownContainer.querySelector('.contributors-dropdown');
  const btn = dropdown.querySelector('.contributors-dropdown-btn');
  const content = dropdown.querySelector('.contributors-dropdown-content');
  const btnText = btn.querySelector('span');

  // Toggle dropdown visibility
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isExpanded = content.classList.toggle('show-dropdown');
    btn.setAttribute('aria-expanded', isExpanded);
  });

  // Handle clicks on contributor names
  content.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      e.preventDefault();
      const selectedUsername = e.target.dataset.username;

      // Update button text to show only the name, not the count
      btnText.textContent = selectedUsername ? selectedUsername : 'None';

      // First, remove any existing highlights
      const highlightedWords = textContainer.querySelectorAll('.word.highlighted-word');
      highlightedWords.forEach(word => word.classList.remove('highlighted-word'));

      // If a specific user is selected, find and highlight their words
      if (selectedUsername) {
        const wordsToHighlight = textContainer.querySelectorAll(`.word[data-username="${selectedUsername}"]`);
        wordsToHighlight.forEach(word => word.classList.add('highlighted-word'));
      }

      // Hide the dropdown after selection
      content.classList.remove('show-dropdown');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // Close dropdown if clicking outside
  window.addEventListener('click', () => {
    if (content.classList.contains('show-dropdown')) {
      content.classList.remove('show-dropdown');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

/**
 * Starts a countdown timer in a given element until the next scheduled seal.
 * @param {HTMLElement} element - The element to display the countdown in.
 * @param {string} cronSchedule - The cron schedule string
 */
export function startSealCountdown(element, cronSchedule) {
  let countdownInterval;

  function calculateNextSealDate() {
    const parts = cronSchedule.split(' ');
    const minutePart = parts[0];
    const hourPart = parts[1];
    const now = new Date();

    const nextSealDate = new Date();
    nextSealDate.setSeconds(0, 0); // Reset seconds and milliseconds for clean countdowns

    // Case 1: "Every X minutes" schedule (e.g., '*/5 * * * *')
    if (minutePart.startsWith('*/')) {
      const interval = parseInt(minutePart.substring(2), 10);
      const currentMinutes = now.getMinutes();
      const remainder = currentMinutes % interval;
      const minutesToAdd = interval - remainder;

      // Add the remaining minutes to the current time
      nextSealDate.setMinutes(now.getMinutes() + minutesToAdd);
      return nextSealDate;
    }

    // Case 2: Specific hours schedule (e.g., '0 8,16,0 * * *')
    if (hourPart !== '*' && !hourPart.includes('/')) {
        const scheduledMinute = parseInt(minutePart, 10);
        const scheduledHours = hourPart.split(',').map(h => parseInt(h, 10)).sort((a, b) => a - b);

        let nextHour = scheduledHours.find(h => h > now.getHours() || (h === now.getHours() && scheduledMinute > now.getMinutes()));

        if (nextHour !== undefined) {
            // Next seal is later today
            nextSealDate.setHours(nextHour, scheduledMinute);
        } else {
            // Next seal is tomorrow at the first scheduled hour
            nextSealDate.setDate(now.getDate() + 1);
            nextSealDate.setHours(scheduledHours[0], scheduledMinute);
        }
        return nextSealDate;
    }

    // Fallback for unsupported cron formats
    return null;
  }

  function updateTimer() {
    const nextSealTime = calculateNextSealDate();

    if (!nextSealTime) {
      element.textContent = "Invalid schedule";
      clearInterval(countdownInterval);
      return;
    }

    const distance = nextSealTime - new Date().getTime();

    if (distance <= 0) {
      // It's time to seal, or the time has just passed.
      // Refresh the page in 5 seconds to show the newly sealed chunk.
      element.textContent = "Sealing now! Refreshing soon...";
      clearInterval(countdownInterval);
      setTimeout(() => window.location.reload(), 5000);
      return;
    }

    const hours = Math.floor(distance / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    const pad = (num) => String(num).padStart(2, '0');
    element.textContent = `Next seal in: ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  updateTimer(); // Run once immediately
  countdownInterval = setInterval(updateTimer, 1000);
}

/**
 * Creates a throttled version of a function that only runs at most once
 * every `delay` milliseconds.
 * @param {Function} func - The function to throttle.
 * @param {number} delay - The throttle delay in milliseconds.
 * @returns {Function} The new throttled function.
 */
export function throttle(func, delay) {
  let inProgress = false;
  return function(...args) {
    if (inProgress) {
      return; // If a function is already in progress, do nothing.
    }
    inProgress = true;
    setTimeout(() => {
      func.apply(this, args);
      inProgress = false; // Reset the flag after the delay.
    }, delay);
  };
}
