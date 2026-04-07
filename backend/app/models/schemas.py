from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

RunMode = Literal["simulation", "live"]
RunStatus = Literal["queued", "running", "completed", "failed", "degraded"]


class RunRequest(BaseModel):
    user_id: str = Field(default="demo-user")
    session_id: str = Field(default="demo-session")
    task: str
    mode: RunMode = "simulation"


class ToolAttempt(BaseModel):
    tool: str
    attempt: int
    status: Literal["ok", "error"]
    error: str | None = None


class MemoryReference(BaseModel):
    memory_id: str
    thread_id: str | None = None
    score: float | None = None
    summary: str | None = None
    facts: list[str] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    source_type: str | None = None
    created_at: str | None = None


class EpisodeRecord(BaseModel):
    episode_id: str
    thread_id: str | None = None
    run_id: str | None = None
    agent_id: str | None = None
    episode_type: str
    content: str
    created_at: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ClaimRecord(BaseModel):
    claim_id: str
    text: str
    source: str | None = None
    confidence: float | None = None
    status: str | None = None
    entity_names: list[str] = Field(default_factory=list)
    created_at: str | None = None


class DesktopArtifactRecord(BaseModel):
    artifact_id: str
    action_id: str
    kind: str
    agent_id: str | None = None
    action_type: str | None = None
    title: str | None = None
    output_path: str | None = None
    created_at: str | None = None


class EntityMention(BaseModel):
    entity_id: str
    name: str
    entity_type: str = "concept"


class NodeResult(BaseModel):
    node: str
    status: Literal["ok", "retry", "error"]
    detail: str
    started_at: datetime
    finished_at: datetime


class GraphDelta(BaseModel):
    created_nodes: int = 0
    created_relationships: int = 0


class AgentProfile(BaseModel):
    id: str
    name: str
    avatar: str
    provider: str
    model: str
    function: str = ""
    speech_voice: str = "verse"
    speech_style: str = "natural"
    speech_persona: str = ""
    premium_voice_id: str = ""
    heygen_avatar_id: str = ""
    heygen_voice_id: str = ""
    app_execution_mode: Literal["disabled", "approval", "auto"] = "approval"
    specialist_apps: list[str] = Field(default_factory=list)


class AgentProfilesPayload(BaseModel):
    agents: dict[str, AgentProfile]


class AgentProfilePatch(BaseModel):
    name: str | None = None
    avatar: str | None = None
    provider: str | None = None
    model: str | None = None
    function: str | None = None
    speech_voice: str | None = None
    speech_style: str | None = None
    speech_persona: str | None = None
    premium_voice_id: str | None = None
    heygen_avatar_id: str | None = None
    heygen_voice_id: str | None = None
    app_execution_mode: Literal["disabled", "approval", "auto"] | None = None
    specialist_apps: list[str] | None = None


class AgentProfileUpdatePayload(BaseModel):
    agents: dict[str, AgentProfilePatch]


class RunResponse(BaseModel):
    run_id: str
    status: RunStatus


class RunDetail(BaseModel):
    run_id: str
    status: RunStatus
    mode: RunMode
    task: str
    state: dict[str, Any]
    output: str | None = None
    created_at: datetime
    updated_at: datetime


class RunMemoryResponse(BaseModel):
    run_id: str
    thread_id: str | None = None
    thread_context: str | None = None
    memory_refs: list[MemoryReference] = Field(default_factory=list)
    episodes: list[EpisodeRecord] = Field(default_factory=list)
    entities: list[EntityMention] = Field(default_factory=list)
    claims: list[ClaimRecord] = Field(default_factory=list)
    desktop_artifacts: list[DesktopArtifactRecord] = Field(default_factory=list)


class ThreadDetailResponse(BaseModel):
    thread_id: str
    user_id: str | None = None
    context: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    episodes: list[EpisodeRecord] = Field(default_factory=list)


class ShoppingSource(BaseModel):
    title: str
    domain: str
    url: str
    trust_score: int
    price_signal: str | None = None
    marketplace_type: str | None = None


class ShoppingSummaryResponse(BaseModel):
    run_id: str
    task: str
    trust_notes: list[str] = Field(default_factory=list)
    sources: list[ShoppingSource] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)


class ApprovalItem(BaseModel):
    approval_id: str
    kind: Literal["shopping_lead", "social_post"]
    title: str
    status: Literal["queued", "approved", "rejected"]
    platform: str | None = None
    url: str | None = None
    message: str | None = None
    notes: list[str] = Field(default_factory=list)
    executed: bool = False
    simulated: bool = True
    created_at: str
    updated_at: str


class SocialPlatformPlan(BaseModel):
    platform: str
    notes: list[str] = Field(default_factory=list)
    live_ready: bool = False


class SocialSummaryResponse(BaseModel):
    run_id: str
    task: str
    platforms: list[SocialPlatformPlan] = Field(default_factory=list)
    scheduling_notes: list[str] = Field(default_factory=list)
    publish_status: list[dict[str, Any]] = Field(default_factory=list)
    approvals: list[ApprovalItem] = Field(default_factory=list)


class LocalAppDefinition(BaseModel):
    id: str
    label: str
    category: str
    actions: list[str] = Field(default_factory=list)
    notes: str | None = None


class DesktopAction(BaseModel):
    action_id: str
    kind: Literal["writer_doc", "social_package", "gmail_calendar", "ai_influencer"]
    agent_id: str
    status: Literal["queued", "completed", "blocked", "failed"]
    title: str
    output_path: str | None = None
    notes: list[str] = Field(default_factory=list)
    payload: dict[str, Any] = Field(default_factory=dict)
    execution_history: list[dict[str, Any]] = Field(default_factory=list)
    last_execution_method: str | None = None
    last_error: str | None = None
    executed_at: str | None = None
    created_at: str
    updated_at: str
