"""Compulsory device location (GPS) and live updates over WebSocket."""

import pytest
from starlette.websockets import WebSocketDisconnect

from conftest import ADMIN_PASSWORD, pay

from core import realtime

ERODE = {"lat": 11.3410, "lng": 77.7172, "accuracy": 18.4}
CF = {"cf-ipcity": "Erode", "cf-region": "Tamil Nadu", "cf-ipcountry": "IN"}


def _require_location(db):
    db.conn.execute("UPDATE settings SET value = '1' WHERE key = 'location_required'")
    from services import settings_service

    settings_service.invalidate_cache()


def _unlock(client, headers):
    token = client.post("/api/security/unlock", json={"password": ADMIN_PASSWORD}, headers=headers).json()["token"]
    return {**headers, "X-Security-Unlock": token}


def test_the_app_is_locked_until_the_device_shares_its_location(client, db, admin, member_session):
    _require_location(db)
    member, member_headers = member_session
    blocked = client.get("/api/me/overview", headers=member_headers)
    assert blocked.status_code == 428 and blocked.json()["error"]["code"] == "LOCATION_REQUIRED"
    assert client.get("/api/auth/me", headers=member_headers).status_code == 200  # sign-in routes still work
    assert client.post("/api/auth/location", json={"lat": 120, "lng": 0}, headers=member_headers).status_code == 422

    assert client.post("/api/auth/location", json=ERODE, headers={**member_headers, **CF}).status_code == 200
    assert client.get("/api/me/overview", headers=member_headers).status_code == 200

    # The admin sees where the member's phone is, and the first fix is in the activity log.
    assert client.post("/api/auth/location", json=ERODE, headers=admin).status_code == 200
    headers = _unlock(client, admin)
    device = client.get("/api/security/sessions", params={"role": "MEMBER"}, headers=headers).json()["items"][0]
    assert device["location"]["lat"] == pytest.approx(11.341) and device["location"]["accuracy_m"] == 18
    log = client.get("/api/security/activity", params={"category": "Security"}, headers=headers).json()["items"]
    shared = [i for i in log if i["action"] == "LOCATION_SHARED"]
    assert {i["name"] for i in shared} == {member["name"], "Admin"}
    assert any(i["target"] == "Erode, Tamil Nadu" for i in shared)


def test_an_admin_without_location_can_still_turn_the_requirement_off(client, db, admin):
    _require_location(db)
    assert client.get("/api/members", headers=admin).status_code == 428
    assert client.put("/api/settings", json={"location_required": False}, headers=admin).status_code == 200
    assert client.get("/api/members", headers=admin).status_code == 200
    assert client.get("/api/config").json()["location_required"] is False


def test_sign_in_records_the_network_city(client, db):
    from conftest import ADMIN_EMAIL, insert_user

    insert_user(db, role_id=1, name="Admin", email=ADMIN_EMAIL)
    token = client.post("/api/auth/login", json={"identifier": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, headers=CF).json()["token"]
    client.cookies.clear()
    headers = _unlock(client, {"Authorization": f"Bearer {token}"})
    device = client.get("/api/security/sessions", headers=headers).json()["items"][0]
    assert device["place"] == "Erode, Tamil Nadu, IN" and device["location"] is None


def _ticket(client, headers):
    response = client.post("/api/realtime/ticket", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["ticket"]


def test_live_updates_reach_the_right_apps(client, admin, staff, plans, member_session):
    member, member_headers = member_session
    with client.websocket_connect(f"/api/realtime/connect?ticket={_ticket(client, admin)}") as admin_socket, \
            client.websocket_connect(f"/api/realtime/connect?ticket={_ticket(client, member_headers)}") as member_socket:
        admin_socket.send_text("ping")
        assert admin_socket.receive_text() == "pong"

        # The desk records a payment: the admin's screens refresh (and the member's app, via their receipt).
        pay(client, staff, member["id"], plans["Monthly"])
        events = [admin_socket.receive_json(), admin_socket.receive_json()]
        assert {"type": "changed", "topics": ["security"]} in events
        assert any(e["type"] == "changed" and "payments" in e["topics"] for e in events)
        mine = member_socket.receive_json()
        assert mine["type"] == "changed" and "portal" in mine["topics"]

        # The member checks in at the desk: their app hears about it at once.
        assert client.post("/api/attendance", json={"member_id": member["id"], "action": "IN"}, headers=staff).status_code == 200
        assert "attendance" in member_socket.receive_json()["topics"]

        # Online right now, as the Security page shows.
        headers = _unlock(client, admin)
        devices = client.get("/api/security/sessions", params={"role": "MEMBER"}, headers=headers).json()["items"]
        assert devices[0]["online"] is True

        # The admin signs the member's phone out: the socket is told and closed immediately.
        client.post(f"/api/security/sessions/{devices[0]['id']}/sign-out", headers=headers)
        while member_socket.receive_json()["type"] != "signed_out":
            pass
        with pytest.raises(WebSocketDisconnect):
            member_socket.receive_json()


def test_a_bad_ticket_is_refused(client):
    with pytest.raises(WebSocketDisconnect) as refused:
        with client.websocket_connect("/api/realtime/connect?ticket=nope") as socket:
            socket.receive_text()
    assert refused.value.code == 4401


def test_tickets_name_the_device_and_expire():
    issued = realtime.issue_ticket({"uid": 7, "role": "MEMBER", "sid": 3, "mid": 9}, "x" * 40)
    who = realtime.read_ticket(issued["ticket"], "x" * 40)
    assert realtime.tags_for(who) == ["user:7", "role:MEMBER", "sid:3", "member:9"]
    assert realtime.read_ticket(issued["ticket"], "y" * 40) is None
