"""Upload-and-diff a portfolio-report PDF against the current basket: parses
additions/removals/weight-changes and applies them to portfolios + rebalance
history, matching company names to NSE codes via the cached symbol list."""
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile

import price_engine
from buy_price_gains import _date_to_ts
from persistence import (
    BASKET_DISPLAY_NAMES,
    _load_portfolios, _save_portfolios,
    _load_rebalance_history, _save_rebalance_history,
)
from price_engine import _parse_portfolio_pdf, _resolve_nse, _fetch_nse_symbols
from live_data import _fetch_rebalance_prices

router = APIRouter()

@router.post("/api/upload-portfolio-report")
async def upload_portfolio_report(
    background_tasks: BackgroundTasks,
    basket: str = Form(...),
    date: str = Form(...),
    file: UploadFile = File(...),
):
    if basket not in BASKET_DISPLAY_NAMES:
        raise HTTPException(status_code=400, detail=f"Unknown basket: {basket}")

    try:
        rebalance_dt = datetime.strptime(date.strip(), "%d %b %Y")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date. Use format: 15 Jan 2025")
    date_str = rebalance_dt.strftime("%d %b %Y")

    # Duplicate check
    rh = _load_rebalance_history()
    existing_dates = {e.get("date", "").strip() for e in rh.get(basket, [])}
    if date_str in existing_dates:
        return {"duplicate": True, "message": "Report for this date has already been uploaded"}

    # Parse PDF
    raw = await file.read()
    try:
        pdf_entries = _parse_portfolio_pdf(raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read PDF: {e}")

    if not pdf_entries:
        raise HTTPException(status_code=400, detail="No rebalance data found in PDF")

    # Resolve NSE codes — load portfolio + NSE symbols for matching
    portfolios    = _load_portfolios()
    curr_stocks   = portfolios.get(basket, [])
    nse_symbols   = price_engine._nse_symbols_cache  # use cached list (populated by /api/nse-symbols)
    if not nse_symbols:
        nse_symbols = await _fetch_nse_symbols()

    stk_map  = {s["nseCode"]: s for s in curr_stocks}
    sold     = portfolios.get(f"{basket}_sold", [])

    # Build prev_snap from rebalance history (same as CSV upload)
    basket_history = rh.get(basket, [])
    by_date: dict  = {}
    for e in basket_history:
        by_date.setdefault(e.get("date", ""), []).append(e)
    latest_date = max(by_date, key=lambda d: _date_to_ts(d), default=None)
    prev_snap   = {e["nseCode"]: e for e in by_date.get(latest_date, [])} if latest_date else {}

    unmatched = []
    added_codes: list    = []
    removed_codes: list  = []
    increased_items: list = []
    decreased_items: list = []

    for entry in pdf_entries:
        section = entry["section"]
        if section == "no_change":
            continue  # nothing to update

        nse = _resolve_nse(entry["companyName"], curr_stocks, nse_symbols)
        if not nse:
            unmatched.append(entry["companyName"])
            continue

        w = entry["newWeight"]

        if section == "addition":
            if nse not in stk_map:
                new_entry = {"nseCode": nse, "allocation": round(w / 100, 6), "buyPrice": None,
                             "securityName": entry["companyName"], "segment": entry["holdingType"]}
                curr_stocks.append(new_entry)
                stk_map[nse] = new_entry
            else:
                stk_map[nse]["allocation"] = round(w / 100, 6)
            added_codes.append(nse)
            rh.setdefault(basket, []).append({
                "date": date_str, "nseCode": nse,
                "securityName": entry["companyName"],
                "segment": entry["holdingType"], "weight": w,
            })

        elif section == "removal":
            old = prev_snap.get(nse) or stk_map.get(nse, {})
            sold.append({
                "nseCode": nse,
                "securityName": entry["companyName"],
                "date": date_str, "action": "Wholly Sold",
                "weightSold": round(float(old.get("weight", old.get("allocation", 0)) or 0) *
                                    (1 if float(old.get("weight", 1) or 1) <= 1 else 0.01), 2),
                "buyPrice": stk_map[nse].get("buyPrice") if nse in stk_map else None,
                "sellPrice": None,
            })
            curr_stocks = [s for s in curr_stocks if s["nseCode"] != nse]
            stk_map.pop(nse, None)
            removed_codes.append(nse)
            rh.setdefault(basket, []).append({
                "date": date_str, "nseCode": nse,
                "securityName": entry["companyName"],
                "segment": entry["holdingType"], "weight": 0,
            })

        elif section == "increase":
            old_w = float((prev_snap.get(nse) or {}).get("weight", 0) or 0)
            if nse in stk_map:
                stk_map[nse]["allocation"] = round(w / 100, 6)
            increased_items.append({"nseCode": nse, "from": old_w, "to": w})
            rh.setdefault(basket, []).append({
                "date": date_str, "nseCode": nse,
                "securityName": entry["companyName"],
                "segment": entry["holdingType"], "weight": w,
            })

        elif section == "decrease":
            old_w = float((prev_snap.get(nse) or {}).get("weight", 0) or 0)
            if nse in stk_map:
                stk_map[nse]["allocation"] = round(w / 100, 6)
            decreased_items.append({"nseCode": nse, "from": old_w, "to": w})
            sold.append({
                "nseCode": nse, "securityName": entry["companyName"],
                "date": date_str, "action": "Partial Sell",
                "weightSold": round(max(old_w - w, 0), 2),
                "buyPrice": None, "sellPrice": None,
            })
            rh.setdefault(basket, []).append({
                "date": date_str, "nseCode": nse,
                "securityName": entry["companyName"],
                "segment": entry["holdingType"], "weight": w,
            })

    portfolios[basket]             = curr_stocks
    portfolios[f"{basket}_sold"]   = sold
    _save_portfolios(portfolios)
    _save_rebalance_history(rh)

    sell_codes = removed_codes + [i["nseCode"] for i in decreased_items]
    background_tasks.add_task(_fetch_rebalance_prices, basket, date_str, added_codes, sell_codes)

    resp = {
        "ok": True,
        "basket": BASKET_DISPLAY_NAMES[basket],
        "date": date_str,
        "changes": {
            "added":     added_codes,
            "removed":   removed_codes,
            "increased": [f"{i['nseCode']} ({i['from']}% → {i['to']}%)" for i in increased_items],
            "decreased": [f"{i['nseCode']} ({i['from']}% → {i['to']}%)" for i in decreased_items],
        },
    }
    if unmatched:
        resp["unmatched"] = unmatched
    return resp


