import { useRef, useState } from 'react';
import { formatPercent, getColorClass } from '../App.jsx';

function extractYear(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split(' ');
  return parts.length >= 3 ? parts[2] : null;
}

const _MON = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
function parseDateMs(d) {
  if (!d) return 0;
  const [dd, mm, yy] = d.trim().split(' ');
  const m = _MON[mm];
  return m == null ? 0 : new Date(+yy, m, +dd).getTime();
}

function ActionBadge({ action }) {
  const isWhole = action === 'Wholly Sold';
  return (
    <span style={{
      display: 'inline-block',
      padding: '0.18rem 0.55rem',
      borderRadius: '99px',
      fontSize: '0.72rem',
      fontWeight: 600,
      background: isWhole ? 'rgba(239,68,68,0.12)' : 'rgba(251,191,36,0.12)',
      color:      isWhole ? 'var(--accent-red)'               : 'var(--accent-amber)',
      border:     `1px solid ${isWhole ? 'rgba(239,68,68,0.3)' : 'rgba(251,191,36,0.3)'}`,
      whiteSpace: 'nowrap',
    }}>
      {action || '—'}
    </span>
  );
}

function SoldRow({ row, idx, onBuyChange, onSellChange, onRemove }) {
  const buyRef  = useRef(null);
  const sellRef = useRef(null);

  const absReturn = (row.sellPrice != null && row.buyPrice != null && row.buyPrice !== 0)
    ? (row.sellPrice - row.buyPrice) / row.buyPrice
    : null;

  return (
    <tr>
      <td className="nse-code">{row.nseCode || '—'}</td>

      <td style={{ color: 'var(--text-primary)', fontSize: '0.83rem' }}>
        {row.securityName || '—'}
      </td>

      <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
        {row.date || '—'}
      </td>

      <td><ActionBadge action={row.action} /></td>

      <td style={{ color: 'var(--text-secondary)', fontSize: '0.83rem', textAlign: 'center' }}>
        {row.weightSold != null ? `${row.weightSold}%` : '—'}
      </td>

      <td className="editable-alloc">
        <div className="alloc-wrapper">
          <span className="alloc-suffix" style={{ left: '0.4rem', right: 'auto' }}>₹</span>
          <input
            ref={buyRef}
            type="number" className="cell-edit alloc-edit"
            defaultValue={row.buyPrice ?? ''}
            step="0.01" min="0" placeholder="—"
            style={{ paddingLeft: '1.4rem' }}
            onBlur={() => { const v = buyRef.current?.value; if (v) onBuyChange(idx, v); }}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
          />
        </div>
      </td>

      <td className="editable-alloc">
        <div className="alloc-wrapper">
          <span className="alloc-suffix" style={{ left: '0.4rem', right: 'auto' }}>₹</span>
          <input
            ref={sellRef}
            type="number" className="cell-edit alloc-edit"
            defaultValue={row.sellPrice ?? ''}
            step="0.01" min="0" placeholder="—"
            style={{ paddingLeft: '1.4rem' }}
            onBlur={() => { const v = sellRef.current?.value; if (v) onSellChange(idx, v); }}
            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
          />
        </div>
      </td>

      <td className={`${getColorClass(absReturn)} absret-display`}>
        {absReturn != null ? formatPercent(absReturn) : '—'}
      </td>

      <td className="action-cell">
        <button className="row-action-btn row-remove-btn" title="Remove" onClick={() => onRemove(idx)}>&minus;</button>
      </td>
    </tr>
  );
}

