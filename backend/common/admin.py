"""Single source of truth for who counts as an admin.

Previously duplicated independently in backend/auth.py and
webportal/backend/main.py (and, on the frontend, in
frontend/src/utils/auth.js and frontend/src/pages/ActualPortfolio.jsx).
"""

ADMIN_EMAILS = {
    "jay.chaudhari@niveshaay.com",
    "nukul.madaan@niveshaay.com",
    "nakshatra.rathi@niveshaay.com",
}


def is_admin_email(email: str) -> bool:
    if not email:
        return False
    return email.lower().strip() in ADMIN_EMAILS
