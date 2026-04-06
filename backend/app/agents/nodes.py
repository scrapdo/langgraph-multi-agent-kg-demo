from __future__ import annotations

from datetime import datetime, timezone
from typing import Awaitable, Callable

from tenacity import AsyncRetrying, stop_after_attempt, wait_exponential_jitter

from app.core.config import settings
from app.events.bus import event_bus
from app.graph.state import AgentState
from app.services.llm_service import build_llm
from app.services.memory_service import memory_service
from app.services.neo4j_service import neo4j_service
from app.tools.adapters import CONTENT_PUBLISH_TOOL, TOOLS


async def _emit(run_id: str, node: str, status: str, detail: str) -> None:
    await event_bus.publish(
        run_id,
        {
            "ts": datetime.now(tz=timezone.utc).isoformat(),
            "node": node,
            "status": status,
            "detail": detail,
        },
    )


def _format_risk_flags(flags: list[str]) -> str:
    if not flags:
        return "No major flags"
    pretty: list[str] = []
    for flag in flags:
        if flag.startswith("llm_critic_error"):
            pretty.append("critic_llm_unavailable")
        else:
            pretty.append(flag)
    return ", ".join(pretty)


async def _with_node_retry(state: AgentState, node_name: str, fn: Callable[[], Awaitable[AgentState]]) -> AgentState:
    run_id = state["run_id"]
    try:
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential_jitter(initial=1, max=8),
            reraise=True,
        ):
            with attempt:
                return await fn()
    except Exception as exc:
        state.setdefault("errors", [])
        state["errors"].append(f"{node_name}:{type(exc).__name__}:{exc}")
        state["force_degraded"] = True
        await _emit(run_id, node_name, "error", f"Retry exhausted: {type(exc).__name__}")
        neo4j_service.log_node_execution(run_id, node_name, f"Retry exhausted: {type(exc).__name__}")
        return state


async def coordinator_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        await _emit(run_id, "coordinator", "start", "Decomposing task")

        memory_refs = await memory_service.recall(state["user_id"], state["session_id"], state["task"])
        plan = (
            "1) Gather market context\n"
            "2) Validate with critical checks\n"
            "3) Produce actionable content draft"
        )
        neo4j_service.log_node_execution(run_id, "coordinator", "Task decomposition completed")
        await _emit(run_id, "coordinator", "ok", "Plan generated")

        state["coordinator_plan"] = plan
        state["memory_refs"] = memory_refs
        return state

    return await _with_node_retry(state, "coordinator", _inner)


async def researcher_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        await _emit(run_id, "researcher", "start", "Collecting evidence")

        notes: list[str] = []
        citations: list[str] = []
        tool_results = state.get("tool_results", [])
        for tool in TOOLS:
            result = await tool.run(state["task"], state["mode"])
            tool_results.append({"tool": tool.name, "ok": result.ok, "payload": result.payload, "error": result.error})
            notes.extend(result.payload.get("items", []))
            citations.append(f"tool://{tool.name}")

        neo4j_service.log_node_execution(run_id, "researcher", f"Collected {len(notes)} notes")
        await _emit(run_id, "researcher", "ok", f"Collected {len(notes)} evidence items")

        state["research_notes"] = notes
        state["citations"] = citations
        state["tool_results"] = tool_results
        return state

    return await _with_node_retry(state, "researcher", _inner)


async def critic_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        await _emit(run_id, "critic", "start", "Running quality gates")

        notes = state.get("research_notes", [])
        critique_flags: list[str] = []
        if len(notes) < 2:
            critique_flags.append("insufficient_evidence")
        if not state.get("citations"):
            critique_flags.append("missing_citations")

        llm = build_llm(temperature=0)
        prompt = (
            "Evaluate this research for factuality and actionability. "
            f"Task: {state['task']}\nNotes: {notes}\n"
            "Return PASS or FAIL with one short reason."
        )
        verdict = "PASS"
        reason = "Sufficient for demo output"
        try:
            if settings.openai_api_key:
                response = await llm.ainvoke(prompt)
                text = str(response.content)
                if "FAIL" in text.upper():
                    verdict = "FAIL"
                reason = text[:200]
        except Exception:
            critique_flags.append("llm_critic_error")

        if verdict == "FAIL":
            critique_flags.append("critic_failed")

        neo4j_service.log_node_execution(run_id, "critic", f"Verdict={verdict}")
        await _emit(run_id, "critic", "ok", f"Critic verdict: {verdict}")

        state["critique_flags"] = critique_flags
        state.setdefault("errors", [])
        if verdict == "FAIL":
            state["errors"].append(f"critic:{reason}")
        return state

    return await _with_node_retry(state, "critic", _inner)


async def writer_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        await _emit(run_id, "writer", "start", "Drafting final report")

        report = (
            f"# Market Research Brief\n\n"
            f"Task: {state['task']}\n\n"
            f"## Plan\n{state.get('coordinator_plan', 'N/A')}\n\n"
            f"## Findings\n"
            + "\n".join(f"- {n}" for n in state.get("research_notes", []))
            + "\n\n"
            + f"## Risk Review\n{_format_risk_flags(state.get('critique_flags', []))}\n\n"
            + f"## Citations\n"
            + "\n".join(f"- {c}" for c in state.get("citations", []))
        )

        for note in state.get("research_notes", [])[:3]:
            neo4j_service.create_claim_and_source(run_id, claim=note, source="tool://market_news")

        publish_result = await CONTENT_PUBLISH_TOOL.run(report, state["mode"])
        state.setdefault("tool_results", []).append(
            {
                "tool": publish_result.tool,
                "ok": publish_result.ok,
                "payload": publish_result.payload,
                "error": publish_result.error,
            }
        )

        await memory_service.store(state["user_id"], state["session_id"], report[:2000])
        neo4j_service.log_node_execution(run_id, "writer", "Final report produced")
        await _emit(run_id, "writer", "ok", "Final report completed")

        state["final_report"] = report
        state["run_status"] = "completed"
        return state

    return await _with_node_retry(state, "writer", _inner)


async def degraded_handler_node(state: AgentState) -> AgentState:
    run_id = state["run_id"]
    await _emit(run_id, "degraded_handler", "error", "Workflow degraded; using fallback summary")
    fallback = (
        "# Degraded Result\n\n"
        f"Task: {state['task']}\n\n"
        "The workflow encountered repeated failures. This fallback output was generated from cached context."
    )
    neo4j_service.log_node_execution(run_id, "degraded_handler", "Fallback path used")
    state["final_report"] = fallback
    state["run_status"] = "degraded"
    return state


def should_research_continue(state: AgentState) -> str:
    if state.get("force_degraded"):
        return "degraded"
    return "critic" if len(state.get("research_notes", [])) >= 2 else "degraded"


def should_critic_route(state: AgentState) -> str:
    if state.get("force_degraded"):
        return "degraded"
    revisions = state.get("revision_count", 0)
    flags = state.get("critique_flags", [])
    if "critic_failed" in flags and revisions < state.get("max_revisions", settings.max_revision_loops):
        state["revision_count"] = revisions + 1
        return "researcher"
    if "critic_failed" in flags:
        return "degraded"
    return "writer"
