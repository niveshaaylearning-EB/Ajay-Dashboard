import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BarChart2 } from 'lucide-react';

import { API_BASE } from '../config.js';
const PERIODS = ['1M', '3M', '6M', '1Y', '3Y', '5Y'];

function Cell({ v }) {
  if (v == null) return <td style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '8px 12px' }}>—</td>;
  const color = v >= 0 ? 'var(--positive)' : 'var(--negative)';
  return (
    <td style={{ textAlign: 'center', padding: '8px 12px', color, fontWeight: 500, whiteSpace: 'nowrap' }}>
      {v >= 0 ? '+' : ''}{v.toFixed(2)}%
    </td>
  );
}

function formatInception(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function BasketComparison() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const globalPeriod = searchParams.get('period') || '1M';
  const activePeriod = ['1M', '3M', '6M', '1Y', '3Y', '5Y'].includes(globalPeriod) ? globalPeriod : '1M';

  const [baskets,  setBaskets]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [viewType, setViewType] = useState('net'); // 'net' | 'cagr'

  useEffect(() => {
    axios.get(`${API_BASE}/baskets/comparison`)
      .then(r => { setBaskets(r.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ textAlign: 'center', marginTop: '4rem' }}>
      <h3 className="text-gradient">Loading Basket Comparison…</h3>
      <p style={{ color: 'var(--text-muted)', marginTop: '8px', fontSize: '0.85rem' }}>This may take 15–30 seconds on first load.</p>
    </div>
  );

  const FEATURED = ['green energy', 'mid & small cap', 'mid and small cap'];
  const featured = baskets.filter(b => FEATURED.some(f => b.name.toLowerCase().includes(f)));
  const rest     = baskets.filter(b => !FEATURED.some(f => b.name.toLowerCase().includes(f)));

  function BasketCard({ b, large }) {
    const overall = b.historic?.Overall;
    const ret = viewType === 'cagr'
      ? (overall?.cagr ?? overall?.net ?? 0)
      : (overall?.net ?? 0);
    const label = viewType === 'cagr' ? 'CAGR (Inception)' : 'Net Return (Inception)';
    return (
      <div className="glass-panel" style={{
        padding: large ? '22px 24px' : '14px 16px',
        background: ret >= 0 ? 'linear-gradient(135deg,rgba(16,185,129,0.12),rgba(16,185,129,0.04))' : 'linear-gradient(135deg,rgba(239,68,68,0.12),rgba(239,68,68,0.04))',
        border: `1px solid ${ret >= 0 ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
      }}>
        <div style={{ fontSize: large ? '0.85rem' : '0.73rem', color: 'var(--text-muted)', marginBottom: large ? '6px' : '4px', fontWeight: 600 }}>
          {b.name.replace(/^NIA\s*/i, '')}
        </div>
        <div style={{ fontSize: large ? '1.9rem' : '1.3rem', fontWeight: 700, color: ret >= 0 ? 'var(--positive)' : 'var(--negative)' }}>
          {ret >= 0 ? '+' : ''}{ret.toFixed(2)}%
        </div>
        <div style={{ fontSize: '0.70rem', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span>{b.stats?.stock_count || 0} stocks · {label}</span>
          {b.inception && <span>Since {formatInception(b.inception)}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-slide-up">
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <button className="btn btn-secondary" onClick={() => navigate('/')} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ArrowLeft size={16} /> Back
        </button>
        <div>
          <h2 style={{ marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BarChart2 color="var(--primary)" /> Multi-Basket Comparison
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
            Side-by-side historical performance across all NIA baskets
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
          {['net', 'cagr'].map(v => (
            <button
              key={v}
              className={`btn ${viewType === v ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '6px 14px', fontSize: '0.82rem' }}
              onClick={() => setViewType(v)}
            >
              {v === 'net' ? 'Net Return' : 'CAGR'}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      {featured.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${featured.length}, 1fr)`, gap: '16px', marginBottom: '14px' }}>
          {featured.map(b => <BasketCard key={b.id} b={b} large />)}
        </div>
      )}
      {rest.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '28px' }}>
          {rest.map(b => <BasketCard key={b.id} b={b} />)}
        </div>
      )}

      {/* Period-by-period comparison table */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <h3 style={{ margin: 0 }}>Period Returns — {viewType === 'net' ? 'Net Return' : 'CAGR'}</h3>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                <th style={{ padding: '10px 16px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Period</th>
                {baskets.map(b => (
                  <th key={b.id} style={{ padding: '10px 12px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                    {b.name.replace(/^NIA\s*/,'')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(viewType === 'cagr' ? ['1Y', '3Y', '5Y'] : PERIODS).map((p) => {
                const isActive  = p === activePeriod;
                const isOverall = p === 'Overall';
                const vals = baskets.map(b => {
                  const h = b.historic?.[p];
                  return viewType === 'net' ? (h?.net ?? null) : (h?.cagr ?? null);
                });
                const validVals = vals.filter(v => v != null);
                const best  = validVals.length ? Math.max(...validVals) : null;
                const worst = validVals.length ? Math.min(...validVals) : null;

                return (
                  <tr key={p} style={{
                    borderTop: isOverall ? '2px solid rgba(255,255,255,0.1)' : '1px solid rgba(255,255,255,0.05)',
                    background: isOverall ? 'rgba(99,102,241,0.06)' : isActive ? 'rgba(99,102,241,0.10)' : 'transparent',
                  }}>
                    <td style={{ padding: '10px 16px', fontWeight: 700, color: isOverall ? 'var(--primary)' : isActive ? 'var(--primary)' : 'var(--text-main)', whiteSpace: 'nowrap' }}>
                      {isOverall ? 'Since Inception' : p}
                      {isActive && !isOverall && (
                        <span style={{ marginLeft: '6px', fontSize: '0.65rem', color: 'var(--primary)', background: 'rgba(99,102,241,0.25)', padding: '1px 5px', borderRadius: '8px' }}>selected</span>
                      )}
                    </td>
                    {baskets.map((b) => {
                      const h = b.historic?.[p];
                      const v = viewType === 'net' ? (h?.net ?? null) : (h?.cagr ?? null);
                      const isBest  = v != null && v === best;
                      const isWorst = v != null && v === worst && worst !== best;
                      return (
                        <td key={b.id} style={{
                          textAlign: 'center', padding: '10px 12px',
                          color: v == null ? 'var(--text-muted)' : v >= 0 ? 'var(--positive)' : 'var(--negative)',
                          fontWeight: isBest ? 800 : 500,
                          background: isBest ? 'rgba(16,185,129,0.08)' : isWorst ? 'rgba(239,68,68,0.06)' : 'transparent',
                          whiteSpace: 'nowrap',
                        }}>
                          {v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
                          {isBest  && <span style={{ marginLeft: '4px', fontSize: '0.65rem', color: 'var(--positive)' }}>▲</span>}
                          {isWorst && <span style={{ marginLeft: '4px', fontSize: '0.65rem', color: 'var(--negative)' }}>▼</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
