interface Props {
  runId: string | null;
}

export function MemoryPanel({ runId }: Props) {
  return (
    <section className="panel">
      <h2>Memory Panel</h2>
      <p className="muted">Latest run: {runId ?? 'none'}</p>
      <p>
        Zep memory references are attached to each run state and can be inspected via
        <code> GET /runs/{'{run_id}'}</code>.
      </p>
    </section>
  );
}
