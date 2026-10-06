"""Automatic WhatsApp / email messages: queued with each event and sent right after the request
(``outgoing`` in conftest records what would reach Meta and Resend)."""

import asyncio
import json
from dataclasses import replace
from datetime import timedelta

import pytest
from conftest import NOW, activate_login, create_member, pay
from fastapi.testclient import TestClient

from app import create_app
from core.clock import Clock
from jobs.scheduler import run_daily_jobs, send_messages
from utils import http


@pytest.fixture
def connected(db, config):
    """The API with both providers configured (as if the Worker secrets were set)."""
    cfg = replace(config, whatsapp_token="wa-secret", whatsapp_phone_number_id="555000111", resend_api_key="re_secret",
                  email_from="receipts@gym.test")
    with TestClient(create_app(config_provider=lambda scope: cfg, db_provider=lambda scope, c: db)) as client:
        yield client, cfg


def _forget_setup(db, outgoing):
    """Messages start with the keys alone, so the test's own setup (members, earlier payments) has
    already sent some: forget those and check only what happens next."""
    db.conn.execute("DELETE FROM outbox")
    outgoing.clear()


def _outbox(db, event=None):
    """Outbox rows; the welcome every new member gets is left out unless asked for."""
    rows = [dict(r) for r in db.conn.execute("SELECT channel, event, recipient, params, status, dedupe_key, last_error FROM outbox ORDER BY id")]
    return [r for r in rows if (r["event"] == event if event else r["event"] != "WELCOME")]


def _whatsapp(outgoing, template=None):
    sent = [s["json"] for s in outgoing if "graph.facebook.com" in s["url"]]
    return [m for m in sent if (m["template"]["name"] == template if template else m["template"]["name"] != "welcome_member")]


def _emails(outgoing):
    return [s["json"] for s in outgoing if "api.resend.com" in s["url"] and not s["json"]["subject"].startswith("Welcome to")]


def _values(message):
    return [p["text"] for p in message["template"]["components"][0]["parameters"]]


def test_a_payment_sends_the_receipt_by_whatsapp_and_email_at_once(connected, admin, plans, db, outgoing):
    client, _ = connected
    member = create_member(client, admin, email="aarav@example.com")["member"]
    _forget_setup(db, outgoing)
    payment = pay(client, admin, member["id"], plans["Monthly"]).json()["payment"]

    rows = _outbox(db)
    assert [(r["channel"], r["event"], r["recipient"], r["status"]) for r in rows] == [
        ("WHATSAPP", "PAYMENT_RECEIVED", "919876543210", "SENT"), ("EMAIL", "PAYMENT_RECEIVED", "aarav@example.com", "SENT"),
    ]
    assert json.loads(rows[0]["params"]) == {"first": "Aarav", "gym": "Xavion Fitness Studio", "amount": "₹1,500", "plan": "Monthly",
                                             "start": "23 Sep 2026", "end": "22 Oct 2026", "number": payment["payment_number"]}
    [whatsapp] = _whatsapp(outgoing)
    assert whatsapp["to"] == "919876543210" and whatsapp["template"]["name"] == "payment_received"
    assert _values(whatsapp) == ["Aarav", "₹1,500", "Xavion Fitness Studio", "Monthly", "23 Sep 2026", "22 Oct 2026", payment["payment_number"]]
    [email] = _emails(outgoing)
    assert email["to"] == ["aarav@example.com"] and email["subject"] == "Payment received - Xavion Fitness Studio"
    assert "Monthly membership runs from 23 Sep 2026 to 22 Oct 2026" in email["text"]


def test_a_renewal_sends_its_own_receipt(connected, admin, plans, db, outgoing):
    client, _ = connected
    member = create_member(client, admin)["member"]
    pay(client, admin, member["id"], plans["Monthly"])
    _forget_setup(db, outgoing)
    pay(client, admin, member["id"], plans["Quarterly"])  # starts the day after the current one ends
    [renewal] = _whatsapp(outgoing)
    assert _values(renewal)[3:6] == ["Quarterly", "23 Oct 2026", "20 Jan 2027"]


def test_nothing_is_sent_without_the_provider_keys(client, admin, plans, db, outgoing):
    member = create_member(client, admin, email="aarav@example.com")["member"]
    pay(client, admin, member["id"], plans["Monthly"])  # no WHATSAPP_* / RESEND_* keys on the Worker
    assert _outbox(db) == [] and outgoing == []


