"""Historic return analytics for baskets + simulator, plus analyst notes/rationales."""
import asyncio
import time as _time
from datetime import datetime, timedelta

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func as _sqf
from sqlalchemy.orm import Session

import database
from auth import is_admin_email
from main import (
    get_db, _io_pool, yf, _historic_cache, _HISTORIC_TTL,
    _historic_sim_cache, _HIST_SIM_VER, _save_disk_cache, RationaleCreate,
)
from routers.actual_portfolio_bridge import _fetch_all_webportal_baskets
from routers.benchmarks import _BENCHMARKS, _fetch_bench_close_max

router = APIRouter()

@router.get("/api/baskets/{basket_id}/historic")
async def get_basket_historic(basket_id: str, db: Session = Depends(get_db)):
    # ── Cache hit: return instantly ───────────────────────────────────────────
    cached = _historic_cache.get(basket_id)
    if cached and (_time.time() - cached['time']) < _HISTORIC_TTL:
        return cached['data']

    loop    = asyncio.get_running_loop()
    baskets = await loop.run_in_executor(_io_pool, _fetch_all_webportal_baskets)
    if basket_id not in baskets:
        raise HTTPException(status_code=404, detail="Basket not found")

    basket_name = baskets[basket_id]['name']
    holdings    = baskets[basket_id].get("holdings", [])
    if not holdings:
        return {}

    # ── Inception date: earliest first_seen across active + sold stocks ───────
    try:
        a_min = db.query(_sqf.min(database.BasketHistory.first_seen_date)).filter_by(basket_id=basket_name).scalar()
        s_min = db.query(_sqf.min(database.SoldStock.buy_date)).filter_by(basket_id=basket_name).scalar()
        inception_date = min(d for d in [a_min, s_min] if d) if any([a_min, s_min]) else None
    except Exception:
        inception_date = None

    symbols = [f"{h['code']}.NS" if not h['code'].endswith(".NS") else h['code'] for h in holdings]
    weights = {f"{h['code']}.NS" if not h['code'].endswith(".NS") else h['code']: h['allocation']/100.0 for h in holdings}

    try:
        raw  = await loop.run_in_executor(_io_pool,
                   lambda: yf.download(symbols, period="10y", progress=False))
        close_data = raw['Close'] if 'Close' in raw else raw
        if isinstance(close_data, pd.Series):
            close_data = close_data.to_frame(name=symbols[0])
        if close_data.empty:
            return {}

        # Strip timezone for naive datetime comparisons
        if close_data.index.tz is not None:
            close_data.index = close_data.index.tz_localize(None)
        now = close_data.index[-1]

        def calc_ret(target_dt):
            past = close_data.loc[close_data.index <= target_dt]
            if past.empty:
                return None
            past_prices = past.iloc[-1]
            now_prices  = close_data.iloc[-1]
            pf_return = total_weight = 0.0
            for sym in symbols:
                if sym not in close_data.columns:
                    continue
                pp = past_prices.get(sym)
                pn = now_prices.get(sym)
                if pp is None or pn is None:
                    continue
                if hasattr(pp, 'iloc'):
                    pp = pp.iloc[0]
                if hasattr(pn, 'iloc'):
                    pn = pn.iloc[0]
                if pd.isna(pp) or pd.isna(pn) or float(pp) <= 0:
                    continue
                pf_return    += (float(pn) - float(pp)) / float(pp) * weights.get(sym, 0)
                total_weight += weights.get(sym, 0)
            if total_weight == 0:
                return None
            total_w = sum(weights.values())
            return pf_return * (total_w / total_weight) if total_w > 0 else pf_return

        # Build period list — only include periods the basket is actually old enough for.
        # If a basket is 87 days old, showing "1Y" / "3Y" / "5Y" returns meaningless
        # numbers (yfinance just returns the earliest available row for those baskets).
        inception_days = None
        if inception_date:
            try:
                inc_dt = datetime.strptime(inception_date, "%Y-%m-%d")
                inception_days = (datetime.now() - inc_dt).days
            except Exception:
                pass

        all_periods = [("1M", 30), ("6M", 182), ("1Y", 365), ("3Y", 1095), ("5Y", 1825)]
        # Keep a standard period only if the basket is at least that old
        if inception_days is not None:
            periods = [(lbl, d) for lbl, d in all_periods if inception_days >= d]
        else:
            periods = all_periods

        # Always add the Inception period for baskets older than 30 days
        if inception_days is not None and inception_days > 30:
            periods.append(("Inception", inception_days))

        res = {}
        for label, days in periods:
            target_dt = pd.to_datetime(now - timedelta(days=days))
            net_ret   = calc_ret(target_dt)
            if net_ret is not None:
                cagr = ((1 + net_ret) ** (365 / days)) - 1 if days >= 365 and net_ret > -1 else None
                res[label] = {
                    "net":  round(net_ret * 100, 2),
                    "cagr": round(cagr    * 100, 2) if cagr is not None else None,
                }

        if inception_date:
            res["_inception_date"]  = inception_date
            res["_inception_days"]  = inception_days

        # Benchmark returns since inception — fetch max-period data in parallel
        if inception_date and inception_days and inception_days > 30:
            inc_ts = pd.Timestamp(datetime.strptime(inception_date, "%Y-%m-%d"))
            bench_closes = await asyncio.gather(*[
                loop.run_in_executor(_io_pool, _fetch_bench_close_max, sym)
                for sym in _BENCHMARKS.values()
            ])
            bench_inception = {}
            for (bname, _), bclose in zip(_BENCHMARKS.items(), bench_closes):
                if bclose is None or bclose.empty:
                    continue
                if bclose.index.tz is not None:
                    bclose.index = bclose.index.tz_localize(None)
                past = bclose[bclose.index <= inc_ts]
                if past.empty:
                    continue
                p_start = float(past.iloc[-1])
                p_now   = float(bclose.iloc[-1])
                if p_start <= 0:
                    continue
                bnet  = round((p_now - p_start) / p_start * 100, 2)
                bcagr = round(((p_now / p_start) ** (365 / inception_days) - 1) * 100, 2) if inception_days >= 365 else None
                bench_inception[bname] = {"net": bnet, "cagr": bcagr}
            if bench_inception:
                res["_benchmark_inception"] = bench_inception

        _historic_cache[basket_id] = {'time': _time.time(), 'data': res}
        loop.run_in_executor(_io_pool, _save_disk_cache, dict(_historic_cache))
        return res
    except Exception as e:
        print(f"Historic calc error for {basket_id}: {e}")
        return {}

