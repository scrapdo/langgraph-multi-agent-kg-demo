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
from app.services.playwright_service import playwright_service
from app.tools.adapters import (
    CONTENT_PUBLISH_TOOL,
    GENERAL_NEWS_TOOL,
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
    "ElevenLabs": "provider",
    "Hugging Face": "provider",
    "Transformers": "framework",
    "Optimum": "framework",
    "Parler-TTS": "provider",
    "Railway": "platform",
    "Private Shopper": "agent",
    "Social Manager": "agent",
    "Nora": "agent",
    "Ava": "agent",
    "Wellness Coach": "agent",
    "LinkedIn": "platform",
    "Instagram": "platform",
    "DuckDuckGo": "provider",
    "Chrono24": "marketplace",
}

PROMPT_VERSION = "2026-04-08.1"
POLICY_VERSION = "2026-04-08.1"


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

    news_triggers = [
        "major news",
        "news events",
        "news today",
        "headlines today",
        "current events",
        "latest news",
        "what happened today",
        "breaking news",
    ]
    if any(trigger in text for trigger in news_triggers) or _looks_like_topic_news_request(text):
        return "news_brief"

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

    wellness_triggers = [
        "wellness",
        "wellness coach",
        "habit",
        "habits",
        "motivation",
        "motivated",
        "workout",
        "fitness",
        "sleep goal",
        "stress",
        "accountability",
        "healthy routine",
        "meal plan",
    ]
    if any(trigger in text for trigger in wellness_triggers):
        return "wellness_coaching"

    secretary_triggers = [
        "book appointment",
        "schedule appointment",
        "send email",
        "send a text",
        "send text",
        "make a call",
        "place a call",
        "secretary",
        "assistant call",
        "follow up with",
    ]
    if any(trigger in text for trigger in secretary_triggers):
        return "secretary"

    if _looks_like_market_task(text):
        return "market_research"

    return "conversation"


def _looks_like_topic_news_request(text: str) -> bool:
    lowered = text.lower().strip()
    topic_patterns = [
        r"\bwhat(?:'s| is)?\s+the\s+latest\s+(?:news\s+)?(?:on|about)\b",
        r"\b(?:latest|recent|current)\s+news\s+(?:on|about)\b",
        r"\bnews\s+(?:on|about)\b",
        r"\bheadline(?:s)?\s+(?:on|about)\b",
        r"\b(?:update|updates)\s+on\b",
        r"\bwhat(?:'s| is)?\s+new\s+with\b",
    ]
    return any(re.search(pattern, lowered) for pattern in topic_patterns)


def _detect_news_mode(task: str) -> str:
    text = task.lower().strip()
    baltimore_tokens = ["baltimore", "maryland", "local news", "local headlines", "local events"]
    mixed_tokens = ["national and baltimore", "baltimore and national", "world and baltimore", "both baltimore and national", "major news and baltimore"]

    has_baltimore = any(token in text for token in baltimore_tokens)
    has_mixed = any(token in text for token in mixed_tokens)

    if has_mixed:
        return "mixed"
    if _looks_like_topic_news_request(text):
        return "topic_search"
    if has_baltimore:
        return "baltimore_local"
    return "national_major"


def _is_time_sensitive_request(task: str) -> bool:
    text = task.lower().strip()
    return any(
        trigger in text
        for trigger in [
            "today",
            "tonight",
            "this morning",
            "this afternoon",
            "right now",
            "latest",
            "breaking",
            "current",
            "recent",
            "news",
            "headline",
            "weather",
        ]
    )


def _tokenize_agent_aliases(*values: str) -> list[str]:
    aliases: list[str] = []
    for value in values:
        text = (value or "").strip().lower()
        if not text:
            continue
        aliases.append(text)
        aliases.extend(part for part in re.split(r"[\s_/:-]+", text) if len(part) >= 3)
    seen: list[str] = []
    for alias in aliases:
        if alias not in seen:
            seen.append(alias)
    return seen


