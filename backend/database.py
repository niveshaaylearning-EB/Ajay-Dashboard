import os
from sqlalchemy import create_engine, Column, Integer, String, Float, Text, text, event
from sqlalchemy.orm import declarative_base, sessionmaker

SQLALCHEMY_DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./portfolio.db")

# Pool settings for 30-50 concurrent users:
#   pool_size      — persistent connections kept open
#   max_overflow   — extra connections allowed on burst
#   pool_timeout   — wait up to 30s before raising "pool exhausted"
#   pool_pre_ping  — check connection health before handing it out
connect_args = {}
if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args=connect_args,
    pool_size=20,
    max_overflow=30,
    pool_timeout=30,
    pool_pre_ping=True,
)

@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _record):
    """
    Applied once per physical connection:
    - WAL mode:  readers never block writers; writers never block readers.
                 Critical for concurrent access — without this SQLite uses
                 exclusive locks and every write blocks all reads.
    - synchronous=NORMAL: safe for WAL mode, 3-5× faster than FULL.
    - busy_timeout=10000: instead of instant "database is locked" errors,
                          wait up to 10 seconds for the lock to clear.
    - cache_size / mmap_size: keep hot pages in memory, reduce disk I/O.
    - temp_store=MEMORY: temp tables in RAM, not disk.
    """
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=10000")
    cur.execute("PRAGMA cache_size=20000")
    cur.execute("PRAGMA mmap_size=268435456")   # 256 MB memory-mapped I/O
    cur.execute("PRAGMA temp_store=MEMORY")
    cur.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class Rationale(Base):
    __tablename__ = "rationales"
    id = Column(Integer, primary_key=True, index=True)
    stock_code = Column(String, unique=True, index=True)
    rationale_text = Column(Text)

class SimulationMod(Base):
    """A single stock holding in a user's own virtual portfolio."""
    __tablename__ = "simulation_mods"
    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String, index=True)
    stock_code = Column(String, index=True)
    allocation = Column(Float, nullable=True)
    buy_price = Column(Float, nullable=True)
    buy_date = Column(String, nullable=True)   # YYYY-MM-DD -- used to compute Holding Days
    cmp = Column(Float, nullable=True)
    # Legacy columns from the basket-wise simulator, unused going forward.
    basket_id = Column(String, index=True, nullable=True)
    override_type = Column(String, nullable=True)
    formula = Column(String, nullable=True)

class SimulationSip(Base):
    __tablename__ = "simulation_sips"
    id = Column(Integer, primary_key=True, index=True)
    user_email = Column(String, index=True)
    sip_date = Column(String)   # YYYY-MM-DD
    amount = Column(Float)
    # Legacy column from the basket-wise simulator, unused going forward.
    basket_id = Column(String, index=True, nullable=True)


class SimulatorSettings(Base):
    """Per-user Simulator preferences -- currently just the base/initial
    investment amount (defaults to Rs 10L), editable per user instead of a
    single hardcoded figure shared by everyone."""
    __tablename__ = "simulator_settings"
    user_email = Column(String, primary_key=True)
    initial_investment = Column(Float, nullable=False, default=1000000.0)


class NseStock(Base):
    __tablename__ = "nse_stocks"
    id = Column(Integer, primary_key=True, index=True)
    code = Column(String, unique=True, index=True)
    name = Column(String)

class BasketHistory(Base):
    __tablename__ = "basket_history"
    id = Column(Integer, primary_key=True, index=True)
    basket_id = Column(String, index=True)
    stock_code = Column(String, index=True)
    last_cmp = Column(Float)
    buy_price = Column(Float, nullable=True)       # buy price from the sheet
    allocation = Column(Float, nullable=True)      # allocation % from the sheet
    last_seen_date = Column(String)                # YYYY-MM-DD
    first_seen_date = Column(String, nullable=True)  # YYYY-MM-DD – set once when first observed
    stock_name = Column(String, nullable=True)     # human-readable name
    sector = Column(String, nullable=True)         # sector/theme

class SoldStock(Base):
    __tablename__ = "sold_stocks"
    id = Column(Integer, primary_key=True, index=True)
    basket_id = Column(String, index=True)
    stock_code = Column(String, index=True)
    buy_price = Column(Float)
    sell_price = Column(Float)
    sell_date = Column(String)
    buy_date = Column(String, nullable=True)       # first_seen_date at time of archiving
    sector = Column(String, nullable=True)         # sector/theme
    stock_name = Column(String, nullable=True)     # human-readable name
    weight = Column(Float, nullable=True)          # last known allocation % before removal

class HiddenStock(Base):
    """
    Stocks intentionally hidden from the holdings display via dashboard actions.
    hidden_reason = 'sold'    → user sold via dashboard; persists indefinitely
    hidden_reason = 'deleted' → user deleted via dashboard; expires after 7 days (expires_at)
    During sheet sync, any stock whose code is in this table is excluded from holdings.
    """
    __tablename__ = "hidden_stocks"
    id = Column(Integer, primary_key=True, index=True)
    basket_id = Column(String, index=True)
    stock_code = Column(String, index=True)
    hidden_reason = Column(String)              # 'sold' | 'deleted'
    stock_name = Column(String, nullable=True)
    buy_price = Column(Float, nullable=True)
    last_cmp = Column(Float, nullable=True)
    sector = Column(String, nullable=True)
    allocation = Column(Float, nullable=True)
    hidden_at = Column(String)                  # YYYY-MM-DD
    expires_at = Column(String, nullable=True)  # YYYY-MM-DD; NULL for 'sold'

