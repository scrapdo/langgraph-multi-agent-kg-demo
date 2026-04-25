from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import settings


_DEFAULT_PROFILE: dict[str, Any] = {
    "name": "",
    "role": "",
    "timezone": "America/New_York",
    "location": "",
    "phone": "",       # operator's personal callback number (E.164, e.g. +14155551234)
    "email": "",       # operator's primary email
    "goals": [],
    "preferences": "",
    "current_focus": "",
    "notes": "",
    "updated_at": "",
}


class UserProfileService:
    """Persist a single-operator profile used to contextualize every run.

    The profile is serialized as JSON into ``data/user_profile.json``. The file
    is read on every request so an edit via the UI takes effect immediately.
    """

    def __init__(self) -> None:
        base = getattr(settings, "user_profile_store_path", "") or "data/user_profile.json"
        self._path = Path(base)
        if not self._path.is_absolute():
            self._path = Path.cwd() / self._path
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> dict[str, Any]:
        if not self._path.is_file():
            return dict(_DEFAULT_PROFILE)
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return dict(_DEFAULT_PROFILE)
        profile = {**_DEFAULT_PROFILE, **(raw if isinstance(raw, dict) else {})}
        goals = profile.get("goals")
        if isinstance(goals, str):
            profile["goals"] = [line.strip() for line in goals.splitlines() if line.strip()]
        if not isinstance(profile["goals"], list):
            profile["goals"] = []
        return profile

    def _write(self, profile: dict[str, Any]) -> None:
        self._path.write_text(json.dumps(profile, indent=2, ensure_ascii=False), encoding="utf-8")

    def get(self) -> dict[str, Any]:
        with self._lock:
            return self._read()

    def save(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._read()
            for key in _DEFAULT_PROFILE:
                if key in patch:
                    current[key] = patch[key]
            if isinstance(current.get("goals"), str):
                current["goals"] = [
                    line.strip() for line in current["goals"].splitlines() if line.strip()
                ]
            current["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
            self._write(current)
            return current

    def reset(self) -> dict[str, Any]:
        with self._lock:
            cleared = dict(_DEFAULT_PROFILE)
            cleared["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
            self._write(cleared)
            return cleared

    def render_context(self) -> str:
        """Render the profile as plaintext context to inject into every run."""
        profile = self.get()
        lines: list[str] = []
        if profile.get("name"):
            lines.append(f"The operator's name is {profile['name']}.")
        if profile.get("role"):
            lines.append(f"Their role is {profile['role']}.")
        if profile.get("location"):
            lines.append(f"They are located in {profile['location']}.")
        if profile.get("timezone"):
            lines.append(f"Timezone: {profile['timezone']}.")
        if profile.get("phone"):
            lines.append(
                f"Operator's callback phone number: {profile['phone']} (E.164). "
                "When they say 'call me', 'have Emma call me', 'dial my number', "
                "use THIS number as the `to` argument to secretary_place_call. "
                "No need to ask — it's already on file."
            )
        if profile.get("email"):
            lines.append(f"Operator's primary email: {profile['email']}.")
        if profile.get("current_focus"):
            lines.append(f"Current focus: {profile['current_focus']}.")
        goals = profile.get("goals") or []
        if goals:
            bullets = "; ".join(str(g) for g in goals if str(g).strip())
            if bullets:
                lines.append(f"Ongoing goals: {bullets}.")
        if profile.get("preferences"):
            lines.append(f"Preferences: {profile['preferences']}.")
        if profile.get("notes"):
            lines.append(f"Additional context: {profile['notes']}.")
        return "\n".join(lines).strip()


user_profile_service = UserProfileService()
