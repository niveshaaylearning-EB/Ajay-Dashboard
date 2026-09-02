"""Live price serving (/api/live*), listing-price lookup, and sector fetching.
Delegates the actual price fetching to price_engine.py's fetch_live_batch()/
fetch_live_single(), and cost-basis math to buy_price_gains.py."""
import re

import httpx
from fastapi import APIRouter, HTTPException

from buy_price_gains import (
    _wavg_cost_basis, _date_to_ts, _fetch_ohlc_avg,
    _parse_buy_events, _current_series_buy_events,
    _fetch_open_price_for_listing,
)
from persistence import (
    _load_buy_price_data, _save_buy_price_data,
    _load_portfolios, _save_portfolios,
)
from price_engine import fetch_live_batch, fetch_live_single, fetch_performance_batch, _NSE_HEADERS, _get_via_proxies

router = APIRouter()

@router.get("/api/listing-price/{nse_code}")
async def get_listing_price(nse_code: str, date: str):
    """Return the opening price of a stock on its listing date."""
    code  = nse_code.strip().upper()
    price = await _fetch_open_price_for_listing(code, date)
    return {"price": price}


@router.get("/api/live")
async def get_live_all():
    return await fetch_live_batch()


@router.get("/api/performance")
async def get_performance_batch(codes: str):
    """
    Multi-tenure performance for a comma-separated list of NSE codes:
    {code: {"1M": pct, "3M": pct, "6M": pct, "1Y": pct, "2Y": pct, "3Y": pct, "5Y": pct}}
    A tenure is null for a code if there isn't enough price history to cover it
    (e.g. a recently-listed stock has no 5Y bar yet) -- the frontend separately
    gates which tenures it *shows* per stock based on the user's holding period.
    """
    code_list = [c.strip().upper() for c in codes.split(",") if c.strip()]
    if not code_list:
        return {}
    return await fetch_performance_batch(code_list)


@router.get("/api/live/{nse_code}")
async def get_live_single(nse_code: str, fast: bool = False):
    """`fast=true` is for callers that only need CMP/OHLC for a single,
    typically-not-already-tracked stock (e.g. the what-if "Add Hypothetical
    Stock" flow) -- skips both the Market Cap/PE cascade AND the whole-
    portfolio batch cache check. That batch check is normally free (serves a
    warm cache instantly), but when the cache is cold (fresh server start, or
    just past its TTL with nobody having loaded a dashboard yet) it triggers
    a full refresh of every tracked stock, which can take 10+ seconds --
    wasted work for a stock this flow expects to be a cache miss anyway.
    """
    code = nse_code.strip().upper()
    if fast:
        result = await fetch_live_single(code, skip_mc_pe=True)
        return result or {"cmp": None, "close1M": None, "open1M": None, "high1M": None, "low1M": None}

    cache = await fetch_live_batch()
    if code in cache and cache[code].get("cmp") is not None:
        return cache[code]
    result = await fetch_live_single(code)
    if result:
        return result
    return {
        "cmp": None, "close1M": None, "open1M": None,
        "high1M": None, "low1M": None, "marketCapCr": None, "peRatio": None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Sector / Segment fetching  (NSE India → Yahoo Finance → Screener.in)
# ─────────────────────────────────────────────────────────────────────────────

_SECTOR_RE = re.compile(
    r'(?:class="[^"]*tag[^"]*"|href="/screens/[^"]*")\s*[^>]*>([^<]{2,60})</a>',
    re.IGNORECASE,
)

async def _fetch_sector(code: str) -> str | None:
    """Try NSE India → Yahoo Finance → Screener.in to get the sector/industry name."""

    # 1. NSE India ──────────────────────────────────────────────────────────────
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=15.0,
            headers={"User-Agent": _NSE_HEADERS["User-Agent"],
                     "Accept": "text/html,application/xhtml+xml"},
        ) as client:
            await client.get("https://www.nseindia.com", timeout=10.0)
            resp = await client.get(
                f"https://www.nseindia.com/api/quote-equity?symbol={code}",
                headers=_NSE_HEADERS, timeout=12.0,
            )
        if resp.status_code == 200:
            data = resp.json()
            industry = (
                (data.get("metadata") or {}).get("industry") or
                (data.get("info")     or {}).get("industry")
            )
            if industry and industry.strip() not in ("", "-"):
                return industry.strip()
    except Exception:
        pass

    # 2. Yahoo Finance ──────────────────────────────────────────────────────────
    try:
        url = (f"https://query1.finance.yahoo.com/v11/finance/quoteSummary/{code}.NS"
               "?modules=assetProfile")
        async with httpx.AsyncClient(timeout=10.0,
                                     headers={"User-Agent": "Mozilla/5.0"}) as client:
            resp = await client.get(url)
        if resp.status_code == 200:
            qs = resp.json().get("quoteSummary") or {}
            results = (qs.get("result") or [{}])
            sector = (results[0].get("assetProfile") or {}).get("sector") if results else None
            if sector and sector.strip():
                return sector.strip()
    except Exception:
        pass

    # 3. Screener.in ────────────────────────────────────────────────────────────
    try:
        for path in [f"/company/{code}/consolidated/", f"/company/{code}/"]:
            html = await _get_via_proxies(f"https://www.screener.in{path}", timeout=13.0)
            if html:
                m = _SECTOR_RE.search(html)
                if m:
                    val = m.group(1).strip()
                    if val and val.lower() not in ("", "screener", "home"):
                        return val
                break
    except Exception:
        pass

    return None


# ─────────────────────────────────────────────────────────────────────────────
# CSV Rebalance Upload
# ─────────────────────────────────────────────────────────────────────────────



