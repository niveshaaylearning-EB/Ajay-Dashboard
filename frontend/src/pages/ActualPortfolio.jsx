import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getEmail, getToken, ADMIN_EMAILS } from '../utils/auth.js';
import { getTheme, setTheme, THEME_CHANGE_EVENT } from '../utils/theme.js';

const EDIT_ALLOWED = ADMIN_EMAILS;
const BAR_H = 44;

const IS_LOCAL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const WP_BASE  = IS_LOCAL
  ? `http://${window.location.hostname}:8101`
  : `${window.location.origin}/wp/`;
const WP_ORIGIN = IS_LOCAL ? `http://${window.location.hostname}:8101` : window.location.origin;
const THEME_SYNC_TYPE = 'nia-theme-sync';

export default function ActualPortfolio() {
  const navigate = useNavigate();
  const [headerBottom, setHeaderBottom] = useState(120);
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef(null);

  useEffect(() => {
    const header = document.querySelector('header');
    if (header) setHeaderBottom(Math.ceil(header.getBoundingClientRect().bottom));
  }, []);

  // Keep the embedded webportal iframe's theme live-synced with the outer
  // app: push our theme into it whenever it changes (rather than only at
  // iframe-load time, since the iframe's `src` never changes after mount),
  // and accept theme changes made via the toggle inside the iframe itself.
  useEffect(() => {
    const pushTheme = (theme) => {
      iframeRef.current?.contentWindow?.postMessage({ type: THEME_SYNC_TYPE, theme }, WP_ORIGIN);
    };
    const onOuterThemeChange = (e) => pushTheme(e.detail);
    const onMessage = (e) => {
      if (e.origin !== WP_ORIGIN) return;
      if (e.data?.type === THEME_SYNC_TYPE && (e.data.theme === 'light' || e.data.theme === 'dark')) {
        setTheme(e.data.theme);
      }
    };
    window.addEventListener(THEME_CHANGE_EVENT, onOuterThemeChange);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onOuterThemeChange);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  const iframeTop = headerBottom + BAR_H;
  const email     = getEmail() || '';
  const canEdit   = EDIT_ALLOWED.has(email);
  // Pass the auth token through the URL too, not just email/edit flags: in
  // local dev the iframe loads from a different origin (port 8001), so it
  // can't read the main app's localStorage token at all. Without this, admin
  // detection AND every authenticated upload inside the iframe silently fail
  // (empty Authorization header -> 403) even when the edit flag says "yes".
  const token = getToken() || '';
  const WEBPORTAL_URL = `${WP_BASE}?u=${encodeURIComponent(email)}&edit=${canEdit ? '1' : '0'}&t=${encodeURIComponent(token)}&theme=${getTheme()}`;

  return (
    <>
      {/* Placeholder so the container doesn't collapse */}
      <div style={{ height: `calc(100vh - ${headerBottom}px)` }} />

      {/* Thin sub-bar: sits between app header and iframe, no overlap */}
      <div style={{
        position: 'fixed',
        top: headerBottom,
        left: 0,
        width: '100vw',
        height: BAR_H,
        background: 'var(--bg-color)',
        borderBottom: '1px solid var(--panel-border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: '14px',
        zIndex: 100,
        boxSizing: 'border-box',
      }}>
        <button
          className="btn btn-secondary"
          onClick={() => navigate('/')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', fontSize: '0.82rem' }}
        >
          <ArrowLeft size={14} /> Back
        </button>
        <h3 className="text-gradient" style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>
          Actual Portfolio
        </h3>
      </div>

      {/* Loading overlay — visible until iframe fires onLoad */}
      {!loaded && (
        <div style={{
          position: 'fixed',
          top: iframeTop,
          left: 0,
          width: '100vw',
          height: `calc(100vh - ${iframeTop}px)`,
          background: 'var(--bg-color)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '16px',
          zIndex: 60,
        }}>
          <div style={{
            width: 40,
            height: 40,
            border: '3px solid var(--panel-border)',
            borderTop: '3px solid var(--primary)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: 0 }}>
            Loading portfolio data...
          </p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {/* Full-viewport iframe — starts below the sub-bar */}
      <iframe
        ref={iframeRef}
        src={WEBPORTAL_URL}
        title="Actual Portfolio Dashboard"
        onLoad={() => {
          setLoaded(true);
          // Covers the case where the outer theme changed while the iframe
          // was still loading (its src param would already be stale by then).
          iframeRef.current?.contentWindow?.postMessage({ type: THEME_SYNC_TYPE, theme: getTheme() }, WP_ORIGIN);
        }}
        style={{
          position: 'fixed',
          top: iframeTop,
          left: 0,
          width: '100vw',
          height: `calc(100vh - ${iframeTop}px)`,
          border: 'none',
          zIndex: 50,
          display: 'block',
        }}
        allowFullScreen
      />
    </>
  );
}
