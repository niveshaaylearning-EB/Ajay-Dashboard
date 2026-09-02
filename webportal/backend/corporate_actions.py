"""Corporate-action adjustments: stock split, bonus issue, demerger.

Every adjustment requires explicit admin approval and is stored separately
from buyEvents/buyOHLC. Approved split/bonus/demerger(parent-side) records
are applied only as a read-time overlay when computing a stock's CURRENT
weighted-average buy price (see the lazy `_ca_overlay_for` import inside
calc_buy_price / calc_all_baskets / _recalc_basket_buy_prices in
buy_price_gains.py). The overlay never mutates stored buyOHLC/buyEvents, so
already-realized historical gain calculations (FIFO sell math in
_compute_fifo_gains_for_series) are completely unaffected -- only the "current
open position" buy price changes, and only after an admin approves it.
"""
import asyncio
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Request

from persistence import (
    BASKET_DISPLAY_NAMES, _require_admin, _log_activity,
    _load_portfolios, _save_portfolios,
    _load_buy_price_data, _save_buy_price_data,
)
from common.json_store import save_json as _common_save_json
from buy_price_gains import (
    _parse_buy_events, _current_series_buy_events, _date_to_ts, _add_event,
    _recalc_basket_buy_prices,
)

router = APIRouter()

_CA_FILE = Path(__file__).parent / "corporate_actions.json"
_ca_mem: list | None = None

VALID_TYPES = {"split", "bonus", "demerger"}


def _load_ca() -> list:
    global _ca_mem
    if _ca_mem is not None:
        return _ca_mem
    if _CA_FILE.exists():
        with open(_CA_FILE, "r", encoding="utf-8") as f:
            _ca_mem = json.load(f)
            return _ca_mem
    _ca_mem = []
    return _ca_mem


def _save_ca(data: list) -> None:
    global _ca_mem
    _ca_mem = data
    _common_save_json(str(_CA_FILE), data, f"webportal/backend/{_CA_FILE.name}", sync=False)


def _factor(record: dict) -> float:
    """Adjustment divisor for a split/bonus record's ratio (see PLAN.md formulas):
    split = old_face_value / new_face_value; bonus = (existing+bonus) / existing."""
    if record["type"] == "split":
        return record["ratio"]["old"] / record["ratio"]["new"]
    if record["type"] == "bonus":
        r = record["ratio"]
        return (r["existing"] + r["bonus"]) / r["existing"]
    raise ValueError("_factor() only applies to split/bonus records")


def _eligible_and_ineligible(basket: str, code: str, ex_date: str) -> tuple[list, list]:
    """Split the stock's CURRENT active-series buy events (the same set the
    existing weighted-average formula already treats as "the position") into
    those dated before the ex-date (eligible) and on/after it (ineligible).
    Reuses _current_series_buy_events -- no new sell-allocation logic."""
    bp = _load_buy_price_data().get(basket, {}).get(code, {})
    all_buy  = _parse_buy_events(bp.get("buyEvents")  or "")
    all_sell = _parse_buy_events(bp.get("sellEvents") or "")
    series = _current_series_buy_events(all_buy, all_sell)
    ex_ts = _date_to_ts(ex_date)
    eligible   = [(d, q) for d, q in series if _date_to_ts(d) < ex_ts]
    ineligible = [(d, q) for d, q in series if _date_to_ts(d) >= ex_ts]
    return eligible, ineligible


def _ca_overlay_for(basket: str, code: str) -> dict:
    """{date_str: adjusted_price} for every APPROVED record on this stock,
    applied only to the current active series' buy events dated before the
    record's ex-date. Never touches stored buyOHLC. Called lazily from
    buy_price_gains.py to avoid a circular import (that module is imported
    at the top of this one)."""
    overlay: dict[str, float] = {}
    bp = _load_buy_price_data().get(basket, {}).get(code, {})
    raw_ohlc = bp.get("buyOHLC") or {}
    for rec in _load_ca():
        if rec["status"] != "approved" or rec["basketKey"] != basket or rec["nseCode"] != code:
            continue
        eligible, _ = _eligible_and_ineligible(basket, code, rec["exDate"])
        eligible_dates = {d for d, _ in eligible}
        overrides = rec.get("priceOverrides") or {}
        if rec["type"] in ("split", "bonus"):
            factor = _factor(rec)
            for d in eligible_dates:
                if d in raw_ohlc:
                    overlay[d] = overrides[d] if d in overrides else round(raw_ohlc[d] / factor, 4)
        elif rec["type"] == "demerger":
            parent_pct = rec["demerger"]["costAllocationPct"]["parent"] / 100
            for d in eligible_dates:
                if d in raw_ohlc:
                    overlay[d] = overrides[d] if d in overrides else round(raw_ohlc[d] * parent_pct, 4)
    return overlay


