"""Named, parameterizable prompt templates you can run on demand.

A template is a short prompt with ``{{placeholder}}`` parameters plus a
default task_type / conservative-routing hint. Running a template substitutes
the parameters and fires a live run (optionally in the background).

Persisted at ``data/workflow_templates.json``. The service is stateless apart
from the JSON file — no lifecycle thread needed.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.core.config import settings

_TASK_TYPES = {
    "market_research",
    "capabilities",
    "conversation",
    "shopping",
    "social_media",
    "secretary",
    "news_brief",
    "wellness_coaching",
}

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


def _default_seed() -> list[dict[str, Any]]:
    """Sensible starter templates so the UI has something on first open."""
    now = datetime.now(tz=timezone.utc).isoformat()
    def _tpl(
        name: str,
        description: str,
        prompt: str,
        *,
        parameters: list[dict[str, Any]] | None = None,
        task_type: str | None = None,
        conservative: bool = False,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        return {
            "id": uuid4().hex,
            "name": name,
            "description": description,
            "prompt": prompt,
            "parameters": parameters or [],
            "task_type": task_type,
            "conservative": conservative,
            "tags": tags or [],
            "created_at": now,
            "updated_at": now,
            "last_run_id": None,
            "last_run_at": None,
            "run_count": 0,
            "is_seed": True,
        }

    return [
        _tpl(
            "Weekly review",
            "Reflect on the week — what shipped, what slipped, what's next.",
            (
                "It's the end of the week. Based on everything we've worked on across "
                "recent runs and what you know about me, give me:\n\n"
                "1. A one-paragraph summary of what I actually shipped this week.\n"
                "2. Three things that slipped, and why.\n"
                "3. The one thing to start with on Monday morning."
            ),
            tags=["routine", "reflection"],
        ),
        _tpl(
            "Meeting prep",
            "Prep notes for a specific meeting or call.",
            (
                "Help me prep for a meeting with {{who}} about {{topic}}.\n\n"
                "Output:\n"
                "- The three things I most need to remember about them / this topic.\n"
                "- A short briefing I can skim on the way to the meeting.\n"
                "- Two thoughtful questions I can ask.\n"
                "- Anything I owe them from previous conversations."
            ),
            parameters=[
                {"name": "who", "label": "Who is it with?", "placeholder": "e.g. Sarah at Acme"},
                {"name": "topic", "label": "What's it about?", "placeholder": "e.g. renewal negotiation"},
            ],
            tags=["work"],
        ),
        _tpl(
            "Research a person",
            "Investigate a person and return what I should know.",
            (
                "Research {{person}} ({{context}}) and report:\n\n"
                "- Background and current role.\n"
                "- How they're connected to things I care about.\n"
                "- Warm icebreakers based on their public footprint.\n"
                "- Any red flags worth noting."
            ),
            parameters=[
                {"name": "person", "label": "Person", "placeholder": "e.g. Cynthia Lopez"},
                {"name": "context", "label": "Context", "placeholder": "e.g. CTO at Series B startup"},
            ],
            task_type="market_research",
            tags=["research"],
        ),
        _tpl(
            "Draft an email",
            "Generate a polished email draft.",
            (
                "Draft an email to {{recipient}} about {{subject}}.\n\n"
                "Tone: {{tone}}.\n\n"
                "Constraints:\n"
                "- Subject line on the first line.\n"
                "- Body no longer than 120 words.\n"
                "- No 'I hope this finds you well'-style preamble.\n"
                "- End with one clear call to action."
            ),
            parameters=[
                {"name": "recipient", "label": "Recipient", "placeholder": "e.g. investors"},
                {"name": "subject", "label": "Topic", "placeholder": "e.g. monthly update"},
                {"name": "tone", "label": "Tone", "placeholder": "e.g. confident but humble", "default": "direct and warm"},
            ],
            tags=["writing"],
        ),
        _tpl(
            "Morning focus plan",
            "Turn the calendar + inbox into a single focus plan for the next 2 hours.",
            (
                "It's the start of my work day. Based on my calendar, my inbox, and "
                "recent conversations, give me:\n\n"
                "1. One priority for the next two hours.\n"
                "2. Three specific sub-tasks under that priority.\n"
                "3. The one distraction I should protect against."
            ),
            tags=["routine"],
        ),
    ]


class WorkflowTemplateService:
    def __init__(self) -> None:
        base = getattr(settings, "workflow_template_store_path", "") or "data/workflow_templates.json"
        self._path = Path(base)
        if not self._path.is_absolute():
            self._path = Path.cwd() / self._path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._ensure_seeded()

    def _ensure_seeded(self) -> None:
        with self._lock:
            if not self._path.is_file():
                self._write(_default_seed())

    def _read(self) -> list[dict[str, Any]]:
        if not self._path.is_file():
            return []
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if isinstance(raw, list):
            return raw
        return []

    def _write(self, items: list[dict[str, Any]]) -> None:
        self._path.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")

    # --- CRUD ---
    def list_templates(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read()

    def get(self, template_id: str) -> dict[str, Any] | None:
        for t in self.list_templates():
            if t.get("id") == template_id:
                return t
        return None

    def create(self, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ValueError("payload must be an object")
        name = str(patch.get("name") or "").strip()
        prompt = str(patch.get("prompt") or "").strip()
        if not name or not prompt:
            raise ValueError("'name' and 'prompt' are required")
        now = datetime.now(tz=timezone.utc).isoformat()
        tpl = {
            "id": uuid4().hex,
            "name": name,
            "description": str(patch.get("description") or "").strip(),
            "prompt": prompt,
            "parameters": self._normalize_parameters(patch.get("parameters") or []),
            "task_type": self._clean_task_type(patch.get("task_type")),
            "conservative": bool(patch.get("conservative")),
            "tags": [str(x).strip() for x in (patch.get("tags") or []) if str(x).strip()],
            "schedule": self._normalize_schedule(patch.get("schedule")),
            "created_at": now,
            "updated_at": now,
            "last_run_id": None,
            "last_run_at": None,
            "run_count": 0,
            "is_seed": False,
        }
        with self._lock:
            items = self._read()
            items.append(tpl)
            self._write(items)
        return tpl

    def update(self, template_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ValueError("payload must be an object")
        with self._lock:
            items = self._read()
            for idx, tpl in enumerate(items):
                if tpl.get("id") != template_id:
                    continue
                if "name" in patch:
                    tpl["name"] = str(patch["name"] or "").strip() or tpl["name"]
                if "description" in patch:
                    tpl["description"] = str(patch["description"] or "").strip()
                if "prompt" in patch:
                    value = str(patch["prompt"] or "").strip()
                    if value:
                        tpl["prompt"] = value
                if "parameters" in patch:
                    tpl["parameters"] = self._normalize_parameters(patch.get("parameters") or [])
                if "task_type" in patch:
                    tpl["task_type"] = self._clean_task_type(patch.get("task_type"))
                if "conservative" in patch:
                    tpl["conservative"] = bool(patch["conservative"])
                if "tags" in patch:
                    tpl["tags"] = [str(x).strip() for x in (patch.get("tags") or []) if str(x).strip()]
                if "schedule" in patch:
                    tpl["schedule"] = self._normalize_schedule(patch.get("schedule"))
                tpl["updated_at"] = datetime.now(tz=timezone.utc).isoformat()
                items[idx] = tpl
                self._write(items)
                return tpl
        raise KeyError(template_id)

    def delete(self, template_id: str) -> None:
        with self._lock:
            items = [t for t in self._read() if t.get("id") != template_id]
            self._write(items)

    def mark_run(self, template_id: str, run_id: str) -> None:
        with self._lock:
            items = self._read()
            for idx, tpl in enumerate(items):
                if tpl.get("id") != template_id:
                    continue
                tpl["last_run_id"] = run_id
                tpl["last_run_at"] = datetime.now(tz=timezone.utc).isoformat()
                tpl["run_count"] = int(tpl.get("run_count") or 0) + 1
                items[idx] = tpl
                self._write(items)
                return

    def mark_schedule_fired(self, template_id: str, date_iso: str) -> None:
        """Record that the scheduler ran this template on ``date_iso``
        so we don't double-fire the same slot in one day."""
        with self._lock:
            items = self._read()
            for idx, tpl in enumerate(items):
                if tpl.get("id") != template_id:
                    continue
                sched = tpl.get("schedule") or {}
                sched["last_fired_on"] = date_iso
                tpl["schedule"] = sched
                items[idx] = tpl
                self._write(items)
                return

    # --- rendering ---
    def render(self, template_id: str, params: dict[str, Any]) -> tuple[dict[str, Any], str, list[str]]:
        """Return the template, the substituted prompt, and the list of unresolved params."""
        tpl = self.get(template_id)
        if not tpl:
            raise KeyError(template_id)
        prompt = str(tpl.get("prompt") or "")

        # Start with declared-parameter defaults, then layer supplied params on top.
        resolved: dict[str, str] = {}
        for p in tpl.get("parameters") or []:
            name = str(p.get("name") or "").strip()
            if not name:
                continue
            default = str(p.get("default") or "").strip()
            if default:
                resolved[name] = default
        # Any key present in `params` wins — including keys that aren't declared
        # as parameters on the template (so raw {{foo}} placeholders still work).
        for key, value in (params or {}).items():
            s = str(value or "").strip()
            if s:
                resolved[str(key)] = s

        missing: list[str] = []
        def _sub(match: re.Match) -> str:
            key = match.group(1)
            if key in resolved:
                return resolved[key]
            missing.append(key)
            return match.group(0)

        rendered = _PLACEHOLDER_RE.sub(_sub, prompt).strip()
        return tpl, rendered, missing

    @staticmethod
    def _normalize_parameters(raw: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if not isinstance(raw, list):
            return out
        seen: set[str] = set()
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name or not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", name):
                continue
            if name in seen:
                continue
            seen.add(name)
            out.append({
                "name": name,
                "label": str(item.get("label") or name).strip(),
                "placeholder": str(item.get("placeholder") or "").strip(),
                "default": str(item.get("default") or "").strip(),
                "required": bool(item.get("required", False)),
            })
        return out

    @staticmethod
    def _clean_task_type(value: Any) -> str | None:
        s = str(value or "").strip()
        return s if s in _TASK_TYPES else None

    @staticmethod
    def _normalize_schedule(raw: Any) -> dict[str, Any]:
        """Coerce a schedule payload into the canonical shape. Always returns a
        dict so callers don't have to None-check.

        Shape:
          {
            "enabled": bool,
            "hour": 0-23,
            "minute": 0-59,
            "days": [0..6]  # 0=Mon ... 6=Sun
            "last_fired_on": "YYYY-MM-DD" | None,
            "skip_if_missing_required": bool   # default True
          }
        """
        if not isinstance(raw, dict):
            return {
                "enabled": False,
                "hour": 9,
                "minute": 0,
                "days": [0, 1, 2, 3, 4],
                "last_fired_on": None,
                "skip_if_missing_required": True,
            }
        hour = max(0, min(23, int(raw.get("hour") or 0)))
        minute = max(0, min(59, int(raw.get("minute") or 0)))
        days_raw = raw.get("days") or [0, 1, 2, 3, 4]
        if not isinstance(days_raw, list):
            days_raw = [0, 1, 2, 3, 4]
        days = sorted({max(0, min(6, int(d))) for d in days_raw if isinstance(d, (int, float)) or (isinstance(d, str) and d.isdigit())})
        if not days:
            days = [0, 1, 2, 3, 4]
        last_fired = raw.get("last_fired_on")
        if last_fired is not None and not isinstance(last_fired, str):
            last_fired = None
        return {
            "enabled": bool(raw.get("enabled", False)),
            "hour": hour,
            "minute": minute,
            "days": days,
            "last_fired_on": last_fired,
            "skip_if_missing_required": bool(raw.get("skip_if_missing_required", True)),
        }


workflow_template_service = WorkflowTemplateService()
