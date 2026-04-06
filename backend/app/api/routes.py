from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse

from app.core.config import settings
from app.events.bus import event_bus
from app.models.schemas import (
    AgentProfilesPayload,
    AgentProfileUpdatePayload,
    RunDetail,
    RunRequest,
    RunResponse,
)
from app.repositories.run_store import run_store
from app.services.agent_profile_service import agent_profile_service
from app.services.model_router_service import available_catalog
from app.services.neo4j_service import neo4j_service
from app.services.run_service import create_run
from app.services.tts_service import tts_service

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


@router.get("/providers/catalog")
async def providers_catalog():
    return available_catalog()


@router.get("/agents/config", response_model=AgentProfilesPayload)
async def get_agent_profiles() -> AgentProfilesPayload:
    return AgentProfilesPayload(agents=agent_profile_service.get_profiles())


@router.put("/agents/config", response_model=AgentProfilesPayload)
async def update_agent_profiles(payload: AgentProfileUpdatePayload) -> AgentProfilesPayload:
    updates = {k: v.model_dump(exclude_none=True) for k, v in payload.agents.items()}
    updated = agent_profile_service.update_profiles(updates)
    return AgentProfilesPayload(agents=updated)


@router.get("/health")
async def health():
    catalog = available_catalog()
    provider_state = {p["id"]: ("enabled" if p.get("enabled") else "disabled") for p in catalog["providers"]}
    return {
        "status": "ok",
        "app": settings.app_name,
        "dependencies": {
            "neo4j": "configured",
            "redis": settings.redis_url,
            "postgres": settings.postgres_dsn,
            "zep": "enabled" if settings.zep_api_key else "disabled",
            **provider_state,
        },
    }


@router.get("/runs/{run_id}/speech")
async def run_speech(run_id: str, voice: str | None = None, fmt: str = "mp3"):
    rec = run_store.get(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")

    state = rec.get("state") or {}
    raw = state.get("spoken_response") or rec.get("output") or rec.get("task")
    text = str(raw or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No speech text available for this run")

    safe_text = text[:1300]

    try:
        audio = await tts_service.synthesize(safe_text, voice=voice, audio_format=fmt)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    media_type = "audio/mpeg" if fmt == "mp3" else "audio/wav"
    return Response(content=audio, media_type=media_type, headers={"Cache-Control": "no-store"})
