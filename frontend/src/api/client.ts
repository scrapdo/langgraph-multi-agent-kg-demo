import type {
  ApprovalItem,
  AgentProfilesResponse,
  GraphResponse,
  HuggingFaceSearchResponse,
  HuggingFaceStatus,
  HeyGenAssetsResponse,
  ProvidersCatalog,
  RunDetail,
  RunMemoryResponse,
  RunMode,
  RunResponse,
  LocalAppDefinition,
  DesktopAction,
  DesktopSchedule,
  ShoppingSummaryResponse,
  SocialSummaryResponse,
  ThreadDetailResponse,
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

export async function getRunMemory(runId: string): Promise<RunMemoryResponse> {
  const res = await fetch(`${API_BASE}/runs/${runId}/memory`);
  if (!res.ok) throw new Error(`Failed to fetch run memory: ${res.status}`);
  return res.json();
}

export async function getThreadDetail(threadId: string): Promise<ThreadDetailResponse> {
  const res = await fetch(`${API_BASE}/threads/${encodeURIComponent(threadId)}`);
  if (!res.ok) throw new Error(`Failed to fetch thread detail: ${res.status}`);
  return res.json();
}

export async function getGraph(
  limit = 150,
  options?: { runId?: string | null; threadId?: string | null; labels?: string[] },
): Promise<GraphResponse> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (options?.runId) query.set('run_id', options.runId);
  if (options?.threadId) query.set('thread_id', options.threadId);
  for (const label of options?.labels ?? []) query.append('labels', label);
  const res = await fetch(`${API_BASE}/graph?${query.toString()}`);
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

export async function getLocalAppsCatalog(): Promise<{ apps: LocalAppDefinition[] }> {
  const res = await fetch(`${API_BASE}/local-apps/catalog`);
  if (!res.ok) throw new Error(`Failed to fetch local app catalog: ${res.status}`);
  return res.json();
}

export async function getDesktopStatus(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/desktop/status`);
  if (!res.ok) throw new Error(`Failed to fetch desktop status: ${res.status}`);
  return res.json();
}

export async function getDesktopBridgeStatus(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/desktop/bridge/status`);
  if (!res.ok) throw new Error(`Failed to fetch desktop bridge status: ${res.status}`);
  return res.json();
}

export async function testDesktopBridge(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/desktop/bridge/test`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to test desktop bridge: ${text}`);
  }
  return res.json();
}

export async function getDesktopBridgeDiagnostics(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/desktop/bridge/diagnostics`);
  if (!res.ok) throw new Error(`Failed to fetch desktop bridge diagnostics: ${res.status}`);
  return res.json();
}

export async function runDesktopBridgeCheck(kind: 'finder' | 'word' | 'ai_influencer'): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/desktop/bridge/test/${encodeURIComponent(kind)}`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

export async function startGoogleOAuth(): Promise<{ url: string; state: string }> {
  const res = await fetch(`${API_BASE}/google/oauth/start`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to start Google OAuth: ${text}`);
  }
  return res.json();
}

export async function disconnectGoogleOAuth(): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/google/oauth/disconnect`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to disconnect Google OAuth: ${res.status}`);
  return res.json();
}

export async function getDesktopActions(runId?: string | null): Promise<{ actions: DesktopAction[] }> {
  const query = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
  const res = await fetch(`${API_BASE}/desktop/actions${query}`);
  if (!res.ok) throw new Error(`Failed to fetch desktop actions: ${res.status}`);
  return res.json();
}

export async function getDesktopSchedules(): Promise<{ schedules: DesktopSchedule[] }> {
  const res = await fetch(`${API_BASE}/desktop/schedules`);
  if (!res.ok) throw new Error(`Failed to fetch desktop schedules: ${res.status}`);
  return res.json();
}

export async function upsertDesktopSchedule(payload: Partial<DesktopSchedule> & { name: string; workflow_kind: string; agent_id: string; cadence_label: string; rrule: string; notes?: string[]; enabled?: boolean }) {
  const res = await fetch(`${API_BASE}/desktop/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save desktop schedule: ${res.status}`);
  return res.json();
}

export async function dispatchDesktopSchedules() {
  const res = await fetch(`${API_BASE}/desktop/schedules/dispatch`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to dispatch desktop schedules: ${res.status}`);
  return res.json();
}

export async function createWriterDocAction(runId: string, title?: string) {
  const res = await fetch(`${API_BASE}/desktop/actions/writer-doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId, title }),
  });
  if (!res.ok) throw new Error(`Failed to create writer doc action: ${res.status}`);
  return res.json();
}

export async function createSocialPackageAction(runId: string, title?: string) {
  const res = await fetch(`${API_BASE}/desktop/actions/social-package`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId, title }),
  });
  if (!res.ok) throw new Error(`Failed to create social package action: ${res.status}`);
  return res.json();
}

export async function createGmailCalendarAction(
  runId: string,
  prompt: string,
  title?: string,
  actionType: 'snapshot' | 'inbox_triage' | 'agenda_brief' | 'conflict_scan' | 'morning_brief' | 'draft_reply_suggestions' = 'snapshot',
) {
  const res = await fetch(`${API_BASE}/desktop/actions/gmail-calendar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId, prompt, title, action_type: actionType }),
  });
  if (!res.ok) throw new Error(`Failed to create Gmail/calendar action: ${res.status}`);
  return res.json();
}

