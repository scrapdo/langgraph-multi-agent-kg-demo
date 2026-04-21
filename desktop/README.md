# The Brain — Desktop (Electron)

One-click desktop launcher for the whole multi-agent stack. When you open the
app, it:

1. Shows a splash screen.
2. Verifies Docker is running.
3. Runs `docker compose -f infra/docker-compose.yml up -d`.
4. Polls `http://127.0.0.1:8000/health` until the API is healthy.
5. Opens the main window pointing at the frontend (`http://127.0.0.1:5173`).
6. On quit, runs `docker compose down` so nothing is left running in the background.

## Prerequisites

- **Docker Desktop** installed and running on macOS.
- **Secrets file** at `~/.config/kg-multi-agent/secrets.env` (chmod 600)
  containing at least `NEO4J_PASSWORD` and `POSTGRES_PASSWORD`.  
  See [`.env.example`](../.env.example) for the full list of variables.

## Development

From the repository root, no services running:

```bash
cd desktop
npm install
npm start
```

That's it. The launcher will bring up the backend stack and the frontend the
first time, rebuilding images as needed. First boot can take a few minutes
because Docker builds three images (api, worker, frontend); subsequent boots
are < 20 seconds.

## Producing a packaged `.app`

```bash
cd desktop
npm install
npm run dist
```

The produced `release/mac-arm64/The Brain.app` contains:

- the Electron runtime,
- the launcher (`main.js`, `launcher.js`, `preload.js`, `splash.html`),
- a copy of the project source (`infra/`, `backend/`, `frontend/`) under
  `Contents/Resources/project/`, used by `docker compose` at runtime.

You can drag the `.app` to `/Applications` and launch it like any other
macOS app. It still requires Docker Desktop running on the host; it does
not bundle its own Docker runtime.

## Notes

- The app is sandboxed via Electron's `contextIsolation: true`,
  `nodeIntegration: false`, a strict Content-Security-Policy, and external
  links opening in the system browser instead of the app window.
- Closing the main window triggers `docker compose down`; the app can take
  a few seconds to exit while services stop gracefully.
- If Docker Desktop is not running, the splash screen displays an actionable
  error and leaves the user free to quit or retry.
