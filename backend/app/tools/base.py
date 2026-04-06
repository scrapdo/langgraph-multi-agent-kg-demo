from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass
class ToolResult:
    tool: str
    ok: bool
    payload: dict[str, Any]
    error: str | None = None


class ToolAdapter(Protocol):
    name: str

    async def run(self, query: str, mode: str) -> ToolResult: ...
