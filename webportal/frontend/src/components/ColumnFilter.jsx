import { useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';

export default function ColumnFilter({
  rows, getValue, activeValues,
  isSorted, sortDir,
  onSort, onFilter, onClose,
  top, left,
}) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const uniqueVals = useMemo(() => {
    const seen = new Set();
    const vals = [];
    for (const r of rows) {
      const v = getValue(r);
      const s = v == null ? '' : String(v);
      if (s && !seen.has(s)) { seen.add(s); vals.push(s); }
    }
    vals.sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
    return vals;
  }, [rows, getValue]);

  const isAll = activeValues === null;
  const isChecked = (v) => isAll || (activeValues?.has(v) ?? false);

  const toggle = (val) => {
    if (isAll) { onFilter(new Set([val])); return; }
    const next = new Set(activeValues);
    if (next.has(val)) next.delete(val); else next.add(val);
    onFilter(next.size === 0 || next.size === uniqueVals.length ? null : next);
  };

  const clLeft = Math.min(left, (window.innerWidth || 1200) - 216);

  // Portaled to document.body -- this popup is triggered from inside
  // .table-section, which sets backdrop-filter; per spec that makes it the
  // containing block for `position: fixed` descendants, and combined with
  // that element's `overflow: hidden`, the popup would render clipped to
  // invisibility instead of floating over the page.
  return createPortal(
    <div
      ref={ref}
      className="cf-popup"
      style={{ top: top + 4, left: Math.max(4, clLeft) }}
      onClick={e => e.stopPropagation()}
    >
      <div className={`cf-sort-row${isSorted && sortDir === 'asc' ? ' cf-active' : ''}`}
           onClick={() => { onSort('asc'); onClose(); }}>
        <span>↑</span> Sort A → Z
      </div>
      <div className={`cf-sort-row${isSorted && sortDir === 'desc' ? ' cf-active' : ''}`}
           onClick={() => { onSort('desc'); onClose(); }}>
        <span>↓</span> Sort Z → A
      </div>
      <div className="cf-divider" />
      <div className="cf-ctrl">
        <button onClick={() => onFilter(null)}>Select All</button>
        <button onClick={() => onFilter(new Set([]))}>Clear</button>
      </div>
      <div className="cf-list">
        {uniqueVals.map(v => (
          <label key={v} className="cf-item">
            <input type="checkbox" checked={isChecked(v)} onChange={() => toggle(v)} />
            <span>{v}</span>
          </label>
        ))}
        {!uniqueVals.length && <div className="cf-empty">No values</div>}
      </div>
    </div>,
    document.body
  );
}
