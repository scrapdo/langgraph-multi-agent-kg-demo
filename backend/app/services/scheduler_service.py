from __future__ import annotations

import json
from copy import deepcopy
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from app.core.config import settings


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _parse_hhmm(value: str) -> time:
    hour_text, minute_text = value.split(":", 1)
    return time(hour=int(hour_text), minute=int(minute_text))


def _combine_local(day: date, clock: str, tz: ZoneInfo) -> datetime:
    parsed = _parse_hhmm(clock)
    return datetime(day.year, day.month, day.day, parsed.hour, parsed.minute, tzinfo=tz)


def _resolve_store_path(raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[2] / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


class SchedulerService:
    def __init__(self, store_path: str) -> None:
        self.store_path = _resolve_store_path(store_path)
        self._lock = Lock()
        self._loaded = False
        self._data: dict[str, Any] = {}

    def _default_state(self) -> dict[str, Any]:
        return {
            "profile": {
                "owner_name": "Matt",
                "public_slug": "matt",
                "headline": "Book time with Matt",
                "bio": "Choose a time that works and the meeting will be confirmed automatically.",
                "timezone": settings.app_timezone,
                "location_type": "video",
                "location_value": "Google Meet link sent after booking",
                "booking_window_days": 30,
                "minimum_notice_hours": 24,
                "max_bookings_per_day": 4,
                "availability": [
                    {"weekday": 0, "start": "09:00", "end": "17:00"},
                    {"weekday": 1, "start": "09:00", "end": "17:00"},
                    {"weekday": 2, "start": "09:00", "end": "17:00"},
                    {"weekday": 3, "start": "09:00", "end": "17:00"},
                    {"weekday": 4, "start": "09:00", "end": "15:00"},
                ],
                "blackout_dates": [],
                "event_types": [
                    {
                        "event_type_id": "intro-call",
                        "name": "Intro Call",
                        "slug": "intro-call",
                        "description": "A focused introductory call.",
                        "duration_minutes": 30,
                        "buffer_before_minutes": 0,
                        "buffer_after_minutes": 15,
                        "minimum_notice_hours": 24,
                        "booking_window_days": 30,
                        "max_bookings_per_day": 4,
                        "is_active": True,
                    }
                ],
            },
            "bookings": [],
        }

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        if self.store_path.exists():
            try:
                raw = json.loads(self.store_path.read_text())
                if isinstance(raw, dict):
                    self._data = raw
            except Exception:
                self._data = {}
        if not self._data:
            self._data = self._default_state()
            self._flush()
        self._loaded = True

    def _flush(self) -> None:
        tmp_path = self.store_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(self._data, indent=2, sort_keys=True))
        tmp_path.replace(self.store_path)

    def get_profile(self) -> dict[str, Any]:
        with self._lock:
            return self._get_profile_unlocked()

    def update_profile(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            profile = self._get_profile_unlocked()
            next_profile = {
                **profile,
                "owner_name": str(payload.get("owner_name") or profile.get("owner_name") or "Matt").strip(),
                "public_slug": self._normalize_slug(str(payload.get("public_slug") or profile.get("public_slug") or "matt")),
                "headline": str(payload.get("headline") or profile.get("headline") or "").strip(),
                "bio": str(payload.get("bio") or profile.get("bio") or "").strip(),
                "timezone": str(payload.get("timezone") or profile.get("timezone") or settings.app_timezone).strip() or settings.app_timezone,
                "location_type": str(payload.get("location_type") or profile.get("location_type") or "video").strip(),
                "location_value": str(payload.get("location_value") or profile.get("location_value") or "").strip(),
                "booking_window_days": max(1, int(payload.get("booking_window_days") or profile.get("booking_window_days") or 30)),
                "minimum_notice_hours": max(0, int(payload.get("minimum_notice_hours") or profile.get("minimum_notice_hours") or 24)),
                "max_bookings_per_day": max(1, int(payload.get("max_bookings_per_day") or profile.get("max_bookings_per_day") or 4)),
                "availability": self._sanitize_availability(payload.get("availability") or profile.get("availability") or []),
                "blackout_dates": self._sanitize_blackouts(payload.get("blackout_dates") or profile.get("blackout_dates") or []),
                "event_types": self._sanitize_event_types(payload.get("event_types") or profile.get("event_types") or []),
            }
            self._data["profile"] = next_profile
            self._flush()
            return deepcopy(next_profile)

    def get_public_profile(self, slug: str) -> dict[str, Any]:
        with self._lock:
            profile = self._get_profile_unlocked()
            if profile.get("public_slug") != self._normalize_slug(slug):
                raise KeyError(slug)
            return {
                "owner_name": profile["owner_name"],
                "public_slug": profile["public_slug"],
                "headline": profile["headline"],
                "bio": profile["bio"],
                "timezone": profile["timezone"],
                "location_type": profile["location_type"],
                "location_value": profile["location_value"],
                "event_types": [deepcopy(item) for item in profile.get("event_types", []) if item.get("is_active", True)],
            }

    def list_bookings(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._list_bookings_unlocked()

    def get_dashboard(self) -> dict[str, Any]:
        with self._lock:
            bookings = self._list_bookings_unlocked()
            upcoming = [item for item in bookings if item.get("status") == "confirmed" and self._parse_dt(item["start_at"]) >= datetime.now(timezone.utc)]
            return {
                "profile": self._get_profile_unlocked(),
                "bookings": bookings,
                "metrics": {
                    "confirmed_upcoming": len(upcoming),
                    "confirmed_total": len([item for item in bookings if item.get("status") == "confirmed"]),
                },
            }

    def get_available_slots(self, slug: str, event_type_slug: str, day_text: str) -> dict[str, Any]:
        with self._lock:
            profile = self._get_profile_unlocked()
            if profile.get("public_slug") != self._normalize_slug(slug):
                raise KeyError(slug)
            tz = ZoneInfo(str(profile.get("timezone") or settings.app_timezone))
            event_type = self._get_event_type(profile, event_type_slug)
            slots = self._compute_slots_for_day(profile, event_type, date.fromisoformat(day_text), tz)
            return {"date": day_text, "timezone": str(tz), "event_type": event_type, "slots": slots}

    def create_booking(self, slug: str, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            profile = self._get_profile_unlocked()
            if profile.get("public_slug") != self._normalize_slug(slug):
                raise KeyError(slug)
            event_type_slug = str(payload.get("event_type_slug") or "").strip()
            start_at_text = str(payload.get("start_at") or "").strip()
            name = str(payload.get("name") or "").strip()
            email = str(payload.get("email") or "").strip()
            notes = str(payload.get("notes") or "").strip()
            if not event_type_slug or not start_at_text or not name or not email:
                raise ValueError("event_type_slug, start_at, name, and email are required.")
            event_type = self._get_event_type(profile, event_type_slug)
            requested_start = self._parse_dt(start_at_text)
            local_day = requested_start.astimezone(ZoneInfo(profile["timezone"])).date().isoformat()
            available_slots = self._compute_slots_for_day(profile, event_type, date.fromisoformat(local_day), ZoneInfo(profile["timezone"]))
            matched = next((slot for slot in available_slots if slot["start_at"] == requested_start.astimezone(timezone.utc).isoformat()), None)
            if not matched:
                raise ValueError("Selected time is no longer available.")
            booking = {
                "booking_id": f"booking-{uuid4()}",
                "public_slug": profile["public_slug"],
                "event_type_id": event_type["event_type_id"],
                "event_type_slug": event_type["slug"],
                "event_type_name": event_type["name"],
                "duration_minutes": event_type["duration_minutes"],
                "status": "confirmed",
                "name": name,
                "email": email,
                "notes": notes,
                "location_type": profile["location_type"],
                "location_value": profile["location_value"],
                "timezone": profile["timezone"],
                "start_at": matched["start_at"],
                "end_at": matched["end_at"],
                "created_at": _utc_now(),
                "confirmation_code": str(uuid4())[:8],
            }
            self._ensure_loaded()
            bookings = deepcopy(self._data.get("bookings") or [])
            bookings.append(booking)
            self._data["bookings"] = bookings
            self._flush()
            return deepcopy(booking)

    def _get_profile_unlocked(self) -> dict[str, Any]:
        self._ensure_loaded()
        profile = self._data.get("profile") or self._default_state()["profile"]
        return deepcopy(profile)

    def _list_bookings_unlocked(self) -> list[dict[str, Any]]:
        self._ensure_loaded()
        bookings = deepcopy(self._data.get("bookings") or [])
        bookings.sort(key=lambda item: str(item.get("start_at") or ""), reverse=True)
        return bookings

    def _compute_slots_for_day(self, profile: dict[str, Any], event_type: dict[str, Any], day: date, tz: ZoneInfo) -> list[dict[str, Any]]:
        if day.isoformat() in set(profile.get("blackout_dates") or []):
            return []
        now_local = datetime.now(tz)
        day_limit = now_local.date() + timedelta(days=min(int(profile.get("booking_window_days") or 30), int(event_type.get("booking_window_days") or 30)))
        if day > day_limit:
            return []
        day_bookings = [
            item for item in self._list_bookings_unlocked()
            if item.get("status") == "confirmed" and self._parse_dt(str(item.get("start_at") or "")).astimezone(tz).date() == day
        ]
        if len(day_bookings) >= min(int(profile.get("max_bookings_per_day") or 4), int(event_type.get("max_bookings_per_day") or 4)):
            return []
        windows = [item for item in profile.get("availability", []) if int(item.get("weekday", -1)) == day.weekday()]
        if not windows:
            return []
        blocked_ranges = [
            (
                self._parse_dt(str(item.get("start_at") or "")).astimezone(tz),
                self._parse_dt(str(item.get("end_at") or "")).astimezone(tz),
            )
            for item in day_bookings
        ]
        duration = int(event_type.get("duration_minutes") or 30)
        buffer_before = int(event_type.get("buffer_before_minutes") or 0)
        buffer_after = int(event_type.get("buffer_after_minutes") or 0)
        minimum_notice_hours = max(int(profile.get("minimum_notice_hours") or 0), int(event_type.get("minimum_notice_hours") or 0))
        earliest_allowed = now_local + timedelta(hours=minimum_notice_hours)
        increment_minutes = max(15, min(duration, 60))
        slots: list[dict[str, Any]] = []
        for window in windows:
            cursor = _combine_local(day, str(window.get("start")), tz)
            window_end = _combine_local(day, str(window.get("end")), tz)
            while cursor + timedelta(minutes=duration) <= window_end:
                slot_start = cursor
                slot_end = slot_start + timedelta(minutes=duration)
                protected_start = slot_start - timedelta(minutes=buffer_before)
                protected_end = slot_end + timedelta(minutes=buffer_after)
                if slot_start >= earliest_allowed and not self._overlaps(protected_start, protected_end, blocked_ranges):
                    slots.append(
                        {
                            "start_at": slot_start.astimezone(timezone.utc).isoformat(),
                            "end_at": slot_end.astimezone(timezone.utc).isoformat(),
                            "label": slot_start.strftime("%a %b %d at %I:%M %p").replace(" 0", " "),
                        }
                    )
                cursor += timedelta(minutes=increment_minutes)
        return slots

    def _get_event_type(self, profile: dict[str, Any], slug: str) -> dict[str, Any]:
        normalized = self._normalize_slug(slug)
        event_type = next(
            (
                item for item in profile.get("event_types", [])
                if self._normalize_slug(str(item.get("slug") or "")) == normalized and item.get("is_active", True)
            ),
            None,
        )
        if not event_type:
            raise ValueError("Event type not found.")
        return deepcopy(event_type)

    def _sanitize_availability(self, rows: list[Any]) -> list[dict[str, Any]]:
        cleaned = []
        for item in rows:
            if not isinstance(item, dict):
                continue
            start = str(item.get("start") or "").strip()
            end = str(item.get("end") or "").strip()
            weekday = int(item.get("weekday", -1))
            if weekday < 0 or weekday > 6 or not start or not end:
                continue
            cleaned.append({"weekday": weekday, "start": start, "end": end})
        return sorted(cleaned, key=lambda item: (item["weekday"], item["start"])) or self._default_state()["profile"]["availability"]

    def _sanitize_blackouts(self, rows: list[Any]) -> list[str]:
        cleaned: list[str] = []
        for item in rows:
            value = str(item or "").strip()
            if not value:
                continue
            try:
                date.fromisoformat(value)
            except ValueError:
                continue
            cleaned.append(value)
        return sorted(set(cleaned))

    def _sanitize_event_types(self, rows: list[Any]) -> list[dict[str, Any]]:
        cleaned = []
        for item in rows:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            slug = self._normalize_slug(str(item.get("slug") or name))
            if not name:
                continue
            cleaned.append(
                {
                    "event_type_id": str(item.get("event_type_id") or slug),
                    "name": name,
                    "slug": slug,
                    "description": str(item.get("description") or "").strip(),
                    "duration_minutes": max(15, int(item.get("duration_minutes") or 30)),
                    "buffer_before_minutes": max(0, int(item.get("buffer_before_minutes") or 0)),
                    "buffer_after_minutes": max(0, int(item.get("buffer_after_minutes") or 0)),
                    "minimum_notice_hours": max(0, int(item.get("minimum_notice_hours") or 0)),
                    "booking_window_days": max(1, int(item.get("booking_window_days") or 30)),
                    "max_bookings_per_day": max(1, int(item.get("max_bookings_per_day") or 4)),
                    "is_active": bool(item.get("is_active", True)),
                }
            )
        return cleaned or self._default_state()["profile"]["event_types"]

    def _normalize_slug(self, value: str) -> str:
        return "-".join(part for part in "".join(char.lower() if char.isalnum() else "-" for char in value).split("-") if part) or "matt"

    def _parse_dt(self, value: str) -> datetime:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    def _overlaps(self, start: datetime, end: datetime, blocked_ranges: list[tuple[datetime, datetime]]) -> bool:
        for blocked_start, blocked_end in blocked_ranges:
            if start < blocked_end and end > blocked_start:
                return True
        return False


scheduler_service = SchedulerService(settings.scheduler_store_path)
