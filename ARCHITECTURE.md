# Architecture

This document describes how The Brain is wired together —
processes, data flow, and the non-obvious design choices that drove the
current shape.

## High-level picture

```mermaid
flowchart LR
    subgraph Desktop
      UI[Electron window]
      SP[Splash / launcher]
    end

    subgraph Docker compose (loopback only)
      API[FastAPI backend :8000]
      WORKER[Celery worker]
      FE[Frontend nginx :5173]
      NEO4J[(Neo4j :7687)]
      PG[(Postgres :5432)]
      REDIS[(Redis :6379)]
    end

    subgraph Host (macOS, outside docker)
      HB[Host bridge :8899]
      APPS[Word / Finder / AI Influencer]
    end

    SP -->|docker compose up| API
    UI -->|http 127.0.0.1| FE
    FE --> API
    API --> NEO4J
    API --> PG
    API --> REDIS
    API -.queue.-> WORKER
    API -->|http bearer| HB
    HB --> APPS

    subgraph External
      OPENAI[OpenAI / Anthropic / OpenRouter]
      ZEP[Zep memory cloud]
      TW[Twilio / SendGrid / Telnyx]
      GW[Google Workspace]
    end

    API --> OPENAI
    API --> ZEP
    API --> TW
    API --> GW
```

## Run lifecycle

A "run" is a user task that moves through a LangGraph workflow:

1. `POST /runs` creates a run record (Postgres), enqueues it, and returns
   `run_id` to the client.
2. The coordinator node classifies the task, picks a specialist route, and
   establishes memory/thread context in Zep.
3. The researcher node gathers evidence from tools, memory, and the Neo4j
   graph.
4. The critic node evaluates coverage and risk, and can send the workflow
   back to the researcher (revision loop).
5. The writer node produces the final response and a spoken-response
   variant.
6. Throughout, the workflow writes lineage to Neo4j: `Run -> Episode -> Claim
   / Entity / Source / ToolExecution`, plus relationships (`HAS_EPISODE`,
   `SUPPORTED_BY`, `PRODUCED`, `ABOUT`, `AUTHORED`, `PRECEDES`).
7. The frontend subscribes to `/runs/{id}/events` (SSE) and updates the UI
   live.

Side effects (email, SMS, desktop actions) are held behind approval cards in
the operator inbox and never auto-execute unless explicitly configured.

## Directory layout

```
backend/app/
  agents/nodes.py            LangGraph node implementations (coordinator, researcher, critic, writer, specialists, degraded)
  api/routes.py              FastAPI route definitions (being split into per-domain packages)
  core/
    config.py                Pydantic-settings Settings (two-file env load: project .env + ~/.config/kg-multi-agent/secrets.env)
    logging.py               JSON logging + request-ID middleware (ContextVar-based correlation)
  graph/                     AgentState + LangGraph wiring
  models/schemas.py          Pydantic API and profile schemas
  repositories/run_store.py  Durable run persistence
  services/                  One file per bounded capability (see "Service boundaries" below)
  tools/adapters.py          Tool adapters + discovery
  workers/celery_app.py      Celery worker bootstrap

frontend/src/
  App.tsx                    Top-level routing + AppShell composition
  components/
    AppShell.tsx             Sidebar + command bar + workspace container
    RunConsole.tsx           Mission Control (voice, visualizer, events, transcript; scheduled for split)
    RunStateHeader.tsx       Single-line run status summary
    ErrorBoundary.tsx        Workspace-level failure recovery
    ...                      one file per feature surface
  ui/                        Design-system primitives (Button, Card, Tabs, Tooltip, Dialog, Skeleton, Badge, StatusDot, EmptyState)
  styles/
    theme.css                Design tokens (@theme) + dark/light/hud layers
    base.css                 Resets + typography
    effects-hud.css          Optional sci-fi overlay (data-effects="hud")
    legacy.css               Old stylesheet (being retired)
    index.css                Entry point that imports them all
  lib/
    appearance.ts            light/dark + hud effect toggle with legacy theme migration
    presets.ts               Mission templates / legacy theme presets
    voice.ts                 Browser speech helpers
  api/client.ts              Hand-rolled fetch wrappers (to be refactored around apiFetch<T>)
  types.ts                   Shared TS interfaces (to be replaced with zod schemas generated from /openapi.json)

desktop/
  main.js                    Electron main process + lifecycle
  launcher.js                docker compose orchestration + health-poll
  splash.html                Boot screen
  preload.js                 Contextbridge API for the splash / main window

host_bridge/
  server.py                  Local macOS FastAPI service — AppleScript-hardened app/Finder/Word/URL automation
```

## Service boundaries

Backend services follow the "one file per bounded capability" rule. Each one
is imported as a singleton (`service_instance = ServiceClass()`) so the rest
of the app can construct lightweight routes without dependency injection
ceremony. Services hold their own persistence pointers, provider clients, and
error handling.

