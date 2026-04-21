import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

const BASE =
  'w-full bg-[var(--color-bg-sunken)] text-[var(--color-fg-default)] ' +
  'border border-[var(--color-border-default)] rounded-[var(--radius-md)] ' +
  'placeholder:text-[var(--color-fg-subtle)] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] ' +
  'focus-visible:border-[var(--color-border-accent)] ' +
  'transition-colors duration-[var(--motion-fast)] ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(BASE, 'h-9 px-3 text-[var(--text-sm)]', invalid && 'border-[var(--color-danger)]', className)}
      {...props}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 4, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        BASE,
        'py-2 px-3 text-[var(--text-sm)] min-h-[2.5rem] resize-y',
        invalid && 'border-[var(--color-danger)]',
        className,
      )}
      {...props}
    />
  );
});

export function Label({
  htmlFor,
  children,
  hint,
  required,
  className,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('block text-[var(--text-xs)] font-medium text-[var(--color-fg-muted)] mb-1', className)}
    >
      <span>{children}</span>
      {required ? <span className="ml-0.5 text-[var(--color-danger)]">*</span> : null}
      {hint ? <span className="ml-2 font-normal text-[var(--color-fg-subtle)]">{hint}</span> : null}
    </label>
  );
}
