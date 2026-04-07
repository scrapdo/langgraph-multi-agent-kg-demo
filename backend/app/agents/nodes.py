from __future__ import annotations

import ast
import asyncio
import operator as op
import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from tenacity import AsyncRetrying, stop_after_attempt, wait_exponential_jitter

from app.core.config import settings
from app.events.bus import event_bus
from app.graph.state import AgentState
from app.services.agent_profile_service import agent_profile_service
from app.services.llm_service import build_llm_for_agent
from app.services.memory_service import memory_service
from app.services.neo4j_service import neo4j_service
from app.tools.adapters import (
    CONTENT_PUBLISH_TOOL,
    HUGGINGFACE_DISCOVERY_TOOL,
    INSTAGRAM_STRATEGY_TOOL,
    LINKEDIN_STRATEGY_TOOL,
    MARKET_NEWS_TOOL,
    SCHEDULE_PLANNER_TOOL,
    SHOPPING_SCOUT_TOOL,
    SHOPPING_SEARCH_TOOL,
    SOCIAL_PLANNING_TOOL,
    X_STRATEGY_TOOL,
    TOOLS,
)

SYSTEM_ENTITIES = {
    "LangGraph": "framework",
    "Neo4j": "database",
    "Zep": "memory",
    "FastAPI": "framework",
    "React": "framework",
    "OpenAI": "provider",
    "Anthropic": "provider",
    "Gemini": "provider",
    "Perplexity": "provider",
    "Groq": "provider",
    "Grok": "provider",
    "Redis": "infrastructure",
    "Postgres": "database",
    "HeyGen": "provider",
    "ElevenLabs": "provider",
    "Hugging Face": "provider",
    "Transformers": "framework",
    "Optimum": "framework",
    "Parler-TTS": "provider",
    "Railway": "platform",
    "Private Shopper": "agent",
    "Social Manager": "agent",
    "LinkedIn": "platform",
    "Instagram": "platform",
    "DuckDuckGo": "provider",
    "Chrono24": "marketplace",
}


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


