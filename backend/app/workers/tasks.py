from __future__ import annotations

from app.workers.celery_app import celery_app


@celery_app.task(name="watchdog.heartbeat")
def heartbeat() -> dict[str, str]:
    return {"status": "ok"}
