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
