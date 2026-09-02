"""Manual rollback points: full portfolios/buy-price/rebalance-history
snapshots the user can create and restore on demand (last 5 kept)."""
import json
import time

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Request

from buy_price_gains import _refresh_gains_file
from persistence import (
    _PORTFOLIOS_FILE, _BUY_PRICE_FILE, _RH_FILE, _ROLLBACK_FILE, _MAX_ROLLBACK_PTS,
    _require_admin,
)

router = APIRouter()

def _load_rollback_points() -> list:
    try:
        if _ROLLBACK_FILE.exists():
            return json.loads(_ROLLBACK_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []

def _save_rollback_points(points: list) -> None:
    _ROLLBACK_FILE.write_text(json.dumps(points, indent=2, ensure_ascii=False), encoding="utf-8")


@router.get("/api/rollback-points")
async def list_rollback_points():
    points = _load_rollback_points()
    return [{"id": p["id"], "label": p["label"], "createdAt": p["createdAt"]} for p in points]


@router.post("/api/rollback-points")
async def create_rollback_point(request: Request, body: dict = Body(...)):
    _require_admin(request)
    label = (body.get("label") or "").strip() or time.strftime("%d %b %Y %H:%M")
    point_id = str(int(time.time() * 1000))
    point = {
        "id":               point_id,
        "label":            label,
        "createdAt":        time.strftime("%d %b %Y %H:%M"),
        "portfolios":       json.loads(_PORTFOLIOS_FILE.read_text(encoding="utf-8")),
        "buyPriceData":     json.loads(_BUY_PRICE_FILE.read_text(encoding="utf-8")),
        "rebalanceHistory": json.loads(_RH_FILE.read_text(encoding="utf-8")),
    }
    points = _load_rollback_points()
    points.append(point)
    _save_rollback_points(points[-_MAX_ROLLBACK_PTS:])
    return {"ok": True, "id": point_id, "label": label, "createdAt": point["createdAt"]}


@router.post("/api/rollback-points/{point_id}/restore")
async def restore_rollback_point(point_id: str, background_tasks: BackgroundTasks, request: Request):
    _require_admin(request)
    points = _load_rollback_points()
    point = next((p for p in points if p["id"] == point_id), None)
    if not point:
        raise HTTPException(404, "Rollback point not found.")
    _PORTFOLIOS_FILE.write_text(
        json.dumps(point["portfolios"], indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _BUY_PRICE_FILE.write_text(
        json.dumps(point["buyPriceData"], indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _RH_FILE.write_text(
        json.dumps(point["rebalanceHistory"], indent=2, ensure_ascii=False), encoding="utf-8"
    )
    background_tasks.add_task(_refresh_gains_file)
    return {"ok": True, "label": point["label"], "createdAt": point["createdAt"]}


@router.delete("/api/rollback-points/{point_id}")
async def delete_rollback_point(point_id: str, request: Request):
    _require_admin(request)
    points = _load_rollback_points()
    new_points = [p for p in points if p["id"] != point_id]
    if len(new_points) == len(points):
        raise HTTPException(404, "Rollback point not found.")
    _save_rollback_points(new_points)
    return {"ok": True}
