import pandas as pd
import requests
import re
import time
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from io import StringIO
from database import SessionLocal, BasketHistory, SoldStock, HiddenStock, StockEvent
from sqlalchemy import func


class _YFTimeoutSession(requests.Session):
    """Requests session that enforces a 12-second timeout on all yfinance HTTP calls."""
    def request(self, *args, **kwargs):
        kwargs.setdefault('timeout', 12)
        return super().request(*args, **kwargs)

_yf_session = _YFTimeoutSession()

# ── Static buy-dates override (loaded from buy_dates.json if present) ─────────
_STATIC_BUY_DATES: dict = {}
_BUY_DATES_FILE = os.path.join(os.path.dirname(__file__), 'buy_dates.json')
if os.path.exists(_BUY_DATES_FILE):
    try:
        with open(_BUY_DATES_FILE, 'r') as _f:
            _STATIC_BUY_DATES = json.load(_f)
    except Exception as _e:
        print(f"Warning: could not load buy_dates.json: {_e}")

# ── Stock info (name + sector) loaded from stock_info.json if present ─────────
_STOCK_INFO: dict = {}
_STOCK_INFO_FILE = os.path.join(os.path.dirname(__file__), 'stock_info.json')
if os.path.exists(_STOCK_INFO_FILE):
    try:
        with open(_STOCK_INFO_FILE, 'r') as _f:
            _STOCK_INFO = json.load(_f)
    except Exception as _e:
        print(f"Warning: could not load stock_info.json: {_e}")

# ── Junk column filter regex (compiled once at module level) ──────────────────
_JUNK_COL_RE = re.compile(
    r'^(unnamed\s*:?\s*\d+|column\s*\d+|top\s+gainers?|top\s+losers?|top\s+contributors?)\s*$',
    re.IGNORECASE
)

# ── yfinance metrics cache (1-hour TTL) ───────────────────────────────────────
# Caches CMP, PE, MCap, 1M-performance for each stock code.
# This replaces the GOOGLEFINANCE formulas in the Google Sheet:
#   CMP          → =GOOGLEFINANCE("NSE:"&code, "price")
#   1M Perf      → =(CMP / PRICE_30_DAYS_AGO - 1) * 100
#   P/E          → GOOGLEFINANCE or Screener scrape
#   Market Cap   → =GOOGLEFINANCE("NSE:"&code, "marketcap")
_yf_metrics_cache: dict = {}
_YF_METRICS_TTL = 3600  # 1 hour

def _get_yf_metrics(code: str) -> dict:
    """
    Fetch CMP, 1M performance, P/E and Market Cap from Yahoo Finance.
    Results are cached for 1 hour. Lock ensures only one thread fetches a given
    stock at a time — prevents 50 users simultaneously hammering Yahoo Finance
    for the same ticker.
    """
    import yfinance as yf
    normalized = re.sub(r'\s+', '', str(code).strip().upper())
    now = time.time()

    with _yf_metrics_lock:
        cached = _yf_metrics_cache.get(normalized)
        if cached and (now - cached['time']) < _YF_METRICS_TTL:
            return cached['data']

    result = {'cmp': 0.0, 'performance_1m': 0.0, 'pe': 0.0, 'mcap': 0.0}
    try:
        ticker_sym = f"{normalized}.NS" if not normalized.endswith('.NS') else normalized
        tk = yf.Ticker(ticker_sym, session=_yf_session)

        # CMP: latest close price
        hist = tk.history(period='5d')
        if not hist.empty:
            result['cmp'] = round(float(hist['Close'].iloc[-1]), 2)

        # 1-month performance: price 30 days ago vs today
        hist_1m = tk.history(period='35d')
        if not hist_1m.empty and len(hist_1m) >= 2:
            price_now = float(hist_1m['Close'].iloc[-1])
            # Find the row closest to 30 calendar days ago
            target = hist_1m.index[-1] - timedelta(days=30)
            past = hist_1m.loc[hist_1m.index <= target]
            if past.empty:
                past = hist_1m.iloc[:1]
            price_then = float(past['Close'].iloc[-1])
            if price_then > 0:
                result['performance_1m'] = round((price_now / price_then - 1) * 100, 2)

        # P/E and Market Cap from ticker info
        info = tk.info or {}
        pe_val = info.get('trailingPE') or info.get('forwardPE') or 0
        try:
            result['pe'] = round(float(pe_val), 2) if pe_val else 0.0
        except Exception:
            result['pe'] = 0.0

        mc_val = info.get('marketCap') or 0
        try:
            # Convert bytes → Crores (1 Cr = 10M INR)
            result['mcap'] = round(float(mc_val) / 1e7, 2) if mc_val else 0.0
        except Exception:
            result['mcap'] = 0.0

    except Exception as e:
        print(f"_get_yf_metrics error for {code}: {e}")

    with _yf_metrics_lock:
        _yf_metrics_cache[normalized] = {'time': now, 'data': result}
    return result


