# Desktop Wrapper (Electron)

This wraps the existing React dashboard in a native desktop window.

## Dev mode
1. Start backend stack in another terminal from repo root:
   ```bash
   docker compose -f infra/docker-compose.yml up -d
   ```
2. Start frontend dev server:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
3. Start desktop app:
   ```bash
   cd ../desktop
   npm install
   npm run dev
   ```

## Production-ish local run
Build frontend, then open in Electron from static files:
```bash
cd desktop
npm run build:web
npm run start
```

## Notes
- Desktop app points at `http://localhost:5173` in dev mode.
- In packaged mode it loads `../frontend/dist/index.html`.
