import { Inbox } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getOperatorInbox } from '../api/client';
import type { OperatorInboxItem, OperatorInboxResponse } from '../types';
import { Badge, Card, CardHeader, EmptyState, Skeleton } from '../ui';

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

function priorityTone(priority: string): BadgeTone {
  if (priority === 'critical') return 'danger';
  if (priority === 'high') return 'warning';
  if (priority === 'medium') return 'info';
  return 'neutral';
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{label}</p>
      <p data-slot="metric" className="text-[var(--text-lg)] font-semibold">
        {value}
      </p>
    </div>
  );
}

export function OperatorInboxPanel() {
  const [data, setData] = useState<OperatorInboxResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await getOperatorInbox();
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load operator inbox');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const items = data?.items ?? [];
  const summary = data?.summary ?? {};

  return (
    <Card>
      <CardHeader
        eyebrow="QUEUE"
        title="Operator inbox"
        description="Approvals, failures, blocked actions, and setup gaps in one queue."
      />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
        <Metric label="Total" value={summary.total ?? 0} />
        <Metric label="Critical" value={summary.critical ?? 0} />
        <Metric label="High" value={summary.high ?? 0} />
        <Metric label="Approvals" value={summary.pending_approvals ?? 0} />
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : error ? (
        <EmptyState title="Could not load inbox" description={error} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox aria-hidden />}
          title="Operator inbox is clear."
          description="No pending approvals, failed runs, or setup gaps."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item: OperatorInboxItem) => {
            const tone = priorityTone(item.priority);
            const risk =
              item.metadata?.risk && typeof item.metadata.risk === 'object'
                ? (item.metadata.risk as Record<string, unknown>)
                : null;
            return (
              <li
                key={item.item_id}
                className="p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] space-y-1.5"
              >
                <div className="flex items-start gap-2">
                  <p className="flex-1 font-medium text-[var(--text-sm)] leading-snug">{item.title}</p>
                  <Badge tone={tone} size="sm">
                    {item.priority}
                  </Badge>
                </div>
                <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] font-mono">
                  {item.kind} · {item.status} · {item.agent_id || item.source}
                </p>
                <p className="text-[var(--text-sm)] text-[var(--color-fg-muted)]">{item.summary}</p>
                {risk ? (
                  <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
                    Risk: {String(risk.level || 'low')} · score {String(risk.score || 0)}
                  </p>
                ) : null}
                {item.run_id || item.schedule_id || item.action_id ? (
                  <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] font-mono">
                    {item.run_id ? `run ${String(item.run_id).slice(0, 8)}` : ''}
                    {item.schedule_id ? ` · sched ${String(item.schedule_id).slice(0, 8)}` : ''}
                    {item.action_id ? ` · act ${String(item.action_id).slice(0, 8)}` : ''}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
