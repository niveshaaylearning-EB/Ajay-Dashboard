import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Calendar, CalendarPlus, Search, ArrowLeft, AlertCircle, Filter, Loader2, Users, X } from 'lucide-react';
import { API_BASE } from '../config.js';
import { isAdmin } from '../utils/auth.js';

// Color per event type/category -- results stay the original blue, each
// corporate-action category gets its own accent so the two are easy to
// tell apart in the table at a glance. Uses theme-aware CSS variables (not
// hardcoded hex) so this reads correctly in both dark and light mode --
// dark-mode-tuned pastels like #a5b4fc/#34d399 drop to under 2:1 contrast
// against the light theme's cream background.
const TYPE_COLORS = {
  result:          { color: 'var(--primary)',      bg: 'rgba(99,102,241,0.12)',  border: 'rgba(99,102,241,0.25)' },
  Dividend:        { color: 'var(--positive)',      bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.25)' },
  Bonus:           { color: 'var(--positive)',      bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.25)' },
  'Stock Split':   { color: 'var(--accent-amber)',  bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.25)' },
  'Rights Issue':  { color: 'var(--accent-amber)',  bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.25)' },
  Buyback:         { color: 'var(--accent-amber)',  bg: 'rgba(245,158,11,0.12)',  border: 'rgba(245,158,11,0.25)' },
  Demerger:        { color: 'var(--negative)',      bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.25)' },
  'Merger/Scheme':  { color: 'var(--negative)',      bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.25)' },
  'Corporate Action': { color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.12)' },
};

