from __future__ import annotations

import httpx

from app.core.config import settings


class NeuralTTSService:
    async def synthesize(self, text: str, voice: str | None = None, audio_format: str = "mp3") -> bytes:
        if not settings.openai_api_key:
            raise RuntimeError("OpenAI API key is not configured")

        payload = {
            "model": settings.openai_tts_model,
            "voice": voice or settings.openai_tts_voice,
            "input": text,
            "format": audio_format,
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
            raise RuntimeError(f"Neural speech request failed: {response.status_code} {detail}")

        return response.content


tts_service = NeuralTTSService()
