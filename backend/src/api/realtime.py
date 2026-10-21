"""/api/realtime — live updates over WebSocket (core/realtime.py).

1. POST /api/realtime/ticket (signed in): a 60-second ticket naming this user, role and device.
2. Open ``wss://<site>/api/realtime/connect?ticket=...``. In production the Worker entry hands the
   socket to the realtime Durable Object before FastAPI runs; this route is the local-development
   stand-in with the same behaviour.

The socket only receives "what changed" hints and "signed_out"; it sends "ping" every 25 s.
"""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, Depends, WebSocket

from core import realtime
from services.context import Ctx

from .contexts import temp_ctx
from .responses import FastJSON, ok

router = APIRouter(prefix="/realtime", tags=["realtime"])


@router.post("/ticket")
async def ticket(ctx: Ctx = Depends(temp_ctx)) -> FastJSON:
    user = ctx.user
    who = {"uid": user.id, "role": user.role, "sid": user.session_id, "mid": user.member_id}
    return ok({**realtime.issue_ticket(who, ctx.config.jwt_secret), "path": "/api/realtime/connect"})


@router.websocket("/connect")
async def connect(socket: WebSocket, ticket: str = "") -> None:
    config = (socket.scope.get("state") or {}).get("config")
    who = realtime.read_ticket(ticket, config.jwt_secret) if config else None
    if who is None:
        await socket.close(code=4401)
        return
    await socket.accept()
    socket_id, queue = realtime.local_hub.connect(realtime.tags_for(who))

    async def outgoing() -> None:
        while True:
            item = await queue.get()
            await socket.send_json(item["event"])
            if item["close"]:
                await socket.close(code=4000)
                return

    async def incoming() -> None:
        while True:
            if await socket.receive_text() == "ping":
                await socket.send_text("pong")

    tasks = [asyncio.ensure_future(outgoing()), asyncio.ensure_future(incoming())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
        realtime.local_hub.disconnect(socket_id)
