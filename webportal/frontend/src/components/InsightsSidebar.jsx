import { formatPercent, getColorClass } from '../App.jsx';

function InsightCard({ title, subtitle, items, valueKey, accent }) {
  if (!items.length) return null;
  const [top, ...rest] = items;
  const topVal = top[valueKey];
  const topCls = getColorClass(topVal);

  return (
    <div className={`icard icard--${accent}`}>
      {/* Header row */}
      <div className="icard-header">
        <div className="icard-header-left">
          <span className={`icard-dot icard-dot--${accent}`} />
          <span className="icard-title">{title}</span>
        </div>
        <span className="icard-badge">{subtitle}</span>
      </div>

      {/* Featured #1 — shown large like image 2 */}
      <div className="icard-featured">
        <span className={`icard-featured-val ${topCls}`}>{formatPercent(topVal)}</span>
        <span className="icard-featured-stock">{top.nseCode}</span>
      </div>

      {/* Remaining 4 items */}
      <div className="icard-rest">
        {rest.map((item, i) => {
          const val = item[valueKey];
          return (
            <div key={item.nseCode + i} className="icard-rest-row">
              <span className="icard-rest-rank">{i + 2}</span>
              <span className="icard-rest-name">{item.nseCode}</span>
              <span className={`icard-rest-val ${getColorClass(val)}`}>{formatPercent(val)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function InsightsSidebar({ rows, isIPO, perfByTenure, tenure }) {
  const tenureLabel = tenure || '1M';
  // 1M keeps using row.performance -- its own live open1M/close1M-derived
  // figure, already correct and independently verified. Every OTHER tenure
  // comes from perfByTenure (the multi-tenure batch fetch), since rows never
  // carry a baked-in non-1M performance field. Contribution is recomputed
  // from allocation × that tenure's performance rather than reusing
  // row.contribution, which is always the 1M figure regardless of tenure.
  const withTenure = rows.map(r => {
    const perf = tenureLabel === '1M' ? r.performance : perfByTenure?.[r.nseCode]?.[tenureLabel];
    const contribution = (perf != null && r.allocation != null) ? r.allocation * perf : null;
    return { ...r, _tenurePerf: perf, _tenureContribution: contribution };
  });
  const validPerf = withTenure.filter(r => r._tenurePerf != null && isFinite(r._tenurePerf));
  const validCont = withTenure.filter(r => r._tenureContribution != null && isFinite(r._tenureContribution));

  const topGainers  = [...validPerf].sort((a, b) => b._tenurePerf - a._tenurePerf).slice(0, 5);
  const topLosers   = [...validPerf].sort((a, b) => a._tenurePerf - b._tenurePerf).slice(0, 5);
  const topContribs = [...validCont].sort((a, b) => b._tenureContribution - a._tenureContribution).slice(0, 5);
  const topDraggers = [...validCont].sort((a, b) => a._tenureContribution - b._tenureContribution).slice(0, 5);

  return (
    <div className="insights-section">
      {!isIPO && (
        <div className="insights-grid">
          <InsightCard title="Top Gainers"      subtitle={`${tenureLabel} Perf`} items={topGainers}  valueKey="_tenurePerf"         accent="green" />
          <InsightCard title="Top Losers"       subtitle={`${tenureLabel} Perf`} items={topLosers}   valueKey="_tenurePerf"         accent="red"   />
          <InsightCard title="Top Contributors" subtitle="Contribution"         items={topContribs} valueKey="_tenureContribution" accent="green" />
          <InsightCard title="Top Draggers"     subtitle="Contribution"         items={topDraggers} valueKey="_tenureContribution" accent="red"   />
        </div>
      )}
    </div>
  );
}
