import { Mic, MicOff, Send, Square, User2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createProactiveTask,
  deleteProactiveTask,
  executeAppControl,
  getRunSpeech,
  listProactiveTasks,
  placeSecretaryCall,
  quickLookup,
  type ProactiveTask,
} from '../api/client';
import { useProactiveBriefings } from '../lib/useProactiveBriefings';
import { useRealtimeAgent, type RealtimeState, type RealtimeToolCall } from '../lib/useRealtimeAgent';
import { useSpecialistHandoff, type SpecialistArtifact } from '../lib/useSpecialistHandoff';
import { Badge, Button, Card, Input, cn } from '../ui';
import { HumanoidVisualizer, type VisualizerState, type VisualizerPalette } from './HumanoidVisualizer';

// Maps agent_id → orb palette. Warm = pink/red (feminine voices),
// cool = blue/green (masculine + neutral voices). Mirrors the
// `palette` field in backend/data/agent_profiles.json.
const AGENT_PALETTE: Record<string, VisualizerPalette> = {
  coordinator: 'cool',
  researcher:  'cool',
  critic:      'cool',
  writer:      'cool',
  coding:      'cool',
  shopper:     'warm',
  social:      'cool',
  secretary:   'warm',
  wellness:    'warm',
};

// Display name shown in the Voice Stage caption header for the active
// speaker. Mirrors `name` field in agent_profiles.json.
const ACTIVE_AGENT_LABELS: Record<string, string> = {
  coordinator: 'Brain',
  secretary:   'Emma',
  wellness:    'Grace',
  shopper:     'Michelle',
  researcher:  'Leo',
  critic:      'Frank',
  writer:      'George',
  coding:      'Chad',
  social:      'Antonio',
};
import { OutputsRail } from './OutputsRail';

type TranscriptRole = 'you' | 'delegator' | 'specialist' | 'system';

interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  text: string;
  at: string;
}

function realtimeToVisualizer(state: RealtimeState): VisualizerState {
  switch (state) {
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return 'idle';
  }
}

