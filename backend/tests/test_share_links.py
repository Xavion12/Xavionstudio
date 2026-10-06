"""Signed share links sent on WhatsApp: receipts and member reports open without signing in."""

from datetime import timedelta

from conftest import NOW, create_member, pay

from core.clock import Clock


def test_receipt_link_opens_without_signing_in_and_cant_be_edited(client, admin, plans):
    member = create_member(client, admin)["member"]
    paid = pay(client, admin, member["id"], plans["Monthly"]).json()["payment"]
    receipt = client.get(f"/api/payments/{paid['id']}/receipt", headers=admin).json()
    path = receipt["share_path"]
    assert path.startswith(f"/r/{paid['id']}.")
    token = path.removeprefix("/r/")

    public = client.get(f"/api/public/receipts/{token}")  # no Authorization header
    assert public.status_code == 200 and public.json()["receipt_number"] == receipt["receipt_number"]

    other = pay(client, admin, member["id"], plans["Quarterly"]).json()["payment"]
    forged = f"{other['id']}.{token.split('.', 1)[1]}"  # someone else's payment id with this signature
    assert client.get(f"/api/public/receipts/{forged}").status_code == 404
    assert client.get("/api/public/receipts/1.AAAAAAAAAAAAAAAAAAAAAA").status_code == 404


def test_member_report_link_has_the_chosen_sections_and_expires(client, admin, staff, plans):
    member = create_member(client, admin)["member"]
    pay(client, admin, member["id"], plans["Monthly"])
    body = {"from": "2026-09-01", "to": "2026-09-30", "sections": ["attendance", "payments"]}
    path = client.post(f"/api/members/{member['id']}/report/link", json=body, headers=staff).json()["path"]
    assert path.startswith("/mr/")
    token = path.removeprefix("/mr/")

    report = client.get(f"/api/public/member-reports/{token}").json()
    assert report["sections"] == ["attendance", "payments"] and len(report["payments"]) == 1
    assert report["member"]["member_code"] == member["member_code"]

    tampered = token.replace("2026-09-01", "2025-10-01")
    assert client.get(f"/api/public/member-reports/{tampered}").status_code == 404

    Clock.frozen = NOW + timedelta(days=31)
    expired = client.get(f"/api/public/member-reports/{token}")
    assert expired.status_code == 404 and "expired" in expired.json()["error"]["message"]


def test_report_link_without_payments_hides_them(client, admin, plans):
    member = create_member(client, admin)["member"]
    pay(client, admin, member["id"], plans["Monthly"])
    body = {"from": "2026-09-01", "to": "2026-09-30", "sections": ["attendance"]}
    token = client.post(f"/api/members/{member['id']}/report/link", json=body, headers=admin).json()["path"].removeprefix("/mr/")
    assert client.get(f"/api/public/member-reports/{token}").json()["payments"] is None
