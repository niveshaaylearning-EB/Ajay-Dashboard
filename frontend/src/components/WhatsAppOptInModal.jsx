import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { MessageCircle, LogOut } from 'lucide-react';
import { getToken, isLoggedIn, clearAllTokens } from '../utils/auth.js';
import { API_ROOT } from '../config.js';

// MANDATORY -- no option to skip until a verified number is added, per
// explicit instruction (same behavior as the PF performance dashboard).
// Shown on every load after login to any user with no WhatsApp number on
// file yet (re-checked via /auth/me), with no close/skip affordance -- the
// only way out is successfully verifying a number, which makes /auth/me
// stop returning empty and the modal stops rendering on its own.
//
// Logout is offered since the header's own Logout button sits behind this
// full-screen overlay and would otherwise be unreachable -- logging out
// doesn't bypass the requirement (it reappears on next login), it just
// means "mandatory" isn't the same as "trapped".

export default function WhatsAppOptInModal() {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState('phone'); // 'phone' | 'otp'
  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const location = useLocation();

  // Re-checks on every route change, not just once on initial page load --
  // a plain mount-only effect (empty deps) misses a same-tab SPA login (no
  // full page reload from /login -> /), since isLoggedIn() was false the one
  // time this ran and never re-runs on its own afterwards.
  useEffect(() => {
    (async () => {
      if (!isLoggedIn()) { setVisible(false); return; }
      try {
        const res = await axios.get(`${API_ROOT}/auth/me`, { headers: { Authorization: `Bearer ${getToken()}` } });
        setVisible(!res.data.whatsappPhone);
      } catch { /* leave visibility unchanged on a transient fetch error */ }
    })();
  }, [location.pathname]);

  if (!visible) return null;

  const logout = () => {
    clearAllTokens();
    navigate('/login', { replace: true });
  };

  const sendOtp = async () => {
    setError(''); setInfo('');
    if (!phone.startsWith('+') || phone.length < 9) {
      setError('Enter a valid number in international format, e.g. +919537407484.');
      return;
    }
    setLoading(true);
    try {
      await axios.post(`${API_ROOT}/auth/profile/request-phone-otp`, { phone },
        { headers: { Authorization: `Bearer ${getToken()}` } });
      setStep('otp');
      setInfo(`Code sent via WhatsApp to ${phone}.`);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to send code.');
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async () => {
    setError('');
    setLoading(true);
    try {
      await axios.post(`${API_ROOT}/auth/profile/verify-phone-otp`, { phone, code },
        { headers: { Authorization: `Bearer ${getToken()}` } });
      setVisible(false);
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid or expired code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 999998,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
    }}>
      <div style={{
        width: '380px', maxWidth: '100%', background: 'var(--select-bg)',
        border: '1px solid var(--panel-border)', borderRadius: '14px',
        padding: '22px', position: 'relative',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <MessageCircle size={20} color="var(--primary)" />
          <h3 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-main)' }}>Add your WhatsApp number</h3>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 0 }}>
          A verified WhatsApp number is required before you can continue -- it's used as a backup channel for your login code in case email is ever delayed or missed.
        </p>

        {step === 'phone' ? (
          <>
            <input
              type="tel" value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="+919537407484" disabled={loading}
              style={{ width: '100%', marginBottom: '10px' }}
            />
            {error && <div style={{ color: '#f87171', fontSize: '0.78rem', marginBottom: '10px' }}>{error}</div>}
            <button className="btn btn-primary" onClick={sendOtp} disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Sending…' : 'Send Code'}
            </button>
          </>
        ) : (
          <>
            {info && <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginBottom: '10px' }}>{info}</div>}
            <input
              type="text" inputMode="numeric" value={code} onChange={e => setCode(e.target.value)}
              placeholder="6-digit code" disabled={loading}
              style={{ width: '100%', marginBottom: '10px' }}
            />
            {error && <div style={{ color: '#f87171', fontSize: '0.78rem', marginBottom: '10px' }}>{error}</div>}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="btn btn-secondary" onClick={() => setStep('phone')} disabled={loading} style={{ flex: 1 }}>Back</button>
              <button className="btn btn-primary" onClick={verifyOtp} disabled={loading || !code.trim()} style={{ flex: 1 }}>
                {loading ? 'Verifying…' : 'Verify & Save'}
              </button>
            </div>
          </>
        )}

        <button onClick={logout} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
          width: '100%', marginTop: '14px', padding: '8px', background: 'none', border: 'none',
          color: 'var(--text-muted)', fontSize: '0.78rem', cursor: 'pointer',
        }}>
          <LogOut size={13} /> Not now -- Logout instead
        </button>
      </div>
    </div>
  );
}
