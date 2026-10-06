"""MemberReportService: one member's report (attendance, payments, memberships, progress,
workouts) for a period, for staff and for the signed link sent on WhatsApp. The PDF is drawn in
the browser from this JSON."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from core.clock import iso_z
from core.errors import NotFound, ValidationFailed
from security import links

from .attendance_service import AttendanceService
from .context import Ctx
from .member_service import MemberService
from .membership_service import MembershipService
from .message_service import whatsapp_number
from .payment_service import PaymentService
from .progress_service import ProgressService
from .workout_service import WorkoutService

SECTIONS = {"membership": "m", "attendance": "a", "payments": "p", "progress": "g", "workouts": "w"}
LINK_DAYS = 30  # a report link sent on WhatsApp works for 30 days


class _AllRows:
    """Page object for "everything in the period" (a member has at most a few hundred payments a year)."""

    page, limit, offset = 1, 500, 0

    def wrap(self, items: list[Any], total: int) -> dict[str, Any]:
        return {"items": items, "total": total}


def check_period(start: date, end: date) -> None:
    if start > end:
        raise ValidationFailed("The start date is after the end date.", fields={"from": "Must be before the end date"})
    if (end - start).days > 366:
        raise ValidationFailed("Choose a period of at most one year.", fields={"from": "At most one year"})


class MemberReportService:
    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx

    async def build(self, member_id: int, start: date, end: date, *, include_payments: bool) -> dict[str, Any]:
        check_period(start, end)
        ctx = self.ctx
        member = await MemberService(ctx).workspace(member_id, include_finance=include_payments)
        settings = await ctx.settings()
        payments = None
        if include_payments:
            payments = (await PaymentService(ctx).list(_AllRows(), start=start.isoformat(), end=end.isoformat(), status=None,
                                                        method=None, member_id=member_id, q=None))["items"]
        return {
            "gym": {"name": settings["gym_name"], "address": settings["gym_address"], "phone": settings["gym_phone"],
                    "email": settings["gym_email"], "signatory": settings["receipt_signatory"] or settings["gym_name"]},
            "generated_at": iso_z(ctx.now),
            "from": start.isoformat(),
            "to": end.isoformat(),
            "member": member,
            "member_whatsapp": whatsapp_number(member.get("phone") or "", ctx.config.default_country_code) or None,
            "attendance": await AttendanceService(ctx).member_history(member_id, start, end),
            "memberships": await MembershipService(ctx).for_member(member_id),
            "payments": payments,
            "progress": await ProgressService(ctx).for_member(member_id),
            "workouts": await WorkoutService(ctx).for_member(member_id, include_archived=False),
        }

    # -- the link sent on WhatsApp ---------------------------------------------------------------------
    def link(self, member_id: int, start: date, end: date, sections: list[str], *, allow_payments: bool) -> str:
        check_period(start, end)
        codes = "".join(code for name, code in SECTIONS.items() if name in sections and (name != "payments" or allow_payments))
        if not codes:
            raise ValidationFailed("Tick at least one section.", fields={"sections": "Tick at least one section"})
        expires = (self.ctx.clock.today() + timedelta(days=LINK_DAYS) - date(1970, 1, 1)).days
        payload = f"{member_id}.{start.isoformat()}.{end.isoformat()}.{codes}.{expires}"
        return "/mr/" + links.sign("member-report", payload, self.ctx.config.jwt_secret)

    async def from_link(self, token: str) -> dict[str, Any]:
        payload = links.verify("member-report", token, self.ctx.config.jwt_secret)
        if not payload:
            raise NotFound("This link isn't valid. Ask the gym to send it again.")
        try:
            member_id, start, end, codes, expires = payload.split(".")
            start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
            expired = (self.ctx.clock.today() - date(1970, 1, 1)).days > int(expires)
        except ValueError:
            raise NotFound("This link isn't valid. Ask the gym to send it again.") from None
        if expired:
            raise NotFound("This link has expired. Ask the gym to send the report again.")
        sections = [name for name, code in SECTIONS.items() if code in codes]
        report = await self.build(int(member_id), start_date, end_date, include_payments="payments" in sections)
        return {**report, "sections": sections}
