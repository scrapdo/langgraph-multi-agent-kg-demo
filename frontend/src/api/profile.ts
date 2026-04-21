const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000';

export interface UserProfile {
  name: string;
  role: string;
  timezone: string;
  location: string;
  goals: string[];
  preferences: string;
  current_focus: string;
  notes: string;
  updated_at: string;
}

export async function getUserProfile(): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/profile`);
  if (!res.ok) throw new Error(`Failed to load profile: ${res.status}`);
  const data = (await res.json()) as { profile: UserProfile };
  return data.profile;
}

export async function saveUserProfile(patch: Partial<UserProfile>): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to save profile: ${res.status}`);
  const data = (await res.json()) as { profile: UserProfile };
  return data.profile;
}

export type QuickActionTarget = 'desktop' | 'clipboard' | 'obsidian';

export async function rememberFact(fact: string): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/profile/remember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fact }),
  });
  if (!res.ok) throw new Error(`Failed to remember fact: ${res.status}`);
  const data = (await res.json()) as { profile: UserProfile };
  return data.profile;
}

export interface FactProposal {
  has_new_facts: boolean;
  proposals: Partial<{
    name: string;
    role: string;
    location: string;
    timezone: string;
    current_focus: string;
    preferences: string;
    goals_add: string[];
    notes_add: string;
  }>;
  reason: string;
}

export async function extractFactsFromTurn(userTask: string, assistantOutput: string): Promise<FactProposal> {
  const res = await fetch(`${API_BASE}/profile/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_task: userTask, assistant_output: assistantOutput }),
  });
  if (!res.ok) throw new Error(`Fact extraction failed: ${res.status}`);
  const data = (await res.json()) as { proposal: FactProposal };
  return data.proposal;
}

export async function applyProfileProposals(proposals: FactProposal['proposals']): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/profile/apply-proposals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposals }),
  });
  if (!res.ok) throw new Error(`Failed to apply proposals: ${res.status}`);
  const data = (await res.json()) as { profile: UserProfile };
  return data.profile;
}

export async function dispatchQuickAction(payload: {
  action: 'note' | 'email' | 'followup';
  title?: string;
  content?: string;
  prompt?: string;
  to?: string;
  mode?: string;
  session_id?: string;
  target?: QuickActionTarget;
  vault?: string;
}): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/quick-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Quick action failed: ${res.status}`);
  }
  return res.json();
}
