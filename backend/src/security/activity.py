"""The activity log: who did what, when, from which device.

Two sources feed it:
- every successful change made through the API (POST / PUT / DELETE) by a signed-in person is
  recorded by the edge middleware, labelled from ROUTES below, and
- sign-in events that have no signed-in person yet (sign-in, failed sign-in, sign-out) are
  added by AuthService through ``Ctx.log``.

Request bodies are never stored (they can hold passwords); only a member id from the body is
used to name who the change was about (or the typed name of something new).
"""

from __future__ import annotations

import json
import re
from typing import Any

from core.database import Statement

# (method, route) -> (action, category, what happened)
ROUTES: dict[tuple[str, str], tuple[str, str, str]] = {
    ("POST", "/api/attendance/scan"): ("ATTENDANCE_SCAN", "Attendance", "Scanned a QR check-in / check-out"),
    ("POST", "/api/attendance"): ("ATTENDANCE_MANUAL", "Attendance", "Marked attendance by hand"),
    ("DELETE", "/api/attendance/{attendance_id}"): ("ATTENDANCE_DELETED", "Attendance", "Deleted an attendance entry"),
    ("POST", "/api/backups"): ("BACKUP_CREATED", "Data", "Created a backup"),
    ("POST", "/api/backups/{backup_id}/verify"): ("BACKUP_VERIFIED", "Data", "Verified a backup"),
    ("POST", "/api/backups/{backup_id}/archive"): ("BACKUP_ARCHIVED", "Data", "Archived old records after a backup"),
    ("POST", "/api/backups/{backup_id}/cancel"): ("BACKUP_CANCELLED", "Data", "Cancelled a backup"),
    ("POST", "/api/backups/restore/check"): ("RESTORE_CHECKED", "Data", "Checked a backup file for restore"),
    ("POST", "/api/backups/restore/apply"): ("RESTORE_APPLIED", "Data", "Restored data from a backup"),
    ("POST", "/api/backups/restore/complete"): ("RESTORE_COMPLETED", "Data", "Finished a restore"),
    ("POST", "/api/storage/time-travel/restore"): ("TIME_TRAVEL", "Data", "Restored the database to an earlier time"),
    ("POST", "/api/expenses"): ("EXPENSE_ADDED", "Expenses", "Added an expense"),
    ("PUT", "/api/expenses/{expense_id}"): ("EXPENSE_UPDATED", "Expenses", "Edited an expense"),
    ("DELETE", "/api/expenses/{expense_id}"): ("EXPENSE_DELETED", "Expenses", "Deleted an expense"),
    ("POST", "/api/members"): ("MEMBER_ADDED", "Members", "Added a member"),
    ("PUT", "/api/members/{member_id}"): ("MEMBER_UPDATED", "Members", "Edited member details"),
    ("POST", "/api/members/{member_id}/status"): ("MEMBER_STATUS", "Members", "Changed a member's status"),
    ("POST", "/api/members/{member_id}/trainer"): ("MEMBER_TRAINER", "Members", "Assigned a trainer"),
    ("POST", "/api/members/{member_id}/report/link"): ("MEMBER_REPORT_SHARED", "Members", "Shared a member report link"),
    ("POST", "/api/members/{member_id}/qr/reset"): ("MEMBER_QR_RESET", "Members", "Reset a member's QR pass"),
    ("POST", "/api/members/{member_id}/app-access"): ("MEMBER_APP_ACCESS", "Members", "Gave or reset member app access"),
    ("DELETE", "/api/members/{member_id}/app-access"): ("MEMBER_APP_REVOKED", "Members", "Removed member app access"),
    ("POST", "/api/memberships/{membership_id}/cancel"): ("MEMBERSHIP_CANCELLED", "Payments", "Cancelled a membership"),
    ("POST", "/api/payments"): ("PAYMENT_RECORDED", "Payments", "Recorded a payment"),
    ("POST", "/api/payments/{payment_id}/approve"): ("PAYMENT_APPROVED", "Payments", "Approved a UPI payment"),
    ("POST", "/api/payments/{payment_id}/reject"): ("PAYMENT_REJECTED", "Payments", "Rejected a UPI payment"),
    ("POST", "/api/payments/{payment_id}/refund"): ("PAYMENT_REFUNDED", "Payments", "Recorded a refund"),
    ("POST", "/api/membership-plans"): ("PLAN_ADDED", "Plans", "Added a membership plan"),
    ("PUT", "/api/membership-plans/{plan_id}"): ("PLAN_UPDATED", "Plans", "Edited a membership plan"),
    ("PUT", "/api/me/profile"): ("PROFILE_UPDATED", "Member app", "Updated their profile"),
    ("POST", "/api/me/renewals"): ("RENEWAL_SUBMITTED", "Member app", "Submitted a UPI renewal"),
    ("DELETE", "/api/me/renewals/pending"): ("RENEWAL_WITHDRAWN", "Member app", "Withdrew a pending renewal"),
    ("POST", "/api/messages/test"): ("MESSAGE_TEST", "Messages", "Sent a test message"),
    ("POST", "/api/notifications/send"): ("OFFER_SENT", "Messages", "Sent an offer / announcement"),
    ("POST", "/api/notifications/run-reminders"): ("REMINDERS_RUN", "Messages", "Ran expiry reminders"),
    ("POST", "/api/progress/{member_id}"): ("PROGRESS_ADDED", "Workouts", "Recorded body measurements"),
    ("DELETE", "/api/progress/entries/{measurement_id}"): ("PROGRESS_DELETED", "Workouts", "Deleted a measurement"),
    ("POST", "/api/workouts"): ("WORKOUT_ADDED", "Workouts", "Created a workout plan"),
    ("PUT", "/api/workouts/{plan_id}"): ("WORKOUT_UPDATED", "Workouts", "Edited a workout plan"),
    ("POST", "/api/workouts/{plan_id}/copy"): ("WORKOUT_COPIED", "Workouts", "Copied a workout plan"),
    ("DELETE", "/api/workouts/{plan_id}"): ("WORKOUT_DELETED", "Workouts", "Deleted a workout plan"),
    ("PUT", "/api/settings"): ("SETTINGS_CHANGED", "Settings", "Changed gym settings"),
    ("POST", "/api/trainers"): ("TRAINER_ADDED", "Team", "Added a trainer"),
    ("PUT", "/api/trainers/{trainer_id}"): ("TRAINER_UPDATED", "Team", "Edited a trainer"),
    ("POST", "/api/trainers/{trainer_id}/status"): ("TRAINER_STATUS", "Team", "Changed a trainer's status"),
    ("POST", "/api/trainers/{trainer_id}/account"): ("TRAINER_ACCOUNT", "Team", "Gave or reset a trainer's login"),
    ("POST", "/api/trainers/{trainer_id}/members"): ("TRAINER_MEMBERS", "Team", "Changed a trainer's members"),
    ("POST", "/api/users"): ("USER_ADDED", "Team", "Added a team login"),
    ("PUT", "/api/users/{user_id}"): ("USER_UPDATED", "Team", "Edited a team login"),
    ("POST", "/api/users/{user_id}/status"): ("USER_STATUS", "Team", "Enabled or disabled a team login"),
    ("POST", "/api/users/{user_id}/reset-password"): ("USER_PASSWORD_RESET", "Team", "Reset a team member's password"),
}

