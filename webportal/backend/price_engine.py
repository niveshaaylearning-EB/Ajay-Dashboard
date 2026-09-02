"""Multi-source live price fetching: Yahoo Finance chart API, NSE bhavcopy,
Screener.in HTML scrape, Google Finance scrape, market-cap/PE pipeline, and
portfolio PDF parsing. Also owns the in-memory live/mc-pe/nse-symbols caches
since they're only ever read/written by the functions in this module.

_nse_symbols_cache is read directly (via `import price_engine` + module attribute
access, not `from price_engine import _nse_symbols_cache`, since it's reassigned
here) by rebalance.py and portfolio_report.py.
"""
import asyncio
import csv
import io
import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pypdf import PdfReader

from config import YF_HEADERS, YF_SYMBOL_MAP, LIVE_TTL
from persistence import (
    BASKET_DISPLAY_NAMES, _all_nse_codes, _load_portfolios, _require_admin,
    add_client, rename_client, delete_client, _log_activity,
    _load_client_capital, _save_client_capital, _load_historical_index, _load_client_id_map,
)

router = APIRouter()

# ── Persistent Yahoo Finance cookie cache ─────────────────────────────────────
_YF_COOKIES: dict = {}

async def _refresh_yf_cookies():
    """Visit Yahoo Finance homepage to get fresh session cookies. Called at startup + on 401."""
    global _YF_COOKIES
    try:
        async with httpx.AsyncClient(follow_redirects=True, headers=YF_HEADERS, timeout=10.0) as c:
            r = await c.get("https://finance.yahoo.com/")
            _YF_COOKIES = dict(r.cookies)
            print(f"[YF] Session cookies refreshed ({len(_YF_COOKIES)} cookies)")
    except Exception as e:
        print(f"[YF] Cookie refresh failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# In-memory live-data cache
# ─────────────────────────────────────────────────────────────────────────────

_live_cache: dict = {}
_live_cache_ts: float = 0.0
_live_cache_lock = asyncio.Lock()

_mc_pe_cache: dict = {}          # separate long-lived cache for MC + PE
_mc_pe_cache_ts: float = 0.0
_mc_pe_task_running: bool = False
_MC_PE_TTL = 6 * 3600            # refresh MC/PE every 6 hours

_nse_symbols_cache: list = []
_nse_symbols_ts: float = 0.0
_NSE_SYMBOLS_TTL = 24 * 3600  # refresh once per day




# ─────────────────────────────────────────────────────────────────────────────
# Source 1 — Yahoo Finance chart API: CMP + 1-month OHLC
# (No auth required; v7/quote returns 401 so we skip it)
# ─────────────────────────────────────────────────────────────────────────────

def _fetch_bhavcopy_prices(codes: list) -> dict:
    """Fetch EOD prices from NSE bhavcopy using requests with browser headers.
    NSE blocks pandas' urllib on cloud IPs — requests with proper headers works.
    """
    results: dict = {}
    code_set = set(c.upper() for c in codes)
    try:
        import pandas as pd
        import requests as _req
        import io
        from datetime import date, timedelta

        _headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Referer": "https://www.nseindia.com/",
        }

        for i in range(1, 7):
            d = (date.today() - timedelta(days=i))
            url = f"https://archives.nseindia.com/products/content/sec_bhavdata_full_{d.strftime('%d%m%Y')}.csv"
            try:
                r = _req.get(url, headers=_headers, timeout=15)
                if r.status_code != 200:
                    continue
                df = pd.read_csv(io.StringIO(r.text))
                if df is None or df.empty:
                    continue
                df.columns = [c.strip() for c in df.columns]
                df['SYMBOL'] = df['SYMBOL'].str.strip()
                match = df[df['SYMBOL'].isin(code_set)]
                for _, row in match.iterrows():
                    sym = row['SYMBOL']
                    def _f(col):
                        try: v = float(row.get(col, 0) or 0); return v if v > 0 else None
                        except: return None
                    close = _f('CLOSE_PRICE') or _f('LAST_PRICE')
                    if close:
                        results[sym] = {
                            "cmp":     close,
                            "close1M": close,
                            "open1M":  _f('OPEN_PRICE'),
                            "high1M":  _f('HIGH_PRICE'),
                            "low1M":   _f('LOW_PRICE'),
                        }
                if results:
                    print(f"[bhavcopy] Loaded {len(results)} prices from {d.strftime('%d-%m-%Y')}")
                    break
            except Exception as e:
                print(f"[bhavcopy] {d.strftime('%d-%m-%Y')}: {e}")
                continue
    except Exception:
        pass
    return results



# ─────────────────────────────────────────────────────────────────────────────
# Multi-tenure performance (1M/3M/6M/1Y/2Y/3Y/5Y)
# ─────────────────────────────────────────────────────────────────────────────
# For any tenure, the return is:
#   (CLOSE of the last fully-completed trading session)
#     vs
#   (OPEN of the first trading day of the window, i.e. `tenure` calendar days
#    before that last completed session)
# Today's bar is deliberately excluded even if Yahoo already has one for it --
# while the market is open (or freshly closed but not yet finalized upstream)
# that bar's OHLC is still live/provisional, so the "last trading session" is
# always the most recent bar strictly BEFORE today.
# One 5-year daily-bar fetch per stock covers every tenure at once, rather
# than one request per tenure.

_TENURE_DAYS = {"1M": 30, "3M": 91, "6M": 182, "1Y": 365, "2Y": 730, "3Y": 1095, "5Y": 1825}

_perf_cache: dict = {}          # code -> {time, data: {tenure: pct|None}}
_PERF_TTL = 12 * 3600           # 12h -- daily bars for past periods never change; only today's does

