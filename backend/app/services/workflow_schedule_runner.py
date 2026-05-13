"""Fires workflow templates that have a schedule configured.

Background thread wakes every 30 seconds, walks all templates, and for each
one whose schedule is enabled + matches today + is past the configured slot +
hasn't already fired today, renders the prompt (with declared defaults) and
kicks off a live run with ``session_id="workflow-scheduled-{template}"``.

If the template has any required parameters without defaults, the runner
skips it by default (``skip_if_missing_required``) because there's no one
around to fill them in at the scheduled moment.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

from app.repositories.run_store import run_store
from app.services.run_service import create_run
from app.services.workflow_template_service import workflow_template_service

logger = logging.getLogger("app.workflow_schedule")


def _watch_run_outcome(template_id: str, run_id: str, timeout_seconds: float = 900.0) -> None:
    """Poll the run until it reaches a terminal state, then write the outcome
    back onto the template so the delegator can see success/failure + preview.

    Runs on a daemon thread per fired schedule. Timeout is 15 minutes — runs
    longer than that are rare; if they happen we bail and mark the template's
    last_run_status as "stuck" so the delegator surfaces it.
    """
    deadline = time.time() + timeout_seconds
    terminal = {"completed", "failed", "degraded"}
    last_status = ""
    while time.time() < deadline:
        rec = run_store.get(run_id)
        if rec:
            status = str(rec.get("status") or "")
            last_status = status
            if status in terminal:
                state = rec.get("state") or {}
                output = str(state.get("spoken_response") or state.get("final_report") or "").strip()
                error = str((state.get("errors") or [""])[0] if state.get("errors") else "")
                workflow_template_service.mark_run_outcome(
                    template_id,
                    run_id=run_id,
                    status=status,
                    output_summary=output,
                    error=error,
                )
                logger.info(
                    "workflow_schedule_outcome",
                    extra={"template_id": template_id, "run_id": run_id, "status": status},
                )
                return
        time.sleep(5)

    # Timed out waiting for terminal state.
    workflow_template_service.mark_run_outcome(
        template_id,
        run_id=run_id,
        status="stuck",
        error=f"no terminal state after {int(timeout_seconds)}s (last seen: {last_status or 'unknown'})",
    )
    logger.warning(
        "workflow_schedule_outcome_timeout",
        extra={"template_id": template_id, "run_id": run_id, "last_status": last_status},
    )


class WorkflowScheduleRunner:
    def __init__(self) -> None:
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    # --- lifecycle ---
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="workflow-schedule", daemon=True)
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
                logger.exception("workflow_schedule_tick_failed")
            self._stop_event.wait(30)

    # --- main tick ---
    def _tick(self) -> None:
        now = datetime.now(tz=timezone.utc).astimezone()
        today_iso = now.date().isoformat()
        weekday = now.weekday()  # Monday=0 .. Sunday=6

        for tpl in workflow_template_service.list_templates():
            sched = tpl.get("schedule") or {}
            if not sched.get("enabled"):
                continue
            if weekday not in (sched.get("days") or []):
                continue
            if sched.get("last_fired_on") == today_iso:
                continue
            slot = now.replace(hour=int(sched.get("hour") or 0), minute=int(sched.get("minute") or 0), second=0, microsecond=0)
            if now < slot:
                continue

            template_id = str(tpl.get("id") or "")
            if not template_id:
                continue

            try:
                tpl_with_defaults, rendered, missing = workflow_template_service.render(template_id, {})
            except Exception:
                logger.exception("workflow_schedule_render_failed", extra={"template_id": template_id})
                continue

            skip_missing = bool(sched.get("skip_if_missing_required", True))
            required_missing = [
                p["name"]
                for p in (tpl_with_defaults.get("parameters") or [])
                if p.get("required") and p.get("name") in missing
            ]
            if required_missing and skip_missing:
                logger.info(
                    "workflow_schedule_skipped_missing_params",
                    extra={"template_id": template_id, "missing": required_missing},
                )
                # Still mark the slot so we don't loop hot on it.
                workflow_template_service.mark_schedule_fired(template_id, today_iso)
                continue

            try:
                run_id = create_run(
                    task=rendered,
                    mode="live",
                    user_id="local",
                    session_id=f"workflow-scheduled-{template_id[:8]}",
                    conservative_specialist_routing=bool(tpl_with_defaults.get("conservative")),
                    forced_task_type=tpl_with_defaults.get("task_type") or None,
                )
                workflow_template_service.mark_run(template_id, run_id)
                workflow_template_service.mark_schedule_fired(template_id, today_iso)
                # Fire-and-follow: spawn a thread that watches the run to its
                # terminal state and writes the outcome back onto the template.
                # Without this, "last_fired_on" lies — it only proves we queued.
                threading.Thread(
                    target=_watch_run_outcome,
                    args=(template_id, run_id),
                    name=f"watch-{template_id[:8]}",
                    daemon=True,
                ).start()
                logger.info(
                    "workflow_schedule_fired",
                    extra={"template_id": template_id, "run_id": run_id, "name": tpl_with_defaults.get("name")},
                )
            except Exception:
                logger.exception("workflow_schedule_create_run_failed", extra={"template_id": template_id})


workflow_schedule_runner = WorkflowScheduleRunner()
