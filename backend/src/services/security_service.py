"""SecurityService: the admin's Security page — signed-in devices and the activity log.

The page opens only after the admin types their password again ("unlock"), which returns a
short-lived unlock token (15 minutes, bound to this device). Wrong passwords count toward the
normal account lockout, so a borrowed, signed-in browser can't guess its way in.
"""

from __future__ import annotations

import hashlib
import time
from datetime import date
from typing import Any

from core import realtime
from core.clock import iso_z
from core.errors import Forbidden, NotFound, ValidationFailed
from models.domain import ROLE_BY_ID, ROLE_IDS
from repositories.security import SecurityRepository
from repositories.users import UserRepository
from security.activity import CATEGORIES, device_label
from security.tokens import TokenError, create_token, decode_token

from .auth_service import ROLE_LABELS, AuthService, forget_device, forget_user
from .context import Ctx

UNLOCK_MINUTES = 15
LOCKED = "SECURITY_LOCKED"


def _unlock_secret(jwt_secret: str) -> str:
    return hashlib.sha256(f"security-unlock:{jwt_secret}".encode()).hexdigest()


def check_unlock(token: str | None, ctx: Ctx) -> None:
    """The X-Security-Unlock header must be a fresh unlock for this admin on this device."""
    if not token or not ctx.user:
        raise Forbidden("Enter your password to open the Security page.", code=LOCKED)
    try:
        claims = decode_token(token, _unlock_secret(ctx.config.jwt_secret), now=int(time.time()))
    except TokenError:
        raise Forbidden("The Security page locked again. Enter your password to continue.", code=LOCKED) from None
    if claims.get("purpose") != "security" or claims.get("sub") != str(ctx.user.id) or claims.get("sid") != ctx.user.session_id:
        raise Forbidden("Enter your password to open the Security page.", code=LOCKED)


def _who(row: dict[str, Any]) -> dict[str, Any]:
    role = ROLE_BY_ID.get(row.get("role_id") or 0)
    return {
        "name": row.get("name"),
        "role": role,
        "login": row.get("member_code") or row.get("email") or row.get("phone"),
    }


