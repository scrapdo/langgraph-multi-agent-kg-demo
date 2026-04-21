/**
 * Handles the delegator's `route_to_specialist` tool calls.
 *
 *   1. Start a backend run forced into the right task_type.
 *   2. Stream tokens + steps via SSE into a live artifact the UI can show.
 *   3. On completion, fetch the run, extract the final output, and play it aloud
 *      in the specialist's ElevenLabs voice.
 *   4. Publish the artifact to the outputs rail.
 *   5. Return a short tool_result back to the delegator so it can close the loop.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskTypeOverride } from '../api/client';
import { getRun, getRunSpeech, startRun, streamEvents } from '../api/client';

export type SpecialistStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface SpecialistMetrics {
  elapsedMs?: number;
  totalTokens?: number;
  costUsd?: number;
  tokenAccuracy?: string;
}

export interface SpecialistArtifact {
  id: string;
  runId: string;
  agentId: string;
  agentLabel: string;
  taskType: string;
  task: string;
  status: SpecialistStatus;
  /** Live-growing text as tokens stream in. */
  liveContent: string;
  /** Full final answer once the run completes. */
  finalContent?: string;
  startedAt: string;
  finishedAt?: string;
  /** Tokens, cost, elapsed — shown as a small chip under the answer. */
  metrics?: SpecialistMetrics;
}

const AGENT_LABELS: Record<string, string> = {
  secretary: 'Secretary',
  wellness: 'Wellness coach',
  shopper: 'Shopper',
  social: 'Social strategist',
  researcher: 'Researcher',
  news: 'News analyst',
  writer: 'Writer',
  coder: 'Coder',
};

const AGENT_TASK_TYPES: Record<string, TaskTypeOverride> = {
  secretary: 'secretary',
  wellness: 'wellness_coaching',
  shopper: 'shopping',
  social: 'social_media',
  researcher: 'market_research',
  news: 'news_brief',
  writer: 'conversation',
  coder: 'conversation',
};

interface RouteArgs {
  agent_id?: string;
  task?: string;
}

interface HandoffOptions {
  /** Called for each completed specialist run so the delegator can be told. */
  onComplete?: (artifact: SpecialistArtifact) => void;
  /** Called on failure so the delegator knows. */
  onFailed?: (artifact: SpecialistArtifact, message: string) => void;
}

export interface UseSpecialistHandoffResult {
  artifacts: SpecialistArtifact[];
  /** Drop an artifact from the rail (user-initiated). */
  dismissArtifact: (id: string) => void;
  /** Kick off a run from a delegator tool call. Returns the artifact id. */
  runFromToolCall: (args: RouteArgs) => Promise<SpecialistArtifact>;
}

