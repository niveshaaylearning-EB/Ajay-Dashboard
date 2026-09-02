import { API_BASE, getAuthToken } from '../api/base.js';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { fetchBasket, fetchBaskets, fetchLiveData, saveBasket } from '../api/client.js';
import RollbackButtons from './RollbackButtons.jsx';
import ColumnFilter from './ColumnFilter.jsx';
import RebalanceUploadModal from './RebalanceUploadModal.jsx';
import HoldingsUploadModal from './HoldingsUploadModal.jsx';

const ADMIN_EMAILS = ['jay.chaudhari@niveshaay.com', 'nukul.madaan@niveshaay.com', 'nakshatra.rathi@niveshaay.com'];
const _getAdminState = () => {
  try {
    const t = getAuthToken();
    if (!t) return { email: null, isAdmin: false };
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (payload.exp && Date.now() > payload.exp * 1000) return { email: null, isAdmin: false };
    const email = (payload.sub || '').toLowerCase().trim();
    return { email, isAdmin: ADMIN_EMAILS.includes(email) };
  } catch { return { email: null, isAdmin: false }; }
};

const fmt = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const clr = (v) => v == null ? 'var(--text-secondary)' : v > 0 ? 'var(--accent-green)' : v < 0 ? 'var(--accent-red)' : 'var(--text-secondary)';

function getBpColVal(field, row) {
  switch (field) {
    case 'nseCode':       return row.nseCode || '';
    case 'securityName':  return row.securityName || '';
    case 'segment':       return row.segment || '';
    case 'allocation':    return row.allocation !== '' ? String(row.allocation) : '';
    case 'buyPrice':      return row.buyPrice != null ? String(row.buyPrice) : '';
    default:              return String(row[field] ?? '');
  }
}

const ORDINALS = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th'];
const ordinal  = n => ORDINALS[n - 1] || `${n}th`;

// Groups buy + sell events into series by tracking cumulative weight.
// A new series begins whenever cumulative weight rises from 0 → positive.
// A series closes whenever cumulative weight returns to 0.
function computeSeries(buyStr, sellStr, prevBuyStr, prevSellStr) {
  const parseLines = (str, type) =>
    (str || '').split('\n').map(s => s.trim()).filter(s => s.includes(' * ')).map(s => {
      const [d, v] = s.split(' * ');
      return { date: d.trim(), delta: parseFloat(v) || 0, type, raw: s.trim() };
    });

  const toMs = dateStr => {
    try {
      return new Date(dateStr.replace(/^(\d+) (\w+) (\d+)$/, '$2 $1, $3')).getTime();
    } catch { return 0; }
  };

  const all = [
    ...parseLines(prevBuyStr,  'buy'),
    ...parseLines(prevSellStr, 'sell'),
    ...parseLines(buyStr,      'buy'),
    ...parseLines(sellStr,     'sell'),
  ].sort((a, b) => toMs(a.date) - toMs(b.date));

  const series = [];
  let cur = null, cum = 0;

  for (const e of all) {
    if (cum <= 0.001 && e.type === 'buy') {
      cur = { buys: [], sells: [], closed: false };
      series.push(cur);
    }
    if (!cur) continue;
    if (e.type === 'buy') {
      cum = Math.round((cum + e.delta) * 1e6) / 1e6;
      cur.buys.push(e.raw);
    } else {
      cum = Math.max(0, Math.round((cum - e.delta) * 1e6) / 1e6);
      cur.sells.push(e.raw);
      if (cum <= 0.001) { cur.closed = true; cur = null; cum = 0; }
    }
  }
  return series;
}

const EventCell = ({ value, readOnly, onChange }) => {
  if (readOnly) {
    return (
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'pre-line', lineHeight: 1.6 }}>
        {value || '—'}
      </div>
    );
  }
  if (!value && !onChange) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  return (
    <textarea
      className="bp-edit-textarea"
      value={value || ''}
      onChange={onChange}
      rows={Math.max(1, (value || '').split('\n').length)}
    />
  );
};