function stateLabel(state: RealtimeState): string {
  switch (state) {
    case 'connecting':
      return 'Connecting';
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

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function VoiceShell() {
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [textInput, setTextInput] = useState('');
  const [faceOn, setFaceOn] = useState(false);
  // Tracks which agent's persona is currently "speaking" — drives the
  // visualizer palette (warm vs cool). Defaults to coordinator (Brain).
  // Updated to a specialist's id when route_to_specialist runs; reset to
  // coordinator when the run completes/fails or when the operator starts
  // a new turn.
  const [activeAgentId, setActiveAgentId] = useState<string>('coordinator');
  const pendingCallsRef = useRef<Map<string, RealtimeToolCall>>(new Map());

  const pushTranscript = useCallback((role: TranscriptRole, text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setTranscript((prev) => [...prev, { id: uid(), role, text: clean, at: new Date().toISOString() }].slice(-50));
  }, []);

  // Specialist handoff — runs the backend and plays ElevenLabs specialist voice.
  const handoff = useSpecialistHandoff({
    onComplete: (artifact) => {
      const summary = (artifact.finalContent ?? '').slice(0, 1200);
      pushTranscript('specialist', `${artifact.agentLabel} → ${summary}`);
      // Feed a short summary back to the delegator so it can close the loop.
      // We store the callId keyed by run so we know which tool call to respond to.
      const pendingEntry = pendingCallsRef.current.get(artifact.runId);
      if (pendingEntry) {
        pendingCallsRef.current.delete(artifact.runId);
        // Let the delegator see the result and ask "anything else?" — kept short to stay conversational.
        const payload = JSON.stringify({
          status: 'completed',
          agent: artifact.agentId,
          summary: summary.slice(0, 600),
        });
        realtime.sendToolResult(pendingEntry.callId, payload);
      }
      // Specialist done — visual identity returns to the Coordinator.
      setActiveAgentId('coordinator');
    },
    onFailed: (artifact, message) => {
      pushTranscript('system', `${artifact.agentLabel} failed: ${message}`);
      const pendingEntry = pendingCallsRef.current.get(artifact.runId);
      if (pendingEntry) {
        pendingCallsRef.current.delete(artifact.runId);
        realtime.sendToolResult(pendingEntry.callId, JSON.stringify({ status: 'failed', error: message }));
      }
      setActiveAgentId('coordinator');
    },
  });

  // Realtime delegator — WebRTC loop. Tool calls route through the handoff hook.
  const realtime = useRealtimeAgent({
    onUserTranscript: (text) => pushTranscript('you', text),
    onAssistantText: (text) => pushTranscript('delegator', text),
    onToolCall: (call) => {
      if (call.name === 'quick_lookup') {
        const query = String((call.args as { query?: string }).query ?? '').trim();
        if (!query) {
          realtime.sendToolResult(call.callId, JSON.stringify({ status: 'error', error: 'query required' }));
          return;
        }
        pushTranscript('system', `🔍 ${query}`);
        void quickLookup(query)
          .then((res) => {
            // Push the answer to the delegator so it reads it aloud in its own voice.
            realtime.sendToolResult(
              call.callId,
              JSON.stringify({ status: 'ok', answer: res.answer, citations: res.citations }),
            );
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            pushTranscript('system', `quick_lookup failed: ${message}`);
            realtime.sendToolResult(call.callId, JSON.stringify({ status: 'error', error: message }));
          });
        return;
      }
      if (call.name === 'route_to_specialist') {
        const agentId = String((call.args as { agent_id?: string }).agent_id ?? 'writer');
        const task = String((call.args as { task?: string }).task ?? '').trim();
        pushTranscript('system', `Routing to ${agentId}…`);
        // Hand the visual identity off to the specialist. Visualizer
        // crossfades the orb palette over ~600ms.
        setActiveAgentId(agentId);
        void handoff.runFromToolCall({ agent_id: agentId, task }).then((artifact) => {
          pendingCallsRef.current.set(artifact.runId, call);
        });
        return;
      }
      // Each app action is its own Realtime tool now (e.g. `calendar_create`
      // instead of `control_app({app:"calendar", action:"create", args:{...}})`).
      // That keeps the LLM from dropping the nested `args` object — a known
      // failure mode we hit repeatedly. Map tool name -> (app, action).
      const APP_TOOL_MAP: Record<string, [string, string]> = {
        spotify_play: ['spotify', 'play'],
        spotify_pause: ['spotify', 'pause'],
        spotify_next: ['spotify', 'next'],
        spotify_previous: ['spotify', 'previous'],
        spotify_now_playing: ['spotify', 'now_playing'],
        spotify_play_query: ['spotify', 'play_query'],
        messages_send: ['messages', 'send'],
        mail_compose: ['mail', 'compose'],
        calendar_list_today: ['calendar', 'list_today'],
        calendar_list_range: ['calendar', 'list_range'],
        calendar_create: ['calendar', 'create'],
      };
      if (call.name in APP_TOOL_MAP) {
        const [app, action] = APP_TOOL_MAP[call.name];
        const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
        const label = `${app}.${action}`;
        pushTranscript('system', `${label}…`);
        void executeAppControl(app, action, args)
          .then((res) => {
            pushTranscript('system', `${label} ✓`);
            realtime.sendToolResult(call.callId, JSON.stringify({ status: 'ok', result: res.result }));
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            pushTranscript('system', `${label} failed: ${message}`);
            realtime.sendToolResult(call.callId, JSON.stringify({ status: 'error', error: message }));
          });
        return;
      }
      if (call.name === 'schedule_proactive') {
        const args = call.args as {
          name?: string;
          prompt?: string;
          hour?: number;
          minute?: number;
          days?: string[];
          task_type?: string;
        };
        pushTranscript('system', `Scheduling "${args.name ?? 'task'}"…`);
        void createProactiveTask({
          name: String(args.name ?? '').trim() || 'Scheduled task',
          prompt: String(args.prompt ?? '').trim(),
          hour: Number(args.hour ?? 0),
          minute: Number(args.minute ?? 0),
          days: Array.isArray(args.days) ? args.days.map(String) : [],
          task_type: args.task_type,
        })
          .then((task) => {
            pushTranscript('system', `Scheduled: ${task.name} @ ${String(task.schedule.hour).padStart(2, '0')}:${String(task.schedule.minute).padStart(2, '0')}`);
            realtime.sendToolResult(call.callId, JSON.stringify({ status: 'ok', task }));
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            pushTranscript('system', `Scheduling failed: ${message}`);
            realtime.sendToolResult(call.callId, JSON.stringify({ status: 'error', error: message }));
          });
        return;
      }
      if (call.name === 'list_proactive') {
        void listProactiveTasks()
          .then((tasks) => {
            const summary = tasks.length
              ? tasks
                  .map(
                    (t) =>
                      `${t.name} — ${String(t.schedule.hour).padStart(2, '0')}:${String(t.schedule.minute).padStart(2, '0')} on ${t.schedule.days.join(', ')}`,
                  )
                  .join(' | ')
              : '(no proactive tasks scheduled)';
            pushTranscript('system', `${tasks.length} proactive task${tasks.length === 1 ? '' : 's'}`);
            realtime.sendToolResult(
              call.callId,
              JSON.stringify({ status: 'ok', count: tasks.length, summary, tasks }),
            );
          })
          .catch((err: unknown) => {
            realtime.sendToolResult(
              call.callId,
              JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err) }),
            );
          });
        return;
      }
      if (call.name === 'cancel_proactive') {
        const id = String((call.args as { id?: string }).id ?? '').trim();
        if (!id) {
          realtime.sendToolResult(call.callId, JSON.stringify({ status: 'error', error: 'id required' }));
          return;
        }
        void deleteProactiveTask(id)
          .then(() => {
            pushTranscript('system', `Canceled proactive ${id.slice(0, 8)}`);
            realtime.sendToolResult(call.callId, JSON.stringify({ status: 'ok', id }));
          })
          .catch((err: unknown) => {
            realtime.sendToolResult(
              call.callId,
              JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err) }),
            );
          });
        return;
      }
      if (call.name === 'secretary_place_call') {
        const to = String((call.args as { to?: string }).to ?? '').trim();
        const context = String((call.args as { context?: string }).context ?? '').trim();
        if (!to) {
          realtime.sendToolResult(call.callId, JSON.stringify({ status: 'error', error: 'to required' }));
          return;
        }
        pushTranscript('system', `📞 Placing call to ${to}…`);
        void placeSecretaryCall(to, context)
          .then((res) => {
            pushTranscript('system', `📞 Call placed (sid ${(res.sid || '').slice(0, 8)}). Secretary is on the line.`);
            realtime.sendToolResult(
              call.callId,
              JSON.stringify({ status: 'ok', sid: res.sid, call_status: res.status, to: res.to }),
            );
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            pushTranscript('system', `Call failed: ${message}`);
            realtime.sendToolResult(
              call.callId,
              JSON.stringify({ status: 'error', error: message }),
            );
          });
        return;
      }
    },
  });

  // Auto-connect on mount. Under React StrictMode (dev only), effects get
  // mounted → cleaned up → mounted again to surface accidental state leaks.
  // That means start() → stop() → start() in quick succession. The hook is
  // idempotent against this: stop() fully tears down RTC/mic/data-channel
  // state, and the second start() rebuilds from scratch. We intentionally do
  // NOT guard with hasStartedRef — that guard only survived the first
  // start/stop cycle and then silently skipped the real reconnect, leaving
  // the UI stuck at state="idle" after any dev reload. Two sessions briefly
  // open against OpenAI Realtime in dev is an acceptable tax.
  useEffect(() => {
    void realtime.start();
    return () => {
      realtime.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts:
  //   ⌘/Ctrl + M → toggle mute
  //   Esc        → interrupt the current AI response (only while speaking)
  // Ignored when focus is in an input or textarea so normal typing isn't hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase() ?? '';
      const inEditable = tag === 'input' || tag === 'textarea';
      if ((e.metaKey || e.ctrlKey) && (e.key || '').toLowerCase() === 'm' && !inEditable) {
        e.preventDefault();
        realtime.toggleMute();
        return;
      }
      if (e.key === 'Escape' && realtime.state === 'speaking' && !inEditable) {
        e.preventDefault();
        realtime.interrupt();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [realtime]);

  const onSubmitText = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = textInput.trim();
      if (!text) return;
      pushTranscript('you', text);
      realtime.sendText(text);
      setTextInput('');
    },
    [textInput, realtime, pushTranscript],
  );

  const onReplay = useCallback((artifact: SpecialistArtifact) => {
    void getRunSpeech(artifact.runId, { agentId: artifact.agentId, provider: 'elevenlabs' })
      .then((blob) => {
        const audio = new Audio(URL.createObjectURL(blob));
        void audio.play();
      })
      .catch(() => {});
  }, []);

  // Proactive briefings — polls /proactive every ~45s and surfaces completed
  // scheduled-task outputs in the OutputsRail. Also fires a desktop
  // notification (via the Electron bridge) when a new briefing lands.
  const briefings = useProactiveBriefings({
    onNewlyCompleted: (task) => {
      const preview = (task.last_output_summary || '').slice(0, 180);
      const title = `${task.name} is ready`;
      pushTranscript('system', `Briefing ready: ${task.name}`);
      // Electron bridge — no-op in a plain browser tab.
      window.desktop?.notify?.({ title, body: preview, silent: false });
    },
  });

  const onReplayBriefing = useCallback((task: ProactiveTask) => {
    const runId = task.last_run_id;
    if (!runId) return;
    // The scheduler routes through forced task_type, so the run's speaker_agent
    // will be the specialist (researcher / news / etc). Letting the backend
    // pick the agent voice keeps it consistent with how the run was produced.
    void getRunSpeech(runId, { provider: 'elevenlabs' })
      .then((blob) => {
        const audio = new Audio(URL.createObjectURL(blob));
        void audio.play();
      })
      .catch(() => {});
  }, []);

  const visualizerState = useMemo(() => realtimeToVisualizer(realtime.state), [realtime.state]);
  // Drive the visualizer off whichever side is louder — input while listening, output while speaking.
  const level = Math.max(realtime.inputLevel, realtime.outputLevel);
  // Palette tracks the active speaker. Falls back to cool for any
  // unmapped agent.
  const visualizerPalette: VisualizerPalette = AGENT_PALETTE[activeAgentId] ?? 'cool';
  // While the operator is speaking (state=listening), surface the
  // operator's "voice" with the cool palette — Brain is listening, not
  // a specialist. Same for thinking. Only commit to the specialist
  // palette when the AI is actually speaking back.
  const effectivePalette: VisualizerPalette =
    realtime.state === 'speaking' ? visualizerPalette : 'cool';

  const lastYou = [...transcript].reverse().find((t) => t.role === 'you');
  const lastDelegator = [...transcript].reverse().find((t) => t.role === 'delegator');

  // Voice Stage layout (Option D). Orb-dominant, immersive. Captions
  // float over the orb. Bottom dock auto-hides on cursor proximity.
  // No sidebar (the AppShell strips chrome for this workspace).
  const isCallActive = realtime.state !== 'idle' && realtime.state !== 'error';
  const speakingAgentName = ACTIVE_AGENT_LABELS[activeAgentId] ?? 'Brain';

  return (
    <div className="fixed inset-0 bg-black overflow-hidden font-[Geist,Inter,system-ui]">
      {/* Ambient orb-color wash so the rim of the screen subtly picks up
         the speaker's identity. Sits below everything. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            effectivePalette === 'warm'
              ? 'radial-gradient(ellipse at 50% 50%, rgba(255, 80, 130, 0.05), rgba(0,0,0,0) 65%)'
              : 'radial-gradient(ellipse at 50% 50%, rgba(80, 180, 255, 0.05), rgba(0,0,0,0) 65%)',
        }}
      />

      {/* Top-left: agent tag with state + name + elapsed time. */}
      <div className="absolute top-6 left-6 z-20 flex items-center gap-2.5 text-[12px] font-medium text-white/55">
        <span
          aria-hidden
          className={cn(
            'h-2 w-2 rounded-full',
            realtime.state === 'listening' && 'bg-emerald-400',
            realtime.state === 'thinking' && 'bg-amber-300 animate-pulse motion-reduce:animate-none',
            realtime.state === 'speaking' && (effectivePalette === 'warm' ? 'bg-pink-400' : 'bg-cyan-300') + ' animate-pulse motion-reduce:animate-none',
            realtime.state === 'connecting' && 'bg-amber-400 animate-pulse motion-reduce:animate-none',
            (realtime.state === 'idle' || realtime.state === 'error') && 'bg-white/30',
          )}
        />
        <span className="tracking-wide">{speakingAgentName}</span>
        <span className="opacity-30">·</span>
        <span className="tracking-wide font-normal">{stateLabel(realtime.state)}</span>
        {realtime.error ? (
          <span className="ml-2 text-rose-400 font-normal">· {realtime.error}</span>
        ) : null}
      </div>

      {/* The orb — fills as much of the viewport as it can. */}
      <div className="absolute inset-0 grid place-items-center z-0">
        <div className="w-[min(86vmin,720px)] h-[min(86vmin,720px)]">
          <HumanoidVisualizer state={visualizerState} level={level} palette={effectivePalette} />
        </div>
      </div>

      {/* Captions overlay — last user utterance + last AI reply. Floats over the orb at ~70% from top. */}
      <div className="absolute left-1/2 top-[68%] -translate-x-1/2 z-10 max-w-[760px] w-[min(90vw,760px)] px-6 text-center pointer-events-none">
        {lastYou ? (
          <p className="text-[15px] leading-snug text-white/40 mb-3 font-normal">
            "{lastYou.text}"
          </p>
        ) : null}
        {lastDelegator ? (
          <>
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/40 mb-2 font-medium">
              {speakingAgentName}
            </p>
            <p className="text-[19px] leading-relaxed text-white/95 font-normal">
              {lastDelegator.text}
            </p>
          </>
        ) : null}
        {!lastYou && !lastDelegator ? (
          <p className="text-[14px] text-white/30">
            {realtime.state === 'idle'
              ? 'Press Connect to start.'
              : realtime.state === 'connecting'
                ? 'Connecting…'
                : 'Listening.'}
          </p>
        ) : null}
      </div>

      {/* Bottom dock — controls. Always visible while connecting/idle so
          first-run users see "Connect"; auto-hides during active call
          unless cursor is near bottom. */}
      <div
        className={cn(
          'absolute left-1/2 -translate-x-1/2 z-20',
          'transition-all duration-200 ease-out',
          isCallActive
            ? 'bottom-8 opacity-50 hover:opacity-100 group'
            : 'bottom-10 opacity-100',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-1 p-1.5',
            'bg-white/[0.04] backdrop-blur-xl',
            'border border-white/[0.08]',
            'rounded-full',
            'shadow-[0_8px_32px_rgba(0,0,0,0.4)]',
          )}
        >
          {realtime.state === 'idle' || realtime.state === 'error' ? (
            <button
              type="button"
              onClick={() => void realtime.start()}
              className={cn(
                'h-11 px-5 rounded-full',
                'flex items-center gap-2',
                'text-[13px] font-medium',
                'bg-white text-black hover:bg-white/90',
                'transition-colors duration-150',
              )}
            >
              <Mic size={14} aria-hidden />
              <span>Connect</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => realtime.toggleMute()}
                aria-pressed={realtime.muted}
                title={realtime.muted ? 'Unmute (⌘M)' : 'Mute (⌘M)'}
                className={cn(
                  'h-11 w-11 rounded-full grid place-items-center',
                  'transition-colors duration-150',
                  realtime.muted
                    ? 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30'
                    : 'text-white/70 hover:text-white hover:bg-white/[0.06]',
                )}
              >
                {realtime.muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
              </button>
              {realtime.state === 'speaking' ? (
                <button
                  type="button"
                  onClick={() => realtime.interrupt()}
                  title="Interrupt (Esc)"
                  className={cn(
                    'h-11 w-11 rounded-full grid place-items-center',
                    'text-white/70 hover:text-white hover:bg-white/[0.06]',
                    'transition-colors duration-150',
                  )}
                >
                  <Square size={14} aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => realtime.stop()}
                title="End call"
                className={cn(
                  'h-11 px-5 rounded-full',
                  'flex items-center gap-2',
                  'text-[13px] font-medium',
                  'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 hover:text-rose-200',
                  'transition-colors duration-150',
                )}
              >
                <X size={14} aria-hidden />
                <span>End</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Text composer — minimal, bottom-right, always available for typing
          when voice isn't enough. Hidden when no call. */}
      {isCallActive ? (
        <form
          onSubmit={onSubmitText}
          className="absolute bottom-8 right-8 z-20 w-[min(360px,42vw)]"
        >
          <div
            className={cn(
              'flex items-center gap-1 px-1 pl-3',
              'bg-white/[0.04] backdrop-blur-xl',
              'border border-white/[0.08]',
              'rounded-full',
              'transition-all duration-150',
              'focus-within:border-white/20 focus-within:bg-white/[0.06]',
            )}
          >
            <input
              type="text"
              placeholder="Or type instead…"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              aria-label="Type to the delegator"
              className="flex-1 bg-transparent border-0 outline-none text-[13px] text-white/90 placeholder:text-white/30 py-2.5"
            />
            <button
              type="submit"
              disabled={!textInput.trim()}
              className={cn(
                'h-9 w-9 rounded-full grid place-items-center',
                'text-white/60 hover:text-white hover:bg-white/[0.06]',
                'disabled:text-white/20 disabled:hover:bg-transparent',
                'transition-colors duration-150',
              )}
            >
              <Send size={14} aria-hidden />
            </button>
          </div>
        </form>
      ) : null}
      {/* Hide-from-eyes-but-keep-the-logic — face/handoff/briefings still
         tracked but not rendered in Voice Stage; they live on the
         right-rail in the future Admin Mode redesign. */}
      <div className="hidden">
        <span>{faceOn ? 'face' : ''}</span>
        <OutputsRail
          artifacts={handoff.artifacts}
          onDismiss={handoff.dismissArtifact}
          onReplay={onReplay}
          briefings={briefings.briefings}
          onReplayBriefing={onReplayBriefing}
        />
      </div>
    </div>
  );
}