def _get_hidden_codes(db, basket_id: str) -> set:
    """
    Return the set of stock codes that should be hidden for a basket.
    - reason='sold'    → always hidden
    - reason='deleted' → hidden until expires_at; auto-remove expired entries
    """
    today_str = str(date.today())
    hidden = db.query(HiddenStock).filter_by(basket_id=basket_id).all()
    codes = set()
    expired = []
    for h in hidden:
        if h.hidden_reason == 'sold':
            codes.add(h.stock_code)
        elif h.hidden_reason == 'deleted':
            if h.expires_at and h.expires_at >= today_str:
                codes.add(h.stock_code)
            else:
                expired.append(h)
    for h in expired:
        db.delete(h)
    if expired:
        db.commit()
    return codes


def get_basket_from_db(sheet_name: str) -> tuple[list, list]:
    """
    Build a basket entirely from the local SQLite DB + yfinance.
    Called as a fallback when the Google Sheet is unreachable or has been removed.

    Replaces ALL GOOGLEFINANCE formulas:
      - CMP              ← yfinance latest close
      - 1M Performance   ← yfinance 30-day price change
      - Overall Perf     ← (CMP - BuyPrice) / BuyPrice × 100  (stored buy_price)
      - Contribution     ← Performance × Allocation / 100
      - P/E              ← yfinance trailingPE
      - Market Cap       ← yfinance marketCap → Crores
      - Stock Name       ← stock_name stored in BasketHistory (or stock_info.json)
      - Sector           ← sector stored in BasketHistory (or stock_info.json)
      - Allocation %     ← allocation stored in BasketHistory (saved on last sheet sync)
      - Buy Price        ← buy_price stored in BasketHistory
      - Buy Date         ← first_seen_date in BasketHistory
    """
    db = None
    try:
        db = SessionLocal()
        rows = db.query(BasketHistory).filter_by(basket_id=sheet_name).all()
        if not rows:
            return [], []

        hidden_codes = _get_hidden_codes(db, sheet_name)
        rows = [r for r in rows if r.stock_code not in hidden_codes]

        theme_label = re.sub(r'^NIA\s*', '', sheet_name).strip()

        # Fetch yfinance metrics for all stocks IN PARALLEL (not sequentially).
        # Sequential: 20 stocks × 2s = 40s. Parallel (8 workers): ~5s.
        def _fetch_row(row):
            code       = row.stock_code
            metrics    = _get_yf_metrics(code)
            cmp_val    = metrics['cmp'] or (row.last_cmp or 0.0)
            buy_price  = row.buy_price or 0.0
            allocation = row.allocation or 0.0
            overall_perf = round((cmp_val - buy_price) / buy_price * 100, 2) if buy_price > 0 and cmp_val > 0 else 0.0
            perf_1m      = metrics['performance_1m']
            return {
                'code':                code,
                'formula':             '',
                'theme':               theme_label,
                'allocation':          allocation,
                'buy_price':           buy_price,
                'cmp':                 cmp_val,
                'performance':         perf_1m,
                'overall_performance': overall_perf,
                'contribution':        round(perf_1m * allocation / 100, 4) if allocation > 0 else 0.0,
                'pe':                  metrics['pe'],
                'mcap':                metrics['mcap'],
                'tracker':             {},
                'sector':              row.sector     or _STOCK_INFO.get(code, {}).get('sector', ''),
                'stock_name':          row.stock_name or _STOCK_INFO.get(code, {}).get('name', code),
                'first_buy_date':      row.first_seen_date,
                'holding_days':        _holding_days(row.first_seen_date),
            }

        holdings = []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(_fetch_row, row): row for row in rows}
            for fut in as_completed(futures):
                try:
                    holdings.append(fut.result())
                except Exception as e:
                    print(f"get_basket_from_db row error: {e}")

        return holdings, []

    except Exception as e:
        print(f"get_basket_from_db error for {sheet_name}: {e}")
        return [], []
    finally:
        if db:
            db.close()


# ── Normalization & sanitization helpers ──────────────────────────────────────

def normalize_stock_code(raw) -> str:
    """Normalize NSE code for consistent comparisons & DB keys."""
    if raw is None or pd.isna(raw):
        return ""
    s = str(raw).strip().upper()
    # Remove internal whitespace (some sheets include accidental spaces)
    s = re.sub(r"\s+", "", s)
    return s

