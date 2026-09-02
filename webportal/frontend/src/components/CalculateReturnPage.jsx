import { API_BASE, getAuthToken } from '../api/base.js';
import { useState, useEffect, useMemo } from 'react';
import DailyValuesPanel from './DailyValuesPanel.jsx';
import RollbackButtons from './RollbackButtons.jsx';
import ColumnFilter from './ColumnFilter.jsx';

const ADMIN_EMAILS = ['jay.chaudhari@niveshaay.com', 'nukul.madaan@niveshaay.com', 'nakshatra.rathi@niveshaay.com'];
const _getAdminState = () => {
  try {
    const t = getAuthToken();
    if (!t) return { isAdmin: false };
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (payload.exp && Date.now() > payload.exp * 1000) return { isAdmin: false };
    const email = (payload.sub || '').toLowerCase().trim();
    return { isAdmin: ADMIN_EMAILS.includes(email) };
  } catch { return { isAdmin: false }; }
};

const BASKET_ORDER = [
  'Mid_Small_Cap', 'Green_Energy', 'Make_in_India', 'Trends_Triology',
  'Consumer_Trends', 'IPO_Basket', 'Techstack',
];

const BASKET_LABELS = {
  Green_Energy:    'Green Energy',
  Mid_Small_Cap:   'Mid & Small Cap',
  Consumer_Trends: 'Consumer Trends',
  IPO_Basket:      'IPO Basket',
  Trends_Triology: 'Trends Triology',
  Techstack:       'Techstack',
  Make_in_India:   'Make in India',
};

