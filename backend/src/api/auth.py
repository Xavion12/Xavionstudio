"""/api/auth — sign in, session, password change and first-run setup."""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from schemas.requests import ChangePasswordIn, LocationIn, LoginIn, SetupIn
from security import session_cookie
from security.rate_limit import check_rate
from security.tokens import TokenError, decode_token
from services.auth_service import AuthService
from services.context import Ctx

from .contexts import public_ctx, temp_ctx
from .responses import FastJSON, no_content, ok

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")


def _with_session(request: Request, auth: dict[str, Any], status: int = 200) -> FastJSON:
    """The session goes into an HttpOnly cookie; the body keeps the token for scripts (Bearer)."""
    response = ok(auth, status=status)
    return session_cookie.attach(response, request, auth["token"], auth["expires_at"] - int(time.time()))


@router.post("/login")
async def login(body: LoginIn, request: Request, ctx: Ctx = Depends(public_ctx)) -> FastJSON:
    return _with_session(request, await AuthService(ctx).login(body.identifier, body.password, body.remember, _client_ip(request)))


@router.post("/logout", status_code=204)
async def logout(request: Request, ctx: Ctx = Depends(public_ctx)) -> Response:
    """Ends this device's session (it leaves the signed-in devices list) and clears the cookie.
    Works even if the session already expired."""
    header = request.headers.get("authorization") or ""
    token = header[7:].strip() if header.lower().startswith("bearer ") else session_cookie.read(request)
    if token:
        try:
            claims = decode_token(token, ctx.config.jwt_secret, now=int(time.time()))
            user_id, session_id = int(claims["sub"]), claims.get("sid")
        except (TokenError, KeyError, ValueError, TypeError):
            user_id, session_id = 0, None
        if user_id and isinstance(session_id, int):
            await AuthService(ctx).logout(user_id, session_id)
    return session_cookie.clear(no_content(), request)


@router.post("/location")
async def share_location(body: LocationIn, ctx: Ctx = Depends(temp_ctx)) -> FastJSON:
    """This device's location (compulsory while Settings -> location_required is on)."""
    accuracy = round(body.accuracy) if body.accuracy is not None else None
    return ok(await AuthService(ctx).share_location(ctx.user, body.lat, body.lng, accuracy))


@router.get("/me")
async def me(ctx: Ctx = Depends(temp_ctx)) -> FastJSON:
    return ok(await AuthService(ctx).me(ctx.user))


@router.post("/change-password")
async def change_password(body: ChangePasswordIn, request: Request, ctx: Ctx = Depends(temp_ctx)) -> FastJSON:
    # Every other session ends; this browser gets a fresh cookie.
    return _with_session(request, await AuthService(ctx).change_password(ctx.user, body.current_password, body.new_password))


@router.post("/logout-all", status_code=204)
async def logout_all(request: Request, ctx: Ctx = Depends(temp_ctx)) -> Response:
    await AuthService(ctx).logout_everywhere(ctx.user)
    return session_cookie.clear(no_content(), request)


@router.get("/setup-status")
async def setup_status(ctx: Ctx = Depends(public_ctx)) -> FastJSON:
    return ok(await AuthService(ctx).setup_status())


@router.post("/setup", status_code=201)
async def setup(body: SetupIn, request: Request, ctx: Ctx = Depends(public_ctx)) -> FastJSON:
    await check_rate(ctx.env, "LOGIN_LIMITER", f"setup:{_client_ip(request)}")
    auth = await AuthService(ctx).setup_first_admin(body.setup_token, body.name, body.email, body.password)
    return _with_session(request, auth, status=201)
