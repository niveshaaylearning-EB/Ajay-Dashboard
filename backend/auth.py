"""
Authentication — password-based login with OTP email verification.
JWT tokens expire at 11:59 PM IST or 24 hours from login, whichever is earlier.
"""
import os
import hashlib as _hashlib_pw
import hashlib as _hl
import uuid as _uuid
from datetime import datetime, timedelta, timezone
import threading
import base64 as _b64
import urllib.request as _ur
import json as _json
import re as _re

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Request, Header
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional
from slowapi import Limiter
from slowapi.util import get_remote_address

import io
import secrets
import string
import hashlib
import json
import pyotp
def generate_totp_secret() -> str:
    """Generate a random Base32 secret for TOTP (Google Authenticator)."""
    return pyotp.random_base32()

def generate_totp_qr_svg(email: str, secret: str) -> str:
    """
    Generate an SVG QR code for TOTP provisioning.
    Returns the SVG content as a string.
    """
    # Create the provisioning URI
    uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=email.strip().lower(),
        issuer_name="Niveshaay Equity Basket Tracker"
    )
    
    # Generate SVG QR code using path-based factory (most compatible with browsers)
    import qrcode, qrcode.image.svg
    factory = qrcode.image.svg.SvgPathImage
    img = qrcode.make(uri, image_factory=factory, box_size=10, border=2)

    buf = io.BytesIO()
    img.save(buf)
    svg = buf.getvalue().decode("utf-8")

    # Add explicit dimensions so the browser renders it correctly
    if 'width=' not in svg:
        svg = svg.replace('<svg ', '<svg width="200" height="200" ', 1)

    return svg

def verify_totp_token(secret: str, token: str) -> bool:
    """
    Verify a 6-digit TOTP token against the secret.
    Allows for clock drift of +/- 1 time step (30 seconds).
    """
    if not secret or not token:
        return False
    
    # Clean token (only digits, strip whitespaces)
    clean_token = "".join(c for c in str(token) if c.isdigit())
    if len(clean_token) != 6:
        return False
        
    totp = pyotp.TOTP(secret)
    # valid_window=1 allows verification of codes from 30 seconds ago/ahead
    return totp.verify(clean_token, valid_window=1)

def generate_backup_codes(count: int = 8) -> tuple[list[str], list[str]]:
    """
    Generate random single-use backup recovery codes.
    Returns:
      - raw_codes: List of strings (e.g. ['ABCD-1234', ...]) to show to the user.
      - hashed_codes: List of hex-encoded SHA-256 hashes to store in the database.
    """
    raw_codes = []
    hashed_codes = []
    chars = string.ascii_uppercase + string.digits
    for _ in range(count):
        # Format: XXXX-XXXX
        part1 = "".join(secrets.choice(chars) for _ in range(4))
        part2 = "".join(secrets.choice(chars) for _ in range(4))
        code = f"{part1}-{part2}"
        raw_codes.append(code)
        
        # Normalize and hash with SHA-256
        normalized = code.upper().replace("-", "").strip()
        hashed = hashlib.sha256(normalized.encode()).hexdigest()
        hashed_codes.append(hashed)
        
    return raw_codes, hashed_codes

def verify_and_consume_backup_code(stored_codes_json: str | None, submitted_code: str) -> tuple[bool, str | None]:
    """
    Check if a submitted backup recovery code is valid and unused.
    If valid, consumes the code and returns (True, updated_codes_json).
    Otherwise returns (False, None).
    """
    if not stored_codes_json or not submitted_code:
        return False, None
        
    try:
        hashes_list = json.loads(stored_codes_json)
        if not isinstance(hashes_list, list):
            return False, None
    except Exception:
        return False, None
        
    # Normalize and hash the submitted code
    normalized = submitted_code.upper().replace("-", "").strip()
    submitted_hash = hashlib.sha256(normalized.encode()).hexdigest()
    
    if submitted_hash in hashes_list:
        # Code is valid! Consume it by removing it from the list
        hashes_list.remove(submitted_hash)
        return True, json.dumps(hashes_list)
        
    return False, None

from common.admin import ADMIN_EMAILS, is_admin_email  # noqa: F401 (re-exported for existing imports)

# ── Rate limiter (attached to app in main.py) ─────────────────────────────────
_limiter = Limiter(key_func=get_remote_address)

# ── In-memory security state ──────────────────────────────────────────────────
# Revoked JTIs — cleared on restart but tokens are short-lived (4h) so acceptable
_revoked_jtis: set = set()

# Failed login tracking — {email: {"count": int, "locked_until": float}}
_failed_logins: dict = {}

# Single source of truth for all credentials: the repo-root .env (not
# backend/.env) -- explicit path so this resolves the same regardless of
# the process's current working directory.
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'))

# ── Config ────────────────────────────────────────────────────────────────────
ALLOWED_DOMAIN = os.environ.get("ALLOWED_DOMAIN", "niveshaay.com")
ADMIN_EMAIL    = os.environ.get("ADMIN_EMAIL",    "jay.chaudhari@niveshaay.com")

JWT_SECRET     = os.environ.get("JWT_SECRET")
if not JWT_SECRET:
    raise RuntimeError(
        "JWT_SECRET is not set. Add it to backend/.env -- refusing to start with "
        "no signing secret, since a guessable default baked into source code "
        "would let anyone forge valid login tokens."
    )
JWT_ALGORITHM  = "HS256"

# ── Pydantic models ───────────────────────────────────────────────────────────
class LoginRequest(BaseModel):
    email:     str
    latitude:  Optional[float] = None
    longitude: Optional[float] = None

class VerifyEnrollRequest(BaseModel):
    code: str

class VerifyTotpRequest(BaseModel):
    code: str
    latitude:  Optional[float] = None
    longitude: Optional[float] = None

# ── Helpers ───────────────────────────────────────────────────────────────────
import urllib.request
import json as _json

def get_location_from_ip(ip: str) -> str:
    if not ip or ip in ("127.0.0.1", "::1", "localhost"):
        return "Local"
    try:
        with urllib.request.urlopen(f"http://ip-api.com/json/{ip}", timeout=3) as r:
            d = _json.loads(r.read().decode())
            if d.get("status") == "success":
                parts = [d.get("city",""), d.get("regionName",""), d.get("country","")]
                return ", ".join(p for p in parts if p) or "Unknown"
    except Exception:
        pass
    return "Unknown"

