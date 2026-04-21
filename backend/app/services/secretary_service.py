from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from app.core.config import settings


class SecretaryService:
    def _history_path(self) -> Path:
        path = Path(settings.secretary_test_store_path)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[2] / path
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _contacts_path(self) -> Path:
        path = Path(settings.secretary_contact_store_path)
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[2] / path
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def _load_history(self) -> list[dict[str, Any]]:
        path = self._history_path()
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text())
        except Exception:
            return []
        return data if isinstance(data, list) else []

    def record_history(self, entry: dict[str, Any]) -> None:
        history = self._load_history()
        history.insert(0, entry)
        self._history_path().write_text(json.dumps(history[:20], indent=2))

    def list_contacts(self) -> list[dict[str, Any]]:
        path = self._contacts_path()
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text())
        except Exception:
            return []
        return data if isinstance(data, list) else []

    def save_contact(self, payload: dict[str, Any]) -> dict[str, Any]:
        contact_id = str(payload.get("contact_id") or "").strip()
        name = str(payload.get("name") or "").strip()
        preferred_channel = str(payload.get("preferred_channel") or "email").strip().lower()
        preferred_provider = str(payload.get("preferred_provider") or "auto").strip().lower()
        if not contact_id or not name:
            raise RuntimeError("contact_id and name are required.")
        if preferred_channel not in {"call", "sms", "email", "telegram"}:
            raise RuntimeError("preferred_channel must be call, sms, email, or telegram.")
        if preferred_provider not in {"auto", "twilio", "telnyx", "sendgrid", "telegram"}:
            raise RuntimeError("preferred_provider must be auto, twilio, telnyx, sendgrid, or telegram.")
        raw_priority = payload.get("channel_priority") or []
        if isinstance(raw_priority, str):
            channel_priority = [item.strip().lower() for item in raw_priority.split(",") if item.strip()]
        elif isinstance(raw_priority, list):
            channel_priority = [str(item).strip().lower() for item in raw_priority if str(item).strip()]
        else:
            channel_priority = []
        allowed_channels = {"call", "sms", "email", "telegram"}
        if any(item not in allowed_channels for item in channel_priority):
            raise RuntimeError("channel_priority must only include call, sms, email, or telegram.")
        contact = {
            "contact_id": contact_id,
            "name": name,
            "preferred_channel": preferred_channel,
            "preferred_provider": preferred_provider,
            "phone_number": str(payload.get("phone_number") or "").strip(),
            "email": str(payload.get("email") or "").strip(),
            "telegram_chat_id": str(payload.get("telegram_chat_id") or "").strip(),
            "notes": str(payload.get("notes") or "").strip(),
            "relationship": str(payload.get("relationship") or "").strip(),
            "organization": str(payload.get("organization") or "").strip(),
            "timezone": str(payload.get("timezone") or "").strip(),
            "preferred_contact_window": str(payload.get("preferred_contact_window") or "").strip(),
            "channel_priority": channel_priority,
            "wellness_opt_in": bool(payload.get("wellness_opt_in", False)),
            "last_contact_at": str(payload.get("last_contact_at") or "").strip(),
        }
        contacts = [item for item in self.list_contacts() if item.get("contact_id") != contact_id]
        contacts.append(contact)
        self._contacts_path().write_text(json.dumps(sorted(contacts, key=lambda item: str(item.get("name", "")).lower()), indent=2))
        return contact

    def resolve_contact_dispatch(self, contact_id: str, channel: str, provider: str, fallback_to: str) -> tuple[str, str, str]:
        contact = next((item for item in self.list_contacts() if item.get("contact_id") == contact_id), None)
        if not contact:
            raise RuntimeError("Selected secretary contact was not found.")
        resolved_channel = channel if channel != "auto" else str(contact.get("preferred_channel") or "email")
        resolved_provider = provider if provider != "auto" else str(contact.get("preferred_provider") or "auto")
        resolved_to = fallback_to
        if resolved_channel in {"call", "sms"}:
            resolved_to = str(contact.get("phone_number") or fallback_to).strip()
        elif resolved_channel == "email":
            resolved_to = str(contact.get("email") or fallback_to).strip()
        elif resolved_channel == "telegram":
            resolved_to = str(contact.get("telegram_chat_id") or fallback_to).strip()
        if not resolved_to:
            raise RuntimeError(f"Contact {contact.get('name') or contact_id} is missing a destination for {resolved_channel}.")
        return resolved_channel, resolved_provider, resolved_to

    def touch_contact(self, contact_id: str, channel: str) -> None:
        contacts = self.list_contacts()
        updated: list[dict[str, Any]] = []
        now = datetime.now(tz=timezone.utc).isoformat()
        for item in contacts:
            if item.get("contact_id") == contact_id:
                next_item = dict(item)
                next_item["last_contact_at"] = now
                next_item["last_contact_channel"] = channel
                updated.append(next_item)
            else:
                updated.append(item)
        self._contacts_path().write_text(json.dumps(sorted(updated, key=lambda item: str(item.get("name", "")).lower()), indent=2))

    def get_contact(self, contact_id: str) -> dict[str, Any] | None:
        return next((item for item in self.list_contacts() if item.get("contact_id") == contact_id), None)

    def _twilio_ready(self) -> bool:
        return bool(settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_phone_number)

    def _telnyx_sms_ready(self) -> bool:
        return bool(settings.telnyx_api_key and settings.telnyx_phone_number)

    def _telnyx_call_ready(self) -> bool:
        return bool(settings.telnyx_api_key and settings.telnyx_phone_number and settings.telnyx_connection_id)

    def _email_ready(self) -> bool:
        return bool(settings.sendgrid_api_key and settings.secretary_email_from)

    def _telegram_ready(self) -> bool:
        return bool(settings.telegram_bot_token)

    def _provider_status(self) -> dict[str, Any]:
        return {
            "twilio": {
                "ready": self._twilio_ready(),
                "channels": ["call", "sms"],
                "missing": [
                    name
                    for name, present in (
                        ("TWILIO_ACCOUNT_SID", bool(settings.twilio_account_sid)),
                        ("TWILIO_AUTH_TOKEN", bool(settings.twilio_auth_token)),
                        ("TWILIO_PHONE_NUMBER", bool(settings.twilio_phone_number)),
                    )
                    if not present
                ],
            },
            "telnyx": {
                "ready": self._telnyx_call_ready() or self._telnyx_sms_ready(),
                "channels": ["call", "sms"],
                "missing": [
                    name
                    for name, present in (
                        ("TELNYX_API_KEY", bool(settings.telnyx_api_key)),
                        ("TELNYX_PHONE_NUMBER", bool(settings.telnyx_phone_number)),
                        ("TELNYX_CONNECTION_ID", bool(settings.telnyx_connection_id)),
                    )
                    if not present
                ],
            },
            "sendgrid": {
                "ready": self._email_ready(),
                "channels": ["email"],
                "missing": [
                    name
                    for name, present in (
                        ("SENDGRID_API_KEY", bool(settings.sendgrid_api_key)),
                        ("SECRETARY_EMAIL_FROM", bool(settings.secretary_email_from)),
                    )
                    if not present
                ],
            },
            "telegram": {
                "ready": self._telegram_ready(),
                "channels": ["telegram"],
                "missing": [
                    name
                    for name, present in (
                        ("TELEGRAM_BOT_TOKEN", bool(settings.telegram_bot_token)),
                    )
                    if not present
                ],
            },
        }

    def status(self) -> dict[str, Any]:
        provider_status = self._provider_status()
        missing = {provider: details["missing"] for provider, details in provider_status.items()}
        call_ready = self._twilio_ready() or self._telnyx_call_ready()
        sms_ready = self._twilio_ready() or self._telnyx_sms_ready()
        email_ready = self._email_ready()
        telegram_ready = self._telegram_ready()
        payload = {
            "twilio_enabled": self._twilio_ready(),
            "telnyx_enabled": bool(settings.telnyx_api_key and settings.telnyx_phone_number),
            "sendgrid_enabled": email_ready,
            "telegram_enabled": telegram_ready,
            "phone_number": settings.twilio_phone_number or settings.telnyx_phone_number,
            "email_from": settings.secretary_email_from,
            "telegram_default_chat_id": settings.telegram_default_chat_id,
            "missing_config": missing,
            "channel_status": {
                "call": call_ready,
                "sms": sms_ready,
                "email": email_ready,
                "telegram": telegram_ready,
            },
            "providers": {
                "call": "twilio" if self._twilio_ready() else ("telnyx" if self._telnyx_call_ready() else "unconfigured"),
                "sms": "twilio" if self._twilio_ready() else ("telnyx" if self._telnyx_sms_ready() else "unconfigured"),
                "email": "sendgrid" if email_ready else "unconfigured",
                "telegram": "telegram" if telegram_ready else "unconfigured",
            },
            "readiness_percent": int((int(call_ready) + int(sms_ready) + int(email_ready) + int(telegram_ready)) / 4 * 100),
            "provider_status": provider_status,
            "history": self._load_history(),
            "contacts": self.list_contacts(),
        }
        payload["checklist"] = self.checklist(payload)
        return payload

    async def send_sms(self, to: str, body: str, provider: str = "auto") -> dict[str, Any]:
        if provider not in {"auto", "twilio", "telnyx"}:
            raise RuntimeError("SMS provider must be auto, twilio, or telnyx.")
        if provider in {"auto", "twilio"} and self._twilio_ready():
            url = f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Messages.json"
            data = {
                "From": settings.twilio_phone_number,
                "To": to,
                "Body": body,
            }
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(url, data=data, auth=(settings.twilio_account_sid, settings.twilio_auth_token))
            if response.status_code >= 400:
                raise RuntimeError(f"Twilio SMS failed: {response.status_code} {response.text[:220]}")
            payload = response.json()
            return {"sid": payload.get("sid"), "status": payload.get("status"), "provider": "twilio"}
        if provider == "twilio":
            raise RuntimeError("Twilio SMS is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.")
        if provider in {"auto", "telnyx"} and self._telnyx_sms_ready():
            payload = {
                "from": settings.telnyx_phone_number,
                "to": to,
                "text": body,
            }
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    "https://api.telnyx.com/v2/messages",
                    json=payload,
                    headers={"Authorization": f"Bearer {settings.telnyx_api_key}", "Content-Type": "application/json"},
                )
            if response.status_code >= 400:
                raise RuntimeError(f"Telnyx SMS failed: {response.status_code} {response.text[:220]}")
            body_payload = response.json().get("data", {})
            return {"sid": body_payload.get("id"), "status": body_payload.get("status"), "provider": "telnyx"}
        if provider == "telnyx":
            raise RuntimeError("Telnyx SMS is not configured. Add TELNYX_API_KEY and TELNYX_PHONE_NUMBER.")
        raise RuntimeError(
            "SMS is not configured. Add either TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER or TELNYX_API_KEY and TELNYX_PHONE_NUMBER."
        )

    async def place_call(self, to: str, message: str, provider: str = "auto") -> dict[str, Any]:
        if provider not in {"auto", "twilio", "telnyx"}:
            raise RuntimeError("Call provider must be auto, twilio, or telnyx.")
        if provider in {"auto", "twilio"} and self._twilio_ready():
            twiml = f"<Response><Say voice=\"alice\">{message}</Say></Response>"
            url = f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Calls.json"
            data = {
                "From": settings.twilio_phone_number,
                "To": to,
                "Twiml": twiml,
            }
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(url, data=data, auth=(settings.twilio_account_sid, settings.twilio_auth_token))
            if response.status_code >= 400:
                raise RuntimeError(f"Twilio call failed: {response.status_code} {response.text[:220]}")
            payload = response.json()
            return {"sid": payload.get("sid"), "status": payload.get("status"), "provider": "twilio"}
        if provider == "twilio":
            raise RuntimeError("Twilio calling is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.")
        if provider in {"auto", "telnyx"} and self._telnyx_call_ready():
            payload = {
                "connection_id": settings.telnyx_connection_id,
                "to": to,
                "from": settings.telnyx_phone_number,
                "audio_url": "https://www2.cs.uic.edu/~i101/SoundFiles/StarWars3.wav",
            }
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(
                    "https://api.telnyx.com/v2/calls",
                    json=payload,
                    headers={"Authorization": f"Bearer {settings.telnyx_api_key}", "Content-Type": "application/json"},
                )
            if response.status_code >= 400:
                raise RuntimeError(f"Telnyx call failed: {response.status_code} {response.text[:220]}")
            body_payload = response.json().get("data", {})
            return {"sid": body_payload.get("call_control_id"), "status": body_payload.get("call_leg_id"), "provider": "telnyx"}
        if provider == "telnyx":
            raise RuntimeError("Telnyx calling is not configured. Add TELNYX_API_KEY, TELNYX_PHONE_NUMBER, and TELNYX_CONNECTION_ID.")
        raise RuntimeError(
            "Calling is not configured. Add either TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER or TELNYX_API_KEY, TELNYX_PHONE_NUMBER, and TELNYX_CONNECTION_ID."
        )

    async def send_email(self, to: str, subject: str, body: str, provider: str = "auto") -> dict[str, Any]:
        if provider not in {"auto", "sendgrid"}:
            raise RuntimeError("Email provider must be auto or sendgrid.")
        if provider == "sendgrid" and not self._email_ready():
            raise RuntimeError("SendGrid email is not configured. Add SENDGRID_API_KEY and SECRETARY_EMAIL_FROM.")
        if not (settings.sendgrid_api_key and settings.secretary_email_from):
            raise RuntimeError("SendGrid email is not configured. Add SENDGRID_API_KEY and SECRETARY_EMAIL_FROM.")
        payload = {
            "personalizations": [{"to": [{"email": to}], "subject": subject}],
            "from": {"email": settings.secretary_email_from},
            "content": [{"type": "text/plain", "value": body}],
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                json=payload,
                headers={"Authorization": f"Bearer {settings.sendgrid_api_key}", "Content-Type": "application/json"},
            )
        if response.status_code >= 400:
            raise RuntimeError(f"SendGrid email failed: {response.status_code} {response.text[:220]}")
        return {"status": "queued", "provider": "sendgrid"}

    async def send_telegram(self, to: str, body: str, provider: str = "auto") -> dict[str, Any]:
        if provider not in {"auto", "telegram"}:
            raise RuntimeError("Telegram provider must be auto or telegram.")
        if not self._telegram_ready():
            raise RuntimeError("Telegram is not configured. Add TELEGRAM_BOT_TOKEN.")
        chat_id = to.strip() or settings.telegram_default_chat_id.strip()
        if not chat_id:
            raise RuntimeError("Telegram requires a chat id. Provide a chat id or set TELEGRAM_DEFAULT_CHAT_ID.")
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
                json={"chat_id": chat_id, "text": body},
            )
        if response.status_code >= 400:
            raise RuntimeError(f"Telegram message failed: {response.status_code} {response.text[:220]}")
        payload = response.json()
        if not payload.get("ok"):
            raise RuntimeError(f"Telegram message failed: {payload}")
        result = payload.get("result", {})
        return {"status": "sent", "provider": "telegram", "message_id": result.get("message_id"), "chat_id": result.get("chat", {}).get("id", chat_id)}

    async def dispatch(
        self,
        *,
        channel: str,
        to: str,
        message: str,
        subject: str = "",
        mode: str = "live",
        provider: str = "auto",
        contact_id: str = "",
    ) -> dict[str, Any]:
        history_entry = {
            "at": datetime.now(tz=timezone.utc).isoformat(),
            "channel": channel,
            "to": to,
            "provider": provider,
            "mode": mode,
            "contact_id": contact_id or None,
        }

        if mode != "live":
            if contact_id:
                self.touch_contact(contact_id, channel)
            self.record_history({**history_entry, "status": "simulated"})
            return {"status": "simulated", "channel": channel, "to": to, "subject": subject, "message": message, "provider": provider}

        try:
            if channel == "call":
                result = await self.place_call(to, message, provider=provider)
            elif channel == "sms":
                result = await self.send_sms(to, message, provider=provider)
            elif channel == "telegram":
                result = await self.send_telegram(to, message, provider=provider)
            else:
                result = await self.send_email(to, subject or "Follow-up from Nora", message, provider=provider)
        except RuntimeError as exc:
            self.record_history({**history_entry, "status": "failed", "error": str(exc)})
            raise
        if contact_id:
            self.touch_contact(contact_id, channel)
        self.record_history({**history_entry, "status": "dispatched", "resolved_provider": result.get("provider"), "result": result})
        return {"status": "dispatched", "channel": channel, "to": to, "result": result}

    async def dispatch_wellness_outreach(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        mode = str(payload.get("mode") or "live").strip().lower()
        channel = str(payload.get("outreach_channel") or "telegram").strip().lower()
        provider = str(payload.get("outreach_provider") or "auto").strip().lower()
        message = str(payload.get("outreach_message") or payload.get("message") or "").strip()
        if not message:
            return []
        requested_ids = [str(item).strip() for item in (payload.get("contact_ids") or []) if str(item).strip()]
        contacts = self.list_contacts()
        results: list[dict[str, Any]] = []
        for contact in contacts:
            contact_id = str(contact.get("contact_id") or "")
            if requested_ids and contact_id not in requested_ids:
                continue
            if not bool(contact.get("wellness_opt_in")):
                continue
            resolved_channel, resolved_provider, resolved_to = self.resolve_contact_dispatch(contact_id, channel, provider, "")
            result = await self.dispatch(
                channel=resolved_channel,
                to=resolved_to,
                message=message,
                subject="Wellness check-in from Ava",
                mode=mode,
                provider=resolved_provider,
                contact_id=contact_id,
            )
            results.append(
                {
                    "contact_id": contact_id,
                    "name": contact.get("name"),
                    "channel": resolved_channel,
                    "provider": resolved_provider,
                    "to": resolved_to,
                    "status": result.get("status"),
                }
            )
        return results

    def checklist(self, status: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        status = status or self.status()
        provider_status = status["provider_status"]
        return [
            {
                "id": "voice_sms_provider",
                "label": "Configure a calling/SMS provider",
                "ok": bool(status["channel_status"]["call"] or status["channel_status"]["sms"]),
                "detail": "Twilio or Telnyx is required for real phone calls and SMS.",
            },
            {
                "id": "email_provider",
                "label": "Configure email sending",
                "ok": bool(status["channel_status"]["email"]),
                "detail": "SendGrid is required for live secretary email.",
            },
            {
                "id": "telegram_provider",
                "label": "Configure Telegram bot access",
                "ok": bool(status["channel_status"]["telegram"]),
                "detail": "Telegram needs a bot token, and recipients must start the bot before Nora can message them.",
            },
            {
                "id": "provider_selection",
                "label": "Pick the right live provider for each channel",
                "ok": any(item["ready"] for item in provider_status.values()),
                "detail": "Use provider override in the Secretary panel to force Twilio, Telnyx, SendGrid, or Telegram.",
            },
        ]


secretary_service = SecretaryService()
