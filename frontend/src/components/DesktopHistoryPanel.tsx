import { useEffect, useMemo, useState } from 'react';
import { getDesktopActions } from '../api/client';
import type { DesktopAction } from '../types';

export function DesktopHistoryPanel() {
  const [actions, setActions] = useState<DesktopAction[]>([]);
  const [agentFilter, setAgentFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    void getDesktopActions()
      .then((payload) => setActions(payload.actions))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load desktop history'));
  }, []);

  const agents = useMemo(() => ['all', ...new Set(actions.map((item) => item.agent_id))], [actions]);
  const kinds = useMemo(() => ['all', ...new Set(actions.map((item) => item.kind))], [actions]);
  const statuses = useMemo(() => ['all', ...new Set(actions.map((item) => item.status))], [actions]);

  const filtered = useMemo(
    () =>
      actions.filter((item) => {
        if (agentFilter !== 'all' && item.agent_id !== agentFilter) return false;
        if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
        if (statusFilter !== 'all' && item.status !== statusFilter) return false;
        return true;
      }),
    [actions, agentFilter, kindFilter, statusFilter],
  );

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Desktop History</h2>
          <p className="muted">Review local automation activity across runs, grouped by agent, action type, and execution result.</p>
        </div>
      </div>

      <div className="desktop-history-filters">
        <label>
          Agent
          <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
            {agents.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
            {kinds.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="muted">{error}</p>}

      <div className="approval-list">
        {filtered.length === 0 ? (
          <p className="muted">No desktop actions match the current filters.</p>
        ) : (
          filtered.map((action) => (
            <article key={action.action_id} className="approval-card">
              <div className="approval-head">
                <strong>{action.title}</strong>
                <span className={`trust-pill ${action.status === 'completed' ? 'high' : action.status === 'blocked' ? 'caution' : 'medium'}`}>
                  {action.status}
                </span>
              </div>
              <p className="muted small">{action.agent_id} · {action.kind}</p>
              <p className="muted small">Created: {new Date(action.created_at).toLocaleString()}</p>
              {action.executed_at && <p className="muted small">Executed: {new Date(action.executed_at).toLocaleString()}</p>}
              {action.output_path && <p className="approval-copy">{action.output_path}</p>}
              {action.last_execution_method && <p className="muted small">Method: {action.last_execution_method}</p>}
              {action.last_error && <p className="muted small">Last error: {action.last_error}</p>}
              {action.execution_history.length > 0 && (
                <details>
                  <summary className="muted small">Execution History</summary>
                  <ul className="compact-bullets">
                    {action.execution_history.map((entry, idx) => (
                      <li key={`${action.action_id}-${idx}`}>
                        {String(entry.ts ?? '')} · {String(entry.event ?? '')} · {String(entry.status ?? '')} · {String(entry.method ?? '')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
