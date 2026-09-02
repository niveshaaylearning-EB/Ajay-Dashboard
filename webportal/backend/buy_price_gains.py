"""Buy-price/OHLC computation (multi-source averaging: Yahoo/Google/Screener)
and the FIFO gains-statement engine. These two domains are combined in one
module because the gains engine is computed directly from buy-price data and
the underlying route handlers are tightly interleaved in the original file.
"""
import asyncio
import json
import re
import time
import urllib.parse
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Request

from config import YF_HEADERS, YF_SYMBOL_MAP
from persistence import (
    BASKET_DISPLAY_NAMES, _GAINS_FILE,
    _load_portfolios, _save_portfolios,
    _load_buy_price_data, _save_buy_price_data,
    _load_rebalance_history, _save_rebalance_history,
    _save_gains,
    _load_undo_snapshots, _save_undo_snapshots,
    _auto_save_rollback, _push_undo_snapshot,
    _require_admin,
)

router = APIRouter()

# ── Buy Price Calculation (OHLC weighted avg) ─────────────────────────────────

_MONTH_FULL = {
    "january":1,"february":2,"march":3,"april":4,"may":5,"june":6,
    "july":7,"august":8,"september":9,"october":10,"november":11,"december":12,
    "jan":1,"feb":2,"mar":3,"apr":4,"jun":6,"jul":7,"aug":8,
    "sep":9,"oct":10,"nov":11,"dec":12,
}
_MONTH_ABBR = {
    1:"Jan",2:"Feb",3:"Mar",4:"Apr",5:"May",6:"Jun",
    7:"Jul",8:"Aug",9:"Sep",10:"Oct",11:"Nov",12:"Dec",
}

def _normalise_date(raw: str) -> str:
    """Convert 'DDth Month YYYY' or 'DD Month YYYY' to 'DD Mon YYYY'."""
    raw = raw.strip()
    # Remove ordinal suffixes: 1st 2nd 3rd 4th ... 31st
    raw = re.sub(r'(\d+)(st|nd|rd|th)\b', r'\1', raw, flags=re.IGNORECASE)
    parts = raw.split()
    if len(parts) != 3:
        return raw
    day, month, year = parts
    m = _MONTH_FULL.get(month.lower())
    if m:
        return f"{int(day):02d} {_MONTH_ABBR[m]} {year}"
    return raw


def _parse_buy_events(buy_events_str: str) -> list[tuple[str, float]]:
    """Parse 'DD Mon YYYY * qty' (or ordinal variants) → [(date_str, qty), ...]"""
    events = []
    for line in buy_events_str.strip().split('\n'):
        parts = re.split(r'[*×]', line.strip())
        if len(parts) != 2:
            continue
        try:
            date_str = _normalise_date(parts[0])
            events.append((date_str, float(parts[1].strip())))
        except ValueError:
            pass
    return events


def _total_to_delta_events(
    buy_events_total: list[tuple[str, float]],
    sell_events_delta: list[tuple[str, float]],
) -> list[tuple[str, float]]:
    """Convert total-weight buy events to delta weights for FIFO/formula use.
    Walks events chronologically; sell events (delta) reduce the running weight
    so subsequent buy deltas are computed correctly."""
    combined = (
        [(d, "buy",  q) for d, q in buy_events_total] +
        [(d, "sell", q) for d, q in sell_events_delta]
    )
    combined.sort(key=lambda e: _date_to_ts(e[0]))

    cw: float = 0.0
    result: list[tuple[str, float]] = []

    for date_str, etype, qty in combined:
        if etype == "buy":
            delta = qty - cw
            if delta > 0.001:
                result.append((date_str, round(delta, 6)))
            cw = qty
        else:
            cw = max(0.0, cw - qty)

    return result


def _compute_allocation(
    buy_events_delta: list[tuple[str, float]],
    sell_events_delta: list[tuple[str, float]],
) -> float:
    """Compute current net weight (as 0–1 fraction) from delta buy/sell events."""
    combined = (
        [(d, "buy",  q) for d, q in buy_events_delta] +
        [(d, "sell", q) for d, q in sell_events_delta]
    )
    combined.sort(key=lambda e: _date_to_ts(e[0]))

    net: float = 0.0
    for date_str, etype, qty in combined:
        if etype == "buy":
            net += qty
        else:
            net = max(0.0, net - qty)

    return round(net / 100, 6)


def _current_series_buy_events(
    buy_events: list[tuple[str, float]],
    sell_events: list[tuple[str, float]],
) -> list[tuple[str, float]]:
    """Return (date, remaining_weight) for every buy lot still open in the
    CURRENT series. Each sell consumes the OLDEST unconsumed lot(s) first
    (FIFO), reducing their remaining weight -- mirrors the same matching
    _compute_fifo_gains_for_series already uses for realized/sold gains, so
    the open-position buy price and the sold-position realized gain are
    finally based on one consistent lot-consumption model, instead of this
    function silently treating every buy lot as still fully held even after
    a later partial sell has consumed part of it. A full exit (every lot's
    remaining hits ~0) naturally "resets" the series because the next buy
    simply appends to what is by then an empty list -- no separate reset
    flag needed.
    """
    combined = (
        [(d, "buy",  q) for d, q in buy_events] +
        [(d, "sell", q) for d, q in sell_events]
    )
    combined.sort(key=lambda e: _date_to_ts(e[0]))

    lots: list[dict] = []
    for date_str, etype, qty in combined:
        if etype == "buy":
            lots.append({"date": date_str, "remaining": round(qty, 6)})
        else:                           # sell — FIFO-consume oldest lots first
            to_consume = qty
            for lot in lots:
                if to_consume <= 1e-6:
                    break
                take = min(lot["remaining"], to_consume)
                lot["remaining"] = round(lot["remaining"] - take, 6)
                to_consume = round(to_consume - take, 6)
            lots = [l for l in lots if l["remaining"] > 1e-6]

    return [(l["date"], l["remaining"]) for l in lots]


async def _fetch_ohlc_yahoo(nse_code: str, ts: int) -> tuple[float | None, str | None]:
    """OHLC avg from Yahoo Finance for Unix timestamp ts.
    Uses a 4-day window so weekends/holidays are handled — takes the first valid bar.
    Returns (price, actual_date_str) where actual_date_str is set only when the bar
    date differs from the requested date (i.e. a next-trading-day fallback was used)."""
    try:
        sym = YF_SYMBOL_MAP.get(nse_code, f"{nse_code}.NS")
        url = (
            f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
            f"?interval=1d&period1={ts}&period2={ts + 4 * 86400}"
        )
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        result = r.json()["chart"]["result"][0]
        q = result["indicators"]["quote"][0]
        timestamps = result.get("timestamp", [])
        for i, (o, h, l, c) in enumerate(zip(q["open"], q["high"], q["low"], q["close"])):
            if None not in (o, h, l, c):
                # Accept the bar on or nearest after the target date
                if not timestamps or timestamps[i] >= ts - 86400:
                    price = round((o + h + l + c) / 4, 4)
                    fallback_date = None
                    if timestamps:
                        actual_date = datetime.utcfromtimestamp(timestamps[i]).date()
                        target_date = datetime.utcfromtimestamp(ts).date()
                        if actual_date != target_date:
                            fallback_date = actual_date.strftime("%d %b %Y")
                    return price, fallback_date
    except Exception:
        pass
    return None, None


