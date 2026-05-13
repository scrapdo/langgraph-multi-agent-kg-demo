import type {
  ApprovalItem,
  AgentProfilesResponse,
  GraphResponse,
  HuggingFaceSearchResponse,
  HuggingFaceStatus,
  ProvidersCatalog,
  RunDetail,
  RunMemoryResponse,
  RunMode,
  RunResponse,
  LocalAppDefinition,
  OperatorInboxResponse,
  DesktopAction,
  DesktopSchedule,
  DesktopSchedulePreset,
  BrowserInspectionResult,
  BrowserWorkflow,
  DocumentProcessResponse,
  PlaywrightScript,
  PlaywrightScriptPreset,
  SchedulerAvailabilityResponse,
  SchedulerBooking,
  SchedulerDashboardResponse,
  SchedulerProfile,
  SchedulerPublicProfile,
  ShoppingSummaryResponse,
  SocialSummaryResponse,
  SecretaryDispatchRequest,
  SecretaryContactPreference,
  ThreadDetailResponse,
} from '../types';

const API_BASE = (typeof window !== 'undefined' && (window as any).__BRAIN_API_BASE__) || (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8000';

export type TaskTypeOverride =
  | 'market_research'
  | 'capabilities'
  | 'conversation'
  | 'shopping'
  | 'social_media'
  | 'secretary'
  | 'news_brief'
  | 'wellness_coaching';

export async function startRun(
  task: string,
  mode: RunMode,
  conservativeSpecialistRouting = false,
  taskType?: TaskTypeOverride,
): Promise<RunResponse> {
  const body: Record<string, unknown> = {
    task,
    mode,
    conservative_specialist_routing: conservativeSpecialistRouting,
  };
  if (taskType) body.task_type = taskType;
  const res = await fetch(`${API_BASE}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to start run: ${res.status}`);
  return res.json();
}

export async function getRun(runId: string): Promise<RunDetail> {
  const res = await fetch(`${API_BASE}/runs/${runId}`);
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`);
  return res.json();
}

export interface RunSummary {
  run_id: string;
  status: string;
  title: string;
  preview: string;
  created_at: string;
  updated_at: string;
  elapsed_ms?: number | null;
  estimated_total_tokens?: number | null;
}

export async function listRuns(limit = 50, query?: string, sessionId?: string): Promise<RunSummary[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query && query.trim()) params.set('q', query.trim());
  if (sessionId && sessionId.trim()) params.set('session_id', sessionId.trim());
  const res = await fetch(`${API_BASE}/runs?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to list runs: ${res.status}`);
  const data = (await res.json()) as { runs: RunSummary[] };
  return data.runs;
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

export async function getOperatorInbox(limit = 40): Promise<OperatorInboxResponse> {
  const res = await fetch(`${API_BASE}/ops/inbox?limit=${encodeURIComponent(String(limit))}`);
  if (!res.ok) throw new Error(`Failed to fetch operator inbox: ${res.status}`);
  return res.json();
}

export async function getSchedulerDashboard(): Promise<SchedulerDashboardResponse> {
  const res = await fetch(`${API_BASE}/scheduler`);
  if (!res.ok) throw new Error(`Failed to fetch scheduler dashboard: ${res.status}`);
  return res.json();
}

export async function getSchedulerProfile(): Promise<SchedulerProfile> {
  const res = await fetch(`${API_BASE}/scheduler/profile`);
  if (!res.ok) throw new Error(`Failed to fetch scheduler profile: ${res.status}`);
  return res.json();
}

export async function updateSchedulerProfile(payload: SchedulerProfile): Promise<SchedulerProfile> {
  const res = await fetch(`${API_BASE}/scheduler/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to update scheduler profile: ${res.status}`);
  return res.json();
}

export async function getPublicSchedulerProfile(slug: string): Promise<SchedulerPublicProfile> {
  const res = await fetch(`${API_BASE}/scheduler/public/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Failed to fetch public scheduler profile: ${res.status}`);
  return res.json();
}

export async function getPublicSchedulerAvailability(slug: string, eventType: string, date: string): Promise<SchedulerAvailabilityResponse> {
  const query = new URLSearchParams({ event_type: eventType, date });
  const res = await fetch(`${API_BASE}/scheduler/public/${encodeURIComponent(slug)}/availability?${query.toString()}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to fetch scheduler availability: ${res.status}`);
  }
  return res.json();
}

export async function createPublicSchedulerBooking(
  slug: string,
  payload: { event_type_slug: string; start_at: string; name: string; email: string; notes?: string },
): Promise<SchedulerBooking> {
  const res = await fetch(`${API_BASE}/scheduler/public/${encodeURIComponent(slug)}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to create booking: ${res.status}`);
  }
  return res.json();
}

export async function getSecretaryStatus(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/secretary/status`);
  if (!res.ok) throw new Error(`Failed to fetch secretary status: ${res.status}`);
  return res.json();
}

