"""Broker holdings-statement import (Zerodha/Groww-style "holdings-<ClientID>.xlsx"
export, with an 'Equity' sheet and a 'Client ID' cell). Two-step preview/confirm,
same shape as rebalance.py's Excel-upload flow: preview parses and returns data
WITHOUT writing anything, confirm applies the (admin-reviewed) result."""
import io

import openpyxl
from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile

from persistence import (
    BASKET_DISPLAY_NAMES, add_client, _require_admin, _log_activity,
    _load_portfolios, _save_portfolios,
    _load_client_id_map, _save_client_id_map,
    _auto_save_rollback, _push_undo_snapshot,
)

router = APIRouter()


def _find_client_id(rows) -> str | None:
    """The 'Client ID' label and its value can land in any column depending on
    how far the export indents its summary block (seen: label in column B,
    value in column C) -- scan each cell for the label, then take the next
    non-empty cell in that same row as the value, instead of assuming a fixed
    column pair."""
    for row in rows[:20]:
        if not row:
            continue
        for i, c in enumerate(row):
            if c is not None and str(c).strip().lower() == "client id":
                for nxt in row[i + 1:]:
                    if nxt is not None and str(nxt).strip():
                        return str(nxt).strip()
    return None


def _parse_holdings_sheet(rows, extra_cols: dict | None = None) -> tuple[list, float]:
    """Finds the 'Symbol'/'ISIN' header row (position varies by export), then
    reads rows below it until the sheet runs out. Returns (holdings, totalInvested)."""
    extra_cols = extra_cols or {}
    header_idx = None
    headers: list[str] = []
    for i, row in enumerate(rows):
        if not row:
            continue
        cells = [str(c).strip().lower() if c is not None else "" for c in row]
        if "symbol" in cells and "isin" in cells:
            header_idx, headers = i, cells
            break
    if header_idx is None:
        return [], 0.0

    def col(fragment):
        return next((i for i, h in enumerate(headers) if fragment in h), None)

    symbol_col = col("symbol")
    isin_col   = col("isin")
    qty_col    = col("quantity available")
    price_col  = col("average price")
    extra_col_idx = {key: col(fragment) for key, fragment in extra_cols.items()}

    if symbol_col is None or qty_col is None or price_col is None:
        return [], 0.0

    def cell(row, idx):
        return row[idx] if idx is not None and idx < len(row) else None

    holdings, total = [], 0.0
    for row in rows[header_idx + 1:]:
        if not row or all(c is None for c in row):
            break
        symbol = cell(row, symbol_col)
        if symbol is None or not str(symbol).strip():
            continue
        try:
            qty   = float(cell(row, qty_col))   if cell(row, qty_col)   not in (None, "") else 0.0
            price = float(cell(row, price_col)) if cell(row, price_col) not in (None, "") else 0.0
        except (TypeError, ValueError):
            continue
        if qty <= 0 or price <= 0:
            continue
        invested = round(qty * price, 4)
        entry = {
            "nseCode":       str(symbol).strip().upper(),
            "isin":          str(cell(row, isin_col)).strip() if cell(row, isin_col) else None,
            "quantity":      qty,
            "avgPrice":      round(price, 4),
            "investedValue": invested,
        }
        for key, idx in extra_col_idx.items():
            val = cell(row, idx)
            entry[key] = str(val).strip() if val else None
        holdings.append(entry)
        total += invested
    return holdings, total


