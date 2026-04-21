import type { ReactNode } from 'react';
import { cn } from './cn';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        'border border-dashed border-[var(--color-border-default)]',
        'rounded-[var(--radius-lg)] bg-[var(--color-bg-sunken)]',
        'px-6 py-10 gap-3',
        className,
      )}
    >
      {icon ? (
        <div className="text-[var(--color-fg-subtle)] [&_svg]:h-7 [&_svg]:w-7" aria-hidden>
          {icon}
        </div>
      ) : null}
      <h4 className="text-[var(--text-base)] font-medium text-[var(--color-fg-default)]">{title}</h4>
      {description ? (
        <p className="text-[var(--text-sm)] max-w-sm text-[var(--color-fg-muted)]">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
