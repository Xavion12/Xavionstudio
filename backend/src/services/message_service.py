"""MessageService: automatic WhatsApp (Meta Cloud API) and email (Resend) messages to members.

    event (payment, renewal, check-in / out, refund, offer ...) ─► outbox row, in the same step
        ─► sent right after that request finishes (Worker waitUntil) ─► result recorded
    daily job: 7 / 3 / 1 days before expiry, and after it ─► outbox ─► sent at once as well
    every minute: anything still queued (a temporary failure, a large offer) is retried

Messages reach every member with a phone number (WhatsApp) or an email address on file, app
login or not, unless the member turned messages off. A channel is on as soon as its keys are set
on the Worker (WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID, RESEND_API_KEY + EMAIL_FROM) - there is
no screen for it. Each kind of message follows the matching in-app switch in Settings ->
Notifications (payments, welcome, trainer, reminders); attendance messages are always on.
"""

from __future__ import annotations

import asyncio
import html
import json
import re
import time
import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import quote

from core.clock import fmt_ts, iso_z
from core.database import Statement
from core.errors import ValidationFailed
from repositories.messages import MessageRepository
from utils import http
from utils.formatting import digits_only, format_date, format_inr, is_valid_email, normalize_phone

from .context import Ctx

CHANNELS = ("WHATSAPP", "EMAIL")
REMINDERS = {7: "EXPIRY_7D", 3: "EXPIRY_3D", 1: "EXPIRY_1D"}
SEND_BATCH = 20  # per run: the Free plan allows 50 outgoing requests per invocation
SEND_NOW_SECONDS = 20  # keep sending this long after a request (waitUntil allows 30 s)
MAX_ATTEMPTS = 5
EMAIL_GAP_SECONDS = 0.6  # Resend accepts 2 requests a second


class Kind:
    """One kind of message: its Settings switch, WhatsApp template and email."""

    def __init__(self, label: str, toggle: str | None, template: str, keys: tuple[str, ...], subject: str, lines: list[str],
                 category: str = "UTILITY", sample: str = "") -> None:
        self.label, self.toggle, self.template, self.keys = label, toggle, template, keys
        self.subject, self.lines, self.category, self.sample = subject, lines, category, sample


_REMINDER = Kind(
    "Expiry reminder", "reminders_enabled", "membership_reminder", ("first", "plan", "gym", "end"),
    "Your membership ends on {end}",
    ["Hi {first},", "Your {plan} membership at {gym} ends on {end}.",
     "Renew in the member app or at the front desk to keep training without a break.", "{gym}"],
    sample="Hi {{1}}, your {{2}} membership at {{3}} ends on {{4}}. Renew in the member app or at the front desk to keep training without a break.",
)

