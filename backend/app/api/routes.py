from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.events.bus import event_bus
from app.models.schemas import RunDetail, RunRequest, RunResponse
from app.repositories.run_store import run_store
from app.services.neo4j_service import neo4j_service
from app.services.run_service import create_run

router = APIRouter()


@router.post("/runs", response_model=RunResponse)
async def start_run(payload: RunRequest) -> RunResponse:
    run_id = create_run(
        task=payload.task,
        mode=payload.mode,
        user_id=payload.user_id,
        session_id=payload.session_id,
    )
    rec = run_store.get(run_id)
    return RunResponse(run_id=run_id, status=rec["status"] if rec else "queued")


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: str) -> RunDetail:
    rec = run_store.get(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")
    return RunDetail(**rec)


@router.get("/runs/{run_id}/events")
async def stream_events(run_id: str) -> StreamingResponse:
    async def event_generator():
        queue = await event_bus.subscribe(run_id)
        try:
            while True:
                msg = await queue.get()
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("status") in {"completed", "failed", "degraded"}:
                    break
        finally:
            event_bus.unsubscribe(run_id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/graph")
async def graph(limit: int = 100):
    return neo4j_service.fetch_graph(limit=limit)


@router.get("/health")
async def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "dependencies": {
            "neo4j": "configured",
            "redis": settings.redis_url,
            "postgres": settings.postgres_dsn,
            "zep": "enabled" if settings.zep_api_key else "disabled",
        },
    }
