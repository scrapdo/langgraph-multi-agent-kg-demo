const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000';

export interface GoogleWorkspaceStatus {
  enabled: boolean;
  connected: boolean;
  oauth_configured: boolean;
  user: string;
  calendar_id: string;
  token_source: 'env' | 'oauth_store' | 'none';
  expires_at?: string | null;
  updated_at?: string | null;
  granted_scope?: string | null;
  can_refresh?: boolean;
  supported_actions: string[];
  required_scopes: string[];
  redirect_uri: string;
  connect_hint?: string;
}

export async function getGoogleStatus(): Promise<GoogleWorkspaceStatus> {
  const res = await fetch(`${API_BASE}/google/oauth/status`);
  if (!res.ok) throw new Error(`Failed to load Google status: ${res.status}`);
  return res.json();
}

export async function startGoogleOAuth(): Promise<{ url: string; state: string }> {
  const res = await fetch(`${API_BASE}/google/oauth/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start Google OAuth: ${res.status}`);
  return res.json();
}

export async function disconnectGoogle(): Promise<void> {
  const res = await fetch(`${API_BASE}/google/oauth/disconnect`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to disconnect Google: ${res.status}`);
}

export interface BriefContext {
  connected: boolean;
  messages: Array<{ id: string; subject: string; from: string; date: string }>;
  events: Array<{ summary: string; start?: string; end?: string; location?: string; attendees?: string[] }>;
  overlaps: string[];
  generated_at?: string | null;
  error?: string;
}

export async function getBriefContext(): Promise<BriefContext> {
  const res = await fetch(`${API_BASE}/workspace/morning-brief-context`);
  if (!res.ok) throw new Error(`Failed to load brief context: ${res.status}`);
  return res.json();
}
