// FILE: test-social.js
// Purpose: A standalone script to test the `postToInstagram` function from social.js.

require('dotenv').config();
const { initBots, generateAndUploadImage } = require('./bots');
const { initSocial, postEverywhere } = require('./social');
const logger = require('./logger');

// ============================================================================
// --- TEST EXECUTION ---
// ============================================================================

(async () => {
  // --- 1. Initialize the required modules ---
  // This loads API keys and prepares the clients, just like in server.js.
  try {
    initSocial();
    initBots();
  } catch (err) {
    logger.error({ err }, '[test.js] Failed during initialization.');
    return;
  }

  // --- 2. Define the input data for the test post ---
  const chapterTitle = `Chapter 5: "The Weaver's First Thread"`;
  const chapterText = `The room is a cage of shadows and humming machinery. Wires snake across the floor like sleeping serpents. Kaelen sits before the Nexus terminal, its holographic display bathing her face in cold, blue light. Her knuckles are white where she grips the edge of her chair. *Just breathe. It’s only the fate of the entire sector.* Her fingers hover, then dive. They are a blur across the projected keys. Lines of raw data cascade down the screen, a frantic waterfall of green and white. She is searching. Probing. Looking for a single weakness in the Citadel’s impenetrable network. A hairline crack in the armor. There. A ghost port, a forgotten diagnostic channel left open from a forgotten era. A dusty back door. *Got you.* She begins to code. This is not a battering ram. This is a needle. She constructs the intrusion protocol, her movements precise, economical. It materializes on the display, a shimmering, silver filament of pure light. The first thread. She commits the command thread to the digital void. It plunges into the silent, starless sea of the Citadel’s core processes, a single silver soul navigating the ghost-roads of forgotten time. The network’s sentinels, those crystalline constructs of logic, do not stir. They are blind to this singular act of creation, this quiet birth of rebellion. The filament glides past firewalls like a comet passing sleeping planets, unheard, unseen. It finds the heart-star, the central processing god-mind of the system, and anchors itself there—a whisper in the sanctum, a promise of unmaking. Kaelen leans back, her breath a ghost on the air. The ritual is done. She is no longer coder, but oracle, awaiting the echo of her own prophecy. The loom is now strung, and the pattern of a new age, terrible and bright, has begun to form in the dark. The first thread holds, a single point of light against an endless night, awaiting the dawn it must weave into being.`;
  const hash = "a6401acbd6a46743e0267f12282c60ccbc23535ef813189a2ddc256124d1df69";
  const shareableUrl = `https://www.sntnz.com/chapter/${hash}`;
  const isProduction = 0;

// --- 3. Run the function ---
  logger.info('--- Starting social post test ---');
  try {
    imageUrl = await generateAndUploadImage(chapterText, chapterTitle, hash, isProduction);
    //await postEverywhere(chapterText, shareableUrl, imageUrl);
  } catch (error) {
    logger.warn('[test.js] The test failed.');
  }
  logger.info('--- Social post test finished ---');
})();
