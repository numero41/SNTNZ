// FILE: test-mailer.js
// Purpose: A standalone script to test the email notification service.

// 1. Load environment variables from your .env file
require('dotenv').config();

// 2. Import the notifyError function from your mailer module
//    Make sure this script is in the same directory as mailer.js
const { notifyError, flushNow } = require('./mailer.js');


// --- Test Execution ---

console.log('--- [Mailer Test Script] ---');

// Check if essential variables are loaded
if (!process.env.ALERT_EMAIL_TO || !process.env.SMTP_HOST) {
  console.error('[ERROR] Essential environment variables (ALERT_EMAIL_TO, SMTP_HOST) are missing.');
  console.error('Please check your .env file.');
  process.exit(1); // Exit the script with an error code
}

console.log(`Attempting to send a test email...`);
console.log(`  -> Recipient: ${process.env.ALERT_EMAIL_TO}`);
console.log(`  -> From:      ${process.env.ALERT_EMAIL_FROM}`);
console.log(`  -> SMTP Host: ${process.env.SMTP_HOST}`);

// 3. Define a sample error message
const testErrorMessage = `✅ This is a test alert from test-mailer.js, sent at: ${new Date().toISOString()}. \n\nIf you received this, your email configuration is working correctly.`;

// 4. Call the function to trigger the email
notifyError(testErrorMessage);

// 5. Immediately flush the queue for testing purposes
//    This overrides the 5-minute throttle so the email sends right away.
flushNow();

console.log('\nTest email has been sent.');
console.log('Please check your inbox (and spam folder) for the test message.');
console.log('--- [Test Complete] ---');