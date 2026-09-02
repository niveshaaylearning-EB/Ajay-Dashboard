import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export default function SectorRollup({ holdings }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState({});

  const sectors = useMemo(() => {
    const map = {};
    for (const h of holdings) {
      const s = (h.sector || h.theme || 'Other').trim();
      if (!map[s]) map[s] = [];
      map[s].push(h);
    }
    return Object.entries(map)
      .map(([name, stocks]) => {
        const totalAlloc = stocks.reduce((s, h) => s + (Number(h.allocation) || 0), 0);
        const totalAlloc_ = totalAlloc || 1;
        const weightedReturn = stocks.reduce((s, h) => s + (Number(h.overall_performance) || 0) * ((Number(h.allocation) || 0) / totalAlloc_), 0);
        return { name, stocks, totalAlloc, weightedReturn, count: stocks.length };
      })
      .sort((a, b) => b.totalAlloc - a.totalAlloc);
  }, [holdings]);

  if (!sectors.length) return null;

  const toggle = (name) => setExpanded(e => ({ ...e, [name]: !e[name] }));

  return (
    <div className="glass-panel" style={{ marginBottom: '24px' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: open ? '16px' : 0 }}
        onClick={() => setOpen(o => !o)}
      >
        {open ? <ChevronDown size={16} color="var(--primary)" /> : <ChevronRight size={16} color="var(--primary)" />}
        <h3 style={{ margin: 0, color: 'var(--primary)' }}>Sector Rollup</h3>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginLeft: '4px' }}>
          ({sectors.length} sectors · {holdings.length} stocks)
        </span>
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {sectors.map(({ name, stocks, totalAlloc, weightedReturn, count }) => {
            const isExp  = expanded[name];
            const retClr = weightedReturn >= 0 ? 'var(--positive)' : 'var(--negative)';
            return (
              <div key={name} style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}>
                {/* Sector header row */}
                <div
                  onClick={() => toggle(name)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 1fr 80px 90px 70px',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '8px 12px',
                    background: 'rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)' }}>
                    {isExp ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{name}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{count} stock{count !== 1 ? 's' : ''}</span>
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{totalAlloc.toFixed(1)}%</span>
                  <span style={{ color: retClr, fontWeight: 600, fontSize: '0.85rem' }}>
                    {weightedReturn >= 0 ? '+' : ''}{weightedReturn.toFixed(2)}%
                  </span>
                </div>

                {/* Expanded stock list */}
                {isExp && (
                  <div style={{ background: 'rgba(0,0,0,0.15)' }}>
                    {stocks.map((h, i) => {
                      const alloc  = Number(h.allocation) || 0;
                      const perf   = Number(h.overall_performance) || 0;
                      const pColor = perf >= 0 ? 'var(--positive)' : 'var(--negative)';
                      return (
                        <div key={h.code || i} style={{
                          display: 'grid',
                          gridTemplateColumns: '24px 1fr 80px 90px 70px',
                          alignItems: 'center',
                          gap: '12px',
                          padding: '6px 12px',
                          borderTop: '1px solid rgba(255,255,255,0.04)',
                          fontSize: '0.78rem',
                        }}>
                          <span />
                          <div>
                            <span style={{ fontWeight: 700 }}>{h.code}</span>
                            {h.stock_name && h.stock_name !== h.code && (
                              <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '0.72rem' }}>{h.stock_name}</span>
                            )}
                          </div>
                          <span style={{ color: 'var(--text-muted)' }}>CMP {h.cmp > 0 ? h.cmp.toFixed(0) : '--'}</span>
                          <span>{alloc.toFixed(1)}%</span>
                          <span style={{ color: pColor, fontWeight: 600 }}>
                            {perf >= 0 ? '+' : ''}{perf.toFixed(2)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
