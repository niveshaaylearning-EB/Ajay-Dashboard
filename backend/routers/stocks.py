"""Basket list + basic stock lookup/search/price-history endpoints."""
import asyncio
import io
import re
import time as _time
from datetime import datetime, timedelta

import pandas as pd
import requests as _requests
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import database
import sheet_service
from auth import is_admin_email
from main import get_db, _io_pool, yf, _get_nse_ltp
from routers.actual_portfolio_bridge import _fetch_all_webportal_baskets

router = APIRouter()

_NSE_EQUITY_LIST_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"

def sync_nse_stocks(db: Session, force: bool = False) -> int:
    """Populate the NseStock table (powers the stock-search/autocomplete used by
    the Simulator/virtual-portfolio "Add Stock" box) from NSE's public equity
    list CSV. Skips if already populated unless force=True -- this table lives
    in SQLite, which isn't backed up to GitHub like allowed_emails/stock_events
    are (see main.py's startup restore block), so on a host where the DB doesn't
    persist across deploys this needs to be re-run; called both from the
    admin-triggered endpoint below and once at startup (main.py) so a freshly
    empty table self-heals without anyone needing to remember a manual script.
    Returns the number of rows inserted."""
    if not force and db.query(database.NseStock).count() > 200:
        return 0
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    resp = _requests.get(_NSE_EQUITY_LIST_URL, headers=headers, timeout=20)
    resp.raise_for_status()
    df = pd.read_csv(io.StringIO(resp.text))
    existing_codes = {c for (c,) in db.query(database.NseStock.code).all()}
    inserted = 0
    for _, row in df.iterrows():
        code = str(row.get("SYMBOL", "")).strip()
        name = str(row.get("NAME OF COMPANY", "")).strip()
        if code and name and code not in existing_codes:
            db.add(database.NseStock(code=code, name=name))
            existing_codes.add(code)
            inserted += 1
    db.commit()
    return inserted

@router.get("/api/baskets")
def get_baskets():
    """All baskets with holdings — sourced from webportal (actual portfolio)."""
    data = _fetch_all_webportal_baskets()
    if not data:
        raise HTTPException(status_code=503, detail="Webportal unreachable or no basket data")
    return data

@router.get("/api/stocks/search")
def search_stocks(q: str = "", db: Session = Depends(get_db)):
    if not q or len(q) < 1:
        return []
    stocks = db.query(database.NseStock).filter(
        database.NseStock.code.ilike(f"%{q}%") | database.NseStock.name.ilike(f"%{q}%")
    ).limit(10).all()
    return [{"code": s.code, "name": s.name} for s in stocks]

@router.post("/api/admin/sync-nse-stocks")
def admin_sync_nse_stocks(request: Request, db: Session = Depends(get_db)):
    """Admin-only: (re)populate the NseStock autocomplete table from NSE's
    public equity list. Always force-refreshes (picks up new listings)."""
    user = getattr(request.state, "user", None)
    if not is_admin_email(user):
        raise HTTPException(status_code=403, detail="Admin access required.")
    try:
        inserted = sync_nse_stocks(db, force=True)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch NSE equity list: {e}")
    return {"ok": True, "inserted": inserted, "total": db.query(database.NseStock).count()}

# ── Per-stock info cache (24 h TTL) ──────────────────────────────────────────
_stock_info_cache: dict = {}
_STOCK_INFO_TTL = 86400  # 24 hours

@router.get("/api/stocks/info")
async def get_stock_info(code: str):
    """
    Return {code, name, sector, industry} for an NSE stock code.
    Fetched from Yahoo Finance — used to auto-fill the Add Stock form.
    Cached 24 h per stock to keep the UI snappy.
    """
    upper_code = re.sub(r'\s+', '', code.strip().upper())
    cached = _stock_info_cache.get(upper_code)
    if cached and (_time.time() - cached['time']) < _STOCK_INFO_TTL:
        return cached['data']

    def _fetch():
        ticker_sym = f"{upper_code}.NS"
        tk = yf.Ticker(ticker_sym)
        info = tk.info or {}
        return {
            "code":     upper_code,
            "name":     info.get("longName") or info.get("shortName") or upper_code,
            "sector":   info.get("sector") or info.get("industry") or "",
            "industry": info.get("industry") or "",
        }

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(_io_pool, _fetch)
    except Exception as e:
        print(f"stock/info error for {upper_code}: {e}")
        result = {"code": upper_code, "name": upper_code, "sector": "", "industry": ""}

    _stock_info_cache[upper_code] = {'time': _time.time(), 'data': result}
    return result

_stock_hist_price_cache: dict = {}  # "{code}:{date}" → {time, price}
_STOCK_HIST_PRICE_TTL = 12 * 3600   # 12 h — historical prices don't change

_cmp_cache: dict = {}   # code → {time, price}
_CMP_TTL = 60           # live price — short TTL so repeated lookups (e.g. re-opening
                        # the Add Stock modal for the same code) don't refetch every time

# Yahoo Finance's public chart JSON endpoint — used directly via `requests`
# instead of through the `yfinance` package. `yfinance` needs a "crumb"
# cookie from a separate auth handshake that frequently 401s on cloud IPs
# (see the crumb warning filters in main.py); this chart endpoint needs no
# auth at all, just a browser-like User-Agent, and returns both the live
# price (in `meta.regularMarketPrice`) and historical daily OHLC bars.
_YF_CHART_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
}

