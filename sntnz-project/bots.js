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
 * Generates a unique chapter title.
 * @param {number} totalChapterCount - The total number of previously sealed chapters, used for chapter numbering.
 * @param {string[]} [recentTitles=[]] - An array of recent titles to avoid duplication.
 * @param {object} currentWritingStyle - The writing style object to guide the AI.
 * @returns {Promise<object[]>} A promise that resolves to a queue containing the formatted title object.
 */
async function generateNewTitle(totalChapterCount, recentTitles = [], currentWritingStyle) {
  logger.info('[bot] Generating a title...');
  const chapterNumber = totalChapterCount + 1;
  let title = 'A New Beginning'; // Default title in case of failure
  let newQueue = [];

  try {
    const AI_TIMEOUT_MS = Number(constants.AI_TIMEOUT_MS || 35000);
    const withTimeout = (p, ms = AI_TIMEOUT_MS) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    // --- 1. Generate a unique title candidate ---
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
          generationConfig: { maxOutputTokens: 64, temperature: 0.6 },
      }));
      const candidateTitle = (titleResult?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().replace(/["“”]/g, '');

      // Check if the generated title is new and valid.
      if (candidateTitle && !recentTitles.some(t => t.toLowerCase() === candidateTitle.toLowerCase())) {
        title = candidateTitle;
        isUnique = true;
        break; // Exit the loop on success.
      }
      logger.warn(`[bot] Generated duplicate or empty title ('${candidateTitle}'). Retrying... (${i + 1}/${MAX_TITLE_ATTEMPTS})`);
    }

    if (!isUnique) {
      logger.error('[bot] Failed to generate a unique title after multiple attempts. Using fallback.');
    }

    // --- 2. Format the title and build the queue ---
    const finalTitleText = `Chapter ${chapterNumber}: "${title}"`;
    newQueue.push({
        word: finalTitleText,
        styles: { bold: true, italic: false, underline: false, newline: true },
        isTitle: true
    });

    logger.info({ title: finalTitleText }, '[bot] New title generated and queued.');
    if (newQueue.length > 0) {
      newQueue[0].writingStyle = currentWritingStyle.name;
    }
    return newQueue; // Return immediately on success.

  } catch (err) {
    logger.error({ err }, '[bot] Failed to generate title.');
    return []; // Return an empty array on failure.
  }
}

/**
 * Generates or continues a story chapter using a largely shared prompt and logic.
 * @param {object} args - The arguments for the function.
 * @param {boolean} args.isContinuing - If true, continues a story. If false, starts a new one.
 * @param {number} args.targetWordCount - The approximate number of words to generate.
 * @param {object} args.currentWritingStyle - The writing style object to guide the AI.
 * @param {object} args.contextData - Contains the necessary context for the story.
 * @param {string} [args.contextData.title] - The chapter title (if starting a new chapter).
 * @param {string} [args.contextData.wordsSoFar] - The existing text (if continuing).
 * @returns {Promise<object[]>} A promise that resolves to a queue of word objects.
 */
