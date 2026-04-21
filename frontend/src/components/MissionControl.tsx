import {
  ArrowUp,
  BookmarkPlus,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clipboard,
  Copy,
  Download,
  FileText,
  History,
  Info,
  Link as LinkIcon,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Sparkles,
  StickyNote,
  Sun,
  User,
  UserPen,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  describeImage,
  getRun,
  listRuns,
  processDocument,
  startRun,
  streamEvents,
  type RunSummary,
  type TaskTypeOverride,
} from '../api/client';
import {
  applyProfileProposals,
  dispatchQuickAction,
  extractFactsFromTurn,
  getUserProfile,
  rememberFact,
  type FactProposal,
  type QuickActionTarget,
} from '../api/profile';
import { getBriefContext } from '../api/workspace';
import { useVoiceInput } from '../lib/useVoiceInput';
import type { RunDetail, RunMode } from '../types';
import { Badge, Button, Card, StatusDot, Tooltip } from '../ui';
import { cn } from '../ui/cn';
import { ProfileDialog } from './ProfileDialog';
import { WhyDialog } from './WhyDialog';

type MessageRole = 'user' | 'assistant' | 'system';

interface AgentStep {
  agent: string;
  node: string;
  status: string;
  detail: string;
  ts: string;
}

interface Attachment {
  id: string;
  label: string;
  preview: string;
  kind: 'file' | 'url';
}

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** How many characters of `content` should currently be shown (for the typing effect). */
  revealed?: number;
  timestamp: string;
  runId?: string;
  status?: RunDetail['status'];
  steps?: AgentStep[];
  mode?: RunMode;
  channel?: ChannelId;
  attachments?: Attachment[];
  tokens?: number;
  elapsedMs?: number;
  /** User-visible text for "I learned …" auto-extracted proposal cards. */
  factProposal?: FactProposal;
  /** If the operator has already actioned the proposal, remember for UI. */
  factProposalResolved?: 'saved' | 'dismissed';
  /** True once real tokens have been streamed in so the client-side reveal animation is skipped. */
  streamedLive?: boolean;
}

type ChannelId = 'auto' | 'research' | 'writing' | 'secretary' | 'coding' | 'social' | 'wellness';

interface ChannelDef {
  id: ChannelId;
  label: string;
  hint: string;
  prefix?: string;
  conservative?: boolean;
  /** When set, the backend's coordinator skips task-type detection and routes
   *  directly to this specialist's workflow. */
  taskType?: TaskTypeOverride;
}

const CHANNELS: ChannelDef[] = [
  { id: 'auto', label: 'Auto', hint: 'Let the coordinator pick the right specialist.' },
  { id: 'research', label: 'Research', hint: 'Web + memory research, citations, writeups.', prefix: 'Research:', taskType: 'market_research' },
  { id: 'writing', label: 'Writing', hint: 'Long-form drafting with a writer focus.', prefix: 'Write:' },
  { id: 'secretary', label: 'Secretary', hint: 'Nora — outbound calls, texts, emails, bookings.', prefix: 'Secretary:', conservative: true, taskType: 'secretary' },
  { id: 'coding', label: 'Coding', hint: 'Chad — generate or refactor code.', prefix: 'Coding:', conservative: true },
  { id: 'social', label: 'Social', hint: 'Content and publishing workflows.', prefix: 'Social:', conservative: true, taskType: 'social_media' },
  { id: 'wellness', label: 'Wellness', hint: 'Coach — habits, recovery, motivation.', prefix: 'Wellness:', conservative: true, taskType: 'wellness_coaching' },
];

const CHANNEL_STORAGE_KEY = 'kg-demo-channel';
const BRIEF_STORAGE_KEY = 'kg-demo-last-brief';

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  {
    label: 'Morning brief',
    prompt: "Give me a briefing for today — top 3 priorities, anything time-sensitive, and one thing I shouldn't forget.",
  },
  { label: 'Research', prompt: 'Research the trade-offs between Postgres vs. SQLite for a local-first desktop app.' },
  { label: 'Write', prompt: 'Draft a concise update email summarising what I shipped this week.' },
  { label: 'Plan', prompt: 'Help me plan the next two hours — I want to ship one meaningful thing.' },
];

interface Props {
  onRunChange: (runId: string | null, run: RunDetail | null) => void;
  onEnterVoiceMode?: () => void;
}

function uuid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function niceStatusLabel(status?: RunDetail['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Thinking…';
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'degraded':
      return 'Recovered';
    default:
      return '';
  }
}

function statusTone(status?: RunDetail['status']): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'running':
    case 'queued':
      return 'accent';
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'degraded':
      return 'warning';
    default:
      return 'neutral';
  }
}

function agentSummary(steps: AgentStep[]): string {
  const seen = new Set<string>();
  for (const s of steps) if (s.agent && !seen.has(s.agent)) seen.add(s.agent);
  return Array.from(seen).join(' → ');
}

