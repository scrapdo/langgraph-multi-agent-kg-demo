from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.core.config import settings

try:
    from playwright.async_api import async_playwright
except Exception:  # pragma: no cover - optional runtime
    async_playwright = None


def _utc_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(tz=timezone.utc).isoformat()


PLAYWRIGHT_SCRIPT_PRESETS: list[dict[str, Any]] = [
    {
        "preset_id": "research-headline-scan",
        "name": "Research Headline Scan",
        "agent_id": "researcher",
        "description": "Open a page, let it settle, then extract the main headline and first paragraph.",
        "start_url": "https://example.com",
        "mode": "simulation",
        "approval_required": False,
        "steps": [
            {"action": "wait", "timeout_ms": 1200, "label": "settle"},
            {"action": "extract_text", "selector": "h1", "label": "headline"},
            {"action": "extract_text", "selector": "p", "label": "lead_paragraph"},
        ],
    },
    {
        "preset_id": "shopper-listing-scan",
        "name": "Shopper Listing Scan",
        "agent_id": "shopper",
        "description": "Open a product listing page and extract title plus price-like text from the first result block.",
        "start_url": "https://example.com",
        "mode": "simulation",
        "approval_required": False,
        "steps": [
            {"action": "wait", "timeout_ms": 1600, "label": "wait_for_cards"},
            {"action": "extract_text", "selector": "h1, h2, [data-testid='product-title']", "label": "product_title"},
            {"action": "extract_text", "selector": ".price, [data-testid='price'], [class*='price']", "label": "price_signal"},
        ],
    },
    {
        "preset_id": "social-admin-check",
        "name": "Social Admin Check",
        "agent_id": "social",
        "description": "Open an admin or analytics page and extract the visible title and key KPI card text.",
        "start_url": "https://example.com",
        "mode": "simulation",
        "approval_required": False,
        "steps": [
            {"action": "wait", "timeout_ms": 1500, "label": "wait_for_dashboard"},
            {"action": "extract_text", "selector": "h1, h2", "label": "dashboard_title"},
            {"action": "extract_text", "selector": "[class*='metric'], [class*='card'], [data-testid='metric']", "label": "kpi_snapshot"},
        ],
    },
    {
        "preset_id": "secretary-form-fill",
        "name": "Secretary Form Fill",
        "agent_id": "secretary",
        "description": "Open a booking or contact form, fill a name and message, and pause before submission.",
        "start_url": "https://example.com",
        "mode": "live",
        "approval_required": True,
        "steps": [
            {"action": "wait", "timeout_ms": 1200, "label": "wait_for_form"},
            {"action": "fill", "selector": "input[name='name'], input[type='text']", "value": "Nora", "label": "fill_name"},
            {"action": "fill", "selector": "textarea, input[name='message']", "value": "Hello, I am following up to coordinate scheduling details.", "label": "fill_message"},
        ],
    },
]