function findClosest(data, targetDate) {
  const exact = data.find(d => d.date === targetDate);
  if (exact) return { date: exact.date, value: exact.value, benchmark: exact.benchmark, adjusted: false };
  const next = data.find(d => d.date > targetDate);
  if (next) return { date: next.date, value: next.value, benchmark: next.benchmark, adjusted: true };
  // Fall back to the most recent date before targetDate
  const prev = [...data].reverse().find(d => d.date < targetDate);
  if (prev) return { date: prev.date, value: prev.value, benchmark: prev.benchmark, adjusted: true };
  return null;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[+m - 1]} ${y}`;
}

function fmtPct(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function colorClass(v) {
  if (v == null) return '';
  return v >= 0 ? 'cr-positive' : 'cr-negative';
}

function getCrColVal(field, row) {
  switch (field) {
    case 'label':         return row.label || '';
    case 'absBasket':     return row.absBasket != null ? row.absBasket.toFixed(2) + '%' : '';
    case 'absBenchmark':  return row.absBenchmark != null ? row.absBenchmark.toFixed(2) + '%' : '';
    case 'absAlpha':      return row.absAlpha != null ? row.absAlpha.toFixed(2) + '%' : '';
    case 'cagrBasket':    return row.cagrBasket != null ? row.cagrBasket.toFixed(2) + '%' : '';
    case 'cagrBenchmark': return row.cagrBenchmark != null ? row.cagrBenchmark.toFixed(2) + '%' : '';
    case 'cagrAlpha':     return row.cagrAlpha != null ? row.cagrAlpha.toFixed(2) + '%' : '';
    default:              return String(row[field] ?? '');
  }
}

export default function CalculateReturnPage() {
  const { isAdmin: userIsAdmin } = _getAdminState();
  const [histData,     setHistData]     = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [baseDate,     setBaseDate]     = useState('');
  const [latestDate,   setLatestDate]   = useState('');
  const [results,      setResults]      = useState([]);
  const [error,        setError]        = useState('');
  const [confirmInfo,     setConfirmInfo]     = useState(null);
  const [pendingRows,     setPendingRows]     = useState([]);
  const [showDailyPanel,  setShowDailyPanel]  = useState(false);
  const [crSortKey,    setCrSortKey]    = useState(null);
  const [crSortDir,    setCrSortDir]    = useState('asc');
  const [crColFilters, setCrColFilters] = useState({});
  const [crOpenFilter, setCrOpenFilter] = useState(null);
  const [crFilterPos,  setCrFilterPos]  = useState({ top: 0, left: 0 });

  const handleCrFilterOpen = (col, e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setCrFilterPos({ top: rect.bottom, left: rect.left });
    setCrOpenFilter(prev => prev === col ? null : col);
  };
  const handleCrSort = (col, dir) => { setCrSortKey(col); setCrSortDir(dir); };
  const handleCrFilter = (col, vals) => {
    setCrColFilters(prev => {
      const next = { ...prev };
      if (vals === null) delete next[col]; else next[col] = vals;
      return next;
    });
  };

  const crDisplayResults = useMemo(() => {
    let r = results;
    for (const [field, values] of Object.entries(crColFilters)) {
      if (!values) continue;
      if (values.size === 0) { r = []; break; }
      r = r.filter(x => values.has(getCrColVal(field, x)));
    }
    if (!crSortKey) return r;
    return [...r].sort((a, b) => {
      const d = crSortDir === 'asc' ? 1 : -1;
      if (crSortKey === 'label') return d * (a.label || '').localeCompare(b.label || '');
      const va = a[crSortKey] ?? -Infinity;
      const vb = b[crSortKey] ?? -Infinity;
      return d * (va - vb);
    });
  }, [results, crSortKey, crSortDir, crColFilters]);

  const fetchHistData = () => {
    setLoading(true);
    fetch(`${API_BASE}/index-history`)
      .then(r => r.json())
      .then(d => { setHistData(d); setLoading(false); })
      .catch(() => { setError('Failed to load historical data.'); setLoading(false); });
  };

  useEffect(() => { fetchHistData(); }, []);

  const buildRows = () => {
    if (!histData || !baseDate || !latestDate) return null;
    if (baseDate >= latestDate) {
      setError('Latest Date must be after Base Date.');
      return null;
    }
    setError('');

    const rows = [];
    const adjustments = [];

    const keys = BASKET_ORDER.filter(k => histData[k]);
    for (const key of keys) {
      const info = histData[key];
      const basePt   = findClosest(info.data, baseDate);
      const latestPt = findClosest(info.data, latestDate);
      if (!basePt || !latestPt) continue;

      if (basePt.adjusted)
        adjustments.push({ basket: BASKET_LABELS[key], field: 'Base Date',   requested: baseDate,   actual: basePt.date });
      if (latestPt.adjusted)
        adjustments.push({ basket: BASKET_LABELS[key], field: 'Latest Date', requested: latestDate, actual: latestPt.date });

      rows.push({ key, label: BASKET_LABELS[key], basePt, latestPt });
    }

    return { rows, adjustments };
  };

  const compute = (rows) =>
    rows.map(({ key, label, basePt, latestPt }) => {
      const bv  = basePt.value;
      const lv  = latestPt.value;
      const bbv = basePt.benchmark;
      const lbv = latestPt.benchmark;
      const years = (new Date(latestPt.date) - new Date(basePt.date)) / (365.25 * 86400000);

      const absBasket    = ((lv  - bv)  / bv)  * 100;
      const absBenchmark = (bbv != null && lbv != null) ? ((lbv - bbv) / bbv) * 100 : null;
      const absAlpha     = absBenchmark != null ? absBasket - absBenchmark : null;
      const cagrBasket    = years >= 1 ? (Math.pow(lv  / bv,  1 / years) - 1) * 100 : null;
      const cagrBenchmark = (years >= 1 && bbv != null && lbv != null)
        ? (Math.pow(lbv / bbv, 1 / years) - 1) * 100 : null;
      const cagrAlpha     = (cagrBasket != null && cagrBenchmark != null) ? cagrBasket - cagrBenchmark : null;

      return {
        key, label,
        baseDate: basePt.date,   baseValue: bv,  baseBenchmark: bbv,
        latestDate: latestPt.date, latestValue: lv, latestBenchmark: lbv,
        absBasket, absBenchmark, absAlpha,
        cagrBasket, cagrBenchmark, cagrAlpha,
      };
    });

  const handleSinceInception = () => {
    if (!histData) return;
    setError('');
    const rows = BASKET_ORDER
      .filter(k => histData[k]?.data?.length >= 2)
      .map(k => {
        const data = histData[k].data;
        const basePt   = { date: data[0].date,                value: data[0].value,                benchmark: data[0].benchmark,                adjusted: false };
        const latestPt = { date: data[data.length - 1].date,  value: data[data.length - 1].value,  benchmark: data[data.length - 1].benchmark,  adjusted: false };
        return { key: k, label: BASKET_LABELS[k], basePt, latestPt };
      });
    if (!rows.length) { setError('No historical data available.'); return; }
    setResults(compute(rows));
  };

  const handleCalculate = () => {
    const built = buildRows();
    if (!built) return;
    const { rows, adjustments } = built;
    if (!rows.length) { setError('No historical data available for the selected date range.'); return; }
    if (adjustments.length > 0) {
      setPendingRows(rows);
      setConfirmInfo(adjustments);
    } else {
      setResults(compute(rows));
    }
  };

  const handleConfirmYes = () => {
    setResults(compute(pendingRows));
    setConfirmInfo(null);
    setPendingRows([]);
  };

  const handleConfirmNo = () => {
    setConfirmInfo(null);
    setPendingRows([]);
  };

  return (
    <div className="cr-page">
      {/* Header */}
      <div className="cr-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={() => { window.location.href = '/wp/' + window.location.search; }}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.9rem', borderRadius: '8px', fontSize: '0.82rem', fontWeight: 600, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            ← Back
          </button>
          <div>
            <h1 className="cr-title">Calculate Returns</h1>
            <p className="cr-subtitle">Historical Index Value Analysis — Niveshaay Investment Advisors</p>
          </div>
        </div>
        {userIsAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <RollbackButtons btnStyle="bp" />
            <button
              onClick={() => setShowDailyPanel(true)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.5rem 1.1rem', borderRadius: '8px', fontSize: '0.88rem', fontWeight: 600,
                background: '#6366f1', border: 'none', color: '#fff', cursor: 'pointer',
              }}
            >
              <i className="fa-solid fa-calendar-plus" /> Add Daily Values
            </button>
          </div>
        )}
      </div>

      {userIsAdmin && showDailyPanel && <DailyValuesPanel onClose={() => setShowDailyPanel(false)} onSaved={fetchHistData} />}

      {/* Controls */}
      <div className="cr-controls-card">
        <div className="cr-controls">
          <div className="cr-field">
            <label>Base Date</label>
            <input
              type="date"
              value={baseDate}
              onChange={e => setBaseDate(e.target.value)}
              className="cr-date-input"
            />
          </div>
          <div className="cr-field">
            <label>Latest Date</label>
            <input
              type="date"
              value={latestDate}
              onChange={e => setLatestDate(e.target.value)}
              className="cr-date-input"
            />
          </div>
          <button
            className="cr-calc-btn"
            onClick={handleCalculate}
            disabled={!histData || !baseDate || !latestDate}
          >
            Calculate Returns
          </button>
          <button
            className="cr-calc-btn cr-calc-btn--inception"
            onClick={handleSinceInception}
            disabled={!histData}
            title="Calculate from each basket's earliest available date to its latest"
          >
            <i className="fa-solid fa-flag" /> Since Inception
          </button>
        </div>
        {error && <p className="cr-error">{error}</p>}
        {loading && <p className="cr-loading">Loading historical data…</p>}
      </div>

      {/* Results table */}
      {results.length > 0 && (
        <div className="cr-table-wrap">
          <table className="cr-table">
            <thead>
              <tr>
                <th rowSpan={2} className="cr-th-main" style={{ userSelect: 'none' }}>
                  <div className="cf-th-inner">
                    <span onClick={() => { setCrSortKey('label'); setCrSortDir(d => crSortKey === 'label' && d === 'asc' ? 'desc' : 'asc'); }} style={{ cursor: 'pointer' }}>Basket</span>
                    <span style={{ fontSize: '0.6em', color: crSortKey === 'label' ? 'var(--accent-blue)' : '#3a4f6a' }}>
                      {crSortKey === 'label' ? (crSortDir === 'asc' ? '▲' : '▼') : '⇅'}
                    </span>
                    <button className={`cf-trigger${crColFilters['label'] != null ? ' on' : ''}`}
                      onClick={e => handleCrFilterOpen('label', e)} title="Filter">▾</button>
                  </div>
                </th>
                <th rowSpan={2} className="cr-th-main">Base Date</th>
                <th colSpan={2} className="cr-th-group">Base Date Index Value</th>
                <th rowSpan={2} className="cr-th-main">Latest Date</th>
                <th colSpan={2} className="cr-th-group">Latest Date Index Value</th>
                <th colSpan={3} className="cr-th-group">Absolute Returns (%)</th>
                <th colSpan={3} className="cr-th-group">CAGR Returns (%)</th>
              </tr>
              <tr>
                <th className="cr-th-sub">Basket</th>
                <th className="cr-th-sub">Nifty SmallCap 100</th>
                <th className="cr-th-sub">Basket</th>
                <th className="cr-th-sub">Nifty SmallCap 100</th>
                {[
                  ['absBasket',    'Basket',              'cr-th-sub'],
                  ['absBenchmark', 'Nifty SmallCap 100',  'cr-th-sub'],
                  ['absAlpha',     'Alpha',               'cr-th-sub cr-th-alpha'],
                  ['cagrBasket',   'Basket',              'cr-th-sub'],
                  ['cagrBenchmark','Nifty SmallCap 100',  'cr-th-sub'],
                  ['cagrAlpha',    'Alpha',               'cr-th-sub cr-th-alpha'],
                ].map(([col, label, cls]) => (
                  <th key={col} className={cls} style={{ userSelect: 'none' }}>
                    <div className="cf-th-inner" style={{ justifyContent: 'center' }}>
                      <span onClick={() => handleCrSort(col, crSortKey === col && crSortDir === 'asc' ? 'desc' : 'asc')} style={{ cursor: 'pointer' }}>{label}</span>
                      <span style={{ fontSize: '0.6em', color: crSortKey === col ? 'var(--accent-blue)' : '#3a4f6a' }}>
                        {crSortKey === col ? (crSortDir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                      <button className={`cf-trigger${crColFilters[col] != null ? ' on' : ''}`}
                        onClick={e => handleCrFilterOpen(col, e)} title="Filter">▾</button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {crDisplayResults.map(r => (
                <tr key={r.key}>
                  <td className="cr-basket-name">{r.label}</td>
                  <td>{fmtDate(r.baseDate)}</td>
                  <td>{r.baseValue.toFixed(2)}</td>
                  <td>{r.baseBenchmark != null ? r.baseBenchmark.toFixed(2) : '—'}</td>
                  <td>{fmtDate(r.latestDate)}</td>
                  <td>{r.latestValue.toFixed(2)}</td>
                  <td>{r.latestBenchmark != null ? r.latestBenchmark.toFixed(2) : '—'}</td>
                  <td className={colorClass(r.absBasket)}>{fmtPct(r.absBasket)}</td>
                  <td className={colorClass(r.absBenchmark)}>{fmtPct(r.absBenchmark)}</td>
                  <td className={`${colorClass(r.absAlpha)} cr-alpha-cell`}>{fmtPct(r.absAlpha)}</td>
                  <td className={colorClass(r.cagrBasket)}>{fmtPct(r.cagrBasket)}</td>
                  <td className={colorClass(r.cagrBenchmark)}>{fmtPct(r.cagrBenchmark)}</td>
                  <td className={`${colorClass(r.cagrAlpha)} cr-alpha-cell`}>{fmtPct(r.cagrAlpha)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirmation modal */}
      {confirmInfo && (
        <div className="cr-overlay">
          <div className="cr-modal">
            <h3 className="cr-modal-title">Date Unavailable — Use Next Available Date?</h3>
            <p className="cr-modal-desc">
              The following dates are not in the historical data. The system found the next available trading date for each. Do you want to proceed?
            </p>
            <div className="cr-confirm-table-wrap">
              <table className="cr-confirm-table">
                <thead>
                  <tr>
                    <th>Basket</th>
                    <th>Field</th>
                    <th>Requested</th>
                    <th>Next Available</th>
                  </tr>
                </thead>
                <tbody>
                  {confirmInfo.map((a, i) => (
                    <tr key={i}>
                      <td>{a.basket}</td>
                      <td>{a.field}</td>
                      <td className="cr-date-req">{fmtDate(a.requested)}</td>
                      <td className="cr-date-avail">{fmtDate(a.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cr-modal-actions">
              <button className="cr-btn-yes" onClick={handleConfirmYes}>Yes, Proceed</button>
              <button className="cr-btn-no"  onClick={handleConfirmNo}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {crOpenFilter && (
        <ColumnFilter
          rows={results}
          getValue={r => getCrColVal(crOpenFilter, r)}
          activeValues={crColFilters[crOpenFilter] ?? null}
          isSorted={crSortKey === crOpenFilter}
          sortDir={crSortDir}
          onSort={dir => handleCrSort(crOpenFilter, dir)}
          onFilter={vals => handleCrFilter(crOpenFilter, vals)}
          onClose={() => setCrOpenFilter(null)}
          top={crFilterPos.top}
          left={crFilterPos.left}
        />
      )}
    </div>
  );
}
