"""The sign-in session as an HttpOnly cookie, so page scripts (and any injected script) can never
read the token.

    __Host-xavion_session=<jwt>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<ttl>

``__Host-`` makes browsers refuse the cookie unless it is Secure, host-only and Path=/ (no
subdomain or plain-HTTP page can set or overwrite it). Over plain HTTP (local development only)
the cookie is ``xavion_session`` without Secure. SameSite=Strict keeps other sites' pages from
sending it; deps.py also checks the Origin of every cookie-authenticated change.

``Authorization: Bearer`` keeps working for scripts and tests.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import Response

SECURE_NAME = "__Host-xavion_session"
DEV_NAME = "xavion_session"


def _secure(request: Request) -> bool:
    forwarded = (request.headers.get("x-forwarded-proto") or "").lower()
    return request.url.scheme == "https" or forwarded == "https"


def read(request: Request) -> str | None:
    return request.cookies.get(SECURE_NAME) or request.cookies.get(DEV_NAME) or None


def attach(response: Response, request: Request, token: str, max_age: int) -> Response:
    secure = _secure(request)
    response.set_cookie(
        SECURE_NAME if secure else DEV_NAME, token, max_age=max(0, max_age), path="/", secure=secure,
        httponly=True, samesite="strict",
    )
    return response


def clear(response: Response, request: Request) -> Response:
    for name, secure in ((SECURE_NAME, True), (DEV_NAME, False)):
        if secure and not _secure(request):
            continue
        response.delete_cookie(name, path="/", secure=secure, httponly=True, samesite="strict")
    return response
