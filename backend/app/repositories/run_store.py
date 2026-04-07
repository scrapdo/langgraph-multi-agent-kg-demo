from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Callable

from app.core.config import settings


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class JsonRunStore:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self._lock = Lock()
        self._data: dict[str, dict[str, Any]] = {}
        self._loaded = False

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            try:
                raw = json.loads(self.path.read_text())
                if isinstance(raw, dict):
                    self._data = raw
            except Exception:
                self._data = {}
        self._loaded = True

    def _flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(self._data, indent=2, sort_keys=True))
        tmp_path.replace(self.path)

    def create(self, run_id: str, task: str, mode: str) -> dict[str, Any]:
        now = _utc_now()
        record = {
            "run_id": run_id,
            "status": "queued",
            "mode": mode,
            "task": task,
            "state": {},
            "output": None,
            "created_at": now,
            "updated_at": now,
        }
        with self._lock:
            self._ensure_loaded()
            self._data[run_id] = record
            self._flush()
            return deepcopy(record)

    def update(self, run_id: str, **updates: Any) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            rec = self._data[run_id]
            rec.update(updates)
            rec["updated_at"] = _utc_now()
            self._flush()
            return deepcopy(rec)

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            self._ensure_loaded()
            rec = self._data.get(run_id)
            return deepcopy(rec) if rec else None

    def update_state(self, run_id: str, transform: Callable[[dict[str, Any]], dict[str, Any]]) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            rec = self._data[run_id]
            state = deepcopy(rec.get("state") or {})
            new_state = transform(state) or state
            rec["state"] = new_state
            rec["updated_at"] = _utc_now()
            self._flush()
            return deepcopy(rec)


run_store = JsonRunStore(settings.run_store_path)
