from __future__ import annotations

import asyncio
from typing import Any

from app.services.run_service import execute_run
from app.workers.celery_app import celery_app


@celery_app.task(name="watchdog.heartbeat")
def heartbeat() -> dict[str, str]:
    return {"status": "ok"}


@celery_app.task(name="runs.execute")
def execute_run_task(run_id: str, initial_state: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(execute_run(run_id, initial_state))
