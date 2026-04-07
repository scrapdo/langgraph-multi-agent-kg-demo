from __future__ import annotations

import json

import httpx

from app.core.config import settings
from app.services.huggingface_service import huggingface_service


class RoutedTTSService:
    def _prepare_text_for_speech(self, text: str) -> str:
        cleaned = " ".join(text.split())
        cleaned = cleaned.replace(" - ", ", ")
        cleaned = cleaned.replace(":", ". ")
        cleaned = cleaned.replace(";", ". ")
        cleaned = cleaned.replace("...", ". ")
        cleaned = cleaned.replace(" .", ".")
        cleaned = cleaned.replace(" ,", ",")
        cleaned = cleaned.replace(" AI ", " A.I. ")
        cleaned = cleaned.replace("KG", "knowledge graph")
        cleaned = cleaned.replace("LangGraph", "Lang Graph")
        cleaned = cleaned.replace("Neo4j", "Neo four j")
        cleaned = cleaned.replace("Zep", "Zep")
        return cleaned.strip()

    def _profile_prompt(self, speech_profile: str, persona: str) -> tuple[str, float]:
        profile_map = {
            "natural": (
                "Speak like a calm, articulate human. Use contractions when natural, vary sentence rhythm, "
                "pause briefly between ideas, and avoid robotic list cadence or over-enunciation.",
                0.92,
            ),
            "warm": (
                "Speak in a warm, human, reassuring tone. Keep the cadence smooth, conversational, and lightly expressive.",
                0.91,
            ),
            "energetic": (
                "Speak with confident energy and momentum. Keep it human, expressive, and crisp without sounding rushed or synthetic.",
                0.98,
            ),
            "precise": (
                "Speak like a precise mission-control operator. Keep a firm, concise cadence, but still sound conversational and human.",
                0.96,
            ),
            "cinematic": (
                "Speak in a polished cinematic tone. Use deliberate pacing, stronger pauses, and natural emphasis on key phrases without sounding theatrical.",
                0.88,
            ),
        }
        base_prompt, speed = profile_map.get(speech_profile, profile_map["natural"])
        if persona.strip():
            return f"{base_prompt} Persona: {persona.strip()}", speed
        return base_prompt, speed

    async def _synthesize_openai(
        self,
        text: str,
        voice: str | None,
        audio_format: str,
        speech_profile: str,
        persona: str,
    ) -> bytes:
        if not settings.openai_api_key:
            raise RuntimeError("OpenAI API key is not configured")

        instructions, speed = self._profile_prompt(speech_profile, persona)
        prepared_text = self._prepare_text_for_speech(text)
        payload = {
            "model": settings.openai_tts_model,
            "voice": voice or settings.openai_tts_voice,
            "input": prepared_text,
            "format": audio_format,
            "instructions": instructions,
            "speed": speed,
        }
        headers = {
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        }
        endpoint = settings.openai_base_url.rstrip("/") + "/audio/speech"

        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(endpoint, headers=headers, json=payload)

        if response.status_code >= 400:
            detail = response.text[:220]
            raise RuntimeError(f"OpenAI speech request failed: {response.status_code} {detail}")
        return response.content

    async def _synthesize_elevenlabs(
        self,
        text: str,
        voice_id: str | None,
        speech_profile: str,
        persona: str,
    ) -> bytes:
        if not settings.elevenlabs_api_key:
            raise RuntimeError("ElevenLabs API key is not configured")

        resolved_voice_id = (voice_id or settings.elevenlabs_voice_id).strip()
        if not resolved_voice_id:
            raise RuntimeError("ElevenLabs voice ID is not configured")

        # Inference from ElevenLabs official API docs: POST /v1/text-to-speech/{voice_id}
        # with text, model_id, and voice_settings.
        voice_settings_map = {
            "natural": {"stability": 0.48, "similarity_boost": 0.82, "style": 0.28, "use_speaker_boost": True},
            "warm": {"stability": 0.42, "similarity_boost": 0.84, "style": 0.35, "use_speaker_boost": True},
            "energetic": {"stability": 0.36, "similarity_boost": 0.8, "style": 0.52, "use_speaker_boost": True},
            "precise": {"stability": 0.62, "similarity_boost": 0.86, "style": 0.18, "use_speaker_boost": True},
            "cinematic": {"stability": 0.45, "similarity_boost": 0.88, "style": 0.62, "use_speaker_boost": True},
        }
        payload = {
            "text": self._prepare_text_for_speech(text),
            "model_id": settings.elevenlabs_tts_model,
            "voice_settings": voice_settings_map.get(speech_profile, voice_settings_map["natural"]),
        }
        if persona.strip():
            payload["text"] = f"{persona.strip()}\n\n{payload['text']}"

        endpoint = f"{settings.elevenlabs_base_url.rstrip('/')}/text-to-speech/{resolved_voice_id}"
        headers = {
            "xi-api-key": settings.elevenlabs_api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        }
        params = {"output_format": "mp3_44100_128"}

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(endpoint, headers=headers, params=params, content=json.dumps(payload))

        if response.status_code >= 400:
            detail = response.text[:220]
            raise RuntimeError(f"ElevenLabs speech request failed: {response.status_code} {detail}")
        return response.content

    async def synthesize(
        self,
        text: str,
        provider: str | None = None,
        voice: str | None = None,
        audio_format: str = "mp3",
        speech_profile: str = "natural",
        persona: str = "",
        premium_voice_id: str | None = None,
    ) -> bytes:
        resolved_provider = (provider or settings.tts_provider_default or "openai").strip().lower()
        if resolved_provider == "elevenlabs":
            return await self._synthesize_elevenlabs(text, premium_voice_id, speech_profile, persona)
        if resolved_provider == "parler":
            return await huggingface_service.synthesize_parler(self._prepare_text_for_speech(text), persona)
        return await self._synthesize_openai(text, voice, audio_format, speech_profile, persona)


tts_service = RoutedTTSService()
