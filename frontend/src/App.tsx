import { useMemo, useState } from 'react';
import { AgentStudio } from './components/AgentStudio';
import { GraphPanel } from './components/GraphPanel';
import { HealthPanel } from './components/HealthPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { RunConsole } from './components/RunConsole';
import type { RunDetail } from './types';
import './styles.css';

export default function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);

  const runStatus = useMemo(() => run?.status ?? 'idle', [run?.status]);

  return (
    <main className="app-shell">
      <header className="hero hud-frame">
        <div className="hero-copy">
          <p className="eyebrow">NEURAL OPS CONSOLE</p>
          <h1>LangGraph Multi-Agent Brain</h1>
          <p>Coordinator, Researcher, Critic, Writer with live KG + memory + mission control stream.</p>
        </div>
        <nav className="hero-nav" aria-label="Sections">
          <span>CHAT</span>
          <span>OPS</span>
          <span className="active">BRAIN</span>
          <span>LOG</span>
        </nav>
      </header>

      <section className="status-strip hud-frame">
        <article>
          <p className="metric-label">Run ID</p>
          <p className="metric-value">{runId ?? 'none'}</p>
        </article>
        <article>
          <p className="metric-label">Mode</p>
          <p className="metric-value">{run?.mode ?? 'simulation'}</p>
        </article>
        <article>
          <p className={`metric-value status-${runStatus}`}>{runStatus}</p>
          <p className="metric-label">Status</p>
        </article>
        <article>
          <p className="metric-label">Last Update</p>
          <p className="metric-value">{run?.updated_at ? new Date(run.updated_at).toLocaleTimeString() : '--:--:--'}</p>
        </article>
      </section>

      <section className="grid layout-main">
        <RunConsole
          onRunChange={(id, detail) => {
            setRunId(id);
            if (detail) setRun(detail);
          }}
        />
        <HealthPanel run={run} />
      </section>

      <section className="grid layout-secondary">
        <GraphPanel />
        <MemoryPanel runId={runId} run={run} />
      </section>

      <section className="grid layout-third">
        <AgentStudio />
      </section>
    </main>
  );
}