def _now_iso() -> str:
    return datetime.utcnow().isoformat()

def create_token(email: str, first_name: str = "") -> str:
    """4-hour access token with unique JTI (used for single-token flows like TOTP)."""
    jti  = str(_uuid.uuid4())
    exp  = datetime.utcnow() + timedelta(hours=4)
    payload: dict = {"sub": email, "exp": exp, "jti": jti}
    if first_name:
        payload["fn"] = first_name
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def _create_session_tokens(email: str, first_name: str, db,
                            device_info: str = None, ip: str = None, location: str = None) -> dict:
    """Create a 4-hour access token + 7-day refresh token and persist the session."""
    from database import ActiveSession
    jti = str(_uuid.uuid4())
    exp = datetime.utcnow() + timedelta(hours=4)
    payload: dict = {"sub": email, "exp": exp, "jti": jti}
    if first_name:
        payload["fn"] = first_name
    access_token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

    import secrets as _sec
    refresh_raw = _sec.token_urlsafe(48)
    refresh_hash = _hl.sha256(refresh_raw.encode()).hexdigest()
    try:
        db.add(ActiveSession(
            jti=jti, email=email, refresh_token=refresh_hash,
            device_info=(device_info or "")[:200],
            ip_address=ip, location=location,
            created_at=_now_iso(), last_seen_at=_now_iso(), is_active=1,
        ))
        db.commit()
    except Exception:
        try: db.rollback()
        except: pass
    return {"token": access_token, "refresh_token": refresh_raw, "jti": jti}

