import { Bell, BellOff, Calendar, Clock, Mail, Save, Trash2, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { listRuns, type RunSummary } from '../api/client';
import {
  dismissWatcherItems,
  getWatcherConfig,
  saveWatcherConfig,
  undismissWatcherItems,
  type WatcherConfig,
} from '../api/watchers';
import { getBriefContext, type BriefContext } from '../api/workspace';
import { Badge, Button, Card, CardHeader, Input, Label, Skeleton, Textarea } from '../ui';

function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): [T | null, boolean, string | null, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return [data, loading, error, reload];
}

export function WatcherPanel() {
  const [config, cfgLoading, cfgError, reloadConfig] = useLoad(getWatcherConfig);
  const [brief, briefLoading] = useLoad(getBriefContext);
  const [firedRuns, setFiredRuns] = useState<RunSummary[]>([]);
  const [firedLoading, setFiredLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setFiredLoading(true);
      try {
        const runs = await listRuns(25, undefined, 'proactive-watch');
        // Only show runs from the last 7 days.
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recent = runs.filter(
          (r) => new Date(r.updated_at || r.created_at).getTime() >= cutoff,
        );
        if (!cancelled) setFiredRuns(recent);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setFiredLoading(false);
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  const [form, setForm] = useState({
    enabled: false,
    poll_seconds: 180,
    lead_time_minutes: 15,
    priority_senders_text: '',
  });

  useEffect(() => {
    if (!config) return;
    setForm({
      enabled: config.enabled,
      poll_seconds: config.poll_seconds,
      lead_time_minutes: config.lead_time_minutes,
      priority_senders_text: (config.priority_senders || []).join('\n'),
    });
  }, [config]);

  const save = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      setBusy(true);
      try {
        await saveWatcherConfig({
          enabled: form.enabled,
          poll_seconds: Math.max(60, Number(form.poll_seconds) || 180),
          lead_time_minutes: Math.max(1, Math.min(120, Number(form.lead_time_minutes) || 15)),
          priority_senders: form.priority_senders_text
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        });
        reloadConfig();
      } finally {
        setBusy(false);
      }
    },
    [form, reloadConfig],
  );

  const dismiss = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await dismissWatcherItems([id]);
        reloadConfig();
      } finally {
        setBusy(false);
      }
    },
    [reloadConfig],
  );

  const undismiss = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await undismissWatcherItems([id]);
        reloadConfig();
      } finally {
        setBusy(false);
      }
    },
    [reloadConfig],
  );

  const upcomingEvents = (brief?.events ?? []).filter((e) => e.start);
  const dismissedIds = new Set(config?.dismiss_ids ?? []);
  const lastFired = config?.last_fired ?? {};

  return (
    <Card>
      <CardHeader
        eyebrow="PROACTIVE WATCHER"
        title="Gmail + Calendar watcher"
        description="Polls every few minutes; fires a background run when a meeting is imminent or a priority sender emails."
        action={
          config?.enabled ? (
            <Badge tone="success" size="sm" icon={<Bell size={11} aria-hidden />}>
              watching
            </Badge>
          ) : (
            <Badge tone="neutral" size="sm" icon={<BellOff size={11} aria-hidden />}>
              off
            </Badge>
          )
        }
      />

      {cfgLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : cfgError ? (
        <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{cfgError}</p>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <label className="flex items-center gap-2 text-[var(--text-sm)]">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            <span>Enable background watchers</span>
            <span className="text-[var(--color-fg-subtle)] text-[var(--text-xs)]">
              (requires Google connected)
            </span>
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="poll-seconds">Poll interval (seconds)</Label>
              <Input
                id="poll-seconds"
                type="number"
                min={60}
                max={3600}
                value={form.poll_seconds}
                onChange={(e) => setForm((f) => ({ ...f, poll_seconds: Number(e.target.value) }))}
              />
            </div>
            <div>
              <Label htmlFor="lead-time">Meeting prep lead (minutes)</Label>
              <Input
                id="lead-time"
                type="number"
                min={1}
                max={120}
                value={form.lead_time_minutes}
                onChange={(e) => setForm((f) => ({ ...f, lead_time_minutes: Number(e.target.value) }))}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="priority-senders" hint="One per line. Substring match against the From header.">
              Priority senders
            </Label>
            <Textarea
              id="priority-senders"
              rows={4}
              value={form.priority_senders_text}
              onChange={(e) => setForm((f) => ({ ...f, priority_senders_text: e.target.value }))}
              placeholder={'e.g.\nceo@acme.com\nsarah@'}
            />
          </div>

          <div className="flex justify-end">
            <Button type="submit" size="md" variant="primary" loading={busy} leading={<Save size={14} aria-hidden />}>
              Save watcher config
            </Button>
          </div>
        </form>
      )}

      {/* Upcoming events + dismiss controls */}
      <div className="mt-6 pt-5 border-t border-[var(--color-border-subtle)]">
        <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-2">
          Upcoming meetings {brief?.connected ? '' : '(Google not connected)'}
        </p>
        {briefLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : upcomingEvents.length === 0 ? (
          <p className="text-[var(--text-sm)] text-[var(--color-fg-subtle)] italic">
            Nothing on the calendar in the next 48 hours.
          </p>
        ) : (
          <ul className="space-y-2">
            {upcomingEvents.slice(0, 6).map((ev) => {
              const startDate = ev.start ? new Date(ev.start) : null;
              const id = `event:${ev.summary ?? ''}:${ev.start ?? ''}`;
              const fired = Boolean(lastFired[id]);
              const dismissed = dismissedIds.has(id);
              return (
                <li
                  key={id}
                  className="flex items-start justify-between gap-3 p-2.5 rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]"
                >
                  <div className="min-w-0">
                    <p className="text-[var(--text-sm)] text-[var(--color-fg-default)] font-medium inline-flex items-center gap-1.5">
                      <Calendar size={12} className="text-[var(--color-fg-subtle)]" aria-hidden />
                      {ev.summary || '(untitled)'}
                    </p>
                    <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-0.5">
                      {startDate ? startDate.toLocaleString() : ''}
                      {ev.location ? ` · ${ev.location}` : ''}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {fired ? (
                        <Badge tone="accent" size="sm">
                          prepped today
                        </Badge>
                      ) : null}
                      {dismissed ? (
                        <Badge tone="neutral" size="sm">
                          dismissed
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {dismissed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      leading={<Undo2 size={12} aria-hidden />}
                      onClick={() => void undismiss(id)}
                      disabled={busy}
                    >
                      Undismiss
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      leading={<X size={12} aria-hidden />}
                      onClick={() => void dismiss(id)}
                      disabled={busy}
                    >
                      Dismiss
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Recent watcher-fired runs (last 7 days) */}
      <div className="mt-5 pt-4 border-t border-[var(--color-border-subtle)]">
        <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-2 inline-flex items-center gap-1">
          <Clock size={11} aria-hidden /> Recent watcher runs
          {firedRuns.length > 0 ? <span className="text-[var(--color-fg-subtle)]">· last 7 days</span> : null}
        </p>
        {firedLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : firedRuns.length === 0 ? (
          <p className="text-[var(--text-sm)] text-[var(--color-fg-subtle)] italic">
            The watcher hasn't fired anything in the last week.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {firedRuns.slice(0, 10).map((r) => {
              const when = new Date(r.updated_at || r.created_at);
              const since = Math.round((Date.now() - when.getTime()) / 60000);
              const rel =
                since < 60
                  ? `${since}m ago`
                  : since < 24 * 60
                    ? `${Math.round(since / 60)}h ago`
                    : `${Math.round(since / (60 * 24))}d ago`;
              return (
                <li
                  key={r.run_id}
                  className="p-2 rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[var(--text-sm)] text-[var(--color-fg-default)] font-medium truncate flex-1">
                      {r.title || '(empty)'}
                    </p>
                    <Badge tone={r.status === 'completed' ? 'success' : 'warning'} size="sm">
                      {r.status}
                    </Badge>
                  </div>
                  <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-0.5 line-clamp-2">
                    {r.preview}
                  </p>
                  <p className="text-[10px] text-[var(--color-fg-subtle)] mt-1 font-mono">
                    {when.toLocaleString()} · {rel}
                    {r.estimated_total_tokens ? ` · ${r.estimated_total_tokens} tok` : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Dismissed list */}
      {config && (config.dismiss_ids?.length ?? 0) > 0 ? (
        <div className="mt-5 pt-4 border-t border-[var(--color-border-subtle)]">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-2 inline-flex items-center gap-1">
            <Trash2 size={11} aria-hidden /> Permanently dismissed ({config.dismiss_ids.length})
          </p>
          <ul className="space-y-1">
            {config.dismiss_ids.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between gap-2 text-[var(--text-xs)] font-mono text-[var(--color-fg-muted)]"
              >
                <span className="inline-flex items-center gap-1">
                  {id.startsWith('msg:') ? (
                    <Mail size={11} aria-hidden />
                  ) : (
                    <Calendar size={11} aria-hidden />
                  )}
                  <span className="truncate max-w-[380px]">{id}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => void undismiss(id)} disabled={busy}>
                  <Undo2 size={11} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
