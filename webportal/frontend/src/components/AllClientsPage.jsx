import { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { getAuthToken } from '../api/base.js';
import { addClient, renameClient, deleteClient, setClientCapital, fetchClientsSummary, fetchBasket, fetchLiveData } from '../api/client.js';
import { calcAbsoluteReturns, calcHoldingDaysWithBuyDateFallback, calcPerformance, calcContribution } from '../App.jsx';
import ConfirmModal from './ConfirmModal.jsx';

const ADMIN_EMAILS = ['jay.chaudhari@niveshaay.com', 'nukul.madaan@niveshaay.com', 'nakshatra.rathi@niveshaay.com'];
const _getAdminState = () => {
  try {
    const t = getAuthToken();
    if (!t) return { isAdmin: false };
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (payload.exp && Date.now() > payload.exp * 1000) return { isAdmin: false };
    const email = (payload.sub || '').toLowerCase().trim();
    return { isAdmin: ADMIN_EMAILS.includes(email) };
  } catch { return { isAdmin: false }; }
};

const fmtRupee = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const fmtPct   = (v) => v == null ? '—' : (v * 100).toFixed(2) + '%';

// Text-only mirror of PortfolioTable.jsx's getCmpStatus (that one also
// carries a display color, irrelevant for a spreadsheet cell).
function cmpStatusLabel(cmp, targetPrice, stopLoss) {
  if (cmp == null) return '';
  if (targetPrice != null) {
    if (cmp >= targetPrice) return 'Target Achieved';
    if (cmp >= targetPrice * 0.95) return 'Near Target Price';
  }
  if (stopLoss != null) {
    if (cmp <= stopLoss) return 'SL Triggered';
    if (cmp <= stopLoss * 1.05) return 'Near Stop Loss';
  }
  return '';
}
const pctColor = (v) => v == null ? 'var(--text-secondary)' : v > 0 ? 'var(--accent-green)' : v < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';

export default function AllClientsPage() {
  const { isAdmin: userIsAdmin } = _getAdminState();
  const [rows,        setRows]        = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [searchTerm,   setSearchTerm]   = useState('');
  const [saveMsg,      setSaveMsg]      = useState('');
  const [addingClient, setAddingClient] = useState(false);
  const [editRow,       setEditRow]       = useState(null);   // row being edited, or null
  const [editName,      setEditName]      = useState('');
  const [editCapital,   setEditCapital]   = useState('');
  const [savingEdit,    setSavingEdit]    = useState(false);
  const [deleteTarget,  setDeleteTarget]  = useState(null);   // row pending delete confirmation
  const [selectedKeys,  setSelectedKeys]  = useState(new Set());
  const [exporting,     setExporting]     = useState(false);

  const refresh = () => {
    setLoading(true);
    fetchClientsSummary()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  const flash = (msg) => { setSaveMsg(msg); setTimeout(() => setSaveMsg(''), 2500); };

  const handleAddClient = async () => {
    const name = window.prompt('New client name:');
    if (!name || !name.trim()) return;
    setAddingClient(true);
    try {
      await addClient(name);
      refresh();
      flash('Client added!');
    } catch (e) {
      window.alert(e.message || 'Failed to add client.');
    } finally {
      setAddingClient(false);
    }
  };

  const openEdit = (row) => {
    setEditRow(row);
    setEditName(row.label);
    setEditCapital(row.totalCapital != null ? String(row.totalCapital) : '');
  };

  const handleSaveEdit = async () => {
    if (!editRow) return;
    const name = editName.trim();
    if (!name) { window.alert('Client name is required.'); return; }
    const capitalNum = editCapital.trim() === '' ? null : parseFloat(editCapital);
    if (editCapital.trim() !== '' && (isNaN(capitalNum) || capitalNum < 0)) {
      window.alert('Total capital must be a non-negative number.');
      return;
    }
    setSavingEdit(true);
    try {
      if (name !== editRow.label) await renameClient(editRow.key, name);
      if (capitalNum != null && capitalNum !== editRow.totalCapital) await setClientCapital(editRow.key, capitalNum);
      setEditRow(null);
      refresh();
      flash('Client updated!');
    } catch (e) {
      window.alert(e.message || 'Failed to update client.');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const key = deleteTarget.key;
    setDeleteTarget(null);
    try {
      await deleteClient(key);
      refresh();
      flash('Client deleted.');
    } catch (e) {
      window.alert(e.message || 'Failed to delete client.');
    }
  };

  const filteredRows = rows.filter(r => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return r.label.toLowerCase().includes(q) || (r.clientId || '').toLowerCase().includes(q);
  });
  const totalCapital = rows.reduce((s, r) => s + (r.totalCapital || 0), 0);
  const totalCurrent = rows.reduce((s, r) => s + (r.currentValue || 0), 0);

  const toggleSelect = (key) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const allFilteredSelected = filteredRows.length > 0 && filteredRows.every(r => selectedKeys.has(r.key));
  const toggleSelectAll = () => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredRows.forEach(r => next.delete(r.key));
      else filteredRows.forEach(r => next.add(r.key));
      return next;
    });
  };

  // Exports every selected client's full holdings (one row per stock) plus a
  // per-client summary, into one workbook -- two sheets, so it stays useful
  // whether one client or fifty are selected. Basket fetches run in parallel;
  // live prices (cmp/OHLC/market cap) are fetched once and shared across every
  // selected client since the same stock can appear in several baskets.
  const handleExport = async () => {
    const targets = rows.filter(r => selectedKeys.has(r.key));
    if (!targets.length) return;
    setExporting(true);
    try {
      const [liveData, basketResults] = await Promise.all([
        fetchLiveData(),
        Promise.all(targets.map(client => fetchBasket(client.key).then(data => ({ client, data })))),
      ]);

      const summaryHeader = ['Client', 'Client ID', 'Stocks', 'Invested Value (₹)', 'Current Value (₹)', 'Since Inception Return (%)'];
      const summaryRows = targets.map(r => [
        r.label, r.clientId || '', r.stockCount,
        r.totalCapital ?? '', r.currentValue ?? '',
        r.sinceInceptionPct != null ? +(r.sinceInceptionPct * 100).toFixed(2) : '',
      ]);

      // Every field the app tracks per holding -- mirrors the on-screen
      // Holdings table's full column set (incl. the Show Details/OHLC
      // columns, which are hidden by default on screen but always included
      // here) plus buyPriceDetails' segment/target/stop-loss, which the
      // table doesn't show as columns at all but the app does store.
      const holdingsHeader = [
        'Client', 'Client ID', 'NSE Code', 'Security Name', 'Segment',
        'Allocation (%)', 'Invested Value (₹)', 'Buy Date', 'Buy Price (₹)', 'CMP (₹)',
        'Absolute Return (%)', 'Performance 1M (%)', 'Contribution 1M (%)', 'Holding Days',
        'Target Price (₹)', 'Stop Loss (₹)', 'Status',
        'Market Cap (Cr)', 'PE Ratio', 'Open 1M (₹)', 'Close 1M (₹)', 'High 1M (₹)', 'Low 1M (₹)',
      ];
      const holdingsRows = [];

      for (const { client, data } of basketResults) {
        const stocks  = (data.stocks || []).filter(s => (s.allocation || 0) > 0);
        const details = data.buyPriceDetails || {};
        for (const s of stocks) {
          const det  = details[s.nseCode] || {};
          const live = liveData[s.nseCode] || {};
          const cmp  = live.cmp ?? null;
          const absReturn    = calcAbsoluteReturns(cmp, s.buyPrice);
          const performance1M = calcPerformance(live.open1M, live.close1M);
          const contribution1M = calcContribution(s.allocation, performance1M);
          const holdingDays  = calcHoldingDaysWithBuyDateFallback(det.buyEvents, det.sellEvents, det.buyDate);
          holdingsRows.push([
            client.label, client.clientId || '', s.nseCode, det.securityName || '', det.segment || '',
            s.allocation != null ? +(s.allocation * 100).toFixed(2) : '',
            (client.totalCapital != null && s.allocation != null) ? Math.round(s.allocation * client.totalCapital) : '',
            det.buyDate || '', s.buyPrice ?? '', cmp ?? '',
            absReturn != null ? +(absReturn * 100).toFixed(2) : '',
            performance1M != null ? +(performance1M * 100).toFixed(2) : '',
            contribution1M != null ? +(contribution1M * 100).toFixed(2) : '',
            holdingDays ?? '',
            det.targetPrice ?? '', det.stopLoss ?? '',
            cmpStatusLabel(cmp, det.targetPrice, det.stopLoss),
            live.marketCapCr != null ? Math.round(live.marketCapCr) : '', live.peRatio ?? '',
            live.open1M ?? '', live.close1M ?? '', live.high1M ?? '', live.low1M ?? '',
          ]);
        }
      }

      const wb = XLSX.utils.book_new();
      const ws1 = XLSX.utils.aoa_to_sheet([summaryHeader, ...summaryRows]);
      ws1['!cols'] = [22, 12, 8, 18, 18, 20].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws1, 'Clients Summary');

      const ws2 = XLSX.utils.aoa_to_sheet([holdingsHeader, ...holdingsRows]);
      ws2['!cols'] = [20, 12, 10, 26, 14, 12, 16, 12, 12, 10, 14, 14, 16, 12, 12, 12, 16, 14, 10, 12, 12, 12, 12].map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws2, 'Holdings');

      const stamp = targets.length === 1
        ? targets[0].label.replace(/[^A-Za-z0-9]+/g, '_')
        : `${targets.length}_clients`;
      XLSX.writeFile(wb, `ClientHoldings_${stamp}.xlsx`);
    } catch (e) {
      window.alert('Export failed: ' + e.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      {editRow && (
        <div
          onClick={() => !savingEdit && setEditRow(null)}
          style={{ position: 'fixed', inset: 0, background: 'var(--modal-overlay-bg)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--panel-border-hover)', borderRadius: '12px', padding: '1.5rem', width: '380px', maxWidth: '92vw' }}
          >
            <div style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)', marginBottom: '1rem' }}>
              <i className="fa-solid fa-pen" style={{ color: 'var(--accent-blue)', marginRight: '0.5rem' }} />
              Edit Client
            </div>
            <div className="input-group">
              <label>Client Name</label>
              <input type="text" value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div className="input-group">
              <label>Total Capital Deployed (₹)</label>
              <input type="number" min="0" step="0.01" placeholder="e.g. 500000" value={editCapital} onChange={e => setEditCapital(e.target.value)} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginTop: '1.2rem' }}>
              <button className="btn" onClick={() => setEditRow(null)} disabled={savingEdit}>Cancel</button>
              <button className="btn btn-secondary" onClick={handleSaveEdit} disabled={savingEdit}>
                {savingEdit ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Client"
          message={`Permanently delete "${deleteTarget.label}" and ALL of their data —\nholdings, buy-price history, rebalance history, and undo snapshots?\n\nThis cannot be undone.`}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <div className="bp-page">
        <div className="bp-page-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              onClick={() => { window.location.href = '/wp/' + window.location.search; }}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.9rem', borderRadius: '8px', fontSize: '0.82rem', fontWeight: 600, background: 'var(--hover-bg)', border: '1px solid var(--panel-border-hover)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              ← Back
            </button>
            <div className="bp-page-title">
              <i className="fa-solid fa-users" style={{ color: 'var(--accent-blue)', marginRight: '0.6rem' }} />
              All Clients
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="search-wrapper">
              <i className="fa-solid fa-magnifying-glass search-icon" />
              <input
                type="text"
                className="search-input"
                placeholder="Search by name or Client ID…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
              {searchTerm && (
                <button className="search-clear" onClick={() => setSearchTerm('')} title="Clear search">
                  <i className="fa-solid fa-xmark" />
                </button>
              )}
            </div>
            {saveMsg && <span className="bp-save-msg">{saveMsg}</span>}
            <button
              className="bp-save-btn"
              onClick={handleExport}
              disabled={exporting || selectedKeys.size === 0}
              title={selectedKeys.size === 0 ? 'Select one or more clients to export' : `Export ${selectedKeys.size} client${selectedKeys.size !== 1 ? 's' : ''} to Excel`}
              style={{ background: 'rgba(16,185,129,0.1)', color: (exporting || selectedKeys.size === 0) ? 'var(--text-secondary)' : 'var(--accent-green)', borderColor: 'rgba(16,185,129,0.25)' }}
            >
              <i className={`fa-solid ${exporting ? 'fa-spinner fa-spin' : 'fa-file-arrow-down'}`} style={{ marginRight: '0.35rem' }} />
              {exporting ? 'Exporting…' : `Export${selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ''}`}
            </button>
            {userIsAdmin && (
              <button
                className="bp-save-btn"
                onClick={handleAddClient}
                disabled={addingClient}
                title="Add a new client"
                style={{ background: 'rgba(99,102,241,0.1)', color: 'var(--accent-blue)', borderColor: 'rgba(99,102,241,0.25)' }}
              >
                <i className="fa-solid fa-plus" style={{ marginRight: '0.35rem' }} />
                {addingClient ? 'Adding…' : 'Add Client'}
              </button>
            )}
          </div>
        </div>

        <div className="bp-page-subtitle">{rows.length} client{rows.length !== 1 ? 's' : ''}</div>

        <div className="bp-table-wrap" style={{ maxHeight: 'none', overflowY: 'visible' }}>
          {loading ? (
            <div className="bp-empty">Loading clients…</div>
          ) : filteredRows.length === 0 ? (
            <div className="bp-empty">{rows.length === 0 ? 'No clients yet.' : 'No clients match your search.'}</div>
          ) : (
            <table className="bp-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'center', width: '2rem' }}>
                    <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll} title="Select all" />
                  </th>
                  {['Client', 'Client ID', 'Stocks', 'Invested Value', 'Current Value', 'Return', ''].map((h, i) => (
                    <th key={h || i} style={{ textAlign: i === 0 || i === 1 ? 'left' : (i === 6 ? 'center' : 'right') }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(row => (
                  <tr key={row.key}>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={selectedKeys.has(row.key)} onChange={() => toggleSelect(row.key)} />
                    </td>
                    <td style={{ textAlign: 'left', fontWeight: 600, color: 'var(--text-primary)' }}>{row.label}</td>
                    <td style={{ textAlign: 'left', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{row.clientId || '—'}</td>
                    <td>{row.stockCount}</td>
                    <td>{fmtRupee(row.totalCapital)}</td>
                    <td>{fmtRupee(row.currentValue)}</td>
                    <td style={{ fontWeight: 600, color: pctColor(row.sinceInceptionPct) }}>{fmtPct(row.sinceInceptionPct)}</td>
                    <td className="bp-action-cell">
                      {userIsAdmin && (
                        <>
                          <button className="bp-row-btn bp-row-add" title="Edit client" onClick={() => openEdit(row)}>
                            <i className="fa-solid fa-pen" style={{ fontSize: '0.7em' }} />
                          </button>
                          <button className="bp-row-btn bp-row-remove" title="Delete client" onClick={() => setDeleteTarget(row)} style={{ marginLeft: '4px' }}>
                            <i className="fa-solid fa-trash-can" style={{ fontSize: '0.7em' }} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {!searchTerm && rows.length > 0 && (
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderTop: '2px solid rgba(255,255,255,0.1)' }}>
                    <td />
                    <td colSpan={2} style={{ textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', paddingRight: '0.75rem', fontSize: '0.82rem' }}>Total</td>
                    <td />
                    <td style={{ fontWeight: 700, color: 'var(--accent-blue)' }}>{fmtRupee(totalCapital)}</td>
                    <td style={{ fontWeight: 700, color: 'var(--accent-blue)' }}>{fmtRupee(totalCurrent)}</td>
                    <td colSpan={2} />
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