function extractOutput(run: RunDetail | null): string {
  if (!run) return '';
  if (run.output && run.output.trim()) return run.output.trim();
  const state = (run.state ?? {}) as Record<string, unknown>;
  for (const key of ['final_answer', 'final_response', 'answer', 'output', 'response']) {
    const value = state[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const events = Array.isArray(state.events) ? (state.events as Array<Record<string, unknown>>) : [];
  const writerEvents = events.filter(
    (e) => String(e.node ?? '').toLowerCase().includes('writer') && String(e.status ?? '').toLowerCase() === 'complete',
  );
  if (writerEvents.length > 0) {
    const last = writerEvents[writerEvents.length - 1];
    const detail = String(last.detail ?? '').trim();
    if (detail) return detail;
  }
  return '';
}

function Avatar({ role }: { role: MessageRole }) {
  if (role === 'user') {
    return (
      <div className="h-7 w-7 rounded-full bg-[var(--color-accent-subtle)] text-[var(--color-accent)] grid place-items-center flex-shrink-0" aria-hidden>
        <User size={14} />
      </div>
    );
  }
  if (role === 'system') {
    return (
      <div className="h-7 w-7 rounded-full bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] grid place-items-center flex-shrink-0" aria-hidden>
        <Sparkles size={14} />
      </div>
    );
  }
  return (
    <div className="h-7 w-7 rounded-full bg-gradient-to-br from-[var(--color-accent-subtle)] to-[var(--color-bg-elevated)] text-[var(--color-accent)] grid place-items-center flex-shrink-0 border border-[var(--color-border-accent)]" aria-hidden>
      <Bot size={14} />
    </div>
  );
}

function AgentStepsRow({ steps }: { steps: AgentStep[] }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  return (
    <div className="mt-2 text-[var(--text-xs)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-default)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] rounded-[var(--radius-sm)] px-1 py-0.5"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <span className="font-mono">
          {steps.length} step{steps.length === 1 ? '' : 's'} · {agentSummary(steps)}
        </span>
      </button>
      {open ? (
        <ol className="mt-2 space-y-1 pl-4 border-l border-[var(--color-border-subtle)]">
          {steps.map((step, idx) => (
            <li key={`${step.ts}-${idx}`} className="flex items-baseline gap-2 text-[var(--color-fg-muted)] font-mono leading-snug">
              <span className="text-[var(--color-fg-subtle)]">
                {new Date(step.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="text-[var(--color-fg-default)]">{step.agent}</span>
              <span>·</span>
              <span>{step.status}</span>
              {step.detail ? <span className="truncate">· {step.detail}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function QuickActions({
  content,
  onFollowup,
}: {
  content: string;
  onFollowup: (prompt: string, context: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const save = useCallback(
    async (target: QuickActionTarget) => {
      setBusy(`save:${target}`);
      setConfirm(null);
      try {
        const firstLine = content.split('\n').find((l) => l.trim()) ?? 'Untitled';
        const result = await dispatchQuickAction({
          action: 'note',
          title: firstLine.slice(0, 60),
          content,
          target,
        });
        if (target === 'clipboard' && typeof result.body === 'string') {
          try {
            await navigator.clipboard.writeText(result.body);
            setConfirm('Copied to clipboard');
          } catch {
            setConfirm('Clipboard blocked by browser');
          }
        } else if (target === 'obsidian' && typeof result.uri === 'string') {
          window.open(result.uri, '_blank');
          setConfirm('Opening Obsidian…');
        } else if (target === 'desktop' && typeof result.path === 'string') {
          setConfirm(`Saved to ${String(result.path)}`);
        } else {
          setConfirm('Saved');
        }
      } catch (err) {
        setConfirm(err instanceof Error ? err.message : 'Save failed');
      } finally {
        setBusy(null);
        window.setTimeout(() => setConfirm(null), 3500);
      }
    },
    [content],
  );

  const refine = useCallback(() => {
    onFollowup('Take the previous answer and make it shorter and more actionable.', content);
  }, [content, onFollowup]);

  const expand = useCallback(() => {
    onFollowup('Expand the previous answer into a detailed plan with concrete next steps.', content);
  }, [content, onFollowup]);

  const emailDraft = useCallback(() => {
    onFollowup('Draft this as a clean email I can send. Subject + body. No preamble.', content);
  }, [content, onFollowup]);

  if (!content) return null;
  const btn =
    'inline-flex items-center gap-1 h-6 px-2 rounded-[var(--radius-pill)] bg-[var(--color-bg-sunken)] hover:bg-[var(--color-bg-elevated)] border border-[var(--color-border-subtle)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-50';
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5 text-[var(--text-xs)]">
      <button type="button" onClick={() => void save('clipboard')} disabled={busy?.startsWith('save:')} className={btn}>
        <Clipboard size={11} aria-hidden />
        {busy === 'save:clipboard' ? 'Copying…' : 'Copy'}
      </button>
      <button type="button" onClick={() => void save('desktop')} disabled={busy?.startsWith('save:')} className={btn}>
        <StickyNote size={11} aria-hidden />
        {busy === 'save:desktop' ? 'Saving…' : 'Save note'}
      </button>
      <button type="button" onClick={() => void save('obsidian')} disabled={busy?.startsWith('save:')} className={btn}>
        <FileText size={11} aria-hidden />
        {busy === 'save:obsidian' ? 'Opening…' : 'To Obsidian'}
      </button>
      <span className="self-center text-[var(--color-fg-subtle)]">·</span>
      <button type="button" onClick={refine} className={btn}>
        <Send size={11} aria-hidden />
        Make concise
      </button>
      <button type="button" onClick={expand} className={btn}>
        <ChevronRight size={11} aria-hidden />
        Expand into plan
      </button>
      <button type="button" onClick={emailDraft} className={btn}>
        <FileText size={11} aria-hidden />
        Draft as email
      </button>
      {confirm ? (
        <span className="inline-flex items-center text-[var(--color-fg-subtle)] italic">{confirm}</span>
      ) : null}
    </div>
  );
}

/**
 * Renders either plain text (user bubbles, system notes) or markdown (assistant).
 * `revealed` optionally clips the content for a typing effect while streaming.
 */
function MessageBody({
  content,
  role,
  revealed,
}: {
  content: string;
  role: MessageRole;
  revealed?: number;
}) {
  const text = useMemo(() => {
    if (revealed === undefined) return content;
    return content.slice(0, revealed);
  }, [content, revealed]);
  if (role !== 'assistant') {
    return <>{text}</>;
  }
  return (
    <div className="prose-assistant">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] underline underline-offset-2 hover:text-[var(--color-accent-hover)]"
            />
          ),
          code: ({ node: _node, inline, className, children, ...props }: {
            node?: unknown;
            inline?: boolean;
            className?: string;
            children?: React.ReactNode;
          }) =>
            inline ? (
              <code
                className="px-1 py-0.5 rounded-[var(--radius-xs)] bg-[var(--color-bg-canvas)] border border-[var(--color-border-subtle)] font-mono text-[0.85em]"
                {...props}
              >
                {children}
              </code>
            ) : (
              <pre className="my-2 p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-canvas)] border border-[var(--color-border-subtle)] overflow-x-auto font-mono text-[0.85em] whitespace-pre">
                <code className={className} {...props}>
                  {children}
                </code>
              </pre>
            ),
          ul: ({ node: _node, ...props }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...props} />,
          ol: ({ node: _node, ...props }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...props} />,
          h1: ({ node: _node, ...props }) => <h3 className="text-[var(--text-lg)] font-semibold mt-1 mb-2" {...props} />,
          h2: ({ node: _node, ...props }) => <h4 className="text-[var(--text-base)] font-semibold mt-2 mb-1.5" {...props} />,
          h3: ({ node: _node, ...props }) => <h5 className="text-[var(--text-sm)] font-semibold mt-2 mb-1" {...props} />,
          p: ({ node: _node, ...props }) => <p className="mb-1.5 last:mb-0" {...props} />,
          table: ({ node: _node, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table className="text-[var(--text-xs)] border-collapse" {...props} />
            </div>
          ),
          th: ({ node: _node, ...props }) => (
            <th className="border border-[var(--color-border-subtle)] bg-[var(--color-bg-canvas)] px-2 py-1 text-left" {...props} />
          ),
          td: ({ node: _node, ...props }) => (
            <td className="border border-[var(--color-border-subtle)] px-2 py-1 align-top" {...props} />
          ),
          blockquote: ({ node: _node, ...props }) => (
            <blockquote className="pl-3 border-l-2 border-[var(--color-border-default)] text-[var(--color-fg-muted)] my-1.5" {...props} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {revealed !== undefined && revealed < content.length ? (
        <span
          aria-hidden
          className="inline-block w-[8px] h-[1em] -mb-[0.15em] bg-[var(--color-accent)] align-middle animate-pulse motion-reduce:animate-none"
        />
      ) : null}
    </div>
  );
}

function FactProposalCard({
  proposal,
  resolved,
  onSave,
  onDismiss,
}: {
  proposal: FactProposal;
  resolved?: 'saved' | 'dismissed';
  onSave: () => void;
  onDismiss: () => void;
}) {
  const p = proposal.proposals ?? {};
  const chips: string[] = [];
  if (p.name) chips.push(`name: ${p.name}`);
  if (p.role) chips.push(`role: ${p.role}`);
  if (p.location) chips.push(`location: ${p.location}`);
  if (p.timezone) chips.push(`tz: ${p.timezone}`);
  if (p.current_focus) chips.push(`focus: ${p.current_focus}`);
  for (const g of p.goals_add ?? []) chips.push(`goal: ${g}`);
  if (p.preferences) chips.push(`style: ${p.preferences.slice(0, 48)}${p.preferences.length > 48 ? '…' : ''}`);
  if (p.notes_add) chips.push(p.notes_add.slice(0, 72));

  return (
    <div className="mt-2 p-2.5 rounded-[var(--radius-md)] bg-[var(--color-accent-subtle)]/40 border border-[var(--color-border-accent)] text-[var(--text-xs)]">
      <div className="flex items-start gap-2">
        <BrainCircuit size={14} className="text-[var(--color-accent)] flex-shrink-0 mt-0.5" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-[var(--color-fg-default)]">
            {resolved === 'saved'
              ? 'Saved to your profile.'
              : resolved === 'dismissed'
                ? 'Dismissed.'
                : 'I picked up something worth remembering.'}
          </p>
          {!resolved && proposal.reason ? (
            <p className="text-[var(--color-fg-muted)] mt-0.5">{proposal.reason}</p>
          ) : null}
          {!resolved && chips.length > 0 ? (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {chips.map((c, i) => (
                <li key={i}>
                  <Badge tone="accent" size="sm">
                    {c}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {!resolved ? (
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={onSave}
                className="h-6 px-2 rounded-[var(--radius-pill)] bg-[var(--color-accent)] text-[var(--color-fg-on-accent)] font-medium hover:bg-[var(--color-accent-hover)]"
              >
                Save to profile
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="h-6 px-2 rounded-[var(--radius-pill)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]"
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  live,
  onFollowup,
  onEditUser,
  onRemember,
  onSaveProposal,
  onDismissProposal,
  onShowWhy,
}: {
  message: Message;
  live: boolean;
  onFollowup: (prompt: string, context: string) => void;
  onEditUser?: (id: string) => void;
  onRemember?: (content: string) => void;
  onSaveProposal?: (id: string) => void;
  onDismissProposal?: (id: string) => void;
  onShowWhy?: (runId: string) => void;
}) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content || '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }, [message.content]);

  return (
    <div className={cn('group flex gap-3 items-start', isUser && 'flex-row-reverse')}>
      <Avatar role={message.role} />
      <div className={cn('min-w-0 max-w-[72ch] w-full', isUser && 'text-right')}>
        {message.attachments && message.attachments.length > 0 ? (
          <div className={cn('flex flex-wrap gap-1.5 mb-1.5', isUser && 'justify-end')}>
            {message.attachments.map((a) => (
              <Badge key={a.id} tone="neutral" size="sm" icon={a.kind === 'url' ? <LinkIcon size={10} aria-hidden /> : <Paperclip size={10} aria-hidden />}>
                {a.label}
              </Badge>
            ))}
          </div>
        ) : null}
        <div
          className={cn(
            'inline-block text-left rounded-[var(--radius-lg)] px-3.5 py-2.5 text-[var(--text-sm)] leading-relaxed break-words',
            isUser
              ? 'bg-[var(--color-accent-subtle)] text-[var(--color-fg-default)] border border-[var(--color-border-accent)] whitespace-pre-wrap'
              : isSystem
                ? 'bg-transparent text-[var(--color-fg-muted)] italic px-1 py-0 whitespace-pre-wrap'
                : 'bg-[var(--color-bg-sunken)] text-[var(--color-fg-default)] border border-[var(--color-border-subtle)]',
          )}
        >
          {message.content ? (
            <MessageBody content={message.content} role={message.role} revealed={message.revealed} />
          ) : live ? (
            <span className="text-[var(--color-fg-subtle)]">Thinking…</span>
          ) : (
            ''
          )}
        </div>

        {!isUser && message.status && message.status !== 'completed' ? (
          <div className="mt-1.5 flex items-center gap-2 text-[var(--text-xs)]">
            <StatusDot tone={statusTone(message.status)} pulse={message.status === 'running' || message.status === 'queued'} />
            <span className="text-[var(--color-fg-muted)]">{niceStatusLabel(message.status)}</span>
            {message.channel && message.channel !== 'auto' ? (
              <Badge tone="info" size="sm">
                #{message.channel}
              </Badge>
            ) : null}
          </div>
        ) : null}

        {!isUser && message.steps && message.steps.length > 0 ? <AgentStepsRow steps={message.steps} /> : null}

        {!isSystem && message.content ? (
          <div
            className={cn(
              'mt-1 flex gap-1 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity text-[var(--text-xs)]',
              isUser && 'justify-end',
            )}
          >
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--radius-xs)] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]"
              aria-label="Copy message"
            >
              {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {isUser && onEditUser ? (
              <button
                type="button"
                onClick={() => onEditUser(message.id)}
                className="inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--radius-xs)] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]"
                aria-label="Edit and resubmit"
              >
                <Pencil size={11} aria-hidden />
                Edit
              </button>
            ) : null}
            {!isUser && message.status === 'completed' && onRemember ? (
              <button
                type="button"
                onClick={() => onRemember(message.content)}
                className="inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--radius-xs)] text-[var(--color-fg-subtle)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-sunken)]"
                aria-label="Remember this as a profile fact"
              >
                <BookmarkPlus size={11} aria-hidden />
                Remember
              </button>
            ) : null}
            {!isUser && message.status === 'completed' && message.runId && onShowWhy ? (
              <button
                type="button"
                onClick={() => onShowWhy(message.runId!)}
                className="inline-flex items-center gap-1 h-5 px-1.5 rounded-[var(--radius-xs)] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]"
                aria-label="Show why this answer"
              >
                <Info size={11} aria-hidden />
                Why
              </button>
            ) : null}
            {!isUser && message.status === 'completed' && (message.tokens || message.elapsedMs) ? (
              <span className="inline-flex items-center gap-2 text-[var(--color-fg-subtle)] font-mono">
                {message.tokens ? <span>~{message.tokens.toLocaleString()} tok</span> : null}
                {message.elapsedMs ? <span>{(message.elapsedMs / 1000).toFixed(1)}s</span> : null}
              </span>
            ) : null}
          </div>
        ) : null}

        {!isUser && !isSystem && message.factProposal ? (
          <FactProposalCard
            proposal={message.factProposal}
            resolved={message.factProposalResolved}
            onSave={() => onSaveProposal?.(message.id)}
            onDismiss={() => onDismissProposal?.(message.id)}
          />
        ) : null}

        {!isUser && !isSystem && message.status === 'completed' && message.content ? (
          <QuickActions content={message.content} onFollowup={onFollowup} />
        ) : null}
      </div>
    </div>
  );
}

export function MissionControl({ onRunChange, onEnterVoiceMode }: Props) {
  const [messages, setMessages] = useState<Message[]>(() => [
    {
      id: 'welcome',
      role: 'system',
      content: "Press \u2318\u21e7Space from anywhere on your Mac to bring this up. Ask anything below, or pick a suggestion.",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState('');
  const mode: RunMode = 'live';
  const [channel, setChannel] = useState<ChannelId>(() => {
    if (typeof window === 'undefined') return 'auto';
    const stored = window.localStorage.getItem(CHANNEL_STORAGE_KEY);
    return (CHANNELS.find((c) => c.id === stored)?.id ?? 'auto') as ChannelId;
  });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [apiOnline, setApiOnline] = useState<boolean>(true);
  const [pttListening, setPttListening] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [profileEmpty, setProfileEmpty] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [whyRunId, setWhyRunId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const voice = useVoiceInput();

  useEffect(() => {
    window.localStorage.setItem(CHANNEL_STORAGE_KEY, channel);
  }, [channel]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Progressive reveal effect: every frame, advance `revealed` on any assistant
  // message whose content is longer than the chars currently visible. 28 chars
  // per tick ≈ feels like typing without being slow on multi-paragraph replies.
  useEffect(() => {
    const hasPending = messages.some(
      (m) => m.role === 'assistant' && typeof m.revealed === 'number' && m.revealed < m.content.length,
    );
    if (!hasPending) return;
    const id = window.setInterval(() => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.role !== 'assistant' || typeof m.revealed !== 'number') return m;
          if (m.revealed >= m.content.length) return m;
          return { ...m, revealed: Math.min(m.content.length, m.revealed + 28) };
        }),
      );
    }, 18);
    return () => window.clearInterval(id);
  }, [messages]);

  useEffect(() => {
    if (voice.transcript) setInput(voice.transcript);
  }, [voice.transcript]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        const res = await fetch(`${(import.meta.env.VITE_API_BASE as string) ?? 'http://localhost:8000'}/health`);
        if (!cancelled) setApiOnline(res.ok);
      } catch {
        if (!cancelled) setApiOnline(false);
      }
    };
    void ping();
    const id = window.setInterval(ping, 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Push-to-talk via hold of ⌘/Ctrl on an empty textarea + mic support.
  useEffect(() => {
    if (!voice.supported) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const isHotkey = (e.metaKey || e.ctrlKey) && e.code === 'Space';
      if (!isHotkey) return;
      e.preventDefault();
      if (e.type === 'keydown' && !pttListening) {
        void voice.start();
        setPttListening(true);
      } else if (e.type === 'keyup' && pttListening) {
        voice.stop();
        setPttListening(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [voice, pttListening]);

  // Listen for the Electron hotkey telling us to focus the input.
  useEffect(() => {
    const unsubscribe = window.desktop?.onFocusInput?.(() => {
      textareaRef.current?.focus();
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Load profile state once so we know whether to prompt first-run setup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getUserProfile();
        if (cancelled) return;
        const isEmpty =
          !p.name && !p.role && !p.current_focus && (p.goals ?? []).length === 0 && !p.notes;
        setProfileEmpty(isEmpty);
        if (isEmpty && !window.localStorage.getItem('kg-demo-profile-prompt-dismissed')) {
          setProfileDialogOpen(true);
        }
      } catch {
        // backend unreachable — keep empty state, chat failure will surface elsewhere
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const appendMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const updateAssistantMessage = useCallback(
    (runId: string, updater: (prev: Message) => Message) => {
      setMessages((prev) => prev.map((m) => (m.role === 'assistant' && m.runId === runId ? updater(m) : m)));
    },
    [],
  );

  const finalizeRun = useCallback(
    async (runId: string) => {
      try {
        const detail = await getRun(runId);
        const output = extractOutput(detail);
        const metrics = ((detail.state ?? {}) as Record<string, unknown>).run_metrics as
          | Record<string, number>
          | undefined;
        const tokens = metrics?.estimated_total_tokens;
        const elapsedMs = metrics?.elapsed_ms;
        updateAssistantMessage(runId, (prev) => {
          const liveContent = prev.streamedLive ? (prev.content ?? '').trim() : '';
          const finalContent =
            liveContent ||
            output ||
            prev.content ||
            "I didn't produce a response for that. Try rephrasing?";
          return {
            ...prev,
            content: finalContent,
            status: detail.status,
            // If we streamed real tokens, leave `revealed` at content.length (already set),
            // so the client-side reveal animation doesn't re-type the final message.
            revealed: prev.streamedLive ? finalContent.length : 0,
            tokens: typeof tokens === 'number' ? tokens : undefined,
            elapsedMs: typeof elapsedMs === 'number' ? elapsedMs : undefined,
          };
        });
        onRunChange(runId, detail);

        // Post-run: silently ask the fact-extractor whether anything in this
        // turn is worth remembering. Attach the proposal to the assistant
        // message so the operator sees an inline "Save to profile?" banner.
        if (output && detail.status === 'completed') {
          const rawTask = String(detail.task ?? '');
          const cleanedTask = rawTask.replace(/^\[Operator profile[\s\S]*?\[\/Operator profile\]\n\n/, '');
          void extractFactsFromTurn(cleanedTask, output)
            .then((proposal) => {
              if (!proposal?.has_new_facts) return;
              const hasAny =
                !!proposal.proposals &&
                Object.values(proposal.proposals).some((v) =>
                  typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : false,
                );
              if (!hasAny) return;
              updateAssistantMessage(runId, (prev) => ({ ...prev, factProposal: proposal }));
            })
            .catch(() => {});
        }
        try {
          const state = await window.desktop?.getWindowState?.();
          if (state && !state.focused) {
            window.desktop?.notify?.({
              title: 'The Brain',
              body: (output || 'Run complete.').slice(0, 180),
            });
          }
        } catch {
          // Browser context without Electron bridge — skip.
        }
      } catch (err) {
        updateAssistantMessage(runId, (prev) => ({
          ...prev,
          content: `Failed to load final run state: ${err instanceof Error ? err.message : String(err)}`,
          status: 'failed',
        }));
      } finally {
        streamRef.current?.close();
        streamRef.current = null;
        if (pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setActiveRunId((current) => (current === runId ? null : current));
      }
    },
    [onRunChange, updateAssistantMessage],
  );

  const attachStream = useCallback(
    (runId: string) => {
      streamRef.current?.close();
      const source = streamEvents(runId, (event) => {
        const type = String(event.type ?? '').toLowerCase();
        const node = String(event.node ?? event.agent ?? '').trim();
        const agent = node || 'system';
        const status = String(event.status ?? '').toLowerCase();
        const detail = String(event.detail ?? event.message ?? '').trim();
        const ts = String(event.ts ?? new Date().toISOString());
        if (type === 'token') {
          const delta = String(event.content ?? '');
          if (delta) {
            updateAssistantMessage(runId, (prev) => {
              const nextContent = (prev.content ?? '') + delta;
              return {
                ...prev,
                content: nextContent,
                revealed: nextContent.length,
                streamedLive: true,
                status: prev.status === 'queued' ? 'running' : prev.status,
              };
            });
          }
          return;
        }
        if (type === 'stream_end') {
          return;
        }
        if (type === 'node' || node) {
          const step: AgentStep = { agent, node, status: status || 'update', detail, ts };
          updateAssistantMessage(runId, (prev) => ({
            ...prev,
            steps: [...(prev.steps ?? []), step].slice(-60),
          }));
        }
        if (type === 'final' || type === 'done' || status === 'complete' || status === 'completed') {
          void finalizeRun(runId);
        }
      });
      source.onerror = () => {
        /* the poll below is our safety net */
      };
      streamRef.current = source;

      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        try {
          const detail = await getRun(runId);
          updateAssistantMessage(runId, (prev) => ({ ...prev, status: detail.status }));
          if (detail.status === 'completed' || detail.status === 'failed' || detail.status === 'degraded') {
            void finalizeRun(runId);
          }
        } catch {
          /* ignore */
        }
      }, 3000);
    },
    [finalizeRun, updateAssistantMessage],
  );

  const submit = useCallback(
    async (taskOverride?: string, options?: { background?: boolean }) => {
      const text = (taskOverride ?? input).trim();
      if (!text || activeRunId) return;
      voice.stop();
      setPttListening(false);
      setInput('');
      voice.reset();

      const channelDef = CHANNELS.find((c) => c.id === channel);
      let task = text;
      if (channelDef?.prefix) task = `${channelDef.prefix} ${task}`;

      const attachmentSummary = attachments
        .map((a) => (a.kind === 'url' ? `URL: ${a.label}` : `File: ${a.label}\n---\n${a.preview}`))
        .join('\n\n');
      if (attachmentSummary) task = `${task}\n\nAttached:\n${attachmentSummary}`;

      const userMsg: Message = {
        id: uuid(),
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      const placeholder: Message = {
        id: uuid(),
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        status: 'queued',
        steps: [],
        mode,
        channel,
      };
      setMessages((prev) => [...prev, userMsg, placeholder]);
      setAttachments([]);

      try {
        const response = await startRun(task, mode, Boolean(channelDef?.conservative), channelDef?.taskType);
        if (options?.background) {
          // Fire and forget — Electron watches the run and badges the dock on completion.
          window.desktop?.trackBackgroundRun?.({ runId: response.run_id, title: 'Background run finished' });
          setMessages((prev) =>
            prev.map((m) =>
              m.id === placeholder.id
                ? {
                    ...m,
                    content: 'Running in the background — you\u2019ll get a notification when it\u2019s done.',
                    status: 'completed',
                    runId: response.run_id,
                  }
                : m,
            ),
          );
          onRunChange(response.run_id, null);
          return;
        }
        setActiveRunId(response.run_id);
        setMessages((prev) =>
          prev.map((m) => (m.id === placeholder.id ? { ...m, runId: response.run_id, status: response.status } : m)),
        );
        onRunChange(response.run_id, null);
        attachStream(response.run_id);
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholder.id
              ? {
                  ...m,
                  content: err instanceof Error ? `Could not reach the backend: ${err.message}` : 'Could not reach the backend.',
                  status: 'failed',
                }
              : m,
          ),
        );
      }
    },
    [activeRunId, attachStream, attachments, channel, input, mode, onRunChange, voice],
  );

  const handleFollowup = useCallback(
    (prompt: string, context: string) => {
      if (activeRunId) return;
      const combined = context ? `${prompt}\n\nPrevious answer:\n${context}` : prompt;
      void submit(combined);
    },
    [activeRunId, submit],
  );

  const handleEditUser = useCallback(
    (id: string) => {
      if (activeRunId) return;
      const idx = messages.findIndex((m) => m.id === id);
      if (idx < 0) return;
      const target = messages[idx];
      if (target.role !== 'user') return;
      setInput(target.content);
      // Drop that user message and anything after it — they'll be replaced by the new turn.
      setMessages((prev) => prev.slice(0, idx));
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [activeRunId, messages],
  );

  const handleRemember = useCallback(async (content: string) => {
    const text = content.trim().slice(0, 500);
    if (!text) return;
    try {
      await rememberFact(text);
    } catch {
      /* ignore — user-facing error channel is the banner below the chat */
    }
  }, []);

  const handleSaveProposal = useCallback(
    async (messageId: string) => {
      const target = messages.find((m) => m.id === messageId);
      if (!target?.factProposal) return;
      try {
        await applyProfileProposals(target.factProposal.proposals);
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, factProposalResolved: 'saved' } : m)),
        );
      } catch {
        /* ignore */
      }
    },
    [messages],
  );

  const handleDismissProposal = useCallback((messageId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, factProposalResolved: 'dismissed' } : m)),
    );
  }, []);

  const loadHistory = useCallback(async (query?: string) => {
    setHistoryLoading(true);
    try {
      const rows = await listRuns(40, query);
      setHistory(rows);
    } catch {
      /* ignore — offline */
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const openHistory = useCallback(() => {
    setHistoryOpen(true);
    void loadHistory(historyQuery);
  }, [loadHistory, historyQuery]);

  // Debounced refetch when the search query changes.
  useEffect(() => {
    if (!historyOpen) return;
    const id = window.setTimeout(() => {
      void loadHistory(historyQuery);
    }, 250);
    return () => window.clearTimeout(id);
  }, [historyOpen, historyQuery, loadHistory]);

  const openHistoryRun = useCallback(async (summary: RunSummary) => {
    try {
      const detail = await getRun(summary.run_id);
      const output = extractOutput(detail);
      // Re-hydrate the conversation as two bubbles — user turn + assistant turn —
      // so you can read and continue from there.
      const rawTask = String(detail.task ?? '');
      const cleanedTask = rawTask.replace(/^\[Operator profile[\s\S]*?\[\/Operator profile\]\n\n/, '');
      const userMsg: Message = {
        id: uuid(),
        role: 'user',
        content: cleanedTask,
        timestamp: String(detail.created_at ?? new Date().toISOString()),
      };
      const assistantMsg: Message = {
        id: uuid(),
        role: 'assistant',
        content: output,
        timestamp: String(detail.updated_at ?? detail.created_at ?? new Date().toISOString()),
        runId: detail.run_id,
        status: detail.status,
        tokens: summary.estimated_total_tokens ?? undefined,
        elapsedMs: summary.elapsed_ms ?? undefined,
      };
      setMessages([
        {
          id: 'resumed',
          role: 'system',
          content: `Showing run from ${new Date(String(detail.created_at ?? Date.now())).toLocaleString()}. Ask a follow-up below.`,
          timestamp: new Date().toISOString(),
        },
        userMsg,
        assistantMsg,
      ]);
      setHistoryOpen(false);
    } catch (err) {
      /* ignore */
      void err;
    }
  }, []);

  const stopRun = useCallback(() => {
    streamRef.current?.close();
    streamRef.current = null;
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (activeRunId) {
      updateAssistantMessage(activeRunId, (prev) => ({
        ...prev,
        status: 'degraded',
        content: prev.content || 'Run cancelled.',
      }));
    }
    setActiveRunId(null);
  }, [activeRunId, updateAssistantMessage]);

  const exportConversation = useCallback(() => {
    if (messages.length === 0) return;
    const now = new Date();
    const lines: string[] = [
      `# Conversation — ${now.toLocaleString()}`,
      '',
      '_Exported from The Brain Mission Control._',
      '',
    ];
    for (const m of messages) {
      if (m.role === 'system') {
        lines.push(`> _${m.content}_`, '');
        continue;
      }
      const speaker = m.role === 'user' ? '### You' : '### Assistant';
      const meta: string[] = [new Date(m.timestamp).toLocaleString()];
      if (m.channel && m.channel !== 'auto') meta.push(`#${m.channel}`);
      if (m.tokens) meta.push(`~${m.tokens} tok`);
      if (m.elapsedMs) meta.push(`${(m.elapsedMs / 1000).toFixed(1)}s`);
      lines.push(speaker);
      lines.push(`_${meta.join(' · ')}_`);
      lines.push('');
      if (m.attachments && m.attachments.length > 0) {
        lines.push('**Attachments:**');
        for (const a of m.attachments) lines.push(`- ${a.kind === 'url' ? '[link]' : '[file]'} ${a.label}`);
        lines.push('');
      }
      lines.push(m.content);
      lines.push('');
      if (m.steps && m.steps.length > 0) {
        lines.push('<details><summary>Agent steps</summary>', '');
        for (const s of m.steps) {
          lines.push(`- \`${new Date(s.ts).toLocaleTimeString()}\` **${s.agent}** · ${s.status}${s.detail ? ` · ${s.detail}` : ''}`);
        }
        lines.push('', '</details>', '');
      }
    }
    const md = lines.join('\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${stamp}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [messages]);

  const startNewChat = useCallback(() => {
    stopRun();
    setMessages([
      {
        id: 'welcome',
        role: 'system',
        content: 'New conversation. What would you like to work on?',
        timestamp: new Date().toISOString(),
      },
    ]);
    onRunChange(null, null);
  }, [onRunChange, stopRun]);

  const addUrlAttachment = useCallback((raw: string) => {
    const url = raw.trim();
    if (!url) return;
    setAttachments((prev) => [...prev, { id: uuid(), label: url, preview: `URL: ${url}`, kind: 'url' }]);
  }, []);

  const addFileAttachment = useCallback(async (file: File) => {
    const isImage = (file.type || '').toLowerCase().startsWith('image/');
    try {
      if (isImage) {
        const id = uuid();
        // Optimistic placeholder so the user sees "Describing image…" immediately.
        setAttachments((prev) => [
          ...prev,
          { id, label: file.name, preview: '(describing image…)', kind: 'file' },
        ]);
        try {
          const v = await describeImage(file);
          const preview = `[image: ${file.name}] ${v.description.slice(0, 2000)}`;
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, preview } : a)));
        } catch (err) {
          const preview =
            err instanceof Error
              ? `[image: ${file.name}] (could not describe: ${err.message})`
              : `[image: ${file.name}] (could not describe)`;
          setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, preview } : a)));
        }
        return;
      }
      const processed = await processDocument(file);
      const preview =
        (processed.summary && processed.summary.slice(0, 2000)) ||
        (processed.text && processed.text.slice(0, 2000)) ||
        `File: ${file.name} (${Math.round(file.size / 1024)} KB)`;
      setAttachments((prev) => [...prev, { id: uuid(), label: file.name, preview, kind: 'file' }]);
    } catch (err) {
      setAttachments((prev) => [
        ...prev,
        {
          id: uuid(),
          label: file.name,
          preview: err instanceof Error ? `(Could not parse: ${err.message})` : '(Could not parse)',
          kind: 'file',
        },
      ]);
    }
  }, []);

  const onDrop = useCallback(
    async (e: DragEvent<HTMLFormElement>) => {
      e.preventDefault();
      setDragging(false);
      const { files } = e.dataTransfer;
      const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (text && /^https?:\/\//i.test(text.trim())) {
        addUrlAttachment(text.trim());
      }
      if (files && files.length > 0) {
        for (const file of Array.from(files)) {
          await addFileAttachment(file);
        }
      }
    },
    [addFileAttachment, addUrlAttachment],
  );

  const onDragOver = useCallback((e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dragging) setDragging(true);
  }, [dragging]);

  const onDragLeave = useCallback((e: DragEvent<HTMLFormElement>) => {
    // Only clear when leaving the form entirely.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragging(false);
  }, []);

  const onFilePicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list) return;
      for (const file of Array.from(list)) {
        await addFileAttachment(file);
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [addFileAttachment],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        if (e.shiftKey) return; // newline
        if (e.altKey) {
          e.preventDefault();
          void submit(undefined, { background: true });
          return;
        }
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const onMicClick = useCallback(() => {
    if (voice.listening) voice.stop();
    else void voice.start();
  }, [voice]);

  const onFormSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void submit();
    },
    [submit],
  );

  // Morning brief auto-post on first open each day. When Google is connected,
  // pulls real inbox + calendar into the prompt so the assistant works with
  // actual today-data instead of a generic reflection.
  const postMorningBrief = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (window.localStorage.getItem(BRIEF_STORAGE_KEY) === today) return;
    window.localStorage.setItem(BRIEF_STORAGE_KEY, today);

    let context = '';
    try {
      const ctx = await getBriefContext();
      if (ctx.connected && !ctx.error) {
        const inboxLines = ctx.messages
          .slice(0, 8)
          .map((m) => `- ${m.from} — "${m.subject}" (${m.date})`)
          .join('\n');
        const eventLines = ctx.events
          .slice(0, 8)
          .map((e) => {
            const when = e.start ? new Date(e.start).toLocaleString() : '';
            const who = (e.attendees && e.attendees.length > 0) ? ` · with ${e.attendees.slice(0, 3).join(', ')}` : '';
            const where = e.location ? ` · ${e.location}` : '';
            return `- ${when}: ${e.summary}${who}${where}`;
          })
          .join('\n');
        const overlap = (ctx.overlaps || []).slice(0, 4).map((o) => `- ${o}`).join('\n');
        const parts: string[] = [];
        if (eventLines) parts.push(`Calendar (next 48h):\n${eventLines}`);
        if (inboxLines) parts.push(`Recent inbox (last 2 days):\n${inboxLines}`);
        if (overlap) parts.push(`Calendar conflicts:\n${overlap}`);
        if (parts.length > 0) context = `\n\n---\nReal Gmail + Calendar data from this moment:\n\n${parts.join('\n\n')}`;
      }
    } catch {
      // Google not reachable — fall back to the generic prompt.
    }
    void submit(
      `Good morning — give me today's brief. Top 3 priorities, anything time-sensitive, and the one thing I shouldn't forget.${context}`,
    );
  }, [submit]);

  const canSend = useMemo(
    () => input.trim().length > 0 && !activeRunId,
    [activeRunId, input],
  );
  const showSuggestions = messages.length === 1 && messages[0].id === 'welcome';
  const channelDef = CHANNELS.find((c) => c.id === channel) ?? CHANNELS[0];

  return (
    <Card padding="none" className="relative flex flex-col h-[calc(100vh-12rem)] min-h-[480px]">
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--color-border-default)]">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-[var(--radius-sm)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)] grid place-items-center" aria-hidden>
            <Sparkles size={14} />
          </div>
          <div className="min-w-0">
            <p className="text-[var(--text-sm)] font-semibold leading-none">Mission Control</p>
            <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-0.5">
              {activeRunId ? 'Working on it…' : channelDef.hint}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip content={apiOnline ? 'API is reachable' : 'API is not reachable — check Docker'} side="bottom">
            <span aria-label={apiOnline ? 'API online' : 'API offline'}>
              {apiOnline ? (
                <Wifi size={14} className="text-[var(--color-success)]" aria-hidden />
              ) : (
                <WifiOff size={14} className="text-[var(--color-danger)]" aria-hidden />
              )}
            </span>
          </Tooltip>

          <Tooltip content="Morning brief" side="bottom">
            <Button size="sm" variant="ghost" leading={<Sun size={14} aria-hidden />} onClick={postMorningBrief}>
              Brief
            </Button>
          </Tooltip>

          {onEnterVoiceMode ? (
            <Tooltip content="Hands-free voice conversation" side="bottom">
              <Button size="sm" variant="ghost" leading={<Mic size={14} aria-hidden />} onClick={onEnterVoiceMode}>
                Voice
              </Button>
            </Tooltip>
          ) : null}

          <Tooltip content="Export conversation as markdown" side="bottom">
            <Button
              size="sm"
              variant="ghost"
              leading={<Download size={14} aria-hidden />}
              onClick={exportConversation}
              disabled={messages.length <= 1}
            >
              Export
            </Button>
          </Tooltip>

          <Tooltip content="Conversation history" side="bottom">
            <Button size="sm" variant="ghost" leading={<History size={14} aria-hidden />} onClick={openHistory}>
              History
            </Button>
          </Tooltip>

          <Button
            size="sm"
            variant={profileEmpty ? 'primary' : 'ghost'}
            leading={<UserPen size={14} aria-hidden />}
            onClick={() => setProfileDialogOpen(true)}
          >
            {profileEmpty ? 'Set up profile' : 'Profile'}
          </Button>

          <Button size="sm" variant="ghost" leading={<Plus size={14} aria-hidden />} onClick={startNewChat}>
            New
          </Button>
        </div>
      </header>

      {profileEmpty ? (
        <div className="px-4 py-2 border-b border-[var(--color-border-default)] bg-[var(--color-accent-subtle)]/40">
          <div className="flex items-center justify-between gap-3 text-[var(--text-xs)]">
            <p className="text-[var(--color-fg-muted)]">
              I don't know anything about you yet. A 60-second profile makes every answer 10× more relevant.
            </p>
            <Button
              size="sm"
              variant="primary"
              leading={<UserPen size={14} aria-hidden />}
              onClick={() => setProfileDialogOpen(true)}
            >
              Set it up
            </Button>
          </div>
        </div>
      ) : null}

      <ProfileDialog
        open={profileDialogOpen}
        onOpenChange={(open) => {
          setProfileDialogOpen(open);
          if (!open) window.localStorage.setItem('kg-demo-profile-prompt-dismissed', '1');
        }}
        onSaved={(saved) => {
          const isEmpty =
            !saved.name && !saved.role && !saved.current_focus && (saved.goals ?? []).length === 0 && !saved.notes;
          setProfileEmpty(isEmpty);
        }}
      />

      <WhyDialog
        open={Boolean(whyRunId)}
        onOpenChange={(open) => {
          if (!open) setWhyRunId(null);
        }}
        runId={whyRunId}
      />

      {historyOpen ? (
        <div
          role="dialog"
          aria-label="Conversation history"
          className="absolute inset-y-0 right-0 z-30 w-[340px] bg-[var(--color-bg-surface)] border-l border-[var(--color-border-default)] shadow-[var(--shadow-lg)] flex flex-col"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border-default)]">
            <div className="flex items-center gap-2">
              <History size={14} className="text-[var(--color-fg-muted)]" aria-hidden />
              <p className="text-[var(--text-sm)] font-semibold">Recent conversations</p>
            </div>
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              aria-label="Close history"
              className="h-6 w-6 rounded-[var(--radius-sm)] grid place-items-center text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
          <div className="px-3 py-2 border-b border-[var(--color-border-default)]">
            <label className="relative block">
              <span className="sr-only">Search conversations</span>
              <input
                type="search"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
                placeholder="Search past conversations…"
                className="w-full h-8 px-2.5 pr-7 bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] rounded-[var(--radius-sm)] text-[var(--text-sm)] placeholder:text-[var(--color-fg-subtle)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
              />
              {historyQuery ? (
                <button
                  type="button"
                  onClick={() => setHistoryQuery('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 grid place-items-center text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-default)]"
                >
                  <X size={12} aria-hidden />
                </button>
              ) : null}
            </label>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {historyLoading ? (
              <p className="p-3 text-[var(--text-xs)] text-[var(--color-fg-subtle)]">Loading…</p>
            ) : history.length === 0 ? (
              <p className="p-3 text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
                {historyQuery ? `No runs match "${historyQuery}".` : 'No past runs yet.'}
              </p>
            ) : (
              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {history.map((run) => (
                  <li key={run.run_id}>
                    <button
                      type="button"
                      onClick={() => void openHistoryRun(run)}
                      className="w-full text-left px-3 py-2.5 hover:bg-[var(--color-bg-sunken)] focus-visible:bg-[var(--color-bg-sunken)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent)]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-[var(--text-sm)] font-medium truncate flex-1">{run.title || '(empty)'}</p>
                        <StatusDot tone={statusTone(run.status as RunDetail['status'])} />
                      </div>
                      <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-0.5 line-clamp-2">
                        {run.preview}
                      </p>
                      <p className="text-[10px] text-[var(--color-fg-subtle)] mt-1 font-mono">
                        {new Date(run.updated_at || run.created_at).toLocaleString()}
                        {run.estimated_total_tokens ? ` · ~${run.estimated_total_tokens} tok` : ''}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}

      <div className="px-4 py-2 border-b border-[var(--color-border-default)] overflow-x-auto">
        <div className="flex items-center gap-1">
          {CHANNELS.map((c) => (
            <Tooltip key={c.id} content={c.hint}>
              <button
                type="button"
                onClick={() => setChannel(c.id)}
                aria-pressed={channel === c.id}
                className={cn(
                  'px-2 h-6 text-[var(--text-xs)] rounded-[var(--radius-pill)] border flex-shrink-0',
                  channel === c.id
                    ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] border-[var(--color-border-accent)]'
                    : 'bg-transparent text-[var(--color-fg-muted)] border-[var(--color-border-subtle)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]',
                )}
              >
                #{c.id === 'auto' ? 'auto' : c.id}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-5 space-y-4" role="log" aria-live="polite">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            live={msg.runId === activeRunId}
            onFollowup={handleFollowup}
            onEditUser={handleEditUser}
            onRemember={handleRemember}
            onSaveProposal={handleSaveProposal}
            onDismissProposal={handleDismissProposal}
            onShowWhy={setWhyRunId}
          />
        ))}
        {showSuggestions ? (
          <div className="flex flex-wrap gap-2 pt-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => void submit(s.prompt)}
                className="text-[var(--text-xs)] px-2.5 h-7 rounded-[var(--radius-pill)] bg-[var(--color-bg-sunken)] hover:bg-[var(--color-bg-elevated)] border border-[var(--color-border-subtle)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
              >
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <form
        onSubmit={onFormSubmit}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={cn(
          'border-t border-[var(--color-border-default)] px-3 py-3 bg-[var(--color-bg-surface)] transition-colors',
          dragging && 'bg-[var(--color-accent-subtle)]/30 border-[var(--color-border-accent)]',
        )}
      >
        {attachments.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 text-[var(--text-xs)] px-2 h-6 rounded-[var(--radius-pill)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] text-[var(--color-fg-muted)]"
              >
                {a.kind === 'url' ? <LinkIcon size={11} aria-hidden /> : <Paperclip size={11} aria-hidden />}
                <span className="max-w-[220px] truncate">{a.label}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== a.id))}
                  aria-label={`Remove ${a.label}`}
                  className="hover:text-[var(--color-fg-default)]"
                >
                  <X size={11} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            onChange={onFilePicked}
            accept="image/*,.txt,.md,.csv,.json,.html,.htm,.js,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.yaml,.yml,.toml"
          />
          <Tooltip content="Attach a file (text, markdown, CSV, JSON, HTML, code)">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach file"
              className="h-9 w-9 rounded-[var(--radius-md)] grid place-items-center flex-shrink-0 bg-[var(--color-bg-sunken)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] border border-[var(--color-border-default)]"
            >
              <Paperclip size={16} aria-hidden />
            </button>
          </Tooltip>

          <Tooltip content={voice.listening || pttListening ? 'Stop listening' : voice.supported ? 'Press to speak — or hold ⌘Space' : 'Voice input unavailable'}>
            <button
              type="button"
              onClick={onMicClick}
              disabled={!voice.supported}
              aria-label={voice.listening ? 'Stop voice input' : 'Start voice input'}
              aria-pressed={voice.listening}
              className={cn(
                'h-9 w-9 rounded-[var(--radius-md)] grid place-items-center flex-shrink-0',
                'border border-[var(--color-border-default)]',
                'transition-colors duration-[var(--motion-fast)]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
                voice.listening || pttListening
                  ? 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] border-[var(--color-border-accent)] animate-pulse motion-reduce:animate-none'
                  : 'bg-[var(--color-bg-sunken)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]',
                !voice.supported && 'opacity-40 cursor-not-allowed',
              )}
            >
              <Mic size={16} aria-hidden />
            </button>
          </Tooltip>

          <label className="sr-only" htmlFor="mission-control-input">
            Ask the system
          </label>
          <textarea
            id="mission-control-input"
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              activeRunId
                ? 'Working on your last request…'
                : dragging
                  ? 'Drop files or a URL to attach…'
                  : `Ask anything — ${pttListening ? 'listening (release ⌘Space)' : 'Enter to send · ⌥Enter to run in background · Shift+Enter for newline · hold ⌘Space to dictate'}`
            }
            disabled={Boolean(activeRunId)}
            className={cn(
              'flex-1 resize-none min-h-[36px] max-h-[220px]',
              'bg-[var(--color-bg-sunken)] border border-[var(--color-border-default)] rounded-[var(--radius-md)]',
              'px-3 py-2 text-[var(--text-sm)] leading-snug',
              'placeholder:text-[var(--color-fg-subtle)]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] focus-visible:border-[var(--color-border-accent)]',
              'disabled:opacity-60',
            )}
          />

          {activeRunId ? (
            <Tooltip content="Stop the current run">
              <button
                type="button"
                onClick={stopRun}
                aria-label="Stop run"
                className="h-9 w-9 rounded-[var(--radius-md)] grid place-items-center flex-shrink-0 bg-[var(--color-bg-sunken)] text-[var(--color-danger)] border border-[var(--color-border-default)] hover:text-[var(--color-fg-default)]"
              >
                <CircleStop size={16} aria-hidden />
              </button>
            </Tooltip>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              className={cn(
                'h-9 w-9 rounded-[var(--radius-md)] grid place-items-center flex-shrink-0',
                'transition-colors duration-[var(--motion-fast)]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
                canSend
                  ? 'bg-[var(--color-accent)] text-[var(--color-fg-on-accent)] hover:bg-[var(--color-accent-hover)]'
                  : 'bg-[var(--color-bg-sunken)] text-[var(--color-fg-subtle)] cursor-not-allowed',
              )}
            >
              <ArrowUp size={16} aria-hidden />
            </button>
          )}
        </div>
        {voice.error ? (
          <p className="mt-1.5 text-[var(--text-xs)] text-[var(--color-danger)]">Voice: {voice.error}</p>
        ) : null}
      </form>
    </Card>
  );
}
