"""Per-model prompt/completion pricing, USD per 1K tokens.

Keep this table conservative — list only models we actually use. Unknown models
default to a mid-range rate so totals are ballpark, never zero. Update from the
provider pages periodically.
"""

from __future__ import annotations

# USD per 1,000 tokens. (prompt, completion).
_PRICES_PER_1K: dict[str, tuple[float, float]] = {
    # OpenAI
    "gpt-4.1-mini": (0.0004, 0.0016),
    "gpt-4.1": (0.002, 0.008),
    "gpt-4.1-nano": (0.0001, 0.0004),
    "gpt-4o-mini": (0.00015, 0.0006),
    "gpt-4o": (0.0025, 0.01),
    # Anthropic
    "claude-3-7-sonnet-latest": (0.003, 0.015),
    "claude-3-5-sonnet-latest": (0.003, 0.015),
    "claude-3-5-haiku-latest": (0.0008, 0.004),
    # Google
    "gemini-2.5-pro": (0.00125, 0.005),
    "gemini-1.5-flash": (0.000075, 0.0003),
    # OpenRouter curated
    "meta-llama/llama-3.3-70b-instruct": (0.00059, 0.00079),
    "qwen/qwen-2.5-coder-32b-instruct": (0.0003, 0.0008),
    # Groq (often the cheapest path)
    "llama-3.3-70b-versatile": (0.00059, 0.00079),
    # xAI
    "grok-3-mini": (0.0003, 0.0005),
}

_DEFAULT = (0.001, 0.003)  # mid-range fallback


def price_for(model: str | None) -> tuple[float, float]:
    if not model:
        return _DEFAULT
    key = model.strip()
    if key in _PRICES_PER_1K:
        return _PRICES_PER_1K[key]
    # Try suffix match (e.g. openai/gpt-4.1-mini vs gpt-4.1-mini).
    for name, price in _PRICES_PER_1K.items():
        if key.endswith(name):
            return price
    return _DEFAULT


def estimate_cost_usd(model: str | None, prompt_tokens: int, completion_tokens: int) -> float:
    p, c = price_for(model)
    return round((prompt_tokens / 1000.0) * p + (completion_tokens / 1000.0) * c, 6)
