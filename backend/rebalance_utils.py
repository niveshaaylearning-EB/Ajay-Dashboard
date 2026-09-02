"""
Shared logic for parsing Excel rebalance files and importing into the DB.
Used by both import_rebalances.py (CLI script) and main.py (upload endpoint).
"""
import re
from datetime import datetime, date, timedelta
from collections import defaultdict

import requests
import openpyxl
import yfinance as yf
import pandas as pd

from database import BasketHistory, SoldStock, StockEvent


class _YFTimeoutSession(requests.Session):
    def request(self, *args, **kwargs):
        kwargs.setdefault('timeout', 12)
        return super().request(*args, **kwargs)

_yf_session = _YFTimeoutSession()

# ---- Constants --------------------------------------------------------------

SHEET_MAP = {
    'Mid & Small All Rebalances till':  'NIA Mid & Small',
    'Green Energy All Rebalances til':  'NIA Green Energy',
    'TechStack All Rebalances till D':  'NIA Tech Stack',
    'Trends Triology All Rebalances ':  'NIA Trends Trio',
    'Consumer Trend All Rebalances t':  'NIA Consumer Trends',
    'Make in India - All Rebalances ':  'NIA Make in India',
    'IPO All Rebalances till Date':     'NIA IPO Basket',
}

CASH_CODES = {
    'LIQUIDBEES', 'LIQUIDCASE', 'LIQUIDETF', 'NIFTYBEES',
    'JUNIORBEES', 'LIQUIDIETF',
}

_price_cache: dict = {}


# ---- Price fetcher ----------------------------------------------------------

def get_avg_price(nse_code: str, on_date: str) -> float:
    """(High+Low+Close)/3 on or just before on_date. Returns 0.0 on failure."""
    key = f"{nse_code}|{on_date}"
    if key in _price_cache:
        return _price_cache[key]

    ticker = f"{nse_code}.NS"
    try:
        dt    = datetime.strptime(on_date, "%Y-%m-%d")
        start = (dt - timedelta(days=5)).strftime("%Y-%m-%d")
        end   = (dt + timedelta(days=5)).strftime("%Y-%m-%d")
        data  = yf.download(ticker, start=start, end=end,
                            progress=False, auto_adjust=True, session=_yf_session)
        if data.empty:
            _price_cache[key] = 0.0
            return 0.0

        if isinstance(data.columns, pd.MultiIndex):
            data.columns = data.columns.get_level_values(0)

        idx = data.index
        if hasattr(idx, 'tz') and idx.tz is not None:
            idx = idx.tz_localize(None)
        cutoff = pd.to_datetime(dt)
        before = data[idx <= cutoff]
        row    = before.iloc[-1] if not before.empty else data.iloc[0]

        def _s(col):
            v = row.get(col, 0.0)
            if hasattr(v, 'iloc'):
                v = v.iloc[0]
            try:
                return float(v)
            except (TypeError, ValueError):
                return 0.0

        hi, lo, cl = _s('High'), _s('Low'), _s('Close')
        price = round((hi + lo + cl) / 3, 2) if (hi + lo + cl) > 0 else 0.0
        _price_cache[key] = price
        return price
    except Exception:
        _price_cache[key] = 0.0
        return 0.0


# ---- Excel parser -----------------------------------------------------------

def parse_excel(excel_path: str) -> dict:
    """
    Parse every mapped sheet in the Excel file.
    Returns {basket_name: {rebalance_dates, by_date, inception_date}}.
    """
    wb = openpyxl.load_workbook(excel_path, read_only=True, data_only=True)
    result = {}

    for excel_sheet, basket_name in SHEET_MAP.items():
        if excel_sheet not in wb.sheetnames:
            continue

        ws   = wb[excel_sheet]
        rows = list(ws.rows)
        if len(rows) < 2:
            continue

        by_date: dict[str, list] = defaultdict(list)

        for row in rows[1:]:
            cells = [c.value for c in row]
            if len(cells) < 6:
                continue
            _src, rebal_date, nse_code, sec_name, segment, weight = cells[:6]

            if not rebal_date or not nse_code:
                continue

            if isinstance(rebal_date, datetime):
                date_str = rebal_date.strftime("%Y-%m-%d")
            else:
                try:
                    date_str = str(rebal_date)[:10]
                    datetime.strptime(date_str, "%Y-%m-%d")
                except ValueError:
                    continue

            code = re.sub(r'\s+', '', str(nse_code).strip().upper())
            if not code or code.lower() == 'nan':
                continue
            if code in CASH_CODES:
                continue

            try:
                w = float(str(weight).strip())
            except (ValueError, TypeError):
                w = 0.0

            by_date[date_str].append((
                code,
                str(sec_name).strip() if sec_name else code,
                str(segment).strip()  if segment  else '',
                w,
            ))

        # Cash-code tickers (incl. LIQUIDCASE) are stripped above, so if a
        # rebalance date's remaining holdings don't sum to 100%, park the
        # unallocated remainder in LIQUIDCASE rather than leaving it untracked.
        for date_str, rows_for_date in by_date.items():
            total_weight = sum(w for _, _, _, w in rows_for_date)
            residual = 100.0 - total_weight
            if residual > 0.01:
                rows_for_date.append(('LIQUIDCASE', 'Liquid Cash', 'Cash', round(residual, 4)))

        rebalance_dates = sorted(by_date.keys())
        result[basket_name] = {
            'rebalance_dates': rebalance_dates,
            'by_date': dict(by_date),
            'inception_date': rebalance_dates[0] if rebalance_dates else None,
        }

    wb.close()
    return result


