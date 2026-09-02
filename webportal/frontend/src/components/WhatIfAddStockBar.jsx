import { useEffect, useRef, useState } from 'react';
import { formatRupee } from '../App.jsx';
import { EMPTY_SLOT, computeWhatIf, toIsoDate, fromIsoDate, applySellToSlot } from '../whatIfCalc.js';
import { fetchLiveStock, fetchOhlcLookup } from '../api/client.js';
import NseAutocomplete from './NseAutocomplete.jsx';

// Renders at the end of the real holdings table. Lets anyone (not just
// admins) layer hypothetical stocks onto the what-if simulation -- entirely
// in-memory (simOverlay), never persisted, resets on refresh.
//
// The actual "add" form lives in a centered modal (opened via a trigger
// button) rather than inline: inline, the NSE autocomplete's suggestion
// dropdown opens BELOW the input, and since this bar sits at the very end of
// the table, that dropdown had nowhere to render -- it was cut off past the
// bottom of the page with no way to scroll to it.
export default function WhatIfAddStockBar({ basketKey, rows, nseSymbols, simOverlay, setSimOverlay }) {
  const slot = simOverlay[basketKey] || EMPTY_SLOT;
  const hasSimulation = slot.added.length > 0 || slot.deletedNse.length > 0 ||
    Object.keys(slot.editedBuys).length > 0 || Object.keys(slot.editedSells || {}).length > 0 ||
    Object.keys(slot.weightReductions || {}).length > 0;

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ nseCode: '', weight: '', buyDate: '', ohlc: '' });
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [priceWarn, setPriceWarn] = useState('');
  // "Make room" for the new stock by replacing (fully removing) or partially
  // reducing an existing holding, instead of requiring free headroom to
  // already exist -- picked in the same modal so the user never has to leave
  // it to go edit another stock first.
  const [makeRoomMode, setMakeRoomMode] = useState('none'); // 'none' | 'replace' | 'reduce'
  const [makeRoomCode, setMakeRoomCode] = useState('');
  const [reduceBy, setReduceBy] = useState('');
  const latestRequestRef = useRef('');
  const overlayRef = useRef(null);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setModalOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  // Fires once both an NSE code and a date are present, regardless of which
  // field was filled in last -- avoids the earlier bug where the auto-fetch
  // only worked if the code happened to be typed before the date. A native
  // date input fires onChange per segment (day/month/year) as it's filled,
  // so multiple fetches can be in flight together; latestRequestRef makes
  // sure only the most recently issued one is ever applied, discarding any
  // response that resolves out of order.
  const tryAutoFetchPrice = async (code, date) => {
    if (!code || !date) return;
    const requestKey = `${code}|${date}`;
    latestRequestRef.current = requestKey;
    setPriceWarn('');
    try {
      const res = await fetchOhlcLookup(code, date);
      if (latestRequestRef.current !== requestKey) return; // a newer request superseded this one
      if (res && res.price != null) {
        setForm(f => ({ ...f, ohlc: res.price }));
      } else {
        setPriceWarn('No price data for this date — enter the price manually.');
      }
    } catch {
      if (latestRequestRef.current !== requestKey) return;
      setPriceWarn('Lookup failed — enter the price manually.');
    }
  };

  const handleCodeCommit = (val) => {
    const code = (val || '').trim().toUpperCase();
    setForm(f => ({ ...f, nseCode: code }));
    if (code && form.buyDate) tryAutoFetchPrice(code, form.buyDate);
  };

  const handleDateChange = (isoValue) => {
    const newDate = fromIsoDate(isoValue);
    setForm(f => ({ ...f, buyDate: newDate }));
    const code = (form.nseCode || '').trim().toUpperCase();
    if (code && newDate) tryAutoFetchPrice(code, newDate);
  };

  // Current effective allocation of every stock BEFORE this pending add --
  // used both to list "make room" candidates with their live weight and to
  // validate a reduction against what a stock actually has to give.
  const before = computeWhatIf(rows, slot);
  const eligibleForRoom = rows
    .filter(r => r.nseCode && !slot.deletedNse.includes(r.nseCode))
    .map(r => ({ nseCode: r.nseCode, allocationPct: (before.overlaid.find(o => o.nseCode === r.nseCode)?.allocation || 0) * 100 }))
    .filter(r => r.allocationPct > 0.0001)
    .sort((a, b) => b.allocationPct - a.allocationPct);
  const selectedStockPct = makeRoomCode ? (before.overlaid.find(o => o.nseCode === makeRoomCode)?.allocation || 0) * 100 : 0;
  const reduceByNum = parseFloat(reduceBy) || 0;
  const reduceInvalid = makeRoomMode === 'reduce' && !!makeRoomCode &&
    (reduceByNum <= 0 || reduceByNum > selectedStockPct + 0.0001);

  // "Today" in this app's "DD Mon YYYY" convention -- a Reduce make-room pick
  // locks in the trimmed stock's gain/loss at CMP right now, same as an
  // instant partial sell, so its sell date is always today.
  const todayDdMonYyyy = fromIsoDate(new Date().toISOString().slice(0, 10));

  // Draft slot with the pending make-room action applied, so the headroom
  // check below reflects the room it would actually free up. Reduce goes
  // through applySellToSlot (not a bare weightReductions write) so the
  // trimmed stock's gain gets locked in as a sold lot -- see soldLotStats in
  // whatIfCalc.js -- instead of just vanishing once its weight hits zero.
  // Replace intentionally skips this: fully swapping a stock out means it
  // never happened, no gain to bank.
  const draftSlot = (() => {
    if (makeRoomMode === 'replace' && makeRoomCode) {
      return { ...slot, deletedNse: [...slot.deletedNse, makeRoomCode] };
    }
    if (makeRoomMode === 'reduce' && makeRoomCode && reduceByNum > 0 && !reduceInvalid) {
      const makeRoomRow = rows.find(r => r.nseCode === makeRoomCode);
      return applySellToSlot(slot, {
        nseCode: makeRoomCode, weightSold: reduceByNum, sellDate: todayDdMonYyyy,
        sellPrice: makeRoomRow?.cmp ?? null, buyPrice: makeRoomRow?.buyPrice ?? null, full: false,
      });
    }
    return slot;
  })();

  // skipCashTopUp: this is a PREVIEW of room freed by the pending make-room
  // action, before the new stock has actually been added to the slot. Without
  // this, computeWhatIf's cash auto-top-up (meant for confirmed sells) would
  // immediately refill the gap just freed here into LIQUIDCASE, so by the
  // time the cap check runs there'd be no room left for the incoming stock.
  const after = computeWhatIf(rows, draftSlot, { skipCashTopUp: true });
  const liveTotalPct = after.totalAllocation * 100;
  const draftWeight  = parseFloat(form.weight) || 0;
  const overCap      = draftWeight > 0 && liveTotalPct + draftWeight > 100.0001;

  const patchSlot = (patchFn) => setSimOverlay(prev => {
    const prevSlot = prev[basketKey] || EMPTY_SLOT;
    return { ...prev, [basketKey]: patchFn(prevSlot) };
  });

  const resetAll = () => setSimOverlay(prev => ({ ...prev, [basketKey]: { editedBuys: {}, deletedNse: [], added: [], weightReductions: {}, sold: [] } }));

  const removeAdded = (id) => patchSlot(prevSlot => ({ ...prevSlot, added: prevSlot.added.filter(a => a.id !== id) }));

  const resetMakeRoom = () => { setMakeRoomMode('none'); setMakeRoomCode(''); setReduceBy(''); };

  const closeModal = () => {
    setModalOpen(false);
    setForm({ nseCode: '', weight: '', buyDate: '', ohlc: '' });
    setError('');
    setPriceWarn('');
    resetMakeRoom();
  };

  const handleAddStock = async () => {
    setError('');
    const code    = (form.nseCode || '').trim().toUpperCase();
    const weight  = parseFloat(form.weight);
    const buyDate = (form.buyDate || '').trim();
    const ohlc    = parseFloat(form.ohlc);
    if (!code)                  { setError('Enter an NSE code.'); return; }
    if (!weight || weight <= 0) { setError('Enter a valid weight %.'); return; }
    if (!buyDate)                { setError('Pick a buy date.'); return; }
    if (!ohlc || ohlc <= 0)      { setError('Enter a buy OHLC price.'); return; }
    // Replacing this exact code frees it up, so it's not "already in the sim" in that case.
    const alreadyReal  = rows.some(r => r.nseCode === code) && !slot.deletedNse.includes(code) &&
      !(makeRoomMode === 'replace' && makeRoomCode === code);
    const alreadyAdded = slot.added.some(a => a.nseCode === code);
    if (alreadyReal || alreadyAdded) { setError(`${code} is already in this simulation.`); return; }
    if (makeRoomMode === 'replace' && !makeRoomCode) { setError('Pick a stock to replace.'); return; }
    if (makeRoomMode === 'reduce') {
      if (!makeRoomCode) { setError('Pick a stock to reduce.'); return; }
      if (reduceInvalid)  { setError(`Enter a reduction between 0% and ${selectedStockPct.toFixed(2)}%.`); return; }
    }
    if (liveTotalPct + weight > 100.0001) {
      setError(`Would exceed 100% total allocation (${(100 - liveTotalPct).toFixed(2)}% free).`);
      return;
    }

    setFetching(true);
    try {
      // fast=true: this modal only ever reads cmp/close1M/open1M below, so skip
      // the Market Cap/PE cascade (Screener.in -> Google Finance -> NSE), which
      // was adding several extra seconds of pure wasted latency on every add.
      const live = await fetchLiveStock(code, { fast: true });
      const id = `${code}-${Math.random().toString(36).slice(2, 9)}`;
      patchSlot(prevSlot => {
        let next = { ...prevSlot };
        if (makeRoomMode === 'replace' && makeRoomCode) {
          next.deletedNse = [...next.deletedNse, makeRoomCode];
        } else if (makeRoomMode === 'reduce' && makeRoomCode) {
          const makeRoomRow = rows.find(r => r.nseCode === makeRoomCode);
          next = applySellToSlot(next, {
            nseCode: makeRoomCode, weightSold: reduceByNum, sellDate: todayDdMonYyyy,
            sellPrice: makeRoomRow?.cmp ?? null, buyPrice: makeRoomRow?.buyPrice ?? null, full: false,
          });
        }
        next.added = [...next.added, {
          id, nseCode: code, weight, buyDate, ohlc,
          cmp: live?.cmp ?? null, close1M: live?.close1M ?? null, open1M: live?.open1M ?? null,
        }];
        return next;
      });
      closeModal();
    } catch {
      setError('Could not fetch live price for that code — try again.');
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="whatif-addbar">
      <div className="whatif-section-title" style={{ marginTop: 0 }}>Add Hypothetical Stock (simulation only)</div>

      {slot.added.length > 0 && (
        <div style={{ marginBottom: '0.5rem' }}>
          {slot.added.map(a => (
            <div key={a.id} className="whatif-added-row">
              <span style={{ fontWeight: 700 }}>{a.nseCode}</span>
              <span className="sit-label">{a.weight}% &middot; bought {a.buyDate} @ {formatRupee(a.ohlc)}</span>
              <button className="whatif-close" onClick={() => removeAdded(a.id)}>&times;</button>
            </div>
          ))}
        </div>
      )}

      <div className="whatif-addrow">
        <button className="btn btn-secondary" onClick={() => setModalOpen(true)} style={{ fontSize: '0.78rem' }}>
          + Add Hypothetical Stock
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
                Add Hypothetical Stock
              </span>
              <button className="whatif-close" onClick={closeModal}>&times;</button>
            </div>
            <div className="whatif-body">
              <div className="whatif-section-title" style={{ marginTop: 0 }}>NSE Code</div>
              <NseAutocomplete initialValue={form.nseCode} onCommit={handleCodeCommit} symbols={nseSymbols} />

              <div className="whatif-section-title">Weight %</div>
              <input type="number" placeholder="Weight %" value={form.weight}
                onChange={e => setForm(f => ({ ...f, weight: e.target.value }))} style={{ width: '100%' }} />

              <div className="whatif-section-title">Buy Date</div>
              <input type="date" value={toIsoDate(form.buyDate)}
                onChange={e => handleDateChange(e.target.value)} style={{ width: '100%' }} />

              <div className="whatif-section-title">OHLC Buy Price</div>
              <input type="number" placeholder="OHLC" value={form.ohlc}
                onChange={e => setForm(f => ({ ...f, ohlc: e.target.value }))} style={{ width: '100%' }} />

              <div className="whatif-section-title">Make Room For This Stock (optional)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.4rem', fontSize: '0.82rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <input type="radio" checked={makeRoomMode === 'none'} onChange={resetMakeRoom} /> No change
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <input type="radio" checked={makeRoomMode === 'replace'}
                    onChange={() => { setMakeRoomMode('replace'); setReduceBy(''); }} /> Replace a stock
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                  <input type="radio" checked={makeRoomMode === 'reduce'}
                    onChange={() => setMakeRoomMode('reduce')} /> Reduce a stock's weight
                </label>
              </div>

              {makeRoomMode !== 'none' && (
                <>
                  <select value={makeRoomCode} onChange={e => { setMakeRoomCode(e.target.value); setReduceBy(''); }} style={{ width: '100%' }}>
                    <option value="">Select a stock…</option>
                    {eligibleForRoom.map(s => (
                      <option key={s.nseCode} value={s.nseCode}>{s.nseCode} — {s.allocationPct.toFixed(2)}%</option>
                    ))}
                  </select>

                  {makeRoomMode === 'replace' && makeRoomCode && (
                    <div className="sit-label" style={{ marginTop: '0.4rem' }}>
                      {makeRoomCode} will be fully removed from the simulation, freeing {selectedStockPct.toFixed(2)}%.
                    </div>
                  )}

                  {makeRoomMode === 'reduce' && makeRoomCode && (
                    <input type="number" placeholder={`Reduce by % (max ${selectedStockPct.toFixed(2)}%)`}
                      value={reduceBy} onChange={e => setReduceBy(e.target.value)} style={{ width: '100%', marginTop: '0.4rem' }} />
                  )}
                </>
              )}

              {priceWarn && <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>{priceWarn}</div>}
              {reduceInvalid && makeRoomCode && (
                <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>
                  Enter a reduction between 0% and {selectedStockPct.toFixed(2)}%.
                </div>
              )}
              {overCap && <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>Would exceed 100% total allocation ({(100 - liveTotalPct).toFixed(2)}% free).</div>}
              {error && <div className="whatif-warn" style={{ marginTop: '0.5rem' }}>{error}</div>}
            </div>
            <div className="whatif-footer">
              <button className="btn btn-secondary" onClick={closeModal} style={{ fontSize: '0.78rem' }}>Cancel</button>
              <button
                className="btn btn-secondary"
                disabled={overCap || fetching || (makeRoomMode !== 'none' && !makeRoomCode) || reduceInvalid}
                onClick={handleAddStock}
                style={{ fontSize: '0.78rem' }}
              >
                {fetching ? 'Adding…' : 'Add hypothetical stock'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
