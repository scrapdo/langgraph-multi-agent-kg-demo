import { Clock, Timer } from 'lucide-react';
import { useMemo } from 'react';
import { Badge, Card, StatusDot } from '../ui';
import type { RunDetail } from '../types';

type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const STATUS_TONES: Record<string, StatusTone> = {
  idle: 'neutral',
  queued: 'neutral',
  running: 'accent',
  revising: 'warning',
  complete: 'success',
  completed: 'success',
  failed: 'danger',
  degraded: 'warning',
};

function formatElapsed(start?: string | null, end?: string | null): string {
  if (!start) return '--';
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return '--';
  const ms = Math.max(0, endMs - startMs);
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function shortId(value: string | null | undefined, length = 8): string | null {
  if (!value) return null;
  if (value.length <= length) return value;
  return `${value.slice(0, length)}…`;
}

export function RunStateHeader({
  runId,
  run,
}: {
  runId: string | null;
  run: RunDetail | null;
}) {
  const status = run?.status ?? (runId ? 'queued' : 'idle');
  const tone = STATUS_TONES[status] ?? 'neutral';
  const label = status.charAt(0).toUpperCase() + status.slice(1);

  const isTerminal = status === 'completed' || status === 'failed' || status === 'degraded';
  const elapsed = useMemo(
    () => formatElapsed(run?.created_at, isTerminal ? run?.updated_at : null),
    [run?.created_at, run?.updated_at, isTerminal],
  );
  const modelId =
    (run?.state as Record<string, unknown> | undefined)?.model_provider ??
    (run?.state as Record<string, unknown> | undefined)?.model ??
    null;
  const thread = (run?.state as Record<string, unknown> | undefined)?.thread_id as string | undefined;

  return (
    <Card padding="sm" tone="sunken" className="!shadow-none">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[var(--text-sm)]">
        <div className="flex items-center gap-2">
          <StatusDot tone={tone} pulse={status === 'running'} />
          <span className="font-medium capitalize">{label}</span>
        </div>
        <span className="text-[var(--color-fg-subtle)]">·</span>
        <Badge tone="neutral" size="sm" icon={<Timer size={12} aria-hidden />}>
          {elapsed}
        </Badge>
        {modelId ? (
          <>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <span className="font-mono text-[var(--color-fg-muted)]">{String(modelId)}</span>
          </>
        ) : null}
        {runId ? (
          <>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <span className="flex items-center gap-1 font-mono text-[var(--color-fg-muted)]">
              <Clock size={12} aria-hidden />
              {shortId(runId, 10)}
            </span>
          </>
        ) : null}
        {thread ? (
          <>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <span className="font-mono text-[var(--color-fg-muted)]">thread {shortId(thread, 8)}</span>
          </>
        ) : null}
      </div>
    </Card>
  );
}