async function writeChapter({ isContinuing, targetWordCount, currentWritingStyle, contextData }) {
  const logContext = isContinuing ? 'story continuation' : 'new chapter';
  logger.info(`[bot] Preparing to write ${logContext}...`);

  // --- 1. Conditionally build prompt components ---
  const taskDescription = isContinuing
    ? `A story is in progress, and your task is to continue it seamlessly and bring it to a satisfying conclusion. Write approximately ${targetWordCount} more words.`
    : `You are tasked with writing a complete, self-contained story of approximately ${targetWordCount} words based on the provided chapter title. The story must have a clear beginning, middle, and a satisfying conclusion.`;

  const contextBlock = isContinuing
    ? `Existing Text:\n"${contextData.wordsSoFar}"`
    : `Chapter Title: "${contextData.title}"`;

  const criticalInstruction = isContinuing
    ? 'CRITICAL: Your response must be ONLY the new, continuing text. Do not repeat the existing text. Do not add any explanation.'
    : 'CRITICAL: Your entire response must be ONLY the story text. Do not repeat the title. Do not add any explanation or commentary.';

  // --- 2. Assemble the final prompt ---
  const finalPrompt = `
    You are a master storyteller telling creative tales, with a subtile surreal tone.
    ${taskDescription}
    Style Guide (adhere to this strictly):
    - Style Name: ${currentWritingStyle.name}
    - Enforce These Elements: ${(currentWritingStyle.enforce || []).join(', ')}
    ${contextBlock}
    ${criticalInstruction}
  `.trim();

  // --- 3. Select model and define processing options ---
  let selectedModel = textModelPro; // Default to Pro model
  if (isContinuing && targetWordCount <= 100) {
    selectedModel = textModelFlash; // Use faster model for short continuations
  }
  const startWithNewline = !isContinuing;
  let newQueue = [];

  // --- 4. Call AI, process response, and handle errors ---
  try {
    const AI_TIMEOUT_MS = Number(constants.AI_TIMEOUT_MS || 35000);
    const withTimeout = (p, ms = AI_TIMEOUT_MS) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    const result = await withTimeout(selectedModel.generateContent({
        contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.6, topP: 0.9 },
    }));
    const generatedText = (result?.response?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();

    if (generatedText) {
        generatedText.split(/\s+/).filter(Boolean).forEach((word, index) => {
            newQueue.push({
                word: word,
                styles: {
                    bold: false, italic: false, underline: false, isTitle: false,
                    newline: startWithNewline && index === 0
                }
            });
        });
    }

    logger.info({ wordCount: newQueue.length, text: generatedText, model: selectedModel.model }, `[bot] Successfully generated ${logContext}`);
    return newQueue;

  } catch (err) {
      logger.error({ err }, `[bot] Failed to generate ${logContext}`);
      return [];
  }
}

/**
 * Generates the main story text for a new chapter by calling the shared writer function.
 */
async function generateNewChapter(targetWordCount, currentTitle, currentWritingStyle) {
  return writeChapter({
    isContinuing: false,
    targetWordCount,
    currentWritingStyle,
    contextData: { title: currentTitle }
  });
}

/**
 * Generates a continuation for a story by calling the shared writer function.
 */
async function continueChapter(currentChapterWords, targetWordCount, currentWritingStyle) {
  const wordsSoFar = currentChapterWords.map(w => w.word).join(' ');
  return writeChapter({
    isContinuing: true,
    targetWordCount,
    currentWritingStyle,
    contextData: { wordsSoFar }
  });
}

/**
 * @summary Orchestrates the bot's turn to generate and submit text.
 * @description This is the main function for the text bot. It manages the bot's queue
 * and decides when to generate new content based on the current state of the story chapter.
 * @param {object} state - The complete current state of the game from server.js.
 * @returns {Promise<object>} An object containing the updated bot state to be synchronized with the server.
 */
