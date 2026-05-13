from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from zep_cloud.client import AsyncZep
from zep_cloud.types.message import Message

from app.core.config import settings


class MemoryService:
    def __init__(self) -> None:
        self._client: AsyncZep | None = None
        if settings.zep_api_key:
            self._client = AsyncZep(api_key=settings.zep_api_key)

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def ensure_user_and_thread(self, user_id: str, thread_id: str) -> bool:
        if not self._client:
            return False
        try:
            try:
                await asyncio.wait_for(self._client.user.get(user_id), timeout=8)
            except Exception:
                await asyncio.wait_for(self._client.user.add(user_id=user_id, metadata={"source": "kg-demo"}), timeout=8)

            try:
                await asyncio.wait_for(self._client.thread.get(thread_id, lastn=1), timeout=8)
            except Exception:
                await asyncio.wait_for(self._client.thread.create(thread_id=thread_id, user_id=user_id), timeout=8)
            return True
        except Exception:
            return False

    async def add_message(
        self,
        user_id: str,
        thread_id: str,
        role: str,
        content: str,
        *,
        metadata: dict[str, Any] | None = None,
        return_context: bool = False,
    ) -> dict[str, Any]:
        if not self._client or not content.strip():
            return {}
        ok = await self.ensure_user_and_thread(user_id, thread_id)
        if not ok:
            return {}
        try:
            response = await asyncio.wait_for(
                self._client.thread.add_messages(
                    thread_id,
                    messages=[
                        Message(
                            role=role,
                            content=content,
                            created_at=datetime.now(tz=timezone.utc).isoformat(),
                            metadata=metadata or {},
                        )
                    ],
                    return_context=return_context,
                ),
                timeout=8,
            )
            return {
                "context": getattr(response, "context", None),
                "message_uuids": list(getattr(response, "message_uuids", []) or []),
                "task_id": getattr(response, "task_id", None),
            }
        except Exception:
            return {}

    async def add_episode(
        self,
        user_id: str,
        thread_id: str,
        content: str,
        *,
        source_description: str,
        episode_type: str,
    ) -> dict[str, Any]:
        if not self._client or not content.strip():
            return {}
        try:
            episode = await asyncio.wait_for(
                self._client.graph.add(
                    data=content,
                    type="text",
                    user_id=user_id,
                    graph_id=thread_id,
                    created_at=datetime.now(tz=timezone.utc).isoformat(),
                    source_description=f"{source_description}:{episode_type}",
                ),
                timeout=8,
            )
            return {
                "memory_id": getattr(episode, "uuid_", ""),
                "thread_id": getattr(episode, "thread_id", thread_id),
                "summary": getattr(episode, "content", None),
                "score": getattr(episode, "score", None),
                "source_type": getattr(episode, "source", "text"),
                "created_at": getattr(episode, "created_at", None),
            }
        except Exception:
            return {}

    async def get_thread_context(self, thread_id: str) -> str:
        if not self._client:
            return ""
        try:
            response = await asyncio.wait_for(self._client.thread.get_user_context(thread_id), timeout=8)
            return str(getattr(response, "context", "") or "")
        except Exception:
            return ""

    async def get_thread_messages(self, thread_id: str, lastn: int = 12) -> list[dict[str, Any]]:
        if not self._client:
            return []
        try:
            response = await asyncio.wait_for(self._client.thread.get(thread_id, lastn=lastn), timeout=8)
            messages = []
            for msg in getattr(response, "messages", []) or []:
                messages.append(
                    {
                        "uuid": getattr(msg, "uuid_", ""),
                        "role": getattr(msg, "role", "user"),
                        "content": getattr(msg, "content", ""),
                        "created_at": getattr(msg, "created_at", None),
                        "metadata": getattr(msg, "metadata", {}) or {},
                    }
                )
            return messages
        except Exception:
            return []

    async def recall(self, user_id: str, session_id: str, query: str) -> list[dict[str, Any]]:
        if not self._client:
            return []
        ok = await self.ensure_user_and_thread(user_id, session_id)
        if not ok:
            return []

        refs: list[dict[str, Any]] = []
        try:
            context = await self.get_thread_context(session_id)
            if context.strip():
                refs.append(
                    {
                        "memory_id": f"thread:{session_id}",
                        "thread_id": session_id,
                        "summary": context[:500],
                        "score": 1.0,
                        "facts": [],
                        "entities": [],
                        "source_type": "thread_context",
                        "created_at": None,
                    }
                )
        except Exception:
            pass

        try:
            search = await asyncio.wait_for(
                self._client.graph.search(
                    query=query,
                    user_id=user_id,
                    graph_id=session_id,
                    limit=5,
                    scope="episodes",
                    reranker="cross_encoder",
                ),
                timeout=8,
            )
            for episode in getattr(search, "episodes", []) or []:
                refs.append(
                    {
                        "memory_id": getattr(episode, "uuid_", ""),
                        "thread_id": getattr(episode, "thread_id", session_id),
                        "summary": getattr(episode, "content", None),
                        "score": getattr(episode, "score", None),
                        "facts": [],
                        "entities": [],
                        "source_type": getattr(episode, "source", "episode"),
                        "created_at": getattr(episode, "created_at", None),
                    }
                )
        except Exception:
            pass

        try:
            search = await asyncio.wait_for(
                self._client.graph.search(
                    query=query,
                    user_id=user_id,
                    graph_id=session_id,
                    limit=5,
                    scope="nodes",
                    reranker="cross_encoder",
                ),
                timeout=8,
            )
            for node in getattr(search, "nodes", []) or []:
                refs.append(
                    {
                        "memory_id": getattr(node, "uuid_", ""),
                        "thread_id": session_id,
                        "summary": getattr(node, "summary", None) or getattr(node, "name", None),
                        "score": getattr(node, "score", None),
                        "facts": [],
                        "entities": [getattr(node, "name", "")],
                        "source_type": "entity_node",
                        "created_at": getattr(node, "created_at", None),
                    }
                )
        except Exception:
            pass

        deduped: list[dict[str, Any]] = []
        seen: set[str] = set()
        for ref in refs:
            memory_id = str(ref.get("memory_id") or "")
            if not memory_id or memory_id in seen:
                continue
            seen.add(memory_id)
            deduped.append(ref)
        return deduped[:8]

    async def store(self, user_id: str, session_id: str, content: str) -> None:
        await self.add_message(
            user_id,
            session_id,
            role="assistant",
            content=content,
            metadata={"source": "writer_output"},
            return_context=False,
        )
        await self.add_episode(
            user_id,
            session_id,
            content,
            source_description="writer_output",
            episode_type="assistant_response",
        )


memory_service = MemoryService()
