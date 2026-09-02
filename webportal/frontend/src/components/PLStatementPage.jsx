import { API_BASE, getAuthToken } from '../api/base.js';
import { fetchBaskets } from '../api/client.js';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
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

function dateToTs(d) {
  try {
    const M = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    const [dd, mm, yy] = d.trim().split(' ');
    return new Date(+yy, M[mm], +dd).getTime();
  } catch { return 0; }
}

const fmtDate  = s => s || '—';
const fmtPct   = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const calcGain = (sp, bp) => (sp != null && bp != null && bp > 0) ? +((sp - bp) / bp * 100).toFixed(2) : null;

const SELL_TYPE_OPTS = ['All', 'Full Exit', 'Partial Sell'];

const EMPTY_FILTERS = { nse: '', name: '', sellDate: '', sellType: 'All', buyDate: '' };

function getPLColVal(field, row) {
  switch (field) {
    case 'nseCode':       return row.nseCode || '';
    case 'securityName':  return row.securityName || '';
    case 'sellDate':      return row.sellDate || '';
    case 'sellType':      return row.sellType || '';
    case 'buyDate':       return row.buyDate || '';
    case 'sellWeight':    return row.sellWeight != null ? String(row.sellWeight) : '';
    case 'sellPrice':     return row.sellPrice != null ? String(row.sellPrice) : '';
    case 'buyPrice':      return row.buyPrice != null ? String(row.buyPrice) : '';
    case 'gainPct':       return row.gainPct != null ? row.gainPct.toFixed(2) + '%' : '';
    default:              return String(row[field] ?? '');
  }
}

function SellTypeBadge({ type }) {
  if (!type) return null;
  const isFull = type === 'Full Exit';
  return (
    <span style={{
      display: 'inline-block', padding: '0.15rem 0.5rem', borderRadius: '99px',
      fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap',
      background: isFull ? 'rgba(239,68,68,0.12)' : 'rgba(251,191,36,0.12)',
      color:      isFull ? 'var(--accent-red)'               : 'var(--accent-amber)',
      border:     `1px solid ${isFull ? 'rgba(239,68,68,0.3)' : 'rgba(251,191,36,0.3)'}`,
    }}>{type}</span>
  );
}