@router.get("/api/simulator/historic")
async def get_simulator_historic(request: Request, db: Session = Depends(get_db)):
    """Historic net/CAGR returns for the current user's own virtual portfolio holdings."""
    user = getattr(request.state, "user", None)
    holdings_raw = db.query(database.SimulationMod).filter(database.SimulationMod.user_email == user).all()
    if not holdings_raw:
        return {"simulated": {}}

    # ── Cache key includes the user + holdings fingerprint ────────────────────
    mod_key = f"{_HIST_SIM_VER}:{user}|" + ','.join(sorted(f"{m.stock_code}:{m.allocation}:{m.buy_price}:{m.cmp}" for m in holdings_raw))
    cached = _historic_sim_cache.get(mod_key)
    if cached and (_time.time() - cached['time']) < 3600:  # 1-hour cache (index-history changes daily)
        return cached['data']

    loop = asyncio.get_running_loop()
    sim_holdings = [{'code': m.stock_code, 'allocation': m.allocation or 0} for m in holdings_raw]

    def compute_sim_historic(holdings):
        if not holdings:
            return {}
        symbols = [f"{h['code']}.NS" if not h['code'].endswith(".NS") else h['code'] for h in holdings]
        total_alloc = sum(float(h.get('allocation', 0)) for h in holdings)
        if total_alloc > 0:
            weights = {(f"{h['code']}.NS" if not h['code'].endswith(".NS") else h['code']): float(h.get('allocation', 0)) / 100.0 for h in holdings}
        else:
            weights = {sym: 1.0 / len(symbols) for sym in symbols}
        try:
            raw = yf.download(symbols, period="5y", progress=False)
            if raw.empty:
                return {}
            data = raw['Close']
            if isinstance(data, pd.Series):
                data = data.to_frame(name=symbols[0])
            now = data.index[-1]

            def calc_ret(days):
                target = now - timedelta(days=days)
                past = data.loc[data.index <= target]
                if past.empty:
                    return None
                past_prices = past.iloc[-1]
                now_prices  = data.iloc[-1]
                pf_return = 0.0
                weight_used = 0.0
                for sym in symbols:
                    if sym not in data.columns:
                        continue
                    p_past = past_prices.get(sym)
                    p_now  = now_prices.get(sym)
                    if p_past is not None and p_now is not None and pd.notna(p_past) and pd.notna(p_now) and float(p_past) > 0:
                        ret = (float(p_now) - float(p_past)) / float(p_past)
                        pf_return += ret * weights.get(sym, 0)
                        weight_used += weights.get(sym, 0)
                if weight_used == 0:
                    return None
                total_w = sum(weights.values())
                if total_w > 0:
                    pf_return = pf_return * (total_w / weight_used)
                return pf_return

            res = {}
            for label, days in [("1M", 30), ("6M", 182), ("1Y", 365), ("3Y", 1095), ("5Y", 1825)]:
                net_ret = calc_ret(days)
                if net_ret is not None:
                    cagr = ((1 + net_ret) ** (365 / days)) - 1 if days >= 365 and net_ret > -1 else net_ret
                    res[label] = {"net": round(net_ret * 100, 2), "cagr": round(cagr * 100, 2) if days >= 365 else None}
            return res
        except Exception as e:
            print(f"Simulator historic error: {e}")
            return {}

    sim_hist = await loop.run_in_executor(_io_pool, compute_sim_historic, sim_holdings)
    result = {"simulated": sim_hist}

    # ── Store in simulator cache ──────────────────────────────────────────────
    _historic_sim_cache[mod_key] = {'time': _time.time(), 'data': result}
    return result

