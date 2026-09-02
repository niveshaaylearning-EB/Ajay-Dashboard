import { useEffect, useMemo, useState } from 'react';
import ColumnFilter from './ColumnFilter.jsx';
import NseAutocomplete from './NseAutocomplete.jsx';
import {
  fetchWatchlist, fetchWatchlistMeta, addWatchlistCompany,
  updateWatchlistCompany, deleteWatchlistCompany, refreshWatchlistCompany,
} from '../api/client.js';

// Values are CSS custom properties, not hardcoded hex -- each status hue has
// a dark-theme (bright/pastel) and light-theme (darker/more saturated)
// variant defined in App.css, so this automatically stays legible in both
// themes without any theme-detection logic here.
const STATUS_COLORS = {
  'Initial Screening':    'var(--status-initial-screening)',
  'Financial Analysis':   'var(--status-financial-analysis)',
  'Management Study':     'var(--status-management-study)',
  'Scuttlebutt':           'var(--status-scuttlebutt)',
  'Valuation':             'var(--status-valuation)',
  'Investment Committee':  'var(--status-investment-committee)',
  'Approved':              'var(--status-approved)',
  'On Hold':                'var(--status-on-hold)',
  'Rejected':               'var(--status-rejected)',
};
const TERMINAL_STATUSES = ['Approved', 'On Hold', 'Rejected'];

// Column definitions for the main table -- `key` must match a field on the
// watchlist record (or 'upside', computed client-side from fairValue/cmp).
const COLUMNS = [
  { key: 'company',              label: 'Company',              default: true,  sticky: true },
  { key: 'ticker',                label: 'Ticker',                default: true },
  { key: 'sector',                label: 'Sector',                default: true },
  { key: 'industry',              label: 'Industry',              default: false },
  { key: 'marketCap',             label: 'Market Cap (Cr)',       default: true },
  { key: 'cmp',                   label: 'CMP',                   default: true },
  { key: 'fairValue',             label: 'Fair Value',            default: true },
  { key: 'upside',                label: 'Upside %',              default: true },
  { key: 'week52High',            label: '52W High',              default: false },
  { key: 'week52Low',             label: '52W Low',                default: false },
  { key: 'pe',                    label: 'PE',                    default: true },
  { key: 'evEbitda',              label: 'EV/EBITDA',             default: false },
  { key: 'roe',                   label: 'ROE %',                 default: true },
  { key: 'roce',                  label: 'ROCE %',                default: false },
  { key: 'debtEquity',            label: 'Debt/Equity',           default: true },
  { key: 'revenueCagr',           label: 'Revenue CAGR %',        default: false, title: "Yahoo's trailing revenue growth -- a proxy, not a strict multi-year CAGR." },
  { key: 'profitCagr',            label: 'Profit CAGR %',         default: false, title: "Yahoo's trailing earnings growth -- a proxy, not a strict multi-year CAGR." },
  { key: 'fcf',                   label: 'FCF (Cr)',              default: false },
  { key: 'promoterHolding',       label: 'Promoter Holding %',    default: true },
  { key: 'institutionalHolding',  label: 'Institutional Holding %', default: false },
  { key: 'riskScore',             label: 'Risk Score',            default: false },
  { key: 'qualityScore',          label: 'Quality Score',         default: false },
  { key: 'researchScore',         label: 'Research Score',        default: true },
  { key: 'portfolioTags',         label: 'Portfolio Suitability', default: true },
  { key: 'status',                label: 'Status',                default: true },
  { key: 'analyst',               label: 'Analyst',                default: true },
  { key: 'lastUpdated',           label: 'Last Updated',          default: true },
  { key: 'nextReview',            label: 'Next Review',           default: false },
];

