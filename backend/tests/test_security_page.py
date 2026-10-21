"""Security page: signed-in devices (counts include members), device sign-out, the activity log,
and the password unlock that only an admin can pass."""

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD, create_member, login, pay

PHONE = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36"


def _unlock(client, admin) -> dict[str, str]:
    response = client.post("/api/security/unlock", json={"password": ADMIN_PASSWORD}, headers=admin)
    assert response.status_code == 200, response.text
    return {**admin, "X-Security-Unlock": response.json()["token"]}


def test_only_an_admin_who_reenters_the_password_can_open_it(client, admin, staff, member_session):
    _, member = member_session
    assert client.get("/api/security/overview", headers=staff).status_code == 403
    assert client.post("/api/security/unlock", json={"password": ADMIN_PASSWORD}, headers=staff).status_code == 403
    assert client.post("/api/security/unlock", json={"password": ADMIN_PASSWORD}, headers=member).status_code == 403

    locked = client.get("/api/security/overview", headers=admin)
    assert locked.status_code == 403 and locked.json()["error"]["code"] == "SECURITY_LOCKED"
    wrong = client.post("/api/security/unlock", json={"password": "not-it"}, headers=admin)
    assert wrong.status_code == 422
    assert client.get("/api/security/overview", headers=_unlock(client, admin)).status_code == 200

    # The unlock belongs to the device that typed the password.
    other_device = login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    token = _unlock(client, admin)["X-Security-Unlock"]
    assert client.get("/api/security/overview", headers={**other_device, "X-Security-Unlock": token}).status_code == 403


def test_signed_in_devices_are_counted_by_role_including_members(client, admin, staff, member_session):
    member, member_headers = member_session
    headers = _unlock(client, admin)
    overview = client.get("/api/security/overview", headers=headers).json()
    roles = {r["role"]: r for r in overview["roles"]}
    assert roles["MEMBER"]["devices"] == 1 and roles["MEMBER"]["people"] == 1
    assert roles["STAFF"]["devices"] == 1 and roles["ADMIN"]["people"] == 1
    assert overview["devices"] == sum(r["devices"] for r in overview["roles"])
    assert overview["today"]["sign_ins"] >= 3

    listed = client.get("/api/security/sessions", params={"role": "MEMBER"}, headers=headers).json()
    assert listed["total"] == 1 and listed["items"][0]["name"] == member["name"]
    assert listed["items"][0]["login"] == member["member_code"]


def test_admin_can_sign_out_one_device(client, admin, member_session):
    _, member_headers = member_session
    phone = client.post("/api/auth/login", json={"identifier": "desk@smartgym.test", "password": "x"})  # unknown login
    assert phone.status_code == 401
    headers = _unlock(client, admin)
    item = client.get("/api/security/sessions", params={"role": "MEMBER"}, headers=headers).json()["items"][0]
    assert client.post(f"/api/security/sessions/{item['id']}/sign-out", headers=headers).status_code == 204
    gone = client.get("/api/auth/me", headers=member_headers)
    assert gone.status_code == 401 and gone.json()["error"]["code"] == "SESSION_EXPIRED"
    assert client.get("/api/security/sessions", params={"role": "MEMBER"}, headers=headers).json()["total"] == 0
    # The admin's own device can't be signed out from here.
    mine = next(i for i in client.get("/api/security/sessions", headers=headers).json()["items"] if i["current"])
    assert client.post(f"/api/security/sessions/{mine['id']}/sign-out", headers=headers).status_code == 422


def test_device_label_and_logout_leave_the_list(client, admin, db):
    response = client.post("/api/auth/login", json={"identifier": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                           headers={"user-agent": PHONE})
    phone = {"Authorization": f"Bearer {response.json()['token']}"}
    client.cookies.clear()
    headers = _unlock(client, admin)
    devices = {i["device"] for i in client.get("/api/security/sessions", headers=headers).json()["items"]}
    assert "Chrome on Android" in devices
    assert client.post("/api/auth/logout", headers=phone).status_code == 204
    assert client.get("/api/auth/me", headers=phone).status_code == 401
    devices = {i["device"] for i in client.get("/api/security/sessions", headers=headers).json()["items"]}
    assert "Chrome on Android" not in devices


def test_activity_log_records_sign_ins_failures_and_changes(client, admin, plans):
    client.post("/api/auth/login", json={"identifier": ADMIN_EMAIL, "password": "wrong-password"})
    client.post("/api/auth/login", json={"identifier": "nobody@example.com", "password": "whatever"})
    member = create_member(client, admin, name="Kavya Iyer", phone="9123456789")["member"]
    pay(client, admin, member["id"], plans["Monthly"])
    client.put("/api/settings", json={"gym_phone": "9876500000"}, headers=admin)

    headers = _unlock(client, admin)
    items = client.get("/api/security/activity", headers=headers).json()["items"]
    actions = [i["action"] for i in items]
    for expected in ("LOGIN", "LOGIN_FAILED", "MEMBER_ADDED", "PAYMENT_RECORDED", "SETTINGS_CHANGED", "SECURITY_UNLOCKED"):
        assert expected in actions, expected
    payment = next(i for i in items if i["action"] == "PAYMENT_RECORDED")
    assert payment["target"] == f"Kavya Iyer · {member['member_code']}" and payment["name"] == "Admin"
    unknown = next(i for i in items if i["action"] == "LOGIN_FAILED" and i["user_id"] is None)
    assert "nobody" not in unknown["summary"] and "no•••@example.com" in unknown["summary"]
    assert not any("password" in (i["target"] or "") for i in items)

    payments_only = client.get("/api/security/activity", params={"category": "Payments"}, headers=headers).json()["items"]
    assert payments_only and {i["category"] for i in payments_only} == {"Payments"}
    found = client.get("/api/security/activity", params={"q": "kavya"}, headers=headers).json()["items"]
    assert {i["action"] for i in found} >= {"MEMBER_ADDED", "PAYMENT_RECORDED"}


def test_password_change_ends_the_other_devices(client, admin):
    second = login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    response = client.post("/api/auth/change-password", json={"current_password": ADMIN_PASSWORD, "new_password": "Fresh@2026pass"},
                           headers=admin)
    assert response.status_code == 200
    assert client.get("/api/auth/me", headers=second).status_code == 401
    fresh = {"Authorization": f"Bearer {response.json()['token']}"}
    client.cookies.clear()
    token = client.post("/api/security/unlock", json={"password": "Fresh@2026pass"}, headers=fresh).json()["token"]
    listed = client.get("/api/security/sessions", params={"role": "ADMIN"}, headers={**fresh, "X-Security-Unlock": token}).json()
    assert listed["total"] == 1 and listed["items"][0]["current"]
