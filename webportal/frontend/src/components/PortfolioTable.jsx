import { useRef, useMemo, useState } from 'react';
import { formatPercent, formatRupee, getColorClass } from '../App.jsx';
import NseAutocomplete from './NseAutocomplete.jsx';
import ColumnFilter from './ColumnFilter.jsx';
import DatePickerPopup from './DatePickerPopup.jsx';
import { toIsoDate, fromIsoDate } from '../whatIfCalc.js';

// Formula and PE Ratio removed per user request
// 'Performance' is a stable header key internally (SORT_KEY/getColVal/column
// filters all key off it) -- the actual displayed text gets a "(<tenure>)"
// suffix appended at render time, so switching tenure never resets an active
// sort/filter on this column the way changing the key string itself would.
const TABLE_HEADERS = [
  'NSE Code', 'Allocation', 'Invested Value', 'Performance', 'Contribution',
  'Buy Date', 'Buy Price', 'CMP', 'Market Cap (Cr)', 'Open 1M', 'Close 1M',
  'High 1M', 'Low 1M', 'Absolute Returns', 'Holding Days', 'CMP Status', 'Actions',
];

const TABLE_HEADERS_IPO = [
  'NSE Code', 'Listing Date', 'Performance', 'Contribution',
  'Listing Price', 'CMP', 'Market Cap (Cr)', 'Open 1M', 'Close 1M',
  'High 1M', 'Low 1M', 'Absolute Returns', 'Holding Days', 'Actions',
];

// Tenures available in the selector, and the minimum holding period (in
// days) required for each to show a value instead of "—". 1M has no
// minimum -- it's shown from day one, same as before this feature existed.
const TENURE_OPTIONS = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y'];
const TENURE_MIN_DAYS = { '1M': 0, '3M': 91, '6M': 182, '1Y': 365, '2Y': 730, '3Y': 1095, '5Y': 1825 };

function getTenurePerformance(row, tenure, perfByTenure) {
  const minDays = TENURE_MIN_DAYS[tenure] ?? 0;
  if (minDays > 0 && (row.holdingDays == null || row.holdingDays < minDays)) return null;
  const perf = perfByTenure?.[row.nseCode]?.[tenure];
  if (perf != null) return perf;
  // 1M has its own independently-reliable source: row.performance, computed
  // from the live open1M/close1M pipeline that loads for every stock
  // regardless of whether Yahoo's chart API can serve deep (3M+) history for
  // it. perfByTenure's batch endpoint requests a 5y bar range up front, which
  // some thinly-traded/SME-listed symbols (e.g. NSE/BSE SME board stocks)
  // never return -- Yahoo caps those to `validRanges: ["1d","5d"]` regardless
  // of what's requested -- silently leaving 1M null there too even though
  // the app already has a perfectly good 1M figure from the other pipeline.
  // Same fallback InsightsSidebar.jsx already uses for exactly this reason.
  if (tenure === '1M' && row.performance != null) return row.performance;
  return null;
}

// row.contribution is always the 1M figure (allocation × 1M performance,
// set upstream) -- fine for callers that specifically want 1M, but the
// Holdings table's own Contribution column should track whichever tenure is
// selected, same as its Performance column already does.
function getTenureContribution(row, tenure, perfByTenure) {
  const perf = getTenurePerformance(row, tenure, perfByTenure);
  return (perf != null && row.allocation != null) ? row.allocation * perf : null;
}

const SORT_KEY = {
  'NSE Code':        'nseCode',
  'Allocation':      'allocation',
  'Performance':     'tenurePerformance',
  'Contribution':    'tenureContribution',
  'Buy Price':       'buyPrice',
  'Listing Price':   'buyPrice',
  'CMP':             'cmp',
  'Market Cap (Cr)': 'marketCap',
  'Open 1M':         'open1M',
  'Close 1M':        'close1M',
  'High 1M':         'high1M',
  'Low 1M':          'low1M',
  'Absolute Returns':'absoluteReturns',
  'Holding Days':    'holdingDays',
};

