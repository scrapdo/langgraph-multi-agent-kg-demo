import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { AgentStudio } from './components/AgentStudio';
import { AppShell, type WorkspaceId } from './components/AppShell';
import { CapabilityDeckPanel } from './components/CapabilityDeckPanel';
import { BookmarkletDialog } from './components/BookmarkletDialog';
import { BrowserOpsPanel } from './components/BrowserOpsPanel';
import { ChatWatchersPanel } from './components/ChatWatchersPanel';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { VoiceMode } from './components/VoiceMode';
import { VoiceShell } from './components/VoiceShell';
import { WatcherPanel } from './components/WatcherPanel';
import { DesktopHistoryPanel } from './components/DesktopHistoryPanel';
import { DesktopOpsPanel } from './components/DesktopOpsPanel';
import { DesktopScheduleHistoryPanel } from './components/DesktopScheduleHistoryPanel';
import { DocumentWorkbenchPanel } from './components/DocumentWorkbenchPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HealthPanel } from './components/HealthPanel';
import { HuggingFacePanel } from './components/HuggingFacePanel';
import { MemoryCard } from './components/MemoryCard';
import { MemoryLibrary } from './components/MemoryLibrary';
import { MemoryPanel } from './components/MemoryPanel';
import { MissionControl } from './components/MissionControl';
import { OperatorInboxPanel } from './components/OperatorInboxPanel';
import { ProfileDialog } from './components/ProfileDialog';
import { ProfilePanel } from './components/ProfilePanel';
import { ReportWorkbenchPanel } from './components/ReportWorkbenchPanel';
import { RunStateHeader } from './components/RunStateHeader';
import { UsageDashboard } from './components/UsageDashboard';
import { WorkflowsPanel } from './components/WorkflowsPanel';
import { SecretaryPanel } from './components/SecretaryPanel';
import { ShoppingBoard } from './components/ShoppingBoard';
import { SocialOpsPanel } from './components/SocialOpsPanel';
import { SchedulerAdminPanel, SchedulerPublicPage } from './components/SchedulerSuite';
import {
  applyAppearance,
  loadAppearance,
  persistAppearance,
  type Appearance,
} from './lib/appearance';
import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from './ui';
import type { DesktopSchedule, RunDetail } from './types';
import './styles/index.css';

const GraphPanel = lazy(() =>
  import('./components/GraphPanel').then((module) => ({ default: module.GraphPanel })),
);

type IntelligenceView = 'graph' | 'memory' | 'library';
type StudioSection = 'agents-models' | 'integrations' | 'automations' | 'workbench';

