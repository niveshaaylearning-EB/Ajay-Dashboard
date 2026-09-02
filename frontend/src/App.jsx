import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Link, useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import { Sun, Moon } from 'lucide-react';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import { clearAllTokens, getEmail, isAdmin, getFirstName, isLoggedIn } from './utils/auth.js';
import { getTheme, toggleTheme, THEME_CHANGE_EVENT } from './utils/theme.js';
import { API_ROOT } from './config.js';

function ThemeToggle() {
  const [theme, setThemeState] = useState(getTheme());
  useEffect(() => {
    // Keeps the icon correct even when the theme changes because the toggle
    // inside the embedded Actual Portfolio iframe was clicked, not this one.
    const onChange = (e) => setThemeState(e.detail);
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
  }, []);
  return (
    <button
      onClick={() => setThemeState(toggleTheme())}
      className="btn btn-secondary"
      style={{ fontSize: '0.78rem', padding: '6px 10px' }}
      title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      aria-label="Toggle color theme"
    >
      {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
    </button>
  );
}


const HomePage            = lazy(() => import('./pages/HomePage'));
const ActualPortfolio     = lazy(() => import('./pages/ActualPortfolio'));
const SimulatorPortfolio  = lazy(() => import('./pages/SimulatorPortfolio'));
const ScreenerData        = lazy(() => import('./pages/ScreenerData'));
const BasketComparison    = lazy(() => import('./pages/BasketComparison'));
const LoginPage           = lazy(() => import('./pages/LoginPage'));
const AdminBacklog        = lazy(() => import('./pages/AdminBacklog'));
const AdminSimulators     = lazy(() => import('./pages/AdminSimulators'));
const ResultCalendar      = lazy(() => import('./pages/ResultCalendar'));
const RebalanceAlertPage  = lazy(() => import('./pages/RebalanceAlertPage'));
const ApprovedEmailsPage  = lazy(() => import('./pages/ApprovedEmailsPage'));

function PageLoader() {
  return (
    <div style={{ textAlign: 'center', marginTop: '4rem' }}>
      <h3 className="text-gradient">Loading...</h3>
    </div>
  );
}

function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const loggedIn = isLoggedIn();
  const email    = getEmail();

  // Check every 60 s — redirect to login if the midnight-expiry JWT has elapsed
  useEffect(() => {
    const id = setInterval(() => {
      if (!isLoggedIn() && location.pathname !== '/login') {
        clearAllTokens();
        navigate('/login', { replace: true });
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [location.pathname, navigate]);

  async function handleLogout() {
    try {
      await axios.post(`${API_ROOT}/auth/logout`);
    } catch (_) {
      // best-effort — still clear the token even if the call fails
    }
    clearAllTokens();
    navigate('/login', { replace: true });
  }

  if (location.pathname === '/login') return null;

  return (
    <header className="main-header">
      <Link to="/" style={{ textDecoration: 'none' }}>
        <h1 className="text-gradient" style={{ margin: 0, fontSize: '1.8rem' }}>Niveshaay Equity Basket Tracker</h1>
      </Link>
      <nav className="main-header-nav">
        <Link to="/" className="btn btn-secondary">Home</Link>

        {loggedIn && (
          <Link
            to="/calendar"
            className="btn btn-secondary"
            style={{ fontSize: '0.78rem', padding: '6px 12px' }}
          >
            Calendar
          </Link>
        )}
        {loggedIn && isAdmin() && (
          <Link
            to="/admin"
            className="btn btn-secondary"
            style={{ fontSize: '0.78rem', padding: '6px 12px', color: 'var(--accent-amber)', borderColor: 'rgba(245,158,11,0.4)' }}
          >
            Backlog
          </Link>
        )}
        {loggedIn && (getEmail() || '').toLowerCase().trim() === 'jay.chaudhari@niveshaay.com' && (
          <Link
            to="/admin/simulators"
            className="btn btn-secondary"
            style={{ fontSize: '0.78rem', padding: '6px 12px', color: 'var(--accent-amber)', borderColor: 'rgba(245,158,11,0.4)' }}
          >
            Users' Sims
          </Link>
        )}
        <ThemeToggle />
        {loggedIn && (
          <>
            {email && (
              <span style={{
                fontSize: '0.75rem', color: 'var(--text-muted)',
                background: 'var(--hover-overlay)', border: '1px solid var(--panel-border)',
                borderRadius: '20px', padding: '4px 10px',
              }}>
                {getFirstName()}
              </span>
            )}
            <button
              onClick={handleLogout}
              className="btn btn-secondary"
              style={{ fontSize: '0.78rem', padding: '6px 12px' }}
            >
              Logout
            </button>
          </>
        )}
      </nav>
    </header>
  );
}

function App() {
  return (
    <BrowserRouter>
      <div className="container">
        <Header />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/rebalance-alerts" element={
              <ProtectedRoute><RebalanceAlertPage /></ProtectedRoute>
            } />
            <Route path="/approved-emails" element={
              <ProtectedRoute adminOnly><ApprovedEmailsPage /></ProtectedRoute>
            } />
            <Route path="/" element={
              <ProtectedRoute><HomePage /></ProtectedRoute>
            } />
            <Route path="/actual" element={
              <ProtectedRoute><ActualPortfolio /></ProtectedRoute>
            } />
            <Route path="/simulator" element={
              <ProtectedRoute><SimulatorPortfolio /></ProtectedRoute>
            } />
            <Route path="/screener" element={
              <ProtectedRoute><ScreenerData /></ProtectedRoute>
            } />
            <Route path="/comparison" element={
              <ProtectedRoute><BasketComparison /></ProtectedRoute>
            } />
            <Route path="/calendar" element={
              <ProtectedRoute><ResultCalendar /></ProtectedRoute>
            } />
            <Route path="/admin" element={
              <ProtectedRoute adminOnly><AdminBacklog /></ProtectedRoute>
            } />
            <Route path="/admin/simulators" element={
              <ProtectedRoute allowedEmails={['jay.chaudhari@niveshaay.com']}><AdminSimulators /></ProtectedRoute>
            } />
          </Routes>
        </Suspense>
      </div>
    </BrowserRouter>
  );
}

export default App;
