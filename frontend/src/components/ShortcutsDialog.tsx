import { Dialog, DialogContent } from '../ui';

interface Shortcut {
  keys: string[];
  label: string;
  group: string;
}

const SHORTCUTS: Shortcut[] = [
  // Global
  { keys: ['⌘', 'K'], label: 'Command palette', group: 'Global' },
  { keys: ['⌘', '⇧', 'Space'], label: 'Focus the main window from anywhere', group: 'Global' },
  { keys: ['⌘', '⌥', 'Space'], label: 'Open the mini composer from anywhere', group: 'Global' },
  { keys: ['⌘', '/'], label: 'Show this cheat sheet', group: 'Global' },
  { keys: ['⌘', '.'], label: 'Toggle focus mode', group: 'Global' },
  { keys: ['⌘', 'R'], label: 'Reload', group: 'Global' },
  { keys: ['⌘', '⇧', 'R'], label: 'Hard reload (clear cache)', group: 'Global' },

  // Chat
  { keys: ['Enter'], label: 'Send message', group: 'Chat' },
  { keys: ['⌥', 'Enter'], label: 'Send in background (notify when done)', group: 'Chat' },
  { keys: ['⇧', 'Enter'], label: 'Newline in the input', group: 'Chat' },
  { keys: ['⌘', 'Space'], label: 'Hold to dictate (push-to-talk)', group: 'Chat' },
  { keys: ['Drop file / URL'], label: 'Attach to the next message', group: 'Chat' },
  { keys: ['Click Edit'], label: 'Rewind to a previous user message and resubmit', group: 'Chat' },

  // Messages
  { keys: ['Hover'], label: 'Reveal Copy / Edit / Remember / Why', group: 'Messages' },
  { keys: ['Copy'], label: 'Copy the message text', group: 'Messages' },
  { keys: ['Remember'], label: 'Save the content as a profile fact', group: 'Messages' },
  { keys: ['Why'], label: 'See the memory / tools / graph that produced this answer', group: 'Messages' },
];

function Keycap({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={i} className="inline-flex items-center">
          <kbd className="font-mono text-[10px] px-1.5 h-5 inline-flex items-center rounded-[var(--radius-xs)] bg-[var(--color-bg-canvas)] border border-[var(--color-border-subtle)] text-[var(--color-fg-default)]">
            {k}
          </kbd>
          {i < keys.length - 1 && keys.length > 1 && !['Drop file / URL', 'Hover', 'Copy', 'Remember', 'Why', 'Click Edit'].includes(keys[0]) ? (
            <span className="mx-0.5 text-[var(--color-fg-subtle)]">+</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const groups = Array.from(new Set(SHORTCUTS.map((s) => s.group)));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Keyboard shortcuts"
        description="Everything you can do without reaching for the mouse."
        className="!w-[min(94vw,600px)]"
      >
        <div className="max-h-[60vh] overflow-y-auto">
          {groups.map((group) => (
            <div key={group} className="mb-4 last:mb-0">
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1.5">{group}</p>
              <ul className="divide-y divide-[var(--color-border-subtle)]">
                {SHORTCUTS.filter((s) => s.group === group).map((s, i) => (
                  <li key={i} className="flex items-center justify-between py-2 gap-4">
                    <span className="text-[var(--text-sm)] text-[var(--color-fg-default)] flex-1">{s.label}</span>
                    <Keycap keys={s.keys} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
