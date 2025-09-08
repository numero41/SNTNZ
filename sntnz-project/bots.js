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
const constants = require('./constants');
const imageStyles = constants.IMAGE_STYLES;
const logger = require('./logger');

// These variables will be initialized once by the `initBots` function.
let vertex_ai, storage, bucket, textModel;
let recentlyUsedStyles = []; // In-memory store to avoid repeating image styles too frequently.

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

  // Get a reference to the specific Gemini model we'll be using for text generation.
  textModel = vertex_ai.getGenerativeModel({ model: constants.GEMINI_MODEL });

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
  const botBufferMax = constants.CURRENT_TEXT_LENGTH * constants.BOT_LOOKBACK_MULTIPLIER;
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
 * @summary Generates and submits a word from the Gemini bot.
 * @description This is the main function for the text bot. It performs several steps:
 * 1. If a sentence is already queued, it submits the next word from the queue.
 * 2. If the queue is empty, it constructs a detailed prompt for the Gemini model,
 * including context, rules, and a list of banned words to ensure novelty.
 * 3. It calls the Gemini API to generate a new sentence.
 * 4. It validates the generated sentence against multiple criteria (length, banned words, etc.).
 * 5. If valid, it splits the sentence into a queue of words and submits the first one.
 * @param {object} state - The current state of the game needed for the bot's decision.
 * @returns {Promise<{botQueue: string[]}>} An object containing the updated bot queue.
 */
