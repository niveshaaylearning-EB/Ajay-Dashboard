"""Portfolio holdings CRUD (DB-backed, sheet-independent) -- add/edit/sell/delete
stocks, event history, and the yfinance metrics-cache refresh trigger.

_resolve_basket() is used by several other routers too (notes/targets/snapshots)
since basket-slug resolution is needed anywhere a basket_id path param appears.
"""
import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import database
import sheet_service
from database import StockEvent
from main import get_db

router = APIRouter()

class HoldingUpsert(BaseModel):
    stock_code: str
    allocation: Optional[float] = None
    buy_price: Optional[float] = None
    buy_date: Optional[str] = None      # YYYY-MM-DD
    stock_name: Optional[str] = None
    sector: Optional[str] = None

@router.get("/api/portfolio/{basket_id}/holdings")
def list_portfolio_holdings(basket_id: str, db: Session = Depends(get_db)):
    """List all holdings stored in DB for a basket (sheet-independent view)."""
    # Convert slug back to sheet name
    basket_name = next(
        (s for s in sheet_service.BASKET_SHEETS
         if re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') == basket_id),
        None
    )
    if not basket_name:
        raise HTTPException(status_code=404, detail="Basket not found")
    rows = db.query(database.BasketHistory).filter_by(basket_id=basket_name).all()
    return [
        {
            "stock_code":    r.stock_code,
            "stock_name":    r.stock_name or r.stock_code,
            "sector":        r.sector or "",
            "allocation":    r.allocation or 0.0,
            "buy_price":     r.buy_price or 0.0,
            "last_cmp":      r.last_cmp or 0.0,
            "buy_date":      r.first_seen_date or "",
            "last_seen":     r.last_seen_date or "",
        }
        for r in rows
    ]

@router.post("/api/portfolio/{basket_id}/holdings")
def upsert_portfolio_holding(basket_id: str, item: HoldingUpsert, request: Request, db: Session = Depends(get_db)):
    """
    Create or update a holding in the DB.
    Use this to manually manage the portfolio after removing the Google Sheet.
    """
    basket_name = next(
        (s for s in sheet_service.BASKET_SHEETS
         if re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') == basket_id),
        None
    )
    if not basket_name:
        raise HTTPException(status_code=404, detail="Basket not found")

    code       = re.sub(r'\s+', '', item.stock_code.upper())
    today_str  = datetime.now().strftime("%Y-%m-%d")
    user_email = getattr(request.state, "user", "unknown")

    row = db.query(database.BasketHistory).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()

    if row:
        if item.allocation is not None and row.allocation is not None:
            if abs(item.allocation - row.allocation) >= 0.01:
                db.add(StockEvent(
                    basket_id   = basket_name,
                    stock_code  = code,
                    event_type  = 'allocation_changed',
                    description = f"Allocation changed from {row.allocation:.2f}% to {item.allocation:.2f}% via dashboard",
                    old_value   = f"{row.allocation:.2f}",
                    new_value   = f"{item.allocation:.2f}",
                    event_date  = today_str,
                    user_email  = user_email,
                ))
        if item.buy_price is not None and row.buy_price is not None:
            if abs(item.buy_price - row.buy_price) >= 0.01:
                db.add(StockEvent(
                    basket_id   = basket_name,
                    stock_code  = code,
                    event_type  = 'price_changed',
                    description = f"Buy price updated from Rs.{row.buy_price:.2f} to Rs.{item.buy_price:.2f} via dashboard",
                    old_value   = f"{row.buy_price:.2f}",
                    new_value   = f"{item.buy_price:.2f}",
                    event_date  = today_str,
                    user_email  = user_email,
                ))
        if item.allocation is not None:
            row.allocation = item.allocation
        if item.buy_price is not None:
            row.buy_price = item.buy_price
        if item.buy_date:
            row.first_seen_date = item.buy_date
        if item.stock_name:
            row.stock_name = item.stock_name
        if item.sector:
            row.sector = item.sector
        row.last_seen_date = today_str
    else:
        cmp_val = sheet_service.get_live_cmp(code)
        row = database.BasketHistory(
            basket_id       = basket_name,
            stock_code      = code,
            last_cmp        = cmp_val,
            last_seen_date  = today_str,
            first_seen_date = item.buy_date or today_str,
            buy_price       = item.buy_price,
            allocation      = item.allocation,
            stock_name      = item.stock_name or code,
            sector          = item.sector or "",
        )
        db.add(row)
        db.add(StockEvent(
            basket_id   = basket_name,
            stock_code  = code,
            event_type  = 'added',
            description = f"Stock added via dashboard" + (f" with {item.allocation:.2f}% allocation" if item.allocation else "") + (f" at Rs.{item.buy_price:.2f}" if item.buy_price else ""),
            old_value   = None,
            new_value   = f"alloc={item.allocation or 0:.2f}%, buy_px={item.buy_price or 0:.2f}",
            event_date  = today_str,
            user_email  = user_email,
        ))

    sheet_service._cache.pop(basket_name, None)
    db.commit()
    return {"status": "success", "stock_code": code}

@router.delete("/api/portfolio/{basket_id}/holdings/{stock_code}")
def delete_portfolio_holding(basket_id: str, stock_code: str, db: Session = Depends(get_db)):
    """
    Remove a holding from the DB (equivalent to deleting it from the sheet).
    Also archives it in sold_stocks with sell_date = today.
    """
    basket_name = next(
        (s for s in sheet_service.BASKET_SHEETS
         if re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') == basket_id),
        None
    )
    if not basket_name:
        raise HTTPException(status_code=404, detail="Basket not found")

    code = re.sub(r'\s+', '', stock_code.upper())
    row = db.query(database.BasketHistory).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Holding not found")

    today_str = datetime.now().strftime("%Y-%m-%d")
    sell_cmp  = sheet_service.get_live_cmp(code) or row.last_cmp or row.buy_price or 0.0
    recorded_buy = row.buy_price if (row.buy_price and row.buy_price > 0) else sell_cmp

    # Archive as sold
    existing_sold = db.query(database.SoldStock).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()
    if not existing_sold:
        db.add(database.SoldStock(
            basket_id  = basket_name,
            stock_code = code,
            buy_price  = recorded_buy,
            sell_price = sell_cmp,
            sell_date  = today_str,
            buy_date   = row.first_seen_date,
            sector     = row.sector or "",
            stock_name = row.stock_name or code,
        ))

    db.delete(row)
    sheet_service._cache.pop(basket_name, None)
    db.commit()
    return {"status": "sold", "stock_code": code}

def _resolve_basket(basket_id: str):
    """Convert a basket slug to its full sheet name, or raise 404."""
    name = next(
        (s for s in sheet_service.BASKET_SHEETS
         if re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') == basket_id),
        None
    )
    if not name:
        raise HTTPException(status_code=404, detail="Basket not found")
    return name


@router.post("/api/portfolio/{basket_id}/sell/{stock_code}")
def sell_stock(basket_id: str, stock_code: str, request: Request, db: Session = Depends(get_db)):
    """
    Sell a stock via the dashboard:
      1. Fetch live CMP as sell price.
      2. Archive to sold_stocks.
      3. Add to hidden_stocks (reason='sold') so it never reappears from the sheet.
      4. Remove from basket_history (it's sold, not missing).
    """
    basket_name = _resolve_basket(basket_id)
    code        = re.sub(r'\s+', '', stock_code.upper())
    today_str   = datetime.now().strftime("%Y-%m-%d")
    user_email  = getattr(request.state, "user", "unknown")

    row = db.query(database.BasketHistory).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()

    sell_cmp     = sheet_service.get_live_cmp(code) or (row.last_cmp if row else 0.0)
    recorded_buy = (row.buy_price if row and row.buy_price and row.buy_price > 0 else sell_cmp) if row else sell_cmp

    existing = db.query(database.SoldStock).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()
    if not existing:
        db.add(database.SoldStock(
            basket_id  = basket_name,
            stock_code = code,
            buy_price  = recorded_buy,
            sell_price = sell_cmp,
            sell_date  = today_str,
            buy_date   = row.first_seen_date if row else None,
            sector     = (row.sector  or "") if row else "",
            stock_name = (row.stock_name or code) if row else code,
        ))
    db.add(StockEvent(
        basket_id   = basket_name,
        stock_code  = code,
        event_type  = 'sold',
        description = f"Stock sold via dashboard at CMP Rs.{sell_cmp:.2f} (buy Rs.{recorded_buy:.2f})",
        old_value   = f"{recorded_buy:.2f}",
        new_value   = f"{sell_cmp:.2f}",
        event_date  = today_str,
        user_email  = user_email,
    ))

    # Hide from dashboard (permanent — no expiry)
    hidden = db.query(database.HiddenStock).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()
    if not hidden:
        db.add(database.HiddenStock(
            basket_id    = basket_name,
            stock_code   = code,
            hidden_reason= 'sold',
            stock_name   = (row.stock_name or code) if row else code,
            buy_price    = recorded_buy,
            last_cmp     = sell_cmp,
            sector       = (row.sector or "") if row else "",
            allocation   = (row.allocation or 0.0) if row else 0.0,
            hidden_at    = today_str,
            expires_at   = None,
        ))
    else:
        hidden.hidden_reason = 'sold'
        hidden.expires_at    = None

    # Remove from active holdings
    if row:
        db.delete(row)

    sheet_service._cache.pop(basket_name, None)
    db.commit()
    return {"status": "sold", "stock_code": code, "sell_price": round(sell_cmp, 2)}


@router.post("/api/portfolio/{basket_id}/dashboard-delete/{stock_code}")
def dashboard_delete_stock(basket_id: str, stock_code: str, request: Request, db: Session = Depends(get_db)):
    """
    Soft-delete a stock from the dashboard (not a sell):
      - Adds to hidden_stocks with reason='deleted' and expires_at = today+7 days.
      - After 7 days the background thread clears it and it reappears from the sheet.
      - Does NOT create a sold_stocks entry.
    """
    basket_name = _resolve_basket(basket_id)
    code        = re.sub(r'\s+', '', stock_code.upper())
    today_str   = datetime.now().strftime("%Y-%m-%d")
    expires_str = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d")
    user_email  = getattr(request.state, "user", "unknown")

    row = db.query(database.BasketHistory).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()

    hidden = db.query(database.HiddenStock).filter_by(
        basket_id=basket_name, stock_code=code
    ).first()
    if hidden:
        hidden.hidden_reason = 'deleted'
        hidden.expires_at    = expires_str
        hidden.hidden_at     = today_str
    else:
        db.add(database.HiddenStock(
            basket_id    = basket_name,
            stock_code   = code,
            hidden_reason= 'deleted',
            stock_name   = (row.stock_name or code) if row else code,
            buy_price    = (row.buy_price  or 0.0)  if row else 0.0,
            last_cmp     = (row.last_cmp   or 0.0)  if row else 0.0,
            sector       = (row.sector     or "")   if row else "",
            allocation   = (row.allocation or 0.0)  if row else 0.0,
            hidden_at    = today_str,
            expires_at   = expires_str,
        ))

    db.add(StockEvent(
        basket_id   = basket_name,
        stock_code  = code,
        event_type  = 'deleted',
        description = f"Stock hidden from dashboard for 7 days (restores {expires_str})",
        old_value   = None,
        new_value   = expires_str,
        event_date  = today_str,
        user_email  = user_email,
    ))
    sheet_service._cache.pop(basket_name, None)
    db.commit()
    return {"status": "deleted", "stock_code": code, "expires_at": expires_str}


@router.get("/api/portfolio/{basket_id}/events/{stock_code}")
def get_stock_events(basket_id: str, stock_code: str, db: Session = Depends(get_db)):
    """Return full event history for a stock in a basket, newest first."""
    basket_name = _resolve_basket(basket_id)
    code = re.sub(r'\s+', '', stock_code.upper())
    rows = (
        db.query(StockEvent)
        .filter(StockEvent.basket_id == basket_name, StockEvent.stock_code == code)
        .order_by(StockEvent.event_date.desc(), StockEvent.id.desc())
        .all()
    )
    return [
        {
            "event_type":  r.event_type,
            "description": r.description,
            "old_value":   r.old_value,
            "new_value":   r.new_value,
            "event_date":  r.event_date,
        }
        for r in rows
    ]


@router.get("/api/portfolio/{basket_id}/deleted")
def get_deleted_stocks(basket_id: str, db: Session = Depends(get_db)):
    """Return all stocks currently hidden with reason='deleted' for a basket."""
    basket_name = _resolve_basket(basket_id)
    today_str   = datetime.now().strftime("%Y-%m-%d")
    rows = db.query(database.HiddenStock).filter(
        database.HiddenStock.basket_id     == basket_name,
        database.HiddenStock.hidden_reason == 'deleted',
        database.HiddenStock.expires_at    >= today_str,
    ).all()
    return [
        {
            "stock_code": r.stock_code,
            "stock_name": r.stock_name or r.stock_code,
            "sector":     r.sector     or "",
            "buy_price":  r.buy_price  or 0.0,
            "last_cmp":   r.last_cmp   or 0.0,
            "allocation": r.allocation or 0.0,
            "hidden_at":  r.hidden_at,
            "expires_at": r.expires_at,
        }
        for r in rows
    ]


@router.post("/api/portfolio/refresh-metrics")
def refresh_yf_metrics():
    """
    Clear the yfinance metrics cache so the next /api/baskets call
    re-fetches CMP, PE and MCap for all stocks from Yahoo Finance.
    """
    sheet_service._yf_metrics_cache.clear()
    sheet_service._cache.clear()
    return {"status": "cache_cleared"}