# WhatsApp templates must be created and approved in Meta's WhatsApp Manager with exactly these
# names, language English (en) and the body variables {{1}}, {{2}} ... in the order of ``keys``.
KINDS: dict[str, Kind] = {
    "PAYMENT_RECEIVED": Kind(
        "Payment received / membership active", "notify_payment", "payment_received",
        ("first", "amount", "gym", "plan", "start", "end", "number"),
        "Payment received - {gym}",
        ["Hi {first},", "We have received your payment of {amount}. Your {plan} membership runs from {start} to {end}.",
         "Payment number: {number}", "Thank you,", "{gym}"],
        sample="Hi {{1}}, we have received your payment of {{2}} at {{3}}. Your {{4}} membership runs from {{5}} to {{6}}. Payment number {{7}}. Thank you!",
    ),
    "PAYMENT_SUBMITTED": Kind(
        "UPI payment submitted (waiting for approval)", "notify_payment", "payment_submitted",
        ("first", "amount", "plan", "gym", "utr"),
        "We are checking your payment - {gym}",
        ["Hi {first},", "We have your UPI payment of {amount} for the {plan} plan (UTR {utr}).",
         "{gym} will check it and confirm shortly.", "{gym}"],
        sample="Hi {{1}}, we have your UPI payment of {{2}} for the {{3}} plan. {{4}} will check UTR {{5}} and confirm shortly.",
    ),
    "PAYMENT_REJECTED": Kind(
        "UPI payment not verified", "notify_payment", "payment_rejected", ("first", "amount", "utr", "reason", "gym"),
        "We couldn't verify your payment - {gym}",
        ["Hi {first},", "We couldn't verify your UPI payment of {amount} (UTR {utr}).", "{reason}",
         "Please contact the front desk.", "{gym}"],
        sample="Hi {{1}}, we couldn't verify your UPI payment of {{2}} (UTR {{3}}). {{4}} Please contact the front desk at {{5}}.",
    ),
    "PAYMENT_REFUNDED": Kind(
        "Refund recorded", "notify_payment", "payment_refunded", ("first", "amount", "number", "gym"),
        "Refund recorded - {gym}",
        ["Hi {first},", "A refund of {amount} for payment {number} has been recorded.", "{gym}"],
        sample="Hi {{1}}, a refund of {{2}} for payment {{3}} has been recorded by {{4}}.",
    ),
    "WELCOME": Kind(
        "Welcome (new member)", "notify_activation", "welcome_member", ("first", "gym", "code"),
        "Welcome to {gym}",
        ["Hi {first},", "Welcome to {gym}! Your member ID is {code}.", "See you at the gym,", "{gym}"],
        sample="Hi {{1}}, welcome to {{2}}! Your member ID is {{3}}. See you at the gym.",
    ),
    "TRAINER_ASSIGNED": Kind(
        "Trainer assigned", "notify_trainer", "trainer_assigned", ("first", "trainer", "gym"),
        "Your trainer at {gym}",
        ["Hi {first},", "{trainer} is now your trainer at {gym}.", "{gym}"],
        sample="Hi {{1}}, {{2}} is now your trainer at {{3}}.",
    ),
    "CHECK_IN": Kind(
        "Attendance: checked in", None, "attendance_check_in", ("first", "gym", "time"),
        "Checked in at {gym}",
        ["Hi {first},", "You checked in at {gym} at {time}. Have a great workout!", "{gym}"],
        sample="Hi {{1}}, you checked in at {{2}} at {{3}}. Have a great workout!",
    ),
    "CHECK_OUT": Kind(
        "Attendance: checked out", None, "attendance_check_out", ("first", "gym", "time", "duration"),
        "Checked out of {gym}",
        ["Hi {first},", "You checked out of {gym} at {time} after {duration}. See you next time!", "{gym}"],
        sample="Hi {{1}}, you checked out of {{2}} at {{3}} after {{4}}. See you next time!",
    ),
    "EXPIRY_7D": _REMINDER,
    "EXPIRY_3D": _REMINDER,
    "EXPIRY_1D": _REMINDER,
    "MEMBERSHIP_EXPIRED": Kind(
        "Membership expired", "reminders_enabled", "membership_expired", ("first", "gym", "end"),
        "Your membership has expired",
        ["Hi {first},", "Your membership at {gym} expired on {end}. Please renew to continue - we'd love to see you back.", "{gym}"],
        sample="Hi {{1}}, your membership at {{2}} expired on {{3}}. Please renew to continue - we'd love to see you back.",
    ),
    "OFFER": Kind(
        "Offers and announcements", None, "gym_offer", ("first", "gym", "message"),
        "{title}",
        ["Hi {first},", "{message}", "{gym}"], category="MARKETING",
        sample="Hi {{1}}, news from {{2}}: {{3}}",
    ),
}


def template_catalog() -> list[dict[str, Any]]:
    """The WhatsApp templates to create in Meta (listed in the README and in GET /api/messages)."""
    seen: dict[str, dict[str, Any]] = {}
    for kind in KINDS.values():
        seen.setdefault(kind.template, {"name": kind.template, "category": kind.category, "language": "en",
                                        "label": kind.label, "body": kind.sample, "variables": list(kind.keys)})
    return list(seen.values())


class DeliveryError(Exception):
    """``retry`` = temporary (rate limit, provider down, network); otherwise permanent."""

    def __init__(self, message: str, *, retry: bool = False) -> None:
        super().__init__(message)
        self.retry = retry


class _Values(dict):
    def __missing__(self, key: str) -> str:
        return ""


def whatsapp_number(phone: str, country_code: str) -> str:
    digits = digits_only(phone)
    return country_code + digits if len(digits) == 10 else digits


def _template_text(value: Any) -> str:
    # WhatsApp refuses template values with new lines, tabs or more than 4 spaces in a row.
    text = re.sub(r"\s*[\r\n\t]+\s*", " · ", str(value if value not in (None, "") else "-"))
    return re.sub(r" {4,}", "   ", text)[:1000]


