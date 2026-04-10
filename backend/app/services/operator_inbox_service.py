from __future__ import annotations

from collections import Counter
from typing import Any

from app.repositories.run_store import run_store
from app.services.desktop_automation_service import desktop_automation_service
from app.services.desktop_schedule_service import desktop_schedule_service
from app.services.policy_service import evaluate_operation_risk
from app.services.secretary_service import secretary_service


def _priority_rank(priority: str) -> int:
    return {
        "critical": 0,
        "high": 1,
        "medium": 2,
        "low": 3,
    }.get(priority, 9)


class OperatorInboxService:
    def get_inbox(self, limit: int = 40) -> dict[str, Any]:
        items: list[dict[str, Any]] = []

        for run in run_store.list(limit=100):
            run_id = str(run.get("run_id") or "")
            status = str(run.get("status") or "")
            state = run.get("state") or {}
            route = state.get("route_decision") or {}
            route_agent = str(route.get("agent_id") or "")
            if status in {"failed", "degraded"}:
                items.append(
                    {
                        "item_id": f"run:{run_id}",
                        "kind": "run_status",
                        "title": run.get("task") or "Run issue",
                        "summary": str((state.get("errors") or ["Run failed"])[0] if status == "failed" else "Run degraded and used fallback output."),
                        "status": status,
                        "priority": "critical" if status == "failed" else "high",
                        "source": "run",
                        "agent_id": route_agent or None,
                        "run_id": run_id,
                        "created_at": run.get("updated_at"),
                        "metadata": {
                            "mode": run.get("mode"),
                            "task_type": state.get("task_type"),
                            "route_reason": route.get("reason"),
                        },
                    }
                )
            if status == "running":
                items.append(
                    {
                        "item_id": f"run-running:{run_id}",
                        "kind": "run_status",
                        "title": run.get("task") or "Running task",
                        "summary": "Run is still active. Open Mission Control for the live stream.",
                        "status": "running",
                        "priority": "low",
                        "source": "run",
                        "agent_id": route_agent or None,
                        "run_id": run_id,
                        "created_at": run.get("updated_at"),
                        "metadata": {
                            "task_type": state.get("task_type"),
                            "latency_ms": state.get("run_metrics", {}).get("elapsed_ms"),
                        },
                    }
                )
            approvals = list(state.get("approvals") or [])
            for approval in approvals:
                if str(approval.get("status") or "") != "queued":
                    continue
                approval_kind = str(approval.get("kind") or "")
                operation = "social_publish" if approval_kind == "social_post" else "desktop_action"
                risk = evaluate_operation_risk(operation, mode=str(run.get("mode") or "simulation"), approval_required=True)
                items.append(
                    {
                        "item_id": f"approval:{approval.get('approval_id')}",
                        "kind": "approval",
                        "title": approval.get("title") or "Approval pending",
                        "summary": f"{approval.get('message') or approval.get('url') or 'Pending operator approval.'} Risk: {risk['level']}.",
                        "status": "queued",
                        "priority": "high",
                        "source": "approval",
                        "agent_id": route_agent or None,
                        "run_id": run_id,
                        "created_at": approval.get("updated_at") or run.get("updated_at"),
                        "metadata": {
                            "approval_id": approval.get("approval_id"),
                            "approval_kind": approval.get("kind"),
                            "platform": approval.get("platform"),
                            "risk": risk,
                        },
                    }
                )

        for schedule in desktop_schedule_service.list():
            last_status = str(schedule.get("last_run_status") or "")
            priority = "medium"
            if last_status == "awaiting_approval":
                priority = "high"
            elif last_status in {"failed", "rejected"}:
                priority = "critical"
            else:
                continue
            items.append(
                {
                    "item_id": f"schedule:{schedule.get('schedule_id')}",
                    "kind": "schedule",
                    "title": schedule.get("name") or "Desktop schedule",
                    "summary": f"{schedule.get('workflow_kind')} · {last_status}",
                    "status": last_status,
                    "priority": priority,
                    "source": "schedule",
                    "agent_id": schedule.get("agent_id"),
                    "schedule_id": schedule.get("schedule_id"),
                    "run_id": schedule.get("last_run_id"),
                    "action_id": schedule.get("last_action_id"),
                    "created_at": schedule.get("updated_at"),
                    "metadata": {
                        "mode": schedule.get("mode"),
                        "approval_required": schedule.get("approval_required"),
                        "last_error": schedule.get("last_error"),
                        "risk": evaluate_operation_risk(
                            "wellness_outreach" if str(schedule.get("workflow_kind") or "") in {"wellness_checkin", "wellness_outreach", "wellness_nudge"} else "desktop_action",
                            mode=str(schedule.get("mode") or "simulation"),
                            approval_required=bool(schedule.get("approval_required")),
                        ),
                    },
                }
            )

        for action in desktop_automation_service.list_actions():
            status = str(action.get("status") or "")
            if status not in {"blocked", "failed"}:
                continue
            items.append(
                {
                    "item_id": f"desktop:{action.get('action_id')}",
                    "kind": "desktop_action",
                    "title": action.get("title") or "Desktop action",
                    "summary": str(action.get("last_error") or "Desktop action needs attention."),
                    "status": status,
                    "priority": "high" if status == "blocked" else "critical",
                    "source": "desktop",
                    "agent_id": action.get("agent_id"),
                    "action_id": action.get("action_id"),
                    "run_id": (action.get("payload") or {}).get("run_id"),
                    "created_at": action.get("updated_at"),
                    "metadata": {
                        "kind": action.get("kind"),
                        "output_path": action.get("output_path"),
                        "risk": evaluate_operation_risk(
                            "wellness_outreach" if str(action.get("kind") or "") == "wellness_checkin" else "desktop_action",
                            mode=str((action.get("payload") or {}).get("mode") or "simulation"),
                        ),
                    },
                }
            )

        secretary = secretary_service.status()
        for item in list(secretary.get("checklist") or []):
            if item.get("ok"):
                continue
            items.append(
                {
                    "item_id": f"setup:{item.get('id')}",
                    "kind": "setup",
                    "title": item.get("label") or "Setup task",
                    "summary": item.get("detail") or "Configuration required.",
                    "status": "pending",
                    "priority": "medium",
                    "source": "setup",
                    "agent_id": "secretary",
                    "created_at": None,
                    "metadata": {},
                }
            )
        for entry in list(secretary.get("history") or [])[:10]:
            if str(entry.get("status") or "") != "failed":
                continue
            operation = {
                "call": "secretary_call",
                "sms": "secretary_sms",
                "email": "secretary_email",
                "telegram": "secretary_telegram",
            }.get(str(entry.get("channel") or ""), "desktop_action")
            items.append(
                {
                    "item_id": f"secretary-failure:{entry.get('at')}:{entry.get('channel')}",
                    "kind": "secretary_dispatch",
                    "title": f"Secretary {entry.get('channel')} failed",
                    "summary": str(entry.get("error") or "Dispatch failed"),
                    "status": "failed",
                    "priority": "high",
                    "source": "secretary",
                    "agent_id": "secretary",
                    "created_at": entry.get("at"),
                    "metadata": {
                        "to": entry.get("to"),
                        "provider": entry.get("provider"),
                        "contact_id": entry.get("contact_id"),
                        "risk": evaluate_operation_risk(operation, mode=str(entry.get("mode") or "live"), approval_required=True),
                    },
                }
            )

        items.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        items.sort(key=lambda item: _priority_rank(str(item.get("priority") or "medium")))
        items = items[:limit]
        counts = Counter(str(item.get("kind") or "unknown") for item in items)
        summary = {
            "total": len(items),
            "critical": sum(1 for item in items if item.get("priority") == "critical"),
            "high": sum(1 for item in items if item.get("priority") == "high"),
            "pending_approvals": sum(1 for item in items if item.get("kind") in {"approval", "schedule"} and item.get("status") in {"queued", "awaiting_approval"}),
            "failed": sum(1 for item in items if item.get("status") in {"failed", "rejected"}),
            "runs": counts.get("run_status", 0),
            "desktop": counts.get("desktop_action", 0),
            "setup": counts.get("setup", 0),
        }
        return {"summary": summary, "items": items}


operator_inbox_service = OperatorInboxService()
