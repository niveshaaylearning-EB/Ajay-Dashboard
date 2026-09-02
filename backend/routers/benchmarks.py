"""Benchmark index returns (Nifty 50/200/MidSmall) + multi-basket comparison.

_BENCHMARKS / _fetch_bench_close_max are also used by routers/historic.py for
inception-period benchmark comparisons.
"""
import asyncio
from datetime import datetime, timedelta

import pandas as pd
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import database
from main import get_db, _io_pool, yf
from routers.actual_portfolio_bridge import _fetch_all_webportal_baskets, _fetch_index_history

router = APIRouter()

# ── Benchmark Returns ─────────────────────────────────────────────────────────
# Returns 1M/6M/1Y/3Y/5Y net + CAGR for Nifty50, Nifty200, Nifty MidSmall
# Cached in benchmark_cache table (24 h TTL — one row per symbol+period).
# Each symbol is fetched individually via yf.Ticker to avoid multi-level
# column ambiguity that occurs with yf.download(multiple_symbols).

_BENCHMARKS = {
    "Nifty 50":       "^NSEI",
    "Nifty 200":      "^CNX200",
    "Nifty MidSmall": "^NSMIDCP400",
}
_BENCH_PERIODS = [("1M", 30), ("6M", 182), ("1Y", 365), ("3Y", 1095), ("5Y", 1825)]


def _fetch_benchmark_symbol(symbol: str) -> "pd.Series | None":
    """Fetch 5-year daily Close prices for a single Yahoo Finance symbol."""
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="5y", auto_adjust=True)
        if hist is None or hist.empty:
            print(f"[benchmark] No data for {symbol}")
            return None
        close = hist["Close"].dropna()
        return close if not close.empty else None
    except Exception as e:
        print(f"[benchmark] Fetch error for {symbol}: {e}")
        return None


def _fetch_bench_close_max(symbol: str) -> "pd.Series | None":
    """Fetch maximum available daily Close prices — used for inception-period benchmark returns."""
    try:
        hist = yf.Ticker(symbol).history(period="10y", auto_adjust=True)
        if hist is None or hist.empty:
            return None
        close = hist["Close"].dropna()
        return close if not close.empty else None
    except Exception as e:
        print(f"[benchmark_max] Fetch error for {symbol}: {e}")
        return None


def _calc_benchmark_returns(close: "pd.Series") -> dict:
    """Given a Close price series, compute net & CAGR for all standard periods."""
    now_price = float(close.iloc[-1])
    now_dt    = close.index[-1]
    out = {}
    for pname, days in _BENCH_PERIODS:
        target_dt = now_dt - timedelta(days=days)
        past = close[close.index <= target_dt]
        if past.empty:
            out[pname] = {"net": None, "cagr": None}
            continue
        past_price = float(past.iloc[-1])
        if past_price <= 0:
            out[pname] = {"net": None, "cagr": None}
            continue
        net  = round((now_price - past_price) / past_price * 100, 2)
        cagr = round(((now_price / past_price) ** (365 / days) - 1) * 100, 2) if days >= 365 else None
        out[pname] = {"net": net, "cagr": cagr}
    return out


@router.get("/api/benchmarks")
async def get_benchmarks(db: Session = Depends(get_db)):
    today_str = datetime.now().strftime("%Y-%m-%d")
    result: dict = {}

    # Which symbols need a fresh fetch? (cache miss = any period missing for today)
    symbols_to_fetch: list[tuple[str, str]] = []  # (label, symbol)

    for label, symbol in _BENCHMARKS.items():
        result[label] = {}
        missing = False
        for pname, _ in _BENCH_PERIODS:
            cached = db.query(database.BenchmarkCache).filter_by(
                symbol=symbol, period=pname
            ).first()
            if cached and cached.fetched_at == today_str and cached.net is not None:
                result[label][pname] = {"net": cached.net, "cagr": cached.cagr}
            else:
                missing = True
        if missing:
            symbols_to_fetch.append((label, symbol))

    if not symbols_to_fetch:
        return result

    loop = asyncio.get_running_loop()

    for label, symbol in symbols_to_fetch:
        close = await loop.run_in_executor(_io_pool, _fetch_benchmark_symbol, symbol)
        if close is None:
            # Leave as empty dict (already initialised above)
            continue
        period_data = _calc_benchmark_returns(close)
        result[label] = period_data
        # Upsert cache rows
        for pname, vals in period_data.items():
            cached = db.query(database.BenchmarkCache).filter_by(symbol=symbol, period=pname).first()
            if cached:
                cached.net = vals["net"]; cached.cagr = vals["cagr"]; cached.fetched_at = today_str
            else:
                db.add(database.BenchmarkCache(
                    symbol=symbol, period=pname,
                    net=vals["net"], cagr=vals["cagr"], fetched_at=today_str
                ))

    db.commit()
    return result


