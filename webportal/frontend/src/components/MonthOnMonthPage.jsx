import { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api/base.js';

function fmtMonth(ym) {
  const [y, m] = ym.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[+m - 1]} ${y}`;
}

// Groups a basket's daily index series into calendar months, using the
// first and last AVAILABLE trading day within that same month (never
// rolling into the next month) -- an intra-month return, matching the
// Basket_Monthly_NAV_Returns_Since_Inception workbook's convention.
function buildMonthlyRows(data) {
  const byMonth = {};
  for (const d of data) {
    const ym = d.date.slice(0, 7);
    (byMonth[ym] ||= []).push(d);
  }
  return Object.keys(byMonth).sort().map(ym => {
    const pts = byMonth[ym];
    const first = pts[0];
    const last = pts[pts.length - 1];
    const ret = first.value ? ((last.value - first.value) / first.value) * 100 : null;
    return { ym, firstDate: first.date, firstVal: first.value, lastDate: last.date, lastVal: last.value, ret };
  });
}

export default function MonthOnMonthPage({ basketKey, basketLabel }) {
  const [series, setSeries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    fetch(`${API_BASE}/index-history`)
      .then(r => r.json())
      .then(hi => {
        const data = (hi[basketKey]?.data || []).slice().sort((a, b) => a.date.localeCompare(b.date));
        setSeries(data);
        setFromDate(data[0]?.date || '');
        setToDate(data[data.length - 1]?.date || '');
        setLoading(false);
      })
      .catch(() => { setError('Failed to load historical data.'); setLoading(false); });
  }, [basketKey]);

  const monthly = useMemo(() => (series ? buildMonthlyRows(series).reverse() : []), [series]);

  const filtered = useMemo(() => {
    if (!fromDate || !toDate) return monthly;
    return monthly.filter(r => r.lastDate >= fromDate && r.firstDate <= toDate);
  }, [monthly, fromDate, toDate]);

  const inceptionDate = series?.[0]?.date;
  const latestDate = series?.[series.length - 1]?.date;
  const resetToInception = () => { setFromDate(inceptionDate || ''); setToDate(latestDate || ''); };

  if (loading) return <p style={{ color: 'var(--text-secondary)', padding: '24px' }}>Loading month-on-month returns…</p>;
  if (error) return <p style={{ color: 'var(--accent-red)', padding: '24px' }}>{error}</p>;
  if (!series || series.length === 0) return <p style={{ color: 'var(--text-secondary)', padding: '24px' }}>No historical data available for {basketLabel}.</p>;

  const handleExportCsv = () => {
    const header = ['Month', 'First Date', 'First NAV', 'Last Date', 'Last NAV', 'Return %'];
    const lines = filtered.map(r => [fmtMonth(r.ym), r.firstDate, r.firstVal.toFixed(2), r.lastDate, r.lastVal.toFixed(2), r.ret.toFixed(2)]);
    const csv = [header, ...lines].map(row => row.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${basketLabel.replace(/\s+/g, '_')}_MonthOnMonth_${fromDate}_to_${toDate}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '14px' }}>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Month-on-Month Return — {basketLabel}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: '4px 0 0' }}>
            Since inception by default ({fmtMonth(inceptionDate.slice(0, 7))} onward) — pick a range to narrow it down
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            From
            <input type="date" value={fromDate} min={inceptionDate} max={latestDate}
              onChange={e => setFromDate(e.target.value)}
              style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.8rem' }} />
          </label>
          <label style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            To
            <input type="date" value={toDate} min={inceptionDate} max={latestDate}
              onChange={e => setToDate(e.target.value)}
              style={{ padding: '5px 8px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.8rem' }} />
          </label>
          <button onClick={resetToInception} style={{
            padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--accent-blue)',
            background: 'transparent', color: 'var(--accent-blue)', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
          }}>
            Since Inception
          </button>
          <button onClick={handleExportCsv} style={{
            padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--accent-blue)',
            background: 'var(--accent-blue)', color: '#fff', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <i className="fa-solid fa-file-export" /> Export CSV
          </button>
        </div>
      </div>

      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto', maxHeight: '560px', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '16%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '16%' }} />
              <col style={{ width: '20%' }} />
            </colgroup>
            <thead>
              <tr style={{ background: 'var(--th-bg)' }}>
                <th style={{ padding: '10px 16px', textAlign: 'left',   color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Month</th>
                <th style={{ padding: '10px 12px', textAlign: 'left',   color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>First Date</th>
                <th style={{ padding: '10px 12px', textAlign: 'right',  color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>First NAV</th>
                <th style={{ padding: '10px 12px', textAlign: 'left',   color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Last Date</th>
                <th style={{ padding: '10px 12px', textAlign: 'right',  color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Last NAV</th>
                <th style={{ padding: '10px 16px', textAlign: 'right',  color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Return %</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.ym} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '9px 16px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fmtMonth(r.ym)}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.firstDate}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{r.firstVal.toFixed(2)}</td>
                  <td style={{ padding: '9px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{r.lastDate}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{r.lastVal.toFixed(2)}</td>
                  <td style={{ padding: '9px 16px', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', color: r.ret >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                    {r.ret >= 0 ? '+' : ''}{r.ret.toFixed(2)}%
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>No months in the selected range.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
