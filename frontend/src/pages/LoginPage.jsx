import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Mail, LogIn, RefreshCw, KeyRound, UserPlus } from 'lucide-react';
import { setToken, setRefreshToken } from '../utils/auth';
import { API_ROOT as API } from '../config.js';

// ── Shared styles ─────────────────────────────────────────────────────────────
const inputBase = {
  width: '100%', padding: '12px 16px 12px 40px', fontSize: '1rem',
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '10px', color: 'var(--text-main)', outline: 'none', boxSizing: 'border-box',
};
const inputNoIcon = { ...inputBase, paddingLeft: '16px' };
const iconStyle = {
  position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)',
  color: 'var(--text-muted)', pointerEvents: 'none',
};

function ErrorBox({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      padding: '10px 14px', marginBottom: '14px', borderRadius: '8px',
      background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
      color: 'var(--negative)', fontSize: '0.85rem',
    }}>{msg}</div>
  );
}

function HintBox({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      padding: '10px 14px', marginBottom: '14px', borderRadius: '8px',
      background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)',
      color: 'var(--accent-amber)', fontSize: '0.85rem', fontFamily: 'monospace', letterSpacing: '0.05em',
    }}>{msg}</div>
  );
}

function SuccessBox({ msg }) {
  if (!msg) return null;
  return (
    <div style={{
      padding: '10px 14px', marginBottom: '14px', borderRadius: '8px',
      background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)',
      color: 'var(--positive)', fontSize: '0.85rem',
    }}>{msg}</div>
  );
}

