from __future__ import annotations

import json
from pathlib import Path
from copy import deepcopy
from typing import Any

from app.core.config import settings
from app.services.model_router_service import available_catalog


def _default_profiles() -> dict[str, dict[str, str]]:
    recommended = available_catalog().get("recommended_by_function", {})
    return {
        "coordinator": {
            "id": "coordinator",
            "name": "Coordinator",
            "avatar": "🧭",
            "provider": recommended.get("coordinator", {}).get("provider", "openai"),
            "model": recommended.get("coordinator", {}).get("model", settings.openai_model),
            "function": "Planning, routing, and run budgeting",
            "speech_voice": "sage",
            "speech_style": "precise",
            "speech_persona": "Speak like a calm mission-control coordinator. Short sentences. Clear transitions. No hype.",
            "premium_voice_id": "",
            "heygen_avatar_id": settings.heygen_avatar_id,
            "heygen_voice_id": settings.heygen_voice_id,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files", "gmail_calendar"],
        },
        "researcher": {
            "id": "researcher",
            "name": "Researcher",
            "avatar": "🔎",
            "provider": recommended.get("researcher", {}).get("provider", "openai"),
            "model": recommended.get("researcher", {}).get("model", settings.openai_model),
            "function": "Evidence retrieval, tools, and context collection",
            "speech_voice": "aria",
            "speech_style": "natural",
            "speech_persona": "Speak like an analytical research lead. Conversational, grounded, and specific.",
            "premium_voice_id": "",
            "heygen_avatar_id": settings.heygen_avatar_id,
            "heygen_voice_id": settings.heygen_voice_id,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files", "gmail_calendar"],
        },
        "critic": {
            "id": "critic",
            "name": "Critic",
            "avatar": "🛡️",
            "provider": recommended.get("critic", {}).get("provider", "openai"),
            "model": recommended.get("critic", {}).get("model", settings.openai_model),
            "function": "Quality gate, risk checks, and revision decisions",
            "speech_voice": "ash",
            "speech_style": "precise",
            "speech_persona": "Speak like a skeptical reviewer. Crisp, factual, and careful about uncertainty.",
            "premium_voice_id": "",
            "heygen_avatar_id": settings.heygen_avatar_id,
            "heygen_voice_id": settings.heygen_voice_id,
            "app_execution_mode": "approval",
            "specialist_apps": [],
        },
        "writer": {
            "id": "writer",
            "name": "Writer",
            "avatar": "✍️",
            "provider": recommended.get("writer", {}).get("provider", "openai"),
            "model": recommended.get("writer", {}).get("model", settings.openai_model),
            "function": "Final synthesis with concise conversational output",
            "speech_voice": "verse",
            "speech_style": "warm",
            "speech_persona": "Speak like a polished human operator. Natural cadence, concise phrasing, and strong clarity.",
            "premium_voice_id": "",
            "heygen_avatar_id": settings.heygen_avatar_id,
            "heygen_voice_id": settings.heygen_voice_id,
            "app_execution_mode": "approval",
            "specialist_apps": ["microsoft_word", "finder_files", "heygen_studio"],
        },
        "coding": {
            "id": "coding",
            "name": "Coder",
            "avatar": "💻",
            "provider": recommended.get("coding", {}).get("provider", "openai"),
            "model": recommended.get("coding", {}).get("model", settings.openai_model),
            "function": "Code generation, refactoring, and debugging tasks",
            "speech_voice": "alloy",
            "speech_style": "precise",
            "speech_persona": "Speak like a senior engineer. Direct, technical, and calm under pressure.",
            "premium_voice_id": "",
            "heygen_avatar_id": settings.heygen_avatar_id,
            "heygen_voice_id": settings.heygen_voice_id,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files"],
        },
        "shopper": {
            "id": "shopper",
            "name": "Private Shopper",
            "avatar": "🛍️",
            "provider": recommended.get("shopper", {}).get("provider", "openai"),
            "model": recommended.get("shopper", {}).get("model", settings.openai_model),
            "function": "Web shopping, hard-to-find item sourcing, and deal scouting",
            "speech_voice": "aria",
            "speech_style": "natural",
            "speech_persona": "Speak like a sharp luxury concierge and deal scout. Be practical, fast, and specific about options.",
            "premium_voice_id": "",
            "heygen_avatar_id": settings.heygen_avatar_id,
            "heygen_voice_id": settings.heygen_voice_id,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files", "gmail_calendar"],
        },
        "social": {
            "id": "social",
            "name": "Social Manager",
            "avatar": "📣",
            "provider": recommended.get("social", {}).get("provider", "openai"),
            "model": recommended.get("social", {}).get("model", settings.openai_model),
            "function": "Social media planning, content drafts, scheduling, and engagement strategy",
            "speech_voice": "verse",
            "speech_style": "energetic",
            "speech_persona": "Speak like a seasoned social media manager. Clear, current, concise, and tuned for audience attention.",
            "premium_voice_id": "",
            "heygen_avatar_id": settings.heygen_avatar_id,
            "heygen_voice_id": settings.heygen_voice_id,
            "app_execution_mode": "approval",
            "specialist_apps": ["heygen_studio", "ai_influencer_studio", "photoshop_media", "finder_files"],
        },
    }