async function runBotSubmission(state) {
  const { liveWords, currentText, botContext, profanityFilter, getCompositeKey, broadcastLiveFeed } = state;
  let { botQueue } = state; // Make a mutable copy of the queue

  // --- Step 1: Use a queued word if available ---
  if (botQueue.length > 0) {
    const plannedWord = botQueue.shift(); // Take the next word from the queue
    const botWordData = {
      word: plannedWord,
      styles: { bold: false, italic: false, underline: false, newline: false }
    };
    const compositeKey = getCompositeKey(botWordData);
    // Submit the word only if it hasn't been submitted by someone else already.
    if (!liveWords.has(compositeKey)) {
        liveWords.set(compositeKey, {
            ...botWordData,
            submitterId: 'sntnz_bot',
            submitterName: constants.BOT_NAME,
            ts: Date.now(),
            votes: new Map([['sntnz_bot', 1]]) // The bot automatically "upvotes" its own word.
        });
    }
    broadcastLiveFeed();
    return { botQueue }; // Return the modified queue
  }

  // --- Step 2: Construct the Prompt if the queue is empty ---
  const allWords = currentText.map(w => w.word);
  const recentWords = allWords.slice(-75).map(w => w.toLowerCase().replace(/[.,!?;:…]+$/u, ''));
  const offensiveWords = allWords.filter(w => profanityFilter.check(w));
  const extraBanned = (process.env.EXTRA_BANNED_WORDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  let banPool = [...new Set([...recentWords, ...offensiveWords, ...extraBanned, 'please', 'pls', 'plz'])];
  banPool = banPool.filter(word => !constants.BOT_STOP_WORDS.includes(word.toLowerCase()));
  const banListForPrompt = `[${banPool.join(', ')}]`;

  const buildPrompt = (violationNote = "") => `
      You are a master storyteller and a painter of words, weaving a forever-living novel.
      Your primary purpose is to generate text with profound visual richness, as each sentence is a prompt for a unique piece of generated art.
      You will write EXACTLY ONE complete sentence.

      **YOUR FIRST PRIORITY IS THIS CRITICAL RULE:**
      - **IF** the "Context" text below ends with an incomplete sentence (no period, question mark, or exclamation point), your response **MUST** be only the words that complete that sentence.
      - **ELSE** (if the sentence is complete), you will write a new, complete sentence that continues the story.
      ${violationNote}

      Hard rules:
      1) Length: ${constants.BOT_SENTENCE_MIN_WORDS}–${constants.BOT_SENTENCE_MAX_WORDS} words.
      2) Do NOT use any of these recently used words: ${banListForPrompt}
      3) **Cinematic Lens:** Introduce a novel angle by dramatically shifting the scale or focus.
      4) Do not repeat words or phrases within your new sentence.
      5) **Composition over Description:** Build a single, focused scene using potent nouns and active verbs.
      6) Avoid starting new sentences with mundane words like "A", "The", "It", or "There".
      7) **Sensory Richness:** Your sentence must evoke at least two senses.
      8) Style and themes: Blend classical wayfaring and surrealism with themes of exploration, technologies, and journeys.

      Context (recent excerpt):
      "${botContext.join(' ')}"

      IMPORTANT:
      - You must follow all rules perfectly.
      - Output ONLY the one sentence. No explanations.
    `.trim();

  // --- Step 3: Define Validation Logic ---
  const normalizeSentence = s => s.toLowerCase().replace(/[“”"‘’'`]+/g, '').replace(/[^\p{L}\p{N}\s.!?-]/gu, '').trim();
  const wordCount = s => (s.trim().match(/\S+/g) || []).length;
  const endsWithPunctuation = s => /[.!?]$/.test(s.trim());

  const isValidSentence = (s) => {
    if (typeof s !== 'string' || s.trim() === '') return false;
    const wc = wordCount(s);
    if (wc < constants.BOT_SENTENCE_MIN_WORDS || wc > constants.BOT_SENTENCE_MAX_WORDS) return false;
    if (!endsWithPunctuation(s)) return false;
    const tokens = s.toLowerCase().replace(/[.!?]/g, '').split(/\s+/);
    if (tokens.some(t => banPool.includes(t))) return false;
    // Check for repeated words (excluding common stop words)
    const contentWords = tokens.filter(t => !constants.BOT_STOP_WORDS.includes(t));
    if (new Set(contentWords).size !== contentWords.length) return false;
    return true;
  };


  // --- Step 4: Call Gemini API and Validate the Response ---
  let sentence = '';
  try {
    const AI_TIMEOUT_MS = Number(constants.AI_TIMEOUT_MS || 25000);
    const withTimeout = (p, ms = AI_TIMEOUT_MS) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

    const generateOnce = async (prompt) => {
      const result = await withTimeout(textModel.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 5000, temperature: 0.5, topP: 0.8, topK: 40 },
      }));
      const parts = result?.response?.candidates?.[0]?.content?.parts || [];
      const rawText = parts.map(p => p.text).join(" ").trim();
      logger.debug({ rawText }, '[bot] RAW AI OUTPUT');
      const match = rawText.match(/^[\s\S]*?[.!?](?=\s|$)/); // Extract the first full sentence.
      return match ? match[0] : rawText;
    };

    // First attempt
    sentence = await generateOnce(buildPrompt());
    // If first attempt fails validation, retry with a note asking for safer content.
    if (!isValidSentence(sentence)) {
      const note = 'CRITICAL: Your previous response failed validation. Follow all rules strictly. Ensure the sentence is neutral, non-violent, and uses common vocabulary.';
      sentence = await generateOnce(buildPrompt(note));
    }

  } catch (e) {
    logger.warn({ err: e }, '[bot] model error (AI)');
    sentence = ''; // Ensure sentence is empty on error.
  }

  logger.info('[bot] Final generated sentence:', sentence);
  if (!isValidSentence(sentence)) {
      logger.info({ sentence }, '[bot] Final generated sentence');
      return { botQueue }; // Return unchanged queue on failure
  }

  // --- Step 5: Update Bot Memory and Submit the First Word ---
  // Add major nouns from the new sentence to the theme cache to avoid repetition.
  const majorNouns = sentence.split(' ').filter(w => w.length > 4 && /^[a-z]/.test(w));
  globalThis.__recentBotThemes.push(...majorNouns.map(n => n.toLowerCase().replace(/[.,!?;:…]+$/u, '')));
  if (globalThis.__recentBotThemes.length > 10) {
    globalThis.__recentBotThemes = globalThis.__recentBotThemes.slice(-10);
  }

  // The new valid sentence becomes the bot's queue.
  botQueue = sentence.trim().split(/\s+/);
  let firstWord = (botQueue.length > 0) ? botQueue.shift() : '';
  if (!firstWord) return { botQueue }; // Safety check

  // Capitalize the first word if it starts a new sentence.
  const lastWord = currentText.length ? currentText[currentText.length - 1].word : '';
  if (!lastWord || /[.!?]$/.test(lastWord)) {
    firstWord = firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
  }

  const botWordData = {
    word: firstWord,
    styles: { bold: false, italic: false, underline: false, newline: false }
  };
  const compositeKey = getCompositeKey(botWordData);
  if (!liveWords.has(compositeKey)) {
      liveWords.set(compositeKey, {
          ...botWordData,
          submitterId: 'sntnz_bot',
          submitterName: constants.BOT_NAME,
          ts: Date.now(),
          votes: new Map([['sntnz_bot', 1]])
      });
  }

  broadcastLiveFeed();
  return { botQueue }; // Return the new queue
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
    let availableStyles = imageStyles.filter(style => !recentlyUsedStyles.includes(style.name));
    if (availableStyles.length === 0) {
      logger.info('[image] All styles used recently. Resetting pool.');
      recentlyUsedStyles = [];
      availableStyles = imageStyles;
    }
    const selectedStyle = availableStyles[Math.floor(Math.random() * availableStyles.length)];
    recentlyUsedStyles.push(selectedStyle.name);
    if (recentlyUsedStyles.length > 4) recentlyUsedStyles.shift();
    logger.info({ style: selectedStyle.name }, '[image] Selected style');

    // --- Step 2: Summarize Text with Gemini for a better visual prompt ---
    let summarized = text.trim();
    try {
      const summarizationPrompt = `
        Summarize the following text into a single, concise paragraph of about 40-70 words
        that visually describes the scene. Focus on concrete objects, colors, and actions.
        Omit abstract concepts, dialogue, and character names. Output only the description.
        TEXT: "${summarized}"`.trim();
      const result = await textModel.generateContent({
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
      `- Quality: fine art premium grade.`,
      ``,
      `CONSTRAINTS:`,
      `- the image must not contain any text, logos, watermarks, or people.`,
      `- the image must be highly detailed and fill the entire square canvas.`,
    ].join('\n');
    logger.info('[image] Final Imagen prompt prepared.');


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


    // --- Step 5: Upload Image to Google Cloud Storage ---
    const imageBuffer = Buffer.from(imageDataBase64, 'base64');
    const folder = isProduction ? 'images' : 'dev-images';
    const fileName = `${folder}/sntnz-chunk-${Date.now()}.png`;
    const file = bucket.file(fileName);

    await file.save(imageBuffer, {
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
