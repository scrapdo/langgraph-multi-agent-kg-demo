from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.responses import Response, StreamingResponse

from app.core.config import settings
from app.events.bus import event_bus
from app.models.schemas import (
    AgentProfilesPayload,
    AgentProfileUpdatePayload,
    ApprovalItem,
    DocumentProcessResponse,
    OperatorInboxResponse,
    RunDetail,
    RunMemoryResponse,
    RunRequest,
    RunResponse,
    SchedulerAvailabilityResponse,
    SchedulerBooking,
    SchedulerBookingCreatePayload,
    SchedulerDashboardResponse,
    SchedulerProfile,
    SchedulerProfileUpdatePayload,
    SchedulerPublicProfileResponse,
    ShoppingSource,
    ShoppingSummaryResponse,
    SocialPlatformPlan,
    SocialSummaryResponse,
    ThreadDetailResponse,
)
from app.repositories.run_store import run_store
from app.services.agent_profile_service import agent_profile_service
from app.services.browser_automation_service import browser_automation_service
from app.services.desktop_automation_service import desktop_automation_service
from app.services.desktop_artifact_ingest_service import ingest_desktop_action
from app.services.desktop_schedule_service import desktop_schedule_service
from app.services.desktop_schedule_runner import desktop_schedule_runner
from app.services.document_service import document_service
from app.services.huggingface_service import huggingface_service
from app.services.local_app_service import local_app_service
from app.services.memory_service import memory_service
from app.services.model_router_service import available_catalog
from app.services.neo4j_service import neo4j_service
from app.services.playwright_service import playwright_service
from app.services.google_workspace_service import google_workspace_service
from app.services.github_ops_service import github_ops_service
from app.services.operator_inbox_service import operator_inbox_service
from app.services.policy_service import evaluate_operation_risk
from app.services.run_service import create_run
from app.services.scheduler_service import scheduler_service
from app.services.secretary_service import secretary_service
from app.services.tts_service import tts_service
from app.tools.adapters import INSTAGRAM_PUBLISH_TOOL, LINKEDIN_PUBLISH_TOOL, X_PUBLISH_TOOL, score_shopping_domain