def _compute_tenure_performance(bars: list) -> dict:
    """`bars` is a list of (timestamp_seconds, open, close) sorted ascending by time."""
    result = {t: None for t in _TENURE_DAYS}
    if not bars:
        return result

    today = datetime.now(timezone.utc).date()
    completed = [b for b in bars if datetime.fromtimestamp(b[0], tz=timezone.utc).date() < today]
    if not completed:
        return result

    last_ts, _, last_close = completed[-1]
    if last_close is None:
        return result
    for tenure, days in _TENURE_DAYS.items():
        cutoff = last_ts - days * 86400
        start_bar = next((b for b in completed if b[0] >= cutoff), None)
        if start_bar is None:
            continue
        start_open = start_bar[1]
        if start_open is None or start_open <= 0:
            continue
        result[tenure] = (last_close - start_open) / start_open
    return result

async def _fetch_tenure_bars_for_symbol(sym: str, client: httpx.AsyncClient) -> list:
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + urllib.parse.quote(sym) + "?interval=1d&range=5y")
    try:
        resp = await client.get(url, timeout=20.0)
        if resp.status_code != 200:
            return []
        r = (resp.json().get("chart") or {}).get("result") or []
        if not r:
            return []
        r = r[0]
        ts = r.get("timestamp") or []
        q  = ((r.get("indicators") or {}).get("quote") or [{}])[0]
        opens  = q.get("open")  or []
        closes = q.get("close") or []
        bars = [(t, opens[i], closes[i]) for i, t in enumerate(ts)
                if i < len(opens) and i < len(closes) and opens[i] is not None and closes[i] is not None]
        bars.sort(key=lambda b: b[0])
        return bars
    except Exception:
        return []


async def _fetch_tenure_bars(code: str, client: httpx.AsyncClient) -> list:
    """5 years of daily (timestamp, open, close) bars for one NSE stock.
    Same symbol-resolution fallback as _fetch_yahoo_charts (the CMP/OHLC
    fetch): standard CODE.NS first, then CODE-SM.NS (NSE/BSE SME listings)
    if that returns nothing -- without this, an SME stock's CMP/OHLC would
    load fine while its multi-tenure Performance column stayed stuck at "-"
    forever, since only the primary .NS symbol was ever tried here."""
    sym = YF_SYMBOL_MAP.get(code, f"{code}.NS")
    bars = await _fetch_tenure_bars_for_symbol(sym, client)
    if not bars and sym.endswith(".NS") and code not in YF_SYMBOL_MAP:
        bars = await _fetch_tenure_bars_for_symbol(f"{code}-SM.NS", client)
    return bars

async def fetch_performance_batch(codes: list) -> dict:
    """{code: {tenure: pct|None}} for every code, using a 12h per-code cache."""
    now = time.time()
    result: dict = {}
    to_fetch: list = []
    for c in codes:
        cached = _perf_cache.get(c)
        if cached and (now - cached['time']) < _PERF_TTL:
            result[c] = cached['data']
        else:
            to_fetch.append(c)

    if not to_fetch:
        return result

    if not _YF_COOKIES:
        await _refresh_yf_cookies()

    sem = asyncio.Semaphore(15)

    async def _one(code: str, client: httpx.AsyncClient):
        async with sem:
            bars = await _fetch_tenure_bars(code, client)
            return code, _compute_tenure_performance(bars)

    async with httpx.AsyncClient(
        follow_redirects=True,
        headers={**YF_HEADERS, "Referer": "https://finance.yahoo.com/", "Origin": "https://finance.yahoo.com"},
        cookies=_YF_COOKIES,
    ) as client:
        pairs = await asyncio.gather(*[_one(c, client) for c in to_fetch], return_exceptions=True)

    for item in pairs:
        if isinstance(item, Exception):
            continue
        code, perf = item
        _perf_cache[code] = {'time': now, 'data': perf}
        result[code] = perf

    return result


