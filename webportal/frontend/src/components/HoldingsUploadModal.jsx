import { API_BASE, getAuthToken } from '../api/base.js';
import { useState } from 'react';

const cellStyle = { padding: '0.35rem 0.7rem', fontSize: '0.79rem', verticalAlign: 'middle' };
const hdrStyle  = { padding: '0.3rem 0.7rem', color: 'var(--text-secondary)', fontWeight: 600,
                    fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em',
                    borderBottom: '1px solid rgba(255,255,255,0.1)', textAlign: 'left' };

const fmtRupee = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Admin uploads a broker holdings statement (.xlsx, e.g. "holdings-PA8384.xlsx")
// for review here before it's applied. The file's "Client ID" is matched
// against client_id_map.json (built up as admins link IDs to clients over
// time) -- first time a given ID shows up, the admin links it to an existing
// client or creates a new one right here, and that link is remembered so
// future uploads for the same client resolve automatically.
export default function HoldingsUploadModal({ previewData, basketOptions, onClose, onConfirmed }) {
  const alreadyLinked = !!previewData.basketKey;
  const [relinking,       setRelinking]       = useState(false);
  const [linkChoice,      setLinkChoice]      = useState(alreadyLinked ? 'matched' : (basketOptions.length ? 'existing' : 'new'));
  const [selectedBasket,  setSelectedBasket]  = useState('');
  const [newClientName,   setNewClientName]   = useState('');
  const [confirming,      setConfirming]      = useState(false);
  const [error,           setError]           = useState('');

  const showChooser = relinking || !alreadyLinked;
  const resolvedBasketKey = !showChooser
    ? previewData.basketKey
    : (linkChoice === 'existing' ? selectedBasket : '');
  const resolvedLabel = !showChooser
    ? previewData.basketLabel
    : (linkChoice === 'existing'
        ? basketOptions.find(b => b.key === selectedBasket)?.label
        : newClientName.trim());

  const canConfirm = showChooser
    ? (linkChoice === 'existing' ? !!selectedBasket : !!newClientName.trim())
    : true;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setError('');
    setConfirming(true);
    try {
      const token = getAuthToken();
      const resp = await fetch(`${API_BASE}/confirm-holdings-upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          clientId:       previewData.clientId,
          basketKey:      showChooser && linkChoice === 'new' ? '' : resolvedBasketKey,
          newClientName:  showChooser && linkChoice === 'new' ? newClientName.trim() : '',
          holdings:       previewData.holdings,
          filename:       previewData.filename,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const d = data.detail;
        throw new Error(Array.isArray(d) ? d.map(e => e.msg || JSON.stringify(e)).join('; ') : String(d || 'Confirm failed'));
      }
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
              Review Broker Holdings — Client ID {previewData.clientId}
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              {previewData.filename} · {previewData.holdings.length} stock{previewData.holdings.length !== 1 ? 's' : ''} · {fmtRupee(previewData.totalInvested)} invested
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-secondary)', fontSize: '1.1rem', padding: '0.2rem' }}>
            <i className="fa-solid fa-xmark" />
          </button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '1rem 1.5rem' }}>

          {/* ── Client link ── */}
          <div style={{ marginBottom: '1.1rem' }}>
            {!showChooser ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.84rem' }}>
                <i className="fa-solid fa-link" style={{ color: 'var(--accent-green)' }} />
                <span style={{ color: 'var(--text-secondary)' }}>Client ID <strong style={{ color: 'var(--text-primary)' }}>{previewData.clientId}</strong> is linked to</span>
                <strong style={{ color: 'var(--text-primary)' }}>{previewData.basketLabel}</strong>
                <button
                  onClick={() => setRelinking(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent-blue)', fontSize: '0.76rem',
                           cursor: 'pointer', textDecoration: 'underline', marginLeft: '0.4rem' }}
                >
                  Not this client? Change link
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>
                  <i className="fa-solid fa-circle-question" style={{ color: 'var(--accent-amber)', marginRight: '0.4rem' }} />
                  Client ID <strong style={{ color: 'var(--text-primary)' }}>{previewData.clientId}</strong> hasn't been linked to a client yet.
                  Link it to an existing one, or create a new client — remembered for future uploads of this Client ID.
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.6rem', fontSize: '0.82rem' }}>
                  {basketOptions.length > 0 && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <input type="radio" checked={linkChoice === 'existing'} onChange={() => setLinkChoice('existing')} /> Link to existing client
                    </label>
                  )}
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <input type="radio" checked={linkChoice === 'new'} onChange={() => setLinkChoice('new')} /> Create new client
                  </label>
                </div>
                {linkChoice === 'existing' && (
                  <select value={selectedBasket} onChange={e => setSelectedBasket(e.target.value)} style={{ width: '100%' }}>
                    <option value="">Select a client…</option>
                    {basketOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                )}
                {linkChoice === 'new' && (
                  <input
                    type="text"
                    placeholder="New client name"
                    value={newClientName}
                    onChange={e => setNewClientName(e.target.value)}
                    style={{ width: '100%' }}
                  />
                )}
              </>
            )}
          </div>

          {/* ── Mutual funds banner ── */}
          {previewData.mutualFunds && (
            <div style={{
              marginBottom: '1rem', padding: '0.65rem 0.9rem', borderRadius: '8px',
              background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)',
              fontSize: '0.8rem', color: 'var(--text-secondary)',
            }}>
              <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--accent-amber)', marginRight: '0.4rem' }} />
              <strong style={{ color: 'var(--accent-amber)' }}>{previewData.mutualFunds.count} mutual fund holding{previewData.mutualFunds.count !== 1 ? 's' : ''} found in this file were not imported</strong> (equity only): {previewData.mutualFunds.funds.join(', ')}
            </div>
          )}

          {/* ── Holdings table ── */}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Symbol', 'Sector', 'Quantity', 'Avg. Buy Price', 'Invested Value', 'Allocation %'].map(h => (
                  <th key={h} style={hdrStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewData.holdings.map((h, i) => (
                <tr key={h.nseCode + i} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>{h.nseCode}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>{h.sector || '—'}</td>
                  <td style={cellStyle}>{h.quantity}</td>
                  <td style={cellStyle}>{fmtRupee(h.avgPrice)}</td>
                  <td style={cellStyle}>{fmtRupee(h.investedValue)}</td>
                  <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--accent-blue)' }}>{h.allocationPct.toFixed(2)}%</td>
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
              style={{ background: (confirming || !canConfirm) ? 'rgba(16,185,129,0.08)' : 'rgba(16,185,129,0.18)',
                       border: '1px solid rgba(16,185,129,0.35)',
                       color: (confirming || !canConfirm) ? 'var(--text-secondary)' : 'var(--accent-green)',
                       borderRadius: '8px', padding: '0.5rem 1.4rem',
                       cursor: (confirming || !canConfirm) ? 'default' : 'pointer',
                       fontSize: '0.84rem', fontWeight: 700 }}
            >
              <i className={`fa-solid ${confirming ? 'fa-spinner fa-spin' : 'fa-check'}`}
                 style={{ marginRight: '0.4rem' }} />
              {confirming ? 'Saving…' : `Upload to ${resolvedLabel || '…'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
