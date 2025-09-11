/**
 * ============================================================================
 * --- Social Media Posting (social.js) ---
 * ============================================================================
 *
 * This module is responsible for all interactions with external social media platforms.
 * It provides a unified interface to cross-post content (text and images) to
 * X (formerly Twitter), Instagram, and Facebook Pages.
 *
 * Responsibilities:
 * - Initialize the Twitter API client.
 * - Manage the long-lived user access token for the Facebook/Instagram Graph API,
 * including a mechanism to refresh it automatically before it expires.
 * - Contain specific functions for posting to each platform, handling their
 * unique API requirements (e.g., media upload flows).
 * - Export a single `postEverywhere` function that orchestrates posting to all
 * configured platforms in parallel.
 */

const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');
const constants = require('./constants');
const logger = require('./logger');

let twitterClient;

// This runtime variable holds the Facebook long-lived token. It's used so the
// token can be refreshed in memory without needing a server restart.
let FB_LONG_TOKEN_RUNTIME;

// ============================================================================
// --- INITIALIZATION ---
// ============================================================================

/**
 * @summary Initializes the social media clients.
 * @description This function sets up the necessary API clients using credentials
 * from environment variables. It should be called once on server startup.
 */
function initSocial() {
  // Initialize the Twitter API v2 client with app-level credentials.
  twitterClient = new TwitterApi({
    appKey:       process.env.X_API_KEY,
    appSecret:    process.env.X_API_SECRET,
    accessToken:  process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });

  // Load the initial Facebook token from the environment.
  FB_LONG_TOKEN_RUNTIME = process.env.FB_LONG_TOKEN;

  logger.info('[social] Social media clients initialized.');
}

// ============================================================================
// --- POSTING MAIN FUNCTIONS ---
// ============================================================================

// --- X (TWITTER) POSTING ---
/**
 * @summary Posts content to X, with or without an image.
 * @param {string} fullText - The untruncated story text.
 * @param {string} shareableUrl - The URL to the story chunk.
 * @param {string|null} imageUrl - The public URL of the image to attach, or null.
 * @returns {Promise<void>}
 */
async function postToX(fullText, shareableUrl, imageUrl) {
  try {
    // --- 1. Format Caption for X ---
    const finalCaption = formatPostText(
      fullText,
      shareableUrl,
      constants.SOCIAL_X_HASHTAGS || '',
      constants.TWITTER_MAX_CHARS
    );

    // --- 2. Post to X (with or without image) ---
    if (imageUrl) {
      logger.info('[social] Starting post to X with image...');
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const mediaId = await twitterClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });

      await twitterClient.v2.tweet(finalCaption, { media: { media_ids: [mediaId] } });
      logger.info('[social] Successfully posted tweet with image to X.');
    } else {
      logger.info('[social] Starting text-only post to X...');
      await twitterClient.v2.tweet(finalCaption);
      logger.info('[social] Successfully posted text-only tweet to X.');
    }
  } catch (err) {
    // --- 3. Error Handling ---
    logger.error({ err }, '[social] Failed to post to X');
    throw err;
  }
}

// --- INSTAGRAM POSTING ---
/**
 * @summary Creates and publishes an Instagram photo post, using a fallback image if necessary.
 * @param {string} fullText - The untruncated story text.
 * @param {string} shareableUrl - The URL to the story chunk.
 * @param {string|null} imageUrl - The public URL of the image to post.
 * @returns {Promise<string>} The ID of the published media item.
 */
async function postToInstagram(fullText, shareableUrl, imageUrl) {
  try {
    // --- 1. Pre-flight Checks & Image Fallback ---
    let finalImageUrl = imageUrl;
    if (!finalImageUrl) {
      finalImageUrl = constants.DEFAULT_SOCIAL_IMAGE_URL;
      logger.info('[social] No image URL provided for Instagram; using default fallback image.');
    }

    await checkAndRefreshFbLongToken(7);
    const accessToken = FB_LONG_TOKEN_RUNTIME;
    const igUserId = process.env.IG_USER_ID;
    if (!accessToken || !igUserId) throw new Error('IG posting is not configured in .env');

    // --- 2. Format Caption ---
    const finalCaption = formatPostText(
      fullText,
      shareableUrl,
      constants.SOCIAL_HASHTAGS || '',
      constants.IG_MAX_CHARS
    );

    // --- 3. Post to Instagram (2-Step Process) ---
    logger.info('[social] Starting post to Instagram...');

    // Step 3a: Create the media container.
    const createResponse = await graphPost(
      `https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/${igUserId}/media`,
      { image_url: finalImageUrl, caption: finalCaption, access_token: accessToken }
    );
    const creationId = createResponse?.id;
    if (!creationId) throw new Error('IG API: No creation_id was returned.');

    // Step 3b: Publish the container.
    const publishResponse = await graphPost(
      `https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/${igUserId}/media_publish`,
      { creation_id: creationId, access_token: accessToken }
    );
    const mediaId = publishResponse?.id;
    if (!mediaId) throw new Error('IG API: Media publish call returned no id.');

    logger.info({ mediaId }, '[social] Successfully posted to Instagram');
    return mediaId;
  } catch (err) {
    // --- 4. Error Handling ---
    logger.error({ err }, '[social] Failed to post to Instagram');
    throw err;
  }
}

