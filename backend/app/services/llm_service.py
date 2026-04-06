from __future__ import annotations

from app.services.agent_profile_service import agent_profile_service
from app.services.model_router_service import build_llm as build_routed_llm


def build_llm(temperature: float = 0.2):
    return build_routed_llm(provider=None, model=None, temperature=temperature)


def build_llm_for_agent(agent_id: str, temperature: float = 0.2):
    profile = agent_profile_service.get_profile(agent_id)
    return build_routed_llm(
        provider=profile.get("provider"),
        model=profile.get("model"),
        temperature=temperature,
    )
