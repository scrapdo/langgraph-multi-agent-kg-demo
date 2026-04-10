import { useEffect, useState } from 'react';
import {
  approveDesktopSchedule,
  cloneDesktopSchedule,
  deleteDesktopSchedule,
  dispatchDesktopSchedules,
  getDesktopSchedules,
  pauseDesktopSchedule,
  rejectDesktopSchedule,
  resumeDesktopSchedule,
} from '../api/client';
import type { DesktopSchedule } from '../types';

interface Props {
  onEditSchedule?: (schedule: DesktopSchedule) => void;
}

export function DesktopScheduleHistoryPanel({ onEditSchedule }: Props) {
  const [schedules, setSchedules] = useState<DesktopSchedule[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = async () => {
    const payload = await getDesktopSchedules();
    setSchedules(payload.schedules);
  };

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : 'Failed to load schedule history'));
  }, []);

  const dispatchNow = async () => {
    setBusy('dispatch');
    setError('');
    try {
      await dispatchDesktopSchedules();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dispatch schedules');
    } finally {
      setBusy('');
    }
  };

  const approveNow = async (scheduleId: string) => {
    setBusy(scheduleId);
    setError('');
    try {
      await approveDesktopSchedule(scheduleId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve scheduled run');
    } finally {
      setBusy('');
    }
  };

  const rejectNow = async (scheduleId: string) => {
    setBusy(`reject-${scheduleId}`);
    setError('');
    try {
      await rejectDesktopSchedule(scheduleId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject scheduled run');
    } finally {
      setBusy('');
    }
  };

  const cloneNow = async (scheduleId: string) => {
    setBusy(`clone-${scheduleId}`);
    setError('');
    try {
      await cloneDesktopSchedule(scheduleId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clone schedule');
    } finally {
      setBusy('');
    }
  };

  const toggleEnabled = async (scheduleId: string, enabled: boolean) => {
    setBusy(`${enabled ? 'pause' : 'resume'}-${scheduleId}`);
    setError('');
    try {
      if (enabled) {
        await pauseDesktopSchedule(scheduleId);
      } else {
        await resumeDesktopSchedule(scheduleId);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${enabled ? 'pause' : 'resume'} schedule`);
    } finally {
      setBusy('');
    }
  };

  const deleteNow = async (scheduleId: string) => {
    setBusy(`delete-${scheduleId}`);
    setError('');
    try {
      await deleteDesktopSchedule(scheduleId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete schedule');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Schedule History</h2>
          <p className="muted">Review desktop workflow cadence, latest run state, counters, and approval behavior in one place.</p>
        </div>
        <button type="button" onClick={() => void dispatchNow()} disabled={busy === 'dispatch'}>
          {busy === 'dispatch' ? 'Dispatching...' : 'Dispatch Due Schedules'}
        </button>
      </div>
      {error && <p className="muted">{error}</p>}
      <div className="approval-list">
        {schedules.length === 0 ? (
          <p className="muted">No desktop schedules saved yet.</p>
        ) : (
          schedules.map((schedule) => (
            <article key={schedule.schedule_id} className="approval-card">
              <div className="approval-head">
                <strong>{schedule.name}</strong>
                <span className={`trust-pill ${schedule.last_run_status === 'completed' ? 'high' : schedule.last_run_status === 'failed' ? 'caution' : 'medium'}`}>
                  {schedule.last_run_status || 'idle'}
                </span>
              </div>
              <p className="muted small">{schedule.workflow_kind} · {schedule.agent_id} · {schedule.mode}</p>
              <p className="muted small">{schedule.cadence_label}</p>
              <p className="muted small">Approval required: {String(schedule.approval_required)}</p>
              {schedule.output_preset && <p className="muted small">Destination preset: {schedule.output_preset}</p>}
              {schedule.output_subdir && <p className="muted small">Output subdir: {schedule.output_subdir}</p>}
              {schedule.template_preset && <p className="muted small">Template preset: {schedule.template_preset}</p>}
              {schedule.prompt_template && <p className="muted small">Prompt template: {schedule.prompt_template}</p>}
              {schedule.content_template && <p className="muted small">Content template: {schedule.content_template}</p>}
              {schedule.last_run_at && <p className="muted small">Last run: {new Date(schedule.last_run_at).toLocaleString()}</p>}
              {schedule.next_run_at && <p className="muted small">Next run: {new Date(schedule.next_run_at).toLocaleString()}</p>}
              <p className="muted small">Success: {schedule.success_count ?? 0} · Failure: {schedule.failure_count ?? 0}</p>
              {schedule.last_run_id && <p className="muted small">Last run id: {schedule.last_run_id}</p>}
              {schedule.last_action_id && <p className="muted small">Last action id: {schedule.last_action_id}</p>}
              {schedule.last_error && <p className="muted small">Last error: {schedule.last_error}</p>}
              <div className="action-row">
                <button type="button" className="ghost-button" onClick={() => onEditSchedule?.(schedule)}>
                  Edit
                </button>
                <button type="button" className="ghost-button" onClick={() => void cloneNow(schedule.schedule_id)} disabled={busy === `clone-${schedule.schedule_id}`}>
                  {busy === `clone-${schedule.schedule_id}` ? 'Cloning...' : 'Clone'}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void toggleEnabled(schedule.schedule_id, schedule.enabled)}
                  disabled={busy === `${schedule.enabled ? 'pause' : 'resume'}-${schedule.schedule_id}`}
                >
                  {busy === `${schedule.enabled ? 'pause' : 'resume'}-${schedule.schedule_id}`
                    ? (schedule.enabled ? 'Pausing...' : 'Resuming...')
                    : (schedule.enabled ? 'Pause' : 'Resume')}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => void deleteNow(schedule.schedule_id)}
                  disabled={busy === `delete-${schedule.schedule_id}`}
                >
                  {busy === `delete-${schedule.schedule_id}` ? 'Deleting...' : 'Delete'}
                </button>
              </div>
              {schedule.last_run_status === 'awaiting_approval' && (
                <div className="action-row">
                  <button type="button" onClick={() => void approveNow(schedule.schedule_id)} disabled={busy === schedule.schedule_id}>
                    {busy === schedule.schedule_id ? 'Approving...' : 'Approve And Execute'}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => void rejectNow(schedule.schedule_id)} disabled={busy === `reject-${schedule.schedule_id}`}>
                    {busy === `reject-${schedule.schedule_id}` ? 'Rejecting...' : 'Reject'}
                  </button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
