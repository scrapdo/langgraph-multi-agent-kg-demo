import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { getAgentProfiles, getHealth, getRun, getRunSpeech, startRun, streamEvents, testTts } from '../api/client';
import {
  DEFAULT_MISSION_TEMPLATES,
  MISSION_TEMPLATE_STORAGE_KEY,
  loadJsonArray,
  mergeMissionTemplates,
  saveJsonArray,
  type MissionTemplate,
} from '../lib/presets';
import {
  VISUALIZER_OPTIONS,
  fallbackSpeakingLevel,
  normalizeSpeechText,
  shouldIgnoreTranscript,
  type BrainState,
  type VisualizerMode,
} from '../lib/voice';
import type { AgentProfile, RunDetail, RunMode } from '../types';

type TranscriptRole = 'user' | 'brain' | 'system';
type VoiceProfile = 'natural' | 'warm' | 'energetic' | 'precise' | 'cinematic';
type VoiceEngine = 'elevenlabs' | 'openai' | 'parler' | 'browser';
type NeuralVoice = 'alloy' | 'ash' | 'coral' | 'sage' | 'shimmer' | 'verse';

interface TranscriptEntry {
  id: string;
  role: TranscriptRole;
  text: string;
  ts: string;
}

interface EventView {
  ts: string;
  node: string;
  status: string;
  detail: string;
}

interface NarrationItem {
  text: string;
  node: string;
}

interface Props {
  onRunChange: (runId: string | null, run: RunDetail | null) => void;
}

const CONSERVATIVE_ROUTING_STORAGE_KEY = 'kg-demo-conservative-routing';
const AUTO_SILENCE_RUN_MS = 1500;
const SPEECH_ECHO_GUARD_MS = 1200;
const SPEECH_RESUME_DELAY_MS = 320;
const FOLLOW_UP_REPLY_WINDOW_MS = 6500;

function useSpeechRecognition() {
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  useEffect(() => {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      recognitionRef.current = null;
    };
  }, []);

  return recognitionRef;
}

function pickVoice(voices: SpeechSynthesisVoice[]) {
  if (!voices.length) return null;
  return (
    voices.find((v) => /en-US/i.test(v.lang) && /Samantha|Ava|Allison|Google US|Daniel/i.test(v.name)) ??
    voices.find((v) => /en-US/i.test(v.lang)) ??
    voices[0]
  );
}

function isVisualAvatar(value: string) {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:image/');
}

function browserStyleSettings(style: VoiceProfile) {
  switch (style) {
    case 'warm':
      return { rate: 0.92, pitch: 1.02 };
    case 'energetic':
      return { rate: 1.02, pitch: 1.04 };
    case 'precise':
      return { rate: 0.98, pitch: 0.96 };
    case 'cinematic':
      return { rate: 0.88, pitch: 0.94 };
    default:
      return { rate: 0.93, pitch: 0.98 };
  }
}

function formatNarrationDetail(detail: string) {
  return detail.replace(/\s+/g, ' ').trim().replace(/^Critic verdict:\s*/i, '').slice(0, 180);
}

function buildNarrationItem(node: string, status: string, detail: string) {
  const cleanDetail = formatNarrationDetail(detail);
  if (status === 'start') {
    return { node, text: `${node} is now active.` };
  }
  if (status === 'retry') {
    return { node, text: `${node} is retrying after an error.` };
  }
  if (status === 'error') {
    return { node, text: `${node} hit an error. Switching to fallback handling.` };
  }
  if (status === 'degraded') {
    return { node, text: `${node} is running in degraded mode.` };
  }
  if (status === 'ok' && cleanDetail) {
    return { node, text: `${node}: ${cleanDetail}.` };
  }
  if (status === 'completed') {
    return { node, text: `${node} completed.` };
  }
  return null;
}

function detectPredictedRoute(
  task: string,
  agentProfiles: Record<string, AgentProfile>,
  conservativeSpecialistRouting: boolean,
) {
  const text = task.trim().toLowerCase();
  if (!text) return { agentId: 'coordinator', label: 'Coordinator' };

  const aliasesByAgent: Record<string, string[]> = {
    coordinator: ['coordinator'],
    researcher: ['researcher'],
    critic: ['critic'],
    writer: ['writer'],
    shopper: ['shopper', 'private shopper'],
    social: ['social', 'social manager'],
    secretary: ['secretary', 'assistant'],
    wellness: ['wellness', 'wellness coach', 'coach'],
  };

  for (const [agentId, profile] of Object.entries(agentProfiles)) {
    const aliases = [
      agentId,
      (profile.name || '').toLowerCase(),
      ...(aliasesByAgent[agentId] || []),
    ]
      .flatMap((value) => value.split(/[\s_/:-]+/).length > 1 ? [value, ...value.split(/[\s_/:-]+/)] : [value])
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length >= 3);
    for (const alias of aliases) {
      if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
        return { agentId, label: profile.name || agentId };
      }
    }
  }

  const capabilityTriggers = [
    'capabilities',
    'what can you do',
    'who are you',
    'tell me about yourself',
    'introduce yourself',
  ];
  if (capabilityTriggers.some((trigger) => text.includes(trigger))) {
    return { agentId: 'coordinator', label: 'Coordinator' };
  }

  const strongSpecialistTriggers: Array<{ agentId: string; triggers: string[] }> = [
    { agentId: 'shopper', triggers: ['where can i buy', 'best deal', 'hard to find', 'in stock', 'source this item'] },
    { agentId: 'social', triggers: ['social media plan', 'content calendar', 'posting schedule', 'linkedin post', 'instagram caption', 'tweet thread'] },
    { agentId: 'secretary', triggers: ['book appointment', 'schedule appointment', 'make a call', 'place a call', 'send a text', 'send email', 'follow up with'] },
    { agentId: 'wellness', triggers: ['wellness coach', 'habit plan', 'workout plan', 'sleep routine', 'motivation', 'accountability', 'healthy routine'] },
  ];

  for (const item of strongSpecialistTriggers) {
    if (item.triggers.some((trigger) => text.includes(trigger))) {
      const profile = agentProfiles[item.agentId];
      return { agentId: item.agentId, label: profile?.name || item.agentId };
    }
  }

  if (!conservativeSpecialistRouting) {
    if (['find me', 'deal on', 'private shopper'].some((trigger) => text.includes(trigger))) {
      return { agentId: 'shopper', label: agentProfiles.shopper?.name || 'Private Shopper' };
    }
    if (['social media', 'instagram', 'linkedin', 'tweet', 'content plan'].some((trigger) => text.includes(trigger))) {
      return { agentId: 'social', label: agentProfiles.social?.name || 'Social Manager' };
    }
    if (['wellness', 'habit', 'fitness', 'workout', 'sleep', 'stress'].some((trigger) => text.includes(trigger))) {
      return { agentId: 'wellness', label: agentProfiles.wellness?.name || 'Wellness Coach' };
    }
  }

  return { agentId: 'coordinator', label: agentProfiles.coordinator?.name || 'Coordinator' };
}

function looksLikeFollowUpQuestion(text: string) {
  const clean = normalizeSpeechText(text).trim();
  if (!clean) return false;
  const parts = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const tail = parts.at(-1) ?? clean;
  return /\?\s*$/.test(tail);
}

function isDismissalReply(text: string) {
  const normalized = normalizeSpeechText(text).trim().toLowerCase();
  if (!normalized) return false;
  return [
    /^no(?:\s+thanks)?[.!]*$/,
    /^nope[.!]*$/,
    /^i'?m good[.!]*$/,
    /^we'?re good[.!]*$/,
    /^that'?s all[.!]*$/,
    /^that is all[.!]*$/,
    /^nothing else[.!]*$/,
    /^i do(?:\s+not|n't)\s+need anything else[.!]*$/,
    /^don'?t need anything else[.!]*$/,
    /^all set[.!]*$/,
    /^bye[.!]*$/,
    /^goodbye[.!]*$/,
  ].some((pattern) => pattern.test(normalized));
}

function isEditableTarget(target: EventTarget | null) {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tagName = node.tagName;
  return node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tagName);
}

