import { formatPercent, getColorClass } from '../App.jsx';
import { TENURE_FULL_LABELS } from '../utils/tenureReturn.js';

function StockRow({ rank, item }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.55rem 0.9rem', borderRadius: '8px',
      background: rank === 1 ? 'var(--hover-bg)' : 'transparent',
      border: rank === 1 ? '1px solid var(--panel-border-hover)' : '1px solid transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span style={{
          width: '20px', height: '20px', borderRadius: '50%', display: 'flex',
          alignItems: 'center', justifyContent: 'center', fontSize: '0.68rem', fontWeight: 700,
          background: 'var(--panel-border)', color: 'var(--text-secondary)', flexShrink: 0,
        }}>{rank}</span>
        <div>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.86rem' }}>{item.nseCode}</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            {formatPercent(item._tenurePerf)} performance · {(item.allocation != null ? (item.allocation * 100).toFixed(1) : '—')}% weight
          </div>
        </div>
      </div>
      <div className={getColorClass(item._tenureContribution)} style={{ fontWeight: 700, fontSize: '0.92rem' }}>
        {formatPercent(item._tenureContribution)}
      </div>
    </div>
  );
}

export default function PerformanceSummaryPage({ rows, isIPO, perfByTenure, tenure, tenureReturn, basketLabel }) {
  const tenureLabel = tenure || '1M';
  const tenureFull = TENURE_FULL_LABELS[tenureLabel] || tenureLabel;

  const withTenure = rows.map(r => {
    const perf = tenureLabel === '1M' ? r.performance : perfByTenure?.[r.nseCode]?.[tenureLabel];
    const contribution = (perf != null && r.allocation != null) ? r.allocation * perf : null;
    return { ...r, _tenurePerf: perf, _tenureContribution: contribution };
  });
  const validCont = withTenure.filter(r => r._tenureContribution != null && isFinite(r._tenureContribution));

  const topContribs = [...validCont].sort((a, b) => b._tenureContribution - a._tenureContribution).slice(0, 3);
  const topDraggers = [...validCont].sort((a, b) => a._tenureContribution - b._tenureContribution).slice(0, 3)
    .filter(r => !topContribs.some(t => t.nseCode === r.nseCode));

  if (isIPO) {
    return (
      <div style={{ padding: '2rem 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
        Performance summary isn't meaningful for an equal-weighted watchlist basket.
      </div>
    );
  }

  return (
    <div style={{ padding: '0.5rem 0' }}>
      <div style={{
        marginBottom: '1.25rem', padding: '1rem 1.2rem', borderRadius: '10px',
        background: 'var(--card-bg, var(--panel-bg))', border: '1px solid var(--panel-border)',
      }}>
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{basketLabel}</strong> returned
        </div>
        <div className={getColorClass(tenureReturn?.pct != null ? tenureReturn.pct * 100 : null)} style={{ fontSize: '1.8rem', fontWeight: 700, margin: '0.2rem 0' }}>
          {tenureReturn?.pct != null ? (tenureReturn.pct >= 0 ? '+' : '') + (tenureReturn.pct * 100).toFixed(2) + '%' : '—'}
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
          over the past {tenureFull} — here's what drove it.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
        <div style={{ background: 'var(--card-bg, var(--panel-bg))', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '10px', padding: '1rem' }}>
          <div style={{ fontWeight: 700, color: 'var(--accent-green)', fontSize: '0.85rem', marginBottom: '0.6rem' }}>
            Top Contributors — why it went up
          </div>
          {topContribs.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>No data available.</div>
          ) : topContribs.map((item, i) => <StockRow key={item.nseCode} rank={i + 1} item={item} />)}
        </div>

        <div style={{ background: 'var(--card-bg, var(--panel-bg))', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', padding: '1rem' }}>
          <div style={{ fontWeight: 700, color: 'var(--accent-red)', fontSize: '0.85rem', marginBottom: '0.6rem' }}>
            Top Draggers — why it underperformed
          </div>
          {topDraggers.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>No data available.</div>
          ) : topDraggers.map((item, i) => <StockRow key={item.nseCode} rank={i + 1} item={item} />)}
        </div>
      </div>
    </div>
  );
}
