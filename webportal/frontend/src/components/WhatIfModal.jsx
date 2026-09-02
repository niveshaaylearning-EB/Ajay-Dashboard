import { useEffect, useMemo, useRef, useState } from 'react';
import { currentSeriesBuyEvents, parseEventLines, formatPercent, formatRupee, getColorClass } from '../App.jsx';
import { EMPTY_SLOT, applyEditToRow, applySellEditToRow, weightedSellGainPct, computeWhatIf, toIsoDate, fromIsoDate, applySellToSlot, undoSoldEntry } from '../whatIfCalc.js';
import { fetchOhlcLookup, fetchCaStatus } from '../api/client.js';

const CA_TYPE_LABEL = { split: 'stock split', bonus: 'bonus issue', demerger: 'demerger' };

export default function WhatIfModal({ nse, basketKey, basketMeta, rows, simOverlay, setSimOverlay, onClose }) {
  const overlayRef = useRef(null);
  const slot = simOverlay[basketKey] || EMPTY_SLOT;

  const det = basketMeta.buyPriceDetails?.[nse] || {};
  const historyEntry = basketMeta.history?.[nse] || null;

  // A stock fully exited and later re-bought has its earlier history split
  // into prevBuyEvents/prevSellEvents by the backend, but that's a storage
  // detail, not a real boundary -- it's still ONE continuous ledger. Feeding
  // the FULL combined history (not just the current series) into the same
  // FIFO netting the backend itself uses means editing an OLD sell correctly
  // cascades into what's held today: reduce how much was sold back then and
  // the leftover lot reappears as an open buy lot below, exactly as if that
  // sell genuinely hadn't fully closed the position out.
  const combinedBuyEventsStr = useMemo(
    () => [det.prevBuyEvents, det.buyEvents].filter(Boolean).join('\n'),
    [det.prevBuyEvents, det.buyEvents]
  );
  const dateSort = (a, b) => toIsoDate(a.date).localeCompare(toIsoDate(b.date));

  // Every sell ever recorded for this stock, prev-series and current alike --
  // all equally editable (see comment above).
  const realSellSeries = useMemo(() => {
    const prev = parseEventLines(det.prevSellEvents).map(e => ({ date: e.date, weight: e.qty, ohlc: det.sellOHLC?.[e.date] ?? null }));
    const curr = parseEventLines(det.sellEvents).map(e => ({ date: e.date, weight: e.qty, ohlc: det.sellOHLC?.[e.date] ?? null }));
    return [...prev, ...curr].sort(dateSort);
  }, [det.prevSellEvents, det.sellEvents, det.sellOHLC]);
  const sellEvents = slot.editedSells?.[nse]?.events || realSellSeries;

  // The (possibly-edited) sell events, formatted back into the "DD Mon YYYY
  // * qty" line format currentSeriesBuyEvents expects, so an edit here feeds
  // straight back into the buy-lot netting below.
  const effectiveSellEventsStr = useMemo(
    () => sellEvents.map(e => `${e.date} * ${e.weight}`).join('\n'),
    [sellEvents]
  );

  const realSeries = useMemo(
    () => currentSeriesBuyEvents(combinedBuyEventsStr, effectiveSellEventsStr)
      .map(e => ({ date: e.date, weight: e.weight, ohlc: det.buyOHLC?.[e.date] ?? null })),
    [combinedBuyEventsStr, effectiveSellEventsStr, det.buyOHLC]
  );

  const events = slot.editedBuys[nse]?.events || realSeries;

  const [ohlcWarn, setOhlcWarn] = useState({});
  const [weightWarn, setWeightWarn] = useState({});
  const [sellOhlcWarn, setSellOhlcWarn] = useState({});
  const [sellWeightWarn, setSellWeightWarn] = useState({});
  const [caRecords, setCaRecords] = useState([]);
  const latestRequestRef = useRef({});
  const dateDebounceRef = useRef({});
  const sellLotLatestRequestRef = useRef({});
  const sellLotDateDebounceRef = useRef({});
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    return () => {
      Object.values(dateDebounceRef.current).forEach(clearTimeout);
      Object.values(sellLotDateDebounceRef.current).forEach(clearTimeout);
    };
  }, []);

  // Surface any pending/approved corporate action for this stock -- explains
  // upfront why buy-lot prices might look inconsistent (e.g. a split whose
  // ex-date falls between two lots), rather than leaving the user to wonder.
  useEffect(() => {
    let cancelled = false;
    fetchCaStatus(basketKey, nse).then(res => {
      if (!cancelled) setCaRecords(res?.records || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [basketKey, nse]);

  const patchSlot = (patchFn) => {
    setSimOverlay(prev => {
      const prevSlot = prev[basketKey] || EMPTY_SLOT;
      return { ...prev, [basketKey]: patchFn(prevSlot) };
    });
  };

  // Pure -- builds what editedBuys[nse] would become after `patch` is applied
  // to event `idx`, without committing it. Shared by updateEvent (which always
  // commits) and handleWeightChange (which previews the result first to
  // enforce the 100% cap before committing).
  const computeEditedEntry = (fromSlot, idx, patch) => {
    const existing = fromSlot.editedBuys[nse];
    const baseEvents = existing?.events || realSeries;
    const nextEvents = baseEvents.map((e, i) => (i === idx ? { ...e, ...patch } : e));
    const baseTotalQty   = existing?.baseTotalQty   ?? realSeries.reduce((s, e) => s + (e.weight || 0), 0);
    const baseAllocation = existing?.baseAllocation ?? (rows.find(r => r.nseCode === nse)?.allocation ?? 0);
    return { events: nextEvents, baseTotalQty, baseAllocation };
  };

  const updateEvent = (idx, patch) => {
    patchSlot(prevSlot => ({
      ...prevSlot,
      editedBuys: { ...prevSlot.editedBuys, [nse]: computeEditedEntry(prevSlot, idx, patch) },
    }));
  };

  // Weight edits change this stock's simulated allocation, which can push the
  // portfolio's total over 100% -- unlike date/OHLC edits, which never touch
  // allocation. Preview the resulting total before committing and reject the
  // edit (rather than silently letting the total exceed 100%) if it would.
  const handleWeightChange = (idx, rawValue) => {
    const newWeight = rawValue === '' ? 0 : parseFloat(rawValue);
    if (isNaN(newWeight) || newWeight < 0) return;

    const prospectiveEntry = computeEditedEntry(slot, idx, { weight: newWeight });
    const prospectiveSlot  = { ...slot, editedBuys: { ...slot.editedBuys, [nse]: prospectiveEntry } };
    const prospectiveTotalPct = computeWhatIf(rows, prospectiveSlot).totalAllocation * 100;

    if (prospectiveTotalPct > 100.0001) {
      setWeightWarn(w => ({ ...w, [idx]: `Would push total allocation to ${prospectiveTotalPct.toFixed(2)}% — capped at 100%. Reduce the weight.` }));
      return;
    }
    setWeightWarn(w => ({ ...w, [idx]: null }));
    updateEvent(idx, { weight: newWeight });
  };

  // A native date input fires onChange per segment (day/month/year) as it's
  // filled -- e.g. editing just the day of an existing full date produces a
  // complete, valid, but WRONG intermediate date on every keystroke before
  // landing on the final one. Each of those intermediate dates used to fire
  // its own OHLC lookup immediately; `latestRequestRef` was meant to let only
  // the last one win, but in practice the final lookup could still lose a
  // response-ordering race against an earlier intermediate one, leaving the
  // OLD price on screen even though the date field shows the new date.
  // Debouncing so only the value the user actually settles on ever fires a
  // request removes that race entirely, rather than trying to out-guess it.
  const fetchAndApplyOhlc = async (idx, newDate) => {
    const requestKey = newDate;
    latestRequestRef.current[idx] = requestKey;
    try {
      const res = await fetchOhlcLookup(nse, newDate);
      if (latestRequestRef.current[idx] !== requestKey) return;
      if (res && res.price != null) {
        updateEvent(idx, { date: newDate, ohlc: res.price });
        // Sanity-check against this stock's OTHER lots: a live re-fetch can
        // land on a split/bonus-adjusted price (data providers apply splits
        // retroactively to their whole history) while sibling lots still hold
        // whatever was stored before the adjustment -- exactly the "why is
        // one lot 10x the others" confusion a partial re-fetch can create.
        // Reads eventsRef (kept fresh every render) rather than the `events`
        // closure captured when this async call started, in case other lots
        // changed in the meantime.
        const siblingPrices = eventsRef.current.filter((e, j) => j !== idx && e.ohlc != null).map(e => e.ohlc);
        if (siblingPrices.length > 0) {
          const siblingAvg = siblingPrices.reduce((s, v) => s + v, 0) / siblingPrices.length;
          const ratio = siblingAvg > 0 ? res.price / siblingAvg : 1;
          if (ratio > 3 || ratio < 1 / 3) {
            setOhlcWarn(w => ({ ...w, [idx]: `This is ${ratio >= 1 ? ratio.toFixed(1) + '×' : '1/' + (1 / ratio).toFixed(1)} this stock's other buy lots (avg ${'₹'}${siblingAvg.toFixed(2)}) — likely an unrecorded stock split/bonus. Check Corporate Actions before trusting this comparison.` }));
            return;
          }
        }
        setOhlcWarn(w => ({ ...w, [idx]: null }));
      } else {
        setOhlcWarn(w => ({ ...w, [idx]: 'No price data for this date — enter the price manually.' }));
      }
    } catch {
      if (latestRequestRef.current[idx] !== requestKey) return;
      setOhlcWarn(w => ({ ...w, [idx]: 'Lookup failed — enter the price manually.' }));
    }
  };

  const handleDateChange = (idx, isoValue) => {
    const newDate = fromIsoDate(isoValue);
    const prevDate = events[idx]?.date;
    updateEvent(idx, { date: newDate });
    if (!newDate || newDate === prevDate) return; // no real change -- skip the network round-trip entirely

    if (dateDebounceRef.current[idx]) clearTimeout(dateDebounceRef.current[idx]);
    dateDebounceRef.current[idx] = setTimeout(() => {
      fetchAndApplyOhlc(idx, newDate);
    }, 500);
  };

  // ── Sell-lot editing -- mirrors the buy-lot handlers above exactly, but for
  // this stock's CURRENT SERIES sell events. A sell-lot weight edit is the
  // inverse of a buy-lot one: recording a SMALLER sell means MORE is
  // retained today (allocation goes up), so it gets the same 100%-cap
  // preview-before-commit treatment.
  const computeEditedSellEntry = (fromSlot, idx, patch) => {
    const existing = fromSlot.editedSells?.[nse];
    const baseEvents = existing?.events || realSellSeries;
    const nextEvents = baseEvents.map((e, i) => (i === idx ? { ...e, ...patch } : e));
    const baseTotalQty   = existing?.baseTotalQty   ?? realSellSeries.reduce((s, e) => s + (e.weight || 0), 0);
    const baseAllocation = existing?.baseAllocation ?? (rows.find(r => r.nseCode === nse)?.allocation ?? 0);
    return { events: nextEvents, baseTotalQty, baseAllocation };
  };

  const updateSellEvent = (idx, patch) => {
    patchSlot(prevSlot => ({
      ...prevSlot,
      editedSells: { ...(prevSlot.editedSells || {}), [nse]: computeEditedSellEntry(prevSlot, idx, patch) },
    }));
  };

  const handleSellWeightChange = (idx, rawValue) => {
    const newWeight = rawValue === '' ? 0 : parseFloat(rawValue);
    if (isNaN(newWeight) || newWeight < 0) return;

    const prospectiveEntry = computeEditedSellEntry(slot, idx, { weight: newWeight });
    const prospectiveSlot  = { ...slot, editedSells: { ...(slot.editedSells || {}), [nse]: prospectiveEntry } };
    const prospectiveTotalPct = computeWhatIf(rows, prospectiveSlot).totalAllocation * 100;

    if (prospectiveTotalPct > 100.0001) {
      setSellWeightWarn(w => ({ ...w, [idx]: `Would push total allocation to ${prospectiveTotalPct.toFixed(2)}% — capped at 100%. Increase the weight sold instead.` }));
      return;
    }
    setSellWeightWarn(w => ({ ...w, [idx]: null }));
    updateSellEvent(idx, { weight: newWeight });
  };

  const fetchAndApplySellLotOhlc = async (idx, newDate) => {
    const requestKey = newDate;
    sellLotLatestRequestRef.current[idx] = requestKey;
    try {
      const res = await fetchOhlcLookup(nse, newDate);
      if (sellLotLatestRequestRef.current[idx] !== requestKey) return;
      if (res && res.price != null) {
        updateSellEvent(idx, { date: newDate, ohlc: res.price });
        setSellOhlcWarn(w => ({ ...w, [idx]: null }));
      } else {
        setSellOhlcWarn(w => ({ ...w, [idx]: 'No price data for this date — enter the price manually.' }));
      }
    } catch {
      if (sellLotLatestRequestRef.current[idx] !== requestKey) return;
      setSellOhlcWarn(w => ({ ...w, [idx]: 'Lookup failed — enter the price manually.' }));
    }
  };

  const handleSellLotDateChange = (idx, isoValue) => {
    const newDate = fromIsoDate(isoValue);
    const prevDate = sellEvents[idx]?.date;
    updateSellEvent(idx, { date: newDate });
    if (!newDate || newDate === prevDate) return;

    if (sellLotDateDebounceRef.current[idx]) clearTimeout(sellLotDateDebounceRef.current[idx]);
    sellLotDateDebounceRef.current[idx] = setTimeout(() => {
      fetchAndApplySellLotOhlc(idx, newDate);
    }, 500);
  };

  const isDeleted = slot.deletedNse.includes(nse);

  const before = useMemo(() => computeWhatIf(rows, EMPTY_SLOT), [rows]);
  const after  = useMemo(() => computeWhatIf(rows, slot), [rows, slot]);

  const realRow    = rows.find(r => r.nseCode === nse) || null;
  const currentEdit = slot.editedBuys[nse];
  const currentSellEdit = slot.editedSells?.[nse];
  const revisedRow  = isDeleted ? null : applySellEditToRow(applyEditToRow(realRow, currentEdit), currentSellEdit);

  const resetThisStock = () => patchSlot(prevSlot => {
    const editedBuys = { ...prevSlot.editedBuys };
    delete editedBuys[nse];
    const editedSells = { ...(prevSlot.editedSells || {}) };
    delete editedSells[nse];
    const weightReductions = { ...prevSlot.weightReductions };
    delete weightReductions[nse];
    return {
      ...prevSlot, editedBuys, editedSells, weightReductions,
      deletedNse: prevSlot.deletedNse.filter(n => n !== nse),
      sold: (prevSlot.sold || []).filter(s => s.nseCode !== nse),
    };
  });

  const resetAll = () => setSimOverlay(prev => ({
    ...prev, [basketKey]: { editedBuys: {}, editedSells: {}, deletedNse: [], added: [], weightReductions: {}, sold: [] },
  }));

  // ── Sell (simulation only) -- same shared logic as the standalone Sell bar,
  // scoped to this one stock so no stock-picker is needed here.
  const soldForThisStock = (slot.sold || []).filter(s => s.nseCode === nse);
  const [sellMode, setSellMode] = useState('full');
  const [sellWeight, setSellWeight] = useState('');
  const [sellDate, setSellDate] = useState('');
  const [sellPrice, setSellPrice] = useState('');
  const [sellError, setSellError] = useState('');
  const [sellPriceWarn, setSellPriceWarn] = useState('');
  const sellLatestRequestRef = useRef('');

  // NOT revisedRow.allocation -- that only reflects editedBuys (buy-lot
  // edits), not weightReductions from a prior partial sell. after.overlaid
  // (via computeWhatIf) is the one place that already applies both.
  const remainingPct = ((after.overlaid.find(r => r.nseCode === nse)?.allocation) || 0) * 100;
  const sellWeightNum = parseFloat(sellWeight) || 0;
  const partialInvalid = sellMode === 'partial' && (sellWeightNum <= 0 || sellWeightNum > remainingPct + 0.0001);
  const sellGainPct = (revisedRow?.buyPrice && parseFloat(sellPrice) > 0)
    ? (parseFloat(sellPrice) - revisedRow.buyPrice) / revisedRow.buyPrice
    : null;

  const tryAutoFetchSellPrice = async (date) => {
    if (!date) return;
    const requestKey = date;
    sellLatestRequestRef.current = requestKey;
    setSellPriceWarn('');
    try {
      const res = await fetchOhlcLookup(nse, date);
      if (sellLatestRequestRef.current !== requestKey) return;
      if (res && res.price != null) setSellPrice(String(res.price));
      else setSellPriceWarn('No price data for this date — enter the price manually.');
    } catch {
      if (sellLatestRequestRef.current !== requestKey) return;
      setSellPriceWarn('Lookup failed — enter the price manually.');
    }
  };

  const handleSellDateChange = (isoValue) => {
    const newDate = fromIsoDate(isoValue);
    setSellDate(newDate);
    if (newDate) tryAutoFetchSellPrice(newDate);
  };

  const handleSellSubmit = () => {
    setSellError('');
    if (!sellDate) { setSellError('Pick a sell date.'); return; }
    const price = parseFloat(sellPrice);
    if (!price || price <= 0) { setSellError('Enter a sell OHLC price.'); return; }
    if (sellMode === 'partial' && partialInvalid) {
      setSellError(`Enter a weight between 0% and ${remainingPct.toFixed(2)}%.`);
      return;
    }
    const weightSold = sellMode === 'full' ? remainingPct : sellWeightNum;
    patchSlot(prevSlot => applySellToSlot(prevSlot, {
      nseCode: nse, weightSold, sellDate, sellPrice: price,
      buyPrice: revisedRow?.buyPrice ?? null, full: sellMode === 'full',
    }));
    setSellMode('full'); setSellWeight(''); setSellDate(''); setSellPrice(''); setSellPriceWarn('');
  };

  return (
    <div className="whatif-overlay" ref={overlayRef} onClick={e => { if (e.target === overlayRef.current) onClose(); }}>
      <div className="whatif-modal">
        <div className="whatif-header">
          <span className="sit-symbol" style={{ background: 'transparent', border: 'none', padding: 0 }}>
            NSE: {nse}
          </span>
          <button className="whatif-close" onClick={onClose}>&times;</button>
        </div>

        <div className="whatif-body">
          {caRecords.length > 0 && (
            <div className="whatif-ca-warning">
              {caRecords.map((r, i) => (
                <div key={i}>
                  ⚠ {r.status === 'approved' ? 'Approved' : 'Pending'} {CA_TYPE_LABEL[r.type] || r.type}
                  {r.ratio && r.type !== 'demerger' ? ` (${r.ratio.old ?? r.ratio.existing}:${r.ratio.new ?? r.ratio.bonus})` : ''}
                  {' '}with ex-date {r.exDate}. Buy lots before this date may show inconsistent prices
                  {r.status === 'pending_review' ? ' until this is reviewed and approved' : ''} — see Corporate Actions.
                </div>
              ))}
            </div>
          )}

          <div className="sit-row">
            <span className="sit-label">Added to Portfolio</span>
            <span className="sit-date">{historyEntry?.added || '—'}</span>
          </div>

          <div className="whatif-section-title">Rebalancing History</div>
          {(!historyEntry || historyEntry.rebalances.length === 0) ? (
            <div className="sit-no-data">No rebalancing records yet.</div>
          ) : (
            historyEntry.rebalances.map((r, i) => (
              <div key={i} className="sit-rebal-row">
                <span className="sit-rebal-date">{r.date}</span>
                <span>{r.note}</span>
              </div>
            ))
          )}

          <div className="whatif-section-title">What-If: Current Buy Lots</div>
          {isDeleted ? (
            <div className="sit-no-data">This stock is simulated as fully sold. Undo it in "Sell Stock" below to restore it.</div>
          ) : events.length === 0 ? (
            <div className="sit-no-data">No open buy lots to simulate.</div>
          ) : (
            events.map((e, i) => (
              <div key={i} className="whatif-buyrow">
                <input
                  type="date" value={toIsoDate(e.date)}
                  onChange={ev => handleDateChange(i, ev.target.value)}
                  style={{ width: '9.5rem' }}
                />
                <input
                  type="number" step="0.01" value={e.weight ?? ''} placeholder="Weight"
                  onChange={ev => handleWeightChange(i, ev.target.value)}
                  style={{ width: '4.6rem' }}
                />
                <span className="sit-label">% wt</span>
                <input
                  type="number" step="0.01" value={e.ohlc ?? ''} placeholder="OHLC"
                  onChange={ev => updateEvent(i, { ohlc: ev.target.value === '' ? null : parseFloat(ev.target.value) })}
                  style={{ width: '6rem' }}
                />
                {ohlcWarn[i] && <span className="whatif-warn">{ohlcWarn[i]}</span>}
                {weightWarn[i] && <span className="whatif-warn">{weightWarn[i]}</span>}
              </div>
            ))
          )}

          <div className="whatif-section-title">What-If: Sell Lots</div>
          {isDeleted ? (
            <div className="sit-no-data">This stock is simulated as fully sold — its sell lots aren't relevant right now.</div>
          ) : sellEvents.length === 0 ? (
            <div className="sit-no-data">No sell events recorded for this stock.</div>
          ) : (
            sellEvents.map((e, i) => {
              const rowGainPct = (revisedRow?.buyPrice && e.ohlc != null)
                ? (e.ohlc - revisedRow.buyPrice) / revisedRow.buyPrice
                : null;
              return (
                <div key={i} className="whatif-buyrow">
                  <input
                    type="date" value={toIsoDate(e.date)}
                    onChange={ev => handleSellLotDateChange(i, ev.target.value)}
                    style={{ width: '9.5rem' }}
                  />
                  <input
                    type="number" step="0.01" value={e.weight ?? ''} placeholder="Weight"
                    onChange={ev => handleSellWeightChange(i, ev.target.value)}
                    style={{ width: '4.6rem' }}
                  />
                  <span className="sit-label">% wt</span>
                  <input
                    type="number" step="0.01" value={e.ohlc ?? ''} placeholder="OHLC"
                    onChange={ev => updateSellEvent(i, { ohlc: ev.target.value === '' ? null : parseFloat(ev.target.value) })}
                    style={{ width: '6rem' }}
                  />
                  {rowGainPct != null && (
                    <span className={getColorClass(rowGainPct)} style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                      {formatPercent(rowGainPct)}
                    </span>
                  )}
                  {sellOhlcWarn[i] && <span className="whatif-warn">{sellOhlcWarn[i]}</span>}
                  {sellWeightWarn[i] && <span className="whatif-warn">{sellWeightWarn[i]}</span>}
                </div>
              );
            })
          )}
          <div className="sit-no-data" style={{ marginTop: '-0.2rem', marginBottom: '0.5rem' }}>
            Includes every sell ever recorded for this stock, not just recent ones -- editing a sell's weight
            simulates having sold more or less than actually happened: sell less and more is retained today
            (weight goes up, and a fully-closed-out lot can even reopen above); sell more and less is (weight
            goes down). The %/row gain shown compares that lot's OHLC price against this stock's current buy price.
          </div>

          {!isDeleted && realRow && (() => {
            // Weight edits already move Weight/Allocation above via
            // applySellEditToRow. A sell lot's PRICE or DATE edit doesn't
            // touch allocation at all (correctly -- that's not what those
            // fields mean) but it needs to move SOMETHING visible: this is
            // the realized gain on whatever's actually been sold, so editing
            // a sell's price is no longer a silent no-op.
            const sellGainBefore = weightedSellGainPct(realSellSeries, realRow.buyPrice);
            const sellGainAfter  = weightedSellGainPct(sellEvents, revisedRow?.buyPrice);
            return (
              <div className="whatif-impact">
                <div className="whatif-impact-row">
                  <span className="sit-label">Weight</span>
                  <span>{formatPercent(realRow.allocation)} &rarr; <strong>{formatPercent(revisedRow?.allocation)}</strong></span>
                </div>
                <div className="whatif-impact-row">
                  <span className="sit-label">Buy Price</span>
                  <span>{formatRupee(realRow.buyPrice)} &rarr; <strong>{formatRupee(revisedRow?.buyPrice)}</strong></span>
                </div>
                <div className="whatif-impact-row">
                  <span className="sit-label">Gain / Loss % (unrealized)</span>
                  <span>
                    <span className={getColorClass(realRow.absoluteReturns)}>{formatPercent(realRow.absoluteReturns)}</span>
                    {' → '}
                    <strong className={getColorClass(revisedRow?.absoluteReturns)}>{formatPercent(revisedRow?.absoluteReturns)}</strong>
                  </span>
                </div>
                {(sellGainBefore != null || sellGainAfter != null) && (
                  <div className="whatif-impact-row">
                    <span className="sit-label">Realized Gain % (sells)</span>
                    <span>
                      {sellGainBefore != null
                        ? <span className={getColorClass(sellGainBefore)}>{formatPercent(sellGainBefore)}</span>
                        : '—'}
                      {' → '}
                      <strong className={getColorClass(sellGainAfter)}>{sellGainAfter != null ? formatPercent(sellGainAfter) : '—'}</strong>
                    </span>
                  </div>
                )}
              </div>
            );
          })()}

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
              Buy-date/price edits move Gain %; weight edits also move Total Allocation/Contribution. 1M Returns and Since Inception track live market momentum, not buy price, so they're otherwise unaffected.
            </div>
          </div>

          <div className="whatif-section-title">Sell Stock (simulation only)</div>

          {soldForThisStock.length > 0 && (
            <div style={{ marginBottom: '0.5rem' }}>
              {soldForThisStock.map(s => (
                <div key={s.id} className="whatif-added-row">
                  <span className="sit-label">
                    {s.full ? 'Fully sold' : `${s.weightSold.toFixed(2)}% sold`} &middot; {s.sellDate} @ {formatRupee(s.sellPrice)}
                    {s.gainPct != null && (
                      <> &middot; <span className={getColorClass(s.gainPct)}>{formatPercent(s.gainPct)}</span></>
                    )}
                  </span>
                  <button className="whatif-close" onClick={() => patchSlot(prevSlot => undoSoldEntry(prevSlot, s.id))}>&times;</button>
                </div>
              ))}
            </div>
          )}

          {isDeleted ? (
            <div className="sit-no-data">This stock is simulated as fully sold — undo above to restore it.</div>
          ) : (
            <>
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
                  value={sellWeight} onChange={e => setSellWeight(e.target.value)} style={{ width: '100%', marginBottom: '0.5rem' }} />
              )}

              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem' }}>
                <input type="date" value={toIsoDate(sellDate)} onChange={e => handleSellDateChange(e.target.value)} style={{ width: '9.5rem' }} />
                <input type="number" placeholder="OHLC Sell Price" value={sellPrice} onChange={e => setSellPrice(e.target.value)} style={{ width: '8rem' }} />
              </div>

              {sellGainPct != null && (
                <div className="sit-label" style={{ marginBottom: '0.4rem' }}>
                  Simulated gain: <span className={getColorClass(sellGainPct)}>{formatPercent(sellGainPct)}</span>
                </div>
              )}
              {sellPriceWarn && <div className="whatif-warn" style={{ marginBottom: '0.4rem' }}>{sellPriceWarn}</div>}
              {partialInvalid && sellWeight && (
                <div className="whatif-warn" style={{ marginBottom: '0.4rem' }}>
                  Enter a weight between 0% and {remainingPct.toFixed(2)}%.
                </div>
              )}
              {sellError && <div className="whatif-warn" style={{ marginBottom: '0.4rem' }}>{sellError}</div>}

              <button className="btn btn-secondary" disabled={partialInvalid} onClick={handleSellSubmit} style={{ fontSize: '0.78rem' }}>
                Sell {sellMode === 'full' ? 'all' : 'part'} of {nse}
              </button>
            </>
          )}

          <div className="sit-no-data" style={{ marginTop: '0.5rem' }}>
            To add a hypothetical new stock, use the "Add Hypothetical Stock" bar at the end of the holdings table. If this sell drops total allocation below 100%, the freed-up weight is automatically parked in LIQUIDCASE.
          </div>
        </div>

        <div className="whatif-footer">
          <span className="sit-no-data" style={{ marginRight: 'auto', alignSelf: 'center' }}>Temporary — resets on refresh, never saved.</span>
          <button className="btn btn-secondary" onClick={resetThisStock} style={{ fontSize: '0.78rem' }}>Reset This Stock</button>
          <button className="btn btn-secondary" onClick={resetAll} style={{ fontSize: '0.78rem' }}>Reset All</button>
          <button className="btn btn-secondary" onClick={onClose} style={{ fontSize: '0.78rem' }}>Close</button>
        </div>
      </div>
    </div>
  );
}
