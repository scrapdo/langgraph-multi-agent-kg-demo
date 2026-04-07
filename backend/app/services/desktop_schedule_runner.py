from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from uuid import uuid4

from app.repositories.run_store import run_store
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
            run_id = str(uuid4())
            workflow_kind = str(schedule.get("workflow_kind") or "morning_brief")
            task = f"Scheduled desktop workflow: {workflow_kind}"
            thread_id = f"desktop-schedule:{schedule.get('schedule_id')}"
            run_store.create(run_id=run_id, task=task, mode="simulation")
            run_store.update(
                run_id,
                status="completed",
                state={
                    "run_id": run_id,
                    "user_id": "demo-user",
                    "thread_id": thread_id,
                    "task_type": "desktop_workflow",
                    "desktop_schedule_id": schedule.get("schedule_id"),
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
                status="completed",
                user_id="demo-user",
                thread_id=thread_id,
                mode="simulation",
                task_type="desktop_workflow",
            )
            action = desktop_automation_service.create_action(
                kind="gmail_calendar",
                agent_id=str(schedule.get("agent_id") or "coordinator"),
                title=str(schedule.get("name") or workflow_kind),
                payload={
                    "run_id": run_id,
                    "prompt": f"Scheduled desktop workflow for {workflow_kind}.",
                    "action_type": workflow_kind,
                    "owner_agent": str(schedule.get("agent_id") or "coordinator"),
                    "schedule_id": str(schedule.get("schedule_id") or ""),
                    "scheduled": True,
                },
            )
            executed = desktop_automation_service.execute(str(action.get("action_id")))
            await ingest_desktop_action(executed)
            desktop_schedule_service.mark_dispatched(str(schedule.get("schedule_id")), run_id)
            dispatched.append({"schedule_id": schedule.get("schedule_id"), "run_id": run_id, "action_id": action.get("action_id")})
        return dispatched


desktop_schedule_runner = DesktopScheduleRunner()
