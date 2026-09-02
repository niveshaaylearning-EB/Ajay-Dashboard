export const TOKEN_KEY   = 'nia_auth_token';
export const REFRESH_KEY = 'nia_refresh_token';

export const getToken        = () => localStorage.getItem(TOKEN_KEY);
export const setToken        = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken      = () => localStorage.removeItem(TOKEN_KEY);
export const getRefreshToken = () => localStorage.getItem(REFRESH_KEY);
export const setRefreshToken = (t) => localStorage.setItem(REFRESH_KEY, t);
export const clearRefreshToken = () => localStorage.removeItem(REFRESH_KEY);

export const clearAllTokens = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
};

const _decodePayload = (t) => {
  try { return JSON.parse(atob(t.split('.')[1])); } catch { return null; }
};

export const isLoggedIn = () => {
  const t = getToken();
  if (!t) return false;
  const payload = _decodePayload(t);
  if (!payload?.exp) return false;
  return Date.now() < payload.exp * 1000;
};

export const getEmail = () => {
  const t = getToken();
  if (!t) return null;
  return _decodePayload(t)?.sub ?? null;
};

export const getFirstName = () => {
  const t = getToken();
  if (!t) return null;
  const payload = _decodePayload(t);
  if (payload?.fn) return payload.fn;
  // Fall back to deriving name from email
  const email = payload?.sub;
  if (!email) return null;
  const part = email.split('@')[0].split(/[._-]/)[0];
  return part.charAt(0).toUpperCase() + part.slice(1);
};

// Single source of truth for the frontend's admin/edit allowlist — matches
// backend/common/admin.py's ADMIN_EMAILS on the server side.
export const ADMIN_EMAILS = new Set([
  'jay.chaudhari@niveshaay.com',
  'nukul.madaan@niveshaay.com',
  'nakshatra.rathi@niveshaay.com',
]);

export const isAdmin = () => {
  const email = getEmail();
  if (!email) return false;
  return ADMIN_EMAILS.has(email.toLowerCase().trim());
};
