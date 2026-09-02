import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Target, AlertTriangle, X, ChevronDown, ChevronRight } from 'lucide-react';

import { API_BASE } from '../config.js';

/* ── Stoploss alert banner ─────────────────────────────────────────────────── */
export function StoplossAlerts({ holdings, targets }) {
  const breached = holdings.filter(h => {
    const t = targets[h.code];
    return t?.stoploss && Number(h.cmp) > 0 && Number(h.cmp) < t.stoploss;
  });
  if (!breached.length) return null;
  return (
    <div style={{
      marginBottom: '20px', padding: '14px 18px',
      background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
      borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--negative)' }}>
        <AlertTriangle size={18} /> {breached.length} Stoploss Breach{breached.length > 1 ? 'es' : ''}
      </div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {breached.map(h => {
          const t   = targets[h.code];
          const pct = ((h.cmp - t.stoploss) / t.stoploss * 100).toFixed(1);
          return (
            <div key={h.code} style={{
              background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '8px', padding: '6px 12px', fontSize: '0.8rem',
            }}>
              <strong>{h.code}</strong>
              <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>
                CMP ₹{h.cmp.toFixed(2)} · SL ₹{t.stoploss.toFixed(2)} · <span style={{ color: 'var(--negative)' }}>{pct}%</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Target / Stoploss panel (full table) ──────────────────────────────────── */
export default function TargetStoplossPanel({ basketId, holdings }) {
  const [targets, setTargets]   = useState({});
  const [open,    setOpen]      = useState(false);
  const [editing, setEditing]   = useState(null); // stock code being edited
  const [form,    setForm]      = useState({ target_price: '', stoploss: '' });
  const [saving,  setSaving]    = useState(false);

  const load = useCallback(() => {
    if (!basketId) return;
    axios.get(`${API_BASE}/portfolio/${basketId}/targets`)
      .then(r => setTargets(r.data || {}))
      .catch(() => {});
  }, [basketId]);

  useEffect(() => { load(); }, [load]);

  const startEdit = (code) => {
    const t = targets[code] || {};
    setForm({ target_price: t.target_price ?? '', stoploss: t.stoploss ?? '' });
    setEditing(code);
  };

  const saveTarget = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await axios.post(`${API_BASE}/portfolio/${basketId}/targets`, {
        stock_code:   editing,
        target_price: form.target_price !== '' ? parseFloat(form.target_price) : null,
        stoploss:     form.stoploss     !== '' ? parseFloat(form.stoploss)     : null,
      });
      load();
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const clearTarget = async (code) => {
    await axios.delete(`${API_BASE}/portfolio/${basketId}/targets/${code}`);
    load();
  };

  const withTarget = holdings.filter(h => targets[h.code]);

  return (
    <>
      {/* Always-visible alert banner */}
      <StoplossAlerts holdings={holdings} targets={targets} />

      <div className="glass-panel" style={{ marginBottom: '24px' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: open ? '16px' : 0 }}
          onClick={() => setOpen(o => !o)}
        >
          {open ? <ChevronDown size={16} color="var(--primary)" /> : <ChevronRight size={16} color="var(--primary)" />}
          <Target size={16} color="var(--primary)" />
          <h3 style={{ margin: 0, color: 'var(--primary)' }}>Target Price &amp; Stoploss</h3>
          {withTarget.length > 0 && (
            <span style={{ background: 'rgba(99,102,241,0.2)', color: 'var(--primary)', padding: '2px 8px', borderRadius: '10px', fontSize: '0.75rem', fontWeight: 700 }}>
              {withTarget.length} set
            </span>
          )}
        </div>

        {open && (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th>CMP</th>
                  <th>Buy Px</th>
                  <th>Target</th>
                  <th>Upside %</th>
                  <th>Stoploss</th>
                  <th>Downside %</th>
                  <th>Status</th>
                  <th>Act.</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map(h => {
                  const t      = targets[h.code] || {};
                  const cmp    = Number(h.cmp) || 0;
                  const tgt    = t.target_price;
                  const sl     = t.stoploss;
                  const upside = tgt && cmp > 0 ? ((tgt - cmp) / cmp * 100) : null;
                  const down   = sl  && cmp > 0 ? ((sl  - cmp) / cmp * 100) : null;
                  const hitTgt = tgt && cmp >= tgt;
                  const hitSl  = sl  && cmp <= sl;

                  if (editing === h.code) {
                    return (
                      <tr key={h.code} style={{ background: 'rgba(99,102,241,0.08)' }}>
                        <td><strong>{h.code}</strong></td>
                        <td>{cmp > 0 ? cmp.toFixed(2) : '--'}</td>
                        <td>{h.buy_price > 0 ? Number(h.buy_price).toFixed(2) : '--'}</td>
                        <td>
                          <input type="number" value={form.target_price} onChange={e => setForm(f => ({ ...f, target_price: e.target.value }))}
                            placeholder="Target ₹" style={{ width: '90px', padding: '3px 6px', fontSize: '0.78rem' }} />
                        </td>
                        <td colSpan={1} />
                        <td>
                          <input type="number" value={form.stoploss} onChange={e => setForm(f => ({ ...f, stoploss: e.target.value }))}
                            placeholder="SL ₹" style={{ width: '90px', padding: '3px 6px', fontSize: '0.78rem' }} />
                        </td>
                        <td colSpan={2} />
                        <td>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button className="btn btn-primary" style={{ padding: '3px 8px', fontSize: '0.75rem' }} onClick={saveTarget} disabled={saving}>
                              {saving ? '…' : 'Save'}
                            </button>
                            <button className="btn btn-secondary" style={{ padding: '3px 6px' }} onClick={() => setEditing(null)}>
                              <X size={12} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={h.code} style={{
                      background: hitSl ? 'rgba(239,68,68,0.08)' : hitTgt ? 'rgba(16,185,129,0.08)' : 'transparent'
                    }}>
                      <td><strong>{h.code}</strong></td>
                      <td style={{ fontWeight: 600 }}>{cmp > 0 ? cmp.toFixed(2) : '--'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{h.buy_price > 0 ? Number(h.buy_price).toFixed(2) : '--'}</td>
                      <td style={{ color: hitTgt ? 'var(--positive)' : 'var(--text-main)', fontWeight: tgt ? 600 : 400 }}>
                        {tgt ? `₹${tgt.toFixed(2)}` : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        {upside != null
                          ? <span style={{ color: upside >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 600 }}>
                              {upside >= 0 ? '+' : ''}{upside.toFixed(1)}%
                            </span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ color: hitSl ? 'var(--negative)' : 'var(--text-main)', fontWeight: sl ? 600 : 400 }}>
                        {sl ? `₹${sl.toFixed(2)}` : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        {down != null
                          ? <span style={{ color: down >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 600 }}>
                              {down >= 0 ? '+' : ''}{down.toFixed(1)}%
                            </span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        {hitSl && <span style={{ background: 'rgba(239,68,68,0.2)', color: 'var(--negative)', padding: '2px 8px', borderRadius: '10px', fontSize: '0.7rem', fontWeight: 700 }}>SL Hit</span>}
                        {hitTgt && !hitSl && <span style={{ background: 'rgba(16,185,129,0.2)', color: 'var(--positive)', padding: '2px 8px', borderRadius: '10px', fontSize: '0.7rem', fontWeight: 700 }}>Target Hit</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '3px' }}>
                          <button className="btn" style={{ padding: '3px 6px', fontSize: '0.72rem' }} onClick={() => startEdit(h.code)}>
                            {tgt || sl ? 'Edit' : 'Set'}
                          </button>
                          {(tgt || sl) && (
                            <button className="btn" style={{ padding: '3px 4px', color: 'var(--text-muted)' }} onClick={() => clearTarget(h.code)}>
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export { TargetStoplossPanel };
export function useTargets(basketId) {
  const [targets, setTargets] = useState({});
  useEffect(() => {
    if (!basketId) return;
    axios.get(`${API_BASE}/portfolio/${basketId}/targets`)
      .then(r => setTargets(r.data || {}))
      .catch(() => {});
  }, [basketId]);
  return targets;
}
