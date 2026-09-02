import React from 'react'
import ReactDOM from 'react-dom/client'
import axios from 'axios'
import App from './App.jsx'
import './index.css'
import { getToken, setToken, clearAllTokens, getRefreshToken, setRefreshToken } from './utils/auth.js'
import { initTheme } from './utils/theme.js'

// Apply the saved theme before first paint to avoid a flash of the wrong theme.
initTheme();

// Attach JWT to every outbound request
axios.interceptors.request.use(config => {
  const token = getToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// On 401, try refresh token once before redirecting to login
let _refreshing = null;
axios.interceptors.response.use(
  res => res,
  async err => {
    const original = err.config;
    // Never intercept 401/428 from auth endpoints — those are meaningful errors for the login page
    const isAuthEndpoint = /\/auth\/(login|register|forgot-password|reset-password)/.test(original?.url || '');
    if (err.response?.status === 401 && !original._retry && !isAuthEndpoint) {
      const refreshToken = getRefreshToken();
      if (refreshToken) {
        original._retry = true;
        if (!_refreshing) {
          _refreshing = axios.post('/auth/refresh', { refresh_token: refreshToken })
            .then(r => {
              setToken(r.data.token);
              if (r.data.refresh_token) setRefreshToken(r.data.refresh_token);
              return r.data.token;
            })
            .catch(() => {
              clearAllTokens();
              window.location.href = '/login';
              return null;
            })
            .finally(() => { _refreshing = null; });
        }
        const newToken = await _refreshing;
        if (newToken) {
          original.headers = original.headers || {};
          original.headers['Authorization'] = `Bearer ${newToken}`;
          return axios(original);
        }
      } else {
        clearAllTokens();
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