function getCmpStatus(cmp, targetPrice, stopLoss) {
  if (cmp == null) return null;
  if (targetPrice != null) {
    if (cmp >= targetPrice)             return { text: 'Target Achieved',  color: 'var(--accent-green)' };
    if (cmp >= targetPrice * 0.95)      return { text: 'Near Target Price', color: 'var(--accent-amber)' };
  }
  if (stopLoss != null) {
    if (cmp <= stopLoss)                return { text: 'SL Triggered',     color: 'var(--accent-red)' };
    if (cmp <= stopLoss * 1.05)         return { text: 'Near Stop Loss',   color: 'var(--accent-amber)' };
  }
  return null;
}

function CellLoading() {
  return <span className="cell-loading">Loading…</span>;
}

const OHLC_LABELS = new Set(['Open 1M', 'Close 1M', 'High 1M', 'Low 1M', 'Market Cap (Cr)', 'CMP Status']);

function getColVal(field, row) {
  switch (field) {
    case 'nseCode':         return row.nseCode || '';
    case 'allocation':      return row.allocation != null ? (row.allocation * 100).toFixed(2) + '%' : '';
    case 'performance':     return row.performance != null ? (row.performance * 100).toFixed(2) + '%' : '';
    case 'tenurePerformance': return row.tenurePerformance != null ? (row.tenurePerformance * 100).toFixed(2) + '%' : '';
    case 'contribution':    return row.contribution != null ? (row.contribution * 100).toFixed(2) + '%' : '';
    case 'tenureContribution': return row.tenureContribution != null ? (row.tenureContribution * 100).toFixed(2) + '%' : '';
    case 'buyPrice':        return row.buyPrice != null ? String(row.buyPrice) : '';
    case 'cmp':             return row.cmp != null ? String(row.cmp) : '';
    case 'marketCap':       return row.marketCap != null ? String(Math.round(row.marketCap)) : '';
    case 'open1M':          return row.open1M != null ? String(row.open1M) : '';
    case 'close1M':         return row.close1M != null ? String(row.close1M) : '';
    case 'high1M':          return row.high1M != null ? String(row.high1M) : '';
    case 'low1M':           return row.low1M != null ? String(row.low1M) : '';
    case 'absoluteReturns': return row.absoluteReturns != null ? (row.absoluteReturns * 100).toFixed(2) + '%' : '';
    case 'holdingDays':     return row.holdingDays != null ? `${row.holdingDays} days` : '';
    default:                return String(row[field] ?? '');
  }
}

