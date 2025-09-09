/**
 * ============================================================================
 * --- AI Bot Logic (bots.js) ---
 * ============================================================================
 *
 * This module centralizes all interactions with Google's Generative AI services.
 * It handles the logic for both text generation with Gemini and image generation
 * with Imagen.
 *
 * Responsibilities:
 * - Initialize the Google Cloud Vertex AI and Storage clients.
 * - Contain the `runBotSubmission` function, which orchestrates the entire
 * process of the Gemini bot generating and submitting a word.
 * - Contain the `generateAndUploadImage` function, which creates an image
 * based on a text prompt using Imagen and uploads it to Google Cloud Storage.
 * - Manage bot-specific state like prompt construction, validation, and memory
 * (e.g., avoiding recently used words and themes).
 */

// --- Google Cloud & AI SDKs ---
const { VertexAI } = require('@google-cloud/vertexai');
const { Storage } = require('@google-cloud/storage');
const { GoogleAuth } = require('google-auth-library');

// --- Custom Modules ---
const logger = require('./logger');
const constants = require('./constants');
const sharp = require('sharp');
const writingStyles = constants.WRITING_STYLES;
const imageStyles = constants.IMAGE_STYLES;

// These variables will be initialized once by the `initBots` function.
let vertex_ai, storage, bucket, textModelLite;
let recentlyUsedImageStyles = []; // In-memory store to avoid repeating image styles too frequently.
let recentlyUsedWritingStyles = []; // In-memory store to avoid repeating writing styles too frequently.

// A cache for the bot's recently generated themes to promote novelty.
globalThis.__recentBotThemes = [];

// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

/**
 * @summary Initializes the necessary Google Cloud clients for AI and storage.
 * @description This function should be called once when the server starts. It sets up
 * the VertexAI client for accessing Gemini and Imagen, and the Storage client for
 * uploading generated images to a Google Cloud Storage bucket.
 */
function initBots() {
  // Initialize the Vertex AI client with the project ID and location from environment variables.
  vertex_ai = new VertexAI({
    project: process.env.GOOGLE_CLOUD_PROJECT_ID,
    location: process.env.GOOGLE_CLOUD_LOCATION
  });

  // Initialize the client for Google Cloud Storage.
  storage = new Storage();
  // Get a reference to the specific bucket where images will be stored.
  bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

  // Get a reference to the Gemini models with fallbacks for resilience.
  try {
    textModelFlash = vertex_ai.getGenerativeModel({ model: constants.GEMINI_MODEL_FLASH });
  } catch (e) {
    logger.error('[bots] Could not initialize Gemini Flash model. Check constants/env vars.');
    throw e; // Flash is essential, so we should stop if it's missing.
  }

  try {
    textModelLite = vertex_ai.getGenerativeModel({ model: constants.GEMINI_MODEL_LITE });
  } catch (e) {
    logger.warn('[bots] Could not initialize Gemini Lite model. Falling back to Flash.');
    textModelLite = textModelFlash; // Fallback
  }

  try {
    textModelPro = vertex_ai.getGenerativeModel({ model: constants.GEMINI_MODEL_PRO });
  } catch (e) {
    logger.warn('[bots] Could not initialize Gemini Pro model. Falling back to Flash.');
    textModelPro = textModelFlash; // Fallback
  }

  logger.info('[bots] Google AI and Storage clients initialized.');
}

// ============================================================================
// --- HELPER FUNCTIONS ---
// ============================================================================

/**
 * @summary Appends a word to the bot's context buffer.
 * @description The context buffer is a "ring buffer" that maintains a sliding window
 * of the most recent words in the story. This context is fed to the Gemini model
 * to ensure its generated text is relevant to the current narrative.
 * @param {string} word - The word to add to the context.
 * @param {string[]} botContext - The current context array.
 * @returns {string[]} The updated context array.
 */
