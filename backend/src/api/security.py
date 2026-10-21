"""/api/security — the admin's Security page: signed-in devices (with sign-in counts by role,
members included) and the activity log.

Admin only, and only after the admin re-enters their password: POST /security/unlock returns a
15-minute unlock token the page sends as ``X-Security-Unlock`` on every other call here.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import Response
from pydantic import Field

from schemas.common import Model
from services.context import Ctx
from services.security_service import SecurityService, check_unlock

from .contexts import admin_ctx
from .deps import Page, pagination
from .responses import FastJSON, no_content, ok

router = APIRouter(prefix="/security", tags=["security"])
Role = Literal["ADMIN", "STAFF", "TRAINER", "MEMBER"]


class UnlockIn(Model):
    password: str = Field(min_length=1, max_length=128)


async def unlocked_ctx(
    ctx: Ctx = Depends(admin_ctx), unlock: str | None = Header(None, alias="X-Security-Unlock"),
) -> Ctx:
    check_unlock(unlock, ctx)
    return ctx


@router.post("/unlock")
async def unlock(body: UnlockIn, request: Request, ctx: Ctx = Depends(admin_ctx)) -> FastJSON:
    return ok(await SecurityService(ctx).unlock(body.password))


@router.get("/overview")
async def overview(ctx: Ctx = Depends(unlocked_ctx)) -> FastJSON:
    return ok(await SecurityService(ctx).overview())


@router.get("/sessions")
async def sessions(
    role: Role | None = None,
    q: str | None = Query(None, max_length=80),
    page: Page = Depends(pagination(20, 100)),
    ctx: Ctx = Depends(unlocked_ctx),
) -> FastJSON:
    return ok(await SecurityService(ctx).sessions(page, role=role, q=q))


@router.post("/sessions/{session_id}/sign-out", status_code=204)
async def sign_out_device(session_id: int, ctx: Ctx = Depends(unlocked_ctx)) -> Response:
    await SecurityService(ctx).sign_out_device(session_id)
    return no_content()


@router.post("/users/{user_id}/sign-out")
async def sign_out_person(user_id: int, ctx: Ctx = Depends(unlocked_ctx)) -> FastJSON:
    return ok({"ended": await SecurityService(ctx).sign_out_person(user_id)})


@router.get("/activity")
async def activity(
    from_: date | None = Query(None, alias="from"),
    to: date | None = None,
    category: str | None = Query(None, max_length=20),
    role: Role | None = None,
    user_id: int | None = None,
    q: str | None = Query(None, max_length=80),
    page: Page = Depends(pagination(50, 100)),
    ctx: Ctx = Depends(unlocked_ctx),
) -> FastJSON:
    return ok(await SecurityService(ctx).activity(page, start=from_, end=to, category=category, role=role, user_id=user_id, q=q))
