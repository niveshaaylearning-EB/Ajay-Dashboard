"""Upcoming-results calendar: cross-references portfolio holdings against NSE
board-meeting/corporate-action feeds and yfinance earnings calendars.

_refresh_results_calendar_data() is also called by main.py's startup
background thread (daily refresh), so it's imported back from there.
"""
import asyncio
import json
import os
import re
import time as _time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import database
from auth import is_admin_email
from main import get_db, _io_pool, yf
from routers.actual_portfolio_bridge import _fetch_all_webportal_baskets

router = APIRouter()

def _classify_corporate_action(subject: str) -> str:
    """Buckets an NSE corporate-action 'subject' free-text string into a
    human label for display/email -- e.g. 'Dividend - Rs 13 Per Share' -> 'Dividend'."""
    s = subject.lower()
    if 'dividend' in s:
        return 'Dividend'
    if 'bonus' in s:
        return 'Bonus'
    if 'split' in s or 'sub-division' in s or 'sub division' in s:
        return 'Stock Split'
    if 'rights' in s:
        return 'Rights Issue'
    if 'buyback' in s or 'buy back' in s:
        return 'Buyback'
    if 'demerger' in s:
        return 'Demerger'
    if 'amalgamation' in s or 'scheme' in s or 'merger' in s:
        return 'Merger/Scheme'
    return 'Corporate Action'

# BasketHistory.basket_id (the main app's own "Actual Portfolio" holdings
# tracking) uses an older/abbreviated name for a few baskets that doesn't
# match what the webportal side calls the exact same basket -- confirmed by
# querying BasketHistory's distinct basket_id values directly (only these 3
# actually differ; everything else already matches). Without normalizing,
# a stock held in both systems' records of one basket shows up as if it were
# in two different portfolios (e.g. "Tech Stack, Techstack").
_LEGACY_BASKET_NAME_ALIASES = {
    "Tech Stack":  "Techstack",
    "Trends Trio": "Trends Triology",
    "Mid & Small": "Mid & Small Cap",
}

def _normalize_basket_name(name: str) -> str:
    return _LEGACY_BASKET_NAME_ALIASES.get(name, name)

_RESULTS_CACHE_FILE = os.path.join(os.path.dirname(__file__), '..', 'results_calendar_cache.json')
_RESULTS_TTL = 12 * 3600      # 12 hours -- normal cache lifetime for a successful fetch
_RESULTS_RETRY_TTL = 15 * 60  # 15 minutes -- short-lived cache when a source errored, so a
                              # transient NSE rate-limit/block self-heals quickly instead of
                              # leaving an empty result cached for the full 12h window

