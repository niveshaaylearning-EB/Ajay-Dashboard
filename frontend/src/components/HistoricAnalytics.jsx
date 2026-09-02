import React, { useState, useEffect } from 'react';
import axios from 'axios';

import { API_BASE } from '../config.js';

function fmt(v) {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function clr(v) {
  if (v == null) return 'var(--text-muted)';
  return v >= 0 ? 'var(--positive)' : 'var(--negative)';
}
function fmtDate(d) {
  if (!d) return '';
  try {
    const [y, m, day] = d.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${parseInt(day)} ${months[parseInt(m)-1]} ${y}`;
  } catch { return d; }
}

export default function HistoricAnalytics({ basketId }) {
  const [data,       setData]       = useState(null);
  const [benchmarks, setBenchmarks] = useState(null);
  const [loading,    setLoading]    = useState(false);

  useEffect(() => {
    if (!basketId) return;
    setLoading(true);
    Promise.all([
      axios.get(`${API_BASE}/baskets/${basketId}/historic`).then(r => r.data).catch(() => null),
      axios.get(`${API_BASE}/benchmarks`).then(r => r.data).catch(() => null),
    ]).then(([hist, bench]) => {
      setData(hist);
      setBenchmarks(bench);
      setLoading(false);
    });
  }, [basketId]);

  if (loading) return <div style={{ color: 'var(--text-muted)', marginBottom: '24px' }}>Calculating historic returns…</div>;
  if (!data || !Object.keys(data).length) return null;

  // Extract metadata keys (prefixed with _) before building period list
  const inceptionDate = data['_inception_date'] || null;
  const periods       = ['1M', '6M', '1Y', '3Y', '5Y'];
  if (data['Inception']) periods.push('Inception');

  const benchNames = benchmarks ? Object.keys(benchmarks) : [];

  const colHeader = (p) => {
    if (p === 'Inception') {
      return (
        <th key={p} style={{ textAlign: 'center', padding: '6px 16px', color: 'var(--primary)', fontWeight: 700, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
          Since Inception
          {inceptionDate && (
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 400 }}>
              {fmtDate(inceptionDate)}
            </div>
          )}
        </th>
      );
    }
    return (
      <th key={p} style={{ textAlign: 'center', padding: '6px 16px', color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.75rem' }}>{p}</th>
    );
  };

  return (
    <div className="glass-panel" style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: 'var(--primary)' }}>Historical Basket Analytics</h3>
        {inceptionDate && (
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Inception: <strong style={{ color: 'var(--text-main)' }}>{fmtDate(inceptionDate)}</strong>
          </span>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 12px', color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>Metric</th>
              {periods.map(p => colHeader(p))}
            </tr>
          </thead>
          <tbody>
            {/* Basket Net */}
            <tr>
              <td style={{ padding: '8px 12px', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                This Basket (Net)
              </td>
              {periods.map(p => {
                const v = data[p]?.net ?? null;
                return (
                  <td key={p} style={{ textAlign: 'center', padding: '8px 16px', fontWeight: 700, color: clr(v), borderBottom: '1px solid rgba(255,255,255,0.06)', whiteSpace: 'nowrap' }}>
                    {fmt(v)}
                  </td>
                );
              })}
            </tr>

            {/* Basket CAGR */}
            <tr>
              <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-muted)', whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                This Basket (CAGR)
              </td>
              {periods.map(p => {
                const skip = (p === '1M' || p === '6M');
                const v    = skip ? null : (data[p]?.cagr ?? null);
                return (
                  <td key={p} style={{ textAlign: 'center', padding: '8px 16px', color: clr(v), borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap' }}>
                    {v == null ? <span style={{ color: 'var(--text-muted)' }}>—</span> : fmt(v)}
                  </td>
                );
              })}
            </tr>

            {/* Benchmarks */}
            {benchNames.map((name, bi) => (
              <React.Fragment key={name}>
                <tr>
                  <td style={{ padding: '8px 12px', fontWeight: 500, whiteSpace: 'nowrap', borderBottom: '1px solid rgba(255,255,255,0.06)', color: 'var(--primary)' }}>
                    {name} (Net)
                  </td>
                  {periods.map(p => {
                    const v = p === 'Inception'
                      ? (data['_benchmark_inception']?.[name]?.net ?? null)
                      : (benchmarks[name]?.[p]?.net ?? null);
                    return (
                      <td key={p} style={{ textAlign: 'center', padding: '8px 16px', color: clr(v), borderBottom: '1px solid rgba(255,255,255,0.06)', whiteSpace: 'nowrap' }}>
                        {fmt(v)}
                      </td>
                    );
                  })}
                </tr>
                {/* Alpha row */}
                <tr>
                  <td style={{ padding: '6px 12px', whiteSpace: 'nowrap', borderBottom: bi === benchNames.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)', fontSize: '0.75rem', paddingLeft: '20px' }}>
                    ↳ Alpha vs {name}
                  </td>
                  {periods.map(p => {
                    const basket = data[p]?.net ?? null;
                    const bench  = p === 'Inception'
                      ? (data['_benchmark_inception']?.[name]?.net ?? null)
                      : (benchmarks[name]?.[p]?.net ?? null);
                    const alpha  = basket != null && bench != null ? basket - bench : null;
                    return (
                      <td key={p} style={{ textAlign: 'center', padding: '6px 16px', color: clr(alpha), borderBottom: bi === benchNames.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.1)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                        {alpha == null ? '—' : `${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`}
                      </td>
                    );
                  })}
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
