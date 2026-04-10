from __future__ import annotations

import json
from pathlib import Path
from copy import deepcopy
from typing import Any

from app.core.config import settings
from app.services.model_router_service import available_catalog


def _normalize_speech_voice(value: Any) -> str:
    voice = str(value or "").strip().lower()
    if voice == "aria":
        return "shimmer"
    return voice or "alloy"


def _default_profiles() -> dict[str, dict[str, str]]:
    recommended = available_catalog().get("recommended_by_function", {})
    return {
        "coordinator": {
            "id": "coordinator",
            "name": "Brain",
            "avatar": "🧭",
            "provider": recommended.get("coordinator", {}).get("provider", "openai"),
            "model": recommended.get("coordinator", {}).get("model", settings.openai_model),
            "function": "Planning, routing, and run budgeting",
            "speech_voice": "sage",
            "speech_style": "precise",
            "speech_persona": "Speak like a calm mission-control coordinator. Short sentences. Clear transitions. No hype.",
            "premium_voice_id": "jRAAK67SEFE9m7ci5DhD",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files", "gmail_calendar"],
        },
        "researcher": {
            "id": "researcher",
            "name": "Leo",
            "avatar": "🔎",
            "provider": recommended.get("researcher", {}).get("provider", "openai"),
            "model": recommended.get("researcher", {}).get("model", settings.openai_model),
            "function": "Evidence retrieval, tools, and context collection",
            "speech_voice": "shimmer",
            "speech_style": "natural",
            "speech_persona": "Speak like an analytical research lead. Conversational, grounded, and specific.",
            "premium_voice_id": "bbGtsRRKUfYO634UxSjz",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files", "gmail_calendar"],
        },
        "critic": {
            "id": "critic",
            "name": "Frank",
            "avatar": "🛡️",
            "provider": recommended.get("critic", {}).get("provider", "openai"),
            "model": recommended.get("critic", {}).get("model", settings.openai_model),
            "function": "Quality gate, risk checks, and revision decisions",
            "speech_voice": "ash",
            "speech_style": "precise",
            "speech_persona": "Speak like a skeptical reviewer. Crisp, factual, and careful about uncertainty.",
            "premium_voice_id": "q3pCVYOxlOb5G3l2O13o",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": [],
        },
        "writer": {
            "id": "writer",
            "name": "George",
            "avatar": "✍️",
            "provider": recommended.get("writer", {}).get("provider", "openai"),
            "model": recommended.get("writer", {}).get("model", settings.openai_model),
            "function": "Final synthesis with concise conversational output",
            "speech_voice": "verse",
            "speech_style": "warm",
            "speech_persona": "Speak like a polished human operator. Natural cadence, concise phrasing, and strong clarity.",
            "premium_voice_id": "fnYMz3F5gMEDGMWcH1ex",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["microsoft_word", "finder_files"],
        },
        "coding": {
            "id": "coding",
            "name": "Chad",
            "avatar": "💻",
            "provider": recommended.get("coding", {}).get("provider", "openai"),
            "model": recommended.get("coding", {}).get("model", settings.openai_model),
            "function": "Code generation, refactoring, and debugging tasks",
            "speech_voice": "alloy",
            "speech_style": "precise",
            "speech_persona": "Speak like a senior engineer. Direct, technical, and calm under pressure.",
            "premium_voice_id": "TABZn6CDfjMNGrsnGzzD",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files"],
        },
        "shopper": {
            "id": "shopper",
            "name": "Michelle",
            "avatar": "🛍️",
            "provider": recommended.get("shopper", {}).get("provider", "openai"),
            "model": recommended.get("shopper", {}).get("model", settings.openai_model),
            "function": "Web shopping, hard-to-find item sourcing, and deal scouting",
            "speech_voice": "shimmer",
            "speech_style": "natural",
            "speech_persona": "Speak like a sharp luxury concierge and deal scout. Be practical, fast, and specific about options.",
            "premium_voice_id": "x8syuETaTA9JYwAbE2JM",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["finder_files", "gmail_calendar"],
        },
        "social": {
            "id": "social",
            "name": "Antonio",
            "avatar": "📣",
            "provider": recommended.get("social", {}).get("provider", "openai"),
            "model": recommended.get("social", {}).get("model", settings.openai_model),
            "function": "Social media planning, content drafts, scheduling, and engagement strategy",
            "speech_voice": "verse",
            "speech_style": "energetic",
            "speech_persona": "Speak like a seasoned social media manager. Clear, current, concise, and tuned for audience attention.",
            "premium_voice_id": "bzhDZB4cGhEmQvjxPqqj",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["ai_influencer_studio", "photoshop_media", "finder_files"],
        },
        "secretary": {
            "id": "secretary",
            "name": "Emma",
            "avatar": "📇",
            "provider": recommended.get("secretary", {}).get("provider", "openai"),
            "model": recommended.get("secretary", {}).get("model", settings.openai_model),
            "function": "Executive secretary for calls, texts, emails, booking, and follow-up tasks",
            "speech_voice": "shimmer",
            "speech_style": "warm",
            "speech_persona": "Speak like a polished executive secretary. Warm, efficient, confident, and concise.",
            "premium_voice_id": "exCoNc1yqICBgUPkEEkP",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["gmail_calendar", "telephony_sms", "email_outreach", "finder_files"],
        },
        "wellness": {
            "id": "wellness",
            "name": "Grace",
            "avatar": "🌿",
            "provider": recommended.get("wellness", {}).get("provider", "openai"),
            "model": recommended.get("wellness", {}).get("model", settings.openai_model),
            "function": "Wellness coach for goals, habits, motivation, accountability, recovery, and proactive check-ins",
            "speech_voice": "sage",
            "speech_style": "warm",
            "speech_persona": "Speak like an excellent wellness coach. Calm, encouraging, practical, and specific. Avoid fluff and guilt.",
            "premium_voice_id": "XHqlxleHbYnK8xmft8Vq",
            "ready": True,
            "app_execution_mode": "approval",
            "specialist_apps": ["gmail_calendar", "finder_files", "email_outreach", "telegram_messaging"],
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
                elif field == "ready":
                    base[field] = bool(value)
                elif field == "speech_voice":
                    base[field] = _normalize_speech_voice(value)
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
                "speech_style",
                "speech_persona",
                "premium_voice_id",
                "app_execution_mode",
            ]:
                if field in patch and isinstance(patch.get(field), str):
                    profiles[agent_id][field] = str(patch.get(field)).strip()
            if "speech_voice" in patch and patch.get("speech_voice") is not None:
                profiles[agent_id]["speech_voice"] = _normalize_speech_voice(patch.get("speech_voice"))
            if "ready" in patch and patch.get("ready") is not None:
                profiles[agent_id]["ready"] = bool(patch.get("ready"))
            if "specialist_apps" in patch and isinstance(patch.get("specialist_apps"), list):
                profiles[agent_id]["specialist_apps"] = [
                    str(item).strip() for item in patch.get("specialist_apps", []) if str(item).strip()
                ]
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(profiles, indent=2))
        return profiles

    def update_profile(self, agent_id: str, patch: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return self.update_profiles({agent_id: patch})


agent_profile_service = AgentProfileService(settings.agent_profile_store_path)