def _load_results_cache() -> dict:
    try:
        if os.path.exists(_RESULTS_CACHE_FILE):
            with open(_RESULTS_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        print(f"[cache] Could not load results_calendar_cache.json: {e}")
    return {}

def _save_results_cache(cache: dict):
    try:
        with open(_RESULTS_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
    except Exception as e:
        print(f"[cache] Could not save results_calendar_cache.json: {e}")

_results_cache: dict = _load_results_cache()

async def _refresh_results_calendar_data(db: Session) -> list:
    from datetime import date
    now = _time.time()
    today_str = date.today().isoformat()

    # Fetch active hidden stocks to exclude them
    hidden_objs = db.query(database.HiddenStock).all()
    hidden_set = set()
    for hs in hidden_objs:
        if hs.hidden_reason == 'sold':
            hidden_set.add((hs.basket_id, hs.stock_code.strip().upper()))
        elif hs.hidden_reason == 'deleted':
            if hs.expires_at and hs.expires_at >= today_str:
                hidden_set.add((hs.basket_id, hs.stock_code.strip().upper()))

    holdings = db.query(database.BasketHistory).filter(database.BasketHistory.stock_code != None).all()
    if not holdings:
        _results_cache["calendar"] = {
            "time": now,
            "data": []
        }
        _save_results_cache(_results_cache)
        return []

    stocks_map = {}
    for h in holdings:
        code = h.stock_code.strip().upper()
        if not code:
            continue
        # Skip if hidden/deleted/sold
        if (h.basket_id, code) in hidden_set:
            continue
        basket_name = _normalize_basket_name(re.sub(r'^NIA\s*', '', h.basket_id).strip())
        if code not in stocks_map:
            stocks_map[code] = {
                "name": h.stock_name or code,
                "baskets": {basket_name}
            }
        else:
            stocks_map[code]["baskets"].add(basket_name)

    # Supplement with stocks from actual portfolio (webportal) — falls back silently
    try:
        for key, basket_obj in _fetch_all_webportal_baskets().items():
            basket_label = basket_obj.get("name", key)
            for h in basket_obj.get("holdings", []):
                code = (h.get("code") or "").strip().upper()
                if not code:
                    continue
                if code not in stocks_map:
                    stocks_map[code] = {
                        "name": h.get("stock_name") or code,
                        "baskets": {basket_label}
                    }
                else:
                    stocks_map[code]["baskets"].add(basket_label)
    except Exception:
        pass

    unique_codes = set(stocks_map.keys())

    upcoming_events = []
    seen_events = set()  # (code, date) dedup
    any_source_failed = False  # tracks transient errors so we don't cache a bad empty result for 12h

    # ── Source 1: NSE board meetings (nse_events) — real announced dates ──────
    try:
        from nsepython import nse_events
        events_df = await asyncio.get_running_loop().run_in_executor(_io_pool, nse_events)
        if events_df is not None and not events_df.empty:
            results_df = events_df[
                events_df['purpose'].str.contains('result|financial', case=False, na=False)
            ]
            for _, row in results_df.iterrows():
                code = str(row.get('symbol', '')).strip().upper()
                if code not in unique_codes:
                    continue
                raw_date = str(row.get('date', '')).strip()
                try:
                    date_obj = datetime.strptime(raw_date, '%d-%b-%Y')
                except Exception:
                    try:
                        date_obj = datetime.strptime(raw_date, '%d-%m-%Y')
                    except Exception:
                        continue
                date_str = date_obj.strftime('%Y-%m-%d')
                if date_str < today_str:
                    continue
                key = (code, date_str)
                if key in seen_events:
                    continue
                seen_events.add(key)
                info = stocks_map[code]
                upcoming_events.append({
                    "stock_code": code,
                    "stock_name": info["name"],
                    "baskets": sorted(list(info["baskets"])),
                    "date": date_str,
                    "purpose": str(row.get('purpose', 'Financial Results')),
                    "type": "result",
                })
    except Exception as nse_err:
        print(f"[Results Calendar] NSE events fetch error: {nse_err}")
        any_source_failed = True

    # ── Source 1b: NSE corporate actions via direct HTTP (if nsepython geo-blocked) ──
    if not upcoming_events:
        try:
            import httpx as _hx, urllib.parse as _up
            from datetime import date as _date, timedelta as _td
            _today = _date.today()
            _to    = (_today + _td(days=90)).strftime("%d-%m-%Y")
            _from  = _today.strftime("%d-%m-%Y")
            _hdrs  = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                      "Referer": "https://www.nseindia.com/", "Accept": "*/*"}
            async with _hx.AsyncClient(headers=_hdrs, timeout=10, follow_redirects=True) as _c:
                await _c.get("https://www.nseindia.com/")
                _r = await _c.get(
                    f"https://www.nseindia.com/api/corporates-corporateActions"
                    f"?index=equities&from_date={_from}&to_date={_to}&type=boardMeeting"
                )
            if _r.status_code != 200:
                any_source_failed = True
            else:
                for item in _r.json():
                    code = str(item.get("symbol","")).strip().upper()
                    if code not in unique_codes:
                        continue
                    subj = str(item.get("subject","")).lower()
                    if "result" not in subj and "quarterly" not in subj and "financial" not in subj:
                        continue
                    raw = str(item.get("exDate","") or item.get("bm_date","")).strip()
                    try:
                        ds = datetime.strptime(raw, "%d-%b-%Y").strftime("%Y-%m-%d")
                    except Exception:
                        continue
                    if ds < today_str or (code, ds) in seen_events:
                        continue
                    seen_events.add((code, ds))
                    upcoming_events.append({"stock_code": code, "stock_name": stocks_map[code]["name"],
                                            "baskets": sorted(list(stocks_map[code]["baskets"])),
                                            "date": ds, "purpose": "Financial Results", "type": "result"})
        except Exception as _e:
            print(f"[Results Calendar] NSE direct fetch error: {_e}")
            any_source_failed = True

    # ── Source 2: yfinance calendar — covers large caps NSE may not list yet ──
    remaining_codes = [c for c in unique_codes if not any(e['stock_code'] == c for e in upcoming_events)]

    def _fetch_earnings_yf(code):
        try:
            tk = yf.Ticker(f"{code}.NS" if not code.endswith('.NS') else code)
            cal = tk.calendar
            if cal and 'Earnings Date' in cal:
                dates = cal['Earnings Date']
                if isinstance(dates, list) and dates:
                    iso_dates = []
                    for d in dates:
                        if hasattr(d, 'isoformat'):
                            iso_dates.append(d.isoformat()[:10])
                        elif hasattr(d, 'strftime'):
                            iso_dates.append(d.strftime('%Y-%m-%d'))
                        else:
                            iso_dates.append(str(d)[:10])
                    return code, iso_dates
        except Exception:
            pass
        return code, None

    loop = asyncio.get_running_loop()
    yf_tasks = [loop.run_in_executor(_io_pool, _fetch_earnings_yf, code) for code in remaining_codes]
    yf_results = await asyncio.gather(*yf_tasks)

    for code, dates in yf_results:
        if not dates:
            continue
        info = stocks_map[code]
        for date_str in dates:
            if date_str < today_str:
                continue
            key = (code, date_str)
            if key in seen_events:
                continue
            seen_events.add(key)
            upcoming_events.append({
                "stock_code": code,
                "stock_name": info["name"],
                "baskets": sorted(list(info["baskets"])),
                "date": date_str,
                "purpose": "Financial Results",
                "type": "result",
            })

    # ── Source 3: NSE corporate actions (dividend/bonus/split/rights/buyback/
    # demerger/etc.) — additive, not a fallback, so it always runs regardless
    # of whether Sources 1/1b/2 found any results. Same 90-day forward window.
    try:
        import httpx as _hx
        from datetime import date as _date, timedelta as _td
        _today = _date.today()
        _to    = (_today + _td(days=90)).strftime("%d-%m-%Y")
        _from  = _today.strftime("%d-%m-%Y")
        _hdrs  = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                  "Referer": "https://www.nseindia.com/", "Accept": "*/*"}
        seen_ca_events = set()  # (code, date, subject) dedup -- a stock can have >1 action on/near the same date
        async with _hx.AsyncClient(headers=_hdrs, timeout=10, follow_redirects=True) as _c:
            await _c.get("https://www.nseindia.com/")
            _ca_r = await _c.get(
                f"https://www.nseindia.com/api/corporates-corporateActions"
                f"?index=equities&from_date={_from}&to_date={_to}"
            )
        if _ca_r.status_code != 200:
            any_source_failed = True
        else:
            for item in _ca_r.json():
                code = str(item.get("symbol", "")).strip().upper()
                if code not in unique_codes:
                    continue
                subject = str(item.get("subject", "")).strip()
                raw = str(item.get("exDate", "")).strip()
                try:
                    ds = datetime.strptime(raw, "%d-%b-%Y").strftime("%Y-%m-%d")
                except Exception:
                    continue
                if ds < today_str:
                    continue
                ca_key = (code, ds, subject)
                if ca_key in seen_ca_events:
                    continue
                seen_ca_events.add(ca_key)
                info = stocks_map[code]
                upcoming_events.append({
                    "stock_code": code,
                    "stock_name": info["name"],
                    "baskets": sorted(list(info["baskets"])),
                    "date": ds,
                    "purpose": subject,
                    "type": "corporate_action",
                    "action_category": _classify_corporate_action(subject),
                })
    except Exception as _ca_err:
        print(f"[Results Calendar] NSE corporate-actions fetch error: {_ca_err}")
        any_source_failed = True

    upcoming_events.sort(key=lambda x: x["date"])

    _results_cache["calendar"] = {
        "time": now,
        "data": upcoming_events,
        "reliable": not any_source_failed,
    }
    _save_results_cache(_results_cache)

    return upcoming_events