class StockEvent(Base):
    """
    Audit log for every meaningful change to a holding:
    - 'added'              → stock first appeared (sheet or dashboard)
    - 'allocation_changed' → allocation % was updated
    - 'price_changed'      → buy price was updated
    - 'sold'               → stock sold via dashboard
    - 'deleted'            → stock soft-hidden via dashboard
    """
    __tablename__ = "stock_events"
    id = Column(Integer, primary_key=True, index=True)
    basket_id   = Column(String, index=True)
    stock_code  = Column(String, index=True)
    event_type  = Column(String)           # see docstring above
    description = Column(String)           # human-readable summary
    old_value   = Column(String, nullable=True)
    new_value   = Column(String, nullable=True)
    event_date  = Column(String)           # YYYY-MM-DD
    user_email  = Column(String, nullable=True)

class BasketNote(Base):
    __tablename__ = "basket_notes"
    id         = Column(Integer, primary_key=True, index=True)
    basket_id  = Column(String, unique=True, index=True)
    note_text  = Column(Text)
    updated_at = Column(String)   # YYYY-MM-DD HH:MM

class StockTarget(Base):
    __tablename__ = "stock_targets"
    id           = Column(Integer, primary_key=True, index=True)
    basket_id    = Column(String, index=True)
    stock_code   = Column(String, index=True)
    target_price = Column(Float, nullable=True)
    stoploss     = Column(Float, nullable=True)

class PortfolioSnapshot(Base):
    __tablename__ = "portfolio_snapshots"
    id            = Column(Integer, primary_key=True, index=True)
    basket_id     = Column(String, index=True)
    snapshot_name = Column(String)
    snapshot_date = Column(String)   # YYYY-MM-DD
    holdings_json = Column(Text)     # JSON-serialised holdings list + stats

class OtpCode(Base):
    __tablename__ = "otp_codes"
    id         = Column(Integer, primary_key=True, index=True)
    email      = Column(String, index=True)
    code       = Column(String)
    created_at = Column(String)   # ISO datetime
    used       = Column(Integer, default=0)  # 0=fresh 1=consumed

class LoginHistory(Base):
    __tablename__ = "login_history"
    id         = Column(Integer, primary_key=True, index=True)
    email      = Column(String, index=True)
    logged_at  = Column(String)
    ip_address = Column(String, nullable=True)
    location   = Column(String, nullable=True)

class AuditLog(Base):
    __tablename__ = "audit_log"
    id         = Column(Integer, primary_key=True, index=True)
    user_email = Column(String, index=True)
    event_type = Column(String)   # rebalance_upload | portfolio_change
    details    = Column(Text, nullable=True)
    created_at = Column(String, index=True)
    ip_address = Column(String, nullable=True)
    location   = Column(String, nullable=True)

class BenchmarkCache(Base):
    __tablename__ = "benchmark_cache"
    id         = Column(Integer, primary_key=True, index=True)
    symbol     = Column(String, index=True)
    period     = Column(String)    # 1M / 6M / 1Y / 3Y / 5Y
    net        = Column(Float, nullable=True)
    cagr       = Column(Float, nullable=True)
    fetched_at = Column(String)    # YYYY-MM-DD  (24 h TTL)

class BasketAnalyst(Base):
    __tablename__ = "basket_analyst"
    id           = Column(Integer, primary_key=True, index=True)
    basket_id    = Column(String, unique=True, index=True)
    analyst_name = Column(String)
    updated_by   = Column(String, nullable=True)
    updated_at   = Column(String, nullable=True)

class BasketAnalystContact(Base):
    """Analyst(s) assigned to a basket for result/corporate-action reminder
    emails -- distinct from BasketAnalyst's single free-text display name
    above (unrelated, unused elsewhere). Multiple rows per basket_name are
    expected. Keyed by the same basket display-name string the Results
    Calendar itself produces (see routers/results_calendar.py's
    stocks_map), so no extra name-mapping is needed between this app's two
    basket-naming systems (main-backend BasketHistory vs webportal)."""
    __tablename__ = "basket_analyst_contacts"
    id          = Column(Integer, primary_key=True, index=True)
    basket_name = Column(String, index=True)
    name        = Column(String)
    email       = Column(String, index=True)
    added_by    = Column(String, nullable=True)
    added_at    = Column(String, nullable=True)

