import { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { formatPercent, formatRupee, getColorClass } from '../App.jsx';

const PIE_COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899','#84cc16','#14b8a6','#a78bfa','#34d399'];

function Panel({ title, children, action }) {
  return (
    <div className="dv-panel">
      <div className="dv-panel-head">
        <span className="dv-panel-title">{title}</span>
        {action && <button className="dv-panel-action">{action} →</button>}
      </div>
      {children}
    </div>
  );
}

function AllocationDonut({ rows }) {
  const data = useMemo(() => rows
    .filter(r => r.nseCode && r.allocation > 0)
    .sort((a, b) => b.allocation - a.allocation)
    .map(r => ({ name: r.nseCode, value: parseFloat((r.allocation * 100).toFixed(2)) }))
  , [rows]);

  const totalAlloc = data.reduce((s, d) => s + d.value, 0);

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="dv-tooltip">
        <strong>{payload[0].name}</strong>: {payload[0].value.toFixed(2)}%
      </div>
    );
  };

  return (
    <Panel title="Allocation Overview">
      <div className="dv-donut-wrap">
        <div className="dv-donut-chart">
          <ResponsiveContainer width={200} height={200}>
            <PieChart>
              <Pie data={data} cx="50%" cy="50%" innerRadius={58} outerRadius={88}
                dataKey="value" paddingAngle={1} strokeWidth={0}>
                {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="dv-donut-center">
            <span className="dv-donut-pct">{totalAlloc.toFixed(0)}%</span>
            <span className="dv-donut-label">Invested</span>
          </div>
        </div>
        <div className="dv-donut-legend">
          <div className="dv-leg-title">Top 10 Holdings</div>
          {data.slice(0, 10).map((d, i) => (
            <div key={d.name} className="dv-leg-row">
              <span className="dv-leg-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
              <span className="dv-leg-name">{d.name}</span>
              <div className="dv-leg-bar-track">
                <div className="dv-leg-bar" style={{ width: `${(d.value / (data[0]?.value || 1)) * 100}%`, background: PIE_COLORS[i % PIE_COLORS.length] }} />
              </div>
              <span className="dv-leg-val">{d.value.toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function TopHoldingsPanel({ rows }) {
  const top = useMemo(() =>
    [...rows].filter(r => r.nseCode && r.allocation > 0)
      .sort((a, b) => b.allocation - a.allocation).slice(0, 5)
  , [rows]);

  return (
    <Panel title="Top Holdings">
      <table className="dv-mini-table">
        <thead>
          <tr>
            <th>Stock</th>
            <th>Alloc</th>
            <th>CMP</th>
            <th>1M</th>
            <th>Abs Ret</th>
            <th>Contrib</th>
          </tr>
        </thead>
        <tbody>
          {top.map(r => (
            <tr key={r.nseCode}>
              <td className="dv-stock-name">{r.nseCode}</td>
              <td>{r.allocation != null ? (r.allocation * 100).toFixed(2) + '%' : '-'}</td>
              <td>{r.cmp != null ? '₹' + r.cmp.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '-'}</td>
              <td className={getColorClass(r.performance)}>{r.performance != null ? (r.performance * 100).toFixed(2) + '%' : '-'}</td>
              <td className={getColorClass(r.absoluteReturns)}>{r.absoluteReturns != null ? (r.absoluteReturns * 100).toFixed(2) + '%' : '-'}</td>
              <td className={getColorClass(r.contribution)}>{r.contribution != null ? (r.contribution * 100).toFixed(2) + '%' : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function BarListPanel({ title, items, valueKey, colorKey, subtitle }) {
  const maxAbs = Math.max(...items.map(d => Math.abs(d[valueKey] ?? 0)), 0.0001);
  return (
    <Panel title={title}>
      <div className="dv-barlist-sub">{subtitle}</div>
      <div className="dv-barlist">
        {items.map((item, i) => {
          const val = item[valueKey];
          const pct = maxAbs > 0 ? Math.abs(val ?? 0) / maxAbs * 100 : 0;
          const cls = getColorClass(val);
          return (
            <div key={item.nseCode + i} className="dv-bar-row">
              <span className="dv-bar-rank">{i + 1}</span>
              <span className="dv-bar-name">{item.nseCode}</span>
              <div className="dv-bar-track">
                <div className={`dv-bar dv-bar--${cls}`} style={{ width: pct + '%' }} />
              </div>
              <span className={`dv-bar-val ${cls}`}>{formatPercent(val)}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function KeyInsightsPanel({ rows }) {
  const valid = rows.filter(r => r.nseCode && r.performance != null);
  const topGainer   = [...valid].sort((a, b) => b.performance - a.performance)[0];
  const topLoser    = [...valid].sort((a, b) => a.performance - b.performance)[0];
  const topContrib  = [...rows.filter(r => r.contribution != null)].sort((a, b) => b.contribution - a.contribution)[0];
  const largestAlloc = [...rows.filter(r => r.allocation > 0)].sort((a, b) => b.allocation - a.allocation)[0];

  const items = [
    { label: 'Top Gainer',          stock: topGainer?.nseCode,    value: formatPercent(topGainer?.performance),    cls: 'positive', icon: 'fa-arrow-trend-up' },
    { label: 'Top Loser',           stock: topLoser?.nseCode,     value: formatPercent(topLoser?.performance),     cls: 'negative', icon: 'fa-arrow-trend-down' },
    { label: 'Highest Contribution',stock: topContrib?.nseCode,   value: formatPercent(topContrib?.contribution),  cls: 'positive', icon: 'fa-chart-line' },
    { label: 'Largest Allocation',  stock: largestAlloc?.nseCode, value: largestAlloc ? (largestAlloc.allocation * 100).toFixed(2) + '%' : '-', cls: 'neutral', icon: 'fa-weight-hanging' },
  ];

  return (
    <Panel title="Key Insights">
      <div className="dv-insights-list">
        {items.map(it => (
          <div key={it.label} className="dv-insight-row">
            <div className="dv-insight-left">
              <i className={`fa-solid ${it.icon} dv-insight-icon`} />
              <div>
                <div className="dv-insight-label">{it.label}</div>
                <div className="dv-insight-stock">{it.stock || '-'}</div>
              </div>
            </div>
            <span className={`dv-insight-val ${it.cls}`}>{it.value}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RiskValuationPanel({ medianPE, avgMarketCap, rows }) {
  const holdingDays = rows.map(r => r.holdingDays).filter(d => d != null && d > 0);
  const earliest = holdingDays.length ? Math.max(...holdingDays) : null;
  const avgHolding = holdingDays.length ? Math.round(holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length) : null;

  const mcFormatted = avgMarketCap > 0
    ? (avgMarketCap >= 100000 ? '₹' + (avgMarketCap / 100000).toFixed(2) + ' L Cr' : '₹' + Math.round(avgMarketCap).toLocaleString('en-IN') + ' Cr')
    : '-';

  const stats = [
    { label: 'Median PE Ratio',  value: medianPE > 0 ? medianPE.toFixed(1) + 'x' : '-', icon: 'fa-calculator' },
    { label: 'Avg Market Cap',   value: mcFormatted,                                          icon: 'fa-building-columns' },
    { label: 'Earliest Holding', value: earliest ? earliest + ' Days' : '-',              icon: 'fa-calendar-days' },
    { label: 'Avg Holding Days', value: avgHolding ? avgHolding + ' Days' : '-',          icon: 'fa-clock' },
  ];

  return (
    <Panel title="Risk & Valuation">
      <div className="dv-rv-grid">
        {stats.map(s => (
          <div key={s.label} className="dv-rv-item">
            <i className={`fa-solid ${s.icon} dv-rv-icon`} />
            <span className="dv-rv-label">{s.label}</span>
            <span className="dv-rv-val">{s.value}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function BasketOverlapPanel({ overlap, onGoToBasket, basketOptions }) {
  const [expandedKey, setExpandedKey] = useState(null);
  const maxPct = Math.max(...overlap.map(o => o.pct), 0.0001);
  return (
    <Panel title="Basket Overlap">
      <div className="dv-barlist-sub">Shared tickers vs. each other basket ({overlap[0]?.total ?? 0} stocks in this basket) — click the count to see which</div>
      <div className="dv-barlist">
        {overlap.map((o, i) => {
          const label = basketOptions.find(b => b.key === o.key)?.label || o.key;
          const pct = maxPct > 0 ? (o.pct / maxPct) * 100 : 0;
          const isExpanded = expandedKey === o.key;
          return (
            <div key={o.key}>
              <div className="dv-bar-row dv-bar-row--wide">
                <span className="dv-bar-rank">{i + 1}</span>
                <span className="dv-bar-name" style={{ cursor: onGoToBasket ? 'pointer' : 'default' }}
                  onClick={() => onGoToBasket && onGoToBasket(o.key)} title="Go to this basket">
                  {label}
                </span>
                <div className="dv-bar-track">
                  <div className="dv-bar dv-bar--neutral" style={{ width: pct + '%' }} />
                </div>
                <span
                  className="dv-bar-val dv-bar-val--clickable"
                  onClick={() => setExpandedKey(isExpanded ? null : o.key)}
                  title="Show overlapping stocks"
                >
                  {o.common}/{o.total} ({o.pct.toFixed(1)}%) {isExpanded ? '▲' : '▼'}
                </span>
              </div>
              {isExpanded && (
                <div className="dv-overlap-tickers">
                  {o.commonCodes.map(code => (
                    <span key={code} className="dv-overlap-ticker-chip">{code}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function BasketWeightOverlapPanel({ overlap, onGoToBasket, basketOptions }) {
  const [expandedKey, setExpandedKey] = useState(null);
  const maxPct = Math.max(...overlap.map(o => o.pct), 0.0001);
  return (
    <Panel title="Basket Overlap by Weight">
      <div className="dv-barlist-sub">% of this basket's total allocation sitting in stocks each other basket also holds — click the % to see which</div>
      <div className="dv-barlist">
        {overlap.map((o, i) => {
          const label = basketOptions.find(b => b.key === o.key)?.label || o.key;
          const pct = maxPct > 0 ? (o.pct / maxPct) * 100 : 0;
          const isExpanded = expandedKey === o.key;
          return (
            <div key={o.key}>
              <div className="dv-bar-row dv-bar-row--wide">
                <span className="dv-bar-rank">{i + 1}</span>
                <span className="dv-bar-name" style={{ cursor: onGoToBasket ? 'pointer' : 'default' }}
                  onClick={() => onGoToBasket && onGoToBasket(o.key)} title="Go to this basket">
                  {label}
                </span>
                <div className="dv-bar-track">
                  <div className="dv-bar dv-bar--neutral" style={{ width: pct + '%' }} />
                </div>
                <span
                  className="dv-bar-val dv-bar-val--clickable"
                  onClick={() => setExpandedKey(isExpanded ? null : o.key)}
                  title={`${o.weightPct.toFixed(1)}% of this basket's ${o.totalPct.toFixed(1)}% total allocation`}
                >
                  {o.pct.toFixed(1)}% {isExpanded ? '▲' : '▼'}
                </span>
              </div>
              {isExpanded && (
                <div className="dv-overlap-detail">
                  <div className="dv-overlap-detail-head">
                    <span>Stock</span><span>This Basket</span><span>{label}</span>
                  </div>
                  {o.commonStocks.map(s => (
                    <div key={s.code} className="dv-overlap-detail-row">
                      <span className="dv-overlap-detail-code">{s.code}</span>
                      <span>{(s.myWeight * 100).toFixed(1)}%</span>
                      <span>{(s.otherWeight * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export default function DashboardView({ rows, avgMarketCap, medianPE, isIPO, onViewHoldings, basketOverlap, basketWeightOverlap, onGoToBasket, basketOptions = [] }) {
  const validPerf = rows.filter(r => r.performance != null && isFinite(r.performance));
  const validCont = rows.filter(r => r.contribution != null && isFinite(r.contribution));

  const topContribs = [...validCont].sort((a, b) => b.contribution - a.contribution).slice(0, 5);
  const topDraggers = [...validCont].sort((a, b) => a.contribution - b.contribution).slice(0, 5);

  return (
    <div className="dv-root">
      {/* Row 1: Allocation + Key Insights + Risk & Valuation */}
      <div className="dv-row-top">
        <AllocationDonut rows={rows} />
        <KeyInsightsPanel rows={rows} />
        <RiskValuationPanel medianPE={medianPE} avgMarketCap={avgMarketCap} rows={rows} />
      </div>

      {/* Row 2: Top Holdings + Contributors + Draggers */}
      <div className="dv-row-bottom">
        <TopHoldingsPanel rows={rows} onViewAll={onViewHoldings} />
        {!isIPO && <BarListPanel title="Top Contributors (1M)" items={topContribs} valueKey="contribution" subtitle="By contribution to portfolio" />}
        {!isIPO && <BarListPanel title="Top Draggers (1M)" items={topDraggers} valueKey="contribution" subtitle="By drag on portfolio" />}
      </div>

      {/* Row 3: Basket Overlap -- by stock count, and (separately) by weight */}
      {((basketOverlap && basketOverlap.length > 0) || (basketWeightOverlap && basketWeightOverlap.length > 0)) && (
        <div className="dv-row-overlap">
          {basketOverlap && basketOverlap.length > 0 && (
            <BasketOverlapPanel overlap={basketOverlap} onGoToBasket={onGoToBasket} basketOptions={basketOptions} />
          )}
          {basketWeightOverlap && basketWeightOverlap.length > 0 && (
            <BasketWeightOverlapPanel overlap={basketWeightOverlap} onGoToBasket={onGoToBasket} basketOptions={basketOptions} />
          )}
        </div>
      )}
    </div>
  );
}
