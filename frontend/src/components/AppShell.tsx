import {
  Activity,
  Bot,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  LayoutGrid,
  Mic,
  Moon,
  Radio,
  Settings,
  Sparkles,
  Sun,
  Terminal,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Tooltip, TooltipProvider } from '../ui';
import type { Appearance, AppearanceMode, EffectLayer } from '../lib/appearance';
import { cn } from '../ui/cn';

export type WorkspaceId = 'voice' | 'control' | 'intelligence' | 'specialists' | 'studio';

interface NavItem {
  id: WorkspaceId;
  label: string;
  icon: ReactNode;
  description: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'voice',
    label: 'Delegator',
    icon: <Mic size={16} aria-hidden />,
    description: 'Talk to the team. The coordinator routes to the right specialist.',
  },
  {
    id: 'control',
    label: 'Mission Control',
    icon: <Radio size={16} aria-hidden />,
    description: 'Launch runs, talk to the system, watch live state.',
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    icon: <Activity size={16} aria-hidden />,
    description: 'Graph lineage, memory timeline, claims.',
  },
  {
    id: 'specialists',
    label: 'Specialists',
    icon: <Bot size={16} aria-hidden />,
    description: 'Shopping, social, and secretary boards.',
  },
  {
    id: 'studio',
    label: 'Studio',
    icon: <Settings size={16} aria-hidden />,
    description: 'Agents, integrations, desktop, workbench.',
  },
];

interface AppShellProps {
  workspace: WorkspaceId;
  onWorkspaceChange: (id: WorkspaceId) => void;
  runStatus?: string;
  appearance: Appearance;
  onAppearanceChange: (patch: Partial<Appearance>) => void;
  children: ReactNode;
}