const SI = ({ col, sortKey, sortDir }) => (
  <span style={{ marginLeft: '0.3em', fontSize: '0.62em', color: sortKey === col ? 'var(--accent-blue)' : '#3a4f6a', verticalAlign: 'middle' }}>
    {sortKey === col ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
  </span>
);

const EMPTY_FILTERS = { nse: '', name: '', date: '', action: 'All' };
const ACTION_OPTS   = ['All', 'Wholly Sold', 'Partially Sold'];

const fStyle = {
  width: '100%', background: 'var(--input-bg)', border: '1px solid var(--border-color)',
  borderRadius: '4px', color: 'var(--text-primary)', fontSize: '0.75rem',
  padding: '0.2rem 0.4rem', boxSizing: 'border-box',
};

export default function SoldStocksTable({ rows, activeNseCodes = new Set(), onChange }) {
  const [yearFilter,  setYearFilter]  = useState('All');
  const [viewMode,    setViewMode]    = useState('all');
  const [sortKey,     setSortKey]     = useState(null);
  const [sortDir,     setSortDir]     = useState('asc');
  const [showFilters, setShowFilters] = useState(false);
  const [colFilters,  setColFilters]  = useState(EMPTY_FILTERS);

  const setColF = (k, v) => setColFilters(prev => ({ ...prev, [k]: v }));
  const clearFilters = () => setColFilters(EMPTY_FILTERS);
  const anyFilter = Object.entries(colFilters).some(([k, v]) => k === 'action' ? v !== 'All' : v !== '');

  const handleSort = (key) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(null); setSortDir('asc'); }
    } else { setSortKey(key); setSortDir('asc'); }
  };

  const viewRows = viewMode === 'active' ? rows.filter(r => activeNseCodes.has(r.nseCode)) : rows;
  const years    = [...new Set(viewRows.map(r => extractYear(r.date)).filter(Boolean))].sort((a, b) => b - a);

  // Year → column filters → sort
  const yearRows = yearFilter === 'All' ? viewRows : viewRows.filter(r => extractYear(r.date) === yearFilter);
  const colFiltered = yearRows.filter(r => {
    if (colFilters.nse    && !(r.nseCode      || '').toLowerCase().includes(colFilters.nse.toLowerCase()))    return false;
    if (colFilters.name   && !(r.securityName || '').toLowerCase().includes(colFilters.name.toLowerCase()))   return false;
    if (colFilters.date   && !(r.date         || '').includes(colFilters.date))                               return false;
    if (colFilters.action !== 'All' && r.action !== colFilters.action)                                        return false;
    return true;
  });

  const filtered = sortKey ? [...colFiltered].sort((a, b) => {
    const d = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'nseCode')       return d * (a.nseCode || '').localeCompare(b.nseCode || '');
    if (sortKey === 'securityName')  return d * (a.securityName || '').localeCompare(b.securityName || '');
    if (sortKey === 'date')          return d * (parseDateMs(a.date) - parseDateMs(b.date));
    if (sortKey === 'absReturn') {
      const ra = (a.sellPrice != null && a.buyPrice != null && a.buyPrice !== 0) ? (a.sellPrice - a.buyPrice) / a.buyPrice : null;
      const rb = (b.sellPrice != null && b.buyPrice != null && b.buyPrice !== 0) ? (b.sellPrice - b.buyPrice) / b.buyPrice : null;
      return d * ((ra ?? -Infinity) - (rb ?? -Infinity));
    }
    return d * ((a[sortKey] ?? -Infinity) - (b[sortKey] ?? -Infinity));
  }) : colFiltered;

  const handleBuyChange  = (idx, v) => onChange(rows.map((r, i) => i === idx ? { ...r, buyPrice:  parseFloat(v) || null } : r));
  const handleSellChange = (idx, v) => onChange(rows.map((r, i) => i === idx ? { ...r, sellPrice: parseFloat(v) || null } : r));
  const handleRemove     = (idx)    => onChange(rows.filter((_, i) => i !== idx));

  return (
    <div className="table-container">
      {/* Controls toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {/* View mode toggle */}
        <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border)' }}>
          {[['all', 'All Stocks'], ['active', 'Active Portfolio']].map(([mode, label]) => (
            <button key={mode} onClick={() => { setViewMode(mode); setYearFilter('All'); clearFilters(); }} style={{
              padding: '0.28rem 0.65rem', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', border: 'none',
              background: viewMode === mode ? '#3b82f6' : 'var(--card-bg)',
              color:      viewMode === mode ? '#fff'    : 'var(--text-secondary)',
            }}>{label}</button>
          ))}
        </div>

        <label style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>Year:</label>
        <select
          value={yearFilter}
          onChange={e => setYearFilter(e.target.value)}
          style={{ background: 'var(--card-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.3rem 0.6rem', fontSize: '0.82rem', cursor: 'pointer' }}
        >
          <option value="All">All Years</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>

        {/* Column filters toggle */}
        <button onClick={() => setShowFilters(v => !v)} style={{
          padding: '0.28rem 0.65rem', borderRadius: '6px', fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
          border: '1px solid var(--border)', background: anyFilter ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
          color: anyFilter ? 'var(--accent-blue)' : 'var(--text-secondary)',
        }}>
          {anyFilter ? '⊘ Filters On' : '⊙ Filters'}
        </button>
        {anyFilter && (
          <button onClick={clearFilters} style={{
            padding: '0.28rem 0.55rem', borderRadius: '6px', fontSize: '0.75rem', cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--card-bg)', color: 'var(--accent-red)',
          }}>Clear</button>
        )}

        <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginLeft: 'auto' }}>
          {filtered.length} record{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th onClick={() => handleSort('nseCode')}      style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>NSE Code <SI col="nseCode"      sortKey={sortKey} sortDir={sortDir} /></th>
            <th onClick={() => handleSort('securityName')} style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>Security Name <SI col="securityName" sortKey={sortKey} sortDir={sortDir} /></th>
            <th onClick={() => handleSort('date')}         style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>Date <SI col="date"         sortKey={sortKey} sortDir={sortDir} /></th>
            <th>Action</th>
            <th onClick={() => handleSort('weightSold')}   style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>Weight Sold <SI col="weightSold"   sortKey={sortKey} sortDir={sortDir} /></th>
            <th onClick={() => handleSort('buyPrice')}     style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>Buy Price <SI col="buyPrice"     sortKey={sortKey} sortDir={sortDir} /></th>
            <th onClick={() => handleSort('sellPrice')}    style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>Sell Price <SI col="sellPrice"    sortKey={sortKey} sortDir={sortDir} /></th>
            <th onClick={() => handleSort('absReturn')}    style={{ cursor:'pointer', userSelect:'none', whiteSpace:'nowrap' }}>Absolute Returns <SI col="absReturn"    sortKey={sortKey} sortDir={sortDir} /></th>
            <th></th>
          </tr>
          {showFilters && (
            <tr style={{ background: 'var(--th-bg)' }}>
              <th><input value={colFilters.nse}  onChange={e => setColF('nse',  e.target.value)} placeholder="Filter…"   style={fStyle} /></th>
              <th><input value={colFilters.name} onChange={e => setColF('name', e.target.value)} placeholder="Filter…"   style={fStyle} /></th>
              <th><input value={colFilters.date} onChange={e => setColF('date', e.target.value)} placeholder="e.g. 2024" style={fStyle} /></th>
              <th>
                <select value={colFilters.action} onChange={e => setColF('action', e.target.value)} style={fStyle}>
                  {ACTION_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              </th>
              <th></th><th></th><th></th><th></th><th></th>
            </tr>
          )}
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={9} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                {viewMode === 'active' && viewRows.length === 0
                  ? 'No sell events found for active portfolio stocks.'
                  : anyFilter ? 'No records match the current filters.' : `No sold stocks for ${yearFilter}.`}
              </td>
            </tr>
          ) : (
            filtered.map((row) => {
              const origIdx = rows.indexOf(row);
              const stableKey = `${row.nseCode}|${row.date || ''}|${row.buyPrice ?? ''}|${origIdx}`;
              return (
                <SoldRow
                  key={stableKey} row={row} idx={origIdx}
                  onBuyChange={(_, v) => handleBuyChange(origIdx, v)}
                  onSellChange={(_, v) => handleSellChange(origIdx, v)}
                  onRemove={() => handleRemove(origIdx)}
                />
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
