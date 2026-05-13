import asyncio

from app.services.desktop_schedule_runner import DesktopScheduleRunner


def test_dispatch_due_marks_live_approval_schedule_as_awaiting_approval(monkeypatch):
    runner = DesktopScheduleRunner()

    monkeypatch.setattr(
        "app.services.desktop_schedule_runner.desktop_schedule_service.due_schedules",
        lambda: [
            {
                "schedule_id": "schedule-1",
                "workflow_kind": "wellness_outreach",
                "mode": "live",
                "approval_required": True,
                "agent_id": "wellness",
                "name": "Wellness Outreach",
                "output_subdir": "",
            }
        ],
    )
    monkeypatch.setattr("app.services.desktop_schedule_runner.run_store.create", lambda **kwargs: kwargs)
    monkeypatch.setattr("app.services.desktop_schedule_runner.run_store.update", lambda *args, **kwargs: {})
    monkeypatch.setattr("app.services.desktop_schedule_runner.neo4j_service.upsert_run", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.desktop_schedule_runner.neo4j_service.link_schedule_to_run", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.desktop_schedule_runner.neo4j_service.upsert_schedule", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "app.services.desktop_schedule_runner.agent_profile_service.get_profiles",
        lambda: {"wellness": {"specialist_apps": []}},
    )
    monkeypatch.setattr(
        "app.services.desktop_schedule_runner.desktop_automation_service.create_action",
        lambda **kwargs: {"action_id": "action-1", "kind": kwargs["kind"], "payload": kwargs["payload"]},
    )
    monkeypatch.setattr(
        "app.services.desktop_schedule_runner.desktop_schedule_service.mark_run_result",
        lambda schedule_id, run_id, status, error="", action_id="": {
            "schedule_id": schedule_id,
            "name": "Wellness Outreach",
            "workflow_kind": "wellness_outreach",
            "agent_id": "wellness",
            "enabled": True,
            "mode": "live",
            "approval_required": True,
            "cadence_label": "Daily",
            "output_preset": "wellness_checkins",
            "output_subdir": "",
            "template_preset": "wellness_nudge",
            "prompt_template": "",
            "content_template": "",
            "last_run_status": status,
            "next_run_at": "",
        },
    )

    dispatched = asyncio.run(runner.dispatch_due())
    assert len(dispatched) == 1
    assert dispatched[0]["status"] == "awaiting_approval"