# ─────────────────────────────────────────────────────────────────────────────
# Auto-detection: scan every stock actually held across baskets for splits/
# bonuses via Yahoo Finance's public chart-events feed (the same source the
# existing hand-entered records already cite in their `source` field -- this
# just automates that lookup instead of an admin doing it by hand). NSE's own
# site blocks this server's outbound requests outright (even the homepage
# 403s before any API call), so Yahoo is the only source that's actually
# reachable here. Demergers aren't covered: Yahoo's feed has no way to
# distinguish one from a large ordinary price move, and the cost-allocation
# % a demerger record needs isn't in this feed at all -- that still requires
# a human to notice the news and fill it in by hand via the create form above.
# Yahoo's `splits` events don't distinguish a true face-value split from a
# bonus issue (both are just a share-count ratio to it) -- since _factor()
# computes the exact same price-adjustment divisor either way (old/new here
# vs (existing+bonus)/existing for a manually-entered bonus), every detected
# event is drafted as type="split" with ratio.old/new set to the numerator/
# denominator; an admin can retype it as a bonus before approving if they
# know that's what it actually was, with no change to the resulting math.
_YF_SCAN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
}
_IST = timezone(timedelta(hours=5, minutes=30))
SCAN_BASKETS = [k for k in BASKET_DISPLAY_NAMES if k != "IPO_Recommendations"]


async def _fetch_recent_splits_yf(code: str, client: httpx.AsyncClient) -> list[dict]:
    """Recent (6mo) split/bonus-as-split events for one NSE code, from Yahoo's
    chart-events feed. Returns [] on any failure -- one stock's bad data/
    network hiccup should never abort the whole scan."""
    try:
        resp = await client.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{code}.NS",
            params={"range": "6mo", "interval": "1d", "events": "split,div"},
        )
        if resp.status_code != 200:
            return []
        result = ((resp.json().get("chart") or {}).get("result")) or []
        if not result:
            return []
        splits = ((result[0].get("events") or {}).get("splits")) or {}
        out = []
        for s in splits.values():
            num, den, ts = s.get("numerator"), s.get("denominator"), s.get("date")
            if not num or not den or not ts:
                continue
            ex_date = datetime.fromtimestamp(ts, tz=_IST).strftime("%d %b %Y")
            out.append({"exDate": ex_date, "old": num, "new": den, "splitRatio": s.get("splitRatio")})
        return out
    except Exception:
        return []


