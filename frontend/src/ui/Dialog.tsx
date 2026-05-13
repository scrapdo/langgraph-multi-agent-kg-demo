import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';
import { cn } from './cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { title: string; description?: ReactNode }
>(function DialogContent({ className, children, title, description, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-[var(--color-bg-overlay)] backdrop-blur-sm',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
          'w-[min(92vw,520px)] max-h-[86vh] overflow-auto',
          'bg-[var(--color-bg-surface)] border border-[var(--color-border-default)]',
          'rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)]',
          'p-6',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-[var(--text-lg)] font-semibold tracking-tight">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-[var(--text-sm)] text-[var(--color-fg-muted)]">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="rounded-[var(--radius-sm)] p-1 text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)]"
          >
            <X size={16} aria-hidden />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
