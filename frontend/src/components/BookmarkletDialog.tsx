import { Check, Copy, Globe } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog, DialogContent } from '../ui';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:8000';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BookmarkletDialog({ open, onOpenChange }: Props) {
  const [code, setCode] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/bookmarklet`);
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { bookmarklet: string };
        if (!cancelled) setCode(data.bookmarklet);
      } catch (err) {
        if (!cancelled) setCode(`// Failed to load bookmarklet: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Ask the brain about any webpage"
        description="Drag this to your bookmarks bar, or copy and paste it as a new bookmark. Click it on any page to send the URL, title, and any highlighted text to the brain."
        className="!w-[min(94vw,680px)]"
      >
        <div className="space-y-4">
          <div className="rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] p-3">
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1.5">
              1. Drag to your bookmarks bar
            </p>
            <a
              draggable
              href={code || '#'}
              onClick={(e) => e.preventDefault()}
              className="inline-flex items-center gap-2 h-8 px-3 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-fg-on-accent)] font-medium hover:bg-[var(--color-accent-hover)]"
              title="Drag me to your bookmarks bar"
            >
              <Globe size={13} aria-hidden />
              Ask my brain
            </a>
            <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] mt-2">
              After dragging, click the bookmark on any page you want to ask about. The page will flash a confirmation,
              and a notification will appear in your brain app when the run finishes.
            </p>
          </div>

          <div className="rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)] p-3">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                Or copy the code directly
              </p>
              <Button
                size="sm"
                variant="ghost"
                leading={copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                onClick={copy}
                disabled={!code}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-[var(--color-fg-muted)] max-h-[200px] overflow-auto">
              {code || 'Loading…'}
            </pre>
          </div>

          <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)]">
            How it works: the bookmarklet sends the current URL, page title, and any selected text to
            <code className="mx-1 font-mono">POST /ask-about-page</code>
            on your local brain backend. A run is created immediately; you can watch it in Mission Control,
            or wait for the completion notification.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
