import {
  Calendar,
  ChevronRight,
  Hourglass,
  Pencil,
  Play,
  Plus,
  Tag,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { TaskTypeOverride } from '../api/client';
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
  type WorkflowParameter,
  type WorkflowSchedule,
  type WorkflowTemplate,
} from '../api/workflows';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogContent,
  EmptyState,
  Input,
  Label,
  Skeleton,
  Textarea,
  Tooltip,
} from '../ui';

const TASK_TYPES: Array<{ value: TaskTypeOverride | ''; label: string }> = [
  { value: '', label: 'Auto-detect' },
  { value: 'conversation', label: 'Conversation' },
  { value: 'market_research', label: 'Research' },
  { value: 'social_media', label: 'Social' },
  { value: 'secretary', label: 'Secretary' },
  { value: 'shopping', label: 'Shopping' },
  { value: 'wellness_coaching', label: 'Wellness' },
  { value: 'news_brief', label: 'News' },
  { value: 'capabilities', label: 'Capabilities' },
];

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function extractPlaceholders(prompt: string): string[] {
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(PLACEHOLDER_RE);
  while ((match = regex.exec(prompt)) !== null) seen.add(match[1]);
  return Array.from(seen);
}

/** 0 = Monday, 6 = Sunday (matches Python's datetime.weekday). */
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const DAY_FULL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Returns a human "next run" description for a schedule, or null if disabled/no days. */
function describeNextRun(schedule: WorkflowSchedule | undefined, now = new Date()): string | null {
  if (!schedule || !schedule.enabled) return null;
  const days = (schedule.days || []).slice().sort((a, b) => a - b);
  if (days.length === 0) return null;
  const time = `${pad2(schedule.hour)}:${pad2(schedule.minute)}`;
  // Python Monday=0; JS Sunday=0. Convert JS today to Python weekday.
  const jsDow = now.getDay(); // 0..6 Sun..Sat
  const pyToday = (jsDow + 6) % 7; // 0..6 Mon..Sun
  const slotPassedToday = (() => {
    const slot = new Date(now);
    slot.setHours(schedule.hour, schedule.minute, 0, 0);
    return now > slot;
  })();
  for (let offset = 0; offset < 8; offset++) {
    const candidate = (pyToday + offset) % 7;
    if (!days.includes(candidate)) continue;
    if (offset === 0 && slotPassedToday) continue;
    if (offset === 0) return `Today at ${time}`;
    if (offset === 1) return `Tomorrow at ${time}`;
    return `${DAY_FULL[candidate]} at ${time}`;
  }
  return null;
}

interface RunFormState {
  values: Record<string, string>;
  errors: Record<string, string>;
}

