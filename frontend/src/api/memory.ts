const API_BASE = (typeof window !== 'undefined' && (window as any).__BRAIN_API_BASE__) || (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8000';

export interface MemoryTimelineEpisode {
  episode_id?: string | null;
  agent_id?: string | null;
  episode_type?: string | null;
  content: string;
  created_at?: string | null;
  run_id?: string | null;
  thread_id?: string | null;
  task_preview?: string;
}

export interface MemoryTimelineClaim {
  claim_id?: string | null;
  text: string;
  status?: string | null;
  run_id?: string | null;
  thread_id?: string | null;
  created_at?: string | null;
}

export interface MemoryTimelineEntity {
  entity_id?: string | null;
  name: string;
  entity_type?: string | null;
  mentions: number;
  last_run_id?: string | null;
  last_seen?: string | null;
}

export interface MemoryTimelineThread {
  thread_id: string;
  last_task: string;
  last_updated?: string | null;
  run_count: number;
}

export interface MemoryTimelineResponse {
  episodes: MemoryTimelineEpisode[];
  claims: MemoryTimelineClaim[];
  entities: MemoryTimelineEntity[];
  threads: MemoryTimelineThread[];
}

export async function getMemoryTimeline(limit = 80, query?: string): Promise<MemoryTimelineResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query && query.trim()) params.set('q', query.trim());
  const res = await fetch(`${API_BASE}/memory/timeline?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load memory timeline: ${res.status}`);
  return res.json();
}
