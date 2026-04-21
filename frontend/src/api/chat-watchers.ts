const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000';

export interface ProviderBlock {
  enabled: boolean;
  bot_token: string;
  has_token?: boolean;
  poll_seconds: number;
  last_seen?: Record<string, string>;
}

export interface SlackBlock extends ProviderBlock {
  channels: string[];
}

export interface DiscordBlock extends ProviderBlock {
  guild_ids: string[];
}

export interface ChatWatchersConfig {
  slack: SlackBlock;
  discord: DiscordBlock;
  user_id: string;
  session_id: string;
}

export async function getChatWatchers(): Promise<ChatWatchersConfig> {
  const res = await fetch(`${API_BASE}/chat-watchers`);
  if (!res.ok) throw new Error(`Failed to load chat watchers: ${res.status}`);
  const data = (await res.json()) as { config: ChatWatchersConfig };
  return data.config;
}

export async function saveChatWatchers(
  patch: Partial<{
    slack: Partial<SlackBlock>;
    discord: Partial<DiscordBlock>;
    user_id: string;
    session_id: string;
  }>,
): Promise<ChatWatchersConfig> {
  const res = await fetch(`${API_BASE}/chat-watchers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to save chat watchers: ${res.status}`);
  const data = (await res.json()) as { config: ChatWatchersConfig };
  return data.config;
}