def _fifo_cost_basis(
    series_buys: list[tuple[str, float]],
    prior_sells: list[tuple[str, float]],
    sell_qty: float,
    buy_ohlc: dict,
) -> float | None:
    """FIFO-weighted average buy price for selling sell_qty units."""
    buy_queue = sorted(
        [{"date": d, "remaining": q, "price": buy_ohlc.get(d)} for d, q in series_buys],
        key=lambda e: _date_to_ts(e["date"]),
    )
    # drain all prior sells through the FIFO queue
    for _, prev_qty in sorted(prior_sells, key=lambda e: _date_to_ts(e[0])):
        rem = prev_qty
        for lot in buy_queue:
            if rem < 1e-6:
                break
            if lot["remaining"] < 1e-6:
                continue
            take = min(lot["remaining"], rem)
            lot["remaining"] = round(lot["remaining"] - take, 6)
            rem = round(rem - take, 6)
    # consume sell_qty and compute cost
    total_cost = total_qty = 0.0
    rem = sell_qty
    for lot in buy_queue:
        if rem < 1e-6:
            break
        if lot["remaining"] < 1e-6 or lot["price"] is None:
            continue
        take = min(lot["remaining"], rem)
        lot["remaining"] = round(lot["remaining"] - take, 6)
        rem = round(rem - take, 6)
        total_cost += take * lot["price"]
        total_qty  += take
    return round(total_cost / total_qty, 4) if total_qty > 1e-6 else None


async def _fetch_rebalance_prices(basket: str, date_str: str,
                                  new_codes: list, sell_codes: list) -> None:
    """Background: fetch OHLC on rebalance date; store in buy/sellOHLC;
    compute FIFO (partial sell) or weighted-avg (wholly sold) cost basis."""
    try:
        bp_data      = _load_buy_price_data()
        basket_bp    = bp_data.get(basket, {})
        portfolios   = _load_portfolios()
        basket_stocks = portfolios.get(basket, [])
        sold         = portfolios.get(f"{basket}_sold", [])
        stk_map      = {s["nseCode"]: s for s in basket_stocks}
        pf_changed   = False
        bp_changed   = False

        rebalance_ts = _date_to_ts(date_str)

        # Buy price + sector for newly added stocks
        for code in new_codes:
            price, buy_fallback = await _fetch_ohlc_avg(code, date_str)
            if price:
                det = basket_bp.get(code)
                if det is not None:
                    ohlc = det.setdefault("buyOHLC", {})
                    if date_str not in ohlc:
                        ohlc[date_str] = price
                        bp_changed = True
                    if buy_fallback:
                        det.setdefault("buyOHLC_fallback", {})[date_str] = buy_fallback
                        bp_changed = True
                if code in stk_map and not stk_map[code].get("buyPrice"):
                    stk_map[code]["buyPrice"] = price
                    pf_changed = True

            # Fetch sector if missing or still at default "Equity"
            det = basket_bp.get(code)
            if det is not None:
                current_seg = (det.get("segment") or "").strip()
                if current_seg.lower() in ("", "equity"):
                    sector = await _fetch_sector(code)
                    if sector:
                        det["segment"] = sector
                        bp_changed = True

        # Also fill missing segment for ALL stocks in the basket, not just new ones
        for code, det in basket_bp.items():
            if code in new_codes:
                continue  # already handled above
            current_seg = (det.get("segment") or "").strip()
            if current_seg.lower() in ("", "equity"):
                sector = await _fetch_sector(code)
                if sector:
                    det["segment"] = sector
                    bp_changed = True

        # Sell events: fetch sell OHLC; compute cost basis
        for code in sell_codes:
            sell_price, sell_fallback = await _fetch_ohlc_avg(code, date_str)
            buy_price  = None

            det = basket_bp.get(code)
            if det is not None:
                if sell_price:
                    sohlc = det.setdefault("sellOHLC", {})
                    if date_str not in sohlc:
                        sohlc[date_str] = sell_price
                        bp_changed = True
                    if sell_fallback:
                        det.setdefault("sellOHLC_fallback", {})[date_str] = sell_fallback
                        bp_changed = True

                all_buy  = _parse_buy_events(det.get("buyEvents")  or "")
                all_sell = _parse_buy_events(det.get("sellEvents") or "")
                buy_ohlc = det.get("buyOHLC") or {}

                # Only consider events at or before the rebalance date for buy;
                # strictly before for prior sells (exclude this event)
                prior_buys  = [(d, q) for d, q in all_buy
                               if _date_to_ts(d) <= rebalance_ts]
                prior_sells = [(d, q) for d, q in all_sell
                               if _date_to_ts(d) < rebalance_ts]
                series_buys = _current_series_buy_events(prior_buys, prior_sells)

                is_wholly_sold = code not in stk_map
                if is_wholly_sold:
                    buy_price = _wavg_cost_basis(series_buys, buy_ohlc)
                else:
                    sell_qty = next((q for d, q in all_sell if d == date_str), None)
                    if sell_qty is not None:
                        buy_price = _fifo_cost_basis(series_buys, prior_sells, sell_qty, buy_ohlc)

            for ev in sold:
                if ev["nseCode"] == code and ev["date"] == date_str:
                    if sell_price and ev.get("sellPrice") is None:
                        ev["sellPrice"] = sell_price
                        pf_changed = True
                    if buy_price and ev.get("buyPrice") is None:
                        ev["buyPrice"] = buy_price
                        pf_changed = True

        if pf_changed:
            portfolios[basket] = basket_stocks
            portfolios[f"{basket}_sold"] = sold
            _save_portfolios(portfolios)
        if bp_changed:
            _save_buy_price_data(bp_data)
    except Exception:
        pass

