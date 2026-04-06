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
    score: float | None = None
    summary: str | None = None


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


class AgentProfilesPayload(BaseModel):
    agents: dict[str, AgentProfile]


class AgentProfilePatch(BaseModel):
    name: str | None = None
    avatar: str | None = None
    provider: str | None = None
    model: str | None = None
    function: str | None = None


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
