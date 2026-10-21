"""The authenticated user of a request."""

from __future__ import annotations

from dataclasses import dataclass

from .domain import STAFF_ROLES


@dataclass(frozen=True)
class CurrentUser:
    id: int
    role: str
    name: str
    member_id: int | None
    trainer_id: int | None
    must_change_password: bool
    token_version: int
    # The signed-in device (sessions table); None only for tokens issued outside a sign-in (tests).
    session_id: int | None = None

    @property
    def is_staff(self) -> bool:
        return self.role in STAFF_ROLES

    @property
    def is_admin(self) -> bool:
        return self.role == "ADMIN"
