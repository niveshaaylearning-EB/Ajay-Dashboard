import { useState } from 'react';
import { confirmHoldingsUploadSimple } from '../api/client.js';

const cellStyle = { padding: '0.35rem 0.7rem', fontSize: '0.79rem', verticalAlign: 'middle' };
const hdrStyle  = { padding: '0.3rem 0.7rem', color: 'var(--text-secondary)', fontWeight: 600,
                    fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em',
                    borderBottom: '1px solid rgba(255,255,255,0.1)', textAlign: 'left' };

const fmtRupee = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const STATUS_STYLE = {
  new:       { label: 'New',       bg: 'rgba(16,185,129,0.14)', color: 'var(--accent-green)' },
  changed:   { label: 'Changed',   bg: 'rgba(251,191,36,0.14)', color: 'var(--accent-amber)' },
  unchanged: { label: 'Unchanged', bg: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' },
};

// Admin uploads a simple SCRIP/BUY PRICE/QUANTITY summary table for a client
// they've already picked (no Client-ID auto-detection like the broker-statement
// format -- this one doesn't have an embeddable ID at all). Allocation % here
// is computed against the client's Total Capital, so a missing/zero Total
// Capital blocks confirming rather than silently producing meaningless %s.
export default function SimpleHoldingsUploadModal({ previewData, onClose, onConfirmed }) {
  const [holdings,   setHoldings]   = useState(previewData.holdings);
  const [confirming, setConfirming] = useState(false);
  const [error,      setError]      = useState('');

  const hasTotalCapital = previewData.totalCapital != null;
  const totalAllocPct = holdings.reduce((s, h) => s + (h.allocationPct || 0), 0);
  // A 0 buy price/quantity means that specific field genuinely failed to
  // read (OCR misread a digit as a letter, for instance) -- block confirming
  // until it's corrected rather than silently writing a 0 into real data.
  const hasZeroField = holdings.some(h => !h.buyPrice || !h.quantity);
  const canConfirm = hasTotalCapital && totalAllocPct <= 100.1 && !hasZeroField && holdings.every(h => h.nseCode);

  const updateCode = (idx, val) => {
    setHoldings(prev => prev.map((h, i) => i === idx ? { ...h, nseCode: val } : h));
  };

  // Buy Price/Quantity are editable too (not just the NSE code) -- the OCR
  // path in particular misreads numbers as often as names, so a value here
  // may need correcting before it ever reaches the allocation math.
  const updateNumber = (idx, field, raw) => {
    const num = parseFloat(raw);
    setHoldings(prev => prev.map((h, i) => {
      if (i !== idx) return h;
      const next = { ...h, [field]: isNaN(num) ? 0 : num };
      next.buyValue = round4(next.buyPrice * next.quantity);
      next.allocationPct = hasTotalCapital ? round4(next.buyValue / previewData.totalCapital * 100) : null;
      return next;
    }));
  };

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setError('');
    setConfirming(true);
    try {
      const data = await confirmHoldingsUploadSimple({
        basketKey: previewData.basketKey,
        holdings,
        filename:  previewData.filename,
      });
      onConfirmed(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--modal-overlay-bg)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', padding: '1rem',
    }}>
      <div style={{
        background: 'var(--modal-bg)', border: '1px solid rgba(99,102,241,0.35)',
        borderRadius: '14px', width: '100%', maxWidth: '820px',
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
      }}>
        {/* Header */}
        <div style={{ padding: '1.2rem 1.5rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.07)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>
              <i className="fa-solid fa-file-import" style={{ color: 'var(--accent-blue)', marginRight: '0.5rem' }} />
              Review Holdings — {previewData.basketLabel}
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              {previewData.filename} · {holdings.length} stock{holdings.length !== 1 ? 's' : ''} · {fmtRupee(previewData.fileTotal)} in this file
            </div>
            <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
              <i className="fa-solid fa-circle-info" style={{ marginRight: '0.3rem' }} />
              This merges into the client's existing holdings — any stock they already hold that isn't in this file stays untouched.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-secondary)', fontSize: '1.1rem', padding: '0.2rem' }}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '1rem 1.5rem' }}>

          {previewData.extractionMethod === 'gemini' && (
            <div style={{
              marginBottom: '1rem', padding: '0.65rem 0.9rem', borderRadius: '8px',
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.3)',
              fontSize: '0.8rem', color: 'var(--text-secondary)',
            }}>
              <i className="fa-solid fa-wand-magic-sparkles" style={{ color: 'var(--accent-blue)', marginRight: '0.4rem' }} />
              <strong style={{ color: 'var(--accent-blue)' }}>Read from an image (Gemini)</strong> — much more reliable than plain OCR, but still worth a quick glance before confirming.
            </div>
          )}

          {previewData.extractionMethod === 'ocr' && (
            <div style={{
              marginBottom: '1rem', padding: '0.65rem 0.9rem', borderRadius: '8px',
              background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
              fontSize: '0.8rem', color: 'var(--text-secondary)',
            }}>
              <i className="fa-solid fa-eye" style={{ color: 'var(--accent-amber)', marginRight: '0.4rem' }} />
              <strong style={{ color: 'var(--accent-amber)' }}>Read from an image (OCR fallback)</strong> — Gemini wasn't available, so this used plain OCR, which is less reliable. Check every scrip code, quantity, and buy price below carefully before confirming.
            </div>
          )}

          {!hasTotalCapital && (
            <div style={{
              marginBottom: '1rem', padding: '0.65rem 0.9rem', borderRadius: '8px',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
              fontSize: '0.8rem', color: 'var(--text-secondary)',
            }}>
              <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--accent-red)', marginRight: '0.4rem' }} />
              <strong style={{ color: 'var(--accent-red)' }}>Total Capital isn't set for this client.</strong> Set it on the All Clients page first — allocation % can't be computed without it.
            </div>
          )}

          {hasTotalCapital && previewData.overCapital && (
            <div style={{
              marginBottom: '1rem', padding: '0.65rem 0.9rem', borderRadius: '8px',
              background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
              fontSize: '0.8rem', color: 'var(--text-secondary)',
            }}>
              <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--accent-amber)', marginRight: '0.4rem' }} />
              The resulting total after merging ({fmtRupee(previewData.mergedTotal ?? previewData.fileTotal)}) is more than this client's Total Capital ({fmtRupee(previewData.totalCapital)}).
            </div>
          )}

          {hasTotalCapital && (
            <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem', fontSize: '0.82rem' }}>
              <div><span style={{ color: 'var(--text-secondary)' }}>Total Capital: </span><strong style={{ color: 'var(--text-primary)' }}>{fmtRupee(previewData.totalCapital)}</strong></div>
              <div><span style={{ color: 'var(--text-secondary)' }}>Invested: </span><strong style={{ color: 'var(--accent-blue)' }}>{totalAllocPct.toFixed(2)}%</strong></div>
              <div><span style={{ color: 'var(--text-secondary)' }}>Cash after upload: </span><strong style={{ color: 'var(--accent-green)' }}>{Math.max(0, 100 - totalAllocPct).toFixed(2)}%</strong></div>
            </div>
          )}

          {/* ── Holdings table ── */}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Status', 'Scrip (as uploaded)', 'Resolved NSE Code', 'Quantity', 'Buy Price', 'Buy Value', 'Allocation %'].map(h => (
                  <th key={h} style={hdrStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {holdings.map((h, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={cellStyle}>
                    {(() => {
                      const s = STATUS_STYLE[h.status] || STATUS_STYLE.new;
                      return (
                        <span style={{ background: s.bg, color: s.color, fontWeight: 600, fontSize: '0.7rem',
                                       padding: '0.15rem 0.5rem', borderRadius: '999px', whiteSpace: 'nowrap' }}>
                          {s.label}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{h.scripName}</td>
                  <td style={cellStyle}>
                    <input
                      value={h.nseCode}
                      onChange={e => updateCode(i, e.target.value.toUpperCase())}
                      style={{
                        width: '9rem', fontWeight: 600, fontFamily: 'monospace',
                        background: 'var(--input-bg)', color: h.nseCode ? 'var(--text-primary)' : 'var(--accent-red)',
                        border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.2rem 0.4rem',
                      }}
                    />
                  </td>
                  <td style={cellStyle}>
                    <input
                      type="number" value={h.quantity}
                      onChange={e => updateNumber(i, 'quantity', e.target.value)}
                      title={!h.quantity ? 'Could not read this value -- enter it manually' : undefined}
                      style={{ width: '6rem', background: 'var(--input-bg)',
                               color: h.quantity ? 'var(--text-primary)' : 'var(--accent-red)',
                               border: `1px solid ${h.quantity ? 'var(--border-color)' : 'var(--accent-red)'}`,
                               borderRadius: '6px', padding: '0.2rem 0.4rem' }}
                    />
                  </td>
                  <td style={cellStyle}>
                    <input
                      type="number" value={h.buyPrice}
                      onChange={e => updateNumber(i, 'buyPrice', e.target.value)}
                      title={!h.buyPrice ? 'Could not read this value -- enter it manually' : undefined}
                      style={{ width: '6.5rem', background: 'var(--input-bg)',
                               color: h.buyPrice ? 'var(--text-primary)' : 'var(--accent-red)',
                               border: `1px solid ${h.buyPrice ? 'var(--border-color)' : 'var(--accent-red)'}`,
                               borderRadius: '6px', padding: '0.2rem 0.4rem' }}
                    />
                  </td>
                  <td style={cellStyle}>{fmtRupee(h.buyValue)}</td>
                  <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--accent-blue)' }}>
                    {h.allocationPct != null ? h.allocationPct.toFixed(2) + '%' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid rgba(255,255,255,0.07)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
          <button
            onClick={onClose}
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)',
                     color: 'var(--accent-red)', borderRadius: '8px', padding: '0.5rem 1.1rem',
                     cursor: 'pointer', fontSize: '0.84rem', fontWeight: 600 }}
          >
            Cancel
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {error && (
              <span style={{ color: 'var(--accent-red)', fontSize: '0.78rem' }}>
                <i className="fa-solid fa-triangle-exclamation" style={{ marginRight: '0.3rem' }} />
                {error}
              </span>
            )}
            <button
              onClick={handleConfirm}
              disabled={confirming || !canConfirm}
              title={!hasTotalCapital ? 'Set this client\'s Total Capital first' : (!canConfirm ? 'Fix the issues above first' : undefined)}
              style={{ background: (confirming || !canConfirm) ? 'rgba(16,185,129,0.08)' : 'rgba(16,185,129,0.18)',
                       border: '1px solid rgba(16,185,129,0.35)',
                       color: (confirming || !canConfirm) ? 'var(--text-secondary)' : 'var(--accent-green)',
                       borderRadius: '8px', padding: '0.5rem 1.4rem',
                       cursor: (confirming || !canConfirm) ? 'default' : 'pointer',
                       fontSize: '0.84rem', fontWeight: 700 }}
            >
              <i className={`fa-solid ${confirming ? 'fa-spinner fa-spin' : 'fa-check'}`}
                 style={{ marginRight: '0.4rem' }} />
              {confirming ? 'Saving…' : `Upload to ${previewData.basketLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function round4(n) { return Math.round(n * 10000) / 10000; }
