/**
 * username-ui.js
 * --------------
 * Handles all DOM logic for the username selection page.
 */

(function() {
  const usernameForm = document.getElementById('usernameForm');
  const usernameInput = document.getElementById('usernameInput');
  const feedbackMessage = document.getElementById('feedbackMessage');
  let feedbackTimeout;

  if (!usernameForm) return;

  function showFeedback(message) {
    if (!feedbackMessage) return;
    feedbackMessage.textContent = message;
    feedbackMessage.classList.add('visible');
    clearTimeout(feedbackTimeout);
    feedbackTimeout = setTimeout(() => {
      feedbackMessage.classList.remove('visible');
    }, 3000);
  }

  usernameForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = usernameInput.value.trim();

    if (!username) {
      showFeedback("Username cannot be empty.");
      return;
    }

    try {
      const response = await fetch('/api/username', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const result = await response.json();

      if (response.ok) {
        showFeedback('Username saved! Redirecting...');
        setTimeout(() => { window.location.href = '/'; }, 1500);
      } else {
        showFeedback(result.message || 'An unknown error occurred.');
      }
    } catch (error) {
      console.error('Failed to set username:', error);
      showFeedback('A network error occurred. Please try again.');
    }
  });
})();