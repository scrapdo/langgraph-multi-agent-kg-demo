import { Activity } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getAgentProfiles, getGraph, getHealth } from '../api/client';
import type { AgentProfile, GraphResponse, RunDetail } from '../types';
import { Badge, Card, CardHeader, Skeleton, StatusDot } from '../ui';
import { cn } from '../ui/cn';

interface Props {
  run: RunDetail | null;
}

interface HealthData {
  status?: string;
  app?: string;
  dependencies?: Record<string, string>;
}

function normalizeStatus(value?: string) {
  if (!value) return 'unknown';
  if (value.startsWith('postgresql')) return 'online';
  if (value.startsWith('redis://')) return 'online';
  return value;
}

function isImageAvatar(value: string) {
  return /^https?:\/\//i.test(value.trim()) || value.trim().startsWith('data:image/');
}

function AgentAvatar({ avatar, name }: { avatar: string; name: string }) {
  const trimmed = (avatar || '').trim();
  if (isImageAvatar(trimmed)) {
    return (
      <img
        className="h-6 w-6 rounded-full object-cover border border-[var(--color-border-default)]"
        src={trimmed}
        alt={name}
        loading="lazy"
      />
    );
  }
  return (
    <span className="h-6 w-6 rounded-full grid place-items-center text-[var(--text-xs)] bg-[var(--color-bg-elevated)] border border-[var(--color-border-default)] text-[var(--color-fg-muted)]">
      {trimmed || '•'}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{label}</p>
      <p data-slot="metric" className="text-[var(--text-lg)] font-semibold">
        {value}
      </p>
    </div>
  );
}

export function HealthPanel({ run }: Props) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [] });
  const [agents, setAgents] = useState<Record<string, AgentProfile>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [healthData, graphData, agentData] = await Promise.all([
          getHealth(),
          getGraph(220),
          getAgentProfiles(),
        ]);
        setHealth(healthData as HealthData);
        setGraph(graphData);
        setAgents(agentData.agents);
      } finally {
        setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const metrics = useMemo(() => {
    const state = (run?.state ?? {}) as Record<string, unknown>;
    const toolResults = Array.isArray(state.tool_results) ? state.tool_results.length : 0;
    const memoryRefs = Array.isArray(state.memory_refs) ? state.memory_refs.length : 0;
    const errors = Array.isArray(state.errors) ? state.errors.length : 0;
    return {
      entities: graph.nodes.length,
      relationships: graph.edges.length,
      toolsObserved: toolResults,
      memoryRefs,
      retries: errors,
      agents: Object.keys(agents).length,
      integrations: Object.keys(health?.dependencies ?? {}).length,
    };
  }, [graph, health, run, agents]);

  return (
    <Card>
      <CardHeader
        eyebrow="OPS HEALTH"
        title="Operational health"
        description="System readiness, agents, integrations, graph scale."
      />
      {loading ? (
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
            <Metric label="Entities" value={metrics.entities} />
            <Metric label="Relationships" value={metrics.relationships} />
            <Metric label="Agents" value={metrics.agents} />
            <Metric label="Integrations" value={metrics.integrations} />
          </div>
          <div className="grid grid-cols-3 gap-2 mb-4">
            <Metric label="Tools used" value={metrics.toolsObserved} />
            <Metric label="Memory hits" value={metrics.memoryRefs} />
            <Metric label="Retries" value={metrics.retries} />
          </div>

          {Object.keys(agents).length > 0 ? (
            <>
              <p className="text-[var(--text-xs)] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-2">
                Agents
              </p>
              <ul className="divide-y divide-[var(--color-border-subtle)] mb-4">
                {Object.values(agents).map((agent) => (
                  <li key={agent.id} className="flex items-center justify-between py-1.5 text-[var(--text-sm)]">
                    <span className="flex items-center gap-2 min-w-0">
                      <AgentAvatar avatar={agent.avatar} name={agent.name} />
                      <span className="truncate">{agent.name}</span>
                    </span>
                    <Badge tone={run?.status === 'running' ? 'accent' : 'neutral'} size="sm">
                      {run?.status === 'running' ? 'active' : 'standby'}
                    </Badge>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {Object.keys(health?.dependencies ?? {}).length > 0 ? (
            <>
              <p className="text-[var(--text-xs)] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-2">
                Dependencies
              </p>
              <ul className="space-y-1">
                {Object.entries(health?.dependencies ?? {}).map(([name, status]) => {
                  const normalized = normalizeStatus(status);
                  const ok = normalized === 'online' || normalized === 'ok';
                  return (
                    <li
                      key={name}
                      className="flex items-center justify-between text-[var(--text-sm)] font-mono"
                    >
                      <span className="flex items-center gap-2">
                        <StatusDot tone={ok ? 'success' : 'warning'} />
                        <span>{name}</span>
                      </span>
                      <span className={cn('text-[var(--text-xs)]', ok ? 'text-[var(--color-success)]' : 'text-[var(--color-warning)]')}>
                        {normalized}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="text-[var(--text-sm)] text-[var(--color-fg-muted)] flex items-center gap-2">
              <Activity size={14} aria-hidden /> Dependency status not available.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
