import { useState } from 'react';
import { GraphPanel } from './components/GraphPanel';
import { HealthPanel } from './components/HealthPanel';
import { MemoryPanel } from './components/MemoryPanel';
import { RunConsole } from './components/RunConsole';
import './styles.css';

export default function App() {
  const [runId, setRunId] = useState<string | null>(null);

  return (
    <main className="app-shell">
      <header className="hero">
        <h1>Talking / Listening Brain Demo</h1>
        <p>Voice-ready coordinator, researcher, critic, writer workflow with live memory and graph state.</p>
      </header>
      <section className="grid two-col">
        <RunConsole onRunChange={setRunId} />
        <HealthPanel />
      </section>
      <section className="grid two-col">
        <GraphPanel />
        <MemoryPanel runId={runId} />
      </section>
    </main>
  );
}
