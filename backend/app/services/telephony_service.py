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
       - openai → twilio: for each response.output_audio.delta, send {event: "media"} with the delta
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
You are Emma, Matt's executive secretary, handling an active phone call. You are speaking over a phone line — keep responses tight, natural, and conversational. No filler openers.

YOUR NAME IS EMMA. If a caller asks "what's your name?", "who am I speaking with?", "do you have a name?", or anything similar — answer with your actual name: "I'm Emma" or "Emma — Matt's assistant". Never dodge the question with just "I'm Matt's assistant" — that sounds evasive and callers notice. Once you've given your name, you don't need to repeat it on every turn.

If this is an INBOUND call (someone called the operator's number):
- Greet warmly: "Hi, this is Emma — Matt's assistant. How can I help?"
- Identify who's calling and why.
- ANY time you're going to add an event to Matt's calendar on a caller's behalf, you MUST collect the caller's name and a callback number first (so Matt can reach them if anything changes). Stitch them into the event notes when you call calendar_create. Phrasing: "Just so I can put your name on the event and pass it to Matt, can I get your name and the best number to reach you back?"
- If the caller wants to reach Matt directly without booking, take a message: name, number, reason, best time to reach back.
- Do NOT impersonate Matt. You are his assistant, not him.
- For unsolicited sales calls, politely decline and hang up.

If this is an OUTBOUND call (you're calling someone on the operator's behalf):
- Start: "Hi, this is Emma — Matt's assistant — calling on his behalf about [context]."
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
- BEFORE calling calendar_list_today or calendar_list_range, give the caller a SHORT verbal heads-up like "Let me pull up his calendar — one sec" or "Hold on while I check Monday for you." These tools talk to a real macOS Calendar and take 20–30 seconds. Without the heads-up the line goes dead-silent and callers think it dropped — the prior version of this prompt told you to be silent, that was wrong.
- For calendar_create, you have already read the event back and gotten a yes — silence after "okay, adding it now" is fine because the caller knows you're acting.
- Report findings in natural speech. "Matt has a 2pm today and he's open after 4" — not "matt_calendar returned three events at..."
- If the caller talks while you're waiting on a tool, that's fine — finish the lookup, then acknowledge what they said and answer.

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


# GA Realtime model (May 2026 migration). The preview model
# `gpt-4o-realtime-preview` and the `OpenAI-Beta: realtime=v1` header both
# deprecate on May 18, 2026, so we connect to `gpt-realtime` with no beta header.
OPENAI_REALTIME_WS = "wss://api.openai.com/v1/realtime?model=gpt-realtime"


def _today_human_string() -> str:
    """Today's date in operator-local timezone, formatted human-readably for
    the secretary prompt. Used by both the OpenAI Realtime and ElevenLabs
    Conv AI bridges so neither one hallucinates dates on phone calls."""
    from datetime import datetime
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo(settings.app_timezone or "America/New_York"))
    except Exception:
        now = datetime.now()
    return now.strftime("%A, %B %-d, %Y")


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
        """Open the OpenAI Realtime WebSocket and send the initial session config.

        Uses the GA Realtime schema (May 2026): no beta header, nested
        ``audio.input`` / ``audio.output`` config, MIME-typed format objects
        (audio/pcmu for telephony — Twilio's mulaw passes through directly to
        OpenAI's pcmu codec with no transcoding).
        """
        import websockets

        headers = [
            ("Authorization", f"Bearer {settings.openai_api_key}"),
        ]
        self.openai_ws = await websockets.connect(
            OPENAI_REALTIME_WS,
            additional_headers=headers,
            max_size=16 * 1024 * 1024,
        )

        session_config: dict[str, Any] = {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "instructions": self._instructions(),
                "output_modalities": ["audio"],
                "audio": {
                    "input": {
                        # Twilio sends mulaw/8000. pcmu IS mulaw — pass through
                        # base64 frames with zero transcoding.
                        "format": {"type": "audio/pcmu"},
                        "transcription": {"model": "whisper-1"},
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.5,
                            "prefix_padding_ms": 300,
                            "silence_duration_ms": 700,
                            "interrupt_response": True,
                        },
                    },
                    "output": {
                        "format": {"type": "audio/pcmu"},
                        "voice": (settings.openai_realtime_secretary_voice or "shimmer"),
                    },
                },
                # Tools the secretary can call mid-call. Read tools are
                # immediate; calendar_create requires a verbal confirmation
                # gate (enforced by SECRETARY_PHONE_INSTRUCTIONS).
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
            "Greet the caller as Emma — Matt's assistant — and ask how you can help. Keep it to one sentence and include your name."
            if self.direction == "inbound"
            else "Greet the callee as Emma, Matt's assistant, calling on his behalf, and briefly state the reason. Keep it to one sentence and include your name."
        )
        # GA Realtime renamed response.create's `modalities` → `output_modalities`.
        # The bare server name `text` is dropped too (it's implicit; only audio
        # needs to be requested explicitly).
        await self.openai_ws.send(
            json.dumps(
                {
                    "type": "response.create",
                    "response": {"output_modalities": ["audio"], "instructions": greeting},
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
        # Date grounding — see _ElevenLabsBridge._instructions for context.
        # Realtime models hallucinate dates without an explicit anchor.
        from datetime import datetime
        try:
            from zoneinfo import ZoneInfo
            now = datetime.now(ZoneInfo(settings.app_timezone or "America/New_York"))
        except Exception:
            now = datetime.now()
        base += (
            f"\n\n[Today's date: {now.strftime('%A, %B %-d, %Y')}. Current time: {now.strftime('%-I:%M %p %Z')}.]"
            "\n[When the caller says a relative day like 'Monday' or 'next Tuesday', "
            "compute the actual calendar date from today's date above. Read it back "
            "with the date number ('Monday, April 27th') so the caller can catch any mismatch.]"
        )
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
        """Pump OpenAI response.output_audio.delta → Twilio media frames."""
        audio_deltas = 0
        try:
            while not self.closed.is_set():
                if not self.openai_ws:
                    await asyncio.sleep(0.05)
                    continue
                raw = await self.openai_ws.recv()
                msg = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
                mtype = msg.get("type", "")
                # GA Realtime renamed audio events:
                #   response.audio.delta            → response.output_audio.delta
                #   response.audio_transcript.done  → response.output_audio_transcript.done
                # Accept the new names; the old names stop working when the
                # gpt-4o-realtime-preview model is retired on May 18, 2026.
                if mtype in ("response.output_audio.delta", "response.audio.delta"):
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
                        # `name` is reserved on LogRecord (it's the logger
                        # name); the formatter raises if we try to overwrite
                        # it via extra=. Use `tool` instead.
                        extra={"tool": tool_name, "args_keys": sorted(tool_args.keys())},
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
                    logger.info("telephony_tool_returned", extra={"tool": tool_name})
                elif mtype in ("session.updated", "response.created", "response.done", "response.output_item.done"):
                    # Surfaced so we can see the model actually processing. Volume is fine;
                    # a typical call only fires 10-30 of these total.
                    logger.info("telephony_openai_event", extra={"type": mtype})
                elif mtype in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
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


# ---------------------------------------------------------------------------
# ElevenLabs Conversational AI bridge
# ---------------------------------------------------------------------------
# Same shape as _CallBridge above, but the upstream is ElevenLabs Conv AI
# instead of OpenAI Realtime. The caller hears the operator's custom
# ElevenLabs voice (e.g. a cloned voice from their profile). Twilio side is
# identical — we still pump mulaw 8000 base64 frames in both directions.

class _ElevenLabsBridge:
    """Bridge a Twilio Media Stream to an ElevenLabs Conv AI conversation."""

    def __init__(self, twilio_ws, *, direction: str, context: str = "") -> None:
        self.twilio_ws = twilio_ws
        self.direction = direction
        self.context = context
        self.stream_sid: str | None = None
        self.eleven_ws = None
        self.closed = asyncio.Event()

    def _voice_id(self) -> str:
        # Resolution order: explicit secretary voice → general ElevenLabs
        # voice → the secretary agent profile's premium_voice_id → a known
        # stock female voice (Rachel) so the agent can at least be created.
        if settings.elevenlabs_secretary_voice_id:
            return settings.elevenlabs_secretary_voice_id
        if settings.elevenlabs_voice_id:
            return settings.elevenlabs_voice_id
        try:
            from app.services.agent_profile_service import agent_profile_service
            profile = agent_profile_service.get_profile("secretary") or {}
            vid = str(profile.get("premium_voice_id") or "").strip()
            if vid:
                return vid
        except Exception:
            pass
        return "21m00Tcm4TlvDq8ikWAM"  # ElevenLabs "Rachel" — stock fallback

    def _instructions(self) -> str:
        # Re-uses the same prompt-assembly logic as _CallBridge so behavior
        # is identical regardless of provider.
        base = SECRETARY_PHONE_INSTRUCTIONS
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
        # Date grounding — Realtime models have no clock, so without this the
        # model invents dates ("April eighth" when today is April 25th). The
        # caller hears the wrong date and either has to correct her or the
        # calendar event lands in the past. Live observation: this fired in
        # the very first ElevenLabs test call.
        from datetime import datetime
        try:
            from zoneinfo import ZoneInfo
            now = datetime.now(ZoneInfo(settings.app_timezone or "America/New_York"))
        except Exception:
            now = datetime.now()
        base += (
            f"\n\n[Today's date: {now.strftime('%A, %B %-d, %Y')}. Current time: {now.strftime('%-I:%M %p %Z')}.]"
            "\n[When the caller says a relative day like 'Monday' or 'next Tuesday', "
            "compute the actual calendar date from today's date above. Read it back "
            "with the date number ('Monday, April 27th') so the caller can catch any mismatch.]"
        )
        return base

    async def _connect_elevenlabs(self) -> None:
        """Provision the agent if needed, get a signed URL, open the WS,
        and send conversation_initiation_client_data with overrides."""
        import websockets

        from app.services.elevenlabs_convai_service import (
            ensure_agent,
            get_signed_ws_url,
        )

        prompt = self._instructions()
        voice_id = self._voice_id()
        first_message = (
            "Hi, this is Emma — Matt's assistant. How can I help?"
            if self.direction == "inbound"
            else "Hi, this is Emma — Matt's assistant — calling on his behalf."
        )

        agent_id = await ensure_agent(prompt=prompt, voice_id=voice_id, first_message=first_message)
        signed_url = await get_signed_ws_url(agent_id)

        self.eleven_ws = await websockets.connect(
            signed_url,
            max_size=16 * 1024 * 1024,
        )

        # Send conversation_initiation_client_data with per-call overrides.
        # The agent's stored config is the floor; this lets us push the
        # latest persona text + first_message without re-PATCHing the agent
        # on every single call.
        await self.eleven_ws.send(
            json.dumps(
                {
                    "type": "conversation_initiation_client_data",
                    "conversation_config_override": {
                        "agent": {
                            "prompt": {"prompt": prompt},
                            "first_message": first_message,
                            "language": "en",
                        },
                        "tts": {"voice_id": voice_id},
                    },
                    "custom_llm_extra_body": {},
                    # Surfacing the call direction as a piece of dynamic
                    # context the model can reference without us putting it
                    # in the prompt itself.
                    "dynamic_variables": {
                        "direction": self.direction,
                        "context": self.context or "",
                        # Date anchor — also baked into the prompt itself,
                        # but exposing it as a dynamic variable lets the
                        # agent reference {{today}} in templated responses
                        # if the persona is ever ported to the dashboard.
                        "today": _today_human_string(),
                    },
                }
            )
        )
        logger.info("telephony_greeting_primed", extra={"direction": self.direction})

    async def _twilio_to_elevenlabs(self) -> None:
        """Pump Twilio media frames → ElevenLabs user_audio_chunk."""
        try:
            while not self.closed.is_set():
                raw = await self.twilio_ws.receive_text()
                msg = json.loads(raw)
                event = msg.get("event")
                if event == "start":
                    self.stream_sid = msg.get("start", {}).get("streamSid")
                    logger.info(
                        "telephony_call_started",
                        extra={"stream_sid": self.stream_sid, "direction": self.direction, "provider": "elevenlabs"},
                    )
                elif event == "media" and self.eleven_ws:
                    payload = msg.get("media", {}).get("payload")
                    if payload:
                        await self.eleven_ws.send(
                            json.dumps({"user_audio_chunk": payload})
                        )
                elif event == "stop":
                    self.closed.set()
                    break
        except Exception as exc:
            logger.info("telephony_twilio_pump_ended", extra={"reason": str(exc)[:120]})
        finally:
            self.closed.set()

    async def _elevenlabs_to_twilio(self) -> None:
        """Pump ElevenLabs Conv AI events → Twilio media frames + tool calls."""
        audio_deltas = 0
        try:
            while not self.closed.is_set():
                if not self.eleven_ws:
                    await asyncio.sleep(0.05)
                    continue
                raw = await self.eleven_ws.recv()
                msg = json.loads(raw) if isinstance(raw, str) else json.loads(raw.decode())
                mtype = msg.get("type", "")

                if mtype == "audio":
                    # Conv AI wraps audio in audio_event.audio_base_64.
                    audio_event = msg.get("audio_event") or {}
                    delta = audio_event.get("audio_base_64") or audio_event.get("audio_base64")
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
                            logger.info(
                                "telephony_audio_delta",
                                extra={"count": audio_deltas, "provider": "elevenlabs"},
                            )

                elif mtype == "interruption":
                    # Caller spoke over the agent — flush queued Twilio audio
                    # so the interruption feels responsive.
                    if self.stream_sid:
                        await self.twilio_ws.send_text(
                            json.dumps({"event": "clear", "streamSid": self.stream_sid})
                        )

                elif mtype == "user_transcript":
                    # Caller's recognized speech.
                    transcript = str(
                        (msg.get("user_transcription_event") or {}).get("user_transcript")
                        or msg.get("user_transcript")
                        or ""
                    )[:160]
                    if transcript:
                        logger.info("telephony_caller_said", extra={"transcript": transcript})

                elif mtype == "agent_response":
                    transcript = str(
                        (msg.get("agent_response_event") or {}).get("agent_response")
                        or msg.get("agent_response")
                        or ""
                    )[:160]
                    if transcript:
                        logger.info("telephony_assistant_said", extra={"transcript": transcript})

                elif mtype == "client_tool_call":
                    # The agent wants to invoke one of our tools (calendar,
                    # etc.). Conv AI client tools always call back to us.
                    tool_event = msg.get("client_tool_call") or {}
                    tool_name = str(tool_event.get("tool_name") or "")
                    tool_call_id = str(tool_event.get("tool_call_id") or "")
                    tool_params = tool_event.get("parameters") or {}
                    if isinstance(tool_params, str):
                        try:
                            tool_params = json.loads(tool_params)
                        except Exception:
                            tool_params = {}
                    logger.info(
                        "telephony_tool_call",
                        extra={
                            "tool": tool_name,
                            "args_keys": sorted(tool_params.keys()) if isinstance(tool_params, dict) else [],
                            "provider": "elevenlabs",
                        },
                    )
                    output = await _call_phone_tool(tool_name, tool_params if isinstance(tool_params, dict) else {})
                    await self.eleven_ws.send(
                        json.dumps(
                            {
                                "type": "client_tool_result",
                                "tool_call_id": tool_call_id,
                                "result": json.dumps(output),
                                "is_error": "error" in (output or {}),
                            }
                        )
                    )
                    logger.info("telephony_tool_returned", extra={"tool": tool_name, "provider": "elevenlabs"})

                elif mtype == "ping":
                    # Conv AI sends keep-alive pings; reply with pong to keep
                    # the connection from being torn down by their side.
                    event_id = (msg.get("ping_event") or {}).get("event_id")
                    if event_id is not None:
                        await self.eleven_ws.send(
                            json.dumps({"type": "pong", "event_id": event_id})
                        )

                elif mtype in ("conversation_initiation_metadata", "agent_response_correction", "vad_score"):
                    # Useful for telemetry but not actionable on our side.
                    logger.info("telephony_convai_event", extra={"type": mtype})
                # All other event types ignored on purpose.
        except Exception as exc:
            logger.info(
                "telephony_elevenlabs_pump_ended",
                extra={"reason": str(exc)[:120], "audio_deltas": audio_deltas},
            )
        finally:
            self.closed.set()

    async def run(self) -> None:
        await self._connect_elevenlabs()
        try:
            await asyncio.gather(
                self._twilio_to_elevenlabs(),
                self._elevenlabs_to_twilio(),
                return_exceptions=True,
            )
        finally:
            if self.eleven_ws:
                try:
                    await self.eleven_ws.close()
                except Exception:
                    pass


def make_call_bridge(twilio_ws, *, direction: str, context: str = ""):
    """Pick the right bridge based on settings.secretary_voice_provider.

    Returns an instance with a ``.run()`` coroutine. The route handler
    awaits it; everything below this function is provider-agnostic.
    """
    provider = (settings.secretary_voice_provider or "openai").strip().lower()
    if provider == "elevenlabs":
        if not settings.elevenlabs_api_key:
            logger.warning(
                "telephony_provider_fallback",
                extra={"reason": "elevenlabs requested but ELEVENLABS_API_KEY missing"},
            )
        else:
            return _ElevenLabsBridge(twilio_ws, direction=direction, context=context)
    return _CallBridge(twilio_ws, direction=direction, context=context)


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

    def new_bridge(self, twilio_ws, *, direction: str, context: str = ""):
        # Picks the bridge whose upstream matches settings.secretary_voice_provider.
        # Falls back to OpenAI Realtime when ElevenLabs is requested but
        # ELEVENLABS_API_KEY isn't set, so misconfiguration never silently
        # drops a real phone call.
        return make_call_bridge(twilio_ws, direction=direction, context=context)


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
