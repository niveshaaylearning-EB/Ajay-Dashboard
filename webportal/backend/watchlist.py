"""Centralized Watchlist: research-pipeline tracking for stocks under review,
from initial screening through investment-committee approval or rejection.

Shared across all users/baskets (not basket-scoped) -- one flat list, same
JSON-persistence pattern as portfolios.json (see persistence.py), so it
survives redeploys via the same GitHub-push mechanism.

v1 scope: core tracking (list, add-with-autofetch, edit, delete, refresh).
Explicitly deferred to later phases: AI insights/summaries, news feed,
document uploads, draggable Kanban, calendar, alerts engine, role-based
access, versioning, comments.
"""
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from config import YF_HEADERS, YF_SYMBOL_MAP
from persistence import _get_request_email, _log_activity, _save_and_push, BASKET_DISPLAY_NAMES

router = APIRouter()

_WATCHLIST_FILE = Path(__file__).parent / "watchlist.json"
_watchlist_mem: list | None = None

STATUSES = [
    "Initial Screening", "Financial Analysis", "Management Study", "Scuttlebutt",
    "Valuation", "Investment Committee", "Approved", "On Hold", "Rejected",
]
# The real baskets currently in the dashboard -- not a made-up category list,
# so this stays in sync automatically if a basket is ever added/renamed.
PORTFOLIO_TAGS = list(BASKET_DISPLAY_NAMES.values())

# Fields an analyst fills in by hand -- never touched by the auto-fetch/refresh.
_MANUAL_FIELDS = {
    "fairValue", "targetPrice", "riskScore", "qualityScore", "valuationScore",
    "researchScore", "status", "analyst", "thesis", "competitiveAdvantages",
    "growthDrivers", "keyRisks", "industryTailwinds", "valuationSummary",
    "analystNotes", "portfolioTags", "pinned", "nextReview", "company",
}


def _load_watchlist() -> list:
    global _watchlist_mem
    if _watchlist_mem is not None:
        return _watchlist_mem
    if _WATCHLIST_FILE.exists():
        with open(_WATCHLIST_FILE, "r", encoding="utf-8") as f:
            _watchlist_mem = json.load(f)
            return _watchlist_mem
    _watchlist_mem = []
    return _watchlist_mem


def _save_watchlist(data: list) -> None:
    global _watchlist_mem
    _watchlist_mem = data
    _save_and_push(_WATCHLIST_FILE, data)


# ── Yahoo "crumb" session ────────────────────────────────────────────────────
# quoteSummary (unlike the v8 chart endpoint used elsewhere) 401s with
# "Invalid Crumb" unless the request carries both a session cookie and a
# crumb token minted against that same cookie. Fetched once, cached, and
# refreshed automatically if a request comes back 401.
_yf_crumb: str | None = None
_yf_cookies: dict = {}

async def _refresh_yf_crumb() -> None:
    global _yf_crumb, _yf_cookies
    try:
        async with httpx.AsyncClient(follow_redirects=True, headers=YF_HEADERS, timeout=10.0) as client:
            await client.get("https://fc.yahoo.com")
            r = await client.get("https://query2.finance.yahoo.com/v1/test/getcrumb")
            _yf_crumb = r.text.strip() if r.status_code == 200 else None
            _yf_cookies = dict(client.cookies)
    except Exception as e:
        print(f"[watchlist] crumb refresh failed: {e}")
        _yf_crumb = None