class AnalystUpdate(BaseModel):
    analyst_name: str

@router.get("/api/baskets/{basket_id}/analyst")
def get_basket_analyst(basket_id: str, db: Session = Depends(get_db)):
    rec = db.query(database.BasketAnalyst).filter_by(basket_id=basket_id).first()
    return {"analyst_name": rec.analyst_name if rec else ""}

@router.post("/api/baskets/{basket_id}/analyst")
def set_basket_analyst(basket_id: str, body: AnalystUpdate, request: Request, db: Session = Depends(get_db)):
    user = getattr(request.state, "user", None)
    if not is_admin_email(user):
        raise HTTPException(status_code=403, detail="Admin only")
    rec = db.query(database.BasketAnalyst).filter_by(basket_id=basket_id).first()
    now = datetime.utcnow().isoformat()
    if rec:
        rec.analyst_name = body.analyst_name.strip()
        rec.updated_by   = user
        rec.updated_at   = now
    else:
        db.add(database.BasketAnalyst(
            basket_id=basket_id,
            analyst_name=body.analyst_name.strip(),
            updated_by=user,
            updated_at=now,
        ))
    db.commit()
    return {"status": "ok", "analyst_name": body.analyst_name.strip()}


@router.get("/api/rationales/{stock_code}")
def get_rationale(stock_code: str, db: Session = Depends(get_db)):
    db_obj = db.query(database.Rationale).filter(database.Rationale.stock_code == stock_code.upper()).first()
    if db_obj:
        return {"stock_code": stock_code, "rationale_text": db_obj.rationale_text}
    return {"stock_code": stock_code, "rationale_text": ""}

@router.post("/api/rationales")
def save_rationale(item: RationaleCreate, db: Session = Depends(get_db)):
    db_obj = db.query(database.Rationale).filter(database.Rationale.stock_code == item.stock_code.upper()).first()
    if db_obj:
        db_obj.rationale_text = item.rationale_text
    else:
        db_obj = database.Rationale(stock_code=item.stock_code.upper(), rationale_text=item.rationale_text)
        db.add(db_obj)
    db.commit()
    return {"status": "success"}
