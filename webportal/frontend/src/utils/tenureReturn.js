// Shared basket-index-based return calculation for a lookback tenure
// (1M/3M/6M/1Y/2Y/3Y/5Y), built on the same `historical_index.json` series
// (fetched once as `indexHistory` in App.jsx) that "Since Inception" and the
// "Portfolio Actions -> Calculate Return" page already use. Always measured
// from the series' own latest data point -- i.e. the last date data was
// actually uploaded -- never from today's calendar date.

export const TENURE_LOOKBACK_DAYS = {
  '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '2Y': 730, '3Y': 1095, '5Y': 1825,
};

export const TENURE_FULL_LABELS = {
  '1M': '1 Month', '3M': '3 Months', '6M': '6 Months',
  '1Y': '1 Year', '2Y': '2 Years', '3Y': '3 Years', '5Y': '5 Years',
};

function shiftIsoDate(iso, deltaDays) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

// Same semantics as CalculateReturnPage.jsx's findClosest: exact match first,
// else the next available date after the target, else the closest date
// before it -- kept identical so this always agrees with "Calculate Return".
function findClosestPoint(data, targetDate) {
  const exact = data.find(d => d.date === targetDate);
  if (exact) return exact;
  const next = data.find(d => d.date > targetDate);
  if (next) return next;
  const prev = [...data].reverse().find(d => d.date < targetDate);
  return prev || null;
}

export function getLatestIndexDate(data) {
  return data && data.length ? data[data.length - 1].date : null;
}

// Returns { pct, baseDate, latestDate } or null if there isn't enough history.
export function computeTenureReturn(data, tenure) {
  if (!data || data.length < 2) return null;
  const latestPt = data[data.length - 1];
  const days = TENURE_LOOKBACK_DAYS[tenure] ?? 30;
  const targetDate = shiftIsoDate(latestPt.date, -days);
  const basePt = findClosestPoint(data, targetDate);
  if (!basePt || !basePt.value || basePt.date >= latestPt.date) return null;
  return {
    pct: (latestPt.value - basePt.value) / basePt.value,
    baseDate: basePt.date,
    latestDate: latestPt.date,
  };
}