async def _fetch_fundamentals(ticker: str) -> dict:
    """
    One Yahoo Finance quoteSummary call, multiple modules at once, covering
    most of the auto-fetchable fields. ROCE and true multi-year Revenue/Profit
    CAGR aren't available from this endpoint -- left for manual entry; the
    growth fields below are Yahoo's trailing revenue/earnings growth (a
    reasonable proxy, not a strict CAGR), clearly distinct in the field name.
    """
    global _yf_crumb
    sym = YF_SYMBOL_MAP.get(ticker, f"{ticker}.NS")
    modules = "price,summaryDetail,defaultKeyStatistics,financialData,assetProfile"
    result = {}
    try:
        if _yf_crumb is None:
            await _refresh_yf_crumb()

        async def _do_request():
            url = (f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{sym}"
                   f"?modules={modules}&crumb={_yf_crumb}")
            async with httpx.AsyncClient(follow_redirects=True, headers=YF_HEADERS,
                                          cookies=_yf_cookies, timeout=10.0) as client:
                return await client.get(url)

        resp = await _do_request()
        if resp.status_code == 401:
            await _refresh_yf_crumb()
            resp = await _do_request()
        if resp.status_code != 200:
            return result
        r = (resp.json().get("quoteSummary") or {}).get("result") or []
        if not r:
            return result
        r = r[0]

        def _raw(module, field):
            v = ((r.get(module) or {}).get(field) or {})
            return v.get("raw") if isinstance(v, dict) else None

        price = r.get("price") or {}
        profile = r.get("assetProfile") or {}

        result["company"]              = price.get("longName") or price.get("shortName")
        result["cmp"]                  = _raw("price", "regularMarketPrice")
        mc = _raw("price", "marketCap")
        result["marketCap"]            = round(mc / 1e7, 1) if mc else None   # raw INR -> Cr
        result["sector"]               = profile.get("sector")
        result["industry"]             = profile.get("industry")
        result["week52High"]           = _raw("summaryDetail", "fiftyTwoWeekHigh")
        result["week52Low"]            = _raw("summaryDetail", "fiftyTwoWeekLow")
        result["pe"]                   = _raw("summaryDetail", "trailingPE")
        result["dividendYield"]        = _raw("summaryDetail", "dividendYield")
        result["pb"]                   = _raw("defaultKeyStatistics", "priceToBook")
        result["evEbitda"]             = _raw("defaultKeyStatistics", "enterpriseToEbitda")
        result["promoterHolding"]      = _raw("defaultKeyStatistics", "heldPercentInsiders")
        result["institutionalHolding"] = _raw("defaultKeyStatistics", "heldPercentInstitutions")
        result["roe"]                  = _raw("financialData", "returnOnEquity")
        result["debtEquity"]           = _raw("financialData", "debtToEquity")
        result["revenueCagr"]          = _raw("financialData", "revenueGrowth")   # proxy, see docstring
        result["profitCagr"]           = _raw("financialData", "earningsGrowth")  # proxy, see docstring
        fcf = _raw("financialData", "freeCashflow")
        result["fcf"]                  = round(fcf / 1e7, 1) if fcf else None    # raw INR -> Cr

        # Percent-like fields come back as fractions (0.15 == 15%) -- normalize to %.
        for k in ("dividendYield", "promoterHolding", "institutionalHolding",
                  "roe", "revenueCagr", "profitCagr"):
            if result.get(k) is not None:
                result[k] = round(result[k] * 100, 2)
        for k in ("cmp", "week52High", "week52Low", "pe", "pb", "evEbitda", "debtEquity"):
            if result.get(k) is not None:
                result[k] = round(result[k], 2)

        result = {k: v for k, v in result.items() if v is not None}
    except Exception as e:
        print(f"[watchlist] fundamentals fetch failed for {ticker}: {e}")
    return result


class WatchlistAddRequest(BaseModel):
    ticker: str
    company: str | None = None


class WatchlistUpdateRequest(BaseModel):
    # All optional -- PUT sends only the fields being changed.
    company: str | None = None
    fairValue: float | None = None
    targetPrice: float | None = None
    riskScore: float | None = None
    qualityScore: float | None = None
    valuationScore: float | None = None
    researchScore: float | None = None
    status: str | None = None
    analyst: str | None = None
    thesis: str | None = None
    competitiveAdvantages: str | None = None
    growthDrivers: str | None = None
    keyRisks: str | None = None
    industryTailwinds: str | None = None
    valuationSummary: str | None = None
    analystNotes: str | None = None
    portfolioTags: list[str] | None = None
    pinned: bool | None = None
    nextReview: str | None = None


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ── Triggers: next-review date reached OR target price hit, whichever first ──
_TERMINAL = ("Approved", "Rejected")

