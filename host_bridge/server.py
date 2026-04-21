from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel


app = FastAPI(title="Host Automation Bridge")


_BOOT_TOKEN = os.getenv("HOST_AUTOMATION_TOKEN", "").strip()
if not _BOOT_TOKEN:
    sys.stderr.write(
        "host_bridge: HOST_AUTOMATION_TOKEN is not set. Refusing to start without auth.\n"
        "  Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(32))\"\n"
    )
    raise SystemExit(2)


def _allowed_roots() -> list[Path]:
    # Exports root is the primary allow-listed directory. Additional roots can be added via HOST_EXTRA_ROOTS (colon-separated).
    raw_roots: list[str] = []
    exports = os.getenv("HOST_EXPORTS_ROOT", "").strip()
    if exports:
        raw_roots.append(exports)
    extra = os.getenv("HOST_EXTRA_ROOTS", "").strip()
    if extra:
        raw_roots.extend(part for part in extra.split(":") if part)
    resolved: list[Path] = []
    for entry in raw_roots:
        try:
            resolved.append(Path(entry).expanduser().resolve())
        except OSError:
            continue
    return resolved


def _require_auth(authorization: str | None) -> None:
    if authorization != f"Bearer {_BOOT_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def _ensure_macos() -> None:
    if platform.system() != "Darwin":
        raise HTTPException(status_code=400, detail="Host bridge requires macOS.")


_UNSAFE_PATH_CHARS = re.compile(r'[\x00-\x1f"\\\n\r;]')


def _validate_path_string(raw: str) -> str:
    stripped = raw.strip()
    if not stripped:
        raise HTTPException(status_code=400, detail="Path must not be empty.")
    if _UNSAFE_PATH_CHARS.search(stripped):
        raise HTTPException(status_code=400, detail="Path contains disallowed characters.")
    return stripped


def _resolve_target(raw_path: str) -> str:
    cleaned = _validate_path_string(raw_path)
    candidate = Path(cleaned)
    if not candidate.is_absolute():
        roots = _allowed_roots()
        if roots:
            relative = cleaned.replace("data/exports/", "")
            candidate = roots[0] / relative
        else:
            candidate = candidate.expanduser()
    target = candidate.expanduser().resolve()

    allowed = _allowed_roots()
    if allowed:
        for root in allowed:
            try:
                target.relative_to(root)
                break
            except ValueError:
                continue
        else:
            raise HTTPException(status_code=400, detail="Path is outside allow-listed roots.")
    return str(target)


def _validate_app_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Application name must not be empty.")
    if not re.fullmatch(r"[A-Za-z0-9 _.&+'\-()]{1,64}", cleaned):
        raise HTTPException(status_code=400, detail="Application name contains disallowed characters.")
    return cleaned


def _validate_url(url: str) -> str:
    cleaned = url.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="URL must not be empty.")
    if not re.match(r"^https?://", cleaned):
        raise HTTPException(status_code=400, detail="Only http(s):// URLs are allowed.")
    if _UNSAFE_PATH_CHARS.search(cleaned):
        raise HTTPException(status_code=400, detail="URL contains disallowed characters.")
    return cleaned


class PathPayload(BaseModel):
    path: str


class UrlPayload(BaseModel):
    url: str


class AppPayload(BaseModel):
    name: str


class AppPathPayload(BaseModel):
    path: str


@app.get("/status")
def status():
    return {
        "host_os": platform.system(),
        "osascript_available": bool(shutil.which("osascript")),
        "word_available": True,
        "allowed_roots": [str(root) for root in _allowed_roots()],
    }