function pushBotContext(word, botContext) {
  const botBufferMax = constants.CURRENT_TEXT_LENGTH;
  botContext.push(String(word || ''));
  // If the buffer exceeds its maximum size, remove the oldest word.
  if (botContext.length > botBufferMax) {
    botContext.shift();
  }
  return botContext;
}

// ============================================================================
// --- GEMINI TEXT GENERATION ---
// ============================================================================

/**
 * @summary Selects a writing style, avoiding recently used ones.
 * @returns {object} The selected writing style object from constants.
 */
function selectWritingStyle() {
  let availableStyles = writingStyles.filter(style => !recentlyUsedWritingStyles.includes(style.name));
  if (availableStyles.length === 0) {
    logger.info('[bot] All writing styles used recently. Resetting pool.');
    recentlyUsedWritingStyles = [];
    availableStyles = writingStyles;
  }
  const selectedStyle = availableStyles[Math.floor(Math.random() * availableStyles.length)];
  recentlyUsedWritingStyles.push(selectedStyle.name);
  if (recentlyUsedWritingStyles.length > 3) recentlyUsedWritingStyles.shift();

  logger.info({ style: selectedStyle.name }, '[bot] Selected writing style');
  return selectedStyle;
}

/**
 * @summary Generates a new chapter, including a title and a full story.
 * @description This function is called when the bot detects the start of a new, empty chunk.
 * It selects a writing style, prompts Gemini to create a title, then prompts Gemini
 * again to write a ~360-word story based on that title and style.
 * @param {number} totalChunkCount - The total number of chunks created so far.
 * @returns {Promise<Array<object>>} A promise that resolves to a queue of word objects for submission.
 */
