import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--color-accent)] text-[var(--color-fg-on-accent)] hover:bg-[var(--color-accent-hover)] border border-[var(--color-accent)] shadow-[var(--shadow-sm)]',
  secondary:
    'bg-[var(--color-bg-elevated)] text-[var(--color-fg-default)] hover:bg-[var(--color-bg-sunken)] border border-[var(--color-border-default)]',
  ghost:
    'bg-transparent text-[var(--color-fg-default)] hover:bg-[var(--color-bg-elevated)] border border-transparent',
  danger:
    'bg-[var(--color-danger)] text-white hover:opacity-90 border border-[var(--color-danger)]',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[var(--text-xs)] gap-1 rounded-[var(--radius-sm)]',
  md: 'h-9 px-3.5 text-[var(--text-sm)] gap-1.5 rounded-[var(--radius-md)]',
  lg: 'h-11 px-4.5 text-[var(--text-base)] gap-2 rounded-[var(--radius-md)]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = 'secondary',
    size = 'md',
    leading,
    trailing,
    loading,
    fullWidth,
    disabled,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium whitespace-nowrap',
        'transition-colors duration-[var(--motion-fast)] ease-[var(--easing-standard)]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      ) : (
        leading
      )}
      {children}
      {!loading && trailing}
    </button>
  );
});