function RunDialog({
  template,
  open,
  onOpenChange,
  onRan,
}: {
  template: WorkflowTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRan?: (template: WorkflowTemplate, runId: string) => void;
}) {
  const [form, setForm] = useState<RunFormState>({ values: {}, errors: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !template) return;
    const values: Record<string, string> = {};
    for (const p of template.parameters ?? []) {
      values[p.name] = p.default ?? '';
    }
    setForm({ values, errors: {} });
    setError(null);
  }, [open, template]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!template) return;
    const errors: Record<string, string> = {};
    for (const p of template.parameters ?? []) {
      if (p.required && !(form.values[p.name] || '').trim()) errors[p.name] = 'Required';
    }
    if (Object.keys(errors).length > 0) {
      setForm((prev) => ({ ...prev, errors }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await runWorkflow(template.id, form.values);
      onRan?.(template, res.run_id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run workflow');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={template?.name ?? 'Run workflow'}
        description={template?.description || 'Fill in the parameters and run.'}
        className="!w-[min(94vw,600px)]"
      >
        {!template ? null : (
          <form onSubmit={onSubmit} className="space-y-3">
            {(template.parameters ?? []).length === 0 ? (
              <p className="text-[var(--text-sm)] text-[var(--color-fg-muted)]">
                No parameters — this workflow runs as-is.
              </p>
            ) : (
              (template.parameters ?? []).map((p) => (
                <div key={p.name}>
                  <Label htmlFor={`param-${p.name}`} required={p.required}>
                    {p.label || p.name}
                  </Label>
                  <Input
                    id={`param-${p.name}`}
                    value={form.values[p.name] ?? ''}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        values: { ...prev.values, [p.name]: e.target.value },
                        errors: { ...prev.errors, [p.name]: '' },
                      }))
                    }
                    placeholder={p.placeholder}
                    invalid={!!form.errors[p.name]}
                  />
                  {form.errors[p.name] ? (
                    <p className="text-[var(--text-xs)] text-[var(--color-danger)] mt-0.5">
                      {form.errors[p.name]}
                    </p>
                  ) : null}
                </div>
              ))
            )}
            {error ? <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p> : null}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="md" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={busy}
                leading={<Play size={14} aria-hidden />}
              >
                Run workflow
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  template,
  open,
  onOpenChange,
  onSaved,
}: {
  template: WorkflowTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (template: WorkflowTemplate) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [taskType, setTaskType] = useState<TaskTypeOverride | ''>('');
  const [conservative, setConservative] = useState(false);
  const [tagsText, setTagsText] = useState('');
  const [paramMeta, setParamMeta] = useState<Record<string, WorkflowParameter>>({});
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleHour, setScheduleHour] = useState(9);
  const [scheduleMinute, setScheduleMinute] = useState(0);
  const [scheduleDays, setScheduleDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (template) {
      setName(template.name);
      setDescription(template.description || '');
      setPrompt(template.prompt);
      setTaskType((template.task_type ?? '') as TaskTypeOverride | '');
      setConservative(Boolean(template.conservative));
      setTagsText((template.tags ?? []).join(', '));
      const meta: Record<string, WorkflowParameter> = {};
      for (const p of template.parameters ?? []) meta[p.name] = { ...p };
      setParamMeta(meta);
      const sched = template.schedule;
      setScheduleEnabled(Boolean(sched?.enabled));
      setScheduleHour(typeof sched?.hour === 'number' ? sched.hour : 9);
      setScheduleMinute(typeof sched?.minute === 'number' ? sched.minute : 0);
      setScheduleDays(
        sched && Array.isArray(sched.days) && sched.days.length > 0 ? [...sched.days] : [0, 1, 2, 3, 4],
      );
    } else {
      setName('');
      setDescription('');
      setPrompt('Help me with {{topic}}.');
      setTaskType('');
      setConservative(false);
      setTagsText('');
      setParamMeta({});
      setScheduleEnabled(false);
      setScheduleHour(9);
      setScheduleMinute(0);
      setScheduleDays([0, 1, 2, 3, 4]);
    }
  }, [open, template]);

  const detected = useMemo(() => extractPlaceholders(prompt), [prompt]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const parameters: WorkflowParameter[] = detected.map((n) => {
        const existing = paramMeta[n] ?? ({ name: n } as WorkflowParameter);
        return {
          name: n,
          label: existing.label || n,
          placeholder: existing.placeholder || '',
          default: existing.default || '',
          required: existing.required ?? false,
        };
      });
      const schedule: WorkflowSchedule = {
        enabled: scheduleEnabled,
        hour: Math.max(0, Math.min(23, Number(scheduleHour) || 0)),
        minute: Math.max(0, Math.min(59, Number(scheduleMinute) || 0)),
        days: scheduleDays.length > 0 ? [...scheduleDays].sort((a, b) => a - b) : [0, 1, 2, 3, 4],
        skip_if_missing_required: true,
      };
      const patch: Partial<WorkflowTemplate> = {
        name,
        description,
        prompt,
        parameters,
        task_type: (taskType || null) as TaskTypeOverride | null,
        conservative,
        tags: tagsText
          .split(/[,\n]/)
          .map((t) => t.trim())
          .filter(Boolean),
        schedule,
      };
      const saved = template
        ? await updateWorkflow(template.id, patch)
        : await createWorkflow(patch);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save workflow');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={template ? 'Edit workflow' : 'New workflow'}
        description={
          template
            ? 'Update the prompt, parameters, or routing hints.'
            : 'Use {{placeholders}} in your prompt — each one becomes a parameter.'
        }
        className="!w-[min(94vw,680px)]"
      >
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <Label htmlFor="tpl-name" required>Name</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly review"
              required
            />
          </div>
          <div>
            <Label htmlFor="tpl-desc" hint="Shown in the list. Keep it to one line.">
              Description
            </Label>
            <Input
              id="tpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Reflect on the week"
            />
          </div>
          <div>
            <Label htmlFor="tpl-prompt" hint="Use {{placeholders}} — they become parameters." required>
              Prompt
            </Label>
            <Textarea
              id="tpl-prompt"
              rows={7}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Draft an email to {{recipient}} about {{topic}}…"
              required
            />
          </div>
          {detected.length > 0 ? (
            <div className="border border-[var(--color-border-subtle)] rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] p-2.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1.5">
                Parameters
              </p>
              <div className="space-y-2">
                {detected.map((name) => {
                  const meta = paramMeta[name] ?? { name };
                  return (
                    <div
                      key={name}
                      className="grid grid-cols-[1.1fr_1.6fr_auto] gap-2 items-center text-[var(--text-sm)]"
                    >
                      <span className="font-mono text-[var(--color-fg-default)] truncate">{name}</span>
                      <Input
                        value={meta.placeholder ?? ''}
                        onChange={(e) =>
                          setParamMeta((prev) => ({
                            ...prev,
                            [name]: { ...(prev[name] ?? { name }), name, placeholder: e.target.value },
                          }))
                        }
                        placeholder="placeholder"
                      />
                      <label className="inline-flex items-center gap-1 text-[var(--text-xs)] text-[var(--color-fg-muted)]">
                        <input
                          type="checkbox"
                          checked={Boolean(meta.required)}
                          onChange={(e) =>
                            setParamMeta((prev) => ({
                              ...prev,
                              [name]: { ...(prev[name] ?? { name }), name, required: e.target.checked },
                            }))
                          }
                        />
                        required
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="tpl-task-type" hint="Pin routing to a specialist. Leave Auto to let the coordinator decide.">
                Routing
              </Label>
              <select
                id="tpl-task-type"
                value={taskType}
                onChange={(e) => setTaskType(e.target.value as TaskTypeOverride | '')}
                className="w-full h-9 bg-[var(--color-bg-sunken)] border border-[var(--color-border-default)] rounded-[var(--radius-md)] px-2.5 text-[var(--text-sm)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
              >
                {TASK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="tpl-tags" hint="Comma-separated.">
                Tags
              </Label>
              <Input
                id="tpl-tags"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder="work, routine"
              />
            </div>
          </div>
          <label className="inline-flex items-center gap-2 text-[var(--text-sm)]">
            <input
              type="checkbox"
              checked={conservative}
              onChange={(e) => setConservative(e.target.checked)}
            />
            <span>
              Conservative routing — keep the coordinator on ambiguous prompts instead of auto-escalating.
            </span>
          </label>

          {/* Schedule section */}
          <div className="border border-[var(--color-border-subtle)] rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] p-3">
            <label className="flex items-center gap-2 text-[var(--text-sm)]">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />
              <Calendar size={13} className="text-[var(--color-fg-muted)]" aria-hidden />
              <span className="font-medium">Run on a schedule</span>
              <span className="ml-auto text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
                {describeNextRun({
                  enabled: scheduleEnabled,
                  hour: scheduleHour,
                  minute: scheduleMinute,
                  days: scheduleDays,
                }) ?? '—'}
              </span>
            </label>
            {scheduleEnabled ? (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Label htmlFor="tpl-sched-hour" className="mb-0">
                    Time
                  </Label>
                  <Input
                    id="tpl-sched-hour"
                    type="number"
                    min={0}
                    max={23}
                    value={scheduleHour}
                    onChange={(e) => setScheduleHour(Number(e.target.value))}
                    className="!w-20"
                  />
                  <span className="text-[var(--color-fg-muted)]">:</span>
                  <Input
                    type="number"
                    min={0}
                    max={59}
                    value={scheduleMinute}
                    onChange={(e) => setScheduleMinute(Number(e.target.value))}
                    className="!w-20"
                  />
                  <span className="text-[var(--text-xs)] text-[var(--color-fg-subtle)]">24-hour, local time</span>
                </div>
                <div>
                  <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mb-1">Days of the week</p>
                  <div className="flex items-center gap-1">
                    {DAY_LABELS.map((label, idx) => {
                      const active = scheduleDays.includes(idx);
                      return (
                        <button
                          key={`${label}-${idx}`}
                          type="button"
                          onClick={() =>
                            setScheduleDays((prev) =>
                              active ? prev.filter((d) => d !== idx) : [...prev, idx].sort((a, b) => a - b),
                            )
                          }
                          aria-pressed={active}
                          title={DAY_FULL[idx]}
                          className={
                            active
                              ? 'h-7 w-7 rounded-full bg-[var(--color-accent)] text-[var(--color-fg-on-accent)] text-[var(--text-xs)] font-medium'
                              : 'h-7 w-7 rounded-full bg-transparent border border-[var(--color-border-subtle)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] text-[var(--text-xs)]'
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                    <span className="ml-2 text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
                      {scheduleDays.length === 5 && [0, 1, 2, 3, 4].every((d) => scheduleDays.includes(d))
                        ? 'Weekdays'
                        : scheduleDays.length === 7
                          ? 'Every day'
                          : `${scheduleDays.length} day${scheduleDays.length === 1 ? '' : 's'}`}
                    </span>
                  </div>
                </div>
                <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] italic">
                  Templates with required parameters are skipped at scheduled time (no one to fill them in).
                </p>
              </div>
            ) : null}
          </div>

          {error ? <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p> : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="md" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" loading={busy}>
              {template ? 'Save changes' : 'Create workflow'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface WorkflowsPanelProps {
  onRanWorkflow?: (template: WorkflowTemplate, runId: string) => void;
}

export function WorkflowsPanel({ onRanWorkflow }: WorkflowsPanelProps = {}) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runTarget, setRunTarget] = useState<WorkflowTemplate | null>(null);
  const [editTarget, setEditTarget] = useState<WorkflowTemplate | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<WorkflowTemplate | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listWorkflows();
      setTemplates(rows.sort((a, b) => (b.run_count ?? 0) - (a.run_count ?? 0)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRan = (template: WorkflowTemplate, runId: string) => {
    void load();
    onRanWorkflow?.(template, runId);
  };

  const onSaved = (_template: WorkflowTemplate) => {
    void load();
  };

  const onDelete = async (template: WorkflowTemplate) => {
    setBusy(true);
    try {
      await deleteWorkflow(template.id);
      setConfirmDelete(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        eyebrow="WORKFLOWS"
        title="Workflow templates"
        description="Save a prompt with {{parameters}} once, run it whenever you need it."
        action={
          <Button
            size="sm"
            variant="primary"
            leading={<Plus size={13} aria-hidden />}
            onClick={() => {
              setEditTarget(null);
              setEditOpen(true);
            }}
          >
            New
          </Button>
        }
      />

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon aria-hidden />}
          title="No workflows yet"
          description="Save a reusable prompt — then one click runs it with the right parameters."
          action={
            <Button
              size="sm"
              variant="primary"
              leading={<Plus size={13} aria-hidden />}
              onClick={() => {
                setEditTarget(null);
                setEditOpen(true);
              }}
            >
              New workflow
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-[var(--color-border-subtle)]">
          {templates.map((tpl) => (
            <li key={tpl.id} className="py-2.5 flex items-start gap-3">
              <div className="h-8 w-8 rounded-[var(--radius-sm)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)] grid place-items-center flex-shrink-0">
                <WorkflowIcon size={14} aria-hidden />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[var(--text-sm)] font-medium text-[var(--color-fg-default)]">{tpl.name}</p>
                  {tpl.task_type ? (
                    <Badge tone="info" size="sm">
                      #{tpl.task_type.replace('_', ' ')}
                    </Badge>
                  ) : null}
                  {tpl.schedule?.enabled ? (
                    <Badge tone="success" size="sm" icon={<Calendar size={10} aria-hidden />}>
                      scheduled
                    </Badge>
                  ) : null}
                  {(tpl.tags ?? []).slice(0, 3).map((t) => (
                    <Badge key={t} tone="neutral" size="sm" icon={<Tag size={10} aria-hidden />}>
                      {t}
                    </Badge>
                  ))}
                  {tpl.is_seed ? (
                    <Badge tone="neutral" size="sm">
                      example
                    </Badge>
                  ) : null}
                </div>
                {tpl.description ? (
                  <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-0.5">
                    {tpl.description}
                  </p>
                ) : null}
                {(tpl.parameters ?? []).length > 0 ? (
                  <p className="text-[10px] font-mono text-[var(--color-fg-subtle)] mt-1">
                    params: {(tpl.parameters ?? []).map((p) => `{{${p.name}}}`).join(' ')}
                  </p>
                ) : null}
                {tpl.last_run_at ? (
                  <p className="text-[10px] text-[var(--color-fg-subtle)] mt-1 inline-flex items-center gap-1">
                    <Hourglass size={10} aria-hidden />
                    {new Date(tpl.last_run_at).toLocaleString()} · {tpl.run_count ?? 0} runs
                  </p>
                ) : null}
                {tpl.schedule?.enabled ? (
                  <p className="text-[10px] text-[var(--color-accent)] mt-1 inline-flex items-center gap-1">
                    <Calendar size={10} aria-hidden />
                    Scheduled · next: {describeNextRun(tpl.schedule) ?? '—'}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <Tooltip content="Run now">
                  <Button
                    size="sm"
                    variant="primary"
                    leading={<Play size={12} aria-hidden />}
                    onClick={() => setRunTarget(tpl)}
                  >
                    Run
                  </Button>
                </Tooltip>
                <Tooltip content="Edit">
                  <button
                    type="button"
                    onClick={() => {
                      setEditTarget(tpl);
                      setEditOpen(true);
                    }}
                    aria-label="Edit workflow"
                    className="h-7 w-7 rounded-[var(--radius-sm)] grid place-items-center text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]"
                  >
                    <Pencil size={12} aria-hidden />
                  </button>
                </Tooltip>
                <Tooltip content="Delete">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(tpl)}
                    aria-label="Delete workflow"
                    className="h-7 w-7 rounded-[var(--radius-sm)] grid place-items-center text-[var(--color-fg-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg-sunken)]"
                  >
                    <Trash2 size={12} aria-hidden />
                  </button>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      )}

      <RunDialog
        template={runTarget}
        open={Boolean(runTarget)}
        onOpenChange={(open) => {
          if (!open) setRunTarget(null);
        }}
        onRan={onRan}
      />
      <EditDialog
        template={editTarget}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={onSaved}
      />

      {confirmDelete ? (
        <Dialog open={Boolean(confirmDelete)} onOpenChange={(open) => !open && setConfirmDelete(null)}>
          <DialogContent
            title={`Delete "${confirmDelete.name}"?`}
            description="This removes the template but keeps any past runs it triggered."
          >
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" size="md" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                loading={busy}
                onClick={() => void onDelete(confirmDelete)}
                leading={<Trash2 size={14} aria-hidden />}
              >
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}

// Small helper exposed for the palette: returns a flat list of "Run: <name>"
// commands so the user can trigger a workflow straight from ⌘K.
export async function loadWorkflowPaletteCommands(
  onRun: (template: WorkflowTemplate) => void,
): Promise<Array<{ id: string; label: string; hint?: string; icon: typeof ChevronRight; run: () => void }>> {
  try {
    const rows = await listWorkflows();
    return rows.slice(0, 20).map((tpl) => ({
      id: `workflow:${tpl.id}`,
      label: `Run workflow · ${tpl.name}`,
      hint: tpl.description || (tpl.parameters ?? []).map((p) => `{{${p.name}}}`).join(' ') || undefined,
      icon: ChevronRight,
      run: () => onRun(tpl),
    }));
  } catch {
    return [];
  }
}
