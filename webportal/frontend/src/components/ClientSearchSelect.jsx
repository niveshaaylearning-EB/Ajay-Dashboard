import { useState, useEffect, useRef } from 'react';

// Searchable client switcher -- replaces a plain <select> so an admin with
// many clients can jump straight to one by typing part of its name OR its
// broker Client ID (e.g. "PA8384"), instead of scrolling a dropdown list.
export default function ClientSearchSelect({ basketKey, options = [], onSelect }) {
  const [query,        setQuery]        = useState('');
  const [isOpen,       setIsOpen]       = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapRef = useRef(null);

  useEffect(() => {
    const close = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setIsOpen(false); setQuery(''); } };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const current = options.find(o => o.key === basketKey);
  const q = query.trim().toLowerCase();
  const filtered = !q ? options : options.filter(o =>
    o.label.toLowerCase().includes(q) || (o.clientId || '').toLowerCase().includes(q)
  );

  const commit = (key) => {
    setQuery('');
    setIsOpen(false);
    setHighlightIdx(-1);
    if (key !== basketKey) onSelect(key);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(h => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0 && filtered[highlightIdx]) commit(filtered[highlightIdx].key);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setQuery('');
    }
  };

  return (
    <div className="client-search-wrap" ref={wrapRef}>
      <input
        type="text"
        className="db-basket-select client-search-input"
        value={isOpen ? query : (current?.label || '')}
        onChange={e => { setQuery(e.target.value); setIsOpen(true); setHighlightIdx(-1); }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={options.length === 0 ? 'No clients yet' : 'Search client (name or ID)…'}
        disabled={options.length === 0}
        autoComplete="off"
      />
      <i className="fa-solid fa-magnifying-glass client-search-icon" />
      {isOpen && (
        <ul className="client-search-list">
          {filtered.length === 0 && <li className="client-search-empty">No matches</li>}
          {filtered.map((o, i) => (
            <li
              key={o.key}
              className={`client-search-item${i === highlightIdx ? ' active' : ''}${o.key === basketKey ? ' selected' : ''}`}
              onMouseDown={e => { e.preventDefault(); commit(o.key); }}
              onMouseEnter={() => setHighlightIdx(i)}
            >
              <span className="client-search-name">{o.label}</span>
              {o.clientId && <span className="client-search-id">{o.clientId}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