def test_settings_can_no_longer_switch_channels(client, admin):
    response = client.put("/api/settings", json={"whatsapp_enabled": False}, headers=admin)
    assert response.status_code == 422  # the keys alone decide; there is no switch to forget


def test_check_in_and_check_out_are_messaged(connected, admin, plans, db, outgoing):
    client, _ = connected
    member = create_member(client, admin, email="aarav@example.com")["member"]
    pay(client, admin, member["id"], plans["Monthly"])
    _forget_setup(db, outgoing)
    assert client.post("/api/attendance", json={"member_id": member["id"], "action": "IN"}, headers=admin).json()["result"] == "CHECKED_IN"
    Clock.frozen = NOW + timedelta(minutes=75)
    assert client.post("/api/attendance", json={"member_id": member["id"], "action": "OUT"}, headers=admin).json()["result"] == "CHECKED_OUT"

    check_in, check_out = _whatsapp(outgoing)
    assert check_in["template"]["name"] == "attendance_check_in" and _values(check_in) == ["Aarav", "Xavion Fitness Studio", "12:00 PM"]
    assert check_out["template"]["name"] == "attendance_check_out" and _values(check_out) == ["Aarav", "Xavion Fitness Studio", "1:15 PM", "1 h 15 min"]
    assert [e["subject"] for e in _emails(outgoing)] == ["Checked in at Xavion Fitness Studio", "Checked out of Xavion Fitness Studio"]


def test_welcome_reaches_members_without_the_app(connected, admin, db, outgoing):
    client, _ = connected
    _forget_setup(db, outgoing)
    member = create_member(client, admin, create_app_login=False)["member"]
    [welcome] = _whatsapp(outgoing, "welcome_member")
    assert welcome["template"]["name"] == "welcome_member" and _values(welcome) == ["Aarav", "Xavion Fitness Studio", member["member_code"]]


def test_trainer_assignment_rejection_and_refund_are_messaged(connected, admin, plans, db, outgoing, upi_enabled):
    client, _ = connected
    created = create_member(client, admin, email="aarav@example.com")
    member = created["member"]
    paid = pay(client, admin, member["id"], plans["Monthly"]).json()["payment"]
    _forget_setup(db, outgoing)

    trainer = client.post("/api/trainers", json={"name": "Arjun Menon", "phone": "9845000001"}, headers=admin).json()
    assert client.post(f"/api/members/{member['id']}/trainer", json={"trainer_id": trainer["id"]}, headers=admin).status_code == 200

    headers = activate_login(client, created["credentials"]["login"], created["credentials"]["temporary_password"])
    submitted = client.post("/api/me/renewals", json={"plan_id": plans["Quarterly"]["id"], "utr": "412345678901"}, headers=headers)
    pending = submitted.json()["payment"]
    client.post(f"/api/payments/{pending['id']}/reject", json={"reason": "No credit found in the bank statement"}, headers=admin)
    client.post(f"/api/payments/{paid['id']}/refund", json={"refund_method": "CASH", "refund_reason": "Moved city"}, headers=admin)

    names = [m["template"]["name"] for m in _whatsapp(outgoing)]
    assert names == ["trainer_assigned", "payment_submitted", "payment_rejected", "payment_refunded"]
    trainer_msg, submitted_msg, rejected_msg, refunded_msg = _whatsapp(outgoing)
    assert _values(trainer_msg) == ["Aarav", "Arjun Menon", "Xavion Fitness Studio"]
    assert _values(submitted_msg) == ["Aarav", "₹4,000", "Quarterly", "Xavion Fitness Studio", "412345678901"]
    assert _values(rejected_msg) == ["Aarav", "₹4,000", "412345678901", "No credit found in the bank statement.", "Xavion Fitness Studio"]
    assert _values(refunded_msg) == ["Aarav", "₹1,500", paid["payment_number"], "Xavion Fitness Studio"]
    assert all(r["status"] == "SENT" for r in _outbox(db))