export function AppShell({
  workspace,
  onWorkspaceChange,
  runStatus,
  appearance,
  onAppearanceChange,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('kg-demo-sidebar-collapsed') === '1';
  });

  useEffect(() => {
    window.localStorage.setItem('kg-demo-sidebar-collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  const active = NAV_ITEMS.find((item) => item.id === workspace) ?? NAV_ITEMS[0];

  const setMode = (mode: AppearanceMode) => onAppearanceChange({ mode });
  const setEffects = (effects: EffectLayer) => onAppearanceChange({ effects });

  return (
    <TooltipProvider delayDuration={200}>
      <div
        data-slot="shell"
        className="min-h-screen flex text-[var(--color-fg-default)] bg-[var(--color-bg-canvas)]"
      >
        <aside
          className={cn(
            'sticky top-0 h-screen flex flex-col',
            'bg-[var(--color-bg-surface)] border-r border-[var(--color-border-default)]',
            'transition-[width] duration-[var(--motion-base)] ease-[var(--easing-standard)]',
            collapsed ? 'w-[56px]' : 'w-[236px]',
          )}
          aria-label="Primary navigation"
        >
          <div className="flex items-center gap-2 px-3 h-14 border-b border-[var(--color-border-default)]">
            <div
              className="h-8 w-8 rounded-[var(--radius-sm)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)] grid place-items-center"
              aria-hidden
            >
              <Sparkles size={16} />
            </div>
            {!collapsed ? (
              <div className="min-w-0 flex-1">
                <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] leading-none">Operator</p>
                <p className="text-[var(--text-sm)] font-semibold leading-tight truncate">
                  The Brain
                </p>
              </div>
            ) : null}
          </div>

          <nav className="flex-1 py-2">
            <ul className="space-y-0.5 px-1.5">
              {NAV_ITEMS.map((item) => (
                <li key={item.id}>
                  {collapsed ? (
                    <Tooltip content={item.label} side="right">
                      <button
                        type="button"
                        onClick={() => onWorkspaceChange(item.id)}
                        aria-label={item.label}
                        aria-current={workspace === item.id ? 'page' : undefined}
                        className={cn(
                          'flex items-center justify-center w-full h-9 rounded-[var(--radius-sm)]',
                          'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
                          workspace === item.id &&
                            'bg-[var(--color-bg-elevated)] text-[var(--color-fg-default)]',
                        )}
                      >
                        {item.icon}
                      </button>
                    </Tooltip>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onWorkspaceChange(item.id)}
                      aria-current={workspace === item.id ? 'page' : undefined}
                      className={cn(
                        'group flex items-center gap-2 w-full h-9 px-2.5 rounded-[var(--radius-sm)]',
                        'text-[var(--text-sm)] font-medium',
                        'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
                        workspace === item.id &&
                          'bg-[var(--color-bg-elevated)] text-[var(--color-fg-default)]',
                      )}
                    >
                      {item.icon}
                      <span className="flex-1 text-left truncate">{item.label}</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          <div className="px-1.5 py-2 border-t border-[var(--color-border-default)] space-y-1">
            {!collapsed ? (
              <>
                <div className="flex items-center gap-1 px-1 py-1">
                  <Tooltip content="Light mode">
                    <button
                      type="button"
                      onClick={() => setMode('light')}
                      aria-label="Light mode"
                      aria-pressed={appearance.mode === 'light'}
                      className={cn(
                        'flex-1 h-7 rounded-[var(--radius-sm)] inline-flex items-center justify-center gap-1',
                        'text-[var(--text-xs)] text-[var(--color-fg-muted)]',
                        'hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]',
                        appearance.mode === 'light' && 'bg-[var(--color-bg-elevated)] text-[var(--color-fg-default)]',
                      )}
                    >
                      <Sun size={14} aria-hidden />
                    </button>
                  </Tooltip>
                  <Tooltip content="Dark mode">
                    <button
                      type="button"
                      onClick={() => setMode('dark')}
                      aria-label="Dark mode"
                      aria-pressed={appearance.mode === 'dark'}
                      className={cn(
                        'flex-1 h-7 rounded-[var(--radius-sm)] inline-flex items-center justify-center gap-1',
                        'text-[var(--text-xs)] text-[var(--color-fg-muted)]',
                        'hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]',
                        appearance.mode === 'dark' && 'bg-[var(--color-bg-elevated)] text-[var(--color-fg-default)]',
                      )}
                    >
                      <Moon size={14} aria-hidden />
                    </button>
                  </Tooltip>
                  <Tooltip content={appearance.effects === 'hud' ? 'HUD effects on' : 'HUD effects off'}>
                    <button
                      type="button"
                      onClick={() => setEffects(appearance.effects === 'hud' ? 'none' : 'hud')}
                      aria-label="Toggle HUD effects"
                      aria-pressed={appearance.effects === 'hud'}
                      className={cn(
                        'flex-1 h-7 rounded-[var(--radius-sm)] inline-flex items-center justify-center gap-1',
                        'text-[var(--text-xs)] text-[var(--color-fg-muted)]',
                        'hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]',
                        appearance.effects === 'hud' && 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)]',
                      )}
                    >
                      <Terminal size={14} aria-hidden />
                    </button>
                  </Tooltip>
                </div>
                {runStatus ? (
                  <div className="px-2 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]">
                    <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">Run</p>
                    <p className="text-[var(--text-sm)] font-mono truncate">{runStatus}</p>
                  </div>
                ) : null}
              </>
            ) : null}

            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className={cn(
                'w-full h-8 rounded-[var(--radius-sm)] inline-flex items-center justify-center',
                'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
              )}
            >
              {collapsed ? <ChevronRight size={14} aria-hidden /> : <ChevronLeft size={14} aria-hidden />}
            </button>
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="sticky top-0 z-30 h-14 bg-[var(--color-bg-surface)]/80 backdrop-blur-md border-b border-[var(--color-border-default)] flex items-center gap-4 px-5">
            <div className="min-w-0 flex items-center gap-3">
              <LayoutGrid size={14} className="text-[var(--color-fg-subtle)]" aria-hidden />
              <h1 className="text-[var(--text-base)] font-semibold tracking-tight">{active.label}</h1>
              <Badge tone="neutral" size="sm">
                {active.description}
              </Badge>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <Badge tone="info" size="sm" icon={<FlaskConical size={12} aria-hidden />}>
                beta
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => (window.location.hash = '#/scheduler')}>
                Scheduler
              </Button>
            </div>
          </header>

          <main className="flex-1 min-w-0 p-5 lg:p-6 space-y-5">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
