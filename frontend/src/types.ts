export type RunMode = 'simulation' | 'live';

export interface RunResponse {
  run_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'degraded';
}

export interface RunDetail {
  run_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'degraded';
  mode: RunMode;
  task: string;
  state: Record<string, unknown>;
  output?: string;
  created_at: string;
  updated_at: string;
}

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: Record<string, unknown>;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AgentProfile {
  id: string;
  name: string;
  avatar: string;
  provider: string;
  model: string;
  function: string;
}

export interface AgentProfilesResponse {
  agents: Record<string, AgentProfile>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  enabled: boolean;
  models: string[];
}

export interface ProvidersCatalog {
  providers: ProviderDefinition[];
  recommended_by_function: Record<string, { provider: string; model: string }>;
}
