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
// --- X (TWITTER) POSTING ---
// ============================================================================

/**
 * @summary Posts a tweet with text and an image to the X API.
 * @description The X API v1 requires a two-step process for posting media:
 * 1. The image must be downloaded from its URL and uploaded to X's media endpoint
 * to get a `media_id`.
 * 2. A new tweet is created, referencing the `media_id` to attach the image.
 * @param {string} text - The text content of the tweet (max 280 characters).
 * @param {string} imageUrl - The public URL of the image to attach.
 * @returns {Promise<void>} Resolves on success, rejects on failure.
 */
// FILE: social.js

async function postToX(text, imageUrl) {
  try {
    logger.info('[social] Starting post to X...');

    // Smartly format text for X/Twitter
    const hashtags = constants.SOCIAL_X_HASHTAGS || '';
    const urlRegex = /(https?:\/\/[^\s]+)\s*$/; // Find URL at the end of the text
    const urlMatch = text.match(urlRegex);
    const url = urlMatch ? urlMatch[0].trim() : '';
    const storyText = urlMatch ? text.substring(0, urlMatch.index).trim() : text.trim();

    // Twitter URLs are shortened to 23 chars. Leave room for separators and hashtags.
    const maxStoryLength = 280 - (url ? 23 : 0) - hashtags.length - 4;

    let finalStoryText = storyText;
    if (storyText.length > maxStoryLength) {
      finalStoryText = storyText.substring(0, maxStoryLength).trim();
      // Add ellipsis if not already present from the source
      if (!finalStoryText.endsWith('...')) {
        finalStoryText += '...';
      }
    }

    // Assemble the final tweet content, ensuring no empty lines
    const tweetParts = [finalStoryText, url, hashtags].filter(Boolean);
    const finalText = tweetParts.join('\n\n');

    // Step 1: Download the image from its public URL into a buffer.
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    // Step 2: Upload the image buffer to the X API to get a media ID.
    const mediaId = await twitterClient.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });
    logger.info({ mediaId }, '[social] Image uploaded to X');

    // Step 3: Post the tweet, attaching the media ID.
    await twitterClient.v2.tweet(finalText, { media: { media_ids: [mediaId] } });
    logger.info('[social] Successfully posted tweet to X.');

  } catch (err) {
    // Log the full error for debugging purposes.
    logger.error({ err }, '[social] Failed to post to X');
    // Re-throw the error so the calling function knows about the failure.
    throw err;
  }
}

// ============================================================================
// --- FACEBOOK & INSTAGRAM GRAPH API ---
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


// --- Posting Functions ---

/**
 * @summary Creates and publishes an Instagram photo post.
 * @description The Instagram Graph API requires a two-step process:
 * 1. Create a "media container" by providing the public URL of the image.
 * 2. Publish the container using the `creation_id` from the first step.
 * @param {string} imageUrl - The public, direct URL of the image to post.
 * @param {string} caption - The caption text for the Instagram post.
 * @returns {Promise<string>} The ID of the published Instagram media item.
 */
async function postToInstagram(imageUrl, caption) {
  await checkAndRefreshFbLongToken(7);
  const accessToken = FB_LONG_TOKEN_RUNTIME;
  const igUserId = process.env.IG_USER_ID;
  if (!accessToken || !igUserId) throw new Error('IG posting is not configured in .env');

  const finalCaption = `${caption}\n\n${constants.SOCIAL_HASHTAGS || ''}`;

  // Step 1: Create the media container.
  const createResponse = await graphPost(
    `https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/${igUserId}/media`,
    { image_url: imageUrl, caption: finalCaption, access_token: accessToken }
  );
  const creationId = createResponse?.id;
  if (!creationId) throw new Error('IG API: No creation_id was returned.');

  // Step 2: Publish the container to the user's feed.
  const publishResponse = await graphPost(
    `https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/${igUserId}/media_publish`,
    { creation_id: creationId, access_token: accessToken }
  );
  const mediaId = publishResponse?.id;
  if (!mediaId) throw new Error('IG API: Media publish call returned no id.');
  logger.info({ mediaId }, '[social] Successfully posted to Instagram');
  return mediaId;
}

/**
 * @summary Posts a photo to a Facebook Page.
 * @description This function posts a photo with a message to the configured Facebook Page.
 * It uses a long-lived Page Access Token for authentication.
 * @param {string} imageUrl - The public URL of the image.
 * @param {string} message - The text content for the Facebook post.
 * @returns {Promise<string>} The ID of the created Facebook post.
 */
async function postToFacebookPage(imageUrl, message) {
  const pageId = process.env.FB_PAGE_ID;
  const pageToken = process.env.FB_PAGE_TOKEN;
  if (!pageId || !pageToken) throw new Error('Facebook Page posting is not configured in .env');

  const finalMessage = `${message}\n\n${constants.SOCIAL_HASHTAGS || ''}`;

  const response = await graphPost(
    `https://graph.facebook.com/${constants.FB_GRAPH_VERSION}/${pageId}/photos`,
    { url: imageUrl, message: finalMessage, access_token: pageToken }
  );
  const postId = response?.post_id || response?.id;
  if (!postId) throw new Error('FB Page API: Photo post returned no id.');
  logger.info({ postId }, '[social] Successfully posted to Facebook Page');
  return postId;
}

// ============================================================================
// --- ORCHESTRATION ---
// ============================================================================

/**
 * @summary Posts the same content to all configured social media platforms.
 * @description This function acts as a single entry point for cross-posting.
 * It invokes the individual posting functions for each platform in parallel.
 * It uses `Promise.allSettled` to ensure that a failure on one platform does
 * not prevent the others from attempting to post.
 * @param {string} text - The text content to be used as the tweet/caption/message.
 * @param {string} imageUrl - The public URL of the image to be posted.
 * @param {boolean} isProduction - Flag passed to token refresh logic.
 * @returns {Promise<void>} Resolves when all posting attempts are complete.
 */
async function postEverywhere(text, imageUrl, isProduction) {
  const jobs = [
    postToInstagram(imageUrl, text).catch(e => logger.error({ err: e }, '[social] Instagram post failed')),
    postToFacebookPage(imageUrl, text).catch(e => logger.error({ err: e }, '[social] Facebook Page post failed')),
    postToX(text, imageUrl).catch(e => logger.error({ err: e }, '[social] X post failed')),
  ];
  await Promise.allSettled(jobs);
  logger.info('[social] Cross-posting attempts finished.');
}

module.exports = {
  initSocial,
  postEverywhere,
  checkAndRefreshFbLongToken,
};