async function generateNewChapter(totalChunkCount, targetWordCount, recentTitles = [], currentWritingStyle) {
  logger.info('[bot] Starting a new chapter...');
  const chapterNumber = totalChunkCount + 1;
  let title = `Chapter ${chapterNumber}`;
  let story = '';
  const newQueue = [];

  try {
    const AI_TIMEOUT_MS = Number(constants.AI_TIMEOUT_MS || 35000);
    const withTimeout = (p, ms = AI_TIMEOUT_MS) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    // --- Step 1: Generate Title ---
    const MAX_TITLE_ATTEMPTS = 3;
    let isUnique = false;

    for (let i = 0; i < MAX_TITLE_ATTEMPTS; i++) {
      const titlePrompt = `
        You are a master storyteller. Your current task is to create a chapter title for a new story to begin.
        Style Guide:
        - Style Name: ${currentWritingStyle.name}
        - Description: ${currentWritingStyle.description}
        - Instructions: Generate a short, evocative chapter title of 1-5 words from this style.
        CRITICAL: Do not use any of the following recent titles: ${recentTitles.join(', ')}
        Output ONLY the title text, without any quotes or prefixes.
      `.trim();

      const titleResult = await withTimeout(textModelLite.generateContent({
          contents: [{ role: "user", parts: [{ text: titlePrompt }] }],
          generationConfig: { maxOutputTokens: 50, temperature: 0.8 },
      }));

      const candidateTitle = (titleResult?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().replace(/["“”]/g, '');

      // Check if the generated title is in the list of recent titles (case-insensitive).
      if (candidateTitle && !recentTitles.some(t => t.toLowerCase() === candidateTitle.toLowerCase())) {
        title = candidateTitle;
        isUnique = true;
        break; // Exit the loop on success
      }
      logger.warn(`[bot] Generated duplicate or empty title ('${candidateTitle}'). Retrying... (${i + 1}/${MAX_TITLE_ATTEMPTS})`);
    }

    // If the loop fails, use a generic fallback title.
    if (!isUnique) {
      title = `A New Beginning`;
      logger.error('[bot] Failed to generate a unique title after multiple attempts. Using fallback.');
    }

    logger.info({ title }, '[bot] Generated chapter title');

    // --- Step 2: Generate Story ---
    const storyPrompt = `
      You are a master storyteller tasked with writing a complete, self-contained story of approximately ${targetWordCount} words based on the provided chapter title.
      The story must have a clear beginning, middle, and a satisfying conclusion.

      Style Guide:
      - Style Name: ${currentWritingStyle.name}
      - Enforce These Elements: ${currentWritingStyle.enforce.join(', ')}

      Chapter Title: "${title}"

      CRITICAL: Your entire response must be ONLY the story text. Do not repeat the title. Do not add any explanation or commentary.
    `.trim();

     const storyResult = await withTimeout(textModelPro.generateContent({
        contents: [{ role: "user", parts: [{ text: storyPrompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.6, topP: 0.9 },
    }));
    story = (storyResult?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

    // --- Step 3: Build the Submission Queue ---
    if (story) {
        const storyWords = story.split(/\s+/).filter(Boolean);

        // This adds another line break, followed by the complete chapter title in one submission.
        newQueue.push({
          word: `Chapter ${chapterNumber}: "${title}"`,
          styles: { bold: true, italic: false, underline: false, newline: true },
          isTitle: true
        });

        // Add story words to the queue, ensuring the first word starts on a new line.
        if (storyWords.length > 0) {
            storyWords.forEach((word, index) => {
                const isFirstWord = index === 0;
                newQueue.push({
                    word: word,
                    styles: {
                        bold: false,
                        italic: false,
                        underline: false,
                        newline: isFirstWord
                    }
                });
            });
        }
    }

  } catch (err) {
      logger.error({ err }, '[bot] Failed to generate new chapter');
      return []; // Return empty queue on failure
  }

  logger.info({ wordCount: newQueue.length, title: title, story: story }, '[bot] New chapter generated and queued');
  return newQueue;
}

/**
 * @summary Continues a story that was started by users.
 * @description If the bot is triggered mid-chunk, this function gets the existing text,
 * determines how many words are needed to reach the ~360 target, and prompts Gemini
 * to write a conclusion to the story in the established style.
 * @param {Array<object>} currentChunkWords - An array of the word objects already in the current chunk.
 * @returns {Promise<Array<object>>} A promise that resolves to a queue of new word objects.
 */
async function continueStory(currentChunkWords, targetWordCount, currentWritingStyle) {
    logger.info('[bot] Continuing user-initiated story...');
    const wordsSoFar = currentChunkWords.map(w => w.word).join(' ');
    const remainingWords = Math.max(2, targetWordCount - currentChunkWords.length);
    let continuation = '';
    const newQueue = [];

    try {
        // Conditionally select the AI model based on the number of remaining words.
        const useProModel = remainingWords > (targetWordCount * 0.5);
        const selectedModel = useProModel ? textModelPro : textModelFlash;
        logger.info({ model: useProModel ? 'PRO' : 'LITE', remainingWords }, '[bot] Selected model for story continuation');

        const continuationPrompt = `
            You are a master storyteller. A story is in progress, and your task is to continue it seamlessly and bring it to a satisfying conclusion.
            Write approximately ${remainingWords} more words.

            Style Guide (adhere to this strictly):
            - Style Name: ${currentWritingStyle.name}
            - Enforce These Elements: ${currentWritingStyle.enforce.join(', ')}

            Existing Text:
            "${wordsSoFar}"

            CRITICAL: Your response must be ONLY the new, continuing text. Do not repeat the existing text. Do not add any explanation.
        `.trim();

        const result = await selectedModel.generateContent({
            contents: [{ role: "user", parts: [{ text: continuationPrompt }] }],
            generationConfig: { maxOutputTokens: 4096, temperature: 0.6, topP: 0.9 },
        });
        continuation = (result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

        if (continuation) {
            continuation.split(/\s+/).filter(Boolean).forEach(word => {
                newQueue.push({ word, styles: { bold: false, italic: false, underline: false, newline: false } });
            });
        }
    } catch (err) {
        logger.error({ err }, '[bot] Failed to continue story');
        return [];
    }

    logger.info({ wordCount: newQueue.length, targetWordCount: targetWordCount, continuation: continuation }, '[bot] Story continuation generated and queued');
    return newQueue;
}

/**
 * @summary Orchestrates the bot's turn to generate and submit text.
 * @description This is the main function for the text bot. It manages the bot's queue
 * and decides when to generate new content based on the current state of the story chunk.
 * @param {object} state - The complete current state of the game from server.js.
 * @returns {Promise<object>} An object containing the updated bot state to be synchronized with the server.
 */
async function runBotSubmission(state) {
  // ==========================================================================
  // --- 1. SETUP & STATE DECONSTRUCTION ---
  // ==========================================================================
  // Destructure all required variables from the main state object passed by the server.
  // 'currentWritingStyle' is now managed here, not as a module-level variable.
  const { liveWords, getCompositeKey, broadcastLiveFeed, currentChunkWords, totalChunkCount, dynamicTargetWordCount, recentTitles, currentText } = state;
  let { botQueue, botMustStartNewChapter, botHasFinishedChapter, currentWritingStyle } = state;

  // ==========================================================================
  // --- 2. HANDLE QUEUED SUBMISSIONS (with last-winner guard) ---
  // ==========================================================================
  // If the last round was won by a user (not the bot), any existing queue is stale
  // and must be discarded so we regenerate fresh content for this round.
  const lastWinner = Array.isArray(currentText) && currentText.length > 0 ? currentText[currentText.length - 1] : null;

  if (botQueue.length > 0) {
    if (lastWinner && lastWinner.username !== constants.BOT_NAME) {
      logger.info('[bot] Last winner was a user; discarding stale queue and regenerating.');
      botQueue = [];
      botHasFinishedChapter = false;
    } else {
      const plannedSubmission = botQueue.shift(); // Take the next word from the front of the queue.
      const compositeKey = getCompositeKey(plannedSubmission);

      // Add the word to the live feed for users to vote on.
      if (!liveWords.has(compositeKey)) {
        liveWords.set(compositeKey, {
          ...plannedSubmission,
          submitterId: 'sntnz_bot',
          submitterName: constants.BOT_NAME,
          ts: Date.now(),
          votes: new Map([['sntnz_bot', 1]]) // The bot always upvotes its own submissions.
        });
      }
      broadcastLiveFeed();

      // Return the updated state to the server.
      return { botQueue, botMustStartNewChapter, botHasFinishedChapter, currentWritingStyle };
    }
  }

  // ==========================================================================
  // --- 3. GUARD CLAUSE: CHECK IF WORK IS DONE ---
  // ==========================================================================
  // If the queue is empty but the bot has already completed its main writing task
  // for this chapter, do nothing. This prevents the bot from adding more words to a finished chapter.
  if (botHasFinishedChapter) {
    return { botQueue, botMustStartNewChapter, botHasFinishedChapter, currentWritingStyle };
  }

  // ==========================================================================
  // --- 4. CONTENT GENERATION LOGIC ---
  // ==========================================================================
  // If the queue is empty and work is not done, the bot must decide what to write.
  const isNewChunk = currentChunkWords.length === 0;
  let newQueue = [];

  // If a writing style hasn't been chosen for this chapter yet, select one now.
  if (!currentWritingStyle) {
    currentWritingStyle = selectWritingStyle();
  }

  // A) START A NEW CHAPTER: If the server signals a new chapter is needed or the chunk is empty.
  if (botMustStartNewChapter || isNewChunk) {
    logger.info('[bot] Server signaled a new chapter must be started.');
    newQueue = await generateNewChapter(totalChunkCount, dynamicTargetWordCount, recentTitles, currentWritingStyle);
    if (newQueue.length > 0) {
      botMustStartNewChapter = false; // Reset the signal flag.
      botHasFinishedChapter = true;   // Mark the bot's main job as complete for this chunk.
    }
  }
  // B) CONTINUE AN EXISTING STORY: If users have started writing but the chunk isn't full.
  else {
    if (currentChunkWords.length < dynamicTargetWordCount) {
        newQueue = await continueStory(currentChunkWords, dynamicTargetWordCount, currentWritingStyle);
        if (newQueue.length > 0) {
          botHasFinishedChapter = true; // Mark the bot's main job as complete for this chunk.
        }
    } else {
        logger.info('[bot] Chunk is complete. Bot will not add more words.');
    }
  }

  // ==========================================================================
  // --- 5. POPULATE QUEUE & SUBMIT FIRST WORD ---
  // ==========================================================================
  // If the generation step produced new words, populate the bot's queue.
  if (newQueue.length > 0) {
      botQueue = newQueue;
  } else {
      // If generation failed or wasn't needed, exit and return the current state.
      return { botQueue, botMustStartNewChapter, botHasFinishedChapter, currentWritingStyle };
  }

  // Immediately submit the first word from the newly populated queue.
  if (botQueue.length > 0) {
    const firstSubmission = botQueue.shift();
    const compositeKey = getCompositeKey(firstSubmission);

    if (!liveWords.has(compositeKey)) {
        liveWords.set(compositeKey, {
            ...firstSubmission,
            submitterId: 'sntnz_bot',
            submitterName: constants.BOT_NAME,
            ts: Date.now(),
            votes: new Map([['sntnz_bot', 1]])
        });
    }
    broadcastLiveFeed();
  }

  // ==========================================================================
  // --- 6. RETURN FINAL UPDATED STATE ---
  // ==========================================================================
  // Return all state variables, which will be used to update the main server state.
  return { botQueue, botMustStartNewChapter, botHasFinishedChapter, currentWritingStyle };
}

// ============================================================================
// --- IMAGEN IMAGE GENERATION ---
// ============================================================================

/**
 * @summary Generates an image with Imagen and uploads it to Google Cloud Storage.
 * @description This is a multi-step process:
 * 1. A random artistic style is selected, avoiding recently used ones.
 * 2. The input text (a chunk of the story) is summarized by Gemini to create a
 * more effective and concise visual prompt.
 * 3. A detailed final prompt is constructed, combining the summary, the chosen
 * style, and hard constraints (like "no text" or "no logos").
 * 4. The Imagen API is called to generate the image from the prompt.
 * 5. The resulting image data is decoded and uploaded to a public GCS bucket.
 * @param {string} text - The core text content (story chunk) to be depicted.
 * @param {boolean} isProduction - Flag to determine which GCS folder to use.
 * @returns {Promise<string|null>} The public URL of the uploaded image, or null on failure.
 */
async function generateAndUploadImage(text, isProduction) {
  try {
    logger.info('[image] Starting image generation process...');

    // --- Step 1: Select an Artistic Style ---
    let availableStyles = imageStyles.filter(style => !recentlyUsedImageStyles.includes(style.name));
    if (availableStyles.length === 0) {
      logger.info('[image] All styles used recently. Resetting pool.');
      recentlyUsedImageStyles = [];
      availableStyles = imageStyles;
    }
    const selectedStyle = availableStyles[Math.floor(Math.random() * availableStyles.length)];
    recentlyUsedImageStyles.push(selectedStyle.name);
    if (recentlyUsedImageStyles.length > 4) recentlyUsedImageStyles.shift();
    logger.info({ style: selectedStyle.name }, '[image] Selected style');

    // --- Step 2: Summarize Text with Gemini for a better visual prompt ---
    let summarized = text.trim();
    try {
      const summarizationPrompt = `
        Summarize the following text into a single, concise paragraph of about 50-80 words
        that visually describes the scene. Focus on concrete objects, colors, and actions.
        Omit abstract concepts, dialogue, and character names. Output only the description.
        TEXT: "${summarized}"`.trim();
      const result = await textModelLite.generateContent({
        contents: [{ role: "user", parts: [{ text: summarizationPrompt }] }],
        generationConfig: { maxOutputTokens: 128, temperature: 0.3 }
      });
      const rawSummary = result?.response?.candidates?.[0]?.content?.parts?.[0]?.text.trim();
      if (rawSummary) {
        summarized = rawSummary.replace(/["“”]/g, '');
        logger.info({ summarized }, '[image] Summarized description for Imagen');
      }
    } catch (e) {
      logger.warn({ err: e }, '[image] Summarization failed, using original text');
    }

    // --- Step 3: Construct the Final Imagen Prompt ---
    const finalPrompt = [
      `DEPICT THIS SCENE:`,
      `${summarized}`,
      ``,
      `IN THIS STYLE:`,
      `— render strictly as ${selectedStyle.name}:`,
      `- Medium/Surface: ${(selectedStyle.surface || []).join(', ')}`,
      `- Technique: ${selectedStyle.enforce.join(', ') || selectedStyle.description}`,
      `- Palette: ${(selectedStyle.palette || []).join(', ')}`,
      `- Quality: fine art, gallery, poster, magazine cover, high premium grade.`,
      ``,
      `CONSTRAINTS:`,
      `- the render must NOT be photorealistic.`,
      `- the image must be highly detailed and fill the entire square canvas.`,
    ].join('\n');
    logger.info({ finalPrompt: finalPrompt }, '[image] Final Imagen prompt prepared.');


    // --- Step 4: Call the Imagen API ---
    const project = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const region = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const modelId = constants.IMAGEN_MODEL || 'imagen-3.0-generate-001';

    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const predictUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${modelId}:predict`;

    const predictBody = {
      instances: [{ prompt: finalPrompt }],
      parameters: { sampleCount: 1, aspectRatio: "1:1" }
    };
    const predictRes = await fetch(predictUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(predictBody)
    });

    if (!predictRes.ok) {
      throw new Error(`[Imagen:predict] ${predictRes.status} ${await predictRes.text()}`);
    }
    const predictJson = await predictRes.json();
    const imageDataBase64 = predictJson?.predictions?.[0]?.bytesBase64Encoded;
    if (!imageDataBase64) {
      throw new Error('[Imagen:predict] No image data returned from API.');
    }
    logger.info('[image] Image data received from Vertex AI.');

    // --- Step 5: Create Watermark and Composite Image ---
    const imageBuffer = Buffer.from(imageDataBase64, 'base64');

    // Create a text watermark as an SVG image in a buffer.
    // This gives you full control over font, size, color, and opacity.
      const watermarkSvg = `
        <svg width="300" height="100">
          <text x="95%" y="85%" text-anchor="end"
          font-family="IBM Plex Mono, monospace" font-size="20" font-weight="bold" fill="rgba(255, 153, 51, 0.71)">
          sntnz.com
          </text>
        </svg>
      `;
    const watermarkBuffer = Buffer.from(watermarkSvg);

    // Use sharp to composite the watermark onto the generated image.
    const watermarkedImageBuffer = await sharp(imageBuffer)
      .composite([
        {
          input: watermarkBuffer,
          gravity: 'southeast', // Positions the watermark in the bottom-right corner
        },
      ])
      .toBuffer();

    // --- Step 6: Upload Image to Google Cloud Storage ---
    const folder = isProduction ? 'images' : 'dev-images';
    const fileName = `${folder}/sntnz-chunk-${Date.now()}.png`;
    const file = bucket.file(fileName);

    await file.save(watermarkedImageBuffer, {
      metadata: { contentType: 'image/png' },
      resumable: false // Use simpler upload for smaller files.
    });

    const publicUrl = file.publicUrl();
    logger.info({ publicUrl }, '[image] Successfully uploaded to GCS');
    return publicUrl;

  } catch (err) {
    logger.error({ err }, '[image] Full image generation pipeline failed');
    return null; // Return null to indicate failure.
  }
}

module.exports = {
  initBots,
  runBotSubmission,
  generateAndUploadImage,
  pushBotContext
};