export async function dispatchSecretaryAction(payload: SecretaryDispatchRequest) {
  const res = await fetch(`${API_BASE}/secretary/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      throw new Error(parsed.detail || `Failed to dispatch secretary action: ${res.status}`);
    } catch {
      throw new Error(text || `Failed to dispatch secretary action: ${res.status}`);
    }
  }
  return res.json();
}

export async function getSecretaryContacts(): Promise<{ contacts: SecretaryContactPreference[] }> {
  const res = await fetch(`${API_BASE}/secretary/contacts`);
  if (!res.ok) throw new Error(`Failed to fetch secretary contacts: ${res.status}`);
  return res.json();
}

export async function saveSecretaryContact(payload: SecretaryContactPreference) {
  const res = await fetch(`${API_BASE}/secretary/contacts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to save secretary contact: ${res.status}`);
  }
  return res.json();
}

export interface VisionDescribeResponse {
  ok: boolean;
  filename: string;
  size: number;
  content_type: string;
  description: string;
}

export async function describeImage(file: File): Promise<VisionDescribeResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/vision/describe`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Failed to describe image: ${res.status}`);
  }
  return res.json();
}

export async function processDocument(file: File): Promise<DocumentProcessResponse> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/documents/process`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Failed to process document: ${res.status}`);
  return res.json();
}

export function getRunReportUrl(runId: string) {
  return `${API_BASE}/reports/run/${encodeURIComponent(runId)}`;
}

export async function inspectBrowserUrl(url: string): Promise<BrowserInspectionResult> {
  const query = new URLSearchParams({ url });
  const res = await fetch(`${API_BASE}/browser/inspect?${query.toString()}`);
  if (!res.ok) throw new Error(`Failed to inspect browser URL: ${res.status}`);
  return res.json();
}

export async function getBrowserWorkflows(): Promise<{ workflows: BrowserWorkflow[] }> {
  const res = await fetch(`${API_BASE}/browser/workflows`);
  if (!res.ok) throw new Error(`Failed to fetch browser workflows: ${res.status}`);
  return res.json();
}

export async function saveBrowserWorkflow(payload: Partial<BrowserWorkflow> & { name: string; start_url: string; goal?: string; urls?: string[]; agent_id?: string; mode?: RunMode }) {
  const res = await fetch(`${API_BASE}/browser/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save browser workflow: ${res.status}`);
  return res.json();
}

export async function runBrowserWorkflow(workflowId: string): Promise<{ workflow: BrowserWorkflow; results: BrowserInspectionResult[] }> {
  const res = await fetch(`${API_BASE}/browser/workflows/${encodeURIComponent(workflowId)}/run`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to run browser workflow: ${res.status}`);
  return res.json();
}

