import { BookOpen, GitBranch, MessageSquare, Tag } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getRunMemory, getThreadDetail } from '../api/client';
import type { RunDetail, RunMemoryResponse, ThreadDetailResponse } from '../types';
import { Badge, Card, CardHeader, EmptyState, Skeleton } from '../ui';
import { cn } from '../ui/cn';

interface Props {
  runId: string | null;
  run: RunDetail | null;
}

function formatTime(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString();
}

function formatRelative(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function episodeTone(type: string): 'neutral' | 'accent' | 'info' | 'success' | 'warning' {
  const t = (type || '').toLowerCase();
  if (t.includes('error') || t.includes('fail')) return 'warning';
  if (t.includes('tool')) return 'info';
  if (t.includes('research') || t.includes('critic')) return 'accent';
  if (t.includes('write') || t.includes('output')) return 'success';
  return 'neutral';
}

function ListItem({ primary, secondary, detail }: { primary: string; secondary?: string; detail?: string }) {
  return (
    <li className="py-2 text-[var(--text-sm)]">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 flex-1 text-[var(--color-fg-default)] truncate">{primary}</span>
        {secondary ? (
          <Badge tone="neutral" size="sm">
            {secondary}
          </Badge>
        ) : null}
      </div>
      {detail ? <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] mt-0.5">{detail}</p> : null}
    </li>
  );
}

function EmptyLine({ label }: { label: string }) {
  return <p className="text-[var(--text-sm)] text-[var(--color-fg-subtle)] italic">{label}</p>;
}

export function MemoryPanel({ runId }: Props) {
  const [memory, setMemory] = useState<RunMemoryResponse | null>(null);
  const [thread, setThread] = useState<ThreadDetailResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(runId));

  useEffect(() => {
    if (!runId) {
      setMemory(null);
      setThread(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const memoryData = await getRunMemory(runId);
        if (cancelled) return;
        setMemory(memoryData);
        if (memoryData.thread_id) {
          const threadData = await getThreadDetail(memoryData.thread_id);
          if (!cancelled) setThread(threadData);
        } else if (!cancelled) {
          setThread(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runId]);

  const memoryRefs = memory?.memory_refs ?? [];
  const episodes = memory?.episodes ?? [];
  const entities = memory?.entities ?? [];
  const claims = memory?.claims ?? [];
  const desktopArtifacts = memory?.desktop_artifacts ?? [];
  const messages = thread?.messages ?? [];

  const summaryMetrics = useMemo(
    () => [
      { label: 'Episodes', value: episodes.length },
      { label: 'Memory refs', value: memoryRefs.length },
      { label: 'Entities', value: entities.length },
      { label: 'Claims', value: claims.length },
    ],
    [episodes.length, memoryRefs.length, entities.length, claims.length],
  );

  if (!runId) {
    return (
      <Card>
        <CardHeader title="Memory & claims" description="Context, recall, and lineage for the active run." />
        <EmptyState
          icon={<BookOpen aria-hidden />}
          title="No active run."
          description="Start a run from Mission Control to see thread context, memory references, and claims here."
        />
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)] gap-4">
      <Card>
        <CardHeader
          eyebrow="TIMELINE"
          title="Episode timeline"
          description="Agent-by-agent trace of what happened in this run."
          action={
            memory?.thread_id ? (
              <Badge tone="neutral" size="sm">
                thread {memory.thread_id.slice(0, 8)}
              </Badge>
            ) : null
          }
        />

        <div className="grid grid-cols-4 gap-2 mb-4">
          {summaryMetrics.map((m) => (
            <div
              key={m.label}
              className="rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] p-2.5"
            >
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                {m.label}
              </p>
              <p data-slot="metric" className="text-[var(--text-lg)] font-semibold">
                {m.value}
              </p>
            </div>
          ))}
        </div>

        {memory?.thread_context || thread?.context ? (
          <div className="mb-4 p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]">
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">
              Thread context
            </p>
            <p className="text-[var(--text-sm)] leading-relaxed text-[var(--color-fg-default)]">
              {memory?.thread_context ?? thread?.context}
            </p>
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : episodes.length === 0 ? (
          <EmptyLine label="No graph episodes recorded yet." />
        ) : (
          <ol className="relative border-l border-[var(--color-border-default)] ml-1.5 pl-5 space-y-4">
            {episodes.slice(0, 20).map((episode) => {
              const tone = episodeTone(episode.episode_type);
              const time = formatTime(episode.created_at);
              const relative = formatRelative(episode.created_at);
              return (
                <li key={episode.episode_id} className="relative">
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
                      {episode.agent_id ?? 'system'}
                    </strong>
                    <Badge tone={tone} size="sm">
                      {episode.episode_type}
                    </Badge>
                    {time ? <span className="ml-auto">{relative || time}</span> : null}
                  </div>
                  <p className="text-[var(--text-sm)] leading-relaxed text-[var(--color-fg-default)]">
                    {episode.content}
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader
            eyebrow="RECALL"
            title="Memory references"
            description="External memory hits attached to this run."
          />
          {memoryRefs.length === 0 ? (
            <EmptyLine label="No external memory hit yet." />
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {memoryRefs.slice(0, 8).map((ref) => (
                <ListItem
                  key={ref.memory_id}
                  primary={ref.summary ?? ref.memory_id}
                  secondary={ref.source_type ?? 'linked'}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            eyebrow="GRAPH"
            title="Entities & claims"
            description="Everything this run touched in the knowledge graph."
            action={<Tag size={14} className="text-[var(--color-fg-subtle)]" aria-hidden />}
          />
          {entities.length === 0 && claims.length === 0 ? (
            <EmptyLine label="No graph entities or claims yet." />
          ) : (
            <>
              {entities.length > 0 ? (
                <>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">
                    Entities
                  </p>
                  <ul className="divide-y divide-[var(--color-border-subtle)] mb-3">
                    {entities.slice(0, 6).map((entity) => (
                      <ListItem
                        key={`${entity.entity_id}-${entity.name}`}
                        primary={entity.name}
                        secondary={entity.entity_type}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
              {claims.length > 0 ? (
                <>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">
                    Claims
                  </p>
                  <ul className="divide-y divide-[var(--color-border-subtle)]">
                    {claims.slice(0, 6).map((claim) => (
                      <ListItem
                        key={claim.claim_id}
                        primary={claim.text}
                        secondary={claim.status ?? 'active'}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          )}
        </Card>

        {desktopArtifacts.length > 0 ? (
          <Card>
            <CardHeader
              eyebrow="ARTIFACTS"
              title="Desktop outputs"
              action={<GitBranch size={14} className="text-[var(--color-fg-subtle)]" aria-hidden />}
            />
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {desktopArtifacts.slice(0, 6).map((artifact) => (
                <ListItem
                  key={artifact.artifact_id}
                  primary={artifact.title ?? artifact.output_path ?? artifact.action_id}
                  secondary={artifact.action_type ?? artifact.kind}
                  detail={artifact.output_path ?? undefined}
                />
              ))}
            </ul>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            eyebrow="CONVERSATION"
            title="Recent messages"
            action={<MessageSquare size={14} className="text-[var(--color-fg-subtle)]" aria-hidden />}
          />
          {messages.length === 0 ? (
            <EmptyLine label="No thread messages yet." />
          ) : (
            <ul className="divide-y divide-[var(--color-border-subtle)]">
              {messages
                .slice(-6)
                .reverse()
                .map((message, idx) => (
                  <ListItem
                    key={String(message.uuid ?? idx)}
                    primary={String(message.content ?? '').slice(0, 120)}
                    secondary={String(message.role ?? 'msg')}
                  />
                ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
