require('dotenv').config();
const { initBots, generateAndUploadImage } = require('./bots');
const { initSocial, postEverywhere } = require('./social');
const logger = require('./logger');
const { MongoClient, ServerApiVersion } = require('mongodb');

// ============================================================================
// --- DATABASE CONNECTION (for regeneration task) ---
// ============================================================================
// For the image regeneration task, we need a direct database connection.
const DATABASE_URL = process.env.DATABASE_URL_PROD;
if (!DATABASE_URL) {
  logger.error("FATAL: Database URL is not defined. Check your .env file.");
  process.exit(1);
}
const client = new MongoClient(DATABASE_URL, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});
let chaptersCollection;


// ============================================================================
// --- NEW FUNCTION: IMAGE REGENERATION ---
// ============================================================================

/**
 * Fetches chapters by their specific numbers and regenerates their cover images.
 * This will overwrite existing images in Google Cloud Storage and update the database record.
 * @param {number[]} chapterNumbers - An array of chapter numbers to process (e.g., [5, 12, 23]).
 * @param {boolean} useProductionBucket - Flag to determine which GCS folder to use ('images' vs 'dev-images').
 * @param {boolean} postOnSocials - Flag to determine if the chapter should be posted to social media after regeneration.
 */
async function regenerateChapterImages(chapterNumbers = [], useProductionBucket = false, postOnSocials = false) {
  if (!Array.isArray(chapterNumbers) || chapterNumbers.length === 0) {
    logger.info('No chapter numbers provided. Exiting regeneration task.');
    return;
  }
  logger.info(`--- Starting image regeneration for chapters: [${chapterNumbers.join(', ')}] ---`);

  try {
    // 1. Connect to the database
    await client.connect();
    const db = client.db();
    chaptersCollection = db.collection('chapters');
    logger.info("[db] Successfully connected to MongoDB Atlas for image regeneration task.");

    // 2. Build the query to find chapters by their numbers using regular expressions
    const regexQueries = chapterNumbers.map(num => ({
      title: new RegExp(`^Chapter ${num}:`, 'i') // 'i' for case-insensitive matching
    }));

    const chaptersToProcess = await chaptersCollection.find({
      $or: regexQueries,
      hash: { $ne: null, $exists: true } // Ensure we only process sealed chapters
    }).toArray();

    if (chaptersToProcess.length === 0) {
      logger.info('Did not find any matching sealed chapters in the database for the given numbers.');
      return;
    }

    const foundNumbers = chaptersToProcess.map(ch => ch.title.match(/Chapter (\d+):/)[1]);
    logger.info(`Found ${chaptersToProcess.length} matching chapters to process: [${foundNumbers.join(', ')}].`);

    // 3. Iterate and regenerate image for each chapter
    for (const chapter of chaptersToProcess) {
      const { text, title, hash } = chapter;
      if (!text || !title || !hash) {
        logger.warn({ chapterId: chapter._id }, 'Skipping chapter due to missing text, title, or hash.');
        continue;
      }

      logger.info({ chapterTitle: title, chapterText: text, chapterHash: hash.substring(0, 12) }, 'Regenerating image...');

      try {
        const newImageUrl = await generateAndUploadImage(text, title, hash, useProductionBucket);

        if (newImageUrl) {
          // 4. Update the chapter document in the database with the new image URL
          await chaptersCollection.updateOne(
            { _id: chapter._id },
            { $set: { imageUrl: newImageUrl } }
          );
          logger.info({ chapterTitle: title, newImageUrl }, 'Successfully regenerated image and updated database.');

          // 5. Post the chapter to social media if the flag is true
          if (postOnSocials && newImageUrl) {
            const shareableUrl = `https://www.sntnz.com/chapter/${hash}`;
            logger.info({ chapterTitle: title }, 'Posting to social media...');
            await postEverywhere(text, shareableUrl, newImageUrl);
            logger.info({ chapterTitle: title }, 'Successfully posted to social media.');
          }

        } else {
          logger.warn({ chapterTitle: title }, 'generateAndUploadImage returned null. Database not updated.');
        }
      } catch (error) {
        logger.error({ err: error, chapterTitle: title }, 'Failed to process a chapter during image regeneration loop.');
      }
    }

  } catch (error) {
    logger.error({ err: error }, 'The image regeneration process failed.');
  } finally {
    // 6. Ensure the database connection is closed
    await client.close();
    logger.info('[db] MongoDB connection closed.');
  }

  logger.info('--- Image regeneration process finished ---');
}


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

  // --- REGENERATE IMAGES FOR SPECIFIC CHAPTERS ---
  // Provide a list of chapter numbers you want to process.
  const chaptersToRegenerate = [54];
  const useProductionBucket = true;
  const postOnSocials = true;

  await regenerateChapterImages(chaptersToRegenerate, useProductionBucket, postOnSocials);

})();