@router.get("/api/portfolio/results-calendar")
async def get_results_calendar(db: Session = Depends(get_db)):
    from datetime import date
    now = _time.time()
    cached = _results_cache.get("calendar")
    today_str = date.today().isoformat()

    # If the last refresh had a source error (e.g. NSE rate-limiting), don't trust
    # the full 12h TTL -- retry much sooner so a transient failure self-heals
    # instead of leaving a possibly-empty/incomplete result cached all day.
    effective_ttl = _RESULTS_TTL if (cached and cached.get("reliable", True)) else _RESULTS_RETRY_TTL

    if cached and (now - cached['time']) < effective_ttl:
        holdings = db.query(database.BasketHistory).filter(database.BasketHistory.stock_code != None).all()
        hidden_objs = db.query(database.HiddenStock).all()

        # Build active set and hidden set
        active_set = set()
        hidden_set = set()
        for hs in hidden_objs:
            if hs.hidden_reason == 'sold':
                hidden_set.add((hs.basket_id, hs.stock_code.strip().upper()))
            elif hs.hidden_reason == 'deleted':
                if hs.expires_at and hs.expires_at >= today_str:
                    hidden_set.add((hs.basket_id, hs.stock_code.strip().upper()))

        for h in holdings:
            code = h.stock_code.strip().upper()
            if not code:
                continue
            basket_name = _normalize_basket_name(re.sub(r'^NIA\s*', '', h.basket_id).strip())
            if (h.basket_id, code) not in hidden_set:
                active_set.add((basket_name, code))

        # Webportal-only baskets never appear in BasketHistory above, so
        # without this their events would be filtered out entirely here
        # even though _refresh_results_calendar_data() included them.
        try:
            for _key, _basket_obj in _fetch_all_webportal_baskets().items():
                _label = _basket_obj.get("name", _key)
                for _h in _basket_obj.get("holdings", []):
                    _code = (_h.get("code") or "").strip().upper()
                    if _code:
                        active_set.add((_label, _code))
        except Exception:
            pass

        upcoming = []
        for e in cached['data']:
            if e['date'] < today_str:
                continue
            active_baskets = []
            for b in e['baskets']:
                if (b, e['stock_code']) in active_set:
                    active_baskets.append(b)
            if active_baskets:
                event_copy = e.copy()
                event_copy['baskets'] = active_baskets
                upcoming.append(event_copy)

        return upcoming

    return await _refresh_results_calendar_data(db)


