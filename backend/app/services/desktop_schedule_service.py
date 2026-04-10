from __future__ import annotations

import json
from calendar import day_abbr
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.core.config import settings
from zoneinfo import ZoneInfo


DESTINATION_PRESETS: dict[str, dict[str, str]] = {
    "custom": {"label": "Custom", "subdir": ""},
    "briefs": {"label": "Briefs", "subdir": "briefs"},
    "writer_exports": {"label": "Writer Exports", "subdir": "writer/exports"},
    "social_campaigns": {"label": "Social Campaigns", "subdir": "social/campaigns"},
    "inbox_briefs": {"label": "Inbox Briefs", "subdir": "gmail/inbox-briefs"},
    "calendar_ops": {"label": "Calendar Ops", "subdir": "gmail/calendar-ops"},
    "approvals": {"label": "Approvals Queue", "subdir": "ops/approvals"},
    "wellness_checkins": {"label": "Wellness Check-ins", "subdir": "wellness/checkins"},
}

TEMPLATE_PRESETS: dict[str, dict[str, dict[str, str]]] = {
    "none": {"label": "No Preset", "prompt_template": "", "content_template": ""},
    "morning_operator": {
        "label": "Morning Operator Brief",
        "prompt_template": "Prepare a morning operator brief with inbox priorities, calendar risks, and the next three actions to take.",
        "content_template": "",
    },
    "founder_writer": {
        "label": "Founder Writer Export",
        "prompt_template": "",
        "content_template": "# Founder Export\n\nProduce a concise operator-ready brief with headline, context, risks, and recommended next actions.",
    },
    "social_launch": {
        "label": "Social Launch Pack",
        "prompt_template": "",
        "content_template": "Build a launch-ready social package with one primary post, two variations, CTA options, and asset handoff notes.",
    },
    "reply_drafter": {
        "label": "Reply Draft Suggestions",
        "prompt_template": "Review the highest-priority inbox threads and draft concise suggested replies with rationale and next steps.",
        "content_template": "",
    },
    "wellness_nudge": {
        "label": "Wellness Check-in",
        "prompt_template": "Prepare a concise wellness check-in with one goal, one habit reminder, one accountability question, and one encouraging note.",
        "content_template": "# Wellness Check-in\n\nShare one concrete wellness goal, one habit reminder, one accountability question, and one motivating prompt for today.",
    },
}


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class DesktopScheduleService:
    def __init__(self, store_path: str) -> None:
        self.store_path = Path(store_path)
        self._lock = Lock()
        self._loaded = False
        self._data: dict[str, dict[str, Any]] = {}

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        if self.store_path.exists():
            try:
                raw = json.loads(self.store_path.read_text())
                if isinstance(raw, dict):
                    self._data = raw
            except Exception:
                self._data = {}
        self._loaded = True

    def _flush(self) -> None:
        tmp_path = self.store_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(self._data, indent=2, sort_keys=True))
        tmp_path.replace(self.store_path)

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_loaded()
            rows = list(self._data.values())
            rows.sort(key=lambda item: item.get("created_at", ""), reverse=True)
            return deepcopy(rows)

    def upsert(self, payload: dict[str, Any]) -> dict[str, Any]:
        schedule_id = str(payload.get("schedule_id") or f"desktop-schedule-{uuid4()}")
        rrule = str(payload.get("rrule") or "")
        next_run_at = self._compute_next_run_at(rrule)
        output_preset = str(payload.get("output_preset") or "custom")
        template_preset = str(payload.get("template_preset") or "none")
        output_subdir = str(payload.get("output_subdir") or "")
        prompt_template = str(payload.get("prompt_template") or "")
        content_template = str(payload.get("content_template") or "")
        if output_preset in DESTINATION_PRESETS and not output_subdir:
            output_subdir = DESTINATION_PRESETS[output_preset]["subdir"]
        if template_preset in TEMPLATE_PRESETS:
            preset = TEMPLATE_PRESETS[template_preset]
            if not prompt_template:
                prompt_template = preset["prompt_template"]
            if not content_template:
                content_template = preset["content_template"]
        record = {
            "schedule_id": schedule_id,
            "name": str(payload.get("name") or "Desktop Workflow"),
            "workflow_kind": str(payload.get("workflow_kind") or "morning_brief"),
            "agent_id": str(payload.get("agent_id") or "coordinator"),
            "enabled": bool(payload.get("enabled", True)),
            "mode": str(payload.get("mode") or "simulation"),
            "approval_required": bool(payload.get("approval_required", False)),
            "output_preset": output_preset,
            "output_subdir": output_subdir,
            "template_preset": template_preset,
            "prompt_template": prompt_template,
            "content_template": content_template,
            "cadence_label": str(payload.get("cadence_label") or "Weekdays 8:00 AM"),
            "rrule": rrule,
            "notes": list(payload.get("notes") or []),
            "last_run_at": str(payload.get("last_run_at") or ""),
            "last_run_id": str(payload.get("last_run_id") or ""),
            "last_action_id": str(payload.get("last_action_id") or ""),
            "last_run_status": str(payload.get("last_run_status") or ""),
            "last_error": str(payload.get("last_error") or ""),
            "success_count": int(payload.get("success_count") or 0),
            "failure_count": int(payload.get("failure_count") or 0),
            "next_run_at": next_run_at,
            "created_at": str(payload.get("created_at") or _utc_now()),
            "updated_at": _utc_now(),
        }
        with self._lock:
            self._ensure_loaded()
            existing = self._data.get(schedule_id) or {}
            record["created_at"] = str(existing.get("created_at") or record["created_at"])
            self._data[schedule_id] = record
            self._flush()
            return deepcopy(record)

    def due_schedules(self) -> list[dict[str, Any]]:
        now = datetime.now(ZoneInfo(settings.app_timezone))
        due: list[dict[str, Any]] = []
        with self._lock:
            self._ensure_loaded()
            for record in self._data.values():
                if not record.get("enabled", True):
                    continue
                next_run_at = str(record.get("next_run_at") or "")
                if not next_run_at:
                    continue
                try:
                    when = datetime.fromisoformat(next_run_at)
                except Exception:
                    continue
                if when <= now:
                    due.append(deepcopy(record))
        due.sort(key=lambda item: item.get("next_run_at", ""))
        return due

    def mark_run_result(self, schedule_id: str, run_id: str, *, status: str, error: str = "", action_id: str = "") -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            record = self._data[schedule_id]
            record["last_run_id"] = run_id
            record["last_run_at"] = _utc_now()
            record["last_action_id"] = action_id or str(record.get("last_action_id") or "")
            record["last_run_status"] = status
            record["last_error"] = error
            if status == "completed":
                record["success_count"] = int(record.get("success_count") or 0) + 1
            elif status in {"failed", "rejected"}:
                record["failure_count"] = int(record.get("failure_count") or 0) + 1
            record["next_run_at"] = self._compute_next_run_at(str(record.get("rrule") or ""))
            record["updated_at"] = _utc_now()
            self._flush()
            return deepcopy(record)

    def get(self, schedule_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_loaded()
            record = self._data.get(schedule_id)
            return deepcopy(record) if record else None

    def presets(self) -> dict[str, list[dict[str, str]]]:
        return {
            "destination_presets": [
                {"id": preset_id, **payload}
                for preset_id, payload in DESTINATION_PRESETS.items()
            ],
            "template_presets": [
                {"id": preset_id, **payload}
                for preset_id, payload in TEMPLATE_PRESETS.items()
            ],
        }

    def clone(self, schedule_id: str) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            record = self._data.get(schedule_id)
            if not record:
                raise KeyError(schedule_id)
            cloned = deepcopy(record)
            cloned["schedule_id"] = f"desktop-schedule-{uuid4()}"
            cloned["name"] = f"{record.get('name', 'Desktop Workflow')} Copy"
            cloned["last_run_at"] = ""
            cloned["last_run_id"] = ""
            cloned["last_action_id"] = ""
            cloned["last_run_status"] = ""
            cloned["last_error"] = ""
            cloned["success_count"] = 0
            cloned["failure_count"] = 0
            cloned["next_run_at"] = self._compute_next_run_at(str(cloned.get("rrule") or ""))
            cloned["created_at"] = _utc_now()
            cloned["updated_at"] = _utc_now()
            self._data[cloned["schedule_id"]] = cloned
            self._flush()
            return deepcopy(cloned)

    def set_enabled(self, schedule_id: str, enabled: bool) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            record = self._data.get(schedule_id)
            if not record:
                raise KeyError(schedule_id)
            record["enabled"] = enabled
            record["updated_at"] = _utc_now()
            self._flush()
            return deepcopy(record)

    def delete(self, schedule_id: str) -> None:
        with self._lock:
            self._ensure_loaded()
            if schedule_id not in self._data:
                raise KeyError(schedule_id)
            del self._data[schedule_id]
            self._flush()

    def _compute_next_run_at(self, rrule: str) -> str:
        if not rrule:
            return ""
        tz = ZoneInfo(settings.app_timezone)
        now = datetime.now(tz).replace(second=0, microsecond=0)
        parts = {}
        for chunk in rrule.split(";"):
            if "=" not in chunk:
                continue
            key, value = chunk.split("=", 1)
            parts[key] = value
        freq = parts.get("FREQ", "").upper()
        if freq == "WEEKLY":
            byday = [item.strip().upper() for item in parts.get("BYDAY", "").split(",") if item.strip()]
            byhour = int(parts.get("BYHOUR", now.hour))
            byminute = int(parts.get("BYMINUTE", 0))
            weekday_map = {abbr.upper()[:2]: idx for idx, abbr in enumerate(day_abbr)}
            allowed = [weekday_map[item] for item in byday if item in weekday_map]
            for offset in range(0, 8):
                candidate = now.replace(hour=byhour, minute=byminute) + timedelta(days=offset)
                if allowed and candidate.weekday() not in allowed:
                    continue
                if candidate > now:
                    return candidate.isoformat()
        if freq == "HOURLY":
            interval = max(int(parts.get("INTERVAL", 1) or 1), 1)
            candidate = now + timedelta(hours=interval)
            return candidate.isoformat()
        return ""


desktop_schedule_service = DesktopScheduleService(settings.desktop_schedule_store_path)
