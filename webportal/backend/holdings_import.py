"""Broker holdings-statement import (Zerodha/Groww-style "holdings-<ClientID>.xlsx"
export, with an 'Equity' sheet and a 'Client ID' cell). Two-step preview/confirm,
same shape as rebalance.py's Excel-upload flow: preview parses and returns data
WITHOUT writing anything, confirm applies the (admin-reviewed) result.

Also: a second, simpler upload format (SCRIP / BUY PRICE / MARKET PRICE /
QUANTITY / BUY VALUE / MARKET VALUE summary table, company names instead of
tickers, no embedded Client ID) -- see the "-simple" preview/confirm endpoints
near the bottom of this file. Unlike the format above, this one has no way to
auto-detect which client it belongs to, so the admin picks the target client
directly (e.g. an "Upload Holdings" button on that client's own row), and
allocation % is computed against that client's Total Capital (client_capital.json)
rather than the file's own total, so the unfilled remainder correctly becomes
their Cash balance via persistence.py's existing auto-top-up.

That simple format accepts three input types:
  .xlsx/.xls -- parsed via openpyxl, real cell boundaries, most reliable.
  .pdf       -- assumed to have a real text layer (not scanned); pdfplumber
               extracts an actual table grid, fed into the SAME row parser
               as the Excel path since the shapes match.
  .png/.jpg/.jpeg -- no real table structure at all, so pytesseract (OCR)
               reads words + their pixel positions, groups them into visual
               rows/columns, and reconstructs a best-effort grid. Markedly
               less reliable than the other two -- every field (not just the
               NSE code) is editable in the preview before confirming,
               since OCR misreads numbers as often as names."""
import io
import re

import openpyxl
import pdfplumber
import pytesseract
from PIL import Image
from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile

from persistence import (
    BASKET_DISPLAY_NAMES, add_client, _require_admin, _log_activity,
    _load_portfolios, _save_portfolios,
    _load_client_id_map, _save_client_id_map,
    _load_buy_price_data, _load_client_capital,
    _auto_save_rollback, _push_undo_snapshot,
)
from price_engine import _fetch_nse_symbols

router = APIRouter()

# pytesseract shells out to the real `tesseract` binary, which must be on
# PATH -- the standard Windows installer (UB-Mannheim build) adds it to the
# SYSTEM PATH, but any process already running (or started before a reboot/
# fresh login) won't see that update. Fall back to its well-known default
# install location explicitly rather than depend on PATH timing.
import os as _os
import shutil as _shutil
if _os.name == "nt" and not _shutil.which("tesseract"):
    _default_win_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if _os.path.isfile(_default_win_path):
        pytesseract.pytesseract.tesseract_cmd = _default_win_path


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


# ─────────────────────────────────────────────────────────────────────────────
# Simple format: SCRIP / BUY PRICE / MARKET PRICE / QUANTITY / BUY VALUE /
# MARKET VALUE summary table (company names, no ISIN, no embedded Client ID --
# the admin picks the target client directly, so this doesn't need any of the
# Client-ID-matching machinery above).
# ─────────────────────────────────────────────────────────────────────────────

_NAME_SUFFIX_RE = re.compile(r'\b(LIMITED|LTD|PVT|PRIVATE|CO|COMPANY|INDIA)\b\.?')
_NAME_STRIP_RE  = re.compile(r'[^A-Z0-9]+')


def _normalize_company_name(name: str) -> str:
    """Collapse a company name to just its distinguishing letters/digits, so
    "Steamhouse (India) Limited" and "STEAMHOUSE INDIA LTD." compare equal --
    strip common suffixes first so they don't masquerade as distinguishing
    content, then strip everything that isn't alphanumeric."""
    s = _NAME_SUFFIX_RE.sub('', name.upper())
    return _NAME_STRIP_RE.sub('', s)


