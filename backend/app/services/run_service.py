from __future__ import annotations

import asyncio
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from app.events.bus import event_bus
from app.graph.workflow import build_graph
from app.repositories.run_store import run_store
from app.services.agent_profile_service import agent_profile_service
from app.services.memory_service import memory_service
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


async def _persist_conversation_direct(result: dict[str, Any]) -> None:
    run_id = str(result.get("run_id") or "")
    task = str(result.get("task") or "").strip()
    final_report = str(result.get("final_report") or "").strip()
    user_id = str(result.get("user_id") or "").strip()
    thread_id = str(result.get("thread_id") or result.get("session_id") or "").strip()
    if not run_id or not user_id or not thread_id or not task or not final_report:
        return

    try:
        neo4j_service.upsert_thread(thread_id, user_id, session_id=result.get("session_id"))
    except Exception:
        pass

    try:
        await memory_service.ensure_user_and_thread(user_id, thread_id)
    except Exception:
        pass

    user_episode_id = ""
    try:
        user_episode_id = neo4j_service.create_episode(
            run_id,
            thread_id,
            "user",
            "user_request",
            task,
            metadata={"task": task, "mode": result.get("mode"), "deferred": True},
            previous_episode_id=None,
        )
        await memory_service.add_message(
            user_id,
            thread_id,
            "user",
            task,
            metadata={"run_id": run_id, "agent_id": "user", "episode_id": user_episode_id, "deferred": True},
            return_context=False,
        )
        await memory_service.add_episode(
            user_id,
            thread_id,
            task,
            source_description="user",
            episode_type="user_request",
        )
    except Exception:
        pass

    try:
        final_episode_id = neo4j_service.create_episode(
            run_id,
            thread_id,
            "writer",
            "final_output",
            final_report,
            metadata={
                "task_type": result.get("task_type"),
                "speaker_agent": result.get("speaker_agent") or "writer",
                "deferred": True,
            },
            previous_episode_id=user_episode_id or None,
        )
        await memory_service.add_message(
            user_id,
            thread_id,
            "assistant",
            final_report,
            metadata={"run_id": run_id, "agent_id": "writer", "episode_id": final_episode_id, "deferred": True},
            return_context=False,
        )
        await memory_service.add_episode(
            user_id,
            thread_id,
            final_report,
            source_description="writer",
            episode_type="final_output",
        )
    except Exception:
        pass


def _spawn_deferred_persistence(result: dict[str, Any]) -> None:
    if result.get("fast_path") != "conversation_direct":
        return

    def _runner() -> None:
        try:
            asyncio.run(_persist_conversation_direct(result))
        except Exception:
            return

    threading.Thread(target=_runner, daemon=True).start()


async def execute_run(run_id: str, initial_state: dict[str, Any]) -> dict[str, Any]:
    started_at = datetime.now(tz=timezone.utc)
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
        finished_at = datetime.now(tz=timezone.utc)
        result["run_metrics"] = {
            **(result.get("run_metrics") or {}),
            "started_at": started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "elapsed_ms": int((finished_at - started_at).total_seconds() * 1000),
        }
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
        _spawn_deferred_persistence(result)
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


def create_run(task: str, mode: str, user_id: str, session_id: str, conservative_specialist_routing: bool = False) -> str:
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
        "conservative_specialist_routing": conservative_specialist_routing,
        "spoken_response": "",
        "research_notes": [],
        "citations": [],
        "critique_flags": [],
        "tool_results": [],
        "memory_refs": [],
        "errors": [],
        "warnings": [],
        "news_mode": "",
        "route_decision": {},
        "action_items": [],
        "operator_summary": "",
        "prompt_version": "",
        "policy_version": "",
        "run_metrics": {},
        "node_results": [],
        "force_degraded": False,
    }

    from app.workers.tasks import execute_run_task

    execute_run_task.delay(run_id, initial_state)
    return run_id