# ── Analyst contacts (per basket) — receive the 1-day-before reminder ────────

class AnalystContactCreate(BaseModel):
    basket_name: str
    name: str
    email: str

@router.get("/api/results-calendar/analyst-contacts")
def list_analyst_contacts(db: Session = Depends(get_db)):
    rows = db.query(database.BasketAnalystContact).order_by(database.BasketAnalystContact.basket_name).all()
    return [{"id": r.id, "basket_name": r.basket_name, "name": r.name, "email": r.email} for r in rows]

@router.post("/api/results-calendar/analyst-contacts")
def add_analyst_contact(body: AnalystContactCreate, request: Request, db: Session = Depends(get_db)):
    user = getattr(request.state, "user", None)
    if not is_admin_email(user):
        raise HTTPException(status_code=403, detail="Admin access required.")

    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="A valid email is required.")
    basket_name = body.basket_name.strip()
    if not basket_name:
        raise HTTPException(status_code=422, detail="Basket is required.")

    existing = db.query(database.BasketAnalystContact).filter_by(basket_name=basket_name, email=email).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"{email} is already assigned to {basket_name}.")

    row = database.BasketAnalystContact(
        basket_name=basket_name, name=body.name.strip() or email, email=email,
        added_by=user, added_at=datetime.now().isoformat(),
    )
    db.add(row)
    db.commit()
    return {"id": row.id, "basket_name": row.basket_name, "name": row.name, "email": row.email}

@router.delete("/api/results-calendar/analyst-contacts/{contact_id}")
def delete_analyst_contact(contact_id: int, request: Request, db: Session = Depends(get_db)):
    user = getattr(request.state, "user", None)
    if not is_admin_email(user):
        raise HTTPException(status_code=403, detail="Admin access required.")
    db.query(database.BasketAnalystContact).filter_by(id=contact_id).delete()
    db.commit()
    return {"status": "success"}