def _resolve_scrip_to_code(scrip_name: str, basket_key: str, bp_data: dict, nse_symbols: list) -> str:
    """Best-effort company-name -> NSE code resolution for the simple upload
    format (no ISIN, no ticker column, just a SCRIP name). Priority:
      1. This basket's own existing holdings (exact code or securityName match)
      2. The full NSE-listed company-name universe (exact normalized match,
         then a one-sided prefix match if that's unambiguous)
      3. The scrip name itself, cleaned into a code-safe string -- matches how
         this app already stores a handful of holdings that were never
         cleanly resolved (e.g. "NEOGEN CHEMICALS" as a literal nseCode)
    Always returns a non-empty, review-before-confirm best guess -- the admin
    can still correct it in the preview before anything is saved."""
    name = (scrip_name or "").strip()
    if not name:
        return ""

    basket_bp = bp_data.get(basket_key, {})
    upper = name.upper()
    if upper in basket_bp:
        return upper
    lower = name.lower()
    for code, det in basket_bp.items():
        sn = (det.get("securityName") or "").lower()
        if sn and (sn == lower or sn.startswith(lower) or lower.startswith(sn)):
            return code

    norm = _normalize_company_name(name)
    if norm:
        exact = [row["symbol"] for row in nse_symbols if _normalize_company_name(row["name"]) == norm]
        if len(exact) == 1:
            return exact[0]
        prefix = [row["symbol"] for row in nse_symbols
                  if row["name"] and (_normalize_company_name(row["name"]).startswith(norm)
                                       or norm.startswith(_normalize_company_name(row["name"])))]
        if len(prefix) == 1:
            return prefix[0]

    cleaned = _NAME_SUFFIX_RE.sub('', upper)
    cleaned = re.sub(r'[.\s]+', '', cleaned).strip()
    return cleaned or upper


def _parse_simple_holdings_sheet(rows) -> list[dict]:
    """Parse the SCRIP / BUY PRICE / MARKET PRICE / QUANTITY / BUY VALUE /
    MARKET VALUE table. Header row position varies; stops at a "Grand Total"
    row or the end of the sheet. MARKET PRICE/MARKET VALUE are read-only
    snapshots at export time (live CMP supersedes them immediately), so only
    SCRIP/BUY PRICE/QUANTITY are actually used -- buy value is recomputed
    from them rather than trusting the file's own (possibly rounded) column."""
    header_idx = None
    headers: list[str] = []
    for i, row in enumerate(rows):
        if not row:
            continue
        cells = [str(c).strip().lower() if c is not None else "" for c in row]
        if "scrip" in cells:
            header_idx, headers = i, cells
            break
    if header_idx is None:
        return []

    def col(fragment):
        return next((i for i, h in enumerate(headers) if fragment in h), None)

    scrip_col = col("scrip")
    price_col = col("buy price")
    qty_col   = col("quantity")
    if scrip_col is None or price_col is None or qty_col is None:
        return []

    def cell(row, idx):
        return row[idx] if idx is not None and idx < len(row) else None

    def to_number(v):
        """openpyxl can hand back a native float directly; pdfplumber (and
        OCR) only ever produce strings, often with comma digit-grouping
        (e.g. "76,100") -- strip that before parsing either way."""
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        s = re.sub(r'[,\s₹]', '', str(v))
        return float(s) if s else None

    out = []
    for row in rows[header_idx + 1:]:
        if not row or all(c is None for c in row):
            break
        scrip = cell(row, scrip_col)
        if scrip is None or not str(scrip).strip():
            continue
        if str(scrip).strip().lower() in ("grand total", "total"):
            break
        try:
            price = to_number(cell(row, price_col))
            qty   = to_number(cell(row, qty_col))
            if price is None or qty is None:
                continue
        except (TypeError, ValueError):
            continue
        if price <= 0 or qty <= 0:
            continue
        out.append({
            "scripName": str(scrip).strip(),
            "buyPrice":  round(price, 4),
            "quantity":  qty,
            "buyValue":  round(price * qty, 2),
        })
    return out


def _pdf_to_simple_rows(raw: bytes) -> list[dict]:
    """Real-text PDF (not scanned) -- pdfplumber extracts an actual table
    grid (cell boundaries inferred from the PDF's own layout/ruling lines),
    which has the exact same shape as openpyxl's row list, so it's fed
    straight into the same parser as the Excel path."""
    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for page in pdf.pages:
            for table in (page.extract_tables() or []):
                parsed = _parse_simple_holdings_sheet(table)
                if parsed:
                    return parsed
    return []


_NUMBER_RE = re.compile(r'^[+-]?[\d,]+\.?\d*$')
# OCR glues stray table-gridline fragments onto numbers at the EDGES of the
# token (e.g. "102|", "[STEAMHOUSE", "_1,03,15,710|", "'50,05,308|") -- strip
# those before checking whether what's left is a clean number. Deliberately
# NOT stripping from the middle of a token: that's what keeps "E2E" (a real
# scrip name containing a digit) from being misread as the number 2.
_EDGE_NOISE_RE = re.compile(r"^[\[\](){}|_'\"`\s]+|[\[\](){}|_'\"`\s]+$")


def _ocr_word_to_number(text: str):
    """OCR'd numbers often carry commas (Indian digit grouping), a ₹ sign,
    or edge noise from misread table borders -- strip all three, then only
    accept it as a number if what remains is a clean number through and
    through (not just at the edges), so a name with a stray digit in the
    middle (e.g. "E2E") is never misread as one."""
    core = _EDGE_NOISE_RE.sub('', text.replace('₹', ''))
    if not core or not _NUMBER_RE.match(core):
        return None
    try:
        return float(core.replace(',', ''))
    except ValueError:
        return None


