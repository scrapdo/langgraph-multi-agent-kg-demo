import {
  Bot,
  BrainCircuit,
  Calendar,
  FileText,
  Globe,
  Layers,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardHeader } from '../ui';

interface Capability {
  title: string;
  icon: ReactNode;
  description: string;
}

const CARDS: Capability[] = [
  {
    title: 'Research workspace',
    icon: <Search aria-hidden />,
    description:
      'Ask anything. The coordinator routes work across researcher, critic, writer, shopper, secretary, wellness coach, and specialists with live traces.',
  },
  {
    title: 'It actually remembers you',
    icon: <BrainCircuit aria-hidden />,
    description:
      'Short-term state, Zep long-term recall, thread context, graph lineage, and desktop artifacts stay connected across runs.',
  },
  {
    title: 'Autonomous thinking',
    icon: <Sparkles aria-hidden />,
    description:
      'Critique loops, schedule runners, degraded fallbacks, and approval-gated live actions keep the system moving on its own.',
  },
  {
    title: 'Visual reports',
    icon: <FileText aria-hidden />,
    description:
      'Any run opens as a polished HTML report that prints to PDF without dumping the raw dashboard layout.',
  },
  {
    title: 'Browser & desktop automation',
    icon: <Globe aria-hidden />,
    description:
      'Desktop ops, host-bridge hooks, shopping search, Google Workspace, and approval queues are all controllable specialist surfaces.',
  },
  {
    title: 'Multi-agent orchestration',
    icon: <Bot aria-hidden />,
    description:
      'Coordinator, researcher, critic, writer, coding, shopper, social, secretary, wellness coach, and schedules share one mission state.',
  },
  {
    title: 'Document processing',
    icon: <Layers aria-hidden />,
    description:
      'Drop text, markdown, CSV, JSON, HTML, or code files into the document workbench for extraction and downstream use.',
  },
  {
    title: 'Google Workspace',
    icon: <Calendar aria-hidden />,
    description:
      'Gmail and Calendar workflows feed back into memory, graph lineage, desktop artifacts, schedules, and operator briefs.',
  },
  {
    title: 'Safety by design',
    icon: <ShieldCheck aria-hidden />,
    description:
      'Approval gates for destructive actions, execution history, retries, and persistent audit context.',
  },
];

export function CapabilityDeckPanel() {
  return (
    <Card tone="sunken" className="!shadow-none">
      <CardHeader
        eyebrow="CAPABILITY DECK"
        title="What this system can do today"
        description="The Captain-Claw-inspired ideas adapted to this app's runtime."
      />
      <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {CARDS.map((card) => (
          <li
            key={card.title}
            className="p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-surface)] border border-[var(--color-border-default)] transition-colors duration-[var(--motion-fast)] hover:border-[var(--color-border-strong)]"
          >
            <div className="flex items-start gap-2.5">
              <div
                className="h-8 w-8 rounded-[var(--radius-sm)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)] grid place-items-center flex-shrink-0 [&_svg]:h-4 [&_svg]:w-4"
                aria-hidden
              >
                {card.icon}
              </div>
              <div className="min-w-0">
                <p className="text-[var(--text-sm)] font-medium text-[var(--color-fg-default)] mb-0.5">
                  {card.title}
                </p>
                <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] leading-relaxed">
                  {card.description}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
