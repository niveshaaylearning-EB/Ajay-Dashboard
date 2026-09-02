import requests
import sys
import os
import io
import pandas as pd
from sqlalchemy.orm import Session

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend'))
from database import SessionLocal, NseStock

NSE_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"

def sync_nse_stocks():
    print("Fetching NSE Equity List...")
    try:
        # NSE requires a user-agent
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }
        r = requests.get(NSE_URL, headers=headers)
        if r.status_code != 200:
            print(f"Failed to fetch: {r.status_code}")
            return
            
        df = pd.read_csv(io.StringIO(r.text))
        
        db = SessionLocal()
        
        # Check if already synced to avoid slow inserts
        count = db.query(NseStock).count()
        if count > 200:
            print("Database already has NSE stocks synced.")
            return

        print(f"Processing {len(df)} symbols...")
        for _, row in df.iterrows():
            code = str(row.get('SYMBOL', '')).strip()
            name = str(row.get('NAME OF COMPANY', '')).strip()
            
            if code and name:
                existing = db.query(NseStock).filter(NseStock.code == code).first()
                if not existing:
                    stock = NseStock(code=code, name=name)
                    db.add(stock)
                    
        db.commit()
        print("Successfully synced NSE Database!")
        
    except Exception as e:
        print(f"Error syncing NSE stocks: {e}")

if __name__ == "__main__":
    sync_nse_stocks()