CATEGORIES = ("Sign-in", "Security", "Members", "Payments", "Attendance", "Plans", "Workouts", "Expenses",
              "Messages", "Member app", "Team", "Settings", "Data")

# Who / what a change was about, from the route's id (one cheap sub-select, no extra round trip).
_TARGETS: dict[str, str] = {
    "member_id": "SELECT name || ' · ' || member_code FROM members WHERE id = ?",
    "payment_id": "SELECT m.name || ' · ' || p.payment_number FROM payments p JOIN members m ON m.id = p.member_id WHERE p.id = ?",
    "membership_id": "SELECT m.name || ' · ' || m.member_code FROM memberships s JOIN members m ON m.id = s.member_id WHERE s.id = ?",
    "attendance_id": "SELECT m.name || ' · ' || m.member_code FROM attendance a JOIN members m ON m.id = a.member_id WHERE a.id = ?",
    "measurement_id": "SELECT m.name || ' · ' || m.member_code FROM body_measurements b JOIN members m ON m.id = b.member_id WHERE b.id = ?",
    "trainer_id": "SELECT name FROM trainers WHERE id = ?",
    "user_id": "SELECT name FROM users WHERE id = ?",
    "expense_id": "SELECT category || ' · ' || printf('%.2f', amount / 100.0) FROM expenses WHERE id = ?",
}
_PLAN_TARGETS = {
    "/api/membership-plans/": "SELECT name FROM membership_plans WHERE id = ?",
    "/api/workouts/": "SELECT title FROM workout_plans WHERE id = ?",
}
_SKIP = {"/api/notifications/read-all", "/api/notifications/{notification_id}/read", "/api/storage/refresh"}