class AgentProfileService:
    def __init__(self, path: str):
        self.path = Path(path)

    def _ensure_loaded(self) -> dict[str, dict[str, Any]]:
        defaults = _default_profiles()
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(defaults, indent=2))
            return defaults

        try:
            data = json.loads(self.path.read_text())
            if not isinstance(data, dict):
                raise ValueError("invalid profile format")
        except Exception:
            self.path.write_text(json.dumps(defaults, indent=2))
            return defaults

        merged: dict[str, dict[str, Any]] = deepcopy(defaults)
        for agent_id, raw_profile in data.items():
            if not isinstance(raw_profile, dict):
                continue
            base = deepcopy(defaults.get(agent_id, {"id": agent_id}))
            for field, value in raw_profile.items():
                if field == "specialist_apps" and isinstance(value, list):
                    base[field] = [str(item).strip() for item in value if str(item).strip()]
                else:
                    base[field] = value
            if "specialist_apps" not in base:
                base["specialist_apps"] = []
            if "app_execution_mode" not in base:
                base["app_execution_mode"] = "approval"
            merged[agent_id] = base
        if merged != data:
            self.path.write_text(json.dumps(merged, indent=2))
        return merged

    def get_profiles(self) -> dict[str, dict[str, Any]]:
        return self._ensure_loaded()

    def get_profile(self, agent_id: str) -> dict[str, Any]:
        profiles = self._ensure_loaded()
        return profiles.get(agent_id, profiles.get("coordinator", {}))

    def update_profiles(self, updates: dict[str, Any]) -> dict[str, dict[str, Any]]:
        profiles = self._ensure_loaded()
        for agent_id, patch in updates.items():
            if agent_id not in profiles or not isinstance(patch, dict):
                continue
            for field in [
                "name",
                "avatar",
                "provider",
                "model",
                "function",
                "speech_voice",
                "speech_style",
                "speech_persona",
                "premium_voice_id",
                "heygen_avatar_id",
                "heygen_voice_id",
                "app_execution_mode",
            ]:
                if field in patch and isinstance(patch.get(field), str):
                    profiles[agent_id][field] = str(patch.get(field)).strip()
            if "specialist_apps" in patch and isinstance(patch.get("specialist_apps"), list):
                profiles[agent_id]["specialist_apps"] = [
                    str(item).strip() for item in patch.get("specialist_apps", []) if str(item).strip()
                ]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(profiles, indent=2))
        return profiles


agent_profile_service = AgentProfileService(settings.agent_profile_store_path)
