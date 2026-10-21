"""Live updates over WebSocket.

Production: every open app holds one WebSocket to a Cloudflare Durable Object (``RealtimeHub`` in
the separate ``xavion-realtime`` Worker, ../realtime). The Python Worker checks a short-lived
ticket and hands the upgrade to the hub; after any change it sends the hub a few small messages
and the hub pushes them to the matching sockets at once.

Messages carry *what changed* (topics such as "payments" or "attendance"), never the data
itself: each screen then reloads what it shows through the normal, permission-checked API. So a
member's app can be told "your payments changed" without the socket ever carrying anyone's data.

Each socket is tagged ``user:<id>``, ``role:<ROLE>``, ``sid:<session id>`` and, for members,
``member:<id>``. A message goes to every socket with any of its ``to`` tags (minus ``except``);
``close`` also closes those sockets (a device signed out by the admin leaves at once).

Local development and tests use the in-process ``LocalHub`` with the same message format.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

from security.tokens import TokenError, create_token, decode_token

logger = logging.getLogger("smartgym.realtime")

TICKET_SECONDS = 60
HUB_NAME = "gym"

# What a logged change means for the screens that show it (activity category -> topics).
TOPICS_BY_CATEGORY: dict[str, list[str]] = {
    "Attendance": ["attendance", "dashboard", "members"],
    "Payments": ["payments", "memberships", "dashboard", "members"],
    "Members": ["members", "dashboard"],
    "Plans": ["plans"],
    "Workouts": ["workouts", "progress"],
    "Expenses": ["expenses", "dashboard"],
    "Messages": ["notifications"],
    "Member app": ["payments", "members", "dashboard"],
    "Team": ["team"],
    "Settings": ["settings"],
    "Data": ["all"],
}
STAFF_TAGS = ["role:ADMIN", "role:STAFF"]
TEAM_TAGS = ["role:ADMIN", "role:STAFF", "role:TRAINER"]


def _ticket_secret(jwt_secret: str) -> str:
    return hashlib.sha256(f"realtime-ticket:{jwt_secret}".encode()).hexdigest()


def issue_ticket(who: dict[str, Any], jwt_secret: str) -> dict[str, Any]:
    expires = int(time.time()) + TICKET_SECONDS
    return {"ticket": create_token({**who, "purpose": "realtime", "exp": expires}, _ticket_secret(jwt_secret)), "expires_at": expires}


def read_ticket(ticket: str, jwt_secret: str) -> dict[str, Any] | None:
    try:
        claims = decode_token(ticket or "", _ticket_secret(jwt_secret), now=int(time.time()))
    except TokenError:
        return None
    if claims.get("purpose") != "realtime" or not isinstance(claims.get("uid"), int):
        return None
    return claims


def tags_for(who: dict[str, Any]) -> list[str]:
    tags = [f"user:{who['uid']}", f"role:{who['role']}", f"sid:{who.get('sid')}"]
    if who.get("mid"):
        tags.append(f"member:{who['mid']}")
    return tags


def message(to: list[str], event: dict[str, Any], *, except_: list[str] | None = None, close: bool = False) -> dict[str, Any]:
    return {"to": to, "except": except_ or [], "event": event, "close": close}


def changed(to: list[str], topics: list[str], **extra: Any) -> dict[str, Any]:
    return message(to, {"type": "changed", "topics": topics, **extra})


# -- the in-process hub (local development and tests) ---------------------------------------------------
class LocalHub:
    def __init__(self) -> None:
        self.sockets: dict[int, tuple[set[str], asyncio.Queue]] = {}
        self.sent: list[dict[str, Any]] = []  # every message published (tests read this)
        self._next = 0

    def connect(self, tags: list[str]) -> tuple[int, asyncio.Queue]:
        self._next += 1
        queue: asyncio.Queue = asyncio.Queue()
        self.sockets[self._next] = (set(tags), queue)
        return self._next, queue

    def disconnect(self, socket_id: int) -> None:
        self.sockets.pop(socket_id, None)

    def online_sessions(self) -> set[int]:
        found = set()
        for tags, _ in self.sockets.values():
            for tag in tags:
                if tag.startswith("sid:") and tag[4:].isdigit():
                    found.add(int(tag[4:]))
        return found

    def deliver(self, messages: list[dict[str, Any]]) -> None:
        self.sent.extend(messages)
        for msg in messages:
            to, skip = set(msg["to"]), set(msg.get("except") or [])
            for tags, queue in list(self.sockets.values()):
                if tags & to and not tags & skip:
                    queue.put_nowait({"event": msg["event"], "close": bool(msg.get("close"))})


local_hub = LocalHub()


# -- the Durable Object (production) --------------------------------------------------------------------
def _stub(env: Any) -> Any:
    from core.database.d1 import raw_binding  # noqa: PLC0415

    namespace = raw_binding(env.REALTIME)
    return namespace.get(namespace.idFromName(HUB_NAME))


async def _hub_call(env: Any, path: str, payload: dict[str, Any] | None = None) -> Any:
    import js  # type: ignore[import-not-found]  # noqa: PLC0415

    init = {"method": "POST", "headers": {"content-type": "application/json"}, "body": json.dumps(payload or {})}
    response = await _stub(env).fetch(f"https://hub.internal/{path}", js.JSON.parse(json.dumps(init)))
    return json.loads(await response.text())


def has_hub(env: Any) -> bool:
    return env is not None and getattr(env, "REALTIME", None) is not None


async def publish(env: Any, messages: list[dict[str, Any]]) -> None:
    if not messages:
        return
    if has_hub(env):
        try:
            await _hub_call(env, "publish", {"messages": messages})
        except Exception:  # live updates are a convenience: screens still refresh on their own
            logger.exception("could not reach the realtime hub")
        return
    local_hub.deliver(messages)


async def online_sessions(env: Any) -> set[int]:
    """Session ids with an open live connection right now."""
    if has_hub(env):
        try:
            return {int(s) for s in (await _hub_call(env, "presence")).get("sessions", [])}
        except Exception:
            logger.exception("could not read presence from the realtime hub")
            return set()
    return local_hub.online_sessions()


async def connect_in_worker(request: Any, env: Any, jwt_secret: str) -> Any:
    """Workers entry: check the ticket and hand the WebSocket upgrade to the hub (JS Response)."""
    import js  # type: ignore[import-not-found]  # noqa: PLC0415

    raw = getattr(request, "js_object", request)
    url = js.URL.new(raw.url)
    who = read_ticket(url.searchParams.get("ticket") or "", jwt_secret)
    if raw.headers.get("Upgrade") != "websocket":
        return js.Response.new("Expected a WebSocket.", js.JSON.parse('{"status": 426}'))
    if who is None or not has_hub(env):
        return js.Response.new("Live updates are not available.", js.JSON.parse('{"status": 403}'))
    # A fresh request (method + headers incl. Upgrade) so the client can't send its own tags.
    headers = js.Headers.new(raw.headers)
    headers.set("X-Realtime-Tags", json.dumps(tags_for(who)))
    return await _stub(env).fetch(js.Request.new(raw.url, _upgrade_init(raw, headers)))


def _upgrade_init(raw: Any, headers: Any) -> Any:
    import js  # type: ignore[import-not-found]  # noqa: PLC0415

    init = js.Object.new()
    init.method = raw.method
    init.headers = headers
    return init