// --- FACEBOOK PAGE POSTING ---
/**
 * @summary Posts content to a Facebook Page, with or without a photo.
 * @param {string} fullText - The untruncated story text.
 * @param {string} shareableUrl - The URL to the story chunk.
 * @param {string|null} imageUrl - The public URL of the image, or null.
 * @returns {Promise<string>} The ID of the created Facebook post.
 */
async function postToFacebookPage(fullText, shareableUrl, imageUrl) {
  try {
    // --- 1. Pre-flight Checks ---
    const pageId = process.env.FB_PAGE_ID;
    const pageToken = process.env.FB_PAGE_TOKEN;
    if (!pageId || !pageToken) throw new Error('Facebook Page posting is not configured in .env');

    // --- 2. Format Caption ---
    const finalCaption = formatPostText(
      fullText,
      shareableUrl,
      constants.SOCIAL_HASHTAGS || '',
      constants.IG_MAX_CHARS
    );

    // --- 3. Post to Facebook Page (Photo or Text) ---
    let response;
    if (imageUrl) {
      logger.info('[social] Starting photo post to Facebook Page...');
      response = await graphPost(
        `https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/${pageId}/photos`,
        { url: imageUrl, message: finalCaption, access_token: pageToken }
      );
    } else {
      logger.info('[social] Starting text-only post to Facebook Page...');
      response = await graphPost(
        `https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/${pageId}/feed`,
        { message: finalCaption, access_token: pageToken }
      );
    }

    // --- 4. Finalize and Log ---
    const postId = response?.post_id || response?.id;
    if (!postId) throw new Error('FB Page API: Post returned no id.');

    logger.info({ postId }, '[social] Successfully posted to Facebook Page');
    return postId;
  } catch(err) {
    // --- 5. Error Handling ---
    logger.error({ err }, '[social] Failed to post to Facebook Page');
    throw err;
  }
}

// ============================================================================
// --- HELPERS ---
// ============================================================================
// --- Graph API Helper Functions ---

/**
 * @summary A small helper to make POST requests to the Graph API.
 * @param {string} url - The fully qualified Graph API endpoint.
 * @param {Record<string,string>} params - A key-value map of parameters.
 * @returns {Promise<any>} The parsed JSON response from the API.
 * @throws {Error} Throws an error if the API response is not ok or contains an error object.
 */
async function graphPost(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    throw new Error(`[GraphPOST] ${res.status} ${JSON.stringify(json?.error || json)}`);
  }
  return json;
}

/**
 * @summary A small helper to make GET requests to the Graph API.
 * @param {string} url - The base URL for the API endpoint.
 * @param {Record<string,string>} params - A key-value map of query parameters.
 * @returns {Promise<any>} The parsed JSON response from the API.
 */
async function graphGet(url, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    throw new Error(`[GraphGET] ${res.status} ${JSON.stringify(json?.error || json)}`);
  }
  return json;
}


// --- Token Management ---

/**
 * Persists/updates a single key in the local .env file.
 * NOTE: This is for local development convenience ONLY. In production, you
 * should manage secrets through your hosting provider's dashboard.
 * @param {string} key - The environment variable key (e.g., 'FB_LONG_TOKEN').
 * @param {string} val - The new value for the variable.
 */
function persistEnvVar(key, val) {
  try {
    const envPath = path.join(process.cwd(), '.env');
    let txt = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const line = `${key}="${val}"`;
    if (txt.includes(`${key}=`)) {
      txt = txt.replace(new RegExp(`^${key}=.*$`, 'm'), line);
    } else {
      txt = `${txt.trim()}\n${line}\n`;
    }
    fs.writeFileSync(envPath, txt, 'utf8');
    logger.info({ key }, '[auth] .env file updated');
  } catch (e) {
    logger.warn({ err: e }, '[auth] Failed to update .env file (non-fatal)');
  }
}

/**
 * Checks the validity and expiration of a Facebook access token using the `debug_token` endpoint.
 * @param {string} token - The access token to inspect.
 * @returns {Promise<{isValid:boolean, expiresAt:number}>} An object with validity and a UNIX timestamp of expiration.
 */
async function getTokenInfo(token) {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  const data = await graphGet(`https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/debug_token`, {
    input_token: token,
    access_token: `${appId}|${appSecret}`
  });
  return {
    isValid: !!data?.data?.is_valid,
    expiresAt: Number(data?.data?.expires_at || 0)
  };
}