def sanitize_tracker_value(val):
    """Make sheet cell values safe for JSON serialization (avoid NaN/inf)."""
    if val is None:
        return None
    if pd.isna(val):
        return None
    if isinstance(val, (datetime, date)):
        return str(val)
    if isinstance(val, (int, float)):
        try:
            return float(val)
        except Exception:
            return None
    return str(val)

SPREADSHEET_ID = os.environ.get("SPREADSHEET_ID", "1eIw2QxtHX6b0iwhQvmlayKAAO7i97fYdMq7Fq6mToEk")
BASKET_SHEETS = [
  'NIA Mid & Small',
  'NIA Green Energy',
  'NIA Consumer Trends',
  'NIA IPO Basket',
  'NIA Tech Stack',
  'NIA Trends Trio',
  'NIA Make in India'
]

# ── Thread-safe cache layer ───────────────────────────────────────────────────
#
# Three levels:
#   1. _cache           — per-basket raw holdings (5-min TTL, populated by fetch_basket)
#   2. _assembled_cache — full /api/baskets response dict (60-sec TTL, avoids re-building
#                         the whole response for every request)
#   3. _basket_locks    — one Lock per basket; guarantees only ONE thread fetches a given
#                         basket from Google Sheets at a time (prevents cache stampede when
#                         50 users all hit the endpoint the moment the cache expires)
#
# Without this, 50 concurrent users could each simultaneously send an HTTP request to
# Google Sheets for the same basket, overwhelming both our server and Google's API.

CACHE_TTL      = 300   # seconds — basket-level cache
ASSEMBLED_TTL  = 60    # seconds — top-level assembled response cache

_cache:          dict = {}
_cache_rlock     = threading.RLock()           # protects reads/writes to _cache dict

_basket_locks:   dict = {sheet: threading.Lock() for sheet in BASKET_SHEETS}  # per-basket mutex

_assembled_cache = {'time': 0.0, 'data': None}
_assembled_lock  = threading.Lock()

# yfinance metrics lock — prevents duplicate parallel fetches for the same stock
_yf_metrics_lock = threading.RLock()

# ── Date parsing helpers ──────────────────────────────────────────────────────

# Formats seen in the sheet "Buy Date" column, e.g.:
#   "19 Nov 2025 → 3.0"
#   "28 Apr 2021 → 12.5\n10 Dec 2024 → 4.0"  (multiple entries)
#   "2025-11-19"
_DATE_FORMATS = [
    '%d %b %Y',   # 19 Nov 2025
    '%d %B %Y',   # 19 November 2025
    '%Y-%m-%d',   # 2025-11-19
    '%d/%m/%Y',   # 19/11/2025
    '%d/%m/%y',   # 16/03/25  (2-digit year, from Smallcase CSV)
    '%d-%m-%Y',   # 19-11-2025
    '%d-%m-%y',   # 16-03-25
]

def _try_parse_date(raw: str) -> str | None:
    """Extract the EARLIEST date from a raw Buy Date cell string.
    Returns a 'YYYY-MM-DD' string or None.

    The sheet uses a × (U+00D7 / \\xc3\\x97) separator between date and
    allocation, e.g. '19 Nov 2025 × 3.0' or multiple lines:
      '28 Apr 2021 × 12.5\\n10 Dec 2024 × 4.0'
    We extract the EARLIEST date.
    """
    if not raw or pd.isna(raw):
        return None
    raw = str(raw)
    # Split on newline / line-feed in case of multiple purchase entries
    lines = re.split(r'[\n\r]+', raw)
    parsed_dates = []
    for line in lines:
        # Split on × (U+00D7), → (U+2192), –, —, or plain hyphen/gt
        line = re.split(r'[\u00d7\u2192\u2013\u2014>]|-(?=\s*\d)', line)[0].strip()
        # Remove any remaining non-ASCII noise
        line = re.sub(r'[^\x00-\x7F]+', '', line).strip()
        # Remove trailing standalone numbers (e.g. '19 Nov 2025  3.0')
        line = re.sub(r'\s+\d+\.?\d*$', '', line).strip()
        for fmt in _DATE_FORMATS:
            try:
                d = datetime.strptime(line, fmt).date()
                parsed_dates.append(d)
                break
            except ValueError:
                continue
    if not parsed_dates:
        return None
    return str(min(parsed_dates))  # return the INITIAL (earliest) buy date


