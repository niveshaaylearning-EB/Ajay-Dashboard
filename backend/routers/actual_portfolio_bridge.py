"""Bridge routes that read basket/holdings data from the webportal sub-app.

_fetch_all_webportal_baskets() and _fetch_index_history() are used across
several other routers (stocks, historic, benchmarks, rebalance_alerts) and
by main.py's startup pre-warm — this module is their single shared home.
"""
import time as _time
import requests as _http
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException

router = APIRouter()

# ── Actual Portfolio proxy (webportal mounted in-process at /wp) ────────────

_WEBPORTAL = "http://127.0.0.1:8100/wp"
_wp_all_cache: dict = {"data": None, "ts": 0.0}
_WP_ALL_TTL = 60 * 60  # 60 min — cache basket+live data longer on cloud

_wp_index_cache: dict = {"data": None, "ts": 0.0}

_WP_BASKET_LABELS = {
    'Green_Energy':    'Green Energy',
    'Mid_Small_Cap':   'Mid & Small Cap',
    'Consumer_Trends': 'Consumer Trends',
    'IPO_Basket':      'IPO Basket',
    'Trends_Triology': 'Trends Triology',
    'Techstack':       'Techstack',
    'Make_in_India':   'Make in India',
}

def _fetch_index_history() -> dict:
    """Fetch webportal historical index data. Cached 5 min."""
    global _wp_index_cache
    now = _time.time()
    if _wp_index_cache["data"] and (now - _wp_index_cache["ts"]) < _WP_ALL_TTL:
        return _wp_index_cache["data"]
    try:
        r = _http.get(f"{_WEBPORTAL}/api/index-history", timeout=8)
        r.raise_for_status()
        _wp_index_cache = {"data": r.json(), "ts": now}
        return _wp_index_cache["data"]
    except Exception:
        return _wp_index_cache["data"] or {}

def _fetch_all_webportal_baskets() -> dict:
    """Internal helper — fetch all webportal baskets with holdings. Cached 5 min."""
    global _wp_all_cache
    now = _time.time()
    if _wp_all_cache["data"] and (now - _wp_all_cache["ts"]) < _WP_ALL_TTL:
        return _wp_all_cache["data"]

    def _get_wb():
        return _http.get(f"{_WEBPORTAL}/api/baskets", timeout=6).json()
    def _get_live():
        try:
            return _http.get(f"{_WEBPORTAL}/api/live", timeout=8).json()
        except Exception:
            return {}

    from concurrent.futures import ThreadPoolExecutor as _BPE2
    with _BPE2(max_workers=2) as p2:
        f_wb   = p2.submit(_get_wb)
        f_live = p2.submit(_get_live)
        try:
            wb = f_wb.result()
        except Exception:
            return _wp_all_cache["data"] or {}
        live_map = f_live.result()

    def _fetch_one_basket(kv):
        key, label = kv
        try:
            return key, label, _http.get(f"{_WEBPORTAL}/api/basket/{key}", timeout=8).json()
        except Exception:
            return key, label, None

    from concurrent.futures import ThreadPoolExecutor as _BPE
    with _BPE(max_workers=min(len(wb), 10)) as pool:
        fetched = list(pool.map(_fetch_one_basket, wb.items()))

    result = {}
    for key, label, bdata in fetched:
        if bdata is None:
            continue
        stocks = bdata.get("stocks") or []   # webportal returns a list
        bpd    = bdata.get("buyPriceDetails") or {}
        holdings = []
        for stock in stocks:
            nse   = (stock.get("nseCode") or stock.get("nse") or "").strip().upper()
            if not nse:
                continue
            alloc = float(stock.get("allocation") or 0) * 100  # webportal stores as 0-1 fraction
            if alloc <= 0:
                # Zero-allocation rows are stale/sold-but-not-removed leftovers
                # (portfolios.json has historically accumulated a few of these) --
                # not an active holding, so exclude from counts/averages/calendar.
                continue
            bp    = float((bpd.get(nse) or {}).get("buyPrice") or stock.get("buyPrice") or 0)
            cmp_v = float((live_map.get(nse) or {}).get("cmp") or 0)
            perf  = round(((cmp_v - bp) / bp * 100) if bp > 0 else 0, 2)
            sname = stock.get("securityName") or stock.get("name") or nse
            holdings.append({
                "code": nse, "stock_name": sname,
                "allocation": alloc, "buy_price": bp, "cmp": cmp_v,
                "performance": perf, "sector": "", "theme": label,
            })
        total_alloc = sum(h["allocation"] for h in holdings)
        if total_alloc > 0:
            basket_ret = sum(h["performance"] * h["allocation"] for h in holdings) / total_alloc
        elif holdings:
            basket_ret = sum(h["performance"] for h in holdings) / len(holdings)
        else:
            basket_ret = 0.0
        result[key] = {
            "id": key, "name": label, "holdings": holdings,
            "stats": {"basket_return": round(basket_ret, 2), "stock_count": len(holdings)},
        }

    # Only cache if we got valid CMP data — if all 0, webportal wasn't ready yet
    # so don't cache (next request will retry and get real prices). This guard
    # used to read `total_holdings == 0 or valid_cmps > 0`, which is inverted
    # from the comment's own stated intent: total_holdings == 0 is the WORSE
    # failure (webportal returned no basket data at all, e.g. mid-startup
    # race), yet that condition alone made the `or` true and cached the empty
    # result anyway for the full 60-minute TTL -- confirmed live via a stale
    # empty /api/baskets response that only cleared after a manual restart.
    total_holdings = sum(len(v.get("holdings", [])) for v in result.values())
    valid_cmps     = sum(1 for v in result.values()
                        for h in v.get("holdings", []) if h.get("cmp", 0) > 0)
    if total_holdings > 0 and valid_cmps > 0:
        _wp_all_cache = {"data": result, "ts": now}

    return result


