import { Download, FileText, Loader2, Volume2, X } from 'lucide-react';
import { useState } from 'react';
import type { SpecialistArtifact, SpecialistStatus } from '../lib/useSpecialistHandoff';
import { Badge, Button, Card, EmptyState, cn } from '../ui';

interface Props {
  artifacts: SpecialistArtifact[];
  onDismiss: (id: string) => void;
  onReplay?: (artifact: SpecialistArtifact) => void;
}

function statusLabel(status: SpecialistStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Working…';
    case 'failed':
      return 'Failed';
    default:
      return 'Done';
  }
}

function statusTone(status: SpecialistStatus): 'neutral' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'running':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'completed':
      return 'success';
    default:
      return 'neutral';
  }
}

function downloadText(name: string, body: string) {
  const blob = new Blob([body], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function formatName(artifact: SpecialistArtifact): string {
  const slug = artifact.agentId.toLowerCase();
  const ts = artifact.startedAt.replace(/[:.]/g, '-');
  return `${slug}-${ts}.md`;
}

function formatMetrics(artifact: SpecialistArtifact): string | null {
  const m = artifact.metrics;
  if (!m) return null;
  const parts: string[] = [];
  if (typeof m.elapsedMs === 'number') {
    parts.push(m.elapsedMs >= 1000 ? `${(m.elapsedMs / 1000).toFixed(1)}s` : `${m.elapsedMs}ms`);
  }
  if (typeof m.totalTokens === 'number' && m.totalTokens > 0) {
    parts.push(`${m.totalTokens.toLocaleString()} tok`);
  }
  if (typeof m.costUsd === 'number' && m.costUsd > 0) {
    parts.push(m.costUsd < 0.01 ? `<$0.01` : `$${m.costUsd.toFixed(2)}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export function OutputsRail({ artifacts, onDismiss, onReplay }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const hasAny = artifacts.length > 0;

  return (
    <aside
      aria-label="Team outputs"
      className="flex flex-col gap-3 h-full overflow-y-auto pr-1"
    >
      <div className="flex items-center justify-between sticky top-0 bg-[var(--color-bg-canvas)]/95 backdrop-blur z-10 py-2">
        <div>
          <h2 className="text-[var(--text-sm)] font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
            Team outputs
          </h2>
          <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
            What your specialists have produced.
          </p>
        </div>
      </div>

      {!hasAny ? (
        <EmptyState
          title="No outputs yet"
          description="Ask the delegator a question and specialist results will appear here — documents, plans, code, research."
        />
      ) : (
        <ul className="space-y-3">
          {artifacts.map((artifact) => {
            const isOpen = expanded[artifact.id] ?? artifact.status === 'running';
            const body = artifact.finalContent?.trim() || artifact.liveContent.trim();
            return (
              <li key={artifact.id}>
                <Card className="p-3">
                  <header className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <FileText size={14} className="text-[var(--color-fg-subtle)]" aria-hidden />
                        <span className="text-[var(--text-sm)] font-medium truncate">
                          {artifact.agentLabel}
                        </span>
                        <Badge tone={statusTone(artifact.status)}>
                          {artifact.status === 'running' ? (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 size={10} className="animate-spin" aria-hidden />
                              {statusLabel(artifact.status)}
                            </span>
                          ) : (
                            statusLabel(artifact.status)
                          )}
                        </Badge>
                      </div>
                      <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-1 line-clamp-2">
                        {artifact.task}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onDismiss(artifact.id)}
                      aria-label="Dismiss output"
                      className="h-7 w-7 grid place-items-center rounded-md text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-default)] hover:bg-white/5"
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </header>

                  {body ? (
                    <div className="mt-2 text-[var(--text-sm)] leading-relaxed">
                      <div
                        className={cn(
                          'whitespace-pre-wrap text-[var(--color-fg-default)]',
                          !isOpen && 'line-clamp-4',
                        )}
                      >
                        {body}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <button
                            type="button"
                            className="text-[var(--text-xs)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]"
                            onClick={() =>
                              setExpanded((prev) => ({ ...prev, [artifact.id]: !isOpen }))
                            }
                          >
                            {isOpen ? 'Collapse' : 'Read more'}
                          </button>
                          {formatMetrics(artifact) ? (
                            <span
                              className="text-[10px] font-mono text-[var(--color-fg-subtle)] whitespace-nowrap"
                              title="elapsed · tokens · cost"
                            >
                              {formatMetrics(artifact)}
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1 flex-none">
                          {artifact.status === 'completed' && onReplay ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onReplay(artifact)}
                              aria-label="Replay voice"
                            >
                              <Volume2 size={12} aria-hidden />
                              Replay
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => downloadText(formatName(artifact), body)}
                            aria-label="Download as markdown"
                          >
                            <Download size={12} aria-hidden />
                            Save
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
                      Working on it…
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
