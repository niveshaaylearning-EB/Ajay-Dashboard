"""Rebalance-impact alerts: notify a user once per basket about the most
recent rebalance (exits, partial sells, new additions, weight increases)."""
import json
import os
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

import database
from main import get_db

router = APIRouter()

_WEBPORTAL_PORTFOLIOS = os.path.join(os.path.dirname(__file__), '..', '..', 'webportal', 'backend', 'portfolios.json')
_WEBPORTAL_REBAL_HIST = os.path.join(os.path.dirname(__file__), '..', '..', 'webportal', 'backend', 'rebalance_history.json')

_BASKET_ALERT_KEYS = {
    'Mid_Small_Cap': 'Mid & Small Cap',
    'Green_Energy':  'Green Energy',
    'IPO_Basket':    'IPO Basket',
    'Trends_Triology': 'Trends Triology',
    'Techstack':     'Techstack',
    'Make_in_India': 'Make in India',
    'Consumer_Trends': 'Consumer Trends',
}

def _parse_rebal_date(ds: str):
    """Parse 'DD Mon YYYY' → date object, or return None."""
    for fmt in ("%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(ds.strip(), fmt).date()
        except Exception:
            pass
    return None

def _build_rebalance_alert(basket_id: str, rebal_date: str, portfolios: dict, rh: dict) -> dict | None:
    """Build a single rebalance alert dict for basket_id on rebal_date."""
    sold_key = f"{basket_id}_sold"
    sold_all = portfolios.get(sold_key, [])
    hist_all = rh.get(basket_id, [])

    # ── Exits & partial sells on this date ───────────────────────────────────
    sold_on_date = [s for s in sold_all if s.get('date', '').strip() == rebal_date]
    wholly_sold  = [s for s in sold_on_date if s.get('action') == 'Wholly Sold']
    partly_sold  = [s for s in sold_on_date if s.get('action') == 'Partially Sold']

    # ── Rebalance history: stocks entering on this date (additions/increases) ─
    added_on_date = [e for e in hist_all if e.get('date', '').strip() == rebal_date]

    # Find previous rebalance date to compute weight diffs
    dates_before = sorted(
        set(e['date'] for e in hist_all if _parse_rebal_date(e['date']) and
            _parse_rebal_date(e['date']) < _parse_rebal_date(rebal_date)),
        key=lambda d: _parse_rebal_date(d),
        reverse=True,
    )
    prev_date = dates_before[0] if dates_before else None
    prev_map = {e['nseCode']: e for e in hist_all if e.get('date') == prev_date} if prev_date else {}
    curr_map = {e['nseCode']: e for e in added_on_date}

    new_additions   = []
    weight_increased = []
    for nse, entry in curr_map.items():
        if nse not in prev_map:
            new_additions.append({'nseCode': nse, 'securityName': entry.get('securityName',''), 'weight': entry.get('weight', 0)})
        else:
            old_w = prev_map[nse].get('weight', 0)
            new_w = entry.get('weight', 0)
            if new_w > old_w + 0.01:
                weight_increased.append({'nseCode': nse, 'securityName': entry.get('securityName',''), 'oldWeight': old_w, 'newWeight': new_w})

    # Skip if nothing changed
    if not wholly_sold and not partly_sold and not new_additions and not weight_increased:
        return None

    def _pnl(s):
        bp = s.get('buyPrice') or 0
        sp = s.get('sellPrice') or 0
        pct = round((sp - bp) / bp * 100, 2) if bp > 0 else None
        return {'nseCode': s.get('nseCode'), 'securityName': s.get('securityName',''),
                'weight': s.get('weightSold', 0), 'buyPrice': bp, 'sellPrice': sp,
                'returnPct': pct, 'gain': sp > bp if bp > 0 else None}

    return {
        'basketId':        basket_id,
        'basketLabel':     _BASKET_ALERT_KEYS.get(basket_id, basket_id),
        'rebalanceDate':   rebal_date,
        'fullExits':       [_pnl(s) for s in wholly_sold],
        'partialSells':    [_pnl(s) for s in partly_sold],
        'newAdditions':    new_additions,
        'weightIncreased': weight_increased,
    }


@router.get("/api/rebalance-alerts")
def get_rebalance_alerts(request: Request, db: Session = Depends(get_db)):
    """Return rebalance events the current user has not yet acknowledged."""
    current_user = getattr(request.state, "user", None)
    if not current_user:
        return []
    try:
        with open(_WEBPORTAL_PORTFOLIOS, encoding='utf-8') as f:
            portfolios = json.load(f)
        with open(_WEBPORTAL_REBAL_HIST, encoding='utf-8') as f:
            rh = json.load(f)
    except Exception:
        return []

    # Get dates the user has already seen
    seen = set(
        (r.basket_id, r.rebalance_date)
        for r in db.query(database.RebalanceAck).filter_by(user_email=current_user).all()
    )

    alerts = []
    for basket_id in _BASKET_ALERT_KEYS:
        sold_all = portfolios.get(f"{basket_id}_sold", [])
        hist_all = rh.get(basket_id, [])

        # Collect all rebalance dates for this basket
        all_dates = set(s.get('date', '').strip() for s in sold_all) | \
                    set(e.get('date', '').strip() for e in hist_all)

        # Find the single MOST RECENT rebalance date only
        valid_dates = [(d, _parse_rebal_date(d)) for d in all_dates if _parse_rebal_date(d)]
        if not valid_dates:
            continue
        latest_date, _ = max(valid_dates, key=lambda x: x[1])

        # Skip if user has already seen this rebalance
        if (basket_id, latest_date) in seen:
            continue

        alert = _build_rebalance_alert(basket_id, latest_date, portfolios, rh)
        if alert:
            alerts.append(alert)

    return alerts


@router.post("/api/rebalance-alerts/ack")
def ack_rebalance_alerts(request: Request, body: dict, db: Session = Depends(get_db)):
    """Mark rebalance events as seen. Body: [{basketId, rebalanceDate}, ...]"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    items = body.get('items', [])
    now_iso = datetime.now().isoformat()
    for item in items:
        basket_id  = item.get('basketId', '')
        rebal_date = item.get('rebalanceDate', '')
        if not basket_id or not rebal_date:
            continue
        exists = db.query(database.RebalanceAck).filter_by(
            user_email=user, basket_id=basket_id, rebalance_date=rebal_date
        ).first()
        if not exists:
            db.add(database.RebalanceAck(
                user_email=user, basket_id=basket_id,
                rebalance_date=rebal_date, acknowledged_at=now_iso,
            ))
    db.commit()
    return {'ok': True, 'acked': len(items)}
