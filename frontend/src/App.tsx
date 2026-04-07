import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { AgentStudio } from './components/AgentStudio';
import { DesktopHistoryPanel } from './components/DesktopHistoryPanel';
import { DesktopOpsPanel } from './components/DesktopOpsPanel';
import { HeyGenPanel } from './components/HeyGenPanel';
import { HealthPanel } from './components/HealthPanel';
import { HuggingFacePanel } from './components/HuggingFacePanel';
import { MemoryPanel } from './components/MemoryPanel';
import { RunConsole } from './components/RunConsole';
import { ShoppingBoard } from './components/ShoppingBoard';
import { SocialOpsPanel } from './components/SocialOpsPanel';
import { DEFAULT_THEME, THEMES, loadTheme, persistTheme, type ThemeId } from './lib/themes';
import type { RunDetail } from './types';
import './styles.css';

const GraphPanel = lazy(() => import('./components/GraphPanel').then((module) => ({ default: module.GraphPanel })));

type Workspace = 'control' | 'intelligence' | 'specialists' | 'studio';
type IntelligenceView = 'graph' | 'memory';
type StudioView = 'agents' | 'models' | 'avatar' | 'desktop' | 'history';

export default function App() {
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [workspace, setWorkspace] = useState<Workspace>('control');
  const [intelligenceView, setIntelligenceView] = useState<IntelligenceView>('graph');
  const [studioView, setStudioView] = useState<StudioView>('agents');
  const [theme, setTheme] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return DEFAULT_THEME;
    return loadTheme(window.localStorage);
  });

  const runStatus = useMemo(() => run?.status ?? 'idle', [run?.status]);
  const activeTheme = useMemo(() => THEMES.find((item) => item.id === theme) ?? THEMES[0], [theme]);
  const threadId = (run?.state?.thread_id as string | undefined) ?? null;

  useEffect(() => {
    persistTheme(theme, window.localStorage);
    document.body.dataset.theme = theme;
  }, [theme]);

  return (
    <main className={`app-shell theme-${theme}`}>
      <header className="hero hud-frame">
        <div className="hero-copy">
          <p className="eyebrow">NEURAL OPS CONSOLE</p>
          <h1>LangGraph Multi-Agent Brain</h1>
          <p>
            Voice-first mission console for coordinator, researcher, critic, and writer agents with live graph,
            memory, model routing, and avatar/video integrations.
          </p>
        </div>
        <div className="theme-switcher hud-frame">
          <div className="theme-switcher-copy">
            <p className="metric-label">Theme</p>
            <p className="metric-value">{activeTheme.label}</p>
          </div>
          <label className="theme-switcher-select">
            <span className="sr-only">Theme selector</span>
            <select value={theme} onChange={(e) => setTheme(e.target.value as ThemeId)}>
              {THEMES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <section className="status-strip hud-frame">
        <article>
          <p className="metric-label">Run ID</p>
          <p className="metric-value">{runId ?? 'none'}</p>
        </article>
        <article>
          <p className="metric-label">Thread</p>
          <p className="metric-value">{threadId ?? 'none'}</p>
        </article>
        <article>
          <p className="metric-label">Mode</p>
          <p className="metric-value">{run?.mode ?? 'simulation'}</p>
        </article>
        <article>
          <p className="metric-label">Status</p>
          <p className={`metric-value status-${runStatus}`}>{runStatus}</p>
        </article>
        <article>
          <p className="metric-label">Last Update</p>
          <p className="metric-value">{run?.updated_at ? new Date(run.updated_at).toLocaleTimeString() : '--:--:--'}</p>
        </article>
      </section>

      <section className="workspace-shell hud-frame">
        <div className="workspace-bar">
          <div className="workspace-copy">
            <p className="eyebrow">WORKSPACE</p>
            <h2>
              {workspace === 'control'
                ? 'Mission Control'
                : workspace === 'intelligence'
                  ? 'Graph And Memory'
                  : workspace === 'specialists'
                    ? 'Specialist Boards'
                  : 'Models, Agents, And Avatars'}
            </h2>
            <p className="muted">
              {workspace === 'control'
                ? 'Launch runs, speak with the system, and monitor live operational state.'
                : workspace === 'intelligence'
                  ? 'Inspect graph lineage, recalled memory, claims, and thread context without dashboard clutter.'
                  : workspace === 'specialists'
                    ? 'Use focused operator panels for shopping and social workflows instead of digging through raw traces.'
                  : 'Configure agent identity, provider routing, open-model discovery, and avatar/video tooling.'}
            </p>
          </div>
          <div className="workspace-tabs" role="tablist" aria-label="Primary workspace">
            <button
              type="button"
              className={workspace === 'control' ? 'workspace-tab active' : 'workspace-tab'}
              onClick={() => setWorkspace('control')}
            >
              Control
            </button>
            <button
              type="button"
              className={workspace === 'intelligence' ? 'workspace-tab active' : 'workspace-tab'}
              onClick={() => setWorkspace('intelligence')}
            >
              Intelligence
            </button>
            <button
              type="button"
              className={workspace === 'specialists' ? 'workspace-tab active' : 'workspace-tab'}
              onClick={() => setWorkspace('specialists')}
            >
              Specialists
            </button>
            <button
              type="button"
              className={workspace === 'studio' ? 'workspace-tab active' : 'workspace-tab'}
              onClick={() => setWorkspace('studio')}
            >
              Studio
            </button>
          </div>
        </div>

        {workspace === 'control' && (
          <section className="grid layout-main">
            <RunConsole
              onRunChange={(id, detail) => {
                setRunId(id);
                if (detail) setRun(detail);
              }}
            />
            <HealthPanel run={run} />
          </section>
        )}

        {workspace === 'intelligence' && (
          <>
            <div className="subworkspace-tabs" role="tablist" aria-label="Intelligence view">
              <button
                type="button"
                className={intelligenceView === 'graph' ? 'workspace-tab active' : 'workspace-tab'}
                onClick={() => setIntelligenceView('graph')}
              >
                Knowledge Graph
              </button>
              <button
                type="button"
                className={intelligenceView === 'memory' ? 'workspace-tab active' : 'workspace-tab'}
                onClick={() => setIntelligenceView('memory')}
              >
                Memory And Claims
              </button>
            </div>
            {intelligenceView === 'graph' ? (
              <Suspense fallback={<section className="panel graph-panel"><h2>Knowledge Graph</h2><p className="muted">Loading graph renderer...</p></section>}>
                <GraphPanel runId={runId} threadId={threadId} />
              </Suspense>
            ) : (
              <MemoryPanel runId={runId} run={run} />
            )}
          </>
        )}

        {workspace === 'specialists' && (
          <section className="grid layout-main">
            <ShoppingBoard runId={runId} run={run} />
            <SocialOpsPanel runId={runId} run={run} />
          </section>
        )}

        {workspace === 'studio' && (
          <>
            <div className="subworkspace-tabs" role="tablist" aria-label="Studio view">
              <button
                type="button"
                className={studioView === 'agents' ? 'workspace-tab active' : 'workspace-tab'}
                onClick={() => setStudioView('agents')}
              >
                Agent Studio
              </button>
              <button
                type="button"
                className={studioView === 'models' ? 'workspace-tab active' : 'workspace-tab'}
                onClick={() => setStudioView('models')}
              >
                Hugging Face
              </button>
              <button
                type="button"
                className={studioView === 'avatar' ? 'workspace-tab active' : 'workspace-tab'}
                onClick={() => setStudioView('avatar')}
              >
                HeyGen
              </button>
              <button
                type="button"
                className={studioView === 'desktop' ? 'workspace-tab active' : 'workspace-tab'}
                onClick={() => setStudioView('desktop')}
              >
                Desktop
              </button>
              <button
                type="button"
                className={studioView === 'history' ? 'workspace-tab active' : 'workspace-tab'}
                onClick={() => setStudioView('history')}
              >
                History
              </button>
            </div>
            {studioView === 'agents' && <AgentStudio theme={theme} onThemeChange={setTheme} />}
            {studioView === 'models' && <HuggingFacePanel />}
            {studioView === 'avatar' && <HeyGenPanel run={run} />}
            {studioView === 'desktop' && <DesktopOpsPanel runId={runId} run={run} />}
            {studioView === 'history' && <DesktopHistoryPanel />}
          </>
        )}
      </section>
    </main>
  );
}