def _merge_split_number_fragments(texts: list[str]) -> list[str]:
    """A large comma-grouped number can get OCR'd as two separate words when
    there's a tiny gap mid-number (confirmed on a real statement: "99,12,764"
    came back as two tokens, "99,12," and "764|") -- a token whose digits/
    commas end in a bare trailing comma is almost certainly the first half
    of one of these, so glue it to the next token before anything else
    runs. Otherwise the extra token shifts every later column one slot out
    of position, same failure mode a dropped unparseable token causes."""
    merged, i = [], 0
    while i < len(texts):
        t = texts[i]
        digits_commas = re.sub(r"[^\d,]", "", t)
        if digits_commas.endswith(",") and i + 1 < len(texts):
            merged.append(t + texts[i + 1])
            i += 2
        else:
            merged.append(t)
            i += 1
    return merged


def _ocr_image_to_simple_rows(raw: bytes) -> list[dict]:
    """No real table structure to read at all -- OCRs every word with its
    pixel position, groups words into rows using Tesseract's OWN line
    segmentation (block/paragraph/line numbers from image_to_data), NOT a
    manual Y-coordinate clustering: a naive "is this word's Y close to the
    previous word's Y" check chains transitively across an entire multi-row
    table when row height is small relative to text height (confirmed on a
    real 12-row statement: the whole table collapsed into one "row"), since
    each pair of adjacent lines can be closer together than two words within
    the same line. Tesseract's own layout analysis doesn't have that bug.
    Sorts each row left-to-right by X, then (since the column ORDER in this
    format is fixed: SCRIP, BUY PRICE, MARKET PRICE, QUANTITY, BUY VALUE,
    MARKET VALUE) splits each data row into its leading non-numeric words
    (the scrip name) and its trailing numeric words, taking the 1st and 3rd
    numbers as buy price and quantity. Markedly less reliable than the
    Excel/PDF paths by nature, not because of a cut corner -- every field is
    editable in the preview before confirming."""
    img = Image.open(io.BytesIO(raw))
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)

    line_words: dict = {}
    for i in range(len(data["text"])):
        txt = (data["text"][i] or "").strip()
        if not txt:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        line_words.setdefault(key, []).append({"text": txt, "left": data["left"][i]})
    if not line_words:
        return []

    rows = [sorted(words, key=lambda w: w["left"]) for _, words in sorted(line_words.items())]

    header_idx = next((i for i, row in enumerate(rows)
                        if any(w["text"].strip(".:").lower() in ("scrip", "script") for w in row)), None)
    if header_idx is None:
        return []

    out = []
    for row in rows[header_idx + 1:]:
        texts = _merge_split_number_fragments([w["text"] for w in row])
        joined = " ".join(texts).strip().lower()
        if joined.startswith("grand total") or joined.startswith("total"):
            break
        # Column order is fixed (BUY PRICE, MARKET PRICE, QUANTITY, BUY
        # VALUE, MARKET VALUE) -- take the trailing 5 tokens AS those
        # columns BY POSITION, not by "does this one happen to parse as a
        # number". Scanning for validity and skipping whatever doesn't
        # parse (the previous approach) silently drops a misread token
        # instead of keeping its slot, which shifts every later column
        # left by one -- confirmed on a real statement: a single garbled
        # "774" -> "77A" made quantity read as that row's BUY VALUE
        # instead, off by a factor of ~1000. A position that still fails
        # to parse here becomes 0 -- visibly wrong and still editable in
        # the preview, rather than silently dropping the whole row (worse:
        # a real holding missing from the upload with no indication why).
        if len(texts) < 6:
            continue
        name_tokens, number_tokens = texts[:-5], texts[-5:]
        if not name_tokens:
            continue
        price = _ocr_word_to_number(number_tokens[0]) or 0
        qty   = _ocr_word_to_number(number_tokens[2]) or 0
        out.append({
            "scripName": " ".join(name_tokens).strip(),
            "buyPrice":  round(price, 4),
            "quantity":  qty,
            "buyValue":  round(price * qty, 2),
        })
    return out


