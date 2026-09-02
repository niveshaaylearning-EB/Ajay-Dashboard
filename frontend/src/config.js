// When built and served by FastAPI on the same origin, use relative paths.
// When running the Vite dev server, the proxy in vite.config.js forwards
// /api and /auth to localhost:8000, so relative paths work there too.
// To override (e.g. point to a different machine), set VITE_API_URL in .env.
const base = import.meta.env.VITE_API_URL ?? '';

export const API_ROOT = base;
export const API_BASE = `${base}/api`;

// External dashboard URL for the Actual Portfolio page.
// Set this to the full URL of the new dashboard when it is ready.
// Example: 'https://your-dashboard.example.com'
export const ACTUAL_PORTFOLIO_DASHBOARD_URL = import.meta.env.VITE_ACTUAL_PORTFOLIO_URL ?? '';