def parse_percent(val):
    if pd.isna(val):
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace('%', '').replace(',', '').strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_number(val):
    if pd.isna(val):
        return 0.0
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).replace(',', '').strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def is_holding_row(row):
    """
    Detect a valid holding row from the tracker.

    A stock is considered a holding if it has a valid NSE Code AND at least one
    numeric financial field (CMP, Buy Price, or Allocation) with a non-zero value.
    This prevents section-header rows (e.g. "Top Gainers") from being treated as stocks.
    """
    nse_code = ""
    for k in row.keys():
        if str(k).strip().lower() == "nse code":
            nse_code = normalize_stock_code(row[k])
            break

    if not nse_code or nse_code.lower() == "nan":
        return False

    # Allow optional ".NS" suffix
    if not re.match(r"^[A-Z0-9_\-\&]+(\.NS)?$", nse_code):
        return False

    # Require at least one valid numeric financial field to filter out section headers
    # (e.g. "Top Gainers" row has no CMP/Buy Price/Allocation)
    for k, v in row.items():
        k_lower = str(k).strip().lower()
        if k_lower in ('cmp', 'buy price', 'allocation'):
            try:
                num = float(str(v).replace('%', '').replace(',', '').strip())
                if num > 0:
                    return True
            except (ValueError, TypeError):
                pass

    return False


# ── Holding-days calculation ───────────────────────────────────────────────────

def _holding_days(first_date_str: str | None) -> int | None:
    """Return number of calendar days from first_date_str to today."""
    if not first_date_str:
        return None
    try:
        d = datetime.strptime(first_date_str, '%Y-%m-%d').date()
        return (date.today() - d).days
    except Exception:
        return None


# (cache variables already declared above near BASKET_SHEETS)


