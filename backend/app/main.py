from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import settings
from app.core.logging import configure_logging, request_id_middleware
from app.services.chat_watchers_service import chat_watchers_service
from app.services.desktop_schedule_runner import desktop_schedule_runner
from app.services.event_watcher_service import event_watcher_service
from app.services.proactive_nudge_service import proactive_nudge_service
from app.services.workflow_schedule_runner import workflow_schedule_runner

configure_logging()
logger = logging.getLogger(__name__)


# Open endpoints that the frontend needs to reach without the bearer token.
# Anything else on the API requires Authorization: Bearer <API_BEARER_TOKEN>.
_OPEN_PATHS: tuple[str, ...] = (
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/scheduler/public/",
    "/google/oauth/callback",
    # Bookmarklet fires from arbitrary web pages — can't carry a bearer header.
    # The API binds to 127.0.0.1 only so the surface is still loopback-scoped.
    "/ask-about-page",
)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    desktop_schedule_runner.start()
    proactive_nudge_service.start()
    event_watcher_service.start()
    chat_watchers_service.start()
    workflow_schedule_runner.start()
    try:
        yield
    finally:
        for runner, name in (
            (workflow_schedule_runner, "workflow_schedule_runner"),
            (chat_watchers_service, "chat_watchers_service"),
            (event_watcher_service, "event_watcher_service"),
            (proactive_nudge_service, "proactive_nudge_service"),
            (desktop_schedule_runner, "desktop_schedule_runner"),
        ):
            stop = getattr(runner, "stop", None)
            if callable(stop):
                try:
                    stop()
                except Exception:
                    logger.exception("%s stop failed", name)


app = FastAPI(title=settings.app_name, lifespan=lifespan)


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)


# Outermost middleware (runs first): tag every request with a correlation ID and
# emit one structured access log line per request.
app.middleware("http")(request_id_middleware)


@app.middleware("http")
async def bearer_auth(request: Request, call_next):
    # Auth is opt-in: if the operator has not configured a bearer token the API
    # behaves as before. Once configured, every non-open endpoint requires it.
    expected = settings.api_bearer_token
    if not expected:
        return await call_next(request)
    path = request.url.path
    if request.method == "OPTIONS" or any(path == p or path.startswith(p) for p in _OPEN_PATHS):
        return await call_next(request)
    header = request.headers.get("authorization", "")
    provided = header[len("Bearer ") :] if header.startswith("Bearer ") else ""
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")
    return await call_next(request)


app.include_router(router)