export async function createAiInfluencerAction(runId: string, title?: string) {
  const res = await fetch(`${API_BASE}/desktop/actions/ai-influencer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId, title }),
  });
  if (!res.ok) throw new Error(`Failed to create AI influencer action: ${res.status}`);
  return res.json();
}

export async function executeDesktopAction(actionId: string) {
  const res = await fetch(`${API_BASE}/desktop/actions/${encodeURIComponent(actionId)}/execute`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to execute desktop action: ${res.status}`);
  return res.json();
}

export async function revealDesktopAction(actionId: string) {
  const res = await fetch(`${API_BASE}/desktop/actions/${encodeURIComponent(actionId)}/reveal`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to reveal desktop action output: ${res.status}`);
  return res.json();
}

export async function openDesktopAction(actionId: string) {
  const res = await fetch(`${API_BASE}/desktop/actions/${encodeURIComponent(actionId)}/open`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Failed to open desktop action output: ${res.status}`);
  return res.json();
}

export async function updateAgentProfiles(
  agents: Record<
    string,
    Partial<{
      name: string;
      avatar: string;
      provider: string;
      model: string;
      function: string;
      speech_voice: string;
      speech_style: string;
      speech_persona: string;
      premium_voice_id: string;
      heygen_avatar_id: string;
      heygen_voice_id: string;
      app_execution_mode: 'disabled' | 'approval' | 'auto';
      specialist_apps: string[];
    }>
  >,
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

export async function getRunSpeech(
  runId: string,
  options?: {
    agentId?: string;
    provider?: string;
    voice?: string;
    premiumVoiceId?: string;
    profile?: string;
    persona?: string;
  },
): Promise<Blob> {
  const query = new URLSearchParams({
    agent_id: options?.agentId ?? 'writer',
    provider: options?.provider ?? 'openai',
    voice: options?.voice ?? 'alloy',
    profile: options?.profile ?? 'natural',
    fmt: options?.provider === 'parler' ? 'wav' : 'mp3',
  });
  if (options?.premiumVoiceId) query.set('premium_voice_id', options.premiumVoiceId);
  if (options?.persona) query.set('persona', options.persona);
  const res = await fetch(`${API_BASE}/runs/${runId}/speech?${query.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch speech audio: ${res.status}`);
  return res.blob();
}

export async function getHeyGenAssets(): Promise<HeyGenAssetsResponse> {
  const res = await fetch(`${API_BASE}/heygen/assets`);
  if (!res.ok) throw new Error(`Failed to fetch HeyGen assets: ${res.status}`);
  return res.json();
}

export async function createHeyGenVideo(script: string, avatarId: string, voiceId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/heygen/videos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, avatar_id: avatarId, voice_id: voiceId }),
  });
  if (!res.ok) throw new Error(`Failed to create HeyGen video: ${res.status}`);
  return res.json();
}

