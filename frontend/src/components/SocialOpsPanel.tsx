import { useEffect, useMemo, useState } from 'react';
import { getSocialSummary, queueSocialPost, resolveApproval } from '../api/client';
import type { ApprovalItem, RunDetail, RunMode, SocialSummaryResponse } from '../types';

interface Props {
  runId: string | null;
  run: RunDetail | null;
}

export function SocialOpsPanel({ runId, run }: Props) {
  const [summary, setSummary] = useState<SocialSummaryResponse | null>(null);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<string>('');
  const [operatorNote, setOperatorNote] = useState<string>('');

  useEffect(() => {
    if (!runId || run?.state?.task_type !== 'social_media') {
      setSummary(null);
      setError('');
      return;
    }
    const load = async () => {
      try {
        setSummary(await getSocialSummary(runId));
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load social ops');
      }
    };
    void load();
  }, [runId, run?.state]);

  const draftMessage = useMemo(() => String(run?.output ?? '').slice(0, 260), [run?.output]);

  const handleQueue = async (platform: string) => {
    if (!runId) return;
    setBusy(platform);
    setOperatorNote('');
    try {
      const payload = await queueSocialPost(runId, { platform, message: draftMessage });
      setSummary((current) => current ? { ...current, approvals: payload.approvals.filter((item: ApprovalItem) => item.kind === 'social_post') } : current);
      setOperatorNote(`${platform} post queued for approval`);
    } catch (err) {
      setOperatorNote(err instanceof Error ? err.message : `Failed to queue ${platform} post`);
    } finally {
      setBusy('');
    }
  };

  const handleResolve = async (approvalId: string, action: 'approve' | 'reject') => {
    if (!runId) return;
    setBusy(approvalId);
    setOperatorNote('');
    try {
      const payload = await resolveApproval(runId, approvalId, {
        action,
        mode: (run?.mode ?? 'simulation') as RunMode,
      });
      setSummary((current) => current ? { ...current, approvals: payload.approvals.filter((item: ApprovalItem) => item.kind === 'social_post') } : current);
      setOperatorNote(action === 'approve' ? 'Approval applied' : 'Queued post rejected');
    } catch (err) {
      setOperatorNote(err instanceof Error ? err.message : `Failed to ${action} queued post`);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Social Ops</h2>
          <p className="muted">Channel-by-channel strategy, scheduling guidance, and safe publish actions for social manager runs.</p>
        </div>
      </div>

      {!runId || run?.state?.task_type !== 'social_media' ? (
        <p className="muted">Run a Social Manager mission to populate this panel.</p>
      ) : error ? (
        <p className="muted">{error}</p>
      ) : !summary ? (
        <p className="muted">Loading social ops...</p>
      ) : (
        <>
          <div className="specialist-callout">
            <strong>Scheduling Guidance</strong>
            <ul className="compact-bullets">
              {summary.scheduling_notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </div>
          <div className="specialist-callout">
            <strong>Approval Queue</strong>
            {summary.approvals.length === 0 ? (
              <p className="muted">No social posts queued yet.</p>
            ) : (
              <div className="approval-list">
                {summary.approvals.map((item) => (
                  <article key={item.approval_id} className="approval-card">
                    <div className="approval-head">
                      <strong>{item.title}</strong>
                      <span className={`trust-pill ${item.status === 'approved' ? 'high' : item.status === 'rejected' ? 'caution' : 'medium'}`}>
                        {item.executed ? 'published' : item.status}
                      </span>
                    </div>
                    {item.message && <p className="approval-copy">{item.message}</p>}
                    <ul className="compact-bullets">
                      {item.notes.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                    {item.status === 'queued' && (
                      <div className="action-row">
                        <button type="button" onClick={() => void handleResolve(item.approval_id, 'approve')} disabled={busy === item.approval_id}>
                          Approve{run?.mode === 'live' ? ' And Publish' : ''}
                        </button>
                        <button type="button" className="ghost-button" onClick={() => void handleResolve(item.approval_id, 'reject')} disabled={busy === item.approval_id}>
                          Reject
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
          <div className="social-grid">
            {summary.platforms.map((platform) => (
              <article key={platform.platform} className="social-card">
                <div className="shopping-card-head">
                  <strong>{platform.platform}</strong>
                  <span className={platform.live_ready ? 'trust-pill solid' : 'trust-pill caution'}>
                    {platform.live_ready ? 'live ready' : 'simulated'}
                  </span>
                </div>
                <ul className="compact-bullets">
                  {platform.notes.map((note) => <li key={note}>{note}</li>)}
                </ul>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy === platform.platform}
                  onClick={() => void handleQueue(platform.platform)}
                >
                  {busy === platform.platform ? 'Queueing...' : `Queue ${platform.platform} Post`}
                </button>
              </article>
            ))}
          </div>
          {operatorNote && <p className="muted">{operatorNote}</p>}
        </>
      )}
    </section>
  );
}
