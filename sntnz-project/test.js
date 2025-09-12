// FILE: test-social.js
// Purpose: A standalone script to test the `postToInstagram` function from social.js.

require('dotenv').config();
const { initSocial, postToInstagram } = require('./social');
const logger = require('./logger');

// ============================================================================
// --- TEST EXECUTION ---
// ============================================================================

(async () => {
  // --- 1. Initialize the required modules ---
  // This loads API keys and prepares the clients, just like in server.js.
  try {
    initSocial();
  } catch (err) {
    logger.error({ err }, 'Failed during initialization.');
    return;
  }

  // --- 2. Define the input data for the test post ---
  const fullStoryText = `Dr. Aris Thorne leaned closer to the primary monitor, the soft glow illuminating the concern etched on his face. The deep-space observatory’s vacuum energy sensor, a device calibrated to measure the ephemeral fizz of virtual particles, was reporting a deviation far outside standard error. For the past 93 minutes, the background quantum foam had ceased its random, stochastic behavior. A coherent pattern was emerging. He ran a level-one diagnostic, suspecting a sensor malfunction or a resonance cascade in the containment field generators. Results returned nominal. The anomaly was external. Cross-referencing telemetry from ancillary probes confirmed it: a rhythmic, structured pulse originating not from a point source, but from the fabric of spacetime itself. The fluctuations were resolving and collapsing in a non-random sequence, a series of discrete energy spikes that defied probability. Thorne isolated the signal and fed it through a decryption algorithm, though he knew it was a futile gesture. This wasn't a transmission. It was a fundamental alteration. The algorithm, however, found a mathematical analogue: the sequence of energy spikes perfectly mapped the Fibonacci sequence. It was an impossibly ordered structure imposed upon the universe’s most basic, chaotic level. He initiated a system-wide lockdown, his fingers moving with practiced calm. This wasn't an act of aggression, but it was an act of intelligence. An entity capable of manipulating quantum mechanics on this scale was not merely post-terrestrial; it was post-physical. Humanity had spent centuries listening for signals from the stars, never considering that the universe itself could become the message. It was. A message. Thorne initiated a Level-Alpha diagnostic, rerouting the primary sensor array’s output through the observatory’s quantum entanglement correlator. The raw data stream, now stripped of environmental noise, confirmed the anomaly’s persistence and mathematical purity. The Fibonacci sequence, 1, 1, 2, 3, 5, 8, continued, extending into previously unobserved quantum states, each number corresponding to a specific energy level fluctuation. This wasn't a static pattern; it was dynamic, evolving. He cross-referenced the emergent sequence with known universal constants and fundamental interactions, searching for any correlative resonance. None. The pattern was self-referential, a pure mathematical expression manifesting physically. He then directed the gravitational wave interferometer, typically`;

  const longUrl = 'https://www.sntnz.com/chunk/45a72d49cc267c3baebe1fa697ab049bfbb853cc001abae6862ec3427141661d';
  const shortHash = longUrl.split('/').pop().substring(0, 12);
  const shareableUrl = `https://www.sntnz.com/chunk/${shortHash}`;

  const imageUrl = 'https://storage.googleapis.com/sntnz-bucket1/dev-images/sntnz-chunk-1756905008733.png';

  // --- 3. Run the function ---
  logger.info('--- Starting Instagram post test ---');
  try {
    await postToInstagram(fullStoryText, shareableUrl, imageUrl);
  } catch (error) {
    // The error is already logged in detail by the social.js file.
    // We just need to catch it here to prevent the script from crashing.
    logger.warn('[test.js] The test failed, but the error was caught and the script will now exit gracefully.');
  }
  logger.info('--- Instagram post test finished ---');
})();