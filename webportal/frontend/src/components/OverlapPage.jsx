import { useEffect, useState } from 'react';
import { API_BASE } from '../api/base.js';
import { formatRupee } from '../App.jsx';

const fetchOverlapSummary = () => fetch(`${API_BASE}/overlap-summary`).then(r => r.json());

const pctColor = (v) => v == null ? 'var(--text-secondary)' : v > 0 ? 'var(--accent-green)' : v < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';
const fmtPct   = (v) => v == null ? '—' : v.toFixed(2) + '%';

const hdrStyle = { textAlign: 'right', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '0.3rem 0.6rem', borderBottom: '1px solid var(--border-color)' };
const cellStyle = { textAlign: 'right', fontSize: '0.8rem', padding: '0.35rem 0.6rem' };

// Centralized, NOT basket-scoped -- same as WatchlistPage, this reflects
// every client's data regardless of which one is currently selected in the
// header. Qualification: a stock counts as "overlap" once 2+ distinct
// clients currently hold it (allocation > 0); past sales by ANY client of
// that same stock are shown as extra context once a stock already qualifies.
export default function OverlapPage() {
  const [data,       setData]       = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [searchTerm,  setSearchTerm]  = useState('');
  const [expanded,    setExpanded]    = useState(() => new Set());

  useEffect(() => {
    setLoading(true);
    fetchOverlapSummary().then(setData).catch(() => setData([])).finally(() => setLoading(false));
  }, []);

  const toggleExpand = (code) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  };

  const filtered = data.filter(r => !searchTerm || r.nseCode.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="ov-root">
      <div className="ov-header">
        <div className="ov-title">
          <i className="fa-solid fa-layer-group" style={{ color: 'var(--accent-blue)', marginRight: '0.5rem' }} />
          Stock Overlap Across Clients
        </div>
        <div className="search-wrapper">
          <i className="fa-solid fa-magnifying-glass search-icon" />
          <input
            type="text"
            className="search-input"
            placeholder="Search NSE code…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button className="search-clear" onClick={() => setSearchTerm('')} title="Clear search">
              <i className="fa-solid fa-xmark" />
            </button>
          )}
        </div>
      </div>
      <div className="ov-subtitle">
        {loading ? 'Loading…' : `${filtered.length} stock${filtered.length !== 1 ? 's' : ''} held by 2+ clients`}
      </div>

      {loading ? (
        <div className="bp-empty">Loading overlap data…</div>
      ) : filtered.length === 0 ? (
        <div className="bp-empty">
          {data.length === 0 ? 'No overlapping stocks — every client currently holds a distinct set of stocks.' : 'No stocks match your search.'}
        </div>
      ) : (
        <div className="ov-list">
          {filtered.map(stock => {
            const isOpen = expanded.has(stock.nseCode);
            return (
              <div key={stock.nseCode} className="ov-card">
                <button className="ov-card-head" onClick={() => toggleExpand(stock.nseCode)}>
                  <span className="ov-stock-code">{stock.nseCode}</span>
                  <span className="ov-client-count">{stock.clientCount} clients</span>
                  <span className="ov-mini-clients">
                    {stock.current.slice(0, 4).map(c => c.clientLabel).join(', ')}
                    {stock.current.length > 4 ? ` +${stock.current.length - 4} more` : ''}
                  </span>
                  <i className={`fa-solid fa-chevron-${isOpen ? 'up' : 'down'} ov-card-chevron`} />
                </button>
                {isOpen && (
                  <div className="ov-card-body">
                    <div className="ov-section-label">Current Holdings</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="bp-table">
                        <thead>
                          <tr>
                            <th style={{ ...hdrStyle, textAlign: 'left' }}>Client</th>
                            {['Allocation', 'Invested Value', 'Buy Date', 'Buy Price', 'CMP', 'Return'].map(h => (
                              <th key={h} style={hdrStyle}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {stock.current.map(c => (
                            <tr key={c.clientKey}>
                              <td style={{ ...cellStyle, textAlign: 'left', fontWeight: 600, color: 'var(--text-primary)' }}>{c.clientLabel}</td>
                              <td style={cellStyle}>{c.allocationPct.toFixed(2)}%</td>
                              <td style={cellStyle}>{formatRupee(c.investedValue)}</td>
                              <td style={cellStyle}>{c.buyDate || '—'}</td>
                              <td style={cellStyle}>{formatRupee(c.buyPrice)}</td>
                              <td style={cellStyle}>{formatRupee(c.cmp)}</td>
                              <td style={{ ...cellStyle, fontWeight: 600, color: pctColor(c.absoluteReturnPct) }}>{fmtPct(c.absoluteReturnPct)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {stock.sold.length > 0 && (
                      <>
                        <div className="ov-section-label" style={{ marginTop: '0.9rem' }}>Sold History (any client)</div>
                        <div style={{ overflowX: 'auto' }}>
                          <table className="bp-table">
                            <thead>
                              <tr>
                                <th style={{ ...hdrStyle, textAlign: 'left' }}>Client</th>
                                {['Weight Sold', 'Buy Price', 'Sell Price', 'Sell Date', 'Action', 'Realized Return'].map(h => (
                                  <th key={h} style={hdrStyle}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {stock.sold.map((s, i) => (
                                <tr key={i}>
                                  <td style={{ ...cellStyle, textAlign: 'left', color: 'var(--text-primary)' }}>{s.clientLabel}</td>
                                  <td style={cellStyle}>{s.weightSoldPct != null ? `${s.weightSoldPct}%` : '—'}</td>
                                  <td style={cellStyle}>{formatRupee(s.buyPrice)}</td>
                                  <td style={cellStyle}>{formatRupee(s.sellPrice)}</td>
                                  <td style={cellStyle}>{s.sellDate || '—'}</td>
                                  <td style={cellStyle}>{s.action || '—'}</td>
                                  <td style={{ ...cellStyle, fontWeight: 600, color: pctColor(s.realizedReturnPct) }}>{fmtPct(s.realizedReturnPct)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
