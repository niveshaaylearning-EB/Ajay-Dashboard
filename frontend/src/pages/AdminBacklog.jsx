import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Activity, LogIn, LogOut, Upload, RefreshCw, Clock, User, Layers, ArrowLeft, LayoutDashboard, CheckCircle2, UserPlus, ShieldCheck, ShieldX, Lock, KeyRound, Shield, Mail, CloudUpload } from 'lucide-react';

import { API_BASE as API } from '../config.js';

const TABS = [
  { id: 'events',   label: 'Portfolio Events',    icon: Activity         },
  { id: 'auth',     label: 'Auth Events',          icon: LogIn            },
  { id: 'uploads',  label: 'Rebalance Uploads',    icon: Upload           },
  { id: 'features', label: 'Dashboard Features',   icon: LayoutDashboard  },
];

const FEATURES = [
  {
    section: 'Home — Portfolio Dashboard',
    items: [
      'View all basket holdings with live CMP, allocation & returns',
      'Basket-level performance (absolute return, CAGR)',
      'Historic performance chart vs benchmark',
      'Per-stock notes & price targets',
      'Live price feed via Google Sheets + yfinance fallback',
      'Sold stocks history per basket',
      'Results calendar view',
    ],
  },
  {
    section: 'Actual Portfolio',
    items: [
      'Full embedded webportal view (full-screen iframe)',
      'Buy price data — weighted-average from OHLC buy events',
      'Manual OHLC price override per stock/date',
      'Calculate returns — absolute & CAGR vs benchmark',
      'P&L Statement — FIFO realized gains for sold stocks',
      'OHLC fallback banner for next-trading-day gaps',
      'Undo / rollback snapshot system',
    ],
  },
  {
    section: 'Simulator (Virtual Portfolio)',
    items: [
      'Private per-user virtual portfolio — add/modify/delete any stock',
      'SIP management — scheduled investment simulation',
      'Historic performance chart for the simulated portfolio',
      'Export to Excel & PDF',
    ],
  },
  {
    section: 'Screener',
    items: [
      'Search NSE stocks by code or company name',
      'Multi-metric stock analysis',
    ],
  },
  {
    section: 'Basket Comparison',
    items: [
      'Cross-basket performance comparison',
      'Benchmark (Nifty 50) overlay',
    ],
  },
  {
    section: 'Calendar',
    items: [
      'Results calendar for stocks in the portfolio',
    ],
  },
  {
    section: 'Auth & Security',
    items: [
      'OTP email login — restricted to @niveshaay.com',
      'JWT tokens expire at midnight IST (forced daily re-login)',
      'Auto-logout on 401 (expired/invalid token)',
      'IP address + geolocation tracking per login',
    ],
  },
  {
    section: 'Admin Backlog (this page)',
    items: [
      'Portfolio event audit log (add, buy, sell, edit, delete)',
      'Auth events — login & logout history with IP',
      'Rebalance upload history',
      'Dashboard features overview',
    ],
  },
];

function fmt(iso) {
  if (!iso) return '—';
  // Treat bare datetime strings (no Z / offset) as UTC so the offset conversion is correct
  let normalized = iso.includes('T') ? iso : iso.replace(' ', 'T');
  if (!normalized.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(normalized)) normalized += 'Z';
  const d = new Date(normalized);
  if (isNaN(d)) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }) + ' IST';
}

const TH = ({ children, style }) => (
  <th style={{
    padding: '10px 14px', textAlign: 'left', fontWeight: 600,
    fontSize: '0.75rem', color: 'var(--text-muted)', letterSpacing: '0.05em',
    borderBottom: '1px solid rgba(255,255,255,0.08)', whiteSpace: 'nowrap',
    ...style,
  }}>{children}</th>
);

const TD = ({ children, style }) => (
  <td style={{
    padding: '9px 14px', fontSize: '0.82rem', color: 'var(--text-main)',
    borderBottom: '1px solid rgba(255,255,255,0.05)', verticalAlign: 'top',
    ...style,
  }}>{children}</td>
);