async def scan_for_new_actions(admin_email: str) -> dict:
    """Fetch recent splits for every stock actually held across SCAN_BASKETS
    and draft a pending_review record (identical shape/flow to a manually
    created one) for any not already on file. Never auto-approves anything --
    the admin still reviews/approves/rejects exactly as before."""
    portfolios = _load_portfolios()
    pairs = []
    for basket in SCAN_BASKETS:
        for stk in portfolios.get(basket, []):
            code = (stk.get("nseCode") or "").strip().upper()
            if code and code != "LIQUIDCASE":
                pairs.append((basket, code))
    unique_codes = {code for _, code in pairs}

    splits_by_code: dict[str, list] = {}
    sem = asyncio.Semaphore(10)

    async def _lookup(code: str, client: httpx.AsyncClient):
        async with sem:
            splits_by_code[code] = await _fetch_recent_splits_yf(code, client)

    async with httpx.AsyncClient(headers=_YF_SCAN_HEADERS, timeout=12.0, follow_redirects=True) as client:
        await asyncio.gather(*(_lookup(code, client) for code in unique_codes))

    existing = _load_ca()

    def _already_known(basket: str, code: str, ex_date: str) -> bool:
        return any(r["basketKey"] == basket and r["nseCode"] == code
                   and r["exDate"] == ex_date and r["status"] != "rejected" for r in existing)

    created = []
    for basket, code in pairs:
        for s in splits_by_code.get(code, []):
            if _already_known(basket, code, s["exDate"]):
                continue
            ratio_label = s["splitRatio"] or f"{s['old']}:{s['new']}"
            rec = {
                "id": str(uuid.uuid4()),
                "basketKey": basket, "nseCode": code, "securityName": "",
                "type": "split",
                "exDate": s["exDate"], "recordDate": "",
                "ratio": {"old": s["old"], "new": s["new"]},
                "demerger": None,
                "priceOverrides": {},
                "source": (f"Auto-detected from Yahoo Finance (share ratio {ratio_label}) -- verify against "
                           "the official NSE/BSE announcement, and retype as Bonus Issue if that's what this "
                           "actually was, before approving."),
                "status": "pending_review",
                "createdAt": time.strftime("%d %b %Y %H:%M"), "createdBy": admin_email,
                "approvedBy": None, "approvedAt": None,
                "reversalOf": None,
            }
            rec["comparisonReport"] = build_comparison_report(basket, code, rec)
            existing.append(rec)
            created.append(rec)

    if created:
        _save_ca(existing)
        _log_activity("corporate_action_auto_scan", admin_email,
                       {"createdCount": len(created), "checkedStocks": len(unique_codes)})

    return {"checkedStocks": len(unique_codes), "checkedPairs": len(pairs), "created": created}


def _weighted_avg(events: list, ohlc: dict) -> float | None:
    """Same inline formula as calc_buy_price/calc_all_baskets/_recalc_basket_buy_prices
    (Sigma(weight*price)/Sigma(weight)) -- used here only to preview the comparison
    report; the live dashboard path is never routed through this function."""
    priced = [(q, ohlc[d]) for d, q in events if d in ohlc]
    total_qty = sum(q for q, _ in priced)
    if total_qty <= 1e-9:
        return None
    return round(sum(q * p for q, p in priced) / total_qty, 4)


def build_comparison_report(basket: str, code: str, rec: dict) -> dict:
    """Read-only preview: current buy price vs. what it would become if `rec`
    were approved. Reused by create/edit (so the admin sees fresh numbers
    before approving) -- one implementation, not a separate formula."""
    bp = _load_buy_price_data().get(basket, {}).get(code, {})
    raw_ohlc = bp.get("buyOHLC") or {}
    all_buy  = _parse_buy_events(bp.get("buyEvents")  or "")
    all_sell = _parse_buy_events(bp.get("sellEvents") or "")
    series = _current_series_buy_events(all_buy, all_sell)

    current_price = _weighted_avg(series, raw_ohlc)

    eligible, ineligible = _eligible_and_ineligible(basket, code, rec["exDate"])
    adjusted_ohlc = dict(raw_ohlc)
    detail = []
    # Per-date manual corrections (admin-entered) -- take precedence over the
    # ratio/cost-allocation math below for whichever dates they cover, so a
    # single wrong data point (e.g. Yahoo misreported one day's OHLC) can be
    # fixed by hand without distorting every other lot's auto-computed price.
    overrides = rec.get("priceOverrides") or {}

    if rec["type"] in ("split", "bonus"):
        factor = _factor(rec)
        for d, q in eligible:
            if d in raw_ohlc:
                new_price = overrides[d] if d in overrides else round(raw_ohlc[d] / factor, 4)
                adjusted_ohlc[d] = new_price
                detail.append({"date": d, "weight": q, "oldPrice": raw_ohlc[d], "newPrice": new_price,
                               "overridden": d in overrides})
    elif rec["type"] == "demerger":
        parent_pct = rec["demerger"]["costAllocationPct"]["parent"] / 100
        for d, q in eligible:
            if d in raw_ohlc:
                new_price = overrides[d] if d in overrides else round(raw_ohlc[d] * parent_pct, 4)
                adjusted_ohlc[d] = new_price
                detail.append({"date": d, "weight": q, "oldPrice": raw_ohlc[d], "newPrice": new_price,
                               "overridden": d in overrides})

    revised_price = _weighted_avg(series, adjusted_ohlc)

    report = {
        "currentBuyPrice": current_price,
        "revisedBuyPrice": revised_price,
        "difference": (round(revised_price - current_price, 4)
                       if current_price is not None and revised_price is not None else None),
        "eligibleEvents":   detail,
        "ineligibleEvents": [{"date": d, "weight": q, "price": raw_ohlc.get(d)} for d, q in ineligible],
    }

    if rec["type"] == "demerger":
        dm = rec["demerger"] or {}
        car = dm.get("costAllocationPct") or {}
        ent = dm.get("entitlementRatio") or {}
        per_event = []
        entitlement = None
        if ent.get("parent"):
            entitlement = ent["resulting"] / ent["parent"]
            resulting_pct = (car.get("resulting", 0) or 0) / 100
            for d, q in eligible:
                if d in raw_ohlc and entitlement:
                    resulting_price = round(raw_ohlc[d] * resulting_pct / entitlement, 4)
                    per_event.append({"date": d, "parentWeight": q, "resultingBuyPrice": resulting_price})
        report["resultingCompanyPreview"] = {
            "entitlementRatio": entitlement,
            "perEventBuyPrice": per_event,
            "resultingWeight": dm.get("resultingWeight"),
        }

    return report


