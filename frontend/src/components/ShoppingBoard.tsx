import { useEffect, useState } from 'react';
import { getApprovals, getShoppingSummary, queueShoppingLead, resolveApproval } from '../api/client';
import type { ApprovalItem, RunDetail, RunMode, ShoppingSummaryResponse } from '../types';

interface Props {
  runId: string | null;
  run: RunDetail | null;
}

function trustLabel(score: number) {
  if (score >= 90) return 'high';
  if (score >= 75) return 'solid';
  if (score >= 60) return 'medium';
  return 'caution';
}

export function ShoppingBoard({ runId, run }: Props) {
  const [summary, setSummary] = useState<ShoppingSummaryResponse | null>(null);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<string>('');

  useEffect(() => {
    if (!runId || run?.state?.task_type !== 'shopping') {
      setSummary(null);
      setApprovals([]);
      setError('');
      return;
    }
    const load = async () => {
      try {
        const [shopping, approvalPayload] = await Promise.all([getShoppingSummary(runId), getApprovals(runId)]);
        setSummary(shopping);
        setApprovals(approvalPayload.approvals.filter((item) => item.kind === 'shopping_lead'));
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load shopping board');
      }
    };
    void load();
  }, [runId, run?.state]);

  const handleQueue = async (source: ShoppingSummaryResponse['sources'][number]) => {
    if (!runId) return;
    setBusy(source.url);
    try {
      const payload = await queueShoppingLead(runId, {
        url: source.url,
        title: source.title,
        domain: source.domain,
      });
      setApprovals(payload.approvals.filter((item: ApprovalItem) => item.kind === 'shopping_lead'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue shopping lead');
    } finally {
      setBusy('');
    }
  };

  const handleResolve = async (approvalId: string, action: 'approve' | 'reject') => {
    if (!runId) return;
    setBusy(approvalId);
    try {
      const payload = await resolveApproval(runId, approvalId, {
        action,
        mode: (run?.mode ?? 'live') as RunMode,
      });
      setApprovals(payload.approvals.filter((item: ApprovalItem) => item.kind === 'shopping_lead'));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} shopping lead`);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Shopping Board</h2>
          <p className="muted">Ranked live sources, trust scoring, and buying-risk guidance for private shopper runs.</p>
        </div>
      </div>

      {!runId || run?.state?.task_type !== 'shopping' ? (
        <p className="muted">Run a Private Shopper mission to populate this board.</p>
      ) : error ? (
        <p className="muted">{error}</p>
      ) : !summary ? (
        <p className="muted">Loading shopping summary...</p>
      ) : (
        <>
          <div className="specialist-callout">
            <strong>Trust Notes</strong>
            <ul className="compact-bullets">
              {summary.trust_notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </div>
          <div className="specialist-callout">
            <strong>Approval Queue</strong>
            {approvals.length === 0 ? (
              <p className="muted">No shopping leads queued yet.</p>
            ) : (
              <div className="approval-list">
                {approvals.map((item) => (
                  <article key={item.approval_id} className="approval-card">
                    <div className="approval-head">
                      <strong>{item.title}</strong>
                      <span className={`trust-pill ${item.status === 'approved' ? 'high' : item.status === 'rejected' ? 'caution' : 'medium'}`}>
                        {item.status}
                      </span>
                    </div>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noreferrer">
                        Review source
                      </a>
                    )}
                    <ul className="compact-bullets">
                      {item.notes.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                    {item.status === 'queued' && (
                      <div className="action-row">
                        <button type="button" onClick={() => void handleResolve(item.approval_id, 'approve')} disabled={busy === item.approval_id}>
                          Approve Lead
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
          <div className="shopping-grid">
            {summary.sources.map((source) => (
              <article key={source.url} className="shopping-card">
                <div className="shopping-card-head">
                  <strong>{source.domain}</strong>
                  <span className={`trust-pill ${trustLabel(source.trust_score)}`}>trust {source.trust_score}</span>
                </div>
                <p>{source.title}</p>
                <div className="shopping-meta">
                  <span>{source.marketplace_type ?? 'source'}</span>
                  <span>{source.price_signal ?? 'signal n/a'}</span>
                </div>
                <div className="action-row">
                  <a href={source.url} target="_blank" rel="noreferrer">
                    Open source
                  </a>
                  <button type="button" onClick={() => void handleQueue(source)} disabled={busy === source.url}>
                    {busy === source.url ? 'Queueing...' : 'Queue lead'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
