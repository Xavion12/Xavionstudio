"""Cloudflare Python Worker entrypoint for the Xavion Fitness API.

- fetch     -> FastAPI (ASGI) running inside the Worker, with the D1 binding as ``env.DB``
- scheduled -> the daily Cron Trigger (statuses, reminders, clean-up, storage snapshot) and the
               every-minute trigger that sends queued WhatsApp / email messages

No separate server (and no Uvicorn) is used in production: the Workers runtime is the entry
point. The FastAPI app is created at import time so it is captured in the Workers memory
snapshot.
"""

import logging

from workers import WorkerEntrypoint

from app import create_app

try:  # workers-runtime-sdk
    from workers import asgi
except Exception:  # older runtimes expose the adapter as a top-level module
    import asgi  # type: ignore[no-redef]

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = create_app()


REALTIME_PATH = "/api/realtime/connect"


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if REALTIME_PATH in str(request.url):
            # Live updates: the WebSocket goes to the realtime Durable Object (core/realtime.py).
            from core import realtime
            from core.config import config_from_worker_env

            return await realtime.connect_in_worker(request, self.env, config_from_worker_env(self.env).jwt_secret)
        return await asgi.fetch(app, request, self.env, self.ctx)

    async def scheduled(self, controller, env=None, ctx=None):
        from core.config import config_from_worker_env
        from core.database.d1 import D1Database
        from jobs.scheduler import DAILY_CRON, run_daily_jobs, send_messages

        worker_env = env if env is not None else self.env
        db, config = D1Database(worker_env.DB), config_from_worker_env(worker_env)
        if str(getattr(controller, "cron", DAILY_CRON)) == DAILY_CRON:
            await run_daily_jobs(db, config)
        else:
            await send_messages(db, config)