def fetch_basket(sheet_name):
    now = time.time()

    # ── Fast path: cache hit (no lock needed for read) ────────────────────────
    with _cache_rlock:
        entry = _cache.get(sheet_name)
    if entry and (now - entry['time']) < CACHE_TTL:
        # Return cached data but always recompute holding_days (they change daily)
        cached          = entry['data']
        tracker_columns = entry.get('columns', [])
        db = None
        try:
            db = SessionLocal()
            today_str_ch = str(date.today())
            dirty = False
            for h in cached:
                hist = db.query(BasketHistory).filter_by(
                    basket_id=sheet_name, stock_code=h['code']
                ).first()
                fsd = hist.first_seen_date if hist else None
                # If first_seen_date still null, set it now so Days/Added populate
                if not fsd and hist:
                    hist.first_seen_date = today_str_ch
                    fsd = today_str_ch
                    dirty = True
                # Populate buy_price from DB if sheet had none
                if hist and hist.buy_price and (not h.get('buy_price') or h['buy_price'] == 0):
                    h['buy_price'] = hist.buy_price
                    if h.get('cmp', 0) > 0 and hist.buy_price > 0:
                        h['overall_performance'] = round(
                            (h['cmp'] - hist.buy_price) / hist.buy_price * 100, 2
                        )
                h['first_buy_date'] = fsd
                h['holding_days']   = _holding_days(fsd)
            if dirty:
                db.commit()
        except Exception as e:
            print(f"DB read error (cache hit): {e}")
        finally:
            if db:
                db.close()
        return cached, tracker_columns

    # ── Slow path: cache miss — acquire per-basket lock (stampede protection) ─
    # If 50 users all hit this simultaneously after cache expiry, only ONE thread
    # fetches from Google Sheets. The other 49 wait, then pick up the warm cache.
    basket_lock = _basket_locks.get(sheet_name)
    with basket_lock:
        # Double-check: another thread may have populated the cache while we waited
        with _cache_rlock:
            entry = _cache.get(sheet_name)
        if entry and (now - entry['time']) < CACHE_TTL:
            return entry['data'], entry.get('columns', [])

        url = (
            f"https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}"
            f"/gviz/tq?tqx=out:csv&sheet={requests.utils.quote(sheet_name)}&t={int(now)}"
        )

        try:
            resp = requests.get(url, timeout=15)
            resp.raise_for_status()
            df = pd.read_csv(StringIO(resp.text))
        except Exception as e:
            print(f"Error fetching {sheet_name} from sheet: {e}")
            print(f"  → Falling back to local DB + yfinance for {sheet_name}")
            holdings, cols = get_basket_from_db(sheet_name)
            if holdings:
                with _cache_rlock:
                    _cache[sheet_name] = {'time': now, 'data': holdings, 'columns': cols}
            return holdings, cols

    tracker_columns = [
        str(c).strip() for c in df.columns
        if str(c).strip() and not _JUNK_COL_RE.match(str(c).strip())
    ]
    records = df.to_dict('records')
    valid_holdings = [r for r in records if is_holding_row(r)]

    # Filter out dashboard-hidden stocks (sold/deleted via UI)
    _hidden_db = None
    try:
        _hidden_db = SessionLocal()
        _hidden_codes = _get_hidden_codes(_hidden_db, sheet_name)
        valid_holdings = [
            r for r in valid_holdings
            if normalize_stock_code(
                next((r[k] for k in r if str(k).strip().lower() == 'nse code'), '')
            ) not in _hidden_codes
        ]
    except Exception as _he:
        print(f"Hidden stock filter error: {_he}")
    finally:
        if _hidden_db:
            _hidden_db.close()

    # Derive a clean theme label (strip 'NIA ' prefix)
    theme_label = re.sub(r'^NIA\s*', '', sheet_name).strip()

    processed_holdings = []
    for row in valid_holdings:
        # Preserve original tracker columns for UI display
        tracker_row = {str(k).strip(): sanitize_tracker_value(v) for k, v in row.items()}
        h = {str(k).strip().lower(): v for k, v in row.items()}

        code        = normalize_stock_code(h.get('nse code', ''))
        formula     = str(h.get('formula', '')).strip()
        allocation  = parse_percent(h.get('allocation', 0))
        buy_price   = parse_number(h.get('buy price', 0))
        cmp         = parse_number(h.get('cmp', 0))
        performance = parse_percent(h.get('performance', 0))

        if performance == 0 and buy_price > 0 and cmp > 0:
            performance = ((cmp - buy_price) / buy_price) * 100

        # Overall performance (since inception / since buy) — separate sheet column
        overall_performance = parse_percent(
            h.get('overall performance',
            h.get('overall return',
            h.get('overall%',
            h.get('overall perf', None))))
        )
        # If overall_performance not in sheet, derive it from buy_price vs cmp
        if overall_performance == 0 and buy_price > 0 and cmp > 0:
            overall_performance = ((cmp - buy_price) / buy_price) * 100

        # Read sector and name from sheet columns; fall back to stock_info.json
        sector = str(h.get('sector', h.get('theme_col', ''))).strip()
        if not sector or sector.lower() in ('nan', 'none', ''):
            sector = _STOCK_INFO.get(code, {}).get('sector', '')

        stock_name = str(h.get('constituents', h.get('stock name', h.get('name', '')))).strip()
        if not stock_name or stock_name.lower() in ('nan', 'none', ''):
            stock_name = _STOCK_INFO.get(code, {}).get('name', code)

        contribution = parse_percent(h.get('contribution', 0))

        # Robust PE / Market cap extraction across sheet versions
        pe = parse_number(h.get('pe ratio', h.get('pe', 0)))
        if pe == 0:
            for k, v in h.items():
                k_str = str(k).lower()
                if "pe" in k_str and "ratio" in k_str:
                    pe = parse_number(v)
                    if pe:
                        break

        mcap = parse_number(
            h.get('market cap. (in crs.)',
            h.get('market cap (in crs.)',
            h.get('market cap (crs.)',
            h.get('market cap (cr)',
            h.get('market cap', h.get('mcap', 0))))))
        )
        if mcap == 0:
            for k, v in h.items():
                k_str = str(k).lower().strip()
                if "market cap" in k_str or k_str in ("mcap", "m-cap"):
                    mcap = parse_number(v)
                    if mcap:
                        break

        # Try to read buy date from the sheet column
        sheet_buy_date = _try_parse_date(h.get('buy date', None))

        # Override / supplement with static buy_dates.json if present
        static_date = _STATIC_BUY_DATES.get(sheet_name, {}).get(code)
        if static_date and not sheet_buy_date:
            sheet_buy_date = static_date

        processed_holdings.append({
            'code':                code,
            'formula':             formula,
            'theme':               theme_label,
            'allocation':          allocation,
            'buy_price':           buy_price,
            'cmp':                 cmp,
            'performance':         performance,
            'overall_performance': overall_performance,
            'contribution':        contribution,
            'pe':                  pe,
            'mcap':                mcap,
            'tracker':             tracker_row,
            'sector':              sector,
            'stock_name':          stock_name,
            '_sheet_buy_date':     sheet_buy_date,   # internal, resolved below
            'first_buy_date':      None,
            'holding_days':        None,
        })

    # ── Sync DB ────────────────────────────────────────────────────────────────
    try:
        db = SessionLocal()
        today_str = str(date.today())

        for h in processed_holdings:
            hist = db.query(BasketHistory).filter_by(
                basket_id=sheet_name, stock_code=h['code']
            ).first()

            # Backward-compatible lookup for previously-stored (non-normalized) codes
            if not hist:
                hist = db.query(BasketHistory).filter(
                    BasketHistory.basket_id == sheet_name,
                    func.replace(func.upper(BasketHistory.stock_code), " ", "") == h['code']
                ).first()
                if hist and hist.stock_code != h['code']:
                    hist.stock_code = h['code']

            if hist:
                hist.last_cmp       = h['cmp']
                hist.last_seen_date = today_str

                # Track allocation change for event log
                new_alloc = h['allocation'] if h['allocation'] and h['allocation'] > 0 else None
                old_alloc = hist.allocation
                if new_alloc is not None and old_alloc is not None and abs(new_alloc - old_alloc) >= 0.01:
                    db.add(StockEvent(
                        basket_id   = sheet_name,
                        stock_code  = h['code'],
                        event_type  = 'allocation_changed',
                        description = f"Allocation changed from {old_alloc:.2f}% to {new_alloc:.2f}%",
                        old_value   = f"{old_alloc:.2f}",
                        new_value   = f"{new_alloc:.2f}",
                        event_date  = today_str,
                    ))

                # Track buy price change for event log
                new_bp = h['buy_price'] if h['buy_price'] and h['buy_price'] > 0 else None
                old_bp = hist.buy_price
                if new_bp is not None and old_bp is not None and abs(new_bp - old_bp) >= 0.01:
                    db.add(StockEvent(
                        basket_id   = sheet_name,
                        stock_code  = h['code'],
                        event_type  = 'price_changed',
                        description = f"Buy price updated from ₹{old_bp:.2f} to ₹{new_bp:.2f}",
                        old_value   = f"{old_bp:.2f}",
                        new_value   = f"{new_bp:.2f}",
                        event_date  = today_str,
                    ))

                # Update values
                if new_alloc is not None:
                    hist.allocation = new_alloc
                if new_bp is not None:
                    hist.buy_price = new_bp

                # ── IMMUTABLE first_seen_date: set ONCE, never overwrite ──────
                # Once a stock has a recorded date, it stays forever.
                # Only populate if it is still NULL (first sync for this stock).
                if not hist.first_seen_date:
                    hist.first_seen_date = h['_sheet_buy_date'] or today_str

                if h.get('stock_name'):
                    hist.stock_name = h['stock_name']
                if h.get('sector'):
                    hist.sector = h['sector']
            else:
                first_date = h['_sheet_buy_date'] or today_str
                hist = BasketHistory(
                    basket_id       = sheet_name,
                    stock_code      = h['code'],
                    last_cmp        = h['cmp'],
                    last_seen_date  = today_str,
                    first_seen_date = first_date,
                    buy_price       = h['buy_price'] if h['buy_price'] and h['buy_price'] > 0 else None,
                    allocation      = h['allocation'] if h['allocation'] and h['allocation'] > 0 else None,
                    stock_name      = h.get('stock_name', ''),
                    sector          = h.get('sector', ''),
                )
                db.add(hist)
                # Record 'added' event for newly seen stocks
                db.add(StockEvent(
                    basket_id   = sheet_name,
                    stock_code  = h['code'],
                    event_type  = 'added',
                    description = f"Stock first appeared in portfolio sheet",
                    old_value   = None,
                    new_value   = f"alloc={h['allocation']:.2f}%, buy_px={h['buy_price']:.2f}" if h['buy_price'] else f"alloc={h['allocation']:.2f}%",
                    event_date  = today_str,
                ))

        # Move stocks no longer in the sheet to SoldStock.
        # A stock is considered "sold" ONLY when it is deleted from the tracker sheet.
        # If it is missing today (last_seen_date < today), archive it immediately.
        missing = db.query(BasketHistory).filter(
            BasketHistory.basket_id      == sheet_name,
            BasketHistory.last_seen_date < today_str
        ).all()

        for m in missing:
            sold = db.query(SoldStock).filter_by(
                basket_id=sheet_name, stock_code=m.stock_code
            ).first()
            if not sold:
                # Use stored buy_price from sheet; fall back to last_cmp if unavailable
                recorded_buy = m.buy_price if (m.buy_price and m.buy_price > 0) else m.last_cmp
                sector = m.sector or _STOCK_INFO.get(m.stock_code, {}).get('sector', '')
                stock_name = m.stock_name or _STOCK_INFO.get(m.stock_code, {}).get('name', m.stock_code)
                sold = SoldStock(
                    basket_id  = sheet_name,
                    stock_code = m.stock_code,
                    buy_price  = recorded_buy,
                    sell_price = m.last_cmp,   # last known CMP is the exit price
                    sell_date  = m.last_seen_date,  # use actual last-seen date as sell date
                    buy_date   = m.first_seen_date,
                    sector     = sector,
                    stock_name = stock_name,
                )
                db.add(sold)
            db.delete(m)

        db.commit()

        # Now read back first_seen_date + DB buy_price for every holding
        for h in processed_holdings:
            hist = db.query(BasketHistory).filter_by(
                basket_id=sheet_name, stock_code=h['code']
            ).first()
            if not hist:
                hist = db.query(BasketHistory).filter(
                    BasketHistory.basket_id == sheet_name,
                    func.replace(func.upper(BasketHistory.stock_code), " ", "") == h['code']
                ).first()
            fsd = hist.first_seen_date if hist else None
            h['first_buy_date'] = fsd
            h['holding_days']   = _holding_days(fsd)
            # If the sheet had no buy_price, fall back to the value stored in DB
            # (populated by the Excel rebalance import via yfinance avg price)
            if (not h['buy_price'] or h['buy_price'] == 0) and hist and hist.buy_price:
                h['buy_price'] = hist.buy_price
                if h['cmp'] > 0 and hist.buy_price > 0:
                    h['overall_performance'] = round(
                        (h['cmp'] - hist.buy_price) / hist.buy_price * 100, 2
                    )
            del h['_sheet_buy_date']   # strip internal key

    except Exception as db_e:
        print(f"DB Error processing {sheet_name}: {db_e}")
        # Clean up internal key even on error
        for h in processed_holdings:
            h.pop('_sheet_buy_date', None)
    finally:
        if 'db' in locals():
            db.close()

    with _cache_rlock:
        _cache[sheet_name] = {'time': now, 'data': processed_holdings, 'columns': tracker_columns}
    return processed_holdings, tracker_columns


