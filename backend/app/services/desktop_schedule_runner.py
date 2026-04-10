from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

from app.repositories.run_store import run_store
from app.services.agent_profile_service import agent_profile_service
from app.services.desktop_artifact_ingest_service import ingest_desktop_action
from app.services.desktop_automation_service import desktop_automation_service
from app.services.desktop_schedule_service import desktop_schedule_service
from app.services.neo4j_service import neo4j_service


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class DesktopScheduleRunner:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            try:
                await self.dispatch_due()
            except Exception:
                pass
            await asyncio.sleep(30)

    async def dispatch_due(self) -> list[dict]:
        dispatched = []
        for schedule in desktop_schedule_service.due_schedules():
            schedule_id = str(schedule.get("schedule_id") or "")
            run_id = str(uuid4())
            workflow_kind = str(schedule.get("workflow_kind") or "morning_brief")
            mode = str(schedule.get("mode") or "simulation")
            approval_required = bool(schedule.get("approval_required", False))
            task = f"Scheduled desktop workflow: {workflow_kind}"
            thread_id = f"desktop-schedule:{schedule.get('schedule_id')}"
            run_store.create(run_id=run_id, task=task, mode=mode)
            run_store.update(
                run_id,
                status="running",
                state={
                    "run_id": run_id,
                    "user_id": "demo-user",
                    "thread_id": thread_id,
                    "task_type": "desktop_workflow",
                    "desktop_schedule_id": schedule.get("schedule_id"),
                    "mode": mode,
                    "desktop_artifacts": [],
                    "memory_refs": [],
                    "episodes": [],
                    "last_episode_id": "",
                },
                output=None,
            )
            neo4j_service.upsert_run(
                run_id,
                task=task,
                status="running",
                user_id="demo-user",
                thread_id=thread_id,
                mode=mode,
                task_type="desktop_workflow",
            )
            neo4j_service.link_schedule_to_run(schedule_id, run_id)
            try:
                action = self._create_scheduled_action(schedule, run_id, workflow_kind)
                if mode == "live" and approval_required:
                    final_status = "awaiting_approval"
                    error = ""
                    current = run_store.get(run_id) or {}
                    run_store.update(
                        run_id,
                        status="queued",
                        state={
                            **(current.get("state") or {}),
                            "scheduled_approval_required": True,
                            "desktop_action_id": action.get("action_id"),
                        },
                        output=None,
                    )
                else:
                    executed = desktop_automation_service.execute(str(action.get("action_id")))
                    await ingest_desktop_action(executed)
                    if str(executed.get("kind") or "") == "wellness_checkin" and bool((executed.get("payload") or {}).get("outreach_enabled")):
                        from app.services.secretary_service import secretary_service

                        outreach_results = await secretary_service.dispatch_wellness_outreach(dict(executed.get("payload") or {}))
                        if outreach_results:
                            executed.setdefault("payload", {})
                            executed["payload"]["outreach_results"] = outreach_results
                    final_status = str(executed.get("status") or "completed")
                    error = str(executed.get("last_error") or "")
                    run_store.update(run_id, status="completed" if final_status == "completed" else "failed", output=None)
                updated_schedule = desktop_schedule_service.mark_run_result(
                    schedule_id,
                    run_id,
                    status=final_status,
                    error=error,
                    action_id=str(action.get("action_id") or ""),
                )
                neo4j_service.upsert_schedule(
                    schedule_id,
                    name=updated_schedule["name"],
                    workflow_kind=updated_schedule["workflow_kind"],
                    agent_id=updated_schedule["agent_id"],
                    enabled=bool(updated_schedule["enabled"]),
                    mode=str(updated_schedule["mode"]),
                    approval_required=bool(updated_schedule["approval_required"]),
                    cadence_label=str(updated_schedule["cadence_label"]),
                    output_preset=str(updated_schedule.get("output_preset") or "custom"),
                    output_subdir=str(updated_schedule.get("output_subdir") or ""),
                    template_preset=str(updated_schedule.get("template_preset") or "none"),
                    prompt_template=str(updated_schedule.get("prompt_template") or ""),
                    content_template=str(updated_schedule.get("content_template") or ""),
                    last_run_status=str(updated_schedule.get("last_run_status") or ""),
                    next_run_at=str(updated_schedule.get("next_run_at") or ""),
                )
                dispatched.append(
                    {
                        "schedule_id": schedule_id,
                        "run_id": run_id,
                        "action_id": action.get("action_id"),
                        "status": final_status,
                        "mode": mode,
                        "approval_required": approval_required,
                    }
                )
            except Exception as exc:
                run_store.update(run_id, status="failed", state={"error": str(exc)}, output=None)
                updated_schedule = desktop_schedule_service.mark_run_result(schedule_id, run_id, status="failed", error=str(exc))
                neo4j_service.upsert_schedule(
                    schedule_id,
                    name=updated_schedule["name"],
                    workflow_kind=updated_schedule["workflow_kind"],
                    agent_id=updated_schedule["agent_id"],
                    enabled=bool(updated_schedule["enabled"]),
                    mode=str(updated_schedule["mode"]),
                    approval_required=bool(updated_schedule["approval_required"]),
                    cadence_label=str(updated_schedule["cadence_label"]),
                    output_preset=str(updated_schedule.get("output_preset") or "custom"),
                    output_subdir=str(updated_schedule.get("output_subdir") or ""),
                    template_preset=str(updated_schedule.get("template_preset") or "none"),
                    prompt_template=str(updated_schedule.get("prompt_template") or ""),
                    content_template=str(updated_schedule.get("content_template") or ""),
                    last_run_status=str(updated_schedule.get("last_run_status") or ""),
                    next_run_at=str(updated_schedule.get("next_run_at") or ""),
                )
                dispatched.append(
                    {
                        "schedule_id": schedule.get("schedule_id"),
                        "run_id": run_id,
                        "action_id": None,
                        "status": "failed",
                        "error": str(exc),
                    }
                )
        return dispatched

    def _create_scheduled_action(self, schedule: dict, run_id: str, workflow_kind: str) -> dict:
        agent_id = str(schedule.get("agent_id") or "coordinator")
        title = str(schedule.get("name") or workflow_kind)
        profiles = agent_profile_service.get_profiles()
        prompt_template = str(schedule.get("prompt_template") or "").strip()
        content_template = str(schedule.get("content_template") or "").strip()
        schedule_id = str(schedule.get("schedule_id") or "")

        if workflow_kind in {"writer_export", "writer_doc"}:
            writer = profiles.get("writer", {})
            allowed = list(writer.get("specialist_apps") or [])
            return desktop_automation_service.create_action(
                kind="writer_doc",
                agent_id="writer",
                title=title,
                payload={
                    "run_id": run_id,
                    "title": title,
                    "content": content_template or f"# Scheduled Writer Export\n\nGenerated from desktop schedule `{schedule_id}`.",
                    "allowed_apps": allowed,
                    "schedule_id": schedule_id,
                    "output_subdir": str(schedule.get("output_subdir") or ""),
                    "scheduled": True,
                },
            )

        if workflow_kind in {"social_package", "social_generation"}:
            social = profiles.get("social", {})
            allowed = list(social.get("specialist_apps") or [])
            return desktop_automation_service.create_action(
                kind="social_package",
                agent_id="social",
                title=title,
                payload={
                    "run_id": run_id,
                    "title": title,
                    "message": content_template or "Scheduled social package generated from desktop workflow policy.",
                    "notes": [f"Schedule: {schedule_id}"],
                    "allowed_apps": allowed,
                    "schedule_id": schedule_id,
                    "output_subdir": str(schedule.get("output_subdir") or ""),
                    "scheduled": True,
                },
            )

        if workflow_kind in {"wellness_checkin", "wellness_nudge", "wellness_outreach"}:
            wellness = profiles.get("wellness", {})
            allowed = list(wellness.get("specialist_apps") or [])
            return desktop_automation_service.create_action(
                kind="wellness_checkin",
                agent_id="wellness",
                title=title,
                payload={
                    "run_id": run_id,
                    "title": title,
                    "message": content_template or "Check in on your core habits today. Pick one small win, one movement target, and one recovery action.",
                    "goals": [
                        "Complete one anchor habit",
                        "Move your body for at least ten focused minutes",
                        "Protect tonight's sleep window",
                    ],
                    "mode": str(schedule.get("mode") or "simulation"),
                    "outreach_enabled": workflow_kind == "wellness_outreach",
                    "outreach_channel": "telegram",
                    "outreach_provider": "auto",
                    "allowed_apps": allowed,
                    "schedule_id": schedule_id,
                    "output_subdir": str(schedule.get("output_subdir") or ""),
                    "scheduled": True,
                },
            )

        return desktop_automation_service.create_action(
            kind="gmail_calendar",
            agent_id=agent_id,
            title=title,
            payload={
                "run_id": run_id,
                "prompt": prompt_template or f"Scheduled desktop workflow for {workflow_kind}.",
                "action_type": workflow_kind,
                "owner_agent": agent_id,
                "schedule_id": schedule_id,
                "output_subdir": str(schedule.get("output_subdir") or ""),
                "scheduled": True,
            },
        )


desktop_schedule_runner = DesktopScheduleRunner()
