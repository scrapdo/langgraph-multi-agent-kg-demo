from __future__ import annotations

import json
from pathlib import Path
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
        },
        "researcher": {
            "id": "researcher",
            "name": "Researcher",
            "avatar": "🔎",
            "provider": recommended.get("researcher", {}).get("provider", "openai"),
            "model": recommended.get("researcher", {}).get("model", settings.openai_model),
            "function": "Evidence retrieval, tools, and context collection",
        },
        "critic": {
            "id": "critic",
            "name": "Critic",
            "avatar": "🛡️",
            "provider": recommended.get("critic", {}).get("provider", "openai"),
            "model": recommended.get("critic", {}).get("model", settings.openai_model),
            "function": "Quality gate, risk checks, and revision decisions",
        },
        "writer": {
            "id": "writer",
            "name": "Writer",
            "avatar": "✍️",
            "provider": recommended.get("writer", {}).get("provider", "openai"),
            "model": recommended.get("writer", {}).get("model", settings.openai_model),
            "function": "Final synthesis with concise conversational output",
        },
        "coding": {
            "id": "coding",
            "name": "Coder",
            "avatar": "💻",
            "provider": recommended.get("coding", {}).get("provider", "openai"),
            "model": recommended.get("coding", {}).get("model", settings.openai_model),
            "function": "Code generation, refactoring, and debugging tasks",
        },
    }


class AgentProfileService:
    def __init__(self, path: str):
        self.path = Path(path)

    def _ensure_loaded(self) -> dict[str, dict[str, str]]:
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

        merged = defaults | {k: v for k, v in data.items() if isinstance(v, dict)}
        self.path.write_text(json.dumps(merged, indent=2))
        return merged

    def get_profiles(self) -> dict[str, dict[str, str]]:
        return self._ensure_loaded()

    def get_profile(self, agent_id: str) -> dict[str, str]:
        profiles = self._ensure_loaded()
        return profiles.get(agent_id, profiles.get("coordinator", {}))

    def update_profiles(self, updates: dict[str, Any]) -> dict[str, dict[str, str]]:
        profiles = self._ensure_loaded()
        for agent_id, patch in updates.items():
            if agent_id not in profiles or not isinstance(patch, dict):
                continue
            for field in ["name", "avatar", "provider", "model", "function"]:
                value = patch.get(field)
                if isinstance(value, str) and value.strip():
                    profiles[agent_id][field] = value.strip()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(profiles, indent=2))
        return profiles


agent_profile_service = AgentProfileService(settings.agent_profile_store_path)
