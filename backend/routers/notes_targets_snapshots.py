"""Basket notes, per-stock target/stoploss, and portfolio snapshot CRUD."""
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import database
from main import get_db
from routers.holdings import _resolve_basket

router = APIRouter()

# ── Basket Notes ──────────────────────────────────────────────────────────────

@router.get("/api/basket-notes/{basket_id}")
def get_basket_note(basket_id: str, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    row = db.query(database.BasketNote).filter_by(basket_id=basket_name).first()
    return {"basket_id": basket_id, "note_text": row.note_text if row else "", "updated_at": row.updated_at if row else ""}

class NoteBody(BaseModel):
    note_text: str

@router.post("/api/basket-notes/{basket_id}")
def save_basket_note(basket_id: str, body: NoteBody, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    row = db.query(database.BasketNote).filter_by(basket_id=basket_name).first()
    if row:
        row.note_text  = body.note_text
        row.updated_at = now_str
    else:
        db.add(database.BasketNote(basket_id=basket_name, note_text=body.note_text, updated_at=now_str))
    db.commit()
    return {"status": "saved", "updated_at": now_str}


# ── Stock Targets & Stoploss ──────────────────────────────────────────────────

class TargetBody(BaseModel):
    stock_code:   str
    target_price: Optional[float] = None
    stoploss:     Optional[float] = None

@router.get("/api/portfolio/{basket_id}/targets")
def get_targets(basket_id: str, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    rows = db.query(database.StockTarget).filter_by(basket_id=basket_name).all()
    return {r.stock_code: {"target_price": r.target_price, "stoploss": r.stoploss} for r in rows}

@router.post("/api/portfolio/{basket_id}/targets")
def upsert_target(basket_id: str, body: TargetBody, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    code = re.sub(r'\s+', '', body.stock_code.upper())
    row  = db.query(database.StockTarget).filter_by(basket_id=basket_name, stock_code=code).first()
    if row:
        if body.target_price is not None: row.target_price = body.target_price
        if body.stoploss     is not None: row.stoploss     = body.stoploss
    else:
        db.add(database.StockTarget(basket_id=basket_name, stock_code=code,
                                    target_price=body.target_price, stoploss=body.stoploss))
    db.commit()
    return {"status": "saved"}

@router.delete("/api/portfolio/{basket_id}/targets/{stock_code}")
def delete_target(basket_id: str, stock_code: str, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    code = re.sub(r'\s+', '', stock_code.upper())
    db.query(database.StockTarget).filter_by(basket_id=basket_name, stock_code=code).delete()
    db.commit()
    return {"status": "deleted"}


# ── Portfolio Snapshots ───────────────────────────────────────────────────────

class SnapshotBody(BaseModel):
    snapshot_name: str
    holdings_json: str   # pre-serialised JSON string from client

@router.get("/api/snapshots/{basket_id}")
def list_snapshots(basket_id: str, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    rows = (db.query(database.PortfolioSnapshot)
              .filter_by(basket_id=basket_name)
              .order_by(database.PortfolioSnapshot.snapshot_date.desc())
              .all())
    return [{"id": r.id, "name": r.snapshot_name, "date": r.snapshot_date} for r in rows]

@router.post("/api/snapshots/{basket_id}")
def save_snapshot(basket_id: str, body: SnapshotBody, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    db.add(database.PortfolioSnapshot(
        basket_id=basket_name, snapshot_name=body.snapshot_name,
        snapshot_date=datetime.now().strftime("%Y-%m-%d"), holdings_json=body.holdings_json
    ))
    db.commit()
    return {"status": "saved"}

@router.get("/api/snapshots/{basket_id}/{snapshot_id}")
def get_snapshot(basket_id: str, snapshot_id: int, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    row = db.query(database.PortfolioSnapshot).filter_by(id=snapshot_id, basket_id=basket_name).first()
    if not row:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return {"id": row.id, "name": row.snapshot_name, "date": row.snapshot_date, "holdings_json": row.holdings_json}

@router.delete("/api/snapshots/{basket_id}/{snapshot_id}")
def delete_snapshot(basket_id: str, snapshot_id: int, db: Session = Depends(get_db)):
    basket_name = _resolve_basket(basket_id)
    db.query(database.PortfolioSnapshot).filter_by(id=snapshot_id, basket_id=basket_name).delete()
    db.commit()
    return {"status": "deleted"}
