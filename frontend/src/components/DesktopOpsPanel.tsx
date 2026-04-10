import { useEffect, useState } from 'react';
import {
  createAiInfluencerAction,
  createGmailCalendarAction,
  createSocialPackageAction,
  createWriterDocAction,
  disconnectGoogleOAuth,
  dispatchDesktopSchedules,
  executeDesktopAction,
  getDesktopActions,
  getDesktopBridgeDiagnostics,
  getDesktopBridgeStatus,
  getDesktopSchedulePresets,
  getDesktopSchedules,
  getDesktopStatus,
  openDesktopAction,
  revealDesktopAction,
  runDesktopBridgeCheck,
  startGoogleOAuth,
  testDesktopBridge,
  upsertDesktopSchedule,
} from '../api/client';
import type { DesktopAction, DesktopSchedule, DesktopSchedulePreset, RunDetail } from '../types';

const DEFAULT_DESTINATION_PRESETS: DesktopSchedulePreset[] = [
  { id: 'custom', label: 'Custom', subdir: '' },
  { id: 'briefs', label: 'Briefs', subdir: 'briefs' },
  { id: 'writer_exports', label: 'Writer Exports', subdir: 'writer/exports' },
  { id: 'social_campaigns', label: 'Social Campaigns', subdir: 'social/campaigns' },
  { id: 'inbox_briefs', label: 'Inbox Briefs', subdir: 'gmail/inbox-briefs' },
  { id: 'calendar_ops', label: 'Calendar Ops', subdir: 'gmail/calendar-ops' },
  { id: 'approvals', label: 'Approvals Queue', subdir: 'ops/approvals' },
  { id: 'wellness_checkins', label: 'Wellness Check-ins', subdir: 'wellness/checkins' },
];

const DEFAULT_TEMPLATE_PRESETS: DesktopSchedulePreset[] = [
  { id: 'none', label: 'No Preset', prompt_template: '', content_template: '' },
  { id: 'morning_operator', label: 'Morning Operator Brief', prompt_template: 'Prepare a morning operator brief with inbox priorities, calendar risks, and the next three actions to take.' },
  { id: 'founder_writer', label: 'Founder Writer Export', content_template: '# Founder Export\n\nProduce a concise operator-ready brief with headline, context, risks, and recommended next actions.' },
  { id: 'social_launch', label: 'Social Launch Pack', content_template: 'Build a launch-ready social package with one primary post, two variations, CTA options, and asset handoff notes.' },
  { id: 'reply_drafter', label: 'Reply Draft Suggestions', prompt_template: 'Review the highest-priority inbox threads and draft concise suggested replies with rationale and next steps.' },
  { id: 'wellness_nudge', label: 'Wellness Check-in', prompt_template: 'Prepare a concise wellness check-in with one goal, one habit reminder, one accountability question, and one encouraging note.', content_template: '# Wellness Check-in\n\nShare one concrete wellness goal, one habit reminder, one accountability question, and one motivating prompt for today.' },
];

const WORKFLOW_VALIDATION: Record<string, { recommendedDestinations: string[]; recommendedTemplates: string[]; notes: string[] }> = {
  morning_brief: {
    recommendedDestinations: ['inbox_briefs', 'calendar_ops', 'briefs'],
    recommendedTemplates: ['morning_operator'],
    notes: ['Morning briefs work best with Gmail/Calendar destinations and an operator-style prompt template.'],
  },
  agenda_brief: {
    recommendedDestinations: ['calendar_ops', 'briefs'],
    recommendedTemplates: ['morning_operator'],
    notes: ['Agenda workflows should normally write into calendar-oriented output folders.'],
  },
  inbox_triage: {
    recommendedDestinations: ['inbox_briefs', 'briefs'],
    recommendedTemplates: ['reply_drafter', 'morning_operator'],
    notes: ['Inbox triage should prefer inbox-oriented destinations and a prompt template, not a content template.'],
  },
  draft_reply_suggestions: {
    recommendedDestinations: ['inbox_briefs', 'briefs'],
    recommendedTemplates: ['reply_drafter'],
    notes: ['Reply-drafting schedules need a prompt template; content templates are ignored.'],
  },
  writer_export: {
    recommendedDestinations: ['writer_exports', 'briefs'],
    recommendedTemplates: ['founder_writer'],
    notes: ['Writer exports should generally use a writer destination and a content template.'],
  },
  social_package: {
    recommendedDestinations: ['social_campaigns', 'briefs'],
    recommendedTemplates: ['social_launch'],
    notes: ['Social package schedules should use a social destination and a content template.'],
  },
  wellness_checkin: {
    recommendedDestinations: ['wellness_checkins', 'briefs'],
    recommendedTemplates: ['wellness_nudge'],
    notes: ['Wellness check-ins should normally write to a wellness folder and use a check-in prompt or content template.'],
  },
  wellness_outreach: {
    recommendedDestinations: ['wellness_checkins', 'briefs'],
    recommendedTemplates: ['wellness_nudge'],
    notes: ['Wellness outreach sends the check-in through Nora to opted-in contacts when live mode and channels are configured.'],
  },
};