async def _fetch_yahoo_charts(codes: list) -> dict:
    """Fetch CMP and 1M OHLC for all codes via Yahoo Finance chart API.

    Handles three symbol variants automatically:
      1. Explicit override via YF_SYMBOL_MAP (e.g. BSE SME numeric codes)
      2. Standard NSE: CODE.NS
      3. NSE SME fallback: CODE-SM.NS (retried for any .NS that returns no data)
    """
    sem = asyncio.Semaphore(25)

    async def _one(sym: str, client: httpx.AsyncClient):
        async with sem:
            url = (
                "https://query1.finance.yahoo.com/v8/finance/chart/"
                + urllib.parse.quote(sym)
                + "?interval=1d&range=1mo"
            )
            try:
                return sym, await client.get(url, timeout=15.0)
            except Exception:
                return sym, None

    def _parse_resp(sym: str, resp, sym_to_code: dict):
        """Return (nse_code, data_dict) or (nse_code, None) on failure."""
        code = sym_to_code.get(sym, sym.split(".")[0].replace("-SM", "").upper())
        if resp is None or isinstance(resp, Exception):
            return code, None
        try:
            if resp.status_code != 200:
                return code, None
            r = (resp.json().get("chart") or {}).get("result") or []
            if not r:
                return code, None
            r     = r[0]
            meta  = r.get("meta") or {}
            q     = ((r.get("indicators") or {}).get("quote") or [{}])[0]
            opens = [v for v in (q.get("open") or []) if v is not None]
            highs = [v for v in (q.get("high") or []) if v is not None]
            lows  = [v for v in (q.get("low")  or []) if v is not None]
            cmp   = meta.get("regularMarketPrice")
            if not cmp:
                return code, None
            return code, {
                "cmp":     cmp,
                "close1M": cmp,
                "open1M":  opens[0]   if opens else None,
                "high1M":  max(highs) if highs else None,
                "low1M":   min(lows)  if lows  else None,
            }
        except Exception:
            return code, None

    # Build primary symbol list (use explicit map or default to .NS)
    sym_to_code: dict = {}
    primary_syms: list = []
    for c in codes:
        sym = YF_SYMBOL_MAP.get(c, f"{c}.NS")
        sym_to_code[sym] = c
        primary_syms.append(sym)

    # Refresh cookies if cache is empty
    if not _YF_COOKIES:
        await _refresh_yf_cookies()

    async with httpx.AsyncClient(
        follow_redirects=True,
        headers={**YF_HEADERS, "Referer": "https://finance.yahoo.com/", "Origin": "https://finance.yahoo.com"},
        cookies=_YF_COOKIES,
        timeout=30.0,
    ) as client:
        pairs = await asyncio.gather(
            *[_one(sym, client) for sym in primary_syms],
            return_exceptions=True,
        )

    # If all failed (stale cookies), refresh and retry once
    results_check = [p for p in pairs if isinstance(p, tuple) and p[1] and getattr(p[1], 'status_code', 0) == 200]
    if not results_check and primary_syms:
        await _refresh_yf_cookies()
        async with httpx.AsyncClient(
            follow_redirects=True,
            headers={**YF_HEADERS, "Referer": "https://finance.yahoo.com/", "Origin": "https://finance.yahoo.com"},
            cookies=_YF_COOKIES,
            timeout=30.0,
        ) as client:
            pairs = await asyncio.gather(
                *[_one(sym, client) for sym in primary_syms],
                return_exceptions=True,
            )

    data: dict = {}
    retry_codes: list = []
    for item in pairs:
        if isinstance(item, Exception):
            continue
        sym, resp = item
        code, d = _parse_resp(sym, resp, sym_to_code)
        if d:
            data[code] = d
        elif sym.endswith(".NS") and code not in YF_SYMBOL_MAP:
            # Standard .NS returned nothing — try SME variant next
            retry_codes.append(code)

    # Second pass: retry as NSE SME (CODE-SM.NS) for stocks that got no data
    if retry_codes:
        sm_map = {f"{c}-SM.NS": c for c in retry_codes}
        async with httpx.AsyncClient(follow_redirects=True, headers=YF_HEADERS, timeout=30.0) as client:
            sm_pairs = await asyncio.gather(
                *[_one(sym, client) for sym in sm_map],
                return_exceptions=True,
            )
        for item in sm_pairs:
            if isinstance(item, Exception):
                continue
            sym, resp = item
            code, d = _parse_resp(sym, resp, sm_map)
            if d:
                data[code] = d

    return data


# ─────────────────────────────────────────────────────────────────────────────
# Source 2 — Screener.in HTML scrape: Market Cap (Cr) + Stock P/E
# ─────────────────────────────────────────────────────────────────────────────

_MC_RE = re.compile(r'Market Cap.*?<span[^>]*class="[^"]*number[^"]*"[^>]*>([\d,.]+)</span>', re.DOTALL)
_PE_RE = re.compile(r'Stock P/E.*?<span[^>]*class="[^"]*number[^"]*"[^>]*>([\d,.]+)</span>',  re.DOTALL)


def _parse_screener_html(html: str) -> tuple:
    """Return (marketCapCr, peRatio) parsed from a Screener.in company page."""
    mc, pe = None, None
    mc_m = _MC_RE.search(html)
    pe_m = _PE_RE.search(html)
    if mc_m:
        try:
            mc = float(mc_m.group(1).replace(",", ""))
        except ValueError:
            pass
    if pe_m:
        try:
            pe = round(float(pe_m.group(1).replace(",", "")), 2)
        except ValueError:
            pass
    return mc, pe


_PROXY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "*/*",
}


def _with_proxies(target: str) -> list:
    """Return proxy URL list — codetabs first (known to work), then fallbacks."""
    enc = urllib.parse.quote(target, safe="")
    return [
        f"https://api.codetabs.com/v1/proxy?quest={enc}",   # primary — works reliably
        target,                                              # direct fallback
        f"https://api.allorigins.win/raw?url={enc}",        # secondary fallback
        f"https://corsproxy.io/?{enc}",                     # tertiary fallback
    ]


async def _get_via_proxies(target: str, timeout: float = 13.0) -> Optional[str]:
    """Fetch target via codetabs proxy (primary), with fallback proxies only if codetabs
    fails with a network/timeout exception (not a valid HTTP error response)."""
    enc = urllib.parse.quote(target, safe="")
    codetabs_url = f"https://api.codetabs.com/v1/proxy?quest={enc}"

    # ── Primary: codetabs ──────────────────────────────────────────────
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, headers=_PROXY_HEADERS,
            timeout=httpx.Timeout(timeout, connect=timeout),
        ) as client:
            resp = await client.get(codetabs_url)
        if resp.status_code == 200 and resp.text.strip():
            return resp.text
        # codetabs gave a real HTTP response (404, 500, etc.) — other proxies won't help
        return None
    except Exception:
        pass  # codetabs timed out or had a network error — try fallbacks

    # ── Fallbacks (only reached if codetabs had a network/timeout error) ──
    fallbacks = [
        (target,                                              5.0),
        (f"https://api.allorigins.win/raw?url={enc}",        5.0),
        (f"https://corsproxy.io/?{enc}",                     4.0),
    ]
    for url, t in fallbacks:
        try:
            async with httpx.AsyncClient(
                follow_redirects=True, headers=_PROXY_HEADERS,
                timeout=httpx.Timeout(t, connect=t),
            ) as client:
                resp = await client.get(url)
            if resp.status_code == 200 and resp.text.strip():
                return resp.text
        except Exception:
            continue
    return None


