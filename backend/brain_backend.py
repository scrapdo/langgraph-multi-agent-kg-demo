"""Entry point for the native-app build of the Brain backend.

PyInstaller bundles this (plus ``brain_backend.spec``) into a single
self-contained executable that Electron spawns as a subprocess. Responsibilities:

  * Pick a writable data directory under the user's Application Support folder
    (the PyInstaller-frozen binary lives inside a read-only .app bundle).
  * Export that directory as ``BRAIN_DATA_DIR`` so the backend's file-backed
    stores (``data/runs.json``, ``data/langgraph.sqlite3``, agent profiles,
    etc.) all land in one place.
  * Load config (API keys, optional flags) from ``config.json`` in the same
    directory, without crashing when the file is absent — the first-run
    wizard writes it.
  * Start uvicorn on ``127.0.0.1:8000`` (loopback only; never exposed).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _default_data_dir() -> Path:
    """Pick the right writable directory for this platform."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Brain"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Brain"
    return Path.home() / ".local" / "share" / "brain"


def _prepare_data_dir() -> Path:
    override = os.environ.get("BRAIN_DATA_DIR", "").strip()
    base = Path(override).expanduser() if override else _default_data_dir()
    (base / "data").mkdir(parents=True, exist_ok=True)
    return base


def _apply_config_file(base_dir: Path) -> None:
    """Load ``config.json`` and promote each key to an env var.

    Env vars take precedence over config.json (so the launcher can override),
    but config.json is the primary way the user's API keys reach the backend.
    """
    config_path = base_dir / "config.json"
    if not config_path.exists():
        return
    try:
        data = json.loads(config_path.read_text())
    except Exception:
        return
    if not isinstance(data, dict):
        return
    for key, value in data.items():
        if value is None:
            continue
        key_upper = str(key).upper()
        if key_upper not in os.environ:
            os.environ[key_upper] = str(value)


def main() -> None:
    base_dir = _prepare_data_dir()
    os.environ.setdefault("BRAIN_DATA_DIR", str(base_dir))

    _apply_config_file(base_dir)

    # Redirect all file-store paths into BRAIN_DATA_DIR so the frozen binary
    # doesn't try to write into its own read-only bundle. The config module
    # reads these via pydantic-settings on first import below.
    data_subdir = base_dir / "data"
    os.environ.setdefault("RUN_STORE_PATH", str(data_subdir / "runs.json"))
    os.environ.setdefault("AGENT_PROFILE_STORE_PATH", str(data_subdir / "agent_profiles.json"))
    os.environ.setdefault("SQLITE_CHECKPOINT_PATH", str(data_subdir / "langgraph.sqlite3"))

    # Native build: blank these so the optional-service guards activate.
    os.environ.setdefault("POSTGRES_DSN", "")
    os.environ.setdefault("REDIS_URL", "")
    os.environ.setdefault("NEO4J_URI", "")

    import uvicorn

    from app.main import app  # noqa: E402 — env must be set before app import

    host = os.environ.get("BRAIN_HOST", "127.0.0.1")
    port = int(os.environ.get("BRAIN_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_config=None)


if __name__ == "__main__":
    main()
