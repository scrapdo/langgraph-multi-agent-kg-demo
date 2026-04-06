# LangGraph Multi-Agent KG Demo

Full-stack demo app implementing a coordinator/researcher/critic/writer multi-agent workflow with LangGraph, Neo4j knowledge graph updates, Zep memory integration, retries/fallbacks, and a live dashboard.

## Stack
- Backend: FastAPI + LangGraph + Neo4j + Zep + Celery + Redis
- Frontend: React + Vite + Plotly 3D graph view
- Infra: Docker Compose, Railway deployment template

## Architecture
- Agents: `coordinator -> researcher -> critic -> writer`.
- Conditional edges:
  - `researcher -> critic` when evidence threshold is met.
  - `critic -> researcher` for revision loops.
  - `critic -> writer` when quality gates pass.
  - Any node failure with exhausted retries sets `force_degraded`, routing to degraded handler.
- Memory:
  - Short-term: LangGraph checkpointing (`PostgresSaver` when available, fallback `MemorySaver`).
  - Long-term: Zep Cloud recall/store adapter.
- Knowledge Graph:
  - Neo4j nodes: `Agent`, `Run`, `ToolExecution`, `Claim`, `Source`.
  - Relationships: `ASSIGNED_TO`, `USED_TOOL`, `PRODUCED`, `SUPPORTS`.

## API
- `POST /runs` start run `{ task, mode, user_id, session_id }`
- `GET /runs/{run_id}` fetch run detail and output
- `GET /runs/{run_id}/events` SSE stream for live node events
- `GET /graph` get KG subgraph for visualization
- `GET /health` dependency/config health summary

## Quickstart (Docker)
1. Copy env:
   ```bash
   cp .env.example .env
   ```
2. Launch:
   ```bash
   docker compose -f infra/docker-compose.yml up --build
   ```
3. Open:
   - Frontend: `http://localhost:5173`
   - API docs: `http://localhost:8000/docs`
   - Neo4j Browser: `http://localhost:7474`

## Local Dev
### Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
uvicorn app.main:app --reload
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Desktop (Electron wrapper)
```bash
cd desktop
npm install
npm run dev
```
This expects the frontend dev server at `http://localhost:5173`.

To run desktop against a built frontend bundle:
```bash
cd desktop
npm run build:web
npm run start
```

## Tests
```bash
cd backend
pytest -q
```

## Notes
- `mode=simulation` is default and logs intended side effects only.
- `mode=live` executes side effects only for tools listed in `SIDE_EFFECT_LIVE_TOOLS_CSV`.
- Frontend currently uses Plotly point-cloud 3D node rendering for live KG visibility.
