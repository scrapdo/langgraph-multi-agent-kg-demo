"""Helpers for streaming LLM tokens to the SSE event bus.

We stream tokens as ``{"type": "token", "agent": "<agent>", "content": "<delta>"}``
events. The frontend appends ``content`` to the active assistant message as
each chunk arrives so the answer types in live instead of appearing as a block.
"""

from __future__ import annotations

from typing import Any

from app.events.bus import event_bus


async def publish_token(run_id: str, agent: str, content: str) -> None:
    """Publish a streaming-token event."""
    if not run_id or not content:
        return
    await event_bus.publish(
        run_id,
        {
            "type": "token",
            "agent": agent,
            "content": content,
        },
    )


async def publish_stream_end(run_id: str, agent: str) -> None:
    """Signal that a streamed LLM call has finished producing tokens.

    The frontend can use this to clean up placeholders / animation state
    without waiting for the run to terminate.
    """
    if not run_id:
        return
    await event_bus.publish(
        run_id,
        {
            "type": "stream_end",
            "agent": agent,
        },
    )


def chunk_content(chunk: Any) -> str:
    """Best-effort text extraction from a LangChain AIMessageChunk / BaseMessageChunk."""
    content = getattr(chunk, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for piece in content:
            if isinstance(piece, str):
                parts.append(piece)
            elif isinstance(piece, dict):
                # OpenAI tool-call style chunks sometimes arrive as list-of-dict.
                if "text" in piece and isinstance(piece["text"], str):
                    parts.append(piece["text"])
        return "".join(parts)
    return ""