class PlaywrightService:
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

    def status(self) -> dict[str, Any]:
        return {
            "playwright_available": async_playwright is not None,
            "headless": settings.playwright_headless,
        }

    def list_presets(self) -> list[dict[str, Any]]:
        return [dict(item) for item in PLAYWRIGHT_SCRIPT_PRESETS]

    def install_presets(self, agent_id: str, preset_ids: list[str] | None = None) -> list[dict[str, Any]]:
        selected = []
        for preset in PLAYWRIGHT_SCRIPT_PRESETS:
            if preset.get("agent_id") != agent_id:
                continue
            if preset_ids and preset.get("preset_id") not in preset_ids:
                continue
            selected.append(preset)
        installed: list[dict[str, Any]] = []
        for preset in selected:
            installed.append(
                self.save_script(
                    {
                        "name": preset["name"],
                        "agent_id": preset["agent_id"],
                        "start_url": preset["start_url"],
                        "steps": preset["steps"],
                        "mode": preset["mode"],
                        "approval_required": preset["approval_required"],
                        "notes": [f"installed_from_preset:{preset['preset_id']}"],
                    }
                )
            )
        return installed

    def list_scripts_for_agent(self, agent_id: str) -> list[dict[str, Any]]:
        return [item for item in self.list_scripts() if item.get("agent_id") == agent_id]

    def delete_script(self, script_id: str) -> None:
        with self._lock:
            self._ensure_loaded()
            if script_id not in self._data:
                raise KeyError(script_id)
            del self._data[script_id]
            self._flush()

    def list_scripts(self) -> list[dict[str, Any]]:
        with self._lock:
            self._ensure_loaded()
            rows = list(self._data.values())
            rows.sort(key=lambda item: item.get("updated_at", ""), reverse=True)
            return rows

    def save_script(self, payload: dict[str, Any]) -> dict[str, Any]:
        script_id = str(payload.get("script_id") or f"playwright-{uuid4()}")
        record = {
            "script_id": script_id,
            "name": str(payload.get("name") or "Browser Script"),
            "agent_id": str(payload.get("agent_id") or "researcher"),
            "start_url": str(payload.get("start_url") or ""),
            "steps": list(payload.get("steps") or []),
            "mode": str(payload.get("mode") or "simulation"),
            "approval_required": bool(payload.get("approval_required", False)),
            "notes": [str(item) for item in list(payload.get("notes") or [])],
            "last_run_at": str(payload.get("last_run_at") or ""),
            "last_status": str(payload.get("last_status") or ""),
            "created_at": str(payload.get("created_at") or _utc_now()),
            "updated_at": _utc_now(),
        }
        with self._lock:
            self._ensure_loaded()
            existing = self._data.get(script_id) or {}
            record["created_at"] = str(existing.get("created_at") or record["created_at"])
            self._data[script_id] = record
            self._flush()
            return dict(record)

    async def run_script(self, script_id: str) -> dict[str, Any]:
        if async_playwright is None:
            raise RuntimeError("Playwright runtime is not installed in the backend container.")
        with self._lock:
            self._ensure_loaded()
            script = dict(self._data.get(script_id) or {})
        if not script:
            raise KeyError(script_id)

        start_url = str(script.get("start_url") or "")
        steps = list(script.get("steps") or [])
        if not start_url:
            raise RuntimeError("Browser script is missing a start_url.")

        results: list[dict[str, Any]] = []
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=settings.playwright_headless)
            page = await browser.new_page()
            try:
                await page.goto(start_url, wait_until="domcontentloaded")
                results.append({"step": "goto", "url": page.url, "title": await page.title()})
                for index, step in enumerate(steps):
                    action = str(step.get("action") or "").strip().lower()
                    selector = str(step.get("selector") or "").strip()
                    value = str(step.get("value") or "")
                    label = str(step.get("label") or f"step-{index + 1}")
                    if action == "click":
                        await page.click(selector)
                        results.append({"step": label, "action": action, "selector": selector, "ok": True})
                    elif action == "fill":
                        await page.fill(selector, value)
                        results.append({"step": label, "action": action, "selector": selector, "ok": True})
                    elif action == "wait":
                        timeout_ms = int(step.get("timeout_ms") or 1200)
                        await page.wait_for_timeout(timeout_ms)
                        results.append({"step": label, "action": action, "timeout_ms": timeout_ms, "ok": True})
                    elif action == "extract_text":
                        text = await page.text_content(selector)
                        results.append({"step": label, "action": action, "selector": selector, "text": (text or "").strip()[:1000]})
                    else:
                        results.append({"step": label, "action": action, "error": "Unsupported action"})
                status = "completed"
            except Exception as exc:
                status = "failed"
                results.append({"step": "error", "error": str(exc)})
            finally:
                await browser.close()

        updated = self.save_script(
            {
                **script,
                "last_run_at": _utc_now(),
                "last_status": status,
            }
        )
        return {"script": updated, "results": results}


playwright_service = PlaywrightService(settings.browser_script_store_path)
