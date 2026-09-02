import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { initTheme, setTheme, THEME_SYNC_TYPE } from './utils/theme.js';

// Apply the saved/URL-provided theme before first paint to avoid a flash.
initTheme();

// Live-sync with the outer app's theme toggle: the `theme` URL param is only
// read once at load, so without this, toggling theme in the parent window
// while this iframe is already open would have no effect on it at all.
window.addEventListener('message', (e) => {
  if (e.data?.type === THEME_SYNC_TYPE && (e.data.theme === 'light' || e.data.theme === 'dark')) {
    setTheme(e.data.theme, /* fromParent */ true);
  }
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
