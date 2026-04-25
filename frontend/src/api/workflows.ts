import type { TaskTypeOverride } from './client';

const API_BASE = (typeof window !== 'undefined' && (window as any).__BRAIN_API_BASE__) || (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8000';

export interface WorkflowParameter {
  name: string;
  label?: string;
  placeholder?: string;
  default?: string;
  required?: boolean;
}

export interface WorkflowSchedule {
  enabled: boolean;
  hour: number;
  minute: number;
  /** 0 = Monday ... 6 = Sunday */
  days: number[];
  last_fired_on?: string | null;
  skip_if_missing_required?: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  parameters: WorkflowParameter[];
  task_type?: TaskTypeOverride | null;
  conservative?: boolean;
  tags?: string[];
  schedule?: WorkflowSchedule;
  created_at: string;
  updated_at: string;
  last_run_id?: string | null;
  last_run_at?: string | null;
  run_count?: number;
  is_seed?: boolean;
}

export interface WorkflowRunResponse {
  ok: boolean;
  run_id: string;
  rendered_prompt: string;
  unresolved_params: string[];
  template: WorkflowTemplate;
}

export async function listWorkflows(): Promise<WorkflowTemplate[]> {
  const res = await fetch(`${API_BASE}/workflows/templates`);
  if (!res.ok) throw new Error(`Failed to load workflows: ${res.status}`);
  const data = (await res.json()) as { templates: WorkflowTemplate[] };
  return data.templates;
}

export async function createWorkflow(patch: Partial<WorkflowTemplate>): Promise<WorkflowTemplate> {
  const res = await fetch(`${API_BASE}/workflows/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.text()) || `Failed to create workflow: ${res.status}`);
  const data = (await res.json()) as { template: WorkflowTemplate };
  return data.template;
}

export async function updateWorkflow(id: string, patch: Partial<WorkflowTemplate>): Promise<WorkflowTemplate> {
  const res = await fetch(`${API_BASE}/workflows/templates/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error((await res.text()) || `Failed to update workflow: ${res.status}`);
  const data = (await res.json()) as { template: WorkflowTemplate };
  return data.template;
}

export async function deleteWorkflow(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/workflows/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Failed to delete workflow: ${res.status}`);
}

export async function runWorkflow(
  id: string,
  params: Record<string, string>,
  options?: { sessionId?: string; background?: boolean },
): Promise<WorkflowRunResponse> {
  const body: Record<string, unknown> = { params };
  if (options?.sessionId) body.session_id = options.sessionId;
  const res = await fetch(`${API_BASE}/workflows/templates/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text()) || `Failed to run workflow: ${res.status}`);
  return res.json();
}
