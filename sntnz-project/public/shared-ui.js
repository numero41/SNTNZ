/**
 * shared-ui.js
 * ------------
 * Contains UI functions that are shared across different pages,
 * like the main app and the history page.
 */

/**
 * shared-ui.js
 * ------------
 * Contains UI functions that are shared across different pages,
 * like the main app and the history page.
 */

/**
 * Adds event listeners to a container to show a tooltip on word click.
 * @param {HTMLElement} containerElement - The element to listen for clicks on (e.g., historyContainer).
 * @param {HTMLElement} tooltipElement - The tooltip element to show/hide.
 */
export function addTooltipEvents(containerElement, tooltipElement) {
  if (!containerElement || !tooltipElement) return;

  // Show tooltip on word click
  containerElement.addEventListener('click', (e) => {
    const wordSpan = e.target.closest('.word');
    if (wordSpan) {
      const data = wordSpan.dataset;
      const date = new Date(parseInt(data.ts));

      // Define a shorter, consistent date/time format
      const dateFormatOptions = {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false, // Use 24-hour format
      };

      // Format both dates using the same options
      const localTimeString = date.toLocaleString(undefined, dateFormatOptions);
      const utcTimeString = date.toLocaleString(undefined, {
        ...dateFormatOptions,
        timeZone: 'UTC',
      });

      tooltipElement.innerHTML = `
        <strong>Author:</strong> ${data.username}<br>
        <strong>Time (Local):</strong> ${localTimeString}<br>
        <strong>Time (UTC):</strong> ${utcTimeString}<br>
        <strong>Votes:</strong> ${data.count} / ${data.total} (${data.pct}%)
      `;

      const tooltipWidth = tooltipElement.offsetWidth;
      const windowWidth = window.innerWidth;
      const margin = 15;
      let newLeft = e.pageX - (tooltipWidth / 2);
      let newTop = e.pageY + margin;

      if (newLeft < margin) newLeft = margin;
      if (newLeft + tooltipWidth > windowWidth - margin) {
        newLeft = windowWidth - tooltipWidth - margin;
      }

      tooltipElement.style.left = `${newLeft}px`;
      tooltipElement.style.top = `${newTop}px`;
      tooltipElement.classList.add('visible');
    }
  });

  // Hide tooltip when clicking anywhere else
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.word') && tooltipElement) {
      tooltipElement.classList.remove('visible');
    }
  }, true);
}