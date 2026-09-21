import { API_BASE } from '../config.js';

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

// Permanent base admins — matches backend/common/admin.py's
// _BASE_ADMIN_EMAILS. Anyone promoted later isn't in this static list; their
// status is fetched from the server (below) since the browser has no other
// way to learn about a promotion that happened after the page was built.
export const ADMIN_EMAILS = new Set([
  'jay.chaudhari@niveshaay.com',
  'nukul.madaan@niveshaay.com',
  'nakshatra.rathi@niveshaay.com',
]);

const PROMOTED_ADMIN_KEY = 'nia_promoted_admin';
export const ADMIN_STATUS_CHANGE_EVENT = 'nia-admin-status-change';

export const isAdmin = () => {
  const email = getEmail();
  if (!email) return false;
  if (ADMIN_EMAILS.has(email.toLowerCase().trim())) return true;
  return localStorage.getItem(PROMOTED_ADMIN_KEY) === email.toLowerCase().trim();
};

// Asks the backend whether the current user has been promoted to admin, and
// caches the answer (keyed by email, so switching accounts on the same
// browser can't leak one user's promotion into another's session). Fire
// this on app mount / login so promoted admins see their real access without
// waiting for a frontend redeploy.
export const syncAdminStatus = async () => {
  const email = getEmail();
  if (!email) return;
  try {
    const res = await fetch(`${API_BASE}/me`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return;
    const data = await res.json();
    const before = isAdmin();
    if (data.is_admin) {
      localStorage.setItem(PROMOTED_ADMIN_KEY, email.toLowerCase().trim());
    } else if (localStorage.getItem(PROMOTED_ADMIN_KEY) === email.toLowerCase().trim()) {
      localStorage.removeItem(PROMOTED_ADMIN_KEY);
    }
    if (isAdmin() !== before) {
      window.dispatchEvent(new Event(ADMIN_STATUS_CHANGE_EVENT));
    }
  } catch {
    // Network hiccup -- keep whatever was cached, not worth surfacing.
  }
};
