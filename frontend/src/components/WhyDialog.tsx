import { BookOpen, GitBranch, Info, Tag, Wrench } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { getRun, getRunMemory } from '../api/client';
import type { RunDetail, RunMemoryResponse } from '../types';
import { Badge, Dialog, DialogContent, Skeleton } from '../ui';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string | null;
}

function Section({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="mb-3">
      <div className="flex items-center gap-1.5 mb-1.5 text-[var(--text-xs)] text-[var(--color-fg-muted)]">
        {icon}
        <span className="uppercase tracking-wider font-medium">{title}</span>
        {typeof count === 'number' ? (
          <span className="text-[var(--color-fg-subtle)]">· {count}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function EmptyLine({ label }: { label: string }) {
  return <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] italic">{label}</p>;
}

export function WhyDialog({ open, onOpenChange, runId }: Props) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [memory, setMemory] = useState<RunMemoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRun(null);
    setMemory(null);
    (async () => {
      try {
        const [detail, mem] = await Promise.all([getRun(runId), getRunMemory(runId)]);
        if (cancelled) return;
        setRun(detail);
        setMemory(mem);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, runId]);

  const state = (run?.state ?? {}) as Record<string, unknown>;
  const researchNotes = (state.research_notes as string[] | undefined) ?? [];
  const toolResults = (state.tool_results as Array<Record<string, unknown>> | undefined) ?? [];
  const citations = (state.citations as string[] | undefined) ?? [];
  const critiqueFlags = (state.critique_flags as string[] | undefined) ?? [];
  const actionItems = (state.action_items as Array<Record<string, unknown>> | undefined) ?? [];
  const metrics = (state.run_metrics as Record<string, number> | undefined) ?? {};

  const memoryRefs = memory?.memory_refs ?? [];
  const entities = memory?.entities ?? [];
  const claims = memory?.claims ?? [];
  const episodes = memory?.episodes ?? [];

  const hasAnything =
    loading ||
    researchNotes.length > 0 ||
    toolResults.length > 0 ||
    memoryRefs.length > 0 ||
    entities.length > 0 ||
    claims.length > 0 ||
    episodes.length > 0 ||
    citations.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Why this answer"
        description={runId ? `Memory, tools, and graph context for run ${runId.slice(0, 8)}` : 'Run context'}
        className="!w-[min(94vw,720px)]"
      >
        {error ? (
          <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p>
        ) : loading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !hasAnything ? (
          <p className="text-[var(--text-sm)] text-[var(--color-fg-muted)]">
            This was a pass-through conversational answer — no tools, memory, or graph episodes contributed.
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto pr-1">
            {metrics && Object.keys(metrics).length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {typeof metrics.elapsed_ms === 'number' ? (
                  <Badge tone="neutral" size="sm">
                    {(metrics.elapsed_ms / 1000).toFixed(1)}s
                  </Badge>
                ) : null}
                {typeof metrics.estimated_total_tokens === 'number' ? (
                  <Badge tone="neutral" size="sm">
                    ~{metrics.estimated_total_tokens.toLocaleString()} tok
                  </Badge>
                ) : null}
              </div>
            ) : null}

            {researchNotes.length > 0 ? (
              <Section icon={<Info size={12} aria-hidden />} title="Research notes" count={researchNotes.length}>
                <ul className="space-y-1 text-[var(--text-sm)]">
                  {researchNotes.slice(0, 10).map((note, i) => (
                    <li
                      key={i}
                      className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] text-[var(--color-fg-default)]"
                    >
                      {note}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {toolResults.length > 0 ? (
              <Section icon={<Wrench size={12} aria-hidden />} title="Tools called" count={toolResults.length}>
                <ul className="space-y-1 text-[var(--text-sm)]">
                  {toolResults.slice(0, 12).map((tool, i) => {
                    const name = String(tool.tool ?? tool.name ?? 'tool');
                    const status = String(tool.status ?? '');
                    return (
                      <li
                        key={i}
                        className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]"
                      >
                        <span className="font-mono text-[var(--color-fg-default)]">{name}</span>
                        {status ? (
                          <Badge tone={status === 'ok' ? 'success' : 'warning'} size="sm">
                            {status}
                          </Badge>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </Section>
            ) : null}

            {memoryRefs.length > 0 ? (
              <Section icon={<BookOpen size={12} aria-hidden />} title="Memory recalled" count={memoryRefs.length}>
                <ul className="space-y-1 text-[var(--text-sm)]">
                  {memoryRefs.slice(0, 10).map((ref) => (
                    <li
                      key={ref.memory_id}
                      className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]"
                    >
                      <p className="text-[var(--color-fg-default)]">{ref.summary ?? ref.memory_id}</p>
                      {ref.source_type ? (
                        <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] font-mono mt-0.5">
                          {ref.source_type}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {episodes.length > 0 ? (
              <Section icon={<GitBranch size={12} aria-hidden />} title="Graph episodes" count={episodes.length}>
                <ol className="space-y-1 text-[var(--text-sm)]">
                  {episodes.slice(0, 8).map((ep) => (
                    <li
                      key={ep.episode_id}
                      className="p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]"
                    >
                      <div className="flex items-center gap-2 text-[var(--text-xs)] font-mono text-[var(--color-fg-muted)] mb-0.5">
                        <span className="text-[var(--color-fg-default)]">{ep.agent_id ?? 'system'}</span>
                        <span>·</span>
                        <span>{ep.episode_type}</span>
                      </div>
                      <p className="text-[var(--color-fg-default)]">{ep.content}</p>
                    </li>
                  ))}
                </ol>
              </Section>
            ) : null}

            {claims.length > 0 ? (
              <Section icon={<Tag size={12} aria-hidden />} title="Claims" count={claims.length}>
                <ul className="space-y-1 text-[var(--text-sm)]">
                  {claims.slice(0, 8).map((claim) => (
                    <li
                      key={claim.claim_id}
                      className="flex items-start justify-between gap-2 p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]"
                    >
                      <span className="text-[var(--color-fg-default)]">{claim.text}</span>
                      <Badge tone="neutral" size="sm">
                        {claim.status ?? 'active'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {entities.length > 0 ? (
              <Section icon={<Tag size={12} aria-hidden />} title="Entities" count={entities.length}>
                <ul className="flex flex-wrap gap-1">
                  {entities.slice(0, 20).map((entity) => (
                    <li key={`${entity.entity_id}-${entity.name}`}>
                      <Badge tone="neutral" size="sm">
                        {entity.name} · {entity.entity_type}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {citations.length > 0 ? (
              <Section icon={<Info size={12} aria-hidden />} title="Citations" count={citations.length}>
                <ul className="space-y-0.5 text-[var(--text-xs)] text-[var(--color-fg-muted)] font-mono">
                  {citations.slice(0, 10).map((cite, i) => (
                    <li key={i} className="truncate">
                      {cite}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {critiqueFlags.length > 0 ? (
              <Section icon={<Info size={12} aria-hidden />} title="Critic flags" count={critiqueFlags.length}>
                <ul className="flex flex-wrap gap-1">
                  {critiqueFlags.map((flag, i) => (
                    <li key={i}>
                      <Badge tone="warning" size="sm">
                        {flag}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {actionItems.length > 0 ? (
              <Section icon={<Info size={12} aria-hidden />} title="Action items" count={actionItems.length}>
                <ul className="space-y-1 text-[var(--text-sm)]">
                  {actionItems.slice(0, 6).map((item, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2 p-2 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]"
                    >
                      <span className="text-[var(--color-fg-default)]">{String(item.label ?? item.type ?? '')}</span>
                      {item.owner ? (
                        <Badge tone="neutral" size="sm">
                          {String(item.owner)}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
