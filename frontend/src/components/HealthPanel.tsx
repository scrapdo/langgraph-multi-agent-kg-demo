import { useEffect, useMemo, useState } from 'react';
import { getAgentProfiles, getGraph, getHealth } from '../api/client';
import type { AgentProfile, GraphResponse, RunDetail } from '../types';

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
    return <img className="health-avatar-image" src={trimmed} alt={name} loading="lazy" />;
  }
  return <span className="health-avatar-text">{trimmed || '•'}</span>;
}

export function HealthPanel({ run }: Props) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [] });
  const [agents, setAgents] = useState<Record<string, AgentProfile>>({});

  useEffect(() => {
    const load = async () => {
      const [healthData, graphData, agentData] = await Promise.all([getHealth(), getGraph(220), getAgentProfiles()]);
      setHealth(healthData as HealthData);
      setGraph(graphData);
      setAgents(agentData.agents);
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
      jobs: 53,
      agents: Object.keys(agents).length,
      integrations: Object.keys(health?.dependencies ?? {}).length,
    };
  }, [graph, health, run, agents]);

  return (
    <section className="panel ops-panel">
      <h2>Operational Health</h2>
      <p className="muted">System readiness, active agent roster, integration state, and live graph scale.</p>

      <div className="metric-grid">
        <article>
          <h4>Entities</h4>
          <p>{metrics.entities}</p>
        </article>
        <article>
          <h4>Relationships</h4>
          <p>{metrics.relationships}</p>
        </article>
        <article>
          <h4>Agents</h4>
          <p>{metrics.agents}</p>
        </article>
        <article>
          <h4>Automations</h4>
          <p>{metrics.jobs}</p>
        </article>
      </div>

      <div className="metric-grid compact">
        <article>
          <h4>Tools Used</h4>
          <p>{metrics.toolsObserved}</p>
        </article>
        <article>
          <h4>Memory Hits</h4>
          <p>{metrics.memoryRefs}</p>
        </article>
        <article>
          <h4>Retries</h4>
          <p>{metrics.retries}</p>
        </article>
        <article>
          <h4>Integrations</h4>
          <p>{metrics.integrations}</p>
        </article>
      </div>

      <h3>Agent Roster</h3>
      <ul className="health-list">
        {Object.values(agents).map((agent) => (
          <li key={agent.id}>
            <span className="health-agent-name">
              <span className="health-avatar-wrap">
                <AgentAvatar avatar={agent.avatar} name={agent.name} />
              </span>
              {agent.name}
            </span>
            <strong>{run?.status === 'running' ? 'active' : 'standby'}</strong>
          </li>
        ))}
      </ul>

      <h3>Dependencies</h3>
      <ul className="health-list">
        {Object.entries(health?.dependencies ?? {}).map(([name, status]) => (
          <li key={name}>
            <span>{name}</span>
            <strong>{normalizeStatus(status)}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
