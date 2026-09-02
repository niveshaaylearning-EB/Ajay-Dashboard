import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, ChevronDown, ChevronUp, Search } from 'lucide-react';

import { API_BASE } from '../config.js';

function ScreenerData() {
  const navigate = useNavigate();
  const [baskets, setBaskets] = useState({});
  const [loading, setLoading] = useState(true);
  const [expandedBasket, setExpandedBasket] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const fetchBaskets = async () => {
      setLoading(true);
      try {
        // Prefer actual portfolio data; fall back to PF dashboard basket data
        const [actualRes, pfRes] = await Promise.allSettled([
          axios.get(`${API_BASE}/actual-portfolio-all`),
          axios.get(`${API_BASE}/baskets`),
        ]);
        const actual = actualRes.status === 'fulfilled' ? actualRes.value.data : {};
        const pf     = pfRes.status    === 'fulfilled' ? pfRes.value.data    : {};
        // Merge: actual portfolio baskets take priority; include PF baskets not in actual
        const merged = { ...pf };
        Object.entries(actual).forEach(([key, b]) => {
          merged[key] = b;
        });
        setBaskets(merged);
      } catch (e) {
        console.error(e);
      }
      setLoading(false);
    };
    fetchBaskets();
  }, []);

  const openScreener = (code) => {
    // screener.in URL format: https://www.screener.in/company/STOCKCODE/
    const cleanCode = code.replace(/\.NS$/i, '').toUpperCase();
    window.open(`https://www.screener.in/company/${cleanCode}/`, '_blank', 'noopener,noreferrer');
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', marginTop: '4rem' }}>
        <h3 className="text-gradient">Loading Portfolios...</h3>
      </div>
    );
  }

  const basketList = Object.values(baskets);

  return (
    <div className="animate-slide-up">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '32px' }}>
        <button
          className="btn btn-secondary"
          onClick={() => navigate('/')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px' }}
        >
          <ArrowLeft size={18} /> Back
        </button>
        <div>
          <h2 style={{ margin: 0 }}>Screener Data</h2>
          <p style={{ color: 'var(--text-muted)', margin: '4px 0 0', fontSize: '0.9rem' }}>
            Browse all portfolio stocks and jump directly to Screener.in for deep fundamental analysis.
          </p>
        </div>
      </div>

      {/* Global search */}
      <div style={{ position: 'relative', marginBottom: '28px', maxWidth: '400px' }}>
        <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input
          type="text"
          placeholder="Search stocks across all portfolios…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ paddingLeft: '38px', width: '100%' }}
        />
      </div>

      {/* Portfolio list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {basketList.map(basket => {
          const isExpanded = expandedBasket === basket.id;
          const holdings = basket.holdings || [];

          // Filter holdings by search
          const filtered = search.trim()
            ? holdings.filter(h =>
                (h.code || '').toLowerCase().includes(search.toLowerCase()) ||
                (h.stock_name || '').toLowerCase().includes(search.toLowerCase())
              )
            : holdings;

          // If searching, only show baskets that have matching stocks
          if (search.trim() && filtered.length === 0) return null;

          return (
            <div key={basket.id} className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>
              {/* Basket header — click to expand */}
              <button
                onClick={() => setExpandedBasket(isExpanded ? null : basket.id)}
                style={{
                  width: '100%', background: 'transparent', border: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '20px 24px', cursor: 'pointer', color: 'var(--text-main)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div style={{
                    background: 'rgba(99,102,241,0.15)', color: 'var(--primary)',
                    padding: '6px 14px', borderRadius: '20px', fontSize: '0.85rem', fontWeight: 700
                  }}>
                    {filtered.length} stocks
                  </div>
                  <h3 style={{ margin: 0, fontWeight: 600 }}>{basket.name}</h3>
                </div>
                <div style={{ color: 'var(--text-muted)' }}>
                  {(isExpanded || search.trim()) ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </div>
              </button>

              {/* Stock list — shown when expanded OR when searching */}
              {(isExpanded || search.trim()) && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '16px 24px 20px' }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                    gap: '10px',
                  }}>
                    {filtered.map((h, idx) => (
                      <StockCard
                        key={h.code || idx}
                        code={h.code}
                        name={h.stock_name || h.code}
                        sector={h.sector || h.theme || ''}
                        onOpen={openScreener}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StockCard({ code, name, sector, onOpen }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.07)',
      borderRadius: '10px',
      padding: '12px 14px',
      gap: '12px',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '2px' }}>
          {code}
        </div>
        <div style={{
          fontSize: '0.78rem', color: 'var(--text-muted)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          maxWidth: '160px'
        }}>
          {name}
        </div>
        {sector && (
          <div style={{ marginTop: '4px' }}>
            <span style={{
              background: 'rgba(99,102,241,0.12)', color: 'var(--primary)',
              padding: '1px 7px', borderRadius: '10px', fontSize: '0.7rem', fontWeight: 600,
            }}>
              {sector}
            </span>
          </div>
        )}
      </div>
      <button
        onClick={() => onOpen(code)}
        className="btn btn-primary"
        style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          padding: '7px 12px', fontSize: '0.78rem', whiteSpace: 'nowrap', flexShrink: 0,
        }}
        title={`Open ${code} on Screener.in`}
      >
        <ExternalLink size={13} /> Screener
      </button>
    </div>
  );
}

export default ScreenerData;
