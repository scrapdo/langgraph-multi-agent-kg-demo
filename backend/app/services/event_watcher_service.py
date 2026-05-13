"""Background watcher that reacts to real Gmail/Calendar changes.

Runs every few minutes. Compares the current brief data against a stored
``last_seen`` snapshot; when it detects a new meeting within the next
``lead_time_minutes`` or a sender matching ``priority_senders``, it fires a
background run with a specialized prompt. Runs are suppressed for events /
messages that have already triggered a run in the same day.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.services.google_workspace_service import google_workspace_service
from app.services.run_service import create_run

logger = logging.getLogger("app.event_watcher")

_DEFAULT: dict[str, Any] = {
    "enabled": False,
    "poll_seconds": 180,
    "lead_time_minutes": 15,
    "priority_senders": [],  # e.g. ["ceo@acme.com", "sarah@"]
    "dismiss_ids": [],       # event/message ids the user has dismissed
    "last_fired": {},        # id -> iso timestamp
    "user_id": "local",
    "session_id": "proactive-watch",
}


class EventWatcherService:
    def __init__(self) -> None:
        base = getattr(settings, "event_watcher_store_path", "") or "data/event_watcher.json"
        self._path = Path(base)
        if not self._path.is_absolute():
            self._path = Path.cwd() / self._path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

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

    def _write(self, cfg: dict[str, Any]) -> None:
        self._path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

    def get(self) -> dict[str, Any]:
        with self._lock:
            return self._read()

    def save(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            cfg = self._read()
            for key in ("enabled", "poll_seconds", "lead_time_minutes", "user_id", "session_id"):
                if key in patch:
                    cfg[key] = patch[key]
            if "priority_senders" in patch and isinstance(patch["priority_senders"], list):
                cfg["priority_senders"] = [str(x).strip().lower() for x in patch["priority_senders"] if str(x).strip()]
            if "dismiss_ids" in patch and isinstance(patch["dismiss_ids"], list):
                cfg["dismiss_ids"] = [str(x) for x in patch["dismiss_ids"]]
            cfg["poll_seconds"] = max(60, int(cfg.get("poll_seconds", 180) or 180))
            cfg["lead_time_minutes"] = max(1, min(120, int(cfg.get("lead_time_minutes", 15) or 15)))
            self._write(cfg)
            return cfg

    # --- lifecycle ---
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="event-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=1.5)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            cfg = self.get()
            poll = max(60, int(cfg.get("poll_seconds", 180) or 180))
            try:
                if cfg.get("enabled") and google_workspace_service.connected():
                    self._tick(cfg)
            except Exception:
                logger.exception("event_watcher_tick_failed")
            self._stop_event.wait(poll)

    def _tick(self, cfg: dict[str, Any]) -> None:
        data = google_workspace_service.fetch_brief_data()
        if data.get("error") or not data.get("connected"):
            return
        now = datetime.now(timezone.utc)
        today = now.date().isoformat()
        last_fired: dict[str, str] = dict(cfg.get("last_fired") or {})
        dismissed = set(cfg.get("dismiss_ids") or [])
        lead = timedelta(minutes=int(cfg.get("lead_time_minutes") or 15))

        changed = False

        # --- Upcoming meeting prep ---
        for event in data.get("events") or []:
            start_raw = event.get("start")
            if not start_raw:
                continue
            try:
                start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
            except ValueError:
                continue
            # Make it tz-aware if it's a bare date.
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            if start < now or start > now + lead:
                continue
            event_id = f"event:{event.get('summary','')}:{start.isoformat()}"
            if event_id in dismissed or last_fired.get(event_id) == today:
                continue
            attendees = ", ".join(event.get("attendees") or []) or "no other attendees listed"
            prompt = (
                f"Prep me for a meeting starting in under {cfg['lead_time_minutes']} minutes.\n\n"
                f"Event: {event.get('summary') or '(untitled)'}\n"
                f"When: {start.astimezone().strftime('%I:%M %p')}\n"
                f"Where: {event.get('location') or 'not specified'}\n"
                f"Attendees: {attendees}\n\n"
                "Please output:\n"
                "1. A one-paragraph summary of what I likely need to bring to this meeting based on my profile and prior notes.\n"
                "2. Three things to mention or ask.\n"
                "3. Anything unresolved from previous touchpoints with these people."
            )
            try:
                run_id = create_run(
                    task=prompt,
                    mode="live",
                    user_id=str(cfg.get("user_id") or "local"),
                    session_id=str(cfg.get("session_id") or "proactive-watch"),
                    conservative_specialist_routing=False,
                )
                last_fired[event_id] = today
                changed = True
                logger.info("event_watcher_meeting_prep_fired", extra={"event": event_id, "run_id": run_id})
            except Exception:
                logger.exception("event_watcher_meeting_prep_create_run_failed", extra={"event": event_id})

        # --- Priority-sender triage ---
        priority_senders: list[str] = [str(x).lower() for x in (cfg.get("priority_senders") or [])]
        if priority_senders:
            for msg in data.get("messages") or []:
                sender = str(msg.get("from") or "").lower()
                if not any(p in sender for p in priority_senders):
                    continue
                msg_id = f"msg:{msg.get('id')}"
                if msg_id in dismissed or last_fired.get(msg_id) == today:
                    continue
                prompt = (
                    f"A priority contact just sent me an email. Please draft a triage summary.\n\n"
                    f"From: {msg.get('from')}\n"
                    f"Subject: {msg.get('subject')}\n"
                    f"Date: {msg.get('date')}\n\n"
                    "Output a one-line summary, suggested response tone, and whether it needs a real reply today."
                )
                try:
                    run_id = create_run(
                        task=prompt,
                        mode="live",
                        user_id=str(cfg.get("user_id") or "local"),
                        session_id=str(cfg.get("session_id") or "proactive-watch"),
                        conservative_specialist_routing=False,
                    )
                    last_fired[msg_id] = today
                    changed = True
                    logger.info("event_watcher_priority_email_fired", extra={"msg": msg_id, "run_id": run_id})
                except Exception:
                    logger.exception("event_watcher_priority_email_create_run_failed", extra={"msg": msg_id})

        if changed:
            with self._lock:
                cfg2 = self._read()
                cfg2["last_fired"] = last_fired
                self._write(cfg2)


event_watcher_service = EventWatcherService()
