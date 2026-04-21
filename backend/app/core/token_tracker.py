from __future__ import annotations

from threading import Lock
from typing import Any

from langchain_core.callbacks.base import BaseCallbackHandler


class TokenTracker(BaseCallbackHandler):
    """Aggregate token usage across every LLM call in a LangGraph workflow.

    LangChain models expose token usage in a few different places depending on
    provider and version (``response.llm_output['token_usage']``,
    ``message.usage_metadata``, or ``generation.generation_info['token_usage']``)
    so we look in all of them and add what we find.
    """

    def __init__(self) -> None:
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_tokens = 0
        self._lock = Lock()

    def _add(self, prompt: int = 0, completion: int = 0, total: int = 0) -> None:
        with self._lock:
            self.prompt_tokens += max(0, int(prompt or 0))
            self.completion_tokens += max(0, int(completion or 0))
            if total:
                self.total_tokens += int(total)
            else:
                self.total_tokens += int((prompt or 0) + (completion or 0))

    def on_llm_end(self, response: Any, **_: Any) -> None:  # noqa: ANN401 — LangChain shape
        # 1) Top-level LLM output metadata.
        llm_output = getattr(response, "llm_output", None) or {}
        usage = (
            llm_output.get("token_usage")
            or llm_output.get("usage")
            or {}
        )
        if usage:
            self._add(
                prompt=usage.get("prompt_tokens") or usage.get("input_tokens") or 0,
                completion=usage.get("completion_tokens") or usage.get("output_tokens") or 0,
                total=usage.get("total_tokens") or 0,
            )

        # 2) Per-generation metadata (newer LangChain ChatOpenAI packs it on the AIMessage).
        for gen_list in getattr(response, "generations", []) or []:
            for gen in gen_list or []:
                msg = getattr(gen, "message", None)
                if msg is not None:
                    meta = getattr(msg, "usage_metadata", None)
                    if meta:
                        self._add(
                            prompt=meta.get("input_tokens") or 0,
                            completion=meta.get("output_tokens") or 0,
                            total=meta.get("total_tokens") or 0,
                        )
                        continue
                info = getattr(gen, "generation_info", None) or {}
                gen_usage = info.get("token_usage") or info.get("usage") or {}
                if gen_usage:
                    self._add(
                        prompt=gen_usage.get("prompt_tokens") or gen_usage.get("input_tokens") or 0,
                        completion=gen_usage.get("completion_tokens") or gen_usage.get("output_tokens") or 0,
                        total=gen_usage.get("total_tokens") or 0,
                    )

    # Also observe async-only hook.
    async def on_llm_end_async(self, response: Any, **_: Any) -> None:
        self.on_llm_end(response)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "prompt": self.prompt_tokens,
                "completion": self.completion_tokens,
                "total": self.total_tokens or (self.prompt_tokens + self.completion_tokens),
            }
