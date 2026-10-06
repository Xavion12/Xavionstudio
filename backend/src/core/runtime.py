"""Runtime detection and background work.

Cloudflare Python Workers run on Pyodide (``sys.platform == 'emscripten'``). There, work that must
outlive the response (sending WhatsApp / email right after a payment) is handed to the runtime's
``waitUntil``, so the desk gets its answer at once and the message still goes out a moment later.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import Coroutine
from typing import Any

IN_WORKER = sys.platform == "emscripten"
# Tests set this so background work runs before the response returns and can be asserted on.
INLINE = False

logger = logging.getLogger("smartgym.runtime")
_tasks: set[asyncio.Future] = set()


async def _guarded(coro: Coroutine[Any, Any, Any], name: str) -> None:
    try:
        await coro
    except Exception:  # background work must never surface as a request error
        logger.exception("background task %s failed", name)


async def run_in_background(coro: Coroutine[Any, Any, Any], name: str = "task") -> None:
    """Run ``coro`` after the current response without delaying it."""
    if INLINE:
        await _guarded(coro, name)
        return
    task = asyncio.ensure_future(_guarded(coro, name))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    if IN_WORKER:
        from workers import wait_until  # noqa: PLC0415 - only exists inside the Workers runtime

        wait_until(task)
