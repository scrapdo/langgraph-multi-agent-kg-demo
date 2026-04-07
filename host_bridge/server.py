from __future__ import annotations

import os
import platform
import shutil
import subprocess
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel


app = FastAPI(title="Host Automation Bridge")


def _require_auth(authorization: str | None) -> None:
    expected = os.getenv("HOST_AUTOMATION_TOKEN", "").strip()
    if not expected:
        return
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def _ensure_macos() -> None:
    if platform.system() != "Darwin":
        raise HTTPException(status_code=400, detail="Host bridge requires macOS.")


class PathPayload(BaseModel):
    path: str


class UrlPayload(BaseModel):
    url: str


class AppPayload(BaseModel):
    name: str


class AppPathPayload(BaseModel):
    path: str


def _resolve_target(path: str) -> str:
    raw = Path(path)
    if raw.is_absolute():
        return str(raw.expanduser().resolve())
    exports_root = os.getenv("HOST_EXPORTS_ROOT", "").strip()
    if exports_root:
        return str((Path(exports_root).expanduser() / path.replace("data/exports/", "")).resolve())
    return str(raw.expanduser().resolve())


@app.get("/status")
def status():
    return {
        "host_os": platform.system(),
        "osascript_available": bool(shutil.which("osascript")),
        "word_available": True,
    }


@app.post("/word/open")
def open_word(payload: PathPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    if not shutil.which("osascript"):
        raise HTTPException(status_code=400, detail="osascript unavailable")
    target = _resolve_target(payload.path)
    script = f'''
    tell application "Microsoft Word"
      activate
      open POSIX file "{target}"
    end tell
    '''
    subprocess.run(["osascript", "-e", script], check=True)
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
    subprocess.run(["open", payload.url], check=True)
    return {"ok": True, "url": payload.url}


@app.post("/app/open")
def open_app(payload: AppPayload, authorization: str | None = Header(default=None)):
    _require_auth(authorization)
    _ensure_macos()
    subprocess.run(["open", "-a", payload.name], check=True)
    return {"ok": True, "name": payload.name}


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
