import { useState, useEffect, useRef } from 'react';

/**
 * Controlled NSE ticker input with dropdown autocomplete.
 * Filters client-side from `symbols` prop (loaded once in App.jsx).
 * Calls `onCommit(symbol)` when user picks a suggestion or blurs the field.
 */
export default function NseAutocomplete({ initialValue, onCommit, symbols = [], disabled = false }) {
  const [value,        setValue]        = useState(initialValue || '');
  const [suggestions,  setSuggestions]  = useState([]);
  const [isOpen,       setIsOpen]       = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const committedRef = useRef(initialValue || '');

  // Sync when the parent row changes (basket switch / row reset)
  useEffect(() => {
    setValue(initialValue || '');
    committedRef.current = initialValue || '';
  }, [initialValue]);

  // Recompute suggestions — only when user has changed the value from what was committed
  useEffect(() => {
    const q = value.trim().toUpperCase();
    // Don't show for existing stocks the user hasn't started editing
    if (!q || q === committedRef.current.toUpperCase() || symbols.length === 0) {
      setSuggestions([]); setIsOpen(false); return;
    }

    const prefix = symbols.filter(s => s.symbol.startsWith(q));
    const nameHit = symbols.filter(
      s => !s.symbol.startsWith(q) && s.name.toUpperCase().includes(q)
    );
    const result = [...prefix, ...nameHit].slice(0, 12);
    setSuggestions(result);
    setIsOpen(result.length > 0);
    setHighlightIdx(-1);
  }, [value, symbols]);

  const commit = (symbol) => {
    const s = symbol.trim().toUpperCase();
    setValue(s);
    setSuggestions([]);
    setIsOpen(false);
    if (s && s !== committedRef.current) {
      committedRef.current = s;
      onCommit(s);
    }
  };

  const handleChange = (e) => {
    setValue(e.target.value.toUpperCase());
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(h => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0 && suggestions[highlightIdx]) {
        commit(suggestions[highlightIdx].symbol);
      } else {
        commit(value);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleBlur = () => {
    // Delay so mousedown on a suggestion fires before blur closes the list
    setTimeout(() => { setIsOpen(false); commit(value); }, 160);
  };

  return (
    <div className="nse-autocomplete-wrapper">
      <input
        type="text"
        className="cell-edit nse-edit"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder="NSE Code"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        style={{ textTransform: 'uppercase', width: '100%' }}
      />

      {isOpen && suggestions.length > 0 && (
        <ul className="nse-suggestions">
          {suggestions.map((s, i) => (
            <li
              key={s.symbol}
              className={`nse-suggestion-item${i === highlightIdx ? ' active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); commit(s.symbol); }}
              onMouseEnter={() => setHighlightIdx(i)}
            >
              <span className="nse-sugg-symbol">{s.symbol}</span>
              <span className="nse-sugg-name">{s.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
