from __future__ import annotations

from celery import Celery

from app.core.config import settings

celery_app = Celery("kg_agent", broker=settings.redis_url, backend=settings.redis_url)
celery_app.conf.update(task_serializer="json", result_serializer="json", accept_content=["json"])
celery_app.autodiscover_tasks(["app.workers"])
