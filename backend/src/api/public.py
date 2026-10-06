"""/api/public — what a share link sent on WhatsApp opens, without signing in.

The token in the link is signed (security/links.py), so only links the gym created work.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Path

from core.errors import NotFound
from security import links
from services.context import Ctx
from services.member_report_service import MemberReportService
from services.payment_service import PaymentService

from .contexts import public_ctx
from .responses import FastJSON, ok

router = APIRouter(prefix="/public", tags=["public"])
TOKEN = Path(..., min_length=10, max_length=200, pattern=r"^[A-Za-z0-9._-]+$")


@router.get("/receipts/{token}")
async def receipt(token: str = TOKEN, ctx: Ctx = Depends(public_ctx)) -> FastJSON:
    payload = links.verify("receipt", token, ctx.config.jwt_secret)
    if not payload or not payload.isdigit():
        raise NotFound("This receipt link isn't valid. Ask the gym to send it again.")
    return ok(await PaymentService(ctx).receipt(int(payload)))


@router.get("/member-reports/{token}")
async def member_report(token: str = TOKEN, ctx: Ctx = Depends(public_ctx)) -> FastJSON:
    return ok(await MemberReportService(ctx).from_link(token))
