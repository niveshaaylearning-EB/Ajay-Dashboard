"""Target/stoploss alerts, rebalance Excel upload, network info, market indices."""
import asyncio
import json
import tempfile
from datetime import datetime

from fastapi import APIRouter, Depends, File as FastAPIFile, HTTPException, Request, UploadFile
from sqlalchemy.orm import Session

import database
import sheet_service
from auth import get_location_from_ip, is_admin_email
from common.admin import ADMIN_EMAILS
from main import get_db, _io_pool, _historic_cache, _dump_audit_log
from routers.actual_portfolio_bridge import _fetch_all_webportal_baskets

router = APIRouter()

# ── Target / Stoploss alerts (cross-basket) ───────────────────────────────────

@router.get("/api/alerts")
async def get_alerts(db: Session = Depends(get_db)):
    """
    Return list of stocks across all baskets that have hit their target
    or breached their stoploss based on current CMP.
    """
    loop    = asyncio.get_running_loop()
    baskets = await loop.run_in_executor(_io_pool, _fetch_all_webportal_baskets)

    alerts = []
    for basket_id, basket in baskets.items():
        basket_name = basket['name']
        targets_rows = db.query(database.StockTarget).filter_by(basket_id=basket_name).all()
        tmap = {t.stock_code: t for t in targets_rows}

        for h in basket.get('holdings', []):
            code = h.get('code', '')
            cmp  = float(h.get('cmp', 0) or 0)
            t    = tmap.get(code)
            if not t or cmp <= 0:
                continue

            if t.target_price and cmp >= t.target_price:
                alerts.append({
                    'type':         'target_hit',
                    'basket_id':    basket_id,
                    'basket_name':  basket_name,
                    'stock_code':   code,
                    'stock_name':   h.get('stock_name', code),
                    'cmp':          cmp,
                    'target_price': t.target_price,
                    'stoploss':     t.stoploss,
                    'pct':          round((cmp - t.target_price) / t.target_price * 100, 2),
                })
            elif t.stoploss and cmp <= t.stoploss:
                alerts.append({
                    'type':         'stoploss_hit',
                    'basket_id':    basket_id,
                    'basket_name':  basket_name,
                    'stock_code':   code,
                    'stock_name':   h.get('stock_name', code),
                    'cmp':          cmp,
                    'target_price': t.target_price,
                    'stoploss':     t.stoploss,
                    'pct':          round((t.stoploss - cmp) / t.stoploss * 100, 2),
                })

    # Merge in Watchlist alerts (next-review date reached / target price hit) --
    # lazy import since watchlist.py lives in webportal/backend, only reachable
    # once backend/main.py has put that directory on sys.path (see its startup).
    try:
        import watchlist as _wl_module
        alerts.extend(_wl_module.get_watchlist_alerts())
    except Exception as e:
        print(f"[alerts] watchlist merge failed: {e}")

    return alerts


# ── Rebalance Excel upload ────────────────────────────────────────────────────

REBALANCE_ALLOWED = ADMIN_EMAILS

@router.post("/api/upload-rebalance")
async def upload_rebalance(request: Request, file: UploadFile = FastAPIFile(...)):
    """Upload a new rebalance Excel file and import all 7 baskets."""
    import os as _os
    content  = await file.read()
    summary  = {}
    user_email = getattr(request.state, "user", "unknown")

    if user_email not in REBALANCE_ALLOWED:
        raise HTTPException(status_code=403, detail="You do not have permission to upload rebalance files.")

    with tempfile.NamedTemporaryFile(suffix='.xlsx', delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        from rebalance_utils import parse_excel, import_basket
        baskets_data = parse_excel(tmp_path)
        db_up = database.SessionLocal()
        try:
            for basket_name, data in baskets_data.items():
                result = import_basket(db_up, basket_name, data, log=lambda _: None)
                summary[basket_name] = result
            # Audit log entry
            ip = request.client.host if request.client else None
            loc = get_location_from_ip(ip)
            db_up.add(database.AuditLog(
                user_email = user_email,
                event_type = "rebalance_upload",
                details    = json.dumps({"file": file.filename, "baskets": summary}),
                created_at = datetime.now().isoformat(),
                ip_address = ip,
                location   = loc,
            ))
            db_up.commit()
            _dump_audit_log(db_up)   # persist rebalance upload to GitHub immediately
        finally:
            db_up.close()

        sheet_service._cache.clear()
        sheet_service._assembled_cache['time'] = 0
        _historic_cache.clear()

        return {"status": "success", "baskets": summary}
    finally:
        _os.unlink(tmp_path)


@router.get("/api/network-info")
def get_network_info(request: Request):
    """Return the machine's LAN IP so the admin can see the share URL."""
    user = getattr(request.state, "user", None)
    if not is_admin_email(user):
        raise HTTPException(status_code=403, detail="Admin only")
    import socket as _socket
    try:
        _s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        _s.settimeout(0)
        _s.connect(("10.254.254.254", 1))
        ip = _s.getsockname()[0]
        _s.close()
    except Exception:
        ip = "127.0.0.1"
    return {"ip": ip, "share_url": f"http://{ip}:8100"}


def _fetch_nse_index_csv() -> dict:
    """Fetch NSE index close prices from daily index CSV — works on any cloud IP."""
    import requests as _req
    from datetime import date, timedelta
    for i in range(1, 7):
        d = (date.today() - timedelta(days=i)).strftime("%d%m%Y")
        url = f"https://archives.nseindia.com/content/indices/ind_close_all_{d}.csv"
        try:
            r = _req.get(url, timeout=10,
                         headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code != 200:
                continue
            lines = r.text.strip().split("\n")
            rows = {}
            for line in lines[1:]:
                parts = line.split(",")
                if len(parts) >= 3:
                    name = parts[0].strip().strip('"')
                    try:
                        close = float(parts[1].strip())
                        prev  = float(parts[2].strip())
                        rows[name] = (close, prev)
                    except Exception:
                        pass
            if rows:
                return rows
        except Exception:
            continue
    return {}


@router.get("/api/market")
def get_market_data():
    """Fetch current price + day change for key Indian market indices."""
    result = {}

    # Primary: NSE index CSV archive (no IP blocking)
    idx_csv = _fetch_nse_index_csv()

    INDEX_MAP = {
        "Nifty 50":  ("NIFTY 50",  "^NSEI"),
        "Sensex":    ("SENSEX",    "^BSESN"),
        "Nifty 200": ("NIFTY 200", "^CNX200"),
    }

    for name, (nse_key, yf_symbol) in INDEX_MAP.items():
        if nse_key in idx_csv:
            curr, prev = idx_csv[nse_key]
            pct = round((curr - prev) / prev * 100, 2) if prev > 0 else 0.0
            result[name] = {"price": round(curr, 2), "change_pct": pct}
        else:
            # Fallback: nsepython
            try:
                from nsepython import nse_get_index_quote
                d = nse_get_index_quote(nse_key)
                curr = float(d.get("last", 0) or 0)
                prev = float(d.get("previousClose", curr) or curr)
                if curr > 0:
                    result[name] = {"price": round(curr, 2),
                                    "change_pct": round((curr - prev)/prev*100, 2) if prev else 0.0}
                    continue
            except Exception:
                pass
            result[name] = {"price": 0.0, "change_pct": 0.0}

    return result
