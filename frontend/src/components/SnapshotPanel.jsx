import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Camera, X, Trash2 } from 'lucide-react';

import { API_BASE } from '../config.js';

export default function SnapshotPanel({ basketId, holdings, stats }) {
  const [list,      setList]      = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewSnap,  setViewSnap]  = useState(null); // { name, date, holdings }
  const [nameInput, setNameInput] = useState('');
  const [saving,    setSaving]    = useState(false);

  const load = useCallback(() => {
    if (!basketId) return;
    axios.get(`${API_BASE}/snapshots/${basketId}`)
      .then(r => setList(r.data || []))
      .catch(() => {});
  }, [basketId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!nameInput.trim()) return;
    setSaving(true);
    try {
      const snap = { holdings, stats, saved_at: new Date().toISOString() };
      await axios.post(`${API_BASE}/snapshots/${basketId}`, {
        snapshot_name: nameInput.trim(),
        holdings_json: JSON.stringify(snap),
      });
      setNameInput('');
      setModalOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const view = async (snap) => {
    const r = await axios.get(`${API_BASE}/snapshots/${basketId}/${snap.id}`);
    const parsed = JSON.parse(r.data.holdings_json);
    setViewSnap({ name: snap.name, date: snap.date, ...parsed });
  };

  const del = async (id, e) => {
    e.stopPropagation();
    await axios.delete(`${API_BASE}/snapshots/${basketId}/${id}`);
    load();
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '0' }}>
        <button
          className="btn btn-secondary"
          onClick={() => setModalOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem' }}
        >
          <Camera size={15} /> Save Snapshot
        </button>

        {list.length > 0 && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {list.map(s => (
              <button
                key={s.id}
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
                onClick={() => view(s)}
              >
                {s.name}
                <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem' }}>{s.date}</span>
                <span onClick={e => del(s.id, e)} style={{ marginLeft: '2px', opacity: 0.6 }}>
                  <Trash2 size={10} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Save modal */}
      {modalOpen && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: '380px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Camera size={18} color="var(--primary)" /> Save Snapshot
              </h3>
              <button onClick={() => setModalOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '16px' }}>
              Saves the current holdings &amp; performance as a named point-in-time snapshot.
            </p>
            <div className="input-group">
              <label>Snapshot Name</label>
              <input
                type="text"
                placeholder="e.g. Q1 2025 Review"
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && save()}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px' }}>
              <button className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving || !nameInput.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View snapshot modal */}
      {viewSnap && (
        <div className="modal-overlay" onClick={() => setViewSnap(null)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: '800px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0 }}>Snapshot: {viewSnap.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.85rem' }}>({viewSnap.date})</span></h3>
              <button onClick={() => setViewSnap(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={22} /></button>
            </div>
            {viewSnap.stats && (
              <div style={{ display: 'flex', gap: '24px', marginBottom: '16px', padding: '12px 16px', background: 'rgba(99,102,241,0.08)', borderRadius: '8px' }}>
                <div><div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Basket Return</div>
                  <strong style={{ color: viewSnap.stats.basket_return >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                    {viewSnap.stats.basket_return >= 0 ? '+' : ''}{(viewSnap.stats.basket_return || 0).toFixed(2)}%
                  </strong>
                </div>
                <div><div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>Stock Count</div>
                  <strong>{viewSnap.stats.stock_count || viewSnap.holdings?.length || 0}</strong>
                </div>
              </div>
            )}
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Stock</th><th>Sector</th><th>Alloc%</th><th>Buy Px</th><th>CMP</th><th>Overall%</th><th>1M%</th>
                  </tr>
                </thead>
                <tbody>
                  {(viewSnap.holdings || []).map((h, i) => {
                    const ov = Number(h.overall_performance) || 0;
                    return (
                      <tr key={h.code || i}>
                        <td><strong>{h.code}</strong></td>
                        <td style={{ color: 'var(--primary)', fontSize: '0.73rem' }}>{h.theme || h.sector || '--'}</td>
                        <td>{(Number(h.allocation) || 0).toFixed(1)}%</td>
                        <td>{h.buy_price > 0 ? Number(h.buy_price).toFixed(2) : '--'}</td>
                        <td style={{ fontWeight: 600 }}>{h.cmp > 0 ? Number(h.cmp).toFixed(2) : '--'}</td>
                        <td style={{ color: ov >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 600 }}>
                          {ov >= 0 ? '+' : ''}{ov.toFixed(2)}%
                        </td>
                        <td style={{ color: (Number(h.performance) || 0) >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
                          {(Number(h.performance) || 0) >= 0 ? '+' : ''}{(Number(h.performance) || 0).toFixed(2)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
