import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { getRun, startRun, streamEvents } from '../api/client';
import type { RunDetail, RunMode } from '../types';

type BrainState = 'idle' | 'listening' | 'thinking' | 'speaking';
type TranscriptRole = 'user' | 'brain' | 'system';

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
  onRunChange: (runId: string | null) => void;
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

export function RunConsole({ onRunChange }: Props) {
  const [task, setTask] = useState('Build a market research brief for semiconductor momentum this week.');
  const [mode, setMode] = useState<RunMode>('simulation');
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(false);
  const [brainState, setBrainState] = useState<BrainState>('idle');
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [speechSupported, setSpeechSupported] = useState(true);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  const recognitionRef = useSpeechRecognition();

  const runStateLabel = useMemo(() => {
    if (brainState === 'listening') return 'Listening';
    if (brainState === 'thinking') return 'Thinking';
    if (brainState === 'speaking') return 'Speaking';
    return 'Idle';
  }, [brainState]);

  useEffect(() => {
    const rec = recognitionRef.current;
    if (!rec) {
      setSpeechSupported(false);
      return;
    }
    setSpeechSupported(true);

    rec.onstart = () => {
      setIsListening(true);
      setBrainState('listening');
    };

    rec.onend = () => {
      setIsListening(false);
      if (brainState === 'listening') setBrainState('idle');
    };

    rec.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcriptPart = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += transcriptPart;
        else interim += transcriptPart;
      }
      setInterimText(interim);
      if (finalText.trim()) {
        const clean = finalText.trim();
        setTask(clean);
        setTranscript((prev) => [
          {
            id: crypto.randomUUID(),
            role: 'user',
            text: clean,
            ts: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 30));
      }
    };

    rec.onerror = () => {
      setIsListening(false);
      setBrainState('idle');
    };
  }, [recognitionRef, brainState]);

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    const utter = new SpeechSynthesisUtterance(text.slice(0, 800));
    utter.rate = 1;
    utter.pitch = 1;
    utter.onstart = () => setBrainState('speaking');
    utter.onend = () => setBrainState('idle');
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);

    setTranscript((prev) => [
      {
        id: crypto.randomUUID(),
        role: 'brain',
        text: text.slice(0, 400),
        ts: new Date().toISOString(),
      },
      ...prev,
    ].slice(0, 30));
  };

  const mapEvent = (evt: Record<string, unknown>): EventView => ({
    ts: String(evt.ts ?? new Date().toISOString()),
    node: String(evt.node ?? 'system'),
    status: String(evt.status ?? 'info'),
    detail: String(evt.detail ?? ''),
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setBrainState('thinking');
    setEvents([]);

    try {
      const created = await startRun(task, mode);
      onRunChange(created.run_id);

      const source = streamEvents(created.run_id, (evt) => {
        const mapped = mapEvent(evt);
        setEvents((prev) => [mapped, ...prev].slice(0, 200));

        if (mapped.node === 'system' && mapped.status === 'completed') {
          setBrainState('speaking');
        } else if (mapped.status === 'start') {
          setBrainState('thinking');
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
          ].slice(0, 30));
        }
      });

      setTimeout(() => source.close(), 10 * 60 * 1000);

      const poll = async () => {
        const detail = await getRun(created.run_id);
        setRun(detail);
        if (['completed', 'failed', 'degraded'].includes(detail.status)) {
          source.close();
          if (detail.output) speak(detail.output);
          else setBrainState('idle');
          return;
        }
        setTimeout(poll, 1200);
      };

      poll();
    } finally {
      setLoading(false);
    }
  };

  const toggleListening = () => {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (isListening) {
      rec.stop();
      return;
    }
    rec.start();
  };

  return (
    <section className="panel brain-panel">
      <h2>Brain Console</h2>
      <div className={`brain-orb state-${brainState}`}>
        <div className="brain-core" />
      </div>
      <p className="brain-state">State: {runStateLabel}</p>

      <div className={`voice-meter state-${brainState}`} aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>

      <div className="voice-controls">
        <button type="button" onClick={toggleListening} disabled={!speechSupported}>
          {isListening ? 'Stop Listening' : 'Start Listening'}
        </button>
        <button
          type="button"
          onClick={() => {
            window.speechSynthesis.cancel();
            setBrainState('idle');
          }}
        >
          Stop Speaking
        </button>
      </div>

      {!speechSupported && <p className="muted">Speech input is not supported in this browser.</p>}
      {interimText && <p className="muted">Live transcript: {interimText}</p>}

      <form onSubmit={onSubmit} className="form-grid">
        <label>
          Prompt to Brain
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={4} required />
        </label>
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)}>
            <option value="simulation">simulation</option>
            <option value="live">live</option>
          </select>
        </label>
        <button disabled={loading} type="submit">{loading ? 'Launching...' : 'Run Brain Workflow'}</button>
      </form>

      {run && (
        <div className="status-card">
          <h3>Run Status</h3>
          <p><strong>ID:</strong> {run.run_id}</p>
          <p><strong>Status:</strong> {run.status}</p>
          <p><strong>Updated:</strong> {new Date(run.updated_at).toLocaleString()}</p>
          {run.output && <pre className="output">{run.output}</pre>}
        </div>
      )}

      <div className="events">
        <h3>Live Events</h3>
        <ul>
          {events.map((evt, idx) => (
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
          {transcript.map((entry) => (
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
