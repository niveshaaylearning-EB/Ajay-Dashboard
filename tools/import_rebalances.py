"""
CLI script: import all rebalance data from the Excel file into the DB.
Run: python tools/import_rebalances.py (from repo root)
"""
import sys, os
_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backend')
sys.path.insert(0, _BACKEND_DIR)
os.chdir(_BACKEND_DIR)

from rebalance_utils import parse_excel, import_basket
from database import SessionLocal

EXCEL_PATH = r'C:\Users\Jay Chaudhari\Downloads\Rebalance Data.xlsx'

def main():
    print("=" * 60)
    print("NIA Rebalance Import")
    print("=" * 60)

    print("\n[1/3] Parsing Excel file...")
    baskets_data = parse_excel(EXCEL_PATH)
    for name, data in baskets_data.items():
        dates = data['rebalance_dates']
        print(f"  {name}: {len(dates)} rebalances, latest={dates[-1] if dates else 'N/A'}")

    print("\n[2/3] Importing into database...")
    db = SessionLocal()
    try:
        for basket_name, data in baskets_data.items():
            print(f"\n--- {basket_name} ---")
            result = import_basket(db, basket_name, data)
            print(f"  [ok] {len(result['active'])} active, {len(result['archived'])} archived")
    finally:
        db.close()

    print("\n[3/3] Done!")

if __name__ == '__main__':
    main()
