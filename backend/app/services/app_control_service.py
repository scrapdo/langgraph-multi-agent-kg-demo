"""Thin service that routes app-control commands to the macOS host bridge.

The host bridge (``host_bridge/server.py``) exposes authenticated endpoints for
controlling local apps (Spotify, Messages, Mail, Calendar). This service is the
single integration point used by the graph, specialists, and the delegator tool
dispatcher — so security validation, logging, and action schemas live in one
place.

Every action is dispatched by ``(app, action)`` pair. New actions are added by
registering them in ``_ACTIONS``.
"""

from __future__ import annotations

from typing import Any, Callable

import httpx

from app.core.config import settings


class AppControlError(RuntimeError):
    """Raised when the host bridge is unavailable or rejects a request."""


# A single dispatcher entry describes how an (app, action) pair maps onto a
# host-bridge HTTP call. Keeps the catalog inspectable and enum-able.
_Dispatcher = Callable[[dict[str, Any]], tuple[str, dict[str, Any] | None]]


def _noop_args(args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    return "", None


def _spotify_play(_args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    return "/spotify/play", None


def _spotify_pause(_args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    return "/spotify/pause", None


def _spotify_next(_args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    return "/spotify/next", None


def _spotify_previous(_args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    return "/spotify/previous", None


def _spotify_now_playing(_args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    return "/spotify/now-playing", None


def _spotify_play_query(args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    query = str(args.get("query") or "").strip()
    if not query:
        raise AppControlError("spotify.play_query requires a 'query' argument.")
    return "/spotify/play-query", {"query": query}


def _messages_send(args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    to = str(args.get("to") or "").strip()
    body = str(args.get("body") or "").strip()
    if not to or not body:
        raise AppControlError("messages.send requires 'to' and 'body' arguments.")
    return "/messages/send", {"to": to, "body": body}


def _mail_compose(args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    to = str(args.get("to") or "").strip()
    subject = str(args.get("subject") or "").strip()
    body = str(args.get("body") or "").strip()
    if not to or not subject or not body:
        raise AppControlError("mail.compose requires 'to', 'subject', and 'body' arguments.")
    send_flag = bool(args.get("send"))
    return "/mail/compose", {"to": to, "subject": subject, "body": body, "send": send_flag}


def _calendar_list_today(_args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    return "/calendar/list-today", None


def _calendar_create(args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    # Accept several field-name variants an LLM might emit.
    title = str(
        args.get("title")
        or args.get("summary")
        or args.get("name")
        or args.get("event")
        or ""
    ).strip()
    start_iso = str(
        args.get("start_iso")
        or args.get("start")
        or args.get("startDate")
        or args.get("start_date")
        or args.get("startTime")
        or args.get("start_time")
        or args.get("begin")
        or ""
    ).strip()
    end_iso = str(
        args.get("end_iso")
        or args.get("end")
        or args.get("endDate")
        or args.get("end_date")
        or args.get("endTime")
        or args.get("end_time")
        or ""
    ).strip()
    notes = str(args.get("notes") or args.get("description") or args.get("body") or "").strip()
    calendar = str(args.get("calendar") or args.get("calendar_name") or "").strip()

    missing: list[str] = []
    if not title:
        missing.append("title")
    if not start_iso:
        missing.append("start_iso")
    if not end_iso:
        missing.append("end_iso")
    if missing:
        raise AppControlError(
            f"calendar.create requires {', '.join(missing)} "
            f"(got: {sorted(args.keys())})"
        )
    return "/calendar/create", {
        "title": title,
        "start_iso": start_iso,
        "end_iso": end_iso,
        "notes": notes,
        "calendar": calendar,
    }


_ACTIONS: dict[tuple[str, str], _Dispatcher] = {
    ("spotify", "play"): _spotify_play,
    ("spotify", "pause"): _spotify_pause,
    ("spotify", "next"): _spotify_next,
    ("spotify", "previous"): _spotify_previous,
    ("spotify", "now_playing"): _spotify_now_playing,
    ("spotify", "play_query"): _spotify_play_query,
    ("messages", "send"): _messages_send,
    ("mail", "compose"): _mail_compose,
    ("calendar", "list_today"): _calendar_list_today,
    ("calendar", "create"): _calendar_create,
}


def list_actions() -> list[dict[str, str]]:
    """Return a catalog of (app, action) pairs for schema emission."""
    return [{"app": app, "action": action} for (app, action) in sorted(_ACTIONS.keys())]


class AppControlService:
    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if settings.host_automation_token:
            headers["Authorization"] = f"Bearer {settings.host_automation_token}"
        return headers

    def _base_url(self) -> str:
        base = (settings.host_automation_base_url or "").strip()
        if not base:
            raise AppControlError(
                "Host bridge is not configured. Set HOST_AUTOMATION_BASE_URL + "
                "HOST_AUTOMATION_TOKEN on the backend."
            )
        return base.rstrip("/")

    async def execute(self, app_name: str, action: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        app_clean = app_name.lower().strip()
        action_clean = action.lower().strip()
        # Delegator LLMs sometimes emit the full dotted form as `action`
        # (e.g. action="calendar.create" when we want action="create").
        # Strip the app prefix so both shapes work.
        if "." in action_clean:
            prefix, remainder = action_clean.split(".", 1)
            if prefix == app_clean:
                action_clean = remainder
        key = (app_clean, action_clean)
        dispatcher = _ACTIONS.get(key)
        if not dispatcher:
            raise AppControlError(f"Unknown action: {app_clean}.{action_clean}")
        path, body = dispatcher(args or {})
        url = f"{self._base_url()}{path}"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(url, headers=self._headers(), json=body or {})
        except httpx.HTTPError as exc:
            raise AppControlError(f"Host bridge unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise AppControlError(
                f"Host bridge {response.status_code}: {response.text[:300]}"
            )
        try:
            return response.json()
        except Exception:
            return {"ok": True, "raw": response.text[:1000]}


app_control_service = AppControlService()
