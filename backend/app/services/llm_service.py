from __future__ import annotations

from langchain_openai import ChatOpenAI

from app.core.config import settings


def build_llm(temperature: float = 0.2) -> ChatOpenAI:
    return ChatOpenAI(
        model=settings.openai_model,
        temperature=temperature,
        api_key=settings.openai_api_key or None,
    )
