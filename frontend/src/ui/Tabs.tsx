import * as TabsPrimitive from '@radix-ui/react-tabs';
import { forwardRef } from 'react';
import { cn } from './cn';

export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 p-1',
        'bg-[var(--color-bg-sunken)] border border-[var(--color-border-default)]',
        'rounded-[var(--radius-md)]',
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 h-7 px-3 text-[var(--text-xs)] font-medium',
        'text-[var(--color-fg-muted)] rounded-[var(--radius-sm)]',
        'transition-colors duration-[var(--motion-fast)] ease-[var(--easing-standard)]',
        'hover:text-[var(--color-fg-default)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        'data-[state=active]:bg-[var(--color-bg-elevated)] data-[state=active]:text-[var(--color-fg-default)] data-[state=active]:shadow-[var(--shadow-sm)]',
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn(
        'mt-4 focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  );
});