class AllowedEmail(Base):
    __tablename__ = "allowed_emails"
    id            = Column(Integer, primary_key=True, index=True)
    email         = Column(String, unique=True, index=True)
    added_by      = Column(String, nullable=True)
    added_at      = Column(String)   # ISO datetime
    totp_secret   = Column(String, nullable=True)
    totp_enabled  = Column(Integer, default=0)  # 0=disabled, 1=enabled
    backup_codes  = Column(Text, nullable=True)  # JSON-serialized list of hashed recovery codes
    first_name    = Column(String, nullable=True)
    last_name     = Column(String, nullable=True)
    password_hash = Column(String, nullable=True)  # PBKDF2-SHA256: salt_hex:key_hex
    is_approved   = Column(Integer, default=1)      # 1=approved  0=pending admin approval


class AccessRequest(Base):
    __tablename__ = "access_requests"
    id           = Column(Integer, primary_key=True, index=True)
    email        = Column(String, nullable=False, index=True)
    requested_at = Column(String, nullable=False)
    status       = Column(String, default="pending")   # pending / approved / rejected
    processed_at = Column(String, nullable=True)


class RebalanceAck(Base):
    __tablename__ = "rebalance_ack"
    id              = Column(Integer, primary_key=True, index=True)
    user_email      = Column(String, nullable=False, index=True)
    basket_id       = Column(String, nullable=False)
    rebalance_date  = Column(String, nullable=False)   # "DD Mon YYYY"
    acknowledged_at = Column(String, nullable=False)   # ISO datetime


class ActiveSession(Base):
    """One row per login session. Enables refresh-token rotation and session revocation."""
    __tablename__ = "active_sessions"
    id            = Column(Integer, primary_key=True, index=True)
    jti           = Column(String, unique=True, index=True)   # JWT ID — links to access token
    email         = Column(String, index=True)
    refresh_token = Column(String, nullable=True)             # SHA-256 hash of the raw refresh token
    device_info   = Column(String, nullable=True)             # User-Agent snippet
    ip_address    = Column(String, nullable=True)
    location      = Column(String, nullable=True)
    created_at    = Column(String)
    last_seen_at  = Column(String, nullable=True)
    is_active     = Column(Integer, default=1)                # 1=active  0=revoked


Base.metadata.create_all(bind=engine)


def run_migrations():
    """Add new columns to existing tables if they don't already exist."""
    migrations = [
        "ALTER TABLE basket_history ADD COLUMN stock_name TEXT",
        "ALTER TABLE basket_history ADD COLUMN sector TEXT",
        "ALTER TABLE basket_history ADD COLUMN allocation REAL",
        "ALTER TABLE sold_stocks ADD COLUMN buy_date TEXT",
        "ALTER TABLE sold_stocks ADD COLUMN sector TEXT",
        "ALTER TABLE sold_stocks ADD COLUMN stock_name TEXT",
        # stock_events extra columns (table created by Base.metadata.create_all)
        "ALTER TABLE stock_events ADD COLUMN old_value TEXT",
        "ALTER TABLE stock_events ADD COLUMN new_value TEXT",
        # hidden_stocks is created by Base.metadata.create_all; extra columns listed for safety
        "ALTER TABLE hidden_stocks ADD COLUMN stock_name TEXT",
        "ALTER TABLE hidden_stocks ADD COLUMN buy_price REAL",
        "ALTER TABLE hidden_stocks ADD COLUMN last_cmp REAL",
        "ALTER TABLE hidden_stocks ADD COLUMN sector TEXT",
        "ALTER TABLE hidden_stocks ADD COLUMN allocation REAL",
        "ALTER TABLE hidden_stocks ADD COLUMN expires_at TEXT",
        "ALTER TABLE sold_stocks ADD COLUMN weight REAL",
        "ALTER TABLE stock_events ADD COLUMN user_email TEXT",
        "ALTER TABLE login_history ADD COLUMN location TEXT",
        "ALTER TABLE audit_log ADD COLUMN ip_address TEXT",
        "ALTER TABLE audit_log ADD COLUMN location TEXT",
        # TOTP 2FA columns
        "ALTER TABLE allowed_emails ADD COLUMN totp_secret TEXT",
        "ALTER TABLE allowed_emails ADD COLUMN totp_enabled INTEGER DEFAULT 0",
        "ALTER TABLE allowed_emails ADD COLUMN backup_codes TEXT",
        # Password-based auth
        "ALTER TABLE allowed_emails ADD COLUMN first_name TEXT",
        "ALTER TABLE allowed_emails ADD COLUMN last_name TEXT",
        "ALTER TABLE allowed_emails ADD COLUMN password_hash TEXT",
        # Approval gate — DEFAULT 1 so existing users keep access; self-registered start at 0
        "ALTER TABLE allowed_emails ADD COLUMN is_approved INTEGER DEFAULT 1",
        # Simulator moved from per-basket to per-user virtual portfolios
        "ALTER TABLE simulation_mods ADD COLUMN user_email TEXT",
        "ALTER TABLE simulation_sips ADD COLUMN user_email TEXT",
        "ALTER TABLE simulation_mods ADD COLUMN buy_date TEXT",
    ]
    with engine.connect() as conn:
        for sql in migrations:
            try:
                conn.execute(text(sql))
                conn.commit()
            except Exception:
                # Column already exists — safe to ignore
                pass


run_migrations()
