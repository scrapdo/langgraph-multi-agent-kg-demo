import { useCallback, useEffect, useRef, useState } from 'react';

type RecognitionCtor = new () => SpeechRecognition;

export interface UseVoiceInputResult {
  supported: boolean;
  listening: boolean;
  transcript: string;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  error: string | null;
}

/**
 * Wrapper around the browser Speech Recognition API.
 *
 * Two common failure modes handled here:
 *   1. Electron / Chromium needs an explicit microphone permission grant. We
 *      request it up-front via getUserMedia; if denied, .start() will abort
 *      immediately and we surface a clear error.
 *   2. Chromium's webkitSpeechRecognition silently auto-ends on short silences
 *      even with continuous=true. If the user hasn't manually stopped, we
 *      restart inside onend so the session feels continuous.
 */
export function useVoiceInput(lang = 'en-US'): UseVoiceInputResult {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldListenRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const permissionGrantedRef = useRef(false);

  const Ctor =
    (typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null) as RecognitionCtor | null;
  const supported = Boolean(Ctor);

  useEffect(() => {
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = '';
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i];
        if (piece.isFinal) final += piece[0].transcript;
        else interim += piece[0].transcript;
      }
      setTranscript((prev) => (final ? (prev + final).trim() : (prev + interim).trim()));
    };

    recognition.onerror = (evt: SpeechRecognitionErrorEvent) => {
      // "no-speech" is expected between utterances; let the auto-restart path handle it.
      if (evt.error === 'no-speech' || evt.error === 'aborted') return;
      const messages: Record<string, string> = {
        'not-allowed': 'Microphone access denied. Grant permission to System Settings → Privacy → Microphone → The Brain.',
        'service-not-allowed': 'Speech recognition service unavailable.',
        'audio-capture': 'No microphone detected.',
        network: 'Speech recognition needs network access to Google — check your connection.',
      };
      setError(messages[evt.error] || `Speech recognition error: ${evt.error}`);
      shouldListenRef.current = false;
      setListening(false);
    };

    recognition.onend = () => {
      if (shouldListenRef.current) {
        // Auto-restart — Chromium drops the stream on silence even with continuous=true.
        if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = window.setTimeout(() => {
          const r = recognitionRef.current;
          if (!r || !shouldListenRef.current) return;
          try {
            r.start();
          } catch {
            // "InvalidStateError" happens if already started; harmless.
          }
        }, 150);
      } else {
        setListening(false);
      }
    };

    recognitionRef.current = recognition;
    return () => {
      shouldListenRef.current = false;
      if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    };
  }, [Ctor, lang]);

  const requestMic = useCallback(async () => {
    if (permissionGrantedRef.current) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This environment has no microphone API.');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Release the track immediately; the SpeechRecognition API opens its own.
      stream.getTracks().forEach((t) => t.stop());
      permissionGrantedRef.current = true;
      return true;
    } catch (err) {
      const message =
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone access was denied. Open System Settings → Privacy → Microphone and allow The Brain, then try again.'
          : err instanceof Error
            ? `Could not access microphone: ${err.message}`
            : 'Could not access microphone.';
      setError(message);
      return false;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setTranscript('');
    const recognition = recognitionRef.current;
    if (!recognition) {
      setError('Speech recognition is not available in this environment.');
      return;
    }
    const granted = await requestMic();
    if (!granted) return;
    shouldListenRef.current = true;
    try {
      recognition.start();
      setListening(true);
    } catch (err) {
      // Most browsers throw if .start() is called while a previous session is
      // still ending. The onend auto-restart will pick it up; just reflect state.
      if (err instanceof Error && err.name !== 'InvalidStateError') {
        setError(err.message);
        shouldListenRef.current = false;
        setListening(false);
      } else {
        setListening(true);
      }
    }
  }, [requestMic]);

  const stop = useCallback(() => {
    shouldListenRef.current = false;
    if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
    setListening(false);
  }, []);

  const reset = useCallback(() => setTranscript(''), []);

  return { supported, listening, transcript, start, stop, reset, error };
}
