import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Custom fixed-position calendar dropdown -- NOT the native <input type="date">
// picker. The native picker's own prev/next-month arrows are a documented
// Chromium quirk inside horizontally-scrollable containers (this table has
// overflow-x: auto) and inside iframes (this whole app is embedded in one) --
// clicks on those arrows land at the wrong coordinates or do nothing. This
// popup is plain page content positioned with getBoundingClientRect(), the
// same technique ColumnFilter.jsx already uses reliably in this exact table.
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

const pad2 = (n) => String(n).padStart(2, '0');
const toIso = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

export default function DatePickerPopup({ value, max, top, left, onSelect, onClose }) {
  const ref = useRef(null);
  const initial = value ? new Date(value + 'T00:00:00') : new Date();
  const [viewYear,  setViewYear]  = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const maxDate = max ? new Date(max + 'T00:00:00') : null;

  const goPrevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else { setViewMonth(m => m - 1); }
  };
  const goNextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else { setViewMonth(m => m + 1); }
  };

  // Direct month/year jump -- clicking the prev/next arrows one at a time to
  // reach a buy date from years back is impractical, so the header doubles
  // as a pair of selects instead of a plain label.
  const maxYear = maxDate ? maxDate.getFullYear() : new Date().getFullYear();
  const YEAR_OPTIONS = [];
  for (let y = maxYear; y >= maxYear - 40; y--) YEAR_OPTIONS.push(y);

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startDow = firstOfMonth.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const clLeft = Math.min(left, (window.innerWidth || 1200) - 292);
  // Fixed-position popup: page scrolling never brings the rest of it into
  // view once it runs past the bottom of the viewport, so clamp the vertical
  // position the same way `left` is already clamped horizontally -- a month
  // can span up to 6 week-rows, so budget for the tallest case (header + dow
  // row + 6 rows + footer + padding).
  const POPUP_HEIGHT_EST = 340;
  const clTop = Math.min(top + 4, (window.innerHeight || 800) - POPUP_HEIGHT_EST);

  // Portaled to document.body: this popup is triggered from deep inside
  // .table-section, which sets backdrop-filter -- per spec that makes it the
  // containing block for `position: fixed` descendants, and combined with
  // that same element's `overflow: hidden`, the popup would render clipped
  // to invisibility instead of floating over the page. Escaping the DOM
  // subtree via a portal sidesteps both.
  return createPortal(
    <div ref={ref} className="dp-popup" style={{ top: Math.max(4, clTop), left: Math.max(4, clLeft) }} onClick={e => e.stopPropagation()}>
      <div className="dp-header">
        <button type="button" className="dp-nav-btn" onClick={goPrevMonth} title="Previous month">&#8249;</button>
        <div className="dp-month-select-row">
          <select
            className="dp-select"
            value={viewMonth}
            onChange={e => setViewMonth(Number(e.target.value))}
            title="Select month"
          >
            {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
          <select
            className="dp-select"
            value={viewYear}
            onChange={e => setViewYear(Number(e.target.value))}
            title="Select year"
          >
            {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <button type="button" className="dp-nav-btn" onClick={goNextMonth} title="Next month">&#8250;</button>
      </div>
      <div className="dp-dow-row">
        {DOW.map(d => <span key={d} className="dp-dow">{d}</span>)}
      </div>
      <div className="dp-grid">
        {cells.map((d, i) => {
          if (d == null) return <span key={i} className="dp-day dp-day-blank" />;
          const iso = toIso(viewYear, viewMonth, d);
          const isSelected = value === iso;
          const disabled = maxDate && new Date(viewYear, viewMonth, d) > maxDate;
          return (
            <button
              key={i}
              type="button"
              className={`dp-day${isSelected ? ' dp-day-selected' : ''}`}
              disabled={disabled}
              onClick={() => { onSelect(iso); onClose(); }}
            >
              {d}
            </button>
          );
        })}
      </div>
      <div className="dp-footer">
        <button type="button" className="dp-today-btn" onClick={() => { const t = new Date(); onSelect(toIso(t.getFullYear(), t.getMonth(), t.getDate())); onClose(); }}>
          Today
        </button>
      </div>
    </div>,
    document.body
  );
}
