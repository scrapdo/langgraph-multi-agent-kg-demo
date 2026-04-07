from __future__ import annotations

from typing import Any, Literal, TypedDict


class AgentState(TypedDict, total=False):
    run_id: str
    user_id: str
    session_id: str
    thread_id: str
    mode: Literal["simulation", "live"]
    task: str
    task_type: Literal["market_research", "capabilities", "conversation", "shopping", "social_media"]
    agent_profiles: dict[str, dict[str, str]]

    coordinator_plan: str
    research_notes: list[str]
    citations: list[str]
    critique_flags: list[str]
    final_report: str
    spoken_response: str

    memory_refs: list[dict[str, Any]]
    memory_context: str
    thread_context: str
    episodes: list[dict[str, Any]]
    episode_ids: list[str]
    claims: list[dict[str, Any]]
    entity_mentions: list[dict[str, Any]]
    graph_deltas: list[dict[str, Any]]
    tool_results: list[dict[str, Any]]
    node_results: list[dict[str, Any]]
    errors: list[str]

    thread_initialized: bool
    last_episode_id: str
    revision_count: int
    max_revisions: int
    run_status: Literal["queued", "running", "completed", "failed", "degraded"]
    force_degraded: bool
