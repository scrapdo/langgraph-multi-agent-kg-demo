"""Poll Slack and Discord for mentions / DMs and dispatch background runs.

Lives on the same pattern as ``event_watcher_service`` — a single background
thread polling every ``poll_seconds``, comparing against the last-seen state,
and firing a ``create_run`` with a specialist-triage prompt when something new
shows up. The service no-ops until a token is configured and ``enabled`` is true.

Config schema (``data/chat_watchers.json``):

    {
      "slack": {
        "enabled": false,
        "bot_token": "",                       # xoxb-...
        "channels": [],                        # channel IDs or "all_dms"
        "poll_seconds": 120,
        "last_seen": {}                        # channel_id -> latest ts
      },
      "discord": {
        "enabled": false,
        "bot_token": "",
        "guild_ids": [],
        "poll_seconds": 180,
        "last_seen": {}
      },
      "user_id": "local",
      "session_id": "chat-watchers"
    }
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

import httpx

from app.core.config import settings
from app.services.run_service import create_run

logger = logging.getLogger("app.chat_watchers")

_DEFAULT: dict[str, Any] = {
    "slack": {
        "enabled": False,
        "bot_token": "",
        "channels": [],
        "poll_seconds": 120,
        "last_seen": {},
    },
    "discord": {
        "enabled": False,
        "bot_token": "",
        "guild_ids": [],
        "poll_seconds": 180,
        "last_seen": {},
    },
    "user_id": "local",
    "session_id": "chat-watchers",
}

_SLACK_API = "https://slack.com/api"
_DISCORD_API = "https://discord.com/api/v10"


class ChatWatchersService:
    def __init__(self) -> None:
        base = getattr(settings, "chat_watchers_store_path", "") or "data/chat_watchers.json"
        self._path = Path(base)
        if not self._path.is_absolute():
            self._path = Path.cwd() / self._path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    # ---- persistence ----
    def _read(self) -> dict[str, Any]:
        if not self._path.is_file():
            return json.loads(json.dumps(_DEFAULT))
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return json.loads(json.dumps(_DEFAULT))
        merged = json.loads(json.dumps(_DEFAULT))
        if isinstance(raw, dict):
            for k in ("slack", "discord"):
                merged[k].update(raw.get(k, {}) or {})
            for k in ("user_id", "session_id"):
                if k in raw:
                    merged[k] = raw[k]
        return merged

    def _write(self, cfg: dict[str, Any]) -> None:
        # Never persist empty tokens if user hasn't changed them; preserve what we had.
        self._path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")

    def get(self, *, redact_tokens: bool = True) -> dict[str, Any]:
        with self._lock:
            cfg = self._read()
            if redact_tokens:
                for provider in ("slack", "discord"):
                    tok = cfg[provider].get("bot_token") or ""
                    cfg[provider]["has_token"] = bool(tok)
                    cfg[provider]["bot_token"] = "*" * 6 if tok else ""
            return cfg

    def save(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            cfg = self._read()
            for provider in ("slack", "discord"):
                if provider not in patch or not isinstance(patch[provider], dict):
                    continue
                block = cfg[provider]
                supplied = patch[provider]
                if "enabled" in supplied:
                    block["enabled"] = bool(supplied["enabled"])
                if "poll_seconds" in supplied:
                    block["poll_seconds"] = max(60, int(supplied["poll_seconds"] or 120))
                if "channels" in supplied and isinstance(supplied["channels"], list):
                    block["channels"] = [str(x).strip() for x in supplied["channels"] if str(x).strip()]
                if "guild_ids" in supplied and isinstance(supplied["guild_ids"], list):
                    block["guild_ids"] = [str(x).strip() for x in supplied["guild_ids"] if str(x).strip()]
                if "bot_token" in supplied:
                    tok = str(supplied["bot_token"] or "").strip()
                    # Don't overwrite an existing token with the masked placeholder.
                    if tok and not tok.replace("*", "").strip() == "":
                        block["bot_token"] = tok
                    elif tok == "":
                        block["bot_token"] = ""
            for k in ("user_id", "session_id"):
                if k in patch:
                    cfg[k] = str(patch[k])
            self._write(cfg)
            return self.get()

    # ---- runtime ----
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="chat-watchers", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=1.5)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception:
                logger.exception("chat_watchers_tick_failed")
            # Sleep the shortest provider's poll_seconds.
            cfg = self._read()
            poll = min(
                max(60, int(cfg["slack"].get("poll_seconds") or 120)),
                max(60, int(cfg["discord"].get("poll_seconds") or 180)),
            )
            self._stop_event.wait(poll)

    def _tick(self) -> None:
        cfg = self._read()
        changed = False
        slack_changed = self._tick_slack(cfg)
        discord_changed = self._tick_discord(cfg)
        if slack_changed or discord_changed:
            changed = True
        if changed:
            with self._lock:
                self._write(cfg)

    # ---- Slack ----
    def _tick_slack(self, cfg: dict[str, Any]) -> bool:
        slack = cfg["slack"]
        if not (slack.get("enabled") and slack.get("bot_token") and slack.get("channels")):
            return False
        headers = {"Authorization": f"Bearer {slack['bot_token']}"}
        changed = False
        last_seen = slack.setdefault("last_seen", {})
        with httpx.Client(timeout=15, headers=headers) as client:
            for channel in slack["channels"]:
                oldest = str(last_seen.get(channel) or "")
                try:
                    resp = client.get(
                        f"{_SLACK_API}/conversations.history",
                        params={"channel": channel, "limit": 10, **({"oldest": oldest} if oldest else {})},
                    )
                    resp.raise_for_status()
                    body = resp.json()
                    if not body.get("ok"):
                        logger.warning("slack_api_error", extra={"channel": channel, "error": body.get("error")})
                        continue
                    messages = body.get("messages") or []
                    if not messages:
                        continue
                    # Newest first — dispatch in chronological order.
                    for msg in reversed(messages):
                        ts = str(msg.get("ts") or "")
                        if not ts or ts == oldest:
                            continue
                        text = str(msg.get("text") or "").strip()
                        user = str(msg.get("user") or "").strip() or "(unknown)"
                        if not text:
                            continue
                        prompt = (
                            "Triage this new Slack message into a one-line summary, suggested tone for a reply, "
                            "and whether it needs a real response today.\n\n"
                            f"Channel: {channel}\nFrom user: {user}\nMessage:\n\n\"\"\"\n{text[:4000]}\n\"\"\""
                        )
                        try:
                            create_run(
                                task=prompt,
                                mode="live",
                                user_id=str(cfg.get("user_id") or "local"),
                                session_id=str(cfg.get("session_id") or "chat-watchers"),
                                conservative_specialist_routing=False,
                            )
                        except Exception:
                            logger.exception("slack_triage_run_failed")
                    last_seen[channel] = str(messages[0].get("ts") or oldest)
                    changed = True
                except httpx.HTTPError as exc:
                    logger.warning("slack_http_error", extra={"channel": channel, "error": str(exc)})
        return changed

    # ---- Discord ----
    def _tick_discord(self, cfg: dict[str, Any]) -> bool:
        discord = cfg["discord"]
        if not (discord.get("enabled") and discord.get("bot_token") and discord.get("guild_ids")):
            return False
        headers = {"Authorization": f"Bot {discord['bot_token']}"}
        changed = False
        last_seen = discord.setdefault("last_seen", {})
        with httpx.Client(timeout=15, headers=headers) as client:
            for guild in discord["guild_ids"]:
                # Get channels where the bot can read, then pull the newest messages
                # since the last seen message_id. Intentionally shallow — most users
                # just want a ping about new @-mentions and one channel is enough.
                try:
                    ch_resp = client.get(f"{_DISCORD_API}/guilds/{guild}/channels")
                    ch_resp.raise_for_status()
                    channels = [c for c in ch_resp.json() if c.get("type") in (0, 1)]  # text / DM
                except httpx.HTTPError as exc:
                    logger.warning("discord_channels_failed", extra={"guild": guild, "error": str(exc)})
                    continue
                for channel in channels[:6]:
                    channel_id = str(channel.get("id"))
                    after = str(last_seen.get(channel_id) or "")
                    try:
                        params: dict[str, Any] = {"limit": 5}
                        if after:
                            params["after"] = after
                        resp = client.get(
                            f"{_DISCORD_API}/channels/{channel_id}/messages",
                            params=params,
                        )
                        resp.raise_for_status()
                        messages = resp.json() or []
                    except httpx.HTTPError as exc:
                        logger.warning("discord_messages_failed", extra={"channel": channel_id, "error": str(exc)})
                        continue
                    if not messages:
                        continue
                    for msg in reversed(messages):
                        msg_id = str(msg.get("id") or "")
                        text = str(msg.get("content") or "").strip()
                        author = str(((msg.get("author") or {}).get("username")) or "(unknown)")
                        if not msg_id or not text:
                            continue
                        prompt = (
                            "Triage this new Discord message into a one-line summary, suggested reply tone, "
                            "and whether it needs a response today.\n\n"
                            f"Channel: {channel.get('name') or channel_id}\nFrom: {author}\nMessage:\n\n\"\"\"\n{text[:4000]}\n\"\"\""
                        )
                        try:
                            create_run(
                                task=prompt,
                                mode="live",
                                user_id=str(cfg.get("user_id") or "local"),
                                session_id=str(cfg.get("session_id") or "chat-watchers"),
                                conservative_specialist_routing=False,
                            )
                        except Exception:
                            logger.exception("discord_triage_run_failed")
                    last_seen[channel_id] = str(messages[0].get("id") or after)
                    changed = True
        return changed


chat_watchers_service = ChatWatchersService()
