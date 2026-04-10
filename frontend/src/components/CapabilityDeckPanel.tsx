const CARDS = [
  {
    title: 'Research Workspace',
    accent: 'search',
    description: 'Ask anything. The coordinator routes work across researcher, critic, writer, shopper, secretary, wellness coach, and specialist agents with live traces.',
  },
  {
    title: 'It Actually Remembers You',
    accent: 'memory',
    description: 'Short-term state, Zep long-term recall, thread context, graph lineage, desktop artifacts, and cross-run memory all stay connected.',
  },
  {
    title: 'Autonomous Thinking',
    accent: 'thinking',
    description: 'Critique loops, schedule runners, degraded fallbacks, and approval-gated live actions keep the system moving when you are not babysitting it.',
  },
  {
    title: 'Beautiful Visual Reports',
    accent: 'report',
    description: 'Any run can open as a polished HTML report that is printable to PDF without dumping the raw dashboard layout.',
  },
  {
    title: 'Browser And Desktop Automation',
    accent: 'browser',
    description: 'Desktop operations, host bridge hooks, shopping search, Google Workspace, and approval queues are exposed as controllable specialist surfaces.',
  },
  {
    title: 'Multi-Agent Orchestration',
    accent: 'agents',
    description: 'Coordinator, researcher, critic, writer, coding, shopper, social, secretary, wellness coach, and specialist schedules all share the same mission state.',
  },
  {
    title: 'Document Processing',
    accent: 'doc',
    description: 'Drop text, markdown, CSV, JSON, HTML, or code files into the document workbench for extraction, sectioning, and downstream report use.',
  },
  {
    title: 'Google Workspace',
    accent: 'workspace',
    description: 'Gmail and Calendar workflows feed back into memory, graph lineage, desktop artifacts, schedules, and operator briefs.',
  },
  {
    title: 'Safety By Design',
    accent: 'safety',
    description: 'Simulation by default, approval gates for live actions, execution history, route-specific retries, and persistent audit context.',
  },
];

export function CapabilityDeckPanel() {
  return (
    <section className="panel capability-deck">
      <div className="specialist-head">
        <div>
          <h2>Flight Deck</h2>
          <p className="muted">The strongest Captain Claw-style ideas adapted to this app’s actual runtime and architecture.</p>
        </div>
      </div>
      <div className="capability-grid">
        {CARDS.map((card) => (
          <article key={card.title} className={`capability-card capability-${card.accent}`}>
            <div className="capability-icon" aria-hidden>
              <span />
            </div>
            <h3>{card.title}</h3>
            <p>{card.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
