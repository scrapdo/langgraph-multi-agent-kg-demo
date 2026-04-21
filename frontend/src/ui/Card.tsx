import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

type Tone = 'default' | 'sunken' | 'accent';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'section' | 'article' | 'div' | 'aside';
  tone?: Tone;
  interactive?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const TONES: Record<Tone, string> = {
  default: 'bg-[var(--color-bg-surface)] border-[var(--color-border-default)]',
  sunken: 'bg-[var(--color-bg-sunken)] border-[var(--color-border-subtle)]',
  accent: 'bg-[var(--color-accent-subtle)] border-[var(--color-border-accent)]',
};

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
} as const;

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as: Tag = 'section', tone = 'default', interactive, padding = 'md', className, children, ...props },
  ref,
) {
  return (
    <Tag
      ref={ref as never}
      data-slot="card"
      className={cn(
        'relative overflow-hidden border rounded-[var(--radius-lg)]',
        'shadow-[var(--shadow-md)]',
        interactive && 'transition-colors duration-[var(--motion-fast)] hover:border-[var(--color-border-strong)]',
        TONES[tone],
        PADDING[padding],
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  );
});

export function CardHeader({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex items-start justify-between gap-4 mb-4', className)}>
      <div className="min-w-0">
        {eyebrow ? (
          <p
            data-slot="eyebrow"
            className="text-[var(--text-xs)] font-medium text-[var(--color-fg-muted)] mb-1"
          >
            {eyebrow}
          </p>
        ) : null}
        <h3 className="text-[var(--text-lg)] font-semibold tracking-tight text-[var(--color-fg-default)]">
          {title}
        </h3>
        {description ? (
          <p className="text-[var(--text-sm)] text-[var(--color-fg-muted)] mt-1">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex-shrink-0">{action}</div> : null}
    </header>
  );
}
