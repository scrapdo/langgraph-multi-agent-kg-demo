"""Bridges a Twilio Media Stream WebSocket to an OpenAI Realtime session.

Twilio sends mulaw/8000 base64-encoded audio frames. OpenAI Realtime accepts
g711_ulaw directly in both input and output — so we don't transcode; we just
forward base64 payloads in both directions and let OpenAI handle VAD, turn
detection, and voice synthesis.

Flow for a single call:

  1. Twilio POSTs /telephony/incoming. We return TwiML instructing Twilio
     to open a Media Stream WebSocket to /telephony/stream.
  2. Twilio opens the WebSocket and sends {event: "start", streamSid, ...}.
  3. We open a WebSocket to wss://api.openai.com/v1/realtime, send a
     session.update with the Secretary's instructions + g711_ulaw formats.
  4. Two async pumps run in parallel:
       - twilio → openai: extract media.payload, send as input_audio_buffer.append
       - openai → twilio: for each response.audio.delta, send {event: "media"} with the delta
  5. On hangup Twilio sends {event: "stop"} or closes the WebSocket; we close
     the OpenAI side too.

The bridge is entirely in-process — no Redis, no Celery. One coroutine pair
per active call. Graceful shutdown on either side flushing the other.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger("app.telephony")


SECRETARY_PHONE_INSTRUCTIONS = """\
You are the operator's executive secretary, handling an active phone call. You are speaking over a phone line — keep responses tight, natural, and conversational. No filler openers.