def device_label(user_agent: str | None) -> str | None:
    """'Chrome on Android', 'Safari on iPhone', 'Edge on Windows' ..."""
    ua = user_agent or ""
    if not ua:
        return None
    if "iPhone" in ua:
        os_name = "iPhone"
    elif "iPad" in ua:
        os_name = "iPad"
    elif "Android" in ua:
        os_name = "Android"
    elif "Windows" in ua:
        os_name = "Windows"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        os_name = "Mac"
    elif "CrOS" in ua:
        os_name = "Chromebook"
    elif "Linux" in ua:
        os_name = "Linux"
    else:
        os_name = ""
    for marker, name in (("EdgA/", "Edge"), ("Edg/", "Edge"), ("SamsungBrowser", "Samsung Internet"), ("OPR/", "Opera"),
                         ("Firefox/", "Firefox"), ("FxiOS", "Firefox"), ("CriOS", "Chrome"), ("Chrome/", "Chrome"),
                         ("Safari/", "Safari")):
        if marker in ua:
            browser = name
            break
    else:
        browser = re.split(r"[/ ]", ua, maxsplit=1)[0][:30] or "Browser"
    return f"{browser} on {os_name}" if os_name else browser


def mask_login(identifier: str) -> str:
    """A typed login, shortened for the log: 'GYM000123' -> 'GYM•••', 'riyaz@x.in' -> 'ri•••@x.in'."""
    text = (identifier or "").strip()[:60]
    if "@" in text:
        user, domain = text.split("@", 1)
        return f"{user[:2]}•••@{domain}"
    return f"{text[:3]}•••" if len(text) > 3 else "•••"


def entry(*, at: str, user_id: int | None, action: str, category: str, summary: str, target: str | None = None,
          ip: str | None = None, user_agent: str | None = None, session_id: int | None = None) -> dict[str, Any]:
    return {"at": at, "user_id": user_id, "action": action, "category": category, "summary": summary[:200],
            "target": target[:200] if target else None, "ip": (ip or None) and ip[:64],
            "device": device_label(user_agent), "session_id": session_id, "target_sql": None, "target_id": None}


def from_request(*, method: str, route: str | None, path_params: dict[str, Any], body: bytes, status: int,
                 user: Any, at: str, ip: str | None, user_agent: str | None) -> dict[str, Any] | None:
    """The log entry for a successful API change, or None for reads, failures and routine clicks."""
    if route and not route.startswith("/api/"):
        route = "/api" + route  # the routers are mounted under /api
    if not route or status >= 400 or route in _SKIP or route.startswith("/api/auth/") or route.startswith("/api/security/"):
        return None
    label = ROUTES.get((method, route))
    if label is None:
        action, category, summary = f"{method} {route}"[:40], "Other", f"{method.title()} {route}"
    else:
        action, category, summary = label
    row = entry(at=at, user_id=user.id, action=action, category=category, summary=summary, ip=ip, user_agent=user_agent,
                session_id=getattr(user, "session_id", None))
    for key, sql in _TARGETS.items():
        if key in path_params:
            row["target_sql"], row["target_id"] = sql, path_params[key]
            break
    else:
        if "plan_id" in path_params:
            for prefix, sql in _PLAN_TARGETS.items():
                if route.startswith(prefix):
                    row["target_sql"], row["target_id"] = sql, path_params["plan_id"]
        elif body:
            try:
                data = json.loads(body)
            except ValueError:
                data = None
            data = data if isinstance(data, dict) else {}
            if isinstance(data.get("member_id"), int):
                row["target_sql"], row["target_id"] = _TARGETS["member_id"], data["member_id"]
            elif isinstance(data.get("name") or data.get("title"), str):
                # A new member / trainer / plan / workout is named by what was typed (never other fields).
                row["target"] = str(data.get("name") or data.get("title")).strip()[:200] or None
    return row


def insert_stmt(row: dict[str, Any]) -> Statement:
    params = [row["at"], row["user_id"], row["action"], row["category"], row["summary"], row["target"], row["ip"],
              row["device"], row["session_id"]]
    target = "?6"
    if row.get("target_sql"):
        params.append(row["target_id"])
        target = f"COALESCE(?6, ({row['target_sql'].replace('?', '?10')}))"
    return (
        "INSERT INTO activity_log (at, user_id, action, category, summary, target, ip, device, session_id) "
        f"VALUES (?1, ?2, ?3, ?4, ?5, {target}, ?7, ?8, ?9)",
        params,
    )