@app.post("/word/open")
def open_word(payload: PathPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    if not shutil.which("osascript"):
        raise HTTPException(status_code=400, detail="osascript unavailable")
    target = _resolve_target(payload.path)
    # The path is passed as an argv parameter rather than interpolated into the script, so
    # AppleScript treats it as a literal string even if it contains metacharacters.
    script = (
        'on run argv\n'
        '  set targetPath to item 1 of argv\n'
        '  tell application "Microsoft Word"\n'
        '    activate\n'
        '    open POSIX file targetPath\n'
        '  end tell\n'
        'end run'
    )
    subprocess.run(["osascript", "-e", script, target], check=True)
    return {"ok": True, "path": target}


@app.post("/finder/reveal")
def reveal_finder(payload: PathPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    target = _resolve_target(payload.path)
    subprocess.run(["open", "-R", target], check=True)
    return {"ok": True, "path": target}


@app.post("/browser/open")
def open_browser(payload: UrlPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    url = _validate_url(payload.url)
    subprocess.run(["open", url], check=True)
    return {"ok": True, "url": url}


@app.post("/app/open")
def open_app(payload: AppPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    name = _validate_app_name(payload.name)
    subprocess.run(["open", "-a", name], check=True)
    return {"ok": True, "name": name}


@app.post("/app/open-path")
def open_app_path(payload: AppPathPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    target = _resolve_target(payload.path)
    subprocess.run(["open", target], check=True)
    return {"ok": True, "path": target}


@app.post("/path/open")
def open_path(payload: PathPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    target = _resolve_target(payload.path)
    subprocess.run(["open", target], check=True)
    return {"ok": True, "path": target}


# ---------------------------------------------------------------------------
# Spotify / Messages / Mail / Calendar — app-control endpoints.
#
# Every AppleScript below uses ``on run argv`` and receives user-supplied values
# as positional arguments to osascript. That keeps values treated as literal
# strings and prevents AppleScript injection even if the inputs contain quotes,
# backslashes, or newlines. Never interpolate user input directly into the
# script body.
# ---------------------------------------------------------------------------

_SAFE_TEXT = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')  # disallow nulls + non-printable controls


def _validate_short_text(raw: str, *, field: str, max_len: int = 200) -> str:
    cleaned = (raw or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail=f"{field} must not be empty.")
    if len(cleaned) > max_len:
        raise HTTPException(status_code=400, detail=f"{field} is too long (max {max_len}).")
    if _SAFE_TEXT.search(cleaned):
        raise HTTPException(status_code=400, detail=f"{field} contains disallowed control characters.")
    return cleaned


def _validate_body_text(raw: str, *, field: str, max_len: int = 4000) -> str:
    cleaned = (raw or "").strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail=f"{field} must not be empty.")
    if len(cleaned) > max_len:
        raise HTTPException(status_code=400, detail=f"{field} is too long (max {max_len}).")
    # Bodies can contain newlines; strip only true control chars.
    if _SAFE_TEXT.search(cleaned):
        raise HTTPException(status_code=400, detail=f"{field} contains disallowed control characters.")
    return cleaned


def _run_osascript(script: str, *args: str, timeout: float = 15.0) -> str:
    if not shutil.which("osascript"):
        raise HTTPException(status_code=400, detail="osascript unavailable")
    try:
        result = subprocess.run(
            ["osascript", "-e", script, *args],
            check=True,
            timeout=timeout,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="osascript timed out")
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()[:500]
        raise HTTPException(status_code=500, detail=f"osascript failed: {stderr}") from exc
    return (result.stdout or "").strip()


# ---- Spotify --------------------------------------------------------------

class SpotifyPlayQueryPayload(BaseModel):
    query: str


_SPOTIFY_PLAY = 'tell application "Spotify" to play'
_SPOTIFY_PAUSE = 'tell application "Spotify" to pause'
_SPOTIFY_NEXT = 'tell application "Spotify" to next track'
_SPOTIFY_PREV = 'tell application "Spotify" to previous track'
_SPOTIFY_NOW_PLAYING = (
    'tell application "Spotify"\n'
    '  if player state is playing or player state is paused then\n'
    '    set trackName to name of current track\n'
    '    set trackArtist to artist of current track\n'
    '    set trackAlbum to album of current track\n'
    '    set trackState to (player state as string)\n'
    '    return trackName & "||" & trackArtist & "||" & trackAlbum & "||" & trackState\n'
    '  else\n'
    '    return ""\n'
    '  end if\n'
    'end tell'
)
_SPOTIFY_PLAY_QUERY = (
    'on run argv\n'
    '  set q to item 1 of argv\n'
    '  tell application "Spotify"\n'
    '    activate\n'
    '  end tell\n'
    # spotify:search:{q} is a native Spotify URL that opens in the desktop app.
    '  do shell script "open " & quoted form of ("spotify:search:" & q)\n'
    'end run'
)


@app.post("/spotify/play")
def spotify_play(authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    _run_osascript(_SPOTIFY_PLAY)
    return {"ok": True, "app": "spotify", "action": "play"}


@app.post("/spotify/pause")
def spotify_pause(authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    _run_osascript(_SPOTIFY_PAUSE)
    return {"ok": True, "app": "spotify", "action": "pause"}


@app.post("/spotify/next")
def spotify_next(authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    _run_osascript(_SPOTIFY_NEXT)
    return {"ok": True, "app": "spotify", "action": "next"}


@app.post("/spotify/previous")
def spotify_previous(authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    _run_osascript(_SPOTIFY_PREV)
    return {"ok": True, "app": "spotify", "action": "previous"}


@app.post("/spotify/now-playing")
def spotify_now_playing(authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    raw = _run_osascript(_SPOTIFY_NOW_PLAYING)
    if not raw:
        return {"ok": True, "app": "spotify", "playing": False}
    parts = raw.split("||")
    return {
        "ok": True,
        "app": "spotify",
        "playing": True,
        "track": parts[0] if len(parts) > 0 else "",
        "artist": parts[1] if len(parts) > 1 else "",
        "album": parts[2] if len(parts) > 2 else "",
        "state": parts[3] if len(parts) > 3 else "",
    }


@app.post("/spotify/play-query")
def spotify_play_query(
    payload: SpotifyPlayQueryPayload, authorization: str | None = Header(default=None)
):
    """Open a Spotify search for the given query inside the Spotify desktop app.

    AppleScript cannot reliably 'play the top result' without the Web API, so
    this opens the search in the Spotify app; the user taps the first result.
    """
    _require_auth(authorization)
    _ensure_macos()
    q = _validate_short_text(payload.query, field="query", max_len=120)
    _run_osascript(_SPOTIFY_PLAY_QUERY, q)
    return {"ok": True, "app": "spotify", "action": "search", "query": q}


# ---- Messages (iMessage) -------------------------------------------------

class MessagesSendPayload(BaseModel):
    to: str  # phone number (e.g. +15551234567) or email
    body: str


_MESSAGES_SEND_SCRIPT = (
    'on run argv\n'
    '  set theTo to item 1 of argv\n'
    '  set theBody to item 2 of argv\n'
    '  tell application "Messages"\n'
    '    set targetService to id of (1st service whose service type = iMessage)\n'
    '    set theBuddy to buddy theTo of service id targetService\n'
    '    send theBody to theBuddy\n'
    '  end tell\n'
    'end run'
)


@app.post("/messages/send")
def messages_send(payload: MessagesSendPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    to = _validate_short_text(payload.to, field="to", max_len=120)
    body = _validate_body_text(payload.body, field="body", max_len=4000)
    _run_osascript(_MESSAGES_SEND_SCRIPT, to, body)
    return {"ok": True, "app": "messages", "to": to}


# ---- Mail ----------------------------------------------------------------

class MailDraftPayload(BaseModel):
    to: str
    subject: str
    body: str
    send: bool = False  # default to draft for safety — user reviews before sending


_MAIL_COMPOSE_SCRIPT = (
    'on run argv\n'
    '  set theTo to item 1 of argv\n'
    '  set theSubject to item 2 of argv\n'
    '  set theBody to item 3 of argv\n'
    '  set sendFlag to item 4 of argv\n'
    '  tell application "Mail"\n'
    '    set visibleFlag to (sendFlag is not "1")\n'
    '    set theMessage to make new outgoing message with properties {subject:theSubject, content:theBody, visible:visibleFlag}\n'
    '    tell theMessage\n'
    '      make new to recipient at end of to recipients with properties {address:theTo}\n'
    '    end tell\n'
    '    if sendFlag is "1" then\n'
    '      send theMessage\n'
    '    else\n'
    '      activate\n'
    '    end if\n'
    '  end tell\n'
    'end run'
)


@app.post("/mail/compose")
def mail_compose(payload: MailDraftPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    to = _validate_short_text(payload.to, field="to", max_len=200)
    subject = _validate_short_text(payload.subject, field="subject", max_len=300)
    body = _validate_body_text(payload.body, field="body", max_len=20000)
    send_flag = "1" if payload.send else "0"
    _run_osascript(_MAIL_COMPOSE_SCRIPT, to, subject, body, send_flag)
    return {"ok": True, "app": "mail", "to": to, "sent": payload.send}


# ---- Calendar ------------------------------------------------------------

class CalendarCreatePayload(BaseModel):
    title: str
    start_iso: str  # ISO 8601, e.g. 2026-04-19T15:00:00
    end_iso: str
    notes: str = ""
    calendar: str = ""  # optional named calendar; else the first writable calendar


# JavaScript-for-Automation (JXA) version. The AppleScript
# ``every event ... whose`` pattern iterates every historical event in every
# calendar and regularly hangs for 30+ seconds on Macs with years of iCloud
# calendar history. JXA gives us a tighter, faster path: we ask Calendar for
# a bounded date range directly and only touch the properties we need.
_CALENDAR_LIST_TODAY_SCRIPT_JXA = r"""
var app = Application('Calendar');
app.includeStandardAdditions = true;
var start = new Date();
start.setHours(0, 0, 0, 0);
var end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
var lines = [];
var cals = app.calendars();
for (var i = 0; i < cals.length; i++) {
  var cal = cals[i];
  var calName = cal.name();
  try {
    var evs = cal.events.whose({
      _and: [
        { startDate: { '>=': start } },
        { startDate: { '<': end } }
      ]
    })();
    for (var j = 0; j < evs.length; j++) {
      var e = evs[j];
      var s = e.summary();
      var sd = e.startDate();
      var ed = e.endDate();
      lines.push([s, sd.toISOString(), ed.toISOString(), calName].join('||'));
    }
  } catch (err) {
    // Skip calendars that error (e.g. temporarily offline Exchange accounts).
  }
}
lines.join('\n');
"""


def _run_osascript_jxa(script: str, *args: str, timeout: float = 15.0) -> str:
    if not shutil.which("osascript"):
        raise HTTPException(status_code=400, detail="osascript unavailable")
    try:
        result = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", script, *args],
            check=True,
            timeout=timeout,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail=(
                "Calendar took too long to respond. Try again in a moment — "
                "Calendar may be syncing or loading for the first time this session."
            ),
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()[:500]
        raise HTTPException(status_code=500, detail=f"Calendar script failed: {stderr}") from exc
    return (result.stdout or "").strip()

_CALENDAR_CREATE_SCRIPT = (
    'on run argv\n'
    '  set theTitle to item 1 of argv\n'
    '  set theStart to item 2 of argv\n'
    '  set theEnd to item 3 of argv\n'
    '  set theNotes to item 4 of argv\n'
    '  set theCalName to item 5 of argv\n'
    # Convert ISO "2026-04-19T15:00:00" to AppleScript date via do shell script / date -j.
    '  set startEpoch to (do shell script "date -j -f %Y-%m-%dT%H:%M:%S " & quoted form of theStart & " +%s")\n'
    '  set endEpoch to (do shell script "date -j -f %Y-%m-%dT%H:%M:%S " & quoted form of theEnd & " +%s")\n'
    '  set theStartDate to (current date) - ((do shell script "date +%s") as integer) + (startEpoch as integer)\n'
    '  set theEndDate to (current date) - ((do shell script "date +%s") as integer) + (endEpoch as integer)\n'
    '  tell application "Calendar"\n'
    '    if theCalName is "" then\n'
    '      set targetCal to first calendar whose writable is true\n'
    '    else\n'
    '      set targetCal to first calendar whose name is theCalName\n'
    '    end if\n'
    '    tell targetCal\n'
    '      set newEvent to make new event with properties {summary:theTitle, start date:theStartDate, end date:theEndDate, description:theNotes}\n'
    '      return id of newEvent\n'
    '    end tell\n'
    '  end tell\n'
    'end run'
)


@app.post("/calendar/list-today")
def calendar_list_today(authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    # 10-second cap. Apple Calendar's scripting bridge is slow on Macs with
    # years of iCloud history — we prefer a quick "couldn't read calendar"
    # error over a long hang. The delegator catches this and tells the operator
    # to check Calendar.app directly.
    raw = _run_osascript_jxa(_CALENDAR_LIST_TODAY_SCRIPT_JXA, timeout=10.0)
    events: list[dict[str, Any]] = []
    for line in raw.splitlines():
        parts = line.split("||")
        if len(parts) < 3:
            continue
        events.append(
            {
                "title": parts[0],
                "start": parts[1],
                "end": parts[2],
                "calendar": parts[3] if len(parts) > 3 else "",
            }
        )
    return {"ok": True, "app": "calendar", "events": events, "count": len(events)}


# Accept any ISO-8601-ish timestamp. LLMs emit a variety of formats:
#   2026-04-22T14:00:00, 2026-04-22T14:00:00Z, 2026-04-22T14:00:00-04:00,
#   2026-04-22T14:00 (no seconds), 2026-04-22 14:00:00 (space instead of T),
#   2026-04-22T14:00:00.123 (fractional seconds).
# We normalize all of these to YYYY-MM-DDTHH:MM:SS (local time) — what the
# AppleScript date literal expects.
_ISO_RE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})[T ]"
    r"(?P<hms>\d{2}:\d{2}(?::\d{2})?)"
    r"(?:\.\d+)?"
    r"(?:Z|[+-]\d{2}:?\d{2})?$"
)


def _normalize_iso_for_applescript(raw: str, *, field: str) -> str:
    match = _ISO_RE.match(raw.strip())
    if not match:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{field} must be ISO format like 2026-04-22T14:00 or "
                f"2026-04-22T14:00:00 (timezone suffixes accepted but treated as local)."
            ),
        )
    date = match.group("date")
    hms = match.group("hms")
    # Pad missing seconds so the AppleScript date parser gets a full HH:MM:SS.
    if hms.count(":") == 1:
        hms = f"{hms}:00"
    return f"{date}T{hms}"


@app.post("/calendar/create")
def calendar_create(payload: CalendarCreatePayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    title = _validate_short_text(payload.title, field="title", max_len=200)
    start_raw = _validate_short_text(payload.start_iso, field="start_iso", max_len=40)
    end_raw = _validate_short_text(payload.end_iso, field="end_iso", max_len=40)
    start = _normalize_iso_for_applescript(start_raw, field="start_iso")
    end = _normalize_iso_for_applescript(end_raw, field="end_iso")
    notes = (payload.notes or "").strip()
    if notes and _SAFE_TEXT.search(notes):
        raise HTTPException(status_code=400, detail="notes contains disallowed control characters.")
    notes = notes[:4000]
    cal_name = (payload.calendar or "").strip()
    if cal_name and not re.fullmatch(r"[A-Za-z0-9 _.&+'\-()]{1,64}", cal_name):
        raise HTTPException(status_code=400, detail="Calendar name contains disallowed characters.")
    event_id = _run_osascript(_CALENDAR_CREATE_SCRIPT, title, start, end, notes, cal_name, timeout=30.0)
    return {"ok": True, "app": "calendar", "event_id": event_id, "title": title, "start": start, "end": end}


# Unused import shield — json is reserved for future calendar return shaping.
_ = json
