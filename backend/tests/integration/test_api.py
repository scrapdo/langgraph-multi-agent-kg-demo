from fastapi.testclient import TestClient

from app.api.routes import scheduler_service
from app.main import app


client = TestClient(app)


def _next_available_day(profile: dict) -> str:
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

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


def test_health_endpoint():
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"


def test_scheduler_public_booking_flow(tmp_path):
    scheduler_service.store_path = tmp_path / "scheduler.json"  # type: ignore[assignment]
    scheduler_service._loaded = False  # type: ignore[attr-defined]
    scheduler_service._data = {}  # type: ignore[attr-defined]

    profile_resp = client.get("/scheduler/profile")
    assert profile_resp.status_code == 200
    profile = profile_resp.json()

    public_resp = client.get(f"/scheduler/public/{profile['public_slug']}")
    assert public_resp.status_code == 200

    event_type = public_resp.json()["event_types"][0]["slug"]
    date_text = _next_available_day(profile)
    availability_resp = client.get(
        f"/scheduler/public/{profile['public_slug']}/availability",
        params={"event_type": event_type, "date": date_text},
    )
    assert availability_resp.status_code == 200
    slots = availability_resp.json()["slots"]
    assert slots

    booking_resp = client.post(
        f"/scheduler/public/{profile['public_slug']}/book",
        json={
            "event_type_slug": event_type,
            "start_at": slots[0]["start_at"],
            "name": "Grace Hopper",
            "email": "grace@example.com",
            "notes": "Interested in a strategy session.",
        },
    )
    assert booking_resp.status_code == 200
    assert booking_resp.json()["status"] == "confirmed"
