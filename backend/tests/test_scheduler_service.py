from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.services.scheduler_service import SchedulerService


def _next_available_day(profile: dict) -> str:
    tz = ZoneInfo(profile["timezone"])
    allowed = {item["weekday"] for item in profile["availability"]}
    current = datetime.now(tz).date()
    minimum_notice_hours = int(profile.get("minimum_notice_hours") or 0)
    min_offset = max(1, (minimum_notice_hours // 24) + 1)
    for offset in range(min_offset, 30):
        candidate = current + timedelta(days=offset)
        if candidate.weekday() in allowed:
            return candidate.isoformat()
    raise AssertionError("No available day found")


def test_scheduler_service_generates_slots_and_blocks_conflicts(tmp_path):
    service = SchedulerService(str(tmp_path / "scheduler.json"))
    profile = service.get_profile()
    next_day = _next_available_day(profile)
    availability = service.get_available_slots(profile["public_slug"], "intro-call", next_day)
    assert availability["slots"]

    first_slot = availability["slots"][0]
    booking = service.create_booking(
        profile["public_slug"],
        {
            "event_type_slug": "intro-call",
            "start_at": first_slot["start_at"],
            "name": "Ada Lovelace",
            "email": "ada@example.com",
            "notes": "Interested in a product walkthrough.",
        },
    )
    assert booking["status"] == "confirmed"

    refreshed = service.get_available_slots(profile["public_slug"], "intro-call", next_day)
    assert first_slot["start_at"] not in {slot["start_at"] for slot in refreshed["slots"]}


def test_scheduler_profile_update_persists_custom_values(tmp_path):
    service = SchedulerService(str(tmp_path / "scheduler.json"))
    updated = service.update_profile(
        {
            "owner_name": "Matthew",
            "public_slug": "founder-hours",
            "headline": "Founder office hours",
            "bio": "Book time with Matthew.",
            "timezone": "America/New_York",
            "location_type": "phone",
            "location_value": "Call me directly",
            "booking_window_days": 14,
            "minimum_notice_hours": 12,
            "max_bookings_per_day": 2,
            "availability": [{"weekday": 1, "start": "10:00", "end": "16:00"}],
            "blackout_dates": ["2026-12-25"],
            "event_types": [
                {
                    "name": "Strategy Session",
                    "slug": "strategy-session",
                    "description": "Focused strategy work.",
                    "duration_minutes": 45,
                    "buffer_before_minutes": 15,
                    "buffer_after_minutes": 15,
                    "minimum_notice_hours": 24,
                    "booking_window_days": 10,
                    "max_bookings_per_day": 2,
                    "is_active": True,
                }
            ],
        }
    )
    assert updated["public_slug"] == "founder-hours"
    assert updated["event_types"][0]["slug"] == "strategy-session"

    reloaded = SchedulerService(str(tmp_path / "scheduler.json"))
    assert reloaded.get_profile()["owner_name"] == "Matthew"
