from __future__ import annotations

from celery import Celery

from app.core.config import settings

# Use a local-only broker URL when Redis isn't configured (native-app mode).
# The celery_app still instantiates fine so ``@celery_app.task`` decorators work,
# but we never actually enqueue unless dispatch_run picks the Celery path.
_broker = settings.redis_url or "memory://"
_backend = settings.redis_url or "cache+memory://"

celery_app = Celery("kg_agent", broker=_broker, backend=_backend)
celery_app.conf.update(task_serializer="json", result_serializer="json", accept_content=["json"])
celery_app.autodiscover_tasks(["app.workers"])
