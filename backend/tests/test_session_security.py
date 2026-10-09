"""Sign-in sessions as HttpOnly cookies, the cross-site (CSRF) check, and what share links expose."""

from conftest import ADMIN_EMAIL, ADMIN_PASSWORD, create_member, pay

from security import session_cookie


def _cookie_login(client) -> None:
    response = client.post("/api/auth/login", json={"identifier": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert response.status_code == 200, response.text
    header = response.headers["set-cookie"].lower()
    assert "httponly" in header and "samesite=strict" in header and "path=/" in header


def test_sign_in_sets_an_httponly_cookie_that_signs_requests_in(client, admin):
    _cookie_login(client)
    assert client.cookies.get(session_cookie.DEV_NAME)
    assert client.get("/api/auth/me").json()["role"] == "ADMIN"  # no Authorization header


def test_secure_cookie_over_https(client, admin):
    response = client.post("/api/auth/login", json={"identifier": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                           headers={"x-forwarded-proto": "https"})
    header = response.headers["set-cookie"]
    assert header.startswith(f"{session_cookie.SECURE_NAME}=") and "Secure" in header


def test_cookie_changes_must_come_from_the_app(client, admin):
    _cookie_login(client)
    body = {"name": "Csrf Test", "phone": "9123456780"}
    # Another site's page (or no Origin at all) can't use the cookie to change anything.
    assert client.post("/api/members", json=body, headers={"origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/members", json=body).status_code == 403
    # The app's own pages can.
    assert client.post("/api/members", json=body, headers={"origin": "http://testserver"}).status_code == 201
    assert client.post("/api/members", json={**body, "phone": "9123456781"},
                       headers={"referer": "http://testserver/members"}).status_code == 201


def test_logout_clears_the_cookie(client, admin):
    _cookie_login(client)
    response = client.post("/api/auth/logout", headers={"origin": "http://testserver"})
    assert response.status_code == 204
    assert not client.cookies.get(session_cookie.DEV_NAME)
    assert client.get("/api/auth/me").status_code == 401


def test_logout_everywhere_ends_cookie_sessions(client, admin):
    _cookie_login(client)
    stolen = client.cookies.get(session_cookie.DEV_NAME)
    assert client.post("/api/auth/logout-all", headers={"origin": "http://testserver"}).status_code == 204
    client.cookies.set(session_cookie.DEV_NAME, stolen)
    assert client.get("/api/auth/me").status_code == 401


def test_public_receipt_hides_contact_details(client, admin, plans):
    member = create_member(client, admin, email="aarav@example.com", address="12 Private Street")["member"]
    paid = pay(client, admin, member["id"], plans["Monthly"]).json()["payment"]
    token = client.get(f"/api/payments/{paid['id']}/receipt", headers=admin).json()["share_path"].removeprefix("/r/")
    public = client.get(f"/api/public/receipts/{token}").json()
    assert public["member_phone"] == "••••••3210"
    assert "member_whatsapp" not in public and "share_path" not in public
    assert public["member_name"] == "Aarav Sharma" and public["amount"] == paid["amount"]


def test_public_member_report_hides_personal_details(client, admin, plans):
    member = create_member(client, admin, email="aarav@example.com", address="12 Private Street",
                           date_of_birth="1995-04-12", emergency_contact="Mom 9000000000")["member"]
    body = {"from": "2026-09-01", "to": "2026-09-30", "sections": ["membership", "attendance"]}
    token = client.post(f"/api/members/{member['id']}/report/link", json=body, headers=admin).json()["path"].removeprefix("/mr/")
    report = client.get(f"/api/public/member-reports/{token}").json()
    shared = report["member"]
    assert shared["name"] == "Aarav Sharma" and shared["phone"] == "••••••3210" and shared["email"] == "a•••@example.com"
    for private in ("address", "date_of_birth", "emergency_contact", "gender", "app", "pending_payment"):
        assert private not in shared
    assert "member_whatsapp" not in report
    text = str(report)
    assert "Private Street" not in text and "9000000000" not in text and "9876543210" not in text


def test_api_responses_are_not_indexed(client):
    assert "noindex" in client.get("/api/health").headers.get("x-robots-tag", "")
