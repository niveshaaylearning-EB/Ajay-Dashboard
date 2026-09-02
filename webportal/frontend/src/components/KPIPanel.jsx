import { formatPercent, getColorClass } from '../App.jsx';

function KPICard({ label, value, valueCls, sub, sub2, action }) {
  return (
    <div className="kpi-card-new">
      <span className="kpi-card-label">
        {label}
        {action}
      </span>
      <span className={`kpi-card-value ${valueCls || ''}`}>{value}</span>
      {sub  && <span className="kpi-card-sub">{sub}</span>}
      {sub2 && <span className="kpi-card-sub kpi-card-sub2">{sub2}</span>}
    </div>
  );
}

const fmtRupee = (v) => v == null ? '-' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function KPIPanel({
  tenureReturn, tenureLabel, totalAbsReturn, avgMarketCap, medianPE, activeStocks, totalAllocation, rows,
  totalCapital, currentValue, isAdmin, onEditCapital,
}) {
  const totalRows = rows?.length || 0;
  const tenurePct = tenureReturn?.pct ?? null;

  return (
    <div className="kpi-strip kpi-strip--5">
      <KPICard
        label={`${tenureLabel || '1M'} Returns`}
        value={tenurePct != null ? formatPercent(tenurePct) : '-'}
        valueCls={getColorClass(tenurePct)}
        sub={tenureReturn ? `Basket index return since ${tenureReturn.baseDate}` : 'Basket index return'}
      />
      <KPICard label="Since Inception"  value={totalAbsReturn != null ? formatPercent(totalAbsReturn) : '-'} valueCls={getColorClass(totalAbsReturn)} sub="Basket index absolute return" />
      <KPICard label="Active Stocks"    value={activeStocks}      sub={`of ${totalRows} total`} valueCls="neutral" />
      <KPICard label="Total Allocation" value={totalAllocation > 0 ? (totalAllocation * 100).toFixed(1) + '%' : '-'} valueCls={Math.abs(totalAllocation - 1) < 0.005 ? 'positive' : 'neutral'} sub="Sum of weights" />
      <KPICard
        label="Investment Value"
        value={fmtRupee(currentValue ?? totalCapital)}
        valueCls="neutral"
        sub={totalCapital != null ? `Invested ${fmtRupee(totalCapital)}` : 'No capital set yet'}
        action={isAdmin && (
          <button
            className="kpi-edit-btn"
            onClick={onEditCapital}
            title={totalCapital != null ? 'Edit total capital deployed' : 'Set total capital deployed'}
          >
            <i className="fa-solid fa-pen" />
          </button>
        )}
      />
    </div>
  );
}
