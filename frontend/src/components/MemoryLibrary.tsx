import { BookOpen, GitBranch, MessageSquare, Search, Tag, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getMemoryTimeline, type MemoryTimelineResponse } from '../api/memory';
import { Badge, Card, CardHeader, EmptyState, Skeleton } from '../ui';
import { cn } from '../ui/cn';

function relative(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function episodeTone(type?: string | null): 'neutral' | 'accent' | 'info' | 'success' | 'warning' {
  const t = (type || '').toLowerCase();
  if (t.includes('error') || t.includes('fail')) return 'warning';
  if (t.includes('tool')) return 'info';
  if (t.includes('research') || t.includes('critic')) return 'accent';
  if (t.includes('write') || t.includes('output') || t.includes('final')) return 'success';
  return 'neutral';
}

export function MemoryLibrary() {
  const [data, setData] = useState<MemoryTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [section, setSection] = useState<'timeline' | 'claims' | 'entities' | 'threads'>('timeline');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(async () => {
      try {
        const result = await getMemoryTimeline(120, query || undefined);
        if (!cancelled) setData(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load memory');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  const counts = useMemo(
    () => ({
      episodes: data?.episodes?.length ?? 0,
      claims: data?.claims?.length ?? 0,
      entities: data?.entities?.length ?? 0,
      threads: data?.threads?.length ?? 0,
    }),
    [data],
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,280px)] gap-4">
      <Card>
        <CardHeader
          eyebrow="LONG-TERM MEMORY"
          title="Memory library"
          description="Every episode, claim, and entity the assistant has observed — across all threads."
        />

        <div className="mb-3 relative">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-fg-subtle)]"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across memory…"
            className="w-full h-9 pl-9 pr-8 bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] rounded-[var(--radius-md)] text-[var(--text-sm)] placeholder:text-[var(--color-fg-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-default)]"
            >
              <X size={12} aria-hidden />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-1 mb-3">
          {(['timeline', 'claims', 'entities', 'threads'] as const).map((s) => {
            const count = s === 'timeline' ? counts.episodes : counts[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSection(s)}
                aria-pressed={section === s}
                className={cn(
                  'px-2.5 h-7 rounded-[var(--radius-pill)] text-[var(--text-xs)] font-medium border',
                  section === s
                    ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] border-[var(--color-border-accent)]'
                    : 'bg-transparent text-[var(--color-fg-muted)] border-[var(--color-border-subtle)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]',
                )}
              >
                {s} · {count}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : error ? (
          <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p>
        ) : section === 'timeline' ? (
          data && data.episodes.length > 0 ? (
            <ol className="relative border-l border-[var(--color-border-default)] ml-1.5 pl-5 space-y-4">
              {data.episodes.map((ep, i) => {
                const tone = episodeTone(ep.episode_type);
                return (
                  <li key={(ep.episode_id ?? `${ep.run_id}-${i}`) + String(ep.created_at)} className="relative">
                    <span
                      className={cn(
                        'absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-bg-surface)]',
                        tone === 'accent'
                          ? 'bg-[var(--color-accent)]'
                          : tone === 'info'
                            ? 'bg-sky-400'
                            : tone === 'success'
                              ? 'bg-emerald-400'
                              : tone === 'warning'
                                ? 'bg-amber-400'
                                : 'bg-[var(--color-fg-subtle)]',
                      )}
                      aria-hidden
                    />
                    <div className="flex items-baseline gap-2 text-[var(--text-xs)] text-[var(--color-fg-muted)] font-mono mb-1">
                      <strong className="font-semibold text-[var(--color-fg-default)]">
                        {ep.agent_id ?? 'system'}
                      </strong>
                      <Badge tone={tone} size="sm">
                        {ep.episode_type ?? 'episode'}
                      </Badge>
                      <span className="ml-auto">{relative(ep.created_at)}</span>
                    </div>
                    <p className="text-[var(--text-sm)] leading-relaxed text-[var(--color-fg-default)]">
                      {ep.content}
                    </p>
                    {ep.task_preview ? (
                      <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] italic mt-1">
                        from: "{ep.task_preview}…"
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <EmptyState
              icon={<BookOpen aria-hidden />}
              title={query ? `No episodes match "${query}"` : 'No memory yet'}
              description={query ? 'Try a broader query.' : 'Run a few conversations and the timeline will fill in.'}
            />
          )
        ) : section === 'claims' ? (
          data && data.claims.length > 0 ? (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {data.claims.map((c, i) => (
                <li
                  key={(c.claim_id ?? i) + String(c.created_at)}
                  className="py-2 flex items-start justify-between gap-3 text-[var(--text-sm)]"
                >
                  <span className="flex-1 min-w-0 text-[var(--color-fg-default)]">{c.text}</span>
                  <div className="flex items-center gap-1.5">
                    {c.status ? (
                      <Badge tone="neutral" size="sm">
                        {c.status}
                      </Badge>
                    ) : null}
                    <span className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] font-mono whitespace-nowrap">
                      {relative(c.created_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Tag aria-hidden />} title="No claims yet." />
          )
        ) : section === 'entities' ? (
          data && data.entities.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {data.entities.map((en) => (
                <li key={en.entity_id ?? en.name}>
                  <Badge tone="neutral" size="sm">
                    {en.name} · {en.entity_type ?? 'entity'} · {en.mentions}×
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={<Tag aria-hidden />} title="No entities yet." />
          )
        ) : data && data.threads.length > 0 ? (
          <ul className="divide-y divide-[var(--color-border-subtle)]">
            {data.threads.map((t) => (
              <li key={t.thread_id} className="py-2">
                <div className="flex items-center gap-2 text-[var(--text-sm)]">
                  <GitBranch size={12} className="text-[var(--color-fg-subtle)]" aria-hidden />
                  <span className="font-mono text-[var(--color-fg-muted)] truncate max-w-[280px]">
                    {t.thread_id}
                  </span>
                  <Badge tone="neutral" size="sm">
                    {t.run_count} run{t.run_count === 1 ? '' : 's'}
                  </Badge>
                  <span className="ml-auto text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
                    {relative(t.last_updated)}
                  </span>
                </div>
                <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-0.5 line-clamp-2">
                  {t.last_task}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={<MessageSquare aria-hidden />} title="No threads yet." />
        )}
      </Card>

      <Card tone="sunken" className="!shadow-none">
        <CardHeader
          eyebrow="ABOUT"
          title="What this is"
          description="A cross-thread view of the assistant's durable memory."
        />
        <div className="space-y-2 text-[var(--text-xs)] text-[var(--color-fg-muted)] leading-relaxed">
          <p>
            Every run emits episodes (agent steps), claims (assertions the critic signed off on),
            entities (things the assistant heard about), and a thread id (a logical conversation).
            This library aggregates all of that across every run the local store has seen.
          </p>
          <p>
            Search is case-insensitive over episode content, task text, and claim text.
          </p>
          <p className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
            source: <code>GET /memory/timeline</code>
          </p>
        </div>
      </Card>
    </div>
  );
}