If this is an INBOUND call (someone called the operator's number):
- Greet warmly: "Hi, you've reached Matt's assistant — how can I help?"
- Identify who's calling and why.
- If the caller wants to reach Matt directly, take a message: name, number, reason, best time to reach back.
- Do NOT impersonate Matt. You are his assistant, not him.
- For unsolicited sales calls, politely decline and hang up.

If this is an OUTBOUND call (you're calling someone on the operator's behalf):
- Start: "Hi, this is Matt's assistant calling on his behalf about [context]."
- Deliver the operator's intent clearly, confirm the other party, and handle follow-ups.
- If the callee asks questions you can't answer, say "I'll check with Matt and have him follow up."

Always:
- Stay on task. If the caller wanders, steer back.
- Short sentences. Wait for responses. Let the caller speak.
- If the line is silent for 8+ seconds, prompt: "Still there?"
- When the conversation is winding down, confirm next steps and say goodbye cleanly.

You do not have access to Matt's calendar, email, or messages during this call. If the caller asks for live info you don't have, take a message and promise Matt will follow up.
"""


OPENAI_REALTIME_WS = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"


class _CallBridge:
    """One instance per in-progress call. Pumps audio in both directions."""

    def __init__(self, twilio_ws, *, direction: str, context: str = "") -> None:
        self.twilio_ws = twilio_ws
        self.direction = direction  # "inbound" or "outbound"
        self.context = context
        self.stream_sid: str | None = None
        self.openai_ws = None  # set by _connect_openai
        self.closed = asyncio.Event()

    async def _connect_openai(self) -> None:
        """Open the OpenAI Realtime WebSocket and send the initial session config."""
        import websockets

        headers = [
            ("Authorization", f"Bearer {settings.openai_api_key}"),
            ("OpenAI-Beta", "realtime=v1"),
        ]
        self.openai_ws = await websockets.connect(
            OPENAI_REALTIME_WS,
            additional_headers=headers,
            max_size=16 * 1024 * 1024,
        )

        session_config: dict[str, Any] = {
            "type": "session.update",
            "session": {
                "modalities": ["audio", "text"],
                "instructions": self._instructions(),
                # Twilio sends mulaw/8000. OpenAI accepts "g711_ulaw" directly, so
                # we round-trip base64 audio with zero transcoding.
                "input_audio_format": "g711_ulaw",
                "output_audio_format": "g711_ulaw",
                "voice": settings.openai_realtime_voice or "alloy",
                "input_audio_transcription": {"model": "whisper-1"},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 700,
                    "interrupt_response": True,
                },
                "temperature": 0.7,
            },
        }
        await self.openai_ws.send(json.dumps(session_config))

        if self.direction == "outbound":
            # Prime the assistant to speak first on outbound calls so the callee
            # hears us before silence.
            await self.openai_ws.send(json.dumps({"type": "response.create"}))

    def _instructions(self) -> str:
        base = SECRETARY_PHONE_INSTRUCTIONS
        if self.context:
            base += f"\n\n[Current call context: {self.context}]"
        base += f"\n\n[Call direction: {self.direction}]"
        return base

    async def _twilio_to_openai(self) -> None:
        """Pump Twilio media frames → OpenAI input_audio_buffer.append."""
        try:
            while not self.closed.is_set():
                raw = await self.twilio_ws.receive_text()
                msg = json.loads(raw)
                event = msg.get("event")
                if event == "start":
                    self.stream_sid = msg.get("start", {}).get("streamSid")
                    logger.info("telephony_call_started", extra={"stream_sid": self.stream_sid, "direction": self.direction})
                elif event == "media" and self.openai_ws:
                    payload = msg.get("media", {}).get("payload")
                    if payload:
                        await self.openai_ws.send(
                            json.dumps({"type": "input_audio_buffer.append", "audio": payload})
                        )
                elif event == "stop":
                    self.closed.set()
                    break
        except Exception as exc:
            logger.info("telephony_twilio_pump_ended", extra={"reason": str(exc)[:120]})
        finally:
            self.closed.set()

    async def _openai_to_twilio(self) -> None:
        """Pump OpenAI response.audio.delta → Twilio media frames."""
        try:
            while not self.closed.is_set():
                if not self.openai_ws:
                    await asyncio.sleep(0.05)
                    continue
                raw = await self.openai_ws.recv()
                msg = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
                mtype = msg.get("type")
                if mtype == "response.audio.delta":
                    delta = msg.get("delta")
                    if delta and self.stream_sid:
                        await self.twilio_ws.send_text(
                            json.dumps(
                                {
                                    "event": "media",
                                    "streamSid": self.stream_sid,
                                    "media": {"payload": delta},
                                }
                            )
                        )
                elif mtype == "input_audio_buffer.speech_started":
                    # Caller started speaking — tell Twilio to flush any queued
                    # audio so our interruption feels responsive.
                    if self.stream_sid:
                        await self.twilio_ws.send_text(
                            json.dumps({"event": "clear", "streamSid": self.stream_sid})
                        )
                elif mtype == "error":
                    logger.warning("telephony_openai_error", extra={"error": msg.get("error")})
                # All other event types (transcripts, response.done, etc.) — ignore for now.
                # In a follow-up we'll persist transcripts to Zep + run_store.
        except Exception as exc:
            logger.info("telephony_openai_pump_ended", extra={"reason": str(exc)[:120]})
        finally:
            self.closed.set()

    async def run(self) -> None:
        await self._connect_openai()
        try:
            await asyncio.gather(
                self._twilio_to_openai(),
                self._openai_to_twilio(),
                return_exceptions=True,
            )
        finally:
            if self.openai_ws:
                try:
                    await self.openai_ws.close()
                except Exception:
                    pass


class TelephonyService:
    """Thin façade: TwiML rendering + outbound call initiation + bridge factory."""

    def twiml_for_incoming(self, stream_url: str) -> str:
        """Return the TwiML Twilio fetches when an inbound call arrives.

        The <Connect><Stream> verb tells Twilio to open a bidirectional media
        stream to the given URL. Everything else happens over that WebSocket.
        """
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Say voice="alice">Please hold while I connect you to Matt\'s assistant.</Say>'
            f'<Connect><Stream url="{stream_url}"/></Connect>'
            "</Response>"
        )

    def twiml_for_outgoing(self, stream_url: str) -> str:
        """Return the TwiML Twilio fetches when OUR outbound call is answered.

        Mirrors the inbound flow. The calling party (our secretary) greets the
        callee once the stream is up.
        """
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            f'<Connect><Stream url="{stream_url}"/></Connect>'
            "</Response>"
        )

    async def place_call(self, to: str, context: str, webhook_base: str) -> dict[str, Any]:
        """Dial out via Twilio's REST API. Returns Twilio's call record dict.

        ``webhook_base`` is the publicly-reachable https URL of OUR backend
        (e.g. https://abc.ngrok-free.app). Twilio will POST to
        ``{webhook_base}/telephony/outgoing?context=...`` when the callee
        answers, and we return TwiML with a <Stream> that points at
        ``wss://{host}/telephony/stream?direction=outbound&context=...``.
        """
        if not (settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_phone_number):
            raise RuntimeError("Twilio not configured — set TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER in secrets.env.")
        url = f"https://api.twilio.com/2010-04-01/Accounts/{settings.twilio_account_sid}/Calls.json"
        # Encode context into the URL so our webhook handler can reconstruct it.
        import urllib.parse as _up

        q = _up.urlencode({"context": context, "direction": "outbound"})
        twilio_webhook = f"{webhook_base.rstrip('/')}/telephony/outgoing?{q}"
        payload = {
            "To": to,
            "From": settings.twilio_phone_number,
            "Url": twilio_webhook,
            "Method": "POST",
        }
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                url, data=payload, auth=(settings.twilio_account_sid, settings.twilio_auth_token)
            )
        if response.status_code >= 400:
            raise RuntimeError(f"Twilio call failed: {response.status_code} {response.text[:300]}")
        data = response.json()
        logger.info(
            "telephony_outbound_placed",
            extra={"to": to, "sid": data.get("sid"), "status": data.get("status")},
        )
        return {
            "sid": data.get("sid"),
            "status": data.get("status"),
            "to": to,
            "from": payload["From"],
            "placed_at": datetime.now(tz=timezone.utc).isoformat(),
        }

    def new_bridge(self, twilio_ws, *, direction: str, context: str = "") -> _CallBridge:
        return _CallBridge(twilio_ws, direction=direction, context=context)


def validate_twilio_signature(signing_key: str, url: str, params: dict[str, str], signature: str) -> bool:
    """Twilio signs every webhook request with HMAC-SHA1 over the full URL
    plus the sorted POST params. Validate to ensure outsiders can't spoof
    inbound calls into our backend.

    Reference: https://www.twilio.com/docs/usage/security#validating-requests
    """
    if not signing_key or not signature:
        return False
    import base64 as _b64
    import hmac
    from hashlib import sha1

    data = url
    for key in sorted(params.keys()):
        data += key + (params[key] or "")
    mac = hmac.new(signing_key.encode("utf-8"), data.encode("utf-8"), sha1)
    expected = _b64.b64encode(mac.digest()).decode("utf-8")
    return hmac.compare_digest(expected, signature)


# Single instance consumed by api/routes.py
telephony_service = TelephonyService()
# Suppress unused-import warning for the b64 alias we keep for future transcoding work.
_ = base64