@router.post("/api/preview-holdings-upload")
async def preview_holdings_upload(request: Request, file: UploadFile = File(...)):
    """Parse a broker holdings statement (.xlsx) and return its Equity-sheet
    holdings + resolved allocation weights, WITHOUT writing anything. If the
    file's Client ID has been linked to a basket before, that basket is
    returned too; otherwise the frontend prompts the admin to link/create one."""
    _require_admin(request)

    fname = (file.filename or "").lower()
    if not fname.endswith((".xlsx", ".xls")):
        raise HTTPException(400, "Only .xlsx/.xls files are supported.")

    raw = await file.read()
    try:
        # NOT read_only=True: some broker exports carry a bad/undersized
        # <dimension> tag, which makes openpyxl's read_only row iterator
        # silently return almost nothing for the sheet. Loading fully avoids
        # relying on that tag -- these files are small, so the memory cost
        # of doing so is negligible.
        wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    except Exception:
        raise HTTPException(400, "Could not read this file as an Excel workbook.")

    equity_ws = next((ws for ws in wb.worksheets if (ws.title or "").strip().lower() == "equity"), None)
    if equity_ws is None:
        wb.close()
        raise HTTPException(400, "No 'Equity' sheet found in this file.")

    equity_rows = list(equity_ws.iter_rows(values_only=True))
    client_id = _find_client_id(equity_rows)
    if not client_id:
        wb.close()
        raise HTTPException(400, "Could not find a 'Client ID' in the Equity sheet.")

    holdings, total_invested = _parse_holdings_sheet(equity_rows, {"sector": "sector"})
    if not holdings:
        wb.close()
        raise HTTPException(400, "No stock holdings found in the Equity sheet.")

    mf_info = None
    mf_ws = next((ws for ws in wb.worksheets if (ws.title or "").strip().lower() == "mutual funds"), None)
    if mf_ws is not None:
        mf_holdings, _ = _parse_holdings_sheet(list(mf_ws.iter_rows(values_only=True)))
        if mf_holdings:
            mf_info = {"count": len(mf_holdings), "funds": [h["nseCode"] for h in mf_holdings]}

    wb.close()

    for h in holdings:
        h["allocationPct"] = round(h["investedValue"] / total_invested * 100, 4) if total_invested > 0 else 0.0

    client_map = _load_client_id_map()
    basket_key = client_map.get(client_id)
    basket_label = BASKET_DISPLAY_NAMES.get(basket_key) if basket_key else None

    return {
        "clientId":      client_id,
        "basketKey":     basket_key,
        "basketLabel":   basket_label,
        "holdings":      holdings,
        "totalInvested": round(total_invested, 2),
        "mutualFunds":   mf_info,
        "filename":      file.filename,
    }


@router.post("/api/confirm-holdings-upload")
async def confirm_holdings_upload(request: Request, body: dict = Body(...)):
    """Applies a previewed holdings upload: links/creates the target basket for
    this Client ID (remembered for future uploads), then REPLACES that basket's
    stock list with the uploaded holdings -- this file is the broker's ground
    truth for what's currently held, same "full rebuild" semantics as a
    confirmed rebalance upload."""
    admin_email = _require_admin(request)

    client_id       = (body.get("clientId") or "").strip()
    basket_key      = (body.get("basketKey") or "").strip()
    new_client_name = (body.get("newClientName") or "").strip()
    holdings        = body.get("holdings") or []
    filename        = body.get("filename", "")

    if not client_id:
        raise HTTPException(400, "clientId is required.")
    if not holdings:
        raise HTTPException(400, "No holdings to upload.")

    if not basket_key:
        if not new_client_name:
            raise HTTPException(400, "Provide an existing basketKey or a newClientName.")
        basket_key, _ = add_client(new_client_name)
    elif basket_key not in BASKET_DISPLAY_NAMES:
        raise HTTPException(400, f"Unknown basket: {basket_key}")

    stocks = []
    for h in holdings:
        nse = (h.get("nseCode") or "").strip().upper()
        alloc_pct = h.get("allocationPct")
        buy_price = h.get("avgPrice")
        if not nse or alloc_pct is None or buy_price is None:
            continue
        stocks.append({
            "nseCode":    nse,
            "allocation": round(float(alloc_pct) / 100, 6),
            "buyPrice":   round(float(buy_price), 4),
        })
    if not stocks:
        raise HTTPException(400, "No valid stocks in the uploaded holdings.")

    _auto_save_rollback()
    _push_undo_snapshot(basket_key, label=f"Broker holdings upload ({filename or client_id})")

    portfolios = _load_portfolios()
    portfolios[basket_key] = stocks
    _save_portfolios(portfolios)

    client_map = _load_client_id_map()
    client_map[client_id] = basket_key
    _save_client_id_map(client_map)

    _log_activity("holdings_upload", admin_email, {
        "basket": basket_key, "clientId": client_id,
        "stockCount": len(stocks), "filename": filename,
    })

    return {
        "ok":          True,
        "basketKey":   basket_key,
        "basketLabel": BASKET_DISPLAY_NAMES.get(basket_key, basket_key),
        "count":       len(stocks),
    }
