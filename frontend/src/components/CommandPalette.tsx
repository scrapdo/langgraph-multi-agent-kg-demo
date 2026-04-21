import {
  ArrowRight,
  Bot,
  Focus,
  Globe,
  History,
  Keyboard,
  LayoutGrid,
  type LucideIcon,
  Mic,
  Moon,
  Plus,
  Radio,
  Search,
  Settings,
  Sparkles,
  Sun,
  Terminal,
  UserPen,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listRuns, type RunSummary } from '../api/client';
import { cn } from '../ui/cn';
import type { AppearanceMode, EffectLayer } from '../lib/appearance';
import type { WorkspaceId } from './AppShell';

export interface CommandAction {
  id: string;
  label: string;
  hint?: string;
  group: 'Actions' | 'Workspaces' | 'Conversations';
  icon: LucideIcon;
  shortcut?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (workspace: WorkspaceId) => void;
  onNewChat: () => void;
  onOpenProfile: () => void;
  onOpenBookmarklet: () => void;
  onOpenShortcuts: () => void;
  onEnterVoiceMode: () => void;
  onToggleFocusMode: () => void;
  onMorningBrief: () => void;
  onOpenRun: (summary: RunSummary) => void;
  appearance: { mode: AppearanceMode; effects: EffectLayer };
  onAppearanceChange: (patch: Partial<{ mode: AppearanceMode; effects: EffectLayer }>) => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onNavigate,
  onNewChat,
  onOpenProfile,
  onOpenBookmarklet,
  onOpenShortcuts,
  onEnterVoiceMode,
  onToggleFocusMode,
  onMorningBrief,
  onOpenRun,
  appearance,
  onAppearanceChange,
}: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refresh recent runs every time the palette opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    void listRuns(20)
      .then(setRuns)
      .catch(() => {});
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const runItems: CommandAction[] = useMemo(
    () =>
      runs.map((r) => ({
        id: `run:${r.run_id}`,
        label: r.title || '(empty)',
        hint: new Date(r.updated_at || r.created_at).toLocaleString(),
        group: 'Conversations' as const,
        icon: Bot,
        run: () => onOpenRun(r),
      })),
    [runs, onOpenRun],
  );

  const staticItems: CommandAction[] = useMemo(
    () => [
      {
        id: 'act:new-chat',
        label: 'New conversation',
        hint: 'Clear and start fresh',
        group: 'Actions',
        icon: Plus,
        shortcut: '⌘N',
        run: () => {
          onNewChat();
        },
      },
      {
        id: 'act:voice-mode',
        label: 'Enter voice mode',
        hint: 'Hands-free conversation with a humanoid presence',
        group: 'Actions',
        icon: Mic,
        run: () => onEnterVoiceMode(),
      },
      {
        id: 'act:morning-brief',
        label: 'Post morning brief',
        hint: "Today's priorities",
        group: 'Actions',
        icon: Sun,
        run: () => {
          onMorningBrief();
        },
      },
      {
        id: 'act:profile',
        label: 'Edit your profile',
        hint: 'Context the assistant uses on every run',
        group: 'Actions',
        icon: UserPen,
        run: () => {
          onOpenProfile();
        },
      },
      {
        id: 'act:history',
        label: 'Show conversation history',
        hint: 'Last 40 runs',
        group: 'Actions',
        icon: History,
        run: () => {
          // Ensure we navigate to Mission Control where history lives.
          onNavigate('control');
          // A small timing dance — the history button lives inside MissionControl;
          // the cleanest way to expose it from here would be lifting history state
          // up. For now, jumping to control is enough; user can click History there.
        },
      },
      {
        id: 'act:theme-dark',
        label: 'Use dark mode',
        group: 'Actions',
        icon: Moon,
        run: () => onAppearanceChange({ mode: 'dark' }),
      },
      {
        id: 'act:theme-light',
        label: 'Use light mode',
        group: 'Actions',
        icon: Sun,
        run: () => onAppearanceChange({ mode: 'light' }),
      },
      {
        id: 'act:hud-toggle',
        label: appearance.effects === 'hud' ? 'Turn off HUD effects' : 'Turn on HUD effects',
        hint: 'Decorative sci-fi layer',
        group: 'Actions',
        icon: Terminal,
        run: () => onAppearanceChange({ effects: appearance.effects === 'hud' ? 'none' : 'hud' }),
      },
      {
        id: 'act:focus-mode',
        label: 'Toggle focus mode',
        hint: 'Hide the right rail and chrome',
        group: 'Actions',
        icon: Focus,
        shortcut: '⌘.',
        run: () => onToggleFocusMode(),
      },
      {
        id: 'act:bookmarklet',
        label: 'Install browser bookmarklet',
        hint: 'Ask your brain about any webpage',
        group: 'Actions',
        icon: Globe,
        run: () => onOpenBookmarklet(),
      },
      {
        id: 'act:shortcuts',
        label: 'Show keyboard shortcuts',
        group: 'Actions',
        icon: Keyboard,
        shortcut: '⌘/',
        run: () => onOpenShortcuts(),
      },
      {
        id: 'nav:control',
        label: 'Go to Mission Control',
        group: 'Workspaces',
        icon: Radio,
        run: () => onNavigate('control'),
      },
      {
        id: 'nav:intelligence',
        label: 'Go to Intelligence',
        hint: 'Graph + memory',
        group: 'Workspaces',
        icon: LayoutGrid,
        run: () => onNavigate('intelligence'),
      },
      {
        id: 'nav:specialists',
        label: 'Go to Specialists',
        hint: 'Shopping / social / secretary',
        group: 'Workspaces',
        icon: Bot,
        run: () => onNavigate('specialists'),
      },
      {
        id: 'nav:studio',
        label: 'Go to Studio',
        hint: 'Agents / integrations / automations / workbench',
        group: 'Workspaces',
        icon: Settings,
        run: () => onNavigate('studio'),
      },
    ],
    [
      appearance.effects,
      onAppearanceChange,
      onEnterVoiceMode,
      onMorningBrief,
      onNavigate,
      onNewChat,
      onOpenBookmarklet,
      onOpenProfile,
      onOpenShortcuts,
      onToggleFocusMode,
    ],
  );

  const items = useMemo(() => [...staticItems, ...runItems], [staticItems, runItems]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const hay = `${item.label} ${item.hint ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  const grouped = useMemo(() => {
    const order: Array<CommandAction['group']> = ['Actions', 'Conversations', 'Workspaces'];
    const map = new Map<CommandAction['group'], CommandAction[]>();
    for (const g of order) map.set(g, []);
    for (const item of filtered) map.get(item.group)?.push(item);
    return order.map((g) => [g, map.get(g) ?? []] as const).filter(([, list]) => list.length > 0);
  }, [filtered]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered, active]);

  const runActive = useCallback(() => {
    const item = filtered[active];
    if (!item) return;
    item.run();
    onOpenChange(false);
  }, [active, filtered, onOpenChange]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(filtered.length - 1, a + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runActive();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange(false);
      }
    },
    [filtered.length, onOpenChange, runActive],
  );

  if (!open) return null;

  // Build a map from filtered-item to absolute index for highlight/selection.
  let cursor = -1;

  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--color-bg-overlay)] backdrop-blur-sm flex items-start justify-center pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="w-[min(92vw,640px)] bg-[var(--color-bg-surface)] border border-[var(--color-border-default)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] overflow-hidden">
        <div className="flex items-center gap-2 px-3 border-b border-[var(--color-border-default)]">
          <Search size={14} className="text-[var(--color-fg-muted)]" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type to search actions and conversations…"
            className="flex-1 h-11 bg-transparent outline-none text-[var(--text-sm)] placeholder:text-[var(--color-fg-subtle)]"
          />
          <span className="text-[10px] font-mono text-[var(--color-fg-subtle)] border border-[var(--color-border-subtle)] rounded-[var(--radius-xs)] px-1">
            ESC
          </span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {grouped.length === 0 ? (
            <p className="px-3 py-6 text-center text-[var(--text-sm)] text-[var(--color-fg-subtle)]">
              No matches.
            </p>
          ) : (
            grouped.map(([group, list]) => (
              <div key={group}>
                <p className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  {group}
                </p>
                <ul>
                  {list.map((item) => {
                    cursor += 1;
                    const isActive = cursor === active;
                    const Icon = item.icon;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onMouseEnter={() => setActive(cursor)}
                          onClick={() => {
                            item.run();
                            onOpenChange(false);
                          }}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 text-left text-[var(--text-sm)]',
                            isActive
                              ? 'bg-[var(--color-accent-subtle)] text-[var(--color-fg-default)]'
                              : 'text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)]',
                          )}
                        >
                          <Icon size={14} className="flex-shrink-0 text-[var(--color-fg-muted)]" aria-hidden />
                          <span className="flex-1 min-w-0 truncate">{item.label}</span>
                          {item.hint ? (
                            <span className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] truncate max-w-[40%]">
                              {item.hint}
                            </span>
                          ) : null}
                          {item.shortcut ? (
                            <span className="text-[10px] font-mono text-[var(--color-fg-subtle)] border border-[var(--color-border-subtle)] rounded-[var(--radius-xs)] px-1">
                              {item.shortcut}
                            </span>
                          ) : (
                            isActive && (
                              <ArrowRight size={12} className="text-[var(--color-fg-subtle)]" aria-hidden />
                            )
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-[var(--color-border-default)] bg-[var(--color-bg-sunken)] text-[10px] text-[var(--color-fg-subtle)] font-mono">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          <span className="ml-auto inline-flex items-center gap-1">
            <Sparkles size={10} aria-hidden /> ⌘K anywhere
          </span>
        </div>
      </div>
    </div>
  );
}