def get_live_cmp(code: str) -> float:
    """
    Fetch the current market price for an NSE stock.
    Equivalent to: =GOOGLEFINANCE("NSE:"&code, "price")

    Strategy:
      1. Check the in-memory sheet cache — CMP values there come directly from
         the GOOGLEFINANCE formula in the Google Sheet tracker, so this is the
         primary / most up-to-date Google Finance value.
      2. Fall back to yfinance (Yahoo Finance, same underlying exchange data)
         when the stock is not yet in any basket.
    """
    import yfinance as yf
    from datetime import datetime, timedelta

    normalized = normalize_stock_code(code)

    # ── 1. Try basket cache (GOOGLEFINANCE-powered CMP) ──────────────────────
    for sheet_name, entry in _cache.items():
        for h in entry.get('data', []):
            if normalize_stock_code(h.get('code', '')) == normalized:
                cmp = h.get('cmp', 0)
                if cmp and cmp > 0:
                    return float(cmp)

    # ── 2. Fallback: yfinance (equivalent to GOOGLEFINANCE historical price) ──
    # =GOOGLEFINANCE("NSE:"&code, "price", TODAY()-3, TODAY())
    try:
        ticker = f"{normalized}.NS" if not normalized.endswith('.NS') else normalized
        end   = datetime.now()
        start = end - timedelta(days=5)
        data  = yf.download(ticker, start=start.strftime('%Y-%m-%d'),
                            end=end.strftime('%Y-%m-%d'), progress=False,
                            session=_yf_session)
        if not data.empty:
            return round(float(data.iloc[-1]['Close']), 2)
    except Exception as e:
        print(f"get_live_cmp fallback error for {code}: {e}")

    return 0.0


