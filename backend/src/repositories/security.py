"""SecurityRepository: signed-in devices (sessions) and the activity log."""

from __future__ import annotations

from typing import Any

from .base import Binder, Repository, Statement, where

# A device is signed in while its session hasn't ended or expired and the account still accepts
# its token (a password change, "sign out everywhere" or a disabled account bump token_version).
_ACTIVE = "s.ended_at IS NULL AND s.expires_at > ?1 AND s.token_version = u.token_version AND u.status = 'ACTIVE'"
_WHO = (
    "u.name, u.role_id, u.email, u.phone, "
    "(SELECT m.member_code FROM members m WHERE m.user_id = u.id) AS member_code"
)


class SecurityRepository(Repository):
    # -- sessions ------------------------------------------------------------------------------------
    async def start_session(self, *, user_id: int, token_version: int, now: str, expires_at: str, ip: str | None,
                            user_agent: str | None) -> int:
        result = await self.db.run(
            "INSERT INTO sessions (user_id, token_version, created_at, last_seen_at, expires_at, ip, user_agent) "
            "VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6) RETURNING id",
            [user_id, token_version, now, expires_at, ip, user_agent],
        )
        return result.first["id"]

    async def get_session(self, session_id: int) -> dict[str, Any] | None:
        return await self.db.one(
            "SELECT id, user_id, token_version, last_seen_at, expires_at, ended_at FROM sessions WHERE id = ?1", [session_id]
        )

    async def touch(self, session_id: int, now: str, ip: str | None) -> None:
        await self.db.run(
            "UPDATE sessions SET last_seen_at = ?2, ip = COALESCE(?3, ip) WHERE id = ?1 AND ended_at IS NULL", [session_id, now, ip]
        )

    async def end_session(self, session_id: int, reason: str, now: str) -> int:
        result = await self.db.run(
            "UPDATE sessions SET ended_at = ?3, end_reason = ?2 WHERE id = ?1 AND ended_at IS NULL", [session_id, reason, now]
        )
        return result.changes

    def end_user_sessions_stmt(self, user_id: int, reason: str, now: str, keep: int | None = None) -> Statement:
        return (
            "UPDATE sessions SET ended_at = ?3, end_reason = ?2 WHERE user_id = ?1 AND ended_at IS NULL AND id != COALESCE(?4, 0)",
            [user_id, reason, now, keep],
        )

    async def active_session(self, session_id: int, now: str) -> dict[str, Any] | None:
        return await self.db.one(
            f"SELECT s.id, s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?2 AND {_ACTIVE}",
            [now, session_id],
        )

    async def active_counts(self, now: str) -> list[dict[str, Any]]:
        return await self.db.all(
            "SELECT u.role_id, COUNT(*) AS devices, COUNT(DISTINCT s.user_id) AS people "
            f"FROM sessions s JOIN users u ON u.id = s.user_id WHERE {_ACTIVE} GROUP BY u.role_id",
            [now],
        )

    async def active_sessions(self, now: str, *, role_id: int | None, q: str | None, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
        bind = Binder([now])
        clauses = [_ACTIVE]
        if role_id:
            clauses.append(f"u.role_id = {bind(role_id)}")
        if q:
            like = bind(f"%{q.strip().lower()}%")
            clauses.append(
                f"(lower(u.name) LIKE {like} OR lower(COALESCE(u.email, '')) LIKE {like} OR COALESCE(u.phone, '') LIKE {like} "
                f"OR lower(COALESCE((SELECT m.member_code FROM members m WHERE m.user_id = u.id), '')) LIKE {like})"
            )
        sql_where = where(clauses)
        results = await self.db.batch([
            (
                f"SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent, {_WHO} "
                f"FROM sessions s JOIN users u ON u.id = s.user_id {sql_where} "
                f"ORDER BY s.last_seen_at DESC, s.id DESC LIMIT {bind(limit)} OFFSET {bind(offset)}",
                bind.params,
            ),
            (f"SELECT COUNT(*) AS c FROM sessions s JOIN users u ON u.id = s.user_id {sql_where}", bind.params[:-2]),
        ])
        return results[0].rows, int(results[1].first["c"])

    # -- activity ------------------------------------------------------------------------------------
    async def activity(self, *, start: str | None, end: str | None, category: str | None, user_id: int | None,
                       role_id: int | None, q: str | None, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
        bind = Binder()
        clauses: list[str] = []
        if start:
            clauses.append(f"a.at >= {bind(start)}")
        if end:
            clauses.append(f"a.at < {bind(end)}")
        if category:
            clauses.append(f"a.category = {bind(category)}")
        if user_id:
            clauses.append(f"a.user_id = {bind(user_id)}")
        if role_id:
            clauses.append(f"u.role_id = {bind(role_id)}")
        if q:
            like = bind(f"%{q.strip().lower()}%")
            clauses.append(
                f"(lower(a.summary) LIKE {like} OR lower(COALESCE(a.target, '')) LIKE {like} OR lower(COALESCE(u.name, '')) LIKE {like})"
            )
        sql_where = where(clauses)
        results = await self.db.batch([
            (
                "SELECT a.id, a.at, a.user_id, a.action, a.category, a.summary, a.target, a.ip, a.device, a.session_id, "
                f"u.name, u.role_id FROM activity_log a LEFT JOIN users u ON u.id = a.user_id {sql_where} "
                f"ORDER BY a.at DESC, a.id DESC LIMIT {bind(limit)} OFFSET {bind(offset)}",
                bind.params,
            ),
            (f"SELECT COUNT(*) AS c FROM activity_log a LEFT JOIN users u ON u.id = a.user_id {sql_where}", bind.params[:-2]),
        ])
        return results[0].rows, int(results[1].first["c"])

    async def sign_ins_since(self, start: str) -> dict[str, int]:
        row = await self.db.one(
            "SELECT COALESCE(SUM(action = 'LOGIN'), 0) AS logins, COALESCE(SUM(action = 'LOGIN_FAILED'), 0) AS failed, "
            "COUNT(DISTINCT CASE WHEN action = 'LOGIN' THEN user_id END) AS people "
            "FROM activity_log WHERE category = 'Sign-in' AND at >= ?1",
            [start],
        )
        return {k: int(v or 0) for k, v in (row or {}).items()}

    async def cleanup(self, activity_before: str, sessions_before: str) -> int:
        results = await self.db.batch([
            ("DELETE FROM activity_log WHERE at < ?1", [activity_before]),
            ("DELETE FROM sessions WHERE COALESCE(ended_at, expires_at) < ?1", [sessions_before]),
        ])
        return sum(r.changes for r in results)
