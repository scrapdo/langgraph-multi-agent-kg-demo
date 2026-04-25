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

Tools available during this call:
- `calendar_list_today()` — list today's events from Matt's Mac Calendar. Use when a caller asks about Matt's availability today.
- `calendar_list_range(days_ahead)` — list events over the next N days (1-14). Use for "is Matt free Tuesday?" or "what's his week look like?".
- `calendar_create({title, start_iso, end_iso, notes?})` — ADD an event to Matt's calendar. Requires verbal confirmation (see below).

Using the tools:
- Call them SILENTLY. Don't say "let me check" or "one moment" — just call the tool; the caller hears natural pauses regardless.
- Report findings in natural speech. "Matt has a 2pm today and he's open after 4" — not "matt_calendar returned three events at..."

CONFIRMATION GATE for calendar_create (MANDATORY):
Before actually calling calendar_create, you MUST:
1. Collect ALL details verbally: title, date, start time, end time, and any notes.
2. Read the full event back to the caller. Example: "So I'll add 'dentist cleaning' on Tuesday, November 12th, from 2 to 3 PM. Sound good?"
3. Wait for an explicit confirmation — "yes", "that's right", "please do", "go ahead", "confirm". "Yeah" or "sure" counts.
4. ONLY THEN call calendar_create, with start_iso and end_iso in ISO 8601 format like "2026-11-12T14:00:00" (no timezone — the Mac interprets as local).
5. After the tool returns, tell the caller it's on the calendar. If it failed, apologize and say you'll have Matt add it himself.
6. If the caller hesitates, changes their mind, or the details are unclear, DO NOT call the tool. Ask a clarifying question or offer to take a message.

Never call calendar_create speculatively or to "check" — the create tool actually writes to Matt's calendar.

