import { useEffect, useState } from 'react';
import { getOperatorInbox } from '../api/client';
import type { OperatorInboxItem, OperatorInboxResponse } from '../types';

function priorityClass(priority: string) {
  if (priority === 'critical') return 'caution';
  if (priority === 'high') return 'medium';
  return 'high';
}

export function OperatorInboxPanel() {
  const [data, setData] = useState<OperatorInboxResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void getOperatorInbox()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load operator inbox'));
  }, []);

  const items = data?.items ?? [];
  const summary = data?.summary ?? {};

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Operator Inbox</h2>
          <p className="muted">One queue for approvals, failures, blocked actions, and setup gaps across the whole system.</p>
        </div>
      </div>
      <div className="status-strip inbox-summary">
        <article>
          <p className="metric-label">Total</p>
          <p className="metric-value">{summary.total ?? 0}</p>
        </article>
        <article>
          <p className="metric-label">Critical</p>
          <p className="metric-value">{summary.critical ?? 0}</p>
        </article>
        <article>
          <p className="metric-label">High</p>
          <p className="metric-value">{summary.high ?? 0}</p>
        </article>
        <article>
          <p className="metric-label">Approvals</p>
          <p className="metric-value">{summary.pending_approvals ?? 0}</p>
        </article>
      </div>
      {error && <p className="muted">{error}</p>}
      <div className="approval-list">
        {items.length === 0 ? (
          <p className="muted">Operator inbox is clear.</p>
        ) : (
          items.map((item: OperatorInboxItem) => (
            <article key={item.item_id} className="approval-card">
              <div className="approval-head">
                <strong>{item.title}</strong>
                <span className={`trust-pill ${priorityClass(item.priority)}`}>{item.priority}</span>
              </div>
              <p className="muted small">
                {item.kind} · {item.status} · {item.agent_id || item.source}
              </p>
              <p className="approval-copy">{item.summary}</p>
              {item.metadata?.risk && typeof item.metadata.risk === 'object' && (
                <p className="muted small">
                  Risk: {String((item.metadata.risk as Record<string, unknown>).level || 'low')} · score {String((item.metadata.risk as Record<string, unknown>).score || 0)}
                </p>
              )}
              <p className="muted small">
                {item.run_id ? `Run ${item.run_id}` : ''}
                {item.schedule_id ? ` · Schedule ${item.schedule_id}` : ''}
                {item.action_id ? ` · Action ${item.action_id}` : ''}
              </p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