const fmtNum = (v, suffix = '') => (v == null || isNaN(v) ? '—' : `${v}${suffix}`);
const colorForPct = (v) => (v == null ? 'neutral' : v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral');

function withDerived(row) {
  const upside = row.fairValue != null && row.cmp ? Math.round(((row.fairValue - row.cmp) / row.cmp) * 1000) / 10 : null;
  return { ...row, upside };
}

function getColVal(key, row) {
  switch (key) {
    case 'portfolioTags': return (row.portfolioTags || []).join(', ');
    case 'marketCap': return row.marketCap != null ? Math.round(row.marketCap).toLocaleString('en-IN') : '';
    case 'cmp':
    case 'fairValue':
    case 'week52High':
    case 'week52Low':      return row[key] != null ? `₹${row[key]}` : '';
    case 'upside':
    case 'roe': case 'roce': case 'revenueCagr': case 'profitCagr':
    case 'promoterHolding': case 'institutionalHolding':
      return row[key] != null ? `${row[key]}%` : '';
    default: return row[key] != null ? String(row[key]) : '';
  }
}

// ── Small building blocks ────────────────────────────────────────────────────

function KpiCard({ label, value, cls }) {
  return (
    <div className="wl-kpi">
      <span className="wl-kpi-label">{label}</span>
      <span className={`wl-kpi-value${cls ? ' ' + cls : ''}`}>{value}</span>
    </div>
  );
}

function StatusBadge({ status }) {
  // color is a CSS custom property (theme-aware), not a hex string -- can't
  // splice an alpha suffix onto it like "${color}55", so color-mix() derives
  // the tinted border/background instead.
  const color = STATUS_COLORS[status] || 'var(--status-initial-screening)';
  return (
    <span className="wl-status-badge" style={{
      color,
      borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
      background: `color-mix(in srgb, ${color} 10%, transparent)`,
    }}>
      {status}
    </span>
  );
}

function StatusStepper({ status, onChange }) {
  const pipeline = ['Initial Screening', 'Financial Analysis', 'Management Study', 'Scuttlebutt', 'Valuation', 'Investment Committee'];
  const currentIdx = pipeline.indexOf(status);
  return (
    <div className="wl-stepper">
      {pipeline.map((s, i) => (
        <button
          key={s}
          className={`wl-step${s === status ? ' active' : ''}${currentIdx >= 0 && i < currentIdx ? ' done' : ''}`}
          onClick={() => onChange(s)}
          title={s}
        >
          {i + 1}. {s}
        </button>
      ))}
      <span className="wl-step-divider">then</span>
      {TERMINAL_STATUSES.map(s => (
        <button
          key={s}
          className={`wl-step wl-step-terminal${s === status ? ' active' : ''}`}
          style={s === status ? { borderColor: STATUS_COLORS[s], color: STATUS_COLORS[s] } : {}}
          onClick={() => onChange(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ── Add Company modal ────────────────────────────────────────────────────────

function AddCompanyModal({ nseSymbols, onClose, onAdded }) {
  const [ticker, setTicker] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleAdd = async () => {
    const code = ticker.trim().toUpperCase();
    if (!code) { setError('Enter an NSE code.'); return; }
    setBusy(true); setError('');
    try {
      const rec = await addWatchlistCompany(code);
      onAdded(rec);
    } catch (e) {
      setError(e.message || 'Could not add this company.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="whatif-overlay" onClick={onClose}>
      <div className="whatif-modal" style={{ width: 'min(420px, 94vw)' }} onClick={e => e.stopPropagation()}>
        <div className="whatif-header">
          <span className="sit-symbol" style={{ background: 'transparent', border: 'none', padding: 0 }}>Add to Watchlist</span>
          <button className="whatif-close" onClick={onClose}>&times;</button>
        </div>
        <div className="whatif-body">
          <div className="whatif-section-title" style={{ marginTop: 0 }}>NSE Code</div>
          <NseAutocomplete initialValue={ticker} onCommit={setTicker} symbols={nseSymbols} />
          <div className="sit-no-data" style={{ marginTop: '0.5rem' }}>
            CMP, market cap, PE, ROE, promoter holding and other fundamentals fetch automatically from Yahoo Finance.
          </div>
          {error && <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>{error}</div>}
        </div>
        <div className="whatif-footer">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-secondary" disabled={busy} onClick={handleAdd}>
            {busy ? 'Fetching…' : 'Add to Watchlist'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Company detail modal ─────────────────────────────────────────────────────

// Fields the user can actually edit here -- everything else (cmp, pe, sector,
// etc.) is auto-fetched/read-only in this modal.
const _EDITABLE_FIELDS = [
  'cmp', 'fairValue', 'targetPrice', 'riskScore', 'qualityScore', 'valuationScore', 'researchScore',
  'status', 'analyst', 'thesis', 'competitiveAdvantages', 'growthDrivers', 'keyRisks',
  'industryTailwinds', 'valuationSummary', 'analystNotes', 'portfolioTags', 'nextReview',
];

function DetailModal({ record, meta, onClose, onSave, onDelete, onRefresh }) {
  const [draft, setDraft] = useState(record);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => setDraft(record), [record]);

  const set = (patch) => { setDraft(d => ({ ...d, ...patch })); setJustSaved(false); };

  // Every field auto-saves independently as you leave it (or click a status/
  // tag) -- nothing here is required, and leaving any field blank never
  // blocks saving the rest. "Save Changes" below is an explicit, visible
  // confirmation on top of that, not a gate.
  const commitField = async (field) => {
    if (draft[field] === record[field]) return;
    setSaving(true); setSaveError('');
    try { await onSave(record.id, { [field]: draft[field] }); }
    catch (e) { setSaveError(e.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const setStatus = async (status) => {
    set({ status });
    setSaving(true); setSaveError('');
    try { await onSave(record.id, { status }); }
    catch (e) { setSaveError(e.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const togglePortfolioTag = async (tag) => {
    const tags = draft.portfolioTags?.includes(tag)
      ? draft.portfolioTags.filter(t => t !== tag)
      : [...(draft.portfolioTags || []), tag];
    set({ portfolioTags: tags });
    setSaving(true); setSaveError('');
    try { await onSave(record.id, { portfolioTags: tags }); }
    catch (e) { setSaveError(e.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const isDirty = _EDITABLE_FIELDS.some(f => JSON.stringify(draft[f] ?? null) !== JSON.stringify(record[f] ?? null));

  const handleSaveAll = async () => {
    const patch = {};
    for (const f of _EDITABLE_FIELDS) {
      if (JSON.stringify(draft[f] ?? null) !== JSON.stringify(record[f] ?? null)) patch[f] = draft[f];
    }
    if (Object.keys(patch).length === 0) return;
    setSaving(true); setSaveError('');
    try { await onSave(record.id, patch); setJustSaved(true); }
    catch (e) { setSaveError(e.message || 'Could not save.'); }
    finally { setSaving(false); }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await onRefresh(record.id); } finally { setRefreshing(false); }
  };

  const textField = (field, label, rows = 3) => (
    <div className="input-group">
      <label>{label}</label>
      <textarea
        rows={rows} value={draft[field] || ''}
        onChange={e => set({ [field]: e.target.value })}
        onBlur={() => commitField(field)}
        style={{ width: '100%', resize: 'vertical' }}
      />
    </div>
  );

  const numField = (field, label, width = '6rem') => (
    <div className="input-group" style={{ display: 'inline-block', marginRight: '0.75rem' }}>
      <label>{label}</label>
      <input
        type="number" step="0.1" value={draft[field] ?? ''} style={{ width }}
        onChange={e => set({ [field]: e.target.value === '' ? null : parseFloat(e.target.value) })}
        onBlur={() => commitField(field)}
      />
    </div>
  );

  return (
    <div className="whatif-overlay" onClick={onClose}>
      <div className="whatif-modal wl-detail-modal" onClick={e => e.stopPropagation()}>
        <div className="whatif-header">
          <span className="sit-symbol" style={{ background: 'transparent', border: 'none', padding: 0 }}>
            {draft.company} <span className="sit-label">({draft.ticker})</span>
          </span>
          <button className="whatif-close" onClick={onClose}>&times;</button>
        </div>

        <div className="whatif-body">
          <div className="whatif-section-title" style={{ marginTop: 0 }}>Status</div>
          <StatusStepper status={draft.status} onChange={setStatus} />

          <div className="whatif-section-title">Overview</div>
          <div className="wl-detail-grid">
            <div><span className="sit-label">Sector</span><div>{draft.sector || '—'}</div></div>
            <div><span className="sit-label">Industry</span><div>{draft.industry || '—'}</div></div>
            <div>
              <span className="sit-label">CMP (₹)</span>
              <div>
                <input
                  type="number" step="0.05" value={draft.cmp ?? ''} className="wl-cmp-input"
                  onChange={e => set({ cmp: e.target.value === '' ? null : parseFloat(e.target.value) })}
                  onBlur={() => commitField('cmp')}
                />
              </div>
            </div>
            <div><span className="sit-label">Market Cap</span><div>{draft.marketCap != null ? `₹${Math.round(draft.marketCap).toLocaleString('en-IN')} Cr` : '—'}</div></div>
            <div><span className="sit-label">PE</span><div>{fmtNum(draft.pe)}</div></div>
            <div><span className="sit-label">ROE</span><div>{fmtNum(draft.roe, '%')}</div></div>
            <div><span className="sit-label">Debt/Equity</span><div>{fmtNum(draft.debtEquity)}</div></div>
            <div><span className="sit-label">Promoter Holding</span><div>{fmtNum(draft.promoterHolding, '%')}</div></div>
          </div>
          <div className="sit-no-data" style={{ marginTop: '0.3rem', marginBottom: '0.3rem' }}>
            CMP is editable -- correct it by hand any time, or pull the live Yahoo Finance price with the button below.
          </div>
          <button className="btn btn-secondary" onClick={handleRefresh} disabled={refreshing} style={{ marginTop: '0.5rem', fontSize: '0.78rem' }}>
            {refreshing ? 'Refreshing…' : 'Refresh Live Data'}
          </button>

          <div className="whatif-section-title">Valuation &amp; Scores (manual)</div>
          {numField('fairValue', 'Fair Value (₹)')}
          {numField('riskScore', 'Risk Score (1-10)', '5rem')}
          {numField('qualityScore', 'Quality Score (1-10)', '5rem')}
          {numField('valuationScore', 'Valuation Score (1-10)', '5rem')}
          {numField('researchScore', 'Research Score (1-10)', '5rem')}

          <div className="whatif-section-title">Portfolio Suitability</div>
          <div className="wl-tag-grid">
            {meta.portfolioTags.map(tag => (
              <label key={tag} className={`wl-tag-chip${draft.portfolioTags?.includes(tag) ? ' active' : ''}`}>
                <input type="checkbox" checked={draft.portfolioTags?.includes(tag) || false} onChange={() => togglePortfolioTag(tag)} />
                {tag}
              </label>
            ))}
          </div>

          <div className="whatif-section-title">Research Notes</div>
          {textField('thesis', 'Investment Thesis -- Why are we tracking this company?')}
          {textField('competitiveAdvantages', 'Competitive Advantages')}
          {textField('growthDrivers', 'Growth Drivers')}
          {textField('keyRisks', 'Key Risks')}
          {textField('industryTailwinds', 'Industry Tailwinds')}
          {textField('valuationSummary', 'Valuation Summary')}
          {textField('analystNotes', 'Analyst Notes', 4)}

          <div className="whatif-section-title">Ownership &amp; Alert Trigger</div>
          <div className="input-group" style={{ display: 'inline-block', marginRight: '0.75rem' }}>
            <label>Analyst (gets notified)</label>
            <input value={draft.analyst || ''} onChange={e => set({ analyst: e.target.value })} onBlur={() => commitField('analyst')} />
          </div>
          <div className="input-group" style={{ display: 'inline-block', marginRight: '0.75rem' }}>
            <label>Next Review Date</label>
            <input type="date" value={draft.nextReview || ''} onChange={e => { set({ nextReview: e.target.value }); }} onBlur={() => commitField('nextReview')} />
          </div>
          {numField('targetPrice', 'Target Price (₹)', '7rem')}
          <div className="sit-no-data" style={{ marginTop: '0.3rem', marginBottom: '0.5rem' }}>
            Whichever happens first -- the review date arriving, or CMP reaching the target price above --
            emails the analyst and shows up in the alert banner on the app's homepage.
          </div>

          {saveError && <div className="whatif-warn" style={{ marginTop: '0.75rem' }}>{saveError}</div>}
          <div className="sit-no-data" style={{ marginTop: '0.75rem' }}>
            Added by {record.addedBy || record.analyst || 'unknown'} on {record.dateAdded} &middot; Last updated {record.lastUpdated}
            {saving && ' · saving…'}
            {!saving && justSaved && <span style={{ color: 'var(--accent-green)' }}> · Saved ✓</span>}
          </div>
          <div className="sit-no-data">
            Every field above saves on its own as soon as you leave it or click it -- nothing is required, fill in only what you have.
          </div>
        </div>

        <div className="whatif-footer">
          <button className="btn btn-secondary" style={{ color: 'var(--negative)' }} onClick={() => onDelete(record.id)}>Remove from Watchlist</button>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
          <button className="btn btn-secondary" onClick={handleSaveAll} disabled={saving || !isDirty} style={{ fontWeight: 600 }}>
            {saving ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main table ────────────────────────────────────────────────────────────

function WatchlistTable({ rows, visibleCols, onOpenDetail, onTogglePin, onDeleteRow }) {
  const [sortKey, setSortKey] = useState('researchScore');
  const [sortDir, setSortDir] = useState('desc');
  const [colFilters, setColFilters] = useState({});
  const [openFilter, setOpenFilter] = useState(null);
  const [filterPos, setFilterPos] = useState({ top: 0, left: 0 });

  const cols = COLUMNS.filter(c => visibleCols.has(c.key));

  const sortedRows = useMemo(() => {
    let out = [...rows];
    if (Object.keys(colFilters).length > 0) {
      out = out.filter(r => {
        for (const [field, values] of Object.entries(colFilters)) {
          if (!values) continue;
          if (!values.has(getColVal(field, r))) return false;
        }
        return true;
      });
    }
    out.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const d = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'company' || sortKey === 'ticker') return d * (a[sortKey] || '').localeCompare(b[sortKey] || '');
      if (sortKey === 'portfolioTags') return d * getColVal('portfolioTags', a).localeCompare(getColVal('portfolioTags', b));
      const va = a[sortKey]; const vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1; if (vb == null) return -1;
      return d * (va - vb);
    });
    return out;
  }, [rows, sortKey, sortDir, colFilters]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };
  const handleFilterOpen = (col, e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setFilterPos({ top: rect.bottom, left: rect.left });
    setOpenFilter(prev => prev === col ? null : col);
  };

  return (
    <div className="table-section wl-table-wrap">
      <table className="portfolio-table wl-table">
        <thead>
          <tr>
            <th style={{ width: '2rem' }} />
            {cols.map(c => (
              <th key={c.key} title={c.title} style={c.sticky ? { position: 'sticky', left: 0, background: 'var(--card-bg)', zIndex: 1 } : {}}>
                <div className="cf-th-inner">
                  <span onClick={() => handleSort(c.key)} style={{ cursor: 'pointer' }}>{c.label}</span>
                  <span onClick={(e) => handleFilterOpen(c.key, e)} className="cf-filter-icon" style={{ cursor: 'pointer', marginLeft: '0.3rem', opacity: colFilters[c.key] ? 1 : 0.4 }}>&#9660;</span>
                </div>
              </th>
            ))}
            <th style={{ width: '3.5rem' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(row => (
            <tr key={row.id} className={row.pinned ? 'wl-row-pinned' : ''}>
              <td>
                <button className="wl-pin-btn" title={row.pinned ? 'Unpin' : 'Pin'} onClick={() => onTogglePin(row.id)}>
                  {row.pinned ? '★' : '☆'}
                </button>
              </td>
              {cols.map(c => (
                <td key={c.key} onClick={() => onOpenDetail(row.id)} style={{ cursor: 'pointer', ...(c.sticky ? { position: 'sticky', left: 0, background: 'var(--card-bg)' } : {}) }}>
                  {c.key === 'status' ? <StatusBadge status={row.status} />
                    : c.key === 'company' ? <strong>{row.company}</strong>
                    : c.key === 'portfolioTags'
                      ? (row.portfolioTags?.length
                          ? <div className="wl-tag-badge-list">{row.portfolioTags.map(t => <span key={t} className="wl-tag-badge">{t}</span>)}</div>
                          : <span className="wl-tag-badge-empty">—</span>)
                    : c.key === 'upside' || c.key === 'roe' || c.key === 'roce' || c.key === 'revenueCagr' || c.key === 'profitCagr'
                      ? <span className={colorForPct(row[c.key])}>{fmtNum(row[c.key], '%')}</span>
                      // marketCap is pre-formatted with toLocaleString (adds commas, e.g.
                      // "11,127"), and ticker/sector/industry/analyst etc. are plain
                      // strings -- none of these are valid input to fmtNum, which treats
                      // anything isNaN() (true for every non-numeric string) as missing
                      // and renders "—" even when the real value is right there. Only
                      // genuinely numeric fields (pe, debtEquity, fcf, ...) should go
                      // through fmtNum; everything else falls back to getColVal, which
                      // already formats every column correctly (it backs sorting/search).
                      : c.key === 'marketCap' ? (row.marketCap != null ? Math.round(row.marketCap).toLocaleString('en-IN') : '—')
                      : c.key === 'cmp' || c.key === 'fairValue' || c.key === 'week52High' || c.key === 'week52Low'
                        ? (row[c.key] != null ? `₹${row[c.key]}` : '—')
                        : c.key === 'promoterHolding' || c.key === 'institutionalHolding'
                          ? fmtNum(row[c.key], '%')
                          : c.key === 'ticker' || c.key === 'sector' || c.key === 'industry' || c.key === 'analyst'
                            ? (getColVal(c.key, row) || '—')
                            : fmtNum(row[c.key])}
                </td>
              ))}
              <td>
                <button className="btn" style={{ padding: '2px 6px', color: 'var(--negative)', borderColor: 'var(--negative)' }} onClick={() => onDeleteRow(row.id)} title="Remove">&times;</button>
              </td>
            </tr>
          ))}
          {sortedRows.length === 0 && (
            <tr><td colSpan={cols.length + 2} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No companies match.</td></tr>
          )}
        </tbody>
      </table>
      {openFilter && (
        <ColumnFilter
          rows={rows}
          getValue={r => getColVal(openFilter, r)}
          activeValues={colFilters[openFilter] ?? null}
          isSorted={sortKey === openFilter}
          sortDir={sortDir}
          onSort={dir => { setSortKey(openFilter); setSortDir(dir); }}
          onFilter={vals => setColFilters(prev => { const next = { ...prev }; if (vals === null) delete next[openFilter]; else next[openFilter] = vals; return next; })}
          onClose={() => setOpenFilter(null)}
          top={filterPos.top}
          left={filterPos.left}
        />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function WatchlistPage({ nseSymbols }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ statuses: [], portfolioTags: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [visibleCols, setVisibleCols] = useState(new Set(COLUMNS.filter(c => c.default).map(c => c.key)));

  const load = async () => {
    setLoading(true); setError('');
    try { setRows((await fetchWatchlist()).map(withDerived)); }
    catch { setError('Could not load the watchlist.'); }
    setLoading(false);
  };

  useEffect(() => {
    load();
    fetchWatchlistMeta().then(setMeta).catch(() => {});
  }, []);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      (r.company || '').toLowerCase().includes(q) ||
      (r.ticker || '').toLowerCase().includes(q) ||
      (r.sector || '').toLowerCase().includes(q) ||
      (r.analyst || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const kpis = useMemo(() => {
    const total = rows.length;
    const thisMonth = new Date().toISOString().slice(0, 7);
    const avg = (arr) => arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null;
    return {
      total,
      newThisMonth: rows.filter(r => (r.dateAdded || '').startsWith(thisMonth)).length,
      activeResearch: rows.filter(r => !TERMINAL_STATUSES.includes(r.status)).length,
      readyForIC: rows.filter(r => r.status === 'Investment Committee').length,
      approved: rows.filter(r => r.status === 'Approved').length,
      rejected: rows.filter(r => r.status === 'Rejected').length,
      avgUpside: avg(rows.map(r => r.upside).filter(v => v != null)),
      avgResearch: avg(rows.map(r => r.researchScore).filter(v => v != null)),
      avgValuation: avg(rows.map(r => r.valuationScore).filter(v => v != null)),
      avgQuality: avg(rows.map(r => r.qualityScore).filter(v => v != null)),
    };
  }, [rows]);

  const handleAdded = (rec) => {
    setRows(prev => [...prev, withDerived(rec)]);
    setAddOpen(false);
    setDetailId(rec.id);
  };
  const handleSave = async (id, patch) => {
    const updated = await updateWatchlistCompany(id, patch);
    setRows(prev => prev.map(r => r.id === id ? withDerived(updated) : r));
  };
  const handleDelete = async (id) => {
    await deleteWatchlistCompany(id);
    setRows(prev => prev.filter(r => r.id !== id));
    setDetailId(null);
  };
  const handleRefresh = async (id) => {
    const updated = await refreshWatchlistCompany(id);
    setRows(prev => prev.map(r => r.id === id ? withDerived(updated) : r));
  };
  const handleTogglePin = (id) => {
    const row = rows.find(r => r.id === id);
    if (row) handleSave(id, { pinned: !row.pinned });
  };

  const handleExportCsv = () => {
    const cols = COLUMNS.filter(c => visibleCols.has(c.key));
    const header = cols.map(c => c.label).join(',');
    const lines = filteredRows.map(r => cols.map(c => {
      const v = getColVal(c.key, r).replace(/,/g, ' ');
      return `"${v}"`;
    }).join(','));
    const csv = [header, ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'watchlist.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const toggleCol = (key) => setVisibleCols(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const detailRecord = detailId ? rows.find(r => r.id === detailId) : null;

  if (loading) return <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading watchlist…</div>;

  return (
    <div className="wl-root">
      <div className="wl-kpi-row">
        <KpiCard label="Total Watchlist"        value={kpis.total} />
        <KpiCard label="New This Month"         value={kpis.newThisMonth} />
        <KpiCard label="Active Research"        value={kpis.activeResearch} />
        <KpiCard label="Ready for IC"           value={kpis.readyForIC} />
        <KpiCard label="Approved"               value={kpis.approved} cls="positive" />
        <KpiCard label="Rejected"               value={kpis.rejected} cls="negative" />
        <KpiCard label="Avg Upside %"           value={kpis.avgUpside != null ? `${kpis.avgUpside}%` : '—'} cls={colorForPct(kpis.avgUpside)} />
        <KpiCard label="Avg Research Score"     value={kpis.avgResearch ?? '—'} />
        <KpiCard label="Avg Valuation Score"    value={kpis.avgValuation ?? '—'} />
        <KpiCard label="Avg Quality Score"      value={kpis.avgQuality ?? '—'} />
      </div>

      <div className="wl-toolbar">
        <input
          className="wl-search" placeholder="Search company, ticker, sector, analyst…"
          value={search} onChange={e => setSearch(e.target.value)}
        />
        <button className="btn btn-secondary" onClick={() => setAddOpen(true)}>+ Add Company</button>
        <div style={{ position: 'relative' }}>
          <button className="btn btn-secondary" onClick={() => setColMenuOpen(v => !v)}>Columns</button>
          {colMenuOpen && (
            <div className="wl-col-menu">
              {COLUMNS.map(c => (
                <label key={c.key} className="wl-col-menu-item">
                  <input type="checkbox" checked={visibleCols.has(c.key)} onChange={() => toggleCol(c.key)} disabled={c.sticky} />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn-secondary" onClick={handleExportCsv}>Export CSV</button>
      </div>

      {error && <div className="whatif-warn" style={{ marginBottom: '0.75rem' }}>{error}</div>}

      <WatchlistTable
        rows={filteredRows}
        visibleCols={visibleCols}
        onOpenDetail={setDetailId}
        onTogglePin={handleTogglePin}
        onDeleteRow={handleDelete}
      />

      {addOpen && <AddCompanyModal nseSymbols={nseSymbols} onClose={() => setAddOpen(false)} onAdded={handleAdded} />}
      {detailRecord && (
        <DetailModal
          record={detailRecord} meta={meta}
          onClose={() => setDetailId(null)}
          onSave={handleSave} onDelete={handleDelete} onRefresh={handleRefresh}
        />
      )}
    </div>
  );
}
