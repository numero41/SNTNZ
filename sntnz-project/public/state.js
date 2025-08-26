export const state = {
  // Configuration and Data
  CFG: null,
  currentWordsArray: [],
  currentUser: { loggedIn: false, username: null },

  // UI State
  selectedStyles: { bold: false, italic: false, underline: false },

  // Technical State
  nextTickTimestamp: 0,
  feedbackTimeout: null,
  lastScrollHeight: 0,
  isLoadingMore: false,
  isBooting: true
};