def _explicit_agent_target(task: str, profiles: dict[str, dict[str, Any]]) -> str | None:
    text = task.lower().strip()
    role_aliases = {
        "shopper": ["shopper", "private shopper"],
        "social": ["social", "social manager"],
        "secretary": ["secretary", "assistant"],
        "wellness": ["wellness", "wellness coach", "coach"],
        "researcher": ["researcher"],
        "critic": ["critic"],
        "writer": ["writer"],
        "coordinator": ["coordinator"],
    }
    for agent_id, profile in profiles.items():
        aliases = _tokenize_agent_aliases(
            agent_id,
            str(profile.get("name") or ""),
            *(role_aliases.get(agent_id, [])),
        )
        for alias in aliases:
            if len(alias) < 3:
                continue
            if re.search(rf"\b{re.escape(alias)}\b", text):
                return agent_id
    return None


def _detect_task_type_for_state(task: str, profiles: dict[str, dict[str, Any]], conservative: bool) -> str:
    explicit = _explicit_agent_target(task, profiles)
    if explicit == "shopper":
        return "shopping"
    if explicit == "social":
        return "social_media"
    if explicit == "secretary":
        return "secretary"
    if explicit == "wellness":
        return "wellness_coaching"

    if conservative:
        text = task.lower().strip()
        if _looks_like_market_task(text):
            return "market_research"
        strong_specialist_triggers = {
            "shopping": [
                "where can i buy",
                "best deal",
                "hard to find",
                "in stock",
                "source this item",
            ],
            "social_media": [
                "social media plan",
                "content calendar",
                "posting schedule",
                "linkedin post",
                "instagram caption",
                "tweet thread",
            ],
            "secretary": [
                "book appointment",
                "schedule appointment",
                "make a call",
                "place a call",
                "send a text",
                "send email",
                "follow up with",
            ],
            "wellness_coaching": [
                "wellness coach",
                "habit plan",
                "workout plan",
                "sleep routine",
                "motivation",
                "accountability",
                "stress plan",
                "healthy routine",
            ],
        }
        for task_type, triggers in strong_specialist_triggers.items():
            if any(trigger in text for trigger in triggers):
                return task_type
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
        if any(trigger in text for trigger in ["major news", "news today", "headlines today", "current events", "latest news", "breaking news"]) or _looks_like_topic_news_request(text):
            return "news_brief"
        return "conversation"

    return _detect_task_type(task)


def _is_fast_conversation_candidate(task: str) -> bool:
    text = task.lower().strip()
    if not text:
        return False
    if _is_time_sensitive_request(task):
        return False
    if len(text) > 220:
        return False
    if any(
        trigger in text
        for trigger in [
            "shop for",
            "find me",
            "social media",
            "tweet",
            "linkedin",
            "instagram",
            "book appointment",
            "send email",
            "send text",
            "make a call",
            "market",
            "earnings",
            "ticker",
            "browser",
            "scrape",
            "document",
            "pdf",
            "report",
            "graph",
        ]
    ):
        return False
    return True


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


