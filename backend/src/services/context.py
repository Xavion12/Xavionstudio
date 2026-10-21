"""Per-request service context: database, clock, config, the signed-in user, Worker env and
lazily loaded gym settings. Services receive a Ctx; they never touch FastAPI objects."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from core.clock import Clock
from core.config import AppConfig
from core.database import Database
from models.session import CurrentUser

from . import settings_service


@dataclass
class Ctx:
    db: Database
    clock: Clock
    config: AppConfig
    user: CurrentUser | None = None
    env: Any = None
    # The request's ASGI state: services flag work the edge middleware runs after the response.
    state: dict[str, Any] | None = None
    _settings: dict[str, Any] | None = None

    # -- the request's device, for sessions and the activity log ---------------------------------------
    @property
    def client_ip(self) -> str | None:
        return (self.state or {}).get("client_ip")

    @property
    def user_agent(self) -> str | None:
        return (self.state or {}).get("user_agent")

    @property
    def place(self) -> dict[str, str | None]:
        """City / region / country of the request from Cloudflare's network data."""
        return (self.state or {}).get("place") or {}

    def live(self, *messages: dict[str, Any]) -> None:
        """Push live updates (core/realtime.py) to open apps once this request has finished."""
        if self.state is not None:
            self.state.setdefault("live", []).extend(messages)

    def log(self, action: str, summary: str, *, user_id: int | None = None, category: str = "Sign-in",
            target: str | None = None, session_id: int | None = None) -> None:
        """Add an activity-log entry; the edge middleware writes it after the response (also on errors,
        so failed sign-ins are recorded)."""
        if self.state is None:
            return
        from security.activity import entry  # noqa: PLC0415

        self.state.setdefault("activity", []).append(entry(
            at=self.now, user_id=user_id if user_id is not None else self.actor_id, action=action, category=category,
            summary=summary, target=target, ip=self.client_ip, user_agent=self.user_agent,
            session_id=session_id if session_id is not None else (self.user.session_id if self.user else None),
        ))

    def messages_queued(self) -> None:
        """WhatsApp / email rows were added: send them as soon as this request has finished."""
        if self.state is not None:
            self.state["messages_queued"] = True

    async def settings(self) -> dict[str, Any]:
        if self._settings is None:
            self._settings = await settings_service.get_settings(self.db)
        return self._settings

    def refresh_settings(self, settings: dict[str, Any]) -> None:
        self._settings = settings

    @property
    def actor_id(self) -> int | None:
        return self.user.id if self.user else None

    @property
    def now(self) -> str:
        return self.clock.now_ts()
