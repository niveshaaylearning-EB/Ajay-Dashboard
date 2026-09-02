// When served under /wp/ (cloud via nginx), API calls must use /wp/api/
// On localhost (port 8001 direct), /api/ is correct
const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
export const API_BASE = IS_LOCAL ? '/api' : '/wp/api';

// Auth token for admin-gated calls made from inside this iframe. Prefer the
// `t` query param the parent app (ActualPortfolio.jsx) puts on the iframe src
// -- in local dev this frontend is loaded from a different origin (port 8001)
// than the main app, so it can never read the main app's localStorage token.
// Falls back to localStorage for same-origin cases (e.g. developing this
// frontend standalone, outside the iframe).
export const getAuthToken = () => {
  const fromUrl = new URLSearchParams(window.location.search).get('t');
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem('nia_auth_token') || ''; } catch { return ''; }
};
