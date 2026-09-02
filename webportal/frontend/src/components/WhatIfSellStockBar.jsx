import { useEffect, useRef, useState } from 'react';
import { formatRupee, formatPercent, getColorClass } from '../App.jsx';
import { EMPTY_SLOT, computeWhatIf, toIsoDate, fromIsoDate, applySellToSlot, undoSoldEntry } from '../whatIfCalc.js';
import { fetchOhlcLookup } from '../api/client.js';

// Mirrors WhatIfAddStockBar.jsx, but for the opposite action: simulate fully
// or partially selling an EXISTING real holding, entirely in-memory, never
// persisted. Reuses the same deletedNse/weightReductions plumbing that
// already drives every What-If aggregate (KPIs, pie chart, top movers) --
// this bar just gives that plumbing its own standalone entry point (rather
// than only reachable as a "make room" side-effect of adding a new stock),
// plus a sell date/price so a simulated gain%, mirroring how real sold
// stocks are tracked, can be shown.
export default function WhatIfSellStockBar({ basketKey, rows, simOverlay, setSimOverlay }) {
  const slot = simOverlay[basketKey] || EMPTY_SLOT;
  const sold = slot.sold || [];
  const hasSimulation = slot.added.length > 0 || slot.deletedNse.length > 0 ||
    Object.keys(slot.editedBuys).length > 0 || Object.keys(slot.editedSells || {}).length > 0 ||
    Object.keys(slot.weightReductions || {}).length > 0;

  const [modalOpen, setModalOpen] = useState(false);
  const [nseCode, setNseCode] = useState('');
  const [sellMode, setSellMode] = useState('full'); // 'full' | 'partial'
  const [sellWeight, setSellWeight] = useState('');
  const [sellDate, setSellDate] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [error, setError] = useState('');
  const [priceWarn, setPriceWarn] = useState('');
  const latestRequestRef = useRef('');
  const overlayRef = useRef(null);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setModalOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  const before = computeWhatIf(rows, slot);

  // Eligible = real holdings not already fully sold, with remaining allocation > 0
  const eligible = rows
    .filter(r => r.nseCode && !slot.deletedNse.includes(r.nseCode))
    .map(r => ({
      nseCode: r.nseCode,
      allocationPct: (before.overlaid.find(o => o.nseCode === r.nseCode)?.allocation || 0) * 100,
      buyPrice: r.buyPrice,
    }))
    .filter(r => r.allocationPct > 0.0001)
    .sort((a, b) => b.allocationPct - a.allocationPct);

  const selected = eligible.find(s => s.nseCode === nseCode);
  const remainingPct = selected?.allocationPct || 0;
  const sellWeightNum = parseFloat(sellWeight) || 0;
  const partialInvalid = sellMode === 'partial' && (sellWeightNum <= 0 || sellWeightNum > remainingPct + 0.0001);

  const gainPct = (selected?.buyPrice && sellPrice && parseFloat(sellPrice) > 0)
    ? (parseFloat(sellPrice) - selected.buyPrice) / selected.buyPrice
    : null;

  // Preview the portfolio-wide impact of the pending sell BEFORE it's
  // committed -- driven only by nseCode/weight (deletedNse/weightReductions
  // are all computeWhatIf actually looks at); sell date/price don't affect
  // this, so the preview appears as soon as a stock+amount is chosen, before
  // those fields are even filled in.
  const previewSlot = (() => {
    if (!nseCode) return slot;
    if (sellMode === 'partial' && (sellWeightNum <= 0 || partialInvalid)) return slot;
    const weightSold = sellMode === 'full' ? remainingPct : sellWeightNum;
    if (sellMode === 'full') {
      return { ...slot, deletedNse: [...slot.deletedNse, nseCode] };
    }
    return { ...slot, weightReductions: { ...slot.weightReductions, [nseCode]: (slot.weightReductions[nseCode] || 0) + weightSold } };
  })();
  const after = computeWhatIf(rows, previewSlot);

  const tryAutoFetchPrice = async (code, date) => {
    if (!code || !date) return;
    const requestKey = `${code}|${date}`;
    latestRequestRef.current = requestKey;
    setPriceWarn('');
    try {
      const res = await fetchOhlcLookup(code, date);
      if (latestRequestRef.current !== requestKey) return;
      if (res && res.price != null) {
        setSellPrice(String(res.price));
      } else {
        setPriceWarn('No price data for this date — enter the price manually.');
      }
    } catch {
      if (latestRequestRef.current !== requestKey) return;
      setPriceWarn('Lookup failed — enter the price manually.');
    }
  };

  const handleDateChange = (isoValue) => {
    const newDate = fromIsoDate(isoValue);
    setSellDate(newDate);
    if (nseCode && newDate) tryAutoFetchPrice(nseCode, newDate);
  };

  const handleCodeChange = (code) => {
    setNseCode(code);
    setSellWeight('');
    if (code && sellDate) tryAutoFetchPrice(code, sellDate);
  };

  const patchSlot = (patchFn) => setSimOverlay(prev => {
    const prevSlot = prev[basketKey] || EMPTY_SLOT;
    return { ...prev, [basketKey]: patchFn(prevSlot) };
  });

  const resetAll = () => setSimOverlay(prev => ({
    ...prev, [basketKey]: { editedBuys: {}, deletedNse: [], added: [], weightReductions: {}, sold: [] },
  }));

  const closeModal = () => {
    setModalOpen(false);
    setNseCode(''); setSellMode('full'); setSellWeight(''); setSellDate(''); setSellPrice('');
    setError(''); setPriceWarn('');
  };

  const removeSold = (id) => patchSlot(prevSlot => undoSoldEntry(prevSlot, id));

  const handleSell = () => {
    setError('');
    if (!nseCode)  { setError('Pick a stock to sell.'); return; }
    if (!sellDate) { setError('Pick a sell date.'); return; }
    const price = parseFloat(sellPrice);
    if (!price || price <= 0) { setError('Enter a sell OHLC price.'); return; }
    if (sellMode === 'partial' && partialInvalid) {
      setError(`Enter a weight between 0% and ${remainingPct.toFixed(2)}%.`);
      return;
    }

    const weightSold = sellMode === 'full' ? remainingPct : sellWeightNum;
    patchSlot(prevSlot => applySellToSlot(prevSlot, {
      nseCode, weightSold, sellDate, sellPrice: price,
      buyPrice: selected?.buyPrice ?? null, full: sellMode === 'full',
    }));
    closeModal();
  };

  return (
    <div className="whatif-addbar">
      <div className="whatif-section-title" style={{ marginTop: 0 }}>Sell Hypothetical Stock (simulation only)</div>

      {sold.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          {sold.map(s => (
            <div key={s.id} className="whatif-added-row">
              <span style={{ fontWeight: 700 }}>{s.nseCode}</span>
              <span className="sit-label">
                {s.full ? 'fully sold' : `${s.weightSold.toFixed(2)}% sold`} &middot; {s.sellDate} @ {formatRupee(s.sellPrice)}
                {s.gainPct != null && (
                  <> &middot; <span className={getColorClass(s.gainPct)}>{formatPercent(s.gainPct)}</span></>
                )}
              </span>
              <button className="whatif-close" onClick={() => removeSold(s.id)}>&times;</button>
            </div>
          ))}
        </div>
      )}

      <div className="whatif-addrow">
        <button className="btn btn-secondary" onClick={() => setModalOpen(true)} style={{ fontSize: '0.78rem' }}>
          − Sell Hypothetical Stock
        </button>
        {hasSimulation && (
          <button className="btn btn-secondary" onClick={resetAll} style={{ fontSize: '0.78rem' }}>Reset Simulation</button>
        )}
      </div>
      <div className="sit-no-data" style={{ marginTop: '0.3rem' }}>Temporary — resets on refresh, never saved.</div>

      {modalOpen && (
        <div className="whatif-overlay" ref={overlayRef} onClick={e => { if (e.target === overlayRef.current) closeModal(); }}>
          <div className="whatif-modal" style={{ width: 'min(420px, 94vw)' }}>
            <div className="whatif-header">
              <span className="sit-symbol" style={{ background: 'transparent', border: 'none', padding: 0 }}>
                Sell Hypothetical Stock
              </span>
              <button className="whatif-close" onClick={closeModal}>&times;</button>
            </div>
            <div className="whatif-body">
              <div className="whatif-section-title" style={{ marginTop: 0 }}>Stock</div>
              <select value={nseCode} onChange={e => handleCodeChange(e.target.value)} style={{ width: '100%' }}>
                <option value="">Select a stock…</option>
                {eligible.map(s => (
                  <option key={s.nseCode} value={s.nseCode}>{s.nseCode} — {s.allocationPct.toFixed(2)}% held</option>
                ))}
              </select>

              {nseCode && (
                <>
                  <div className="whatif-section-title">Sell Amount</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.4rem', fontSize: '0.82rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <input type="radio" checked={sellMode === 'full'} onChange={() => { setSellMode('full'); setSellWeight(''); }} />
                      Sell all ({remainingPct.toFixed(2)}%)
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <input type="radio" checked={sellMode === 'partial'} onChange={() => setSellMode('partial')} />
                      Sell part of it
                    </label>
                  </div>

                  {sellMode === 'partial' && (
                    <input type="number" placeholder={`Weight % to sell (max ${remainingPct.toFixed(2)}%)`}
                      value={sellWeight} onChange={e => setSellWeight(e.target.value)} style={{ width: '100%', marginBottom: '0.6rem' }} />
                  )}

                  <div className="whatif-section-title">Sell Date</div>
                  <input type="date" value={toIsoDate(sellDate)}
                    onChange={e => handleDateChange(e.target.value)} style={{ width: '100%' }} />

                  <div className="whatif-section-title">OHLC Sell Price</div>
                  <input type="number" placeholder="OHLC" value={sellPrice}
                    onChange={e => setSellPrice(e.target.value)} style={{ width: '100%' }} />

                  {selected?.buyPrice != null && (
                    <div className="sit-label" style={{ marginTop: '0.5rem' }}>
                      Buy price: {formatRupee(selected.buyPrice)}
                      {gainPct != null && (
                        <> &middot; Simulated gain: <span className={getColorClass(gainPct)}>{formatPercent(gainPct)}</span></>
                      )}
                    </div>
                  )}

                  <div className="whatif-section-title">Portfolio Impact (simulated)</div>
                  <div className="whatif-impact">
                    <div className="whatif-impact-row">
                      <span className="sit-label">Total Allocation</span>
                      <span>{formatPercent(before.totalAllocation)} &rarr; <strong>{formatPercent(after.totalAllocation)}</strong></span>
                    </div>
                    <div className="whatif-impact-row">
                      <span className="sit-label">Weighted Avg Gain %</span>
                      <span>
                        <span className={getColorClass(before.weightedGainPct)}>{formatPercent(before.weightedGainPct)}</span>
                        {' → '}
                        <strong className={getColorClass(after.weightedGainPct)}>{formatPercent(after.weightedGainPct)}</strong>
                      </span>
                    </div>
                    <div className="whatif-impact-row">
                      <span className="sit-label">1M Weighted Contribution</span>
                      <span>{formatPercent(before.totalContribution)} &rarr; {formatPercent(after.totalContribution)}</span>
                    </div>
                    <div className="sit-no-data" style={{ marginTop: '0.4rem' }}>
                      If this sell drops total allocation below 100%, the freed-up weight is automatically parked in LIQUIDCASE.
                    </div>
                  </div>
                </>
              )}

              {priceWarn && <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>{priceWarn}</div>}
              {partialInvalid && sellWeight && (
                <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>
                  Enter a weight between 0% and {remainingPct.toFixed(2)}%.
                </div>
              )}
              {error && <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>{error}</div>}
            </div>
            <div className="whatif-footer">
              <button className="btn btn-secondary" onClick={closeModal} style={{ fontSize: '0.78rem' }}>Cancel</button>
              <button
                className="btn btn-secondary"
                disabled={!nseCode || partialInvalid}
                onClick={handleSell}
                style={{ fontSize: '0.78rem' }}
              >
                Sell hypothetical stock
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