def _record_triggers(rec: dict, today: str) -> dict:
    """Current trigger state for one record -- no persistence, just a snapshot."""
    review_due = bool(rec.get("nextReview") and rec["nextReview"] <= today and rec.get("status") not in _TERMINAL)
    target_hit = bool(
        rec.get("targetPrice") is not None and rec.get("cmp") is not None
        and rec["cmp"] >= rec["targetPrice"] and rec.get("status") not in _TERMINAL
    )
    return {"reviewDue": review_due, "targetHit": target_hit}


def get_watchlist_alerts() -> list:
    """Companies currently past their next-review date or at/above target price --
    read fresh on every call, for the homepage banner. Independent of the
    once-per-condition email tracking in check_and_notify_watchlist_triggers."""
    today = _today()
    alerts = []
    for rec in _load_watchlist():
        trig = _record_triggers(rec, today)
        if trig["reviewDue"]:
            alerts.append({
                "type": "watchlist_review_due", "id": rec["id"], "ticker": rec["ticker"],
                "company": rec["company"], "analyst": rec.get("analyst"),
                "nextReview": rec.get("nextReview"), "status": rec.get("status"),
            })
        if trig["targetHit"]:
            alerts.append({
                "type": "watchlist_target_hit", "id": rec["id"], "ticker": rec["ticker"],
                "company": rec["company"], "analyst": rec.get("analyst"),
                "cmp": rec.get("cmp"), "targetPrice": rec.get("targetPrice"), "status": rec.get("status"),
            })
    return alerts


def check_and_notify_watchlist_triggers():
    """
    Background-thread entrypoint (see backend/main.py's startup daemon
    thread). Emails the analyst the FIRST time either trigger fires for a
    company; a `_notified` flag per-record/per-trigger stops repeat emails.
    If the underlying value changes so the trigger is no longer true (review
    date pushed out, target price raised further away from CMP), the flag
    resets itself here so a future re-trigger can email again -- no special
    casing needed in the edit endpoint for that.
    """
    from auth import _send_email   # backend/auth.py -- always on sys.path first, see main.py
    today = _today()
    data = _load_watchlist()
    changed = False
    for rec in data:
        notified = rec.setdefault("_notified", {})
        trig = _record_triggers(rec, today)
        for key, subject, detail in (
            ("reviewDue", "Next review date reached",
             f"{rec['company']} ({rec['ticker']}) was due for review on {rec.get('nextReview')}."),
            ("targetHit", "Target price reached",
             f"{rec['company']} ({rec['ticker']}) has reached its target price of "
             f"₹{rec.get('targetPrice')} (CMP ₹{rec.get('cmp')})."),
        ):
            if trig[key] and not notified.get(key):
                email = (rec.get("analyst") or "").strip()
                if email and "@" in email:
                    try:
                        _send_email(email, f"[Watchlist] {subject}: {rec['ticker']}",
                                     f"{detail}\n\nOpen the Watchlist tab in the dashboard for details.")
                    except Exception as e:
                        print(f"[watchlist] alert email failed for {email}: {e}")
                notified[key] = True
                changed = True
            elif not trig[key] and notified.get(key):
                notified[key] = False
                changed = True
    if changed:
        _save_watchlist(data)


@router.get("/api/watchlist")
async def get_watchlist():
    return _load_watchlist()


@router.get("/api/watchlist/alerts")
async def get_watchlist_alerts_endpoint():
    return get_watchlist_alerts()


@router.get("/api/watchlist/meta")
async def get_watchlist_meta():
    """Static reference data the frontend needs: valid statuses + portfolio tags."""
    return {"statuses": STATUSES, "portfolioTags": PORTFOLIO_TAGS}