/**
 * @summary Checks if the long-lived Facebook token is nearing expiry and refreshes it if needed.
 * @description Long-lived user tokens for Facebook/Instagram are valid for about 60 days.
 * This function should be run periodically (e.g., daily) to automatically exchange the
 * current token for a new one, effectively extending its life indefinitely.
 * @param {number} daysThreshold - The number of days remaining before a refresh is triggered.
 * @param {boolean} isProduction - Flag to determine if the .env file should be updated.
 */
async function checkAndRefreshFbLongToken(daysThreshold = 7, isProduction) {
  const token = FB_LONG_TOKEN_RUNTIME;
  if (!token) {
      logger.warn('[social] FB_LONG_TOKEN is not set. Skipping token refresh check.');
      return;
  }
  const info = await getTokenInfo(token);
  if (!info.isValid) throw new Error('Current FB long-lived token is invalid.');

  const daysLeft = ((info.expiresAt * 1000) - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysLeft > daysThreshold) {
    logger.info({ daysLeft: daysLeft.toFixed(1) }, '[auth] FB token OK');
    return;
  }

  logger.info({ daysLeft: daysLeft.toFixed(1) }, '[auth] FB token expiring, refreshing');
  const resp = await graphGet(`https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/oauth/access_token`, {
    grant_type: 'fb_exchange_token',
    client_id: process.env.FB_APP_ID,
    client_secret: process.env.FB_APP_SECRET,
    fb_exchange_token: token
  });

  if (!resp?.access_token) throw new Error('Token exchange API call returned no new access_token.');

  // Update the token in memory and, for dev, in the .env file.
  FB_LONG_TOKEN_RUNTIME = resp.access_token;
  if (!isProduction) {
    persistEnvVar('FB_LONG_TOKEN', resp.access_token);
  }

  const newInfo = await getTokenInfo(resp.access_token);
  const newDaysLeft = ((newInfo.expiresAt * 1000) - Date.now()) / (1000 * 60 * 60 * 24);
  logger.info({ daysRemaining: newDaysLeft.toFixed(1) }, '[auth] FB long token refreshed');
}

/**
 * @summary Formats and truncates text to fit within a platform's character limit.
 * @param {string} fullText - The original, untruncated story text.
 * @param {string} shareableUrl - The URL to the story chunk.
 * @param {string} hashtags - The string of hashtags to append.
 * @param {number} maxLength - The maximum character limit for the platform (e.g., 280 for X).
 * @returns {string} The final, formatted text for the post.
 */
function formatPostText(fullText, shareableUrl, hashtags, maxLength) {
  const readMoreBoilerplate = `...\n\nRead more at:`;

  // Calculate the length of all non-story components
  const boilerplateLength = readMoreBoilerplate.length;
  const hashtagsLength = hashtags.length;
  const urlLength = shareableUrl.length;

  // Account for the newlines that join the parts
  const separatorsLength = 4;

  const overhead = boilerplateLength + urlLength + hashtagsLength + separatorsLength;
  const availableTextLength = maxLength - overhead;

  let storyText;
  if (fullText.length > availableTextLength) {
    // Truncate and find the last space to avoid cutting a word in half
    const truncated = fullText.substring(0, availableTextLength);
    const lastSpace = truncated.lastIndexOf(' ');
    storyText = (lastSpace > 0) ? truncated.substring(0, lastSpace) : truncated;
  } else {
    storyText = fullText;
  }

  // Assemble the final text
  return `${storyText}${readMoreBoilerplate}\n${shareableUrl}\n\n${hashtags}`;
}

// ============================================================================
// --- ORCHESTRATION ---
// ============================================================================

/**
 * @summary Posts content to all configured social media platforms. Skips all posts if no image is provided.
 * @param {string} fullText - The untruncated story text.
 * @param {string} shareableUrl - The URL to the story chunk.
 * @param {string|null} imageUrl - The public URL of the image to post. If null, all posting is skipped.
 * @returns {Promise<void>}
 */
async function postEverywhere(fullText, shareableUrl, imageUrl) {
  // --- Pre-flight Check ---
  // If no image URL is provided, skip all social media posts as per the requirement.
  if (!imageUrl) {
    logger.info('[social] No image URL provided. Skipping all social media posts.');
    return;
  }

  // --- Orchestrate Posts ---
  // If an image URL exists, proceed with posting to all platforms in parallel.
  const jobs = [
    postToInstagram(fullText, shareableUrl, imageUrl).catch(e => logger.error({ err: e }, '[social] Instagram post failed')),
    postToFacebookPage(fullText, shareableUrl, imageUrl).catch(e => logger.error({ err: e }, '[social] Facebook Page post failed')),
    postToX(fullText, shareableUrl, imageUrl).catch(e => logger.error({ err: e }, '[social] X post failed')),
  ];

  await Promise.allSettled(jobs);
  logger.info('[social] Cross-posting attempts finished.');
}


module.exports = {
  initSocial,
  postEverywhere,
  checkAndRefreshFbLongToken,
};