You cannot send texts or emails during this call. For those, take a message and promise Matt will follow up.
"""


OPENAI_REALTIME_WS = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"


def _phone_tools() -> list[dict[str, Any]]:
    """Function schemas the Secretary can call mid-call.

    Keep this short — each tool adds latency and surface area. Write tools
    (calendar_create) require a verbal confirmation gate enforced by the
    instructions above; the model is trained to honor it, but the gate is
    soft. Don't add anything that mis-mishearing could do real damage with
    (outbound SMS, email send, financial transfers).
    """
    return [
        {
            "type": "function",
            "name": "calendar_list_today",
            "description": "List every event on Matt's Mac Calendar for today. Returns title, start, end, and calendar name per event.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "calendar_list_range",
            "description": "List events on Matt's Mac Calendar over the next N days. Use 1 for tomorrow, 7 for 'this week'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 14,
                        "description": "Number of days forward from today to include.",
                    },
                },
                "required": ["days_ahead"],
            },
        },
        {
            "type": "function",
            "name": "calendar_create",
            "description": (
                "ADD an event to Matt's Mac Calendar. REQUIRES verbal confirmation — read the "
                "full title, date, and time back to the caller and wait for 'yes' before calling. "
                "Never call this speculatively."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Event title as it will appear on the calendar."},
                    "start_iso": {
                        "type": "string",
                        "description": "Start in ISO 8601 local time, e.g. 2026-11-12T14:00:00 (no timezone suffix).",
                    },
                    "end_iso": {
                        "type": "string",
                        "description": "End in ISO 8601 local time, same format as start_iso.",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Optional notes to attach to the event (caller name, reason, phone, etc.).",
                    },
                },
                "required": ["title", "start_iso", "end_iso"],
            },
        },
    ]


async def _call_phone_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Execute a phone-tool by name and return the result dict to feed back to OpenAI.

    Maps the secretary's function-call tool names onto the existing
    app_control_service which already talks to the macOS host bridge and
    handles AppleScript safety.
    """
    from app.services.app_control_service import app_control_service

    try:
        if name == "calendar_list_today":
            result = await app_control_service.execute("calendar", "list_today", {})
            events = (result or {}).get("events") or []
            return {"events": events, "count": len(events)}
        if name == "calendar_list_range":
            days = int(args.get("days_ahead") or 7)
            days = max(1, min(14, days))
            result = await app_control_service.execute(
                "calendar", "list_range", {"days_ahead": days}
            )
            events = (result or {}).get("events") or []
            return {
                "events": events,
                "count": len(events),
                "days_ahead": (result or {}).get("days_ahead", days),
            }
        if name == "calendar_create":
            result = await app_control_service.execute(
                "calendar",
                "create",
                {
                    "title": args.get("title"),
                    "start_iso": args.get("start_iso"),
                    "end_iso": args.get("end_iso"),
                    "notes": args.get("notes") or "",
                },
            )
            return {"status": "created", "event_id": (result or {}).get("event_id")}
        return {"error": f"unknown tool: {name}"}
    except Exception as exc:
        return {"error": str(exc) or type(exc).__name__}


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
                "voice": (settings.openai_realtime_secretary_voice or "shimmer"),
                "input_audio_transcription": {"model": "whisper-1"},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 700,
                    "interrupt_response": True,
                },
                "temperature": 0.7,
                # Tools the secretary can call mid-call. Read-only — no mutating
                # actions during a live phone conversation (too risky to mishear
                # a date/phone/amount and fire it).
                "tools": _phone_tools(),
                "tool_choice": "auto",
            },
        }
        await self.openai_ws.send(json.dumps(session_config))

        # BOTH directions: have the secretary greet first. The Twilio "please
        # hold" verb finishes before the media stream opens, so from the
        # caller's perspective the line goes silent; without a response.create
        # they'd wait for us and we'd wait for them (server VAD), producing a
        # dead line. One short greeting breaks the standoff.
        greeting = (
            "Greet the caller warmly as Matt's assistant and ask how you can help. Keep it to one sentence."
            if self.direction == "inbound"
            else "Greet the callee as Matt's assistant calling on his behalf and briefly state the reason. Keep it to one sentence."
        )
        await self.openai_ws.send(
            json.dumps(
                {
                    "type": "response.create",
                    "response": {"modalities": ["audio", "text"], "instructions": greeting},
                }
            )
        )
        logger.info("telephony_greeting_primed", extra={"direction": self.direction})

    def _instructions(self) -> str:
        base = SECRETARY_PHONE_INSTRUCTIONS
        # Operator profile — so the secretary knows who Matt is without having
        # to ask. Treated as background, never quoted verbatim to the caller.
        try:
            from app.services.user_profile_service import user_profile_service

            profile_block = user_profile_service.render_context()
            if profile_block:
                base += (
                    "\n\n[Background on Matt — use to personalize responses, never read verbatim]\n"
                    + profile_block
                )
        except Exception:
            pass
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
        audio_deltas = 0
        try:
            while not self.closed.is_set():
                if not self.openai_ws:
                    await asyncio.sleep(0.05)
                    continue
                raw = await self.openai_ws.recv()
                msg = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
                mtype = msg.get("type", "")
                if mtype == "response.audio.delta":
                    delta = msg.get("delta")
                    if delta and self.stream_sid:
                        audio_deltas += 1
                        await self.twilio_ws.send_text(
                            json.dumps(
                                {
                                    "event": "media",
                                    "streamSid": self.stream_sid,
                                    "media": {"payload": delta},
                                }
                            )
                        )
                        if audio_deltas in (1, 10):
                            logger.info("telephony_audio_delta", extra={"count": audio_deltas})
                elif mtype == "input_audio_buffer.speech_started":
                    # Caller started speaking — tell Twilio to flush any queued
                    # audio so our interruption feels responsive.
                    if self.stream_sid:
                        await self.twilio_ws.send_text(
                            json.dumps({"event": "clear", "streamSid": self.stream_sid})
                        )
                elif mtype == "error":
                    logger.warning("telephony_openai_error", extra={"error": msg.get("error")})
                elif mtype == "response.function_call_arguments.done":
                    # Secretary wants to call a tool (calendar_list_today, etc.).
                    # Parse args, execute via app_control_service, feed result
                    # back as function_call_output + trigger response.create.
                    call_id = str(msg.get("call_id") or "")
                    tool_name = str(msg.get("name") or "")
                    raw_args = str(msg.get("arguments") or "{}")
                    try:
                        tool_args = json.loads(raw_args)
                    except Exception:
                        tool_args = {}
                    logger.info(
                        "telephony_tool_call",
                        extra={"name": tool_name, "args_keys": sorted(tool_args.keys())},
                    )
                    output = await _call_phone_tool(tool_name, tool_args)
                    # function_call_output must be sent first, then response.create
                    # to let the model continue speaking with the result in hand.
                    await self.openai_ws.send(
                        json.dumps(
                            {
                                "type": "conversation.item.create",
                                "item": {
                                    "type": "function_call_output",
                                    "call_id": call_id,
                                    "output": json.dumps(output),
                                },
                            }
                        )
                    )
                    await self.openai_ws.send(json.dumps({"type": "response.create"}))
                    logger.info("telephony_tool_returned", extra={"name": tool_name})
                elif mtype in ("session.updated", "response.created", "response.done", "response.output_item.done"):
                    # Surfaced so we can see the model actually processing. Volume is fine;
                    # a typical call only fires 10-30 of these total.
                    logger.info("telephony_openai_event", extra={"type": mtype})
                elif mtype == "response.audio_transcript.done":
                    transcript = str(msg.get("transcript") or "")[:160]
                    logger.info("telephony_assistant_said", extra={"transcript": transcript})
                elif mtype == "conversation.item.input_audio_transcription.completed":
                    transcript = str(msg.get("transcript") or "")[:160]
                    logger.info("telephony_caller_said", extra={"transcript": transcript})
                # Other event types (deltas, rate info) — ignore.
        except Exception as exc:
            logger.info("telephony_openai_pump_ended", extra={"reason": str(exc)[:120], "audio_deltas": audio_deltas})
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