@router.post("/api/watchlist")
async def add_watchlist_company(item: WatchlistAddRequest, request: Request):
    ticker = item.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=422, detail="Ticker is required.")

    data = _load_watchlist()
    if any(c["ticker"] == ticker for c in data):
        raise HTTPException(status_code=409, detail=f"{ticker} is already on the watchlist.")

    email = _get_request_email(request) or "unknown"
    fetched = await _fetch_fundamentals(ticker)

    record = {
        "id": str(uuid.uuid4()),
        "ticker": ticker,
        "company": item.company or fetched.get("company") or ticker,
        "sector": None, "industry": None, "marketCap": None, "cmp": None,
        "week52High": None, "week52Low": None, "pe": None, "evEbitda": None, "pb": None,
        "roe": None, "roce": None, "debtEquity": None, "revenueCagr": None, "profitCagr": None,
        "fcf": None, "promoterHolding": None, "institutionalHolding": None, "dividendYield": None,
        "fairValue": None, "targetPrice": None,
        "riskScore": None, "qualityScore": None, "valuationScore": None, "researchScore": None,
        "status": "Initial Screening", "analyst": email,
        "thesis": "", "competitiveAdvantages": "", "growthDrivers": "", "keyRisks": "",
        "industryTailwinds": "", "valuationSummary": "", "analystNotes": "",
        "portfolioTags": [], "pinned": False,
        # Who actually created this entry, captured once at add-time -- distinct
        # from "analyst" (a reassignable "who's currently working this" field
        # anyone can edit later). addedBy/addedAt are never touched by
        # update_watchlist_company below, so editing/reassigning an entry can
        # never overwrite who originally added it.
        "addedBy": email, "addedAt": datetime.now(timezone.utc).isoformat(),
        "dateAdded": _today(), "lastUpdated": _today(), "nextReview": None,
    }
    for k, v in fetched.items():
        if k in record and k != "company":
            record[k] = v

    data.append(record)
    _save_watchlist(data)
    _log_activity("watchlist_add", email, {"ticker": ticker, "company": record["company"]})
    return record


@router.put("/api/watchlist/{item_id}")
async def update_watchlist_company(item_id: str, item: WatchlistUpdateRequest, request: Request):
    data = _load_watchlist()
    rec = next((c for c in data if c["id"] == item_id), None)
    if not rec:
        raise HTTPException(status_code=404, detail="Watchlist entry not found.")

    email = _get_request_email(request) or "unknown"
    patch = {k: v for k, v in item.model_dump().items() if v is not None}
    if patch.get("status") and patch["status"] not in STATUSES:
        raise HTTPException(status_code=422, detail=f"Invalid status: {patch['status']}")

    rec.update(patch)
    rec["lastUpdated"] = _today()
    _save_watchlist(data)
    _log_activity("watchlist_update", email, {"ticker": rec["ticker"], "fields": list(patch.keys())})
    return rec


@router.post("/api/watchlist/{item_id}/refresh")
async def refresh_watchlist_company(item_id: str, request: Request):
    data = _load_watchlist()
    rec = next((c for c in data if c["id"] == item_id), None)
    if not rec:
        raise HTTPException(status_code=404, detail="Watchlist entry not found.")

    fetched = await _fetch_fundamentals(rec["ticker"])
    for k, v in fetched.items():
        if k in rec and k not in _MANUAL_FIELDS:
            rec[k] = v
    rec["lastUpdated"] = _today()
    _save_watchlist(data)

    email = _get_request_email(request) or "unknown"
    _log_activity("watchlist_refresh", email, {"ticker": rec["ticker"]})
    return rec


@router.delete("/api/watchlist/{item_id}")
async def delete_watchlist_company(item_id: str, request: Request):
    data = _load_watchlist()
    rec = next((c for c in data if c["id"] == item_id), None)
    if not rec:
        raise HTTPException(status_code=404, detail="Watchlist entry not found.")

    data = [c for c in data if c["id"] != item_id]
    _save_watchlist(data)

    email = _get_request_email(request) or "unknown"
    _log_activity("watchlist_delete", email, {"ticker": rec["ticker"], "company": rec["company"]})
    return {"status": "success"}
