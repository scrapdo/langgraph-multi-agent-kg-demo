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

import time
from typing import Any, Callable

import httpx

from app.core.config import settings


class AppControlError(RuntimeError):
    """Raised when the host bridge is unavailable or rejects a request."""


# Small in-process cache for read-only host-bridge calls that are slow to
# regenerate (Calendar's AppleScript bridge takes ~20s for today, ~30s for a
# week's range). Keyed by (app, action, hash-of-args). 30 second TTL — short
# enough that stale data never matters in practice (operators rarely act on
# events that just appeared in the last half-minute), long enough that
# follow-up questions in the same conversation are instant.
_CACHE_TTL_SECONDS = 30.0
_CACHEABLE: set[tuple[str, str]] = {
    ("calendar", "list_today"),
    ("calendar", "list_range"),
}
_response_cache: dict[tuple[str, str, str], tuple[float, dict[str, Any]]] = {}


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


def _calendar_list_range(args: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    raw = args.get("days_ahead") or args.get("days") or 7
    try:
        days = int(raw)
    except (TypeError, ValueError):
        days = 7
    days = max(1, min(14, days))
    return "/calendar/list-range", {"days_ahead": days}


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
    ("calendar", "list_range"): _calendar_list_range,
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

        # Calendar provider switch — for the calendar.* actions, route
        # through Google Calendar API (sub-500ms) instead of the macOS
        # host bridge (20-30s) when settings.calendar_provider == "google".
        # Same response shape as the macOS bridge so callers don't care.
        if (
            app_clean == "calendar"
            and (settings.calendar_provider or "macos").strip().lower() == "google"
        ):
            return await self._execute_google_calendar(action_clean, args or {})

        path, body = dispatcher(args or {})

        # Cache slow read-only calls. Body keying is deterministic — sorted
        # repr is enough since we only ship JSON-serializable scalar args.
        cache_key: tuple[str, str, str] | None = None
        if key in _CACHEABLE:
            cache_key = (app_clean, action_clean, repr(sorted((body or {}).items())))
            cached = _response_cache.get(cache_key)
            if cached is not None:
                ts, payload = cached
                if time.monotonic() - ts < _CACHE_TTL_SECONDS:
                    return payload

        url = f"{self._base_url()}{path}"
        try:
            # 90s ceiling — calendar list-range can take ~30s for a 14-day
            # window on Macs with many calendars. Short timeouts here only
            # cause us to abandon successful queries mid-flight.
            async with httpx.AsyncClient(timeout=90) as client:
                response = await client.post(url, headers=self._headers(), json=body or {})
        except httpx.HTTPError as exc:
            raise AppControlError(f"Host bridge unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise AppControlError(
                f"Host bridge {response.status_code}: {response.text[:300]}"
            )
        try:
            payload = response.json()
        except Exception:
            payload = {"ok": True, "raw": response.text[:1000]}
        if cache_key is not None:
            _response_cache[cache_key] = (time.monotonic(), payload)
        return payload

    async def _execute_google_calendar(self, action: str, args: dict[str, Any]) -> dict[str, Any]:
        """Route calendar.* actions through Google Calendar instead of the
        macOS host bridge. Response shape matches the host-bridge endpoints
        so the secretary phone doesn't need to care which provider it is.

        Cache hits land in the same _response_cache (keyed by provider in
        the args repr) so flipping providers mid-session doesn't show stale
        data from the other provider.
        """
        from app.services.google_workspace_service import google_workspace_service
        import asyncio as _asyncio

        # Cache slow read-only calls — Google list endpoints are fast (~200-
        # 500ms) but the cache still helps when an LLM fires the same
        # lookup twice in a turn. Keep TTL identical so flipping providers
        # gives consistent freshness expectations.
        cache_key: tuple[str, str, str] | None = None
        if ("calendar", action) in _CACHEABLE:
            cache_key = (
                "calendar",
                action,
                repr(sorted([("provider", "google")] + list(args.items()))),
            )
            cached = _response_cache.get(cache_key)
            if cached is not None:
                ts, payload = cached
                if time.monotonic() - ts < _CACHE_TTL_SECONDS:
                    return payload

        try:
            if action == "list_today":
                payload = await _asyncio.to_thread(google_workspace_service.list_today_events)
            elif action == "list_range":
                raw = args.get("days_ahead") or args.get("days") or 7
                try:
                    days = int(raw)
                except (TypeError, ValueError):
                    days = 7
                days = max(1, min(14, days))
                payload = await _asyncio.to_thread(google_workspace_service.list_range_events, days)
            elif action == "create":
                # Reuse the same arg-name flexibility the macOS dispatcher
                # has — LLMs emit a variety of field name variants.
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
                if not (title and start_iso and end_iso):
                    raise AppControlError("calendar.create requires title, start_iso, end_iso.")
                payload = await _asyncio.to_thread(
                    google_workspace_service.create_event,
                    title=title,
                    start_iso=start_iso,
                    end_iso=end_iso,
                    notes=notes,
                )
            else:
                raise AppControlError(f"Unsupported calendar action for Google: {action}")
        except RuntimeError as exc:
            raise AppControlError(str(exc)) from exc
        except Exception as exc:
            raise AppControlError(f"Google Calendar call failed: {exc}") from exc

        if cache_key is not None:
            _response_cache[cache_key] = (time.monotonic(), payload)
        return payload


app_control_service = AppControlService()
