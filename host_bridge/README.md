# Host Automation Bridge

This bridge is a small FastAPI service intended to run on the macOS host, not inside Docker.

Purpose:
- receive safe desktop automation requests from the main backend
- open Word documents on the host
- reveal files or folders in Finder

## Why it exists

The main backend currently runs in Linux Docker containers. Containers can write files into mounted folders, but they cannot directly control macOS apps like Microsoft Word through AppleScript.

Running this bridge on the host solves that boundary cleanly.

## Usage

1. Create a virtual environment:

```bash
cd host_bridge
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

2. Generate an auth token (required — the bridge refuses to start without one):

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Store it in `~/.config/the-brain/secrets.env` as `HOST_AUTOMATION_TOKEN=<value>`. The main backend reads it from the same file.

3. Start the bridge (bind only to localhost):

```bash
export HOST_AUTOMATION_TOKEN="$(security find-generic-password -a "$USER" -s HOST_AUTOMATION_TOKEN -w 2>/dev/null || grep '^HOST_AUTOMATION_TOKEN=' ~/.config/the-brain/secrets.env | cut -d= -f2-)"
export HOST_EXPORTS_ROOT="$HOME/Documents/new-project/backend/data/exports"
uvicorn server:app --host 127.0.0.1 --port 8899 --reload
```

`HOST_EXPORTS_ROOT` must be set so the bridge has an allow-listed directory. Additional roots can be added in `HOST_EXTRA_ROOTS` (colon-separated). Absolute paths outside the allow-list are rejected with HTTP 400.

4. Add this to the root `.env`:

```env
HOST_AUTOMATION_BASE_URL=http://host.docker.internal:8899
```

4. Restart the main app containers.

## Endpoints

- `GET /status`
- `POST /word/open`
- `POST /finder/reveal`
- `POST /browser/open`
- `POST /app/open`
- `POST /app/open-path`
- `POST /path/open`

## Notes

- Microsoft Word must be installed on the Mac.
- The bridge uses `osascript`, so it only works on macOS.
- Authentication is required — `HOST_AUTOMATION_TOKEN` must be set at startup and sent by callers as an `Authorization: Bearer <token>` header.
- Path inputs are restricted to the allow-list (`HOST_EXPORTS_ROOT` / `HOST_EXTRA_ROOTS`) and sanitized — AppleScript is invoked with the path as an argv parameter, not interpolated into the script body, so injection via crafted paths is blocked.
- Bind the process to `127.0.0.1` only. Exposing it on the LAN is unsupported and unsafe.