def verify_token(token: str) -> str:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        email   = payload.get("sub")
        if not email:
            raise ValueError
        jti = payload.get("jti")
        if jti and jti in _revoked_jtis:
            raise HTTPException(status_code=401, detail="Session revoked. Please log in again.")
        return email
    except HTTPException:
        raise
    except (JWTError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid or expired token. Please log in again.")

def create_temp_token(email: str) -> str:
    """Create a short-lived temporary token for 2FA verification flow."""
    exp = datetime.utcnow() + timedelta(minutes=10)
    return jwt.encode({"sub": email, "type": "temp_2fa", "exp": exp}, JWT_SECRET, algorithm=JWT_ALGORITHM)

def verify_temp_token(token: str) -> str:
    """Verify the 2FA temporary token and return the associated email."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "temp_2fa":
            raise ValueError
        email = payload.get("sub")
        if not email:
            raise ValueError
        return email
    except (JWTError, ValueError):
        raise HTTPException(status_code=401, detail="Session expired. Please start login again.")

def get_location_from_ip_safe(ip):
    try:
        return get_location_from_ip(ip)
    except Exception:
        return "Unknown"

def _push_login():
    """Background task to write login_history.json locally and push to GitHub."""
    try:
        from database import SessionLocal, LoginHistory
        db = SessionLocal()
        rows = db.query(LoginHistory).order_by(LoginHistory.id.desc()).limit(500).all()
        data = [{
            "email": r.email,
            "logged_at": r.logged_at,
            "ip_address": r.ip_address,
            "location": r.location
        } for r in rows]
        db.close()
        
        import os as _os
        content = _json.dumps(data, indent=2)
        
        # Write to local file first
        json_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "login_history.json")
        with open(json_path, "w", encoding="utf-8") as f:
            f.write(content)

        token = os.environ.get("GITHUB_TOKEN","")
        repo  = os.environ.get("GITHUB_REPO","")
        if not token or not repo:
            return

        api = f"https://api.github.com/repos/{repo}/contents/backend/login_history.json"
        hdrs = {"Authorization":f"Bearer {token}","Accept":"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28"}
        try:
            sha = _json.loads(_ur.urlopen(_ur.Request(api,headers=hdrs),timeout=8).read())["sha"]
        except Exception:
            sha = None
        body = _json.dumps({"message":"auto: login event","content":_b64.b64encode(content.encode()).decode(),**( {"sha":sha} if sha else {})}).encode()
        _ur.urlopen(_ur.Request(api,data=body,headers=hdrs,method="PUT"),timeout=10)
    except Exception as e:
        print(f"[login-push] {e}")

def _push_allowed_emails():
    """Background task to write allowed_emails_data.json locally and push to GitHub."""
    try:
        from database import SessionLocal, AllowedEmail
        db = SessionLocal()
        rows = db.query(AllowedEmail).all()
        data = [{
            "email":         r.email,
            "added_by":      r.added_by,
            "added_at":      r.added_at,
            "totp_secret":   r.totp_secret,
            "totp_enabled":  r.totp_enabled,
            "backup_codes":  r.backup_codes,
            "first_name":    r.first_name,
            "last_name":     r.last_name,
            "password_hash": r.password_hash,
            "is_approved":   r.is_approved if r.is_approved is not None else 1,
        } for r in rows]
        db.close()
        
        import os as _os
        content = _json.dumps(data, indent=2)
        
        # Write to local file first
        json_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "allowed_emails_data.json")
        with open(json_path, "w", encoding="utf-8") as f:
            f.write(content)
            
        token = os.environ.get("GITHUB_TOKEN","")
        repo  = os.environ.get("GITHUB_REPO","")
        if not token or not repo:
            return

        api = f"https://api.github.com/repos/{repo}/contents/backend/allowed_emails_data.json"
        hdrs = {"Authorization":f"Bearer {token}","Accept":"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28"}
        try:
            sha = _json.loads(_ur.urlopen(_ur.Request(api,headers=hdrs),timeout=8).read())["sha"]
        except Exception:
            sha = None
        body = _json.dumps({"message":"auto: update allowed emails TOTP","content":_b64.b64encode(content.encode()).decode(),**( {"sha":sha} if sha else {})}).encode()
        _ur.urlopen(_ur.Request(api,data=body,headers=hdrs,method="PUT"),timeout=10)
    except Exception as e:
        print(f"[allowed-emails-push] {e}")

# ── HaveIBeenPwned check ──────────────────────────────────────────────────────
def _is_pwned_password(password: str) -> bool:
    """k-anonymity lookup — only first 5 SHA1 chars leave the server."""
    try:
        sha1  = _hl.sha1(password.encode("utf-8")).hexdigest().upper()
        prefix, suffix = sha1[:5], sha1[5:]
        req = _ur.Request(
            f"https://api.pwnedpasswords.com/range/{prefix}",
            headers={"User-Agent": "NIA-PwdCheck/1.0", "Add-Padding": "true"},
        )
        with _ur.urlopen(req, timeout=5) as r:
            for line in r.read().decode().splitlines():
                h, _ = line.split(":")
                if h == suffix:
                    return True
    except Exception:
        pass  # network error → don't block the user
    return False


# ── Audit log helper ──────────────────────────────────────────────────────────
def _log_audit(email: str, event_type: str, details: str = None,
               ip: str = None, location: str = None):
    """Add an audit log entry and push to GitHub in a background thread."""
    def _work():
        try:
            from database import SessionLocal, AuditLog
            db = SessionLocal()
            db.add(AuditLog(user_email=email, event_type=event_type, details=details,
                            created_at=_now_iso(), ip_address=ip, location=location))
            db.commit()
            rows = db.query(AuditLog).order_by(AuditLog.id.desc()).limit(300).all()
            data = [{"user_email": r.user_email, "event_type": r.event_type,
                     "details": r.details, "created_at": r.created_at,
                     "ip_address": r.ip_address, "location": r.location} for r in rows]
            db.close()
            import os as _os
            content = _json.dumps(data, indent=2)
            path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "audit_log.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            token = os.environ.get("GITHUB_TOKEN", "")
            repo  = os.environ.get("GITHUB_REPO", "")
            if not token or not repo:
                return
            api = f"https://api.github.com/repos/{repo}/contents/backend/audit_log.json"
            hdrs = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                    "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"}
            try:
                sha = _json.loads(_ur.urlopen(_ur.Request(api, headers=hdrs), timeout=8).read())["sha"]
            except Exception:
                sha = None
            body = _json.dumps({"message": "auto: audit log",
                                 "content": _b64.b64encode(content.encode()).decode(),
                                 **( {"sha": sha} if sha else {})}).encode()
            _ur.urlopen(_ur.Request(api, data=body, headers=hdrs, method="PUT"), timeout=10)
        except Exception as e:
            print(f"[audit-log] {e}")
    threading.Thread(target=_work, daemon=True).start()


# ── Email OTP ─────────────────────────────────────────────────────────────────
import secrets
import time as _time
import hmac as _hmac_lib
import hashlib as _hashlib

SMTP_FROM      = os.environ.get("SMTP_FROM",      "communication@niveshaay.com")
SMTP_PASSWORD  = os.environ.get("SMTP_PASSWORD",  "")
BREVO_API_KEY  = os.environ.get("BREVO_API_KEY",  "")

# In-memory fallback so OTP verify still works even if DB write failed
# { email: {"code": str, "ts": float, "used": bool} }
_otp_mem: dict = {}

def _generate_otp() -> str:
    return str(secrets.randbelow(900000) + 100000)

# HMAC-based stateless OTP — survives container restarts and multi-worker deployments
_OTP_SECRET = os.environ.get("OTP_SECRET", "") or JWT_SECRET

def _hmac_otp(email: str, minute: int) -> str:
    """Deterministic 6-digit code for (email, UTC-minute). Same result on every worker."""
    key = _OTP_SECRET.encode()
    msg = f"{email}:{minute}".encode()
    h = _hmac_lib.new(key, msg, _hashlib.sha256).hexdigest()
    return str(int(h[-8:], 16) % 900000 + 100000)

def _otp_for_email(email: str) -> str:
    """OTP valid for the current UTC minute (+ window on verify)."""
    return _hmac_otp(email, int(_time.time() // 60))

def _verify_hmac_otp(email: str, code: str, window_minutes: int = 15) -> bool:
    """Returns True if code matches any minute in [now-window, now]."""
    minute = int(_time.time() // 60)
    for offset in range(window_minutes + 1):
        if _hmac_lib.compare_digest(_hmac_otp(email, minute - offset), code):
            return True
    return False

def send_email_otp(to_email: str, code: str):
    """Send OTP via Outlook SMTP (smtp.office365.com:587)."""
    import smtplib
    from email.mime.text import MIMEText
    print(f"[EMAIL-OTP] Code for {to_email}: {code}")   # always log as fallback
    if not SMTP_PASSWORD:
        # Fallback to Brevo if SMTP_PASSWORD not set
        if not BREVO_API_KEY:
            raise RuntimeError("Neither SMTP_PASSWORD nor BREVO_API_KEY is configured")
        import requests as _req
        resp = _req.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={"api-key": BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json"},
            json={
                "sender":      {"email": SMTP_FROM, "name": "Niveshaay Equity Basket Tracker"},
                "to":          [{"email": to_email}],
                "subject":     f"NIA Login Code: {code}",
                "textContent": (
                    f"Hello,\n\nYour Niveshaay Equity Basket Tracker login code is:\n\n    {code}\n\n"
                    f"This code expires in 10 minutes.\nIf you didn't request this, ignore this email.\n\n— NIA Tech Team"
                ),
            },
            timeout=10,
        )
        resp.raise_for_status()
        print(f"[EMAIL-OTP] Email sent via Brevo to {to_email}")
        return

    body = (
        f"Hello,\n\n"
        f"Your Niveshaay Equity Basket Tracker login code is:\n\n"
        f"    {code}\n\n"
        f"This code expires in 10 minutes.\n"
        f"If you didn't request this, ignore this email.\n\n"
        f"— NIA Tech Team"
    )
    msg = MIMEText(body)
    msg["Subject"] = f"NIA Login Code: {code}"
    msg["From"]    = SMTP_FROM
    msg["To"]      = to_email

    with smtplib.SMTP("smtp.office365.com", 587, timeout=15) as s:
        s.ehlo()
        s.starttls()
        s.ehlo()  # must re-identify after STARTTLS
        s.login(SMTP_FROM, SMTP_PASSWORD)
        s.sendmail(SMTP_FROM, [to_email], msg.as_string())
    print(f"[EMAIL-OTP] Email sent via Outlook to {to_email}")


# ── FastAPI dependency ─────────────────────────────────────────────────────────
_bearer = HTTPBearer(auto_error=False)

def get_current_user(creds: HTTPAuthorizationCredentials = Depends(_bearer)) -> str:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return verify_token(creds.credentials)

# ── Router ─────────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/direct-login")
def direct_login(body: LoginRequest, request: Request,
                 db: Session = Depends(lambda: __import__('database').SessionLocal())):
    from database import AllowedEmail, LoginHistory
    email = body.email.lower().strip()

    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        raise HTTPException(status_code=403, detail=f"Only @{ALLOWED_DOMAIN} email addresses are allowed.")

    # Auto-seed allowed email if missing (any @niveshaay.com is allowed now)
    allowed = db.query(AllowedEmail).filter_by(email=email).first()
    if not allowed:
        from datetime import datetime
        allowed = AllowedEmail(email=email, added_by="system", added_at=datetime.utcnow().isoformat())
        db.add(allowed)
        db.commit()
        # Sync to disk & GitHub in background
        threading.Thread(target=_push_allowed_emails, daemon=True).start()

    # Add LoginHistory
    ip = request.client.host if request.client else None
    loc = get_location_from_ip_safe(ip)
    try:
        db.add(LoginHistory(email=email, logged_at=_now_iso(), ip_address=ip, location=loc))
        db.commit()
        # Sync login history in background
        threading.Thread(target=_push_login, daemon=True).start()
    except Exception:
        pass

    return {"token": create_token(email), "email": email}


@router.post("/totp/enroll")
def totp_enroll(authorization: str = Header(...),
                db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Initialize TOTP enrollment for a user. Returns secret and QR code SVG."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header.")
    temp_token = authorization.split(" ", 1)[1]
    email = verify_temp_token(temp_token)
    
    from database import AllowedEmail
    allowed = db.query(AllowedEmail).filter_by(email=email).first()
    if not allowed:
        raise HTTPException(status_code=404, detail="User not found.")
        
    # Create temporary secret (enabled remains 0)
    secret = generate_totp_secret()
    allowed.totp_secret = secret
    allowed.totp_enabled = 0
    db.commit()
    
    # Sync AllowedEmail JSON to disk & GitHub
    threading.Thread(target=_push_allowed_emails, daemon=True).start()
    
    # Generate QR code SVG
    qr_svg = generate_totp_qr_svg(email, secret)
    
    return {
        "secret": secret,
        "qr_svg": qr_svg
    }


@router.post("/totp/verify-enroll")
def totp_verify_enroll(body: VerifyEnrollRequest,
                      authorization: str = Header(...),
                      db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Verify first TOTP token to activate 2FA and get backup recovery codes."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header.")
    temp_token = authorization.split(" ", 1)[1]
    email = verify_temp_token(temp_token)
    
    from database import AllowedEmail
    allowed = db.query(AllowedEmail).filter_by(email=email).first()
    if not allowed or not allowed.totp_secret:
        raise HTTPException(status_code=400, detail="2FA enrollment has not been initialized.")
        
    # Verify token
    if not verify_totp_token(allowed.totp_secret, body.code):
        raise HTTPException(status_code=400, detail="Invalid verification code. Scan the QR code again.")
        
    # Activation: generate recovery codes, mark enabled
    raw_codes, hashed_codes = generate_backup_codes()
    allowed.totp_enabled = 1
    allowed.backup_codes = _json.dumps(hashed_codes)
    db.commit()
    
    # Sync AllowedEmail JSON
    threading.Thread(target=_push_allowed_emails, daemon=True).start()
    
    # Log successful login to history
    from database import LoginHistory
    ip = None
    loc = "Local"
    try:
        db.add(LoginHistory(email=email, logged_at=_now_iso(), ip_address=ip, location=loc))
        db.commit()
        threading.Thread(target=_push_login, daemon=True).start()
    except Exception:
        pass
        
    return {
        "status": "enabled",
        "token": create_token(email),
        "email": email,
        "backup_codes": raw_codes
    }


@router.post("/totp/verify")
def totp_verify(body: VerifyTotpRequest,
                request: Request,
                authorization: str = Header(...),
                db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Verify 6-digit TOTP token or 8-character backup recovery code to log in."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header.")
    temp_token = authorization.split(" ", 1)[1]
    email = verify_temp_token(temp_token)
    
    from database import AllowedEmail, LoginHistory
    allowed = db.query(AllowedEmail).filter_by(email=email).first()
    if not allowed or allowed.totp_enabled != 1 or not allowed.totp_secret:
        raise HTTPException(status_code=400, detail="2FA is not enabled for this user.")
        
    code_str = body.code.strip()
    is_valid = False
    used_backup = False
    
    # Check if 6-digit TOTP code
    if len(code_str) == 6 and code_str.isdigit():
        if verify_totp_token(allowed.totp_secret, code_str):
            is_valid = True
    # Otherwise check if single-use recovery code
    else:
        is_valid, updated_codes = verify_and_consume_backup_code(allowed.backup_codes, code_str)
        if is_valid:
            allowed.backup_codes = updated_codes
            used_backup = True
            
    if not is_valid:
        raise HTTPException(status_code=401, detail="Invalid or expired verification code.")
        
    # Log successful login
    ip = request.client.host if request.client else None
    loc = get_location_from_ip_safe(ip)
    
    now_str = _now_iso()
    try:
        db.add(LoginHistory(email=email, logged_at=now_str, ip_address=ip, location=loc))
        db.commit()
    except Exception:
        pass
        
    # Sync logins
    threading.Thread(target=_push_login, daemon=True).start()
    
    # Sync backup code consumption
    if used_backup:
        threading.Thread(target=_push_allowed_emails, daemon=True).start()
        
    return {
        "token": create_token(email),
        "email": email
    }


@router.get("/me")
def me(current_user: str = Depends(get_current_user)):
    return {"email": current_user, "is_admin": is_admin_email(current_user)}


@router.post("/logout")
def logout(request: Request,
           db: Session = Depends(lambda: __import__('database').SessionLocal())):
    from database import AuditLog, ActiveSession
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        try:
            raw_token = auth_header.split(" ", 1)[1]
            payload = jwt.decode(raw_token, JWT_SECRET, algorithms=[JWT_ALGORITHM],
                                 options={"verify_exp": False})
            email = payload.get("sub", "")
            jti   = payload.get("jti")
            ip    = request.client.host if request.client else None
            # Revoke in-memory and in DB
            if jti:
                _revoked_jtis.add(jti)
                sess = db.query(ActiveSession).filter_by(jti=jti).first()
                if sess:
                    sess.is_active = 0
            db.add(AuditLog(user_email=email, event_type="logout",
                            details=None, created_at=_now_iso(),
                            ip_address=ip, location=get_location_from_ip_safe(ip)))
            db.commit()
        except Exception:
            pass
    return {"status": "logged_out"}


# ── Email OTP Endpoints ────────────────────────────────────────────────────────

class EmailOtpRequest(BaseModel):
    email: str

class EmailOtpVerify(BaseModel):
    email: str
    code:  str

class RegisterRequest(BaseModel):
    first_name: str
    last_name:  str
    email:      str

class RegisterVerifyRequest(BaseModel):
    first_name: str
    last_name:  str
    email:      str
    password:   str = ""
    code:       str = ""

class PasswordLoginRequest(BaseModel):
    email:    str
    password: str = ""
    latitude:  Optional[float] = None
    longitude: Optional[float] = None

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    email:        str
    code:         str
    new_password: str

class AdminRegistrationAction(BaseModel):
    email: str


@router.post("/request-email-otp")
def request_email_otp(body: EmailOtpRequest,
                       db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Send a 6-digit OTP to the user's email. Public endpoint — no token needed."""
    try:
        from database import AllowedEmail
        email = body.email.lower().strip()

        if not email.endswith(f"@{ALLOWED_DOMAIN}"):
            raise HTTPException(400, detail=f"Only @{ALLOWED_DOMAIN} emails allowed.")

        # Admin always allowed; others must be pre-approved
        if email != ADMIN_EMAIL:
            try:
                allowed = db.query(AllowedEmail).filter_by(email=email).first()
            except Exception:
                allowed = None
            if not allowed:
                raise HTTPException(403, detail="Your email is not approved. Request access from the login page.")

        # Use HMAC-based OTP: same code on any worker, no shared state needed
        code = _otp_for_email(email)

        # Also store in memory (backup for same-worker verify)
        _otp_mem[email] = {"code": code, "ts": _time.time(), "used": False}

        # Store in DB (works across workers); wrapped so a DB hiccup never returns 500
        try:
            from database import OtpCode
            db.query(OtpCode).filter(OtpCode.email == email).delete()
            db.add(OtpCode(email=email, code=code, created_at=datetime.utcnow().isoformat(), used=0))
            db.commit()
        except Exception as db_err:
            print(f"[EMAIL-OTP] DB store failed for {email}: {db_err} — using memory fallback")
            try:
                db.rollback()
            except Exception:
                pass
    except HTTPException:
        raise
    except Exception as outer_err:
        # Last resort: still generate and send a code so user is never stuck
        print(f"[EMAIL-OTP] Outer error for {getattr(body, 'email', '?')}: {outer_err}")
        try:
            email = body.email.lower().strip()
            code  = _otp_for_email(email)
            _otp_mem[email] = {"code": code, "ts": _time.time(), "used": False}
        except Exception:
            return {"status": "error", "message": "Service starting up. Please try again in 30 seconds."}

    # Run SMTP in a thread with a hard timeout so a slow/wrong server
    # never blocks the endpoint for more than 12 seconds.
    import concurrent.futures as _cf
    email_sent = False
    email_error = ""
    try:
        with _cf.ThreadPoolExecutor(max_workers=1) as _pool:
            _pool.submit(send_email_otp, email, code).result(timeout=12)
        email_sent = True
    except _cf.TimeoutError:
        email_error = "SMTP timed out"
        print(f"[EMAIL-OTP] Timed out for {email}")
    except Exception as e:
        email_error = str(e)
        print(f"[EMAIL-OTP] Failed for {email}: {e}")

    if email_sent:
        return {"status": "sent", "message": f"OTP sent to {email}. Check your inbox."}
    else:
        # Email failed — return code directly (admin fallback) + show hint
        return {
            "status": "sent",
            "message": f"Email delivery failed. Your OTP code is: {code}",
            "code": code,   # shown on screen so user can still log in
            "error": email_error,
        }


@router.post("/verify-email-otp")
def verify_email_otp(body: EmailOtpVerify, request: Request,
                      db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Verify the email OTP and return a JWT token."""
    from database import LoginHistory, OtpCode
    email = body.email.lower().strip()
    code  = body.code.strip()

    cutoff = (datetime.utcnow() - timedelta(minutes=10)).isoformat()
    record = db.query(OtpCode).filter(
        OtpCode.email == email,
        OtpCode.code  == code,
        OtpCode.used  == 0,
        OtpCode.created_at >= cutoff,
    ).first()

    # Fallback 1: in-memory (same worker, covers DB-write failures)
    mem_hit = False
    if not record:
        mem = _otp_mem.get(email)
        if (mem and mem["code"] == code and not mem["used"]
                and (_time.time() - mem["ts"]) < 600):
            mem_hit = True

    # Fallback 2: HMAC stateless check (works across workers and container restarts)
    hmac_hit = False
    if not record and not mem_hit:
        hmac_hit = _verify_hmac_otp(email, code)

    if not record and not mem_hit and not hmac_hit:
        raise HTTPException(401, detail="Invalid or expired OTP. Please request a new one.")

    # Mark as used in DB and memory to prevent replay
    if record:
        record.used = 1
        try:
            db.commit()
        except Exception:
            pass
    if email in _otp_mem:
        _otp_mem[email]["used"] = True
    # For HMAC hits: store a "used" marker so same code can't replay on this worker
    if hmac_hit:
        _otp_mem[email] = {"code": code, "ts": _time.time(), "used": True}

    ip  = request.client.host if request.client else None
    loc = get_location_from_ip_safe(ip)
    try:
        db.add(LoginHistory(email=email, logged_at=_now_iso(), ip_address=ip, location=loc))
        db.commit()
    except Exception:
        pass

    # Push login history in background
    threading.Thread(target=_push_login, daemon=True).start()

    return {"token": create_token(email), "email": email}


@router.get("/test-smtp")
def test_smtp():
    """Test email sending — returns success or detailed error. Admin debug only."""
    to = ADMIN_EMAIL
    try:
        send_email_otp(to, "123456")
        return {"ok": True, "msg": f"Test email sent to {to}", "smtp_password_set": bool(SMTP_PASSWORD), "brevo_key_set": bool(BREVO_API_KEY)}
    except Exception as e:
        return {"ok": False, "error": str(e), "smtp_password_set": bool(SMTP_PASSWORD), "brevo_key_set": bool(BREVO_API_KEY)}


# ── Password helpers ──────────────────────────────────────────────────────────

import re as _re

def _hash_password(password: str) -> str:
    """PBKDF2-SHA256 with random salt. Returns 'salt_hex:key_hex'."""
    import os as _os
    salt = _os.urandom(32)
    key  = _hashlib_pw.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return salt.hex() + ":" + key.hex()

def _verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, key_hex = stored.split(":")
        salt = bytes.fromhex(salt_hex)
        key  = _hashlib_pw.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
        return key.hex() == key_hex
    except Exception:
        return False

def _validate_password(password: str) -> str | None:
    """Returns an error message string if invalid, None if valid."""
    if len(password) < 8:
        return "Password must be at least 8 characters."
    if not _re.search(r"[A-Z]", password):
        return "Password must contain at least one uppercase letter."
    if not _re.search(r"[0-9]", password):
        return "Password must contain at least one number."
    if not _re.search(r"[^A-Za-z0-9]", password):
        return "Password must contain at least one special character."
    return None


# ── Generic email helper ──────────────────────────────────────────────────────

def _send_email(to_email: str, subject: str, body: str):
    """Send a plain-text email via Brevo. Raises on failure."""
    if not BREVO_API_KEY:
        raise RuntimeError("BREVO_API_KEY not configured")
    import requests as _req
    resp = _req.post(
        "https://api.brevo.com/v3/smtp/email",
        headers={"api-key": BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json"},
        json={
            "sender": {"email": SMTP_FROM, "name": "Niveshaay Equity Basket Tracker"},
            "to": [{"email": to_email}],
            "subject": subject,
            "textContent": body,
        },
        timeout=10,
    )
    resp.raise_for_status()

def _notify_admins_new_registration(first_name: str, last_name: str, email: str):
    """Email all admins when a new self-registered user is pending approval."""
    subject = f"[NIA] New registration pending approval — {email}"
    body = (
        f"Hello,\n\n"
        f"A new user has registered and is waiting for your approval:\n\n"
        f"  Name : {first_name} {last_name}\n"
        f"  Email: {email}\n\n"
        f"Log in to the Niveshaay Equity Basket Tracker and go to Approved Login Emails to approve or reject.\n\n"
        f"— NIA Tech Team"
    )
    for admin in ADMIN_EMAILS:
        try:
            _send_email(admin, subject, body)
        except Exception as e:
            print(f"[NOTIFY-ADMIN] Failed to email {admin}: {e}")

def _notify_user_approved(email: str, first_name: str):
    """Email user when their registration is approved."""
    try:
        _send_email(
            email,
            "Your Niveshaay Equity Basket Tracker account has been approved",
            f"Hi {first_name},\n\n"
            f"Your Niveshaay Equity Basket Tracker account has been approved. You can now log in.\n\n"
            f"— NIA Tech Team",
        )
    except Exception as e:
        print(f"[NOTIFY-USER-APPROVED] {e}")

def _notify_user_rejected(email: str, first_name: str):
    """Email user when their registration is rejected."""
    try:
        _send_email(
            email,
            "Niveshaay Equity Basket Tracker — registration not approved",
            f"Hi {first_name},\n\n"
            f"Your registration request could not be approved at this time.\n"
            f"Please contact your NIA administrator if you think this is a mistake.\n\n"
            f"— NIA Tech Team",
        )
    except Exception as e:
        print(f"[NOTIFY-USER-REJECTED] {e}")


# ── Registration ──────────────────────────────────────────────────────────────

@router.post("/register")
@_limiter.limit("5/minute")
def register(request: Request, body: RegisterRequest,
             db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Request access: add to DB as pending, admin approves before they can log in."""
    from database import AllowedEmail
    email = body.email.lower().strip()
    fn    = body.first_name.strip()
    ln    = body.last_name.strip()

    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        raise HTTPException(400, detail=f"Only @{ALLOWED_DOMAIN} email addresses are allowed.")
    if not fn or not ln:
        raise HTTPException(400, detail="First name and last name are required.")

    existing = db.query(AllowedEmail).filter_by(email=email).first()
    if existing and existing.is_approved:
        raise HTTPException(409, detail="An account with this email already exists. Please log in.")

    ip = request.client.host if request.client else None

    if existing:
        existing.first_name = fn
        existing.last_name  = ln
    else:
        db.add(AllowedEmail(
            email=email, added_by="self-registered",
            added_at=datetime.utcnow().isoformat(),
            first_name=fn, last_name=ln,
            is_approved=0,
        ))
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(500, detail="Could not save request. Please try again.")

    threading.Thread(target=_push_allowed_emails, daemon=True).start()
    _log_audit(email, "registration_requested", f"{fn} {ln} requested access", ip)
    return {"status": "pending_approval", "message": "Access request submitted. An admin will review and approve your account."}


@router.post("/register/complete")
def register_complete(body: RegisterVerifyRequest,
                      db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Step 2: verify OTP and create the account."""
    from database import AllowedEmail, OtpCode
    email = body.email.lower().strip()
    code  = body.code.strip()

    err = _validate_password(body.password)
    if err:
        raise HTTPException(400, detail=err)

    # Verify OTP (same three-tier check)
    cutoff = (datetime.utcnow() - timedelta(minutes=10)).isoformat()
    record = db.query(OtpCode).filter(
        OtpCode.email == email, OtpCode.code == code,
        OtpCode.used == 0, OtpCode.created_at >= cutoff,
    ).first()
    mem_hit  = False
    hmac_hit = False
    if not record:
        mem = _otp_mem.get(email)
        if mem and mem["code"] == code and not mem["used"] and (_time.time() - mem["ts"]) < 600:
            mem_hit = True
    if not record and not mem_hit:
        hmac_hit = _verify_hmac_otp(email, code)
    if not record and not mem_hit and not hmac_hit:
        raise HTTPException(401, detail="Invalid or expired code. Please request a new one.")

    # Mark OTP used
    if record:
        record.used = 1
        try: db.commit()
        except: pass
    if email in _otp_mem:
        _otp_mem[email]["used"] = True

    # HaveIBeenPwned check
    if _is_pwned_password(body.password):
        raise HTTPException(400, detail="This password has appeared in a known data breach. Please choose a different password.")

    # Create or update account
    existing  = db.query(AllowedEmail).filter_by(email=email).first()
    pw_hash   = _hash_password(body.password)
    fn        = body.first_name.strip()
    ln        = body.last_name.strip()
    # Pre-added by admin → auto-approve; brand-new self-registration → needs approval
    auto_approved = 1 if (existing and existing.is_approved) else 0
    if existing:
        existing.first_name    = fn
        existing.last_name     = ln
        existing.password_hash = pw_hash
        existing.is_approved   = auto_approved
    else:
        db.add(AllowedEmail(
            email=email, added_by="self-registered",
            added_at=datetime.utcnow().isoformat(),
            first_name=fn, last_name=ln, password_hash=pw_hash,
            is_approved=0,
        ))
        auto_approved = 0
    try:
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(500, detail="Could not save account. Please try again.")

    threading.Thread(target=_push_allowed_emails, daemon=True).start()
    _log_audit(email, "registration_completed", f"{fn} {ln} registered (auto_approved={auto_approved})")

    if auto_approved:
        tokens = _create_session_tokens(email, fn, db)
        return {"status": "registered", **tokens, "email": email,
                "first_name": fn, "last_name": ln}
    else:
        threading.Thread(
            target=_notify_admins_new_registration, args=(fn, ln, email), daemon=True
        ).start()
        return {"status": "pending_approval",
                "message": "Your account is pending admin approval. You'll receive an email once approved."}


# ── Password login ────────────────────────────────────────────────────────────

@router.post("/login")
@_limiter.limit("10/minute")
def otp_login(request: Request, body: PasswordLoginRequest,
              db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Step 1 of OTP login: validate email, check approval, send OTP."""
    from database import AllowedEmail, OtpCode
    import concurrent.futures as _cf
    email = body.email.lower().strip()
    ip    = request.client.host if request.client else None

    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        raise HTTPException(400, detail=f"Only @{ALLOWED_DOMAIN} email addresses are allowed.")

    user = db.query(AllowedEmail).filter_by(email=email).first()
    if not user:
        raise HTTPException(401, detail="No account found with this email. Please register first.")
    if not user.is_approved:
        raise HTTPException(403, detail="Your account is pending admin approval. You'll be notified when access is granted.")

    # Generate and store OTP
    code = _otp_for_email(email)
    _otp_mem[email] = {"code": code, "ts": _time.time(), "used": False}
    try:
        db.query(OtpCode).filter(OtpCode.email == email).delete()
        db.add(OtpCode(email=email, code=code, created_at=datetime.utcnow().isoformat(), used=0))
        db.commit()
    except Exception:
        try: db.rollback()
        except: pass

    # Send OTP email
    email_sent = False
    try:
        with _cf.ThreadPoolExecutor(max_workers=1) as _pool:
            _pool.submit(send_email_otp, email, code).result(timeout=12)
        email_sent = True
    except Exception as ex:
        print(f"[OTP-LOGIN] Email failed for {email}: {ex}")

    _log_audit(email, "otp_requested", f"Login OTP requested", ip)
    return {
        "status": "otp_sent",
        "email": email,
        "message": f"A login code has been sent to {email}." if email_sent else f"Email failed. Code: {code}",
        **({"code": code} if not email_sent else {}),
    }


# ── Forgot / reset password ───────────────────────────────────────────────────

@router.post("/forgot-password")
@_limiter.limit("5/minute")
def forgot_password(request: Request, body: ForgotPasswordRequest,
                    db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Send OTP to reset password. Works for any registered @niveshaay.com email."""
    from database import AllowedEmail
    email = body.email.lower().strip()

    if not email.endswith(f"@{ALLOWED_DOMAIN}"):
        raise HTTPException(400, detail=f"Only @{ALLOWED_DOMAIN} email addresses are allowed.")

    user = db.query(AllowedEmail).filter_by(email=email).first()
    if not user:
        # Don't reveal if email exists; still return success to prevent enumeration
        return {"status": "otp_sent", "message": f"If that email is registered, a code has been sent."}

    code = _otp_for_email(email)
    _otp_mem[email] = {"code": code, "ts": _time.time(), "used": False}
    try:
        from database import OtpCode
        db.query(OtpCode).filter(OtpCode.email == email).delete()
        db.add(OtpCode(email=email, code=code, created_at=datetime.utcnow().isoformat(), used=0))
        db.commit()
    except Exception:
        try: db.rollback()
        except: pass

    import concurrent.futures as _cf
    email_sent = False
    try:
        with _cf.ThreadPoolExecutor(max_workers=1) as _pool:
            _pool.submit(send_email_otp, email, code).result(timeout=12)
        email_sent = True
    except Exception as e:
        print(f"[FORGOT-PW] Email failed for {email}: {e}")

    if email_sent:
        return {"status": "otp_sent", "message": f"Password reset code sent to {email}."}
    else:
        return {"status": "otp_sent", "message": f"Email delivery failed. Your code: {code}", "code": code}


@router.post("/reset-password")
def reset_password(body: ResetPasswordRequest,
                   db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Verify OTP and set new password."""
    from database import AllowedEmail, OtpCode
    email = body.email.lower().strip()
    code  = body.code.strip()

    err = _validate_password(body.new_password)
    if err:
        raise HTTPException(400, detail=err)

    # Verify OTP
    cutoff = (datetime.utcnow() - timedelta(minutes=10)).isoformat()
    record = db.query(OtpCode).filter(
        OtpCode.email == email, OtpCode.code == code,
        OtpCode.used == 0, OtpCode.created_at >= cutoff,
    ).first()
    mem_hit  = False
    hmac_hit = False
    if not record:
        mem = _otp_mem.get(email)
        if mem and mem["code"] == code and not mem["used"] and (_time.time() - mem["ts"]) < 600:
            mem_hit = True
    if not record and not mem_hit:
        hmac_hit = _verify_hmac_otp(email, code)
    if not record and not mem_hit and not hmac_hit:
        raise HTTPException(401, detail="Invalid or expired code. Please request a new one.")

    if record:
        record.used = 1
        try: db.commit()
        except: pass
    if email in _otp_mem:
        _otp_mem[email]["used"] = True

    user = db.query(AllowedEmail).filter_by(email=email).first()
    if not user:
        raise HTTPException(404, detail="Account not found.")

    # HaveIBeenPwned check
    if _is_pwned_password(body.new_password):
        raise HTTPException(400, detail="This password has appeared in a known data breach. Please choose a different password.")

    user.password_hash = _hash_password(body.new_password)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(500, detail="Could not update password. Please try again.")

    threading.Thread(target=_push_allowed_emails, daemon=True).start()
    _log_audit(email, "password_changed", "Password reset via OTP")
    return {"status": "password_reset", "message": "Password updated successfully. You can now log in."}


# ── Admin: registration approvals ─────────────────────────────────────────────

@router.get("/admin/pending-registrations")
def admin_pending_registrations(
    current_user: str = Depends(get_current_user),
    db: Session = Depends(lambda: __import__('database').SessionLocal()),
):
    if not is_admin_email(current_user):
        raise HTTPException(403, detail="Admin only")
    from database import AllowedEmail
    # NOTE: the actual registration UI (LoginPage.jsx) only calls /register
    # (name + email, no password) and never /register/complete, so rows from
    # real self-registrations never have password_hash set. Filtering on
    # password_hash != None here made every real request invisible to admins.
    rows = db.query(AllowedEmail).filter(
        AllowedEmail.is_approved == 0
    ).order_by(AllowedEmail.added_at.desc()).all()
    return [{"email": r.email, "first_name": r.first_name or "", "last_name": r.last_name or "",
             "added_at": r.added_at} for r in rows]


@router.post("/admin/approve-registration")
def admin_approve_registration(
    body: AdminRegistrationAction,
    current_user: str = Depends(get_current_user),
    db: Session = Depends(lambda: __import__('database').SessionLocal()),
):
    if not is_admin_email(current_user):
        raise HTTPException(403, detail="Admin only")
    from database import AllowedEmail
    email = body.email.lower().strip()
    user  = db.query(AllowedEmail).filter_by(email=email).first()
    if not user:
        raise HTTPException(404, detail="User not found")
    user.is_approved = 1
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(500, detail="DB error")
    threading.Thread(target=_push_allowed_emails, daemon=True).start()
    threading.Thread(
        target=_notify_user_approved, args=(email, user.first_name or ""), daemon=True
    ).start()
    _log_audit(current_user, "admin_approved_user", f"Approved registration for {email}")
    return {"status": "approved", "email": email}


@router.post("/admin/reject-registration")
def admin_reject_registration(
    body: AdminRegistrationAction,
    current_user: str = Depends(get_current_user),
    db: Session = Depends(lambda: __import__('database').SessionLocal()),
):
    if not is_admin_email(current_user):
        raise HTTPException(403, detail="Admin only")
    from database import AllowedEmail
    email = body.email.lower().strip()
    if is_admin_email(email):
        raise HTTPException(400, detail="Cannot reject an admin account")
    user = db.query(AllowedEmail).filter_by(email=email).first()
    if not user:
        raise HTTPException(404, detail="User not found")
    fn = user.first_name or ""
    db.delete(user)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(500, detail="DB error")
    threading.Thread(target=_push_allowed_emails, daemon=True).start()
    threading.Thread(
        target=_notify_user_rejected, args=(email, fn), daemon=True
    ).start()
    _log_audit(current_user, "admin_rejected_user", f"Rejected registration for {email}")
    return {"status": "rejected", "email": email}


# ── Refresh token endpoint ────────────────────────────────────────────────────

class RefreshRequest(BaseModel):
    refresh_token: str

@router.post("/refresh")
def refresh_access_token(body: RefreshRequest, request: Request,
                         db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Exchange a valid refresh token for a new access token + rotated refresh token."""
    from database import ActiveSession, AllowedEmail
    import secrets as _sec
    token_hash = _hl.sha256(body.refresh_token.encode()).hexdigest()
    session = db.query(ActiveSession).filter_by(
        refresh_token=token_hash, is_active=1
    ).first()
    if not session:
        raise HTTPException(401, detail="Invalid or expired refresh token. Please log in again.")

    # 7-day expiry check
    try:
        created = datetime.fromisoformat(session.created_at)
        if datetime.utcnow() - created > timedelta(days=7):
            session.is_active = 0
            db.commit()
            raise HTTPException(401, detail="Session expired. Please log in again.")
    except HTTPException:
        raise
    except Exception:
        pass

    user = db.query(AllowedEmail).filter_by(email=session.email).first()
    fn = (user.first_name or "") if user else ""

    # Rotate: revoke old session, issue new tokens
    _revoked_jtis.add(session.jti)
    session.is_active = 0
    db.commit()

    ip  = request.client.host if request.client else None
    loc = session.location
    tokens = _create_session_tokens(session.email, fn, db,
                                     device_info=session.device_info, ip=ip, location=loc)
    return {**tokens, "email": session.email, "first_name": fn}


# ── Active session management ─────────────────────────────────────────────────

@router.get("/sessions")
def list_sessions(current_user: str = Depends(get_current_user),
                  db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """List all active sessions for the current user."""
    from database import ActiveSession
    rows = db.query(ActiveSession).filter_by(
        email=current_user, is_active=1
    ).order_by(ActiveSession.created_at.desc()).all()
    return [{"jti": r.jti, "device_info": r.device_info, "ip_address": r.ip_address,
             "location": r.location, "created_at": r.created_at,
             "last_seen_at": r.last_seen_at} for r in rows]


@router.delete("/sessions/{jti}")
def revoke_session(jti: str, current_user: str = Depends(get_current_user),
                   db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Revoke a specific session (can only revoke own sessions)."""
    from database import ActiveSession
    sess = db.query(ActiveSession).filter_by(jti=jti, email=current_user).first()
    if not sess:
        raise HTTPException(404, detail="Session not found.")
    _revoked_jtis.add(jti)
    sess.is_active = 0
    db.commit()
    _log_audit(current_user, "session_revoked", f"Revoked session {jti[:8]}…")
    return {"status": "revoked"}


@router.delete("/sessions")
def revoke_all_other_sessions(request: Request,
                               current_user: str = Depends(get_current_user),
                               db: Session = Depends(lambda: __import__('database').SessionLocal())):
    """Revoke all sessions except the current one."""
    from database import ActiveSession
    auth_header = request.headers.get("Authorization", "")
    current_jti = None
    if auth_header.startswith("Bearer "):
        try:
            payload = jwt.decode(auth_header.split(" ", 1)[1], JWT_SECRET,
                                  algorithms=[JWT_ALGORITHM], options={"verify_exp": False})
            current_jti = payload.get("jti")
        except Exception:
            pass
    rows = db.query(ActiveSession).filter_by(email=current_user, is_active=1).all()
    count = 0
    for r in rows:
        if r.jti != current_jti:
            _revoked_jtis.add(r.jti)
            r.is_active = 0
            count += 1
    db.commit()
    _log_audit(current_user, "sessions_revoked_all", f"Revoked {count} other session(s)")
    return {"status": "revoked", "count": count}