function Spinner() {
  return <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function LoginPage() {
  const navigate = useNavigate();

  // 'login' | 'otp' | 'register' | 'pending'
  const [view,    setView]    = useState('login');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [hint,    setHint]    = useState('');
  const [success, setSuccess] = useState('');

  // login
  const [loginEmail, setLoginEmail] = useState('');
  const [loginOtp,   setLoginOtp]   = useState('');

  // register
  const [regFirst, setRegFirst] = useState('');
  const [regLast,  setRegLast]  = useState('');
  const [regEmail, setRegEmail] = useState('');

  function resetState() { setError(''); setHint(''); setSuccess(''); setLoading(false); }
  function go(v) { resetState(); setView(v); }

  // ── Step 1: send OTP ───────────────────────────────────────────────────────
  async function handleSendOtp(e) {
    e.preventDefault();
    setError(''); setHint(''); setSuccess('');
    const em = loginEmail.toLowerCase().trim();
    if (!em.endsWith('@niveshaay.com')) {
      setError('Only @niveshaay.com email addresses are allowed.');
      return;
    }
    setLoading(true);
    try {
      const res = await axios.post(`${API}/auth/login`, { email: em });
      setLoginOtp('');
      go('otp');
      if (res.data?.code) setHint(`Email delivery failed. Your code: ${res.data.code}`);
      else setSuccess(`A login code has been sent to ${em}.`);
    } catch (err) {
      const det = err.response?.data?.detail;
      setError(typeof det === 'string' ? det : det?.[0]?.msg || 'Failed to send code. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Step 2: verify OTP → login ─────────────────────────────────────────────
  async function handleVerifyOtp(e) {
    e.preventDefault();
    setError('');
    if (loginOtp.trim().length < 6) { setError('Enter the 6-digit code from your email.'); return; }
    setLoading(true);
    try {
      const res = await axios.post(`${API}/auth/verify-email-otp`, {
        email: loginEmail.toLowerCase().trim(), code: loginOtp.trim(),
      });
      setToken(res.data.token);
      if (res.data.refresh_token) setRefreshToken(res.data.refresh_token);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid or expired code. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Register: request access ───────────────────────────────────────────────
  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    const em = regEmail.toLowerCase().trim();
    if (!regFirst.trim() || !regLast.trim()) { setError('First name and last name are required.'); return; }
    if (!em.endsWith('@niveshaay.com')) { setError('Only @niveshaay.com email addresses are allowed.'); return; }
    setLoading(true);
    try {
      await axios.post(`${API}/auth/register`, {
        first_name: regFirst.trim(), last_name: regLast.trim(), email: em,
      });
      go('pending');
    } catch (err) {
      setError(err.response?.data?.detail || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const subtitle = {
    login:    'Sign in to your Niveshaay account',
    otp:      `Enter the code sent to ${loginEmail}`,
    register: 'Request access to Niveshaay Equity Basket Tracker',
    pending:  'Request submitted',
  }[view] || '';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div className="glass-panel animate-slide-up" style={{ width: '100%', maxWidth: '440px', padding: '2.5rem 2rem' }}>

        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{
            width: '56px', height: '56px', borderRadius: '16px', margin: '0 auto 16px',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.3), rgba(16,185,129,0.2))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid rgba(99,102,241,0.35)',
          }}>
            {view === 'register'
              ? <UserPlus color="var(--primary)" size={26} />
              : <LogIn color="var(--primary)" size={26} />}
          </div>
          <h1 className="text-gradient" style={{ fontSize: '1.7rem', margin: 0 }}>Niveshaay Equity Basket Tracker</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', marginTop: '6px' }}>{subtitle}</p>
        </div>

        <ErrorBox msg={error} />
        <HintBox  msg={hint} />
        <SuccessBox msg={success} />

        {/* ── LOGIN: email ── */}
        {view === 'login' && (
          <form onSubmit={handleSendOtp} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ position: 'relative' }}>
              <Mail size={16} style={iconStyle} />
              <input type="email" placeholder="your@niveshaay.com" value={loginEmail}
                onChange={e => setLoginEmail(e.target.value)} required autoFocus style={inputBase} />
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px' }}>
              {loading ? <><Spinner /><span>Sending code…</span></> : <><Mail size={16} /><span>Send Login Code</span></>}
            </button>
            <button type="button" onClick={() => go('register')}
              style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: '0.82rem', cursor: 'pointer', padding: 0, textAlign: 'right' }}>
              Request access →
            </button>
          </form>
        )}

        {/* ── LOGIN: OTP ── */}
        {view === 'otp' && (
          <form onSubmit={handleVerifyOtp} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ position: 'relative' }}>
              <KeyRound size={16} style={iconStyle} />
              <input type="text" inputMode="numeric" placeholder="Enter 6-digit code" value={loginOtp}
                onChange={e => setLoginOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                required autoFocus maxLength={6}
                style={{ ...inputBase, letterSpacing: '0.3em', fontSize: '1.2rem', textAlign: 'center' }} />
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px' }}>
              {loading ? <><Spinner /><span>Verifying…</span></> : <><LogIn size={16} /><span>Sign In</span></>}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button type="button" onClick={() => go('login')}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.82rem', cursor: 'pointer', padding: 0 }}>
                ← Use a different email
              </button>
              <button type="button" onClick={handleSendOtp}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: '0.82rem', cursor: 'pointer', padding: 0 }}>
                Resend code
              </button>
            </div>
          </form>
        )}

        {/* ── REGISTER ── */}
        {view === 'register' && (
          <form onSubmit={handleRegister} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <input type="text" placeholder="First name" value={regFirst}
                onChange={e => setRegFirst(e.target.value)} required style={{ ...inputNoIcon, flex: 1 }} />
              <input type="text" placeholder="Last name" value={regLast}
                onChange={e => setRegLast(e.target.value)} required style={{ ...inputNoIcon, flex: 1 }} />
            </div>
            <div style={{ position: 'relative' }}>
              <Mail size={16} style={iconStyle} />
              <input type="email" placeholder="your@niveshaay.com" value={regEmail}
                onChange={e => setRegEmail(e.target.value)} required autoFocus style={inputBase} />
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary"
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px' }}>
              {loading ? <><Spinner /><span>Submitting…</span></> : <><UserPlus size={16} /><span>Request Access</span></>}
            </button>
            <button type="button" onClick={() => go('login')}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.82rem', cursor: 'pointer', padding: 0 }}>
              ← Back to sign in
            </button>
          </form>
        )}

        {/* ── PENDING ── */}
        {view === 'pending' && (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <div style={{
              width: '60px', height: '60px', borderRadius: '50%', margin: '0 auto 18px',
              background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <p style={{ color: 'var(--text-main)', fontSize: '0.95rem', fontWeight: 600, marginBottom: '8px' }}>
              Pending Admin Approval
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.6, marginBottom: '20px' }}>
              Your request has been submitted. An admin will approve your account, after which you can log in with your email.
            </p>
            <button type="button" onClick={() => go('login')} className="btn btn-primary"
              style={{ width: '100%', padding: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <LogIn size={16} /> Back to Sign In
            </button>
          </div>
        )}

      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
