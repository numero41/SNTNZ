/**
 * ============================================================================
 * --- Authentication & User Management (auth.js) ---
 * ============================================================================
 *
 * This module encapsulates all logic related to user authentication, sessions,
 * and user data management. It leverages Passport.js for Google OAuth 2.0
 * and express-session for managing user login state.
 *
 * Responsibilities:
 * - Configure and export the `express-session` middleware.
 * - Configure the Passport.js `GoogleStrategy` for authentication.
 * - Define user serialization (storing user ID in session) and deserialization
 * (retrieving user data from database using session ID).
 * - Create and export an Express router that handles all authentication and
 * user-related API endpoints (`/login`, `/logout`, `/api/user`, etc.).
 * - Provide middleware to protect routes and ensure users have set a username.
 */

const express = require('express');
const session = require('express-session');
const logger = require('./logger');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// Determine if the server is running in a production environment.
const isProduction = process.env.NODE_ENV === 'production';

// This variable will hold the reference to the MongoDB 'users' collection.
// It is passed in from server.js to avoid circular dependencies and global state.
let usersCollection;

// ============================================================================
// --- SESSION MIDDLEWARE CONFIGURATION ---
// ============================================================================

/**
 * @summary Configures and exports the `express-session` middleware.
 * @description This middleware is responsible for creating, managing, and persisting
 * user sessions via cookies.
 */
const sessionMiddleware = session({
  // A long, random string used to sign the session ID cookie, preventing tampering.
  // This should always be stored in an environment variable for security.
  secret: process.env.SESSION_SECRET || 'a-very-secret-key-for-development',

  // If `true`, the session will be saved back to the session store, even if
  // it wasn't modified. `false` is more efficient.
  resave: false,

  // If `true`, a session will be created for every visitor, even if they are
  // not logged in. `false` prevents empty session objects from being stored.
  saveUninitialized: false,

  // Configures the session cookie settings.
  cookie: {
    // `secure: true` ensures the cookie is only sent over HTTPS. This is
    // critical for production but must be `false` for local HTTP development.
    secure: isProduction
  }
});

// ============================================================================
// --- PASSPORT.JS STRATEGY & SERIALIZATION ---
// ============================================================================

/**
 * @summary Initializes the Passport.js authentication strategies and serialization.
 * @description This function sets up the entire authentication flow. It needs access
 * to the `users` collection from the database to find or create user records.
 * @param {Db.Collection} collection - The MongoDB collection for users.
 */
function initializeAuth(collection) {
  usersCollection = collection;

  /**
   * Passport Strategy: Google OAuth 2.0
   * ------------------------------------
   * This configures how Passport authenticates users via their Google account.
   * When a user attempts to log in, they are redirected to Google. After they
   * consent, Google redirects them back to our `/auth/google/callback` URL
   * with a profile and access token. This function then runs.
   */
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback" // This must match the authorized redirect URI in your Google Cloud project.
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if a user with this Google ID already exists in our database.
        let user = await usersCollection.findOne({ googleId: profile.id });

        if (user) {
          // If the user exists, we're done. Pass the user object to Passport.
          return done(null, user);
        } else {
          // If the user does not exist, create a new user record in the database.
          const newUser = {
            googleId: profile.id,
            googleProfile: profile, // Store the raw profile from Google.
            username: null,         // The username is initially null; the user must set it.
          };
          await usersCollection.insertOne(newUser);
          logger.info({ googleId: profile.id }, '[auth] New user created');
          // Pass the newly created user object to Passport.
          return done(null, newUser);
        }
      } catch (err) {
        // If an error occurs (e.g., database connection issue), pass the error to Passport.
        return done(err);
      }
    }
  ));

  /**
   * `passport.serializeUser`
   * ------------------------
   * This function is called after a user successfully authenticates. Its job is to
   * decide what information about the user should be stored in the session cookie.
   * We only store the unique `googleId` to keep the session data small and secure.
   */
  passport.serializeUser((user, done) => {
    done(null, user.googleId);
  });

  /**
   * `passport.deserializeUser`
   * --------------------------
   * This function is called on every subsequent request from an authenticated user.
   * It takes the `googleId` we stored in the session and uses it to retrieve the
   * full user object from the database. This object is then attached to the
   * request as `req.user`, making it available throughout our application.
   */
  passport.deserializeUser(async (googleId, done) => {
    try {
      const user = await usersCollection.findOne({ googleId: googleId });
      // If a user is found, pass it along. If not, pass `null`.
      done(null, user || null);
    } catch (err) {
      done(err);
    }
  });
}

// ============================================================================
// --- USERNAME VALIDATION & MIDDLEWARE ---
// ============================================================================

/**
 * @summary An Express middleware to ensure a logged-in user has set a username.
 * @description This function checks if a user is authenticated and has a non-null
 * `username`. If they don't, it redirects them to the page where they can set one.
 * This is used to protect parts of the application that require a display name.
 * @param {object} req - The Express request object.
 * @param {object} res - The Express response object.
 * @param {function} next - The next middleware function in the stack.
 */
