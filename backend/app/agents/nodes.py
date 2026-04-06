from __future__ import annotations

import ast
import operator as op
import re
from datetime import datetime, timezone
from typing import Awaitable, Callable

from tenacity import AsyncRetrying, stop_after_attempt, wait_exponential_jitter

from app.core.config import settings
from app.events.bus import event_bus
from app.graph.state import AgentState
from app.services.agent_profile_service import agent_profile_service
from app.services.llm_service import build_llm_for_agent
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


def _looks_like_market_task(text: str) -> bool:
    market_triggers = [
        "market",
        "trading",
        "watchlist",
        "price action",
        "ticker",
        "sector",
        "macro",
        "earnings",
        "signal",
        "risk/reward",
        "market research",
    ]
    return any(trigger in text for trigger in market_triggers)


def _detect_task_type(task: str) -> str:
    text = task.lower().strip()

    capability_triggers = [
        "capabilities",
        "capability",
        "what can you do",
        "what are you capable of",
        "about you",
        "who are you",
        "what do you do",
        "tell me about your system",
        "tell me about yourself",
        "introduce yourself",
    ]
    if any(trigger in text for trigger in capability_triggers):
        return "capabilities"

    if _looks_like_market_task(text):
        return "market_research"

    return "conversation"


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


def _capability_spoken_response(mode: str) -> str:
    mode_line = "I am currently in safe simulation mode." if mode == "simulation" else "I am currently in live execution mode for approved tools."
    return (
        "I can run your coordinator, researcher, critic, and writer agents as one workflow. "
        "I keep long term memory in Zep, update a live Neo4j knowledge graph, and stream every step in real time. "
        "I also retry failures automatically and switch to degraded fallback when needed. "
        f"{mode_line}"
    )