router = APIRouter()


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _get_run_or_404(run_id: str) -> dict:
    rec = run_store.get(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")
    return rec


def _get_approvals(state: dict) -> list[dict]:
    return list(state.get("approvals") or [])


def _replace_approval(state: dict, approval_id: str, updated: dict) -> dict:
    approvals = []
    replaced = False
    for item in _get_approvals(state):
        if item.get("approval_id") == approval_id:
            approvals.append(updated)
            replaced = True
        else:
            approvals.append(item)
    if not replaced:
        raise HTTPException(status_code=404, detail="Approval not found")
    state["approvals"] = approvals
    return state


@router.post("/runs", response_model=RunResponse)
async def start_run(payload: RunRequest) -> RunResponse:
    run_id = create_run(
        task=payload.task,
        mode=payload.mode,
        user_id=payload.user_id,
        session_id=payload.session_id,
        conservative_specialist_routing=payload.conservative_specialist_routing,
    )
    rec = run_store.get(run_id)
    return RunResponse(run_id=run_id, status=rec["status"] if rec else "queued")


@router.get("/runs/{run_id}", response_model=RunDetail)
async def get_run(run_id: str) -> RunDetail:
    rec = run_store.get(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")
    return RunDetail(**rec)


@router.get("/scheduler", response_model=SchedulerDashboardResponse)
async def get_scheduler_dashboard() -> SchedulerDashboardResponse:
    return SchedulerDashboardResponse(**scheduler_service.get_dashboard())


@router.get("/scheduler/profile", response_model=SchedulerProfile)
async def get_scheduler_profile() -> SchedulerProfile:
    return SchedulerProfile(**scheduler_service.get_profile())


@router.put("/scheduler/profile", response_model=SchedulerProfile)
async def update_scheduler_profile(payload: SchedulerProfileUpdatePayload) -> SchedulerProfile:
    return SchedulerProfile(**scheduler_service.update_profile(payload.model_dump()))


@router.get("/scheduler/public/{slug}", response_model=SchedulerPublicProfileResponse)
async def get_public_scheduler_profile(slug: str) -> SchedulerPublicProfileResponse:
    try:
        return SchedulerPublicProfileResponse(**scheduler_service.get_public_profile(slug))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Public booking page not found") from exc


@router.get("/scheduler/public/{slug}/availability", response_model=SchedulerAvailabilityResponse)
async def get_public_scheduler_availability(
    slug: str,
    event_type: str = Query(...),
    date: str = Query(...),
) -> SchedulerAvailabilityResponse:
    try:
        return SchedulerAvailabilityResponse(**scheduler_service.get_available_slots(slug, event_type, date))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Public booking page not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/scheduler/public/{slug}/book", response_model=SchedulerBooking)
async def create_public_scheduler_booking(slug: str, payload: SchedulerBookingCreatePayload) -> SchedulerBooking:
    try:
        return SchedulerBooking(**scheduler_service.create_booking(slug, payload.model_dump()))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Public booking page not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/browser/inspect")
async def inspect_browser_url(url: str = Query(..., min_length=5)):
    try:
        return await browser_automation_service.inspect_url(url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/browser/workflows")
async def list_browser_workflows():
    return {"workflows": browser_automation_service.list_workflows()}


@router.post("/browser/workflows")
async def save_browser_workflow(payload: dict):
    return {"workflow": browser_automation_service.save_workflow(payload)}


@router.post("/browser/workflows/{workflow_id}/run")
async def run_browser_workflow(workflow_id: str):
    try:
        return await browser_automation_service.run_workflow(workflow_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Workflow not found") from exc


@router.get("/browser/playwright/status")
async def get_playwright_status():
    return playwright_service.status()


@router.get("/browser/playwright/scripts")
async def list_playwright_scripts():
    return {"scripts": playwright_service.list_scripts()}


@router.get("/browser/playwright/presets")
async def list_playwright_presets():
    return {"presets": playwright_service.list_presets()}


@router.post("/browser/playwright/presets/install")
async def install_playwright_presets(payload: dict):
    agent_id = str(payload.get("agent_id") or "").strip()
    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required")
    preset_ids = payload.get("preset_ids")
    if preset_ids is not None and not isinstance(preset_ids, list):
        raise HTTPException(status_code=400, detail="preset_ids must be a list when provided")
    installed = playwright_service.install_presets(agent_id, [str(item) for item in preset_ids] if preset_ids else None)
    return {"installed": installed}


@router.post("/browser/playwright/scripts")
async def save_playwright_script(payload: dict):
    return {"script": playwright_service.save_script(payload)}


@router.delete("/browser/playwright/scripts/{script_id}")
async def delete_playwright_script(script_id: str):
    try:
        playwright_service.delete_script(script_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Script not found") from exc
    return {"ok": True}


@router.post("/browser/playwright/scripts/{script_id}/run")
async def run_playwright_script(script_id: str):
    try:
        script = next((item for item in playwright_service.list_scripts() if item.get("script_id") == script_id), None)
        if not script:
            raise KeyError(script_id)
        if script.get("mode") == "live" and script.get("approval_required", False):
            queued = playwright_service.save_script(
                {
                    **script,
                    "last_run_at": _utc_now(),
                    "last_status": "awaiting_approval",
                }
            )
            return {"script": queued, "results": [], "awaiting_approval": True}
        return await playwright_service.run_script(script_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Script not found") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/browser/playwright/scripts/{script_id}/approve")
async def approve_playwright_script(script_id: str):
    try:
        return await playwright_service.run_script(script_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Script not found") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/reports/run/{run_id}", response_class=HTMLResponse)
async def get_run_report(run_id: str) -> HTMLResponse:
    rec = run_store.get(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")
    output = str(rec.get("output") or ((rec.get("state") or {}).get("final_report") or "No report available.")).strip()
    safe_output = (
        output.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
    task = str(rec.get("task") or "Untitled run")
    status = str(rec.get("status") or "unknown")
    mode = str(rec.get("mode") or "simulation")
    updated_at = rec.get("updated_at")
    html = f"""
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Run Report · {run_id}</title>
        <style>
          body {{ font-family: Inter, Arial, sans-serif; margin: 0; background: #07111d; color: #e6f3ff; }}
          .shell {{ max-width: 980px; margin: 0 auto; padding: 32px 20px 60px; }}
          .hero {{ border: 1px solid rgba(84, 188, 255, 0.25); border-radius: 18px; padding: 24px; background: linear-gradient(180deg, rgba(10,23,39,0.96), rgba(7,17,29,0.9)); }}
          .eyebrow {{ color: #65d9ff; font-size: 12px; letter-spacing: .24em; text-transform: uppercase; }}
          h1 {{ margin: 10px 0 8px; font-size: 32px; }}
          .meta {{ display: flex; gap: 12px; flex-wrap: wrap; margin-top: 18px; }}
          .pill {{ border: 1px solid rgba(84,188,255,.22); background: rgba(10,23,39,.72); border-radius: 999px; padding: 8px 12px; font-size: 13px; }}
          .report {{ margin-top: 20px; border: 1px solid rgba(84,188,255,.18); border-radius: 18px; background: rgba(7,17,29,.84); padding: 24px; }}
          pre {{ white-space: pre-wrap; word-break: break-word; font: 14px/1.6 "SFMono-Regular", Menlo, monospace; color: #d8eefc; margin: 0; }}
          @media print {{
            body {{ background: #fff; color: #111; }}
            .hero, .report {{ background: #fff; border-color: #ddd; box-shadow: none; }}
            .eyebrow, .pill {{ color: #333; }}
            pre {{ color: #111; }}
          }}
        </style>
      </head>
      <body>
        <div class="shell">
          <section class="hero">
            <div class="eyebrow">Visual Report</div>
            <h1>{task}</h1>
            <div class="meta">
              <div class="pill">Run {run_id}</div>
              <div class="pill">Status {status}</div>
              <div class="pill">Mode {mode}</div>
              <div class="pill">Updated {updated_at}</div>
            </div>
          </section>
          <section class="report"><pre>{safe_output}</pre></section>
        </div>
      </body>
    </html>
    """
    return HTMLResponse(html)


@router.post("/documents/process", response_model=DocumentProcessResponse)
async def process_document(file: UploadFile = File(...)) -> DocumentProcessResponse:
    raw = await file.read()
    return DocumentProcessResponse(**document_service.process(file.filename or "document", file.content_type or "", raw))


@router.get("/runs/{run_id}/events")
async def stream_events(run_id: str) -> StreamingResponse:
    async def event_generator():
        queue = await event_bus.subscribe(run_id)
        try:
            while True:
                msg = await queue.get()
                yield f"data: {json.dumps(msg)}\n\n"
                if msg.get("status") in {"completed", "failed", "degraded"}:
                    break
        finally:
            event_bus.unsubscribe(run_id, queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/runs/{run_id}/memory", response_model=RunMemoryResponse)
async def get_run_memory(run_id: str) -> RunMemoryResponse:
    rec = run_store.get(run_id)
    graph_data = neo4j_service.fetch_run_memory(run_id)
    claims_data = neo4j_service.fetch_run_claims(run_id)
    if not rec and not graph_data.get("thread_id") and not graph_data.get("episodes") and not claims_data.get("claims"):
        raise HTTPException(status_code=404, detail="Run not found")
    state = (rec or {}).get("state") or {}
    thread_id = graph_data.get("thread_id") or state.get("thread_id")
    thread_context = str(state.get("thread_context") or state.get("memory_context") or "").strip() or None
    if not thread_context and thread_id:
        recalled_context = await memory_service.get_thread_context(thread_id)
        thread_context = recalled_context.strip() or None
    return RunMemoryResponse(
        run_id=run_id,
        thread_id=thread_id,
        thread_context=thread_context,
        memory_refs=list(state.get("memory_refs") or []),
        episodes=list(graph_data.get("episodes") or []),
        entities=list(graph_data.get("entities") or []),
        claims=list(claims_data.get("claims") or graph_data.get("claims") or []),
        desktop_artifacts=list(graph_data.get("desktop_artifacts") or state.get("desktop_artifacts") or []),
    )


@router.get("/runs/{run_id}/claims")
async def get_run_claims(run_id: str):
    rec = run_store.get(run_id)
    claims = neo4j_service.fetch_run_claims(run_id)
    if not rec and not claims.get("claims"):
        raise HTTPException(status_code=404, detail="Run not found")
    return claims


@router.get("/runs/{run_id}/shopping", response_model=ShoppingSummaryResponse)
async def get_run_shopping(run_id: str) -> ShoppingSummaryResponse:
    rec = _get_run_or_404(run_id)
    state = rec.get("state") or {}
    tool_results = list(state.get("tool_results") or [])
    search_payload = next(
        (tool.get("payload") for tool in tool_results if tool.get("tool") == "shopping_search" and isinstance(tool.get("payload"), dict)),
        {},
    )
    scout_payload = next(
        (tool.get("payload") for tool in tool_results if tool.get("tool") == "shopping_scout" and isinstance(tool.get("payload"), dict)),
        {},
    )
    sources = [
        ShoppingSource(
            title=str(item.get("title") or ""),
            domain=str(item.get("domain") or ""),
            url=str(item.get("url") or ""),
            trust_score=int(item.get("trust_score") or score_shopping_domain(str(item.get("domain") or ""))[0]),
            price_signal=str(item.get("price_signal") or score_shopping_domain(str(item.get("domain") or ""))[2]) or None,
            marketplace_type=str(item.get("marketplace_type") or score_shopping_domain(str(item.get("domain") or ""))[1]) or None,
        )
        for item in (search_payload.get("results") or [])
        if isinstance(item, dict)
    ]
    return ShoppingSummaryResponse(
        run_id=run_id,
        task=rec.get("task") or "",
        trust_notes=list(scout_payload.get("trust_notes") or []),
        sources=sources,
        risk_flags=list(state.get("critique_flags") or []),
    )


@router.get("/runs/{run_id}/social", response_model=SocialSummaryResponse)
async def get_run_social(run_id: str) -> SocialSummaryResponse:
    rec = _get_run_or_404(run_id)
    state = rec.get("state") or {}
    tool_results = list(state.get("tool_results") or [])

    def _notes(tool_name: str) -> list[str]:
        payload = next(
            (tool.get("payload") for tool in tool_results if tool.get("tool") == tool_name and isinstance(tool.get("payload"), dict)),
            {},
        )
        return [str(item) for item in (payload.get("items") or [])]

    publish_status = [
        {
            "tool": tool.get("tool"),
            "platform": (tool.get("payload") or {}).get("platform"),
            "executed": bool((tool.get("payload") or {}).get("executed")),
            "simulated": bool((tool.get("payload") or {}).get("simulated", True)),
        }
        for tool in tool_results
        if str(tool.get("tool", "")).endswith("_publish")
    ]
    platforms = [
        SocialPlatformPlan(platform="X", notes=_notes("x_strategy"), live_ready=bool(settings.x_publish_webhook_url)),
        SocialPlatformPlan(platform="LinkedIn", notes=_notes("linkedin_strategy"), live_ready=bool(settings.linkedin_publish_webhook_url)),
        SocialPlatformPlan(platform="Instagram", notes=_notes("instagram_strategy"), live_ready=bool(settings.instagram_publish_webhook_url)),
    ]
    return SocialSummaryResponse(
        run_id=run_id,
        task=rec.get("task") or "",
        platforms=platforms,
        scheduling_notes=_notes("schedule_planner"),
        publish_status=publish_status,
        approvals=[ApprovalItem(**item) for item in _get_approvals(state) if item.get("kind") == "social_post"],
    )


@router.get("/runs/{run_id}/approvals")
async def get_run_approvals(run_id: str):
    rec = _get_run_or_404(run_id)
    return {"run_id": run_id, "approvals": _get_approvals(rec.get("state") or {})}


@router.post("/runs/{run_id}/shopping/queue")
async def queue_shopping_lead(run_id: str, payload: dict):
    rec = _get_run_or_404(run_id)
    url = str(payload.get("url") or "").strip()
    title = str(payload.get("title") or url).strip()
    domain = str(payload.get("domain") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    trust_score, marketplace_type, price_signal = score_shopping_domain(domain)
    approval_id = f"approval-{uuid4()}"
    now = _utc_now()
    approval = {
        "approval_id": approval_id,
        "kind": "shopping_lead",
        "title": title,
        "status": "queued",
        "platform": None,
        "url": url,
        "message": None,
        "notes": [
            f"trust {trust_score}",
            marketplace_type,
            price_signal,
        ],
        "executed": False,
        "simulated": True,
        "created_at": now,
        "updated_at": now,
    }

    def transform(state: dict) -> dict:
        approvals = _get_approvals(state)
        if any(item.get("kind") == "shopping_lead" and item.get("url") == url and item.get("status") == "queued" for item in approvals):
            return state
        state["approvals"] = approvals + [approval]
        return state

    updated = run_store.update_state(run_id, transform)
    return {"run_id": run_id, "approval": approval, "approvals": _get_approvals(updated.get("state") or {})}


@router.post("/runs/{run_id}/social/queue")
async def queue_social_post(run_id: str, payload: dict):
    rec = _get_run_or_404(run_id)
    platform = str(payload.get("platform") or "").strip()
    message = str(payload.get("message") or "").strip()
    if not platform or not message:
        raise HTTPException(status_code=400, detail="platform and message are required")
    approval_id = f"approval-{uuid4()}"
    now = _utc_now()
    approval = {
        "approval_id": approval_id,
        "kind": "social_post",
        "title": f"{platform} post",
        "status": "queued",
        "platform": platform,
        "url": None,
        "message": message,
        "notes": ["Queued for operator approval before publish"],
        "executed": False,
        "simulated": True,
        "created_at": now,
        "updated_at": now,
    }

    def transform(state: dict) -> dict:
        approvals = _get_approvals(state)
        state["approvals"] = approvals + [approval]
        return state

    updated = run_store.update_state(run_id, transform)
    return {"run_id": run_id, "approval": approval, "approvals": _get_approvals(updated.get("state") or {})}


@router.post("/runs/{run_id}/approvals/{approval_id}")
async def resolve_approval(run_id: str, approval_id: str, payload: dict):
    rec = _get_run_or_404(run_id)
    state = rec.get("state") or {}
    action = str(payload.get("action") or "").strip().lower()
    mode = str(payload.get("mode") or rec.get("mode") or "simulation")
    approvals = _get_approvals(state)
    approval = next((item for item in approvals if item.get("approval_id") == approval_id), None)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval not found")
    if action not in {"approve", "reject"}:
        raise HTTPException(status_code=400, detail="action must be approve or reject")

    updated = dict(approval)
    updated["status"] = "approved" if action == "approve" else "rejected"
    updated["updated_at"] = _utc_now()
    updated["executed"] = False
    updated["simulated"] = True

    if action == "approve" and approval.get("kind") == "social_post":
        platform = str(approval.get("platform") or "").strip().lower()
        tool = {
            "x": X_PUBLISH_TOOL,
            "linkedin": LINKEDIN_PUBLISH_TOOL,
            "instagram": INSTAGRAM_PUBLISH_TOOL,
        }.get(platform)
        if tool:
            result = await tool.run(str(approval.get("message") or ""), mode)
            updated["executed"] = bool(result.payload.get("executed"))
            updated["simulated"] = bool(result.payload.get("simulated", True))
            updated["notes"] = list(updated.get("notes") or []) + [
                "Live publish executed" if updated["executed"] else "Approved and retained in simulation mode",
            ]

    saved = run_store.update_state(run_id, lambda current: _replace_approval(current, approval_id, updated))
    return {"run_id": run_id, "approval": updated, "approvals": _get_approvals(saved.get("state") or {})}


@router.get("/github/status")
async def get_github_status():
    return github_ops_service.status()


@router.post("/github/approvals/sync")
async def sync_github_approval(payload: dict):
    run_id = str(payload.get("run_id") or "").strip()
    approval_id = str(payload.get("approval_id") or "").strip()
    if not run_id or not approval_id:
        raise HTTPException(status_code=400, detail="run_id and approval_id are required")
    rec = _get_run_or_404(run_id)
    approval = next((item for item in _get_approvals(rec.get("state") or {}) if item.get("approval_id") == approval_id), None)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval not found")
    body = (
        f"Run: `{run_id}`\n\n"
        f"Kind: `{approval.get('kind')}`\n"
        f"Status: `{approval.get('status')}`\n"
        f"Title: {approval.get('title')}\n"
        f"Platform: {approval.get('platform') or 'n/a'}\n"
        f"URL: {approval.get('url') or 'n/a'}\n\n"
        "Notes:\n"
        + "\n".join(f"- {note}" for note in approval.get("notes", []))
    )
    try:
        issue = await github_ops_service.create_issue(
            title=f"Approval · {approval.get('title')}",
            body=body,
            labels=["approval", str(approval.get("kind") or "approval")],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"issue": issue}


@router.post("/github/schedules/sync")
async def sync_github_schedule(payload: dict):
    schedule_id = str(payload.get("schedule_id") or "").strip()
    if not schedule_id:
        raise HTTPException(status_code=400, detail="schedule_id is required")
    schedule = desktop_schedule_service.get(schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    body = (
        f"Schedule: `{schedule_id}`\n\n"
        f"Workflow: `{schedule.get('workflow_kind')}`\n"
        f"Agent: `{schedule.get('agent_id')}`\n"
        f"Mode: `{schedule.get('mode')}`\n"
        f"Approval required: `{schedule.get('approval_required')}`\n"
        f"Cadence: {schedule.get('cadence_label')}\n"
        f"Next run: {schedule.get('next_run_at') or 'n/a'}\n"
        f"Last status: {schedule.get('last_run_status') or 'n/a'}\n"
    )
    try:
        issue = await github_ops_service.create_issue(
            title=f"Schedule · {schedule.get('name')}",
            body=body,
            labels=["schedule", str(schedule.get("workflow_kind") or "desktop-workflow")],
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"issue": issue}


@router.post("/github/pr-review")
async def create_github_pr_review(payload: dict):
    pr_number = int(payload.get("pr_number") or 0)
    run_id = str(payload.get("run_id") or "").strip()
    if pr_number <= 0:
        raise HTTPException(status_code=400, detail="pr_number is required")
    rec = _get_run_or_404(run_id) if run_id else None
    state = rec.get("state") if rec else {}
    body = (
        "Automated review from the KG multi-agent system.\n\n"
        f"Run: `{run_id or 'n/a'}`\n"
        f"Status: `{rec.get('status') if rec else 'n/a'}`\n\n"
        "Critic flags:\n"
        + "\n".join(f"- {flag}" for flag in (state.get('critique_flags') or ['No critic flags']))
        + "\n\nKey notes:\n"
        + "\n".join(f"- {note}" for note in (state.get('research_notes') or [])[:6])
    )
    try:
        review = await github_ops_service.review_pull_request(pr_number=pr_number, body=body, event="COMMENT")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"review": review}


@router.post("/runs/{run_id}/social/publish")
async def publish_social(run_id: str, payload: dict):
    rec = _get_run_or_404(run_id)
    platform = str(payload.get("platform") or "").strip().lower()
    message = str(payload.get("message") or (rec.get("output") or "")).strip()
    mode = str(payload.get("mode") or rec.get("mode") or "simulation")
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    tool = {
        "x": X_PUBLISH_TOOL,
        "linkedin": LINKEDIN_PUBLISH_TOOL,
        "instagram": INSTAGRAM_PUBLISH_TOOL,
    }.get(platform)
    if not tool:
        raise HTTPException(status_code=400, detail="unsupported platform")
    result = await tool.run(message, mode)
    return {"run_id": run_id, "platform": platform, "result": result.payload, "ok": result.ok, "error": result.error}


@router.get("/threads/{thread_id}", response_model=ThreadDetailResponse)
async def get_thread_detail(thread_id: str) -> ThreadDetailResponse:
    lineage = neo4j_service.fetch_thread_lineage(thread_id)
    context = await memory_service.get_thread_context(thread_id)
    messages = await memory_service.get_thread_messages(thread_id)
    return ThreadDetailResponse(
        thread_id=thread_id,
        user_id=lineage.get("user_id"),
        context=context or None,
        messages=messages,
        episodes=list(lineage.get("episodes") or []),
    )


@router.get("/graph")
async def graph(
    limit: int = 100,
    run_id: str | None = None,
    thread_id: str | None = None,
    labels: list[str] = Query(default=[]),
):
    return neo4j_service.fetch_graph(limit=limit, run_id=run_id, thread_id=thread_id, labels=labels)


@router.get("/providers/catalog")
async def providers_catalog():
    return available_catalog()


@router.get("/agents/config", response_model=AgentProfilesPayload)
async def get_agent_profiles() -> AgentProfilesPayload:
    return AgentProfilesPayload(agents=agent_profile_service.get_profiles())


@router.put("/agents/config", response_model=AgentProfilesPayload)
async def update_agent_profiles(payload: AgentProfileUpdatePayload) -> AgentProfilesPayload:
    updates = {k: v.model_dump(exclude_none=True) for k, v in payload.agents.items()}
    updated = agent_profile_service.update_profiles(updates)
    return AgentProfilesPayload(agents=updated)


@router.get("/local-apps/catalog")
async def get_local_apps_catalog():
    return {"apps": local_app_service.get_catalog()}


@router.get("/secretary/status")
async def get_secretary_status():
    return secretary_service.status()


@router.get("/secretary/contacts")
async def get_secretary_contacts():
    return {"contacts": secretary_service.list_contacts()}


@router.post("/secretary/contacts")
async def save_secretary_contact(payload: dict):
    try:
        contact = secretary_service.save_contact(payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"contact": contact}


@router.post("/secretary/dispatch")
async def dispatch_secretary_action(payload: dict):
    channel = str(payload.get("channel") or "").strip().lower()
    to = str(payload.get("to") or "").strip()
    message = str(payload.get("message") or "").strip()
    subject = str(payload.get("subject") or "").strip()
    mode = str(payload.get("mode") or "simulation").strip().lower()
    provider = str(payload.get("provider") or "auto").strip().lower()
    contact_id = str(payload.get("contact_id") or "").strip()
    if channel not in {"auto", "call", "sms", "email", "telegram"}:
        raise HTTPException(status_code=400, detail="channel must be auto, call, sms, email, or telegram")
    if not message:
        raise HTTPException(status_code=400, detail="message is required")
    if not contact_id and channel != "telegram" and not to and channel != "auto":
        raise HTTPException(status_code=400, detail="to is required unless you select a saved contact")
    if provider not in {"auto", "twilio", "telnyx", "sendgrid", "telegram"}:
        raise HTTPException(status_code=400, detail="provider must be auto, twilio, telnyx, sendgrid, or telegram")

    try:
        if contact_id:
            channel, provider, to = secretary_service.resolve_contact_dispatch(contact_id, channel, provider, to)
        elif channel == "auto":
            raise RuntimeError("channel=auto requires a saved secretary contact.")
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        result = await secretary_service.dispatch(
            channel=channel,
            to=to,
            message=message,
            subject=subject,
            mode=mode,
            provider=provider,
            contact_id=contact_id,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return result


@router.get("/desktop/status")
async def get_desktop_status():
    return desktop_automation_service.status()


@router.get("/desktop/bridge/status")
async def get_desktop_bridge_status():
    return desktop_automation_service.bridge_status()


@router.post("/desktop/bridge/test")
async def test_desktop_bridge():
    return desktop_automation_service.test_bridge()


@router.get("/desktop/bridge/diagnostics")
async def get_desktop_bridge_diagnostics():
    return desktop_automation_service.bridge_diagnostics()


@router.post("/desktop/bridge/test/{kind}")
async def test_desktop_bridge_kind(kind: str):
    result = desktop_automation_service.run_bridge_check(kind)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=str(result.get("detail") or "Bridge check failed"))
    return result


@router.get("/google/oauth/status")
async def google_oauth_status():
    return google_workspace_service.status()


@router.post("/google/oauth/start")
async def google_oauth_start():
    try:
        return google_workspace_service.begin_oauth()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/google/oauth/callback", response_class=HTMLResponse)
async def google_oauth_callback(code: str | None = None, state: str | None = None, error: str | None = None):
    if error:
        return HTMLResponse(f"<html><body><h1>Google connection failed</h1><p>{error}</p></body></html>", status_code=400)
    if not code or not state:
        return HTMLResponse("<html><body><h1>Missing Google OAuth parameters</h1></body></html>", status_code=400)
    try:
        google_workspace_service.finish_oauth(code, state)
    except Exception as exc:
        return HTMLResponse(f"<html><body><h1>Google connection failed</h1><p>{exc}</p></body></html>", status_code=400)
    return HTMLResponse(
        "<html><body><h1>Google Workspace connected</h1><p>You can close this window and return to the app.</p>"
        "<script>setTimeout(() => window.close(), 1200);</script></body></html>"
    )


@router.post("/google/oauth/disconnect")
async def google_oauth_disconnect():
    google_workspace_service.disconnect()
    return {"ok": True}


@router.get("/desktop/actions")
async def get_desktop_actions(run_id: str | None = None):
    return {"actions": desktop_automation_service.list_actions(run_id=run_id)}


@router.get("/desktop/schedules")
async def get_desktop_schedules():
    return {"schedules": desktop_schedule_service.list()}


@router.get("/desktop/schedules/presets")
async def get_desktop_schedule_presets():
    return desktop_schedule_service.presets()


@router.post("/desktop/schedules")
async def upsert_desktop_schedule(payload: dict):
    schedule = desktop_schedule_service.upsert(payload)
    neo4j_service.upsert_schedule(
        schedule["schedule_id"],
        name=schedule["name"],
        workflow_kind=schedule["workflow_kind"],
        agent_id=schedule["agent_id"],
        enabled=bool(schedule["enabled"]),
        mode=str(schedule["mode"]),
        approval_required=bool(schedule["approval_required"]),
        cadence_label=str(schedule["cadence_label"]),
        output_preset=str(schedule.get("output_preset") or "custom"),
        output_subdir=str(schedule.get("output_subdir") or ""),
        template_preset=str(schedule.get("template_preset") or "none"),
        prompt_template=str(schedule.get("prompt_template") or ""),
        content_template=str(schedule.get("content_template") or ""),
        last_run_status=str(schedule.get("last_run_status") or ""),
        next_run_at=str(schedule.get("next_run_at") or ""),
    )
    return {"schedule": schedule, "schedules": desktop_schedule_service.list()}


@router.post("/desktop/schedules/{schedule_id}/clone")
async def clone_desktop_schedule(schedule_id: str):
    try:
        schedule = desktop_schedule_service.clone(schedule_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Schedule not found")
    neo4j_service.upsert_schedule(
        schedule["schedule_id"],
        name=schedule["name"],
        workflow_kind=schedule["workflow_kind"],
        agent_id=schedule["agent_id"],
        enabled=bool(schedule["enabled"]),
        mode=str(schedule["mode"]),
        approval_required=bool(schedule["approval_required"]),
        cadence_label=str(schedule["cadence_label"]),
        output_preset=str(schedule.get("output_preset") or "custom"),
        output_subdir=str(schedule.get("output_subdir") or ""),
        template_preset=str(schedule.get("template_preset") or "none"),
        prompt_template=str(schedule.get("prompt_template") or ""),
        content_template=str(schedule.get("content_template") or ""),
        last_run_status=str(schedule.get("last_run_status") or ""),
        next_run_at=str(schedule.get("next_run_at") or ""),
    )
    return {"schedule": schedule, "schedules": desktop_schedule_service.list()}


@router.post("/desktop/schedules/{schedule_id}/pause")
async def pause_desktop_schedule(schedule_id: str):
    try:
        schedule = desktop_schedule_service.set_enabled(schedule_id, False)
    except KeyError:
        raise HTTPException(status_code=404, detail="Schedule not found")
    neo4j_service.upsert_schedule(
        schedule["schedule_id"],
        name=schedule["name"],
        workflow_kind=schedule["workflow_kind"],
        agent_id=schedule["agent_id"],
        enabled=bool(schedule["enabled"]),
        mode=str(schedule["mode"]),
        approval_required=bool(schedule["approval_required"]),
        cadence_label=str(schedule["cadence_label"]),
        output_preset=str(schedule.get("output_preset") or "custom"),
        output_subdir=str(schedule.get("output_subdir") or ""),
        template_preset=str(schedule.get("template_preset") or "none"),
        prompt_template=str(schedule.get("prompt_template") or ""),
        content_template=str(schedule.get("content_template") or ""),
        last_run_status=str(schedule.get("last_run_status") or ""),
        next_run_at=str(schedule.get("next_run_at") or ""),
    )
    return {"schedule": schedule, "schedules": desktop_schedule_service.list()}


@router.post("/desktop/schedules/{schedule_id}/resume")
async def resume_desktop_schedule(schedule_id: str):
    try:
        schedule = desktop_schedule_service.set_enabled(schedule_id, True)
    except KeyError:
        raise HTTPException(status_code=404, detail="Schedule not found")
    neo4j_service.upsert_schedule(
        schedule["schedule_id"],
        name=schedule["name"],
        workflow_kind=schedule["workflow_kind"],
        agent_id=schedule["agent_id"],
        enabled=bool(schedule["enabled"]),
        mode=str(schedule["mode"]),
        approval_required=bool(schedule["approval_required"]),
        cadence_label=str(schedule["cadence_label"]),
        output_preset=str(schedule.get("output_preset") or "custom"),
        output_subdir=str(schedule.get("output_subdir") or ""),
        template_preset=str(schedule.get("template_preset") or "none"),
        prompt_template=str(schedule.get("prompt_template") or ""),
        content_template=str(schedule.get("content_template") or ""),
        last_run_status=str(schedule.get("last_run_status") or ""),
        next_run_at=str(schedule.get("next_run_at") or ""),
    )
    return {"schedule": schedule, "schedules": desktop_schedule_service.list()}


@router.delete("/desktop/schedules/{schedule_id}")
async def delete_desktop_schedule(schedule_id: str):
    try:
        desktop_schedule_service.delete(schedule_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Schedule not found")
    neo4j_service.delete_schedule(schedule_id)
    return {"ok": True, "schedules": desktop_schedule_service.list()}


@router.post("/desktop/schedules/dispatch")
async def dispatch_desktop_schedules():
    return {"dispatched": await desktop_schedule_runner.dispatch_due()}


@router.post("/desktop/schedules/{schedule_id}/approve")
async def approve_desktop_schedule_run(schedule_id: str):
    schedules = {item["schedule_id"]: item for item in desktop_schedule_service.list()}
    schedule = schedules.get(schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    action_id = str(schedule.get("last_action_id") or "").strip()
    run_id = str(schedule.get("last_run_id") or "").strip()
    if not action_id or not run_id:
        raise HTTPException(status_code=400, detail="Schedule has no pending action to approve")
    action = desktop_automation_service.execute(action_id)
    await ingest_desktop_action(action)
    final_status = str(action.get("status") or "completed")
    error = str(action.get("last_error") or "")
    updated = desktop_schedule_service.mark_run_result(schedule_id, run_id, status=final_status, error=error, action_id=action_id)
    neo4j_service.upsert_schedule(
        schedule_id,
        name=updated["name"],
        workflow_kind=updated["workflow_kind"],
        agent_id=updated["agent_id"],
        enabled=bool(updated["enabled"]),
        mode=str(updated["mode"]),
        approval_required=bool(updated["approval_required"]),
        cadence_label=str(updated["cadence_label"]),
        output_preset=str(updated.get("output_preset") or "custom"),
        output_subdir=str(updated.get("output_subdir") or ""),
        template_preset=str(updated.get("template_preset") or "none"),
        prompt_template=str(updated.get("prompt_template") or ""),
        content_template=str(updated.get("content_template") or ""),
        last_run_status=str(updated.get("last_run_status") or ""),
        next_run_at=str(updated.get("next_run_at") or ""),
    )
    run_store.update(run_id, status="completed" if final_status == "completed" else "failed", output=None)
    return {"schedule_id": schedule_id, "action": action, "status": final_status}


@router.post("/desktop/schedules/{schedule_id}/reject")
async def reject_desktop_schedule_run(schedule_id: str):
    schedule = desktop_schedule_service.get(schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="Schedule not found")
    run_id = str(schedule.get("last_run_id") or "").strip()
    action_id = str(schedule.get("last_action_id") or "").strip()
    if not run_id or not action_id or str(schedule.get("last_run_status") or "") != "awaiting_approval":
        raise HTTPException(status_code=400, detail="Schedule has no pending approval to reject")
    updated = desktop_schedule_service.mark_run_result(schedule_id, run_id, status="rejected", error="Operator rejected scheduled live execution.", action_id=action_id)
    neo4j_service.upsert_schedule(
        schedule_id,
        name=updated["name"],
        workflow_kind=updated["workflow_kind"],
        agent_id=updated["agent_id"],
        enabled=bool(updated["enabled"]),
        mode=str(updated["mode"]),
        approval_required=bool(updated["approval_required"]),
        cadence_label=str(updated["cadence_label"]),
        output_preset=str(updated.get("output_preset") or "custom"),
        output_subdir=str(updated.get("output_subdir") or ""),
        template_preset=str(updated.get("template_preset") or "none"),
        prompt_template=str(updated.get("prompt_template") or ""),
        content_template=str(updated.get("content_template") or ""),
        last_run_status=str(updated.get("last_run_status") or ""),
        next_run_at=str(updated.get("next_run_at") or ""),
    )
    run_store.update(run_id, status="failed", state={"error": "Operator rejected scheduled live execution."}, output=None)
    return {"schedule_id": schedule_id, "status": "rejected"}


@router.post("/desktop/actions/writer-doc")
async def create_writer_doc_action(payload: dict):
    run_id = str(payload.get("run_id") or "").strip()
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")
    rec = _get_run_or_404(run_id)
    profiles = agent_profile_service.get_profiles()
    writer = profiles.get("writer", {})
    allowed = set(writer.get("specialist_apps") or [])
    if "microsoft_word" not in allowed and "finder_files" not in allowed:
        raise HTTPException(status_code=400, detail="writer is not configured for Word/Finder desktop actions")
    action = desktop_automation_service.create_action(
        kind="writer_doc",
        agent_id="writer",
        title=str(payload.get("title") or rec.get("task") or "Writer Draft"),
        payload={
            "run_id": run_id,
            "title": str(payload.get("title") or rec.get("task") or "Writer Draft"),
            "content": str(payload.get("content") or rec.get("output") or ""),
            "allowed_apps": list(allowed),
        },
    )
    return {"action": action}


@router.post("/desktop/actions/social-package")
async def create_social_package_action(payload: dict):
    run_id = str(payload.get("run_id") or "").strip()
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")
    rec = _get_run_or_404(run_id)
    profiles = agent_profile_service.get_profiles()
    social = profiles.get("social", {})
    allowed = set(social.get("specialist_apps") or [])
    if not {"finder_files", "ai_influencer_studio"} & allowed:
        raise HTTPException(status_code=400, detail="social is not configured for desktop social package actions")
    action = desktop_automation_service.create_action(
        kind="social_package",
        agent_id="social",
        title=str(payload.get("title") or rec.get("task") or "Social Package"),
        payload={
            "run_id": run_id,
            "title": str(payload.get("title") or rec.get("task") or "Social Package"),
            "message": str(payload.get("message") or rec.get("output") or ""),
            "notes": list(payload.get("notes") or []),
            "allowed_apps": list(allowed),
        },
    )
    return {"action": action}


@router.post("/desktop/actions/gmail-calendar")
async def create_gmail_calendar_action(payload: dict):
    run_id = str(payload.get("run_id") or "").strip()
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")
    _get_run_or_404(run_id)
    profiles = agent_profile_service.get_profiles()
    coordinator = profiles.get("coordinator", {})
    researcher = profiles.get("researcher", {})
    allowed = set(coordinator.get("specialist_apps") or []) | set(researcher.get("specialist_apps") or [])
    if "gmail_calendar" not in allowed:
        raise HTTPException(status_code=400, detail="No agent is configured for Gmail/calendar actions")
    action_type = str(payload.get("action_type") or "snapshot")
    owner = "coordinator"
    if action_type in {"inbox_triage", "draft_reply_suggestions"}:
        owner = "researcher"
    elif action_type in {"agenda_brief", "conflict_scan", "morning_brief"}:
        owner = "coordinator"
    action = desktop_automation_service.create_action(
        kind="gmail_calendar",
        agent_id=owner,
        title=str(payload.get("title") or "Gmail / Calendar Workflow"),
        payload={
            "run_id": run_id,
            "prompt": str(payload.get("prompt") or ""),
            "action_type": action_type,
            "owner_agent": owner,
            "allowed_apps": list(allowed),
        },
    )
    return {"action": action}


@router.post("/desktop/actions/ai-influencer")
async def create_ai_influencer_action(payload: dict):
    run_id = str(payload.get("run_id") or "").strip()
    if not run_id:
        raise HTTPException(status_code=400, detail="run_id is required")
    rec = _get_run_or_404(run_id)
    profiles = agent_profile_service.get_profiles()
    social = profiles.get("social", {})
    allowed = set(social.get("specialist_apps") or [])
    if "ai_influencer_studio" not in allowed:
        raise HTTPException(status_code=400, detail="social is not configured for AI Influencer Studio")
    action = desktop_automation_service.create_action(
        kind="ai_influencer",
        agent_id="social",
        title=str(payload.get("title") or rec.get("task") or "AI Influencer Package"),
        payload={
            "run_id": run_id,
            "title": str(payload.get("title") or rec.get("task") or "AI Influencer Package"),
            "brief": str(payload.get("brief") or rec.get("output") or ""),
            "allowed_apps": list(allowed),
        },
    )
    return {"action": action}


@router.post("/desktop/actions/{action_id}/execute")
async def execute_desktop_action(action_id: str):
    try:
        action = desktop_automation_service.execute(action_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Desktop action not found")
    await ingest_desktop_action(action)
    if str(action.get("kind") or "") == "wellness_checkin" and bool((action.get("payload") or {}).get("outreach_enabled")):
        outreach_results = await secretary_service.dispatch_wellness_outreach(dict(action.get("payload") or {}))
        action.setdefault("payload", {})
        action["payload"]["outreach_results"] = outreach_results
    return {"action": action}


@router.post("/desktop/actions/{action_id}/reveal")
async def reveal_desktop_action(action_id: str):
    actions = {item["action_id"]: item for item in desktop_automation_service.list_actions()}
    action = actions.get(action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Desktop action not found")
    output_path = str(action.get("output_path") or "").strip()
    if not output_path:
        raise HTTPException(status_code=400, detail="Desktop action has no output path")
    try:
        desktop_automation_service.reveal_output(output_path)
        desktop_automation_service.record_followup_action(
            action_id,
            "reveal",
            output_path,
            "host_bridge" if settings.host_automation_base_url else "local_open",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "path": output_path}


@router.post("/desktop/actions/{action_id}/open")
async def open_desktop_action(action_id: str):
    actions = {item["action_id"]: item for item in desktop_automation_service.list_actions()}
    action = actions.get(action_id)
    if not action:
        raise HTTPException(status_code=404, detail="Desktop action not found")
    output_path = str(action.get("output_path") or "").strip()
    if not output_path:
        raise HTTPException(status_code=400, detail="Desktop action has no output path")
    try:
        desktop_automation_service.open_output(output_path)
        desktop_automation_service.record_followup_action(
            action_id,
            "open",
            output_path,
            "host_bridge" if settings.host_automation_base_url else "local_open",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "path": output_path}


@router.get("/health")
async def health():
    catalog = available_catalog()
    provider_state = {p["id"]: ("enabled" if p.get("enabled") else "disabled") for p in catalog["providers"]}
    secretary_status = secretary_service.status()
    return {
        "status": "ok",
        "app": settings.app_name,
        "dependencies": {
            "neo4j": "configured",
            "redis": settings.redis_url,
            "postgres": settings.postgres_dsn,
            "zep": "enabled" if settings.zep_api_key else "disabled",
            **provider_state,
            "huggingface_hub": "enabled" if huggingface_service.hub_enabled() else "disabled",
            "transformers_local": "enabled" if huggingface_service.transformers_enabled() else "disabled",
            "optimum": "enabled" if huggingface_service.optimum_enabled() else "disabled",
            "parler_tts": "enabled" if huggingface_service.inference_enabled() else "disabled",
            "elevenlabs": "enabled" if settings.elevenlabs_api_key else "disabled",
            "secretary_calls": "enabled" if secretary_status.get("channel_status", {}).get("call") else "disabled",
            "secretary_sms": "enabled" if secretary_status.get("channel_status", {}).get("sms") else "disabled",
            "secretary_email": "enabled" if secretary_status.get("channel_status", {}).get("email") else "disabled",
            "secretary_telegram": "enabled" if secretary_status.get("channel_status", {}).get("telegram") else "disabled",
        },
    }


@router.get("/ops/inbox", response_model=OperatorInboxResponse)
async def get_operator_inbox(limit: int = 40) -> OperatorInboxResponse:
    return OperatorInboxResponse(**operator_inbox_service.get_inbox(limit=limit))


@router.get("/hf/status")
async def huggingface_status():
    return huggingface_service.status()


@router.get("/hf/models")
async def huggingface_models(query: str = "", limit: int = 8, task: str | None = None):
    try:
        return await huggingface_service.search_models(query=query, limit=limit, task=task)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/hf/datasets")
async def huggingface_datasets(query: str = "", limit: int = 8):
    try:
        return await huggingface_service.search_datasets(query=query, limit=limit)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/hf/spaces")
async def huggingface_spaces(query: str = "", limit: int = 8):
    try:
        return await huggingface_service.search_spaces(query=query, limit=limit)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/runs/{run_id}/speech")
async def run_speech(
    run_id: str,
    agent_id: str = "writer",
    provider: str | None = None,
    voice: str | None = None,
    premium_voice_id: str | None = None,
    fmt: str = "mp3",
    profile: str = "natural",
    persona: str | None = None,
):
    rec = run_store.get(run_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Run not found")

    state = rec.get("state") or {}
    raw = state.get("spoken_response") or rec.get("output") or rec.get("task")
    text = str(raw or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="No speech text available for this run")

    safe_text = text[:1300]
    profile_data = agent_profile_service.get_profile(agent_id)
    resolved_provider = provider or settings.tts_provider_default
    resolved_voice = voice or profile_data.get("speech_voice")
    resolved_profile = profile or profile_data.get("speech_style", "natural")
    resolved_persona = persona or profile_data.get("speech_persona", "")
    resolved_premium_voice = premium_voice_id or profile_data.get("premium_voice_id")

    try:
        audio = await tts_service.synthesize(
            safe_text,
            provider=resolved_provider,
            voice=resolved_voice,
            audio_format=fmt,
            speech_profile=resolved_profile,
            persona=resolved_persona,
            premium_voice_id=resolved_premium_voice,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if resolved_provider == "parler":
        media_type = "audio/flac"
    else:
        media_type = "audio/mpeg" if fmt == "mp3" else "audio/wav"
    return Response(content=audio, media_type=media_type, headers={"Cache-Control": "no-store"})


@router.post("/tts/test")
async def test_tts(payload: dict):
    text = str(payload.get("text") or "").strip() or "Hello. This is a voice test."
    agent_id = str(payload.get("agent_id") or "writer").strip() or "writer"
    provider = str(payload.get("provider") or settings.tts_provider_default).strip() or settings.tts_provider_default
    voice = str(payload.get("voice") or "").strip() or None
    premium_voice_id = str(payload.get("premium_voice_id") or "").strip() or None
    profile = str(payload.get("profile") or "natural").strip() or "natural"
    persona = str(payload.get("persona") or "").strip()
    fmt = str(payload.get("fmt") or "mp3").strip() or "mp3"

    profile_data = agent_profile_service.get_profile(agent_id)
    resolved_voice = voice or profile_data.get("speech_voice")
    resolved_profile = profile or profile_data.get("speech_style", "natural")
    resolved_persona = persona or profile_data.get("speech_persona", "")
    resolved_premium_voice = premium_voice_id or profile_data.get("premium_voice_id")

    try:
        audio = await tts_service.synthesize(
            text[:800],
            provider=provider,
            voice=resolved_voice,
            audio_format=fmt,
            speech_profile=resolved_profile,
            persona=resolved_persona,
            premium_voice_id=resolved_premium_voice,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    media_type = "audio/flac" if provider == "parler" else ("audio/mpeg" if fmt == "mp3" else "audio/wav")
    return Response(content=audio, media_type=media_type, headers={"Cache-Control": "no-store"})