export default function PLStatementPage() {
  const { isAdmin: userIsAdmin } = _getAdminState();
  const [gainsData,         setGainsData]         = useState(null);
  const [loading,           setLoading]           = useState(true);
  const [error,             setError]             = useState('');
  const [basketKey,         setBasketKey]         = useState('');
  const [basketOptions,     setBasketOptions]     = useState([]);
  const [yearFilter,        setYearFilter]        = useState('All');
  const [ohlcFallbacks,     setOhlcFallbacks]     = useState({});
  const [fallbackDismissed, setFallbackDismissed] = useState(false);
  const [viewMode,          setViewMode]          = useState('all');   // 'all' | 'active'
  const [activeSet,         setActiveSet]         = useState(new Set());
  const [colFilters,        setColFilters]        = useState(EMPTY_FILTERS);
  const [overrides,         setOverrides]         = useState({});      // rowKey → {sellPrice, buyPrice}
  const [extraRows,         setExtraRows]         = useState([]);      // manually added rows
  const [deletedKeys,       setDeletedKeys]       = useState(new Set());
  const [showFilters,       setShowFilters]       = useState(false);
  const [xlsColFilters, setXlsColFilters] = useState({});
  const [plOpenFilter,  setPlOpenFilter]  = useState(null);
  const [plFilterPos,   setPlFilterPos]   = useState({ top: 0, left: 0 });

  const handlePlFilterOpen = (col, e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setPlFilterPos({ top: rect.bottom, left: rect.left });
    setPlOpenFilter(prev => prev === col ? null : col);
  };
  const handlePlFilterSort = (col, dir) => { setSortKey(col); setSortDir(dir); };
  const handlePlFilterVal  = (col, vals) => {
    setXlsColFilters(prev => {
      const next = { ...prev };
      if (vals === null) delete next[col]; else next[col] = vals;
      return next;
    });
  };

  useEffect(() => {
    fetch(`${API_BASE}/gains-statement`)
      .then(r => r.json())
      .then(d => { setGainsData(d); setLoading(false); })
      .catch(() => { setError('Failed to load P&L data.'); setLoading(false); });
  }, []);

  useEffect(() => {
    fetchBaskets().then(dict => setBasketOptions(Object.entries(dict || {}).map(([key, label]) => ({ key, label })))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!basketKey && basketOptions.length > 0) setBasketKey(basketOptions[0].key);
  }, [basketKey, basketOptions]);

  // Auto-refresh when user switches back to this tab
  const gainsLastFetch = useRef(Date.now());
  const refreshGains = useCallback(() => {
    gainsLastFetch.current = Date.now();
    fetch(`${API_BASE}/gains-statement`)
      .then(r => r.json())
      .then(d => setGainsData(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - gainsLastFetch.current < 10000) return;
      refreshGains();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshGains]);

  // Auto-refresh when BuyPricePage confirms a rebalance
  useEffect(() => {
    let bc;
    try {
      bc = new BroadcastChannel('nia_rebalance');
      bc.onmessage = () => {
        // Two-pass refresh: 6s for quick OHLC fetch, 22s for full backfill + gains recompute
        setTimeout(refreshGains, 6000);
        setTimeout(refreshGains, 22000);
      };
    } catch {}
    return () => { try { bc?.close(); } catch {} };
  }, [refreshGains]);

  useEffect(() => {
    if (viewMode !== 'active') { setActiveSet(new Set()); return; }
    fetch(`${API_BASE}/basket/${basketKey}`)
      .then(r => r.json())
      .then(d => setActiveSet(new Set((d.stocks || []).map(s => s.nseCode))))
      .catch(() => setActiveSet(new Set()));
  }, [viewMode, basketKey]);

  useEffect(() => {
    setOhlcFallbacks({});
    setFallbackDismissed(false);
    setYearFilter('All');
    setColFilters(EMPTY_FILTERS);
    setXlsColFilters({});
    setOverrides({});
    setExtraRows([]);
    setDeletedKeys(new Set());
    fetch(`${API_BASE}/ohlc-fallbacks/${basketKey}`)
      .then(r => r.json())
      .then(setOhlcFallbacks)
      .catch(() => {});
  }, [basketKey]);

  // Build base rows — one row per sell event using weighted avg buy price
  const baseRows = useMemo(() => {
    if (!gainsData || !gainsData[basketKey]) return [];
    const result = [];
    for (const [nse, stockData] of Object.entries(gainsData[basketKey])) {
      const allGains = [
        ...(stockData.prevSeriesGains   || []),
        ...(stockData.currentSeriesGains || []),
      ].sort((a, b) => dateToTs(a.sellDate) - dateToTs(b.sellDate));
      for (const [gi, gain] of allGains.entries()) {
        const lotsCount    = (gain.lots || []).length;
        const firstBuyDate = gain.lots?.[0]?.buyDate || '';
        const buyDateLabel = lotsCount <= 1
          ? firstBuyDate
          : `${firstBuyDate} +${lotsCount - 1} more`;
        result.push({
          _key:          `${nse}|${gain.sellDate}|${gi}`,
          _custom:       false,
          _lotsCount:    lotsCount,
          _firstBuyDate: firstBuyDate,
          nseCode:       nse,
          securityName:  stockData.securityName || '',
          sellDate:      gain.sellDate,
          sellWeight:    gain.sellWeight,
          sellPrice:     gain.sellPrice,
          sellType:      gain.sellType || null,
          buyDate:       buyDateLabel,
          buyPrice:      gain.weightedAvgBuyPrice ?? null,
          gainPct:       gain.weightedGainPct     ?? null,
        });
      }
    }
    result.sort((a, b) => {
      const d = dateToTs(a.sellDate) - dateToTs(b.sellDate);
      return d !== 0 ? d : a.nseCode.localeCompare(b.nseCode);
    });
    return result;
  }, [gainsData, basketKey]);

  // Merge base + extra, apply overrides, filter deleted
  const allRows = useMemo(() => {
    const combined = [...baseRows, ...extraRows].filter(r => !deletedKeys.has(r._key));
    return combined.map(r => {
      const ov = overrides[r._key];
      if (!ov) return r;
      const sp = ov.sellPrice  !== undefined ? ov.sellPrice  : r.sellPrice;
      const bp = ov.buyPrice   !== undefined ? ov.buyPrice   : r.buyPrice;
      return { ...r, sellPrice: sp, buyPrice: bp, gainPct: calcGain(sp, bp) };
    });
  }, [baseRows, extraRows, deletedKeys, overrides]);

  const years = useMemo(() => {
    const ys = [...new Set(allRows.map(r => (r.sellDate || '').trim().split(' ')[2]).filter(Boolean))];
    return ys.sort((a, b) => +b - +a);
  }, [allRows]);

  // Active-mode filter → year filter → column filters
  const displayRows = useMemo(() => {
    let r = allRows;
    if (viewMode === 'active' && activeSet.size > 0) r = r.filter(x => activeSet.has(x.nseCode));
    if (yearFilter !== 'All') r = r.filter(x => (x.sellDate || '').trim().split(' ')[2] === yearFilter);
    const f = colFilters;
    if (f.nse)                   r = r.filter(x => x.nseCode.toLowerCase().includes(f.nse.toLowerCase()));
    if (f.name)                  r = r.filter(x => (x.securityName||'').toLowerCase().includes(f.name.toLowerCase()));
    if (f.sellDate)              r = r.filter(x => (x.sellDate||'').includes(f.sellDate));
    if (f.sellType !== 'All')    r = r.filter(x => x.sellType === f.sellType);
    if (f.buyDate)               r = r.filter(x => (x.buyDate||'').includes(f.buyDate));
    for (const [field, values] of Object.entries(xlsColFilters)) {
      if (!values) continue;
      if (values.size === 0) { r = []; break; }
      r = r.filter(x => values.has(getPLColVal(field, x)));
    }
    return r;
  }, [allRows, viewMode, activeSet, yearFilter, colFilters, xlsColFilters]);

  const summary = useMemo(() => {
    const valid = displayRows.filter(r => r.gainPct != null);
    if (!valid.length) return null;
    const gains  = valid.filter(r => r.gainPct > 0).length;
    const losses = valid.filter(r => r.gainPct < 0).length;
    const avg    = valid.reduce((s, r) => s + r.gainPct, 0) / valid.length;
    return { total: valid.length, gains, losses, avg };
  }, [displayRows]);

  const [sortKey,     setSortKey]     = useState(null);
  const [sortDir,     setSortDir]     = useState('asc');
  const [pendingSave, setPendingSave] = useState({});
  const [saveStatus,  setSaveStatus]  = useState({});

  const handleSort = (key) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(null); setSortDir('asc'); }
    } else { setSortKey(key); setSortDir('asc'); }
  };

  const sortedRows = useMemo(() => {
    if (!sortKey) return displayRows;
    return [...displayRows].sort((a, b) => {
      const d = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'nseCode' || sortKey === 'securityName' || sortKey === 'sellType' || sortKey === 'buyDate')
        return d * (a[sortKey] || '').localeCompare(b[sortKey] || '');
      if (sortKey === 'sellDate') return d * (dateToTs(a.sellDate) - dateToTs(b.sellDate));
      const va = a[sortKey] ?? -Infinity;
      const vb = b[sortKey] ?? -Infinity;
      return d * (va - vb);
    });
  }, [displayRows, sortKey, sortDir]);

  const setOv = useCallback((key, field, val, row) => {
    const parsed = val === '' ? null : (parseFloat(val) || null);
    setOverrides(prev => ({
      ...prev,
      [key]: { ...(prev[key] || {}), [field]: parsed },
    }));
    // Track as pending save if it's a buy price for a single-lot row (persists to buyOHLC)
    if (field === 'buyPrice' && parsed != null && row && !row._custom && row._lotsCount === 1) {
      setPendingSave(prev => ({ ...prev, [key]: { ...(prev[key] || {}), buyPrice: parsed, buyDate: row._firstBuyDate } }));
    }
  }, []);

  const persistPrice = useCallback(async (row) => {
    const pending = pendingSave[row._key];
    if (!pending) return;
    setSaveStatus(prev => ({ ...prev, [row._key]: 'saving' }));
    try {
      const token = getAuthToken();
      const res = await fetch(`${API_BASE}/set-ohlc-price`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ basket: basketKey, code: row.nseCode, date: row._firstBuyDate, price: pending.buyPrice, type: 'buy' }),
      });
      if (!res.ok) throw new Error();
      // Reload gains data
      const g = await fetch(`${API_BASE}/gains-statement`).then(r => r.json());
      setGainsData(g);
      setPendingSave(prev => { const n = { ...prev }; delete n[row._key]; return n; });
      setSaveStatus(prev => ({ ...prev, [row._key]: 'saved' }));
      setTimeout(() => setSaveStatus(prev => { const n = { ...prev }; delete n[row._key]; return n; }), 2000);
    } catch {
      setSaveStatus(prev => ({ ...prev, [row._key]: 'error' }));
    }
  }, [pendingSave, basketKey]);

  const addRow = () => {
    const key = `custom|${Date.now()}`;
    setExtraRows(prev => [...prev, {
      _key: key, _custom: true,
      nseCode: '', securityName: '', sellDate: '', sellWeight: null,
      sellPrice: null, sellType: null, buyDate: '', buyWeight: null,
      buyPrice: null, gainPct: null,
    }]);
  };

  const deleteRow = key => setDeletedKeys(prev => new Set([...prev, key]));

  const exportXlsx = () => {
    const header = ['NSE Code','Security Name','Sell Date','Sell Type','Weight Sold (%)','Buy Date (FIFO)','Selling Price (₹)','Avg Buying Price (₹)','Gain / Loss (%)'];
    const data = displayRows.map(r => [
      r.nseCode, r.securityName, r.sellDate, r.sellType || '',
      r.sellWeight, r.buyDate,
      r.sellPrice != null ? r.sellPrice : '',
      r.buyPrice  != null ? r.buyPrice  : '',
      r.gainPct   != null ? r.gainPct   : '',
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws['!cols'] = [10,22,12,12,10,18,14,16,12].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'P&L Statement');
    XLSX.writeFile(wb, `PL_${basketKey}_${viewMode === 'active' ? 'ActiveOnly_' : ''}${yearFilter}.xlsx`);
  };

  const setColF = (k, v) => setColFilters(prev => ({ ...prev, [k]: v }));
  const clearFilters = () => setColFilters(EMPTY_FILTERS);
  const currentLabel = basketOptions.find(o => o.key === basketKey)?.label || basketKey;
  const anyColFilter = Object.entries(colFilters).some(([k, v]) => k === 'sellType' ? v !== 'All' : v !== '');

  return (
    <div className="pl-page">
      <div className="pl-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            onClick={() => { window.location.href = '/wp/' + window.location.search; }}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.9rem', borderRadius: '8px', fontSize: '0.82rem', fontWeight: 600, background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            ← Back
          </button>
          <div>
            <h1 className="pl-title">P&amp;L Statement</h1>
            <p className="pl-subtitle">Realised Gains &amp; Losses — Niveshaay Investment Advisors</p>
          </div>
        </div>
        {userIsAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <RollbackButtons btnStyle="bp" />
          </div>
        )}
      </div>

      <div className="pl-controls-card">
        <div className="pl-controls" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>

          {/* Basket */}
          <div className="pl-field">
            <label>Basket</label>
            <select className="pl-select" value={basketKey} onChange={e => setBasketKey(e.target.value)}>
              {basketOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </div>

          {/* View mode toggle */}
          <div className="pl-field">
            <label>View</label>
            <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border)' }}>
              {[['all','All Stocks'],['active','Active Portfolio']].map(([mode, label]) => (
                <button key={mode} onClick={() => setViewMode(mode)} style={{
                  padding: '0.3rem 0.7rem', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', border: 'none',
                  background: viewMode === mode ? '#3b82f6' : 'var(--card-bg)',
                  color:      viewMode === mode ? '#fff'    : 'var(--text-secondary)',
                }}>{label}</button>
              ))}
            </div>
          </div>

          {/* Year */}
          <div className="pl-field">
            <label>Year</label>
            <select className="pl-select" value={yearFilter} onChange={e => setYearFilter(e.target.value)}>
              <option value="All">All Years</option>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem', marginLeft: 'auto' }}>
            <button onClick={refreshGains} title="Reload latest P&L data" style={{
              padding: '0.32rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--text-secondary)',
            }}>↻ Refresh</button>
            <button onClick={() => setShowFilters(v => !v)} style={{
              padding: '0.32rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
              border: '1px solid var(--border)', background: anyColFilter ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
              color: anyColFilter ? 'var(--accent-blue)' : 'var(--text-secondary)',
            }}>
              {anyColFilter ? '⊘ Filters On' : '⊙ Filters'}
            </button>
            {anyColFilter && (
              <button onClick={clearFilters} style={{
                padding: '0.32rem 0.6rem', borderRadius: '6px', fontSize: '0.78rem', cursor: 'pointer',
                border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--accent-red)',
              }}>Clear</button>
            )}
            <button onClick={addRow} style={{
              padding: '0.32rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer',
              border: '1px solid #22c55e', background: 'rgba(34,197,94,0.08)', color: 'var(--accent-green)',
            }}>+ Add Row</button>
            <button onClick={exportXlsx} disabled={displayRows.length === 0} style={{
              padding: '0.32rem 0.75rem', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
              border: '1px solid #60a5fa', background: 'rgba(59,130,246,0.1)', color: 'var(--accent-blue)',
              opacity: displayRows.length === 0 ? 0.4 : 1,
            }}>↓ Export Excel</button>
          </div>
        </div>

        {/* Summary chips */}
        {summary && (
          <div className="pl-summary-chips" style={{ marginTop: '0.6rem' }}>
            <span className="pl-chip pl-chip-total">{summary.total} trade{summary.total !== 1 ? 's' : ''}</span>
            <span className="pl-chip pl-chip-gain">{summary.gains} gain{summary.gains !== 1 ? 's' : ''}</span>
            <span className="pl-chip pl-chip-loss">{summary.losses} loss{summary.losses !== 1 ? 'es' : ''}</span>
            <span className={`pl-chip ${summary.avg >= 0 ? 'pl-chip-gain' : 'pl-chip-loss'}`}>Avg {fmtPct(summary.avg)}</span>
            {viewMode === 'active' && <span className="pl-chip" style={{ background:'rgba(59,130,246,0.12)',color:'var(--accent-blue)',border:'1px solid rgba(59,130,246,0.3)' }}>Active Portfolio Only</span>}
          </div>
        )}

        {error   && <p className="pl-error">{error}</p>}
        {loading && <p className="pl-loading">Loading P&amp;L data…</p>}
      </div>

      {/* OHLC Fallback Banner */}
      {!fallbackDismissed && Object.keys(ohlcFallbacks).length > 0 && (
        <div style={{ margin:'0.5rem 0', padding:'0.75rem 1rem', borderRadius:'8px', background:'rgba(251,191,36,0.08)', border:'1px solid rgba(251,191,36,0.3)', display:'flex', alignItems:'flex-start', gap:'0.75rem', fontSize:'0.82rem' }}>
          <span style={{ color:'var(--accent-amber)', flexShrink:0 }}>⚠</span>
          <div style={{ flex:1 }}>
            <strong style={{ color:'var(--accent-amber)' }}>Next-Trading-Day Prices Used</strong>
            <div style={{ color:'var(--text-secondary)', marginTop:'0.3rem', lineHeight:1.6 }}>
              {Object.entries(ohlcFallbacks).map(([nse, info]) => {
                const parts = [...Object.entries(info.buyFallbacks||{}).map(([r,a]) => `Buy ${r}→${a}`), ...Object.entries(info.sellFallbacks||{}).map(([r,a]) => `Sell ${r}→${a}`)];
                return parts.length ? <div key={nse}><strong style={{ color:'var(--text-primary)' }}>{nse}</strong>{info.securityName ? ` (${info.securityName})` : ''}: {parts.join(', ')}</div> : null;
              })}
            </div>
          </div>
          <button onClick={() => setFallbackDismissed(true)} style={{ background:'none', border:'none', color:'var(--text-secondary)', cursor:'pointer', fontSize:'1rem', padding:0, flexShrink:0 }}>&times;</button>
        </div>
      )}

      {!loading && !error && allRows.length === 0 && (
        <div className="pl-empty">No realised P&amp;L data for <strong>{currentLabel}</strong>.</div>
      )}
      {allRows.length > 0 && displayRows.length === 0 && (
        <div className="pl-empty">No entries match the current filters for <strong>{currentLabel}</strong>.</div>
      )}

      {(displayRows.length > 0 || extraRows.length > 0) && (
        <div className="pl-table-wrap">
          <table className="pl-table">
            <thead>
              <tr>
                {[
                  ['nseCode',      'NSE Code',          false],
                  ['securityName', 'Security Name',     false],
                  ['sellDate',     'Sell Date',         false],
                  ['sellType',     'Sell Type',         false],
                  ['sellWeight',   'Wt. Sold (%)',      true],
                  ['buyDate',      'Buy Date (FIFO)',   false],
                  ['sellPrice',    'Sell Price (₹)',    true],
                  ['buyPrice',     'Avg Buy Price (₹)', true],
                  ['gainPct',      'Gain / Loss (%)',   true],
                ].map(([col, label, right]) => {
                  const isFiltered = xlsColFilters[col] != null;
                  const isSorted   = sortKey === col;
                  return (
                    <th key={col}
                      className={right ? 'pl-th-right' : ''}
                      style={{ userSelect: 'none', whiteSpace: 'nowrap' }}>
                      <div className="cf-th-inner" style={{ justifyContent: right ? 'flex-end' : 'flex-start' }}>
                        <span onClick={() => handleSort(col)} style={{ cursor: 'pointer' }}>{label}</span>
                        <span style={{ fontSize: '0.6em', color: isSorted ? 'var(--accent-blue)' : '#3a4f6a', marginLeft: '0.1em' }}>
                          {isSorted ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                        <button className={`cf-trigger${isFiltered ? ' on' : ''}`}
                          onClick={e => handlePlFilterOpen(col, e)} title="Filter">▾</button>
                      </div>
                    </th>
                  );
                })}
                <th style={{ width: '3rem' }}></th>
              </tr>
              {/* Column filter row */}
              {showFilters && (
                <tr style={{ background: 'var(--th-bg)' }}>
                  <th><input value={colFilters.nse}      onChange={e => setColF('nse', e.target.value)}      placeholder="Filter…" style={fStyle} /></th>
                  <th><input value={colFilters.name}     onChange={e => setColF('name', e.target.value)}     placeholder="Filter…" style={fStyle} /></th>
                  <th><input value={colFilters.sellDate} onChange={e => setColF('sellDate', e.target.value)} placeholder="e.g. 2026" style={fStyle} /></th>
                  <th>
                    <select value={colFilters.sellType} onChange={e => setColF('sellType', e.target.value)} style={fStyle}>
                      {SELL_TYPE_OPTS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </th>
                  <th></th>
                  <th><input value={colFilters.buyDate} onChange={e => setColF('buyDate', e.target.value)} placeholder="e.g. 2024" style={fStyle} /></th>
                  <th></th><th></th><th></th><th></th>
                </tr>
              )}
            </thead>
            <tbody>
              {sortedRows.map((row, i) => {
                const prev         = sortedRows[i - 1];
                const isFirstStock = !prev || prev.nseCode !== row.nseCode;
                const isGain       = row.gainPct != null && row.gainPct >= 0;
                const isLoss       = row.gainPct != null && row.gainPct < 0;
                const ov           = overrides[row._key] || {};
                return (
                  <tr key={row._key} className={isLoss ? 'pl-row-loss' : ''}>
                    {/* NSE Code */}
                    <td className="pl-nse-code">
                      {row._custom ? (
                        <input defaultValue={row.nseCode} onBlur={e => setExtraRows(prev => prev.map(r => r._key === row._key ? { ...r, nseCode: e.target.value.toUpperCase() } : r))} style={cellInput} placeholder="TICKER" />
                      ) : isFirstStock ? row.nseCode : ''}
                    </td>
                    {/* Security Name */}
                    <td className="pl-sec-name">
                      {row._custom ? (
                        <input defaultValue={row.securityName} onBlur={e => setExtraRows(prev => prev.map(r => r._key === row._key ? { ...r, securityName: e.target.value } : r))} style={cellInput} placeholder="Name" />
                      ) : isFirstStock ? (row.securityName || '—') : ''}
                    </td>
                    {/* Sell Date */}
                    <td>
                      {row._custom ? (
                        <input defaultValue={row.sellDate} onBlur={e => setExtraRows(prev => prev.map(r => r._key === row._key ? { ...r, sellDate: e.target.value } : r))} style={cellInput} placeholder="DD Mon YYYY" />
                      ) : fmtDate(row.sellDate)}
                    </td>
                    {/* Sell Type */}
                    <td><SellTypeBadge type={row.sellType} /></td>
                    {/* Weight Sold */}
                    <td className="pl-td-right">
                      {row.sellWeight != null ? row.sellWeight + '%' : (row._custom ? (
                        <input type="number" defaultValue="" onBlur={e => setExtraRows(prev => prev.map(r => r._key === row._key ? { ...r, sellWeight: parseFloat(e.target.value) || null } : r))} style={{ ...cellInput, textAlign: 'right', width: '4rem' }} placeholder="%" />
                      ) : '—')}
                    </td>
                    {/* Buy Date */}
                    <td>
                      {row._custom ? (
                        <input defaultValue={row.buyDate} onBlur={e => setExtraRows(prev => prev.map(r => r._key === row._key ? { ...r, buyDate: e.target.value } : r))} style={cellInput} placeholder="DD Mon YYYY" />
                      ) : fmtDate(row.buyDate)}
                    </td>
                    {/* Sell Price — editable */}
                    <td className="pl-td-right">
                      <input
                        type="number" step="0.01"
                        defaultValue={ov.sellPrice !== undefined ? ov.sellPrice ?? '' : row.sellPrice ?? ''}
                        key={`sp-${row._key}-${ov.sellPrice}`}
                        onBlur={e => setOv(row._key, 'sellPrice', e.target.value, row)}
                        style={{ ...cellInput, textAlign: 'right', width: '6rem', color: ov.sellPrice !== undefined ? 'var(--accent-amber)' : 'inherit' }}
                        placeholder="₹"
                      />
                    </td>
                    {/* Avg Buy Price — editable, Save button for single-lot rows */}
                    <td className="pl-td-right">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', justifyContent: 'flex-end' }}>
                        <input
                          type="number" step="0.01"
                          defaultValue={ov.buyPrice !== undefined ? ov.buyPrice ?? '' : row.buyPrice ?? ''}
                          key={`bp-${row._key}-${ov.buyPrice}`}
                          onBlur={e => setOv(row._key, 'buyPrice', e.target.value, row)}
                          style={{ ...cellInput, textAlign: 'right', width: '5.5rem', color: ov.buyPrice !== undefined ? 'var(--accent-amber)' : 'inherit' }}
                          placeholder="₹"
                        />
                        {userIsAdmin && pendingSave[row._key] && (
                          <button
                            onClick={() => persistPrice(row)}
                            title="Save corrected buy price to database"
                            style={{ background: saveStatus[row._key] === 'saved' ? 'rgba(34,197,94,0.15)' : 'rgba(251,191,36,0.12)', border: `1px solid ${saveStatus[row._key] === 'saved' ? '#22c55e' : '#fbbf24'}`, borderRadius: '3px', color: saveStatus[row._key] === 'saved' ? 'var(--accent-green)' : 'var(--accent-amber)', fontSize: '0.65rem', cursor: 'pointer', padding: '1px 4px', whiteSpace: 'nowrap', fontWeight: 600 }}
                          >
                            {saveStatus[row._key] === 'saving' ? '…' : saveStatus[row._key] === 'saved' ? '✓' : 'Save'}
                          </button>
                        )}
                      </div>
                    </td>
                    {/* Gain / Loss */}
                    <td className={`pl-td-right pl-gain-cell ${isGain ? 'pl-positive' : isLoss ? 'pl-negative' : ''}`}>
                      {fmtPct(row.gainPct)}
                    </td>
                    {/* Remove button */}
                    <td style={{ textAlign: 'center', padding: '0 0.25rem' }}>
                      <button onClick={() => deleteRow(row._key)} title="Remove row" style={{
                        background: 'none', border: '1px solid #475569', borderRadius: '4px',
                        color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.8rem', lineHeight: 1,
                        padding: '1px 5px', fontWeight: 700,
                      }}>−</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {plOpenFilter && (
        <ColumnFilter
          rows={allRows}
          getValue={r => getPLColVal(plOpenFilter, r)}
          activeValues={xlsColFilters[plOpenFilter] ?? null}
          isSorted={sortKey === plOpenFilter}
          sortDir={sortDir}
          onSort={dir => handlePlFilterSort(plOpenFilter, dir)}
          onFilter={vals => handlePlFilterVal(plOpenFilter, vals)}
          onClose={() => setPlOpenFilter(null)}
          top={plFilterPos.top}
          left={plFilterPos.left}
        />
      )}
    </div>
  );
}

const fStyle = {
  width: '100%', background: 'var(--input-bg)', border: '1px solid var(--border-color)',
  borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.75rem',
  padding: '0.2rem 0.4rem', boxSizing: 'border-box',
};

const cellInput = {
  background: 'transparent', border: 'none', borderBottom: '1px solid var(--border-color)',
  color: 'var(--text-primary)', fontSize: '0.82rem', padding: '0.1rem 0.2rem',
  width: '100%', outline: 'none', fontFamily: 'inherit',
};
