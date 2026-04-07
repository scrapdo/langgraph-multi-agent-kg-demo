from __future__ import annotations

import asyncio
import uuid
from typing import Any

from app.events.bus import event_bus
from app.graph.workflow import build_graph
from app.repositories.run_store import run_store
from app.services.agent_profile_service import agent_profile_service
from app.services.neo4j_service import neo4j_service

workflow_app = build_graph()


async def _safe_upsert_run(
    run_id: str,
    task: str,
    status: str,
    *,
    user_id: str | None = None,
    thread_id: str | None = None,
    mode: str | None = None,
    task_type: str | None = None,
) -> None:
    try:
        neo4j_service.upsert_run(
            run_id,
            task=task,
            status=status,
            user_id=user_id,
            thread_id=thread_id,
            mode=mode,
            task_type=task_type,
        )
    except Exception:
        return


async def execute_run(run_id: str, initial_state: dict[str, Any]) -> dict[str, Any]:
    run_store.update(run_id, status="running")
    await _safe_upsert_run(
        run_id,
        task=initial_state["task"],
        status="running",
        user_id=initial_state.get("user_id"),
        thread_id=initial_state.get("thread_id"),
        mode=initial_state.get("mode"),
        task_type=initial_state.get("task_type"),
    )
    await event_bus.publish(run_id, {"node": "system", "status": "running", "detail": "Run started"})

    try:
        config = {"configurable": {"thread_id": run_id}}
        result = await workflow_app.ainvoke(initial_state, config=config)
        final_status = result.get("run_status", "completed")
        run_store.update(run_id, status=final_status, state=result, output=result.get("final_report"))
        await _safe_upsert_run(
            run_id,
            task=initial_state["task"],
            status=final_status,
            user_id=initial_state.get("user_id"),
            thread_id=result.get("thread_id") or initial_state.get("thread_id"),
            mode=initial_state.get("mode"),
            task_type=result.get("task_type") or initial_state.get("task_type"),
        )
        await event_bus.publish(run_id, {"node": "system", "status": final_status, "detail": "Run finished"})
        return result
    except Exception as exc:
        run_store.update(run_id, status="failed", state={"error": str(exc)}, output=None)
        await _safe_upsert_run(
            run_id,
            task=initial_state["task"],
            status="failed",
            user_id=initial_state.get("user_id"),
            thread_id=initial_state.get("thread_id"),
            mode=initial_state.get("mode"),
            task_type=initial_state.get("task_type"),
        )
        await event_bus.publish(run_id, {"node": "system", "status": "failed", "detail": str(exc)})
        return {"error": str(exc)}


def create_run(task: str, mode: str, user_id: str, session_id: str) -> str:
    run_id = str(uuid.uuid4())
    run_store.create(run_id=run_id, task=task, mode=mode)

    initial_state = {
        "run_id": run_id,
        "task": task,
        "task_type": "conversation",
        "agent_profiles": agent_profile_service.get_profiles(),
        "mode": mode,
        "user_id": user_id,
        "session_id": session_id,
        "thread_id": session_id,
        "thread_initialized": False,
        "thread_context": "",
        "memory_context": "",
        "episodes": [],
        "episode_ids": [],
        "claims": [],
        "entity_mentions": [],
        "graph_deltas": [],
        "last_episode_id": "",
        "revision_count": 0,
        "max_revisions": 2,
        "run_status": "queued",
        "spoken_response": "",
        "research_notes": [],
        "citations": [],
        "critique_flags": [],
        "tool_results": [],
        "memory_refs": [],
        "errors": [],
        "force_degraded": False,
    }

    asyncio.create_task(execute_run(run_id, initial_state))
    return run_id
