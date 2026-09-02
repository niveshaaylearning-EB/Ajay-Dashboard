import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

import { API_BASE } from '../config.js';

export default function AutoCompleteInput({ value, onChange, onSelect, placeholder }) {
  const [query, setQuery] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    if (!isOpen) return;
    
    const fetchSuggestions = async () => {
      if (query.trim().length === 0) {
        setSuggestions([]);
        return;
      }
      try {
        const res = await axios.get(`${API_BASE}/stocks/search?q=${encodeURIComponent(query)}`);
        setSuggestions(res.data);
      } catch (e) {
        console.error("Search failed", e);
      }
    };
    
    // simple debounce
    const timeoutId = setTimeout(() => {
      fetchSuggestions();
    }, 300);
    
    return () => clearTimeout(timeoutId);
  }, [query, isOpen]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [wrapperRef]);

  const handleSelect = (stock) => {
    setQuery(stock.code);
    setIsOpen(false);
    onChange(stock.code);
    if (onSelect) onSelect(stock); // pass full {code, name} to parent
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', width: '100%' }}>
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
          onChange(e.target.value);
        }}
        onFocus={() => setIsOpen(true)}
      />
      {isOpen && suggestions.length > 0 && (
        <ul style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: 'var(--panel-bg)',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          zIndex: 1000,
          listStyle: 'none',
          padding: '8px 0',
          margin: 0,
          maxHeight: '200px',
          overflowY: 'auto'
        }}>
          {suggestions.map((s, idx) => (
            <li 
              key={idx} 
              style={{
                padding: '8px 16px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                borderBottom: idx === suggestions.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)'
              }}
              onClick={() => handleSelect(s)}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
            >
              <strong style={{color: 'var(--text-main)'}}>{s.code}</strong>
              <span style={{color: 'var(--text-muted)', fontSize: '0.85rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '60%'}}>
                {s.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
