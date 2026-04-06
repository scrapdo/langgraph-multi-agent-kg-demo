from __future__ import annotations

from datetime import datetime, timezone
from threading import Lock
from typing import Any


class InMemoryRunStore:
    def __init__(self) -> None:
        self._data: dict[str, dict[str, Any]] = {}
        self._lock = Lock()

    def create(self, run_id: str, task: str, mode: str) -> dict[str, Any]:
        now = datetime.now(tz=timezone.utc)
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
            self._data[run_id] = record
        return record

    def update(self, run_id: str, **updates: Any) -> dict[str, Any]:
        with self._lock:
            rec = self._data[run_id]
            rec.update(updates)
            rec["updated_at"] = datetime.now(tz=timezone.utc)
            return rec

    def get(self, run_id: str) -> dict[str, Any] | None:
        return self._data.get(run_id)


run_store = InMemoryRunStore()
