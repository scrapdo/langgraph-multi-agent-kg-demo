import { describe, expect, it } from 'vitest';
import { VISUALIZER_OPTIONS, fallbackSpeakingLevel, normalizeSpeechText, shouldIgnoreTranscript } from './voice';

describe('voice helpers', () => {
  it('normalizes markdown-heavy speech text', () => {
    expect(normalizeSpeechText('## Hello **there** [link](https://x.com)')).toBe('Hello there link');
  });

  it('suppresses assistant echo transcripts shortly after speech output', () => {
    const now = 20_000;
    expect(shouldIgnoreTranscript('Tell me how you work', 'Tell me how you work.', now, now - 1000)).toBe(true);
    expect(shouldIgnoreTranscript('Different question', 'Tell me how you work.', now, now - 1000)).toBe(false);
  });

  it('computes non-zero fallback levels for listening and speaking states', () => {
    expect(fallbackSpeakingLevel('idle', 0, 1000)).toBe(0);
    expect(fallbackSpeakingLevel('listening', 42, 1000)).toBeGreaterThan(0);
    expect(fallbackSpeakingLevel('speaking', 0, 1000)).toBeGreaterThan(0);
  });

  it('exposes five selectable visualizer options', () => {
    expect(VISUALIZER_OPTIONS).toHaveLength(5);
    expect(VISUALIZER_OPTIONS.map((option) => option.id)).toEqual([
      'hal',
      'neon',
      'circular',
      'particles',
      'constellation',
    ]);
  });
});
