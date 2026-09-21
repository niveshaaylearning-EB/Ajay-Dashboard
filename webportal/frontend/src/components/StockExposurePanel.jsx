import { useEffect, useState } from 'react';
import { API_BASE } from '../api/base.js';

// Centralized, NOT basket-scoped: same data regardless of which basket is
// currently selected -- combined weightage of each stock summed across every
// basket it's held in, same convention as WatchlistPage.
export default function StockExposurePanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null); // stock code currently expanded, or null

  useEffect(() => {
    fetch(`${API_BASE}/stock-exposure`)
      .then(r => r.json())
      .then(data => { setRows(data || []); setLoading(false); })
      .catch(() => { setError('Failed to load stock exposure.'); setLoading(false); });
  }, []);

  if (loading) return <p style={{ color: 'var(--text-secondary)', padding: '24px' }}>Loading stock exposure…</p>;
  if (error) return <p style={{ color: 'var(--accent-red)', padding: '24px' }}>{error}</p>;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Stock Exposure Across Baskets</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: '4px 0 0' }}>
          Combined weightage of each company, summed across every basket it's held in — click a card for the breakdown
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '12px' }}>
        {rows.map((e, i) => {
          const isOpen = expanded === e.code;
          return (
            <div
              key={e.code}
              onClick={() => setExpanded(isOpen ? null : e.code)}
              style={{
                background: 'var(--icard-bg)',
                border: `1px solid ${isOpen ? 'var(--accent-blue)' : 'var(--icard-border)'}`,
                borderRadius: '10px',
                padding: '14px 16px',
                cursor: 'pointer',
                transition: 'border-color 0.15s, box-shadow 0.15s',
                boxShadow: isOpen ? '0 0 0 1px var(--accent-blue)' : 'none',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>#{i + 1} · {e.code}</div>
                  <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.stock_name}
                  </div>
                </div>
                <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'}`} style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '4px', flexShrink: 0 }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: '10px' }}>
                <span style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--accent-blue)' }}>{e.total_weight.toFixed(2)}%</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', background: 'var(--icard-badge-bg)', borderRadius: '10px', padding: '2px 8px' }}>
                  {e.basket_count} basket{e.basket_count > 1 ? 's' : ''}
                </span>
              </div>

              {isOpen && (
                <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--icard-divider)', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {Object.entries(e.per_basket).map(([name, w]) => (
                    <div key={name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                      <span style={{ color: 'var(--text-secondary)' }}>{name}</span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{w.toFixed(2)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
