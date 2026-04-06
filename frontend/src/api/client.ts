import type {
  AgentProfilesResponse,
  GraphResponse,
  ProvidersCatalog,
  RunDetail,
  RunMode,
  RunResponse,
} from '../types';

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8000';

export async function startRun(task: string, mode: RunMode): Promise<RunResponse> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, mode }),
  });
  if (!res.ok) throw new Error(`Failed to start run: ${res.status}`);
  return res.json();
}

export async function getRun(runId: string): Promise<RunDetail> {
  const res = await fetch(`${API_BASE}/runs/${runId}`);
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`);
  return res.json();
}

export async function getGraph(limit = 150): Promise<GraphResponse> {
  const res = await fetch(`${API_BASE}/graph?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch graph: ${res.status}`);
  return res.json();
}

export async function getHealth(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Failed to fetch health: ${res.status}`);
  return res.json();
}

export async function getProvidersCatalog(): Promise<ProvidersCatalog> {
  const res = await fetch(`${API_BASE}/providers/catalog`);
  if (!res.ok) throw new Error(`Failed to fetch provider catalog: ${res.status}`);
  return res.json();
}

export async function getAgentProfiles(): Promise<AgentProfilesResponse> {
  const res = await fetch(`${API_BASE}/agents/config`);
  if (!res.ok) throw new Error(`Failed to fetch agent profiles: ${res.status}`);
  return res.json();
}

export async function updateAgentProfiles(
  agents: Record<string, Partial<{ name: string; avatar: string; provider: string; model: string; function: string }>>,
): Promise<AgentProfilesResponse> {
  const res = await fetch(`${API_BASE}/agents/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents }),
  });
  if (!res.ok) throw new Error(`Failed to update agent profiles: ${res.status}`);
  return res.json();
}

export function streamEvents(runId: string, onEvent: (event: Record<string, unknown>) => void): EventSource {
  const source = new EventSource(`${API_BASE}/runs/${runId}/events`);
  source.onmessage = (evt) => {
    try {
      onEvent(JSON.parse(evt.data));
    } catch {
      onEvent({ raw: evt.data });
    }
  };
  return source;
}

export async function getRunSpeech(runId: string, voice = 'alloy'): Promise<Blob> {
  const res = await fetch(`${API_BASE}/runs/${runId}/speech?voice=${encodeURIComponent(voice)}&fmt=mp3`);
  if (!res.ok) throw new Error(`Failed to fetch speech audio: ${res.status}`);
  return res.blob();
}