function contextualParting(agentId: string, agentProfiles: Record<string, AgentProfile>) {
  const name = agentProfiles[agentId]?.name || agentId;
  switch (agentId) {
    case 'secretary':
      return `${name} will stay ready if you want me to line anything else up.`;
    case 'wellness':
      return `${name} is here when you want to pick this back up. Stay steady.`;
    case 'shopper':
      return `${name} will stay on standby if you want another option or a better price.`;
    case 'social':
      return `${name} can pick this up again whenever you want the next draft or posting move.`;
    case 'researcher':
      return `${name} will be here when you want the next pass on the research.`;
    case 'writer':
      return `${name} can keep going whenever you want the next version.`;
    case 'critic':
      return `${name} can review the next round whenever you want.`;
    case 'coding':
      return `${name} is ready when you want the next implementation step.`;
    default:
      return `${name} will be here when you need anything else.`;
  }
}

function NeuralWave({
  state,
  interimText,
  speakingLevel,
  visualizerMode,
  speechBands,
  speechMotion,
}: {
  state: BrainState;
  interimText: string;
  speakingLevel: number;
  visualizerMode: VisualizerMode;
  speechBands: number[];
  speechMotion: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let t = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * devicePixelRatio);
      canvas.height = Math.floor(rect.height * devicePixelRatio);
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      t += 0.016;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const centerY = height / 2;

      ctx.clearRect(0, 0, width, height);

      const baseAmp = state === 'speaking' ? 40 : state === 'listening' ? 26 : state === 'thinking' ? 16 : 10;
      const amp = baseAmp + speakingLevel * 28 + speechMotion * 22;
      const glow = state === 'speaking' ? '#06b6d4' : state === 'listening' ? '#67e8f9' : '#f59e0b';
      const bandAt = (index: number) => speechBands[index % speechBands.length] ?? speakingLevel;
      const bandMid = speechBands[Math.floor(speechBands.length / 2)] ?? speakingLevel;
      const bandTreble = speechBands[speechBands.length - 1] ?? speakingLevel;

      if (visualizerMode === 'hal') {
        const cx = width / 2;
        const cy = centerY;
        const outer = 96 + speakingLevel * 12 + bandMid * 10;
        const middle = 56 + Math.sin(t * 2.2) * 4 + bandAt(3) * 8;
        const inner = 24 + Math.sin(t * 4.8) * 2 + bandTreble * 9;

        ctx.beginPath();
        ctx.fillStyle = 'rgba(12, 5, 6, 0.96)';
        ctx.arc(cx, cy, outer + 18, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 48, 48, 0.18)';
        ctx.arc(cx, cy, outer, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 90, 90, 0.38)';
        ctx.lineWidth = 4 + bandAt(5) * 4;
        ctx.arc(cx, cy, middle, 0, Math.PI * 2);
        ctx.stroke();

        for (let ring = 0; ring < 3; ring += 1) {
          const ringBand = bandAt(ring * 2);
          ctx.beginPath();
          ctx.strokeStyle = `rgba(255, 70, 70, ${0.12 + ringBand * 0.2})`;
          ctx.lineWidth = 1.5 + ringBand * 2;
          ctx.arc(cx, cy, outer + 10 + ring * 16 + ringBand * 10, 0, Math.PI * 2);
          ctx.stroke();
        }

        const iris = ctx.createRadialGradient(cx, cy, 4, cx, cy, inner + 22);
        iris.addColorStop(0, 'rgba(255, 235, 235, 0.95)');
        iris.addColorStop(0.12, 'rgba(255, 110, 110, 0.92)');
        iris.addColorStop(0.4, 'rgba(230, 24, 24, 0.88)');
        iris.addColorStop(1, 'rgba(40, 3, 3, 0.98)');
        ctx.beginPath();
        ctx.fillStyle = iris;
        ctx.arc(cx, cy, inner + 20, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = '#fff5f5';
        ctx.globalAlpha = 0.9;
        ctx.arc(cx - 7, cy - 7, 6 + speakingLevel * 2 + bandTreble * 3, 0, Math.PI * 2);
        ctx.fill();
      } else if (visualizerMode === 'neon') {
        const waves = 4;
        for (let w = 0; w < waves; w += 1) {
          ctx.beginPath();
          ctx.lineWidth = 1.8 + w * 0.6;
          ctx.strokeStyle = w % 2 === 0 ? '#2af5ff' : '#9b8cff';
          ctx.globalAlpha = 0.32 + w * 0.12;
          for (let i = 0; i <= width; i += 8) {
            const band = bandAt(Math.floor((i / Math.max(width, 1)) * speechBands.length));
            const waveAmp = amp * (0.28 + w * 0.15) * (0.65 + band * 0.9);
            const y =
              centerY +
              Math.sin(i * 0.02 + t * (2.4 + w * 0.6)) * waveAmp +
              Math.cos(i * 0.008 + t * (1.2 + w * 0.35)) * band * 18 +
              (w - 1.5) * 18;
            if (i === 0) ctx.moveTo(i, y);
            else ctx.lineTo(i, y);
          }
          ctx.stroke();
        }
      } else if (visualizerMode === 'circular') {
        const bars = 72;
        const radius = 72;
        const cx = width / 2;
        const cy = centerY;
        for (let i = 0; i < bars; i += 1) {
          const angle = (Math.PI * 2 * i) / bars;
          const energy = 0.2 + bandAt(i) * 0.9 + Math.abs(Math.sin(t * 2.5 + i * 0.32)) * 0.22;
          const barLength = 10 + amp * 0.72 * energy;
          const x1 = cx + Math.cos(angle) * radius;
          const y1 = cy + Math.sin(angle) * radius;
          const x2 = cx + Math.cos(angle) * (radius + barLength);
          const y2 = cy + Math.sin(angle) * (radius + barLength);
          ctx.beginPath();
          ctx.strokeStyle = glow;
          ctx.globalAlpha = 0.24 + energy * 0.52;
          ctx.lineWidth = 2;
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = '#0b1728';
        ctx.arc(cx, cy, radius - 18, 0, Math.PI * 2);
        ctx.fill();
      } else if (visualizerMode === 'particles') {
        const particles = 96;
        for (let i = 0; i < particles; i += 1) {
          const angle = t * (0.4 + (i % 9) * 0.06) + i * 1.73;
          const band = bandAt(i);
          const drift = 28 + (i % 11) * 11 + Math.sin(t * 1.8 + i) * amp * (0.18 + band * 0.5);
          const x = width / 2 + Math.cos(angle) * drift + Math.sin(t + i) * 14;
          const y = centerY + Math.sin(angle * 1.3) * drift * 0.68;
          const size = 1.2 + ((i % 5) / 5) * 4 + speakingLevel * 1.4 + band * 3.5;
          ctx.beginPath();
          ctx.fillStyle = i % 3 === 0 ? '#9b8cff' : '#2af5ff';
          ctx.globalAlpha = 0.14 + ((i % 7) / 7) * 0.32 + band * 0.3;
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (visualizerMode === 'constellation') {
        const dots = 220;
        for (let i = 0; i < dots; i += 1) {
          const x = (i / (dots - 1)) * width;
          const phase = i * 0.18 + t * (state === 'thinking' ? 5 : 8.8);
          const band = bandAt(Math.floor((i / dots) * speechBands.length));
          const mod = Math.sin(t * 2.1 + i * 0.05) * 0.4 + 0.7 + band * 0.8;
          const y = centerY + Math.sin(phase) * amp * mod;
          const size = 1.2 + ((Math.sin(phase * 1.8) + 1) / 2) * 3.1 + band * 2.2;

          ctx.beginPath();
          ctx.fillStyle = glow;
          ctx.globalAlpha = 0.2 + (size / 5.2) * 0.54 + band * 0.18;
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;
      ctx.fillStyle = '#8fd7e6';
      ctx.font = '12px "Space Mono", monospace';
      ctx.fillText(`STATE: ${state.toUpperCase()}`, 14, 24);
      if (interimText) {
        ctx.fillStyle = '#9fb3c8';
        ctx.fillText(`LISTENING: ${interimText.slice(0, 96)}`, 14, height - 14);
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [state, interimText, speakingLevel, visualizerMode, speechBands, speechMotion]);

  return <canvas className="neural-wave" ref={canvasRef} aria-hidden />;
}

export function RunConsole({ onRunChange }: Props) {
  const [task, setTask] = useState('Tell me about your capabilities.');
  const [mode, setMode] = useState<RunMode>('simulation');
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(false);
  const [brainState, setBrainState] = useState<BrainState>('idle');
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [speechSupported, setSpeechSupported] = useState(true);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [autoSilenceRun, setAutoSilenceRun] = useState(true);
  const [conservativeSpecialistRouting, setConservativeSpecialistRouting] = useState(true);
  const [speakingLevel, setSpeakingLevel] = useState(0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile>('natural');
  const [voiceEngine, setVoiceEngine] = useState<VoiceEngine>('elevenlabs');
  const [neuralVoice, setNeuralVoice] = useState<NeuralVoice>('verse');
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('hal');
  const [savedTemplates, setSavedTemplates] = useState<MissionTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [agentProfiles, setAgentProfiles] = useState<Record<string, AgentProfile>>({});
  const [liveNarration, setLiveNarration] = useState(true);
  const [streamPreviewSpeech, setStreamPreviewSpeech] = useState(true);
  const [speechBands, setSpeechBands] = useState<number[]>(Array.from({ length: 16 }, () => 0));
  const [speechMotion, setSpeechMotion] = useState(0);
  const [voiceProviderState, setVoiceProviderState] = useState<Record<string, string>>({});
  const [pendingRemotePlayback, setPendingRemotePlayback] = useState<{ agentId: string; text: string } | null>(null);

  const recognitionRef = useSpeechRecognition();
  const streamRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const runInFlightRef = useRef(false);
  const lastSpokenRunRef = useRef<string | null>(null);
  const speakingRef = useRef(false);
  const recognitionSuspendUntilRef = useRef(0);
  const resumeListeningAfterSpeechRef = useRef(false);
  const lastUtteranceRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const lastAssistantSpeechRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const audioObjectUrlRef = useRef<string | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserDataRef = useRef<Uint8Array | null>(null);
  const waveformDataRef = useRef<Uint8Array | null>(null);
  const analyserFrameRef = useRef<number | null>(null);
  const remotePulseFrameRef = useRef<number | null>(null);
  const browserSpeechPulseRef = useRef(0);
  const browserSpeechDecayRef = useRef<number | null>(null);
  const remoteSpeechPendingRef = useRef(false);
  const narrationQueueRef = useRef<NarrationItem[]>([]);
  const narrationActiveRef = useRef(false);
  const userVoiceOverrideRef = useRef(false);
  const previewStateRef = useRef<{ runId: string | null; count: number }>({ runId: null, count: 0 });
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micFrameRef = useRef<number | null>(null);
  const followUpTimeoutRef = useRef<number | null>(null);
  const followUpAwaitingRef = useRef<{ agentId: string } | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string>('coordinator');

  const runStateLabel = useMemo(() => {
    if (brainState === 'listening') return 'Listening';
    if (brainState === 'thinking') return 'Thinking';
    if (brainState === 'speaking') return 'Speaking';
    return 'Idle';
  }, [brainState]);

  const predictedRoute = useMemo(
    () => detectPredictedRoute(task, agentProfiles, conservativeSpecialistRouting),
    [task, agentProfiles, conservativeSpecialistRouting],
  );

  const activateSpeaker = (agentId: string) => {
    if (agentId) setActiveAgentId(agentId);
  };

  const resolveAgentSpeechOptions = (agentId: string) => {
    const profile = agentProfiles[agentId] ?? agentProfiles.writer ?? agentProfiles.coordinator;
    return {
      agentId,
      voice: (profile?.speech_voice as NeuralVoice | undefined) ?? neuralVoice,
      profile: (profile?.speech_style as VoiceProfile | undefined) ?? voiceProfile,
      persona: profile?.speech_persona,
      premiumVoiceId: profile?.premium_voice_id,
    };
  };

  const clearFollowUpState = () => {
    if (followUpTimeoutRef.current) {
      window.clearTimeout(followUpTimeoutRef.current);
      followUpTimeoutRef.current = null;
    }
    followUpAwaitingRef.current = null;
  };

  const speakContextualParting = (agentId: string) => {
    const speech = resolveAgentSpeechOptions(agentId);
    const text = contextualParting(agentId, agentProfiles);
    void speak(text, undefined, {
      agentId: speech.agentId,
      voice: speech.voice,
      profile: speech.profile,
      persona: speech.persona,
      premiumVoiceId: speech.premiumVoiceId,
      autoListenAfterQuestion: false,
    });
  };

  const armFollowUpTimeout = (agentId: string) => {
    if (followUpTimeoutRef.current) {
      window.clearTimeout(followUpTimeoutRef.current);
    }
    followUpAwaitingRef.current = { agentId };
    followUpTimeoutRef.current = window.setTimeout(() => {
      if (!followUpAwaitingRef.current || speakingRef.current || runInFlightRef.current) return;
      const rec = recognitionRef.current;
      clearFollowUpState();
      setInterimText('');
      if (rec && isListening) {
        try {
          rec.stop();
        } catch {
          // no-op
        }
      }
      speakContextualParting(agentId);
    }, FOLLOW_UP_REPLY_WINDOW_MS);
  };

  const unlockAudioPlayback = async () => {
    if (audioUnlockedRef.current) return true;
    try {
      const audio = audioUnlockRef.current ?? new Audio();
      audioUnlockRef.current = audio;
      audio.preload = 'auto';
      audio.playsInline = true;
      audio.muted = true;

      const sampleRate = 8000;
      const sampleCount = 800;
      const buffer = new ArrayBuffer(44 + sampleCount * 2);
      const view = new DataView(buffer);
      const writeString = (offset: number, value: string) => {
        for (let i = 0; i < value.length; i += 1) {
          view.setUint8(offset + i, value.charCodeAt(i));
        }
      };
      writeString(0, 'RIFF');
      view.setUint32(4, 36 + sampleCount * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, sampleCount * 2, true);
      const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));

      audio.src = url;
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      audio.removeAttribute('src');
      audio.load();
      audio.muted = false;
      URL.revokeObjectURL(url);
      audioUnlockedRef.current = true;
      return true;
    } catch {
      return false;
    }
  };

  useEffect(() => {
    setSavedTemplates(loadJsonArray<MissionTemplate>(window.localStorage, MISSION_TEMPLATE_STORAGE_KEY));
    const conservativeSetting = window.localStorage.getItem(CONSERVATIVE_ROUTING_STORAGE_KEY);
    if (conservativeSetting === 'false') {
      setConservativeSpecialistRouting(false);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CONSERVATIVE_ROUTING_STORAGE_KEY, String(conservativeSpecialistRouting));
  }, [conservativeSpecialistRouting]);

  useEffect(() => {
    const loadProfiles = async () => {
      try {
        const response = await getAgentProfiles();
        setAgentProfiles(response.agents);
        const writer = response.agents.writer;
        if (writer && !userVoiceOverrideRef.current) {
          setNeuralVoice((writer.speech_voice as NeuralVoice) || 'verse');
          setVoiceProfile((writer.speech_style as VoiceProfile) || 'natural');
        }
      } catch {
        // leave defaults in place
      }
    };
    void loadProfiles();
  }, []);

  useEffect(() => {
    const loadHealth = async () => {
      try {
        const response = await getHealth();
        setVoiceProviderState((response.dependencies as Record<string, string> | undefined) ?? {});
      } catch {
        setVoiceProviderState({});
      }
    };
    void loadHealth();
  }, []);

  useEffect(() => {
    const prime = () => {
      void unlockAudioPlayback();
    };
    window.addEventListener('pointerdown', prime, { passive: true });
    window.addEventListener('keydown', prime);
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, []);

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;

    const loadVoices = () => {
      setVoices(window.speechSynthesis.getVoices());
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  useEffect(() => {
    if (pulseTimerRef.current) {
      window.clearInterval(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }

    pulseTimerRef.current = window.setInterval(() => {
      const t = Date.now() / 180;
      if (brainState === 'speaking') {
        const fallbackLevel = fallbackSpeakingLevel(brainState, interimText.length, Date.now());
        const pendingBoost = remoteSpeechPendingRef.current ? 0.14 : 0;
        setSpeakingLevel((prev) => Math.max(prev * 0.72, fallbackLevel + pendingBoost));
        setSpeechMotion((prev) => Math.max(prev * 0.78, fallbackLevel * 0.82 + pendingBoost));
        setSpeechBands((prev) =>
          prev.map((band, index) =>
            Math.max(
              band * 0.74,
              Math.min(1, (fallbackLevel + pendingBoost) * (0.62 + Math.sin(Date.now() / 120 + index) * 0.22)),
            ),
          ),
        );
      } else if (brainState === 'listening') {
        const level = fallbackSpeakingLevel(brainState, interimText.length, Date.now());
        setSpeakingLevel(level);
        setSpeechMotion(level * 0.6);
        setSpeechBands((prev) =>
          prev.map((_, index) => Math.max(0, Math.min(0.8, level * (0.55 + Math.sin(Date.now() / 180 + index) * 0.18)))),
        );
      } else if (brainState === 'thinking') {
        const thoughtLevel = 0.12 + Math.abs(Math.sin(t * 0.55)) * 0.08;
        setSpeakingLevel((prev) => Math.max(prev * 0.9, thoughtLevel));
        setSpeechMotion((prev) => Math.max(prev * 0.88, thoughtLevel * 0.8));
        setSpeechBands((prev) =>
          prev.map((band, index) =>
            Math.max(
              band * 0.86,
              Math.min(0.38, thoughtLevel * (0.42 + Math.abs(Math.sin(t + index * 0.55)) * 0.4)),
            ),
          ),
        );
      } else {
        setSpeakingLevel((prev) => (prev < 0.01 ? 0 : prev * 0.84));
        setSpeechMotion((prev) => (prev < 0.01 ? 0 : prev * 0.82));
        setSpeechBands((prev) => prev.map((band) => (band < 0.01 ? 0 : band * 0.8)));
      }
    }, 70);

    return () => {
      if (pulseTimerRef.current) {
        window.clearInterval(pulseTimerRef.current);
        pulseTimerRef.current = null;
      }
    };
  }, [brainState, interimText]);

  useEffect(() => {
    const rec = recognitionRef.current;
    if (!rec) {
      setSpeechSupported(false);
      return;
    }
    setSpeechSupported(true);

    rec.onstart = () => {
      setIsListening(true);
      activateSpeaker('coordinator');
      void startMicAnalysis().catch(() => undefined);
      if (window.speechSynthesis.speaking && Date.now() > recognitionSuspendUntilRef.current) {
        window.speechSynthesis.cancel();
        narrationQueueRef.current = [];
        narrationActiveRef.current = false;
        speakingRef.current = false;
        setTranscript((prev) => [
          {
            id: crypto.randomUUID(),
            role: 'system',
            text: 'User interruption detected: speech output stopped.',
            ts: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 40));
      }
      if (!runInFlightRef.current && !speakingRef.current) {
        setBrainState('listening');
      }
    };

    rec.onend = () => {
      setIsListening(false);
      stopMicAnalysis();
      if (!runInFlightRef.current && !speakingRef.current) {
        setBrainState('idle');
      }
    };

    rec.onresult = (event) => {
      if (Date.now() < recognitionSuspendUntilRef.current || speakingRef.current) {
        return;
      }

      let finalText = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcriptPart = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += transcriptPart;
        else interim += transcriptPart;
      }

      setInterimText(interim);
      setSpeakingLevel(Math.min(1, interim.length / 64));
      if (interim.trim() && followUpAwaitingRef.current) {
        armFollowUpTimeout(followUpAwaitingRef.current.agentId);
      }

      if (finalText.trim()) {
        const clean = finalText.trim();
        const now = Date.now();
        const isDuplicateUtterance = lastUtteranceRef.current.text === clean && now - lastUtteranceRef.current.at < 5000;
        if (isDuplicateUtterance) return;

        if (shouldIgnoreTranscript(clean, lastAssistantSpeechRef.current.text, now, lastAssistantSpeechRef.current.at)) {
          return;
        }

        lastUtteranceRef.current = { text: clean, at: now };
        setTask(clean);
        activateSpeaker('coordinator');
        setTranscript((prev) => [
          {
            id: crypto.randomUUID(),
            role: 'user',
            text: clean,
            ts: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 40));

        const followUpAgentId = followUpAwaitingRef.current?.agentId;
        if (followUpAgentId && isDismissalReply(clean)) {
          clearFollowUpState();
          setTask('');
          setInterimText('');
          if (silenceTimerRef.current) {
            window.clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          try {
            rec.stop();
          } catch {
            // no-op
          }
          speakContextualParting(followUpAgentId);
          return;
        }

        if (followUpAgentId) {
          clearFollowUpState();
        }

        if ((autoSilenceRun || Boolean(followUpAgentId)) && !runInFlightRef.current && !speakingRef.current) {
          if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = window.setTimeout(() => {
            if (!runInFlightRef.current && !speakingRef.current && clean) {
              void launchRun(clean);
            }
          }, AUTO_SILENCE_RUN_MS);
        }
      }
    };

    rec.onerror = () => {
      setIsListening(false);
      stopMicAnalysis();
      if (!runInFlightRef.current && !speakingRef.current) {
        setBrainState('idle');
      }
    };
  }, [recognitionRef, autoSilenceRun]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
      if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
      if (followUpTimeoutRef.current) window.clearTimeout(followUpTimeoutRef.current);
      if (pulseTimerRef.current) window.clearInterval(pulseTimerRef.current);
      window.speechSynthesis.cancel();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioUnlockRef.current) {
        audioUnlockRef.current.pause();
        audioUnlockRef.current = null;
      }
      if (analyserFrameRef.current) {
        cancelAnimationFrame(analyserFrameRef.current);
        analyserFrameRef.current = null;
      }
      analyserRef.current?.disconnect();
      audioContextRef.current?.close().catch(() => undefined);
      analyserRef.current = null;
      analyserDataRef.current = null;
      waveformDataRef.current = null;
      audioContextRef.current = null;
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
        audioObjectUrlRef.current = null;
      }
      if (browserSpeechDecayRef.current) {
        cancelAnimationFrame(browserSpeechDecayRef.current);
        browserSpeechDecayRef.current = null;
      }
      stopRemotePlaybackPulse();
      stopMicAnalysis();
    };
  }, []);

  const stopAudioAnalysis = () => {
    if (analyserFrameRef.current) {
      cancelAnimationFrame(analyserFrameRef.current);
      analyserFrameRef.current = null;
    }
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    analyserDataRef.current = null;
    waveformDataRef.current = null;
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
  };

  const stopRemotePlaybackPulse = () => {
    if (remotePulseFrameRef.current) {
      cancelAnimationFrame(remotePulseFrameRef.current);
      remotePulseFrameRef.current = null;
    }
  };

  const startRemotePlaybackPulse = (audio: HTMLAudioElement) => {
    stopRemotePlaybackPulse();
    const tick = () => {
      if (audio.paused || audio.ended) {
        remotePulseFrameRef.current = null;
        return;
      }
      const t = audio.currentTime || performance.now() / 1000;
      const base = 0.46 + Math.abs(Math.sin(t * 7.2)) * 0.26;
      const motion = 0.38 + Math.abs(Math.sin(t * 11.4 + 0.6)) * 0.34;
      setSpeakingLevel((prev) => Math.max(prev * 0.76, base));
      setSpeechMotion((prev) => Math.max(prev * 0.8, motion));
      setSpeechBands((prev) =>
        prev.map((band, index) => {
          const next = base * (0.52 + Math.abs(Math.sin(t * (3.6 + index * 0.11) + index * 0.55)) * 0.55);
          return Math.max(band * 0.78, Math.min(1, next));
        }),
      );
      remotePulseFrameRef.current = requestAnimationFrame(tick);
    };
    remotePulseFrameRef.current = requestAnimationFrame(tick);
  };

  const stopMicAnalysis = () => {
    if (micFrameRef.current) {
      cancelAnimationFrame(micFrameRef.current);
      micFrameRef.current = null;
    }
    micAnalyserRef.current?.disconnect();
    micAnalyserRef.current = null;
    if (micContextRef.current) {
      void micContextRef.current.close().catch(() => undefined);
      micContextRef.current = null;
    }
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
  };

  const startMicAnalysis = async () => {
    stopMicAnalysis();
    if (!navigator.mediaDevices?.getUserMedia) return;
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioCtx();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);
    micStreamRef.current = stream;
    micContextRef.current = context;
    micAnalyserRef.current = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const waveform = new Uint8Array(analyser.fftSize);
    const tick = () => {
      const node = micAnalyserRef.current;
      if (!node) return;
      node.getByteFrequencyData(data);
      node.getByteTimeDomainData(waveform);
      const avg = data.reduce((sum, value) => sum + value, 0) / (data.length || 1);
      const rms =
        Math.sqrt(
          waveform.reduce((sum, value) => {
            const centered = (value - 128) / 128;
            return sum + centered * centered;
          }, 0) / (waveform.length || 1),
        ) || 0;
      const groups = 16;
      const bandSize = Math.max(1, Math.floor(data.length / groups));
      const nextBands = Array.from({ length: groups }, (_, groupIndex) => {
        const start = groupIndex * bandSize;
        const end = Math.min(data.length, start + bandSize);
        let sum = 0;
        for (let i = start; i < end; i += 1) sum += data[i];
        return Math.min(1, (sum / Math.max(1, end - start)) / 180);
      });
      setSpeechBands((prev) => nextBands.map((band, index) => (prev[index] ?? 0) * 0.34 + band * 0.66));
      setSpeakingLevel(Math.min(1, avg / 125 + rms * 1.9));
      setSpeechMotion(Math.min(1, rms * 2.2 + avg / 220));
      micFrameRef.current = requestAnimationFrame(tick);
    };
    micFrameRef.current = requestAnimationFrame(tick);
  };

  const attachAudioAnalysis = async (audio: HTMLAudioElement) => {
    stopAudioAnalysis();
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const context = new AudioCtx();
    if (context.state === 'suspended') {
      await context.resume().catch(() => undefined);
    }
    if (context.state !== 'running') {
      await context.close().catch(() => undefined);
      return;
    }

    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    source.connect(analyser);
    analyser.connect(context.destination);

    audioContextRef.current = context;
    analyserRef.current = analyser;
    analyserDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    waveformDataRef.current = new Uint8Array(analyser.fftSize);

    const tick = () => {
      const node = analyserRef.current;
      const data = analyserDataRef.current;
      const waveform = waveformDataRef.current;
      if (!node || !data || !waveform) return;
      node.getByteFrequencyData(data);
      node.getByteTimeDomainData(waveform);

      const avg = data.reduce((sum, value) => sum + value, 0) / (data.length || 1);
      const rms =
        Math.sqrt(
          waveform.reduce((sum, value) => {
            const centered = (value - 128) / 128;
            return sum + centered * centered;
          }, 0) / (waveform.length || 1),
        ) || 0;

      const groups = 16;
      const bandSize = Math.max(1, Math.floor(data.length / groups));
      const nextBands = Array.from({ length: groups }, (_, groupIndex) => {
        const start = groupIndex * bandSize;
        const end = Math.min(data.length, start + bandSize);
        let sum = 0;
        for (let i = start; i < end; i += 1) sum += data[i];
        return Math.min(1, (sum / Math.max(1, end - start)) / 180);
      });

      setSpeechBands((prev) =>
        nextBands.map((band, index) => {
          const prior = prev[index] ?? 0;
          return prior * 0.42 + band * 0.58;
        }),
      );
      const nextLevel = Math.min(1, avg / 135 + rms * 1.8);
      setSpeakingLevel(nextLevel);
      setSpeechMotion((prev) => prev * 0.28 + Math.min(1, rms * 2.4 + avg / 220) * 0.72);
      analyserFrameRef.current = requestAnimationFrame(tick);
    };

    analyserFrameRef.current = requestAnimationFrame(tick);
  };

  const prepareSpeechSession = () => {
    const rec = recognitionRef.current;
    if (isListening && rec) {
      resumeListeningAfterSpeechRef.current = true;
      recognitionSuspendUntilRef.current = Date.now() + SPEECH_ECHO_GUARD_MS;
      rec.stop();
    }

    speakingRef.current = true;
    setBrainState('speaking');
    setSpeakingLevel(1);
  };

  const finishSpeechSession = (options?: { followUpAgentId?: string; autoListenAfterQuestion?: boolean }) => {
    speakingRef.current = false;
    remoteSpeechPendingRef.current = false;
    setInterimText('');
    browserSpeechPulseRef.current = 0;
    if (browserSpeechDecayRef.current) {
      cancelAnimationFrame(browserSpeechDecayRef.current);
      browserSpeechDecayRef.current = null;
    }
    setBrainState(runInFlightRef.current ? 'thinking' : 'idle');
    recognitionSuspendUntilRef.current = Date.now() + SPEECH_ECHO_GUARD_MS;

    const rec = recognitionRef.current;
    const shouldResumeListening = resumeListeningAfterSpeechRef.current;
    const shouldAutoFollowUp = Boolean(options?.followUpAgentId && options.autoListenAfterQuestion !== false);
    resumeListeningAfterSpeechRef.current = false;
    if ((shouldResumeListening || shouldAutoFollowUp) && rec) {
      window.setTimeout(() => {
        if (shouldAutoFollowUp && options?.followUpAgentId) {
          armFollowUpTimeout(options.followUpAgentId);
        }
        try {
          rec.start();
        } catch {
          // no-op
        }
      }, SPEECH_RESUME_DELAY_MS);
    } else if (!shouldAutoFollowUp) {
      clearFollowUpState();
    }
  };

  const stopAllSpeech = (options?: { preserveSpeakingState?: boolean; preserveVisualizer?: boolean }) => {
    window.speechSynthesis.cancel();
    narrationQueueRef.current = [];
    narrationActiveRef.current = false;
    remoteSpeechPendingRef.current = false;
    clearFollowUpState();
    setPendingRemotePlayback(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    stopRemotePlaybackPulse();
    stopAudioAnalysis();
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }
    speakingRef.current = false;
    setBrainState(options?.preserveSpeakingState ? 'speaking' : runInFlightRef.current ? 'thinking' : 'idle');
    if (!options?.preserveVisualizer) {
      setSpeakingLevel(0);
      setSpeechMotion(0);
      setSpeechBands((prev) => prev.map(() => 0));
    }
    browserSpeechPulseRef.current = 0;
    if (browserSpeechDecayRef.current) {
      cancelAnimationFrame(browserSpeechDecayRef.current);
      browserSpeechDecayRef.current = null;
    }
  };

  const speakBrowser = (
    rawText: string,
    runId?: string,
    options?: {
      agentId?: string;
      profile?: VoiceProfile;
      transcriptRole?: TranscriptRole;
      markAsFinal?: boolean;
      autoListenAfterQuestion?: boolean;
      onDone?: () => void;
    },
  ) => {
    if (!('speechSynthesis' in window)) return;

    if (runId && options?.markAsFinal !== false && lastSpokenRunRef.current === runId) {
      return;
    }

    const text = normalizeSpeechText(rawText).slice(0, 900);
    if (!text) return;
    activateSpeaker(options?.agentId ?? activeAgentId);
    if (options?.transcriptRole !== 'system') {
      lastAssistantSpeechRef.current = { text, at: Date.now() };
    }

    const selectedVoice = pickVoice(voices);
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);

    if (!sentences.length) return;

    prepareSpeechSession();
    window.speechSynthesis.cancel();
    prepareSpeechSession();

    let idx = 0;
    const selectedProfile = options?.profile ?? voiceProfile;
    const { rate: baseRate, pitch: basePitch } = browserStyleSettings(selectedProfile);
    const startBrowserSpeechDecay = () => {
      if (browserSpeechDecayRef.current) {
        cancelAnimationFrame(browserSpeechDecayRef.current);
      }
      const tick = () => {
        browserSpeechPulseRef.current *= 0.9;
        setSpeechMotion((prev) => Math.max(browserSpeechPulseRef.current, prev * 0.72));
        setSpeakingLevel((prev) => Math.max(browserSpeechPulseRef.current * 0.95, prev * 0.7));
        setSpeechBands((prev) =>
          prev.map((band, index) => {
            const phase = Date.now() / 90 + index * 0.7;
            const accent = browserSpeechPulseRef.current * (0.55 + Math.abs(Math.sin(phase)) * 0.45);
            return Math.max(accent, band * 0.78);
          }),
        );
        if (browserSpeechPulseRef.current > 0.025 || speakingRef.current) {
          browserSpeechDecayRef.current = requestAnimationFrame(tick);
        } else {
          browserSpeechDecayRef.current = null;
        }
      };
      browserSpeechDecayRef.current = requestAnimationFrame(tick);
    };

    const speakNext = () => {
      const sentence = sentences[idx];
      if (!sentence) {
        finishSpeechSession({
          followUpAgentId: options?.agentId ?? activeAgentId,
          autoListenAfterQuestion: options?.autoListenAfterQuestion !== false && looksLikeFollowUpQuestion(text),
        });
        options?.onDone?.();
        return;
      }

      const utter = new SpeechSynthesisUtterance(sentence);
      utter.lang = 'en-US';
      utter.rate = Math.max(0.85, Math.min(1.05, baseRate + (idx % 2 === 0 ? -0.02 : 0.02)));
      utter.pitch = basePitch;
      if (selectedVoice) utter.voice = selectedVoice;
      utter.onstart = () => {
        browserSpeechPulseRef.current = 0.68;
        startBrowserSpeechDecay();
      };
      utter.onboundary = (event) => {
        const charIndex = typeof event.charIndex === 'number' ? event.charIndex : 0;
        const windowText = sentence.slice(charIndex, charIndex + 14);
        const emphasis = /[A-Z0-9]/.test(windowText) || /[,;:!?]/.test(windowText) ? 0.96 : 0.74;
        browserSpeechPulseRef.current = emphasis;
        setSpeechBands((prev) =>
          prev.map((_, index) => {
            const distance = Math.abs(index - ((charIndex / Math.max(sentence.length, 1)) * prev.length));
            return Math.max(0.16, emphasis * Math.max(0.3, 1 - distance / prev.length));
          }),
        );
        startBrowserSpeechDecay();
      };

      utter.onend = () => {
        idx += 1;
        window.setTimeout(speakNext, voiceProfile === 'natural' ? 150 : 90);
      };
      utter.onerror = () => finishSpeechSession();

      window.speechSynthesis.speak(utter);
    };

    speakNext();
    if (runId && options?.markAsFinal !== false) lastSpokenRunRef.current = runId;

    setTranscript((prev) => [
      {
        id: crypto.randomUUID(),
        role: options?.transcriptRole ?? 'brain',
        text,
        ts: new Date().toISOString(),
      },
      ...prev,
    ].slice(0, 40));
  };

  const speakRemote = async (
    rawText: string,
    runId?: string,
    options?: {
      agentId?: string;
      provider?: 'openai' | 'elevenlabs' | 'parler';
      voice?: NeuralVoice;
      profile?: VoiceProfile;
      persona?: string;
      premiumVoiceId?: string;
      transcriptRole?: TranscriptRole;
      autoListenAfterQuestion?: boolean;
    },
  ) => {
    if (runId && lastSpokenRunRef.current === runId) return;

    const text = normalizeSpeechText(rawText).slice(0, 900);
    if (!text) return;
    if (options?.transcriptRole !== 'system') {
      lastAssistantSpeechRef.current = { text, at: Date.now() };
    }
    activateSpeaker(options?.agentId ?? activeAgentId);

    prepareSpeechSession();
    remoteSpeechPendingRef.current = true;
    stopAllSpeech({ preserveSpeakingState: true, preserveVisualizer: true });
    prepareSpeechSession();

    try {
      const blob = runId
        ? await getRunSpeech(runId, {
            agentId: options?.agentId ?? activeAgentId,
            provider: options?.provider ?? voiceEngine,
            voice: options?.voice ?? neuralVoice,
            profile: options?.profile ?? voiceProfile,
            persona: options?.persona,
            premiumVoiceId: options?.premiumVoiceId,
          })
        : await testTts({
            text,
            agentId: options?.agentId ?? activeAgentId,
            provider: options?.provider ?? voiceEngine,
            voice: options?.voice ?? neuralVoice,
            profile: options?.profile ?? voiceProfile,
            persona: options?.persona,
            premiumVoiceId: options?.premiumVoiceId,
          });
      if (!blob.size) throw new Error('Empty audio response');

      const objectUrl = URL.createObjectURL(blob);
      audioObjectUrlRef.current = objectUrl;
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      audio.preload = 'auto';
      audio.playsInline = true;
      remoteSpeechPendingRef.current = false;

      audio.onplay = () => {
        activateSpeaker(options?.agentId ?? activeAgentId);
        speakingRef.current = true;
        setBrainState('speaking');
        setSpeakingLevel((prev) => Math.max(prev, 0.72));
        setSpeechMotion((prev) => Math.max(prev, 0.58));
        startRemotePlaybackPulse(audio);
      };

      audio.onplaying = () => {
        activateSpeaker(options?.agentId ?? activeAgentId);
        speakingRef.current = true;
        setBrainState('speaking');
        setSpeakingLevel((prev) => Math.max(prev, 0.78));
        setSpeechMotion((prev) => Math.max(prev, 0.62));
        startRemotePlaybackPulse(audio);
      };

      audio.onended = () => {
        remoteSpeechPendingRef.current = false;
        setPendingRemotePlayback(null);
        stopRemotePlaybackPulse();
        stopAudioAnalysis();
        finishSpeechSession({
          followUpAgentId: options?.agentId ?? activeAgentId,
          autoListenAfterQuestion: options?.autoListenAfterQuestion !== false && looksLikeFollowUpQuestion(text),
        });
        if (audioObjectUrlRef.current) {
          URL.revokeObjectURL(audioObjectUrlRef.current);
          audioObjectUrlRef.current = null;
        }
        audioRef.current = null;
      };

      audio.onerror = () => {
        remoteSpeechPendingRef.current = false;
        setPendingRemotePlayback(null);
        stopRemotePlaybackPulse();
        stopAudioAnalysis();
        finishSpeechSession();
        if (audioObjectUrlRef.current) {
          URL.revokeObjectURL(audioObjectUrlRef.current);
          audioObjectUrlRef.current = null;
        }
        audioRef.current = null;
      };

      try {
        await audio.play();
        void attachAudioAnalysis(audio).catch(() => undefined);
      } catch (playError) {
        const playDetail = playError instanceof Error && playError.message ? playError.message : 'Audio playback was blocked.';
        setPendingRemotePlayback({ agentId: options?.agentId ?? activeAgentId, text });
        setTranscript((prev) => [
          {
            id: crypto.randomUUID(),
            role: 'system',
            text: `${playDetail} Tap Play Pending Response to hear this reply.`,
            ts: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 40));
        finishSpeechSession();
        return;
      }
      if (runId) lastSpokenRunRef.current = runId;

      setTranscript((prev) => [
        {
          id: crypto.randomUUID(),
          role: options?.transcriptRole ?? 'brain',
          text,
          ts: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 40));
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : 'Remote voice unavailable.';
      remoteSpeechPendingRef.current = false;
      finishSpeechSession();
      const fallbackBlocked = options?.provider === 'elevenlabs' || voiceEngine === 'elevenlabs';
      setTranscript((prev) => [
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: fallbackBlocked ? `${detail} Browser fallback blocked for ElevenLabs mode.` : `${detail} Switched to browser speech.`,
          ts: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 40));
      if (fallbackBlocked) {
        setBrainState(runInFlightRef.current ? 'thinking' : 'idle');
        setSpeakingLevel(0);
        return;
      }
      speakBrowser(text, runId, {
        agentId: options?.agentId,
        profile: options?.profile,
        transcriptRole: options?.transcriptRole,
        autoListenAfterQuestion: options?.autoListenAfterQuestion,
      });
    }
  };

  const speak = async (
    rawText: string,
    runId?: string,
    options?: {
      agentId?: string;
      voice?: NeuralVoice;
      profile?: VoiceProfile;
      persona?: string;
      premiumVoiceId?: string;
      transcriptRole?: TranscriptRole;
      autoListenAfterQuestion?: boolean;
    },
  ) => {
    if (voiceEngine === 'openai' || voiceEngine === 'elevenlabs' || voiceEngine === 'parler') {
      await speakRemote(rawText, runId, {
        agentId: options?.agentId,
        provider: voiceEngine,
        voice: options?.voice,
        profile: options?.profile,
        persona: options?.persona,
        premiumVoiceId: options?.premiumVoiceId,
        transcriptRole: options?.transcriptRole,
        autoListenAfterQuestion: options?.autoListenAfterQuestion,
      });
      return;
    }
    speakBrowser(rawText, runId, {
      agentId: options?.agentId,
      profile: options?.profile,
      transcriptRole: options?.transcriptRole,
      autoListenAfterQuestion: options?.autoListenAfterQuestion,
    });
  };

  const mapEvent = (evt: Record<string, unknown>): EventView => ({
    ts: String(evt.ts ?? new Date().toISOString()),
    node: String(evt.node ?? 'system'),
    status: String(evt.status ?? 'info'),
    detail: String(evt.detail ?? ''),
  });

  const processNarrationQueue = () => {
    if (narrationActiveRef.current || !liveNarration) {
      return;
    }
    const next = narrationQueueRef.current.shift();
    if (!next) return;
    const profile = (agentProfiles[next.node]?.speech_style as VoiceProfile | undefined) ?? 'natural';
    activateSpeaker(next.node);
    narrationActiveRef.current = true;
    speakBrowser(next.text, undefined, {
      profile,
      transcriptRole: 'system',
      markAsFinal: false,
      autoListenAfterQuestion: false,
      onDone: () => {
        narrationActiveRef.current = false;
        if (runInFlightRef.current) {
          window.setTimeout(processNarrationQueue, 80);
        }
      },
    });
  };

  const launchRun = async (launchTask: string) => {
    if (runInFlightRef.current) return;
    void unlockAudioPlayback();
    clearFollowUpState();

    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    runInFlightRef.current = true;
    setLoading(true);
    setBrainState('thinking');
    setEvents([]);
    setSpeakingLevel(0.45);
    previewStateRef.current = { runId: null, count: 0 };
    activateSpeaker('coordinator');

    streamRef.current?.close();
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);

    const coordinator = agentProfiles.coordinator;
    const ack = 'One moment.';
    void speak(ack, undefined, {
      agentId: 'coordinator',
      voice: (coordinator?.speech_voice as NeuralVoice | undefined) ?? neuralVoice,
      profile: (coordinator?.speech_style as VoiceProfile | undefined) ?? 'precise',
      persona: coordinator?.speech_persona,
      premiumVoiceId: coordinator?.premium_voice_id,
      transcriptRole: 'system',
      autoListenAfterQuestion: false,
    });

    try {
      const created = await startRun(launchTask, mode, conservativeSpecialistRouting);
      onRunChange(created.run_id, null);

      const source = streamEvents(created.run_id, (evt) => {
        if (previewStateRef.current.runId !== created.run_id) {
          previewStateRef.current = { runId: created.run_id, count: 0 };
        }
        const mapped = mapEvent(evt);
        setEvents((prev) => [mapped, ...prev].slice(0, 220));

        if (mapped.status === 'start') {
          if (!speakingRef.current) {
            setBrainState('thinking');
            setSpeakingLevel((prev) => Math.max(prev, 0.35));
          }
        }

        if (mapped.status === 'speech_partial') {
          const agentId = String(evt.agent_id ?? mapped.node ?? 'writer');
          activateSpeaker(agentId);
          const previewProfile = (evt.speech_style as VoiceProfile | undefined)
            ?? (agentProfiles[agentId]?.speech_style as VoiceProfile | undefined)
            ?? 'natural';
          if (streamPreviewSpeech && previewStateRef.current.count < 2 && Date.now() > recognitionSuspendUntilRef.current) {
            previewStateRef.current.count += 1;
            speakBrowser(mapped.detail, undefined, {
              profile: previewProfile,
              transcriptRole: 'brain',
              markAsFinal: false,
              autoListenAfterQuestion: false,
            });
          }
          return;
        }

        if (mapped.detail) {
          setTranscript((prev) => [
            {
              id: crypto.randomUUID(),
              role: 'system',
              text: `[${mapped.node}] ${mapped.status}: ${mapped.detail}`,
              ts: mapped.ts,
            },
            ...prev,
          ].slice(0, 40));
        }

        const narration = buildNarrationItem(mapped.node, mapped.status, mapped.detail);
        if (narration && liveNarration && Date.now() > recognitionSuspendUntilRef.current) {
          narrationQueueRef.current.push(narration);
          processNarrationQueue();
        }
      });

      streamRef.current = source;
      window.setTimeout(() => source.close(), 10 * 60 * 1000);

      const poll = async () => {
        try {
          const detail = await getRun(created.run_id);
          setRun(detail);
          onRunChange(created.run_id, detail);

          if (['completed', 'failed', 'degraded'].includes(detail.status)) {
            source.close();
            runInFlightRef.current = false;
            setLoading(false);
            narrationQueueRef.current = [];
            narrationActiveRef.current = false;

            const state = detail.state as Record<string, unknown>;
            const spoken = String(state.spoken_response ?? detail.output ?? '');
            if (spoken) {
              const speakerAgent = String(state.speaker_agent ?? 'writer');
              activateSpeaker(speakerAgent);
              const speaker = agentProfiles[speakerAgent] ?? agentProfiles.writer;
              const resolvedVoice = (speaker?.speech_voice as NeuralVoice | undefined) ?? neuralVoice;
              const resolvedProfile = (speaker?.speech_style as VoiceProfile | undefined) ?? voiceProfile;
              void speak(spoken, created.run_id, {
                agentId: speakerAgent,
                voice: resolvedVoice,
                profile: resolvedProfile,
                persona: speaker?.speech_persona,
                premiumVoiceId: speaker?.premium_voice_id,
              });
            } else {
              setBrainState('idle');
              setSpeakingLevel(0);
            }
            return;
          }

          pollTimerRef.current = window.setTimeout(poll, 1200);
        } catch {
          runInFlightRef.current = false;
          setLoading(false);
          setBrainState('idle');
          setSpeakingLevel(0);
        }
      };

      void poll();
    } catch {
      runInFlightRef.current = false;
      setLoading(false);
      setBrainState('idle');
      setSpeakingLevel(0);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await unlockAudioPlayback();
    await launchRun(task);
  };

  const templates = useMemo(() => mergeMissionTemplates(savedTemplates), [savedTemplates]);

  const applyTemplate = (template: MissionTemplate) => {
    setTask(template.task);
    setMode(template.mode);
  };

  const saveTemplate = () => {
    const name = templateName.trim();
    const prompt = task.trim();
    if (!name || !prompt) return;
    const nextTemplate: MissionTemplate = {
      id: crypto.randomUUID(),
      name,
      description: 'Saved custom mission template.',
      task: prompt,
      mode,
    };
    const next = [...savedTemplates, nextTemplate];
    setSavedTemplates(next);
    saveJsonArray(window.localStorage, MISSION_TEMPLATE_STORAGE_KEY, next);
    setTemplateName('');
  };

  const deleteTemplate = (templateId: string) => {
    const next = savedTemplates.filter((template) => template.id !== templateId);
    setSavedTemplates(next);
    saveJsonArray(window.localStorage, MISSION_TEMPLATE_STORAGE_KEY, next);
  };

  const toggleListening = () => {
    if (!speechSupported || loading) return;
    const rec = recognitionRef.current;
    if (!rec) return;
    if (isListening) {
      clearFollowUpState();
      rec.stop();
      return;
    }
    try {
      void unlockAudioPlayback();
      rec.start();
    } catch {
      // start can throw if already active
    }
  };

  useEffect(() => {
    const handleMainScreenSpace = (event: KeyboardEvent) => {
      if (event.code !== 'Space' && event.key !== ' ') return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      toggleListening();
    };

    window.addEventListener('keydown', handleMainScreenSpace);
    return () => window.removeEventListener('keydown', handleMainScreenSpace);
  }, [isListening, loading, speechSupported]);

  const playPendingResponse = async () => {
    if (!audioRef.current) return;
    await unlockAudioPlayback();
    try {
      if (audioContextRef.current?.state === 'suspended') {
        await audioContextRef.current.resume().catch(() => undefined);
      }
      prepareSpeechSession();
      await audioRef.current.play();
      startRemotePlaybackPulse(audioRef.current);
      setPendingRemotePlayback(null);
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : 'Audio playback is still blocked.';
      setTranscript((prev) => [
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: detail,
          ts: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 40));
      finishSpeechSession();
    }
  };

  return (
    <section className="panel brain-console">
      <div className="brain-console-head">
        <h2>BRAIN CORE</h2>
        <p className="muted">{runStateLabel}</p>
      </div>

      {agentProfiles[activeAgentId] && (
        <div className="agent-spotlight">
          {isVisualAvatar(agentProfiles[activeAgentId].avatar || '') ? (
            <img
              className="agent-spotlight-video"
              src={agentProfiles[activeAgentId].avatar}
              alt={agentProfiles[activeAgentId].name}
            />
          ) : (
            <div className="agent-spotlight-avatar">{agentProfiles[activeAgentId].avatar || '•'}</div>
          )}
          <div className="agent-spotlight-copy">
            <strong>{agentProfiles[activeAgentId].name}</strong>
            <span>{agentProfiles[activeAgentId].id}</span>
          </div>
        </div>
      )}

      <NeuralWave
        state={brainState}
        interimText={interimText}
        speakingLevel={speakingLevel}
        visualizerMode={visualizerMode}
        speechBands={speechBands}
        speechMotion={speechMotion}
      />


      <div className="template-rail">
        {templates.map((template) => (
          <button key={template.id} type="button" className="template-pill" onClick={() => applyTemplate(template)}>
            <strong>{template.name}</strong>
            <span>{template.description}</span>
          </button>
        ))}
      </div>

      <div className="voice-controls">
        <button type="button" onClick={toggleListening} disabled={!speechSupported || loading}>
          {isListening ? 'Stop Listening' : 'Start Listening'}
        </button>
        <button type="button" onClick={stopAllSpeech}>Stop Speaking</button>
        {pendingRemotePlayback && (
          <button type="button" onClick={playPendingResponse}>Play Pending Response</button>
        )}
      </div>

      <div className="voice-profile-row">
        <label>
          Voice Engine
          <select value={voiceEngine} onChange={(e) => setVoiceEngine(e.target.value as VoiceEngine)}>
            <option value="elevenlabs">Premium (ElevenLabs)</option>
            <option value="openai">Neural (OpenAI)</option>
            <option value="parler">Parler TTS (HF)</option>
            <option value="browser">Browser (local)</option>
          </select>
        </label>
        <span className="muted small">
          {voiceEngine === 'elevenlabs'
            ? `ElevenLabs: ${voiceProviderState.elevenlabs ?? 'unknown'}`
            : voiceEngine === 'openai'
              ? `OpenAI: ${voiceProviderState.openai ?? 'unknown'}`
              : voiceEngine === 'parler'
                ? `Parler: ${voiceProviderState.parler_tts ?? 'unknown'}`
                : 'Browser voice is local only'}
        </span>
      </div>

      <div className="voice-profile-row">
        <label>
          Neural Voice
          <select
            value={neuralVoice}
            onChange={(e) => {
              userVoiceOverrideRef.current = true;
              setNeuralVoice(e.target.value as NeuralVoice);
            }}
            disabled={voiceEngine !== 'openai'}
          >
            <option value="alloy">alloy</option>
            <option value="ash">ash</option>
            <option value="coral">coral</option>
            <option value="sage">sage</option>
            <option value="shimmer">shimmer</option>
            <option value="verse">verse</option>
          </select>
        </label>
      </div>

      <div className="voice-profile-row">
        <label>
          Visualizer
          <select value={visualizerMode} onChange={(e) => setVisualizerMode(e.target.value as VisualizerMode)}>
            {VISUALIZER_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="voice-profile-row">
        <label>
          Speech Style
          <select
            value={voiceProfile}
            onChange={(e) => {
              userVoiceOverrideRef.current = true;
              setVoiceProfile(e.target.value as VoiceProfile);
            }}
          >
            <option value="natural">Natural</option>
            <option value="warm">Warm</option>
            <option value="energetic">Energetic</option>
            <option value="precise">Precise</option>
            <option value="cinematic">Cinematic</option>
          </select>
        </label>
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={liveNarration}
          onChange={(e) => setLiveNarration(e.target.checked)}
        />
        Live narration during active runs
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={streamPreviewSpeech}
          onChange={(e) => setStreamPreviewSpeech(e.target.checked)}
        />
        Stream preview speech before run completes
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={autoSilenceRun}
          onChange={(e) => setAutoSilenceRun(e.target.checked)}
        />
        Auto-run after 1.5s silence
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={conservativeSpecialistRouting}
          onChange={(e) => setConservativeSpecialistRouting(e.target.checked)}
        />
        Route specialists only on explicit name or strong intent
      </label>

      {!speechSupported && <p className="muted">Speech input is not supported in this browser.</p>}

      <form onSubmit={onSubmit} className="form-grid">
        <label>
          Mission Prompt
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} required />
        </label>
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)}>
            <option value="simulation">simulation</option>
            <option value="live">live</option>
          </select>
        </label>
        <button disabled={loading} type="submit">{loading ? 'Running Mission...' : 'Execute Mission'}</button>
      </form>

      <div className="filter-chips">
        <span className="chip active">Predicted Route: {predictedRoute.label}</span>
      </div>

      <div className="template-save-bar">
        <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Save current prompt as template" />
        <button type="button" onClick={saveTemplate}>Save Template</button>
      </div>

      {savedTemplates.length > 0 && (
        <div className="saved-template-list">
          {savedTemplates.map((template) => (
            <div key={template.id} className="saved-template-row">
              <span>{template.name}</span>
              <button type="button" className="ghost-button" onClick={() => deleteTemplate(template.id)}>Delete</button>
            </div>
          ))}
        </div>
      )}

      {run && (
        <div className="status-card">
          <h3>Run Status</h3>
          <p><strong>ID:</strong> {run.run_id}</p>
          <p><strong>Status:</strong> {run.status}</p>
          <p><strong>Updated:</strong> {new Date(run.updated_at).toLocaleString()}</p>
          {run.state?.route_decision && typeof run.state.route_decision === 'object' && (
            <>
              <p><strong>Actual Route:</strong> {String((run.state.route_decision as Record<string, unknown>).agent_id || 'coordinator')} · {String((run.state.route_decision as Record<string, unknown>).task_type || '')}</p>
              <p className="muted small">{String((run.state.route_decision as Record<string, unknown>).reason || '')}</p>
            </>
          )}
          {run.state?.run_metrics && typeof run.state.run_metrics === 'object' && (
            <p><strong>Latency:</strong> {String((run.state.run_metrics as Record<string, unknown>).elapsed_ms || 0)} ms</p>
          )}
          {run.state?.policy_version && (
            <p className="muted small">
              Policy {String(run.state.policy_version)} · Prompt {String(run.state.prompt_version || '')}
            </p>
          )}
          {Array.isArray(run.state?.warnings) && run.state.warnings.length > 0 && (
            <div className="events" style={{ marginTop: 12 }}>
              <h3>Warnings</h3>
              <ul>
                {run.state.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>
                    <p className="muted event-detail">{String(warning)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Array.isArray(run.state?.action_items) && run.state.action_items.length > 0 && (
            <div className="events" style={{ marginTop: 12 }}>
              <h3>Next Actions</h3>
              <ul>
                {run.state.action_items.map((item, index) => (
                  <li key={`${String((item as Record<string, unknown>).type || index)}-${index}`}>
                    <p className="muted event-detail">
                      {String((item as Record<string, unknown>).owner || 'agent')}: {String((item as Record<string, unknown>).label || '')}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="events">
        <h3>Synaptic Stream</h3>
        <ul>
          {events.slice(0, 12).map((evt, idx) => (
            <li key={idx}>
              <p className="event-line">
                <strong>{evt.node}</strong> <span>{evt.status}</span>
              </p>
              <p className="muted event-detail">{evt.detail}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="events">
        <h3>Conversation</h3>
        <ul>
          {transcript.slice(0, 12).map((entry) => (
            <li key={entry.id}>
              <p className="event-line">
                <strong>{entry.role}</strong> <span>{new Date(entry.ts).toLocaleTimeString()}</span>
              </p>
              <p className="event-detail">{entry.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
