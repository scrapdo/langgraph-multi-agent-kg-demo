from __future__ import annotations

import html
import random
import re
from urllib.parse import quote, unquote, urlparse

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from app.core.config import settings
from app.services.huggingface_service import huggingface_service
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


class HuggingFaceDiscoveryTool:
    name = "hf_hub_discovery"

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str) -> ToolResult:
        lowered = query.lower()
        if not any(token in lowered for token in ["hugging face", "model", "dataset", "space", "transformers", "tts"]):
            return ToolResult(
                tool=self.name,
                ok=True,
                payload={"items": [], "mode": mode, "skipped": True},
            )

        models = await huggingface_service.search_models(query=query, limit=3)
        datasets = await huggingface_service.search_datasets(query=query, limit=2)
        items = [
            f"Model: {item['id']}"
            for item in models.get("items", [])
        ] + [
            f"Dataset: {item['id']}"
            for item in datasets.get("items", [])
        ]
        return ToolResult(
            tool=self.name,
            ok=True,
            payload={"items": items, "mode": mode, "skipped": False},
        )


class ShoppingScoutTool:
    name = "shopping_scout"

    @retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(initial=1, max=8))
    async def run(self, query: str, mode: str) -> ToolResult:
        items = [
            f"Primary source shortlist for {query}",
            f"Resale and specialty marketplace scan for {query}",
            f"Best current deal signal and stock-risk note for {query}",
        ]
        payload = {
            "items": items,
            "deal_score": round(0.58 + random.random() * 0.35, 2),
            "trust_notes": [
                "Prefer verified sellers with clear return windows",
                "Avoid listings without recent timestamped photos",
            ],
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


class ShoppingSearchTool:
    name = "shopping_search"

    async def _search_duckduckgo(self, query: str) -> list[dict[str, str]]:
        url = f"https://duckduckgo.com/html/?q={quote(query)}"
        async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as client:
            response = await client.get(url)
            response.raise_for_status()
        body = response.text
        matches = re.findall(
            r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        results: list[dict[str, str]] = []
        for href, title_html in matches[:10]:
            title = re.sub(r"<.*?>", "", title_html)
            title = html.unescape(" ".join(title.split()))
            direct_url = href
            if "uddg=" in href:
                direct_url = unquote(href.split("uddg=", 1)[1].split("&", 1)[0])
            parsed = urlparse(direct_url)
            domain = parsed.netloc.replace("www.", "")
            if not domain:
                continue
            results.append({"title": title, "url": direct_url, "domain": domain})
        return results

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str) -> ToolResult:
        search_results = await self._search_duckduckgo(f"{query} buy deal trusted seller")
        preferred_domains = [
            "chrono24.com",
            "ebay.com",
            "stockx.com",
            "grailed.com",
            "etsy.com",
            "amazon.com",
            "walmart.com",
            "bestbuy.com",
        ]
        ranked = sorted(
            search_results,
            key=lambda item: 0 if any(domain in item["domain"] for domain in preferred_domains) else 1,
        )[:5]
        enriched = []
        for item in ranked:
            trust_score, marketplace_type, price_signal = score_shopping_domain(item["domain"])
            enriched.append(
                {
                    **item,
                    "trust_score": trust_score,
                    "marketplace_type": marketplace_type,
                    "price_signal": price_signal,
                }
            )
        items = [
            f"{item['title']} [{item['domain']}] score {item['trust_score']}"
            for item in enriched
        ]
        payload = {
            "items": items,
            "results": enriched,
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


def score_shopping_domain(domain: str) -> tuple[int, str, str]:
    scored = {
        "chrono24.com": (92, "premium-marketplace", "secondary market"),
        "omegawatches.com": (96, "brand-direct", "official retailer"),
        "bobswatches.com": (84, "specialist-dealer", "secondary market"),
        "vintagewatchusa.com": (80, "specialist-dealer", "independent dealer"),
        "mrwatchmaster.com": (68, "editorial", "editorial guide"),
        "ebay.com": (52, "marketplace", "peer marketplace"),
        "stockx.com": (77, "marketplace", "resale marketplace"),
        "grailed.com": (72, "marketplace", "enthusiast marketplace"),
        "etsy.com": (60, "marketplace", "peer marketplace"),
        "amazon.com": (65, "marketplace", "mass retail"),
        "walmart.com": (66, "retailer", "mass retail"),
        "bestbuy.com": (74, "retailer", "big-box retail"),
    }
    for key, value in scored.items():
        if key in domain:
            return value
    return (58, "unknown", "general web")


class SocialPlanningTool:
    name = "social_planning"

    @retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(initial=1, max=8))
    async def run(self, query: str, mode: str) -> ToolResult:
        items = [
            f"Campaign angle and hook options for {query}",
            f"Platform mix and timing recommendations for {query}",
            f"Content queue and engagement follow-up plan for {query}",
        ]
        payload = {
            "items": items,
            "channels": ["X", "LinkedIn", "Instagram"],
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


class XStrategyTool:
    name = "x_strategy"

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str) -> ToolResult:
        payload = {
            "items": [
                f"X hook stack for {query}",
                "Use sharp first-line hooks and threadable follow-up points.",
                "Plan 2 reactive posts plus 1 anchor post tied to the main launch narrative.",
            ],
            "platform": "X",
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


class LinkedInStrategyTool:
    name = "linkedin_strategy"

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str) -> ToolResult:
        payload = {
            "items": [
                f"LinkedIn authority angle for {query}",
                "Lead with an operator insight, then add one concrete result or lesson.",
                "Use one founder-style post and one team/process post for credibility layering.",
            ],
            "platform": "LinkedIn",
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


class InstagramStrategyTool:
    name = "instagram_strategy"

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str) -> ToolResult:
        payload = {
            "items": [
                f"Instagram creative direction for {query}",
                "Use visually anchored carousel or reel concepts with short caption hooks.",
                "Pair launch visuals with one behind-the-scenes asset to humanize the release.",
            ],
            "platform": "Instagram",
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


class SchedulePlannerTool:
    name = "schedule_planner"

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str) -> ToolResult:
        payload = {
            "items": [
                f"Weekly schedule recommendation for {query}",
                "Front-load the primary announcement early in the week, then stagger proof and follow-up posts.",
                "Reserve one engagement block per day for replies, comments, and lightweight redistribution.",
            ],
            "mode": mode,
        }
        return ToolResult(tool=self.name, ok=True, payload=payload)


class SocialPublishTool:
    def __init__(self, name: str, platform: str, webhook_url: str, bearer_token: str):
        self.name = name
        self.platform = platform
        self.webhook_url = webhook_url
        self.bearer_token = bearer_token

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str) -> ToolResult:
        payload = {
            "platform": self.platform,
            "message": query[:280],
            "mode": mode,
            "executed": False,
            "simulated": True,
        }
        if not can_execute_live(self.name, mode) or not self.webhook_url:
            return ToolResult(tool=self.name, ok=True, payload=payload)

        headers = {"Content-Type": "application/json"}
        if self.bearer_token:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.post(
                self.webhook_url,
                json={"platform": self.platform, "message": query[:280]},
                headers=headers,
            )
            response.raise_for_status()
        payload["executed"] = True
        payload["simulated"] = False
        return ToolResult(tool=self.name, ok=True, payload=payload)