def test_upi_approval_sends_one_receipt_even_if_approved_twice(connected, admin, plans, db, outgoing, upi_enabled):
    client, _ = connected
    created = create_member(client, admin, email="aarav@example.com")
    headers = activate_login(client, created["credentials"]["login"], created["credentials"]["temporary_password"])
    _forget_setup(db, outgoing)
    payment = client.post("/api/me/renewals", json={"plan_id": plans["Monthly"]["id"], "utr": "412345678901"}, headers=headers).json()["payment"]
    assert client.post(f"/api/payments/{payment['id']}/approve", headers=admin).status_code == 200
    client.post(f"/api/payments/{payment['id']}/approve", headers=admin)
    assert [r["event"] for r in _outbox(db)] == ["PAYMENT_SUBMITTED", "PAYMENT_SUBMITTED", "PAYMENT_RECEIVED", "PAYMENT_RECEIVED"]


def test_offers_go_to_a_segment_by_whatsapp_and_email(connected, admin, plans, db, outgoing):
    client, _ = connected
    first = create_member(client, admin, email="aarav@example.com")["member"]
    second = create_member(client, admin, name="Priya Nair", phone="9876500002")["member"]
    quiet = create_member(client, admin, name="Ravi Kumar", phone="9876500003", messages=False)["member"]
    create_member(client, admin, name="No Plan", phone="9876500004")  # not active: outside the segment
    for member in (first, second, quiet):
        pay(client, admin, member["id"], plans["Monthly"])
    _forget_setup(db, outgoing)

    response = client.post("/api/notifications/send", json={
        "segment": "ACTIVE", "title": "Diwali offer", "message": "20% off every plan.\nValid till 31 Oct.",
        "channels": ["WHATSAPP", "EMAIL"],
    }, headers=admin).json()
    assert response["whatsapp"] == 2 and response["email"] == 1 and response["delivered"] == 0  # no in-app copy asked for

    offers = _whatsapp(outgoing)
    assert sorted(m["to"] for m in offers) == ["919876500002", "919876543210"]
    assert {m["template"]["name"] for m in offers} == {"gym_offer"}
    assert _values(offers[0])[2] == "20% off every plan. · Valid till 31 Oct."  # WhatsApp refuses line breaks in values
    [email] = _emails(outgoing)
    assert email["subject"] == "Diwali offer" and "20% off every plan.<br>Valid till 31 Oct." in email["html"]


def test_members_can_stop_messages(connected, admin, plans, db, outgoing):
    client, _ = connected
    _forget_setup(db, outgoing)
    quiet = create_member(client, admin, messages=False)["member"]
    pay(client, admin, quiet["id"], plans["Monthly"])
    assert _outbox(db) == []
    assert client.get(f"/api/members/{quiet['id']}", headers=admin).json()["messages"] is False
    edit = {"name": "Aarav S", "phone": quiet["phone"], "joining_date": quiet["joining_date"]}  # the edit form omits it
    assert client.put(f"/api/members/{quiet['id']}", json=edit, headers=admin).status_code == 200
    assert client.get(f"/api/members/{quiet['id']}", headers=admin).json()["messages"] is False

    created = create_member(client, admin, name="Priya Nair", phone="9876500002")
    member_id = created["member"]["id"]
    headers = activate_login(client, created["credentials"]["login"], created["credentials"]["temporary_password"])
    profile = client.put("/api/me/profile", json={"messages": False}, headers=headers).json()
    assert profile["messages"] is False
    before = len(_outbox(db))
    pay(client, admin, member_id, plans["Monthly"])
    assert len(_outbox(db)) == before  # only the welcome went out, before the member opted out


def test_daily_reminders_are_sent_once(connected, admin, plans, db, outgoing):
    client, cfg = connected
    ending = create_member(client, admin)["member"]
    pay(client, admin, ending["id"], plans["Monthly"], start_date="2026-09-01", payment_date="2026-09-01")  # ends 30 Sep
    lapsed = create_member(client, admin, name="Priya Nair", phone="9876500002", email="priya@example.com")["member"]
    pay(client, admin, lapsed["id"], plans["Monthly"], start_date="2026-08-23", payment_date="2026-08-23")  # ended 21 Sep
    _forget_setup(db, outgoing)
    for _ in range(2):  # a re-run of the daily job adds nothing
        asyncio.run(run_daily_jobs(db, cfg))
    rows = _outbox(db)
    assert sorted((r["event"], r["channel"], r["recipient"], r["status"]) for r in rows) == [
        ("EXPIRY_7D", "WHATSAPP", "919876543210", "SENT"),
        ("MEMBERSHIP_EXPIRED", "EMAIL", "priya@example.com", "SENT"),
        ("MEMBERSHIP_EXPIRED", "WHATSAPP", "919876500002", "SENT"),
    ]
    reminder = next(r for r in rows if r["event"] == "EXPIRY_7D")
    assert json.loads(reminder["params"]) == {"first": "Aarav", "plan": "Monthly", "gym": "Xavion Fitness Studio", "end": "30 Sep 2026"}
    assert len(_whatsapp(outgoing)) == 2  # sent by the daily run itself, not a minute later


