import { FormEvent, useState } from 'react';
import { getRun, startRun, streamEvents } from '../api/client';
import type { RunDetail, RunMode } from '../types';

interface Props {
  onRunChange: (runId: string | null) => void;
}

export function RunConsole({ onRunChange }: Props) {
  const [task, setTask] = useState('Build a market research brief for semiconductor momentum this week.');
  const [mode, setMode] = useState<RunMode>('simulation');
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setEvents([]);
    try {
      const created = await startRun(task, mode);
      onRunChange(created.run_id);
      const source = streamEvents(created.run_id, (evt) => {
        setEvents((prev) => [evt, ...prev].slice(0, 200));
      });
      setTimeout(() => source.close(), 10 * 60 * 1000);

      const poll = async () => {
        const detail = await getRun(created.run_id);
        setRun(detail);
        if (['completed', 'failed', 'degraded'].includes(detail.status)) {
          source.close();
          return;
        }
        setTimeout(poll, 1200);
      };
      poll();
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel">
      <h2>Run Console</h2>
      <form onSubmit={onSubmit} className="form-grid">
        <label>
          Task
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={4} required />
        </label>
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)}>
            <option value="simulation">simulation</option>
            <option value="live">live</option>
          </select>
        </label>
        <button disabled={loading} type="submit">{loading ? 'Launching...' : 'Start Run'}</button>
      </form>

      {run && (
        <div className="status-card">
          <h3>Run Status</h3>
          <p><strong>ID:</strong> {run.run_id}</p>
          <p><strong>Status:</strong> {run.status}</p>
          <p><strong>Updated:</strong> {new Date(run.updated_at).toLocaleString()}</p>
          {run.output && <pre className="output">{run.output}</pre>}
        </div>
      )}

      <div className="events">
        <h3>Live Events</h3>
        <ul>
          {events.map((evt, idx) => (
            <li key={idx}><code>{JSON.stringify(evt)}</code></li>
          ))}
        </ul>
      </div>
    </section>
  );
}