interface Props {
  runId: string | null;
  run: RunDetail | null;
  editingSchedule?: DesktopSchedule | null;
  onLoadedSchedule?: () => void;
}

export function DesktopOpsPanel({ runId, run, editingSchedule, onLoadedSchedule }: Props) {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [actions, setActions] = useState<DesktopAction[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [bridgeStatus, setBridgeStatus] = useState<Record<string, unknown> | null>(null);
  const [bridgeDiagnostics, setBridgeDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [schedules, setSchedules] = useState<DesktopSchedule[]>([]);
  const [destinationPresets, setDestinationPresets] = useState<DesktopSchedulePreset[]>(DEFAULT_DESTINATION_PRESETS);
  const [templatePresets, setTemplatePresets] = useState<DesktopSchedulePreset[]>(DEFAULT_TEMPLATE_PRESETS);
  const [editingScheduleId, setEditingScheduleId] = useState('');
  const [scheduleName, setScheduleName] = useState('Weekday Morning Brief');
  const [scheduleWorkflow, setScheduleWorkflow] = useState('morning_brief');
  const [scheduleAgent, setScheduleAgent] = useState('coordinator');
  const [scheduleMode, setScheduleMode] = useState<'simulation' | 'live'>('simulation');
  const [scheduleApprovalRequired, setScheduleApprovalRequired] = useState(false);
  const [scheduleOutputPreset, setScheduleOutputPreset] = useState('custom');
  const [scheduleOutputSubdir, setScheduleOutputSubdir] = useState('');
  const [scheduleTemplatePreset, setScheduleTemplatePreset] = useState('none');
  const [schedulePromptTemplate, setSchedulePromptTemplate] = useState('');
  const [scheduleContentTemplate, setScheduleContentTemplate] = useState('');
  const [scheduleCadence, setScheduleCadence] = useState('Weekdays 8:00 AM');
  const [scheduleRrule, setScheduleRrule] = useState('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0');
  const [gmailPrompt, setGmailPrompt] = useState('Review my latest inbox and calendar conflicts, then propose next actions.');
  const [gmailActionType, setGmailActionType] = useState<
    'snapshot' | 'inbox_triage' | 'agenda_brief' | 'conflict_scan' | 'morning_brief' | 'draft_reply_suggestions'
  >('snapshot');
  const googleWorkspace = (status?.google_workspace as Record<string, unknown> | undefined) ?? null;
  const hostBridgeConfigured = Boolean(status?.host_bridge_configured);
  const finderRevealAvailable = Boolean(status?.finder_reveal_available);
  const validation = WORKFLOW_VALIDATION[scheduleWorkflow];
  const scheduleWarnings: string[] = [];
  if (validation) {
    if (scheduleOutputPreset !== 'custom' && !validation.recommendedDestinations.includes(scheduleOutputPreset)) {
      scheduleWarnings.push(`Destination preset "${scheduleOutputPreset}" is unusual for ${scheduleWorkflow}.`);
    }
    if (scheduleTemplatePreset !== 'none' && !validation.recommendedTemplates.includes(scheduleTemplatePreset)) {
      scheduleWarnings.push(`Template preset "${scheduleTemplatePreset}" is unusual for ${scheduleWorkflow}.`);
    }
    if (scheduleWorkflow === 'writer_export' || scheduleWorkflow === 'social_package' || scheduleWorkflow === 'wellness_checkin') {
      if (!scheduleContentTemplate.trim()) scheduleWarnings.push('This workflow relies on a content template for the best result.');
    } else if (!schedulePromptTemplate.trim()) {
      scheduleWarnings.push('This workflow relies on a prompt template for the best result.');
    }
  }

  const refresh = async () => {
    const [statusPayload, actionsPayload, bridgePayload] = await Promise.all([
      getDesktopStatus(),
      getDesktopActions(runId),
      getDesktopBridgeStatus(),
    ]);
    setStatus(statusPayload);
    setActions(actionsPayload.actions);
    setBridgeStatus(bridgePayload);
    getDesktopBridgeDiagnostics().then(setBridgeDiagnostics).catch(() => undefined);
    getDesktopSchedules().then((payload) => setSchedules(payload.schedules)).catch(() => undefined);
    getDesktopSchedulePresets().then((payload) => {
      setDestinationPresets(payload.destination_presets);
      setTemplatePresets(payload.template_presets);
    }).catch(() => undefined);
  };

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : 'Failed to load desktop ops'));
  }, [runId]);

  useEffect(() => {
    if (!editingSchedule) return;
    setEditingScheduleId(editingSchedule.schedule_id);
    setScheduleName(editingSchedule.name);
    setScheduleWorkflow(editingSchedule.workflow_kind);
    setScheduleAgent(editingSchedule.agent_id);
    setScheduleMode(editingSchedule.mode);
    setScheduleApprovalRequired(Boolean(editingSchedule.approval_required));
    setScheduleOutputPreset(editingSchedule.output_preset || 'custom');
    setScheduleOutputSubdir(editingSchedule.output_subdir || '');
    setScheduleTemplatePreset(editingSchedule.template_preset || 'none');
    setSchedulePromptTemplate(editingSchedule.prompt_template || '');
    setScheduleContentTemplate(editingSchedule.content_template || '');
    setScheduleCadence(editingSchedule.cadence_label);
    setScheduleRrule(editingSchedule.rrule);
    onLoadedSchedule?.();
  }, [editingSchedule, onLoadedSchedule]);

  const queueWriterDoc = async () => {
    if (!runId) return;
    setBusy('writer');
    setError('');
    try {
      await createWriterDocAction(runId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue writer doc');
    } finally {
      setBusy('');
    }
  };

  const queueSocialPackage = async () => {
    if (!runId) return;
    setBusy('social');
    setError('');
    try {
      await createSocialPackageAction(runId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue social package');
    } finally {
      setBusy('');
    }
  };

  const queueGmailCalendar = async () => {
    if (!runId) return;
    setBusy('gmail');
    setError('');
    try {
      await createGmailCalendarAction(runId, gmailPrompt, undefined, gmailActionType);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue Gmail/calendar action');
    } finally {
      setBusy('');
    }
  };

  const connectGoogle = async () => {
    setBusy('google-connect');
    setError('');
    try {
      const payload = await startGoogleOAuth();
      window.open(payload.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Google OAuth');
    } finally {
      setBusy('');
    }
  };

  const disconnectGoogle = async () => {
    setBusy('google-disconnect');
    setError('');
    try {
      await disconnectGoogleOAuth();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect Google OAuth');
    } finally {
      setBusy('');
    }
  };

  const queueAiInfluencer = async () => {
    if (!runId) return;
    setBusy('influencer');
    setError('');
    try {
      await createAiInfluencerAction(runId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue AI influencer action');
    } finally {
      setBusy('');
    }
  };

  const runAction = async (actionId: string) => {
    setBusy(actionId);
    setError('');
    try {
      await executeDesktopAction(actionId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute desktop action');
    } finally {
      setBusy('');
    }
  };

  const revealAction = async (actionId: string) => {
    setBusy(`reveal-${actionId}`);
    setError('');
    try {
      await revealDesktopAction(actionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reveal desktop output');
    } finally {
      setBusy('');
    }
  };

  const openAction = async (actionId: string) => {
    setBusy(`open-${actionId}`);
    setError('');
    try {
      await openDesktopAction(actionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open desktop output');
    } finally {
      setBusy('');
    }
  };

  const runBridgeTest = async () => {
    setBusy('bridge-test');
    setError('');
    try {
      await testDesktopBridge();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to test host bridge');
    } finally {
      setBusy('');
    }
  };

  const runBridgeCheck = async (kind: 'finder' | 'word' | 'ai_influencer') => {
    setBusy(`bridge-${kind}`);
    setError('');
    try {
      await runDesktopBridgeCheck(kind);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to run ${kind} bridge check`);
    } finally {
      setBusy('');
    }
  };

  const saveSchedule = async () => {
    setBusy('schedule-save');
    setError('');
    try {
      const payload = await upsertDesktopSchedule({
        schedule_id: editingScheduleId || undefined,
        name: scheduleName,
        workflow_kind: scheduleWorkflow,
        agent_id: scheduleAgent,
        mode: scheduleMode,
        approval_required: scheduleApprovalRequired,
        output_preset: scheduleOutputPreset,
        output_subdir: scheduleOutputSubdir,
        template_preset: scheduleTemplatePreset,
        prompt_template: schedulePromptTemplate,
        content_template: scheduleContentTemplate,
        cadence_label: scheduleCadence,
        rrule: scheduleRrule,
        enabled: true,
        notes: ['Desktop workflow policy only. Connect an automation runner before expecting unattended execution.'],
      });
      setSchedules(payload.schedules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save desktop schedule');
    } finally {
      setBusy('');
    }
  };

  const dispatchSchedulesNow = async () => {
    setBusy('schedule-dispatch');
    setError('');
    try {
      await dispatchDesktopSchedules();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch desktop schedules');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Desktop Ops</h2>
          <p className="muted">Queue local writer and social artifacts, then execute them into host-mounted output folders.</p>
        </div>
      </div>

      <div className="specialist-callout">
        <strong>Desktop Status</strong>
        <p className="muted">
          Host OS: {String(status?.host_os ?? 'unknown')} · Word automation: {String(status?.word_automation_available ?? false)}
        </p>
        <p className="muted">
          Finder reveal: {String(finderRevealAvailable)} · Host bridge: {String(hostBridgeConfigured)}
        </p>
        <p className="muted">
          Google Workspace: {String(googleWorkspace?.enabled ?? false)} · Calendar: {String(googleWorkspace?.calendar_id ?? '')}
        </p>
        {!!googleWorkspace?.token_source && <p className="muted small">Token source: {String(googleWorkspace.token_source)}</p>}
        {!!googleWorkspace?.expires_at && <p className="muted small">Expires at: {String(googleWorkspace.expires_at)}</p>}
        {!!googleWorkspace?.updated_at && <p className="muted small">Last token update: {String(googleWorkspace.updated_at)}</p>}
        {!!googleWorkspace?.granted_scope && <p className="muted small">Granted scope: {String(googleWorkspace.granted_scope)}</p>}
        {'can_refresh' in (googleWorkspace ?? {}) && <p className="muted small">Can refresh: {String(googleWorkspace?.can_refresh)}</p>}
        {Array.isArray(googleWorkspace?.required_scopes) && (
          <p className="muted small">Required scopes: {(googleWorkspace?.required_scopes as string[]).join(', ')}</p>
        )}
        {Array.isArray(googleWorkspace?.supported_actions) && (
          <p className="muted small">Supported actions: {(googleWorkspace?.supported_actions as string[]).join(', ')}</p>
        )}
        {!!googleWorkspace?.connect_hint && <p className="muted small">{String(googleWorkspace.connect_hint)}</p>}
        {!!googleWorkspace?.redirect_uri && <p className="muted small">Redirect URI: {String(googleWorkspace.redirect_uri)}</p>}
        {!!status?.host_bridge_base_url && <p className="muted">Bridge URL: {String(status.host_bridge_base_url)}</p>}
        {bridgeStatus && <p className="muted small">Bridge health: {String(bridgeStatus.reachable ?? false)} · {String(bridgeStatus.detail ?? '')}</p>}
        {bridgeDiagnostics && (
          <div className="bridge-diagnostics">
            {Object.entries((bridgeDiagnostics.checks as Record<string, Record<string, unknown>> | undefined) ?? {}).map(([key, value]) => (
              <div key={key} className="bridge-check-card">
                <strong>{key}</strong>
                <p className="muted small">{String(value.ok ?? false)} · {String(value.detail ?? '')}</p>
                <button type="button" className="ghost-button" onClick={() => void runBridgeCheck(key as 'finder' | 'word' | 'ai_influencer')} disabled={busy === `bridge-${key}`}>
                  {busy === `bridge-${key}` ? 'Testing...' : `Test ${key}`}
                </button>
              </div>
            ))}
          </div>
        )}
        {!!status?.ai_influencer_app_url && <p className="muted">AI Influencer URL: {String(status.ai_influencer_app_url)}</p>}
        {!!status?.ai_influencer_app_name && <p className="muted">AI Influencer App: {String(status.ai_influencer_app_name)}</p>}
        {!!status?.ai_influencer_app_path && <p className="muted">AI Influencer Path: {String(status.ai_influencer_app_path)}</p>}
        <p className="muted">{String(status?.note ?? '')}</p>
        <p className="muted">Output dir: {String(status?.output_dir ?? '')}</p>
        <div className="action-row">
          <button type="button" onClick={() => void connectGoogle()} disabled={busy === 'google-connect' || !googleWorkspace?.oauth_configured}>
            {busy === 'google-connect' ? 'Starting...' : 'Connect Google Workspace'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void disconnectGoogle()} disabled={busy === 'google-disconnect' || !googleWorkspace?.connected}>
            {busy === 'google-disconnect' ? 'Disconnecting...' : 'Disconnect Google'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void runBridgeTest()} disabled={busy === 'bridge-test'}>
            {busy === 'bridge-test' ? 'Testing...' : 'Test Host Bridge'}
          </button>
        </div>
      </div>

      <div className="action-row">
        <button type="button" onClick={() => void queueWriterDoc()} disabled={!runId || busy === 'writer' || !run?.output}>
          {busy === 'writer' ? 'Queueing...' : 'Queue Writer Doc'}
        </button>
        <button type="button" onClick={() => void queueSocialPackage()} disabled={!runId || busy === 'social' || !run?.output}>
          {busy === 'social' ? 'Queueing...' : 'Queue Social Package'}
        </button>
        <button type="button" onClick={() => void queueAiInfluencer()} disabled={!runId || busy === 'influencer' || !run?.output}>
          {busy === 'influencer' ? 'Queueing...' : 'Queue AI Influencer'}
        </button>
      </div>

      <div className="specialist-callout">
        <strong>Scheduled Desktop Workflows</strong>
        <p className="muted">Persist cadence policies for proactive desktop and coach workflows, including inbox briefs, exports, social packages, and wellness check-ins.</p>
        <div className="desktop-history-filters">
          <label>
            Name
            <input value={scheduleName} onChange={(e) => setScheduleName(e.target.value)} />
          </label>
          <label>
            Workflow
            <select value={scheduleWorkflow} onChange={(e) => setScheduleWorkflow(e.target.value)}>
              <option value="morning_brief">Morning Brief</option>
              <option value="agenda_brief">Agenda Brief</option>
              <option value="inbox_triage">Inbox Triage</option>
              <option value="draft_reply_suggestions">Draft Reply Suggestions</option>
              <option value="writer_export">Writer Export</option>
              <option value="social_package">Social Package</option>
              <option value="wellness_checkin">Wellness Check-in</option>
              <option value="wellness_outreach">Wellness Outreach</option>
            </select>
          </label>
          <label>
            Owner
            <select value={scheduleAgent} onChange={(e) => setScheduleAgent(e.target.value)}>
              <option value="coordinator">coordinator</option>
              <option value="researcher">researcher</option>
              <option value="writer">writer</option>
              <option value="wellness">wellness</option>
            </select>
          </label>
          <label>
            Mode
            <select value={scheduleMode} onChange={(e) => setScheduleMode(e.target.value as 'simulation' | 'live')}>
              <option value="simulation">simulation</option>
              <option value="live">live</option>
            </select>
          </label>
          <label>
            Cadence Label
            <input value={scheduleCadence} onChange={(e) => setScheduleCadence(e.target.value)} />
          </label>
          <label>
            RRULE
            <input value={scheduleRrule} onChange={(e) => setScheduleRrule(e.target.value)} />
          </label>
          <label>
            Destination Preset
            <select
              value={scheduleOutputPreset}
              onChange={(e) => {
                const next = e.target.value;
                setScheduleOutputPreset(next);
                const preset = destinationPresets.find((item) => item.id === next);
                if (preset && next !== 'custom') setScheduleOutputSubdir(preset.subdir ?? '');
              }}
            >
              {destinationPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </label>
          <label>
            Output Subdir
            <input value={scheduleOutputSubdir} onChange={(e) => setScheduleOutputSubdir(e.target.value)} placeholder="optional/custom-folder" />
          </label>
          <label>
            Template Preset
            <select
              value={scheduleTemplatePreset}
              onChange={(e) => {
                const next = e.target.value;
                setScheduleTemplatePreset(next);
                const preset = templatePresets.find((item) => item.id === next);
                if (preset) {
                  setSchedulePromptTemplate(preset.prompt_template ?? '');
                  setScheduleContentTemplate(preset.content_template ?? '');
                }
              }}
            >
              {templatePresets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </select>
          </label>
          <label>
            Prompt Template
            <input value={schedulePromptTemplate} onChange={(e) => setSchedulePromptTemplate(e.target.value)} placeholder="used for Gmail/calendar schedules" />
          </label>
          <label>
            Content Template
            <input value={scheduleContentTemplate} onChange={(e) => setScheduleContentTemplate(e.target.value)} placeholder="used for writer/social schedules" />
          </label>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={scheduleApprovalRequired} onChange={(e) => setScheduleApprovalRequired(e.target.checked)} />
          Require approval before live execution
        </label>
        <div className="action-row">
          <button type="button" onClick={() => void saveSchedule()} disabled={busy === 'schedule-save'}>
            {busy === 'schedule-save' ? 'Saving...' : editingScheduleId ? 'Update Schedule Policy' : 'Save Schedule Policy'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void dispatchSchedulesNow()} disabled={busy === 'schedule-dispatch'}>
            {busy === 'schedule-dispatch' ? 'Dispatching...' : 'Dispatch Due Schedules'}
          </button>
        </div>
        {validation && (
          <div className="specialist-callout">
            <strong>Workflow Fit</strong>
            {validation.notes.map((note) => (
              <p key={note} className="muted small">{note}</p>
            ))}
            {scheduleWarnings.length > 0 ? (
              <ul className="compact-bullets">
                {scheduleWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Current destination and template selections fit this workflow.</p>
            )}
          </div>
        )}
        <ul className="compact-bullets">
          {schedules.length === 0 && <li>No desktop workflow policies saved yet.</li>}
          {schedules.map((schedule) => (
            <li key={schedule.schedule_id}>
              {schedule.name} · {schedule.workflow_kind} · {schedule.mode} · {schedule.cadence_label} · {schedule.enabled ? 'enabled' : 'disabled'}
              {schedule.last_run_status ? ` · last ${schedule.last_run_status}` : ''}
              {schedule.last_run_at ? ` · ${new Date(schedule.last_run_at).toLocaleString()}` : ''}
              {(schedule.success_count || schedule.failure_count) ? ` · ok ${schedule.success_count ?? 0} / fail ${schedule.failure_count ?? 0}` : ''}
              {schedule.approval_required ? ' · approval gate' : ''}
              {schedule.output_preset ? ` · preset ${schedule.output_preset}` : ''}
              {schedule.output_subdir ? ` · folder ${schedule.output_subdir}` : ''}
              {schedule.template_preset ? ` · template ${schedule.template_preset}` : ''}
              {schedule.prompt_template ? ' · prompt template' : ''}
              {schedule.content_template ? ' · content template' : ''}
              {schedule.last_error ? ` · error: ${schedule.last_error}` : ''}
            </li>
          ))}
        </ul>
      </div>

      <label>
        Gmail / Calendar Prompt
        <textarea value={gmailPrompt} onChange={(e) => setGmailPrompt(e.target.value)} rows={3} />
      </label>
      <label>
        Gmail / Calendar Action
        <select value={gmailActionType} onChange={(e) => setGmailActionType(e.target.value as typeof gmailActionType)}>
          <option value="snapshot">Snapshot</option>
          <option value="inbox_triage">Inbox Triage</option>
          <option value="agenda_brief">Agenda Brief</option>
          <option value="conflict_scan">Conflict Scan</option>
          <option value="morning_brief">Morning Brief</option>
          <option value="draft_reply_suggestions">Draft Reply Suggestions</option>
        </select>
      </label>
      <div className="action-row">
        <button type="button" onClick={() => void queueGmailCalendar()} disabled={!runId || busy === 'gmail'}>
          {busy === 'gmail' ? 'Queueing...' : 'Queue Gmail / Calendar'}
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setGmailActionType('inbox_triage');
            setGmailPrompt('Review the most important inbox threads from the last week and suggest what needs attention first.');
          }}
        >
          Inbox Triage Preset
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setGmailActionType('agenda_brief');
            setGmailPrompt('Prepare a concise brief for my next few calendar items and anything I should prep in advance.');
          }}
        >
          Agenda Brief Preset
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setGmailActionType('conflict_scan');
            setGmailPrompt('Scan the upcoming calendar for overlaps or scheduling conflicts and summarize the issues.');
          }}
        >
          Conflict Scan Preset
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setGmailActionType('morning_brief');
            setGmailPrompt('Create a morning brief that combines inbox priorities, upcoming calendar items, and any conflicts I should resolve first.');
          }}
        >
          Morning Brief Preset
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setGmailActionType('draft_reply_suggestions');
            setGmailPrompt('Review recent inbox threads and suggest concise draft replies with the right next step for each.');
          }}
        >
          Draft Reply Preset
        </button>
      </div>

      {error && <p className="muted">{error}</p>}

      <div className="approval-list">
        {actions.length === 0 ? (
          <p className="muted">No desktop actions queued for this run yet.</p>
        ) : (
          actions.map((action) => (
            <article key={action.action_id} className="approval-card">
              <div className="approval-head">
                <strong>{action.title}</strong>
                <span className={`trust-pill ${action.status === 'completed' ? 'high' : action.status === 'blocked' ? 'caution' : 'medium'}`}>
                  {action.status}
                </span>
              </div>
              <p className="muted small">{action.kind} · {action.agent_id}</p>
              {action.output_path && <p className="approval-copy">{action.output_path}</p>}
              {action.executed_at && <p className="muted small">Executed: {action.executed_at}</p>}
              {action.last_execution_method && <p className="muted small">Method: {action.last_execution_method}</p>}
              {action.last_error && <p className="muted small">Last error: {action.last_error}</p>}
              <ul className="compact-bullets">
                {action.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
              {action.execution_history.length > 0 && (
                <details>
                  <summary className="muted small">Execution History</summary>
                  <ul className="compact-bullets">
                    {action.execution_history.map((entry, idx) => (
                      <li key={`${action.action_id}-${idx}`}>
                        {String(entry.ts ?? '')} · {String(entry.event ?? '')} · {String(entry.status ?? '')} · {String(entry.method ?? '')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {action.status === 'queued' && (
                <div className="action-row">
                  <button type="button" onClick={() => void runAction(action.action_id)} disabled={busy === action.action_id}>
                    {busy === action.action_id ? 'Running...' : 'Execute'}
                  </button>
                </div>
              )}
              {action.status === 'completed' && action.output_path && (
                <div className="action-row">
                  <button type="button" className="ghost-button" onClick={() => void openAction(action.action_id)} disabled={busy === `open-${action.action_id}`}>
                    {busy === `open-${action.action_id}` ? 'Opening...' : 'Open Output'}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => void revealAction(action.action_id)} disabled={busy === `reveal-${action.action_id}`}>
                    {busy === `reveal-${action.action_id}` ? 'Revealing...' : 'Reveal In Finder'}
                  </button>
                  {!finderRevealAvailable && <span className="muted small">Configure the macOS host bridge to reveal files from the container runtime.</span>}
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
