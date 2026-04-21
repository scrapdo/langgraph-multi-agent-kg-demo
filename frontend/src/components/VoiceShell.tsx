import { Mic, MicOff, Send, Square, User2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createProactiveTask,
  deleteProactiveTask,
  executeAppControl,
  getRunSpeech,
  listProactiveTasks,
  quickLookup,
  type ProactiveTask,
} from '../api/client';
import { useProactiveBriefings } from '../lib/useProactiveBriefings';
import { useRealtimeAgent, type RealtimeState, type RealtimeToolCall } from '../lib/useRealtimeAgent';
import { useSpecialistHandoff, type SpecialistArtifact } from '../lib/useSpecialistHandoff';
import { Badge, Button, Card, Input, cn } from '../ui';
import { HumanoidVisualizer, type VisualizerState } from './HumanoidVisualizer';
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
    },
    onFailed: (artifact, message) => {
      pushTranscript('system', `${artifact.agentLabel} failed: ${message}`);
      const pendingEntry = pendingCallsRef.current.get(artifact.runId);
      if (pendingEntry) {
        pendingCallsRef.current.delete(artifact.runId);
        realtime.sendToolResult(pendingEntry.callId, JSON.stringify({ status: 'failed', error: message }));
      }
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

  const lastYou = [...transcript].reverse().find((t) => t.role === 'you');
  const lastDelegator = [...transcript].reverse().find((t) => t.role === 'delegator');

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5 min-h-[calc(100vh-4rem)]">
      <div className="relative flex flex-col">
        {/* Ambient wash behind the visualizer. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at 50% 40%, rgba(41, 216, 255, 0.05), rgba(7, 10, 15, 0) 60%)',
          }}
        />

        {/* Header — status, face toggle, error. */}
        <div className="relative z-10 flex items-center justify-between px-1 py-2">
          <div className="flex items-center gap-3 text-[var(--text-xs)] font-mono uppercase tracking-wider">
            <span
              aria-hidden
              className={cn(
                'h-2 w-2 rounded-full',
                realtime.state === 'listening' && 'bg-emerald-400',
                realtime.state === 'thinking' && 'bg-violet-400 animate-pulse motion-reduce:animate-none',
                realtime.state === 'speaking' && 'bg-cyan-400 animate-pulse motion-reduce:animate-none',
                realtime.state === 'connecting' && 'bg-amber-400 animate-pulse motion-reduce:animate-none',
                (realtime.state === 'idle' || realtime.state === 'error') && 'bg-[var(--color-fg-subtle)]',
              )}
            />
            <span className="text-[var(--color-fg-muted)]">{stateLabel(realtime.state)}</span>
            {realtime.error ? (
              <Badge tone="danger" size="sm">
                {realtime.error}
              </Badge>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {realtime.state === 'speaking' ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => realtime.interrupt()}
                title="Stop the current response (Esc)"
              >
                <Square size={12} aria-hidden />
                Stop
              </Button>
            ) : null}
            {realtime.state !== 'idle' && realtime.state !== 'error' ? (
              <Button
                size="sm"
                variant={realtime.muted ? 'danger' : 'ghost'}
                onClick={() => realtime.toggleMute()}
                aria-pressed={realtime.muted}
                title={
                  realtime.muted
                    ? 'Mic muted — click to unmute (⌘M)'
                    : 'Mute mic (⌘M). AI stops listening.'
                }
              >
                {realtime.muted ? <MicOff size={12} aria-hidden /> : <Mic size={12} aria-hidden />}
                {realtime.muted ? 'Muted' : 'Mute'}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={faceOn ? 'primary' : 'ghost'}
              onClick={() => setFaceOn((v) => !v)}
              aria-pressed={faceOn}
              title="Show a humanoid face for the delegator (preview)"
            >
              <User2 size={12} aria-hidden />
              Face
            </Button>
            {realtime.state === 'idle' || realtime.state === 'error' ? (
              <Button size="sm" variant="primary" onClick={() => void realtime.start()}>
                <Mic size={12} aria-hidden />
                Connect
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => realtime.stop()}>
                <MicOff size={12} aria-hidden />
                Disconnect
              </Button>
            )}
          </div>
        </div>

        {/* Visualizer. */}
        <div className="relative z-10 flex-1 min-h-[420px] grid place-items-center">
          <div className="w-full max-w-[560px] aspect-square">
            {faceOn ? (
              <div className="w-full h-full grid place-items-center rounded-[var(--radius-lg)] bg-[var(--color-bg-surface)] border border-[var(--color-border-subtle)] text-center p-6">
                <div>
                  <p className="text-[var(--text-sm)] font-medium">Humanoid face preview</p>
                  <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-1">
                    Streaming avatar is not wired up yet. Toggle off to return to the ethereal visualizer.
                  </p>
                  <button
                    type="button"
                    className="mt-3 text-[var(--text-xs)] text-[var(--color-accent)] underline"
                    onClick={() => setFaceOn(false)}
                  >
                    Hide face
                  </button>
                </div>
              </div>
            ) : (
              <HumanoidVisualizer state={visualizerState} level={level} />
            )}
          </div>
        </div>

        {/* Last turn. */}
        <div className="relative z-10 max-w-[720px] w-full mx-auto px-4 space-y-2">
          {lastYou ? (
            <p className="text-right text-[var(--text-sm)] text-[var(--color-fg-subtle)]">
              <span className="font-mono text-[10px] uppercase tracking-wider mr-2">you</span>
              {lastYou.text}
            </p>
          ) : null}
          {lastDelegator ? (
            <p className="text-[var(--text-base)] leading-relaxed text-[var(--color-fg-default)]">
              {lastDelegator.text}
            </p>
          ) : null}
        </div>

        {/* Text composer — goes through the same delegator. */}
        <form
          onSubmit={onSubmitText}
          className="relative z-10 mt-4 max-w-[720px] w-full mx-auto px-2 pb-2"
        >
          <div className="flex items-center gap-2">
            <Input
              placeholder="Type to the delegator — or just speak."
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              aria-label="Type to the delegator"
            />
            <Button type="submit" size="md" variant="primary" disabled={!textInput.trim()}>
              <Send size={14} aria-hidden />
              Send
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-[var(--color-fg-subtle)] font-mono uppercase tracking-wider">
            The delegator picks the right specialist and hands off automatically.
          </p>
        </form>

        {/* Micro-transcript (last few lines, scroll-less). */}
        <div className="relative z-10 max-w-[720px] w-full mx-auto px-2 mt-2">
          <Card className="p-2 max-h-[140px] overflow-y-auto">
            <ul className="space-y-1 text-[var(--text-xs)]">
              {transcript.slice(-6).map((entry) => (
                <li key={entry.id} className="flex gap-2">
                  <span className="font-mono uppercase tracking-wider w-16 flex-none text-[var(--color-fg-subtle)]">
                    {entry.role === 'you'
                      ? 'you'
                      : entry.role === 'delegator'
                        ? 'coord.'
                        : entry.role === 'specialist'
                          ? 'spec.'
                          : 'sys'}
                  </span>
                  <span
                    className={cn(
                      'min-w-0',
                      entry.role === 'system'
                        ? 'text-[var(--color-fg-subtle)]'
                        : 'text-[var(--color-fg-default)]',
                    )}
                  >
                    {entry.text}
                  </span>
                </li>
              ))}
              {transcript.length === 0 ? (
                <li className="text-[var(--color-fg-subtle)]">
                  <X size={10} className="inline mr-1" aria-hidden />
                  Waiting — start speaking or type a message.
                </li>
              ) : null}
            </ul>
          </Card>
        </div>
      </div>

      {/* Right rail — team outputs. */}
      <div className="h-full min-h-[600px]">
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
