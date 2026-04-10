from __future__ import annotations

import asyncio
import html
import random
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote_plus, urlparse

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


class GeneralNewsTool:
    name = "general_news"
    outlet_sources = [
        ("Fox News", "https://www.foxnews.com/world"),
        ("Washington Free Beacon", "https://freebeacon.com/"),
        ("Wall Street Journal", "https://www.wsj.com/news"),
        ("National Review", "https://www.nationalreview.com/latest/"),
        ("The Baltimore Banner", "https://www.thebaltimorebanner.com/"),
        ("Baltimore Sun", "https://www.baltimoresun.com/"),
        ("WBAL-TV", "https://www.wbaltv.com/local-news"),
        ("WMAR", "https://www.wmar2news.com/local"),
        ("CBS News", "https://www.cbsnews.com/"),
        ("AP News", "https://apnews.com/"),
        ("Reuters", "https://www.reuters.com/world/"),
    ]

    blocked_path_fragments = [
        "/author/",
        "/authors/",
        "/topic/",
        "/topics/",
        "/tag/",
        "/tags/",
        "/video",
        "/videos",
        "/watch",
        "/listen",
        "/podcast",
        "/podcasts",
        "/live",
        "/nowcast",
        "/newsletter",
        "/newsletters",
        "/e-newspaper",
        "/enewspaper",
        "/digitaledition",
        "/shortcode/",
        "/util-",
        "/account/",
        "/profile/",
        "/search",
        "/weather",
        "/sports/",
        "/opinion/",
        "/opinion",
    ]

    allowed_domain_patterns: dict[str, list[str]] = {
        "foxnews.com": ["/politics/", "/world/", "/us/", "/media/", "/health/", "/tech/"],
        "freebeacon.com": ["/issues/", "/politics/", "/media/", "/trump-administration/", "/biden-administration/"],
        "wsj.com": ["/articles/"],
        "nationalreview.com": ["/news/", "/the-morning-jolt/", "/corner/"],
        "thebaltimorebanner.com": ["/community/", "/education/", "/economy/", "/politics-power/", "/crime-justice/", "/culture/"],
        "baltimoresun.com": ["/202", "/news/", "/politics/", "/business/"],
        "wbaltv.com": ["/article/"],
        "wmar2news.com": ["/news/"],
        "cbsnews.com": ["/news/", "/world/", "/politics/"],
        "apnews.com": ["/article/"],
        "reuters.com": ["/world/", "/business/", "/markets/", "/technology/"],
    }

    preferred_topic_keywords: dict[str, list[str]] = {
        "foxnews.com": ["iran", "israel", "trump", "court", "congress", "border", "china", "russia", "war", "tariff"],
        "freebeacon.com": ["iran", "china", "trump", "biden", "court", "congress", "sanctions", "border"],
        "wsj.com": ["markets", "economy", "fed", "tariff", "china", "business", "stocks", "trump"],
        "nationalreview.com": ["court", "congress", "trump", "iran", "china", "border", "policy"],
        "thebaltimorebanner.com": ["maryland", "baltimore", "crime", "justice", "government", "school", "budget", "transportation"],
        "baltimoresun.com": ["maryland", "baltimore", "crime", "government", "school", "transportation", "budget"],
        "wbaltv.com": ["maryland", "baltimore", "shooting", "government", "school", "storm", "police"],
        "wmar2news.com": ["maryland", "baltimore", "shooting", "government", "school", "police", "court"],
        "cbsnews.com": ["trump", "iran", "israel", "china", "court", "congress", "election", "storm"],
        "apnews.com": ["trump", "iran", "israel", "china", "court", "congress", "war", "election"],
        "reuters.com": ["trump", "iran", "israel", "china", "markets", "economy", "fed", "war"],
    }

    baltimore_local_keywords = [
        "baltimore",
        "maryland",
        "anne arundel",
        "harford",
        "howard county",
        "city hall",
        "county council",
        "police",
        "shooting",
        "school",
        "budget",
        "transit",
        "transportation",
        "crime",
        "government",
        "public safety",
    ]

    baltimore_top_tier_keywords = [
        "city hall",
        "mayor",
        "city council",
        "county council",
        "budget",
        "public safety",
        "police",
        "shooting",
        "murder",
        "crime",
        "government",
        "school board",
        "transit",
        "bridge",
        "water",
        "infrastructure",
        "transportation",
    ]

    baltimore_mid_tier_keywords = [
        "utility",
        "parking",
        "xfinity",
        "blackout",
        "development",
        "housing",
        "business",
        "rates",
        "county",
        "officials",
    ]

    baltimore_low_tier_keywords = [
        "crash",
        "officer injured",
        "sentenced",
        "dui",
        "feature",
        "college",
        "university",
        "arts",
        "culture",
    ]

    baltimore_soft_keywords = [
        "education",
        "culture",
        "arts",
        "lifestyle",
        "food",
        "restaurant",
        "travel",
        "sports",
        "universities",
        "college",
        "feature",
    ]

    national_carryover_keywords = [
        "iran",
        "israel",
        "china",
        "trump",
        "ceasefire",
        "war",
        "congress",
        "supreme court",
        "white house",
        "fed",
        "tariff",
    ]

    blocked_title_keywords = [
        "bracket",
        "march madness",
        "nfl",
        "nba",
        "mlb",
        "nhl",
        "fox nation",
        "video",
        "watch",
        "stream",
        "podcast",
        "crossword",
        "horoscope",
        "games",
        "puzzles",
        "search baltimore crime data",
        "crime data",
    ]

    sports_source_keywords = [
        "espn",
        "mlb",
        "fox sports",
        "cbs sports",
        "nesn",
        "masslive",
        "boston globe",
        "the athletic",
        "sports illustrated",
        "yahoo sports",
        "nbc sports",
        "bleacher report",
    ]

    def _looks_like_headline(self, title: str) -> bool:
        cleaned = title.strip()
        if len(cleaned) < 28 or len(cleaned) > 180:
            return False
        lower = cleaned.lower()
        blocked_titles = {
            "home",
            "latest",
            "latest news",
            "news",
            "world",
            "video",
            "videos",
            "watch live",
            "read more",
            "opinion",
        }
        if lower in blocked_titles:
            return False
        if cleaned.count(" ") < 4:
            return False
        if re.search(r"\b(author|authors|topic|topics|newsletter|nowcast|watch on demand|enewspaper|fox nation)\b", lower):
            return False
        if any(keyword in lower for keyword in self.blocked_title_keywords):
            return False
        return True

    def _is_valid_article_url(self, url: str, domain: str) -> bool:
        parsed = urlparse(url)
        path = parsed.path.lower()
        if not path or path in {"/", ""}:
            return False
        if any(fragment in path for fragment in self.blocked_path_fragments):
            return False
        if any(fragment in path for fragment in ["/crime-data", "/crime-data/", "/crime-numbers", "/crime-stats"]):
            return False
        allowed = self.allowed_domain_patterns.get(domain, [])
        if allowed and not any(fragment in path for fragment in allowed):
            return False
        if path.count("/") < 2:
            return False
        return True

    def _extract_candidate_links(self, body: str, source_url: str) -> list[dict[str, str]]:
        parsed_source = urlparse(source_url)
        domain = parsed_source.netloc.replace("www.", "")
        matches = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', body, flags=re.IGNORECASE | re.DOTALL)
        results: list[dict[str, str]] = []
        seen: set[str] = set()
        for href, title_html in matches:
            title = html.unescape(re.sub(r"<.*?>", "", " ".join(title_html.split()))).strip()
            if not self._looks_like_headline(title):
                continue
            if href.startswith("/"):
                href = f"{parsed_source.scheme}://{parsed_source.netloc}{href}"
            elif href.startswith("//"):
                href = f"{parsed_source.scheme}:{href}"
            if not href.startswith("http"):
                continue
            target = urlparse(href)
            target_domain = target.netloc.replace("www.", "")
            if target_domain and target_domain != domain:
                continue
            normalized_url = href.split("#", 1)[0]
            if not self._is_valid_article_url(normalized_url, domain):
                continue
            if normalized_url in seen:
                continue
            seen.add(normalized_url)
            results.append({"title": title, "url": normalized_url, "domain": domain})
            if len(results) >= 3:
                break
        return results

    def _score_candidate(self, candidate: dict[str, str], query: str, news_mode: str = "national_major") -> int:
        domain = candidate["domain"]
        title = candidate["title"].lower()
        url = candidate["url"].lower()
        score = 0

        preferred = self.preferred_topic_keywords.get(domain, [])
        score += sum(6 for keyword in preferred if keyword in title)
        score += sum(3 for keyword in preferred if keyword in url)

        major_news_terms = [
            "breaking",
            "trump",
            "iran",
            "israel",
            "china",
            "court",
            "congress",
            "ceasefire",
            "war",
            "economy",
            "markets",
            "fed",
            "maryland",
            "baltimore",
            "police",
            "government",
        ]
        score += sum(2 for keyword in major_news_terms if keyword in title)

        if any(keyword in title for keyword in ["opinion", "editorial", "analysis", "review", "column"]):
            score -= 6
        if any(keyword in title for keyword in ["sports", "bracket", "final four", "baseball", "football", "basketball"]):
            score -= 10
        if any(keyword in url for keyword in ["/sports/", "/opinion/", "/entertainment/", "/lifestyle/"]):
            score -= 8
        if query:
            query_terms = [term for term in re.findall(r"[a-z0-9]+", query.lower()) if len(term) > 3]
            score += sum(1 for term in query_terms if term in title)

        if news_mode == "baltimore_local":
            local_domains = {"thebaltimorebanner.com", "baltimoresun.com", "wbaltv.com", "wmar2news.com"}
            if domain not in local_domains:
                return -999
            score += sum(8 for keyword in self.baltimore_local_keywords if keyword in title)
            score += sum(4 for keyword in self.baltimore_local_keywords if keyword in url)
            score += sum(10 for keyword in self.baltimore_top_tier_keywords if keyword in title)
            score += sum(5 for keyword in self.baltimore_top_tier_keywords if keyword in url)
            score += sum(4 for keyword in self.baltimore_mid_tier_keywords if keyword in title)
            score += sum(2 for keyword in self.baltimore_mid_tier_keywords if keyword in url)
            score -= sum(5 for keyword in self.baltimore_low_tier_keywords if keyword in title)
            score -= sum(2 for keyword in self.baltimore_low_tier_keywords if keyword in url)
            score -= sum(7 for keyword in self.national_carryover_keywords if keyword in title)
            score -= sum(3 for keyword in self.national_carryover_keywords if keyword in url)
            score -= sum(4 for keyword in self.baltimore_soft_keywords if keyword in title)
            if domain in {"thebaltimorebanner.com", "baltimoresun.com"} and any(keyword in title for keyword in self.baltimore_soft_keywords):
                score -= 5
        return score

    def _topic_query_terms(self, query: str) -> list[str]:
        stopwords = {
            "what",
            "whats",
            "what's",
            "latest",
            "news",
            "headline",
            "headlines",
            "about",
            "with",
            "tell",
            "today",
            "current",
            "recent",
            "update",
            "updates",
            "the",
            "this",
            "that",
            "team",
        }
        return [
            term
            for term in re.findall(r"[a-z0-9]+", query.lower())
            if len(term) >= 3 and term not in stopwords
        ]

    def _looks_like_sports_topic(self, query: str) -> bool:
        lowered = query.lower()
        sports_terms = [
            "baseball",
            "basketball",
            "football",
            "hockey",
            "soccer",
            "mlb",
            "nba",
            "nfl",
            "nhl",
            "ncaa",
            "red sox",
            "yankees",
            "mets",
            "dodgers",
            "celtics",
            "lakers",
            "patriots",
            "bruins",
        ]
        return any(term in lowered for term in sports_terms)

    def _score_topic_result(self, candidate: dict[str, str], query: str) -> int:
        title = candidate["title"].lower()
        source = candidate.get("source", "").lower()
        url = candidate["url"].lower()
        terms = self._topic_query_terms(query)
        score = 0

        score += sum(8 for term in terms if term in title)
        score += sum(4 for term in terms if term in source)
        score += sum(2 for term in terms if term in url)

        if self._looks_like_sports_topic(query):
            score += sum(6 for keyword in self.sports_source_keywords if keyword in source)
            score += sum(4 for keyword in self.sports_source_keywords if keyword in url)
            if any(keyword in title for keyword in ["injury", "lineup", "trade", "rotation", "roster", "series", "opening day", "pitching"]):
                score += 3

        if any(keyword in title for keyword in ["opinion", "analysis", "podcast", "watch", "video", "betting"]):
            score -= 5
        if any(keyword in url for keyword in ["/video", "/watch", "/betting", "/odds"]):
            score -= 5
        return score

    async def _search_topic_news(self, client: httpx.AsyncClient, query: str) -> list[dict[str, str]]:
        rss_query = quote_plus(f"{query} when:2d")
        url = f"https://news.google.com/rss/search?q={rss_query}&hl=en-US&gl=US&ceid=US:en"
        response = await client.get(url)
        response.raise_for_status()
        root = ET.fromstring(response.text)

        results: list[dict[str, str]] = []
        seen: set[str] = set()
        for item in root.findall(".//item"):
            title = html.unescape((item.findtext("title") or "").strip())
            link = (item.findtext("link") or "").strip()
            source = html.unescape((item.findtext("source") or "").strip())
            if not title or not link:
                continue
            cleaned_title = re.sub(r"\s*-\s*" + re.escape(source) + r"$", "", title, flags=re.IGNORECASE) if source else title
            normalized_link = link.split("#", 1)[0]
            if normalized_link in seen:
                continue
            seen.add(normalized_link)
            candidate = {
                "title": cleaned_title.strip(),
                "url": normalized_link,
                "domain": urlparse(normalized_link).netloc.replace("www.", "") or "news.google.com",
                "source": source or "Google News",
            }
            if self._score_topic_result(candidate, query) <= 0:
                continue
            results.append(candidate)
            if len(results) >= 10:
                break
        return results

    async def _fetch_outlet_candidates(self, client: httpx.AsyncClient, label: str, url: str) -> list[dict[str, str]]:
        try:
            response = await client.get(url)
            response.raise_for_status()
            candidates = self._extract_candidate_links(response.text, url)
            if candidates:
                return candidates
        except Exception:
            return []
        return []

    @retry(stop=stop_after_attempt(2), wait=wait_exponential_jitter(initial=1, max=6))
    async def run(self, query: str, mode: str, news_mode: str = "national_major") -> ToolResult:
        if news_mode == "topic_search":
            async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as client:
                ranked = await self._search_topic_news(client, query)
            payload = {
                "items": [f"{item['title']} [{item.get('source') or item['domain']}]" for item in ranked[:6]],
                "results": ranked[:6],
                "source_type": "topic_news_search",
                "news_mode": news_mode,
                "mode": mode,
            }
            return ToolResult(tool=self.name, ok=True, payload=payload)

        if news_mode == "baltimore_local":
            selected_sources = [item for item in self.outlet_sources if item[0] in {"The Baltimore Banner", "Baltimore Sun", "WBAL-TV", "WMAR"}]
        elif news_mode == "mixed":
            selected_sources = self.outlet_sources
        else:
            selected_sources = [item for item in self.outlet_sources if item[0] not in {"The Baltimore Banner", "Baltimore Sun", "WBAL-TV", "WMAR"}]
        async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as client:
            candidate_lists = await asyncio.gather(
                *(self._fetch_outlet_candidates(client, label, url) for label, url in selected_sources)
            )
        ranked: list[dict[str, str]] = []
        for candidates in candidate_lists:
            if candidates:
                best = max(candidates, key=lambda candidate: self._score_candidate(candidate, query, news_mode))
                if self._score_candidate(best, query, news_mode) > 0:
                    ranked.append(best)
        items = [f"{item['title']} [{item['domain']}]" for item in ranked[:6]]
        payload = {
            "items": items,
            "results": ranked[:6],
            "source_type": "direct_outlet_scrape",
            "news_mode": news_mode,
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
GENERAL_NEWS_TOOL = GeneralNewsTool()
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
    GENERAL_NEWS_TOOL,
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
