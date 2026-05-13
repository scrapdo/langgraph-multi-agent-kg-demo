import { Mic, MicOff, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useVoiceConversation, type ConversationState } from '../lib/useVoiceConversation';
import { cn } from '../ui/cn';
import { HumanoidVisualizer } from './HumanoidVisualizer';

interface Props {
  open: boolean;
  onClose: () => void;
}

function stateLabel(state: ConversationState): string {
  switch (state) {
    case 'listening':
      return 'Listening';
    case 'thinking':
      return 'Thinking';
    case 'speaking':
      return 'Speaking';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}

export function VoiceMode({ open, onClose }: Props) {
  const convo = useVoiceConversation({ provider: 'elevenlabs' });
  const started = useRef(false);

  // Auto-start conversation when the overlay opens, stop on close.
  useEffect(() => {
    if (!open) {
      if (started.current) {
        convo.stop();
        started.current = false;
      }
      return;
    }
    if (!started.current) {
      started.current = true;
      void convo.start();
    }
  }, [open, convo]);

  // Keyboard: Esc closes, Space toggles mic on/off via interrupt.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const lastAssistant = [...convo.messages].reverse().find((m) => m.role === 'assistant');
  const lastUser = [...convo.messages].reverse().find((m) => m.role === 'user');
  const liveTranscript = convo.transcript.trim();

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-[#050910] text-[var(--color-fg-default)]"
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation mode"
    >
      {/* Subtle radial wash behind the scene. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 45%, rgba(41, 216, 255, 0.05), rgba(7, 10, 15, 0.9) 60%, #050910 100%)',
        }}
      />

      <header className="relative z-10 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3 text-[var(--text-xs)] font-mono uppercase tracking-wider">
          <span
            aria-hidden
            className={cn(
              'h-2 w-2 rounded-full',
              convo.state === 'listening' && 'bg-emerald-400',
              convo.state === 'thinking' && 'bg-violet-400 animate-pulse motion-reduce:animate-none',
              convo.state === 'speaking' && 'bg-cyan-400 animate-pulse motion-reduce:animate-none',
              convo.state === 'idle' && 'bg-[var(--color-fg-subtle)]',
              convo.state === 'error' && 'bg-rose-400',
            )}
          />
          <span className="text-[var(--color-fg-muted)]">{stateLabel(convo.state)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            aria-label="Exit voice mode"
            className="h-9 px-3 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] text-[var(--text-sm)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          >
            <X size={14} aria-hidden />
            Exit
            <span className="font-mono text-[10px] ml-1 opacity-70">esc</span>
          </button>
        </div>
      </header>

      {/* The humanoid visualizer takes the bulk of the screen. */}
      <div className="relative z-10 flex-1 min-h-0 grid place-items-center">
        <div className="w-full max-w-[640px] aspect-square">
          <HumanoidVisualizer state={convo.state === 'error' ? 'idle' : convo.state} level={convo.level} />
        </div>
      </div>

      {/* Transcript surface — previous turn, then live dictation as it comes in. */}
      <div className="relative z-10 max-w-[720px] w-full mx-auto px-6 pb-10 space-y-3">
        {lastUser ? (
          <p className="text-right text-[var(--text-sm)] text-[var(--color-fg-subtle)]">
            <span className="font-mono text-[10px] uppercase tracking-wider mr-2">you said</span>
            {lastUser.text}
          </p>
        ) : null}
        {lastAssistant && convo.state !== 'listening' ? (
          <p className="text-[var(--text-base)] leading-relaxed text-[var(--color-fg-default)]">
            {lastAssistant.text}
          </p>
        ) : null}
        {convo.state === 'listening' && liveTranscript ? (
          <p className="text-[var(--text-base)] italic text-[var(--color-fg-muted)] text-right">{liveTranscript}</p>
        ) : null}
        {convo.state === 'listening' && !liveTranscript ? (
          <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] text-center inline-flex items-center justify-center gap-1 w-full">
            <Mic size={11} aria-hidden /> Listening — speak naturally. Silence for a second or so will send.
          </p>
        ) : null}
        {convo.state === 'thinking' ? (
          <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] text-center">Thinking…</p>
        ) : null}
        {convo.error ? (
          <p className="text-[var(--text-xs)] text-[var(--color-danger)] text-center inline-flex items-center justify-center gap-1 w-full">
            <MicOff size={11} aria-hidden /> {convo.error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