async def _fetch_open_price_yahoo_sym(sym: str, ts: int) -> float | None:
    """Opening price from Yahoo Finance for an explicit symbol on a given UTC timestamp."""
    try:
        url = (
            "https://query1.finance.yahoo.com/v8/finance/chart/"
            + urllib.parse.quote(sym)
            + f"?interval=1d&period1={ts}&period2={ts + 7 * 86400}"
        )
        async with httpx.AsyncClient(follow_redirects=True, timeout=15, headers=YF_HEADERS) as client:
            r = await client.get(url)
        if r.status_code != 200:
            return None
        chart = r.json().get("chart") or {}
        results = chart.get("result") or []
        if not results:
            return None
        result = results[0]
        q = (result.get("indicators") or {}).get("quote") or [{}]
        q = q[0]
        timestamps = result.get("timestamp") or []
        for i, o in enumerate(q.get("open") or []):
            if o is not None:
                if not timestamps or timestamps[i] >= ts - 86400:
                    return round(o, 2)
    except Exception:
        pass
    return None


async def _fetch_open_price_for_listing(nse_code: str, date_str: str) -> float | None:
    """Opening price on listing date — tries YF_SYMBOL_MAP override, then .NS,
    then -SM.NS (Yahoo's small-cap/SME suffix). If Yahoo has nothing at all for
    the code (common for very fresh or BSE-only/illiquid SME IPO listings),
    falls back to the same Google Finance / Screener.in OHLC-average chain the
    general ohlc-lookup endpoint already uses -- an approximate day-of-listing
    reference price beats leaving buyPrice permanently empty."""
    dt = None
    for fmt in ("%d %b %Y", "%d-%b-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            break
        except ValueError:
            continue
    if dt is None:
        return None
    ts = int(dt.replace(tzinfo=timezone.utc).timestamp())

    if nse_code in YF_SYMBOL_MAP:
        val = await _fetch_open_price_yahoo_sym(YF_SYMBOL_MAP[nse_code], ts)
    else:
        # Try .NS first, then SME fallback
        val = await _fetch_open_price_yahoo_sym(f"{nse_code}.NS", ts)
        if val is None:
            val = await _fetch_open_price_yahoo_sym(f"{nse_code}-SM.NS", ts)
    if val is not None:
        return val

    val, _ = await _fetch_ohlc_google(nse_code, dt)
    if val is not None:
        return val
    val, _ = await _fetch_ohlc_screener(nse_code, dt)
    return val


async def _backfill_ipo_listing_prices() -> None:
    """Fetch opening price for IPO stocks that have a listingDate but no buyPrice yet.
    Fetches all missing prices in parallel, then persists portfolios.json."""
    try:
        bp_data    = _load_buy_price_data()
        basket_bp  = bp_data.get("IPO_Recommendations", {})
        portfolios = _load_portfolios()
        stk_map    = {s["nseCode"]: s for s in portfolios.get("IPO_Recommendations", [])}

        to_fetch = [
            (code, det["listingDate"].strip())
            for code, det in basket_bp.items()
            if (det.get("listingDate") or "").strip()
            and not (stk_map.get(code, {}).get("buyPrice") or 0) > 0
        ]
        if not to_fetch:
            return

        prices = await asyncio.gather(
            *[_fetch_open_price_for_listing(code, date) for code, date in to_fetch],
            return_exceptions=True,
        )

        pf_changed = False
        for (code, _), price in zip(to_fetch, prices):
            if isinstance(price, Exception) or price is None:
                continue
            if code in stk_map:
                stk_map[code]["buyPrice"] = price
            else:
                entry = {"nseCode": code, "allocation": 0, "buyPrice": price}
                portfolios["IPO_Recommendations"].append(entry)
                stk_map[code] = entry
            pf_changed = True

        if pf_changed:
            _save_portfolios(portfolios)
    except Exception:
        pass


async def _fetch_ohlc_google(nse_code: str, dt: datetime) -> tuple[float | None, str | None]:
    """OHLC avg from Google Finance historical data (fallback).
    Returns (price, actual_date_str) — actual_date_str set when date differs from requested."""
    try:
        # Google Finance getprices endpoint — returns ~30 days of daily OHLC
        url = (
            f"https://finance.google.com/finance/getprices"
            f"?q={nse_code}&x=NSE&i=86400&p=40d&f=d,o,h,l,c,v&df=cpct&auto=1"
        )
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
            r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
        lines = r.text.strip().splitlines()
        # Format: first data row starts with "a<unix_ts>", subsequent rows are offset in days
        base_ts = None
        target_ts   = int(dt.replace(tzinfo=timezone.utc).timestamp())
        target_date = dt.date()
        for line in lines:
            if line.startswith("TIMEZONE_OFFSET") or line.startswith("MARKET") or line.startswith("EXCHANGE"):
                continue
            if line.startswith("a"):
                parts = line.split(",")
                base_ts = int(parts[0][1:])
                offset  = 0
            else:
                parts = line.split(",")
                try:
                    offset = int(parts[0])
                except ValueError:
                    continue
            if base_ts is None or len(parts) < 5:
                continue
            row_ts = base_ts + offset * 86400
            if abs(row_ts - target_ts) < 4 * 86400:       # within 4 days (handles weekends/holidays)
                o, c, h, l = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
                if 0 not in (o, h, l, c):
                    price       = round((o + h + l + c) / 4, 4)
                    actual_date = datetime.utcfromtimestamp(row_ts).date()
                    fallback    = actual_date.strftime("%d %b %Y") if actual_date != target_date else None
                    return price, fallback
    except Exception:
        pass
    return None, None


async def _fetch_ohlc_screener(nse_code: str, dt: datetime) -> tuple[float | None, str | None]:
    """Close price from Screener.in — last-resort fallback for stocks not on NSE
    (e.g. BSE-only IPO allotments). Returns (price, fallback_date_str_or_None)."""
    try:
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"
        api_headers = {
            "User-Agent": ua,
            "Accept": "application/json, */*",
            "Referer": "https://www.screener.in/",
            "X-Requested-With": "XMLHttpRequest",
        }
        async with httpx.AsyncClient(follow_redirects=True, timeout=15) as client:
            # Establish session cookies
            await client.get(
                f"https://www.screener.in/company/{nse_code}/consolidated/",
                headers={"User-Agent": ua},
            )
            # Resolve company ID
            search_r = await client.get(
                f"https://www.screener.in/api/company/search/?q={nse_code}&v=3&fts=1",
                headers=api_headers,
            )
            company_id = None
            for item in search_r.json():
                if f"/company/{nse_code}/" in item.get("url", ""):
                    company_id = item.get("id")
                    break
            if not company_id:
                return None, None
            # Fetch 400-day price chart
            chart_r = await client.get(
                f"https://www.screener.in/api/company/{company_id}/chart/"
                f"?q=Price-DMA50-DMA200-Volume&days=400&consolidated=true",
                headers=api_headers,
            )
            prices: dict[str, float] = {}
            for ds in chart_r.json().get("datasets", []):
                if ds.get("metric") == "Price":
                    for entry in ds.get("values", []):
                        prices[entry[0]] = float(entry[1])
                    break
        # Find price on target date or within +4 day forward window
        target_date = dt.date()
        for i in range(5):
            check = (dt + timedelta(days=i)).strftime("%Y-%m-%d")
            if check in prices:
                actual = (dt + timedelta(days=i)).date()
                fallback = actual.strftime("%d %b %Y") if actual != target_date else None
                return round(prices[check], 2), fallback
    except Exception:
        pass
    return None, None


async def _fetch_ohlc_nse_bhavcopy(nse_code: str, dt: datetime) -> float | None:
    """OHLC avg for one stock on an EXACT date, from NSE's own daily bhavcopy
    CSV archive -- tried as a same-date alternative to Yahoo specifically
    when Yahoo doesn't have that exact day (data gap, illiquid stock, etc.),
    before ever accepting a shifted next-trading-day substitute. Same
    requests-with-browser-headers approach already proven to get past NSE's
    blocking in price_engine.py's _fetch_bhavcopy_prices -- unlike the plain
    nseindia.com site/API, which 403s this server outright.
    Returns None on any failure, including weekends/holidays where NSE simply
    has no bhavcopy file for that date -- the caller already has a
    next-trading-day fallback ready to use in that case."""
    try:
        import io
        import pandas as pd
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": "https://www.nseindia.com/",
        }
        url = f"https://archives.nseindia.com/products/content/sec_bhavdata_full_{dt.strftime('%d%m%Y')}.csv"
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url, headers=headers)
        if r.status_code != 200:
            return None
        df = pd.read_csv(io.StringIO(r.text))
        if df is None or df.empty:
            return None
        df.columns = [c.strip() for c in df.columns]
        df["SYMBOL"] = df["SYMBOL"].str.strip()
        match = df[df["SYMBOL"] == nse_code.upper()]
        if match.empty:
            return None
        row = match.iloc[0]

        def _f(col):
            try:
                v = float(row.get(col, 0) or 0)
                return v if v > 0 else None
            except Exception:
                return None

        o, h, l, c = _f("OPEN_PRICE"), _f("HIGH_PRICE"), _f("LOW_PRICE"), _f("CLOSE_PRICE")
        if None in (o, h, l, c):
            return None
        return round((o + h + l + c) / 4, 4)
    except Exception:
        return None


