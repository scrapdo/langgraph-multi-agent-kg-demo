import { useEffect, useMemo, useState } from 'react';
import { getRunMemory, getThreadDetail } from '../api/client';
import type { RunDetail, RunMemoryResponse, ThreadDetailResponse } from '../types';

interface Props {
  runId: string | null;
  run: RunDetail | null;
}

function formatTime(value?: string | null) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleTimeString();
}

export function MemoryPanel({ runId }: Props) {
  const [memory, setMemory] = useState<RunMemoryResponse | null>(null);
  const [thread, setThread] = useState<ThreadDetailResponse | null>(null);

  useEffect(() => {
    if (!runId) {
      setMemory(null);
      setThread(null);
      return;
    }

    const load = async () => {
      const memoryData = await getRunMemory(runId);
      setMemory(memoryData);
      if (memoryData.thread_id) {
        const threadData = await getThreadDetail(memoryData.thread_id);
        setThread(threadData);
      } else {
        setThread(null);
      }
    };

    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [runId]);

  const memoryRefs = memory?.memory_refs ?? [];
  const episodes = memory?.episodes ?? [];
  const entities = memory?.entities ?? [];
  const claims = memory?.claims ?? [];
  const desktopArtifacts = memory?.desktop_artifacts ?? [];
  const messages = thread?.messages ?? [];

  const activeCount = useMemo(
    () => Math.min(16, Math.max(memoryRefs.length, episodes.length, claims.length)),
    [claims.length, episodes.length, memoryRefs.length],
  );

  return (
    <section className="panel memory-panel">
      <div className="memory-head">
        <div>
          <h2>Memory And Recall</h2>
          <p className="muted">Run-scoped thread context, recalled memory refs, entities, claims, and recent messages.</p>
        </div>
        <div className="memory-thread-meta">
          <span>Thread</span>
          <strong>{memory?.thread_id ?? 'none'}</strong>
        </div>
      </div>

      <div className="memory-grid" aria-hidden>
        {Array.from({ length: 16 }).map((_, i) => {
          const active = i < activeCount;
          return <span key={i} className={active ? 'active' : ''} />;
        })}
      </div>

      <div className="memory-context-card">
        <h3>Thread Context</h3>
        <p>{memory?.thread_context ?? thread?.context ?? 'No recalled thread context yet.'}</p>
      </div>

      <div className="memory-columns">
        <div>
          <h3>Memory References</h3>
          <ul className="health-list compact-list">
            {memoryRefs.length === 0 && (
              <li>
                <span>No external memory hit yet</span>
                <strong>idle</strong>
              </li>
            )}
            {memoryRefs.slice(0, 6).map((ref) => (
              <li key={ref.memory_id}>
                <span>{ref.summary ?? ref.memory_id}</span>
                <strong>{ref.source_type ?? 'linked'}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>Entities</h3>
          <ul className="health-list compact-list">
            {entities.length === 0 && (
              <li>
                <span>No entities linked yet</span>
                <strong>idle</strong>
              </li>
            )}
            {entities.slice(0, 6).map((entity) => (
              <li key={`${entity.entity_id}-${entity.name}`}>
                <span>{entity.name}</span>
                <strong>{entity.entity_type}</strong>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h3>Episode Timeline</h3>
      <div className="episode-timeline">
        {episodes.length === 0 && <p className="muted">No graph episodes recorded yet.</p>}
        {episodes.slice(0, 8).map((episode) => (
          <article key={episode.episode_id} className="episode-card">
            <div className="episode-meta">
              <strong>{episode.agent_id ?? 'system'}</strong>
              <span>{episode.episode_type}</span>
              <time>{formatTime(episode.created_at)}</time>
            </div>
            <p>{episode.content}</p>
          </article>
        ))}
      </div>

      <div className="memory-columns">
        <div>
          <h3>Claims</h3>
          <ul className="health-list compact-list">
            {claims.length === 0 && (
              <li>
                <span>No claims written yet</span>
                <strong>idle</strong>
              </li>
            )}
            {claims.slice(0, 5).map((claim) => (
              <li key={claim.claim_id}>
                <span>{claim.text}</span>
                <strong>{claim.status ?? 'active'}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>Desktop Artifacts</h3>
          <ul className="health-list compact-list">
            {desktopArtifacts.length === 0 && (
              <li>
                <span>No desktop outputs linked yet</span>
                <strong>idle</strong>
              </li>
            )}
            {desktopArtifacts.slice(0, 5).map((artifact) => (
              <li key={artifact.artifact_id}>
                <span>{artifact.title ?? artifact.output_path ?? artifact.action_id}</span>
                <strong>{artifact.action_type ?? artifact.kind}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3>Recent Messages</h3>
          <ul className="health-list compact-list">
            {messages.length === 0 && (
              <li>
                <span>No thread messages yet</span>
                <strong>idle</strong>
              </li>
            )}
            {messages.slice(-5).reverse().map((message, idx) => (
              <li key={String(message.uuid ?? idx)}>
                <span>{String(message.content ?? '').slice(0, 92)}</span>
                <strong>{String(message.role ?? 'message')}</strong>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
