"""
Run once at container startup.
Copies data files from the image into /data (Render persistent disk) if they
don't exist yet — so the first deploy seeds the disk, and subsequent deploys
never overwrite live data.
"""
import os, shutil, sys

if os.environ.get("IS_DOCKER_LOCAL") == "true":
    print("[init] Local Docker detected, skipping symlinking to keep host volume mounts intact.")
    sys.exit(0)

DATA_DIR    = "/data"
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
WP_DIR      = os.path.join(BACKEND_DIR, "..", "webportal", "backend")

# Files that must live on the persistent disk
FILES = [
    # (source in image, destination on disk)
    (os.path.join(BACKEND_DIR, "portfolio.db"),           os.path.join(DATA_DIR, "portfolio.db")),
    (os.path.join(WP_DIR,      "portfolios.json"),        os.path.join(DATA_DIR, "portfolios.json")),
    (os.path.join(WP_DIR,      "historical_index.json"),  os.path.join(DATA_DIR, "historical_index.json")),
    (os.path.join(WP_DIR,      "rebalance_history.json"), os.path.join(DATA_DIR, "rebalance_history.json")),
    (os.path.join(WP_DIR,      "buy_price_data.json"),    os.path.join(DATA_DIR, "buy_price_data.json")),
]

os.makedirs(DATA_DIR, exist_ok=True)

for src, dst in FILES:
    if not os.path.exists(dst):
        if os.path.exists(src):
            shutil.copy2(src, dst)
            print(f"[init] Seeded: {dst}")
        else:
            print(f"[init] Source missing, skipping: {src}")
    else:
        print(f"[init] Already exists, keeping: {dst}")

# Create symlinks so both backends find files at their expected paths
SYMLINKS = [
    (os.path.join(DATA_DIR, "portfolio.db"),           os.path.join(BACKEND_DIR, "portfolio.db")),
    (os.path.join(DATA_DIR, "portfolios.json"),        os.path.join(WP_DIR, "portfolios.json")),
    (os.path.join(DATA_DIR, "historical_index.json"),  os.path.join(WP_DIR, "historical_index.json")),
    (os.path.join(DATA_DIR, "rebalance_history.json"), os.path.join(WP_DIR, "rebalance_history.json")),
    (os.path.join(DATA_DIR, "buy_price_data.json"),    os.path.join(WP_DIR, "buy_price_data.json")),
]

for data_file, app_file in SYMLINKS:
    if os.path.islink(app_file):
        os.unlink(app_file)
    elif os.path.exists(app_file):
        os.remove(app_file)
    os.symlink(data_file, app_file)
    print(f"[init] Linked: {app_file} -> {data_file}")

print("[init] Data directory ready.")