const Badge = ({ text, color }) => (
  <span style={{
    padding: '2px 8px', borderRadius: '20px', fontSize: '0.7rem', fontWeight: 600,
    background: `${color}22`, color, border: `1px solid ${color}44`,
    whiteSpace: 'nowrap',
  }}>{text}</span>
);

const eventColor = (type) => {
  if (!type) return 'var(--text-muted)';
  if (type.includes('add') || type.includes('buy')) return 'var(--positive)';
  if (type.includes('sell') || type.includes('delete') || type.includes('remove')) return '#f87171';
  if (type.includes('edit') || type.includes('update') || type.includes('chang')) return '#f59e0b';
  return '#818cf8';
};

function EventsTab({ data }) {
  if (!data.length) return <p style={{ color: 'var(--text-muted)', padding: '24px' }}>No portfolio events yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '700px' }}>
        <thead>
          <tr>
            <TH>Date &amp; Time</TH>
            <TH>User</TH>
            <TH>Event</TH>
            <TH>Basket</TH>
            <TH>Stock</TH>
            <TH>Details</TH>
          </tr>
        </thead>
        <tbody>
          {data.map(e => (
            <tr key={e.id}
              onMouseEnter={ev => ev.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
              onMouseLeave={ev => ev.currentTarget.style.background = ''}
            >
              <TD style={{ color: 'var(--text-muted)', fontSize: '0.77rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Clock size={12} />
                  {fmt(e.event_date)}
                </div>
              </TD>
              <TD>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                  <User size={11} />
                  {e.user_email || '—'}
                </div>
              </TD>
              <TD><Badge text={e.event_type || '—'} color={eventColor(e.event_type)} /></TD>
              <TD>
                <span style={{ color: 'var(--primary)', fontSize: '0.79rem' }}>
                  {e.basket_id ? e.basket_id.replace('NIA ', '') : '—'}
                </span>
              </TD>
              <TD style={{ fontWeight: 600 }}>{e.stock_code || '—'}</TD>
              <TD style={{ maxWidth: '260px' }}>
                {e.description && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '2px' }}>{e.description}</div>
                )}
                {(e.old_value || e.new_value) && (
                  <div style={{ fontSize: '0.74rem', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {e.old_value && <span style={{ color: 'var(--negative)' }}>Was: {e.old_value}</span>}
                    {e.new_value && <span style={{ color: 'var(--positive)' }}>Now: {e.new_value}</span>}
                  </div>
                )}
              </TD>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const AUTH_EVENT_META = {
  login:                  { label: 'Login',            color: 'var(--positive)',  Icon: LogIn       },
  logout:                 { label: 'Logout',           color: 'var(--negative)',          Icon: LogOut      },
  registration_requested: { label: 'Access Requested', color: 'var(--primary)',          Icon: UserPlus    },
  registration_completed: { label: 'Account Created',  color: 'var(--primary)',          Icon: UserPlus    },
  admin_approved_user:    { label: 'Approved',         color: 'var(--positive)',  Icon: ShieldCheck },
  admin_rejected_user:    { label: 'Rejected',         color: 'var(--negative)',          Icon: ShieldX     },
  account_locked:         { label: 'Account Locked',   color: 'var(--accent-amber)',          Icon: Lock        },
  password_changed:       { label: 'Password Changed', color: 'var(--primary)',          Icon: KeyRound    },
  login_failed:           { label: 'Login Failed',     color: 'var(--negative)',          Icon: ShieldX     },
  results_calendar_reminder_sent:   { label: 'Reminder Email Sent',   color: 'var(--positive)', Icon: Mail },
  results_calendar_reminder_failed: { label: 'Reminder Email Failed', color: 'var(--negative)',         Icon: Mail },
};

function authEventDetails(ev) {
  const type = ev.event_type;
  // For approval/rejection, extract the target email from details
  if (type === 'admin_approved_user' || type === 'admin_rejected_user') {
    const match = (ev.details || '').match(/for (.+@.+)/);
    return {
      actor: ev.user_email,   // admin who acted
      subject: match ? match[1] : null,
      note: null,
    };
  }
  if (type === 'registration_requested' || type === 'registration_completed') {
    return { actor: ev.user_email, subject: null, note: ev.details };
  }
  return { actor: ev.user_email, subject: null, note: ev.details };
}

function AuthTab({ auth_events }) {
  if (!auth_events || !auth_events.length)
    return <p style={{ color: 'var(--text-muted)', padding: '24px' }}>No auth events yet.</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '650px' }}>
        <thead>
          <tr>
            <TH>Date &amp; Time</TH>
            <TH>Event</TH>
            <TH>User / Actor</TH>
            <TH>Details</TH>
            <TH>IP Address</TH>
          </tr>
        </thead>
        <tbody>
          {auth_events.map((ev, idx) => {
            const meta = AUTH_EVENT_META[ev.event_type] || { label: ev.event_type, color: 'var(--text-muted)', Icon: Shield };
            const { Icon, label, color } = meta;
            const { actor, subject, note } = authEventDetails(ev);
            return (
              <tr key={ev.id ?? idx}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                onMouseLeave={e => e.currentTarget.style.background = ''}
              >
                <TD style={{ color: 'var(--text-muted)', fontSize: '0.77rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Clock size={12} />{fmt(ev.created_at)}
                  </div>
                </TD>
                <TD>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Icon size={13} style={{ color }} />
                    <Badge text={label} color={color} />
                  </div>
                </TD>
                <TD style={{ fontSize: '0.82rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ color }}>{actor || '—'}</span>
                    {subject && (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>
                        → {subject}
                      </span>
                    )}
                  </div>
                </TD>
                <TD style={{ color: 'var(--text-muted)', fontSize: '0.78rem', maxWidth: '260px' }}>
                  {note || '—'}
                </TD>
                <TD style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontFamily: 'monospace' }}>
                  {ev.ip_address || '—'}
                </TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FeaturesTab() {
  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {FEATURES.map(({ section, items }) => (
        <div key={section}>
          <h4 style={{ margin: '0 0 10px', color: 'var(--primary)', fontSize: '0.9rem', fontWeight: 700, letterSpacing: '0.03em' }}>
            {section}
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {items.map(item => (
              <div key={item} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '0.83rem', color: 'var(--text-main)' }}>
                <CheckCircle2 size={13} style={{ color: 'var(--positive)', flexShrink: 0, marginTop: '2px' }} />
                {item}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function UploadsTab({ data }) {
  if (!data.length) return <p style={{ color: 'var(--text-muted)', padding: '24px' }}>No rebalance uploads yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '650px' }}>
        <thead>
          <tr>
            <TH>Date &amp; Time</TH>
            <TH>Uploaded By</TH>
            <TH>Details</TH>
            <TH>IP Address</TH>
          </tr>
        </thead>
        <tbody>
          {data.map(u => {
            let parsed = null;
            try { parsed = JSON.parse(u.details); } catch {}
            return (
              <tr key={u.id}
                onMouseEnter={ev => ev.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
                onMouseLeave={ev => ev.currentTarget.style.background = ''}
              >
                <TD style={{ color: 'var(--text-muted)', fontSize: '0.77rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Clock size={12} />
                    {fmt(u.created_at)}
                  </div>
                </TD>
                <TD>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <User size={12} style={{ color: 'var(--accent-amber)' }} />
                    <span style={{ color: 'var(--accent-amber)' }}>{u.user_email || '—'}</span>
                  </div>
                </TD>
                <TD>
                  {parsed ? (
                    <div style={{ fontSize: '0.78rem' }}>
                      {parsed.file && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '3px' }}>
                          <Layers size={11} style={{ color: 'var(--text-muted)' }} />
                          <span style={{ fontWeight: 600 }}>{parsed.file}</span>
                        </div>
                      )}
                      {parsed.baskets && (
                        <span style={{ color: 'var(--positive)', marginRight: '10px' }}>
                          {Object.keys(parsed.baskets).length} basket{Object.keys(parsed.baskets).length !== 1 ? 's' : ''} updated
                        </span>
                      )}
                    </div>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{u.details || '—'}</span>
                  )}
                </TD>
                <TD style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontFamily: 'monospace' }}>
                  {u.ip_address || '—'}
                </TD>
                <TD style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                </TD>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}


export default function AdminBacklog() {
  const navigate  = useNavigate();
  const [tab,     setTab]     = useState('events');
  const [data,    setData]    = useState({ events: [], auth_events: [], uploads: [], logins: [], logouts: [] });
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await axios.post(`${API}/admin/sync-to-github`);
      const { files = {}, error: topError, GITHUB_TOKEN_set, GITHUB_REPO_set } = r.data || {};
      if (topError) {
        window.alert(`Sync not available: ${topError}\n\nGITHUB_TOKEN set: ${GITHUB_TOKEN_set}\nGITHUB_REPO set: ${GITHUB_REPO_set}`);
        return;
      }
      const entries = Object.entries(files);
      const ok     = entries.filter(([, v]) => v.startsWith('ok:'));
      const failed = entries.filter(([, v]) => !v.startsWith('ok:'));
      const summary = `Synced ${ok.length}/${entries.length} files to GitHub.` +
        (failed.length ? `\n\nFailed:\n${failed.map(([f, v]) => `${f}: ${v}`).join('\n')}` : '');
      window.alert(summary);
    } catch (err) {
      window.alert('Sync failed: ' + (err.response?.data?.detail || err.message));
    } finally {
      setSyncing(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true); setError('');
    axios.get(`${API}/admin/audit-log`)
      .then(r => setData({ events: [], auth_events: [], uploads: [], logins: [], logouts: [], ...r.data }))
      .catch(err => {
        const detail = err.response?.data?.detail || err.message || 'Failed to load backlog.';
        setError(detail);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const counts = {
    events:  data.events.length,
    auth:    data.auth_events.length,
    uploads: data.uploads.length,
  };

  return (
    <div className="animate-slide-up">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            className="btn btn-secondary"
            onClick={() => navigate('/')}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
          >
            <ArrowLeft size={18} /> Back
          </button>
          <div>
            <h2 className="text-gradient" style={{ margin: 0, fontSize: '1.6rem' }}>Activity Backlog</h2>
            <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.85rem' }}>
              Admin-only · Portfolio events, logins, logouts &amp; rebalance uploads
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="btn btn-secondary"
            title="Force-push every persistent data file (portfolios, buy prices, clients, login/audit history, etc.) to GitHub right now"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '0.83rem' }}
          >
            <CloudUpload size={14} style={syncing ? { animation: 'spin 1s linear infinite' } : {}} />
            {syncing ? 'Syncing…' : 'Sync Data'}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="btn btn-secondary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '0.83rem' }}
          >
            <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px', marginBottom: '20px', borderRadius: '10px',
          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
          color: 'var(--negative)', fontSize: '0.85rem', fontFamily: 'monospace',
        }}>{error}</div>
      )}

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: '4px', marginBottom: '20px',
        background: 'rgba(255,255,255,0.04)', borderRadius: '10px', padding: '4px',
        width: 'fit-content',
      }}>
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '7px',
                padding: '8px 16px', borderRadius: '7px', border: 'none', cursor: 'pointer',
                fontSize: '0.83rem', fontWeight: active ? 600 : 400, transition: 'all 0.15s',
                background: active ? 'rgba(99,102,241,0.25)' : 'transparent',
                color: active ? 'var(--primary)' : 'var(--text-muted)',
              }}
            >
              <Icon size={14} />
              {t.label}
              {counts[t.id] > 0 && (
                <span style={{
                  background: active ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.08)',
                  color: active ? 'var(--primary)' : 'var(--text-muted)',
                  borderRadius: '10px', padding: '0 6px', fontSize: '0.7rem', fontWeight: 700,
                }}>{counts[t.id]}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="glass-panel" style={{ padding: '0', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
            <RefreshCw size={22} style={{ animation: 'spin 1s linear infinite', marginBottom: '10px' }} />
            <div>Loading backlog…</div>
          </div>
        ) : (
          <>
            {tab === 'events'   && <EventsTab   data={data.events} />}
            {tab === 'auth'     && <AuthTab     auth_events={data.auth_events} />}
            {tab === 'uploads'  && <UploadsTab  data={data.uploads} />}
            {tab === 'features' && <FeaturesTab />}
          </>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
