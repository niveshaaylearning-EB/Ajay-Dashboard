"""Shared scraping config for the webportal backend's price-fetching routers.

Note: webportal/backend/main.py is loaded by backend/main.py via importlib
with a custom module spec, NOT as a normal top-level import -- it is never
registered in sys.modules under the name "main" (that name is already taken
by backend/main.py itself, the real uvicorn entrypoint). So webportal's own
routers must NOT do `from main import X` to reach webportal's main.py; doing
so would silently resolve to the unrelated backend/main.py instead. Shared
constants live here instead, in a module with an unambiguous name.
"""

LIVE_TTL = 60 * 60  # 60 minutes — longer cache reduces Stooq calls on cloud

YF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

# Explicit Yahoo Finance symbol overrides for NSE codes that don't map to CODE.NS
# e.g. BSE-only SME stocks (numeric codes) or corrected spellings
YF_SYMBOL_MAP: dict = {
    "544531":    "TRUECOLORS.BO",  # True Colors Ltd — BSE SME
    "ACUTAAS":   "ACUTAAS.BO",    # Acutaas Digital — BSE only
    "HBLENGINE": "HBLENGINE.BO",  # HBL Engineering — BSE only
    "ARIS":      "ARIS.BO",       # Arisinfra Solutions — BSE only
    "SETL":      "SETL.BO",       # Standard Engineering Technology — BSE only
}

SCREENER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
