import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const COLORS = [
  '#6366f1','#8b5cf6','#10b981','#f59e0b','#ef4444',
  '#3b82f6','#ec4899','#14b8a6','#f97316','#84cc16',
  '#a78bfa','#34d399','#fbbf24','#60a5fa','#fb7185',
];

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{
      background: 'var(--tooltip-bg)', border: '1px solid var(--panel-border)',
      borderRadius: '8px', padding: '10px 14px', fontSize: '0.82rem',
    }}>
      <div style={{ fontWeight: 700, marginBottom: '4px', color: d.color }}>{d.name}</div>
      <div style={{ color: 'var(--text-muted)' }}>Allocation: <strong style={{ color: 'var(--text-main)' }}>{d.value.toFixed(1)}%</strong></div>
      <div style={{ color: 'var(--text-muted)' }}>Stocks: <strong style={{ color: 'var(--text-main)' }}>{d.count}</strong></div>
    </div>
  );
};

export default function AllocationPieChart({ holdings }) {
  const data = useMemo(() => {
    const map = {};
    for (const h of holdings) {
      const sector = (h.sector || h.theme || 'Other').trim();
      if (!map[sector]) map[sector] = { name: sector, value: 0, count: 0 };
      map[sector].value += Number(h.allocation) || 0;
      map[sector].count += 1;
    }
    return Object.values(map)
      .filter(d => d.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((d, i) => ({ ...d, color: COLORS[i % COLORS.length] }));
  }, [holdings]);

  if (!data.length) return null;

  return (
    <div className="glass-panel" style={{ marginBottom: '24px' }}>
      <h3 style={{ marginBottom: '16px', color: 'var(--primary)' }}>Allocation by Sector</h3>
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={70}
            outerRadius={110}
            paddingAngle={2}
            dataKey="value"
          >
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color} stroke="rgba(0,0,0,0.3)" />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
          <Legend
            formatter={(value, entry) => (
              <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                {value} <span style={{ color: entry.color, fontWeight: 700 }}>{entry.payload.value.toFixed(1)}%</span>
              </span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