function checkUsername(req, res, next) {
  // These paths should always be accessible, regardless of login state or username.
  const allowedPaths = ['/username.html', '/api/username', '/config', '/auth/google', '/logout'];
  if (allowedPaths.some(path => req.path.startsWith(path))) {
    return next();
  }

  // If the user is authenticated but has not set a username, redirect them.
  if (req.isAuthenticated() && !req.user.username) {
    return res.redirect('/username.html');
  }

  // Otherwise, the user is either not logged in (which is fine for public pages)
  // or is logged in and has a username. Proceed to the requested route.
  next();
}

// ============================================================================
// --- AUTHENTICATION & USER API ROUTER ---
// ============================================================================

/**
 * @summary Creates and configures an Express router for all auth-related endpoints.
 * @returns {express.Router} An Express router instance.
 */
function createAuthRouter() {
  const router = express.Router();

  // Apply the username check middleware to all routes handled by this router.
  router.use(checkUsername);

  // --- GOOGLE AUTHENTICATION ROUTES ---

  /**
   * GET /auth/google
   * ----------------
   * This is the initial step of the Google login process. When a user clicks
   * "Login with Google", they are sent to this endpoint. Passport then redirects
   * them to Google's consent screen to grant permission to our app.
   * `prompt: 'select_account'` ensures the user can choose between Google accounts.
   */
  router.get('/auth/google', passport.authenticate('google', {
    scope: ['profile'], // We request access to the user's basic profile information.
    prompt: 'select_account'
  }));

  /**
   * GET /auth/google/callback
   * -------------------------
   * After the user authenticates with Google, Google redirects them back to this
   * URL. The Passport middleware automatically handles the token exchange and
   * runs the `GoogleStrategy` function defined above to find or create the user.
   */
  router.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login.html' }), // If login fails, redirect them.
    (req, res) => {
      // After successful authentication, check if they need to set a username.
      if (req.user && !req.user.username) {
        res.redirect('/username.html');
      } else {
        // If they have a username, send them to the main application page.
        res.redirect('/');
      }
    }
  );

  // --- LOGOUT ROUTE ---

  /**
   * GET /logout
   * -----------
   * Logs the user out. `req.logout()` removes the `req.user` property.
   * `req.session.destroy()` completely removes the session from the store.
   * Finally, we clear the session cookie from the browser and redirect home.
   */
  router.get('/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie('connect.sid');
        res.redirect('/');
      });
    });
  });


  // --- USER API ROUTES ---

  /**
   * GET /api/user
   * -------------
   * A simple API endpoint for the client-side to fetch the current user's
   * login status and username. This is useful for updating the UI.
   */
  router.get('/api/user', (req, res) => {
    if (req.isAuthenticated()) {
      res.json({ username: req.user.username, loggedIn: true });
    } else {
      res.json({ username: null, loggedIn: false });
    }
  });

  /**
   * POST /api/username
   * ------------------
   * Allows a newly registered user to set their unique username after logging in.
   */
  router.post('/api/username', async (req, res) => {
    // Ensure user is logged in.
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: 'You must be logged in.' });
    }
    // Prevent users from changing their username once it's set.
    if (req.user.username) {
      return res.status(400).json({ message: 'Username has already been set.' });
    }

    const { username } = req.body;

    // --- Server-side validation ---
    if (!username || typeof username !== 'string' || username.length < 3 || username.length > 20) {
      return res.status(400).json({ message: 'Username must be 3-20 characters long.' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ message: 'Username can only contain letters, numbers, and underscores.' });
    }

    try {
      // Check for uniqueness in the database (case-insensitive).
      const existingUser = await usersCollection.findOne({ username: { $regex: `^${username}$`, $options: 'i' } });
      if (existingUser) {
        return res.status(409).json({ message: 'Username is already taken.' });
      }

      // If validation passes and the name is unique, update the user's document in the database.
      await usersCollection.updateOne(
        { googleId: req.user.googleId },
        { $set: { username: username } }
      );

      logger.info({ googleId: req.user.googleId, username }, '[auth] User set username');
      res.status(200).json({ message: 'Username saved successfully!' });
    } catch (err) {
        logger.error({ err }, '[auth] Error setting username');
        res.status(500).json({ message: 'Error saving username.' });
    }
  });

  /**
   * DELETE /api/user
   * ----------------
   * Allows a logged-in user to permanently delete their account and all associated data.
   */
  router.delete('/api/user', async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ message: 'You must be logged in to delete your account.' });
    }

    const { googleId } = req.user;
    try {
      // Remove the user's document from the 'users' collection.
      await usersCollection.deleteOne({ googleId: googleId });
      logger.info({ googleId }, '[auth] User account deleted');

      // Perform a full logout to clear their session and cookie.
      req.logout((err) => {
        if (err) logger.error({ err }, '[auth] Logout error during account deletion');
        req.session.destroy((err) => {
          if (err) {
            logger.error({ err }, '[auth] Session destruction error during account deletion');
            return res.status(500).json({ message: 'Error clearing session.' });
          }
          res.clearCookie('connect.sid');
          res.status(200).json({ message: 'Account deleted successfully.' });
        });
      });
    } catch (err) {
      logger.error({ err }, '[auth] Error during account deletion');
      res.status(500).json({ message: 'An internal error occurred while deleting the account.' });
    }
  });

  return router;
}


module.exports = {
  initializeAuth,
  createAuthRouter,
  sessionMiddleware,
};