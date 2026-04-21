from __future__ import annotations

import json
import re
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

import httpx

from app.core.config import settings


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).isoformat()


def _extract(pattern: str, html: str) -> str:
    match = re.search(pattern, html, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    text = re.sub(r"\s+", " ", match.group(1)).strip()
    return text[:500]


class BrowserAutomationService:
    def __init__(self, store_path: str) -> None:
        self.store_path = Path(store_path)
        self._lock = Lock()
        self._loaded = False
        self._data: dict[str, dict[str, Any]] = {}

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        if self.store_path.exists():
            try:
                raw = json.loads(self.store_path.read_text())
                if isinstance(raw, dict):
                    self._data = raw
            except Exception:
                self._data = {}
        self._loaded = True

    def _flush(self) -> None:
        tmp = self.store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2, sort_keys=True))
        tmp.replace(self.store_path)

    async def inspect_url(self, url: str) -> dict[str, Any]:
        async with httpx.AsyncClient(
            timeout=20,
            follow_redirects=True,
            verify=settings.browser_verify_ssl,
            headers={"User-Agent": "Mozilla/5.0 KG-Demo BrowserOps"},
        ) as client:
            response = await client.get(url)
        response.raise_for_status()
        html = response.text
        title = _extract(r"<title[^>]*>(.*?)</title>", html)
        description = _extract(r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']', html)
        h1 = _extract(r"<h1[^>]*>(.*?)</h1>", html)
        links = len(re.findall(r"<a\b", html, flags=re.IGNORECASE))
        return {
            "url": str(response.url),
            "status_code": response.status_code,
            "title": title,
            "description": description,
            "h1": h1,
            "link_count": links,
            "content_type": response.headers.get("content-type", ""),
        }

    def list_workflows(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_loaded()
            rows = list(self._data.values())
            rows.sort(key=lambda item: item.get("updated_at", ""), reverse=True)
            return rows

    def save_workflow(self, payload: dict[str, Any]) -> dict[str, Any]:
        workflow_id = str(payload.get("workflow_id") or f"browser-{uuid4()}")
        record = {
            "workflow_id": workflow_id,
            "name": str(payload.get("name") or "Browser Workflow"),
            "agent_id": str(payload.get("agent_id") or "researcher"),
            "mode": str(payload.get("mode") or "live"),
            "start_url": str(payload.get("start_url") or ""),
            "urls": [str(item).strip() for item in list(payload.get("urls") or []) if str(item).strip()],
            "goal": str(payload.get("goal") or ""),
            "notes": [str(item) for item in list(payload.get("notes") or [])],
            "last_run_at": str(payload.get("last_run_at") or ""),
            "last_status": str(payload.get("last_status") or ""),
            "created_at": str(payload.get("created_at") or _utc_now()),
            "updated_at": _utc_now(),
        }
        with self._lock:
            self._ensure_loaded()
            existing = self._data.get(workflow_id) or {}
            record["created_at"] = str(existing.get("created_at") or record["created_at"])
            self._data[workflow_id] = record
            self._flush()
            return dict(record)

    async def run_workflow(self, workflow_id: str) -> dict[str, Any]:
        with self._lock:
            self._ensure_loaded()
            workflow = dict(self._data.get(workflow_id) or {})
        if not workflow:
            raise KeyError(workflow_id)
        targets = [workflow.get("start_url", "")] + list(workflow.get("urls") or [])
        seen: set[str] = set()
        deduped: list[str] = []
        for url in targets:
            if not url or url in seen:
                continue
            deduped.append(url)
            seen.add(url)
        results = []
        for url in deduped[:6]:
            try:
                results.append(await self.inspect_url(url))
            except Exception as exc:
                results.append({"url": url, "error": str(exc)})
        status = "completed" if any("title" in item for item in results) else "failed"
        updated = self.save_workflow(
            {
                **workflow,
                "last_run_at": _utc_now(),
                "last_status": status,
            }
        )
        return {"workflow": updated, "results": results}


browser_automation_service = BrowserAutomationService(settings.browser_workflow_store_path)
