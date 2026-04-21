/**
 * WebRTC client for OpenAI's Realtime API.
 *
 * Flow:
 *   1. Ask our backend to mint an ephemeral session (never expose the long-lived key).
 *   2. Create an RTCPeerConnection, attach mic audio, open a data channel for control events.
 *   3. POST the local SDP offer to OpenAI with the ephemeral bearer; set the SDP answer.
 *   4. Inbound: remote audio track plays through a hidden <audio>, JSON events come over the data channel.
 *   5. Outbound tool results and text prompts are sent as JSON events back over the data channel.
 *
 * The hook exposes two amplitude signals (mic + remote output) so the visualizer can react to
 * both sides of the conversation, plus `sendText` and `sendToolResult` for the typed-prompt
 * path and the specialist-handoff loop.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRealtimeSession, type RealtimeSession } from '../api/client';

export type RealtimeState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface RealtimeToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

interface HookOptions {
  /** Called for every completed function_call from the model. */
  onToolCall?: (call: RealtimeToolCall) => void;
  /** Called every time the model finishes an assistant audio/text turn. */
  onAssistantText?: (text: string) => void;
  /** Called for each finalized user transcript (what the mic heard). */
  onUserTranscript?: (text: string) => void;
}

export interface UseRealtimeAgentResult {
  state: RealtimeState;
  /** 0-1 average amplitude of the remote (assistant) output audio. */
  outputLevel: number;
  /** 0-1 average amplitude of the microphone input. */
  inputLevel: number;
  error: string | null;
  session: RealtimeSession | null;
  /** True when the outbound mic track is disabled (AI can't hear you). */
  muted: boolean;
  start: () => Promise<void>;
  stop: () => void;
  /** Enable/disable the local mic track. While muted, audio is not sent to OpenAI. */
  setMuted: (muted: boolean) => void;
  toggleMute: () => void;
  /** Send a typed message to the delegator and trigger a response. */
  sendText: (text: string) => void;
  /** Return a tool result (function_call_output) and ask the model to continue. */
  sendToolResult: (callId: string, output: string) => void;
  /** Ask the model to continue without adding a new user message — e.g. after a tool result. */
  requestResponse: () => void;
  /** Temporarily silence the assistant's current turn (cancel response). */
  interrupt: () => void;
}

const REALTIME_BASE = 'https://api.openai.com/v1/realtime';

function clamp01(v: number) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function rms(buffer: Uint8Array): number {
  // buffer contains byte-frequency data 0..255 — average amplitude proxy.
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const v = (buffer[i] - 128) / 128;
    sum += v * v;
  }
  return clamp01(Math.sqrt(sum / buffer.length) * 2.2);
}