@router.get("/api/actual-portfolio-baskets")
def get_actual_portfolio_baskets():
    """Return the list of basket keys available in the webportal."""
    try:
        r = _http.get(f"{_WEBPORTAL}/api/baskets", timeout=8)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Webportal unreachable: {e}")


@router.get("/api/basket-period-returns")
def get_basket_period_returns(period: str = "1M"):
    """
    Compute basket-level period returns from the webportal's historical index data.
    Source: webportal GET /api/index-history (historical_index.json).
    period: 1W=7d, 1M=30d, 3M=90d, 6M=182d, 1Y=365d
    Returns {basket_key: {name, net, cagr, base_date, latest_date}}
    """
    period_days = {'1W': 7, '1M': 30, '3M': 90, '6M': 182, '1Y': 365}
    days = period_days.get(period.upper(), 30)
    today = datetime.now().date()
    base_date_str = (today - timedelta(days=days)).isoformat()

    hi = _fetch_index_history()
    if not hi:
        raise HTTPException(status_code=503, detail="Webportal index history unavailable")

    def _find_closest(data, target):
        exact = next((d for d in data if d["date"] == target), None)
        if exact:
            return exact
        after = [d for d in data if d["date"] >= target]
        if after:
            return min(after, key=lambda d: d["date"])
        return max(data, key=lambda d: d["date"]) if data else None

    result = {}
    for basket_key, info in hi.items():
        data = info.get("data", [])
        if not data:
            continue
        base_pt   = _find_closest(data, base_date_str)
        latest_pt = max(data, key=lambda d: d["date"])
        if not base_pt or not latest_pt:
            continue
        bv = float(base_pt["value"])
        lv = float(latest_pt["value"])
        if bv <= 0:
            continue
        years = max(
            (datetime.strptime(latest_pt["date"], "%Y-%m-%d") - datetime.strptime(base_pt["date"], "%Y-%m-%d")).days / 365.25,
            1 / 365.25
        )
        net  = round((lv - bv) / bv * 100, 2)
        cagr = round((pow(lv / bv, 1 / years) - 1) * 100, 2) if years >= 0.083 else None
        result[basket_key] = {
            "name":        _WP_BASKET_LABELS.get(basket_key, basket_key),
            "net":         net,
            "cagr":        cagr,
            "base_date":   base_pt["date"],
            "latest_date": latest_pt["date"],
        }
    return result


@router.get("/api/actual-portfolio-all")
def get_actual_portfolio_all():
    """All webportal baskets with holdings, shaped like /api/baskets. Cached 5 min."""
    data = _fetch_all_webportal_baskets()
    if not data:
        raise HTTPException(status_code=503, detail="Webportal unreachable or no data")
    return data


@router.get("/api/actual-portfolio-sync/{basket_key}")
def sync_from_actual_portfolio(basket_key: str):
    """
    Fetch basket data from the webportal and return it shaped for the simulator.
    Each holding includes: code, name, allocation, buy_price, cmp.
    """
    try:
        r = _http.get(f"{_WEBPORTAL}/api/basket/{basket_key}", timeout=10)
        r.raise_for_status()
        basket_data = r.json()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Webportal unreachable: {e}")

    live_map = {}
    try:
        lr = _http.get(f"{_WEBPORTAL}/api/live", timeout=10)
        live_map = lr.json() if lr.ok else {}
    except Exception:
        pass

    stocks = basket_data.get("stocks") or []   # webportal returns a list
    buy_details = basket_data.get("buyPriceDetails") or {}

    holdings = []
    for stock in stocks:
        nse = (stock.get("nseCode") or stock.get("nse") or "").strip().upper()
        if not nse:
            continue
        allocation = float(stock.get("allocation") or 0)
        buy_price  = float((buy_details.get(nse) or {}).get("buyPrice") or stock.get("buyPrice") or 0)
        cmp        = float((live_map.get(nse) or {}).get("cmp") or 0)
        name       = stock.get("securityName") or stock.get("name") or nse
        holdings.append({
            "code": nse,
            "name": name,
            "allocation": allocation,
            "buy_price": buy_price,
            "cmp": cmp,
        })

    return {"holdings": holdings, "basket_key": basket_key, "count": len(holdings)}