async function runBotSubmission(state) {
  // ==========================================================================
  // --- 1. SETUP & STATE DECONSTRUCTION ---
  // ==========================================================================
  // Destructure all required variables from the main state object passed by the server.
  const { liveWords, getCompositeKey, broadcastLiveFeed, currentChapterWords, totalChapterCount, targetWordCount, recentTitles } = state;
  let { botQueue, botMustWriteTitle, botMustStartChapter, botMustContinueChapter, currentTitle, currentWritingStyle } = state;
  let submissionMade = false;

  // ==========================================================================
  // --- 2. HANDLE QUEUED SUBMISSIONS ---
  // ==========================================================================
  // If the bot has a queue of words, it submits the next one.
  // The server is responsible for clearing this queue if a user wins a round.
  if (botQueue.length > 0) {
    const plannedSubmission = botQueue.shift(); // Take the next word from the queue.
    const compositeKey = getCompositeKey(plannedSubmission);

    // Add the word to the live feed for users to vote on.
    if (!liveWords.has(compositeKey)) {
      liveWords.set(compositeKey, {
        ...plannedSubmission,
        submitterId: constants.BOT_ID,
        submitterName: constants.BOT_NAME,
        ts: Date.now(),
        votes: new Map([[constants.BOT_ID, 1]]) // The bot always upvotes its own submissions.
      });
      submissionMade = true;
    }
    broadcastLiveFeed();

    // Return the updated state to the server and stop further execution for this turn.
    return { botQueue, botMustWriteTitle, botMustStartChapter, botMustContinueChapter, currentTitle, currentWritingStyle, submissionMade };
  }

  // ==========================================================================
  // --- 3. CONTENT GENERATION LOGIC ---
  // ==========================================================================
  // If the queue is empty and work is not done, the bot must decide what to write.
  const isNewChapter = currentChapterWords.length === 0;
  const hasTitleOnly = currentChapterWords.length === 1;
  let newQueue = [];

  // If a writing style hasn't been chosen for this chapter yet, select one now.
  if (!currentWritingStyle) {
    currentWritingStyle = selectWritingStyle();
  }

  // A) WRITE A TITLE: If the server signals a new chapter is needed or the chapter is empty.
  if (botMustWriteTitle || isNewChapter) {
    logger.info('[bot] Server signaled a new title must be written.');
    newQueue = await generateNewTitle(totalChapterCount, recentTitles, currentWritingStyle);
    if (newQueue.length > 0) {
      currentTitle = newQueue[0].word;
      botMustWriteTitle = false;
      botMustStartChapter = true;
      botMustContinueChapter = false;
    }
  }
  // B) START A NEW CHAPTER: If the server signals a new chapter is needed.
  else if (botMustStartChapter || hasTitleOnly) {
    logger.info('[bot] Server signaled a new chapter must be started.');
    newQueue = await generateNewChapter(targetWordCount, currentTitle, currentWritingStyle);
    if (newQueue.length > 0) {
      botMustWriteTitle = false;
      botMustStartChapter = false;
      botMustContinueChapter = false;
    }
  }
  // B) CONTINUE AN EXISTING STORY: If users have started writing but the chapter isn't full.
  else if (botMustContinueChapter && targetWordCount > 0) {
    logger.info('[bot] Server signaled the chapter should be updated from new content.');
    newQueue = await continueChapter(currentChapterWords, targetWordCount, currentWritingStyle);
    if (newQueue.length > 0) {
      botMustWriteTitle = false;
      botMustStartChapter = false;
      botMustContinueChapter = false;
    }
  } else {
    logger.info('[bot] Chapter is complete. Bot will not add more words.');
  }

  // ==========================================================================
  // --- 4. POPULATE QUEUE & SUBMIT FIRST WORD ---
  // ==========================================================================
  // If the generation step produced new words, populate the bot's queue.
  if (newQueue.length > 0) {
      botQueue = newQueue;
  } else {
      // If generation failed or wasn't needed, exit and return the current state.
      return { botQueue, botMustWriteTitle, botMustStartChapter, botMustContinueChapter, currentTitle, currentWritingStyle, submissionMade };
  }

  // Immediately submit the first word from the newly populated queue.
  if (botQueue.length > 0) {
    const firstSubmission = botQueue.shift();
    const compositeKey = getCompositeKey(firstSubmission);

    if (!liveWords.has(compositeKey)) {
        liveWords.set(compositeKey, {
            ...firstSubmission,
            submitterId: constants.BOT_ID,
            submitterName: constants.BOT_NAME,
            ts: Date.now(),
            votes: new Map([[constants.BOT_ID, 1]])
        });
      submissionMade = true;
    }
    broadcastLiveFeed();
  }

  // ==========================================================================
  // --- 5. RETURN FINAL UPDATED STATE ---
  // ==========================================================================
  // Return all state variables, which will be used to update the main server state.
  return { botQueue, botMustWriteTitle, botMustStartChapter, botMustContinueChapter, currentTitle, currentWritingStyle, submissionMade };
}

// ============================================================================
// --- IMAGEN IMAGE GENERATION ---
// ============================================================================