async def _publish_graph_delta(state: AgentState, detail: str, created_nodes: int, created_relationships: int) -> None:
    state.setdefault("graph_deltas", [])
    delta = {
        "created_nodes": created_nodes,
        "created_relationships": created_relationships,
        "detail": detail,
        "ts": datetime.now(tz=timezone.utc).isoformat(),
    }
    state["graph_deltas"].append(delta)
    await event_bus.publish(
        state["run_id"],
        {
            "ts": delta["ts"],
            "node": "graph",
            "status": "delta",
            "detail": detail,
            "created_nodes": created_nodes,
            "created_relationships": created_relationships,
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

    shopping_triggers = [
        "shop for",
        "find me",
        "find a",
        "find an",
        "hard to find",
        "where can i buy",
        "best deal",
        "deal on",
        "in stock",
        "source this item",
        "private shopper",
    ]
    if any(trigger in text for trigger in shopping_triggers):
        return "shopping"

    social_triggers = [
        "social media",
        "content calendar",
        "social manager",
        "tweet",
        "x post",
        "linkedin post",
        "instagram",
        "caption",
        "engagement plan",
        "posting schedule",
        "content plan",
    ]
    if any(trigger in text for trigger in social_triggers):
        return "social_media"

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


def _agent_voice_settings(state: AgentState, agent_id: str) -> dict[str, str]:
    profiles = state.get("agent_profiles") or {}
    profile = profiles.get(agent_id, {})
    fallback = agent_profile_service.get_profile(agent_id)
    return {**fallback, **profile}


def _speech_preview_chunks(text: str, limit: int = 2) -> list[str]:
    sentences = [segment.strip() for segment in re.split(r"(?<=[.!?])\s+", text.strip()) if segment.strip()]
    return sentences[:limit]


async def _emit_speech_preview(state: AgentState, agent_id: str, text: str) -> None:
    run_id = state["run_id"]
    profile = _agent_voice_settings(state, agent_id)
    for chunk in _speech_preview_chunks(text):
        await event_bus.publish(
            run_id,
            {
                "ts": datetime.now(tz=timezone.utc).isoformat(),
                "node": agent_id,
                "status": "speech_partial",
                "detail": chunk,
                "agent_id": agent_id,
                "voice": profile.get("speech_voice", ""),
                "speech_style": profile.get("speech_style", "natural"),
                "speech_persona": profile.get("speech_persona", ""),
                "premium_voice_id": profile.get("premium_voice_id", ""),
            },
        )


def _tool_record(result: Any) -> dict[str, Any]:
    payload = result.payload if isinstance(result.payload, dict) else {}
    return {"tool": result.tool, "ok": result.ok, "payload": payload, "error": result.error}


async def _run_specialist_tools(state: AgentState, specialist_id: str, tools: list[Any], detail: str) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    run_id = state["run_id"]
    await _emit(run_id, specialist_id, "start", detail)
    results = await asyncio.gather(*(tool.run(state["task"], state["mode"]) for tool in tools))
    tool_records = [_tool_record(result) for result in results]
    notes: list[str] = []
    citations: list[str] = []
    for record in tool_records:
        payload = record.get("payload", {})
        notes.extend(payload.get("items", []))
        citations.append(f"tool://{record['tool']}")
    await _emit(run_id, specialist_id, "ok", f"Collected {len(notes)} specialist items")
    return tool_records, notes, citations


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

    if any(
        k in text
        for k in [
            "how do you work",
            "how you work",
            "how it works",
            "how does this work",
            "how does the system work",
            "how are you built",
            "explain how you work",
            "explain your architecture",
        ]
    ):
        return (
            "I work as a multi-agent pipeline. The coordinator interprets your request and sets the plan. "
            "The researcher gathers context from tools, memory, and system facts. "
            "The critic checks coverage, risk, and consistency. "
            "The writer turns that into a clean final answer. "
            "While that happens, the app logs run history in Neo4j and stores longer-term context in Zep."
        )

    if "favorite color" in text:
        return (
            "I do not have personal preferences, but if I had to pick a color for this interface, I would choose cyan "
            "because it is readable on dark backgrounds and fits the sci-fi control-room style."
        )

    if any(k in text for k in ["who are you", "what can you do", "capabilities"]):
        return _capability_spoken_response("simulation")

    if any(k in text for k in ["what happens when", "when i ask", "when i talk to you"]):
        return (
            "When you ask something, I first classify the request. "
            "Simple questions are answered conversationally. More structured tasks can go through the full agent workflow "
            "with research, critique, and synthesis before I respond."
        )

    math_value = _safe_eval_math(task)
    if math_value is not None:
        return f"The answer is {math_value}."

        return (
            "I can answer questions normally, explain how this multi-agent system works, run research workflows, "
            "and describe what the dashboard, graph, memory, and agent pipeline are doing in real time. "
            "I also have specialist agents for shopping requests and social media planning."
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
    writer_profile = _agent_voice_settings(state, "writer")
    speech_persona = writer_profile.get("speech_persona", "").strip()

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
        f"Spoken persona:\n{speech_persona or 'Speak like a polished, natural human operator.'}\n\n"
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


async def _polish_spoken_response(state: AgentState, base_text: str, agent_id: str = "writer") -> str:
    clean = " ".join(base_text.split())
    if not clean:
        return clean

    profile = _agent_voice_settings(state, agent_id)
    persona = profile.get("speech_persona", "").strip()
    style = profile.get("speech_style", "natural")

    if not settings.openai_api_key:
        return clean

    llm = build_llm_for_agent(agent_id, temperature=0.35)
    prompt = (
        "Rewrite this text for spoken delivery. Keep the meaning intact, keep it concise, and make it sound like a normal human. "
        "No markdown. No bullet points. No repeated ideas.\n\n"
        f"Persona: {persona or 'Polished human operator'}\n"
        f"Speech style: {style}\n\n"
        f"Text:\n{clean}"
    )
    try:
        response = await llm.ainvoke(prompt)
        polished = str(response.content).strip()
        return polished or clean
    except Exception:
        return clean


def _entity_type_for_name(name: str) -> str:
    return SYSTEM_ENTITIES.get(name, "concept")


def _extract_entities(texts: list[str]) -> list[dict[str, str]]:
    entities: dict[str, str] = {}
    for text in texts:
        if not text:
            continue
        for name, entity_type in SYSTEM_ENTITIES.items():
            pattern = r"\b" + re.escape(name.lower()) + r"\b"
            if re.search(pattern, text.lower()):
                entities[name] = entity_type

        for match in re.findall(r"\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b", text):
            clean = match.strip()
            if len(clean) < 3:
                continue
            entities.setdefault(clean, "concept")

        for keyword in ["semiconductors", "market", "research", "memory", "knowledge graph", "mission control"]:
            if keyword in text.lower():
                entities.setdefault(keyword.title(), "topic")

    return [{"name": name, "entity_type": entity_type} for name, entity_type in sorted(entities.items())]


async def _remember_episode(
    state: AgentState,
    agent_id: str,
    episode_type: str,
    content: str,
    *,
    role: str = "assistant",
    metadata: dict[str, Any] | None = None,
) -> str:
    if not content.strip():
        return ""

    run_id = state["run_id"]
    thread_id = state.get("thread_id") or state["session_id"]
    previous_episode_id = state.get("last_episode_id") or None
    episode_id = neo4j_service.create_episode(
        run_id,
        thread_id,
        agent_id,
        episode_type,
        content,
        metadata=metadata,
        previous_episode_id=previous_episode_id,
    )

    state.setdefault("episode_ids", []).append(episode_id)
    state["last_episode_id"] = episode_id
    state.setdefault("episodes", []).append(
        {
            "episode_id": episode_id,
            "thread_id": thread_id,
            "run_id": run_id,
            "agent_id": agent_id,
            "episode_type": episode_type,
            "content": content,
            "created_at": datetime.now(tz=timezone.utc).isoformat(),
            "metadata": metadata or {},
        }
    )

    await memory_service.add_message(
        state["user_id"],
        thread_id,
        role,
        content,
        metadata={"run_id": run_id, "agent_id": agent_id, "episode_id": episode_id, **(metadata or {})},
        return_context=False,
    )
    memory_ref = await memory_service.add_episode(
        state["user_id"],
        thread_id,
        content,
        source_description=agent_id,
        episode_type=episode_type,
    )
    if memory_ref:
        state.setdefault("memory_refs", [])
        existing = {str(ref.get("memory_id")) for ref in state["memory_refs"]}
        memory_id = str(memory_ref.get("memory_id") or "")
        if memory_id and memory_id not in existing:
            state["memory_refs"].append(memory_ref)

    entities = _extract_entities([content])
    if entities:
        state.setdefault("entity_mentions", [])
        seen = {(item.get("name"), item.get("entity_type")) for item in state["entity_mentions"]}
        for entity in entities:
            neo4j_service.link_episode_to_entity(episode_id, entity["name"], entity["entity_type"])
            key = (entity["name"], entity["entity_type"])
            if key not in seen:
                seen.add(key)
                state["entity_mentions"].append(
                    {"entity_id": entity["name"].strip().lower(), "name": entity["name"], "entity_type": entity["entity_type"]}
                )

    await _publish_graph_delta(state, f"Episode stored: {agent_id}/{episode_type}", 1 + len(entities), 3 + len(entities))
    return episode_id


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
        neo4j_service.record_failure(
            run_id,
            state.get("thread_id") or state["session_id"],
            node_name,
            f"Retry exhausted: {type(exc).__name__}: {exc}",
            episode_id=state.get("last_episode_id") or None,
        )
        return state


async def coordinator_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        thread_id = state.get("thread_id") or state["session_id"]
        state["thread_id"] = thread_id
        await _emit(run_id, "coordinator", "start", "Decomposing task")

        neo4j_service.upsert_thread(thread_id, state["user_id"], session_id=state["session_id"])

        if not state.get("thread_initialized"):
            await memory_service.ensure_user_and_thread(state["user_id"], thread_id)
            await _remember_episode(
                state,
                "user",
                "user_request",
                state["task"],
                role="user",
                metadata={"task": state["task"], "mode": state["mode"]},
            )
            state["thread_initialized"] = True

        task_type = _detect_task_type(state["task"])
        memory_refs = await memory_service.recall(state["user_id"], thread_id, state["task"])
        thread_context = await memory_service.get_thread_context(thread_id)

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
        elif task_type == "shopping":
            plan = (
                "1) Identify the target item and constraints\n"
                "2) Scan sourcing and deal options\n"
                "3) Return trustworthy buying recommendations"
            )
        elif task_type == "social_media":
            plan = (
                "1) Define the campaign angle and target channels\n"
                "2) Build hooks, cadence, and scheduling notes\n"
                "3) Deliver a practical social media plan"
            )
        else:
            plan = (
                "1) Gather market context\n"
                "2) Validate with critical checks\n"
                "3) Produce actionable content draft"
            )

        await _remember_episode(
            state,
            "coordinator",
            "coordinator_plan",
            f"Task type: {task_type}\nPlan:\n{plan}",
            metadata={"task_type": task_type},
        )
        await _emit(run_id, "coordinator", "ok", f"Plan generated ({task_type})")

        state["task_type"] = task_type
        state["coordinator_plan"] = plan
        state["memory_refs"] = memory_refs
        state["thread_context"] = thread_context
        state["memory_context"] = thread_context
        state["agent_profiles"] = agent_profile_service.get_profiles()
        return state

    return await _with_node_retry(state, "coordinator", _inner)


async def researcher_node(state: AgentState) -> AgentState:
    async def _inner() -> AgentState:
        run_id = state["run_id"]
        thread_id = state.get("thread_id") or state["session_id"]
        await _emit(run_id, "researcher", "start", "Collecting evidence")

        task_type = state.get("task_type", "conversation")
        notes: list[str] = []
        citations: list[str] = []
        tool_results = state.get("tool_results", [])

        if task_type == "capabilities":
            notes = [
                "Multi-agent workflow runs coordinator, researcher, critic, and writer with conditional routing.",
                "Knowledge graph updates in Neo4j track runs, threads, episodes, claims, sources, and tool execution events.",
                "Long-term memory uses Zep threads, graph episodes, and recalled context rather than only plain session search.",
                "Reliability includes retries, degraded fallback path, and resumable run state tracking.",
                "Interface streams live events, health telemetry, graph deltas, and memory lineage for mission-control visibility.",
            ]
            citations = ["system://architecture", "system://workflow", "system://ops"]
            tool_results.append({"tool": "capability_profile", "ok": True, "payload": {"items": notes, "mode": state["mode"]}, "error": None})
        elif task_type == "conversation":
            notes = [
                "This system uses LangGraph orchestration with coordinator, researcher, critic, and writer nodes.",
                "Short-term run state is shared across nodes; long-term memory is recalled from Zep thread context and graph search.",
                "Neo4j stores run, thread, episode, claim, source, and tool execution lineage.",
                "Reliability uses retries and degraded fallback on repeated failures.",
            ]
            citations = ["system://conversation", "system://memory", "system://graph"]
            tool_results.append({"tool": "conversation_context", "ok": True, "payload": {"items": notes}, "error": None})
        elif task_type == "shopping":
            general_task = _run_specialist_tools(
                state,
                "researcher",
                [HUGGINGFACE_DISCOVERY_TOOL],
                "Gathering general product context",
            )
            shopper_task = _run_specialist_tools(
                state,
                "shopper",
                [SHOPPING_SCOUT_TOOL, SHOPPING_SEARCH_TOOL],
                "Scanning live shopping sources and deal options",
            )
            general_records, general_notes, general_citations = await general_task
            shopper_records, shopper_notes, shopper_citations = await shopper_task
            tool_results.extend(general_records + shopper_records)
            notes = shopper_notes + general_notes + [
                "Recommended output should rank options by trust, availability, and price quality.",
                "Flag resale risk, fulfillment uncertainty, and return-policy issues explicitly.",
            ]
            citations = shopper_citations + general_citations
        elif task_type == "social_media":
            researcher_task = _run_specialist_tools(
                state,
                "researcher",
                [SOCIAL_PLANNING_TOOL],
                "Building core campaign direction",
            )
            social_task = _run_specialist_tools(
                state,
                "social",
                [X_STRATEGY_TOOL, LINKEDIN_STRATEGY_TOOL, INSTAGRAM_STRATEGY_TOOL, SCHEDULE_PLANNER_TOOL],
                "Building platform-specific social playbook",
            )
            researcher_records, researcher_notes, researcher_citations = await researcher_task
            social_records, social_notes, social_citations = await social_task
            tool_results.extend(researcher_records + social_records)
            notes = researcher_notes + social_notes + [
                "Response should include hooks, cadence, and channel-specific guidance.",
                "Publishing remains simulated unless the content tool is explicitly allowed live.",
            ]
            citations = researcher_citations + social_citations
            publish_result = await CONTENT_PUBLISH_TOOL.run(f"Drafting queue for: {state['task']}", state["mode"])
            tool_results.append(_tool_record(publish_result))
            citations.append(f"tool://{publish_result.tool}")
        else:
            market_tools = [MARKET_NEWS_TOOL, HUGGINGFACE_DISCOVERY_TOOL]
            for tool in market_tools:
                result = await tool.run(state["task"], state["mode"])
                payload = result.payload if isinstance(result.payload, dict) else {}
                tool_record = {"tool": tool.name, "ok": result.ok, "payload": payload, "error": result.error}
                tool_results.append(tool_record)
                notes.extend(payload.get("items", []))
                citations.append(f"tool://{tool.name}")
        summary = "\n".join(f"- {note}" for note in notes[:10]) or "No evidence collected"
        episode_id = await _remember_episode(
            state,
            "researcher",
            "research_summary",
            summary,
            metadata={"citations": citations[:8], "task_type": task_type},
        )

        tool_count = 3 if task_type == "shopping" else (6 if task_type == "social_media" else (2 if task_type == "market_research" else max(len(TOOLS), 1)))
        for tool_result in tool_results[-tool_count:]:
            neo4j_service.record_tool_execution(
                run_id,
                thread_id,
                "researcher",
                tool_result.get("tool", "unknown"),
                detail="Tool execution from researcher",
                ok=bool(tool_result.get("ok")),
                payload=tool_result.get("payload") if isinstance(tool_result.get("payload"), dict) else {},
                error=str(tool_result.get("error") or "") or None,
                episode_id=episode_id or None,
            )

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
        elif task_type == "shopping":
            if len(notes) < 3:
                critique_flags.append("thin_sourcing")
        elif task_type == "social_media":
            if len(notes) < 3:
                critique_flags.append("thin_campaign_plan")

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

        await _remember_episode(
            state,
            "critic",
            "critic_verdict",
            f"Verdict: {verdict}\nReason: {reason}\nFlags: {_format_risk_flags(critique_flags)}",
            metadata={"verdict": verdict, "flags": critique_flags},
        )
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
        thread_id = state.get("thread_id") or state["session_id"]
        await _emit(run_id, "writer", "start", "Drafting final report")

        task_type = state.get("task_type", "conversation")
        speaker_agent = "writer"

        if task_type == "capabilities":
            report = (
                "# Capability Brief\n\n"
                "## What I Can Do\n"
                "- Run autonomous multi-agent workflows with coordinator, researcher, critic, and writer.\n"
                "- Maintain a live knowledge graph in Neo4j with run, thread, episode, claim, source, and tool lineage.\n"
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
            spoken_response = await _polish_spoken_response(state, _capability_spoken_response(state["mode"]), speaker_agent)
        elif task_type == "conversation":
            spoken_response = await _polish_spoken_response(state, await _build_conversation_answer(state), speaker_agent)
            report = (
                "# Conversation Response\n\n"
                f"{spoken_response}\n\n"
                "## Context Used\n"
                + "\n".join(f"- {n}" for n in state.get("research_notes", []))
            )
        elif task_type == "shopping":
            speaker_agent = "shopper"
            top_notes = state.get("research_notes", [])[:4]
            report = (
                "# Private Shopper Brief\n\n"
                f"Request: {state['task']}\n\n"
                f"## Sourcing Plan\n{state.get('coordinator_plan', 'N/A')}\n\n"
                "## Best Options\n"
                + "\n".join(f"- {n}" for n in top_notes)
                + "\n\n## Live Sources\n"
                + "\n".join(
                    f"- {item.get('title')} ({item.get('domain')})"
                    for tool in state.get("tool_results", [])
                    if tool.get("tool") == "shopping_search"
                    for item in (tool.get("payload", {}).get("results", [])[:3] if isinstance(tool.get("payload"), dict) else [])
                )
                + "\n\n## Buying Guidance\n"
                "- Prioritize verified sellers and clear return policies.\n"
                "- Treat low-trust resale listings as higher risk.\n"
                f"\n## Risk Review\n{_format_risk_flags(state.get('critique_flags', []))}\n\n"
                "## Citations\n"
                + "\n".join(f"- {c}" for c in state.get("citations", []))
            )
            spoken_response = await _polish_spoken_response(
                state,
                (
                    "I completed the shopping scan. "
                    f"The strongest options are {('; '.join(top_notes[:3]) if top_notes else 'still being narrowed down')}. "
                    "I would prioritize trusted sellers and clear return windows before chasing the cheapest listing."
                ),
                speaker_agent,
            )
        elif task_type == "social_media":
            speaker_agent = "social"
            top_notes = state.get("research_notes", [])[:4]
            report = (
                "# Social Media Plan\n\n"
                f"Request: {state['task']}\n\n"
                f"## Campaign Plan\n{state.get('coordinator_plan', 'N/A')}\n\n"
                "## Recommended Angles\n"
                + "\n".join(f"- {n}" for n in top_notes)
                + "\n\n## Platform Breakdown\n"
                + "\n".join(
                    f"- {n}" for n in state.get("research_notes", [])[4:8]
                )
                + "\n\n## Publishing Notes\n"
                "- Build one core narrative, then adapt it per channel.\n"
                "- Keep execution simulated unless live posting is explicitly allowed.\n"
                f"\n## Risk Review\n{_format_risk_flags(state.get('critique_flags', []))}\n\n"
                "## Citations\n"
                + "\n".join(f"- {c}" for c in state.get("citations", []))
            )
            spoken_response = await _polish_spoken_response(
                state,
                (
                    "I built the social media plan. "
                    f"The main angles are {('; '.join(top_notes[:3]) if top_notes else 'still being refined')}. "
                    "I would keep the message consistent, then tailor hooks and cadence by platform."
                ),
                speaker_agent,
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
            spoken_response = await _polish_spoken_response(
                state,
                (
                    f"I completed the market brief. Key findings are: {spoken_findings}. "
                    f"Risk review is {_format_risk_flags(state.get('critique_flags', []))}."
                ),
                speaker_agent,
            )

        await _emit_speech_preview(state, speaker_agent, spoken_response)
        writer_episode_id = await _remember_episode(
            state,
            "writer",
            "final_output",
            report,
            metadata={"task_type": task_type, "citations": state.get("citations", [])[:8], "speaker_agent": speaker_agent},
        )

        claim_records = []
        for note in state.get("research_notes", [])[:5]:
            entities = [item["name"] for item in _extract_entities([note])]
            claim_id = neo4j_service.create_claim(
                run_id,
                thread_id,
                note,
                source=(state.get("citations", ["system://generated"])[0] if state.get("citations") else "system://generated"),
                episode_id=writer_episode_id or None,
                entity_names=entities,
            )
            claim_records.append(
                {
                    "claim_id": claim_id,
                    "text": note,
                    "source": state.get("citations", ["system://generated"])[0] if state.get("citations") else "system://generated",
                    "confidence": 0.72,
                    "status": "active",
                    "entity_names": entities,
                    "created_at": datetime.now(tz=timezone.utc).isoformat(),
                }
            )
        state["claims"] = claim_records

        publish_result = await CONTENT_PUBLISH_TOOL.run(report, state["mode"])
        state.setdefault("tool_results", []).append(
            {
                "tool": publish_result.tool,
                "ok": publish_result.ok,
                "payload": publish_result.payload,
                "error": publish_result.error,
            }
        )
        neo4j_service.record_tool_execution(
            run_id,
            thread_id,
            "writer",
            publish_result.tool,
            detail="Content publish step",
            ok=publish_result.ok,
            payload=publish_result.payload if isinstance(publish_result.payload, dict) else {},
            error=publish_result.error,
            episode_id=writer_episode_id or None,
        )

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
    await _remember_episode(
        state,
        "degraded_handler",
        "degraded_fallback",
        fallback,
        metadata={"errors": state.get("errors", [])[:8]},
    )
    neo4j_service.record_failure(
        run_id,
        state.get("thread_id") or state["session_id"],
        "degraded_handler",
        "Fallback path used",
        episode_id=state.get("last_episode_id") or None,
    )
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
