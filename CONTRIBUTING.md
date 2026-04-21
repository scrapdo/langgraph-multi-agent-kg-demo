# Contributing

Thanks for picking up this project. This file captures the development
workflow, the expectations for a PR, and the commands you need to run locally.

## Quick start

```bash
# 1. Put secrets in ~/.config/kg-multi-agent/secrets.env (chmod 600)
#    at minimum: NEO4J_PASSWORD, POSTGRES_PASSWORD, plus any provider keys.

# 2. Copy the example project config
cp .env.example .env

# 3. One-click desktop run (recommended)
cd desktop
npm install
npm start

# 4. Or bring up the full stack manually
docker compose -f infra/docker-compose.yml up --build
```

## Repository layout

```
backend/   FastAPI + LangGraph + Neo4j + Zep + Celery
frontend/  React + Vite + Tailwind v4 (see src/ui/ for primitives)
desktop/   Electron wrapper that orchestrates docker compose on launch
host_bridge/  macOS-only FastAPI service for native app control
infra/     docker-compose.yml + railway.json
docs/      Supplementary docs (architecture, security, etc.)
```

Design system lives in:
- [frontend/src/styles/theme.css](frontend/src/styles/theme.css) — tokens
- [frontend/src/ui/](frontend/src/ui/) — primitive components
- `data-effects="hud"` on `<html>` enables the optional sci-fi effect layer.

## Development commands

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# run locally (needs docker compose up for neo4j/postgres/redis)
uvicorn app.main:app --reload

# lint + format
ruff check .
ruff format .

# tests
pytest -q
```

### Frontend

```bash
cd frontend
npm install

# dev
npm run dev         # binds to 127.0.0.1:5173

# build + tests
npm run build
npm test

# lint
npx eslint "src/**/*.{ts,tsx}"
npx prettier --check "src/**/*.{ts,tsx,css}"
```

### Desktop

```bash
cd desktop
npm install
npm start           # splash -> docker compose up -> main window
npm run dist        # produce release/mac-arm64/The Brain.app
```

## Branching & commit style

- One logical change per PR. If it touches 10 files across 3 concerns, split it.
- Small, declarative commit messages: `fix(host_bridge): validate paths …`,
  `feat(ui): timeline view for MemoryPanel`, `refactor(api): split routes into domain packages`.
- Prefer new commits over `--amend`. Never force-push to `main`.
- Don't skip hooks (`--no-verify`).

## Code expectations

### General

- Surgical changes — touch only what the task needs.
- No speculative abstractions. Three similar lines > premature helper.
- No commented-out code. No `TODO`s without an owner and a date.
- No commit of secrets, ever. Secrets live in
  `~/.config/kg-multi-agent/secrets.env`.

### Python

- Ruff clean (`ruff check .` passes).
- Type hints on public functions and service boundaries.
- Exceptions raised from services should be typed (don't raise bare `Exception`).
- Use the structured logger from `app.core.logging` — it automatically carries
  the request ID. Avoid `print()`.

### TypeScript / React

- Prefer primitives from `src/ui/` over hand-rolling another card/button/tab.
- Hooks get proper dependency arrays; if you need an exception, add a short
  `// why` comment.
- Wrap new workspace surfaces in `<ErrorBoundary>`.
- Loading states use `<Skeleton>`; empty states use `<EmptyState>`.
- A11y baseline: every interactive element has a visible `:focus-visible`
  ring; every icon-only button has an `aria-label`; animations honour
  `prefers-reduced-motion`.

### CSS

- New components use Tailwind + `src/styles/theme.css` tokens.
- The legacy stylesheet at `frontend/src/styles/legacy.css` is being retired;
  do not add to it.

## Running CI locally

The full CI pipeline (`.github/workflows/ci.yml`) runs:

- `ruff check` + `ruff format --check`
- `pytest`
- `eslint` + `prettier --check`
- `npm run build`
- `vitest`
- `gitleaks` secret scan

You can reproduce everything except the secret scan locally with the commands
listed under *Development commands* above.

## Adding a new API endpoint

1. Add / extend the Pydantic schema in `backend/app/models/schemas.py`.
2. Add the handler to the appropriate router module under `backend/app/api/`.
   (The single-file `routes.py` is being split into per-domain routers —
   when that lands, follow the new structure.)
3. Add a `@router.get/post/put/delete` decorator with a response model.
4. Register the router in `backend/app/main.py` if it's new.
5. Update `frontend/src/api/client.ts` and `frontend/src/types.ts`.
6. Add an integration test under `backend/tests/`.

## Adding a new UI component

1. If it's reusable, put it in `frontend/src/ui/` and export it from
   `frontend/src/ui/index.ts`.
2. If it's specific to a feature, keep it co-located with the feature.
3. Use tokens from `theme.css` — not raw hex or rgba.
4. Wrap expensive / fetching components in `<ErrorBoundary>` at the call site.

## Security expectations

See [SECURITY.md](SECURITY.md) for the full threat model and posture. The
short version:

- Never commit `.env` or anything under `~/.config/kg-multi-agent/`.
- Never hand a raw path to `subprocess` / `osascript` without validation.
- Any new side-effect tool must be gated by `SIDE_EFFECT_LIVE_TOOLS_CSV`
  and surface an operator-approval card.
