"""JSON-file persistence for portfolios, buy-price data, rebalance history,
gains statement, historical index, undo snapshots, and rollback points.

Independent of main.py (no circular imports) so every router can import
directly from here, same pattern as backend/common/ on the main backend.
"""
import json
import time
from pathlib import Path

from fastapi import HTTPException, Request

from portfolio_data import BUY_PRICE_DETAILS, PORTFOLIOS_DATA
from common.admin import is_admin_email
from common.json_store import save_json as _common_save_json

_CLIENTS_FILE = Path(__file__).parent / "clients.json"
_CLIENT_ID_MAP_FILE = Path(__file__).parent / "client_id_map.json"
_CLIENT_CAPITAL_FILE = Path(__file__).parent / "client_capital.json"

def _load_clients() -> dict:
    """{client_key: display_name, ...} -- this dashboard's clients are added
    manually by admin (see add_client() below), not a fixed hardcoded set."""
    if _CLIENTS_FILE.exists():
        with open(_CLIENTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

# NOTE: every module that does `from persistence import BASKET_DISPLAY_NAMES`
# shares this exact dict object. add_client() mutates it in place (rather than
# reassigning) specifically so a newly-added client shows up immediately in
# every already-imported module, with no re-import or restart needed.
BASKET_DISPLAY_NAMES = _load_clients()

_PORTFOLIOS_FILE  = Path(__file__).parent / "portfolios.json"
_BUY_PRICE_FILE   = Path(__file__).parent / "buy_price_data.json"
_RH_FILE          = Path(__file__).parent / "rebalance_history.json"
_GAINS_FILE       = Path(__file__).parent / "gains_statement.json"
_HIST_INDEX_FILE  = Path(__file__).parent / "historical_index.json"
_UNDO_FILE        = Path(__file__).parent / "undo_snapshots.json"
_ROLLBACK_FILE    = Path(__file__).parent / "rollback_points.json"
_MAX_ROLLBACK_PTS = 5
_ACTIVITY_LOG_FILE = Path(__file__).parent / "activity_log.json"

# ── In-memory JSON cache — files are read once then served from RAM ───────────
# Invalidated immediately on every write so stale data is never served --
# WITHIN this process. This module also runs as a second, fully independent
# copy inside backend/main.py's importlib-mounted /wp sub-app (separate
# globals entirely), so a real sell made through one process's API (e.g. the
# standalone webportal on :8001) would otherwise sit invisible to the other
# (e.g. the main app's Basket Comparison/Result Calendar, reading through the
# :8000-mounted copy) until THAT process restarts -- not just for a cache
# TTL's worth of time, but indefinitely. _portfolios_mem_mtime compares
# against the file's on-disk mtime on every load, so any process picks up a
# change made by any other process within roughly a disk-write's worth of
# latency, not "never".
_portfolios_mem:  dict | None = None
_portfolios_mem_mtime: float | None = None
_buy_price_mem:   dict | None = None
_rh_mem:          dict | None = None

# ─────────────────────────────────────────────────────────────────────────────
# Admin auth helpers (JWT decode without jose dependency)
# ─────────────────────────────────────────────────────────────────────────────

def _get_request_email(request: Request) -> str | None:
    import base64 as _b64
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    try:
        parts = auth.split(".")
        if len(parts) != 3:
            return None
        padding = 4 - len(parts[1]) % 4
        payload = json.loads(_b64.urlsafe_b64decode(parts[1] + "=" * padding))
        return (payload.get("sub") or "").lower().strip() or None
    except Exception:
        return None

def _require_admin(request: Request) -> str:
    email = _get_request_email(request)
    if not email or not is_admin_email(email):
        raise HTTPException(status_code=403, detail="Admin access required.")
    return email

def _log_activity(action: str, user: str, details: dict):
    from datetime import datetime, timezone
    try:
        log = json.loads(_ACTIVITY_LOG_FILE.read_text()) if _ACTIVITY_LOG_FILE.exists() else []
        log.insert(0, {
            "action": action, "user": user,
            "ts": datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC"),
            "details": details,
        })
        _ACTIVITY_LOG_FILE.write_text(json.dumps(log[:500], indent=2))
    except Exception as e:
        print(f"[activity-log] {e}")

# ─────────────────────────────────────────────────────────────────────────────
# Portfolio persistence
# ─────────────────────────────────────────────────────────────────────────────

def _load_portfolios() -> dict:
    global _portfolios_mem, _portfolios_mem_mtime
    try:
        disk_mtime = _PORTFOLIOS_FILE.stat().st_mtime if _PORTFOLIOS_FILE.exists() else None
    except OSError:
        disk_mtime = None

    if _portfolios_mem is not None and disk_mtime == _portfolios_mem_mtime:
        return _portfolios_mem

    if _PORTFOLIOS_FILE.exists():
        with open(_PORTFOLIOS_FILE, "r", encoding="utf-8") as f:
            _portfolios_mem = json.load(f)
        _portfolios_mem_mtime = disk_mtime
        return _portfolios_mem

    _portfolios_mem = dict(PORTFOLIOS_DATA)
    _portfolios_mem_mtime = None
    return _portfolios_mem


def _save_and_push(file_path: Path, data: dict) -> None:
    """Write JSON to disk and push to GitHub in background (shared with backend/main.py)."""
    _common_save_json(str(file_path), data, f"webportal/backend/{file_path.name}", sync=False)


_LIQUIDCASE_CODE = "LIQUIDCASE"
_ALLOC_TOLERANCE = 0.001  # fraction (0.1%) -- ignore rounding noise from float weights


def _liquidcase_fallback_price(data: dict) -> float:
    """Best-effort buyPrice for a brand-new LIQUIDCASE row: reuse whatever
    price another basket's existing LIQUIDCASE holding was bought at, since
    it's the same instrument everywhere. Falls back to its approximate NAV."""
    for holdings in data.values():
        if not isinstance(holdings, list):
            continue
        for h in holdings:
            if h.get("nseCode") == _LIQUIDCASE_CODE and h.get("buyPrice"):
                return h["buyPrice"]
    return 100.0


def _reconcile_liquidcase(data: dict) -> dict:
    """Whenever a basket's holdings don't sum to 100% allocation, park the
    unallocated remainder in LIQUIDCASE (cash-equivalent liquid ETF) instead
    of leaving it uninvested and untracked. Only tops up -- never trims an
    over-100% basket down.

    Skips IPO_Recommendations (and its _sold counterpart): that basket is a
    growing equal-weighted watchlist of recent IPOs, not a capital-weighted
    portfolio -- every stock in it is intentionally seeded at allocation: 0
    (see App.jsx's isIPO equal-weight display), so this rule would otherwise
    see ~0% "allocated" on every save and dump ~100% into a LIQUIDCASE row
    that has no business being there."""
    for basket_key, holdings in data.items():
        if basket_key.startswith("IPO_Recommendations"):
            continue
        if not isinstance(holdings, list) or not holdings:
            continue
        total = sum(h.get("allocation", 0) or 0 for h in holdings)
        residual = 1.0 - total
        if residual <= _ALLOC_TOLERANCE:
            continue
        cash_row = next((h for h in holdings if h.get("nseCode") == _LIQUIDCASE_CODE), None)
        if cash_row:
            cash_row["allocation"] = round((cash_row.get("allocation") or 0) + residual, 6)
        else:
            holdings.append({
                "nseCode":   _LIQUIDCASE_CODE,
                "allocation": round(residual, 6),
                "buyPrice":  _liquidcase_fallback_price(data),
            })
    return data


def _save_portfolios(data: dict) -> None:
    global _portfolios_mem, _portfolios_mem_mtime
    data = _reconcile_liquidcase(data)
    _portfolios_mem = data          # update memory cache immediately
    _save_and_push(_PORTFOLIOS_FILE, data)
    try:
        # Matches the mtime _load_portfolios will see post-write, so this
        # process doesn't immediately re-read its own just-written file.
        _portfolios_mem_mtime = _PORTFOLIOS_FILE.stat().st_mtime
    except OSError:
        _portfolios_mem_mtime = None


def _load_buy_price_data() -> dict:
    global _buy_price_mem
    if _buy_price_mem is not None:
        return _buy_price_mem
    if _BUY_PRICE_FILE.exists():
        with open(_BUY_PRICE_FILE, "r", encoding="utf-8") as f:
            _buy_price_mem = json.load(f)
            return _buy_price_mem
    _buy_price_mem = dict(BUY_PRICE_DETAILS)
    return _buy_price_mem


def _save_buy_price_data(data: dict) -> None:
    global _buy_price_mem
    _buy_price_mem = data           # update memory cache immediately
    _save_and_push(_BUY_PRICE_FILE, data)


def _slugify_client_name(name: str) -> str:
    """Turn a human client name into a stable dict key, e.g. 'Acme Corp' -> 'Acme_Corp'."""
    import re as _re
    slug = _re.sub(r'[^A-Za-z0-9]+', '_', name.strip()).strip('_')
    return slug or "Client"


def add_client(name: str) -> tuple[str, str]:
    """Admin-only: register a new client (the basket-equivalent in this
    dashboard). Returns (key, label). Stock composition is added afterward,
    separately, via the existing admin-only rebalance file-upload flow --
    this just creates the empty client entry those uploads can then target."""
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Client name required.")

    base_key = _slugify_client_name(name)
    key = base_key
    n = 2
    while key in BASKET_DISPLAY_NAMES:
        key = f"{base_key}_{n}"
        n += 1

    BASKET_DISPLAY_NAMES[key] = name
    _save_and_push(_CLIENTS_FILE, BASKET_DISPLAY_NAMES)

    portfolios = _load_portfolios()
    if key not in portfolios:
        portfolios[key] = []
        _save_portfolios(portfolios)

    buy_price = _load_buy_price_data()
    if key not in buy_price:
        buy_price[key] = {}
        _save_buy_price_data(buy_price)

    return key, name


def _load_client_id_map() -> dict:
    """{broker Client ID (e.g. 'PA8384'): basket_key} -- lets a broker holdings
    upload auto-resolve which client's basket it belongs to on repeat uploads,
    once an admin has linked that Client ID once (see holdings_import.py)."""
    if _CLIENT_ID_MAP_FILE.exists():
        with open(_CLIENT_ID_MAP_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_client_id_map(data: dict) -> None:
    _save_and_push(_CLIENT_ID_MAP_FILE, data)


def _load_client_capital() -> dict:
    """{basket_key: total capital deployed (float, admin-entered)} -- the app
    has no absolute rupee figure anywhere else (everything else is % weight +
    per-share buy price), so this is the one manually-maintained number the
    All Clients tab's Invested/Current Value columns are built from."""
    if _CLIENT_CAPITAL_FILE.exists():
        with open(_CLIENT_CAPITAL_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_client_capital(data: dict) -> None:
    _save_and_push(_CLIENT_CAPITAL_FILE, data)


def rename_client(key: str, new_name: str) -> str:
    """Admin-only: change a client's display name. The basket key itself
    (used as the storage identifier everywhere else) never changes, so
    nothing else needs updating."""
    new_name = (new_name or "").strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Client name required.")
    if key not in BASKET_DISPLAY_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown client: {key}")

    BASKET_DISPLAY_NAMES[key] = new_name
    _save_and_push(_CLIENTS_FILE, BASKET_DISPLAY_NAMES)
    return new_name


def delete_client(key: str) -> None:
    """Admin-only: permanently remove a client and all of its data (holdings,
    buy-price history, rebalance history, undo snapshots, and any broker
    Client-ID link pointing at it). Irreversible -- the caller is expected to
    have confirmed with the admin already."""
    if key not in BASKET_DISPLAY_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown client: {key}")

    del BASKET_DISPLAY_NAMES[key]
    _save_and_push(_CLIENTS_FILE, BASKET_DISPLAY_NAMES)

    portfolios = _load_portfolios()
    portfolios.pop(key, None)
    portfolios.pop(f"{key}_sold", None)
    _save_portfolios(portfolios)

    buy_price = _load_buy_price_data()
    buy_price.pop(key, None)
    _save_buy_price_data(buy_price)

    rh = _load_rebalance_history()
    rh.pop(key, None)
    _save_rebalance_history(rh)

    undo = _load_undo_snapshots()
    undo.pop(key, None)
    _save_undo_snapshots(undo)

    client_ids = _load_client_id_map()
    remaining = {cid: basket for cid, basket in client_ids.items() if basket != key}
    if len(remaining) != len(client_ids):
        _save_client_id_map(remaining)

    capital = _load_client_capital()
    if capital.pop(key, None) is not None:
        _save_client_capital(capital)


def _load_rebalance_history() -> dict:
    global _rh_mem
    if _rh_mem is not None:
        return _rh_mem
    if _RH_FILE.exists():
        with open(_RH_FILE, "r", encoding="utf-8") as f:
            _rh_mem = json.load(f)
            return _rh_mem
    _rh_mem = {}
    return _rh_mem


def _save_rebalance_history(data: dict) -> None:
    global _rh_mem
    _rh_mem = data
    _save_and_push(_RH_FILE, data)


def _save_gains(gains: dict) -> None:
    """Write gains_statement.json locally (not pushed to GitHub -- derived/recomputable data)."""
    with open(_GAINS_FILE, "w", encoding="utf-8") as f:
        json.dump(gains, f, indent=2, ensure_ascii=False)


def _load_historical_index() -> dict:
    if not _HIST_INDEX_FILE.exists():
        raise HTTPException(status_code=404, detail="historical_index.json not found")
    with open(_HIST_INDEX_FILE, encoding="utf-8") as f:
        return json.load(f)


def _save_historical_index(hi: dict) -> None:
    with open(_HIST_INDEX_FILE, "w", encoding="utf-8") as f:
        json.dump(hi, f, indent=2, ensure_ascii=False)


# ─────────────────────────────────────────────────────────────────────────────
# Persistent undo snapshots (per basket, max 10)
# ─────────────────────────────────────────────────────────────────────────────

def _load_undo_snapshots() -> dict:
    try:
        if _UNDO_FILE.exists():
            with open(_UNDO_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def _save_undo_snapshots(data: dict) -> None:
    with open(_UNDO_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _auto_save_rollback() -> None:
    """Auto-save full system state before any write. Overwrites the single rollback point.
    Never raises — snapshot failure must never abort the actual operation."""
    try:
        point = {
            "id":               "latest",
            "label":            time.strftime("%d %b %Y %H:%M"),
            "createdAt":        time.strftime("%d %b %Y %H:%M"),
            "portfolios":       json.loads(_PORTFOLIOS_FILE.read_text(encoding="utf-8")),
            "buyPriceData":     json.loads(_BUY_PRICE_FILE.read_text(encoding="utf-8")),
            "rebalanceHistory": json.loads(_RH_FILE.read_text(encoding="utf-8")),
        }
        _ROLLBACK_FILE.write_text(json.dumps([point], ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _push_undo_snapshot(basket: str, label: str = "") -> None:
    """Snapshot current basket state before a destructive change. Keeps last 10."""
    pf = _load_portfolios()
    bp = _load_buy_price_data()
    rh = _load_rebalance_history()
    snapshot = {
        "ts":               time.time(),
        "label":            label or f"snapshot at {time.strftime('%d %b %Y %H:%M')}",
        "stocks":           pf.get(basket, []),
        "sold":             pf.get(f"{basket}_sold", []),
        "buyPriceData":     bp.get(basket, {}),
        "rebalanceHistory": rh.get(basket, []),
    }
    snaps = _load_undo_snapshots()
    basket_snaps = snaps.get(basket, [])
    basket_snaps.append(snapshot)
    snaps[basket] = basket_snaps[-10:]   # keep last 10
    _save_undo_snapshots(snaps)


def _all_nse_codes() -> list:
    seen, codes = set(), []
    for stocks in _load_portfolios().values():
        for s in stocks:
            c = s.get("nseCode", "").strip().upper()
            if c and c not in seen:
                seen.add(c)
                codes.append(c)
    return codes
