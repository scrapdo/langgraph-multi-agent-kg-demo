from __future__ import annotations

import json
import platform
import shutil
import subprocess
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

import httpx

from app.core.config import settings
from app.services.google_workspace_service import google_workspace_service


def _utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class DesktopAutomationService:
    def __init__(self, store_path: str, output_dir: str) -> None:
        self.store_path = Path(store_path)
        self.output_dir = Path(output_dir)
        self._lock = Lock()
        self._loaded = False
        self._data: dict[str, dict[str, Any]] = {}

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        if self.store_path.exists():
            try:
                raw = json.loads(self.store_path.read_text())
                if isinstance(raw, dict):
                    self._data = raw
            except Exception:
                self._data = {}
        self._loaded = True

    def _flush(self) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.store_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(self._data, indent=2, sort_keys=True))
        tmp_path.replace(self.store_path)

    def status(self) -> dict[str, Any]:
        host_os = platform.system()
        osascript_available = bool(shutil.which("osascript"))
        host_bridge_configured = bool(settings.host_automation_base_url)
        return {
            "host_os": host_os,
            "osascript_available": osascript_available,
            "word_automation_available": host_os == "Darwin" and osascript_available,
            "finder_reveal_available": (host_os == "Darwin" and osascript_available) or host_bridge_configured,
            "output_dir": str(self.output_dir.resolve()),
            "host_bridge_configured": host_bridge_configured,
            "host_bridge_base_url": settings.host_automation_base_url,
            "google_workspace": google_workspace_service.status(),
            "ai_influencer_app_url": settings.ai_influencer_app_url,
            "ai_influencer_app_name": settings.ai_influencer_app_name,
            "ai_influencer_app_path": settings.ai_influencer_app_path,
            "note": "Desktop app control is only available when the backend runs on the macOS host, not inside a Linux container, unless a host automation bridge is configured.",
        }

    def bridge_status(self) -> dict[str, Any]:
        if not settings.host_automation_base_url:
            return {"configured": False, "reachable": False, "detail": "Host automation bridge is not configured."}
        headers = {}
        if settings.host_automation_token:
            headers["Authorization"] = f"Bearer {settings.host_automation_token}"
        try:
            with httpx.Client(timeout=5) as client:
                response = client.get(f"{settings.host_automation_base_url.rstrip('/')}/status", headers=headers)
                response.raise_for_status()
                payload = response.json()
            return {"configured": True, "reachable": True, "detail": "Host bridge reachable.", "payload": payload}
        except Exception as exc:
            return {"configured": True, "reachable": False, "detail": str(exc)}

    def test_bridge(self) -> dict[str, Any]:
        status = self.bridge_status()
        if not status.get("configured"):
            raise RuntimeError("Host automation bridge is not configured.")
        if not status.get("reachable"):
            raise RuntimeError(f"Host automation bridge is not reachable: {status.get('detail')}")
        return {"ok": True, "bridge": status}

    def bridge_diagnostics(self) -> dict[str, Any]:
        return {
            "status": self.bridge_status(),
            "checks": {
                "finder": self.run_bridge_check("finder"),
                "word": self.run_bridge_check("word"),
                "ai_influencer": self.run_bridge_check("ai_influencer"),
            },
        }

    def run_bridge_check(self, kind: str) -> dict[str, Any]:
        status = self.bridge_status()
        if not status.get("configured"):
            return {"kind": kind, "ok": False, "detail": "Host automation bridge is not configured."}
        if not status.get("reachable"):
            return {"kind": kind, "ok": False, "detail": str(status.get("detail") or "Host automation bridge is not reachable.")}

        try:
            if kind == "finder":
                self._run_bridge_finder_test()
                return {"kind": kind, "ok": True, "detail": "Finder reveal test succeeded."}
            if kind == "word":
                self._run_bridge_word_test()
                return {"kind": kind, "ok": True, "detail": "Word open test succeeded."}
            if kind == "ai_influencer":
                self._run_bridge_ai_influencer_test()
                return {"kind": kind, "ok": True, "detail": "AI Influencer launch test succeeded."}
            return {"kind": kind, "ok": False, "detail": "Unknown bridge check."}
        except Exception as exc:
            return {"kind": kind, "ok": False, "detail": str(exc)}

    def list_actions(self, *, run_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_loaded()
            actions = list(self._data.values())
            if run_id:
                actions = [item for item in actions if item.get("payload", {}).get("run_id") == run_id]
            actions.sort(key=lambda item: item.get("created_at", ""), reverse=True)
            return deepcopy(actions)

    def create_action(self, kind: str, agent_id: str, title: str, payload: dict[str, Any]) -> dict[str, Any]:
        record = {
            "action_id": f"desktop-{uuid4()}",
            "kind": kind,
            "agent_id": agent_id,
            "status": "queued",
            "title": title,
            "output_path": None,
            "notes": [],
            "payload": payload,
            "execution_history": [],
            "last_execution_method": None,
            "last_error": None,
            "executed_at": None,
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
        }
        with self._lock:
            self._ensure_loaded()
            self._data[record["action_id"]] = record
            self._flush()
            return deepcopy(record)

    def _update(self, action_id: str, **updates: Any) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            rec = self._data[action_id]
            rec.update(updates)
            rec["updated_at"] = _utc_now()
            self._flush()
            return deepcopy(rec)

    def _append_history(self, action_id: str, entry: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            rec = self._data[action_id]
            history = list(rec.get("execution_history") or [])
            history.append(entry)
            rec["execution_history"] = history[-12:]
            rec["updated_at"] = _utc_now()
            self._flush()
            return deepcopy(rec)

    def _slug(self, value: str) -> str:
        return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-") or "artifact"

    def _write_text_bundle(self, directory: Path, files: dict[str, str]) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (directory / name).write_text(content)

    def _resolve_output_dir(self, bucket: str, payload: dict[str, Any]) -> Path:
        custom = str(payload.get("output_subdir") or "").strip().strip("/")
        target = self.output_dir / bucket
        if custom:
            target = target / custom
        target.mkdir(parents=True, exist_ok=True)
        return target

    def execute(self, action_id: str) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            action = deepcopy(self._data[action_id])

        kind = str(action.get("kind"))
        payload = dict(action.get("payload") or {})

        try:
            if kind == "writer_doc":
                output = self._execute_writer_doc(action, payload)
            elif kind == "social_package":
                output = self._execute_social_package(action, payload)
            elif kind == "gmail_calendar":
                output = self._execute_gmail_calendar(action, payload)
            elif kind == "ai_influencer":
                output = self._execute_ai_influencer(action, payload)
            elif kind == "wellness_checkin":
                output = self._execute_wellness_checkin(action, payload)
            else:
                return self._update(action_id, status="failed", notes=["Unsupported desktop action kind"])
            method = self._execution_method(kind)
            self._append_history(
                action_id,
                {"ts": _utc_now(), "event": "execute", "status": "completed", "method": method, "output_path": str(output)},
            )
            return self._update(
                action_id,
                status="completed",
                output_path=str(output),
                notes=action.get("notes", []),
                last_execution_method=method,
                last_error=None,
                executed_at=_utc_now(),
            )
        except RuntimeError as exc:
            method = self._execution_method(kind)
            self._append_history(action_id, {"ts": _utc_now(), "event": "execute", "status": "blocked", "method": method, "error": str(exc)})
            return self._update(action_id, status="blocked", notes=[str(exc)], last_execution_method=method, last_error=str(exc))
        except Exception as exc:
            method = self._execution_method(kind)
            self._append_history(action_id, {"ts": _utc_now(), "event": "execute", "status": "failed", "method": method, "error": str(exc)})
            return self._update(action_id, status="failed", notes=[str(exc)], last_execution_method=method, last_error=str(exc))

    def _execution_method(self, kind: str) -> str:
        if kind == "gmail_calendar":
            if google_workspace_service.enabled():
                return "google_workspace"
            if settings.gmail_calendar_webhook_url:
                return "webhook"
            return "unconfigured"
        if kind == "ai_influencer":
            if settings.host_automation_base_url and (settings.ai_influencer_app_path or settings.ai_influencer_app_name or settings.ai_influencer_app_url):
                return "host_bridge"
            if settings.ai_influencer_webhook_url:
                return "webhook"
            return "local_package"
        if kind == "writer_doc":
            return "local_package"
        if kind == "social_package":
            return "local_package"
        if kind == "wellness_checkin":
            return "local_package"
        return "unknown"

    def _host_bridge_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if settings.host_automation_token:
            headers["Authorization"] = f"Bearer {settings.host_automation_token}"
        return headers

    def _execute_writer_doc(self, action: dict[str, Any], payload: dict[str, Any]) -> Path:
        title = str(payload.get("title") or action.get("title") or "Writer Draft")
        content = str(payload.get("content") or "")
        slug = self._slug(title)
        target_dir = self._resolve_output_dir("writer", payload)
        md_path = target_dir / f"{slug}.md"
        rtf_path = target_dir / f"{slug}.rtf"
        md_path.write_text(content)
        rtf_content = "{\\rtf1\\ansi\\deff0 " + content.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\par\n") + "}"
        rtf_path.write_text(rtf_content)
        self._try_host_bridge_open_word(str(rtf_path))
        return md_path

    def _execute_social_package(self, action: dict[str, Any], payload: dict[str, Any]) -> Path:
        title = str(payload.get("title") or action.get("title") or "Social Package")
        message = str(payload.get("message") or "")
        notes = payload.get("notes") or []
        slug = self._slug(title)
        directory = self._resolve_output_dir("social", payload) / slug
        self._write_text_bundle(
            directory,
            {
                "post.txt": message,
                "brief.md": "\n".join(["# Social Package", "", f"Title: {title}", "", "## Notes", *[f"- {note}" for note in notes]]),
                "manifest.json": json.dumps(payload, indent=2),
            },
        )
        return directory

    def _execute_gmail_calendar(self, action: dict[str, Any], payload: dict[str, Any]) -> Path | str:
        prompt = str(payload.get("prompt") or action.get("title") or "Gmail / Calendar Workflow")
        slug = self._slug(str(action.get("title") or "gmail-calendar"))
        action_type = str(payload.get("action_type") or "snapshot")
        if google_workspace_service.enabled():
            return google_workspace_service.snapshot(prompt, self._resolve_output_dir("gmail_calendar", payload), slug, action_type=action_type)
        if not settings.gmail_calendar_webhook_url:
            raise RuntimeError(
                "Google Workspace is not configured. Add GOOGLE_WORKSPACE_ACCESS_TOKEN for direct Gmail/Calendar access or configure GMAIL_CALENDAR_WEBHOOK_URL for a connector fallback."
            )
        return self._execute_webhook_action(settings.gmail_calendar_webhook_url, settings.gmail_calendar_bearer_token, payload)

    def _execute_ai_influencer(self, action: dict[str, Any], payload: dict[str, Any]) -> Path | str:
        title = str(payload.get("title") or action.get("title") or "AI Influencer Package")
        slug = self._slug(title)
        directory = self._resolve_output_dir("ai_influencer", payload) / slug
        brief = str(payload.get("brief") or "")
        self._write_text_bundle(
            directory,
            {
                "brief.md": brief,
                "manifest.json": json.dumps(payload, indent=2),
            },
        )
        self._try_host_bridge_open_ai_influencer(str(directory))
        if settings.ai_influencer_webhook_url:
            self._execute_webhook_action(settings.ai_influencer_webhook_url, settings.ai_influencer_bearer_token, payload)
        return directory

    def _execute_wellness_checkin(self, action: dict[str, Any], payload: dict[str, Any]) -> Path:
        title = str(payload.get("title") or action.get("title") or "Wellness Check-in")
        slug = self._slug(title)
        directory = self._resolve_output_dir("wellness", payload) / slug
        message = str(payload.get("message") or "")
        goals = [str(item).strip() for item in (payload.get("goals") or []) if str(item).strip()]
        self._write_text_bundle(
            directory,
            {
                "checkin.md": "\n".join(
                    [
                        "# Wellness Check-in",
                        "",
                        f"Title: {title}",
                        "",
                        "## Message",
                        message or "No message provided.",
                        "",
                        "## Goals",
                        *([f"- {goal}" for goal in goals] or ["- No goals supplied."]),
                    ]
                ),
                "manifest.json": json.dumps(payload, indent=2),
            },
        )
        return directory

    def try_open_in_word(self, path: str) -> dict[str, Any]:
        if platform.system() != "Darwin" or not shutil.which("osascript"):
            raise RuntimeError("Word automation is unavailable because the backend is not running on the macOS host.")
        script = f'''
        tell application "Microsoft Word"
          activate
          open POSIX file "{path}"
        end tell
        '''
        subprocess.run(["osascript", "-e", script], check=True)
        return {"ok": True, "path": path}

    def _try_host_bridge_open_word(self, path: str) -> None:
        if not settings.host_automation_base_url:
            return
        try:
            with httpx.Client(timeout=8) as client:
                client.post(
                    f"{settings.host_automation_base_url.rstrip('/')}/word/open",
                    json={"path": path},
                    headers=self._host_bridge_headers(),
                ).raise_for_status()
        except Exception:
            return

    def _try_host_bridge_reveal_path(self, path: str) -> None:
        if not settings.host_automation_base_url:
            raise RuntimeError("Host automation bridge is not configured.")
        with httpx.Client(timeout=8) as client:
            client.post(
                f"{settings.host_automation_base_url.rstrip('/')}/finder/reveal",
                json={"path": path},
                headers=self._host_bridge_headers(),
            ).raise_for_status()

    def reveal_output(self, path: str) -> None:
        if platform.system() == "Darwin":
            subprocess.run(["open", "-R", path], check=True)
            return
        self._try_host_bridge_reveal_path(path)

    def open_output(self, path: str) -> None:
        if platform.system() == "Darwin":
            subprocess.run(["open", path], check=True)
            return
        self._try_host_bridge_open_path(path)

    def record_followup_action(self, action_id: str, event: str, path: str, method: str) -> dict[str, Any]:
        return self._append_history(action_id, {"ts": _utc_now(), "event": event, "status": "completed", "method": method, "path": path})

    def _try_host_bridge_open_ai_influencer(self, path: str) -> None:
        if not settings.host_automation_base_url:
            return
        with httpx.Client(timeout=8) as client:
            if settings.ai_influencer_app_url:
                client.post(
                    f"{settings.host_automation_base_url.rstrip('/')}/browser/open",
                    json={"url": settings.ai_influencer_app_url},
                    headers=self._host_bridge_headers(),
                ).raise_for_status()
            elif settings.ai_influencer_app_path:
                client.post(
                    f"{settings.host_automation_base_url.rstrip('/')}/app/open-path",
                    json={"path": settings.ai_influencer_app_path},
                    headers=self._host_bridge_headers(),
                ).raise_for_status()
            elif settings.ai_influencer_app_name:
                client.post(
                    f"{settings.host_automation_base_url.rstrip('/')}/app/open",
                    json={"name": settings.ai_influencer_app_name},
                    headers=self._host_bridge_headers(),
                ).raise_for_status()
            else:
                client.post(
                    f"{settings.host_automation_base_url.rstrip('/')}/finder/reveal",
                    json={"path": path},
                    headers=self._host_bridge_headers(),
                ).raise_for_status()

    def _try_host_bridge_open_path(self, path: str) -> None:
        if not settings.host_automation_base_url:
            raise RuntimeError("Host automation bridge is not configured.")
        with httpx.Client(timeout=8) as client:
            client.post(
                f"{settings.host_automation_base_url.rstrip('/')}/path/open",
                json={"path": path},
                headers=self._host_bridge_headers(),
            ).raise_for_status()

    def _run_bridge_finder_test(self) -> None:
        self._try_host_bridge_reveal_path(str(self.output_dir))

    def _run_bridge_word_test(self) -> None:
        target_dir = self.output_dir / "_bridge_tests"
        target_dir.mkdir(parents=True, exist_ok=True)
        rtf_path = target_dir / "word-bridge-check.rtf"
        rtf_path.write_text("{\\rtf1\\ansi Host bridge Word check}")
        headers = self._host_bridge_headers()
        with httpx.Client(timeout=8) as client:
            client.post(
                f"{settings.host_automation_base_url.rstrip('/')}/word/open",
                json={"path": str(rtf_path)},
                headers=headers,
            ).raise_for_status()

    def _run_bridge_ai_influencer_test(self) -> None:
        if not any([settings.ai_influencer_app_url, settings.ai_influencer_app_name, settings.ai_influencer_app_path]):
            raise RuntimeError("AI Influencer app target is not configured.")
        self._try_host_bridge_open_ai_influencer(str(self.output_dir))

    def _execute_webhook_action(self, webhook_url: str, bearer_token: str, payload: dict[str, Any]) -> str:
        if not webhook_url:
            raise RuntimeError("No webhook configured for this desktop integration.")
        headers = {"Content-Type": "application/json"}
        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"
        with httpx.Client(timeout=15) as client:
            response = client.post(webhook_url, json=payload, headers=headers)
            response.raise_for_status()
        return webhook_url


desktop_automation_service = DesktopAutomationService(
    settings.desktop_action_store_path,
    settings.desktop_output_dir,
)
