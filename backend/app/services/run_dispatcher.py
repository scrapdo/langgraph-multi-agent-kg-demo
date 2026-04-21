"""Routes ``execute_run`` to Celery (when Redis is configured) or to an in-process
background thread (when it isn't).

Native-app builds ship without Redis or a Celery worker, so the backend has to
be self-sufficient. The dispatcher picks at runtime based on ``settings.redis_url``.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from app.core.config import settings

logger = logging.getLogger("app.run_dispatcher")


def _run_in_thread(run_id: str, initial_state: dict[str, Any]) -> None:
    """Fire-and-forget: execute_run is async, so we spawn a daemon thread with
    its own event loop. We don't block the FastAPI request thread."""
    def _runner() -> None:
        try:
            from app.services.run_service import execute_run

            asyncio.run(execute_run(run_id, initial_state))
        except Exception:
            logger.exception("in-process run failed run_id=%s", run_id)

    threading.Thread(target=_runner, name=f"run-{run_id[:8]}", daemon=True).start()


def dispatch_run(run_id: str, initial_state: dict[str, Any]) -> None:
    """Kick off a run. Returns immediately; the run itself happens in the background."""
    if settings.redis_url:
        try:
            from app.workers.tasks import execute_run_task

            execute_run_task.delay(run_id, initial_state)
            return
        except Exception as exc:
            logger.warning("celery dispatch failed (%s); falling back to in-process", exc)

    _run_in_thread(run_id, initial_state)
