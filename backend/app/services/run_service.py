from __future__ import annotations

import asyncio
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from app.core.pricing import estimate_cost_usd
from app.core.token_tracker import TokenTracker
from app.events.bus import event_bus
from app.graph.workflow import build_graph
from app.repositories.run_store import run_store
from app.services.agent_profile_service import agent_profile_service
from app.services.memory_service import memory_service
from app.services.neo4j_service import neo4j_service
from app.services.user_profile_service import user_profile_service

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


def _estimate_tokens(text: str) -> int:
    """Rough tokens-from-chars estimate. ~4 chars per token is the common
    heuristic for English + code; close enough for a UI badge, zero deps."""
    if not text:
        return 0
    return max(1, round(len(text) / 4))


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

    tracker = TokenTracker()
    try:
        config = {"configurable": {"thread_id": run_id}, "callbacks": [tracker]}
        result = await workflow_app.ainvoke(initial_state, config=config)
        final_status = result.get("run_status", "completed")
        finished_at = datetime.now(tz=timezone.utc)

        usage = tracker.snapshot()
        if usage["total"] > 0:
            prompt_tokens = usage["prompt"]
            completion_tokens = usage["completion"]
            total_tokens = usage["total"]
            token_accuracy = "actual"
        else:
            # LangChain didn't expose token metadata for this provider —
            # fall back to the chars/4 heuristic so the UI still has a number.
            prompt_tokens = _estimate_tokens(initial_state.get("task", ""))
            completion_tokens = _estimate_tokens(result.get("final_report", "") or "")
            total_tokens = prompt_tokens + completion_tokens
            token_accuracy = "estimated"

        # Rough cost estimate. We don't know the exact model used per node — the
        # writer's model is a reasonable proxy for the most expensive call, so
        # the OpenAI default falls back to that. Close enough for a UI badge.
        estimated_model = result.get("model_used") or None
        cost_usd = estimate_cost_usd(estimated_model, prompt_tokens, completion_tokens)

        result["run_metrics"] = {
            **(result.get("run_metrics") or {}),
            "started_at": started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "elapsed_ms": int((finished_at - started_at).total_seconds() * 1000),
            "estimated_prompt_tokens": prompt_tokens,
            "estimated_completion_tokens": completion_tokens,
            "estimated_total_tokens": total_tokens,
            "estimated_cost_usd": cost_usd,
            "token_accuracy": token_accuracy,
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


def create_run(
    task: str,
    mode: str,
    user_id: str,
    session_id: str,
    conservative_specialist_routing: bool = False,
    forced_task_type: str | None = None,
) -> str:
    run_id = str(uuid.uuid4())

    operator_context = ""
    try:
        operator_context = user_profile_service.render_context()
    except Exception:
        operator_context = ""

    # The operator profile lives in state["memory_context"] / state["thread_context"]
    # for any agent that wants to personalize. We deliberately do NOT concatenate it
    # into state["task"] because multiple downstream report templates (and stub
    # tools) paste the task verbatim into their output, which would leak the
    # operator's private context back through run outputs and TTS.
    run_store.create(run_id=run_id, task=task, mode=mode)
    # Stash the routing-relevant fields in state immediately so list/search
    # endpoints can filter even while the run is still queued or in flight.
    # These are normally populated by the workflow itself at completion; this
    # pre-population just fills the gap for the queued/running window.
    run_store.update_state(
        run_id,
        lambda current: {
            **current,
            "session_id": session_id,
            "user_id": user_id,
            "task_type": forced_task_type or "conversation",
        },
    )

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
        "thread_context": operator_context,
        "memory_context": operator_context,
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
        "forced_task_type": forced_task_type or "",
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

    # dispatch_run picks Celery if Redis is configured, in-process thread otherwise.
    # Native-app builds have no Redis → runs happen inside the API process.
    from app.services.run_dispatcher import dispatch_run

    dispatch_run(run_id, initial_state)
    return run_id