def _build_basket_entry(sheet: str) -> tuple[str, dict]:
    """Build the result dict for a single basket. Used by both the main path and background refresh."""
    from sqlalchemy import func as _sqf
    slug     = re.sub(r'[^a-z0-9]+', '-', sheet.lower()).strip('-')
    holdings, tracker_columns = fetch_basket(sheet)

    # Inception date: earliest first_seen across active + sold stocks
    inception_date = None
    try:
        _db = SessionLocal()
        _a = _db.query(_sqf.min(BasketHistory.first_seen_date)).filter_by(basket_id=sheet).scalar()
        _s = _db.query(_sqf.min(SoldStock.buy_date)).filter_by(basket_id=sheet).scalar()
        _candidates = [d for d in [_a, _s] if d]
        inception_date = min(_candidates) if _candidates else None
    except Exception:
        pass
    finally:
        if '_db' in dir():
            _db.close()

    for h in holdings:
        if (h.get('contribution', 0) == 0) and h['performance'] != 0 and h['allocation'] > 0:
            h['contribution'] = (h['performance'] * h['allocation']) / 100

    top_gainers      = sorted(holdings, key=lambda x: x['performance'], reverse=True)[:5]
    top_losers       = sorted(holdings, key=lambda x: x['performance'])[:5]
    top_contributors = sorted(holdings, key=lambda x: x['contribution'], reverse=True)[:5]

    total_allocation = sum(h['allocation'] for h in holdings)
    if total_allocation > 0:
        basket_return = sum(h['performance'] * h['allocation'] for h in holdings) / total_allocation
    else:
        basket_return = sum(h['performance'] for h in holdings) / len(holdings) if holdings else 0

    sold_list = []
    try:
        db = SessionLocal()
        for s in db.query(SoldStock).filter_by(basket_id=sheet).all():
            sold_list.append({
                'code':       s.stock_code,
                'name':       s.stock_name or s.stock_code,
                'buy_price':  s.buy_price,
                'sell_price': s.sell_price,
                'buy_date':   s.buy_date,
                'sell_date':  s.sell_date,
                'sector':     s.sector or '',
                'weight':     s.weight,
            })
    except Exception:
        pass
    finally:
        if 'db' in dir():
            db.close()

    return slug, {
        'id':              slug,
        'name':            sheet,
        'holdings':        holdings,
        'sold_stocks':     sold_list,
        'tracker_columns': tracker_columns,
        'stats': {
            'basket_return':    basket_return,
            'top_gainers':      top_gainers,
            'top_losers':       top_losers,
            'top_contributors': top_contributors,
            'stock_count':      len(holdings),
            'total_mcap':       sum(h.get('mcap', 0) for h in holdings if h.get('mcap', 0) > 0),
            'inception_date':   inception_date,
        },
    }


