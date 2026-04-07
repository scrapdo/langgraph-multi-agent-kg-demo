from __future__ import annotations

from typing import Any

import httpx

from app.core.config import settings


class HeyGenService:
    def enabled(self) -> bool:
        return bool(settings.heygen_api_key)

    def _headers(self) -> dict[str, str]:
        if not self.enabled():
            raise RuntimeError("HeyGen API key is not configured")
        return {
            "X-Api-Key": settings.heygen_api_key,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _liveavatar_migration_message(response: httpx.Response) -> str | None:
        if response.status_code != 410:
            return None
        return (
            "HeyGen Interactive Avatar endpoints are sunset. "
            "Migrate this feature to LiveAvatar with a separate LiveAvatar API key. "
            "See https://docs.liveavatar.com/docs/liveavatar-vs-heygen-interactive-avatar"
        )

    async def list_assets(self) -> dict[str, Any]:
        if not self.enabled():
            return {"enabled": False, "avatars": [], "voices": []}

        async with httpx.AsyncClient(timeout=30) as client:
            avatars_res = await client.get(f"{settings.heygen_base_url.rstrip('/')}/v2/avatars", headers=self._headers())
            voices_res = await client.get(f"{settings.heygen_base_url.rstrip('/')}/v2/voices", headers=self._headers())

        if avatars_res.status_code >= 400:
            raise RuntimeError(f"HeyGen avatars request failed: {avatars_res.status_code} {avatars_res.text[:200]}")
        if voices_res.status_code >= 400:
            raise RuntimeError(f"HeyGen voices request failed: {voices_res.status_code} {voices_res.text[:200]}")

        avatars_payload = avatars_res.json()
        voices_payload = voices_res.json()
        avatars = avatars_payload.get("data", {}).get("avatars", avatars_payload.get("avatars", []))
        voices = voices_payload.get("data", {}).get("voices", voices_payload.get("voices", []))
        return {"enabled": True, "avatars": avatars, "voices": voices}

    async def create_video(self, script: str, avatar_id: str | None, voice_id: str | None) -> dict[str, Any]:
        if not self.enabled():
            raise RuntimeError("HeyGen API key is not configured")

        resolved_avatar = (avatar_id or settings.heygen_avatar_id).strip()
        resolved_voice = (voice_id or settings.heygen_voice_id).strip()
        if not resolved_avatar:
            raise RuntimeError("HeyGen avatar ID is required")
        if not resolved_voice:
            raise RuntimeError("HeyGen voice ID is required")

        payload = {
            "video_inputs": [
                {
                    "character": {
                        "type": "avatar",
                        "avatar_id": resolved_avatar,
                    },
                    "voice": {
                        "type": "text",
                        "input_text": script,
                        "voice_id": resolved_voice,
                    },
                    "background": {
                        "type": "color",
                        "value": "#0b1020",
                    },
                }
            ],
            "dimension": {"width": 1280, "height": 720},
        }

        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                f"{settings.heygen_base_url.rstrip('/')}/v2/video/generate",
                headers=self._headers(),
                json=payload,
            )

        if response.status_code >= 400:
            raise RuntimeError(f"HeyGen video create failed: {response.status_code} {response.text[:240]}")
        return response.json()

    async def create_live_session(self, avatar_id: str | None) -> dict[str, Any]:
        if not self.enabled():
            raise RuntimeError("HeyGen API key is not configured")
        resolved_avatar = (avatar_id or settings.heygen_avatar_id).strip()
        if not resolved_avatar:
            raise RuntimeError("HeyGen avatar ID is required")

        payload = {
            "version": "v2",
            "avatar_id": resolved_avatar,
        }
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{settings.heygen_base_url.rstrip('/')}/v1/streaming.new",
                headers={"Authorization": f"Bearer {settings.heygen_api_key}", "Content-Type": "application/json"},
                json=payload,
            )
        migration_message = self._liveavatar_migration_message(response)
        if migration_message:
            raise RuntimeError(migration_message)
        if response.status_code >= 400:
            raise RuntimeError(f"HeyGen live session create failed: {response.status_code} {response.text[:240]}")
        return response.json()

    async def start_live_session(self, session_id: str) -> dict[str, Any]:
        if not self.enabled():
            raise RuntimeError("HeyGen API key is not configured")
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{settings.heygen_base_url.rstrip('/')}/v1/streaming.start",
                headers={"Authorization": f"Bearer {settings.heygen_api_key}", "Content-Type": "application/json"},
                json={"session_id": session_id},
            )
        migration_message = self._liveavatar_migration_message(response)
        if migration_message:
            raise RuntimeError(migration_message)
        if response.status_code >= 400:
            raise RuntimeError(f"HeyGen live session start failed: {response.status_code} {response.text[:240]}")
        return response.json()

    async def send_live_task(self, session_id: str, text: str) -> dict[str, Any]:
        if not self.enabled():
            raise RuntimeError("HeyGen API key is not configured")
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{settings.heygen_base_url.rstrip('/')}/v1/streaming.task",
                headers={"Authorization": f"Bearer {settings.heygen_api_key}", "Content-Type": "application/json"},
                json={"session_id": session_id, "text": text, "task_type": "talk"},
            )
        migration_message = self._liveavatar_migration_message(response)
        if migration_message:
            raise RuntimeError(migration_message)
        if response.status_code >= 400:
            raise RuntimeError(f"HeyGen live task failed: {response.status_code} {response.text[:240]}")
        return response.json()

    async def stop_live_session(self, session_id: str) -> dict[str, Any]:
        if not self.enabled():
            raise RuntimeError("HeyGen API key is not configured")
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{settings.heygen_base_url.rstrip('/')}/v1/streaming.stop",
                headers={"Authorization": f"Bearer {settings.heygen_api_key}", "Content-Type": "application/json"},
                json={"session_id": session_id},
            )
        migration_message = self._liveavatar_migration_message(response)
        if migration_message:
            raise RuntimeError(migration_message)
        if response.status_code >= 400:
            raise RuntimeError(f"HeyGen live session stop failed: {response.status_code} {response.text[:240]}")
        return response.json()

    async def get_video_status(self, video_id: str) -> dict[str, Any]:
        if not self.enabled():
            raise RuntimeError("HeyGen API key is not configured")

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.get(
                f"{settings.heygen_base_url.rstrip('/')}/v1/video_status.get",
                headers=self._headers(),
                params={"video_id": video_id},
            )

        if response.status_code >= 400:
            raise RuntimeError(f"HeyGen video status failed: {response.status_code} {response.text[:240]}")
        return response.json()


heygen_service = HeyGenService()
