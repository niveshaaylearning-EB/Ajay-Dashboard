"""Sold-stock cleanup + Excel export endpoints."""
from io import BytesIO

import pandas as pd
from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

import database
from main import get_db

router = APIRouter()

@router.delete("/api/sold-stocks/cleanup")
def cleanup_false_sold_stocks(db: Session = Depends(get_db)):
    """Remove sold stock records for stocks that still exist in basket_history (still active holdings)."""
    active_codes = db.query(database.BasketHistory.basket_id, database.BasketHistory.stock_code).all()
    active_set = set((b, s) for b, s in active_codes)
    sold = db.query(database.SoldStock).all()
    removed = 0
    for s in sold:
        if (s.basket_id, s.stock_code) in active_set:
            db.delete(s)
            removed += 1
    db.commit()
    return {"status": "success", "removed": removed}

@router.post("/api/download")
def download_excel(data: list = Body(...)):
    if not data:
        raise HTTPException(status_code=400, detail="No data provided")

    df = pd.DataFrame(data)
    df = df.drop(columns=["tracker"], errors="ignore")

    output = BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Portfolio')

    output.seek(0)
    headers = {'Content-Disposition': 'attachment; filename="portfolio.xlsx"'}
    return StreamingResponse(output, headers=headers, media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


@router.post("/api/download/actual-full")
def download_actual_full(data: dict = Body(...)):
    """Export Actual Portfolio Excel: Summary + Holdings + Top5 sheets + Historical Analytics."""
    basket_name = data.get("basket_name", "Portfolio")
    holdings    = data.get("holdings", [])
    stats       = data.get("stats", {})
    historic    = data.get("historic", {})

    # ── Sheet 1: Summary ──────────────────────────────────────────────────────
    summary_rows = [
        {"Metric": "Basket",                        "Value": basket_name},
        {"Metric": "Basket Return (%)",              "Value": round(float(stats.get("basket_return", 0)), 2)},
        {"Metric": "Stock Count",                    "Value": stats.get("stock_count", 0)},
        {"Metric": "Total Market Cap (Cr)",          "Value": round(float(stats.get("total_mcap", 0)), 2)},
        {"Metric": "", "Value": ""},
        {"Metric": "--- Historical Analytics ---",   "Value": ""},
    ]
    for period in ["1M", "6M", "1Y", "3Y", "5Y"]:
        h = historic.get(period) or {}
        if not h:
            continue
        net  = h.get("net")
        cagr = h.get("cagr")
        summary_rows.append({"Metric": f"{period} — Net Return (%)", "Value": net  if net  is not None else "N/A"})
        if cagr is not None:
            summary_rows.append({"Metric": f"{period} — CAGR (%)", "Value": cagr})
        summary_rows.append({"Metric": "", "Value": ""})

    # ── Sheet 2: Holdings ────────────────────────────────────────────────────
    holdings_clean = [{k: v for k, v in h.items() if k != "tracker"} for h in holdings]

    # ── Sheets 3–5: Top 5 Gainers / Losers / Contributors ────────────────────
    def _top5_df(lst):
        rows = []
        for s in lst:
            rows.append({
                "Stock Code":       s.get("code", ""),
                "Name":             s.get("stock_name", s.get("code", "")),
                "Sector":           s.get("sector", ""),
                "Allocation %":     round(float(s.get("allocation", 0)), 2),
                "Buy Price":        round(float(s.get("buy_price", 0)), 2),
                "CMP":              round(float(s.get("cmp", 0)), 2),
                "1M Return %":      round(float(s.get("performance", 0)), 2),
                "Overall Return %": round(float(s.get("overall_performance", 0)), 2),
                "Contribution %":   round(float(s.get("contribution", 0)), 4),
            })
        return pd.DataFrame(rows) if rows else pd.DataFrame()

    output = BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        pd.DataFrame(summary_rows).to_excel(writer, sheet_name="Summary", index=False)
        if holdings_clean:
            pd.DataFrame(holdings_clean).to_excel(writer, sheet_name="Holdings", index=False)
        gainers = _top5_df(stats.get("top_gainers", []))
        if not gainers.empty:
            gainers.to_excel(writer, sheet_name="Top Gainers", index=False)
        losers = _top5_df(stats.get("top_losers", []))
        if not losers.empty:
            losers.to_excel(writer, sheet_name="Top Losers", index=False)
        contribs = _top5_df(stats.get("top_contributors", []))
        if not contribs.empty:
            contribs.to_excel(writer, sheet_name="Top Contributors", index=False)

    output.seek(0)
    safe_name = basket_name.replace("/", "-").replace("\\", "-")
    headers = {'Content-Disposition': f'attachment; filename="{safe_name}_Actual.xlsx"'}
    return StreamingResponse(output, headers=headers,
                             media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')


@router.post("/api/download/simulator-full")
def download_simulator_full(data: dict = Body(...)):
    """Export a user's virtual portfolio Excel with Summary + Holdings sheets."""
    sim_return = float(data.get("sim_return", 0))
    holdings   = data.get("holdings", [])
    historic   = data.get("historic", {})   # {simulated: {...}}

    sim_hist = historic.get("simulated", {})

    # ── Sheet 1: Summary ──────────────────────────────────────────────────────
    summary_rows = [
        {"Metric": "Simulated Portfolio Return (%)", "Value": round(sim_return, 2)},
        {"Metric": "", "Value": ""},
        {"Metric": "--- Historical Performance ---", "Value": ""},
    ]
    for period in ["1M", "6M", "1Y", "3Y", "5Y"]:
        s = sim_hist.get(period, {}) or {}
        if not s:
            continue
        s_net = s.get("net")
        summary_rows.append({"Metric": f"{period} — Net (%)",  "Value": s_net if s_net is not None else "N/A"})
        if s.get("cagr") is not None:
            summary_rows.append({"Metric": f"{period} — CAGR (%)", "Value": s.get("cagr")})
        summary_rows.append({"Metric": "", "Value": ""})

    # ── Sheet 2: Holdings ────────────────────────────────────────────────────
    holdings_clean = []
    for h in holdings:
        row = {k: v for k, v in h.items() if k not in ("tracker",)}
        holdings_clean.append(row)

    output = BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        pd.DataFrame(summary_rows).to_excel(writer, sheet_name="Summary", index=False)
        if holdings_clean:
            pd.DataFrame(holdings_clean).to_excel(writer, sheet_name="Holdings", index=False)

    output.seek(0)
    headers = {'Content-Disposition': 'attachment; filename="My_Virtual_Portfolio_Simulated.xlsx"'}
    return StreamingResponse(output, headers=headers, media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