async def _screener_search_url(code: str) -> Optional[str]:
    """Call Screener.in search API (via proxy waterfall) to resolve the correct company page URL."""
    target = f"https://www.screener.in/api/company/search/?q={urllib.parse.quote(code)}&v=1"
    text = await _get_via_proxies(target, timeout=13.0)
    if text:
        try:
            results = json.loads(text)
            if isinstance(results, list) and results and results[0].get("url"):
                return results[0]["url"]
        except Exception:
            pass
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Source 3 — Google Finance HTML scrape: Market Cap + P/E ratio
# ─────────────────────────────────────────────────────────────────────────────

_GF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _parse_google_finance_html(html: str) -> tuple:
    """Return (marketCapCr, peRatio) parsed from a Google Finance quote page.

    Google Finance (en-US) shows Indian stock market caps as ₹1.37T / ₹678B / ₹45M.
    Conversion: 1T INR = 100,000 Cr  |  1B INR = 100 Cr  |  1M INR = 0.1 Cr
    """
    mc, pe = None, None

    # Market cap — ₹ followed by number and T/B/M suffix
    for pat in (
        r'Market\s+cap[^<]{0,600}?₹\s*([\d.]+)\s*([TBM])\b',
        r'"Market cap"[^"]{0,300}?"₹([\d.]+)\s*([TBM])"',
    ):
        m = re.search(pat, html, re.DOTALL | re.IGNORECASE)
        if m:
            try:
                val    = float(m.group(1))
                suffix = m.group(2).upper()
                if   suffix == 'T': mc = round(val * 100_000)
                elif suffix == 'B': mc = round(val * 100)
                elif suffix == 'M': mc = max(1, round(val * 0.1))
                break
            except (ValueError, AttributeError):
                continue

    # P/E ratio — plain number near the "P/E ratio" label
    for pat in (
        r'P/E\s+ratio[^<]{0,600}?>([\d.]+)<',
        r'"P/E ratio"[^"]{0,200}?"([\d.]+)"',
    ):
        m = re.search(pat, html, re.DOTALL | re.IGNORECASE)
        if m:
            try:
                pe = round(float(m.group(1)), 2)
                break
            except ValueError:
                continue

    return mc, pe


# ─────────────────────────────────────────────────────────────────────────────
# Source 4 — NSE India API: Market Cap via issuedSize × price
#            (Individual-stock P/E is not exposed by this endpoint)
# ─────────────────────────────────────────────────────────────────────────────

_NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com",
    "X-Requested-With": "XMLHttpRequest",
}


# ─────────────────────────────────────────────────────────────────────────────
# Portfolio PDF parsing — password-protected report upload
# ─────────────────────────────────────────────────────────────────────────────

# Set PORTFOLIO_PDF_PASSWORD in backend/.env -- the broker sends portfolio
# reports as a password-protected PDF, and this decrypts it on upload.
# No real value is baked into source; if unset, decryption fails with a
# clear "PDF decryption failed" error at upload time instead of silently
# using a credential anyone reading the code could see.
_R = os.environ.get("PORTFOLIO_PDF_PASSWORD", "").encode()

_PDF_SECTIONS = {
    "additions":                       "addition",
    "increase in weight allocation":   "increase",
    "removals":                        "removal",
    "decrease in weight allocation":   "decrease",
    "no change in weight allocation":  "no_change",
}

_HOLDING_TYPES = [
    "Large & Mid Cap", "Large and Mid Cap",
    "Largecap", "Large Cap", "Midcap", "Mid Cap",
    "Smallcap", "Small Cap", "Microcap", "Micro Cap",
    "Flexicap", "Flex Cap", "Multicap", "Multi Cap",
]

_NAME_STRIP = re.compile(
    r'\b(ltd|limited|pvt|private|inc|corp|corporation|enterprises|industries|co)\b\.?',
    re.IGNORECASE,
)


def _norm_name(name: str) -> str:
    return re.sub(r'\s+', ' ', _NAME_STRIP.sub('', name.lower())).strip()


def _parse_portfolio_pdf(raw: bytes) -> list:
    """Decrypt and parse portfolio PDF; return list of section entries."""
    reader = PdfReader(io.BytesIO(raw))
    if reader.is_encrypted:
        if not reader.decrypt(_R.decode()):
            raise ValueError("PDF decryption failed")

    full_text = "\n".join(page.extract_text() or "" for page in reader.pages)

    entries = []
    current = None
    for line in full_text.splitlines():
        line = line.strip()
        if not line:
            continue
        ll = line.lower()

        # Detect section header
        for hdr, stype in _PDF_SECTIONS.items():
            if hdr in ll:
                current = stype
                break
        else:
            if not current:
                continue
            if "holding type" in ll or ll.startswith("weightage"):
                continue

            # Extract first percentage (= new weight)
            wm = re.search(r'(\d+(?:\.\d+)?)\s*%', line)
            if not wm:
                continue
            new_weight = float(wm.group(1))

            # Find and remove holding type to isolate company name
            holding = "Equity"
            name_part = line
            for ht in sorted(_HOLDING_TYPES, key=len, reverse=True):
                if ht.lower() in ll:
                    holding = ht
                    idx = ll.index(ht.lower())
                    name_part = line[:idx]
                    break
            else:
                name_part = re.sub(r'\d+(?:\.\d+)?\s*%.*', '', name_part)

            company = name_part.strip().rstrip('-').strip()
            if company and len(company) > 2:
                entries.append({
                    "section":     current,
                    "companyName": company,
                    "holdingType": holding,
                    "newWeight":   new_weight,
                })

    return entries