@router.post("/api/preview-holdings-upload-simple")
async def preview_holdings_upload_simple(request: Request, basketKey: str = Form(...), file: UploadFile = File(...)):
    """Parse the simple SCRIP/BUY PRICE/QUANTITY format for a specific,
    already-chosen client, WITHOUT writing anything. Allocation % is computed
    against that client's Total Capital so the admin can see upfront whether
    the file under- or over-shoots it before confirming."""
    _require_admin(request)
    basket_key = basketKey.strip()
    if basket_key not in BASKET_DISPLAY_NAMES:
        raise HTTPException(400, f"Unknown basket: {basket_key}")

    fname = (file.filename or "").lower()
    raw = await file.read()

    if fname.endswith((".xlsx", ".xls")):
        try:
            wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
        except Exception:
            raise HTTPException(400, "Could not read this file as an Excel workbook.")
        ws = wb.worksheets[0]
        rows = list(ws.iter_rows(values_only=True))
        wb.close()
        parsed = _parse_simple_holdings_sheet(rows)
        extraction_method = "excel"
    elif fname.endswith(".pdf"):
        try:
            parsed = _pdf_to_simple_rows(raw)
        except Exception as e:
            raise HTTPException(400, f"Could not read this PDF: {e}")
        extraction_method = "pdf"
    elif fname.endswith((".png", ".jpg", ".jpeg", ".webp")):
        try:
            parsed = _ocr_image_to_simple_rows(raw)
        except Exception as e:
            raise HTTPException(400, f"Could not read this image: {e}")
        extraction_method = "ocr"
    else:
        raise HTTPException(400, "Only .xlsx/.xls, .pdf, or .png/.jpg/.jpeg files are supported.")

    if not parsed:
        raise HTTPException(400, "Could not find a SCRIP / BUY PRICE / QUANTITY table in this file.")

    bp_data = _load_buy_price_data()
    nse_symbols = await _fetch_nse_symbols()

    holdings = []
    for row in parsed:
        code = _resolve_scrip_to_code(row["scripName"], basket_key, bp_data, nse_symbols)
        holdings.append({**row, "nseCode": code})

    file_total = round(sum(h["buyValue"] for h in holdings), 2)
    total_capital = (_load_client_capital() or {}).get(basket_key)
    for h in holdings:
        h["allocationPct"] = round(h["buyValue"] / total_capital * 100, 4) if total_capital else None

    return {
        "basketKey":    basket_key,
        "basketLabel":  BASKET_DISPLAY_NAMES.get(basket_key),
        "holdings":     holdings,
        "fileTotal":    file_total,
        "totalCapital": total_capital,
        "overCapital":  bool(total_capital and file_total > total_capital),
        "filename":     file.filename,
        "extractionMethod": extraction_method,
    }


@router.post("/api/confirm-holdings-upload-simple")
async def confirm_holdings_upload_simple(request: Request, body: dict = Body(...)):
    """Applies a previewed simple-format upload: REPLACES the target client's
    stock list with the uploaded holdings, allocation computed against their
    Total Capital -- the unfilled remainder becomes Cash automatically via
    _save_portfolios' existing auto-top-up, same as any other save."""
    admin_email = _require_admin(request)

    basket_key = (body.get("basketKey") or "").strip()
    holdings   = body.get("holdings") or []
    filename   = body.get("filename", "")

    if basket_key not in BASKET_DISPLAY_NAMES:
        raise HTTPException(400, f"Unknown basket: {basket_key}")
    if not holdings:
        raise HTTPException(400, "No holdings to upload.")

    total_capital = (_load_client_capital() or {}).get(basket_key)
    if not total_capital:
        raise HTTPException(400, "This client's Total Capital isn't set yet -- set it on the All Clients page first, then upload holdings.")

    stocks = []
    for h in holdings:
        nse = (h.get("nseCode") or "").strip().upper()
        buy_value = h.get("buyValue")
        buy_price = h.get("buyPrice")
        if not nse or buy_value is None or buy_price is None:
            continue
        stocks.append({
            "nseCode":    nse,
            "allocation": round(float(buy_value) / total_capital, 6),
            "buyPrice":   round(float(buy_price), 4),
        })
    if not stocks:
        raise HTTPException(400, "No valid stocks in the uploaded holdings.")

    total_alloc = sum(s["allocation"] for s in stocks)
    if total_alloc > 1.001:
        raise HTTPException(
            400,
            f"These holdings total {total_alloc * 100:.1f}% of this client's Total Capital, over 100%. "
            f"Update their Total Capital first, or check the file for an error.",
        )

    _auto_save_rollback()
    _push_undo_snapshot(basket_key, label=f"Holdings upload ({filename or 'simple format'})")

    portfolios = _load_portfolios()
    portfolios[basket_key] = stocks
    _save_portfolios(portfolios)

    _log_activity("holdings_upload_simple", admin_email, {
        "basket": basket_key, "stockCount": len(stocks), "filename": filename,
    })

    return {
        "ok":          True,
        "basketKey":   basket_key,
        "basketLabel": BASKET_DISPLAY_NAMES.get(basket_key, basket_key),
        "count":       len(stocks),
        "cashPct":     round((1 - total_alloc) * 100, 2),
    }
