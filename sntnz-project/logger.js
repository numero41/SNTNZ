/**
 * ============================================================================
 * --- Centralized Application Logger (logger.js) ---
 * ============================================================================
 *
 * This module configures and exports a single, application-wide Pino logger instance.
 *
 * Responsibilities:
 * - Initialize the Pino logger.
 * - Set the appropriate log level (defaulting to 'info', but overridable by
 * the LOG_LEVEL environment variable).
 * - Configure a "pretty" transport (`pino-pretty`) for readable, colorized
 * logs in development environments.
 * - Log in a structured JSON format in production for optimal performance and
 * compatibility with log management services.
 */

const pino = require('pino');
const { notifyError } = require('./mailer');

// In development, we use 'pino-pretty' for nice, human-readable logs.
// In production, we log as JSON for machines to parse.
const transport = process.env.NODE_ENV !== 'production'
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true, // Adds color to the output
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss', // Human-readable time
        ignore: 'pid,hostname', // Don't show process ID and hostname
      },
    }
  : undefined;

// Create the logger instance
const logger = pino({
  // Set the minimum log level. 'info' is a good default.
  // You can override this with a LOG_LEVEL environment variable
  level: process.env.LOG_LEVEL || 'info',
  transport,
});

/**
 * Wrap the original error method:
 *  - Preserve Pino’s behavior.
 *  - Extract a short, readable line and send it to the mailer (throttled).
 *
 * Supported call patterns:
 *  - logger.error('message')
 *  - logger.error(err)                // where err is an Error or object
 *  - logger.error({obj}, 'message')
 *  - logger.error({obj}, 'a', 'b')    // will join extra args
 */
const _error = logger.error.bind(logger);
logger.error = (...args) => {
  try {
    let line;

    if (args.length === 1) {
      const a = args[0];
      if (a instanceof Error) {
        line = `${a.message}\n${a.stack}`;
      } else if (typeof a === 'string') {
        line = a;
      } else {
        line = JSON.stringify(a);
      }
    } else {
      // Normalize common (object, message, ...rest) pattern.
      const [first, ...rest] = args;
      if (first && typeof first === 'object' && !(first instanceof Error)) {
        const msg = rest.map(String).join(' ');
        const objTxt =
          first instanceof Error
            ? `${first.message}\n${first.stack}`
            : JSON.stringify(first);
        line = [msg, objTxt].filter(Boolean).join(' | ');
      } else {
        // e.g., ('a', 'b', 'c')
        line = args.map((v) => (v instanceof Error ? `${v.message}\n${v.stack}` : String(v))).join(' ');
      }
    }

    // Fire-and-forget (throttled in mailer)
    notifyError(line);
  } catch (_err) {
    // Never break logging.
  }

  // Always call the original logger
  return _error(...args);
};

module.exports = logger;