export async function getPlaywrightStatus(): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/browser/playwright/status`);
  if (!res.ok) throw new Error(`Failed to fetch Playwright status: ${res.status}`);
  return res.json();
}

export async function getPlaywrightScripts(): Promise<{ scripts: PlaywrightScript[] }> {
  const res = await fetch(`${API_BASE}/browser/playwright/scripts`);
  if (!res.ok) throw new Error(`Failed to fetch Playwright scripts: ${res.status}`);
  return res.json();
}

export async function getPlaywrightPresets(): Promise<{ presets: PlaywrightScriptPreset[] }> {
  const res = await fetch(`${API_BASE}/browser/playwright/presets`);
  if (!res.ok) throw new Error(`Failed to fetch Playwright presets: ${res.status}`);
  return res.json();
}

export async function installPlaywrightPresets(agentId: string, presetIds?: string[]) {
  const res = await fetch(`${API_BASE}/browser/playwright/presets/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, preset_ids: presetIds }),
  });
  if (!res.ok) throw new Error(`Failed to install Playwright presets: ${res.status}`);
  return res.json();
}

export async function savePlaywrightScript(payload: Partial<PlaywrightScript> & { name: string; start_url: string; steps: Array<Record<string, unknown>>; agent_id?: string }) {
  const res = await fetch(`${API_BASE}/browser/playwright/scripts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save Playwright script: ${res.status}`);
  return res.json();
}

export async function deletePlaywrightScript(scriptId: string) {
  const res = await fetch(`${API_BASE}/browser/playwright/scripts/${encodeURIComponent(scriptId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete Playwright script: ${res.status}`);
  return res.json();
}

