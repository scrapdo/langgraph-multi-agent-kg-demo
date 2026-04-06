import type { RunDetail } from '../types';

interface Props {
  runId: string | null;
  run: RunDetail | null;
}

export function MemoryPanel({ runId, run }: Props) {
  const state = (run?.state ?? {}) as Record<string, unknown>;
  const memoryRefs = Array.isArray(state.memory_refs) ? state.memory_refs : [];
  const notes = Array.isArray(state.research_notes) ? state.research_notes : [];

  return (
    <section className="panel">
      <h2>Memory Sectors</h2>
      <p className="muted">Session run: {runId ?? 'none'}</p>

      <div className="memory-grid" aria-hidden>
        {Array.from({ length: 16 }).map((_, i) => {
          const active = i < Math.min(16, Math.max(memoryRefs.length, notes.length));
          return <span key={i} className={active ? 'active' : ''} />;
        })}
      </div>

      <h3>Recent Memory References</h3>
      <ul className="health-list">
        {memoryRefs.length === 0 && (
          <li>
            <span>No external memory hit yet</span>
            <strong>idle</strong>
          </li>
        )}
        {memoryRefs.slice(0, 6).map((ref, idx) => (
          <li key={idx}>
            <span>{String(ref)}</span>
            <strong>linked</strong>
          </li>
        ))}
      </ul>

      <h3>Learned Signals</h3>
      <ul className="health-list">
        {notes.length === 0 && (
          <li>
            <span>No note captured yet</span>
            <strong>idle</strong>
          </li>
        )}
        {notes.slice(0, 5).map((note, idx) => (
          <li key={idx}>
            <span>{String(note).slice(0, 74)}</span>
            <strong>stored</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