async def _fetch_ohlc_avg(nse_code: str, date_str: str) -> tuple[float | None, str | None]:
    """Fetch OHLC avg (O+H+L+C)/4 — Yahoo Finance first (exact date), then NSE's
    own bhavcopy for that same exact date if Yahoo didn't have it, THEN Google
    Finance, then Screener.in last resort (for BSE-only / pre-listing stocks
    not on NSE) if still nothing. A next-trading-day substitute (from Yahoo,
    Google, or Screener) is only ever accepted once both Yahoo and NSE have
    been tried for the exact requested date and neither has it.
    Returns (price, fallback_date) where fallback_date is the actual date used when
    it differs from the requested date (i.e. next-trading-day fallback)."""
    dt = datetime.strptime(date_str, "%d %b %Y")
    ts = int(dt.replace(tzinfo=timezone.utc).timestamp())

    val, fallback = await _fetch_ohlc_yahoo(nse_code, ts)
    if val is not None and fallback is None:
        return val, None  # exact-date match from Yahoo -- done, no fallback needed

    # Yahoo either found nothing at all, or only a shifted/next-trading-day
    # bar -- before accepting a substitute date, try NSE's own bhavcopy for
    # the EXACT requested date. NSE and Yahoo don't always have gaps on the
    # same days, so this catches cases Yahoo alone would have shifted.
    nse_val = await _fetch_ohlc_nse_bhavcopy(nse_code, dt)
    if nse_val is not None:
        return nse_val, None  # exact date, from NSE -- no fallback needed

    if val is not None:
        return val, fallback  # accept Yahoo's next-trading-day substitute

    val, fallback = await _fetch_ohlc_google(nse_code, dt)
    if val is not None:
        return val, fallback

    return await _fetch_ohlc_screener(nse_code, dt)


@router.get("/api/ohlc-lookup/{nse_code}")
async def ohlc_lookup(nse_code: str, date: str):
    """Ad-hoc OHLC average lookup for an arbitrary date -- powers the client-side
    what-if simulator's buy-date-change preview. Read-only, nothing persisted,
    no admin gate (mirrors GET /api/live/{nse_code})."""
    code = nse_code.strip().upper()
    try:
        price, fallback_date = await _fetch_ohlc_avg(code, date.strip())
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid date format; expected 'DD Mon YYYY'")
    return {"nseCode": code, "date": date.strip(), "price": price, "fallbackDate": fallback_date}


@router.post("/api/set-ohlc-price")
async def set_ohlc_price(body: dict, request: Request):
    """Manually override a buyOHLC or sellOHLC price for a specific stock and date.
    Body: {basket, code, date, price, type} where type is 'buy' or 'sell'.
    Regenerates gains_statement.json after saving."""
    _require_admin(request)
    basket = body.get("basket", "")
    code   = body.get("code", "")
    date   = body.get("date", "")
    price  = body.get("price")
    kind   = body.get("type", "buy")  # 'buy' or 'sell'

    if not basket or not code or not date or price is None:
        raise HTTPException(status_code=422, detail="basket, code, date, price are required")

    price = float(price)
    bp_data   = _load_buy_price_data()
    basket_bp = bp_data.get(basket, {})
    det       = basket_bp.get(code)
    if det is None:
        raise HTTPException(status_code=404, detail=f"{code} not found in {basket}")

    ohlc_field = "buyOHLC" if kind == "buy" else "sellOHLC"
    det.setdefault(ohlc_field, {})[date] = round(price, 4)

    _save_buy_price_data(bp_data)
    gains = _compute_all_gains()
    _save_gains(gains)

    return {"ok": True, "code": code, "date": date, "type": kind, "price": round(price, 4)}


