"""Single source of truth for who counts as an admin.

Previously duplicated independently in backend/auth.py and
webportal/backend/main.py (and, on the frontend, in
frontend/src/utils/auth.js and frontend/src/pages/ActualPortfolio.jsx).
"""

# The permanent floor: these three can never be demoted/removed via the
# "make admin" UI, no matter what the DB says -- a safety net against ever
# locking every admin out of the app at once.
_BASE_ADMIN_EMAILS = frozenset({
    "jay.chaudhari@niveshaay.com",
    "nukul.madaan@niveshaay.com",
    "nakshatra.rathi@niveshaay.com",
})

# Mutated in place (never reassigned) so every module that already did
# `from common.admin import ADMIN_EMAILS` sees a promotion/demotion immediately,
# the same pattern webportal/backend/persistence.py uses for BASKET_DISPLAY_NAMES.
ADMIN_EMAILS = set(_BASE_ADMIN_EMAILS)


def is_admin_email(email: str) -> bool:
    if not email:
        return False
    return email.lower().strip() in ADMIN_EMAILS


def sync_promoted_admins(emails) -> None:
    """Add DB-promoted admin emails to the live ADMIN_EMAILS set. Called once
    at startup with every allowed_emails row that has is_admin=1, and again
    whenever an admin promotes someone -- so the new admin's access is
    effective immediately, no restart needed."""
    ADMIN_EMAILS.update(e.lower().strip() for e in emails if e)


def demote_admin(email: str) -> bool:
    """Remove a promoted admin's access. Refuses to touch the permanent base
    admins even if asked -- returns False in that case instead of raising,
    since this is a plain safety guard, not a real error condition."""
    email = (email or "").lower().strip()
    if email in _BASE_ADMIN_EMAILS:
        return False
    ADMIN_EMAILS.discard(email)
    return True