def _yahoo_chart(code: str, params: dict) -> dict | None:
    """Raw chart payload for one NSE stock, or None on any failure."""
    ticker = code.upper() if code.upper().endswith(".NS") else f"{code.upper()}.NS"
    try:
        r = _requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}",
                           headers=_YF_CHART_HEADERS, params=params, timeout=8)
        r.raise_for_status()
        result = r.json().get("chart", {}).get("result") or []
        return result[0] if result else None
    except Exception as e:
        print(f"Yahoo chart fetch error for {ticker}: {e}")
        return None

def _fetch_live_cmp(code: str) -> float:
    """
    Live CMP for a stock, tried most-reliable-first:
      1. Yahoo Finance's chart endpoint directly — no crumb/session needed.
      2. NSE's own API via nsepython — often blocked by NSE's Akamai WAF on cloud IPs.
      3. sheet_service.get_live_cmp — in-memory basket-sheet cache, then yfinance (crumb-prone).
    Runs on a worker thread (see run_in_executor call site) so it never blocks
    the event loop even when a source is slow.
    """
    chart = _yahoo_chart(code, {"range": "1d", "interval": "1m"})
    price = (chart or {}).get("meta", {}).get("regularMarketPrice")
    if price and price > 0:
        return float(price)

    price = _get_nse_ltp(code)
    if price and price > 0:
        return price

    return sheet_service.get_live_cmp(code)

def _fetch_yahoo_historical(code: str, start_date: datetime, end_date: datetime) -> pd.DataFrame:
    """Daily OHLC bars between the two dates, indexed by (naive) date — or an empty DataFrame."""
    chart = _yahoo_chart(code, {
        "period1": int(start_date.timestamp()),
        "period2": int(end_date.timestamp()),
        "interval": "1d",
    })
    if not chart or not chart.get("timestamp"):
        return pd.DataFrame()
    quote = chart["indicators"]["quote"][0]
    df = pd.DataFrame({
        "Open": quote.get("open"), "High": quote.get("high"),
        "Low": quote.get("low"), "Close": quote.get("close"),
    }, index=pd.to_datetime(chart["timestamp"], unit="s").normalize())
    return df.dropna(how="all")

@router.get("/api/stocks/history")
async def get_stock_history_price(code: str, date: str):
    """
    Fetch the OHLC-average price for a stock on the given date.
    OHLC average = (Open + High + Low + Close) / 4

    If the requested date is a market holiday or weekend (no OHLC data),
    returns the OHLC average for the next available trading day.
    For today/future dates, returns the live CMP instead.
    """
    upper_code = code.upper()
    cache_key  = f"{upper_code}:{date}"
    cached_hp  = _stock_hist_price_cache.get(cache_key)
    if cached_hp and (_time.time() - cached_hp['time']) < _STOCK_HIST_PRICE_TTL:
        return {"price": cached_hp['price']}

    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
        today = datetime.now().date()
        loop = asyncio.get_running_loop()

        # ── Current / future: live CMP, off the event loop, briefly cached ───
        if dt.date() >= today:
            cached_cmp = _cmp_cache.get(upper_code)
            if cached_cmp and (_time.time() - cached_cmp['time']) < _CMP_TTL:
                return {"price": cached_cmp['price']}

            price = await loop.run_in_executor(_io_pool, _fetch_live_cmp, upper_code)
            if price and price > 0:
                _cmp_cache[upper_code] = {'time': _time.time(), 'price': price}
                return {"price": price}

        # ── Historical: fetch a window around the date ───────────────────────
        # end_date extends 10 days forward so we can step to the next trading
        # day when the requested date is a holiday / weekend.
        ticker     = f"{code}.NS" if not code.endswith(".NS") else code
        start_date = dt - timedelta(days=2)
        end_date   = dt + timedelta(days=10)

        data = await loop.run_in_executor(_io_pool, _fetch_yahoo_historical, upper_code, start_date, end_date)

        if data.empty:
            # Fall back to yfinance's own (crumb-prone) client if the direct
            # chart endpoint came back empty for some reason.
            def _fetch():
                return yf.download(ticker, start=start_date.strftime("%Y-%m-%d"),
                                   end=end_date.strftime("%Y-%m-%d"), progress=False,
                                   session=sheet_service._yf_session)
            data = await loop.run_in_executor(_io_pool, _fetch)

        if data.empty:
            return {"price": 0.0}

        # Strip timezone for naive comparison
        idx    = data.index.tz_localize(None) if data.index.tz is not None else data.index
        cutoff = pd.to_datetime(dt)

        # 1st choice: exact date  2nd choice: next trading day  3rd: most recent past
        exact  = data[idx == cutoff]
        if not exact.empty:
            row = exact.iloc[0]
        else:
            future = data[idx > cutoff]
            if not future.empty:
                row = future.iloc[0]        # next trading day (holiday fallback)
            else:
                past = data[idx < cutoff]
                if past.empty:
                    return {"price": 0.0}
                row = past.iloc[-1]

        # OHLC average
        def _f(v):
            if hasattr(v, 'item'): v = v.item()
            try: return float(v) if pd.notna(v) else None
            except: return None

        vals = [_f(row[c]) for c in ('Open', 'High', 'Low', 'Close')]
        vals = [v for v in vals if v is not None and v > 0]
        if not vals:
            return {"price": 0.0}
        price = round(sum(vals) / len(vals), 2)
        _stock_hist_price_cache[cache_key] = {'time': _time.time(), 'price': price}
        return {"price": price}

    except Exception as e:
        print(f"History price lookup error: {e}")
        return {"price": 0.0}
