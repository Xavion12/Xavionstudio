"""/api/public — what a share link sent on WhatsApp opens, without signing in.

The token in the link is signed (security/links.py), so only links the gym created work. A link
can be forwarded, so these responses carry only what the PDF prints, with the phone and email
masked: no address, date of birth, emergency contact or app login. Each IP is rate limited
(PUBLIC_LIMITER) so the endpoints can't be used to hammer the database.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Path, Request

from core.errors import NotFound
from security import links
from security.rate_limit import check_rate
from services.context import Ctx
from services.member_report_service import MemberReportService
from services.payment_service import PaymentService

from .contexts import public_ctx
from .responses import FastJSON, ok

router = APIRouter(prefix="/public", tags=["public"])
TOKEN = Path(..., min_length=10, max_length=200, pattern=r"^[A-Za-z0-9._-]+$")
SLOW_DOWN = "Too many requests. Please wait a minute and try again."

# What a shared member report may show about the member (everything else is dropped).
REPORT_MEMBER_FIELDS = ("id", "member_code", "name", "joining_date", "status", "trainer", "membership", "stats")


def mask_phone(phone: str | None) -> str | None:
    digits = "".join(ch for ch in phone or "" if ch.isdigit())
    return "•" * max(0, len(digits) - 4) + digits[-4:] if len(digits) >= 4 else None


def mask_email(email: str | None) -> str | None:
    if not email or "@" not in email:
        return None
    user, domain = email.split("@", 1)
    return f"{user[:1]}•••@{domain}"


def public_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in receipt.items() if k not in ("share_path", "member_whatsapp")}
    out["member_phone"] = mask_phone(receipt.get("member_phone"))
    return out


def public_report(report: dict[str, Any]) -> dict[str, Any]:
    member = report["member"]
    safe = {k: member.get(k) for k in REPORT_MEMBER_FIELDS}
    if safe.get("trainer"):
        safe["trainer"] = {"name": safe["trainer"].get("name")}
    safe["phone"] = mask_phone(member.get("phone"))
    safe["email"] = mask_email(member.get("email"))
    return {**{k: v for k, v in report.items() if k != "member_whatsapp"}, "member": safe}


async def _throttle(request: Request, ctx: Ctx) -> None:
    ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")
    await check_rate(ctx.env, "PUBLIC_LIMITER", f"share:{ip}", SLOW_DOWN)


@router.get("/receipts/{token}")
async def receipt(request: Request, token: str = TOKEN, ctx: Ctx = Depends(public_ctx)) -> FastJSON:
    await _throttle(request, ctx)
    payload = links.verify("receipt", token, ctx.config.jwt_secret)
    if not payload or not payload.isdigit():
        raise NotFound("This receipt link isn't valid. Ask the gym to send it again.")
    return ok(public_receipt(await PaymentService(ctx).receipt(int(payload))))


@router.get("/member-reports/{token}")
async def member_report(request: Request, token: str = TOKEN, ctx: Ctx = Depends(public_ctx)) -> FastJSON:
    await _throttle(request, ctx)
    return ok(public_report(await MemberReportService(ctx).from_link(token)))