export async function runPlaywrightScript(scriptId: string): Promise<{ script: PlaywrightScript; results: Array<Record<string, unknown>> }> {
  const res = await fetch(`${API_BASE}/browser/playwright/scripts/${encodeURIComponent(scriptId)}/run`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

export async function approvePlaywrightScript(scriptId: string): Promise<{ script: PlaywrightScript; results: Array<Record<string, unknown>> }> {
  const res = await fetch(`${API_BASE}/browser/playwright/scripts/${encodeURIComponent(scriptId)}/approve`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
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

export async function getDesktopSchedulePresets(): Promise<{ destination_presets: DesktopSchedulePreset[]; template_presets: DesktopSchedulePreset[] }> {
  const res = await fetch(`${API_BASE}/desktop/schedules/presets`);
  if (!res.ok) throw new Error(`Failed to fetch desktop schedule presets: ${res.status}`);
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

export async function approveDesktopSchedule(scheduleId: string) {
  const res = await fetch(`${API_BASE}/desktop/schedules/${encodeURIComponent(scheduleId)}/approve`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to approve desktop schedule: ${res.status}`);
  return res.json();
}

export async function rejectDesktopSchedule(scheduleId: string) {
  const res = await fetch(`${API_BASE}/desktop/schedules/${encodeURIComponent(scheduleId)}/reject`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to reject desktop schedule: ${res.status}`);
  return res.json();
}

export async function cloneDesktopSchedule(scheduleId: string) {
  const res = await fetch(`${API_BASE}/desktop/schedules/${encodeURIComponent(scheduleId)}/clone`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to clone desktop schedule: ${res.status}`);
  return res.json();
}

export async function pauseDesktopSchedule(scheduleId: string) {
  const res = await fetch(`${API_BASE}/desktop/schedules/${encodeURIComponent(scheduleId)}/pause`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to pause desktop schedule: ${res.status}`);
  return res.json();
}

export async function resumeDesktopSchedule(scheduleId: string) {
  const res = await fetch(`${API_BASE}/desktop/schedules/${encodeURIComponent(scheduleId)}/resume`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to resume desktop schedule: ${res.status}`);
  return res.json();
}

export async function deleteDesktopSchedule(scheduleId: string) {
  const res = await fetch(`${API_BASE}/desktop/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete desktop schedule: ${res.status}`);
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

export interface RealtimeSession {
  /** Short-lived session id from OpenAI. */
  id: string;
  /** The model the session was provisioned against (e.g. gpt-4o-realtime-preview). */
  model: string;
  /** Ephemeral client secret — use as the Bearer for the WebRTC offer. */
  client_secret: { value: string; expires_at?: number };
  /** Agent catalog echoed back by the backend so the UI can label specialists. */
  agents?: Record<string, { task_type: string; description: string }>;
  /** Pass-through for anything else OpenAI returns (ice servers, etc). */
  [key: string]: unknown;
}

export interface AppControlResult {
  ok: boolean;
  app: string;
  action: string;
  result: Record<string, unknown>;
}

export async function executeAppControl(
  app: string,
  action: string,
  args?: Record<string, unknown>,
): Promise<AppControlResult> {
  const res = await fetch(`${API_BASE}/app-control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app, action, args: args ?? {} }),
  });
  if (!res.ok) {
    let detail = `app-control ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* keep generic */
    }
    throw new Error(detail);
  }
  return (await res.json()) as AppControlResult;
}

export interface QuickLookupResult {
  ok: boolean;
  answer: string;
  citations: string[];
}

export async function quickLookup(query: string): Promise<QuickLookupResult> {
  const res = await fetch(`${API_BASE}/quick-lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    let detail = `quick-lookup ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return (await res.json()) as QuickLookupResult;
}

export interface ProactiveSchedule {
  hour: number;
  minute: number;
  days: string[];
  last_fired_on?: string | null;
}

export interface ProactiveTask {
  id: string;
  name: string;
  prompt: string;
  task_type?: string | null;
  schedule: ProactiveSchedule;
  run_count?: number;
  last_run_at?: string | null;
  // Outcome fields — populated by the scheduler's watcher thread once the
  // run reaches a terminal state. Use these to answer "did my X run?" honestly.
  last_run_id?: string | null;
  last_run_status?: 'completed' | 'failed' | 'degraded' | 'stuck' | string | null;
  last_run_completed_at?: string | null;
  last_success_at?: string | null;
  last_output_summary?: string | null;
  last_error?: string | null;
}

export async function createProactiveTask(payload: {
  name: string;
  prompt: string;
  hour: number;
  minute: number;
  days: string[];
  task_type?: string;
}): Promise<ProactiveTask> {
  const res = await fetch(`${API_BASE}/proactive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = `proactive ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as { task: ProactiveTask };
  return body.task;
}

export async function listProactiveTasks(): Promise<ProactiveTask[]> {
  const res = await fetch(`${API_BASE}/proactive`);
  if (!res.ok) throw new Error(`proactive list ${res.status}`);
  const body = (await res.json()) as { tasks: ProactiveTask[] };
  return body.tasks;
}

export interface PlaceCallResult {
  ok: boolean;
  sid?: string;
  status?: string;
  to?: string;
  from?: string;
  placed_at?: string;
}

export async function placeSecretaryCall(to: string, context: string): Promise<PlaceCallResult> {
  const res = await fetch(`${API_BASE}/telephony/place-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, context }),
  });
  if (!res.ok) {
    let detail = `place-call ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* keep generic */
    }
    throw new Error(detail);
  }
  return (await res.json()) as PlaceCallResult;
}

export async function deleteProactiveTask(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/proactive/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`proactive delete ${res.status}`);
}

export async function createRealtimeSession(): Promise<RealtimeSession> {
  const res = await fetch(`${API_BASE}/realtime/session`, { method: 'POST' });
  if (!res.ok) {
    let detail = `Failed to create realtime session: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* keep generic */
    }
    throw new Error(detail);
  }
  return (await res.json()) as RealtimeSession;
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
  if (!res.ok) {
    let detail = `Failed to fetch speech audio: ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.detail) detail = String(payload.detail);
    } catch {
      // Keep the generic message if the error body is not JSON.
    }
    throw new Error(detail);
  }
  return res.blob();
}

export async function testTts(
  options?: {
    text?: string;
    agentId?: string;
    provider?: string;
    voice?: string;
    premiumVoiceId?: string;
    profile?: string;
    persona?: string;
  },
): Promise<Blob> {
  const res = await fetch(`${API_BASE}/tts/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: options?.text,
      agent_id: options?.agentId,
      provider: options?.provider,
      voice: options?.voice,
      premium_voice_id: options?.premiumVoiceId,
      profile: options?.profile,
      persona: options?.persona,
    }),
  });
  if (!res.ok) {
    let detail = `Failed to test TTS: ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.detail) detail = String(payload.detail);
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return res.blob();
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
