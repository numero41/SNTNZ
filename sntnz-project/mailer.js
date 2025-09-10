/**
 * @file mailer.js
 * @description
 * Minimal, dependency-light email notifier for server errors.
 *
 * HOW IT WORKS
 *  - Collects error lines in a small in-memory buffer.
 *  - Sends a single email at most once per ALERT_MIN_INTERVAL_SEC (default: 300s).
 *  - Never throws: failures to send are swallowed so the app never crashes.
 *
 * USAGE
 *  - Import { notifyError, flushNow }.
 *  - Call notifyError("short text line about the error").
 *  - Optionally call flushNow() on process shutdown to send any remaining buffered errors.
 *
 * REQUIRED ENV
 *  - ALERT_EMAIL_FROM: sender address (e.g., no-reply@sntnz.com)
 *  - ALERT_EMAIL_TO:   recipient address (your inbox)
 *  - SMTP_HOST:        SMTP server host (e.g., smtp.sendgrid.net)
 *  - SMTP_PORT:        SMTP server port (e.g., 587)
 *  - SMTP_USER:        SMTP username (SendGrid uses "apikey")
 *  - SMTP_PASS:        SMTP password (SendGrid API key)
 *
 * OPTIONAL ENV
 *  - ALERT_MIN_INTERVAL_SEC: throttle window in seconds (default: 300)
 *  - RENDER_SERVICE_NAME:    used in email subject for quick identification
 *  - NODE_ENV:               appended to subject (e.g., production)
 */

const nodemailer = require('nodemailer');
const os = require('os');

const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  ALERT_EMAIL_FROM,
  ALERT_EMAIL_TO,
  ALERT_MIN_INTERVAL_SEC = '300',
  RENDER_SERVICE_NAME,
  NODE_ENV,
} = process.env;

/** Create a single reusable SMTP transporter. */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: false, // STARTTLS on port 587
  auth: (SMTP_USER && SMTP_PASS) ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

let buffer = [];          // collects short error lines
let timer = null;         // throttle timer handle
const minIntervalMs = Math.max(0, Number(ALERT_MIN_INTERVAL_SEC) * 1000) || 300_000;

/**
 * Build a compact subject line: "[service][env] N error(s)".
 * Keeps inbox tidy and searchable.
 */
function buildSubject(count) {
  const service = RENDER_SERVICE_NAME || 'app';
  const env = NODE_ENV || 'dev';
  return `[${service}][${env}] ${count} error(s)`;
}

/**
 * Sends a single email containing all buffered error lines, then clears the buffer.
 * This is called automatically by the throttle, but you can also call it on shutdown.
 * Never throws; any failure is swallowed (logged to console at most).
 */
async function flushNow() {
  if (!buffer.length) return;
  const lines = buffer;
  buffer = [];
  timer = null;

  // Safety: if not configured, skip silently.
  if (!ALERT_EMAIL_FROM || !ALERT_EMAIL_TO || !SMTP_HOST) return;

  const subject = buildSubject(lines.length);
  const text = [
    `Host: ${os.hostname()}`,
    `Time: ${new Date().toISOString()}`,
    '',
    lines.join('\n\n---\n\n'),
  ].join('\n');

  try {
    await transporter.sendMail({
      from: ALERT_EMAIL_FROM,
      to: ALERT_EMAIL_TO,
      subject,
      text,
    });
  } catch (_err) {
    // Do not crash the app if email fails; keep it silent or console.warn if you prefer.
    // console.warn('Error sending alert email:', _err);
  }
}

/**
 * Push a single short error line into the buffer and arm the throttle timer if needed.
 * Input is expected to be a small string (we truncate to 4000 chars for safety).
 * This function is intentionally cheap and fire-and-forget.
 *
 * @param {string} line - A concise textual description of the error (e.g., msg + stack top).
 */
function notifyError(line) {
  // Skip entirely if not configured.
  if (!ALERT_EMAIL_FROM || !ALERT_EMAIL_TO || !SMTP_HOST) return;

  try {
    if (typeof line !== 'string') {
      line = JSON.stringify(line);
    }
    buffer.push(line.slice(0, 4000)); // cap the size for email hygiene

    // Start throttle timer if not already scheduled.
    if (!timer) {
      timer = setTimeout(flushNow, minIntervalMs);
    }
  } catch (_err) {
    // Never throw from notifier.
  }
}

module.exports = { notifyError, flushNow };
