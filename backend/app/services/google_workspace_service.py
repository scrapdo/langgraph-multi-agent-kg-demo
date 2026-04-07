from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

import httpx

from app.core.config import settings


class GoogleWorkspaceService:
    base_gmail_url = "https://gmail.googleapis.com/gmail/v1"
    base_calendar_url = "https://www.googleapis.com/calendar/v3"
    token_url = "https://oauth2.googleapis.com/token"
    auth_url = "https://accounts.google.com/o/oauth2/v2/auth"
    scopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
    ]

    def __init__(self, token_store_path: str) -> None:
        self.token_store_path = Path(token_store_path)
        self._lock = Lock()
        self._pending_states: set[str] = set()

    def oauth_configured(self) -> bool:
        return bool(settings.google_oauth_client_id and settings.google_oauth_client_secret and settings.google_oauth_redirect_uri)

    def _read_store(self) -> dict[str, Any]:
        if not self.token_store_path.exists():
            return {}
        try:
            raw = json.loads(self.token_store_path.read_text())
            return raw if isinstance(raw, dict) else {}
        except Exception:
            return {}

    def _write_store(self, payload: dict[str, Any]) -> None:
        self.token_store_path.parent.mkdir(parents=True, exist_ok=True)
        self.token_store_path.write_text(json.dumps(payload, indent=2, sort_keys=True))

    def connected(self) -> bool:
        stored = self._read_store()
        return bool(settings.google_workspace_access_token or stored.get("access_token") or stored.get("refresh_token"))

    def enabled(self) -> bool:
        try:
            return bool(self._get_access_token())
        except Exception:
            return False

    def status(self) -> dict[str, Any]:
        stored = self._read_store()
        return {
            "enabled": self.enabled(),
            "connected": self.connected(),
            "oauth_configured": self.oauth_configured(),
            "user": settings.google_workspace_user,
            "calendar_id": settings.google_calendar_id,
            "token_source": "env" if settings.google_workspace_access_token else ("oauth_store" if stored else "none"),
            "expires_at": stored.get("expires_at"),
            "updated_at": stored.get("updated_at"),
            "granted_scope": stored.get("scope"),
            "can_refresh": bool(stored.get("refresh_token") and self.oauth_configured()),
            "supported_actions": ["snapshot", "inbox_triage", "agenda_brief", "conflict_scan", "morning_brief", "draft_reply_suggestions"],
            "required_scopes": self.scopes,
            "redirect_uri": settings.google_oauth_redirect_uri,
            "connect_hint": (
                "Configure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, then connect from Desktop Ops. "
                "The app will store a refresh token locally and refresh access automatically."
            ),
        }

    def begin_oauth(self) -> dict[str, str]:
        if not self.oauth_configured():
            raise RuntimeError("Google OAuth client credentials are not configured.")
        state = uuid4().hex
        self._pending_states.add(state)
        params = {
            "client_id": settings.google_oauth_client_id,
            "redirect_uri": settings.google_oauth_redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.scopes),
            "access_type": "offline",
            "include_granted_scopes": "true",
            "prompt": "consent",
            "state": state,
        }
        return {"url": f"{self.auth_url}?{urlencode(params)}", "state": state}

    def finish_oauth(self, code: str, state: str) -> dict[str, Any]:
        if state not in self._pending_states:
            raise RuntimeError("Invalid or expired Google OAuth state.")
        self._pending_states.remove(state)
        data = {
            "code": code,
            "client_id": settings.google_oauth_client_id,
            "client_secret": settings.google_oauth_client_secret,
            "redirect_uri": settings.google_oauth_redirect_uri,
            "grant_type": "authorization_code",
        }
        with httpx.Client(timeout=20) as client:
            response = client.post(self.token_url, data=data)
            response.raise_for_status()
            token_payload = response.json()
        self._store_token_payload(token_payload)
        return self.status()

    def disconnect(self) -> None:
        with self._lock:
            if self.token_store_path.exists():
                self.token_store_path.unlink()

    def _store_token_payload(self, payload: dict[str, Any]) -> None:
        now = datetime.now(timezone.utc)
        expires_in = int(payload.get("expires_in") or 0)
        stored = {
            "access_token": payload.get("access_token", ""),
            "refresh_token": payload.get("refresh_token") or self._read_store().get("refresh_token", ""),
            "token_type": payload.get("token_type", "Bearer"),
            "scope": payload.get("scope", " ".join(self.scopes)),
            "expires_at": (now + timedelta(seconds=expires_in)).isoformat() if expires_in else "",
            "updated_at": now.isoformat(),
        }
        with self._lock:
            self._write_store(stored)

    def _refresh_access_token(self, refresh_token: str) -> str:
        data = {
            "client_id": settings.google_oauth_client_id,
            "client_secret": settings.google_oauth_client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
        with httpx.Client(timeout=20) as client:
            response = client.post(self.token_url, data=data)
            response.raise_for_status()
            token_payload = response.json()
        self._store_token_payload(token_payload | {"refresh_token": refresh_token})
        return str(token_payload.get("access_token") or "")

    def _get_access_token(self) -> str:
        if settings.google_workspace_access_token:
            return settings.google_workspace_access_token
        stored = self._read_store()
        access_token = str(stored.get("access_token") or "")
        refresh_token = str(stored.get("refresh_token") or "")
        expires_at = str(stored.get("expires_at") or "")
        if access_token and expires_at:
            try:
                expiry = datetime.fromisoformat(expires_at)
                if expiry > datetime.now(timezone.utc) + timedelta(seconds=30):
                    return access_token
            except Exception:
                pass
        if refresh_token and self.oauth_configured():
            return self._refresh_access_token(refresh_token)
        if access_token:
            return access_token
        return ""

    def _headers(self) -> dict[str, str]:
        token = self._get_access_token()
        if not token:
            raise RuntimeError("Google Workspace is not connected.")
        return {"Authorization": f"Bearer {token}"}

    def snapshot(self, prompt: str, output_dir: Path, slug: str, action_type: str = "snapshot") -> Path:
        headers = self._headers()
        output_dir.mkdir(parents=True, exist_ok=True)
        now = datetime.now(timezone.utc)
        time_min = now.isoformat().replace("+00:00", "Z")
        messages: list[dict[str, Any]] = []
        events: list[dict[str, Any]] = []
        with httpx.Client(timeout=20, headers=headers) as client:
            list_resp = client.get(
                f"{self.base_gmail_url}/users/{settings.google_workspace_user}/messages",
                params={"maxResults": 5, "q": "in:inbox newer_than:7d"},
            )
            list_resp.raise_for_status()
            for item in list_resp.json().get("messages", [])[:5]:
                msg_resp = client.get(
                    f"{self.base_gmail_url}/users/{settings.google_workspace_user}/messages/{item['id']}",
                    params={"format": "metadata", "metadataHeaders": ["Subject", "From", "Date"]},
                )
                msg_resp.raise_for_status()
                payload = msg_resp.json().get("payload", {})
                meta = {entry.get("name"): entry.get("value") for entry in payload.get("headers", [])}
                messages.append(
                    {
                        "id": item["id"],
                        "subject": meta.get("Subject", "(no subject)"),
                        "from": meta.get("From", ""),
                        "date": meta.get("Date", ""),
                    }
                )

            cal_resp = client.get(
                f"{self.base_calendar_url}/calendars/{settings.google_calendar_id}/events",
                params={
                    "maxResults": 8,
                    "singleEvents": "true",
                    "orderBy": "startTime",
                    "timeMin": time_min,
                    "timeMax": (now + timedelta(days=7)).isoformat().replace("+00:00", "Z"),
                },
            )
            cal_resp.raise_for_status()
            for event in cal_resp.json().get("items", [])[:8]:
                events.append(
                    {
                        "summary": event.get("summary", "(untitled)"),
                        "start": (event.get("start") or {}).get("dateTime") or (event.get("start") or {}).get("date"),
                        "end": (event.get("end") or {}).get("dateTime") or (event.get("end") or {}).get("date"),
                    }
                )

        snapshot_dir = output_dir / "gmail_calendar" / slug
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        inbox_lines = [f"- {msg['subject']} | {msg['from']} | {msg['date']}" for msg in messages] or ["- No recent inbox messages found"]
        calendar_lines = [f"- {event['summary']} | {event['start']} -> {event['end']}" for event in events] or ["- No upcoming events found"]
        overlap_notes = self._detect_overlaps(events)
        next_actions = self._next_actions(action_type, messages, events, overlap_notes)
        sections: list[str] = [
            "# Gmail / Calendar Snapshot",
            "",
            f"Action Type: {action_type}",
            f"Prompt: {prompt}",
            "",
        ]
        if action_type in {"snapshot", "inbox_triage", "morning_brief", "draft_reply_suggestions"}:
            sections.extend(["## Inbox", *inbox_lines, ""])
        if action_type in {"snapshot", "agenda_brief", "conflict_scan", "morning_brief"}:
            sections.extend(["## Calendar", *calendar_lines, ""])
        if action_type == "conflict_scan":
            sections.extend(["## Conflicts", *(overlap_notes or ["- No overlapping events detected"]), ""])
        if action_type == "draft_reply_suggestions":
            sections.extend(["## Draft Reply Suggestions", *self._draft_reply_suggestions(messages), ""])
        if action_type == "morning_brief":
            sections.extend(["## Morning Brief", *self._morning_brief(messages, events, overlap_notes), ""])
        sections.extend(["## Suggested Next Actions", *next_actions])
        snapshot = "\n".join(sections)
        (snapshot_dir / "snapshot.md").write_text(snapshot)
        return snapshot_dir

    def _detect_overlaps(self, events: list[dict[str, Any]]) -> list[str]:
        ranges: list[tuple[datetime, datetime, str]] = []
        for event in events:
            start = self._parse_dt(event.get("start"))
            end = self._parse_dt(event.get("end"))
            if not start or not end:
                continue
            ranges.append((start, end, str(event.get("summary") or "(untitled)")))
        overlaps: list[str] = []
        for idx, (start_a, end_a, name_a) in enumerate(ranges):
            for start_b, end_b, name_b in ranges[idx + 1 :]:
                if start_a < end_b and start_b < end_a:
                    overlaps.append(f"- {name_a} overlaps with {name_b}")
        return overlaps

    def _parse_dt(self, value: Any) -> datetime | None:
        if not value or not isinstance(value, str):
            return None
        try:
            if "T" in value:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            return datetime.fromisoformat(f"{value}T00:00:00+00:00")
        except Exception:
            return None

    def _next_actions(
        self,
        action_type: str,
        messages: list[dict[str, Any]],
        events: list[dict[str, Any]],
        overlap_notes: list[str],
    ) -> list[str]:
        if action_type == "inbox_triage":
            return [
                f"- Review the top {min(len(messages), 3)} inbox threads first." if messages else "- Inbox is quiet enough that no immediate email follow-up is obvious.",
                "- Draft replies only after confirming calendar constraints.",
            ]
        if action_type == "agenda_brief":
            return [
                f"- Prepare for the next {min(len(events), 3)} calendar items." if events else "- No upcoming events found, so no agenda prep is needed.",
                "- Block 15 minutes before the first critical event for prep if needed.",
            ]
        if action_type == "conflict_scan":
            return overlap_notes or ["- No calendar conflicts detected in the next 7 days."]
        if action_type == "draft_reply_suggestions":
            return [
                "- Review the suggested email replies before sending anything.",
                "- Check calendar availability before confirming meetings or calls.",
            ]
        if action_type == "morning_brief":
            return [
                "- Triage inbox first, then review the next meetings in sequence.",
                "- Resolve calendar conflicts before making new commitments.",
            ]
        return [
            "- Review inbox priorities against today and tomorrow's calendar.",
            "- Resolve any time conflicts before drafting outbound replies.",
        ]

    def _draft_reply_suggestions(self, messages: list[dict[str, Any]]) -> list[str]:
        if not messages:
            return ["- No recent inbox threads available for draft suggestions."]
        suggestions: list[str] = []
        for msg in messages[:3]:
            subject = str(msg.get("subject") or "(no subject)")
            sender = str(msg.get("from") or "sender")
            suggestions.append(f"- Reply to '{subject}' from {sender}: acknowledge receipt, answer the core ask, and propose a next step if needed.")
        return suggestions

    def _morning_brief(self, messages: list[dict[str, Any]], events: list[dict[str, Any]], overlap_notes: list[str]) -> list[str]:
        lines = [
            f"- Inbox items in scope: {len(messages)}",
            f"- Calendar items in scope: {len(events)}",
        ]
        if overlap_notes:
            lines.append(f"- Calendar conflicts detected: {len(overlap_notes)}")
        else:
            lines.append("- No calendar conflicts detected in the current window.")
        if messages:
            lines.append(f"- Highest-priority email appears to be: {messages[0].get('subject', '(no subject)')}")
        if events:
            lines.append(f"- First upcoming event: {events[0].get('summary', '(untitled)')} at {events[0].get('start', '')}")
        return lines


google_workspace_service = GoogleWorkspaceService(settings.google_workspace_token_store_path)
