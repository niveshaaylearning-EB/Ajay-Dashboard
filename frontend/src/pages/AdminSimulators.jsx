import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, FlaskConical, RefreshCw } from 'lucide-react';
import { API_BASE as API } from '../config.js';

const fmtRupee = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtPct   = (v) => v == null ? '—' : Number(v).toFixed(2) + '%';

export default function AdminSimulators() {
  const navigate = useNavigate();
  const [byUser,  setByUser]  = useState({});
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    axios.get(`${API}/admin/all-simulators`)
      .then(r => setByUser(r.data || {}))
      .catch(err => setError(err.response?.data?.detail || 'Failed to load simulator data.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const users = Object.keys(byUser).sort();

  return (
    <div className="animate-slide-up" style={{ maxWidth: 820, margin: '0 auto', padding: '0 1rem 3rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '28px' }}>
        <button
          className="btn btn-secondary"
          onClick={() => navigate('/')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <FlaskConical size={20} color="var(--primary)" />
            <h2 className="text-gradient" style={{ margin: 0, fontSize: '1.5rem' }}>Users' Virtual Portfolios</h2>
          </div>
          <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.85rem' }}>
            Every user's Simulator holdings + SIPs (read-only, admin-only).
          </p>
        </div>
        <button
          className="btn btn-secondary"
          onClick={load}
          disabled={loading}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: '20px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--negative)', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading…</div>
      ) : users.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          No user has set up a virtual portfolio yet.
        </div>
      ) : users.map(email => {
        const { holdings, sips } = byUser[email];
        return (
          <div key={email} className="glass-panel" style={{ padding: 0, overflow: 'hidden', marginBottom: '18px', border: '1px solid rgba(99,102,241,0.25)' }}>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(99,102,241,0.06)' }}>
              <span style={{ fontWeight: 700, color: 'var(--primary)', fontSize: '0.88rem' }}>
                {email === 'null' ? '(unlinked / unknown user)' : email}
              </span>
              <span style={{ fontSize: '0.72rem', background: 'rgba(99,102,241,0.2)', color: 'var(--primary)', borderRadius: '10px', padding: '2px 8px', fontWeight: 700 }}>
                {holdings.length} holding{holdings.length === 1 ? '' : 's'}
              </span>
              {sips.length > 0 && (
                <span style={{ fontSize: '0.72rem', background: 'rgba(16,185,129,0.15)', color: 'var(--positive)', borderRadius: '10px', padding: '2px 8px', fontWeight: 700 }}>
                  {sips.length} SIP{sips.length === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {holdings.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '8px 20px', fontWeight: 600 }}>Stock</th>
                    <th style={{ padding: '8px 20px', fontWeight: 600 }}>Allocation</th>
                    <th style={{ padding: '8px 20px', fontWeight: 600 }}>Buy Price</th>
                    <th style={{ padding: '8px 20px', fontWeight: 600 }}>CMP</th>
                    <th style={{ padding: '8px 20px', fontWeight: 600 }}>Buy Date</th>
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h, i) => (
                    <tr key={h.stock_code} style={{ borderTop: '1px solid rgba(255,255,255,0.05)', background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent' }}>
                      <td style={{ padding: '8px 20px', color: 'var(--text-main)', fontWeight: 600 }}>{h.stock_code}</td>
                      <td style={{ padding: '8px 20px', color: 'var(--text-main)' }}>{fmtPct(h.allocation)}</td>
                      <td style={{ padding: '8px 20px', color: 'var(--text-main)' }}>{fmtRupee(h.buy_price)}</td>
                      <td style={{ padding: '8px 20px', color: 'var(--text-main)' }}>{fmtRupee(h.cmp)}</td>
                      <td style={{ padding: '8px 20px', color: 'var(--text-muted)' }}>{h.buy_date || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {sips.length > 0 && (
              <div style={{ padding: '10px 20px', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                SIPs: {sips.map(s => `${s.sip_date} · ${fmtRupee(s.amount)}`).join('   ·   ')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