@router.post("/api/refetch-buy-ohlc/{basket}/{code}")
async def refetch_buy_ohlc(basket: str, code: str, request: Request):
    """Force re-fetch OHLC for ALL buy event dates of a stock, overwriting stored values.
    Also re-fetches sell OHLC for its sell event dates.
    Regenerates gains_statement.json after update."""
    _require_admin(request)
    bp_data   = _load_buy_price_data()
    basket_bp = bp_data.get(basket, {})
    det       = basket_bp.get(code)
    if det is None:
        raise HTTPException(status_code=404, detail=f"{code} not found in {basket}")

    results: dict = {"buy": {}, "sell": {}}

    # Re-fetch all buy event dates
    for field in ("prevBuyEvents", "buyEvents"):
        for line in (det.get(field) or "").strip().split("\n"):
            line = line.strip()
            if " * " not in line:
                continue
            date_str = line.split(" * ")[0].strip()
            if not date_str:
                continue
            price, fallback = await _fetch_ohlc_avg(code, date_str)
            if price is not None:
                det.setdefault("buyOHLC", {})[date_str] = price
                if fallback:
                    det.setdefault("buyOHLC_fallback", {})[date_str] = fallback
                elif date_str in det.get("buyOHLC_fallback", {}):
                    det["buyOHLC_fallback"].pop(date_str, None)
                results["buy"][date_str] = price

    # Re-fetch all sell event dates
    for field in ("prevSellEvents", "sellEvents"):
        for line in (det.get(field) or "").strip().split("\n"):
            line = line.strip()
            if " * " not in line:
                continue
            date_str = line.split(" * ")[0].strip()
            if not date_str:
                continue
            price, fallback = await _fetch_ohlc_avg(code, date_str)
            if price is not None:
                det.setdefault("sellOHLC", {})[date_str] = price
                if fallback:
                    det.setdefault("sellOHLC_fallback", {})[date_str] = fallback
                elif date_str in det.get("sellOHLC_fallback", {}):
                    det["sellOHLC_fallback"].pop(date_str, None)
                results["sell"][date_str] = price

    _save_buy_price_data(bp_data)

    # Regenerate gains statement
    gains = _compute_all_gains()
    _save_gains(gains)

    return {"ok": True, "code": code, "basket": basket, "prices": results}


@router.get("/api/calc-buy-price/{key}/{nse}")
async def calc_buy_price(key: str, nse: str, request: Request):
    """Calculate weighted avg buy price for one stock from its buy events."""
    _require_admin(request)
    bp_data = _load_buy_price_data()
    det = bp_data.get(key, {}).get(nse, {})
    buy_events_str = det.get("buyEvents") or ""
    if not buy_events_str:
        raise HTTPException(status_code=404, detail="No buy events for this stock")

    all_buy  = _parse_buy_events(buy_events_str)
    all_sell = _parse_buy_events(det.get("sellEvents") or "")
    events   = _current_series_buy_events(all_buy, all_sell)
    if not events:
        raise HTTPException(status_code=422, detail="Could not parse buy events")

    # Use cached buyOHLC prices where available; only fetch what is missing
    from corporate_actions import _ca_overlay_for  # lazy: avoids circular import
    ca_overlay  = _ca_overlay_for(key, nse)
    cached_ohlc = det.get("buyOHLC") or {}
    ohlc_avgs: list[float | None] = []
    newly_fetched: dict[str, float] = {}
    newly_fetched_fallbacks: dict[str, str] = {}
    for date_str, _ in events:
        if date_str in ca_overlay:
            ohlc_avgs.append(ca_overlay[date_str])
        elif date_str in cached_ohlc:
            ohlc_avgs.append(cached_ohlc[date_str])
        else:
            val, fallback_date = await _fetch_ohlc_avg(nse, date_str)
            ohlc_avgs.append(val)
            if val is not None:
                newly_fetched[date_str] = val
            if fallback_date:
                newly_fetched_fallbacks[date_str] = fallback_date

    # Persist any newly fetched OHLC prices and fallback metadata
    if newly_fetched or newly_fetched_fallbacks:
        bp_data[key][nse]["buyOHLC"] = {**cached_ohlc, **newly_fetched}
        if newly_fetched_fallbacks:
            bp_data[key][nse].setdefault("buyOHLC_fallback", {}).update(newly_fetched_fallbacks)
        _save_buy_price_data(bp_data)

    failed = [events[i][0] for i, v in enumerate(ohlc_avgs) if v is None]
    if failed:
        raise HTTPException(status_code=502, detail=f"OHLC unavailable for: {', '.join(failed)}")

    total_qty     = sum(qty for _, qty in events)
    weighted_sum  = sum(qty * avg for (_, qty), avg in zip(events, ohlc_avgs))
    buy_price     = round(weighted_sum / total_qty, 2)

    # Persist into the stocks array so dashboard reflects it immediately
    portfolios = _load_portfolios()
    for s in portfolios.get(key, []):
        if s["nseCode"] == nse:
            s["buyPrice"] = buy_price
            break
    _save_portfolios(portfolios)

    all_fallbacks = {**det.get("buyOHLC_fallback", {}), **newly_fetched_fallbacks}
    return {
        "buyPrice": buy_price,
        "events":   [
            {"date": d, "qty": q, "ohlcAvg": a, "fallbackDate": all_fallbacks.get(d)}
            for (d, q), a in zip(events, ohlc_avgs)
        ],
        "fallbacks": {d: v for d, v in all_fallbacks.items() if d in {ev[0] for ev in events}},
    }


