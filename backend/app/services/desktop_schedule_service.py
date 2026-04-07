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
        record = {
            "schedule_id": schedule_id,
            "name": str(payload.get("name") or "Desktop Workflow"),
            "workflow_kind": str(payload.get("workflow_kind") or "morning_brief"),
            "agent_id": str(payload.get("agent_id") or "coordinator"),
            "enabled": bool(payload.get("enabled", True)),
            "cadence_label": str(payload.get("cadence_label") or "Weekdays 8:00 AM"),
            "rrule": rrule,
            "notes": list(payload.get("notes") or []),
            "last_run_at": str(payload.get("last_run_at") or ""),
            "last_run_id": str(payload.get("last_run_id") or ""),
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

    def mark_dispatched(self, schedule_id: str, run_id: str) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            record = self._data[schedule_id]
            record["last_run_id"] = run_id
            record["last_run_at"] = _utc_now()
            record["next_run_at"] = self._compute_next_run_at(str(record.get("rrule") or ""))
            record["updated_at"] = _utc_now()
            self._flush()
            return deepcopy(record)

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
