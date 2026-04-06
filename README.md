# LangGraph Multi-Agent Knowledge Graph Demo

Production-style demo of a multi-agent AI system with:
- LangGraph orchestration (`coordinator -> researcher -> critic -> writer`)
- Neo4j knowledge graph lineage
- Zep long-term memory
- FastAPI backend + React mission-control frontend
- Voice input/output with live waveform UI
- Provider-aware LLM routing and per-agent model assignment

## 1) What This Project Does

This app runs autonomous AI workflows with reliability controls and observability:
- Starts a run from user task input (`simulation` or `live` mode)
- Routes task through agent nodes with conditional edges and retry handling
- Updates graph + memory during execution
- Streams run events to the UI via SSE
- Renders graph/health/memory dashboards in real time

It is designed for **greenfield autonomy demos** and architecture prototyping, not financial or safety-critical production operation.

## 2) Core Features

### 2.1 Multi-Agent Orchestration
- Coordinator: task classification + planning
- Researcher: evidence and context gathering
- Critic: quality gate with optional revision loop
- Writer: final synthesis and spoken response
- Degraded handler: fallback output if retries are exhausted

### 2.2 Reliability
- Tenacity retries on node/tool failures
- Exponential backoff with jitter
- Degraded path + explicit run status (`degraded`) when needed
- Run persistence in Postgres-backed run store flow

### 2.3 Memory + Graph
- Zep Cloud for long-term recall/write
- Neo4j for run, claim, source, and tool lineage
- Graph updates emitted during and after runs

### 2.4 Voice + UI
- Browser speech recognition input
- Neural TTS endpoint with OpenAI fallback pathing
- Live “wave of dots” visualizer
- Echo suppression and duplicate-utterance prevention

### 2.5 Provider-Aware LLM Routing
- Supports OpenAI, Anthropic, Google Gemini, Perplexity, xAI Grok, Groq
- Per-agent provider/model config in UI (Agent Studio)
- Provider catalog endpoint and health visibility

### 2.6 Agent Studio
- Rename each agent
- Set avatar per agent (emoji/text/image URL)
- Configure function/provider/model per agent
- Visual org chart of agent hierarchy

## 3) System Architecture

### 3.1 Services
- `api` (FastAPI): run orchestration API, SSE, config endpoints, speech endpoint
- `worker` (Celery): async background jobs and queue processing
- `neo4j`: graph database
- `postgres`: persistence/checkpoint substrate
- `redis`: queue/cache/broker role
- `frontend` (Vite/React served via nginx): mission-control dashboard

### 3.2 Workflow Graph
- `coordinator -> researcher -> critic -> writer`
- Conditional routes:
  - `researcher -> critic` if evidence threshold passes
  - `critic -> researcher` for revisions (bounded by max loops)
  - `critic -> writer` when quality pass
  - Any hard/retry-exhausted failure -> `degraded`

### 3.3 Data Planes
- Runtime state: `AgentState` in graph execution
- Long-term memory: Zep
- Knowledge graph: Neo4j
- UI telemetry: SSE stream from `/runs/{id}/events`

## 4) Repository Layout

```text
backend/
  app/
    agents/               # node logic + routing conditions
    api/                  # FastAPI routes
    core/                 # settings/config
    graph/                # state + workflow definition
    repositories/         # run persistence abstraction
    services/             # llm/memory/neo4j/tts/model-router/agent-profiles
    tools/                # external tool adapters
    workers/              # celery app/tasks
frontend/
  src/
    components/           # RunConsole, Graph, Health, Memory, AgentStudio
    api/                  # frontend API client
infra/
  docker-compose.yml      # local multi-service stack
desktop/
  # desktop wrapper assets
```

## 5) API Reference

### Runs
- `POST /runs`
  - Body: `{ task, mode, user_id?, session_id? }`
  - Starts workflow run
- `GET /runs/{run_id}`
  - Returns run status, state snapshot, and output
- `GET /runs/{run_id}/events`
  - SSE stream of node/system events
- `GET /runs/{run_id}/speech?voice=alloy&fmt=mp3`
  - Returns synthesized speech audio for spoken response

### Observability
- `GET /graph?limit=100`
  - Returns graph subgraph for visualization
- `GET /health`
  - Returns service + provider enablement status