@router.post("/api/calc-all-baskets")
async def calc_all_baskets(request: Request):
    """Calculate and persist weighted avg buy prices for every stock with buy events across all baskets."""
    _require_admin(request)
    bp_data    = _load_buy_price_data()
    portfolios = _load_portfolios()
    results    = {}  # key → { nse: buyPrice | "error" }
    total_ok   = 0
    total_err  = 0
    bp_changed = False

    for key in BASKET_DISPLAY_NAMES:
        basket_bp   = bp_data.get(key, {})
        basket_stks = portfolios.get(key, [])
        stk_map     = {s["nseCode"]: s for s in basket_stks}
        results[key] = {}

        for nse, det in basket_bp.items():
            # Sync allocation from buy/sell events
            buy_ev_str  = det.get("buyEvents")  or ""
            sell_ev_str = det.get("sellEvents") or ""
            buy_ev_all  = _parse_buy_events(buy_ev_str)
            sell_ev_all = _parse_buy_events(sell_ev_str)
            # Only ever UPDATE an existing active-holding entry's allocation here --
            # never fabricate one. buy_price_data.json keeps every stock this basket
            # has EVER held (including fully-exited historical positions), so a stock
            # missing from stk_map is either a legitimately-removed past holding or
            # something rebalance.py hasn't added yet -- either way, adding it here
            # created zero-allocation "ghost" entries in portfolios.json on every call
            # (mirrors the correct skip-if-not-active behavior _recalc_basket_buy_prices
            # already uses below).
            if buy_ev_all and nse in stk_map:
                stk_map[nse]["allocation"] = _compute_allocation(buy_ev_all, sell_ev_all)

            events = _current_series_buy_events(buy_ev_all, sell_ev_all)
            if not events:
                continue

            try:
                # Use cached buyOHLC prices where available
                from corporate_actions import _ca_overlay_for  # lazy: avoids circular import
                ca_overlay  = _ca_overlay_for(key, nse)
                cached_ohlc = det.get("buyOHLC") or {}
                ohlc_avgs: list[float | None] = []
                newly_fetched: dict[str, float] = {}
                for date_str, _ in events:
                    if date_str in ca_overlay:
                        ohlc_avgs.append(ca_overlay[date_str])
                    elif date_str in cached_ohlc:
                        ohlc_avgs.append(cached_ohlc[date_str])
                    else:
                        val, fallback_date = await _fetch_ohlc_avg(nse, date_str)
                        ohlc_avgs.append(val)
                        if val is not None:
                            newly_fetched[date_str] = val
                        if fallback_date:
                            det.setdefault("buyOHLC_fallback", {})[date_str] = fallback_date
                            bp_changed = True

                # Persist newly fetched OHLC prices
                if newly_fetched:
                    det["buyOHLC"] = {**cached_ohlc, **newly_fetched}
                    bp_changed = True

                if any(v is None for v in ohlc_avgs):
                    failed = [events[i][0] for i, v in enumerate(ohlc_avgs) if v is None]
                    results[key][nse] = f"OHLC missing: {', '.join(failed)}"
                    total_err += 1
                    continue

                total_qty    = sum(qty for _, qty in events)
                weighted_sum = sum(qty * avg for (_, qty), avg in zip(events, ohlc_avgs))
                buy_price    = round(weighted_sum / total_qty, 2)

                # Save into portfolios -- same "never fabricate a new active
                # holding" rule as the allocation sync above.
                if nse in stk_map:
                    stk_map[nse]["buyPrice"] = buy_price

                results[key][nse] = buy_price
                total_ok += 1
            except Exception as exc:
                results[key][nse] = str(exc)
                total_err += 1

        portfolios[key] = basket_stks

    if bp_changed:
        _save_buy_price_data(bp_data)

    _save_portfolios(portfolios)
    return {"ok": True, "calculated": total_ok, "errors": total_err, "detail": results}


def _date_to_ts(date_str: str) -> int:
    """Convert 'DD MMM YYYY' to Unix timestamp for chronological sorting."""
    try:
        return int(datetime.strptime(date_str.strip(), "%d %b %Y").replace(tzinfo=timezone.utc).timestamp())
    except Exception:
        return 0


def _compute_fifo_gains_for_series(
    buy_events: list[tuple[str, float]],
    sell_events: list[tuple[str, float]],
    buy_ohlc: dict,
    sell_ohlc: dict,
) -> list[dict]:
    """FIFO gain calculation for one buy/sell series.
    Each sell event is matched against the oldest unconsumed buy lots first.
    Returns a list of per-sell-event records with lot-level breakdown."""
    if not buy_events or not sell_events:
        return []

    buy_queue = sorted(
        [{"date": d, "remaining": q, "price": buy_ohlc.get(d)} for d, q in buy_events],
        key=lambda e: _date_to_ts(e["date"]),
    )
    sell_events_sorted = sorted(sell_events, key=lambda e: _date_to_ts(e[0]))

    gains = []
    for sell_date, sell_weight in sell_events_sorted:
        sell_price = sell_ohlc.get(sell_date)
        remaining = sell_weight
        lots = []

        for lot in buy_queue:
            if remaining < 1e-6:
                break
            if lot["remaining"] < 1e-6:
                continue
            take = min(lot["remaining"], remaining)
            lot["remaining"] = round(lot["remaining"] - take, 6)
            remaining = round(remaining - take, 6)

            buy_price = lot["price"]
            gain_pct = None
            if buy_price and sell_price and buy_price > 0:
                gain_pct = round((sell_price - buy_price) / buy_price * 100, 2)

            lots.append({
                "buyDate":  lot["date"],
                "weight":   round(take, 4),
                "buyPrice": buy_price,
                "gainPct":  gain_pct,
            })

        valid = [l for l in lots if l["gainPct"] is not None]
        total_w = sum(l["weight"] for l in valid)
        wt_gain = (
            round(sum(l["gainPct"] * l["weight"] for l in valid) / total_w, 2)
            if total_w > 0 else None
        )

        remaining_qty = sum(l["remaining"] for l in buy_queue)
        sell_type = "Full Exit" if remaining_qty < 0.05 else "Partial Sell"

        # Buy price: FIFO-weighted avg of the lots THIS sell actually consumed
        # (`lots`, built above from buy_queue's live remaining state). Used
        # uniformly for Full Exit and Partial Sell alike -- a Full Exit that
        # was preceded by an earlier partial sell in the same series must not
        # re-include the weight that sell already consumed and reported.
        lots_with_price = [l for l in lots if l["buyPrice"] is not None]
        total_w_bp = sum(l["weight"] for l in lots_with_price)
        wt_buy_price = (
            round(sum(l["buyPrice"] * l["weight"] for l in lots_with_price) / total_w_bp, 4)
            if total_w_bp > 0 else None
        )

        gains.append({
            "sellDate":            sell_date,
            "sellWeight":          sell_weight,
            "sellPrice":           sell_price,
            "sellType":            sell_type,
            "lots":                lots,
            "weightedGainPct":     wt_gain,
            "weightedAvgBuyPrice": wt_buy_price,
        })

    return gains


def _rebuild_sold_from_bp(basket_bp: dict, existing_sold: list) -> list:
    """Derive sold-stock records from buy/sell event strings in basket_bp.
    This is the authoritative rebuild — weights, actions, and sell prices come
    from the event log. Preserves already-computed buyPrices from existing records."""
    # Primary lookup: (code, date) — exact match when records have dates
    bp_by_key: dict = {}
    # Fallback lookup: code only — used when records were previously stripped of dates
    bp_by_code: dict = {}
    for rec in existing_sold:
        bp = rec.get("buyPrice")
        if bp is None:
            continue
        code = rec.get("nseCode", "")
        date = rec.get("date", "")
        if date:
            bp_by_key.setdefault((code, date), []).append(bp)
        else:
            bp_by_code.setdefault(code, []).append(bp)

    sold: list = []
    for code, det in basket_bp.items():
        sec_name  = det.get("securityName", "")
        sell_ohlc = det.get("sellOHLC") or {}

        for buy_str, sell_str in [
            (det.get("prevBuyEvents"), det.get("prevSellEvents")),
            (det.get("buyEvents"),     det.get("sellEvents")),
        ]:
            buys  = _parse_buy_events(buy_str  or "")
            sells = _parse_buy_events(sell_str or "")
            if not sells:
                continue
            for sell_date, sell_qty in sells:
                ts           = _date_to_ts(sell_date)
                total_bought = sum(q for d, q in buys  if _date_to_ts(d) <= ts)
                total_sold   = sum(q for d, q in sells if _date_to_ts(d) <= ts)
                remaining    = max(0.0, round(total_bought - total_sold, 6))
                is_full      = remaining < 0.05
                # Try exact (code, date) match first; fall back to code-only queue
                keyed = bp_by_key.get((code, sell_date), [])
                if keyed:
                    buy_p = keyed.pop(0)
                else:
                    fallback = bp_by_code.get(code, [])
                    buy_p = fallback.pop(0) if fallback else None
                sold.append({
                    "nseCode":      code,
                    "securityName": sec_name,
                    "date":         sell_date,
                    "action":       "Wholly Sold" if is_full else "Partially Sold",
                    "weightSold":   round(sell_qty, 4),
                    "buyPrice":     buy_p,
                    "sellPrice":    sell_ohlc.get(sell_date),
                })

    return sold


