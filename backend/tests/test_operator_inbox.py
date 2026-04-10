from app.services.operator_inbox_service import operator_inbox_service


def test_operator_inbox_aggregates_runs_schedules_and_setup(monkeypatch):
    monkeypatch.setattr(
        "app.services.operator_inbox_service.run_store.list",
        lambda limit=100: [
            {
                "run_id": "run-1",
                "task": "Review outreach queue",
                "status": "failed",
                "mode": "simulation",
                "updated_at": "2026-04-08T10:00:00+00:00",
                "state": {
                    "errors": ["provider timeout"],
                    "route_decision": {"agent_id": "secretary", "task_type": "secretary", "reason": "explicit mention"},
                    "approvals": [
                        {
                            "approval_id": "approval-1",
                            "title": "LinkedIn post",
                            "status": "queued",
                            "kind": "social_post",
                            "updated_at": "2026-04-08T10:01:00+00:00",
                        }
                    ],
                },
            }
        ],
    )
    monkeypatch.setattr(
        "app.services.operator_inbox_service.desktop_schedule_service.list",
        lambda: [
            {
                "schedule_id": "schedule-1",
                "name": "Morning Brief",
                "workflow_kind": "morning_brief",
                "agent_id": "coordinator",
                "last_run_status": "awaiting_approval",
                "last_run_id": "run-2",
                "last_action_id": "action-2",
                "updated_at": "2026-04-08T10:02:00+00:00",
                "mode": "live",
                "approval_required": True,
                "last_error": "",
            }
        ],
    )
    monkeypatch.setattr(
        "app.services.operator_inbox_service.desktop_automation_service.list_actions",
        lambda: [
            {
                "action_id": "action-3",
                "title": "Writer Draft",
                "status": "blocked",
                "agent_id": "writer",
                "updated_at": "2026-04-08T10:03:00+00:00",
                "payload": {"run_id": "run-3"},
                "last_error": "Host bridge missing",
                "kind": "writer_doc",
                "output_path": None,
            }
        ],
    )
    monkeypatch.setattr(
        "app.services.operator_inbox_service.secretary_service.status",
        lambda: {
            "checklist": [{"id": "voice_sms_provider", "label": "Configure a calling/SMS provider", "ok": False, "detail": "Twilio or Telnyx required."}],
            "history": [{"at": "2026-04-08T10:04:00+00:00", "channel": "call", "status": "failed", "error": "No provider configured", "to": "+15555555555"}],
        },
    )

    payload = operator_inbox_service.get_inbox()
    assert payload["summary"]["total"] >= 5
    assert payload["summary"]["pending_approvals"] >= 2
    assert any(item["kind"] == "run_status" for item in payload["items"])
    assert any(item["kind"] == "schedule" for item in payload["items"])
    assert any(item["kind"] == "desktop_action" for item in payload["items"])
    assert any(item["kind"] == "setup" for item in payload["items"])