def _validate_record_shape(body: dict) -> None:
    if body.get("type") not in VALID_TYPES:
        raise HTTPException(400, "type must be one of: split, bonus, demerger")
    if body.get("basketKey") not in BASKET_DISPLAY_NAMES:
        raise HTTPException(400, f"Unknown basket: {body.get('basketKey')}")
    if not body.get("nseCode"):
        raise HTTPException(400, "nseCode is required")
    if not body.get("exDate"):
        raise HTTPException(400, "exDate is required")
    if body["type"] == "split":
        r = body.get("ratio") or {}
        if not r.get("old") or not r.get("new"):
            raise HTTPException(400, "split requires ratio.old and ratio.new (old/new face value)")
    if body["type"] == "bonus":
        r = body.get("ratio") or {}
        if not r.get("existing") or not r.get("bonus"):
            raise HTTPException(400, "bonus requires ratio.existing and ratio.bonus")
    if body["type"] == "demerger":
        dm = body.get("demerger") or {}
        if not dm.get("resultingCompanyName"):
            raise HTTPException(400, "demerger requires demerger.resultingCompanyName")
        car = dm.get("costAllocationPct") or {}
        if not car.get("parent") or not car.get("resulting"):
            raise HTTPException(400, "demerger requires demerger.costAllocationPct.parent and .resulting")
        ent = dm.get("entitlementRatio") or {}
        if not ent.get("parent") or not ent.get("resulting"):
            raise HTTPException(400, "demerger requires demerger.entitlementRatio.parent and .resulting")


def _find_or_404(records: list, ca_id: str) -> dict:
    rec = next((r for r in records if r["id"] == ca_id), None)
    if not rec:
        raise HTTPException(404, "Corporate action not found.")
    return rec


