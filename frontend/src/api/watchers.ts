const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000';

export interface WatcherConfig {
  enabled: boolean;
  poll_seconds: number;
  lead_time_minutes: number;
  priority_senders: string[];
  dismiss_ids: string[];
  last_fired: Record<string, string>;
  user_id: string;
  session_id: string;
}

export async function getWatcherConfig(): Promise<WatcherConfig> {
  const res = await fetch(`${API_BASE}/watchers`);
  if (!res.ok) throw new Error(`Failed to load watchers: ${res.status}`);
  const data = (await res.json()) as { config: WatcherConfig };
  return data.config;
}

export async function saveWatcherConfig(patch: Partial<WatcherConfig>): Promise<WatcherConfig> {
  const res = await fetch(`${API_BASE}/watchers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to save watchers: ${res.status}`);
  const data = (await res.json()) as { config: WatcherConfig };
  return data.config;
}

export async function dismissWatcherItems(ids: string[]): Promise<WatcherConfig> {
  const res = await fetch(`${API_BASE}/watchers/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`Failed to dismiss watcher items: ${res.status}`);
  const data = (await res.json()) as { config: WatcherConfig };
  return data.config;
}

export async function undismissWatcherItems(ids: string[]): Promise<WatcherConfig> {
  const res = await fetch(`${API_BASE}/watchers/undismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`Failed to undismiss watcher items: ${res.status}`);
  const data = (await res.json()) as { config: WatcherConfig };
  return data.config;
}