def _resolve_nse(company: str, portfolio: list, symbols: list) -> Optional[str]:
    """Map company name → NSE code: portfolio match → symbols exact → symbols partial."""
    norm = _norm_name(company)
    # 1. Existing portfolio
    for s in portfolio:
        if _norm_name(s.get("securityName", "")) == norm:
            return s["nseCode"]
    # 2. NSE symbols exact
    for sym in symbols:
        if _norm_name(sym["name"]) == norm:
            return sym["symbol"]
    # 3. NSE symbols partial (only for names ≥6 chars to avoid false positives)
    if len(norm) >= 6:
        for sym in symbols:
            sn = _norm_name(sym["name"])
            if norm in sn or sn in norm:
                return sym["symbol"]
    return None


async def _fetch_yahoo_mc_pe(code: str) -> tuple:
    """Fetch Market Cap (Cr) and trailing PE from Yahoo Finance quoteSummary."""
    try:
        url = (
            f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{code}.NS"
            "?modules=summaryDetail"
        )
        async with httpx.AsyncClient(
            follow_redirects=True, headers=YF_HEADERS, timeout=10.0
        ) as client:
            resp = await client.get(url)
        if resp.status_code == 200:
            sd = (
                ((resp.json().get("quoteSummary") or {}).get("result") or [{}])[0]
                .get("summaryDetail") or {}
            )
            mc_raw = (sd.get("marketCap") or {}).get("raw")
            pe_raw = (sd.get("trailingPE") or {}).get("raw")
            mc = round(mc_raw / 1e7) if mc_raw else None
            pe = round(pe_raw, 1) if pe_raw else None
            return mc, pe
    except Exception:
        pass
    return None, None


async def _try_nse_mc(code: str) -> Optional[int]:
    """Compute Market Cap (Cr) from NSE India: lastPrice × issuedSize / 1e7."""
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=15.0,
            headers={"User-Agent": _NSE_HEADERS["User-Agent"],
                     "Accept": "text/html,application/xhtml+xml"},
        ) as client:
            await client.get("https://www.nseindia.com", timeout=10.0)
            resp = await client.get(
                f"https://www.nseindia.com/api/quote-equity?symbol={code}",
                headers=_NSE_HEADERS, timeout=12.0,
            )
        if resp.status_code != 200:
            return None
        data   = resp.json()
        price  = ((data.get("priceInfo") or {}).get("lastPrice")
                  or (data.get("priceInfo") or {}).get("close"))
        issued = (data.get("metadata") or {}).get("issuedSize")
        if price and issued:
            return round(float(price) * float(issued) / 1e7)
    except Exception:
        pass
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Combined MC + PE fetch — Screener → Google Finance → Yahoo Finance → NSE India
# ─────────────────────────────────────────────────────────────────────────────

async def _fetch_mc_pe_one(code: str, sem: asyncio.Semaphore) -> tuple:
    """
    Fetch Market Cap (Cr) and P/E for one stock. Source order (strict):
    1. Screener.in   — HTML scrape; most accurate for Indian stocks
    2. Google Finance — fallback if Screener fails/missing
    3. Yahoo Finance  — quoteSummary; fallback if Google fails
    4. NSE India      — last resort; MC only (no PE)
    """
    async with sem:
        mc, pe = None, None

        # ── 1. Screener.in (proxy waterfall) ─────────────────────────────
        # Try direct URL first (fast for most stocks); only fall back to
        # Search API if direct URLs don't have top-ratios (mismatched slug).
        try:
            for target in [
                f"https://www.screener.in/company/{code}/consolidated/",
                f"https://www.screener.in/company/{code}/",
            ]:
                if mc is not None and pe is not None:
                    break
                html = await _get_via_proxies(target, timeout=13.0)
                if html and "top-ratios" in html:
                    sc_mc, sc_pe = _parse_screener_html(html)
                    if sc_mc is not None and mc is None:
                        mc = round(sc_mc)
                    if sc_pe is not None and pe is None:
                        pe = sc_pe

            # Fallback: slug mismatch — resolve via Search API
            if (mc is None or pe is None):
                company_url = await _screener_search_url(code)
                if company_url:
                    html = await _get_via_proxies(
                        f"https://www.screener.in{company_url}", timeout=13.0
                    )
                    if html and "top-ratios" in html:
                        sc_mc, sc_pe = _parse_screener_html(html)
                        if sc_mc is not None and mc is None:
                            mc = round(sc_mc)
                        if sc_pe is not None and pe is None:
                            pe = sc_pe
        except Exception:
            pass

        if mc is not None and pe is not None:
            return code, {"marketCapCr": mc, "peRatio": pe}

        # ── 2. Google Finance ─────────────────────────────────────────────
        try:
            async with httpx.AsyncClient(
                follow_redirects=True, headers=_GF_HEADERS, timeout=12.0
            ) as client:
                resp = await client.get(
                    f"https://www.google.com/finance/quote/{code}:NSE",
                    timeout=12.0,
                )
            if resp.status_code == 200:
                gf_mc, gf_pe = _parse_google_finance_html(resp.text)
                if mc is None and gf_mc is not None:
                    mc = gf_mc
                if pe is None and gf_pe is not None:
                    pe = gf_pe
        except Exception:
            pass

        if mc is not None and pe is not None:
            return code, {"marketCapCr": mc, "peRatio": pe}

        # ── 3. Yahoo Finance ──────────────────────────────────────────────
        if mc is None or pe is None:
            yf_mc, yf_pe = await _fetch_yahoo_mc_pe(code)
            if mc is None and yf_mc is not None:
                mc = yf_mc
            if pe is None and yf_pe is not None:
                pe = yf_pe

        if mc is not None and pe is not None:
            return code, {"marketCapCr": mc, "peRatio": pe}

        # ── 4. NSE India (market cap only) ────────────────────────────────
        if mc is None:
            nse_mc = await _try_nse_mc(code)
            if nse_mc is not None:
                mc = nse_mc

        return code, ({"marketCapCr": mc, "peRatio": pe} if (mc is not None or pe is not None) else {})