def _create_resulting_company_stock(rec: dict) -> None:
    """Seed the resulting company as a new stock in the SAME basket: one buy
    event per eligible parent lot (same acquisition dates as the parent, so
    holding-period/FIFO semantics stay meaningful), each priced via the
    demerger formula and weighted proportionally out of the admin-set total
    resultingWeight. The resulting company's OHLC is seeded directly (not
    fetched -- it may not have existed as a distinct listing on these dates),
    mirroring the minimal write-set rebalance.py already uses for a new stock."""
    basket = rec["basketKey"]
    dm = rec["demerger"]
    resulting_code = (dm.get("resultingNseCode") or dm["resultingCompanyName"]).strip().upper().replace(" ", "_")

    eligible, _ = _eligible_and_ineligible(basket, rec["nseCode"], rec["exDate"])
    total_eligible_weight = sum(q for _, q in eligible)
    if total_eligible_weight <= 1e-9:
        raise HTTPException(400, "No eligible pre-ex-date buy events found for the parent stock -- nothing to demerge.")

    bp_data = _load_buy_price_data()
    basket_bp = bp_data.setdefault(basket, {})
    parent_ohlc = (basket_bp.get(rec["nseCode"], {}) or {}).get("buyOHLC", {}) or {}

    entitlement = dm["entitlementRatio"]["resulting"] / dm["entitlementRatio"]["parent"]
    resulting_pct = dm["costAllocationPct"]["resulting"] / 100
    resulting_weight_total = float(dm["resultingWeight"])

    for d, parent_q in eligible:
        if d not in parent_ohlc:
            continue
        event_weight = round(resulting_weight_total * (parent_q / total_eligible_weight), 4)
        resulting_price = round(parent_ohlc[d] * resulting_pct / entitlement, 4) if entitlement else None
        if event_weight <= 0 or resulting_price is None:
            continue
        _add_event(basket_bp, resulting_code, "buyEvents", d, event_weight)
        basket_bp[resulting_code]["securityName"] = dm["resultingCompanyName"]
        basket_bp[resulting_code].setdefault("buyOHLC", {})[d] = resulting_price

    _save_buy_price_data(bp_data)

    portfolios = _load_portfolios()
    basket_stks = portfolios.setdefault(basket, [])
    if not any(s["nseCode"] == resulting_code for s in basket_stks):
        basket_stks.append({
            "nseCode": resulting_code,
            "allocation": round(resulting_weight_total / 100, 6),
            "buyPrice": None,
        })
    _save_portfolios(portfolios)


# ─────────────────────────────────────────────────────────────────────────────
# Routes -- all admin-only, mirroring _require_admin usage in rebalance.py
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/api/corporate-actions")
async def list_corporate_actions():
    """Read-only, no admin gate -- same pattern as get_basket/get_gains_statement/
    get_ohlc_fallbacks: non-admins can view the corporate-actions log, but every
    mutating route below (create/scan/update/approve/reject/reverse) still
    requires _require_admin."""
    return _load_ca()


@router.get("/api/corporate-actions/status/{basket}/{code}")
async def corporate_action_status(basket: str, code: str):
    """Read-only, no admin gate: just enough for the what-if simulator (used by
    non-admins too) to warn "this stock has a pending/approved corporate action
    -- buy prices before the ex-date may look inconsistent until it's resolved"
    without exposing full record detail like list_corporate_actions does."""
    code = code.strip().upper()
    records = [
        {"type": r["type"], "exDate": r["exDate"], "ratio": r.get("ratio"), "status": r["status"]}
        for r in _load_ca()
        if r["basketKey"] == basket and r["nseCode"] == code and r["status"] in ("pending_review", "approved")
    ]
    return {"records": records}


@router.post("/api/corporate-actions")
async def create_corporate_action(request: Request, body: dict = Body(...)):
    admin_email = _require_admin(request)
    _validate_record_shape(body)

    records = _load_ca()
    dup = next((r for r in records
                if r["basketKey"] == body["basketKey"] and r["nseCode"] == body["nseCode"]
                and r["type"] == body["type"] and r["exDate"] == body["exDate"]
                and r["status"] != "rejected"), None)
    if dup:
        raise HTTPException(400, f"A {body['type']} for {body['nseCode']} on {body['exDate']} "
                                  f"already exists (id={dup['id']}, status={dup['status']}).")

    rec = {
        "id": str(uuid.uuid4()),
        "basketKey": body["basketKey"], "nseCode": body["nseCode"],
        "securityName": body.get("securityName", ""),
        "type": body["type"],
        "exDate": body["exDate"], "recordDate": body.get("recordDate", ""),
        "ratio": body.get("ratio"),
        "demerger": body.get("demerger"),
        "priceOverrides": body.get("priceOverrides") or {},
        "source": body.get("source", "manual entry"),
        "status": "pending_review",
        "createdAt": time.strftime("%d %b %Y %H:%M"), "createdBy": admin_email,
        "approvedBy": None, "approvedAt": None,
        "reversalOf": None,
    }
    rec["comparisonReport"] = build_comparison_report(rec["basketKey"], rec["nseCode"], rec)
    records.append(rec)
    _save_ca(records)
    _log_activity("corporate_action_created", admin_email,
                   {"id": rec["id"], "type": rec["type"], "nseCode": rec["nseCode"]})
    return rec


