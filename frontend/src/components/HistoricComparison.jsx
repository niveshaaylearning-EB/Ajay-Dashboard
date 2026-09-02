import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';

import { API_BASE } from '../config.js';

function colorFor(v) {
  return v >= 0 ? 'var(--positive)' : 'var(--negative)';
}

export default function HistoricComparison({ refreshKey }) {
  const [sim, setSim] = useState(null);
  const [loading, setLoading] = useState(false);

  const key = useMemo(() => refreshKey ?? '', [refreshKey]);

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      try {
        const res = await axios.get(`${API_BASE}/simulator/historic`);
        setSim(res.data?.simulated || {});
      } catch (e) {
        console.error(e);
        setSim(null);
      }
      setLoading(false);
    };
    run();
  }, [key]);

  if (loading) {
    return (
      <div style={{ color: 'var(--text-muted)', marginBottom: '24px' }}>
        Calculating historical performance... (this may take a few seconds)
      </div>
    );
  }

  if (!sim || Object.keys(sim).length === 0) return null;

  const periods = ['1M', '6M', '1Y', '3Y', '5Y'];
  const cagrPeriods = ['1Y', '3Y', '5Y'];
  const hasAnyCagr = cagrPeriods.some(p => sim[p]?.cagr != null);

  return (
    <div className="glass-panel" style={{ marginBottom: '24px', padding: '24px 28px' }}>
      <h3 style={{
        marginBottom: '20px',
        color: 'var(--text-main)',
        fontSize: '1.25rem',
        fontWeight: 600,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        paddingBottom: '12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <span>Historical Performance</span>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}>
          Your Virtual Portfolio
        </span>
      </h3>

      {/* Section 1: Cumulative Net Returns */}
      <div style={{ marginBottom: '24px' }}>
        <h4 style={{
          color: 'var(--text-muted)',
          fontSize: '0.82rem',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '14px'
        }}>
          Cumulative Net Returns
        </h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px' }}>
          {periods.map((p) => {
            const s = sim[p];
            if (!s) return null;

            const sNet = s?.net ?? null;

            return (
              <div
                key={p}
                className="hist-card"
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.05)',
                  padding: '16px 20px',
                  borderRadius: '12px',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <span style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--primary)' }}>{p}</span>
                  <span style={{
                    fontSize: '0.65rem',
                    color: 'var(--primary)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    background: 'rgba(99,102,241,0.12)',
                    padding: '2px 8px',
                    borderRadius: '20px',
                    border: '1px solid rgba(99,102,241,0.2)'
                  }}>
                    Simple
                  </span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Net Return</span>
                  <strong style={{ color: sNet == null ? 'var(--text-muted)' : colorFor(sNet), fontSize: '0.95rem' }}>
                    {sNet == null ? '—' : `${sNet >= 0 ? '+' : ''}${sNet.toFixed(2)}%`}
                  </strong>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section 2: Annualized CAGR */}
      {hasAnyCagr && (
        <div>
          <h4 style={{
            color: 'var(--text-muted)',
            fontSize: '0.82rem',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '14px',
            marginTop: '28px'
          }}>
            Annualized Returns (CAGR)
          </h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px' }}>
            {cagrPeriods.map((p) => {
              const s = sim[p];
              const sCagr = s?.cagr ?? null;
              if (sCagr == null) return null;

              return (
                <div
                  key={p}
                  className="hist-card"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.05)',
                    padding: '16px 20px',
                    borderRadius: '12px',
                    transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                    <span style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--primary)' }}>{p}</span>
                    <span style={{
                      fontSize: '0.65rem',
                      color: 'var(--secondary)',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      background: 'rgba(139,92,246,0.12)',
                      padding: '2px 8px',
                      borderRadius: '20px',
                      border: '1px solid rgba(139,92,246,0.2)'
                    }}>
                      Annualized
                    </span>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>CAGR</span>
                    <strong style={{ color: colorFor(sCagr), fontSize: '0.95rem' }}>
                      {`${sCagr >= 0 ? '+' : ''}${sCagr.toFixed(2)}%`}
                    </strong>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        .hist-card:hover {
          transform: translateY(-3px);
          border-color: rgba(99, 102, 241, 0.22) !important;
          background: rgba(255, 255, 255, 0.04) !important;
          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
        }
      `}</style>
    </div>
  );
}
