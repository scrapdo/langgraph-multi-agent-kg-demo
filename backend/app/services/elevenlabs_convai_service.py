"""ElevenLabs Conversational AI integration for the Secretary phone.

Provides a parallel path to OpenAI Realtime: when
``settings.secretary_voice_provider == "elevenlabs"`` the inbound/outbound
phone bridges open a WebSocket against ElevenLabs Conv AI instead of
OpenAI Realtime. Same Twilio side, different upstream brain — and the
caller hears the operator's custom ElevenLabs voice (e.g. a cloned voice
from the agent_profile_service profile) instead of OpenAI's stock voices.

Architecture choice: programmatic agent provisioning. We don't ask the
operator to go to the ElevenLabs dashboard and copy/paste an agent ID. On
the first call, we POST to /v1/convai/agents/create with the persona
prompt + voice + tool schemas, persist the resulting agent ID at
``data/secretary_elevenlabs_agent.json``, and reuse it for every
subsequent call. Re-provisioning happens automatically when the persona
or tool schemas change (the local cache stores a fingerprint).

Audio: agents are configured for ``ulaw_8000`` so we can pipe Twilio
mulaw frames straight through with zero transcoding — same wire-format
free ride we get with OpenAI Realtime's ``g711_ulaw``.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

import httpx

from app.core.config import settings


logger = logging.getLogger("app.elevenlabs_convai")


_AGENT_CACHE_PATH = Path("data/secretary_elevenlabs_agent.json")
_API_BASE = "https://api.elevenlabs.io"


class ElevenLabsConvAIError(RuntimeError):
    """Raised when agent provisioning or signed-URL retrieval fails."""


def _headers() -> dict[str, str]:
    if not settings.elevenlabs_api_key:
        raise ElevenLabsConvAIError("ELEVENLABS_API_KEY not configured.")
    return {
        "xi-api-key": settings.elevenlabs_api_key,
        "Content-Type": "application/json",
    }


def _fingerprint(prompt: str, voice_id: str, tools: list[dict[str, Any]]) -> str:
    """Stable hash of the bits that affect agent behavior. If any of these
    change we re-provision the agent so the live experience matches the
    config in the repo."""
    payload = json.dumps(
        {"prompt": prompt, "voice_id": voice_id, "tools": tools},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _read_cache() -> dict[str, Any]:
    if not _AGENT_CACHE_PATH.exists():
        return {}
    try:
        return json.loads(_AGENT_CACHE_PATH.read_text())
    except Exception:
        return {}


def _write_cache(data: dict[str, Any]) -> None:
    _AGENT_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _AGENT_CACHE_PATH.write_text(json.dumps(data, indent=2))


def _agent_payload(
    name: str,
    prompt: str,
    first_message: str,
    voice_id: str,
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the create-agent POST body. ElevenLabs Conv AI's schema lives
    under conversation_config — agent prompt, voice, ASR/TTS formats, and
    optional client tools."""
    return {
        "name": name,
        "conversation_config": {
            "agent": {
                "prompt": {
                    "prompt": prompt,
                    # client_tools at agent level so they show up at runtime
                    "tools": tools,
                },
                "first_message": first_message,
                "language": "en",
            },
            "tts": {
                "voice_id": voice_id,
                # Conv AI rejects eleven_turbo_v2_5 for English agents
                # ("English Agents must use turbo or flash v2"). Stick with
                # the v2 line — turbo balances latency and quality, flash is
                # absolute fastest but slightly lower naturalness. Turbo is
                # the right pick for a phone secretary.
                "model_id": "eleven_turbo_v2",
                # Phone audio: 8 kHz mulaw matches Twilio Media Streams.
                "agent_output_audio_format": "ulaw_8000",
            },
            "asr": {
                # Caller audio comes in as mulaw 8000 from Twilio, no transcode.
                "user_input_audio_format": "ulaw_8000",
            },
            "turn": {
                # Lets the model interrupt naturally when the caller speaks.
                "turn_timeout": 7,
            },
        },
    }


def _client_tool_schemas() -> list[dict[str, Any]]:
    """Translate our phone-tool function specs into ElevenLabs Conv AI's
    client-tool schema. Same surface as the OpenAI Realtime path so the
    model's behavior is identical regardless of provider."""
    return [
        {
            "type": "client",
            "name": "calendar_list_today",
            "description": "List every event on Matt's Mac Calendar for today.",
            "parameters": {"type": "object", "properties": {}},
            "expects_response": True,
            "response_timeout_secs": 30,
        },
        {
            "type": "client",
            "name": "calendar_list_range",
            "description": "List events on Matt's Mac Calendar over the next N days. Use for 'next Tuesday' or 'this week'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 14,
                        "description": "Number of days forward from today to include.",
                    }
                },
                "required": ["days_ahead"],
            },
            "expects_response": True,
            "response_timeout_secs": 60,
        },
        {
            "type": "client",
            "name": "calendar_create",
            "description": (
                "ADD an event to Matt's Mac Calendar. REQUIRES verbal confirmation — "
                "read the full title, date, and time back to the caller and wait for "
                "an explicit yes before calling."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Event title — what the operator will see on their calendar.",
                    },
                    "start_iso": {
                        "type": "string",
                        "description": "Start time in ISO 8601 local time, e.g. 2026-11-12T14:00:00 (no timezone suffix).",
                    },
                    "end_iso": {
                        "type": "string",
                        "description": "End time in ISO 8601 local time, same format as start_iso.",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Optional notes to attach (caller name, reason, phone number, etc.).",
                    },
                },
                "required": ["title", "start_iso", "end_iso"],
            },
            "expects_response": True,
            "response_timeout_secs": 30,
        },
    ]