@router.post("/api/corporate-actions/scan")
async def scan_corporate_actions(request: Request):
    """Admin-triggered: check every stock actually held across baskets for
    recent splits/bonuses via Yahoo Finance, drafting a pending_review record
    for anything not already on file. Nothing is auto-approved -- results
    land in the normal review queue above."""
    admin_email = _require_admin(request)
    result = await scan_for_new_actions(admin_email)
    return {
        "checkedStocks": result["checkedStocks"],
        "checkedPairs": result["checkedPairs"],
        "createdCount": len(result["created"]),
        "created": result["created"],
    }


@router.put("/api/corporate-actions/{ca_id}")
async def update_corporate_action(ca_id: str, request: Request, body: dict = Body(...)):
    admin_email = _require_admin(request)
    records = _load_ca()
    rec = _find_or_404(records, ca_id)
    if rec["status"] not in ("pending_review", "approved"):
        raise HTTPException(400, f"Cannot edit a {rec['status']} corporate action.")

    for field in ("securityName", "exDate", "recordDate", "ratio", "demerger", "source", "priceOverrides"):
        if field in body:
            rec[field] = body[field]

    rec["comparisonReport"] = build_comparison_report(rec["basketKey"], rec["nseCode"], rec)
    _save_ca(records)
    _log_activity("corporate_action_edited", admin_email, {"id": rec["id"]})
    return rec


@router.post("/api/corporate-actions/{ca_id}/approve")
async def approve_corporate_action(ca_id: str, request: Request, background_tasks: BackgroundTasks):
    admin_email = _require_admin(request)
    records = _load_ca()
    rec = _find_or_404(records, ca_id)
    if rec["status"] != "pending_review":
        raise HTTPException(400, f"Only a pending_review action can be approved (current status: {rec['status']}).")

    if rec["type"] == "demerger":
        dm = rec["demerger"] or {}
        if not dm.get("resultingWeight") or float(dm["resultingWeight"]) <= 0:
            raise HTTPException(400, "demerger.resultingWeight must be set by the admin before approval.")
        _create_resulting_company_stock(rec)

    rec["status"] = "approved"
    rec["approvedBy"] = admin_email
    rec["approvedAt"] = time.strftime("%d %b %Y %H:%M")
    rec["comparisonReport"] = build_comparison_report(rec["basketKey"], rec["nseCode"], rec)
    _save_ca(records)
    _log_activity("corporate_action_approved", admin_email,
                   {"id": rec["id"], "type": rec["type"], "nseCode": rec["nseCode"]})

    background_tasks.add_task(_recalc_basket_buy_prices, rec["basketKey"])
    return rec


@router.post("/api/corporate-actions/{ca_id}/reject")
async def reject_corporate_action(ca_id: str, request: Request):
    admin_email = _require_admin(request)
    records = _load_ca()
    rec = _find_or_404(records, ca_id)
    if rec["status"] != "pending_review":
        raise HTTPException(400, f"Only a pending_review action can be rejected (current status: {rec['status']}).")
    rec["status"] = "rejected"
    _save_ca(records)
    _log_activity("corporate_action_rejected", admin_email, {"id": rec["id"]})
    return rec


@router.post("/api/corporate-actions/{ca_id}/reverse")
async def reverse_corporate_action(ca_id: str, request: Request, background_tasks: BackgroundTasks):
    admin_email = _require_admin(request)
    records = _load_ca()
    rec = _find_or_404(records, ca_id)
    if rec["status"] != "approved":
        raise HTTPException(400, f"Only an approved action can be reversed (current status: {rec['status']}).")
    rec["status"] = "reversed"
    _save_ca(records)
    _log_activity("corporate_action_reversed", admin_email, {"id": rec["id"]})

    background_tasks.add_task(_recalc_basket_buy_prices, rec["basketKey"])
    return rec
