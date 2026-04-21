/**
 * Polls ``/proactive`` every ~45s and surfaces the results as "briefings":
 * the latest successful output of each scheduled task, regardless of which
 * browser session actually kicked it off.
 *
 * Why this exists: scheduled runs fire in the backend while no browser tab
 * is open. Without this hook, you'd never see the output of your 8am morning
 * brief — the OutputsRail only knows about runs the current session started.
 *
 * The hook also fires a `onNewlyCompleted` callback on the first render
 * that sees a previously-unseen completion. VoiceShell wires that into
 * ``window.desktop.notify`` so finished proactive runs ping the dock.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { listProactiveTasks, type ProactiveTask } from '../api/client';

const POLL_INTERVAL_MS = 45 * 1000;
const SEEN_STORAGE_KEY = 'brain:proactive:seen-at';

export interface UseProactiveBriefingsOptions {
  /** Called once for each proactive task whose last_run_completed_at advanced
   *  to a new value since we last saw it. Use this to fire a desktop notification. */
  onNewlyCompleted?: (task: ProactiveTask) => void;
  /** Disable polling (useful for tests). */
  disabled?: boolean;
}

export interface UseProactiveBriefingsResult {
  briefings: ProactiveTask[];
  loading: boolean;
  error: string | null;
  /** Manually trigger a refresh (after schedule edits, etc). */
  refresh: () => Promise<void>;
  /** Mark a task's current completion as "seen" — stops repeat notifies. */
  markSeen: (taskId: string) => void;
}

type SeenMap = Record<string, string>; // task_id -> last_run_completed_at we've shown

function loadSeen(): SeenMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    /* quota exceeded / disabled — best-effort */
  }
}

export function useProactiveBriefings(
  options: UseProactiveBriefingsOptions = {},
): UseProactiveBriefingsResult {
  const { onNewlyCompleted, disabled } = options;
  const [briefings, setBriefings] = useState<ProactiveTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seenRef = useRef<SeenMap>(loadSeen());
  const notifyRef = useRef(onNewlyCompleted);
  useEffect(() => {
    notifyRef.current = onNewlyCompleted;
  }, [onNewlyCompleted]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const tasks = await listProactiveTasks();
      // Filter: only tasks that have actually completed at least once.
      // Pre-completion we have nothing to show; surfacing them would be noise.
      const completed = tasks.filter((t) => t.last_run_status && t.last_output_summary);
      // Most-recent success first — matches how a human would read a briefings list.
      completed.sort((a, b) => {
        const ai = a.last_success_at || a.last_run_completed_at || '';
        const bi = b.last_success_at || b.last_run_completed_at || '';
        return bi.localeCompare(ai);
      });
      setBriefings(completed);
      setError(null);

      // Fire onNewlyCompleted for any task whose completion timestamp is newer
      // than the last one we fired for. First load after a clean localStorage
      // is treated as "already seen" for every task — we don't want to spam
      // notifications for yesterday's briefs on first open.
      const seen = seenRef.current;
      let dirty = false;
      const firstEverLoad = Object.keys(seen).length === 0;
      for (const task of completed) {
        const ts = task.last_run_completed_at || task.last_success_at || '';
        if (!ts) continue;
        const prior = seen[task.id];
        if (prior === ts) continue;
        // First load: just stamp as seen without notifying.
        if (!firstEverLoad && prior !== undefined && ts > prior && task.last_run_status === 'completed') {
          notifyRef.current?.(task);
        }
        seen[task.id] = ts;
        dirty = true;
      }
      if (dirty) saveSeen(seen);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const markSeen = useCallback((taskId: string) => {
    const task = briefings.find((t) => t.id === taskId);
    if (!task) return;
    const ts = task.last_run_completed_at || task.last_success_at || '';
    if (!ts) return;
    seenRef.current[taskId] = ts;
    saveSeen(seenRef.current);
  }, [briefings]);

  useEffect(() => {
    if (disabled) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [disabled, refresh]);

  return { briefings, loading, error, refresh, markSeen };
}