### Provider/Agent Configuration
- `GET /providers/catalog`
  - Providers, enabled state, known models, recommended role mappings
- `GET /agents/config`
  - Current agent profile map
- `PUT /agents/config`
  - Update agent names, avatars, function text, provider, model

## 6) Environment Variables

Copy `.env.example` to `.env` and set values:

### Required for baseline
- `OPENAI_API_KEY` (if using OpenAI for chat/TTS)
- `ZEP_API_KEY` (if using memory)
- `NEO4J_*`, `POSTGRES_DSN`, `REDIS_URL` (provided by compose defaults)

### Multi-provider keys (optional but recommended)
- `ANTHROPIC_API_KEY`
- `GOOGLE_API_KEY`
- `PERPLEXITY_API_KEY`
- `XAI_API_KEY`
- `GROQ_API_KEY`

### Model defaults
- `OPENAI_MODEL`
- `ANTHROPIC_MODEL`
- `GOOGLE_MODEL`
- `PERPLEXITY_MODEL`
- `XAI_MODEL`
- `GROQ_MODEL`

### Side effects
- `SIDE_EFFECT_DEFAULT_MODE`
- `SIDE_EFFECT_LIVE_TOOLS_CSV`

## 7) Local Setup

### 7.1 Docker (recommended)
```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up --build
```

Open:
- Frontend: `http://localhost:5173`
- API docs: `http://localhost:8000/docs`
- Neo4j browser: `http://localhost:7474`

### 7.2 Backend local dev
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
uvicorn app.main:app --reload
```

### 7.3 Frontend local dev
```bash
cd frontend
npm install
npm run dev
```

## 8) Using Agent Studio

1. Open Agent Studio panel.
2. For each agent (`coordinator`, `researcher`, `critic`, `writer`, `coding`):
   - Set `name`
   - Set `avatar` (emoji/text/image URL)
   - Set provider/model
   - Save
3. Org chart at top reflects current hierarchy and avatars.

## 9) Recommended Provider Mapping

Default suggested mapping for this project:
- Coordinator -> OpenAI (fast routing/planning)
- Researcher -> Perplexity (web-grounded retrieval style)
- Critic -> Anthropic (analysis/critique behavior)
- Writer -> Gemini or OpenAI (style/format quality)
- Coding -> Claude/OpenAI Codex-style model

You can override everything in Agent Studio.

## 10) Validation Checklist

- Run starts from UI and completes
- At least one conversational prompt routes as `task_type=conversation`
- Market prompt routes as `task_type=market_research`
- `/providers/catalog` returns enabled/disabled providers correctly
- Agent rename/avatar changes persist after refresh
- Waveform visibly pulses while listening and speaking

## 11) Deployment (Railway)

Use the same environment contract as local.

Recommended service split:
- `api` service (FastAPI)
- `worker` service (Celery)
- `frontend` service (static nginx)
- managed or self-hosted `postgres`, `redis`, `neo4j`

Deployment notes:
- Set all provider API keys in Railway variables
- Keep `mode=simulation` as default in public demos
- Restrict live side effects with explicit tool allowlist

## 12) Security and Safety Notes

- Do not commit real secrets (`.env`)
- Keep `simulation` default in demos
- Gate `live` mode tools by explicit allowlist
- Add auth/rate limits before exposing publicly
- Treat generated outputs as assistive; verify before external actions

## 13) Troubleshooting

### 13.1 Conversation quality degrades or becomes generic
- Check provider key validity and quota
- Verify selected model exists for selected provider
- Inspect `/health` and `/providers/catalog`

### 13.2 Speech loops/repetition
- Confirm latest frontend build is running
- Use `Stop Listening` while tuning mic gain
- Keep browser tab focused for stable WebSpeech behavior

### 13.3 Avatar image not rendering
- Ensure avatar value is a valid `https://` image URL or `data:image/...`
- Check CORS and remote image availability

### 13.4 Neo4j or memory missing data
- Verify connection vars and service health
- Inspect backend logs for retries/degraded path messages

## 14) Current Status

This repo includes:
- Multi-agent graph orchestration
- Memory + graph lineage integration
- Provider/router abstraction and per-agent model config
- Mission-control frontend with org chart + avatar customization

For production hardening, add authentication, authorization, multi-tenant controls, and observability/alerting.