class SecurityService:
    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx
        self.repo = SecurityRepository(ctx.db)

    async def unlock(self, password: str) -> dict[str, Any]:
        user = self.ctx.user
        assert user is not None
        row = await UserRepository(self.ctx.db).get(user.id)
        if not row or not await AuthService(self.ctx)._check_password(row, password):
            self.ctx.log("SECURITY_UNLOCK_FAILED", "Wrong password when opening the Security page", category="Security")
            raise ValidationFailed("That password is incorrect.", fields={"password": "Incorrect password"})
        expires = int(time.time()) + UNLOCK_MINUTES * 60
        claims = {"sub": str(user.id), "sid": user.session_id, "purpose": "security", "exp": expires}
        self.ctx.log("SECURITY_UNLOCKED", "Opened the Security page", category="Security")
        return {"token": create_token(claims, _unlock_secret(self.ctx.config.jwt_secret)), "expires_at": expires}

    async def overview(self) -> dict[str, Any]:
        now = self.ctx.now
        counts = {ROLE_BY_ID[r["role_id"]]: r for r in await self.repo.active_counts(now)}
        roles = [
            {"role": role, "label": ROLE_LABELS[role], "devices": counts.get(role, {}).get("devices", 0),
             "people": counts.get(role, {}).get("people", 0)}
            for role in ("ADMIN", "STAFF", "TRAINER", "MEMBER")
        ]
        today = await self.repo.sign_ins_since(self.ctx.clock.day_start_utc(self.ctx.clock.today()))
        return {
            "online": len(await realtime.online_sessions(self.ctx.env)),
            "devices": sum(r["devices"] for r in roles),
            "people": sum(r["people"] for r in roles),
            "roles": roles,
            "today": {"sign_ins": today.get("logins", 0), "people": today.get("people", 0), "failed": today.get("failed", 0)},
            "categories": list(CATEGORIES),
            "unlock_minutes": UNLOCK_MINUTES,
        }

    async def sessions(self, page: Any, *, role: str | None, q: str | None) -> dict[str, Any]:
        rows, total = await self.repo.active_sessions(
            self.ctx.now, role_id=ROLE_IDS.get(role) if role else None, q=q, limit=page.limit, offset=page.offset,
        )
        current = self.ctx.user.session_id if self.ctx.user else None
        online = await realtime.online_sessions(self.ctx.env)
        items = [
            {
                "id": r["id"],
                "user_id": r["user_id"],
                **_who(r),
                "device": device_label(r["user_agent"]) or "Unknown device",
                "user_agent": r["user_agent"],
                "ip": r["ip"],
                "signed_in_at": iso_z(r["created_at"]),
                "last_active_at": iso_z(r["last_seen_at"]),
                "expires_at": iso_z(r["expires_at"]),
                "current": r["id"] == current,
                # The app is open on this device right now (live connection).
                "online": r["id"] in online,
                "location": {
                    "lat": r["lat"], "lng": r["lng"], "accuracy_m": r["accuracy_m"], "at": iso_z(r["located_at"]),
                } if r["lat"] is not None else None,
                "place": ", ".join(p for p in (r["city"], r["region"], r["country"]) if p) or None,
            }
            for r in rows
        ]
        return page.wrap(items, total)

    async def sign_out_device(self, session_id: int) -> None:
        device = await self.repo.active_session(session_id, self.ctx.now)
        if not device:
            raise NotFound("That device is already signed out.")
        if self.ctx.user and session_id == self.ctx.user.session_id:
            raise ValidationFailed("This is the device you're using. Use Sign out in the menu instead.")
        await self.repo.end_session(session_id, "SIGNED_OUT_BY_ADMIN", self.ctx.now)
        forget_device(session_id)
        self.ctx.live(realtime.message([f"sid:{session_id}"], {"type": "signed_out"}, close=True))
        who = await UserRepository(self.ctx.db).get(device["user_id"])
        self.ctx.log("DEVICE_SIGNED_OUT", "Signed out a device", category="Security", target=who["name"] if who else None)

    async def sign_out_person(self, user_id: int) -> int:
        """Every device of one person (their next request asks them to sign in again)."""
        users = UserRepository(self.ctx.db)
        who = await users.get(user_id)
        if not who:
            raise NotFound("User not found.")
        if self.ctx.user and user_id == self.ctx.user.id:
            raise ValidationFailed("To sign yourself out everywhere, use Account → Sign out everywhere.")
        await users.bump_token_version(user_id)
        result = await self.ctx.db.run(*self.repo.end_user_sessions_stmt(user_id, "SIGNED_OUT_BY_ADMIN", self.ctx.now))
        forget_user(user_id)
        self.ctx.live(realtime.message([f"user:{user_id}"], {"type": "signed_out"}, close=True))
        self.ctx.log("PERSON_SIGNED_OUT", "Signed out every device of a person", category="Security", target=who["name"])
        return result.changes

    async def activity(self, page: Any, *, start: date | None, end: date | None, category: str | None, role: str | None,
                       user_id: int | None, q: str | None) -> dict[str, Any]:
        if category and category not in CATEGORIES and category != "Other":
            raise ValidationFailed("Unknown activity type.", fields={"category": "Unknown type"})
        clock = self.ctx.clock
        rows, total = await self.repo.activity(
            start=clock.day_start_utc(start) if start else None,
            end=clock.day_range_utc(end, end)[1] if end else None,
            category=category, user_id=user_id, role_id=ROLE_IDS.get(role) if role else None, q=q,
            limit=page.limit, offset=page.offset,
        )
        items = [
            {
                "id": r["id"],
                "at": iso_z(r["at"]),
                "user_id": r["user_id"],
                "name": r["name"],
                "role": ROLE_BY_ID.get(r["role_id"] or 0),
                "action": r["action"],
                "category": r["category"],
                "summary": r["summary"],
                "target": r["target"],
                "ip": r["ip"],
                "device": r["device"],
            }
            for r in rows
        ]
        return page.wrap(items, total)
