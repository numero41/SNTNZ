/**
 * analytics.js
 * ------------
 * Configures and initializes Google Analytics using the gtag.js library.
 * This file contains the core tracking script to send pageview data and
 * other events to the linked Google Analytics property.
 *
 * This implementation is loaded from a separate file to comply with a strict
 * Content Security Policy (CSP) that blocks inline scripts.
 */

// Initialize the dataLayer array to a global variable, or an empty array if it doesn't exist.
// This is the queue for all Google Analytics commands.
window.dataLayer = window.dataLayer || [];

// Define the gtag function to push commands to the dataLayer.
function gtag(){dataLayer.push(arguments);}

// Push the 'js' command with the current timestamp to initialize the Google Analytics library.
// This command loads and prepares the library to receive subsequent commands.
gtag('js', new Date());

// Push the 'config' command to associate the script with a specific Google Analytics property ID.
// This command also sends the initial pageview hit.
gtag('config', 'G-RDT57DJH72');