async def _fetch_screener_batch(codes: list) -> dict:
    """Fetch Market Cap and PE for all codes using cascade: Screener → Google → NSE."""
    sem     = asyncio.Semaphore(10)
    results = await asyncio.gather(
        *[_fetch_mc_pe_one(c, sem) for c in codes],
        return_exceptions=True,
    )
    data: dict = {}
    for r in results:
        if isinstance(r, Exception):
            continue
        code, metrics = r
        if metrics:
            data[code] = metrics
    return data


# ─────────────────────────────────────────────────────────────────────────────
# Combined batch fetch — both sources in parallel, cached 15 min
# ─────────────────────────────────────────────────────────────────────────────

async def _mc_pe_background_refresh() -> None:
    """Fetch MC+PE for all stocks in background; patches live cache when done."""
    global _mc_pe_cache, _mc_pe_cache_ts, _mc_pe_task_running
    _mc_pe_task_running = True
    try:
        codes = _all_nse_codes()
        sem   = asyncio.Semaphore(10)
        results = await asyncio.gather(
            *[_fetch_mc_pe_one(c, sem) for c in codes],
            return_exceptions=True,
        )
        fresh: dict = {}
        for r in results:
            if isinstance(r, Exception):
                continue
            code, metrics = r
            if metrics:
                fresh[code] = metrics
        _mc_pe_cache    = fresh
        _mc_pe_cache_ts = time.time()
        # Patch the live cache so current page loads see the new MC/PE immediately
        async with _live_cache_lock:
            for code, metrics in fresh.items():
                if code in _live_cache:
                    _live_cache[code].update(metrics)
    except Exception:
        pass
    finally:
        _mc_pe_task_running = False


_live_refresh_task = None   # asyncio.Task | None — background Yahoo refresh


async def _refresh_live_cache() -> None:
    """Background task: refresh Yahoo price data and update _live_cache in-place."""
    global _live_cache, _live_cache_ts, _mc_pe_task_running, _live_refresh_task
    try:
        codes = _all_nse_codes()
        mc_pe_cold = not _mc_pe_cache or (time.time() - _mc_pe_cache_ts) >= _MC_PE_TTL
        try:
            yahoo_data = await _fetch_yahoo_charts(codes)
        except Exception:
            yahoo_data = {}
        if mc_pe_cold and not _mc_pe_task_running:
            asyncio.create_task(_mc_pe_background_refresh())
        data: dict = {}
        for code in codes:
            yf = yahoo_data.get(code, {}) if isinstance(yahoo_data, dict) else {}
            sc = _mc_pe_cache.get(code, {})
            data[code] = {
                "cmp":         yf.get("cmp"),
                "close1M":     yf.get("close1M"),
                "open1M":      yf.get("open1M"),
                "high1M":      yf.get("high1M"),
                "low1M":       yf.get("low1M"),
                "marketCapCr": sc.get("marketCapCr"),
                "peRatio":     sc.get("peRatio"),
            }
        async with _live_cache_lock:
            _live_cache    = data
            _live_cache_ts = time.time()
    finally:
        _live_refresh_task = None


async def fetch_live_batch() -> dict:
    """
    Stale-while-revalidate: serve the cached result immediately if it exists,
    and kick off a background refresh whenever the TTL has expired.
    - Cold start (no cache): awaits the refresh directly (~5-10s Yahoo fetch).
    - Warm cache (within TTL): returns instantly, no background work needed.
    - Stale cache (TTL expired): returns stale data NOW, refreshes in background.
    """
    global _live_refresh_task

    async with _live_cache_lock:
        age = time.time() - _live_cache_ts
        cache_warm = bool(_live_cache) and age < LIVE_TTL
        cache_stale = bool(_live_cache) and age >= LIVE_TTL

    if cache_warm:
        return _live_cache

    if cache_stale:
        # Serve stale immediately; start background refresh if not already running
        if _live_refresh_task is None or _live_refresh_task.done():
            _live_refresh_task = asyncio.create_task(_refresh_live_cache())
        return _live_cache

    # Cache is empty (cold start) — must wait for the first fetch
    if _live_refresh_task is None or _live_refresh_task.done():
        _live_refresh_task = asyncio.create_task(_refresh_live_cache())
    await _live_refresh_task
    return _live_cache


# ─────────────────────────────────────────────────────────────────────────────
# Single-stock lookup (used when a stock isn't found in the batch cache)
# ─────────────────────────────────────────────────────────────────────────────

