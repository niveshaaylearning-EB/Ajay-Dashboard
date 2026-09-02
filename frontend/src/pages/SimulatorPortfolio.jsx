import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { Download, Plus, Edit2, RotateCcw, X, Target, Filter, ArrowLeft } from 'lucide-react';
import AutoCompleteInput from '../components/AutoCompleteInput';
import HistoricComparison from '../components/HistoricComparison';

import { API_BASE } from '../config.js';

function SimulatorPortfolio() {
  const [loading, setLoading] = useState(true);
  const [holdings, setHoldings] = useState([]);
  const [sips, setSips] = useState([]);
  const [simReturnData, setSimReturnData] = useState(null);
  const [calculatingReturn, setCalculatingReturn] = useState(false);
  const [sipModalOpen, setSipModalOpen] = useState(false);
  const [newSip, setNewSip] = useState({ sip_date: '', amount: 0 });
  const [sipExpandedIdx, setSipExpandedIdx] = useState(null);

  // Sorting & Filtering
  const [filters, setFilters] = useState({ code: '', performance: '' });
  const [sortConfig, setSortConfig] = useState({ key: 'performance', direction: 'desc' });
  const [showFilters, setShowFilters] = useState(false);

  // Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editMod, setEditMod] = useState(null);
  const [modalDate, setModalDate] = useState('');
  const [allocationError, setAllocationError] = useState('');
  const [histRefreshKey, setHistRefreshKey] = useState(0);
  const [fetchingPrice, setFetchingPrice] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Base/initial investment -- per-user, persisted server-side, Rs 10L by default.
  const [baseInvestment, setBaseInvestment] = useState(1000000);
  const [editingBase, setEditingBase] = useState(false);
  const [baseInput, setBaseInput] = useState('');
  const [savingBase, setSavingBase] = useState(false);

  // Add/Edit modal: let the user enter either an allocation % directly, or a
  // rupee investment amount that gets converted to the equivalent allocation
  // % against their chosen base investment (baseInvestment).
  const [investInputMode, setInvestInputMode] = useState('pct'); // 'pct' | 'value'
  const [investValueInput, setInvestValueInput] = useState('');

  // Universal confirmation dialog
  const [confirmDialog, setConfirmDialog] = useState({
    open: false, title: '', message: '', confirmText: 'Confirm',
    confirmStyle: {}, onConfirm: null, working: false,
  });

  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      setLoading(true);
      await fetchHoldings();
      setLoading(false);
    })();
  }, []);

  const fetchHoldings = async () => {
    try {
      const [holdingsRes, sipsRes, settingsRes] = await Promise.all([
        axios.get(`${API_BASE}/simulator`),
        axios.get(`${API_BASE}/simulator/sips`),
        axios.get(`${API_BASE}/simulator/settings`),
      ]);
      setHoldings(holdingsRes.data || []);
      setSips(sipsRes.data || []);
      setBaseInvestment(settingsRes.data?.initial_investment ?? 1000000);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveBaseInvestment = async () => {
    const parsed = parseFloat(baseInput);
    if (!parsed || parsed <= 0) return;
    setSavingBase(true);
    try {
      await axios.post(`${API_BASE}/simulator/settings`, { initial_investment: parsed });
      setBaseInvestment(parsed);
      setEditingBase(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSavingBase(false);
    }
  };

  const handleExportExcel = async () => {
    setExportModalOpen(false);
    try {
      let historicData = {};
      try {
        const hRes = await axios.get(`${API_BASE}/simulator/historic`);
        historicData = hRes.data || {};
      } catch (_) {}

      const _simRetVal = simReturnData ? simReturnData.absolute_return : simulatedPortfolio.portfolio_return;
      const payload = {
        sim_return: _simRetVal,
        holdings:   simulatedPortfolio.holdings,
        historic:   historicData,
      };
      const res = await axios.post(`${API_BASE}/download/simulator-full`, payload, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'My_Virtual_Portfolio_Simulated.xlsx');
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (e) {
      console.error('Download failed', e);
    }
  };

  const handleExportPDF = () => {
    setExportModalOpen(false);
    setTimeout(() => window.print(), 150);
  };

  const saveMod = async () => {
    try {
      const buyDate = editMod.override_type === 'add' ? (modalDate || null) : (editMod.buy_date ?? null);
      await axios.post(`${API_BASE}/simulator`, {
        stock_code: editMod.stock_code,
        allocation: editMod.allocation,
        buy_price:  editMod.buy_price,
        buy_date:   buyDate,
        cmp:        editMod.cmp,
      });
      setModalOpen(false);
      fetchHoldings();
      setHistRefreshKey(k => k + 1);
    } catch(e) {
      console.error(e);
    }
  };

  const resetMods = async () => {
    try {
      await axios.post(`${API_BASE}/simulator/reset`);
      fetchHoldings();
      setHistRefreshKey(k => k + 1);
    } catch (e) {
      console.error(e);
    }
  };

  const saveSip = async () => {
    if (!newSip.sip_date || newSip.amount <= 0) return;
    try {
      await axios.post(`${API_BASE}/simulator/sips`, newSip);
      setSipModalOpen(false);
      setNewSip({ sip_date: '', amount: 0 });
      fetchHoldings();
    } catch (e) { console.error(e); }
  };

  const removeSip = async (sipId) => {
    try {
      await axios.delete(`${API_BASE}/simulator/sips/${sipId}`);
      fetchHoldings();
    } catch (e) { console.error(e); }
  };

  const deleteStock = async (stockCode) => {
    try {
      await axios.delete(`${API_BASE}/simulator/${stockCode}`);
      fetchHoldings();
      setHistRefreshKey(k => k + 1);
    } catch (e) { console.error(e); }
  };

  const showConfirm = (title, message, confirmText, confirmStyle, onConfirm) => {
    setConfirmDialog({ open: true, title, message, confirmText, confirmStyle, onConfirm, working: false });
  };

  const runConfirmed = async () => {
    setConfirmDialog(d => ({ ...d, working: true }));
    try {
      await confirmDialog.onConfirm();
    } finally {
      setConfirmDialog(d => ({ ...d, open: false, working: false }));
    }
  };

  const confirmSaveMod = () => {
    const isAdd = editMod?.override_type === 'add';

    // Calculate new total allocation
    const code = editMod?.stock_code?.toUpperCase()?.trim();
    const newAlloc = parseFloat(editMod?.allocation || 0);

    // Calculate what the new total allocation would be, excluding both the
    // stock being edited (its new value is added back in below) and the
    // auto-managed LIQUIDCASE row -- that row absorbs/releases the gap on
    // save, so it shouldn't count against the 100% cap on a real stock's edit.
    const currentTotal = (simulatedPortfolio?.holdings || [])
      .filter(h => h.code !== 'LIQUIDCASE' && h.code !== code)
      .reduce((sum, h) => sum + (h.allocation || 0), 0);
    const projectedTotal = currentTotal + newAlloc;

    if (code !== 'LIQUIDCASE' && projectedTotal > 100) {
      setAllocationError(`Overall allocation cannot exceed 100%. Current total would be ${projectedTotal.toFixed(1)}%. Please reduce the allocation.`);
      return;
    }

    setModalOpen(false);

    showConfirm(
      isAdd ? 'Add Stock to Virtual Portfolio' : `Modify ${editMod?.stock_code}`,
      isAdd
        ? `Add ${editMod?.stock_code || 'stock'} to your virtual portfolio?`
        : `Apply changes to ${editMod?.stock_code}?`,
      isAdd ? 'Yes, Add' : 'Yes, Modify',
      { background: 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.4)', color: 'var(--primary)', fontWeight: 700 },
      saveMod
    );
  };

  const confirmDeleteStock = (stockCode) => {
    showConfirm(
      'Delete Stock',
      `Remove ${stockCode} entirely from your virtual portfolio?`,
      'Yes, Delete',
      { background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)', color: 'var(--negative)', fontWeight: 700 },
      () => deleteStock(stockCode)
    );
  };

  const confirmResetAll = () => {
    showConfirm(
      'Reset Virtual Portfolio',
      'Remove all stocks and SIPs from your virtual portfolio? This cannot be undone.',
      'Yes, Reset All',
      { background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.4)', color: 'var(--negative)', fontWeight: 700 },
      resetMods
    );
  };

  const simulatedPortfolio = useMemo(() => {
    const simHoldings = holdings.map(h => {
      const bp  = h.buy_price || 0;
      const cmp = h.cmp || 0;
      const perf = bp > 0 ? ((cmp - bp) / bp) * 100 : 0;
      const holdingDays = h.buy_date
        ? Math.floor((Date.now() - new Date(h.buy_date).getTime()) / 86_400_000)
        : null;
      return {
        code:        h.stock_code,
        allocation:  h.allocation || 0,
        buy_price:   bp,
        buy_date:    h.buy_date || null,
        holdingDays,
        cmp:         cmp,
        performance: perf,
      };
    });

    let totalAlloc = simHoldings.reduce((sum, h) => sum + h.allocation, 0);
    let portfolioReturn = 0;
    if (totalAlloc > 0) {
      portfolioReturn = simHoldings.reduce((sum, h) => sum + (h.performance * h.allocation), 0) / totalAlloc;
    } else if (simHoldings.length > 0) {
      portfolioReturn = simHoldings.reduce((sum, h) => sum + h.performance, 0) / simHoldings.length;
    }

    return { holdings: simHoldings, portfolio_return: portfolioReturn, total_allocation: totalAlloc };
  }, [holdings]);

  useEffect(() => {
    if (!simulatedPortfolio.holdings.length) {
       setSimReturnData(null);
       return;
    }
    let cancelled = false;
    const compute = async () => {
       setCalculatingReturn(true);
       try {
         const res = await axios.post(`${API_BASE}/simulator/calculate-return`, {
           holdings: simulatedPortfolio.holdings,
           sips: sips
         });
         if (!cancelled) {
           setSimReturnData(res.data);
         }
       } catch (err) { console.error(err); }
       if (!cancelled) setCalculatingReturn(false);
    };
    compute();
    return () => { cancelled = true; };
  }, [simulatedPortfolio, sips, baseInvestment]);

  // Auto-fetch Buy Price + CMP whenever stock code or date changes in the
  // Add/Modify modal (both modes -- modifying a holding can refresh its buy
  // price for a corrected date or just pull the latest CMP the same way
  // adding one does). Uses a 600ms debounce and cancels stale requests to
  // avoid race conditions (AutoCompleteInput calls onChange on every
  // keystroke, so without this the "T" and "TC" responses could overwrite
  // the correct "TCS" response).
  const modalCode = editMod?.stock_code || '';
  useEffect(() => {
    if (!modalCode || modalCode.length < 2) return;

    let cancelled = false;
    setFetchingPrice(true);

    const timer = setTimeout(async () => {
      const today = new Date().toISOString().split('T')[0];

      // Fire CMP + buy-price lookups together instead of one after another —
      // on a cold cache each call can take a few seconds, so awaiting them
      // sequentially could double the wait for no reason.
      const requests = [
        axios.get(`${API_BASE}/stocks/history?code=${modalCode}&date=${today}`)
          .then(res => { if (!cancelled && res.data.price > 0) setEditMod(prev => ({ ...prev, cmp: res.data.price })); })
          .catch(err => console.error('CMP fetch error', err)),
      ];
      if (modalDate) {
        requests.push(
          axios.get(`${API_BASE}/stocks/history?code=${modalCode}&date=${modalDate}`)
            .then(res => { if (!cancelled && res.data.price > 0) setEditMod(prev => ({ ...prev, buy_price: res.data.price })); })
            .catch(err => console.error('Buy price fetch error', err))
        );
      }

      await Promise.all(requests);
      if (!cancelled) setFetchingPrice(false);
    }, 600);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [modalCode, modalDate]);

  if (loading) return <div style={{ textAlign: 'center', marginTop: '4rem' }}><h3 className="text-gradient">Loading Simulator...</h3></div>;

  const handleEditClick = (h) => {
    setEditMod({
      stock_code: h.code,
      override_type: 'modify',
      allocation: h.allocation,
      buy_price: h.buy_price,
      buy_date: h.buy_date ?? null,
      cmp: h.cmp
    });
    // Pre-fill with the existing buy date so the auto-fetch effect below can
    // refresh Buy Price/CMP for it immediately, same as the Add flow.
    setModalDate(h.buy_date || '');
    setAllocationError('');
    setInvestInputMode('pct');
    setInvestValueInput('');
    setFetchingPrice(false);
    setModalOpen(true);
  };

  const handleAddNew = () => {
    setEditMod({
      stock_code: '',
      override_type: 'add',
      allocation: 0,
      buy_price: 0,
      buy_date: null,
      cmp: 0
    });
    setModalDate('');
    setAllocationError('');
    setFetchingPrice(false);
    setInvestInputMode('pct');
    setInvestValueInput('');
    setModalOpen(true);
  };

  const handleStockCodeChange = (val) => {
    setEditMod(prev => ({ ...prev, stock_code: val }));
  };

  const handleDateChange = (dateVal) => {
    setModalDate(dateVal);
  };

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const SortIcon = ({ colKey }) => {
    if (sortConfig.key !== colKey) return <span style={{ opacity: 0.3, marginLeft: '4px' }}>⇅</span>;
    return <span style={{ marginLeft: '4px', color: 'var(--primary)' }}>{sortConfig.direction === 'asc' ? '↑' : '↓'}</span>;
  };

  const getFilteredSorted = (holdingsList) => {
    let result = [...holdingsList];

    if (filters.code.trim()) {
      const q = filters.code.trim().toLowerCase();
      result = result.filter(h => h.code && h.code.toLowerCase().includes(q));
    }
    if (filters.performance.trim()) {
      const threshold = parseFloat(filters.performance);
      if (!isNaN(threshold)) {
        result = result.filter(h => Number(h.performance) >= threshold);
      }
    }

    result.sort((a, b) => {
      let aVal = a[sortConfig.key];
      let bVal = b[sortConfig.key];
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
    return result;
  };

  const activeFilterCount = Object.values(filters).filter(v => v.trim()).length;

  return (
    <div className="animate-slide-up">
      <div style={{ marginBottom: '16px' }}>
        <button className="btn btn-secondary" onClick={() => navigate(-1)} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <ArrowLeft size={16} /> Back
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h2 style={{ marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Target color="var(--secondary)" /> My Virtual Portfolio
          </h2>
        </div>
      </div>

      <div
        className="glass-panel"
        style={{
          marginBottom: '24px',
          padding: '14px 18px',
          border: '1px solid rgba(99,102,241,0.25)',
          background: 'rgba(99,102,241,0.06)',
          fontSize: '0.85rem',
          color: 'var(--text-main)',
          lineHeight: 1.5,
        }}
      >
        This portfolio belongs only to you. It isn't linked to any basket or model portfolio —
        it's built entirely from the stocks <strong>you</strong> choose to add below, and only you can see or edit it.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '24px' }}>
        <div className="glass-panel" style={{ textAlign: 'center', border: '1px solid var(--primary)', background: 'var(--primary-glow)' }}>
          <p className="text-muted" style={{ marginBottom: '8px', color: 'var(--text-main)' }}>Simulated Return</p>
          <h1 style={{ color: 'var(--text-main)', margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {calculatingReturn ? <RotateCcw size={24} style={{ animation: 'spin 1s linear infinite' }}/> : <>{simReturnData ? (simReturnData.absolute_return > 0 ? '+' : '') + simReturnData.absolute_return.toFixed(2) + '%' : '--'}</>}
          </h1>
          <div style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-main)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', flexWrap: 'wrap' }}>
            <span style={{ opacity: 0.75 }}>Base Investment:</span>
            {editingBase ? (
              <>
                <input
                  type="number"
                  autoFocus
                  value={baseInput}
                  onChange={e => setBaseInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveBaseInvestment(); if (e.key === 'Escape') setEditingBase(false); }}
                  style={{
                    width: '110px', padding: '2px 6px', fontSize: '0.75rem',
                    background: 'var(--panel-bg)', border: '1px solid var(--primary)',
                    borderRadius: '4px', color: 'var(--text-main)',
                  }}
                />
                <button
                  onClick={handleSaveBaseInvestment}
                  disabled={savingBase}
                  style={{
                    background: 'var(--panel-bg)', border: '1px solid var(--text-main)',
                    color: 'var(--text-main)', cursor: 'pointer', fontWeight: 700, fontSize: '0.75rem',
                    borderRadius: '5px', padding: '3px 10px',
                  }}
                >
                  {savingBase ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => setEditingBase(false)}
                  style={{
                    background: 'transparent', border: '1px solid var(--text-main)', opacity: 0.7,
                    color: 'var(--text-main)', cursor: 'pointer', fontSize: '0.75rem',
                    borderRadius: '5px', padding: '3px 10px',
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--text-main)' }}>₹{baseInvestment.toLocaleString('en-IN')}</strong>
                <button
                  onClick={() => { setBaseInput(String(baseInvestment)); setEditingBase(true); }}
                  title="Edit base investment"
                  style={{
                    background: 'var(--panel-bg)', border: '1px solid var(--text-main)',
                    color: 'var(--text-main)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
                    gap: '4px', padding: '3px 9px', borderRadius: '5px', fontSize: '0.72rem', fontWeight: 600,
                  }}
                >
                  <Edit2 size={12} /> Edit
                </button>
              </>
            )}
          </div>
          {simReturnData && !calculatingReturn && (
            <div style={{ fontSize: '0.75rem', marginTop: '8px', color: 'var(--text-main)', opacity: 0.75 }}>
               Invested: ₹{(simReturnData.total_invested).toLocaleString('en-IN')} &nbsp;|&nbsp;
               Current: ₹{(simReturnData.current_value).toLocaleString('en-IN')}
            </div>
          )}
          {simReturnData?.sip_details?.length > 0 && !calculatingReturn && (
            <button
              onClick={() => setSipModalOpen(true)}
              style={{ marginTop: '8px', fontSize: '0.7rem', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', color: 'var(--primary)', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer' }}
            >
              View SIP Breakdown →
            </button>
          )}
        </div>
      </div>

      <HistoricComparison refreshKey={histRefreshKey} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h3 style={{ margin: 0 }}>Simulated Data Engine</h3>
          <button className="btn btn-primary" onClick={handleAddNew} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Plus size={16}/> Add Stock
          </button>
          <button className="btn btn-secondary" onClick={() => setSipModalOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Target size={16}/> Manage SIPs ({sips.length})
          </button>
          <button className="btn btn-secondary no-print" onClick={() => setExportModalOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Download size={16}/> Export
          </button>
          <button className="btn btn-secondary" onClick={confirmResetAll} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <RotateCcw size={16}/> Reset All
          </button>
        </div>
        <button
          className={`btn ${activeFilterCount > 0 ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setShowFilters(f => !f)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <Filter size={16} />
          {showFilters ? 'Hide Filters' : 'Show Filters'}
          {activeFilterCount > 0 && (
            <span style={{
              background: 'var(--positive)', color: '#fff',
              borderRadius: '50%', width: '18px', height: '18px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.7rem', fontWeight: 700
            }}>{activeFilterCount}</span>
          )}
        </button>
      </div>

      <div className="table-wrapper" style={{ fontSize: '0.78rem' }}>
        <table style={{ borderCollapse: 'collapse', tableLayout: 'auto' }}>
          <thead>
            {/* Sort Headers */}
            <tr>
              <th style={{ whiteSpace: 'nowrap', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 500 }}>#</th>
              <th
                onClick={() => handleSort('code')}
                style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', padding: '6px 8px', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 2 }}
              >
                Stock<SortIcon colKey="code" />
              </th>

              <th
                onClick={() => handleSort('allocation')}
                style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', padding: '6px 8px' }}
              >
                Alloc%<SortIcon colKey="allocation" />
              </th>
              <th
                onClick={() => handleSort('buy_price')}
                style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', padding: '6px 8px', minWidth: '80px' }}
              >
                BuyPx<SortIcon colKey="buy_price" />
              </th>
              <th
                onClick={() => handleSort('cmp')}
                style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', padding: '6px 8px' }}
              >
                CMP<SortIcon colKey="cmp" />
              </th>
              <th
                onClick={() => handleSort('performance')}
                style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', padding: '6px 8px' }}
              >
                SimRet%<SortIcon colKey="performance" />
              </th>
              <th
                onClick={() => handleSort('holdingDays')}
                style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', padding: '6px 8px' }}
              >
                Holding Days<SortIcon colKey="holdingDays" />
              </th>
              <th style={{ padding: '6px 8px' }}>Act.</th>
            </tr>

            {/* Filter Row */}
            {showFilters && (
              <tr style={{ background: 'rgba(99,102,241,0.08)' }}>
                <th />
                <th style={{ padding: '6px 8px' }}>
                  <input
                    type="text"
                    placeholder="Filter stock…"
                    value={filters.code}
                    onChange={e => setFilters(f => ({ ...f, code: e.target.value }))}
                    style={{ width: '100%', padding: '4px 8px', fontSize: '0.8rem' }}
                  />
                </th>

                <th />
                <th />
                <th />
                <th style={{ padding: '6px 8px' }}>
                  <input
                    type="number"
                    placeholder="Min % return"
                    value={filters.performance}
                    onChange={e => setFilters(f => ({ ...f, performance: e.target.value }))}
                    style={{ width: '100%', padding: '4px 8px', fontSize: '0.8rem' }}
                  />
                </th>
                <th />
                <th style={{ padding: '6px 8px' }}>
                  <button
                    className="btn"
                    style={{ padding: '4px 8px', fontSize: '0.75rem', width: '100%' }}
                    onClick={() => setFilters({ code: '', performance: '' })}
                  >
                    Clear
                  </button>
                </th>
              </tr>
            )}
          </thead>
          <tbody>
            {getFilteredSorted(simulatedPortfolio.holdings).map((h, idx) => (
              <tr key={h.code} style={h.code === 'LIQUIDCASE' ? { background: 'rgba(234,179,8,0.06)' } : undefined}>
                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: '0.72rem', textAlign: 'right' }}>
                  {idx + 1}
                </td>
                <td style={{ padding: '5px 8px', position: 'sticky', left: 0, background: h.code === 'LIQUIDCASE' ? 'rgba(20,18,10,0.98)' : 'var(--surface)', zIndex: 1, whiteSpace: 'nowrap' }}>
                  <strong style={{ fontSize: '0.8rem', color: h.code === 'LIQUIDCASE' ? 'var(--accent-amber)' : undefined }}>
                    {h.code === 'LIQUIDCASE' ? 'CASH (LIQUIDCASE)' : h.code}
                  </strong>
                </td>

                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{h.allocation.toFixed(1)}%</td>
                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', minWidth: '80px' }}>{h.buy_price > 0 ? h.buy_price.toFixed(2) : '—'}</td>
                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', fontWeight: 600 }}>{h.cmp.toFixed(2)}</td>
                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap', color: h.performance >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 600 }}>
                  {h.performance > 0 ? '+' : ''}{h.performance.toFixed(2)}%
                </td>
                <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                  {h.holdingDays != null ? `${h.holdingDays} days` : '—'}
                </td>
                <td style={{ padding: '5px 8px', display: 'flex', gap: '4px' }}>
                  <button className="btn btn-secondary" style={{ padding: '3px 5px' }} onClick={() => handleEditClick(h)} title="Edit">
                    <Edit2 size={13} />
                  </button>
                  <button className="btn" style={{ padding: '3px 5px', color: 'var(--negative)', borderColor: 'var(--negative)' }} onClick={() => confirmDeleteStock(h.code)} title="Delete from Virtual Portfolio">
                    <X size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {simulatedPortfolio.holdings.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: '24px 8px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  Your virtual portfolio is empty. Click "Add Stock" to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* SIP Management Modal */}
      {sipModalOpen && (
        <div className="modal-overlay no-print" onClick={() => setSipModalOpen(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: '560px', width: '95%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0 }}>Manage SIPs</h3>
              <button onClick={() => setSipModalOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={22} />
              </button>
            </div>
            <p style={{ color: 'var(--text-muted)', marginBottom: '4px', fontSize: '0.82rem' }}>
              Base Investment: <strong style={{ color: 'var(--text-main)' }}>₹{baseInvestment.toLocaleString('en-IN')}</strong>
              &nbsp;<em style={{ fontStyle: 'normal', opacity: 0.7 }}>(editable above)</em>
              &nbsp;·&nbsp; SIP amount is split by each stock's current allocation weight.
              &nbsp;·&nbsp; If date falls on weekend/holiday, next trading session is used.
            </p>

            {/* SIP list */}
            <div style={{ maxHeight: '260px', overflowY: 'auto', margin: '12px 0', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)' }}>
              {sips.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px 0', fontSize: '0.85rem' }}>No SIPs added yet.</div>
              ) : sips.map((s, i) => {
                const detail = simReturnData?.sip_details?.find(d => d.input_date === s.sip_date);
                const isExpanded = sipExpandedIdx === i;
                const dateAdjusted = detail && detail.actual_date !== detail.input_date;
                return (
                  <div key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    {/* Header row */}
                    <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', gap: '8px' }}>
                      <span style={{ flex: 1, fontSize: '0.84rem' }}>
                        {s.sip_date}
                        {dateAdjusted && (
                          <span style={{ marginLeft: '6px', fontSize: '0.7rem', color: 'var(--accent-amber)', background: 'rgba(251,191,36,0.1)', borderRadius: '4px', padding: '1px 6px' }}>
                            → {detail.actual_date}
                          </span>
                        )}
                      </span>
                      <span style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--text-main)' }}>
                        ₹{s.amount.toLocaleString('en-IN')}
                      </span>
                      {detail?.stocks?.length > 0 && (
                        <button
                          onClick={() => setSipExpandedIdx(isExpanded ? null : i)}
                          style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', color: 'var(--primary)', borderRadius: '4px', fontSize: '0.7rem', padding: '2px 8px', cursor: 'pointer' }}
                        >
                          {isExpanded ? 'Hide' : 'Details'}
                        </button>
                      )}
                      <button onClick={() => removeSip(s.id)} style={{ background: 'transparent', border: 'none', color: 'var(--negative)', cursor: 'pointer', padding: '0 2px' }}>
                        <X size={14} />
                      </button>
                    </div>
                    {/* Expanded breakdown */}
                    {isExpanded && detail?.stocks?.length > 0 && (
                      <div style={{ padding: '4px 12px 10px', background: 'rgba(99,102,241,0.04)' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem' }}>
                          <thead>
                            <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                              <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 600 }}>Stock</th>
                              <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Alloc%</th>
                              <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Buy Price</th>
                              <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Invested</th>
                              <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Units</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.stocks.map(st => (
                              <tr key={st.code} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                                <td style={{ padding: '3px 6px', fontWeight: 700, color: 'var(--text-main)' }}>{st.code}</td>
                                <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--text-muted)' }}>{st.allocation.toFixed(1)}%</td>
                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>₹{st.price.toLocaleString('en-IN')}</td>
                                <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--primary)' }}>₹{st.amount_invested.toLocaleString('en-IN')}</td>
                                <td style={{ padding: '3px 6px', textAlign: 'right', color: 'var(--text-muted)' }}>{st.shares.toFixed(3)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Add new SIP */}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px', color: 'var(--text-muted)' }}>Date</label>
                <input type="date" value={newSip.sip_date} max={new Date().toISOString().split("T")[0]} onChange={e => setNewSip(prev => ({ ...prev, sip_date: e.target.value }))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(0,0,0,0.2)', color: 'white', colorScheme: 'dark' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: '0.8rem', display: 'block', marginBottom: '4px', color: 'var(--text-muted)' }}>Amount (₹)</label>
                <input type="number" value={newSip.amount || ''} onChange={e => setNewSip(prev => ({ ...prev, amount: parseFloat(e.target.value) }))} style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(0,0,0,0.2)', color: 'white' }} />
              </div>
              <button className="btn btn-primary" onClick={saveSip} style={{ padding: '8px 16px', height: '38px' }}>Add</button>
            </div>
          </div>
        </div>
      )}

      {/* Export Format Picker Modal */}
      {exportModalOpen && (
        <div className="modal-overlay no-print" onClick={() => setExportModalOpen(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 style={{ margin: 0 }}>Export Simulator</h3>
              <button onClick={() => setExportModalOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <X size={22} />
              </button>
            </div>
            <p style={{ color: 'var(--text-muted)', marginBottom: '24px', fontSize: '0.9rem' }}>
              Choose the format to export <strong style={{ color: 'var(--text-main)' }}>your virtual portfolio</strong>:
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <button
                className="btn btn-primary"
                onClick={handleExportExcel}
                style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', height: 'auto' }}
              >
                <Download size={28} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>Excel</div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: '4px' }}>Summary + Holdings + Historical Performance</div>
                </div>
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleExportPDF}
                style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', height: 'auto' }}
              >
                <span style={{ fontSize: '1.8rem', lineHeight: 1 }}>📄</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>PDF</div>
                  <div style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: '4px' }}>Full page snapshot via browser print</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Universal Confirmation Dialog */}
      {confirmDialog.open && (
        <div className="modal-overlay no-print" onClick={() => { if (!confirmDialog.working) setConfirmDialog(d => ({ ...d, open: false })); }}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px', textAlign: 'center' }}>
            <h3 style={{ margin: '0 0 16px' }}>{confirmDialog.title}</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: '24px', whiteSpace: 'pre-line', lineHeight: 1.6 }}>
              {confirmDialog.message}
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button className="btn btn-secondary" onClick={() => setConfirmDialog(d => ({ ...d, open: false }))} disabled={confirmDialog.working}>
                Cancel
              </button>
              <button className="btn" onClick={runConfirmed} disabled={confirmDialog.working} style={confirmDialog.confirmStyle}>
                {confirmDialog.working ? 'Working...' : confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && editMod && (
        <div className="modal-overlay" onClick={() => setModalOpen(false)}>
          <div className="modal-content glass-panel" onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: '24px' }}>
              {editMod.override_type === 'add' ? 'Add New Stock to Virtual Portfolio' : `Modify ${editMod.stock_code}`}
            </h3>

            {editMod.override_type === 'add' && (
              <div className="input-group">
                <label>NSE Stock Code</label>
                <AutoCompleteInput
                  value={editMod.stock_code}
                  onChange={handleStockCodeChange}
                  placeholder="e.g. RELIANCE"
                />
              </div>
            )}
            <div className="input-group">
              <label>{editMod.override_type === 'add' ? 'Historical Purchase Date (up to 5 years back)' : 'Purchase Date'}</label>
              <input
                type="date"
                value={modalDate}
                max={new Date().toISOString().split("T")[0]}
                min={new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]}
                onChange={(e) => handleDateChange(e.target.value)}
              />
              <small style={{color: 'var(--text-muted)', display: 'block', marginTop: '4px'}}>
                {fetchingPrice
                  ? '⏳ Fetching prices from NSE...'
                  : 'Auto-fetches historic EOD buy price and current CMP for this date. Both can be edited manually.'}
              </small>
            </div>

            <div className="input-group">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <label style={{ margin: 0 }}>{investInputMode === 'pct' ? 'Allocation (%)' : 'Investment Value (₹)'}</label>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    type="button"
                    onClick={() => setInvestInputMode('pct')}
                    style={{
                      fontSize: '0.7rem', padding: '2px 8px', borderRadius: '5px', cursor: 'pointer',
                      border: '1px solid ' + (investInputMode === 'pct' ? 'var(--primary)' : 'var(--border, rgba(255,255,255,0.15))'),
                      background: investInputMode === 'pct' ? 'var(--primary-glow)' : 'transparent',
                      color: investInputMode === 'pct' ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 600,
                    }}
                  >
                    % Allocation
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // Switching in: seed the ₹ field from whatever allocation % is
                      // currently set, so it doesn't just reset to blank.
                      const seeded = ((editMod.allocation || 0) / 100) * baseInvestment;
                      setInvestValueInput(seeded ? String(Math.round(seeded)) : '');
                      setInvestInputMode('value');
                    }}
                    style={{
                      fontSize: '0.7rem', padding: '2px 8px', borderRadius: '5px', cursor: 'pointer',
                      border: '1px solid ' + (investInputMode === 'value' ? 'var(--primary)' : 'var(--border, rgba(255,255,255,0.15))'),
                      background: investInputMode === 'value' ? 'var(--primary-glow)' : 'transparent',
                      color: investInputMode === 'value' ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 600,
                    }}
                  >
                    ₹ Investment
                  </button>
                </div>
              </div>
              {investInputMode === 'pct' ? (
                <input type="number" step="0.1" value={editMod.allocation || ''} onChange={e => setEditMod({...editMod, allocation: parseFloat(e.target.value)})} />
              ) : (
                <>
                  <input
                    type="number"
                    step="1"
                    value={investValueInput}
                    placeholder={`e.g. ${Math.round(baseInvestment * 0.05)}`}
                    onChange={e => {
                      setInvestValueInput(e.target.value);
                      const val = parseFloat(e.target.value);
                      const pct = (val > 0 && baseInvestment > 0) ? (val / baseInvestment) * 100 : 0;
                      setEditMod(prev => ({ ...prev, allocation: pct }));
                    }}
                  />
                  <small style={{ color: 'var(--text-muted)', display: 'block', marginTop: '4px' }}>
                    ≈ {(editMod.allocation || 0).toFixed(2)}% of your ₹{baseInvestment.toLocaleString('en-IN')} base investment
                  </small>
                </>
              )}
            </div>

            <div className="input-group">
              <label>Buy Price {fetchingPrice && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>fetching…</span>}</label>
              <input
                type="number"
                step="0.1"
                value={editMod.buy_price || ''}
                placeholder={fetchingPrice ? 'Fetching…' : ''}
                onChange={e => setEditMod({...editMod, buy_price: parseFloat(e.target.value)})}
              />
            </div>

            <div className="input-group">
              <label>Current Market Price (CMP) {fetchingPrice && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>fetching…</span>}</label>
              <input
                type="number"
                step="0.1"
                value={editMod.cmp || ''}
                placeholder={fetchingPrice ? 'Fetching…' : ''}
                onChange={e => setEditMod({...editMod, cmp: parseFloat(e.target.value)})}
              />
            </div>

            {allocationError && (
              <div style={{ padding: '10px 14px', marginTop: '12px', borderRadius: '8px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: 'var(--negative)', fontSize: '0.83rem' }}>
                {allocationError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '16px' }}>
              <button className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmSaveMod}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default SimulatorPortfolio;