export async function getHeyGenVideoStatus(videoId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/heygen/videos/${encodeURIComponent(videoId)}`);
  if (!res.ok) throw new Error(`Failed to fetch HeyGen video status: ${res.status}`);
  return res.json();
}

export async function createHeyGenLiveSession(avatarId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/heygen/live/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar_id: avatarId }),
  });
  if (!res.ok) throw new Error(`Failed to create HeyGen live session: ${res.status}`);
  return res.json();
}

export async function startHeyGenLiveSession(sessionId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/heygen/live/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) throw new Error(`Failed to start HeyGen live session: ${res.status}`);
  return res.json();
}

export async function sendHeyGenLiveTask(sessionId: string, text: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/heygen/live/task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, text }),
  });
  if (!res.ok) throw new Error(`Failed to send HeyGen live task: ${res.status}`);
  return res.json();
}

export async function stopHeyGenLiveSession(sessionId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/heygen/live/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
  if (!res.ok) throw new Error(`Failed to stop HeyGen live session: ${res.status}`);
  return res.json();
}

export async function getHuggingFaceStatus(): Promise<HuggingFaceStatus> {
  const res = await fetch(`${API_BASE}/hf/status`);
  if (!res.ok) throw new Error(`Failed to fetch Hugging Face status: ${res.status}`);
  return res.json();
}

export async function searchHuggingFaceModels(query: string, limit = 8, task?: string): Promise<HuggingFaceSearchResponse> {
  const params = new URLSearchParams({ query, limit: String(limit) });
  if (task) params.set('task', task);
  const res = await fetch(`${API_BASE}/hf/models?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch Hugging Face models: ${res.status}`);
  return res.json();
}

export async function searchHuggingFaceDatasets(query: string, limit = 8): Promise<HuggingFaceSearchResponse> {
  const params = new URLSearchParams({ query, limit: String(limit) });
  const res = await fetch(`${API_BASE}/hf/datasets?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch Hugging Face datasets: ${res.status}`);
  return res.json();
}

export async function searchHuggingFaceSpaces(query: string, limit = 8): Promise<HuggingFaceSearchResponse> {
  const params = new URLSearchParams({ query, limit: String(limit) });
  const res = await fetch(`${API_BASE}/hf/spaces?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch Hugging Face spaces: ${res.status}`);
  return res.json();
}

export async function getShoppingSummary(runId: string): Promise<ShoppingSummaryResponse> {
  const res = await fetch(`${API_BASE}/runs/${runId}/shopping`);
  if (!res.ok) throw new Error(`Failed to fetch shopping summary: ${res.status}`);
  return res.json();
}

export async function getSocialSummary(runId: string): Promise<SocialSummaryResponse> {
  const res = await fetch(`${API_BASE}/runs/${runId}/social`);
  if (!res.ok) throw new Error(`Failed to fetch social summary: ${res.status}`);
  return res.json();
}

export async function publishSocialRun(runId: string, platform: 'x' | 'linkedin' | 'instagram', message: string, mode: RunMode) {
  const res = await fetch(`${API_BASE}/runs/${runId}/social/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, message, mode }),
  });
  if (!res.ok) throw new Error(`Failed to publish social run: ${res.status}`);
  return res.json();
}

export async function getApprovals(runId: string): Promise<{ run_id: string; approvals: ApprovalItem[] }> {
  const res = await fetch(`${API_BASE}/runs/${runId}/approvals`);
  if (!res.ok) throw new Error(`Failed to fetch approvals: ${res.status}`);
  return res.json();
}

export async function queueShoppingLead(runId: string, payload: { url: string; title: string; domain: string }) {
  const res = await fetch(`${API_BASE}/runs/${runId}/shopping/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to queue shopping lead: ${res.status}`);
  return res.json();
}

export async function queueSocialPost(runId: string, payload: { platform: string; message: string }) {
  const res = await fetch(`${API_BASE}/runs/${runId}/social/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to queue social post: ${res.status}`);
  return res.json();
}

export async function resolveApproval(runId: string, approvalId: string, payload: { action: 'approve' | 'reject'; mode: RunMode }) {
  const res = await fetch(`${API_BASE}/runs/${runId}/approvals/${approvalId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to resolve approval: ${res.status}`);
  return res.json();
}