# ── Multi-Basket Comparison ───────────────────────────────────────────────────

_BASKET_INCEPTION_MAP = {
    "mid & small cap":   "2019-09-19",
    "mid and small cap": "2019-09-19",
    "green energy":      "2021-03-23",
    "make in india":     "2021-08-16",
    "trends trilogy":    "2022-02-07",
    "trends triology":   "2022-02-07",
    "consumer trends":   "2023-11-13",
    "ipo basket":        "2025-02-13",
    "techstack":         "2026-01-27",
}
_BASKET_EXCLUDE_NAMES = {"ipo recommendations", "ipo recommendation"}

@router.get("/api/baskets/comparison")
def get_basket_comparison():
    """
    Returns all baskets with historic returns from webportal index-history.
    Only shows returns for periods after the basket's inception date.
    """
    baskets = _fetch_all_webportal_baskets()
    hi      = _fetch_index_history()
    today   = datetime.now().date()

    def _get_inception(basket_name: str):
        key = basket_name.lower().replace("nia ", "").strip()
        return _BASKET_INCEPTION_MAP.get(key)

    def _period_returns(basket_key: str, basket_name: str) -> dict:
        if not hi or basket_key not in hi:
            return {}
        idx_data = hi[basket_key].get("data", [])
        if not idx_data:
            return {}
        latest_pt = max(idx_data, key=lambda d: d["date"])
        lv = float(latest_pt["value"])
        inception_str = _get_inception(basket_name)
        result = {}
        for label, days in [("1M", 30), ("3M", 91), ("6M", 182), ("1Y", 365), ("3Y", 1095), ("5Y", 1825)]:
            period_start = (today - timedelta(days=days)).isoformat()
            # Skip if basket wasn't launched at the start of this period
            if inception_str and inception_str > period_start:
                continue
            exact = next((d for d in idx_data if d["date"] == period_start), None)
            if exact:
                base_pt = exact
            else:
                after = [d for d in idx_data if d["date"] >= period_start]
                base_pt = min(after, key=lambda d: d["date"]) if after else None
            if not base_pt:
                continue
            bv = float(base_pt["value"])
            if bv <= 0:
                continue
            years = max(
                (datetime.strptime(latest_pt["date"], "%Y-%m-%d") - datetime.strptime(base_pt["date"], "%Y-%m-%d")).days / 365.25,
                1 / 365.25
            )
            net  = round((lv - bv) / bv * 100, 2)
            cagr = round((pow(lv / bv, 1 / years) - 1) * 100, 2) if years >= 0.083 else None
            result[label] = {"net": net, "cagr": cagr}
        # Since-inception return using provided inception date
        if inception_str:
            inc_exact = next((d for d in idx_data if d["date"] == inception_str), None)
            if not inc_exact:
                after_inc = [d for d in idx_data if d["date"] >= inception_str]
                inc_exact = min(after_inc, key=lambda d: d["date"]) if after_inc else None
            if inc_exact:
                bv_inc = float(inc_exact["value"])
                if bv_inc > 0:
                    years_inc = max(
                        (datetime.strptime(latest_pt["date"], "%Y-%m-%d") - datetime.strptime(inc_exact["date"], "%Y-%m-%d")).days / 365.25,
                        1 / 365.25
                    )
                    result["Overall"] = {
                        "net":  round((lv - bv_inc) / bv_inc * 100, 2),
                        "cagr": round((pow(lv / bv_inc, 1 / years_inc) - 1) * 100, 2) if years_inc > 0 else None,
                    }
        return result

    out = []
    for bid, bdata in baskets.items():
        clean_name = bdata["name"].lower().replace("nia ", "").strip()
        if clean_name in _BASKET_EXCLUDE_NAMES:
            continue
        inception = _get_inception(bdata["name"])
        out.append({
            "id":        bid,
            "name":      bdata["name"],
            "stats":     bdata["stats"],
            "inception": inception,
            "historic":  _period_returns(bid, bdata["name"]),
        })
    return out
