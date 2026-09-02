import { useEffect, useState, useRef } from 'react';
import { getTheme, toggleTheme, THEME_SYNC_TYPE } from '../utils/theme.js';
import { TENURE_FULL_LABELS } from '../utils/tenureReturn.js';
import { addClient } from '../api/client.js';
import ClientSearchSelect from './ClientSearchSelect.jsx';

// Formats an ISO 'YYYY-MM-DD' date string as "24 July 2026" without going
// through the Date constructor, so there's no local-timezone off-by-one.
function formatIsoDateLong(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${+d} ${months[+m - 1]} ${y}`;
}

export default function Header({
  basketKey, basketOptions = [], onClientAdded, onBasketChange,
  searchTerm, onSearchChange, onSearchClear,
  canUndo, onUndo,
  onBuyPrice, onCalculateReturn, onPLStatement, onCorporateActions, onAllClients,
  onUploadHoldings, uploadingHoldings = false,
  readOnly = false,
  tenure = '1M', latestDataDate = null,
}) {
  const [dateStr,      setDateStr]      = useState('');
  const [actionsOpen,  setActionsOpen]  = useState(false);
  const [addingClient, setAddingClient] = useState(false);

  const handleAddClient = async () => {
    const name = window.prompt('New client name:');
    if (!name || !name.trim()) return;
    setAddingClient(true);
    try {
      const { key } = await addClient(name);
      await onClientAdded?.();
      onBasketChange?.(key);
    } catch (e) {
      window.alert(e.message || 'Failed to add client.');
    } finally {
      setAddingClient(false);
    }
  };
  const [theme,        setThemeState]   = useState(getTheme());
  const actionsRef = useRef(null);

  // "As on" shows the latest date this basket actually has data for -- not
  // today's calendar date -- falling back to today only while that data is
  // still loading (data-date momentarily unknown, never a real "no data").
  const asOfStr = latestDataDate ? formatIsoDateLong(latestDataDate) : dateStr;

  useEffect(() => {
    // Keeps this icon correct when the theme changes because the outer
    // app's toggle was clicked, not this one.
    const onMessage = (e) => {
      if (e.data?.type === THEME_SYNC_TYPE && (e.data.theme === 'light' || e.data.theme === 'dark')) {
        setThemeState(e.data.theme);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    setDateStr(new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }));
    const close = e => { if (actionsRef.current && !actionsRef.current.contains(e.target)) setActionsOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <header className="db-header">
      {/* Left title */}
      <div className="db-header-title">
        <div className="db-title-row">
          <h1 className="db-title">Actual Portfolio</h1>
          <span className="db-perf-badge">
            <i className="fa-solid fa-chart-line" /> Past {TENURE_FULL_LABELS[tenure] || '1 Month'} Trailing Returns
          </span>
        </div>
        <p className="db-subtitle">As on {asOfStr}</p>
      </div>

      {/* Right controls */}
      <div className="db-header-controls">
        {/* Search */}
        <div className="search-wrapper">
          <i className="fa-solid fa-magnifying-glass search-icon" />
          <input type="text" className="search-input" placeholder="Find stock…"
            value={searchTerm} onChange={e => onSearchChange(e.target.value)} />
          {searchTerm && (
            <button className="search-clear" onClick={onSearchClear}>
              <i className="fa-solid fa-xmark" />
            </button>
          )}
        </div>

        {/* Undo — hidden for read-only users */}
        {!readOnly && (
          <button className="undo-btn" onClick={onUndo} disabled={!canUndo} title="Undo last change">
            <i className="fa-solid fa-rotate-left" /> Undo
          </button>
        )}

        {/* Client selector — search by name or broker Client ID */}
        <ClientSearchSelect basketKey={basketKey} options={basketOptions} onSelect={onBasketChange} />

        {/* Add Client — admin-only. Rename/delete live in the All Clients tab. */}
        {!readOnly && (
          <button className="undo-btn" onClick={handleAddClient} disabled={addingClient} title="Add a new client">
            <i className="fa-solid fa-plus" /> {addingClient ? 'Adding…' : 'Add Client'}
          </button>
        )}

        {/* Date chip */}
        <div className="date-display">
          <i className="fa-regular fa-calendar" />
          <span>{asOfStr}</span>
        </div>

        {/* Theme toggle */}
        <button
          className="undo-btn"
          onClick={() => setThemeState(toggleTheme())}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          aria-label="Toggle color theme"
        >
          <i className={`fa-solid ${theme === 'light' ? 'fa-moon' : 'fa-sun'}`} />
        </button>

        {/* Portfolio Actions dropdown — visible to everyone; each destination
            page gates its own mutating actions (upload/edit/approve) to
            admins internally and shows read-only content to everyone else. */}
        <div className="db-actions-wrap" ref={actionsRef}>
          <button className="db-actions-btn" onClick={() => setActionsOpen(v => !v)}>
            <i className="fa-solid fa-sliders" />
            Portfolio Actions
            <i className={`fa-solid fa-chevron-${actionsOpen ? 'up' : 'down'}`} style={{ fontSize: '0.65rem' }} />
          </button>
          {actionsOpen && (
            <div className="db-actions-menu">
              <button className="db-action-item" onClick={() => { setActionsOpen(false); onBuyPrice(); }}>
                <i className="fa-solid fa-receipt" /> Buy Price Data
              </button>
              <button className="db-action-item" onClick={() => { setActionsOpen(false); onCalculateReturn(); }}>
                <i className="fa-solid fa-chart-line" /> Calculate Return
              </button>
              <button className="db-action-item" onClick={() => { setActionsOpen(false); onPLStatement(); }}>
                <i className="fa-solid fa-file-invoice-dollar" /> P&amp;L Statement
              </button>
              <button className="db-action-item" onClick={() => { setActionsOpen(false); onCorporateActions(); }}>
                <i className="fa-solid fa-code-branch" /> Corporate Actions
              </button>
              <button className="db-action-item" onClick={() => { setActionsOpen(false); onAllClients(); }}>
                <i className="fa-solid fa-users" /> All Clients
              </button>
              {!readOnly && (
                <button className="db-action-item" disabled={uploadingHoldings} onClick={() => { setActionsOpen(false); onUploadHoldings(); }}>
                  <i className={`fa-solid ${uploadingHoldings ? 'fa-spinner fa-spin' : 'fa-file-import'}`} /> {uploadingHoldings ? 'Uploading…' : 'Upload Holdings'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