# ---- DB importer ------------------------------------------------------------

def import_basket(db, basket_name: str, data: dict,
                  log=print) -> dict:
    """
    Import one basket's rebalance data into the DB.
    Returns {active_count, archived_count}.
    """
    rebalance_dates = data['rebalance_dates']
    by_date         = data['by_date']
    today_str       = str(date.today())

    if not rebalance_dates:
        return {'active': 0, 'archived': 0}

    latest_date  = rebalance_dates[-1]
    latest_codes = {row[0] for row in by_date[latest_date]}

    # Build first-seen lookup (code → (earliest_date, name, sector))
    first_seen: dict[str, tuple] = {}
    for d in rebalance_dates:
        for code, name, sector, _ in by_date[d]:
            if code not in first_seen:
                first_seen[code] = (d, name, sector)

    # ---- Current holdings ---------------------------------------------------
    for code, name, sector, weight in by_date[latest_date]:
        buy_date, _, _ = first_seen[code]
        log(f"  {code}: fetching price on {buy_date}...")
        buy_price = get_avg_price(code, buy_date)

        existing = db.query(BasketHistory).filter_by(
            basket_id=basket_name, stock_code=code
        ).first()

        if existing:
            old_alloc = existing.allocation or 0.0
            if abs(weight - old_alloc) >= 0.01:
                db.add(StockEvent(
                    basket_id   = basket_name,
                    stock_code  = code,
                    event_type  = 'allocation_changed',
                    description = (f"Allocation updated from {old_alloc:.2f}% "
                                   f"to {weight:.2f}% via rebalance upload"),
                    old_value   = f"{old_alloc:.2f}",
                    new_value   = f"{weight:.2f}",
                    event_date  = today_str,
                ))
            existing.allocation     = weight
            existing.last_seen_date = today_str
            # Excel is authoritative: always set first_seen_date from Excel data.
            # The sheet sync fallback writes today's date when the sheet has no buy date,
            # which is wrong. Override it with the real first-appearance date from Excel.
            existing.first_seen_date = buy_date
            if not existing.buy_price or existing.buy_price == 0:
                existing.buy_price = buy_price if buy_price > 0 else None
            if name:
                existing.stock_name = name
            if sector:
                existing.sector     = sector
        else:
            db.add(BasketHistory(
                basket_id       = basket_name,
                stock_code      = code,
                last_cmp        = buy_price,
                last_seen_date  = today_str,
                first_seen_date = buy_date,
                buy_price       = buy_price if buy_price > 0 else None,
                allocation      = weight,
                stock_name      = name,
                sector          = sector,
            ))
            db.add(StockEvent(
                basket_id   = basket_name,
                stock_code  = code,
                event_type  = 'added',
                description = f"Added via rebalance upload (first seen {buy_date})",
                old_value   = None,
                new_value   = f"alloc={weight:.2f}%, buy_px={buy_price:.2f}",
                event_date  = today_str,
            ))

    # ---- Sell/archive removed stocks ----------------------------------------
    all_codes    = set(first_seen.keys())
    sold_codes   = all_codes - latest_codes

    for code in sold_codes:
        buy_date, name, sector = first_seen[code]

        # Find last rebalance this code appeared in
        last_rebal  = None
        last_weight = 0.0
        for d in reversed(rebalance_dates):
            for c, _n, _s, w in by_date[d]:
                if c == code:
                    last_rebal = d
                    last_weight = w
                    break
            if last_rebal:
                break

        # Remove from active holdings if present
        active = db.query(BasketHistory).filter_by(
            basket_id=basket_name, stock_code=code
        ).first()
        if active:
            db.delete(active)

        sell_date_str = last_rebal or today_str
        existing_sold = db.query(SoldStock).filter_by(
            basket_id=basket_name, stock_code=code
        ).first()

        if existing_sold:
            # Update any missing prices / weight on re-import
            if not existing_sold.buy_price or existing_sold.buy_price == 0:
                log(f"  {code}: fetching buy price on {buy_date}...")
                bp = get_avg_price(code, buy_date)
                existing_sold.buy_price = bp if bp > 0 else None
            if not existing_sold.sell_price or existing_sold.sell_price == 0:
                log(f"  {code}: fetching sell price on {sell_date_str}...")
                sp = get_avg_price(code, sell_date_str)
                existing_sold.sell_price = sp if sp > 0 else None
            if not existing_sold.weight:
                existing_sold.weight = last_weight
        else:
            log(f"  {code}: fetching buy price on {buy_date}...")
            bp = get_avg_price(code, buy_date)
            log(f"  {code}: fetching sell price on {sell_date_str}...")
            sp = get_avg_price(code, sell_date_str)
            db.add(SoldStock(
                basket_id  = basket_name,
                stock_code = code,
                buy_price  = bp if bp > 0 else None,
                sell_price = sp if sp > 0 else None,
                sell_date  = sell_date_str,
                buy_date   = buy_date,
                sector     = sector,
                stock_name = name,
                weight     = last_weight,
            ))
            db.add(StockEvent(
                basket_id   = basket_name,
                stock_code  = code,
                event_type  = 'sold',
                description = (f"Removed in rebalance "
                               f"(last seen {last_rebal}, weight {last_weight:.1f}%)"),
                old_value   = None,
                new_value   = last_rebal or today_str,
                event_date  = last_rebal or today_str,
            ))

    db.commit()
    return {'active': len(latest_codes), 'archived': len(sold_codes)}