export function useRealtimeAgent(options: HookOptions = {}): UseRealtimeAgentResult {
  const { onToolCall, onAssistantText, onUserTranscript } = options;

  const [state, setState] = useState<RealtimeState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<RealtimeSession | null>(null);
  const [outputLevel, setOutputLevel] = useState(0);
  const [inputLevel, setInputLevel] = useState(0);
  const [muted, setMutedState] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const stateRef = useRef<RealtimeState>('idle');
  const partialAssistantRef = useRef<string>('');
  /** Guards start() against React StrictMode dev double-invocation. */
  const connectingRef = useRef<boolean>(false);

  const handlersRef = useRef<HookOptions>(options);
  useEffect(() => {
    handlersRef.current = { onToolCall, onAssistantText, onUserTranscript };
  }, [onToolCall, onAssistantText, onUserTranscript]);

  const updateState = useCallback((next: RealtimeState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // ---- analyser loop ----------------------------------------------------
  const startAnalyserLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = () => {
      const micAn = micAnalyserRef.current;
      const outAn = outAnalyserRef.current;
      if (micAn) {
        const buf = new Uint8Array(micAn.fftSize);
        micAn.getByteTimeDomainData(buf);
        setInputLevel(rms(buf));
      }
      if (outAn) {
        const buf = new Uint8Array(outAn.fftSize);
        outAn.getByteTimeDomainData(buf);
        setOutputLevel(rms(buf));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // ---- data channel -----------------------------------------------------
  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify(event));
  }, []);

  const handleRealtimeEvent = useCallback(
    (msg: Record<string, unknown>) => {
      const type = String(msg.type ?? '');
      switch (type) {
        case 'input_audio_buffer.speech_started':
          updateState('listening');
          break;
        case 'input_audio_buffer.speech_stopped':
          updateState('thinking');
          break;
        case 'response.audio.delta':
          if (stateRef.current !== 'speaking') updateState('speaking');
          break;
        case 'response.audio_transcript.delta': {
          const delta = String((msg as { delta?: string }).delta ?? '');
          if (delta) partialAssistantRef.current += delta;
          break;
        }
        case 'response.audio_transcript.done': {
          const text = partialAssistantRef.current.trim();
          partialAssistantRef.current = '';
          if (text && handlersRef.current.onAssistantText) handlersRef.current.onAssistantText(text);
          break;
        }
        case 'response.done': {
          if (stateRef.current !== 'listening') updateState('listening');
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const transcript = String((msg as { transcript?: string }).transcript ?? '').trim();
          if (transcript && handlersRef.current.onUserTranscript) {
            handlersRef.current.onUserTranscript(transcript);
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const callId = String((msg as { call_id?: string }).call_id ?? '');
          const name = String((msg as { name?: string }).name ?? '');
          const rawArgs = String((msg as { arguments?: string }).arguments ?? '{}');
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = { raw: rawArgs };
          }
          if (callId && name && handlersRef.current.onToolCall) {
            handlersRef.current.onToolCall({ callId, name, args });
          }
          break;
        }
        case 'error': {
          const errMsg = (msg as { error?: { message?: string } }).error?.message ?? 'Realtime error';
          setError(errMsg);
          break;
        }
        default:
          // Silent — many event types we don't need right now.
          break;
      }
    },
    [updateState],
  );

  // ---- lifecycle --------------------------------------------------------
  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      dcRef.current?.close();
    } catch {
      /* ignore */
    }
    dcRef.current = null;
    try {
      pcRef.current?.close();
    } catch {
      /* ignore */
    }
    pcRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current.remove();
      audioElRef.current = null;
    }
    try {
      audioCtxRef.current?.close();
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null;
    micAnalyserRef.current = null;
    outAnalyserRef.current = null;
    setOutputLevel(0);
    setInputLevel(0);
    setMutedState(false);
    updateState('idle');
  }, [updateState]);

  const start = useCallback(async () => {
    if (pcRef.current || connectingRef.current) return;
    connectingRef.current = true;
    setError(null);
    updateState('connecting');
    try {
      const sess = await createRealtimeSession();
      setSession(sess);
      const ephemeral = sess.client_secret?.value;
      if (!ephemeral) throw new Error('No ephemeral secret returned from backend');

      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Remote audio element for playback.
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      audioElRef.current = audioEl;

      pc.ontrack = (ev) => {
        audioEl.srcObject = ev.streams[0];
        // Wire an analyser for the incoming assistant audio so the visualizer can react.
        try {
          if (!audioCtxRef.current) {
            const AudioCtor =
              window.AudioContext ||
              (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (AudioCtor) audioCtxRef.current = new AudioCtor();
          }
          const ctx = audioCtxRef.current;
          if (ctx) {
            const srcNode = ctx.createMediaStreamSource(ev.streams[0]);
            const an = ctx.createAnalyser();
            an.fftSize = 1024;
            srcNode.connect(an);
            outAnalyserRef.current = an;
            startAnalyserLoop();
          }
        } catch {
          // Playback still works; we just lose output-level reactivity.
        }
      };

      // Data channel for JSON events in both directions.
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;
      dc.onopen = () => {
        updateState('listening');
      };
      dc.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data);
          if (parsed && typeof parsed === 'object') {
            handleRealtimeEvent(parsed as Record<string, unknown>);
          }
        } catch {
          /* non-JSON event */
        }
      };
      dc.onerror = () => setError('Realtime data channel error');

      // Mic.
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;
      micStream.getTracks().forEach((track) => pc.addTrack(track, micStream));

      // Mic analyser so we can drive the visualizer off the user's voice too.
      try {
        const AudioCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtor) {
          if (!audioCtxRef.current) audioCtxRef.current = new AudioCtor();
          const ctx = audioCtxRef.current;
          const srcNode = ctx.createMediaStreamSource(micStream);
          const an = ctx.createAnalyser();
          an.fftSize = 1024;
          srcNode.connect(an);
          micAnalyserRef.current = an;
          startAnalyserLoop();
        }
      } catch {
        // OK — fall back to no mic-level signal.
      }

      // SDP offer → OpenAI → SDP answer.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(`${REALTIME_BASE}?model=${encodeURIComponent(sess.model)}`, {
        method: 'POST',
        body: offer.sdp ?? '',
        headers: {
          Authorization: `Bearer ${ephemeral}`,
          'Content-Type': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
        },
      });
      if (!sdpResponse.ok) {
        const text = await sdpResponse.text();
        throw new Error(`Realtime SDP exchange failed (${sdpResponse.status}): ${text.slice(0, 200)}`);
      }
      const answer = { type: 'answer' as RTCSdpType, sdp: await sdpResponse.text() };
      await pc.setRemoteDescription(answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      updateState('error');
      stop();
    } finally {
      connectingRef.current = false;
    }
  }, [handleRealtimeEvent, startAnalyserLoop, stop, updateState]);

  const sendText = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: trimmed }],
        },
      });
      sendEvent({ type: 'response.create' });
    },
    [sendEvent],
  );

  const sendToolResult = useCallback(
    (callId: string, output: string) => {
      sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output,
        },
      });
      sendEvent({ type: 'response.create' });
    },
    [sendEvent],
  );

  const requestResponse = useCallback(() => {
    sendEvent({ type: 'response.create' });
  }, [sendEvent]);

  const interrupt = useCallback(() => {
    sendEvent({ type: 'response.cancel' });
  }, [sendEvent]);

  const setMuted = useCallback((next: boolean) => {
    const stream = micStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !next;
      }
    }
    setMutedState(next);
    // Also clear any partial speech buffer OpenAI may have already received so
    // we don't accidentally commit half-heard dog/TV audio when unmuting.
    if (next) {
      sendEvent({ type: 'input_audio_buffer.clear' });
    }
  }, [sendEvent]);

  const toggleMute = useCallback(() => {
    setMuted(!muted);
  }, [muted, setMuted]);

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    state,
    outputLevel,
    inputLevel,
    error,
    session,
    muted,
    start,
    stop,
    setMuted,
    toggleMute,
    sendText,
    sendToolResult,
    requestResponse,
    interrupt,
  };
}