async def _run_agent_browser_script(state: AgentState, agent_id: str, detail: str) -> tuple[list[str], list[str], list[dict[str, Any]]]:
    run_id = state["run_id"]
    scripts = playwright_service.list_scripts_for_agent(agent_id)
    if not scripts or not playwright_service.status().get("playwright_available"):
        return [], [], []

    script = next((item for item in scripts if item.get("mode") != "live"), scripts[0])
    if script.get("mode") == "live" and script.get("approval_required", False):
        await _emit(run_id, agent_id, "awaiting_approval", f"Live browser script awaiting approval: {script.get('name', 'script')}")
        return (
            [f"Live browser workflow queued for approval: {script.get('name', 'script')}"],
            [f"tool://browser_script/{script['script_id']}"],
            [{"tool": "browser_script", "ok": True, "payload": {"script_id": script["script_id"], "awaiting_approval": True}, "error": None}],
        )
    await _emit(run_id, agent_id, "start", detail)
    try:
        result = await playwright_service.run_script(str(script["script_id"]))
    except Exception as exc:
        await _emit(run_id, agent_id, "error", f"Browser script failed: {exc}")
        return [], [f"tool://browser_script/{script['script_id']}"], [{"tool": "browser_script", "ok": False, "payload": {"script_id": script["script_id"]}, "error": str(exc)}]

    notes: list[str] = []
    for item in result.get("results", []):
        if not isinstance(item, dict):
            continue
        label = str(item.get("step") or item.get("action") or "browser_step")
        if item.get("text"):
            notes.append(f"{label}: {str(item.get('text'))[:220]}")
        elif item.get("title"):
            notes.append(f"{label}: {item.get('title')}")
        elif item.get("url"):
            notes.append(f"{label}: {item.get('url')}")
    await _emit(run_id, agent_id, "ok", f"Browser script completed: {script.get('name', 'script')}")
    tool_record = {
        "tool": "browser_script",
        "ok": True,
        "payload": {"script_id": script["script_id"], "script_name": script.get("name"), "results": result.get("results", [])},
        "error": None,
    }
    return notes, [f"tool://browser_script/{script['script_id']}"], [tool_record]


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
        " I also have a secretary agent for booking, follow-up, calls, texts, and email workflows."
        " I also have a wellness coach for goals, habits, motivation, and accountability."
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

    def _strip_spoken_preamble(text: str) -> str:
        value = " ".join(str(text or "").split()).strip()
        patterns = [
            r"^(here(?:'s| are)\s+)",
            r"^(i can handle that as your secretary\.\s*)",
            r"^(i can coach this with you\.\s*)",
            r"^(i completed the shopping scan\.\s*)",
            r"^(i built the social media plan\.\s*)",
            r"^(i completed the market brief\.\s*)",
            r"^(i can help with that\.\s*)",
            r"^(key findings are:\s*)",
            r"^(the main angles are:\s*)",
            r"^(the strongest options are\s*)",
        ]
        for pattern in patterns:
            value = re.sub(pattern, "", value, flags=re.IGNORECASE)
        return value.strip(" .") + ("." if value and value[-1] not in ".!?" else "")

    clean = _strip_spoken_preamble(clean)

    profile = _agent_voice_settings(state, agent_id)
    persona = profile.get("speech_persona", "").strip()
    style = profile.get("speech_style", "natural")

    if not settings.openai_api_key:
        return clean

    llm = build_llm_for_agent(agent_id, temperature=0.35)
    prompt = (
        "Rewrite this text for spoken delivery. Keep the meaning intact, keep it concise, and make it sound like a normal human. "
        "No markdown. No bullet points. No repeated ideas. Start directly with the substance.\n\n"
        f"Persona: {persona or 'Polished human operator'}\n"
        f"Speech style: {style}\n\n"
        "Rules:\n"
        "- Do not start with filler or framing like 'Here are', 'I can help', 'I completed', 'I built', 'Absolutely', 'Sure', or 'As your'.\n"
        "- Assume the short acknowledgment already happened.\n"
        "- Go straight to the answer.\n\n"
        f"Text:\n{clean}"
    )
    try:
        response = await llm.ainvoke(prompt)
        polished = str(response.content).strip()
        return _strip_spoken_preamble(polished or clean)
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
    started_at = datetime.now(tz=timezone.utc)
    try:
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential_jitter(initial=1, max=8),
            reraise=True,
        ):
            with attempt:
                result = await fn()
                finished_at = datetime.now(tz=timezone.utc)
                result.setdefault("node_results", [])
                result["node_results"].append(
                    {
                        "node": node_name,
                        "status": "ok",
                        "detail": "completed",
                        "started_at": started_at.isoformat(),
                        "finished_at": finished_at.isoformat(),
                        "elapsed_ms": int((finished_at - started_at).total_seconds() * 1000),
                    }
                )
                return result
    except Exception as exc:
        state.setdefault("errors", [])
        state["errors"].append(f"{node_name}:{type(exc).__name__}:{exc}")
        finished_at = datetime.now(tz=timezone.utc)
        state.setdefault("node_results", [])
        state["node_results"].append(
            {
                "node": node_name,
                "status": "error",
                "detail": str(exc),
                "started_at": started_at.isoformat(),
                "finished_at": finished_at.isoformat(),
                "elapsed_ms": int((finished_at - started_at).total_seconds() * 1000),
            }
        )
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

        conservative = bool(state.get("conservative_specialist_routing", False))
        profiles = state.get("agent_profiles") or {}
        explicit_target = _explicit_agent_target(state["task"], profiles)
        task_type = _detect_task_type_for_state(state["task"], profiles, conservative)
        if task_type == "news_brief":
            state["news_mode"] = _detect_news_mode(state["task"])
        fast_path = "conversation_direct" if task_type == "conversation" and _is_fast_conversation_candidate(state["task"]) else ""
        route_agent = {
            "shopping": "shopper",
            "social_media": "social",
            "secretary": "secretary",
            "wellness_coaching": "wellness",
        }.get(task_type, "coordinator")
        if explicit_target:
            route_reason = f"explicit mention of {explicit_target}"
        elif task_type == "news_brief":
            route_reason = f"time-sensitive news request ({state.get('news_mode') or _detect_news_mode(state['task'])})"
        elif task_type == "conversation" and fast_path == "conversation_direct":
            route_reason = "simple conversational request fast-pathed through coordinator and writer"
        elif conservative:
            route_reason = "conservative specialist routing kept the coordinator unless intent was strong"
        else:
            route_reason = "intent matched specialist workflow"

        if fast_path != "conversation_direct":
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

            memory_refs = await memory_service.recall(state["user_id"], thread_id, state["task"])
            thread_context = await memory_service.get_thread_context(thread_id)
        else:
            memory_refs = []
            thread_context = ""

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
        elif task_type == "news_brief":
            plan = (
                "1) Search for current major headlines\n"
                "2) Pull the clearest top items and sources\n"
                "3) Summarize them plainly without system chatter"
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

        if fast_path != "conversation_direct":
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
        state["fast_path"] = fast_path
        state["policy_version"] = POLICY_VERSION
        state["prompt_version"] = PROMPT_VERSION
        state["route_decision"] = {
            "task_type": task_type,
            "agent_id": route_agent,
            "explicit_agent": explicit_target or "",
            "reason": route_reason,
            "fast_path": fast_path or "",
            "conservative_specialist_routing": conservative,
            "news_mode": state.get("news_mode") or "",
        }
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
            browser_notes, browser_citations, browser_records = await _run_agent_browser_script(
                state,
                "researcher",
                "Running saved researcher browser script",
            )
            notes.extend(browser_notes)
            citations.extend(browser_citations)
            tool_results.extend(browser_records)
        elif task_type == "news_brief":
            news_mode = str(state.get("news_mode") or "national_major")
            if news_mode == "mixed":
                national_result = await GENERAL_NEWS_TOOL.run(state["task"], state["mode"], "national_major")
                local_result = await GENERAL_NEWS_TOOL.run(state["task"], state["mode"], "baltimore_local")
                for result in [national_result, local_result]:
                    payload = result.payload if isinstance(result.payload, dict) else {}
                    tool_results.append(_tool_record(result))
                    label = "National" if payload.get("news_mode") == "national_major" else "Baltimore"
                    notes.extend([f"{label}: {item}" for item in payload.get("items", [])])
                    citations.extend([item.get("url", "") for item in payload.get("results", []) if isinstance(item, dict) and item.get("url")])
            else:
                result = await GENERAL_NEWS_TOOL.run(state["task"], state["mode"], news_mode)
                payload = result.payload if isinstance(result.payload, dict) else {}
                tool_results.append(_tool_record(result))
                notes = list(payload.get("items", []))
                citations = [item.get("url", "") for item in payload.get("results", []) if isinstance(item, dict) and item.get("url")]
            state.setdefault("warnings", [])
            source_types = {
                (record.get("payload") or {}).get("source_type")
                for record in tool_results
                if isinstance(record, dict)
            }
            if "direct_outlet_scrape" in source_types:
                state["warnings"].append(
                    "Using direct outlet headline scraping. Sources are prioritized, but this is still lighter-weight than a dedicated newswire or news API."
                )
            if "topic_news_search" in source_types:
                state["warnings"].append(
                    "Using targeted current-news search results for this topic. Timeliness is better than the general headline scraper, but this is still lighter-weight than a dedicated newswire feed."
                )
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
            browser_notes, browser_citations, browser_records = await _run_agent_browser_script(
                state,
                "shopper",
                "Running shopper browser sourcing script",
            )
            notes.extend(browser_notes)
            citations.extend(browser_citations)
            tool_results.extend(browser_records)
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
            browser_notes, browser_citations, browser_records = await _run_agent_browser_script(
                state,
                "social",
                "Running social browser admin script",
            )
            notes.extend(browser_notes)
            citations.extend(browser_citations)
            tool_results.extend(browser_records)
        elif task_type == "secretary":
            notes = [
                "Secretary workflow should confirm channel, recipient, and timing before any live outreach.",
                "Calls, texts, and email remain approval-gated until credentials and live mode are both enabled.",
            ]
            citations = ["system://secretary", "system://approval"]
            browser_notes, browser_citations, browser_records = await _run_agent_browser_script(
                state,
                "secretary",
                "Running secretary browser form workflow",
            )
            notes.extend(browser_notes)
            citations.extend(browser_citations)
            tool_results.extend(browser_records)
        elif task_type == "wellness_coaching":
            notes = [
                "Wellness coaching should turn broad intention into a small number of specific, repeatable behaviors.",
                "The best plans balance movement, sleep, food, stress load, and recovery rather than overfocusing on one lever.",
                "Accountability works better with short feedback loops, explicit targets, and compassionate course correction.",
                "Motivation should be anchored to a concrete routine and next action, not only mood.",
            ]
            citations = ["system://wellness", "system://habits", "system://accountability"]
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

        tool_count = 3 if task_type == "shopping" else (6 if task_type == "social_media" else (1 if task_type == "news_brief" else (2 if task_type == "market_research" else max(len(TOOLS), 1))))
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
        elif task_type == "news_brief":
            if len(notes) < 2:
                critique_flags.append("thin_news_brief")

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
        action_items: list[dict[str, Any]] = []

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
            action_items = [{"owner": "coordinator", "type": "clarify_goal", "label": "Choose the next system capability to use"}]
        elif task_type == "conversation":
            if state.get("fast_path") == "conversation_direct":
                spoken_response = _local_conversation_fallback(state.get("task", ""))
                if not spoken_response:
                    spoken_response = "I can help with that. Tell me a bit more about what you want to do."
            else:
                spoken_response = await _polish_spoken_response(state, await _build_conversation_answer(state), speaker_agent)
            report = (
                "# Conversation Response\n\n"
                f"{spoken_response}\n\n"
                "## Context Used\n"
                + "\n".join(f"- {n}" for n in state.get("research_notes", []))
            )
            action_items = [{"owner": "coordinator", "type": "follow_up", "label": "Continue the conversation or escalate to a specialist"}]
        elif task_type == "news_brief":
            top_notes = state.get("research_notes", [])[:5]
            top_links = state.get("citations", [])[:5]
            news_mode = str(state.get("news_mode") or "national_major")
            spoken_response = "; ".join(top_notes[:3]) if top_notes else "I could not confirm enough reliable headlines."
            if news_mode == "mixed":
                national = [item.replace("National: ", "") for item in state.get("research_notes", []) if str(item).startswith("National: ")]
                local = [item.replace("Baltimore: ", "") for item in state.get("research_notes", []) if str(item).startswith("Baltimore: ")]
                report = (
                    "# News Brief\n\n"
                    "## National / World Headlines\n"
                    + "\n".join(f"- {n}" for n in national[:5])
                    + "\n\n## Baltimore Local Headlines\n"
                    + "\n".join(f"- {n}" for n in local[:5])
                    + "\n\n## Sources\n"
                    + "\n".join(f"- {c}" for c in top_links)
                )
            elif news_mode == "baltimore_local":
                report = (
                    "# Baltimore News Brief\n\n"
                    "## Baltimore Local Headlines\n"
                    + "\n".join(f"- {n}" for n in top_notes)
                    + "\n\n## Sources\n"
                    + "\n".join(f"- {c}" for c in top_links)
                )
            elif news_mode == "topic_search":
                report = (
                    "# Topic News Brief\n\n"
                    "## Latest Coverage\n"
                    + "\n".join(f"- {n}" for n in top_notes)
                    + "\n\n## Sources\n"
                    + "\n".join(f"- {c}" for c in top_links)
                )
            else:
                report = (
                    "# News Brief\n\n"
                    "## National / World Headlines\n"
                    + "\n".join(f"- {n}" for n in top_notes)
                    + "\n\n## Sources\n"
                    + "\n".join(f"- {c}" for c in top_links)
                )
            action_items = [{"owner": "coordinator", "type": "news_follow_up", "label": "Ask for deeper coverage on one headline or switch to Baltimore-only news"}]
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
                    f"{('; '.join(top_notes[:3]) if top_notes else 'The options are still being narrowed down')}. "
                    "I would prioritize trusted sellers and clear return windows before chasing the cheapest listing."
                ),
                speaker_agent,
            )
            action_items = [
                {"owner": "shopper", "type": "approve_lead", "label": "Approve the best lead for follow-up"},
                {"owner": "shopper", "type": "compare_risk", "label": "Compare seller trust and return policy before buying"},
            ]
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
                    f"{('; '.join(top_notes[:3]) if top_notes else 'The main angles are still being refined')}. "
                    "I would keep the message consistent, then tailor hooks and cadence by platform."
                ),
                speaker_agent,
            )
            action_items = [
                {"owner": "social", "type": "queue_post", "label": "Queue one platform-specific post for approval"},
                {"owner": "social", "type": "schedule_campaign", "label": "Set publishing cadence for the week"},
            ]
        elif task_type == "secretary":
            speaker_agent = "secretary"
            report = (
                "# Secretary Brief\n\n"
                f"Request: {state['task']}\n\n"
                f"## Plan\n{state.get('coordinator_plan', 'N/A')}\n\n"
                "## Next Actions\n"
                "- Confirm the contact, channel, and timing.\n"
                "- Queue an approval-gated call, text, or email.\n"
                "- Log the outreach result back into memory and the graph.\n"
            )
            spoken_response = await _polish_spoken_response(
                state,
                "I will line up the call, text, or email flow and keep it approval-gated before anything goes out.",
                speaker_agent,
            )
            action_items = [
                {"owner": "secretary", "type": "confirm_contact", "label": "Confirm recipient and preferred channel"},
                {"owner": "secretary", "type": "queue_outreach", "label": "Queue approval-gated outreach"},
            ]
        elif task_type == "wellness_coaching":
            speaker_agent = "wellness"
            top_notes = state.get("research_notes", [])[:4]
            report = (
                "# Wellness Coach Brief\n\n"
                f"Request: {state['task']}\n\n"
                "## Focus Areas\n"
                + "\n".join(f"- {n}" for n in top_notes)
                + "\n\n## This Week's Structure\n"
                "- Pick one daily anchor habit you can complete in under ten minutes.\n"
                "- Set one movement target, one recovery target, and one stress-reduction target.\n"
                "- Review adherence once at the end of the day instead of negotiating all day.\n"
                "\n## Accountability Prompts\n"
                "- What is today's smallest non-negotiable win?\n"
                "- What is the one friction point I can remove before noon?\n"
                "- If the day goes sideways, what is the reduced version that still counts?\n"
            )
            spoken_response = await _polish_spoken_response(
                state,
                (
                    "We will keep it practical: one anchor habit, one movement target, one recovery target, "
                    "and a short daily accountability check so the plan is realistic enough to stick."
                ),
                speaker_agent,
            )
            action_items = [
                {"owner": "wellness", "type": "anchor_habit", "label": "Choose one daily anchor habit"},
                {"owner": "wellness", "type": "movement_goal", "label": "Set one movement target for the week"},
                {"owner": "wellness", "type": "recovery_goal", "label": "Set one sleep or recovery target"},
            ]
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
                    f"{spoken_findings}. "
                    f"Risk review is {_format_risk_flags(state.get('critique_flags', []))}."
                ),
                speaker_agent,
            )
            action_items = [
                {"owner": "coordinator", "type": "review_brief", "label": "Review the market brief and choose next action"},
            ]

        await _emit_speech_preview(state, speaker_agent, spoken_response)
        writer_episode_id = ""
        if state.get("fast_path") != "conversation_direct":
            writer_episode_id = await _remember_episode(
                state,
                "writer",
                "final_output",
                report,
                metadata={"task_type": task_type, "citations": state.get("citations", [])[:8], "speaker_agent": speaker_agent},
            )

        claim_records = []
        if state.get("fast_path") != "conversation_direct":
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

        if state.get("fast_path") != "conversation_direct":
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
        state["speaker_agent"] = speaker_agent
        state["final_report"] = report
        state["action_items"] = action_items
        state["operator_summary"] = spoken_response
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
    state["speaker_agent"] = "coordinator"
    state["final_report"] = fallback
    state["run_status"] = "degraded"
    return state


def should_research_continue(state: AgentState) -> str:
    if state.get("force_degraded"):
        return "degraded"
    return "critic" if len(state.get("research_notes", [])) >= 2 else "degraded"


def should_coordinator_route(state: AgentState) -> str:
    if state.get("force_degraded"):
        return "degraded"
    if state.get("fast_path") == "conversation_direct":
        return "writer"
    return "researcher"


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