function DataRow({
  row, idx, searchTerm, nseSymbols, isIPO, showOHLC, readOnly, totalCapital,
  onNseChange, onAllocChange, onBuyPriceChange, onListingDateChange, onBuyDateChange,
  onAddRow, onRemoveRow,
  onInfoClick, onRemoveSimAdded,
}) {
  const buyPriceRef = useRef(null);
  const buyDateBtnRef = useRef(null);
  const [dpOpen, setDpOpen] = useState(false);
  const [dpAnchor, setDpAnchor] = useState({ top: 0, left: 0 });

  const openDatePicker = () => {
    const rect = buyDateBtnRef.current?.getBoundingClientRect();
    if (rect) setDpAnchor({ top: rect.bottom, left: rect.left });
    setDpOpen(true);
  };

  const loading = row.nseCode && row.cmp === null;
  const lv = (val) => loading ? <CellLoading /> : val;

  const lowerSearch  = searchTerm.toLowerCase().trim();
  const lowerNse     = (row.nseCode || '').toLowerCase();
  const matchSearch  = !lowerSearch || lowerNse.includes(lowerSearch);
  const dimRow       = lowerSearch && !matchSearch;
  const highlightRow = lowerSearch && matchSearch;
  const simClass     = row._simAdded ? ' whatif-sim-row' : (row._simEdited || row._simDeleted || row._simReduced || row._simCashTopped) ? ' whatif-sim-row-touched' : '';
  const trClass      = (dimRow ? 'search-dim' : highlightRow ? 'search-highlight' : '') + simClass;

  const handleAllocBlur = (e) => { onAllocChange(idx, e.target.value); };

  // Invested Value (₹) is the other face of the same coin as Allocation %:
  // editing either one recomputes and saves the SAME underlying
  // row.allocation, via the same onAllocChange handler -- so whichever field
  // an admin edits, the other stays in sync on next render.
  const handleInvestedValueBlur = (e) => {
    if (!totalCapital) return;
    const amount = parseFloat(e.target.value);
    if (isNaN(amount) || amount < 0) return;
    onAllocChange(idx, (amount / totalCapital) * 100);
  };
  const investedValueDisplay = (totalCapital && row.allocation != null)
    ? Math.round(row.allocation * totalCapital)
    : '';

  const handleBuyPriceBlur = () => {
    const val = (buyPriceRef.current?.value || '').trim();
    if (val) onBuyPriceChange(idx, val);
  };
  const handleBuyPriceKeyDown = (e) => { if (e.key === 'Enter') e.target.blur(); };

  const allocDisplay    = row.allocation != null ? (row.allocation * 100).toFixed(2) : '';
  const buyPriceDisplay = row.buyPrice   != null ? row.buyPrice : '';

  const simBadge = (row._simEdited || row._simDeleted || row._simAdded || row._simReduced || row._simCashTopped) && (
    <span className="whatif-sim-badge" title={
      row._simDeleted ? 'Excluded in simulation'
      : row._simReduced ? 'Weight reduced in simulation'
      : row._simCashTopped ? 'Absorbed freed-up allocation from a simulated sell'
      : 'Simulated value'
    }>
      SIM
    </span>
  );

  return (
    <tr className={trClass} data-row-index={idx}>
      {/* NSE Code */}
      <td className="nse-code editable-nse pt-sticky-col" style={{ position: 'sticky', left: 0, zIndex: 1, overflow: 'visible' }}>
        {row._simAdded ? (
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{row.nseCode}</span>
        ) : (
          <>
            {!isIPO && (
              <button className="stock-info-btn" onClick={() => onInfoClick(row.nseCode || '')} title="Rebalancing History / What-If Simulator">
                <i className="fa-solid fa-circle-info" />
              </button>
            )}
            <NseAutocomplete
              initialValue={row.nseCode || ''}
              onCommit={(val) => onNseChange(idx, val)}
              symbols={nseSymbols}
              disabled={readOnly}
            />
          </>
        )}
        {simBadge}
      </td>

      {/* Listing Date — IPO only */}
      {isIPO && (
        <td style={{ whiteSpace: 'nowrap' }}>
          <input
            className="cell-edit"
            defaultValue={row.listingDate || ''}
            placeholder="DD Mon YYYY"
            onBlur={e => onListingDateChange && onListingDateChange(idx, e.target.value.trim())}
            disabled={readOnly}
            style={{ width: '7.5rem', fontSize: '0.82rem' }}
          />
        </td>
      )}

      {/* Allocation — hidden for IPO */}
      {!isIPO && (
        <td className="editable-alloc">
          {row._simAdded ? (
            <span style={{ color: 'var(--text-primary)' }}>{allocDisplay}%</span>
          ) : (
            <div className="alloc-wrapper">
              <input
                key={`alloc-${row.nseCode}-${row.allocation}`}
                type="number" className="cell-edit alloc-edit"
                defaultValue={allocDisplay}
                step="0.01" min="0" max="100" placeholder="0.00"
                onBlur={handleAllocBlur}
                disabled={readOnly}
              />
              <span className="alloc-suffix">%</span>
            </div>
          )}
        </td>
      )}

      {/* Invested Value (₹) — hidden for IPO. Two-way linked with Allocation
          via the client's Total Capital (set in the KPI panel): editing
          either field recomputes and saves the same underlying
          row.allocation, so both stay consistent. */}
      {!isIPO && (
        <td className="editable-alloc">
          {row._simAdded ? (
            <span style={{ color: 'var(--text-primary)' }}>
              {totalCapital != null && row.allocation != null ? formatRupee(row.allocation * totalCapital) : '—'}
            </span>
          ) : (
            <div className="alloc-wrapper">
              <span className="alloc-suffix" style={{ left: '0.4rem', right: 'auto' }}>₹</span>
              <input
                key={`iv-${row.nseCode}-${row.allocation}-${totalCapital}`}
                type="number" className="cell-edit"
                defaultValue={investedValueDisplay}
                step="1" min="0" placeholder={totalCapital ? '0' : '—'}
                onBlur={handleInvestedValueBlur}
                disabled={readOnly || !totalCapital}
                title={totalCapital ? '' : 'Set Investment Value in the KPI panel above first'}
                style={{ paddingLeft: '1.4rem', paddingRight: '0.4rem' }}
              />
            </div>
          )}
        </td>
      )}

      {/* Performance (selected tenure) */}
      <td className={`${getColorClass(row.tenurePerformance)} perf-display`}>
        {lv(formatPercent(row.tenurePerformance))}
      </td>

      {/* Contribution (selected tenure) */}
      <td className={`${getColorClass(row.tenureContribution)} contrib-display`}>
        {lv(formatPercent(row.tenureContribution))}
      </td>

      {/* Buy Price Date — non-IPO only. Auto-fetches the OHLC-avg buy price
          for this date (next trading day's value if it lands on a holiday);
          buy price itself stays directly editable below, for admins only. */}
      {!isIPO && (
        <td style={{ whiteSpace: 'nowrap', position: 'relative' }}>
          {row._simAdded ? (
            <span style={{ color: 'var(--text-primary)' }}>{row.buyDate || '—'}</span>
          ) : (
            <>
              <button
                type="button"
                ref={buyDateBtnRef}
                className="cell-edit"
                onClick={openDatePicker}
                disabled={readOnly}
                style={{ width: '8.5rem', fontSize: '0.82rem', textAlign: 'left', cursor: readOnly ? 'default' : 'pointer', background: 'transparent' }}
              >
                {row.buyDate || <span style={{ color: 'var(--text-secondary)' }}>Pick a date</span>}
              </button>
              {dpOpen && (
                <DatePickerPopup
                  value={toIsoDate(row.buyDate || '')}
                  max={new Date().toISOString().slice(0, 10)}
                  top={dpAnchor.top}
                  left={dpAnchor.left}
                  onSelect={iso => onBuyDateChange && onBuyDateChange(idx, fromIsoDate(iso))}
                  onClose={() => setDpOpen(false)}
                />
              )}
            </>
          )}
        </td>
      )}

      {/* Buy Price / Listing Price */}
      <td className="editable-alloc">
        {row._simAdded ? (
          <span style={{ color: 'var(--text-primary)' }}>{formatRupee(row.buyPrice)}</span>
        ) : (
          <div className="alloc-wrapper">
            <span className="alloc-suffix" style={{ left: '0.4rem', right: 'auto' }}>₹</span>
            <input
              key={`bp-${row.nseCode}-${row.buyPrice}`}
              ref={buyPriceRef}
              type="number"
              className="cell-edit buyprice-edit"
              defaultValue={buyPriceDisplay}
              step="0.01" min="0"
              placeholder="—"
              onBlur={handleBuyPriceBlur}
              onKeyDown={handleBuyPriceKeyDown}
              disabled={readOnly}
              style={{ paddingLeft: '1.4rem', paddingRight: '0.4rem' }}
            />
          </div>
        )}
      </td>

      {/* CMP */}
      <td className="cmp-display">{lv(formatRupee(row.cmp))}</td>

      {/* OHLC columns */}
      {showOHLC && <td className="marketcap-display">{lv(formatRupee(row.marketCap))}</td>}
      {showOHLC && <td className="open1m-display">{lv(formatRupee(row.open1M))}</td>}
      {showOHLC && <td className="close1m-display">{lv(formatRupee(row.close1M))}</td>}
      {showOHLC && <td className="high1m-display">{lv(formatRupee(row.high1M))}</td>}
      {showOHLC && <td className="low1m-display">{lv(formatRupee(row.low1M))}</td>}

      {/* Absolute Returns */}
      <td className={`${getColorClass(row.absoluteReturns)} absret-display`}>
        {lv(formatPercent(row.absoluteReturns))}
      </td>

      {/* Holding Days */}
      <td className="holdingdays-display">
        {row.holdingDays != null ? (
          <span className="pt-holding-badge">{row.holdingDays} days</span>
        ) : '—'}
      </td>

      {/* CMP Status */}
      {!isIPO && showOHLC && (
        <td className="cmpstatus-display">
          {(() => {
            const s = getCmpStatus(row.cmp, row.targetPrice, row.stopLoss);
            return s
              ? <span style={{ color: s.color, fontWeight: 600, fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{s.text}</span>
              : <span style={{ color: 'var(--text-secondary)' }}>—</span>;
          })()}
        </td>
      )}

      {/* Actions */}
      <td className="action-cell">
        {row._simAdded ? (
          <button className="row-action-btn row-remove-btn" title="Remove simulated stock" onClick={() => onRemoveSimAdded(row._simId)}>&minus;</button>
        ) : (
          <>
            {!readOnly && <button className="row-action-btn row-add-btn"    title="Add new stock" onClick={() => onAddRow(idx)}>+</button>}
            {!readOnly && <button className="row-action-btn row-remove-btn" title="Remove stock"   onClick={() => onRemoveRow(idx)}>&minus;</button>}
          </>
        )}
      </td>
    </tr>
  );
}

export default function PortfolioTable({
  rows, searchTerm, nseSymbols, isIPO, readOnly = false, totalCapital,
  onNseChange, onAllocChange, onBuyPriceChange, onListingDateChange, onBuyDateChange,
  onAddRow, onRemoveRow,
  onInfoClick, onRemoveSimAdded,
  avgMarketCap, medianPE,
  tenure = '1M', onTenureChange, perfByTenure,
}) {
  const [sortKey,   setSortKey]   = useState('allocation');
  const [sortDir,   setSortDir]   = useState('desc');
  const [showOHLC,  setShowOHLC]  = useState(false);
  const [colFilters,  setColFilters]  = useState({});
  const [openFilter,  setOpenFilter]  = useState(null);
  const [filterPos,   setFilterPos]   = useState({ top: 0, left: 0 });

  // Precompute the selected tenure's (holding-period-gated) value once per
  // render so DataRow/getColVal/sorting/filtering all just read a plain field.
  rows = useMemo(
    () => rows.map(r => ({
      ...r,
      tenurePerformance: getTenurePerformance(r, tenure, perfByTenure),
      tenureContribution: getTenureContribution(r, tenure, perfByTenure),
    })),
    [rows, tenure, perfByTenure]
  );

  const handleSort = (key) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(null); setSortDir('asc'); }
    } else {
      setSortKey(key); setSortDir('asc');
    }
  };

  const handleFilterOpen = (col, e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setFilterPos({ top: rect.bottom, left: rect.left });
    setOpenFilter(prev => prev === col ? null : col);
  };
  const handleFilterSort = (col, dir) => { setSortKey(col); setSortDir(dir); };
  const handleFilterVal  = (col, vals) => {
    setColFilters(prev => {
      const next = { ...prev };
      if (vals === null) delete next[col]; else next[col] = vals;
      return next;
    });
  };

  const sortedEntries = useMemo(() => {
    const indexed = rows.map((r, i) => [r, i]);
    const filtered = Object.keys(colFilters).length === 0 ? indexed : indexed.filter(([r]) => {
      for (const [field, values] of Object.entries(colFilters)) {
        if (!values) continue;
        if (values.size === 0) return false;
        if (!values.has(getColVal(field, r))) return false;
      }
      return true;
    });
    if (!sortKey) return filtered;
    return [...filtered].sort(([a], [b]) => {
      const d = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'nseCode') return d * (a.nseCode || '').localeCompare(b.nseCode || '');
      const va = a[sortKey] ?? -Infinity;
      const vb = b[sortKey] ?? -Infinity;
      return d * (va - vb);
    });
  }, [rows, sortKey, sortDir, colFilters]);

  const totalAllocation = rows.reduce((s, r) => s + (r.allocation || 0), 0);
  const totalTenureContribution = rows.reduce((s, r) => s + (r.tenureContribution || 0), 0);
  // IPO_Recommendations is equal(-ish)-weighted, not capital-weighted, so its
  // summary row is labelled "Average" -- Performance there is a plain mean
  // across stocks with a value this tenure, rather than a weighted figure.
  const validTenurePerfs = rows.map(r => r.tenurePerformance).filter(v => v != null && isFinite(v));
  const avgTenurePerformance = validTenurePerfs.length
    ? validTenurePerfs.reduce((s, v) => s + v, 0) / validTenurePerfs.length
    : null;
  const headers = (isIPO ? TABLE_HEADERS_IPO : TABLE_HEADERS).filter(h => showOHLC || !OHLC_LABELS.has(h));
  const colCount = headers.length;
  const headerLabel = (h) => {
    if (h === 'Performance')  return `Performance (${tenure})`;
    if (h === 'Contribution') return `Contribution (${tenure})`;
    return h;
  };

  if (rows.length === 0) {
    return (
      <div className="table-container">
        <table className="portfolio-table">
          <thead><tr>{headers.map(h => <th key={h}>{headerLabel(h)}</th>)}</tr></thead>
          <tbody>
            <tr>
              <td colSpan={colCount} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                {readOnly ? 'No stocks in this basket.' : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem' }}>
                    <span>No stocks in this basket yet.</span>
                    <button className="btn btn-secondary" title="Add new stock" onClick={() => onAddRow(-1)}>+ Add stock</button>
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
    <div className="ohlc-toggle-bar">
      {onTenureChange && (
        <div className="pt-tenure-select">
          <span className="pt-tenure-label">Performance:</span>
          {TENURE_OPTIONS.map(t => (
            <button
              key={t}
              className={`pt-tenure-pill${t === tenure ? ' active' : ''}`}
              onClick={() => onTenureChange(t)}
              title={`Show ${t} performance (available once a stock has been held long enough)`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        {!readOnly && (
          <button className="btn btn-secondary" onClick={() => onAddRow(rows.length - 1)}>
            + Add Stock
          </button>
        )}
        <button className="ohlc-toggle-btn" onClick={() => setShowOHLC(v => !v)}>
          {showOHLC ? '▲ Hide Details' : '▼ Show Details'}
        </button>
      </div>
    </div>
    <div className="table-container">
      <table className="portfolio-table">
        <thead>
          <tr>
            {headers.map(h => {
              const col = SORT_KEY[h];
              const isFiltered = col && colFilters[col] != null;
              const isSorted   = col && sortKey === col;
              if (col) {
                return (
                  <th key={h} style={{ whiteSpace: 'nowrap', userSelect: 'none' }}>
                    <div className="cf-th-inner">
                      <span onClick={() => handleSort(col)} style={{ cursor: 'pointer' }}>{headerLabel(h)}</span>
                      <span style={{ fontSize: '0.6em', color: isSorted ? 'var(--accent-blue)' : '#3a4f6a', marginLeft: '0.1em' }}>
                        {isSorted ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                      </span>
                      <button className={`cf-trigger${isFiltered ? ' on' : ''}`}
                        onClick={e => handleFilterOpen(col, e)} title="Filter">▾</button>
                    </div>
                  </th>
                );
              }
              return <th key={h}>{headerLabel(h)}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {sortedEntries.map(([row, origIdx]) => (
            <DataRow
              key={origIdx}
              row={row} idx={origIdx} searchTerm={searchTerm} nseSymbols={nseSymbols} isIPO={isIPO} showOHLC={showOHLC} readOnly={readOnly} totalCapital={totalCapital}
              onNseChange={onNseChange}
              onAllocChange={onAllocChange}
              onBuyPriceChange={onBuyPriceChange}
              onListingDateChange={onListingDateChange}
              onBuyDateChange={onBuyDateChange}
              onAddRow={onAddRow}
              onRemoveRow={onRemoveRow}
              onInfoClick={onInfoClick}
              onRemoveSimAdded={onRemoveSimAdded}
            />
          ))}

          {/* Summary row */}
          {isIPO ? (
            <tr className="summary-row pt-summary-row">
              <td style={{ fontWeight: 700, color: 'var(--text-secondary)', paddingRight: '1.5rem', textAlign: 'right' }}>Average</td>
              <td />{/* Listing Date */}
              <td style={{ fontWeight: 700 }} className={getColorClass(avgTenurePerformance)}>{formatPercent(avgTenurePerformance)}</td>
              <td style={{ fontWeight: 700 }} className={getColorClass(totalTenureContribution)}>{formatPercent(totalTenureContribution)}</td>
              <td colSpan={2} />{/* Listing Price + CMP */}
              {showOHLC && <td style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatRupee(Math.round(avgMarketCap))}</td>}
              {showOHLC && <td colSpan={4} />}
              <td />{/* Abs Returns */}
              <td />{/* Holding Days */}
              <td />{/* Actions */}
            </tr>
          ) : (
            <tr className="summary-row pt-summary-row">
              <td style={{ fontWeight: 700, color: 'var(--text-secondary)', textAlign: 'right' }}>Total / Avg</td>
              <td className="editable-alloc">
                {/* Mirrors the data rows' alloc-wrapper box (right-aligned
                    58px number + separate % suffix) exactly, instead of a
                    plain text node -- otherwise this never lands in the same
                    horizontal position as the weight values above it. */}
                <div className="alloc-wrapper">
                  <span style={{ width: '58px', textAlign: 'right', fontWeight: 700, color: 'var(--accent-blue)' }}>
                    {(totalAllocation * 100).toFixed(2)}
                  </span>
                  <span className="alloc-suffix" style={{ fontWeight: 700, color: 'var(--accent-blue)' }}>%</span>
                </div>
              </td>
              <td style={{ fontWeight: 700, color: 'var(--accent-blue)' }}>
                {totalCapital != null ? formatRupee(totalAllocation * totalCapital) : ''}
              </td>
              <td />{/* Performance */}
              <td style={{ fontWeight: 700 }} className={getColorClass(totalTenureContribution)}>{formatPercent(totalTenureContribution)}</td>
              <td colSpan={3} />{/* Buy Date + Buy Price + CMP */}
              {showOHLC && <td style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{formatRupee(Math.round(avgMarketCap))}</td>}
              {showOHLC && <td colSpan={4} />}
              <td />{/* Abs Returns */}
              <td />{/* Holding Days */}
              {showOHLC && <td />}{/* CMP Status */}
              <td />{/* Actions */}
            </tr>
          )}
        </tbody>
      </table>
    </div>
    {openFilter && (
      <ColumnFilter
        rows={rows}
        getValue={r => getColVal(openFilter, r)}
        activeValues={colFilters[openFilter] ?? null}
        isSorted={sortKey === openFilter}
        sortDir={sortDir}
        onSort={dir => handleFilterSort(openFilter, dir)}
        onFilter={vals => handleFilterVal(openFilter, vals)}
        onClose={() => setOpenFilter(null)}
        top={filterPos.top}
        left={filterPos.left}
      />
    )}
    </>
  );
}