export default function App() {
  const [hashRoute, setHashRoute] = useState(() => window.location.hash || '#/');
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceId>('voice');
  const [intelligenceView, setIntelligenceView] = useState<IntelligenceView>('graph');
  const [studioSection, setStudioSection] = useState<StudioSection>('agents-models');
  const [editingSchedule, setEditingSchedule] = useState<DesktopSchedule | null>(null);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [bookmarkletOpen, setBookmarkletOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusMode, setFocusMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('kg-demo-focus') === '1';
  });

  useEffect(() => {
    window.localStorage.setItem('kg-demo-focus', focusMode ? '1' : '0');
  }, [focusMode]);
  const [appearance, setAppearance] = useState<Appearance>(() =>
    typeof window === 'undefined' ? { mode: 'dark', effects: 'none' } : loadAppearance(window.localStorage),
  );

  useEffect(() => {
    applyAppearance(appearance, document.documentElement);
    persistAppearance(appearance, window.localStorage);
  }, [appearance]);

  const updateAppearance = useCallback((patch: Partial<Appearance>) => {
    setAppearance((prev) => ({ ...prev, ...patch }));
  }, []);

  // Global ⌘K opens the command palette; ⌘. toggles focus mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        setFocusMode((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && paletteOpen) setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  const threadId = (run?.state?.thread_id as string | undefined) ?? null;
  const runStatusLabel = useMemo(() => {
    if (!runId) return undefined;
    const status = run?.status ?? 'queued';
    return `${status} · ${runId.slice(0, 8)}`;
  }, [run?.status, runId]);

  useEffect(() => {
    const onHashChange = () => setHashRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (hashRoute.startsWith('#/book/')) {
    const slug = hashRoute.replace('#/book/', '').split(/[/?]/)[0];
    return <SchedulerPublicPage slug={slug} />;
  }
  if (hashRoute === '#/scheduler') {
    return <SchedulerAdminPanel />;
  }

  return (
    <AppShell
      workspace={workspace}
      onWorkspaceChange={setWorkspace}
      runStatus={runStatusLabel}
      appearance={appearance}
      onAppearanceChange={updateAppearance}
    >
      <ProfileDialog open={profileDialogOpen} onOpenChange={setProfileDialogOpen} />
      <BookmarkletDialog open={bookmarkletOpen} onOpenChange={setBookmarkletOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <VoiceMode open={voiceModeOpen} onClose={() => setVoiceModeOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={setWorkspace}
        onNewChat={() => {
          setRunId(null);
          setRun(null);
          setWorkspace('control');
          window.localStorage.removeItem('kg-demo-last-brief');
        }}
        onOpenProfile={() => setProfileDialogOpen(true)}
        onOpenBookmarklet={() => setBookmarkletOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onEnterVoiceMode={() => {
          setVoiceModeOpen(true);
          setWorkspace('control');
        }}
        onToggleFocusMode={() => setFocusMode((v) => !v)}
        onMorningBrief={() => {
          window.localStorage.removeItem('kg-demo-last-brief');
          setWorkspace('control');
        }}
        onOpenRun={() => setWorkspace('control')}
        appearance={appearance}
        onAppearanceChange={updateAppearance}
      />
      {workspace === 'voice' && (
        <ErrorBoundary label="Delegator">
          <VoiceShell />
        </ErrorBoundary>
      )}

      {workspace === 'control' && (
        <>
          <RunStateHeader runId={runId} run={run} />
          <div
            className={
              focusMode
                ? 'grid grid-cols-1 gap-5'
                : 'grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5'
            }
          >
            <ErrorBoundary label="Mission Control">
              <MissionControl
                onRunChange={(id, detail) => {
                  setRunId(id);
                  if (detail) setRun(detail);
                }}
                onEnterVoiceMode={() => setVoiceModeOpen(true)}
              />
            </ErrorBoundary>
            {!focusMode ? (
              <div className="space-y-4">
                <ErrorBoundary label="Context">
                  <MemoryCard onEditProfile={() => setProfileDialogOpen(true)} />
                </ErrorBoundary>
                <ErrorBoundary label="Health">
                  <HealthPanel run={run} />
                </ErrorBoundary>
                <ErrorBoundary label="Operator inbox">
                  <OperatorInboxPanel />
                </ErrorBoundary>
              </div>
            ) : null}
          </div>
          {!focusMode ? (
            <ErrorBoundary label="Capabilities">
              <CapabilityDeckPanel />
            </ErrorBoundary>
          ) : null}
        </>
      )}

      {workspace === 'intelligence' && (
        <ErrorBoundary label="Intelligence">
          <Tabs value={intelligenceView} onValueChange={(v) => setIntelligenceView(v as IntelligenceView)}>
            <TabsList aria-label="Intelligence view">
              <TabsTrigger value="graph">Knowledge graph</TabsTrigger>
              <TabsTrigger value="memory">Current run memory</TabsTrigger>
              <TabsTrigger value="library">Memory library</TabsTrigger>
            </TabsList>
            <TabsContent value="graph">
              <Suspense fallback={<Skeleton className="h-[420px] w-full" />}>
                <GraphPanel runId={runId} threadId={threadId} />
              </Suspense>
            </TabsContent>
            <TabsContent value="memory">
              <MemoryPanel runId={runId} run={run} />
            </TabsContent>
            <TabsContent value="library">
              <MemoryLibrary />
            </TabsContent>
          </Tabs>
        </ErrorBoundary>
      )}

      {workspace === 'specialists' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <ErrorBoundary label="Shopping">
            <ShoppingBoard runId={runId} run={run} />
          </ErrorBoundary>
          <ErrorBoundary label="Social">
            <SocialOpsPanel runId={runId} run={run} />
          </ErrorBoundary>
          <ErrorBoundary label="Secretary">
            <SecretaryPanel />
          </ErrorBoundary>
        </div>
      )}

      {workspace === 'studio' && (
        <ErrorBoundary label="Studio">
          <Tabs value={studioSection} onValueChange={(v) => setStudioSection(v as StudioSection)}>
            <TabsList aria-label="Studio section">
              <TabsTrigger value="agents-models">Agents & models</TabsTrigger>
              <TabsTrigger value="integrations">Integrations</TabsTrigger>
              <TabsTrigger value="automations">Desktop & automations</TabsTrigger>
              <TabsTrigger value="workbench">Workbench</TabsTrigger>
            </TabsList>

            <TabsContent value="agents-models">
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)] gap-5">
                <div className="space-y-5">
                  <UsageDashboard />
                  <ProfilePanel />
                  <AgentStudio />
                </div>
                <HuggingFacePanel />
              </div>
            </TabsContent>

            <TabsContent value="integrations">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <SecretaryPanel />
                <ChatWatchersPanel />
                <BrowserOpsPanel />
              </div>
            </TabsContent>

            <TabsContent value="automations">
              <div className="space-y-4">
                <WorkflowsPanel />
                <WatcherPanel />
                <DesktopOpsPanel
                  runId={runId}
                  run={run}
                  editingSchedule={editingSchedule}
                  onLoadedSchedule={() => setEditingSchedule(null)}
                />
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <DesktopScheduleHistoryPanel
                    onEditSchedule={(schedule) => {
                      setEditingSchedule(schedule);
                      setStudioSection('automations');
                    }}
                  />
                  <DesktopHistoryPanel />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="workbench">
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <DocumentWorkbenchPanel />
                <ReportWorkbenchPanel runId={runId} />
              </div>
            </TabsContent>
          </Tabs>
        </ErrorBoundary>
      )}
    </AppShell>
  );
}
