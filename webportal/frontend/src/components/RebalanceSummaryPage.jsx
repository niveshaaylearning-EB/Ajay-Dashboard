import { useEffect, useState } from 'react';
import { fetchRebalanceSummary } from '../api/client.js';

const fmtWt = (v) => v == null ? '' : (Math.round(v * 100) / 100) + '%';

function DayCard({ entry }) {
  const { date, added, removed, reweighted } = entry;
  return (
    <div style={{
      background: 'var(--card-bg, var(--panel-bg))', border: '1px solid var(--panel-border)',
      borderRadius: '10px', padding: '0.9rem 1.1rem', marginBottom: '0.75rem',
    }}>
      <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem', marginBottom: '0.6rem' }}>
        {date}
      </div>

      {added.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <span style={{ color: 'var(--accent-green)', fontWeight: 600, fontSize: '0.78rem' }}>+ Added</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.3rem' }}>
            {added.map(s => (
              <span key={s.nseCode} title={s.securityName} style={{
                background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                color: 'var(--accent-green)', borderRadius: '6px', padding: '2px 8px', fontSize: '0.76rem', fontWeight: 600,
              }}>
                {s.nseCode} {s.weight != null ? `(${fmtWt(s.weight)})` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {removed.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          <span style={{ color: 'var(--accent-red)', fontWeight: 600, fontSize: '0.78rem' }}>− Removed</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.3rem' }}>
            {removed.map(s => (
              <span key={s.nseCode} title={s.securityName} style={{
                background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                color: 'var(--accent-red)', borderRadius: '6px', padding: '2px 8px', fontSize: '0.76rem', fontWeight: 600,
              }}>
                {s.nseCode} {s.weight != null ? `(was ${fmtWt(s.weight)})` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {reweighted.length > 0 && (
        <div>
          <span style={{ color: 'var(--accent-amber)', fontWeight: 600, fontSize: '0.78rem' }}>↕ Reweighted</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.3rem' }}>
            {reweighted.map(s => (
              <span key={s.nseCode} title={s.securityName} style={{
                background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
                color: 'var(--text-secondary)', borderRadius: '6px', padding: '2px 8px', fontSize: '0.76rem',
              }}>
                <strong style={{ color: 'var(--text-primary)' }}>{s.nseCode}</strong>{' '}
                {fmtWt(s.from)} → {fmtWt(s.to)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RebalanceSummaryPage({ basketKey, basketLabel }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    setSummary(null);
    fetchRebalanceSummary(basketKey)
      .then(setSummary)
      .catch(() => setError('Failed to load rebalance history.'))
      .finally(() => setLoading(false));
  }, [basketKey]);

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <div style={{ marginBottom: '1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
        Every rebalance recorded for <strong style={{ color: 'var(--text-primary)' }}>{basketLabel}</strong>,
        most recent first — what was added, removed, or reweighted on each date.
      </div>

      {loading && <div style={{ color: 'var(--text-secondary)', padding: '2rem 0', textAlign: 'center' }}>Loading…</div>}
      {error && <div style={{ color: 'var(--accent-red)', padding: '1rem 0' }}>{error}</div>}
      {!loading && !error && summary?.length === 0 && (
        <div style={{ color: 'var(--text-secondary)', padding: '2rem 0', textAlign: 'center' }}>
          No rebalance history recorded for this basket yet.
        </div>
      )}
      {!loading && !error && summary?.map(entry => <DayCard key={entry.date} entry={entry} />)}
    </div>
  );
}