/**
 * @summary Generates an image with Imagen and uploads it to Google Cloud Storage.
 * @description This is a multi-step process:
 * 1. A random artistic style is selected, avoiding recently used ones.
 * 2. The input text (a chapter of the story) is summarized by Gemini to create a
 * more effective and concise visual prompt.
 * 3. A detailed final prompt is constructed, combining the summary, the chosen
 * style, and hard constraints (like "no text" or "no logos").
 * 4. The Imagen API is called to generate the image from the prompt.
 * 5. The resulting image data is decoded and uploaded to a public GCS bucket.
 * @param {string} text - The core text content (story chapter) to be depicted.
 * @param {boolean} isProduction - Flag to determine which GCS folder to use.
 * @returns {Promise<string|null>} The public URL of the uploaded image, or null on failure.
 */
async function generateAndUploadImage(text, chapterTitle, chapterHash, isProduction) {
  let finalPrompt; // Declare here to make it available throughout the function scope

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

    // --- Step 2: Generate the Full Image Prompt with Gemini ---
    try {
      const sceneGenPrompt = `
        Read the following story excerpt and synthesize its essence into a short scene description.\n

        - Omit dialogue and character names.\n
        - Focus on scenery, landscapes, creatures, light, mood.\n
        - Make short sentences.\n
        - CTRITICAL: The whole output MUST NOT exceed 50 words.\n\n

        STORY EXCERPT:\n\n
        """
        ${text}
        """
      `.trim();

      const result = await textModelPro.generateContent({
        contents: [{ role: "user", parts: [{ text: sceneGenPrompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.8 },
      });

      const sceneDescription = result?.response?.candidates?.[0]?.content?.parts?.[0]?.text.trim();

      if (!sceneDescription) {
        throw new Error('AI failed to generate the scene description.');
      }

      // --- Step 3: Manually construct the full prompt in code ---
      const mainPrompt = `A POWERFUL, clear, highly stylized, detailed, graphical artwork in this style: "${selectedStyle.name}". Depicting this scene: "${sceneDescription}".\n
      Emphasize these STYLE details: "${selectedStyle.description}". Prefer abstract or surreal.`;
      const negativePrompt = `CRITICAL: YOU MUST AVOID these elements: text, words, human characters, letters, photorealism, 3D render, cartoon, vignetting, dark, muddy, underexposed.`;

      finalPrompt = `${mainPrompt}\n\n${negativePrompt}`;

      logger.info({ finalPrompt }, '[image] Final Imagen prompt prepared.');

    } catch (e) {
      logger.error({ err: e }, '[image] Failed to generate the final image prompt');
      return null; // Halt execution if prompt generation fails
    }

    // --- Step 3: Call the Imagen API ---
    const project = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const region = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
    const modelId = constants.IMAGEN_MODEL || 'imagen-3.0-generate-001';

    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    const predictUrl = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${modelId}:predict`;

    const predictBody = {
      instances: [{ prompt: finalPrompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "1:1",
      }
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

    // --- Step 4: Create Watermark and Composite Image ---
    const imageBuffer = Buffer.from(imageDataBase64, 'base64');
    const watermarkSvg = `
      <svg width="1000" height="50">
        <text x="50%" y="85%" text-anchor="middle"
        font-family="IBM Plex Mono, monospace" font-size="20" fill="rgba(255, 153, 51, 0.71)">
        ${chapterTitle} - sntnz.com
        </text>
      </svg>
    `;
    const watermarkBuffer = Buffer.from(watermarkSvg);
    const watermarkedImageBuffer = await sharp(imageBuffer)
      .composite([{
        input: watermarkBuffer,
        gravity: 'south',
      }, ])
      .toBuffer();

    // --- Step 5: Upload Image to Google Cloud Storage ---
    const folder = isProduction ? 'images' : 'dev-images';
    const fileName = `${folder}/sntnz-chapter-${chapterHash}.png`;
    const file = bucket.file(fileName);

    await file.save(watermarkedImageBuffer, {
      metadata: { contentType: 'image/png' },
      resumable: false,
    });

    const publicUrl = file.publicUrl();
    logger.info({ publicUrl }, '[image] Successfully uploaded to GCS');
    return publicUrl;

  } catch (err) {
    logger.error({ err: err }, '[image] Full image generation pipeline failed');
    return null;
  }
}

module.exports = {
  initBots,
  runBotSubmission,
  generateAndUploadImage,
  pushBotContext
};