async def fetch_live_single(nse_code: str, skip_mc_pe: bool = False) -> Optional[dict]:
    """
    `skip_mc_pe` short-circuits the Market Cap + PE cascade (Screener.in →
    Google Finance → NSE India, each with a 12-13s timeout) for callers that
    only need CMP/OHLC and would otherwise pay that latency for fields they
    throw away -- e.g. the what-if simulator's "Add Hypothetical Stock" flow.
    """
    code   = nse_code.strip().upper()
    sym    = f"{code}.NS"

    async with httpx.AsyncClient(follow_redirects=True, headers=YF_HEADERS, timeout=12.0) as yf_client:
        chart_resp = await asyncio.gather(
            yf_client.get(
                "https://query1.finance.yahoo.com/v8/finance/chart/"
                + urllib.parse.quote(sym) + "?interval=1d&range=1mo"
            ),
            return_exceptions=True,
        )
    chart_resp = chart_resp[0]

    result: dict = {}

    # CMP + OHLC from Yahoo chart
    if not isinstance(chart_resp, Exception) and chart_resp.status_code == 200:
        try:
            r = (chart_resp.json().get("chart") or {}).get("result") or [None]
            r = r[0]
            if r:
                meta  = r.get("meta") or {}
                q     = ((r.get("indicators") or {}).get("quote") or [{}])[0]
                opens = [v for v in (q.get("open") or []) if v is not None]
                highs = [v for v in (q.get("high") or []) if v is not None]
                lows  = [v for v in (q.get("low")  or []) if v is not None]
                cmp   = meta.get("regularMarketPrice")
                if cmp:
                    result.update({
                        "cmp":     cmp,
                        "close1M": cmp,
                        "open1M":  opens[0]   if opens else None,
                        "high1M":  max(highs) if highs else None,
                        "low1M":   min(lows)  if lows  else None,
                    })
        except Exception:
            pass

    if skip_mc_pe:
        return result or None

    # Market Cap + PE — cascade: Screener.in → Google Finance → NSE India
    sem = asyncio.Semaphore(1)
    _, metrics = await _fetch_mc_pe_one(code, sem)
    result.update(metrics)

    return result or None


# ─────────────────────────────────────────────────────────────────────────────
# NSE equity symbol list — fetched from NSE archives CSV, cached 24 h
# ─────────────────────────────────────────────────────────────────────────────

def _fetch_nse_symbols_from_local_db() -> list:
    """
    Fallback source: the main backend's `nse_stocks` SQLite table (already
    populated separately, see tools/sync_nse.py).

    Deliberately does NOT `import database` (backend/database.py) to get at
    it -- that module's default DATABASE_URL is `sqlite:///./portfolio.db`,
    a path resolved relative to the process's CURRENT WORKING DIRECTORY at
    import time, not to database.py's own file location. run.py starts this
    app as its own process with cwd=webportal/backend, so importing that
    module from here would silently open (or even create) the wrong, empty
    portfolio.db in webportal/backend instead of the real one in backend/ --
    reading the known file by absolute path instead sidesteps that entirely.
    """
    try:
        if os.environ.get("DATABASE_URL", "sqlite").split(":", 1)[0] != "sqlite":
            return []   # non-SQLite backend configured -- nothing we can read directly
        backend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backend')
        db_path = os.path.join(backend_dir, 'portfolio.db')
        if not os.path.isfile(db_path):
            return []
        import sqlite3
        conn = sqlite3.connect(db_path)
        try:
            rows = conn.execute("SELECT code, name FROM nse_stocks").fetchall()
            return [{"symbol": code, "name": name} for code, name in rows if code and name]
        finally:
            conn.close()
    except Exception:
        return []

async def _fetch_nse_symbols() -> list:
    """Fetch all NSE-listed equity symbols + company names from NSE archives CSV."""
    global _nse_symbols_cache, _nse_symbols_ts

    if _nse_symbols_cache and (time.time() - _nse_symbols_ts) < _NSE_SYMBOLS_TTL:
        return _nse_symbols_cache

    url = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"
    try:
        async with httpx.AsyncClient(
            follow_redirects=True, timeout=30.0,
            headers={"User-Agent": YF_HEADERS["User-Agent"], "Accept": "text/csv,*/*"},
        ) as client:
            resp = await client.get(url, timeout=25.0)

        if resp.status_code == 200:
            reader = csv.reader(io.StringIO(resp.text))
            next(reader, None)          # skip header row
            symbols = []
            for row in reader:
                if len(row) >= 2:
                    sym  = row[0].strip()
                    name = row[1].strip()
                    if sym and name:
                        symbols.append({"symbol": sym, "name": name})
            if symbols:
                _nse_symbols_cache = symbols
                _nse_symbols_ts    = time.time()
                return symbols
    except Exception:
        pass

    # NSE's archives CSV is frequently blocked by its own bot-protection on
    # cloud IPs (Akamai edge block, independent of headers/retries) -- fall
    # back to the local DB copy rather than leaving the autocomplete empty.
    local_symbols = _fetch_nse_symbols_from_local_db()
    if local_symbols:
        _nse_symbols_cache = local_symbols
        _nse_symbols_ts    = time.time()
        return local_symbols

    return _nse_symbols_cache   # return stale cache on failure


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/api/baskets")
async def get_baskets():
    return BASKET_DISPLAY_NAMES


@router.post("/api/admin/add-client")
async def admin_add_client(request: Request, body: dict):
    """Admin-only: register a new client by name. Stock composition is added
    afterward via the existing rebalance file-upload flow, targeting the
    returned key."""
    user = _require_admin(request)
    key, label = add_client(body.get("name", ""))
    _log_activity("add_client", user, {"key": key, "label": label})
    return {"key": key, "label": label}


@router.put("/api/admin/rename-client/{key}")
async def admin_rename_client(key: str, request: Request, body: dict):
    """Admin-only: change a client's display name (the basket key stays the same)."""
    user = _require_admin(request)
    label = rename_client(key, body.get("name", ""))
    _log_activity("rename_client", user, {"key": key, "label": label})
    return {"key": key, "label": label}


@router.delete("/api/admin/delete-client/{key}")
async def admin_delete_client(key: str, request: Request):
    """Admin-only: permanently remove a client and all of its data. Irreversible."""
    user = _require_admin(request)
    label = BASKET_DISPLAY_NAMES.get(key, key)
    delete_client(key)
    _log_activity("delete_client", user, {"key": key, "label": label})
    return {"ok": True, "key": key}


