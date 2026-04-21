from __future__ import annotations

import json
import logging
import logging.config
import os
import sys
import time
from contextvars import ContextVar
from typing import Any
from uuid import uuid4

from fastapi import Request

_request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")


def get_request_id() -> str:
    return _request_id_ctx.get()


def set_request_id(value: str) -> None:
    _request_id_ctx.set(value)


class JsonFormatter(logging.Formatter):
    """Minimal structured JSON formatter.

    Avoids pulling in a third-party package and keeps the output shape stable
    regardless of how logs are produced (app code, uvicorn, libraries).
    """

    _RESERVED = (
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "asctime",
        "taskName",
    )

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": get_request_id(),
        }
        for key, value in record.__dict__.items():
            if key in self._RESERVED or key.startswith("_"):
                continue
            # Only include JSON-safe extras; fallback to repr.
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = repr(value)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def configure_logging() -> None:
    """Install JSON logging for the app, uvicorn, and FastAPI access logs.

    LEVEL can be overridden with LOG_LEVEL in the env (defaults to INFO).
    """
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    handler.setLevel(level)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # Quiet uvicorn's default text access log; we emit our own structured line per request.
    for noisy in ("uvicorn.access",):
        logging.getLogger(noisy).handlers.clear()
        logging.getLogger(noisy).propagate = False


async def request_id_middleware(request: Request, call_next):
    """Attach an X-Request-ID to every request, log timing, and propagate it via contextvar.

    Sets the header on the response so clients can correlate logs.
    """
    rid = request.headers.get("x-request-id") or uuid4().hex[:16]
    token = _request_id_ctx.set(rid)
    start = time.perf_counter()
    access_logger = logging.getLogger("app.access")
    try:
        response = await call_next(request)
    except Exception:
        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        access_logger.exception(
            "request_failed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "duration_ms": duration_ms,
                "client": request.client.host if request.client else None,
            },
        )
        raise
    finally:
        _request_id_ctx.reset(token)

    duration_ms = round((time.perf_counter() - start) * 1000, 2)
    response.headers["x-request-id"] = rid
    if request.url.path != "/health":
        access_logger.info(
            "request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "client": request.client.host if request.client else None,
            },
        )
    return response
