from __future__ import annotations

import asyncio
import uuid
from typing import Any

from app.events.bus import event_bus
from app.graph.workflow import build_graph
from app.repositories.run_store import run_store
from app.services.neo4j_service import neo4j_service

workflow_app = build_graph()


async def execute_run(run_id: str, initial_state: dict[str, Any]) -> dict[str, Any]:
    run_store.update(run_id, status="running")
    neo4j_service.upsert_run(run_id, task=initial_state["task"], status="running")
    await event_bus.publish(run_id, {"node": "system", "status": "running", "detail": "Run started"})

    try:
        config = {"configurable": {"thread_id": run_id}}
        result = await workflow_app.ainvoke(initial_state, config=config)
        final_status = result.get("run_status", "completed")
        run_store.update(run_id, status=final_status, state=result, output=result.get("final_report"))
        neo4j_service.upsert_run(run_id, task=initial_state["task"], status=final_status)
        await event_bus.publish(run_id, {"node": "system", "status": final_status, "detail": "Run finished"})
        return result
    except Exception as exc:
        run_store.update(run_id, status="failed", state={"error": str(exc)}, output=None)
        neo4j_service.upsert_run(run_id, task=initial_state["task"], status="failed")
        await event_bus.publish(run_id, {"node": "system", "status": "failed", "detail": str(exc)})
        return {"error": str(exc)}


def create_run(task: str, mode: str, user_id: str, session_id: str) -> str:
    run_id = str(uuid.uuid4())
    run_store.create(run_id=run_id, task=task, mode=mode)

    initial_state = {
        "run_id": run_id,
        "task": task,
        "mode": mode,
        "user_id": user_id,
        "session_id": session_id,
        "revision_count": 0,
        "max_revisions": 2,
        "run_status": "queued",
        "research_notes": [],
        "citations": [],
        "critique_flags": [],
        "tool_results": [],
        "errors": [],
        "force_degraded": False,
    }

    asyncio.create_task(execute_run(run_id, initial_state))
    return run_id