# ── 1-day-before reminder: email Monika + each event's assigned basket ───────
# analyst(s). Mirrors webportal/backend/watchlist.py's
# check_and_notify_watchlist_triggers() -- a per-event dedup flag on disk so
# each (stock, date, purpose) only ever sends once, regardless of how often
# the background thread runs.

_NOTIFIED_FILE = os.path.join(os.path.dirname(__file__), '..', 'results_calendar_notified.json')
_ALWAYS_NOTIFY = ("monika.bansal@niveshaay.com", "nukul.madaan@niveshaay.com")


def _calendar_links(title: str, date_str: str, description: str) -> tuple[str, str]:
    """Google Calendar + Outlook 'add event' deep links for a single all-day
    event on `date_str` (YYYY-MM-DD). No API/auth needed on either side --
    these just pre-fill each provider's own web "create event" form, which
    the recipient still has to hit save on themselves."""
    import urllib.parse as _urlparse
    from datetime import datetime as _dt, timedelta as _td

    day = _dt.strptime(date_str, "%Y-%m-%d").date()
    next_day = day + _td(days=1)  # Google's all-day `dates` end is exclusive

    google_url = "https://calendar.google.com/calendar/render?" + _urlparse.urlencode({
        "action": "TEMPLATE",
        "text": title,
        "dates": f"{day.strftime('%Y%m%d')}/{next_day.strftime('%Y%m%d')}",
        "details": description,
    })
    outlook_url = "https://outlook.live.com/calendar/0/deeplink/compose?" + _urlparse.urlencode({
        "path": "/calendar/action/compose", "rru": "addevent",
        "subject": title, "body": description,
        "startdt": day.isoformat(), "enddt": next_day.isoformat(), "allday": "true",
    })
    return google_url, outlook_url

def _load_notified() -> dict:
    try:
        if os.path.exists(_NOTIFIED_FILE):
            with open(_NOTIFIED_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        print(f"[Results Calendar] Could not load notified-state: {e}")
    return {}

def _save_notified(data: dict) -> None:
    try:
        with open(_NOTIFIED_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    except Exception as e:
        print(f"[Results Calendar] Could not save notified-state: {e}")

def check_and_notify_upcoming_events(db: Session) -> None:
    from datetime import date, timedelta
    from auth import _send_email, _log_audit

    cached = _results_cache.get("calendar") or {}
    events = cached.get("data") or []
    tomorrow_str = (date.today() + timedelta(days=1)).isoformat()
    due = [e for e in events if e["date"] == tomorrow_str]
    if not due:
        return

    notified = _load_notified()
    contacts_by_basket: dict = {}
    for c in db.query(database.BasketAnalystContact).all():
        contacts_by_basket.setdefault(c.basket_name, []).append(c.email)

    changed = False
    for e in due:
        key = f"{e['stock_code']}|{e['date']}|{e.get('purpose', '')}"
        if notified.get(key):
            continue

        recipients = set(_ALWAYS_NOTIFY)
        for b in e["baskets"]:
            recipients.update(contacts_by_basket.get(b, []))

        label = e.get("purpose") or ("Financial Results" if e.get("type") == "result" else "Corporate action")
        subject = f"[Reminder] {e['stock_code']} -- {label} tomorrow ({e['date']})"
        description = f"{e['stock_name']} ({e['stock_code']}) -- {label}. Held in: {', '.join(e['baskets'])}."
        google_url, outlook_url = _calendar_links(f"{e['stock_code']} -- {label}", e['date'], description)
        body = (
            f"{e['stock_name']} ({e['stock_code']}) -- held in: {', '.join(e['baskets'])}\n\n"
            f"{label}\nDate: {e['date']} (tomorrow)\n\n"
            f"Add to your calendar:\n"
            f"Google Calendar: {google_url}\n"
            f"Outlook Calendar: {outlook_url}\n\n"
            f"Open the Result Calendar in the dashboard for details."
        )
        reminder_note = f"{e['stock_code']} -- {label} reminder for {e['date']}"
        for to in recipients:
            try:
                _send_email(to, subject, body)
                _log_audit(to, "results_calendar_reminder_sent", reminder_note)
            except Exception as err:
                print(f"[Results Calendar] reminder email to {to} failed: {err}")
                _log_audit(to, "results_calendar_reminder_failed", f"{reminder_note}: {err}")

        notified[key] = True
        changed = True

    if changed:
        _save_notified(notified)
