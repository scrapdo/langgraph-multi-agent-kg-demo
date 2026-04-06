from __future__ import annotations

import random

from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from app.services.policy_service import can_execute_live
from app.tools.base import ToolResult


class MarketNewsTool:
    name = "market_news"

    @retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(initial=1, max=8))
    async def run(self, query: str, mode: str) -> ToolResult:
        items = [
            f"Macro update relevant to {query}",
            f"Sector flow signal for {query}",
            f"Earnings sentiment change around {query}",
        ]
        payload = {
            "items": items,
            "confidence": round(0.65 + random.random() * 0.3, 2),
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


class ContentPublishTool:
    name = "content_publish"

    @retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(initial=1, max=8))
    async def run(self, query: str, mode: str) -> ToolResult:
        payload = {
            "channel": "social",
            "message": query[:240],
            "mode": mode,
        }
        if can_execute_live(self.name, mode):
            payload["executed"] = True
            return ToolResult(tool=self.name, ok=True, payload=payload)
        payload["executed"] = False
        payload["simulated"] = True
        return ToolResult(tool=self.name, ok=True, payload=payload)


MARKET_NEWS_TOOL = MarketNewsTool()
CONTENT_PUBLISH_TOOL = ContentPublishTool()
TOOLS = [MARKET_NEWS_TOOL]
