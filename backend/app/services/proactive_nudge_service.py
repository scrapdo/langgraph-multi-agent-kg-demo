from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.repositories.run_store import run_store
from app.services.run_service import create_run
from app.services.user_profile_service import user_profile_service

logger = logging.getLogger("app.proactive")

_DEFAULT = {
    "enabled": False,
    "schedule": [
        {"id": "morning", "hour": 9, "minute": 0, "prompt": "Morning brief: top three priorities, anything time-sensitive, and one thing I shouldn't forget."},
        {"id": "afternoon", "hour": 14, "minute": 0, "prompt": "Afternoon check-in: what did I finish this morning, what's left, and am I off track?"},
        # End-of-day slot logs its answer to a daily retrospective file.
        {"id": "wrap", "hour": 17, "minute": 30, "prompt": "End-of-day wrap: what did I actually ship today, what slipped, and what's the first thing I should do tomorrow?", "log_to": "retro"},
    ],
    "user_id": "local",
    "session_id": "proactive",
    "last_fired": {},
}


class ProactiveNudgeService:
    """Posts a predefined prompt to the workflow at configured times of day.

    The config lives at ``data/proactive_nudges.json`` and can be edited
    through GET/PUT /nudges endpoints. Nudges fire at most once per slot per
    local day (based on the operator timezone in their profile, falling back
    to server local time).
    """

    def __init__(self) -> None:
        base = getattr(settings, "proactive_nudge_store_path", "") or "data/proactive_nudges.json"
        self._path = Path(base)
        if not self._path.is_absolute():
            self._path = Path.cwd() / self._path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    # --- persistence ---
    def _read(self) -> dict[str, Any]:
        if not self._path.is_file():
            return json.loads(json.dumps(_DEFAULT))
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return json.loads(json.dumps(_DEFAULT))
        merged = json.loads(json.dumps(_DEFAULT))
        merged.update(raw if isinstance(raw, dict) else {})
        return merged

    def _write(self, config: dict[str, Any]) -> None:
        self._path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")

    def get(self) -> dict[str, Any]:
        with self._lock:
            return self._read()

    def save(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self._read()
            if "enabled" in patch:
                current["enabled"] = bool(patch["enabled"])
            if "schedule" in patch and isinstance(patch["schedule"], list):
                current["schedule"] = [
                    {
                        "id": str(s.get("id") or f"slot-{i}"),
                        "hour": max(0, min(23, int(s.get("hour", 9)))),
                        "minute": max(0, min(59, int(s.get("minute", 0)))),
                        "prompt": str(s.get("prompt", "")).strip(),
                        **({"log_to": str(s.get("log_to")).strip()} if s.get("log_to") else {}),
                    }
                    for i, s in enumerate(patch["schedule"])
                    if isinstance(s, dict) and str(s.get("prompt", "")).strip()
                ]
            self._write(current)
            return current

    # --- runtime ---
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="proactive-nudge", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=1.5)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception:
                logger.exception("proactive_nudge_tick_failed")
            # Evaluate every 30 seconds — cheap, responsive within a minute of the slot.
            self._stop_event.wait(30)

    def _tick(self) -> None:
        config = self.get()
        if not config.get("enabled"):
            return
        now = datetime.now(tz=timezone.utc).astimezone()
        today = now.date().isoformat()
        last_fired = config.get("last_fired") or {}
        changed = False
        for slot in config.get("schedule") or []:
            slot_id = slot.get("id")
            if not slot_id:
                continue
            slot_time = now.replace(hour=slot["hour"], minute=slot["minute"], second=0, microsecond=0)
            if now < slot_time:
                continue
            last = last_fired.get(slot_id)
            if last == today:
                continue
            prompt = slot.get("prompt", "").strip()
            if not prompt:
                continue
            try:
                profile_context = user_profile_service.render_context()
            except Exception:
                profile_context = ""
            full = f"{prompt}\n\nOperator context:\n{profile_context}" if profile_context else prompt
            try:
                new_run_id = create_run(
                    task=full,
                    mode="live",
                    user_id=str(config.get("user_id") or "local"),
                    session_id=str(config.get("session_id") or "proactive"),
                    conservative_specialist_routing=False,
                )
                last_fired[slot_id] = today
                changed = True
                logger.info("proactive_nudge_fired", extra={"slot": slot_id, "prompt": prompt[:80]})

                log_to = str(slot.get("log_to") or "").strip().lower()
                if log_to and new_run_id:
                    threading.Thread(
                        target=self._watch_and_log,
                        args=(new_run_id, log_to, slot_id),
                        name=f"retro-log-{slot_id}",
                        daemon=True,
                    ).start()
            except Exception:
                logger.exception("proactive_nudge_create_run_failed", extra={"slot": slot_id})
        if changed:
            with self._lock:
                current = self._read()
                current["last_fired"] = last_fired
                self._write(current)

    def _watch_and_log(self, run_id: str, log_to: str, slot_id: str) -> None:
        """Poll a run until it terminates, then append its output to
        ``data/exports/<log_to>/YYYY-MM-DD.md`` so a durable per-day log exists."""
        deadline = time.time() + 10 * 60  # give the run 10 minutes
        while time.time() < deadline:
            if self._stop_event.is_set():
                return
            rec = run_store.get(run_id) or {}
            status = rec.get("status")
            if status in ("completed", "failed", "degraded"):
                output = str(rec.get("output") or (rec.get("state") or {}).get("final_report") or "").strip()
                if not output:
                    return
                try:
                    day = datetime.now().astimezone().date().isoformat()
                    folder = Path.cwd() / "data" / "exports" / log_to
                    folder.mkdir(parents=True, exist_ok=True)
                    path = folder / f"{day}.md"
                    header = datetime.now().astimezone().strftime("%H:%M")
                    with path.open("a", encoding="utf-8") as f:
                        f.write(f"## {header} · slot={slot_id} · run={run_id[:8]}\n\n{output}\n\n---\n\n")
                    logger.info("retro_log_appended", extra={"slot": slot_id, "path": str(path), "run_id": run_id})
                except Exception:
                    logger.exception("retro_log_write_failed", extra={"slot": slot_id, "run_id": run_id})
                return
            time.sleep(5)

    # --- manual retro append ---
    def append_retro(self, text: str, log_to: str = "retro") -> str:
        """Append an ad-hoc line to today's retrospective log. Returns the path."""
        cleaned = (text or "").strip()
        if not cleaned:
            return ""
        day = datetime.now().astimezone().date().isoformat()
        folder = Path.cwd() / "data" / "exports" / log_to
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{day}.md"
        header = datetime.now().astimezone().strftime("%H:%M")
        with path.open("a", encoding="utf-8") as f:
            f.write(f"## {header} · manual\n\n{cleaned}\n\n---\n\n")
        return str(path)

    def recent_retros(self, days: int = 7, log_to: str = "retro") -> list[dict[str, Any]]:
        """Return the most recent daily retrospective files."""
        folder = Path.cwd() / "data" / "exports" / log_to
        if not folder.is_dir():
            return []
        files = sorted(folder.glob("*.md"), reverse=True)[:days]
        return [
            {"date": f.stem, "path": str(f), "content": f.read_text(encoding="utf-8", errors="replace")}
            for f in files
        ]


proactive_nudge_service = ProactiveNudgeService()
