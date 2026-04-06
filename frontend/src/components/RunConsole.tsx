import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { getRun, getRunSpeech, startRun, streamEvents } from '../api/client';
import type { RunDetail, RunMode } from '../types';

type BrainState = 'idle' | 'listening' | 'thinking' | 'speaking';
type TranscriptRole = 'user' | 'brain' | 'system';
type VoiceProfile = 'natural' | 'command';
type VoiceEngine = 'neural' | 'browser';
type NeuralVoice = 'alloy' | 'verse' | 'aria';

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

interface Props {
  onRunChange: (runId: string | null, run: RunDetail | null) => void;
}

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

function normalizeSpeechText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/#+\s/g, ' ')
    .replace(/[*_~>-]/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(text: string) {
  return normalizeSpeechText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function pickVoice(voices: SpeechSynthesisVoice[]) {
  if (!voices.length) return null;
  return (
    voices.find((v) => /en-US/i.test(v.lang) && /Samantha|Ava|Allison|Google US|Daniel/i.test(v.name)) ??
    voices.find((v) => /en-US/i.test(v.lang)) ??
    voices[0]
  );
}

function NeuralWave({ state, interimText, speakingLevel }: { state: BrainState; interimText: string; speakingLevel: number }) {
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

      const dots = 220;
      const baseAmp = state === 'speaking' ? 40 : state === 'listening' ? 26 : state === 'thinking' ? 16 : 10;
      const amp = baseAmp + speakingLevel * 28;
      const glow = state === 'speaking' ? '#06b6d4' : state === 'listening' ? '#67e8f9' : '#f59e0b';

      for (let i = 0; i < dots; i += 1) {
        const x = (i / (dots - 1)) * width;
        const phase = i * 0.18 + t * (state === 'thinking' ? 5 : 8.8);
        const mod = Math.sin(t * 2.1 + i * 0.05) * 0.4 + 0.7;
        const y = centerY + Math.sin(phase) * amp * mod;
        const size = 1.2 + ((Math.sin(phase * 1.8) + 1) / 2) * 3.1;

        ctx.beginPath();
        ctx.fillStyle = glow;
        ctx.globalAlpha = 0.2 + (size / 5.2) * 0.76;
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
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
  }, [state, interimText, speakingLevel]);

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
  const [speakingLevel, setSpeakingLevel] = useState(0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile>('natural');
  const [voiceEngine, setVoiceEngine] = useState<VoiceEngine>('neural');
  const [neuralVoice, setNeuralVoice] = useState<NeuralVoice>('alloy');

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
  const audioObjectUrlRef = useRef<string | null>(null);
  const pulseTimerRef = useRef<number | null>(null);

  const runStateLabel = useMemo(() => {
    if (brainState === 'listening') return 'Listening';
    if (brainState === 'thinking') return 'Thinking';
    if (brainState === 'speaking') return 'Speaking';
    return 'Idle';
  }, [brainState]);

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

    if (brainState !== 'speaking' && brainState !== 'listening') {
      return;
    }

    pulseTimerRef.current = window.setInterval(() => {
      const t = Date.now() / 180;
      if (brainState === 'speaking') {
        const level = 0.45 + Math.abs(Math.sin(t)) * 0.5;
        setSpeakingLevel(level);
      } else {
        const interimBoost = Math.min(0.35, interimText.length / 120);
        const level = 0.15 + Math.abs(Math.sin(t * 0.8)) * 0.28 + interimBoost;
        setSpeakingLevel(level);
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
      if (window.speechSynthesis.speaking && Date.now() > recognitionSuspendUntilRef.current) {
        window.speechSynthesis.cancel();
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
      if (!runInFlightRef.current && !speakingRef.current) {
        setBrainState('idle');
        setSpeakingLevel(0);
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

      if (finalText.trim()) {
        const clean = finalText.trim();
        const now = Date.now();
        const isDuplicateUtterance = lastUtteranceRef.current.text === clean && now - lastUtteranceRef.current.at < 5000;
        if (isDuplicateUtterance) return;

        const userNorm = normalizeForMatch(clean);
        const aiNorm = normalizeForMatch(lastAssistantSpeechRef.current.text);
        const recentAssistantSpeech = now - lastAssistantSpeechRef.current.at < 14000;
        if (recentAssistantSpeech && aiNorm && userNorm && (aiNorm.includes(userNorm) || userNorm.includes(aiNorm))) {
          return;
        }

        lastUtteranceRef.current = { text: clean, at: now };
        setTask(clean);
        setTranscript((prev) => [
          {
            id: crypto.randomUUID(),
            role: 'user',
            text: clean,
            ts: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 40));

        if (autoSilenceRun && !runInFlightRef.current && !speakingRef.current) {
          if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = window.setTimeout(() => {
            if (!runInFlightRef.current && !speakingRef.current && clean) {
              void launchRun(clean);
            }
          }, 3000);
        }
      }
    };

    rec.onerror = () => {
      setIsListening(false);
      if (!runInFlightRef.current && !speakingRef.current) {
        setBrainState('idle');
        setSpeakingLevel(0);
      }
    };
  }, [recognitionRef, autoSilenceRun]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
      if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current);
      if (pulseTimerRef.current) window.clearInterval(pulseTimerRef.current);
      window.speechSynthesis.cancel();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current);
        audioObjectUrlRef.current = null;
      }
    };
  }, []);

  const prepareSpeechSession = () => {
    const rec = recognitionRef.current;
    if (isListening && rec) {
      resumeListeningAfterSpeechRef.current = true;
      recognitionSuspendUntilRef.current = Date.now() + 3000;
      rec.stop();
    }

    speakingRef.current = true;
    setBrainState('speaking');
    setSpeakingLevel(1);
  };

  const finishSpeechSession = () => {
    speakingRef.current = false;
    setInterimText('');
    setSpeakingLevel(0);
    setBrainState(runInFlightRef.current ? 'thinking' : 'idle');
    recognitionSuspendUntilRef.current = Date.now() + 4000;

    const rec = recognitionRef.current;
    if (resumeListeningAfterSpeechRef.current && rec) {
      resumeListeningAfterSpeechRef.current = false;
      window.setTimeout(() => {
        try {
          rec.start();
        } catch {
          // no-op
        }
      }, 380);
    }
  };

  const stopAllSpeech = () => {
    window.speechSynthesis.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }
    speakingRef.current = false;
    setBrainState(runInFlightRef.current ? 'thinking' : 'idle');
    setSpeakingLevel(0);
  };

  const speakBrowser = (rawText: string, runId?: string) => {
    if (!('speechSynthesis' in window)) return;

    if (runId && lastSpokenRunRef.current === runId) {
      return;
    }

    const text = normalizeSpeechText(rawText).slice(0, 900);
    if (!text) return;
    lastAssistantSpeechRef.current = { text, at: Date.now() };

    const selectedVoice = pickVoice(voices);
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 12);

    if (!sentences.length) return;

    prepareSpeechSession();
    stopAllSpeech();
    prepareSpeechSession();

    let idx = 0;
    const baseRate = voiceProfile === 'natural' ? 0.93 : 1.0;
    const basePitch = voiceProfile === 'natural' ? 0.98 : 1.03;

    const speakNext = () => {
      const sentence = sentences[idx];
      if (!sentence) {
        finishSpeechSession();
        return;
      }

      const utter = new SpeechSynthesisUtterance(sentence);
      utter.lang = 'en-US';
      utter.rate = Math.max(0.85, Math.min(1.05, baseRate + (idx % 2 === 0 ? -0.02 : 0.02)));
      utter.pitch = basePitch;
      if (selectedVoice) utter.voice = selectedVoice;

      utter.onend = () => {
        idx += 1;
        window.setTimeout(speakNext, voiceProfile === 'natural' ? 150 : 90);
      };
      utter.onerror = finishSpeechSession;

      window.speechSynthesis.speak(utter);
    };

    speakNext();
    if (runId) lastSpokenRunRef.current = runId;

    setTranscript((prev) => [
      {
        id: crypto.randomUUID(),
        role: 'brain',
        text,
        ts: new Date().toISOString(),
      },
      ...prev,
    ].slice(0, 40));
  };

  const speakNeural = async (rawText: string, runId: string) => {
    if (runId && lastSpokenRunRef.current === runId) return;

    const text = normalizeSpeechText(rawText).slice(0, 900);
    if (!text) return;
    lastAssistantSpeechRef.current = { text, at: Date.now() };

    prepareSpeechSession();
    stopAllSpeech();
    prepareSpeechSession();

    try {
      const blob = await getRunSpeech(runId, neuralVoice);
      if (!blob.size) throw new Error('Empty audio response');

      const objectUrl = URL.createObjectURL(blob);
      audioObjectUrlRef.current = objectUrl;
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      audio.preload = 'auto';

      audio.onended = () => {
        finishSpeechSession();
        if (audioObjectUrlRef.current) {
          URL.revokeObjectURL(audioObjectUrlRef.current);
          audioObjectUrlRef.current = null;
        }
        audioRef.current = null;
      };

      audio.onerror = () => {
        finishSpeechSession();
        if (audioObjectUrlRef.current) {
          URL.revokeObjectURL(audioObjectUrlRef.current);
          audioObjectUrlRef.current = null;
        }
        audioRef.current = null;
      };

      await audio.play();
      lastSpokenRunRef.current = runId;

      setTranscript((prev) => [
        {
          id: crypto.randomUUID(),
          role: 'brain',
          text,
          ts: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 40));
    } catch {
      finishSpeechSession();
      setTranscript((prev) => [
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: 'Neural voice unavailable, switched to browser speech.',
          ts: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 40));
      speakBrowser(text, runId);
    }
  };

  const speak = async (rawText: string, runId?: string) => {
    if (voiceEngine === 'neural' && runId) {
      await speakNeural(rawText, runId);
      return;
    }
    speakBrowser(rawText, runId);
  };

  const mapEvent = (evt: Record<string, unknown>): EventView => ({
    ts: String(evt.ts ?? new Date().toISOString()),
    node: String(evt.node ?? 'system'),
    status: String(evt.status ?? 'info'),
    detail: String(evt.detail ?? ''),
  });

  const launchRun = async (launchTask: string) => {
    if (runInFlightRef.current) return;

    if (silenceTimerRef.current) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }

    runInFlightRef.current = true;
    setLoading(true);
    setBrainState('thinking');
    setEvents([]);
    setSpeakingLevel(0.45);

    streamRef.current?.close();
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);

    try {
      const created = await startRun(launchTask, mode);
      onRunChange(created.run_id, null);

      const source = streamEvents(created.run_id, (evt) => {
        const mapped = mapEvent(evt);
        setEvents((prev) => [mapped, ...prev].slice(0, 220));

        if (mapped.status === 'start') {
          setBrainState('thinking');
          setSpeakingLevel(0.35);
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

            const state = detail.state as Record<string, unknown>;
            const spoken = String(state.spoken_response ?? detail.output ?? '');
            if (spoken) {
              void speak(spoken, created.run_id);
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
    await launchRun(task);
  };

  const toggleListening = () => {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (isListening) {
      rec.stop();
      return;
    }
    try {
      rec.start();
    } catch {
      // start can throw if already active
    }
  };

  return (
    <section className="panel brain-console">
      <div className="brain-console-head">
        <h2>BRAIN CORE</h2>
        <p className="muted">{runStateLabel}</p>
      </div>

      <NeuralWave state={brainState} interimText={interimText} speakingLevel={speakingLevel} />

      <div className="voice-controls">
        <button type="button" onClick={toggleListening} disabled={!speechSupported || loading}>
          {isListening ? 'Stop Listening' : 'Start Listening'}
        </button>
        <button type="button" onClick={stopAllSpeech}>Stop Speaking</button>
      </div>

      <div className="voice-profile-row">
        <label>
          Voice Engine
          <select value={voiceEngine} onChange={(e) => setVoiceEngine(e.target.value as VoiceEngine)}>
            <option value="neural">Neural (OpenAI)</option>
            <option value="browser">Browser (local)</option>
          </select>
        </label>
      </div>

      <div className="voice-profile-row">
        <label>
          Neural Voice
          <select value={neuralVoice} onChange={(e) => setNeuralVoice(e.target.value as NeuralVoice)} disabled={voiceEngine !== 'neural'}>
            <option value="alloy">alloy</option>
            <option value="verse">verse</option>
            <option value="aria">aria</option>
          </select>
        </label>
      </div>

      <div className="voice-profile-row">
        <label>
          Voice Cadence
          <select value={voiceProfile} onChange={(e) => setVoiceProfile(e.target.value as VoiceProfile)}>
            <option value="natural">Natural</option>
            <option value="command">Command</option>
          </select>
        </label>
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={autoSilenceRun}
          onChange={(e) => setAutoSilenceRun(e.target.checked)}
        />
        Auto-run after 3s silence
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

      {run && (
        <div className="status-card">
          <h3>Run Status</h3>
          <p><strong>ID:</strong> {run.run_id}</p>
          <p><strong>Status:</strong> {run.status}</p>
          <p><strong>Updated:</strong> {new Date(run.updated_at).toLocaleString()}</p>
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