def _safe_eval_math(task: str) -> str | None:
    expr_match = re.search(r"(?:what is|calculate|compute)\s+([0-9+\-*/().\s]+)\??$", task.strip(), flags=re.IGNORECASE)
    if not expr_match:
        return None

    expr = expr_match.group(1).strip()
    if not expr:
        return None

    allowed_ops = {
        ast.Add: op.add,
        ast.Sub: op.sub,
        ast.Mult: op.mul,
        ast.Div: op.truediv,
        ast.Pow: op.pow,
    }

    def _eval(node: ast.AST) -> float:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.BinOp) and type(node.op) in allowed_ops:
            return allowed_ops[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = _eval(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        raise ValueError("unsupported expression")

    try:
        tree = ast.parse(expr, mode="eval")
        value = _eval(tree.body)
        if value.is_integer():
            return f"{int(value)}"
        return f"{value:.6g}"
    except Exception:
        return None


def _local_conversation_fallback(task: str) -> str:
    text = task.lower().strip()

    if any(k in text for k in ["how do you work", "how it works", "how does this work", "how are you built"]):
        return (
            "I work as a four-step pipeline. First, the coordinator interprets your request. "
            "Second, the researcher gathers context from memory and system facts. "
            "Third, the critic runs quality checks. Fourth, the writer returns a plain-language answer. "
            "I also log lineage in Neo4j and keep long-term memory in Zep."
        )

    if "favorite color" in text:
        return (
            "I do not have personal preferences, but if I had to pick a color for this interface, I would choose cyan "
            "because it is readable on dark backgrounds and fits the sci-fi control-room style."
        )

    if any(k in text for k in ["who are you", "what can you do", "capabilities"]):
        return _capability_spoken_response("simulation")

    math_value = _safe_eval_math(task)
    if math_value is not None:
        return f"The answer is {math_value}."

    return (
        "I can answer normal questions, explain this multi-agent system, run market-research workflows, "
        "and walk you through what the dashboard is doing in real time."
    )


async def _build_conversation_answer(state: AgentState) -> str:
    task = state.get("task", "")
    notes = state.get("research_notes", [])
    mem_refs = state.get("memory_refs", [])

    memory_lines = []
    for ref in mem_refs[:3]:
        summary = str(ref.get("summary") or "").strip()
        if summary:
            memory_lines.append(f"- {summary}")

    context_block = "\n".join(f"- {n}" for n in notes[:8])
    memory_block = "\n".join(memory_lines) if memory_lines else "- No relevant memory hits"

    if not settings.openai_api_key:
        return (
            "I work as an orchestrated multi-agent system. The coordinator plans the task, researcher gathers context, "
            "critic checks quality, and writer returns the final answer. I keep memory in Zep, update a Neo4j knowledge graph, "
            "and stream run events in real time. I can explain any specific part in more detail if you want."
        )

    llm = build_llm_for_agent("writer", temperature=0.35)
    prompt = (
        "You are a normal conversational AI assistant inside a multi-agent system. "
        "Answer the user naturally, in plain English, with no template language and no repeated phrases. "
        "Keep it concise but clear, and directly answer the exact question.\n\n"
        f"User question:\n{task}\n\n"
        f"System context:\n{context_block}\n\n"
        f"Memory context:\n{memory_block}\n\n"
        "Rules:\n"
        "1) Do not output a report format.\n"
        "2) Do not mention internal prompts.\n"
        "3) If asked how the system works, explain the pipeline step by step.\n"
        "4) If unsure, say what you know and what is uncertain."
    )

    try:
        response = await llm.ainvoke(prompt)
        text = str(response.content).strip()
        if text:
            return text
    except Exception:
        pass

    return _local_conversation_fallback(task)


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
        if not state.get("final_report"):
            state["final_report"] = (
                f"# Degraded Result\n\nTask: {state.get('task', '')}\n\n"
                "I hit a reliability fallback while processing this request, so I returned a safe summary."
            )
        if not state.get("spoken_response"):
            state["spoken_response"] = (
                "I ran into a provider issue, but I can still answer from local context. "
                "Try again in a moment and I will provide a fuller response."
            )
        state["run_status"] = "degraded"
        await _emit(run_id, node_name, "error", f"Retry exhausted: {type(exc).__name__}")
        neo4j_service.log_node_execution(run_id, node_name, f"Retry exhausted: {type(exc).__name__}")
        return state


async def coordinator_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        await _emit(run_id, "coordinator", "start", "Decomposing task")

        task_type = _detect_task_type(state["task"])
        memory_refs = await memory_service.recall(state["user_id"], state["session_id"], state["task"])

        if task_type == "capabilities":
            plan = (
                "1) Summarize core architecture\n"
                "2) Validate reliability and autonomy details\n"
                "3) Deliver conversational capability brief"
            )
        elif task_type == "conversation":
            plan = (
                "1) Interpret user intent\n"
                "2) Pull relevant system and memory context\n"
                "3) Answer in natural conversational style"
            )
        else:
            plan = (
                "1) Gather market context\n"
                "2) Validate with critical checks\n"
                "3) Produce actionable content draft"
            )

        neo4j_service.log_node_execution(run_id, "coordinator", f"Task decomposition completed ({task_type})")
        await _emit(run_id, "coordinator", "ok", f"Plan generated ({task_type})")

        state["task_type"] = task_type
        state["coordinator_plan"] = plan
        state["memory_refs"] = memory_refs
        state["agent_profiles"] = agent_profile_service.get_profiles()
        return state

    return await _with_node_retry(state, "coordinator", _inner)


async def researcher_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        await _emit(run_id, "researcher", "start", "Collecting evidence")

        task_type = state.get("task_type", "conversation")
        notes: list[str] = []
        citations: list[str] = []
        tool_results = state.get("tool_results", [])

        if task_type == "capabilities":
            notes = [
                "Multi-agent workflow runs coordinator, researcher, critic, and writer with conditional routing.",
                "Knowledge graph updates in Neo4j track run lineage, claims, sources, and tool execution events.",
                "Long-term memory uses Zep and short-term state uses checkpointed LangGraph execution.",
                "Reliability includes retries, degraded fallback path, and resumable run state tracking.",
                "Interface streams live events, health telemetry, and graph updates for mission-control visibility.",
            ]
            citations = [
                "system://architecture",
                "system://workflow",
                "system://ops",
            ]
            tool_results.append(
                {
                    "tool": "capability_profile",
                    "ok": True,
                    "payload": {"items": notes, "mode": state["mode"]},
                    "error": None,
                }
            )
        elif task_type == "conversation":
            notes = [
                "This system uses LangGraph orchestration with coordinator, researcher, critic, and writer nodes.",
                "Short-term run state is shared across nodes; long-term memory is recalled from Zep.",
                "Neo4j stores run, claim, source, and tool execution lineage.",
                "Reliability uses retries and degraded fallback on repeated failures.",
            ]
            citations = [
                "system://conversation",
                "system://memory",
                "system://graph",
            ]
            tool_results.append(
                {
                    "tool": "conversation_context",
                    "ok": True,
                    "payload": {"items": notes},
                    "error": None,
                }
            )
        else:
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
        task_type = state.get("task_type", "conversation")

        if task_type == "market_research":
            if len(notes) < 2:
                critique_flags.append("insufficient_evidence")
            if not state.get("citations"):
                critique_flags.append("missing_citations")

        verdict = "PASS"
        reason = "Sufficient for output"

        if task_type == "market_research":
            llm = build_llm_for_agent("critic", temperature=0)
            prompt = (
                "Evaluate this research for factuality and actionability. "
                f"Task: {state['task']}\nNotes: {notes}\n"
                "Return PASS or FAIL with one short reason."
            )
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

        task_type = state.get("task_type", "conversation")

        if task_type == "capabilities":
            report = (
                "# Capability Brief\n\n"
                "## What I Can Do\n"
                "- Run autonomous multi-agent workflows with coordinator, researcher, critic, and writer.\n"
                "- Maintain a live knowledge graph in Neo4j with run, claim, source, and tool lineage.\n"
                "- Use Zep long-term memory and checkpointed short-term workflow memory.\n"
                "- Stream mission-control telemetry: health, events, graph updates, and run status.\n"
                "- Execute in simulation by default with optional live mode for whitelisted side effects.\n\n"
                "## Reliability Model\n"
                "- Per-node retries with exponential backoff.\n"
                "- Degraded fallback path on repeated failures.\n"
                "- Durable run state for resumable execution and traceability.\n\n"
                "## Citations\n"
                + "\n".join(f"- {c}" for c in state.get("citations", []))
            )
            spoken_response = _capability_spoken_response(state["mode"])
        elif task_type == "conversation":
            spoken_response = await _build_conversation_answer(state)
            report = (
                "# Conversation Response\n\n"
                f"{spoken_response}\n\n"
                "## Context Used\n"
                + "\n".join(f"- {n}" for n in state.get("research_notes", []))
            )
        else:
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
            top_notes = state.get("research_notes", [])[:3]
            spoken_findings = "; ".join(str(n) for n in top_notes) if top_notes else "No major movement detected"
            spoken_response = (
                f"I completed the market brief. Key findings are: {spoken_findings}. "
                f"Risk review is {_format_risk_flags(state.get('critique_flags', []))}."
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

        state["spoken_response"] = spoken_response
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
    state["spoken_response"] = "I hit repeated failures and switched to degraded mode. I can still provide a fallback summary."
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