MARKET_NEWS_TOOL = MarketNewsTool()
CONTENT_PUBLISH_TOOL = ContentPublishTool()
HUGGINGFACE_DISCOVERY_TOOL = HuggingFaceDiscoveryTool()
SHOPPING_SCOUT_TOOL = ShoppingScoutTool()
SHOPPING_SEARCH_TOOL = ShoppingSearchTool()
SOCIAL_PLANNING_TOOL = SocialPlanningTool()
X_STRATEGY_TOOL = XStrategyTool()
LINKEDIN_STRATEGY_TOOL = LinkedInStrategyTool()
INSTAGRAM_STRATEGY_TOOL = InstagramStrategyTool()
SCHEDULE_PLANNER_TOOL = SchedulePlannerTool()
X_PUBLISH_TOOL = SocialPublishTool("x_publish", "X", settings.x_publish_webhook_url, settings.x_publish_bearer_token)
LINKEDIN_PUBLISH_TOOL = SocialPublishTool(
    "linkedin_publish",
    "LinkedIn",
    settings.linkedin_publish_webhook_url,
    settings.linkedin_publish_bearer_token,
)
INSTAGRAM_PUBLISH_TOOL = SocialPublishTool(
    "instagram_publish",
    "Instagram",
    settings.instagram_publish_webhook_url,
    settings.instagram_publish_bearer_token,
)
TOOLS = [
    MARKET_NEWS_TOOL,
    HUGGINGFACE_DISCOVERY_TOOL,
    SHOPPING_SCOUT_TOOL,
    SHOPPING_SEARCH_TOOL,
    SOCIAL_PLANNING_TOOL,
    X_STRATEGY_TOOL,
    LINKEDIN_STRATEGY_TOOL,
    INSTAGRAM_STRATEGY_TOOL,
    SCHEDULE_PLANNER_TOOL,
    X_PUBLISH_TOOL,
    LINKEDIN_PUBLISH_TOOL,
    INSTAGRAM_PUBLISH_TOOL,
]