def test_temporary_failures_are_retried_by_the_minute_job(connected, admin, plans, db, outgoing, monkeypatch):
    client, cfg = connected
    member = create_member(client, admin, name="Aarav <b>Sharma</b>", email="aarav@example.com")["member"]
    _forget_setup(db, outgoing)
    calls = []

    async def email_down(method, url, *, headers=None, json_body=None, timeout=30.0, body=None):
        calls.append(url)
        if "graph.facebook.com" in url:
            return http.HttpResponse(200, '{"messages":[{"id":"wamid.1"}]}')
        return http.HttpResponse(503, '{"message":"busy"}')

    monkeypatch.setattr(http, "request", email_down)
    pay(client, admin, member["id"], plans["Monthly"])
    statuses = {r["channel"]: r["status"] for r in _outbox(db, "PAYMENT_RECEIVED")}
    assert statuses == {"WHATSAPP": "SENT", "EMAIL": "QUEUED"}  # email provider down: kept for a retry

    monkeypatch.setattr(http, "request", lambda *a, **k: outgoing_ok(outgoing, *a, **k))
    assert asyncio.run(send_messages(db, cfg)) == {"sent": 1, "failed": 0, "retry": 0}
    [email] = _emails(outgoing)
    assert "<b>" not in email["html"] and "Hi Aarav," in email["text"]  # names are escaped in HTML

    async def refuse(method, url, **kwargs):
        return http.HttpResponse(422, '{"message":"Invalid to address"}')

    monkeypatch.setattr(http, "request", refuse)
    client.post("/api/attendance", json={"member_id": member["id"], "action": "IN"}, headers=admin)
    failed = db.conn.execute("SELECT status, last_error FROM outbox WHERE event = 'CHECK_IN' AND channel = 'EMAIL'").fetchone()
    assert tuple(failed) == ("FAILED", "Email 422: Invalid to address")  # permanent: not retried


async def outgoing_ok(outgoing, method, url, *, headers=None, json_body=None, timeout=30.0, body=None):
    outgoing.append({"method": method, "url": url, "headers": headers or {}, "json": json_body})
    return http.HttpResponse(200, "{}")


def test_admins_see_deliveries_templates_and_can_send_a_test(connected, admin, staff, outgoing):
    client, _ = connected
    status = client.get("/api/messages", headers=admin).json()
    assert status["whatsapp"] == {"configured": True, "enabled": True} and status["queued"] == 0
    templates = {t["name"]: t for t in status["templates"]}
    assert {"payment_received", "attendance_check_in", "attendance_check_out", "gym_offer", "membership_reminder"} <= set(templates)
    assert templates["gym_offer"]["category"] == "MARKETING" and "{{3}}" in templates["gym_offer"]["body"]
    sent = client.post("/api/messages/test", json={"channel": "WHATSAPP", "to": "98765 43210"}, headers=admin).json()
    assert sent == {"ok": True, "message": "Sent to 919876543210."}
    assert client.post("/api/messages/test", json={"channel": "EMAIL", "to": "not-an-email"}, headers=admin).status_code == 422
    assert client.get("/api/messages", headers=staff).status_code == 403
    assert "wa-secret" not in json.dumps(status)


def test_the_minute_job_is_harmless_without_providers(db, config, outgoing):
    assert asyncio.run(send_messages(db, config)) == {"sent": 0, "failed": 0, "retry": 0}
    assert outgoing == []


def test_turning_messages_off_in_the_app_keeps_the_contact_details(client, admin):
    created = create_member(client, admin, email="aarav@example.com", address="12 MG Road")
    headers = activate_login(client, created["credentials"]["login"], created["credentials"]["temporary_password"])
    profile = client.put("/api/me/profile", json={"messages": False}, headers=headers).json()
    assert profile["messages"] is False
    assert profile["email"] == "aarav@example.com" and profile["address"] == "12 MG Road"  # used to be wiped
    cleared = client.put("/api/me/profile", json={"address": None}, headers=headers).json()
    assert cleared["address"] is None and cleared["email"] == "aarav@example.com" and cleared["messages"] is False