def get_all_baskets():
    """
    Return the assembled baskets dict.

    Two-level caching:
      - Each basket is individually cached for 5 minutes by fetch_basket().
      - The fully assembled response is cached for 60 seconds here, so if 50
        users all call /api/baskets at once, only 1 request builds the response
        and the other 49 receive the cached copy instantly.
    """
    now = time.time()

    with _assembled_lock:
        if _assembled_cache['data'] and (now - _assembled_cache['time']) < ASSEMBLED_TTL:
            return _assembled_cache['data']

    results = {}
    for sheet in BASKET_SHEETS:
        try:
            slug, entry = _build_basket_entry(sheet)
            results[slug] = entry
        except Exception as e:
            print(f"get_all_baskets error for {sheet}: {e}")

    with _assembled_lock:
        _assembled_cache['time'] = now
        _assembled_cache['data'] = results

    return results


# ── Background cleanup thread ──────────────────────────────────────────────────
# Used to also re-fetch every basket from the Google Sheet here every 4.5
# minutes, but that Sheet was retired once the webportal + its own rebalance-
# upload flow became the real source of truth for basket composition (Overview/
# Holdings now read from routers/actual_portfolio_bridge.py's
# _fetch_all_webportal_baskets() instead -- see historic.py/alerts_market.py/
# main.py's prewarm). That refetch loop was actively harmful, not just idle:
# it wrote stale Sheet-derived buy_price/allocation/cmp values into
# BasketHistory every cycle, and its "new stock?" detection misfired
# constantly, logging thousands of bogus "Stock first appeared" StockEvent
# rows into the admin Activity Backlog (confirmed 5000+ of them, all with no
# user attribution since they're not user-driven). Only the unrelated hidden-
# stock cleanup below is still needed, so that's all this thread does now.
def _background_refresh():
    while True:
        time.sleep(270)   # 4.5 min
        # Cleanup expired 'deleted' hidden stocks (>7 days old)
        try:
            _cleanup_db = SessionLocal()
            today_str = str(date.today())
            expired = _cleanup_db.query(HiddenStock).filter(
                HiddenStock.hidden_reason == 'deleted',
                HiddenStock.expires_at < today_str
            ).all()
            for h in expired:
                _cleanup_db.delete(h)
            if expired:
                _cleanup_db.commit()
                print(f"[BG] Removed {len(expired)} expired hidden stocks.")
        except Exception as _ce:
            print(f"[BG] Hidden stock cleanup error: {_ce}")
        finally:
            if '_cleanup_db' in dir():
                _cleanup_db.close()

_bg_thread = threading.Thread(target=_background_refresh, daemon=True, name="hidden-stock-cleanup")
_bg_thread.start()