| Service | Responsibility |
|---|---|
| `agent_profile_service` | Per-agent identity / model / voice / permission persistence |
| `browser_automation_service` | Live URL inspection, saved workflows |
| `desktop_automation_service` | Writer docs, social packages, Gmail/Calendar briefs, AI Influencer |
| `desktop_schedule_service` + `desktop_schedule_runner` | Persistent schedules + background dispatcher |
| `desktop_artifact_ingest_service` | Ingest completed desktop actions back into graph + memory |
| `document_service` | Lightweight text/markdown/CSV/JSON/HTML extraction |
| `github_ops_service` | Optional GitHub ops |
| `google_workspace_service` | OAuth + Gmail/Calendar readonly |
| `huggingface_service` | Hub/dataset/spaces search + Parler TTS |
| `llm_service` | Shared LLM call surface used by agent nodes |
| `local_app_service` | AI Influencer + local app catalog |
| `memory_service` | Zep thread memory |
| `model_router_service` | Provider catalog + per-role model resolution |
| `neo4j_service` | All Cypher in one place (being split) |
| `operator_inbox_service` | Unified approvals / failures / setup gaps queue |
| `playwright_service` | Optional Playwright scripts surface |
| `policy_service` | Operation risk classification |
| `run_service` | Run lifecycle |
| `scheduler_service` | Public-facing booking page (separate from desktop schedules) |
| `secretary_service` | Twilio / Telnyx / SendGrid / Telegram dispatch |
| `tts_service` | Routed speech synthesis (OpenAI / ElevenLabs / Parler / browser) |

The single-file [backend/app/api/routes.py](backend/app/api/routes.py) binds
these services to HTTP routes. It is scheduled to be split into
`api/routes/{runs,desktop,scheduler,browser,secretary,hf,agents,ops}.py`; the
structure is intentional and should survive that split.

## Config & secrets

Two-file env loading (see [backend/app/core/config.py](backend/app/core/config.py)):

1. **`.env`** in the project tree — non-secret config only (model IDs, base
   URLs, feature flags, workflow tuning).
2. **`~/.config/kg-multi-agent/secrets.env`** (chmod 600) — API keys, DB
   passwords, bearer tokens.

Values in the second file override the first. Env vars from the shell override
both. Docker compose loads both via `env_file:` with `required: false` on the
secrets file so the stack still runs in CI where the file doesn't exist.

`KG_SECRETS_FILE` env var can override the secrets path for tests / CI
(see `.github/workflows/ci.yml`).

## Observability

- JSON logs only. Every request carries an `X-Request-ID` that shows up in
  response headers and in every log line emitted during the request, via a
  `ContextVar` ([backend/app/core/logging.py](backend/app/core/logging.py)).
- `/health` is excluded from the access log to keep signal clean.
- `uvicorn.access` is muted; our middleware emits the structured access line.
- Errors are logged with full exception traces.

## Frontend runtime

- React 18 + Vite 5 + Tailwind v4.
- No state manager — local state + React context are sufficient for current
  scope. A `useRunSession` hook will consolidate the run lifecycle when
  `RunConsole.tsx` is split.
- `api/client.ts` is currently ~50 hand-rolled `fetch` wrappers. Next
  refactor: thin `apiFetch<T>(path, init)` helper plus optional TanStack
  Query caching.
- Theme + effects are applied to `<html>` via `data-theme="light|dark"` and
  optional `data-effects="hud"` ([frontend/src/lib/appearance.ts](frontend/src/lib/appearance.ts)).

## Desktop launcher

See [desktop/README.md](desktop/README.md) for the full flow. Key points:

- The Electron main process runs `docker compose -f infra/docker-compose.yml
  up -d`, polls `/health`, then creates the main window.
- On quit, `docker compose down` runs from a `before-quit` hook so nothing
  is left running.
- Content-Security-Policy is installed via
  `session.defaultSession.webRequest.onHeadersReceived`. Navigation to
  non-loopback URLs is blocked; external links open in the system browser.

## Non-obvious design choices

- **Two-file env loading** — keys must not live in the project tree; they're
  in `~/.config/kg-multi-agent/secrets.env` instead. Pydantic loads both,
  with the secrets file winning conflicts.
- **HUD as an effect layer, not a theme** — themes (dark/light) and effects
  (hud/off) are orthogonal. One token set, two axes of customization.
- **Hash routing** — the frontend uses `#/...` routes for the public
  scheduler pages to avoid needing server-side rewrites when the Vite dev
  server is bypassed.
- **Single API file still** — `api/routes.py` is a known hotspot. It is
  split by section internally; physical file split is queued for a follow-up
  to avoid breaking import paths all at once.
- **Legacy stylesheet alongside Tailwind** — the old 2074-line stylesheet
  lives at `src/styles/legacy.css` and is progressively retired. New work
  never adds to it.
- **ContextVar-based request ID** — avoids threading the ID through every
  service call signature. A request ID is set on entry, read wherever
  `get_request_id()` is called, reset on exit.
- **Simulation default** — runs are `simulation` unless explicitly
  upgraded. Live side effects require both a per-tool allowlist and an
  operator approval card.
