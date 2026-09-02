import { API_BASE, getAuthToken } from '../api/base.js';
import { useState, useEffect, useRef } from 'react';

const BASKETS = [
  { key: 'Mid_Small_Cap',   label: 'Mid & Small Cap'  },
  { key: 'Green_Energy',    label: 'Green Energy'     },
  { key: 'IPO_Basket',      label: 'IPO Basket'       },
  { key: 'Trends_Triology', label: 'Trends Triology'  },
  { key: 'Techstack',       label: 'Techstack'        },
  { key: 'Make_in_India',   label: 'Make in India'    },
  { key: 'Consumer_Trends', label: 'Consumer Trends'  },
];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[+m-1]} ${y}`;
}

const COL = {
  basket:    { base: '#38bdf8', bg: 'rgba(56,189,248,0.08)',  border: 'rgba(56,189,248,0.3)'  },
  benchmark: { base: '#34d399', bg: 'rgba(52,211,153,0.08)',  border: 'rgba(52,211,153,0.3)'  },
};

const INPUT_BASE = {
  width: '100%',
  padding: '0.6rem 0.85rem',
  borderRadius: '8px',
  fontSize: '1rem',
  fontWeight: 600,
  border: '1.5px solid var(--border-color)',
  background: 'var(--input-bg)',
  outline: 'none',
  transition: 'border-color 0.15s, background 0.15s',
  textAlign: 'right',
  boxSizing: 'border-box',
};

export default function DailyValuesPanel({ onClose, onSaved }) {
  const [date, setDate]       = useState(todayISO());
  const [values, setValues]   = useState(() =>
    Object.fromEntries(BASKETS.map(b => [b.key, { value: '', benchmark: '' }]))
  );
  const [saving, setSaving]   = useState(false);
  const [msg, setMsg]         = useState('');
  const [error, setError]     = useState('');
  const [auditRows, setAuditRows] = useState([]);

  // Excel import state
  const [xlFiles,    setXlFiles]   = useState([]);
  const [xlResults,  setXlResults] = useState([]);
  const [xlError,    setXlError]   = useState('');
  const [xlLoading,  setXlLoading] = useState(false);
  const fileInputRef = useRef(null);

  const overlayRef = useRef(null);

  const fetchAudit = () => {
    fetch(`${API_BASE}/index-history`)
      .then(r => r.json())
      .then(data => {
        const rows = [];
        for (const basket of BASKETS) {
          const info = data[basket.key];
          if (!info?.data) continue;
          for (const entry of info.data) {
            rows.push({ date: entry.date, key: basket.key, label: basket.label, value: entry.value, benchmark: entry.benchmark });
          }
        }
        // Get 7 most recent unique dates that have any data
        const dates = [...new Set(rows.map(r => r.date))].sort((a, b) => b.localeCompare(a)).slice(0, 7);
        const dateSet = new Set(dates);
        const filtered = rows
          .filter(r => dateSet.has(r.date))
          .sort((a, b) => b.date.localeCompare(a.date) || BASKETS.findIndex(x => x.key === a.key) - BASKETS.findIndex(x => x.key === b.key));
        setAuditRows(filtered);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchAudit();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setVal = (basket, field, v) => {
    setMsg('');
    setError('');
    setValues(prev => ({ ...prev, [basket]: { ...prev[basket], [field]: v } }));
  };

  const handleSave = async () => {
    setError('');
    setMsg('');

    const entries = BASKETS
      .map(b => ({
        basket:    b.key,
        value:     parseFloat(values[b.key].value),
        benchmark: parseFloat(values[b.key].benchmark),
      }))
      .filter(e => !isNaN(e.value) && !isNaN(e.benchmark));

    if (!entries.length) {
      setError('Fill in at least one basket value and its benchmark value to save.');
      return;
    }

    setSaving(true);
    try {
      const token = getAuthToken();
      const resp = await fetch(`${API_BASE}/daily-values`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body:    JSON.stringify({ date, entries }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.detail || 'Failed to save.');
      } else {
        const labels = data.saved.map(k => BASKETS.find(b => b.key === k)?.label || k);
        setMsg(`Saved for ${date}: ${labels.join(', ')}`);
        fetchAudit();
        if (onSaved) onSaved();
      }
    } catch {
      setError('Network error — could not save.');
    } finally {
      setSaving(false);
    }
  };

  const filledCount = BASKETS.filter(b => {
    const v = values[b.key];
    return v.value !== '' && v.benchmark !== '';
  }).length;

  const handleExcelImport = async () => {
    if (!xlFiles.length) { setXlError('Please select at least one Excel file.'); return; }
    setXlError(''); setXlResults([]); setXlLoading(true);
    try {
      const fd = new FormData();
      for (const f of xlFiles) fd.append('files', f);
      const xlToken = getAuthToken();
      const resp = await fetch(`${API_BASE}/import-excel-multi`, {
        method: 'POST',
        headers: xlToken ? { Authorization: `Bearer ${xlToken}` } : {},
        body: fd,
      });
      const data = await resp.json();
      if (!resp.ok) {
        setXlError(data.detail || 'Import failed.');
      } else {
        setXlResults(data.results || []);
        setXlFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
        const anyImported = (data.results || []).some(r => r.imported > 0);
        if (anyImported) { fetchAudit(); if (onSaved) onSaved(); }
      }
    } catch {
      setXlError('Network error — could not import.');
    } finally {
      setXlLoading(false);
    }
  };

  // Group audit rows by date for rendering
  const auditByDate = auditRows.reduce((acc, row) => {
    if (!acc[row.date]) acc[row.date] = [];
    acc[row.date].push(row);
    return acc;
  }, {});
  const auditDates = Object.keys(auditByDate).sort((a, b) => b.localeCompare(a));

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'var(--modal-overlay-bg)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div style={{
        background: 'var(--modal-bg)',
        border: '1px solid rgba(139,92,246,0.2)',
        borderRadius: '16px',
        padding: '2rem 2.25rem',
        width: 'min(820px, 96vw)',
        maxHeight: '92vh',
        overflowY: 'auto',
        boxShadow: '0 40px 100px rgba(0,0,0,0.8), 0 0 0 1px rgba(139,92,246,0.08)',
      }}>

        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
              Add Daily Index Values
            </h2>
            <p style={{ margin: '0.3rem 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Fill any basket(s) you have data for — the rest will be skipped.
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--hover-bg)', border: '1px solid var(--border-color)',
              borderRadius: '8px', color: 'var(--text-secondary)', cursor: 'pointer',
              fontSize: '1.15rem', padding: '0.3rem 0.65rem', lineHeight: 1,
            }}
            title="Close (Esc)"
          >&times;</button>
        </div>

        {/* ── Excel Import (always visible) ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem', padding: '1rem 1.1rem', background: 'rgba(139,92,246,0.05)', borderRadius: '12px', border: '1px solid rgba(139,92,246,0.15)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.1rem' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>📊 Import from Excel</span>
            <span style={{ fontSize: '0.72rem', color: 'var(--accent-green)', fontWeight: 600 }}>— only new dates added, existing never overwritten</span>
          </div>
          <div style={{ display: 'flex', gap: '0.85rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', flex: 1, minWidth: '220px' }}>
              <label style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Excel Files (.xlsx) — select multiple</label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                multiple
                onChange={e => { setXlFiles(Array.from(e.target.files || [])); setXlResults([]); setXlError(''); }}
                style={{ background: 'var(--input-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '0.45rem 0.7rem', fontSize: '0.82rem', cursor: 'pointer' }}
              />
              {xlFiles.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {xlFiles.map((f, i) => (
                    <span key={i} style={{ fontSize: '0.72rem', background: 'rgba(139,92,246,0.15)', color: 'var(--accent-blue)', borderRadius: '5px', padding: '0.1rem 0.45rem' }}>{f.name}</span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={handleExcelImport}
              disabled={xlLoading || !xlFiles.length}
              style={{ padding: '0.5rem 1.2rem', borderRadius: '8px', border: 'none', cursor: xlLoading || !xlFiles.length ? 'not-allowed' : 'pointer', background: xlLoading || !xlFiles.length ? 'rgba(139,92,246,0.12)' : 'rgba(139,92,246,0.7)', color: 'var(--accent-blue)', fontSize: '0.85rem', fontWeight: 700, whiteSpace: 'nowrap', opacity: xlLoading || !xlFiles.length ? 0.5 : 1, alignSelf: 'flex-end' }}
            >
              {xlLoading ? 'Importing…' : `⬆ Import${xlFiles.length > 1 ? ` (${xlFiles.length})` : ''}`}
            </button>
          </div>
          {xlResults.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {xlResults.map((r, i) => (
                <div key={i} style={{ padding: '0.45rem 0.75rem', borderRadius: '7px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem', background: r.ok && r.imported > 0 ? 'rgba(74,222,128,0.07)' : r.ok ? 'var(--hover-bg)' : 'rgba(239,68,68,0.07)', border: `1px solid ${r.ok && r.imported > 0 ? 'rgba(74,222,128,0.18)' : r.ok ? 'var(--hover-bg)' : 'rgba(239,68,68,0.18)'}` }}>
                  <span>{r.ok && r.imported > 0 ? '✅' : r.ok ? '✔️' : '❌'}</span>
                  <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{r.file}</span>
                  <span style={{ color: r.ok ? (r.imported > 0 ? 'var(--accent-green)' : 'var(--text-secondary)') : 'var(--accent-red)' }}>{r.error || r.message}</span>
                </div>
              ))}
            </div>
          )}
          {xlError && <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '7px', color: 'var(--accent-red)', fontSize: '0.82rem' }}>{xlError}</div>}
        </div>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>or enter manually</span>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
        </div>

        {/* Date picker — manual entry */}
        {<>
        {/* Date picker */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '1.25rem',
          marginBottom: '1.5rem',
          padding: '0.9rem 1.25rem',
          background: 'rgba(139,92,246,0.07)',
          border: '1px solid rgba(139,92,246,0.18)',
          borderRadius: '10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#8b5cf6', boxShadow: '0 0 6px #8b5cf6' }} />
            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Date
            </span>
          </div>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={{
              background: 'transparent', border: 'none', color: 'var(--text-primary)',
              fontSize: '1.05rem', fontWeight: 600, outline: 'none', cursor: 'pointer', flex: 1, colorScheme: 'dark',
            }}
          />
          <span style={{
            fontSize: '0.78rem', fontWeight: 600, whiteSpace: 'nowrap',
            color: filledCount > 0 ? 'var(--accent-blue)' : 'var(--text-secondary)',
            background: filledCount > 0 ? 'rgba(139,92,246,0.15)' : 'transparent',
            padding: filledCount > 0 ? '0.2rem 0.6rem' : '0',
            borderRadius: '20px', transition: 'all 0.2s',
          }}>
            {filledCount > 0 ? `${filledCount} basket${filledCount > 1 ? 's' : ''} ready` : 'No values entered yet'}
          </span>
        </div>

        {/* Column headers */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 170px 170px',
          gap: '0.75rem', padding: '0 0.5rem 0.6rem',
          borderBottom: '1px solid var(--border-color)', marginBottom: '0.4rem',
        }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Basket</span>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: COL.basket.base, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Basket Value</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: COL.benchmark.base, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Benchmark</span>
            <span style={{ display: 'block', fontSize: '0.68rem', fontWeight: 400, color: 'var(--text-secondary)', marginTop: '0.1rem' }}>NIFTY Smallcap 100</span>
          </div>
        </div>

        {/* Basket input rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: '1.5rem' }}>
          {BASKETS.map((b, idx) => {
            const v = values[b.key];
            const filled = v.value !== '' && v.benchmark !== '';
            return (
              <div
                key={b.key}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 170px 170px',
                  gap: '0.75rem', alignItems: 'center',
                  padding: '0.65rem 0.75rem', borderRadius: '9px',
                  background: filled ? 'rgba(139,92,246,0.06)' : idx % 2 === 0 ? 'var(--hover-bg)' : 'transparent',
                  border: filled ? '1px solid rgba(139,92,246,0.2)' : '1px solid transparent',
                  transition: 'background 0.2s, border-color 0.2s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {filled && <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#8b5cf6', flexShrink: 0 }} />}
                  <span style={{ fontSize: '0.95rem', fontWeight: filled ? 600 : 500, color: filled ? 'var(--text-primary)' : 'var(--text-secondary)', transition: 'color 0.2s' }}>
                    {b.label}
                  </span>
                </div>
                <input
                  type="number" step="0.01" placeholder="—" value={v.value}
                  onChange={e => setVal(b.key, 'value', e.target.value)}
                  style={{
                    ...INPUT_BASE,
                    color: v.value ? COL.basket.base : 'var(--text-secondary)',
                    borderColor: v.value ? COL.basket.border : 'var(--border-color)',
                    background: v.value ? COL.basket.bg : 'var(--input-bg)',
                  }}
                />
                <input
                  type="number" step="0.01" placeholder="—" value={v.benchmark}
                  onChange={e => setVal(b.key, 'benchmark', e.target.value)}
                  style={{
                    ...INPUT_BASE,
                    color: v.benchmark ? COL.benchmark.base : 'var(--text-secondary)',
                    borderColor: v.benchmark ? COL.benchmark.border : 'var(--border-color)',
                    background: v.benchmark ? COL.benchmark.bg : 'var(--input-bg)',
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Feedback */}
        {error && (
          <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: 'var(--accent-red)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>⚠</span> {error}
          </div>
        )}
        {msg && (
          <div style={{ marginBottom: '1rem', padding: '0.7rem 1rem', borderRadius: '8px', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: 'var(--accent-green)', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>✓</span> {msg}
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', alignItems: 'center', marginBottom: '2rem' }}>
          <button
            onClick={onClose}
            style={{ padding: '0.65rem 1.5rem', borderRadius: '9px', fontSize: '0.92rem', fontWeight: 500, background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: '0.68rem 2rem', borderRadius: '9px', fontSize: '0.97rem', fontWeight: 700,
              background: saving ? 'rgba(139,92,246,0.35)' : 'linear-gradient(135deg, #7c3aed 0%, #8b5cf6 50%, #a78bfa 100%)',
              border: '1px solid rgba(139,92,246,0.4)',
              color: saving ? 'rgba(255,255,255,0.5)' : '#fff',
              cursor: saving ? 'default' : 'pointer',
              boxShadow: saving ? 'none' : '0 4px 18px rgba(124,58,237,0.45)',
              letterSpacing: '0.02em',
            }}
          >
            {saving ? 'Saving…' : `Save Data${filledCount > 0 ? ` (${filledCount})` : ''}`}
          </button>
        </div>
        </>}

        {/* ── Audit Trail ── */}
        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem' }}>
            <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#a78bfa', boxShadow: '0 0 5px #a78bfa' }} />
            <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Audit Trail — Last 7 Days
            </span>
          </div>

          {auditDates.length === 0 ? (
            <div style={{ padding: '1.25rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem', background: 'var(--hover-bg)', borderRadius: '8px' }}>
              No data saved yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {auditDates.map(d => (
                <div key={d} style={{ borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
                  {/* Date header */}
                  <div style={{
                    padding: '0.5rem 0.85rem',
                    background: 'rgba(139,92,246,0.1)',
                    borderBottom: '1px solid rgba(139,92,246,0.15)',
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                  }}>
                    <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--accent-blue)' }}>{fmtDate(d)}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--accent-blue)', background: 'rgba(109,40,217,0.2)', padding: '0.1rem 0.45rem', borderRadius: '10px', fontWeight: 600 }}>
                      {auditByDate[d].length} basket{auditByDate[d].length > 1 ? 's' : ''}
                    </span>
                  </div>

                  {/* Basket rows for this date */}
                  <div>
                    {/* Sub-header */}
                    <div style={{
                      display: 'grid', gridTemplateColumns: '1fr 130px 130px',
                      gap: '0.5rem', padding: '0.35rem 0.85rem',
                      background: 'var(--hover-bg)',
                      borderBottom: '1px solid var(--hover-bg)',
                    }}>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Basket</span>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: COL.basket.base, textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right', opacity: 0.7 }}>Index Value</span>
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, color: COL.benchmark.base, textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right', opacity: 0.7 }}>Benchmark<br /><span style={{ fontSize: '0.62rem', fontWeight: 500, textTransform: 'none', letterSpacing: 0, opacity: 0.75 }}>(Nifty Smallcap 100)</span></span>
                    </div>
                    {auditByDate[d].map((row, i) => (
                      <div
                        key={row.key}
                        style={{
                          display: 'grid', gridTemplateColumns: '1fr 130px 130px',
                          gap: '0.5rem', padding: '0.45rem 0.85rem',
                          background: i % 2 === 0 ? 'var(--hover-bg)' : 'transparent',
                          borderBottom: i < auditByDate[d].length - 1 ? '1px solid var(--input-bg)' : 'none',
                        }}
                      >
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 500 }}>{row.label}</span>
                        <span style={{ fontSize: '0.88rem', color: COL.basket.base, fontWeight: 600, textAlign: 'right' }}>{row.value.toFixed(2)}</span>
                        <span style={{ fontSize: '0.88rem', color: COL.benchmark.base, fontWeight: 600, textAlign: 'right' }}>{row.benchmark.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