@router.put("/api/admin/client-capital/{key}")
async def admin_set_client_capital(key: str, request: Request, body: dict):
    """Admin-only: set/update a client's total capital deployed (₹) -- the one
    manually-maintained absolute figure the All Clients tab computes Invested/
    Current Value from, since every other stored figure is % weight-based."""
    user = _require_admin(request)
    if key not in BASKET_DISPLAY_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown client: {key}")
    amount = body.get("amount")
    try:
        amount = float(amount)
        if amount < 0:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="amount must be a non-negative number")

    capital = _load_client_capital()
    capital[key] = round(amount, 2)
    _save_client_capital(capital)
    _log_activity("set_client_capital", user, {"key": key, "amount": capital[key]})
    return {"key": key, "totalCapital": capital[key]}


@router.get("/api/clients-summary")
async def get_clients_summary():
    """One row per client for the All Clients overview tab and the header's
    client search: display name, broker Client ID (if linked), admin-entered
    total capital, since-inception return (same index series the Overview
    KPI panel's "Since Inception" figure already uses), the resulting
    current value, and live stock count. Read-only, no admin gate (matches
    every other basket-list read endpoint in this app)."""
    portfolios   = _load_portfolios()
    capital_map  = _load_client_capital()
    hist         = _load_historical_index()
    # client_id_map.json is {clientId: basketKey} -- invert it once so each
    # basket can look up its own linked Client ID (there's at most one in
    # practice; a basket linked to several just shows the first found).
    basket_to_client_id = {}
    for client_id, basket_key in _load_client_id_map().items():
        basket_to_client_id.setdefault(basket_key, client_id)

    rows = []
    for key, label in BASKET_DISPLAY_NAMES.items():
        stocks = portfolios.get(key, [])
        stock_count = sum(1 for s in stocks if (s.get("allocation") or 0) > 0)
        total_capital = capital_map.get(key)

        since_inception_pct = None
        series = (hist.get(key) or {}).get("data") or []
        if len(series) >= 2:
            inception_val = series[0].get("value")
            latest_val    = series[-1].get("value")
            if inception_val:
                since_inception_pct = (latest_val - inception_val) / inception_val

        current_value = None
        if total_capital is not None and since_inception_pct is not None:
            current_value = round(total_capital * (1 + since_inception_pct), 2)

        rows.append({
            "key":               key,
            "label":             label,
            "clientId":          basket_to_client_id.get(key),
            "totalCapital":      total_capital,
            "sinceInceptionPct": since_inception_pct,
            "currentValue":      current_value,
            "stockCount":        stock_count,
        })
    return rows


@router.get("/api/basket-stock-map")
async def get_basket_stock_map():
    """{basketKey: [nseCode, ...]} for every basket -- powers cross-basket
    stock search ("which other baskets hold this stock") and the basket
    overlap % panel in the frontend. Read-only, no admin gate.

    Only counts stocks with a POSITIVE allocation -- a basket's stock list
    can carry old, fully-sold-out entries at 0% allocation indefinitely
    (never cleaned out), and those aren't real current holdings, so they'd
    silently inflate the stock count and overlap denominator. IPO_Recommendations
    is a watchlist with no allocation concept at all (every entry is legitimately
    0%), so it's exempted from the filter -- every entry there counts.
    """
    portfolios = _load_portfolios()
    return {
        key: sorted({
            s["nseCode"] for s in portfolios.get(key, [])
            if s.get("nseCode") and (key == "IPO_Recommendations" or (s.get("allocation") or 0) > 0)
        })
        for key in BASKET_DISPLAY_NAMES
    }


@router.get("/api/basket-weight-map")
async def get_basket_weight_map():
    """{basketKey: {nseCode: allocation}} for every basket -- powers the
    weight-based basket-overlap panel (as opposed to basket-stock-map's
    plain code list, used for the stock-count overlap panel). Allocation
    is the raw 0-1 fraction. Unlike basket-stock-map, no positive-allocation
    filter is needed here -- a 0%/stale entry just contributes 0 to any
    weighted sum, so it's harmless to leave in."""
    portfolios = _load_portfolios()
    return {
        key: {
            s["nseCode"]: (s.get("allocation") or 0)
            for s in portfolios.get(key, [])
            if s.get("nseCode")
        }
        for key in BASKET_DISPLAY_NAMES
    }


@router.post("/api/debug/pdf-text")
async def debug_pdf_text(file: UploadFile = File(...)):
    """Return raw text extracted from the PDF (for debugging only)."""
    raw = await file.read()
    reader = PdfReader(io.BytesIO(raw))
    if reader.is_encrypted:
        reader.decrypt(_R.decode())
    pages = []
    for i, page in enumerate(reader.pages):
        pages.append({"page": i + 1, "text": page.extract_text() or ""})
    return {"pages": pages}


@router.get("/api/debug/mcpe")
async def debug_mcpe():
    return {
        "mc_pe_cache_size": len(_mc_pe_cache),
        "mc_pe_task_running": _mc_pe_task_running,
        "mc_pe_cache_age_s": round(time.time() - _mc_pe_cache_ts, 1) if _mc_pe_cache_ts else None,
        "live_cache_size": len(_live_cache),
        "live_cache_age_s": round(time.time() - _live_cache_ts, 1) if _live_cache_ts else None,
        "sample": {k: _mc_pe_cache[k] for k in list(_mc_pe_cache.keys())[:5]} if _mc_pe_cache else {},
    }


@router.get("/api/nse-symbols")
async def get_nse_symbols():
    """Return full NSE equity symbol list for autocomplete (cached 24 h)."""
    return await _fetch_nse_symbols()

