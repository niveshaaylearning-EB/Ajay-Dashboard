"""
One-time migration script:
1. Backfills first_seen_date = last_seen_date for any NULL rows
2. Overlays with actual buy dates from Green Energy sheet (and any other
   sheet that has a 'Buy Date' column)
"""
import sqlite3
import sys
import os
import re
from datetime import datetime

import pandas as pd
import requests

SPREADSHEET_ID = '1eIw2QxtHX6b0iwhQvmlayKAAO7i97fYdMq7Fq6mToEk'

DATE_FORMATS = [
    '%d %b %Y',   # 19 Nov 2025
    '%d %B %Y',   # 19 November 2025
    '%Y-%m-%d',   # 2025-11-19
    '%d/%m/%Y',   # 19/11/2025
    '%d-%m-%Y',   # 19-11-2025
]


def try_parse_date(raw):
    """Return the EARLIEST date (YYYY-MM-DD) found in a Buy Date cell, or None."""
    if not raw or str(raw).strip() in ('', 'nan'):
        return None
    raw = str(raw)
    lines = re.split(r'[\n\r]+', raw)
    parsed = []
    for line in lines:
        # Separator is × (U+00D7 / \xc3\x97) followed by allocation number
        line = re.split(r'[\u00d7\u2192\u2013\u2014>]|-(?=\s*\d)', line)[0].strip()
        line = re.sub(r'[^\x00-\x7F]+', '', line).strip()
        line = re.sub(r'\s+\d+\.?\d*$', '', line).strip()   # strip trailing "3.0" etc.
        for fmt in DATE_FORMATS:
            try:
                parsed.append(datetime.strptime(line, fmt).date())
                break
            except ValueError:
                pass
    return str(min(parsed)) if parsed else None


def main():
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend', 'portfolio.db')
    db_path = os.path.normpath(db_path)
    print(f'DB path: {db_path}')
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Step 1: ensure column exists
    cur.execute('PRAGMA table_info(basket_history)')
    cols = [row[1] for row in cur.fetchall()]
    if 'first_seen_date' not in cols:
        cur.execute('ALTER TABLE basket_history ADD COLUMN first_seen_date TEXT')
        print('Added first_seen_date column')

    # Step 2: Backfill NULLs with last_seen_date
    cur.execute('UPDATE basket_history SET first_seen_date = last_seen_date WHERE first_seen_date IS NULL')
    print(f'Step 2: Backfilled {cur.rowcount} rows with last_seen_date as placeholder')

    # Step 3: Overlay with actual sheet buy dates where available
    sheets_with_buy_date = ['NIA Green Energy']   # extend as more sheets get Buy Date
    total_updated = 0

    for sheet_name in sheets_with_buy_date:
        url = (
            f'https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}'
            f'/gviz/tq?tqx=out:csv&sheet={requests.utils.quote(sheet_name)}'
        )
        try:
            df = pd.read_csv(url)
        except Exception as e:
            print(f'  Error fetching {sheet_name}: {e}')
            continue

        buy_date_col = next(
            (c for c in df.columns if 'buy' in c.lower() and 'date' in c.lower()), None
        )
        if not buy_date_col:
            print(f'  {sheet_name}: no Buy Date column found, skipping')
            continue

        updated = 0
        for _, row in df.iterrows():
            code = str(row.get('NSE Code', '')).strip()
            if not code or code.lower() == 'nan':
                continue
            buy_date = try_parse_date(row.get(buy_date_col))
            if code and buy_date:
                cur.execute(
                    'UPDATE basket_history SET first_seen_date=? '
                    'WHERE stock_code=? AND basket_id=?',
                    (buy_date, code, sheet_name)
                )
                if cur.rowcount > 0:
                    updated += 1
                    print(f'  [{sheet_name}] {code}: first_seen_date = {buy_date}')

        print(f'  {sheet_name}: updated {updated} stocks with sheet buy dates')
        total_updated += updated

    conn.commit()
    conn.close()
    print(f'\nDone. Total with authoritative sheet dates: {total_updated}')


if __name__ == '__main__':
    main()
