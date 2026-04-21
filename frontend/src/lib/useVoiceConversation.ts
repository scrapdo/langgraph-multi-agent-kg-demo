import { useCallback, useEffect, useRef, useState } from 'react';
import { getRun, getRunSpeech, startRun, streamEvents } from '../api/client';

type RecognitionCtor = new () => SpeechRecognition;

export type ConversationState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  at: string;
}

export interface UseVoiceConversationOptions {
  provider?: 'elevenlabs' | 'openai' | 'parler' | 'browser';
  voice?: string;
  premiumVoiceId?: string;
  profile?: string;
  persona?: string;
  /** RMS threshold above which we treat the mic as "voiced". 0-1. */
  voiceThreshold?: number;
  /** RMS threshold below which we treat the mic as "silent". 0-1. */
  silenceThreshold?: number;
  /** Trailing-silence duration before submitting (ms). */
  trailingMs?: number;
  /** Minimum continuous voiced duration before we treat it as speech onset (ms). */
  onsetMs?: number;
}

export interface UseVoiceConversationResult {
  state: ConversationState;
  level: number;
  transcript: string;
  messages: ConversationMessage[];
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  interrupt: () => void;
}

function uuid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractOutputFromState(state: Record<string, unknown>): string {
  for (const key of ['final_answer', 'final_response', 'answer', 'output', 'response', 'final_report']) {
    const value = state[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Full conversational voice loop with real voice-activity detection.
 *
 *   listen → (VAD end-of-utterance) → submit run → thinking → TTS → speaking → listen
 *
 * During playback, the mic analyser keeps running so that when the user starts
 * speaking audibly the TTS is cut and the loop returns to listening.
 *
 * Thresholds are time-domain RMS on a 0-1 scale; ``level`` follows whichever
 * source is currently "primary" (mic when listening/thinking, TTS when speaking).
 */
export function useVoiceConversation(options: UseVoiceConversationOptions = {}): UseVoiceConversationResult {
  const {
    provider: providerOverride,
    voice: voiceOverride,
    premiumVoiceId: premiumOverride,
    profile: profileOverride,
    persona: personaOverride,
    voiceThreshold = 0.1,
    silenceThreshold = 0.035,
    trailingMs = 650,
    onsetMs = 140,
  } = options;

  const [state, setState] = useState<ConversationState>('idle');
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const shouldListenRef = useRef(false);
  const lastFinalRef = useRef('');
  const stateRef = useRef<ConversationState>('idle');

  // VAD refs — live state tracked across animation frames.
  type VadPhase = 'silent' | 'voiced' | 'trailing';
  const vadPhaseRef = useRef<VadPhase>('silent');
  const vadVoicedSinceRef = useRef<number>(0);
  const vadSilenceSinceRef = useRef<number>(0);
  const hadSpeechRef = useRef(false);
  const pendingSubmitRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const Ctor =
    (typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null) as RecognitionCtor | null;
  const supported = Boolean(Ctor);

  // Forward-declared so callbacks below can call into it.
  const submitTranscriptRef = useRef<() => Promise<void>>(async () => {});

  // ------- Audio graph setup -------
  const ensureAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtxRef.current = new Ctor();
    }
    return audioCtxRef.current;
  }, []);

  const attachMicAnalyser = useCallback((stream: MediaStream) => {
    const ctx = ensureAudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.3; // responsive — VAD wants speed
    ctx.createMediaStreamSource(stream).connect(analyser);
    micAnalyserRef.current = analyser;
  }, [ensureAudioContext]);

  const attachAudioAnalyser = useCallback((audio: HTMLAudioElement) => {
    const ctx = ensureAudioContext();
    if (audioNodeRef.current) {
      try {
        audioNodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      audioNodeRef.current = null;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    const node = ctx.createMediaElementSource(audio);
    node.connect(analyser);
    node.connect(ctx.destination);
    audioNodeRef.current = node;
    audioAnalyserRef.current = analyser;
  }, [ensureAudioContext]);

  const detachAudioAnalyser = useCallback(() => {
    audioAnalyserRef.current = null;
  }, []);

  // Compute RMS (0-1) from time-domain samples.
  const readRms = useCallback((analyser: AnalyserNode | null): number => {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 2.4);
  }, []);

  // Main frame loop: updates level, runs VAD, drives barge-in.
  const startMeter = useCallback(() => {
    if (levelRafRef.current) return;
    const tick = () => {
      const mic = readRms(micAnalyserRef.current);
      const aud = readRms(audioAnalyserRef.current);
      const st = stateRef.current;

      // Primary display level.
      if (st === 'speaking') setLevel(Math.max(aud, mic * 0.6));
      else if (st === 'listening' || st === 'thinking') setLevel(mic);
      else setLevel(0);

      // VAD on mic signal — active whenever we care about user speech.
      if (st === 'listening' || st === 'speaking') {
        const now = performance.now();
        if (mic >= voiceThreshold) {
          if (vadPhaseRef.current === 'silent') {
            vadVoicedSinceRef.current = now;
          }
          vadPhaseRef.current = 'voiced';
          vadSilenceSinceRef.current = 0;
        } else if (mic <= silenceThreshold) {
          if (vadPhaseRef.current === 'voiced') {
            // Confirm the prior voiced segment counted as speech if it was long enough.
            const voicedFor = now - vadVoicedSinceRef.current;
            if (voicedFor >= onsetMs) {
              hadSpeechRef.current = true;
              // Barge-in: if the assistant was speaking, cut it here.
              if (st === 'speaking' && audioElRef.current) {
                try {
                  audioElRef.current.pause();
                  audioElRef.current.currentTime = 0;
                } catch {
                  /* ignore */
                }
                setState('listening');
              }
            }
            vadPhaseRef.current = 'trailing';
            vadSilenceSinceRef.current = now;
          } else if (vadPhaseRef.current === 'trailing') {
            const trailingFor = now - vadSilenceSinceRef.current;
            if (
              trailingFor >= trailingMs &&
              hadSpeechRef.current &&
              stateRef.current === 'listening' &&
              !runningRef.current &&
              !pendingSubmitRef.current
            ) {
              pendingSubmitRef.current = true;
              // Let one more frame settle before firing.
              void submitTranscriptRef.current();
            }
          }
        }
        // mic between silence and voice thresholds: hold state (hysteresis).
      } else {
        // Reset VAD when we're not actively gated on user speech.
        vadPhaseRef.current = 'silent';
        vadVoicedSinceRef.current = 0;
        vadSilenceSinceRef.current = 0;
        hadSpeechRef.current = false;
        pendingSubmitRef.current = false;
      }

      levelRafRef.current = requestAnimationFrame(tick);
    };
    levelRafRef.current = requestAnimationFrame(tick);
  }, [onsetMs, readRms, silenceThreshold, trailingMs, voiceThreshold]);

  const stopMeter = useCallback(() => {
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current);
    levelRafRef.current = null;
    setLevel(0);
  }, []);

  // ------- Speech recognition -------
  const ensureRecognition = useCallback(() => {
    if (!Ctor) return null;
    if (recognitionRef.current) return recognitionRef.current;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';

    r.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i];
        if (piece.isFinal) final += piece[0].transcript;
        else interim += piece[0].transcript;
      }
      if (final) lastFinalRef.current = (lastFinalRef.current + final).trim() + ' ';
      const combined = (lastFinalRef.current + interim).trim();
      if (combined) setTranscript(combined);
      if (combined) hadSpeechRef.current = true;
    };

    r.onend = () => {
      if (shouldListenRef.current && stateRef.current === 'listening') {
        try {
          r.start();
        } catch {
          /* ignore */
        }
      }
    };

    r.onerror = (evt: SpeechRecognitionErrorEvent) => {
      if (evt.error === 'aborted' || evt.error === 'no-speech') return;
      setError(`Voice recognition: ${evt.error}`);
    };

    recognitionRef.current = r;
    return r;
  }, [Ctor]);

  // ------- Submission + playback -------
  const submitTranscript = useCallback(async () => {
    if (runningRef.current) return;
    const text = (lastFinalRef.current || transcript).trim();
    if (!text) {
      pendingSubmitRef.current = false;
      return;
    }
    runningRef.current = true;
    setTranscript('');
    lastFinalRef.current = '';
    hadSpeechRef.current = false;
    setMessages((prev) => [...prev, { id: uuid(), role: 'user', text, at: new Date().toISOString() }]);
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }

    setState('thinking');
    try {
      const response = await startRun(text, 'live');
      activeRunIdRef.current = response.run_id;
      try {
        eventSourceRef.current?.close();
        eventSourceRef.current = streamEvents(response.run_id, () => {});
      } catch {
        /* ignore */
      }

      let output = '';
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const detail = await getRun(response.run_id);
        if (detail.status === 'completed') {
          output = detail.output?.trim() || extractOutputFromState((detail.state ?? {}) as Record<string, unknown>);
          break;
        }
        if (detail.status === 'failed' || detail.status === 'degraded') {
          output = detail.output?.trim() || 'I ran into an issue answering that.';
          break;
        }
      }
      if (!output) output = "I couldn't produce an answer in time — try again?";

      setMessages((prev) => [...prev, { id: uuid(), role: 'assistant', text: output, at: new Date().toISOString() }]);

      try {
        // Pick per-specialist voice settings from the run state so the
        // speaking agent actually sounds like the speaking agent.
        const state = ((await getRun(response.run_id)).state ?? {}) as Record<string, unknown>;
        const speakerAgent = (state.speaker_agent as string | undefined) ?? 'writer';
        const agentProfiles = (state.agent_profiles as Record<string, Record<string, unknown>> | undefined) ?? {};
        const agent = agentProfiles[speakerAgent] || {};
        const opts = {
          agentId: speakerAgent,
          provider: providerOverride ?? (agent.speech_provider as string | undefined) ?? 'elevenlabs',
          voice: voiceOverride ?? (agent.speech_voice as string | undefined),
          premiumVoiceId: premiumOverride ?? (agent.premium_voice_id as string | undefined),
          profile: profileOverride ?? (agent.speech_style as string | undefined),
          persona: personaOverride ?? (agent.speech_persona as string | undefined),
        };
        const blob = await getRunSpeech(response.run_id, opts);
        const url = URL.createObjectURL(blob);
        if (audioElRef.current) {
          try {
            audioElRef.current.pause();
          } catch {
            /* ignore */
          }
        }
        const audio = new Audio(url);
        audioElRef.current = audio;
        attachAudioAnalyser(audio);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          detachAudioAnalyser();
          runningRef.current = false;
          pendingSubmitRef.current = false;
          audioElRef.current = null;
          if (shouldListenRef.current) {
            setState('listening');
            void resumeListening();
          } else {
            setState('idle');
          }
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          detachAudioAnalyser();
          runningRef.current = false;
          pendingSubmitRef.current = false;
          setState(shouldListenRef.current ? 'listening' : 'idle');
          void resumeListening();
        };
        setState('speaking');
        await audio.play();
      } catch (err) {
        runningRef.current = false;
        pendingSubmitRef.current = false;
        setError(err instanceof Error ? err.message : 'Voice playback failed');
        setState(shouldListenRef.current ? 'listening' : 'idle');
        void resumeListening();
      }
    } catch (err) {
      runningRef.current = false;
      pendingSubmitRef.current = false;
      setError(err instanceof Error ? err.message : 'Run failed');
      setState(shouldListenRef.current ? 'listening' : 'idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachAudioAnalyser, detachAudioAnalyser, personaOverride, premiumOverride, profileOverride, providerOverride, transcript, voiceOverride]);

  useEffect(() => {
    submitTranscriptRef.current = submitTranscript;
  }, [submitTranscript]);

  // ------- Lifecycle helpers -------
  const resumeListening = useCallback(async () => {
    if (!shouldListenRef.current) return;
    const r = ensureRecognition();
    if (r) {
      try {
        r.start();
      } catch {
        /* already started */
      }
    }
  }, [ensureRecognition]);

  const start = useCallback(async () => {
    if (!supported) {
      setError('This environment has no speech recognition API.');
      return;
    }
    setError(null);
    shouldListenRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      attachMicAnalyser(stream);
      startMeter();
    } catch (err) {
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone access denied — enable it in System Settings → Privacy → Microphone.'
          : 'Could not open microphone.',
      );
      shouldListenRef.current = false;
      return;
    }
    setState('listening');
    const r = ensureRecognition();
    if (r) {
      try {
        r.start();
      } catch {
        /* ignore */
      }
    }
  }, [attachMicAnalyser, ensureRecognition, startMeter, supported]);

  const stop = useCallback(() => {
    shouldListenRef.current = false;
    runningRef.current = false;
    pendingSubmitRef.current = false;
    hadSpeechRef.current = false;
    try {
      recognitionRef.current?.abort();
    } catch {
      /* ignore */
    }
    if (audioElRef.current) {
      try {
        audioElRef.current.pause();
      } catch {
        /* ignore */
      }
      audioElRef.current = null;
    }
    try {
      eventSourceRef.current?.close();
    } catch {
      /* ignore */
    }
    detachAudioAnalyser();
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    stopMeter();
    micAnalyserRef.current = null;
    setState('idle');
    setTranscript('');
    lastFinalRef.current = '';
  }, [detachAudioAnalyser, stopMeter]);

  const interrupt = useCallback(() => {
    if (audioElRef.current) {
      try {
        audioElRef.current.pause();
      } catch {
        /* ignore */
      }
      audioElRef.current = null;
    }
    detachAudioAnalyser();
    runningRef.current = false;
    pendingSubmitRef.current = false;
    setState(shouldListenRef.current ? 'listening' : 'idle');
    void resumeListening();
  }, [detachAudioAnalyser, resumeListening]);

  useEffect(() => {
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, level, transcript, messages, error, start, stop, interrupt };
}