def _compute_all_gains() -> dict:
    """Compute FIFO gains for every stock across all baskets using stored OHLC data.
    No network calls — purely derived from buy_price_data.json."""
    bp_data = _load_buy_price_data()
    result: dict = {}

    for basket_key in BASKET_DISPLAY_NAMES:
        basket_bp = bp_data.get(basket_key, {})
        basket_result: dict = {}

        for nse, det in basket_bp.items():
            buy_ev      = _parse_buy_events(det.get("buyEvents")      or "")
            sell_ev     = _parse_buy_events(det.get("sellEvents")     or "")
            prev_buy_ev = _parse_buy_events(det.get("prevBuyEvents")  or "")
            prev_sell_ev= _parse_buy_events(det.get("prevSellEvents") or "")
            buy_ohlc    = det.get("buyOHLC")  or {}
            sell_ohlc   = det.get("sellOHLC") or {}

            # All baskets now store delta weights in buyEvents
            prev_gains = _compute_fifo_gains_for_series(
                prev_buy_ev, prev_sell_ev, buy_ohlc, sell_ohlc
            )
            curr_gains = _compute_fifo_gains_for_series(
                buy_ev, sell_ev, buy_ohlc, sell_ohlc
            )

            if prev_gains or curr_gains:
                basket_result[nse] = {
                    "securityName":      det.get("securityName", ""),
                    "prevSeriesGains":   prev_gains,
                    "currentSeriesGains": curr_gains,
                }

        if basket_result:
            result[basket_key] = basket_result

    return result


def _build_history_from_events(bp_basket: dict) -> dict:
    """
    Derive per-stock rebalance history from buyEvents / sellEvents stored in
    buy_price_data.json.  Returns the same shape the React StockInfoTooltip expects:
      { nse: { added: "DD MMM YYYY", rebalances: [{ date, note }] } }
    Previous-series events (prevBuyEvents / prevSellEvents) are included in the
    full timeline but labelled as past series entries.
    """
    history: dict = {}
    for nse, det in bp_basket.items():
        buy_events       = _parse_buy_events(det.get("buyEvents")      or "")
        sell_events      = _parse_buy_events(det.get("sellEvents")     or "")
        prev_buy_events  = _parse_buy_events(det.get("prevBuyEvents")  or "")
        prev_sell_events = _parse_buy_events(det.get("prevSellEvents") or "")

        all_events = buy_events + sell_events + prev_buy_events + prev_sell_events
        if not all_events:
            continue

        # Merge all events into one chronological list
        combined = []
        for date_str, qty in buy_events:
            combined.append({"date": date_str, "note": f"Buy {qty:g}%", "_ts": _date_to_ts(date_str)})
        for date_str, qty in sell_events:
            combined.append({"date": date_str, "note": f"Sell {qty:g}%", "_ts": _date_to_ts(date_str)})
        for date_str, qty in prev_buy_events:
            combined.append({"date": date_str, "note": f"Buy {qty:g}% (prev)", "_ts": _date_to_ts(date_str)})
        for date_str, qty in prev_sell_events:
            combined.append({"date": date_str, "note": f"Sell {qty:g}% (prev)", "_ts": _date_to_ts(date_str)})

        combined.sort(key=lambda e: e["_ts"])

        rebalances = [{"date": e["date"], "note": e["note"]} for e in combined]

        # Earliest buy event = when the stock was first added
        added = min((e["date"] for e in combined if e["note"].startswith("Buy")),
                    key=_date_to_ts, default=None)

        history[nse] = {"added": added, "rebalances": rebalances}

    return history


async def _fetch_listing_date_nse(symbol: str) -> str | None:
    """Fetch listing date for a stock from NSE India API. Returns e.g. '30-Jul-2025'."""
    headers = {
        "User-Agent":      YF_HEADERS["User-Agent"],
        "Accept":          "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer":         "https://www.nseindia.com/",
    }
    try:
        async with httpx.AsyncClient(headers=headers, timeout=15.0, follow_redirects=True) as c:
            await c.get("https://www.nseindia.com/", timeout=10.0)
            r = await c.get(
                "https://www.nseindia.com/api/quote-equity?symbol="
                + urllib.parse.quote(symbol),
                timeout=10.0,
            )
            if r.status_code != 200:
                return None
            d = r.json()
            ld = (
                (d.get("metadata") or {}).get("listingDate")
                or (d.get("info")     or {}).get("listingDate")
            )
            return str(ld).strip() if ld else None
    except Exception:
        return None


async def _fetch_listing_date_yahoo(symbol: str) -> str | None:
    """Fallback for when NSE's own site blocks this server outright (it does,
    unconditionally, from this host -- even the plain homepage 403s before any
    API call is attempted, unlike Yahoo/Google/Screener which all work fine).
    Yahoo's chart `meta.firstTradeDate` is the exchange's first-trade Unix
    timestamp for the symbol -- a reliable stand-in for listing date. Tries
    YF_SYMBOL_MAP override, then .NS, then -SM.NS, mirroring the same ladder
    _fetch_open_price_for_listing already uses for the price side."""
    async def _first_trade_date(sym: str) -> str | None:
        try:
            async with httpx.AsyncClient(timeout=10, headers={"User-Agent": "Mozilla/5.0"},
                                          follow_redirects=True) as client:
                r = await client.get(
                    f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}"
                    "?range=5y&interval=1d"
                )
            if r.status_code != 200:
                return None
            result = ((r.json().get("chart") or {}).get("result")) or []
            if not result:
                return None
            ts = (result[0].get("meta") or {}).get("firstTradeDate")
            return datetime.utcfromtimestamp(ts).strftime("%d-%b-%Y") if ts else None
        except Exception:
            return None

    if symbol in YF_SYMBOL_MAP:
        return await _first_trade_date(YF_SYMBOL_MAP[symbol])
    return (await _first_trade_date(f"{symbol}.NS")) or (await _first_trade_date(f"{symbol}-SM.NS"))