export function useSpecialistHandoff(options: HandoffOptions = {}): UseSpecialistHandoffResult {
  const [artifacts, setArtifacts] = useState<SpecialistArtifact[]>([]);
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  const callbacksRef = useRef<HandoffOptions>(options);
  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const updateArtifact = useCallback(
    (id: string, updater: (prev: SpecialistArtifact) => SpecialistArtifact) => {
      setArtifacts((prev) => prev.map((a) => (a.id === id ? updater(a) : a)));
    },
    [],
  );

  const dismissArtifact = useCallback((id: string) => {
    const audio = audioElsRef.current.get(id);
    if (audio) {
      audio.pause();
      audio.remove();
      audioElsRef.current.delete(id);
    }
    setArtifacts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const playSpecialistSpeech = useCallback(async (artifactId: string, runId: string, agentId: string) => {
    try {
      const blob = await getRunSpeech(runId, { agentId, provider: 'elevenlabs' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioElsRef.current.delete(artifactId);
      };
      audioElsRef.current.set(artifactId, audio);
      await audio.play();
    } catch {
      // Speech is best-effort — the transcript is still visible in the outputs rail.
    }
  }, []);

  const runFromToolCall = useCallback(
    async (args: RouteArgs): Promise<SpecialistArtifact> => {
      const agentId = String(args.agent_id ?? 'writer').toLowerCase();
      const task = String(args.task ?? '').trim() || 'Help the operator with their request.';
      const taskType = AGENT_TASK_TYPES[agentId] ?? 'conversation';
      const agentLabel = AGENT_LABELS[agentId] ?? agentId;

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      // Start the backend run immediately so we can put a real runId on the artifact.
      let runId = '';
      try {
        const response = await startRun(task, 'live', false, taskType);
        runId = response.run_id;
      } catch (err) {
        const failureArtifact: SpecialistArtifact = {
          id,
          runId: '',
          agentId,
          agentLabel,
          taskType,
          task,
          status: 'failed',
          liveContent: err instanceof Error ? err.message : String(err),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        setArtifacts((prev) => [failureArtifact, ...prev]);
        callbacksRef.current.onFailed?.(failureArtifact, failureArtifact.liveContent);
        return failureArtifact;
      }

      const initial: SpecialistArtifact = {
        id,
        runId,
        agentId,
        agentLabel,
        taskType,
        task,
        status: 'running',
        liveContent: '',
        startedAt: new Date().toISOString(),
      };
      setArtifacts((prev) => [initial, ...prev].slice(0, 12));

      // Subscribe to SSE for this run — accumulate live tokens for the UI.
      const source = streamEvents(runId, (event) => {
        const type = String(event.type ?? '').toLowerCase();
        if (type === 'token') {
          const delta = String(event.content ?? '');
          if (delta) {
            updateArtifact(id, (prev) => ({ ...prev, liveContent: prev.liveContent + delta }));
          }
        }
      });

      // Poll for the final state — the SSE stream closes itself on completion but
      // we need the canonical `final_report` text from the run record.
      await new Promise<void>((resolve) => {
        const poll = async () => {
          try {
            const detail = await getRun(runId);
            const status = detail.status;
            if (status === 'completed' || status === 'failed' || status === 'degraded') {
              source.close();
              const stateAny = detail.state as Record<string, unknown> | undefined;
              const finalReport =
                (stateAny?.final_report as string | undefined) ??
                (stateAny?.spoken_response as string | undefined) ??
                '';
              const metricsAny = (stateAny?.run_metrics ?? {}) as Record<string, unknown>;
              const toNum = (v: unknown): number | undefined =>
                typeof v === 'number' && Number.isFinite(v) ? v : undefined;
              const metrics: SpecialistMetrics = {
                elapsedMs: toNum(metricsAny.elapsed_ms),
                totalTokens: toNum(metricsAny.estimated_total_tokens),
                costUsd: toNum(metricsAny.estimated_cost_usd),
                tokenAccuracy:
                  typeof metricsAny.token_accuracy === 'string' ? metricsAny.token_accuracy : undefined,
              };
              const finished = new Date().toISOString();
              const finalStatus: SpecialistStatus = status === 'completed' ? 'completed' : 'failed';
              updateArtifact(id, (prev) => ({
                ...prev,
                status: finalStatus,
                finalContent: finalReport || prev.liveContent,
                liveContent: prev.liveContent || finalReport,
                finishedAt: finished,
                metrics,
              }));
              if (finalStatus === 'completed') {
                void playSpecialistSpeech(id, runId, agentId);
                const summary = (finalReport || '').slice(0, 1200);
                callbacksRef.current.onComplete?.({
                  ...initial,
                  status: 'completed',
                  finalContent: finalReport,
                  liveContent: finalReport,
                  finishedAt: finished,
                });
                // Return a short summary the delegator can reason about — full content is in the rail.
                void summary;
              } else {
                callbacksRef.current.onFailed?.({ ...initial, status: 'failed' }, 'Specialist run failed');
              }
              resolve();
              return;
            }
          } catch {
            // Keep polling on transient errors.
          }
          window.setTimeout(poll, 1500);
        };
        void poll();
      });

      return artifacts.find((a) => a.id === id) ?? initial;
    },
    [playSpecialistSpeech, updateArtifact, artifacts],
  );

  useEffect(() => {
    return () => {
      audioElsRef.current.forEach((audio) => {
        try {
          audio.pause();
          audio.remove();
        } catch {
          /* ignore */
        }
      });
      audioElsRef.current.clear();
    };
  }, []);

  return { artifacts, dismissArtifact, runFromToolCall };
}
