export type BrainState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type VisualizerMode = 'hal' | 'neon' | 'circular' | 'particles' | 'constellation';

export interface VisualizerOption {
  id: VisualizerMode;
  label: string;
}

export const VISUALIZER_OPTIONS: VisualizerOption[] = [
  { id: 'hal', label: 'HAL' },
  { id: 'neon', label: 'Neon Wave Spectrum' },
  { id: 'circular', label: 'Minimal Circular Bars' },
  { id: 'particles', label: 'Abstract Particle Effects' },
  { id: 'constellation', label: 'Constellation Dots' },
];

export function normalizeSpeechText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/#+\s/g, ' ')
    .replace(/[*_~>-]/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeForMatch(text: string) {
  return normalizeSpeechText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

export function shouldIgnoreTranscript(
  userText: string,
  assistantText: string,
  now: number,
  assistantAt: number,
  duplicateWindowMs = 14000,
) {
  const userNorm = normalizeForMatch(userText);
  const aiNorm = normalizeForMatch(assistantText);
  const recentAssistantSpeech = now - assistantAt < duplicateWindowMs;
  return Boolean(recentAssistantSpeech && aiNorm && userNorm && (aiNorm.includes(userNorm) || userNorm.includes(aiNorm)));
}

export function fallbackSpeakingLevel(state: BrainState, interimLength: number, tickMs: number) {
  if (state !== 'speaking' && state !== 'listening') return 0;
  const t = tickMs / 180;
  if (state === 'speaking') {
    return 0.45 + Math.abs(Math.sin(t)) * 0.5;
  }
  const interimBoost = Math.min(0.35, interimLength / 120);
  return 0.15 + Math.abs(Math.sin(t * 0.8)) * 0.28 + interimBoost;
}