async def _backfill_ipo_listing_dates() -> None:
    """Background: fetch & persist missing listing dates for IPO_Recommendations stocks."""
    try:
        portfolios = _load_portfolios()
        ipo_stocks = portfolios.get("IPO_Recommendations", [])
        if not ipo_stocks:
            return
        bp_data   = _load_buy_price_data()
        basket_bp = bp_data.get("IPO_Recommendations", {})
        changed   = False
        for s in ipo_stocks:
            code = s.get("nseCode", "").strip()
            if not code:
                continue
            if (basket_bp.get(code) or {}).get("listingDate"):
                continue  # already cached
            ld = await _fetch_listing_date_nse(code) or await _fetch_listing_date_yahoo(code)
            if ld:
                if code not in basket_bp:
                    basket_bp[code] = {}
                basket_bp[code]["listingDate"] = ld
                changed = True
        if changed:
            bp_data["IPO_Recommendations"] = basket_bp
            _save_buy_price_data(bp_data)
    except Exception:
        pass


@router.get("/api/basket/{key}")
async def get_basket(key: str, background_tasks: BackgroundTasks):
    # Load both JSON files in parallel (non-blocking via thread pool)
    portfolios, bp_full = await asyncio.gather(
        asyncio.to_thread(_load_portfolios),
        asyncio.to_thread(_load_buy_price_data),
    )
    bp_data = bp_full.get(key, {})
    if key == "IPO_Recommendations":
        background_tasks.add_task(_backfill_ipo_listing_dates)
        # Synchronously fill any missing listing prices so they appear on first load
        await _backfill_ipo_listing_prices()
        # Re-read from in-memory cache (free — no disk I/O after cache is warm)
        portfolios = _load_portfolios()
        bp_data    = _load_buy_price_data().get(key, {})
    return {
        "stocks":          portfolios.get(key, []),
        "soldStocks":      portfolios.get(f"{key}_sold", []),
        "history":         _build_history_from_events(bp_data),
        "buyPriceDetails": bp_data,
    }


async def _recalc_basket_buy_prices(key: str) -> None:
    """Background task: recalculate OHLC-weighted avg buy prices for all stocks
    in a basket that have buy events, then persist results to portfolios.json."""
    try:
        bp_data     = _load_buy_price_data()
        portfolios  = _load_portfolios()
        basket_bp   = bp_data.get(key, {})
        basket_stks = portfolios.get(key, [])
        stk_map     = {s["nseCode"]: s for s in basket_stks}
        pf_changed  = False
        bp_changed  = False

        for nse, det in basket_bp.items():
            all_buy   = _parse_buy_events(det.get("buyEvents")  or "")
            all_sell  = _parse_buy_events(det.get("sellEvents") or "")
            buy_events = _current_series_buy_events(all_buy, all_sell)
            if not buy_events:
                continue
            try:
                # Use cached buyOHLC prices where available
                from corporate_actions import _ca_overlay_for  # lazy: avoids circular import
                ca_overlay  = _ca_overlay_for(key, nse)
                cached_ohlc = det.get("buyOHLC") or {}
                ohlc_avgs: list[float | None] = []
                newly_fetched: dict[str, float] = {}
                for date_str, _ in buy_events:
                    if date_str in ca_overlay:
                        ohlc_avgs.append(ca_overlay[date_str])
                    elif date_str in cached_ohlc:
                        ohlc_avgs.append(cached_ohlc[date_str])
                    else:
                        val, fallback_date = await _fetch_ohlc_avg(nse, date_str)
                        ohlc_avgs.append(val)
                        if val is not None:
                            newly_fetched[date_str] = val
                        if fallback_date:
                            det.setdefault("buyOHLC_fallback", {})[date_str] = fallback_date
                            bp_changed = True

                if newly_fetched:
                    det["buyOHLC"] = {**cached_ohlc, **newly_fetched}
                    bp_changed = True

                if any(v is None for v in ohlc_avgs):
                    continue  # skip if any event date is unavailable
                total_qty    = sum(qty for _, qty in buy_events)
                weighted_sum = sum(qty * avg for (_, qty), avg in zip(buy_events, ohlc_avgs))
                buy_price    = round(weighted_sum / total_qty, 2)
                if nse not in stk_map:
                    continue  # skip sold/non-active stocks
                stk_map[nse]["buyPrice"] = buy_price
                pf_changed = True
            except Exception:
                continue

        if pf_changed:
            portfolios[key] = basket_stks
            _save_portfolios(portfolios)
        if bp_changed:
            _save_buy_price_data(bp_data)
    except Exception:
        pass  # background task — never crash the server


async def _refresh_gains_file() -> None:
    """Background task: recompute FIFO gains from current buy_price_data and persist."""
    try:
        gains = _compute_all_gains()
        _save_gains(gains)
    except Exception:
        pass


async def _backfill_all_sell_ohlc_bg() -> None:
    """Background task: fetch any missing sell OHLC prices across ALL baskets,
    then regenerate gains_statement.json. Runs as the final step after a rebalance
    to ensure every sell event has a price regardless of which basket was updated."""
    try:
        bp_data = _load_buy_price_data()
        filled = 0
        for basket_bp in bp_data.values():
            for code, det in basket_bp.items():
                sell_ohlc = det.setdefault("sellOHLC", {})
                for field in ("prevSellEvents", "sellEvents"):
                    for line in (det.get(field) or "").strip().split("\n"):
                        line = line.strip()
                        if " * " not in line:
                            continue
                        date_str = line.split(" * ")[0].strip()
                        if not date_str or date_str in sell_ohlc:
                            continue
                        price, fallback = await _fetch_ohlc_avg(code, date_str)
                        if price:
                            sell_ohlc[date_str] = price
                            if fallback:
                                det.setdefault("sellOHLC_fallback", {})[date_str] = fallback
                            filled += 1
        if filled:
            _save_buy_price_data(bp_data)
        gains = _compute_all_gains()
        _save_gains(gains)
    except Exception:
        pass


@router.get("/api/undo-count/{basket}")
async def get_undo_count(basket: str):
    snaps = _load_undo_snapshots()
    return {"count": len(snaps.get(basket, []))}


@router.post("/api/undo/{basket}")
async def undo_basket(basket: str, background_tasks: BackgroundTasks, request: Request):
    _require_admin(request)
    snaps = _load_undo_snapshots()
    basket_snaps = snaps.get(basket, [])
    if not basket_snaps:
        raise HTTPException(400, "No undo history available for this basket.")
    snapshot = basket_snaps.pop()
    snaps[basket] = basket_snaps
    _save_undo_snapshots(snaps)

    pf = _load_portfolios()
    pf[basket]                  = snapshot["stocks"]
    pf[f"{basket}_sold"]        = snapshot["sold"]
    _save_portfolios(pf)

    bp = _load_buy_price_data()
    bp[basket] = snapshot["buyPriceData"]
    _save_buy_price_data(bp)

    rh = _load_rebalance_history()
    rh[basket] = snapshot["rebalanceHistory"]
    _save_rebalance_history(rh)

    background_tasks.add_task(_recalc_basket_buy_prices, basket)
    background_tasks.add_task(_refresh_gains_file)
    return {"ok": True, "remainingUndos": len(basket_snaps)}


