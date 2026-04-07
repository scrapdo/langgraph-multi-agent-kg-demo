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

2. Start the bridge:

```bash
uvicorn server:app --host 127.0.0.1 --port 8899 --reload
```

3. Add these to the root `.env`:

```env
HOST_AUTOMATION_BASE_URL=http://host.docker.internal:8899
HOST_AUTOMATION_TOKEN=
```

If you want Finder/Word reveal from relative export paths, also set this in the host bridge shell before starting:

```bash
export HOST_EXPORTS_ROOT="/Users/matt/Documents/new-project/backend/data/exports"
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
- If you want authentication, set `HOST_AUTOMATION_TOKEN` in both places and send it as a bearer token.
