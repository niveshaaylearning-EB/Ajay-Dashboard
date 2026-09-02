// Dark/light theme state for the webportal app. In local dev this app is
// loaded in an iframe from a different origin than the main app, so it can't
// read the parent's localStorage -- same constraint as the auth token (see
// api/base.js getAuthToken). We mirror that pattern: prefer the `theme` URL
// query param the parent sets on the iframe src, falling back to this app's
// own localStorage for same-origin/standalone use.
const THEME_KEY = 'nia_theme';

const getStoredTheme = () => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return (v === 'light' || v === 'dark') ? v : null;
  } catch { return null; }
};

// IMPORTANT: localStorage must win once it holds a value. The `theme` URL
// param is only ever set once, at the moment the parent app built this
// iframe's src -- it never updates again for the iframe's whole lifetime.
// If it were consulted on every call (as it used to be), every toggle click
// after the very first would re-derive "current theme" from that stale URL
// value instead of from what's actually on screen, so the toggle would
// recompute the same target theme forever and appear to stop working after
// one click. The URL param is only meant to seed the very first load.
export const getTheme = () => {
  const stored = getStoredTheme();
  if (stored) return stored;
  const fromUrl = new URLSearchParams(window.location.search).get('theme');
  if (fromUrl === 'light' || fromUrl === 'dark') return fromUrl;
  return 'dark';
};

export const THEME_SYNC_TYPE = 'nia-theme-sync';

export const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
};

// `fromParent` is true when this call originated from a postMessage sent by
// the outer app (see main.jsx's listener) -- in that case we must not echo
// it back out, or the two windows would just ping-pong the same change.
export const setTheme = (theme, fromParent = false) => {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  applyTheme(theme);
  if (!fromParent && window.parent !== window) {
    window.parent.postMessage({ type: THEME_SYNC_TYPE, theme }, '*');
  }
};

export const toggleTheme = () => {
  const next = getTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
};

export const initTheme = () => {
  // Persist (not just apply) so the very first toggle click has a real
  // localStorage baseline to flip from, instead of re-deriving from the URL.
  setTheme(getTheme(), /* fromParent */ true);
};