def _raise_for(response: http.HttpResponse, provider: str) -> None:
    if response.ok:
        return
    body = response.json()
    detail = ""
    if isinstance(body, dict):
        error = body.get("error")
        detail = str(error.get("message") or "") if isinstance(error, dict) else str(body.get("message") or "")
    message = f"{provider} {response.status}: {detail or 'request refused'}"
    raise DeliveryError(message, retry=response.status == 429 or response.status >= 500)


def visit_length(minutes: int | None) -> str:
    minutes = max(0, int(minutes or 0))
    if minutes < 60:
        return f"{minutes} min"
    return f"{minutes // 60} h {minutes % 60:02d} min"


class MessageService:
    def __init__(self, ctx: Ctx) -> None:
        self.ctx = ctx
        self.repo = MessageRepository(ctx.db)

    # -- which channels are live -----------------------------------------------------------------------
    def configured(self) -> dict[str, bool]:
        return {"WHATSAPP": self.ctx.config.whatsapp_configured, "EMAIL": self.ctx.config.email_configured}

    async def live_channels(self) -> list[str]:
        """A channel is on as soon as its keys are set on the Worker (secrets, or .dev.vars locally)."""
        configured = self.configured()
        return [c for c in CHANNELS if configured[c]]

    def local_time(self) -> str:
        return self.ctx.clock.local_now().strftime("%I:%M %p").lstrip("0")

    # -- queueing --------------------------------------------------------------------------------------
    async def event_statements(self, member_id: int | None, event: str, params: dict[str, Any], dedupe: str) -> list[Statement]:
        """Outbox rows for one member event, to add to the batch that records the event.

        ``dedupe`` identifies the event (e.g. the payment id): re-running the same step, or two
        desks doing it at once, never sends the same message twice."""
        if not member_id:
            return []
        kind = KINDS[event]
        settings = await self.ctx.settings()
        if kind.toggle and not settings.get(kind.toggle, True):
            return []
        channels = await self.live_channels()
        if not channels:
            return []
        values = {"gym": settings["gym_name"], **{k: v for k, v in params.items() if v is not None}}
        self.ctx.messages_queued()
        return [
            self.repo.member_event_stmt(channel=channel, event=event, member_id=member_id, params=values,
                                        dedupe_key=f"{event}:{dedupe}:{channel}", country_code=self.ctx.config.default_country_code,
                                        now=self.ctx.now)
            for channel in channels
        ]

    async def queue(self, member_id: int | None, event: str, params: dict[str, Any], dedupe: str) -> int:
        """Queue one member event on its own (when it isn't part of a larger batch)."""
        statements = await self.event_statements(member_id, event, params, dedupe)
        if not statements:
            return 0
        return sum(r.changes for r in await self.ctx.db.batch(statements))

    async def payment_statements(self, member: dict[str, Any], payment: dict[str, Any], membership: dict[str, Any] | None) -> list[Statement]:
        """The receipt for a completed payment (new membership or renewal), in the batch that records it."""
        if not membership:
            return []
        rate = payment.get("gst_rate")
        rate = int((await self.ctx.settings())["gst_rate"] or 0) if rate is None else rate
        amount = format_inr(payment["amount"]) + (f" (incl. {rate}% GST)" if rate else "")
        return await self.event_statements(member["id"], "PAYMENT_RECEIVED", {
            "amount": amount, "plan": membership.get("plan_name") or "",
            "start": format_date(membership["start_date"]), "end": format_date(membership["end_date"]),
            "number": payment["payment_number"],
        }, str(payment["id"]))

    async def queue_offer(self, *, title: str, message: str, segment: str | None, member_ids: list[int] | None,
                          channels: list[str]) -> dict[str, int]:
        """An offer / announcement to a segment of members (or picked members) by WhatsApp and / or email."""
        live = [c for c in await self.live_channels() if c in channels]
        if not live:
            return {}
        settings = await self.ctx.settings()
        today = self.ctx.clock.today()
        campaign = f"OFFER:{uuid.uuid4().hex[:12]}"
        params = {"gym": settings["gym_name"], "title": title, "message": message}
        statements = [
            self.repo.segment_stmt(channel=channel, event="OFFER", segment=segment, member_ids=member_ids, params=params,
                                   campaign=campaign, country_code=self.ctx.config.default_country_code, now=self.ctx.now,
                                   today=today.isoformat(), soon=(today + timedelta(days=7)).isoformat())
            for channel in live
        ]
        results = await self.ctx.db.batch(statements)
        queued = {channel: r.changes for channel, r in zip(live, results)}
        if any(queued.values()):
            self.ctx.messages_queued()
        return queued

    async def queue_reminders(self) -> dict[str, int]:
        """Daily: 7 / 3 / 1 days before a membership ends, and once after it lapsed."""
        settings = await self.ctx.settings()
        channels = await self.live_channels()
        if not settings["reminders_enabled"] or not channels:
            return {"queued": 0}
        today = self.ctx.clock.today()
        common = {"gym": settings["gym_name"], "country_code": self.ctx.config.default_country_code, "now": self.ctx.now}
        plan: list[tuple[str, str, str, bool]] = [
            (kind, (today + timedelta(days=days)).isoformat(), (today + timedelta(days=days)).isoformat(), False)
            for days, kind in REMINDERS.items()
        ]
        plan.append(("MEMBERSHIP_EXPIRED", (today - timedelta(days=3)).isoformat(), (today - timedelta(days=1)).isoformat(), True))
        statements = [
            self.repo.reminder_stmt(channel=channel, event=kind, end_from=low, end_to=high, expired=expired, **common)
            for kind, low, high, expired in plan
            for channel in channels
        ]
        results = await self.ctx.db.batch(statements)
        return {"queued": sum(r.changes for r in results)}

    # -- sending ---------------------------------------------------------------------------------------
    async def send_now(self, budget_seconds: float = SEND_NOW_SECONDS) -> dict[str, int]:
        """Right after a request: send batches until the queue is empty or the time is up."""
        totals = {"sent": 0, "failed": 0, "retry": 0}
        deadline = time.monotonic() + budget_seconds
        while True:
            counts = await self.send_queued()
            for key in totals:
                totals[key] += counts[key]
            if sum(counts.values()) < SEND_BATCH or time.monotonic() >= deadline:
                return totals

    async def send_queued(self, limit: int = SEND_BATCH) -> dict[str, int]:
        """Send a few queued messages and record each result (temporary errors are retried later)."""
        configured = self.configured()
        if not any(configured.values()):
            return {"sent": 0, "failed": 0, "retry": 0}
        now = self.ctx.now
        rows = await self.repo.claim(limit, now, fmt_ts(self.ctx.clock.utcnow() - timedelta(minutes=10)))
        settings = await self.ctx.settings()
        updates: list[Statement] = []
        counts = {"sent": 0, "failed": 0, "retry": 0}
        emailed = False
        for row in rows:
            try:
                if row["channel"] == "EMAIL" and emailed and EMAIL_GAP_SECONDS:
                    await asyncio.sleep(EMAIL_GAP_SECONDS)
                emailed = emailed or row["channel"] == "EMAIL"
                await self.deliver(row["channel"], row["recipient"], row["event"], json.loads(row["params"]), settings)
                updates.append(self.repo.sent_stmt(row["id"], self.ctx.now))
                counts["sent"] += 1
            except DeliveryError as exc:
                if exc.retry:
                    updates.append(self.repo.retry_stmt(row["id"], str(exc), MAX_ATTEMPTS))
                    counts["retry"] += 1
                else:
                    updates.append(self.repo.failed_stmt(row["id"], str(exc)))
                    counts["failed"] += 1
        if updates:
            await self.ctx.db.batch(updates)
        return counts

    async def deliver(self, channel: str, recipient: str, event: str, params: dict[str, Any], settings: dict[str, Any]) -> None:
        if not self.configured()[channel]:
            raise DeliveryError(f"{'WhatsApp' if channel == 'WHATSAPP' else 'Email'} is not connected.")
        if event not in KINDS:
            raise DeliveryError(f"Unknown message type {event}.")
        try:
            if channel == "WHATSAPP":
                await self._whatsapp(recipient, event, params)
            else:
                await self._email(recipient, event, params, settings["gym_name"])
        except http.HttpError as exc:
            raise DeliveryError(str(exc), retry=True) from None

    async def _whatsapp(self, to: str, event: str, params: dict[str, Any]) -> None:
        config = self.ctx.config
        kind = KINDS[event]
        body = {
            "messaging_product": "whatsapp",
            "to": to,
            "type": "template",
            "template": {
                "name": kind.template,
                "language": {"code": config.whatsapp_language},
                "components": [{"type": "body", "parameters": [{"type": "text", "text": _template_text(params.get(k))} for k in kind.keys]}],
            },
        }
        url = f"https://graph.facebook.com/{quote(config.whatsapp_api_version)}/{quote(config.whatsapp_phone_number_id)}/messages"
        response = await http.request("POST", url, headers={"Authorization": f"Bearer {config.whatsapp_token}"}, json_body=body, timeout=15)
        _raise_for(response, "WhatsApp")

    async def _email(self, to: str, event: str, params: dict[str, Any], gym: str) -> None:
        config = self.ctx.config
        kind = KINDS[event]
        values = _Values({k: str(v) for k, v in params.items()})
        values.setdefault("gym", gym)
        text_lines = [line.format_map(values) for line in kind.lines]
        text_lines = [line for line in text_lines if line.strip()]
        # Names and offer text come from people: escaped in the HTML part; no line breaks in headers.
        sender = re.sub(r'[\r\n"<>]', "", gym)[:60].strip() or "Gym"
        subject = re.sub(r"[\r\n]", " ", kind.subject.format_map(values)).strip() or f"News from {sender}"
        paragraphs = "".join(
            "<p>" + "<br>".join(html.escape(part) for part in line.split("\n")) + "</p>" for line in text_lines
        )
        body = {
            "from": f"{sender} <{config.email_from}>",
            "to": [to],
            "subject": subject[:150],
            "text": "\n\n".join(text_lines),
            "html": "<div style=\"font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111\">" + paragraphs + "</div>",
        }
        response = await http.request("POST", "https://api.resend.com/emails", headers={"Authorization": f"Bearer {config.resend_api_key}"},
                                      json_body=body, timeout=15)
        _raise_for(response, "Email")

    # -- admin -------------------------------------------------------------------------------------------
    async def overview(self) -> dict[str, Any]:
        configured = self.configured()
        pending, week, recent = await self.repo.overview(fmt_ts(self.ctx.clock.utcnow() - timedelta(days=7)), 30)
        stats = week.first or {}
        return {
            "whatsapp": {"configured": configured["WHATSAPP"], "enabled": configured["WHATSAPP"]},
            "email": {"configured": configured["EMAIL"], "enabled": configured["EMAIL"],
                      "sender": self.ctx.config.email_from or None},
            "queued": (pending.first or {}).get("c", 0),
            "sent_7d": stats.get("sent", 0),
            "failed_7d": stats.get("failed", 0),
            "templates": template_catalog(),
            "events": [{"event": event, "label": kind.label, "toggle": kind.toggle} for event, kind in KINDS.items()
                       if event not in ("EXPIRY_3D", "EXPIRY_1D")],
            "recent": [
                {**r, "created_at": iso_z(r["created_at"]), "sent_at": iso_z(r["sent_at"])} for r in recent.rows
            ],
        }

    async def send_test(self, channel: str, to: str) -> dict[str, Any]:
        """Send the payment receipt with sample values straight away (checks the template too)."""
        if channel == "WHATSAPP":
            local = normalize_phone(to, self.ctx.config.default_country_code)
            if not 10 <= len(local) <= 15:
                raise ValidationFailed("Enter a mobile number.", fields={"to": "Enter a mobile number"})
            recipient = whatsapp_number(local, self.ctx.config.default_country_code)
        else:
            recipient = to.strip().lower()
            if not is_valid_email(recipient):
                raise ValidationFailed("Enter an email address.", fields={"to": "Enter a valid email address"})
        settings = await self.ctx.settings()
        today = self.ctx.clock.today()
        sample = {"first": "Test", "gym": settings["gym_name"], "amount": format_inr(150000), "plan": "Monthly",
                  "start": format_date(today), "end": format_date(today + timedelta(days=30)), "number": "PAY-TEST-000001"}
        try:
            await self.deliver(channel, recipient, "PAYMENT_RECEIVED", sample, settings)
        except DeliveryError as exc:
            return {"ok": False, "message": str(exc)}
        return {"ok": True, "message": f"Sent to {recipient}."}

    # -- retention -----------------------------------------------------------------------------------------
    async def cleanup(self) -> int:
        settings = await self.ctx.settings()
        cutoff = fmt_ts(self.ctx.clock.utcnow() - timedelta(days=settings["notification_retention_days"]))
        return (await self.ctx.db.run(*self.repo.cleanup_stmt(cutoff))).changes