export default function BuyPricePage() {
  const [basketKey,        setBasketKey]        = useState('');
  const [basketOptions,    setBasketOptions]    = useState([]);
  const [rows,             setRows]             = useState([]);
  const [liveData,         setLiveData]         = useState({});
  const [loading,          setLoading]          = useState(false);
  const [liveLoading,      setLiveLoading]      = useState(true);
  const [saving,           setSaving]           = useState(false);
  const [saveMsg,          setSaveMsg]          = useState('');
  const [searchTerm,       setSearchTerm]       = useState('');
  const [bpSortKey,    setBpSortKey]    = useState(null);
  const [bpSortDir,    setBpSortDir]    = useState('asc');
  const [bpColFilters, setBpColFilters] = useState({});
  const [bpOpenFilter, setBpOpenFilter] = useState(null);
  const [bpFilterPos,  setBpFilterPos]  = useState({ top: 0, left: 0 });
  const [nseSymbols,       setNseSymbols]       = useState([]);
  const [ohlcFallbacks,    setOhlcFallbacks]    = useState({});
  const [fallbackDismissed,setFallbackDismissed]= useState(false);
  const [undoCount,      setUndoCount]      = useState(0);
  const stocksRef   = useRef([]);
  const [rebalancePreview,   setRebalancePreview]   = useState(null);
  const [uploadingRebalance, setUploadingRebalance] = useState(false);
  const [lastRebalanceFile, setLastRebalanceFile]   = useState(null);
  const rebalanceFileRef = useRef(null);
  const [holdingsPreview,   setHoldingsPreview]   = useState(null);
  const [uploadingHoldings, setUploadingHoldings] = useState(false);
  const holdingsFileRef = useRef(null);
  const { isAdmin: userIsAdmin } = _getAdminState();


  useEffect(() => {
    fetch(`${API_BASE}/nse-symbols`)
      .then(r => r.json())
      .then(setNseSymbols)
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchBaskets().then(dict => setBasketOptions(Object.entries(dict || {}).map(([key, label]) => ({ key, label })))).catch(() => {});
  }, []);
  useEffect(() => {
    if (!basketKey && basketOptions.length > 0) setBasketKey(basketOptions[0].key);
  }, [basketKey, basketOptions]);

  // Fetch OHLC fallback info whenever the basket changes
  useEffect(() => {
    setOhlcFallbacks({});
    setFallbackDismissed(false);
    fetch(`${API_BASE}/ohlc-fallbacks/${basketKey}`)
      .then(r => r.json())
      .then(setOhlcFallbacks)
      .catch(() => {});
  }, [basketKey]);

  // Name of the most recently uploaded rebalance file for this basket
  const refreshLastRebalanceFile = () => {
    fetch(`${API_BASE}/last-rebalance-file/${basketKey}`)
      .then(r => r.json())
      .then(d => setLastRebalanceFile(d.filename || null))
      .catch(() => setLastRebalanceFile(null));
  };
  useEffect(() => {
    setLastRebalanceFile(null);
    refreshLastRebalanceFile();
  }, [basketKey]);

  const refreshUndoCount = () => {
    fetch(`${API_BASE}/undo-count/${basketKey}`)
      .then(r => r.json())
      .then(d => setUndoCount(d.count || 0))
      .catch(() => {});
  };

  const autoSave = async (rowsToSave) => {
    setSaving(true);
    setSaveMsg('Saving…');
    try {
      const buyPriceDetails = {};
      rowsToSave.forEach(r => {
        if (!r.nseCode) return;
        buyPriceDetails[r.nseCode] = {
          securityName:   r.securityName,
          segment:        r.segment,
          buyEvents:      r.buyEvents,
          sellEvents:     r.sellEvents     || '',
          prevBuyEvents:  r.prevBuyEvents  || '',
          prevSellEvents: r.prevSellEvents || '',
        };
      });
      const updatedStocks = stocksRef.current.map(s => {
        const row = rowsToSave.find(r => r.nseCode === s.nseCode);
        if (!row) return s;
        const pct = parseFloat(row.allocation);
        return { ...s, allocation: isNaN(pct) ? s.allocation : pct / 100 };
      });
      rowsToSave.forEach(r => {
        if (!r.nseCode) return;
        if (!updatedStocks.find(s => s.nseCode === r.nseCode)) {
          const pct = parseFloat(r.allocation);
          updatedStocks.push({ nseCode: r.nseCode, allocation: isNaN(pct) ? 0 : pct / 100 });
        }
      });
      await saveBasket(basketKey, updatedStocks, undefined, buyPriceDetails);
      stocksRef.current = updatedStocks;
      refreshUndoCount();
      setSaveMsg('Saved!');
      setTimeout(() => setSaveMsg(''), 2000);
      return true;
    } catch {
      setSaveMsg('Save failed.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleUndo = async () => {
    if (undoCount === 0) return;
    setSaving(true);
    setSaveMsg('Undoing…');
    try {
      const undoToken = getAuthToken();
      const resp = await fetch(`${API_BASE}/undo/${basketKey}`, {
        method: 'POST',
        headers: undoToken ? { Authorization: `Bearer ${undoToken}` } : {},
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || 'Undo failed');
      setUndoCount(data.remainingUndos);
      setLoading(true);
      const fresh = await fetch(`${API_BASE}/basket/${basketKey}`).then(r => r.json());
      const details = fresh.buyPriceDetails || {};
      const stocks  = fresh.stocks || [];
      stocksRef.current = stocks;
      const stockMap = {};
      stocks.forEach(s => { stockMap[s.nseCode] = s; });
      const allKeys = new Set(stocks.filter(s => (s.allocation || 0) > 0).map(s => s.nseCode));
      setRows([...allKeys].map(nse => {
        const det = details[nse] || {};
        const stk = stockMap[nse] || {};
        return {
          nseCode: nse, securityName: det.securityName || '',
          segment: det.segment || '',
          allocation: stk.allocation != null ? (stk.allocation * 100).toFixed(2) : '',
          buyEvents: det.buyEvents || '', sellEvents: det.sellEvents || '',
          prevBuyEvents: det.prevBuyEvents || '', prevSellEvents: det.prevSellEvents || '',
          buyPrice: stk.buyPrice || null,
        };
      }));
      setSaveMsg('Undone!');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (err) {
      setSaveMsg('Undo failed: ' + err.message);
    } finally {
      setSaving(false);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLiveData()
      .then(setLiveData)
      .catch(() => {})
      .finally(() => setLiveLoading(false));
  }, []);

  useEffect(() => { refreshUndoCount(); }, [basketKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    setRows([]);
    fetchBasket(basketKey)
      .then(d => {
        const details = d.buyPriceDetails || {};
        const stocks  = d.stocks || [];
        stocksRef.current = stocks;

        const stockMap = {};
        stocks.forEach(s => { stockMap[s.nseCode] = s; });

        const allKeys = new Set(stocks.filter(s => (s.allocation || 0) > 0).map(s => s.nseCode));

        const built = [...allKeys].map(nse => {
          const det = details[nse] || {};
          const stk = stockMap[nse] || {};
          return {
            nseCode:        nse,
            securityName:   det.securityName   || '',
            segment:        det.segment        || '',
            allocation:     stk.allocation != null ? (stk.allocation * 100).toFixed(2) : '',
            buyEvents:      det.buyEvents      || '',
            sellEvents:     det.sellEvents     || '',
            prevBuyEvents:  det.prevBuyEvents  || '',
            prevSellEvents: det.prevSellEvents || '',
            buyPrice:       stk.buyPrice       || null,
          };
        });

        setRows(built);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [basketKey]);

  const updateRow = (idx, field, value) => {
    setRows(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const handleNseChange = (idx, value) => {
    setRows(prev => {
      const next = [...prev];
      const upper = value.trim().toUpperCase();
      const match = nseSymbols.find(s => s.symbol === upper);
      next[idx] = {
        ...next[idx],
        nseCode: value,
        ...(match ? { securityName: match.name || '' } : {}),
      };
      return next;
    });
  };


  const exportBuyPriceXlsx = () => {
    const basketLabel = basketOptions.find(o => o.key === basketKey)?.label || basketKey;

    // ── Sheet 1: Holdings Summary ──────────────────────────────────────────
    const holdingsHeader = [
      'NSE Code', 'Security Name', 'Segment', 'Weight (%)',
      'Wtd. Avg Buy Price (₹)', 'Current Market Price (₹)', 'Return (%)',
    ];
    const holdingsData = rows.map(r => {
      const cmp = liveData[r.nseCode]?.cmp ?? null;
      const ret = (cmp != null && r.buyPrice != null && r.buyPrice > 0)
        ? +((cmp - r.buyPrice) / r.buyPrice * 100).toFixed(2)
        : '';
      return [
        r.nseCode,
        r.securityName || '',
        r.segment || '',
        r.allocation !== '' ? parseFloat(r.allocation) || '' : '',
        r.buyPrice != null ? r.buyPrice : '',
        cmp != null ? cmp : '',
        ret,
      ];
    });
    const ws1 = XLSX.utils.aoa_to_sheet([holdingsHeader, ...holdingsData]);
    ws1['!cols'] = [12, 30, 16, 10, 20, 20, 12].map(w => ({ wch: w }));

    // ── Sheet 2: Buy & Sell Event History ─────────────────────────────────
    const eventsHeader = [
      'NSE Code', 'Security Name', 'Cycle', 'Cycle Status',
      'Event Type', 'Date', 'Weight (%)',
    ];
    const eventsData = [];
    for (const row of rows) {
      const series = computeSeries(row.buyEvents, row.sellEvents, row.prevBuyEvents, row.prevSellEvents);
      for (const [si, s] of series.entries()) {
        const cycleLabel = `${ordinal(si + 1)} Cycle`;
        const status = s.closed ? 'Closed' : 'Active';
        for (const line of s.buys) {
          const parts = line.split(' * ');
          eventsData.push([row.nseCode, row.securityName || '', cycleLabel, status, 'Buy', parts[0]?.trim() || '', parseFloat(parts[1]) || '']);
        }
        for (const line of s.sells) {
          const parts = line.split(' * ');
          eventsData.push([row.nseCode, row.securityName || '', cycleLabel, status, 'Sell', parts[0]?.trim() || '', parseFloat(parts[1]) || '']);
        }
      }
    }
    const ws2 = XLSX.utils.aoa_to_sheet([eventsHeader, ...eventsData]);
    ws2['!cols'] = [12, 30, 14, 12, 12, 16, 12].map(w => ({ wch: w }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Holdings');
    XLSX.utils.book_append_sheet(wb, ws2, 'Event History');
    XLSX.writeFile(wb, `BuyPriceData_${basketKey}.xlsx`);
  };

  const label = basketOptions.find(o => o.key === basketKey)?.label || basketKey;

  const [historyRow,  setHistoryRow]  = useState(null);
  const [historyEdits, setHistoryEdits] = useState({ buyText: '', sellText: '' });

  const openHistory = (row, series, rowIdx) => {
    const activeSeries = series.length > 0 ? series[series.length - 1] : null;
    const isOpen = activeSeries && !activeSeries.closed;
    setHistoryEdits({
      buyText:  isOpen ? activeSeries.buys.join('\n')  : '',
      sellText: isOpen ? activeSeries.sells.join('\n') : '',
    });
    setHistoryRow({ ...row, series, rowIdx });
  };

  const handleHistorySave = async () => {
    const { rowIdx, buyEvents, sellEvents, series } = historyRow;
    const activeSeries = series[series.length - 1];
    const buysSet  = new Set(activeSeries.buys.map(l => l.trim()));
    const sellsSet = new Set(activeSeries.sells.map(l => l.trim()));
    const buyPrefix  = (buyEvents  || '').split('\n').filter(l => l.trim() && !buysSet.has(l.trim()));
    const sellPrefix = (sellEvents || '').split('\n').filter(l => l.trim() && !sellsSet.has(l.trim()));
    const newBuyEvents  = [...buyPrefix,  ...historyEdits.buyText.split('\n').filter(l => l.trim())].join('\n');
    const newSellEvents = [...sellPrefix, ...historyEdits.sellText.split('\n').filter(l => l.trim())].join('\n');
    const updatedRows = rows.map((r, i) =>
      i === rowIdx ? { ...r, buyEvents: newBuyEvents, sellEvents: newSellEvents } : r
    );
    setRows(updatedRows);
    setHistoryRow(null);
    await autoSave(updatedRows);
  };

  const handleRebalanceUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadingRebalance(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('basket', basketKey);
      const token = getAuthToken();
      const resp = await fetch(`${API_BASE}/preview-rebalance`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(Array.isArray(data.detail) ? data.detail.map(d => d.msg || JSON.stringify(d)).join('; ') : String(data.detail || 'Upload failed'));
      if (data.duplicate) {
        alert(data.message || 'No new rebalance data found in this file.');
        return;
      }
      setRebalancePreview(data);
    } catch (err) {
      alert('Rebalance upload failed: ' + err.message);
    } finally {
      setUploadingRebalance(false);
    }
  };

  const handleRebalanceConfirmed = () => {
    setRebalancePreview(null);
    setSaveMsg('Rebalance applied!');
    setTimeout(() => setSaveMsg(''), 3000);
    refreshLastRebalanceFile();
    setLoading(true);
    fetchBasket(basketKey)
      .then(d => {
        const details = d.buyPriceDetails || {};
        const stocks  = d.stocks || [];
        stocksRef.current = stocks;
        const stockMap = {};
        stocks.forEach(s => { stockMap[s.nseCode] = s; });
        const allKeys = new Set(stocks.filter(s => (s.allocation || 0) > 0).map(s => s.nseCode));
        setRows([...allKeys].map(nse => {
          const det = details[nse] || {};
          const stk = stockMap[nse] || {};
          return {
            nseCode: nse, securityName: det.securityName || '',
            segment: det.segment || '',
            allocation: stk.allocation != null ? (stk.allocation * 100).toFixed(2) : '',
            buyEvents: det.buyEvents || '', sellEvents: det.sellEvents || '',
            prevBuyEvents: det.prevBuyEvents || '', prevSellEvents: det.prevSellEvents || '',
            buyPrice: stk.buyPrice || null,
          };
        }));
        refreshUndoCount();
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleHoldingsUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadingHoldings(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const token = getAuthToken();
      const resp = await fetch(`${API_BASE}/preview-holdings-upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(Array.isArray(data.detail) ? data.detail.map(d => d.msg || JSON.stringify(d)).join('; ') : String(data.detail || 'Upload failed'));
      setHoldingsPreview(data);
    } catch (err) {
      alert('Holdings upload failed: ' + err.message);
    } finally {
      setUploadingHoldings(false);
    }
  };

  const handleHoldingsConfirmed = (data) => {
    setHoldingsPreview(null);
    setSaveMsg(`Holdings uploaded to ${data.basketLabel}!`);
    setTimeout(() => setSaveMsg(''), 3000);
    // A new client may have just been created by this upload -- refresh the
    // basket dropdown so it (and its display name) shows up immediately.
    fetchBaskets().then(dict => setBasketOptions(Object.entries(dict || {}).map(([key, label]) => ({ key, label })))).catch(() => {});
    setBasketKey(data.basketKey);
    setLoading(true);
    fetchBasket(data.basketKey)
      .then(d => {
        const details = d.buyPriceDetails || {};
        const stocks  = d.stocks || [];
        stocksRef.current = stocks;
        const stockMap = {};
        stocks.forEach(s => { stockMap[s.nseCode] = s; });
        const allKeys = new Set(stocks.filter(s => (s.allocation || 0) > 0).map(s => s.nseCode));
        setRows([...allKeys].map(nse => {
          const det = details[nse] || {};
          const stk = stockMap[nse] || {};
          return {
            nseCode: nse, securityName: det.securityName || '',
            segment: det.segment || '',
            allocation: stk.allocation != null ? (stk.allocation * 100).toFixed(2) : '',
            buyEvents: det.buyEvents || '', sellEvents: det.sellEvents || '',
            prevBuyEvents: det.prevBuyEvents || '', prevSellEvents: det.prevSellEvents || '',
            buyPrice: stk.buyPrice || null,
          };
        }));
        refreshUndoCount();
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const handleBpFilterOpen = (col, e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setBpFilterPos({ top: rect.bottom, left: rect.left });
    setBpOpenFilter(prev => prev === col ? null : col);
  };
  const handleBpSort = (col, dir) => { setBpSortKey(col); setBpSortDir(dir); };
  const handleBpFilter = (col, vals) => {
    setBpColFilters(prev => {
      const next = { ...prev };
      if (vals === null) delete next[col]; else next[col] = vals;
      return next;
    });
  };

  const filteredRows = useMemo(() => {
    let result = rows.filter(r =>
      !searchTerm || r.nseCode.toLowerCase().includes(searchTerm.toLowerCase())
    );
    for (const [field, values] of Object.entries(bpColFilters)) {
      if (!values) continue;
      if (values.size === 0) { result = []; break; }
      result = result.filter(r => values.has(getBpColVal(field, r)));
    }
    if (bpSortKey) {
      result = [...result].sort((a, b) => {
        const d = bpSortDir === 'asc' ? 1 : -1;
        if (bpSortKey === 'nseCode' || bpSortKey === 'securityName' || bpSortKey === 'segment')
          return d * (a[bpSortKey] || '').localeCompare(b[bpSortKey] || '');
        const va = parseFloat(a[bpSortKey]);
        const vb = parseFloat(b[bpSortKey]);
        return d * ((isNaN(va) ? -Infinity : va) - (isNaN(vb) ? -Infinity : vb));
      });
    }
    return result;
  }, [rows, searchTerm, bpColFilters, bpSortKey, bpSortDir]);

  return (
    <>
    {rebalancePreview && (
      <RebalanceUploadModal
        previewData={rebalancePreview}
        onClose={() => setRebalancePreview(null)}
        onConfirmed={handleRebalanceConfirmed}
      />
    )}
    {holdingsPreview && (
      <HoldingsUploadModal
        previewData={holdingsPreview}
        basketOptions={basketOptions}
        onClose={() => setHoldingsPreview(null)}
        onConfirmed={handleHoldingsConfirmed}
      />
    )}
    {historyRow && (
      <div
        onClick={() => setHistoryRow(null)}
        style={{ position: 'fixed', inset: 0, background: 'var(--modal-overlay-bg)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ background: 'var(--modal-bg)', border: '1px solid var(--panel-border-hover)', borderRadius: '12px', padding: '1.5rem', minWidth: '500px', maxWidth: '680px', maxHeight: '80vh', overflowY: 'auto' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.2rem' }}>
            <div>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '1rem' }}>{historyRow.nseCode}</span>
              <span style={{ color: 'var(--text-secondary)', marginLeft: '0.6rem', fontSize: '0.88rem' }}>{historyRow.securityName}</span>
            </div>
            <button onClick={() => setHistoryRow(null)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1.3rem', lineHeight: 1, padding: 0 }}>&times;</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            {historyRow.series.map((s, i) => (
              <div key={i} style={{ background: 'var(--input-bg)', borderRadius: '8px', padding: '0.8rem 1rem', border: '1px solid ' + (s.closed ? '#1e3a5f' : '#1e4d3a') }}>
                <div style={{ fontWeight: 600, color: 'var(--accent-blue)', fontSize: '0.8rem', marginBottom: '0.55rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  {ordinal(i + 1)} Buy-Sell Cycle
                  <span style={{ fontWeight: 400, fontSize: '0.72rem', color: s.closed ? 'var(--text-secondary)' : 'var(--accent-green)', background: s.closed ? 'var(--hover-bg)' : 'rgba(16,185,129,0.12)', borderRadius: '4px', padding: '1px 6px' }}>
                    {s.closed ? 'Closed' : 'Active'}
                  </span>
                </div>
                {s.closed ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Buy Events</div>
                      <div style={{ color: 'var(--accent-green)', fontSize: '0.82rem', whiteSpace: 'pre-line', lineHeight: 1.75 }}>{s.buys.join('\n') || '—'}</div>
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sell Events</div>
                      <div style={{ color: 'var(--accent-red)', fontSize: '0.82rem', whiteSpace: 'pre-line', lineHeight: 1.75 }}>{s.sells.join('\n') || '—'}</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Buy Events</div>
                      <textarea
                        className="bp-edit-textarea"
                        value={historyEdits.buyText}
                        onChange={e => setHistoryEdits(prev => ({ ...prev, buyText: e.target.value }))}
                        rows={Math.max(2, historyEdits.buyText.split('\n').filter(l => l.trim()).length + 1)}
                        disabled={!userIsAdmin}
                        style={{ width: '100%', boxSizing: 'border-box', color: 'var(--accent-green)' }}
                      />
                    </div>
                    <div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sell Events</div>
                      <textarea
                        className="bp-edit-textarea"
                        value={historyEdits.sellText}
                        onChange={e => setHistoryEdits(prev => ({ ...prev, sellText: e.target.value }))}
                        rows={Math.max(2, historyEdits.sellText.split('\n').filter(l => l.trim()).length + 1)}
                        disabled={!userIsAdmin}
                        style={{ width: '100%', boxSizing: 'border-box', color: 'var(--accent-red)' }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: '1.2rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
            {userIsAdmin && historyRow.series.some(s => !s.closed) && (
              <button
                onClick={handleHistorySave}
                style={{ padding: '0.4rem 1rem', borderRadius: '6px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(99,102,241,0.4)', background: 'rgba(99,102,241,0.15)', color: 'var(--accent-blue)' }}
              >
                Save Changes
              </button>
            )}
            <button
              onClick={() => setHistoryRow(null)}
              style={{ padding: '0.4rem 1rem', borderRadius: '6px', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'var(--hover-bg)', color: 'var(--text-secondary)' }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
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
            <i className="fa-solid fa-receipt" style={{ color: 'var(--accent-blue)', marginRight: '0.6rem' }} />
            Buy Price Data
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div className="search-wrapper">
            <i className="fa-solid fa-magnifying-glass search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="Find stock…"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button className="search-clear" onClick={() => setSearchTerm('')} title="Clear search">
                <i className="fa-solid fa-xmark" />
              </button>
            )}
          </div>
          <select
            className="bp-page-select"
            value={basketKey}
            onChange={e => setBasketKey(e.target.value)}
          >
            {basketOptions.map(o => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          {userIsAdmin && (
            <button
              className="bp-save-btn"
              onClick={handleUndo}
              disabled={undoCount === 0 || saving}
              title={`Undo last action (${undoCount}/10 available)`}
              style={{ background: 'rgba(251,191,36,0.1)', color: undoCount === 0 ? 'var(--text-secondary)' : 'var(--accent-amber)', borderColor: 'rgba(251,191,36,0.25)' }}
            >
              <i className="fa-solid fa-rotate-left" style={{ marginRight: '0.35rem' }} />
              Undo {undoCount > 0 ? `(${undoCount})` : ''}
            </button>
          )}
          {saveMsg && <span className="bp-save-msg">{saveMsg}</span>}

          <button
            className="bp-save-btn"
            onClick={exportBuyPriceXlsx}
            disabled={rows.length === 0}
            title="Export buy price data to Excel"
            style={{ background: 'rgba(16,185,129,0.1)', color: rows.length === 0 ? 'var(--text-secondary)' : 'var(--accent-green)', borderColor: 'rgba(16,185,129,0.25)' }}
          >
            <i className="fa-solid fa-file-arrow-down" style={{ marginRight: '0.35rem' }} />
            Export Excel
          </button>

          {userIsAdmin && (
            <button
              className="bp-save-btn"
              title="Rebuild sold records from event log — fixes wrong weights, actions, and duplicates"
              onClick={() => {
                if (!window.confirm(`Rebuild sold records for ${basketOptions.find(o => o.key === basketKey)?.label}?\nThis will correct wrong weights, actions, and remove duplicates.`)) return;
                const token = getAuthToken();
                fetch(`${API_BASE}/rebuild-sold/${basketKey}`, {
                  method: 'POST',
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                })
                  .then(r => r.json())
                  .then(d => alert(`Done. ${d.recordCount} records rebuilt. Refresh the dashboard to see updated data.`))
                  .catch(() => alert('Rebuild failed.'));
              }}
              style={{ background: 'rgba(239,68,68,0.08)', color: 'var(--accent-red)', borderColor: 'rgba(239,68,68,0.25)', fontSize: '0.76rem' }}
            >
              <i className="fa-solid fa-wrench" style={{ marginRight: '0.35rem' }} />
              Fix Sold Records
            </button>
          )}

          {userIsAdmin && <RollbackButtons btnStyle="bp" />}

          {userIsAdmin && (
            <>
              <input
                ref={rebalanceFileRef}
                type="file"
                accept=".xlsx,.xls"
                style={{ display: 'none' }}
                onChange={handleRebalanceUpload}
              />
              <button
                className="bp-save-btn"
                onClick={() => rebalanceFileRef.current?.click()}
                disabled={uploadingRebalance}
                title="Upload rebalance Excel to update buy/sell events and weights (Admin only)"
                style={{ background: 'rgba(99,102,241,0.1)', color: uploadingRebalance ? 'var(--text-secondary)' : 'var(--accent-blue)', borderColor: 'rgba(99,102,241,0.25)' }}
              >
                <i className={`fa-solid ${uploadingRebalance ? 'fa-spinner fa-spin' : 'fa-upload'}`} style={{ marginRight: '0.35rem' }} />
                {uploadingRebalance ? 'Uploading…' : 'Upload Rebalance'}
              </button>

              <input
                ref={holdingsFileRef}
                type="file"
                accept=".xlsx,.xls"
                style={{ display: 'none' }}
                onChange={handleHoldingsUpload}
              />
              <button
                className="bp-save-btn"
                onClick={() => holdingsFileRef.current?.click()}
                disabled={uploadingHoldings}
                title="Upload a broker holdings statement (.xlsx) — matched to a client by the Client ID inside the file (Admin only)"
                style={{ background: 'rgba(16,185,129,0.1)', color: uploadingHoldings ? 'var(--text-secondary)' : 'var(--accent-green)', borderColor: 'rgba(16,185,129,0.25)' }}
              >
                <i className={`fa-solid ${uploadingHoldings ? 'fa-spinner fa-spin' : 'fa-file-import'}`} style={{ marginRight: '0.35rem' }} />
                {uploadingHoldings ? 'Uploading…' : 'Upload Holdings'}
              </button>
            </>
          )}

        </div>
      </div>

      <div className="bp-page-subtitle" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        {label}
        {lastRebalanceFile && (
          <span
            title="Most recently uploaded rebalance file for this basket"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
              fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-secondary)',
              background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.2)',
              borderRadius: '999px', padding: '0.15rem 0.65rem',
            }}
          >
            <i className="fa-solid fa-file-excel" style={{ color: 'var(--accent-blue)' }} />
            {lastRebalanceFile}
          </span>
        )}
      </div>

      {/* OHLC Fallback Banner */}
      {!fallbackDismissed && Object.keys(ohlcFallbacks).length > 0 && (
        <div style={{
          margin: '0.5rem 0 0.75rem',
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          background: 'rgba(251,191,36,0.08)',
          border: '1px solid rgba(251,191,36,0.3)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
          fontSize: '0.82rem',
        }}>
          <i className="fa-solid fa-triangle-exclamation" style={{ color: 'var(--accent-amber)', marginTop: '0.1rem', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <strong style={{ color: 'var(--accent-amber)' }}>Next-Trading-Day Prices Used</strong>
            <div style={{ color: 'var(--text-secondary)', marginTop: '0.3rem', lineHeight: 1.6 }}>
              {Object.entries(ohlcFallbacks).map(([nse, info]) => {
                const parts = [
                  ...Object.entries(info.buyFallbacks || {}).map(([req, act]) => `Buy ${req} → ${act}`),
                  ...Object.entries(info.sellFallbacks || {}).map(([req, act]) => `Sell ${req} → ${act}`),
                ];
                return parts.length > 0 ? (
                  <div key={nse}>
                    <strong style={{ color: 'var(--text-primary)' }}>{nse}</strong>
                    {info.securityName ? ` (${info.securityName})` : ''}{': '}
                    {parts.join(', ')}
                  </div>
                ) : null;
              })}
            </div>
          </div>
          <button
            onClick={() => setFallbackDismissed(true)}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '1rem', padding: '0', flexShrink: 0 }}
            title="Dismiss"
          >&times;</button>
        </div>
      )}

      <div className="bp-table-wrap" style={{ maxHeight: 'none', overflowY: 'visible' }}>
        {loading ? (
          <div className="bp-empty">Loading basket data…</div>
        ) : rows.length === 0 ? (
          <div className="bp-empty">No buy price data available for this basket.</div>
        ) : (
          <table className="bp-table">
            <colgroup>
              <col style={{ width: '10%' }} />
              <col style={{ width: '26%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '6%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '4%' }} />
            </colgroup>
            <thead>
              <tr>
                {[
                  ['nseCode',      'NSE Ticker',    false],
                  ['securityName', 'Security Name', false],
                  ['segment',      'Segment',       false],
                  ['allocation',   'Weight (%)',    true],
                  ['buyPrice',     'Wtd. Avg Price',true],
                  [null,           'Mkt Price',     true],
                  [null,           'Return (%)',    true],
                  [null,           '',              false],
                ].map(([col, label, right], i) => {
                  if (!col || !label) return <th key={i} style={{ textAlign: right ? 'right' : 'left' }}>{label}</th>;
                  const isFiltered = bpColFilters[col] != null;
                  const isSorted   = bpSortKey === col;
                  return (
                    <th key={col} style={{ textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap', userSelect: 'none' }}>
                      <div className="cf-th-inner" style={{ justifyContent: right ? 'flex-end' : 'flex-start' }}>
                        <span onClick={() => { setBpSortKey(col); setBpSortDir(d => bpSortKey === col && d === 'asc' ? 'desc' : 'asc'); }} style={{ cursor: 'pointer' }}>{label}</span>
                        <span style={{ fontSize: '0.6em', color: isSorted ? 'var(--accent-blue)' : '#3a4f6a' }}>
                          {isSorted ? (bpSortDir === 'asc' ? '▲' : '▼') : '⇅'}
                        </span>
                        <button className={`cf-trigger${isFiltered ? ' on' : ''}`}
                          onClick={e => handleBpFilterOpen(col, e)} title="Filter">▾</button>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, idx) => {
                const idx_orig = rows.indexOf(row);
                const live = liveData[row.nseCode];
                const cmp  = live?.cmp ?? null;
                const ret  = (cmp != null && row.buyPrice != null && row.buyPrice !== 0)
                  ? (cmp - row.buyPrice) / row.buyPrice
                  : null;

                const series = computeSeries(row.buyEvents, row.sellEvents, row.prevBuyEvents, row.prevSellEvents);

                return (
                  <tr key={row.nseCode || idx}>
                    <td style={{ overflow: 'visible' }}>
                      <input
                        className="bp-edit-input"
                        value={row.nseCode}
                        onChange={e => handleNseChange(idx_orig, e.target.value)}
                        onBlur={e => handleNseChange(idx_orig, e.target.value.trim().toUpperCase())}
                        disabled={!userIsAdmin}
                        style={{ fontWeight: 600, color: 'var(--text-primary)', width: '8rem' }}
                      />
                    </td>
                    <td style={{ textAlign: 'left' }}>
                      <span style={{ color: 'var(--text-primary)' }}>{row.securityName || '—'}</span>
                      <button
                        onClick={() => openHistory(row, series, idx_orig)}
                        title="View / edit buy & sell events"
                        style={{ marginLeft: '0.4rem', background: 'none', border: '1px solid #475569', borderRadius: '3px', color: 'var(--text-secondary)', fontSize: '0.65rem', cursor: 'pointer', padding: '1px 4px', lineHeight: 1.3, fontWeight: 600, letterSpacing: '0.02em' }}
                      >H</button>
                    </td>
                    <td>
                      <input
                        className="bp-edit-input"
                        value={row.segment}
                        onChange={e => updateRow(idx_orig, 'segment', e.target.value)}
                        disabled={!userIsAdmin}
                        style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', width: '7rem' }}
                      />
                    </td>
                    <td>
                      <input
                        className="bp-edit-input"
                        value={row.allocation}
                        onChange={e => updateRow(idx_orig, 'allocation', e.target.value)}
                        disabled={!userIsAdmin}
                        style={{ width: '4.5rem', textAlign: 'right' }}
                        placeholder="0.00"
                      />
                    </td>


                    <td>{fmt(row.buyPrice)}</td>
                    <td>
                      {liveLoading
                        ? <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>Loading…</span>
                        : fmt(cmp)}
                    </td>
                    <td style={{ fontWeight: 600, color: clr(ret) }}>
                      {ret != null ? (ret * 100).toFixed(2) + '%' : '—'}
                    </td>
                    <td className="bp-action-cell">
                      {userIsAdmin && (
                        <>
                          <button
                            className="bp-row-btn bp-row-add"
                            title="Add stock below"
                            onClick={() => { setRows(prev => { const next = [...prev]; next.splice(idx_orig + 1, 0, { nseCode: '', securityName: '', segment: '', allocation: '', buyEvents: '', sellEvents: '', prevBuyEvents: '', prevSellEvents: '', buyPrice: null }); return next; }); }}
                          >+</button>
                          <button
                            className="bp-row-btn bp-row-remove"
                            title="Remove this stock"
                            onClick={() => { setRows(prev => prev.filter((_, i) => i !== idx_orig)); }}
                            style={{ marginLeft: '4px' }}
                          >−</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {/* Total weight summary row */}
              {!searchTerm && (() => {
                const totalW = rows.reduce((s, r) => {
                  const p = parseFloat(r.allocation);
                  return s + (isNaN(p) ? 0 : p);
                }, 0);
                return (
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderTop: '2px solid rgba(255,255,255,0.1)' }}>
                    <td colSpan={3} style={{ textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)', paddingRight: '0.75rem', fontSize: '0.82rem' }}>
                      Total Weight
                    </td>
                    <td style={{ fontWeight: 700, color: 'var(--accent-blue)', fontSize: '0.88rem' }}>
                      {totalW.toFixed(2)}%
                    </td>
                    <td colSpan={4} />
                  </tr>
                );
              })()}
            </tbody>
          </table>
        )}
      </div>
    </div>
    {bpOpenFilter && (
      <ColumnFilter
        rows={rows}
        getValue={r => getBpColVal(bpOpenFilter, r)}
        activeValues={bpColFilters[bpOpenFilter] ?? null}
        isSorted={bpSortKey === bpOpenFilter}
        sortDir={bpSortDir}
        onSort={dir => handleBpSort(bpOpenFilter, dir)}
        onFilter={vals => handleBpFilter(bpOpenFilter, vals)}
        onClose={() => setBpOpenFilter(null)}
        top={bpFilterPos.top}
        left={bpFilterPos.left}
      />
    )}
    </>
  );
}