function EventTypeBadge({ event }) {
  const label = event.type === 'result' ? 'Result' : (event.action_category || 'Corporate Action');
  const c = TYPE_COLORS[event.type === 'result' ? 'result' : (event.action_category || 'Corporate Action')]
    || TYPE_COLORS['Corporate Action'];
  return (
    <span style={{
      display: 'inline-block', fontSize: '0.72rem', fontWeight: 600, padding: '2px 9px',
      borderRadius: '10px', background: c.bg, border: `1px solid ${c.border}`, color: c.color, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

// ── Admin: manage which analyst(s) get the 1-day-before reminder email ──────
function AnalystContactsPanel({ baskets, onClose }) {
  const [basket, setBasket]   = useState(baskets[0] || '');
  const [contacts, setContacts] = useState([]);
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy]   = useState(false);

  const load = () => {
    axios.get(`${API_BASE}/results-calendar/analyst-contacts`)
      .then(res => setContacts(res.data || []))
      .catch(() => setContacts([]));
  };
  useEffect(() => { load(); }, []);

  const basketContacts = contacts.filter(c => c.basket_name === basket);

  const handleAdd = async () => {
    if (!basket) { setError('Pick a basket first.'); return; }
    if (!name.trim() || !email.trim()) { setError('Name and email are both required.'); return; }
    setBusy(true); setError('');
    try {
      await axios.post(`${API_BASE}/results-calendar/analyst-contacts`, { basket_name: basket, name, email });
      setName(''); setEmail('');
      load();
    } catch (e) {
      setError(e.response?.data?.detail || 'Could not add this analyst.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await axios.delete(`${API_BASE}/results-calendar/analyst-contacts/${id}`);
      load();
    } catch (_) {}
  };

  return (
    <div className="whatif-overlay" onClick={onClose}>
      <div className="whatif-modal" style={{ width: 'min(480px, 94vw)' }} onClick={e => e.stopPropagation()}>
        <div className="whatif-header">
          <span className="sit-symbol" style={{ background: 'transparent', border: 'none', padding: 0 }}>
            Main Research Analyst -- Reminder Recipients
          </span>
          <button className="whatif-close" onClick={onClose}>&times;</button>
        </div>
        <div className="whatif-body">
          <div className="whatif-section-title" style={{ marginTop: 0 }}>Basket</div>
          <select value={basket} onChange={e => setBasket(e.target.value)} style={{ width: '100%', marginBottom: '0.75rem' }}>
            {baskets.map(b => <option key={b} value={b}>{b}</option>)}
          </select>

          <div className="whatif-section-title">Assigned analysts (get emailed 1 day before)</div>
          {basketContacts.length === 0 && (
            <div className="sit-no-data" style={{ marginBottom: '0.5rem' }}>No analyst assigned to this basket yet.</div>
          )}
          {basketContacts.map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0.6rem', marginBottom: '0.35rem', borderRadius: '8px', background: 'rgba(255,255,255,0.04)' }}>
              <span style={{ fontSize: '0.85rem' }}><strong>{c.name}</strong> <span style={{ color: 'var(--text-muted)' }}>({c.email})</span></span>
              <button className="btn" style={{ padding: '2px 6px', color: 'var(--negative)', borderColor: 'var(--negative)' }} onClick={() => handleDelete(c.id)} title="Remove">
                <X size={13} />
              </button>
            </div>
          ))}

          <div className="whatif-section-title">Add analyst</div>
          <div className="input-group" style={{ display: 'inline-block', marginRight: '0.5rem' }}>
            <label>Name</label>
            <input value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div className="input-group" style={{ display: 'inline-block' }}>
            <label>Email</label>
            <input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@niveshaay.com" />
          </div>
          {error && <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>{error}</div>}
        </div>
        <div className="whatif-footer">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-secondary" disabled={busy} onClick={handleAdd}>
            {busy ? 'Adding…' : 'Add Analyst'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ResultCalendar() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [events, setEvents] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBasket, setSelectedBasket] = useState('All');
  const [analystPanelOpen, setAnalystPanelOpen] = useState(false);

  useEffect(() => {
    axios.get(`${API_BASE}/portfolio/results-calendar`)
      .then(res => {
        setEvents(res.data || []);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching results calendar:', err);
        setError('Failed to load upcoming results. Please try again later.');
        setLoading(false);
      });
  }, []);

  // Get unique basket names for the filter dropdown
  const allBaskets = ['All', ...Array.from(new Set(events.flatMap(e => e.baskets || []))).sort()];

  // Filter events based on search term and selected basket
  const filteredEvents = events.filter(e => {
    const matchesSearch = 
      e.stock_code.toLowerCase().includes(searchTerm.toLowerCase()) || 
      e.stock_name.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesBasket = 
      selectedBasket === 'All' || 
      e.baskets.includes(selectedBasket);

    return matchesSearch && matchesBasket;
  });

  const getDaysRemaining = (dateStr) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(dateStr);
    targetDate.setHours(0, 0, 0, 0);
    const diffTime = targetDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  const formatEventDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  // Google Calendar "quick add" link — no OAuth/API needed, just opens a
  // pre-filled event-creation page in a new tab. All-day event, so the end
  // date is the next calendar day (Google's convention: end date exclusive).
  const buildGoogleCalendarUrl = (event) => {
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const start = new Date(event.date);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const label = event.type === 'result' ? 'Results' : (event.action_category || 'Corporate Action');
    const text = encodeURIComponent(`${event.stock_code} ${label}`);
    const details = encodeURIComponent(
      `${event.stock_name} (${event.stock_code}) — ${event.purpose || 'Financial results'}.\n` +
      `Basket${event.baskets.length > 1 ? 's' : ''}: ${event.baskets.join(', ')}`
    );
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${fmt(start)}/${fmt(end)}&details=${details}`;
  };

  return (
    <div className="animate-slide-up" style={{ minHeight: '80vh' }}>
      
      {/* Top Header Navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <button
          className="btn btn-secondary"
          onClick={() => navigate('/')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
        >
          <ArrowLeft size={18} /> Back
        </button>
        <div>
          <h2 className="text-gradient" style={{ margin: 0, fontSize: '1.6rem' }}>Result Calendar</h2>
        </div>
        {isAdmin() && (
          <button
            className="btn btn-secondary"
            onClick={() => setAnalystPanelOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', marginLeft: 'auto' }}
          >
            <Users size={16} /> Manage Analyst Reminders
          </button>
        )}
      </div>

      {analystPanelOpen && (
        <AnalystContactsPanel baskets={allBaskets.filter(b => b !== 'All')} onClose={() => setAnalystPanelOpen(false)} />
      )}

      {/* Main Section */}
      <div className="glass-panel" style={{ padding: '24px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Section description & Search/Filters bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem', margin: 0 }}>
                Earnings, board meetings and corporate actions (dividends, bonuses, splits, buybacks, demergers)
                scheduled for active holdings present in your baskets.
              </p>
            </div>

            {/* Filter controls */}
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', width: '100%', maxWidth: '600px', justifyContent: 'flex-end' }}>
              
              {/* Search input */}
              <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
                <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  placeholder="Search stock code or name..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 12px 8px 36px',
                    fontSize: '0.88rem',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              {/* Basket filter */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Filter size={16} style={{ color: 'var(--text-muted)' }} />
                <select
                  value={selectedBasket}
                  onChange={e => setSelectedBasket(e.target.value)}
                  style={{
                    padding: '8px 32px 8px 12px',
                    fontSize: '0.88rem',
                  }}
                >
                  {allBaskets.map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>

            </div>
          </div>

          {/* Table / List representation */}
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '12px' }}>
              <Loader2 className="animate-spin" size={32} style={{ color: 'var(--primary)' }} />
              <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>Analyzing portfolio and fetching earnings dates...</span>
            </div>
          ) : error ? (
            <div className="error-alert" style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '8px', color: 'var(--negative)' }}>
              <AlertCircle size={20} />
              <span>{error}</span>
            </div>
          ) : filteredEvents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)' }}>
              No upcoming results found for the selected filters.
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Stock Name</th>
                    <th>Code</th>
                    <th>Type</th>
                    <th>Baskets</th>
                    <th>Date</th>
                    <th style={{ textAlign: 'right' }}>Remaining Days</th>
                    <th style={{ textAlign: 'center' }}>Calendar</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((event, idx) => {
                    const daysLeft = getDaysRemaining(event.date);
                    let badgeColor = 'var(--text-muted)';
                    let badgeBg = 'rgba(255,255,255,0.06)';
                    let badgeBorder = 'rgba(255,255,255,0.12)';

                    if (daysLeft === 0) {
                      badgeColor = 'var(--positive)';
                      badgeBg = 'rgba(16, 185, 129, 0.12)';
                      badgeBorder = 'rgba(16, 185, 129, 0.25)';
                    } else if (daysLeft <= 7) {
                      badgeColor = 'var(--accent-amber)';
                      badgeBg = 'rgba(245, 158, 11, 0.12)';
                      badgeBorder = 'rgba(245, 158, 11, 0.25)';
                    } else if (daysLeft <= 30) {
                      badgeColor = 'var(--primary)';
                      badgeBg = 'rgba(99, 102, 241, 0.12)';
                      badgeBorder = 'rgba(99, 102, 241, 0.25)';
                    }

                    return (
                      <tr key={idx} className="hover-row">
                        <td style={{ fontWeight: 500, color: 'var(--text-main)', whiteSpace: 'normal' }}>
                          {event.stock_name}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{event.stock_code}</td>
                        <td title={event.purpose}><EventTypeBadge event={event} /></td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {event.baskets.map(b => (
                              <span key={b} style={{
                                fontSize: '0.72rem',
                                padding: '2px 8px',
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: '1px solid rgba(255, 255, 255, 0.08)',
                                borderRadius: '4px',
                                color: 'var(--text-muted)'
                              }}>
                                {b}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td style={{ color: 'var(--text-main)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Calendar size={14} style={{ color: 'var(--primary)', opacity: 0.8 }} />
                            <span>{formatEventDate(event.date)}</span>
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={{
                            display: 'inline-block',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            padding: '4px 10px',
                            background: badgeBg,
                            border: `1px solid ${badgeBorder}`,
                            borderRadius: '12px',
                            color: badgeColor
                          }}>
                            {daysLeft === 0 ? 'Today!' : daysLeft === 1 ? 'Tomorrow' : `In ${daysLeft} days`}
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <a
                            href={buildGoogleCalendarUrl(event)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Add to Google Calendar"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: '5px',
                              fontSize: '0.75rem', fontWeight: 600, textDecoration: 'none',
                              padding: '4px 10px', borderRadius: '8px',
                              background: 'var(--hover-overlay)', border: '1px solid var(--panel-border)',
                              color: 'var(--primary)', whiteSpace: 'nowrap',
                            }}
                          >
                            <CalendarPlus size={13} /> Add
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

        </div>
      </div>

    </div>
  );
}
