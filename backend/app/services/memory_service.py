from __future__ import annotations

import asyncio
from typing import Any

from zep_cloud.client import AsyncZep

from app.core.config import settings


class MemoryService:
    def __init__(self) -> None:
        self._client: AsyncZep | None = None
        if settings.zep_api_key:
            self._client = AsyncZep(api_key=settings.zep_api_key)

    async def recall(self, user_id: str, session_id: str, query: str) -> list[dict[str, Any]]:
        if not self._client:
            return []
        try:
            memories = await asyncio.wait_for(
                self._client.memory.search_sessions(user_id=user_id, text=query, limit=5),
                timeout=8,
            )
            return [
                {
                    "memory_id": getattr(m, "session_id", ""),
                    "summary": getattr(m, "summary", None),
                    "score": getattr(m, "score", None),
                }
                for m in getattr(memories, "results", [])
            ]
        except Exception:
            return []

    async def store(self, user_id: str, session_id: str, content: str) -> None:
        if not self._client:
            return
        try:
            await asyncio.wait_for(
                self._client.memory.add(
                    session_id=session_id,
                    messages=[{"role": "assistant", "content": content}],
                    user_id=user_id,
                ),
                timeout=8,
            )
        except Exception:
            return


memory_service = MemoryService()