@router.put("/api/basket/{key}")
async def save_basket(key: str, body: dict, background_tasks: BackgroundTasks, request: Request):
    _require_admin(request)
    if key not in BASKET_DISPLAY_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown basket: {key}")
    _auto_save_rollback()
    _push_undo_snapshot(key, f"before save {time.strftime('%d %b %Y %H:%M')}")
    portfolios = _load_portfolios()
    portfolios[key] = body.get("stocks", [])
    if "soldStocks" in body:
        portfolios[f"{key}_sold"] = body["soldStocks"]

    if "buyPriceDetails" in body:
        bp_data = _load_buy_price_data()
        bp_data[key] = body["buyPriceDetails"]
        _save_buy_price_data(bp_data)

        # Re-derive allocations from buy/sell events — backend is authoritative source
        stk_map = {s["nseCode"]: s for s in portfolios[key]}
        for nse, det in bp_data[key].items():
            buy_events  = _parse_buy_events(det.get("buyEvents")  or "")
            sell_events = _parse_buy_events(det.get("sellEvents") or "")
            if not buy_events:
                continue
            allocation = _compute_allocation(buy_events, sell_events)
            if nse in stk_map:
                stk_map[nse]["allocation"] = allocation
            else:
                new_stk = {"nseCode": nse, "allocation": allocation}
                portfolios[key].append(new_stk)
                stk_map[nse] = new_stk

        # Auto-recalculate buy prices in background after every save
        background_tasks.add_task(_recalc_basket_buy_prices, key)
        # Refresh gains statement so P&L page reflects latest sell events
        background_tasks.add_task(_refresh_gains_file)

    # For IPO basket, auto-fetch opening prices for stocks with a listing date
    if key == "IPO_Recommendations":
        background_tasks.add_task(_backfill_ipo_listing_prices)

    _save_portfolios(portfolios)
    return {"ok": True, "saved": len(portfolios[key])}


@router.get("/api/gains-statement")
async def get_gains_statement():
    """Return FIFO gains statement for all stocks with sell events.
    Serves from gains_statement.json if it exists; otherwise computes fresh."""
    if _GAINS_FILE.exists():
        with open(_GAINS_FILE, encoding="utf-8") as f:
            return json.load(f)
    gains = _compute_all_gains()
    _save_gains(gains)
    return gains


@router.post("/api/gains-statement/refresh")
async def refresh_gains_statement(request: Request):
    """Recompute FIFO gains from current buy_price_data.json and persist."""
    _require_admin(request)
    gains = _compute_all_gains()
    _save_gains(gains)
    total = sum(len(v) for v in gains.values())
    return {"ok": True, "stocksWithGains": total}


@router.post("/api/gains-statement/backfill-sell-ohlc")
async def backfill_sell_ohlc(request: Request):
    """Fetch missing sellOHLC prices for all sell event dates across all baskets,
    then regenerate gains_statement.json."""
    _require_admin(request)
    bp_data = _load_buy_price_data()
    filled = 0

    for basket_key, basket_bp in bp_data.items():
        for code, det in basket_bp.items():
            sell_ohlc = det.setdefault("sellOHLC", {})
            for field in ("prevSellEvents", "sellEvents"):
                for line in (det.get(field) or "").strip().split("\n"):
                    line = line.strip()
                    if " * " not in line:
                        continue
                    date_str = line.split(" * ")[0].strip()
                    if not date_str or date_str in sell_ohlc:
                        continue
                    price, fallback = await _fetch_ohlc_avg(code, date_str)
                    if price:
                        sell_ohlc[date_str] = price
                        if fallback:
                            det.setdefault("sellOHLC_fallback", {})[date_str] = fallback
                        filled += 1

    _save_buy_price_data(bp_data)
    gains = _compute_all_gains()
    _save_gains(gains)

    return {"ok": True, "pricesFilled": filled}


@router.get("/api/ohlc-fallbacks/{basket}")
async def get_ohlc_fallbacks(basket: str):
    """Return all stocks in a basket that used next-trading-day OHLC fallbacks.
    Each entry has buyFallbacks and sellFallbacks dicts mapping
    {requested_date: actual_date_used}."""
    bp_data   = _load_buy_price_data()
    basket_bp = bp_data.get(basket, {})
    result    = {}
    for nse, det in basket_bp.items():
        buy_fb  = det.get("buyOHLC_fallback",  {})
        sell_fb = det.get("sellOHLC_fallback", {})
        if buy_fb or sell_fb:
            result[nse] = {
                "securityName":  det.get("securityName", ""),
                "buyFallbacks":  buy_fb,
                "sellFallbacks": sell_fb,
            }
    return result


def _wavg_cost_basis(
    series_buys: list[tuple[str, float]],
    buy_ohlc: dict,
) -> float | None:
    """Weighted average buy price across all lots in the current series.
    Used by this module's FIFO gains engine and by live_data.py's cost-basis helpers."""
    total_cost = total_qty = 0.0
    for date_str, qty in series_buys:
        price = buy_ohlc.get(date_str)
        if price:
            total_cost += qty * price
            total_qty  += qty
    return round(total_cost / total_qty, 4) if total_qty > 1e-6 else None


def _add_event(basket_bp: dict, code: str, field: str, date_str: str, qty: float) -> None:
    """Append 'DD Mon YYYY * qty' to buyEvents or sellEvents for a stock.
    Deduplicates by date across BOTH the current field and its prev* counterpart,
    so a series reset (which moves events to prevBuyEvents/prevSellEvents and clears
    the current field) does not allow the same date to be re-added.
    Used by rebalance.py and historical_upload.py."""
    if code not in basket_bp:
        basket_bp[code] = {"securityName": "", "segment": "",
                            "buyEvents": "", "sellEvents": "",
                            "buyOHLC": {}, "sellOHLC": {},
                            "prevBuyEvents": "", "prevSellEvents": ""}
    det = basket_bp[code]
    existing  = det.get(field) or ""
    prev_field = "prevBuyEvents" if field == "buyEvents" else "prevSellEvents"
    prev_existing = det.get(prev_field) or ""

    def _dates_in(s: str) -> set:
        return {
            line.strip().split(" * ")[0].strip()
            for line in s.strip().split("\n")
            if " * " in line.strip()
        }

    # Skip if this date already exists in either current or previous series
    if date_str.strip() in (_dates_in(existing) | _dates_in(prev_existing)):
        return
    new_line = f"{date_str} * {round(qty, 4):g}"
    det[field] = (existing.strip() + "\n" + new_line).strip()


