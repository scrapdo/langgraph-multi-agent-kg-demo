from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from langchain_openai import ChatOpenAI

from app.core.config import settings

try:
    from langchain_anthropic import ChatAnthropic
except Exception:  # pragma: no cover
    ChatAnthropic = None  # type: ignore

try:
    from langchain_google_genai import ChatGoogleGenerativeAI
except Exception:  # pragma: no cover
    ChatGoogleGenerativeAI = None  # type: ignore


@dataclass
class ModelConfig:
    provider: str
    model: str


OPENAI_COMPATIBLE_PROVIDERS = {
    "openai": lambda: (settings.openai_api_key, settings.openai_base_url),
    "perplexity": lambda: (settings.perplexity_api_key, settings.perplexity_base_url),
    "xai": lambda: (settings.xai_api_key, settings.xai_base_url),
    "groq": lambda: (settings.groq_api_key, settings.groq_base_url),
}


def _provider_ready(provider: str) -> bool:
    if provider in OPENAI_COMPATIBLE_PROVIDERS:
        key, _ = OPENAI_COMPATIBLE_PROVIDERS[provider]()
        return bool(key)
    if provider == "anthropic":
        return bool(settings.anthropic_api_key and ChatAnthropic)
    if provider == "google":
        return bool(settings.google_api_key and ChatGoogleGenerativeAI)
    return False


def available_catalog() -> dict[str, Any]:
    return {
        "providers": [
            {
                "id": "openai",
                "name": "OpenAI",
                "enabled": _provider_ready("openai"),
                "models": ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-5.4", "gpt-5-codex"],
            },
            {
                "id": "anthropic",
                "name": "Anthropic",
                "enabled": _provider_ready("anthropic"),
                "models": ["claude-3-7-sonnet-latest", "claude-3-5-sonnet-latest"],
            },
            {
                "id": "google",
                "name": "Google Gemini",
                "enabled": _provider_ready("google"),
                "models": ["gemini-2.5-pro", "gemini-2.5-flash"],
            },
            {
                "id": "perplexity",
                "name": "Perplexity",
                "enabled": _provider_ready("perplexity"),
                "models": ["sonar-pro", "sonar"],
            },
            {
                "id": "xai",
                "name": "xAI Grok",
                "enabled": _provider_ready("xai"),
                "models": ["grok-3-mini", "grok-3"],
            },
            {
                "id": "groq",
                "name": "Groq",
                "enabled": _provider_ready("groq"),
                "models": ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
            },
        ],
        "recommended_by_function": {
            "coordinator": {"provider": "openai", "model": settings.openai_model},
            "researcher": {"provider": "perplexity", "model": settings.perplexity_model},
            "critic": {"provider": "anthropic", "model": settings.anthropic_model},
            "writer": {"provider": "google", "model": settings.google_model},
            "coding": {"provider": "anthropic", "model": settings.anthropic_model},
        },
    }


def _fallback_model() -> ModelConfig:
    return ModelConfig(provider="openai", model=settings.openai_model)


def resolve_model(requested_provider: str | None, requested_model: str | None) -> ModelConfig:
    provider = (requested_provider or "").strip().lower()
    model = (requested_model or "").strip()

    if provider and _provider_ready(provider):
        return ModelConfig(provider=provider, model=model or _fallback_model().model)

    catalog = available_catalog()
    for provider_info in catalog["providers"]:
        if provider_info["enabled"]:
            default_model = provider_info["models"][0] if provider_info["models"] else _fallback_model().model
            return ModelConfig(provider=provider_info["id"], model=model or default_model)

    return _fallback_model()


def build_llm(provider: str | None = None, model: str | None = None, temperature: float = 0.2):
    resolved = resolve_model(provider, model)

    if resolved.provider in OPENAI_COMPATIBLE_PROVIDERS:
        api_key, base_url = OPENAI_COMPATIBLE_PROVIDERS[resolved.provider]()
        return ChatOpenAI(
            model=resolved.model,
            temperature=temperature,
            api_key=api_key or None,
            base_url=base_url,
        )

    if resolved.provider == "anthropic" and ChatAnthropic:
        return ChatAnthropic(model=resolved.model, temperature=temperature, api_key=settings.anthropic_api_key)

    if resolved.provider == "google" and ChatGoogleGenerativeAI:
        return ChatGoogleGenerativeAI(model=resolved.model, temperature=temperature, google_api_key=settings.google_api_key)

    # last resort
    fallback = _fallback_model()
    return ChatOpenAI(
        model=fallback.model,
        temperature=temperature,
        api_key=settings.openai_api_key or None,
        base_url=settings.openai_base_url,
    )
