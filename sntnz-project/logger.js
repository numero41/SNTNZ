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

module.exports = logger;