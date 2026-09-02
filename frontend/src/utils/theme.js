// Shared dark/light theme state. Persisted so it survives reloads, and applied
// via a `data-theme` attribute on <html> so plain CSS variables (index.css)
// drive the actual re-theming -- this module only decides which theme is active.
export const THEME_KEY = 'nia_theme';

export const getTheme = () => {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
};

export const THEME_CHANGE_EVENT = 'nia-theme-change';

export const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
};

export const setTheme = (theme) => {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  applyTheme(theme);
  // Notify anything mounted in this session (e.g. the Actual Portfolio iframe
  // wrapper) that the theme changed, so it can push a live update into the
  // iframe instead of relying on the (frozen at mount time) src URL param.
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
};

export const toggleTheme = () => {
  const next = getTheme() === 'light' ? 'dark' : 'light';
  setTheme(next);
  return next;
};

// Call once, as early as possible (before first paint) to avoid a flash of
// the wrong theme.
export const initTheme = () => {
  applyTheme(getTheme());
};
