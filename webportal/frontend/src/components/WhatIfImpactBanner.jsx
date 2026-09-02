import { formatPercent, formatRupee, getColorClass } from '../App.jsx';

const STATUS_LABEL = { edited: 'Edited', added: 'Added', deleted: 'Deleted', reduced: 'Reduced' };

function MetricCell({ label, beforeVal, afterVal, colored, formatter = formatPercent }) {
  const delta = (beforeVal != null && afterVal != null) ? afterVal - beforeVal : null;
  return (
    <div className="whatif-banner-metric">
      <span className="whatif-banner-label">{label}</span>
      <span className="whatif-banner-value">
        {formatter(beforeVal)}
        <span className="whatif-banner-arrow">&rarr;</span>
        <strong className={colored ? getColorClass(afterVal) : ''}>{formatter(afterVal)}</strong>
        {delta != null && Math.abs(delta) > 0.0001 && (
          <span className={`whatif-banner-delta ${getColorClass(delta)}`}>
            ({delta > 0 ? '+' : ''}{formatter(delta)})
          </span>
        )}
      </span>
    </div>
  );
}

// Persistent, always-visible (both Overview and Holdings tabs) report of what
// an active what-if simulation has changed -- both portfolio-wide aggregates
// AND a per-stock before/after breakdown -- so nothing requires reopening
// each stock's own modal to see. Explicit about which numbers are structurally
// incapable of moving from a buy-price/date edit, and why:
//   - "1M Returns" / Top Gainers-Losers-Contributors are pure CMP momentum
//     (close1M vs open1M) -- no buy price anywhere in that formula.
//   - "Since Inception" is a separately-maintained basket NAV/index time
//     series (recorded daily values), not derived from any stock's buy price
//     at all -- there is no way to "recompute" a recorded history.
// "Weighted Avg Gain %" and "CAGR" below are the two metrics that genuinely
// are buy-price/date driven, so they're the ones featured here.
export default function WhatIfImpactBanner({ before, after, details, onReset }) {
  return (
    <div className="whatif-banner">
      <div className="whatif-banner-top">
        <div className="whatif-banner-title">
          <span className="whatif-sim-badge" style={{ marginLeft: 0 }}>SIM</span>
          Simulation Active — Portfolio Impact
        </div>
        <button className="btn btn-secondary" onClick={onReset} style={{ fontSize: '0.78rem' }}>Reset Simulation</button>
      </div>

      <div className="whatif-banner-metrics">
        <MetricCell label="Total Allocation" beforeVal={before.totalAllocation} afterVal={after.totalAllocation} />
        <MetricCell label="Weighted Avg Gain % (unrealized)" beforeVal={before.weightedGainPct} afterVal={after.weightedGainPct} colored />
        <MetricCell label="Weighted Portfolio CAGR" beforeVal={before.weightedCagr} afterVal={after.weightedCagr} colored />
        <MetricCell label="1M Weighted Contribution" beforeVal={before.totalContribution} afterVal={after.totalContribution} colored />
      </div>

      <div className="sit-no-data" style={{ margin: '0.5rem 0' }}>
        1M Returns, Top Gainers/Losers/Contributors and Since Inception don't move here — they track live market
        momentum or a separately-recorded basket NAV history, not buy price. Weighted Avg Gain % and CAGR above are
        the metrics actually derived from buy price/date, so they're the honest measure of this simulation's effect.
      </div>

      {details.length > 0 && (
        <>
          <div className="whatif-section-title" style={{ marginTop: '0.75rem' }}>What Changed, Stock by Stock</div>
          <div className="whatif-detail-table-wrap">
            <table className="whatif-detail-table">
              <thead>
                <tr>
                  <th>Stock</th><th>Status</th><th>Weight</th><th>Buy Price</th>
                  <th>Gain %</th><th>Holding Days</th><th>CAGR</th>
                </tr>
              </thead>
              <tbody>
                {details.map(d => (
                  <tr key={d.nseCode}>
                    <td style={{ fontWeight: 700 }}>{d.nseCode}</td>
                    <td>{STATUS_LABEL[d.status]}</td>
                    <td>
                      {d.before ? <>{formatPercent(d.before.allocation)} &rarr; </> : null}
                      <strong>{formatPercent(d.after.allocation)}</strong>
                    </td>
                    <td>
                      {d.before ? <>{formatRupee(d.before.buyPrice)} &rarr; </> : null}
                      <strong>{formatRupee(d.after.buyPrice)}</strong>
                    </td>
                    <td>
                      {d.before && <span className={getColorClass(d.before.absoluteReturns)}>{formatPercent(d.before.absoluteReturns)}</span>}
                      {d.before && ' → '}
                      <strong className={getColorClass(d.after.absoluteReturns)}>{formatPercent(d.after.absoluteReturns)}</strong>
                    </td>
                    <td>
                      {d.before ? <>{d.before.holdingDays ?? '—'} &rarr; </> : null}
                      <strong>{d.after.holdingDays ?? '—'}</strong>
                    </td>
                    <td>
                      {d.before && <span className={getColorClass(d.before.cagr)}>{formatPercent(d.before.cagr)}</span>}
                      {d.before && ' → '}
                      <strong className={getColorClass(d.after.cagr)}>{formatPercent(d.after.cagr)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
