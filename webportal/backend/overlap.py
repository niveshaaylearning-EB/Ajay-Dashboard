"""Cross-client stock overlap: which stocks are held by more than one client
at once, with per-client detail (weight, buy date/price, CMP, P&L) for both
their current position and any past sale of that same stock -- powers the
"Overlap" tab."""
from persistence import BASKET_DISPLAY_NAMES, _load_portfolios, _load_buy_price_data, _load_client_capital
from price_engine import fetch_live_batch
from fastapi import APIRouter

router = APIRouter()


@router.get("/api/overlap-summary")
async def get_overlap_summary():
    """One entry per stock held by 2+ distinct clients right now, each
    carrying every client's current position (allocation %, invested value,
    buy date/price, CMP, absolute return %) AND, for full history, any past
    sale of that stock by ANY client (sell date/price, realized return %) --
    not just the currently-overlapping ones, since a client who has since
    exited is still relevant overlap history. Read-only, no admin gate
    (matches every other basket-list read endpoint in this app)."""
    portfolios  = _load_portfolios()
    bp_data     = _load_buy_price_data()
    capital_map = _load_client_capital()
    live        = await fetch_live_batch()

    by_code: dict[str, dict] = {}

    for key, label in BASKET_DISPLAY_NAMES.items():
        stocks    = portfolios.get(key, [])
        bp_basket = bp_data.get(key, {})
        total_capital = capital_map.get(key)

        for s in stocks:
            code  = (s.get("nseCode") or "").strip().upper()
            alloc = s.get("allocation") or 0
            if not code or alloc <= 0:
                continue
            det       = bp_basket.get(code, {})
            buy_price = s.get("buyPrice")
            cmp       = (live.get(code) or {}).get("cmp")
            abs_return = None
            if cmp is not None and buy_price:
                abs_return = (cmp - buy_price) / buy_price
            invested = round(total_capital * alloc, 2) if total_capital is not None else None

            entry = by_code.setdefault(code, {"current": [], "sold": []})
            entry["current"].append({
                "clientKey":         key,
                "clientLabel":       label,
                "allocationPct":     round(alloc * 100, 4),
                "investedValue":     invested,
                "buyDate":           det.get("buyDate") or None,
                "buyPrice":          buy_price,
                "cmp":               cmp,
                "absoluteReturnPct": round(abs_return * 100, 4) if abs_return is not None else None,
            })

        for s in portfolios.get(f"{key}_sold", []):
            code = (s.get("nseCode") or "").strip().upper()
            if not code:
                continue
            buy_price  = s.get("buyPrice")
            sell_price = s.get("sellPrice")
            realized = None
            if buy_price and sell_price is not None:
                realized = (sell_price - buy_price) / buy_price

            entry = by_code.setdefault(code, {"current": [], "sold": []})
            entry["sold"].append({
                "clientKey":          key,
                "clientLabel":        label,
                "securityName":       s.get("securityName"),
                "weightSoldPct":      s.get("weightSold"),
                "buyPrice":           buy_price,
                "sellPrice":          sell_price,
                "sellDate":           s.get("date"),
                "action":             s.get("action"),
                "realizedReturnPct":  round(realized * 100, 4) if realized is not None else None,
            })

    result = []
    for code, groups in by_code.items():
        holder_keys = {r["clientKey"] for r in groups["current"]}
        if len(holder_keys) < 2:
            continue
        result.append({
            "nseCode":     code,
            "clientCount": len(holder_keys),
            "current":     sorted(groups["current"], key=lambda r: -r["allocationPct"]),
            "sold":        groups["sold"],
        })
    result.sort(key=lambda r: -r["clientCount"])
    return result