async def _create_agent(name: str, payload: dict[str, Any]) -> str:
    """POST /v1/convai/agents/create — returns agent_id. Raises on failure."""
    url = f"{_API_BASE}/v1/convai/agents/create"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(url, headers=_headers(), json=payload)
    if response.status_code >= 400:
        raise ElevenLabsConvAIError(
            f"ElevenLabs agent create failed ({response.status_code}): {response.text[:300]}"
        )
    body = response.json()
    agent_id = str(body.get("agent_id") or body.get("id") or "")
    if not agent_id:
        raise ElevenLabsConvAIError(f"agent create succeeded but no agent_id returned: {body}")
    # `name` is reserved on LogRecord; pass as `agent_name`.
    logger.info("elevenlabs_convai_agent_created", extra={"agent_id": agent_id, "agent_name": name})
    return agent_id


async def _update_agent(agent_id: str, payload: dict[str, Any]) -> None:
    """PATCH /v1/convai/agents/{agent_id} — updates an existing agent's config."""
    url = f"{_API_BASE}/v1/convai/agents/{agent_id}"
    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.patch(url, headers=_headers(), json=payload)
    if response.status_code >= 400:
        raise ElevenLabsConvAIError(
            f"ElevenLabs agent update failed ({response.status_code}): {response.text[:300]}"
        )
    logger.info("elevenlabs_convai_agent_updated", extra={"agent_id": agent_id})


async def ensure_agent(prompt: str, voice_id: str, first_message: str) -> str:
    """Get the persistent Conv AI agent ID, creating or updating as needed.

    Cache schema (data/secretary_elevenlabs_agent.json):
        {"agent_id": "...", "fingerprint": "...", "voice_id": "..."}

    If the persona prompt or tool list has changed since last call, we
    PATCH the existing agent so the next conversation reflects the update.
    If the cache is missing or the saved agent_id was deleted upstream, we
    create a fresh one.
    """
    explicit = (settings.elevenlabs_secretary_agent_id or "").strip()
    if explicit:
        # Operator pinned a specific agent in env — trust it, no provisioning.
        return explicit

    tools = _client_tool_schemas()
    fingerprint = _fingerprint(prompt, voice_id, tools)
    cache = _read_cache()

    cached_id = str(cache.get("agent_id") or "").strip()
    cached_fp = str(cache.get("fingerprint") or "").strip()

    if cached_id and cached_fp == fingerprint:
        return cached_id

    payload = _agent_payload(
        name="Brain Secretary (Emma)",
        prompt=prompt,
        first_message=first_message,
        voice_id=voice_id,
        tools=tools,
    )

    if cached_id:
        # Persona or tools drifted — push the new config to the existing agent.
        try:
            await _update_agent(cached_id, payload)
            cache["fingerprint"] = fingerprint
            cache["voice_id"] = voice_id
            _write_cache(cache)
            return cached_id
        except ElevenLabsConvAIError as exc:
            # Cached agent disappeared (deleted on the dashboard) — fall
            # through to create-fresh.
            logger.warning(
                "elevenlabs_convai_update_failed_recreating",
                extra={"agent_id": cached_id, "error": str(exc)[:200]},
            )

    agent_id = await _create_agent("Brain Secretary (Emma)", payload)
    _write_cache({"agent_id": agent_id, "fingerprint": fingerprint, "voice_id": voice_id})
    return agent_id


async def get_signed_ws_url(agent_id: str) -> str:
    """Get a short-lived signed WebSocket URL for the given agent.

    ElevenLabs Conv AI supports two auth modes for the conversation WS:
      1. Pass xi-api-key header (works but exposes the key to the client).
      2. GET a signed URL from /v1/convai/conversation/get_signed_url and
         use that — auth is in the URL, time-limited, no headers needed.

    We use signed URLs because some WebSocket clients (and in particular
    the ``websockets`` lib's ``additional_headers`` path) drop custom
    headers on certain proxy chains.
    """
    url = f"{_API_BASE}/v1/convai/conversation/get_signed_url?agent_id={agent_id}"
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(url, headers=_headers())
    if response.status_code >= 400:
        raise ElevenLabsConvAIError(
            f"signed URL fetch failed ({response.status_code}): {response.text[:300]}"
        )
    body = response.json()
    signed = str(body.get("signed_url") or "").strip()
    if not signed:
        raise ElevenLabsConvAIError(f"signed URL response missing signed_url: {body}")
    return signed
