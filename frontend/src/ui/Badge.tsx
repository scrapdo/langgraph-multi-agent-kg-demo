import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: 'sm' | 'md';
  icon?: ReactNode;
}

const TONES: Record<Tone, string> = {
  neutral: 'bg-[var(--color-bg-elevated)] text-[var(--color-fg-muted)] border-[var(--color-border-default)]',
  accent: 'bg-[var(--color-accent-subtle)] text-[var(--color-accent)] border-[var(--color-border-accent)]',
  success: 'bg-emerald-400/15 text-emerald-400 border-emerald-400/30',
  warning: 'bg-amber-400/15 text-amber-300 border-amber-400/30',
  danger: 'bg-rose-400/15 text-rose-300 border-rose-400/30',
  info: 'bg-sky-400/15 text-sky-300 border-sky-400/30',
};

export function Badge({ tone = 'neutral', size = 'md', icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 border rounded-[var(--radius-pill)]',
        'font-medium',
        size === 'sm' ? 'px-1.5 h-5 text-[11px]' : 'px-2 h-6 text-[var(--text-xs)]',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}

export function StatusDot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  const color: Record<Tone, string> = {
    neutral: 'bg-[var(--color-fg-subtle)]',
    accent: 'bg-[var(--color-accent)]',
    success: 'bg-emerald-400',
    warning: 'bg-amber-400',
    danger: 'bg-rose-400',
    info: 'bg-sky-400',
  };
  return (
    <span className="relative inline-flex h-2 w-2" aria-hidden>
      <span
        className={cn(
          'absolute inline-flex h-full w-full rounded-full opacity-70',
          color[tone],
          pulse && 'animate-ping motion-reduce:hidden',
        )}
      />
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', color[tone])} />
    </span>
  );
}
