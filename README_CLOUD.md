# Niveshaay Equity Basket Tracker — Cloud Deployment Guide

This guide details how to configure, build, and deploy the Niveshaay Equity Basket Tracker application on cloud environments (e.g., Render, AWS, Heroku, Fly.io, or in a Docker container).

---

## ── Environment Variables Configuration ──────────────────────────────────────

The application is structured to load configuration settings from standard environment variables. You can define these in a `.env` file in the `backend` folder during development or set them in your cloud provider's dashboard for production.

### Backend Configurations

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | The database connection URL. Supports SQLite, PostgreSQL, MySQL, etc. | `sqlite:///./portfolio.db` |
| `JWT_SECRET` | Secret key used to sign JWT auth tokens. **Change in production!** | `nia-perf-secret-change-in-prod-32x` |
| `ALLOWED_DOMAIN` | Restricted email domain allowed to log in. | `niveshaay.com` |
| `ADMIN_EMAIL` | Restricted email address designated as admin. | `jay.chaudhari@niveshaay.com` |
| `SPREADSHEET_ID` | Google Spreadsheet ID containing the source portfolio data. | `1eIw2QxtHX6b0iwhQvmlayKAAO7i97fYdMq7Fq6mToEk` |
| `CORS_ORIGINS` | Comma-separated list of allowed origins (CORS). Wildcard `*` disables credentials. | `*` (or `https://your-app.com`) |
| `SMTP_HOST` | Host for outgoing mail servers (used for OTP logins). | `smtp.office365.com` |
| `SMTP_PORT` | Port for SMTP (usually TLS on `587` or SSL on `465`). | `587` |
| `SMTP_USER` | SMTP username. | (None) |
| `SMTP_PASS` | SMTP password. | (None) |
| `SMTP_FROM` | Sender email address for outgoing OTP emails. | (Defaults to `SMTP_USER`) |

### Frontend Configurations

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `VITE_API_URL` | The absolute URL of the running backend server. | `""` (defaults to relative path / same origin) |
| `VITE_ACTUAL_PORTFOLIO_URL` | External dashboard URL for the Actual Portfolio page. | `""` |

---

## ── Production Build & Deployment Options ────────────────────────────────────

### Option A: Monorepo Deployment (FastAPI serves built React frontend)
This is the simplest hosting strategy. You build the React frontend static files, and the FastAPI backend automatically serves them. You only need to deploy **one** service.

1. **Build the Frontend**:
   Navigate to the `frontend` folder and build the assets:
   ```bash
   cd frontend
   npm install
   npm run build
   ```
   This will output the production bundle to `frontend/dist`.

2. **Run the Backend**:
   Run the uvicorn server. It will automatically detect `frontend/dist` and serve it at the root URL:
   ```bash
   cd backend
   # Activate virtual environment
   venv\Scripts\activate  # (Windows) or source venv/bin/activate (Linux)
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

3. **Deploy on Render / Heroku / Fly.io**:
   - Set **Build Command**: `cd frontend && npm install && npm run build && cd ../backend && pip install -r requirements.txt` (or let the platform run it).
   - Set **Start Command**: `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT`

---

### Option B: Decoupled Hosting (Frontend on CDN, Backend on Cloud VM/Container)
If you prefer hosting the frontend on a static CDN (Vercel, Netlify, AWS S3, Cloudflare Pages) and the backend separately (Render, Heroku, AWS ECS):

1. **Frontend Configuration & Build**:
   - Set the environment variable `VITE_API_URL` to your backend cloud URL (e.g. `https://nia-backend-api.onrender.com`).
   - Build the frontend (`npm run build`) and deploy `frontend/dist` to Netlify/Vercel.

2. **Backend Configuration**:
   - Set `CORS_ORIGINS` on the backend to your frontend URL (e.g. `https://nia-performance.netlify.app`) so that requests are not blocked by CORS policies.
   - Run the backend service on your server.
