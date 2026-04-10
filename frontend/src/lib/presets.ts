import type { AgentProfile, RunMode } from '../types';
import type { ThemeId } from './themes';

export interface MissionTemplate {
  id: string;
  name: string;
  description: string;
  task: string;
  mode: RunMode;
}

export interface SystemPreset {
  id: string;
  name: string;
  theme: ThemeId;
  agents: Record<string, AgentProfile>;
}

export const MISSION_TEMPLATE_STORAGE_KEY = 'kg-demo-mission-templates';
export const SYSTEM_PRESET_STORAGE_KEY = 'kg-demo-system-presets';

export const DEFAULT_MISSION_TEMPLATES: MissionTemplate[] = [
  {
    id: 'market-brief',
    name: 'Market Brief',
    description: 'Sector pulse, risks, and content angles for this week.',
    task: 'Build a market research brief for semiconductor momentum this week.',
    mode: 'simulation',
  },
  {
    id: 'system-tour',
    name: 'System Tour',
    description: 'Explain the pipeline, memory, graph, and reliability model.',
    task: 'Tell me how you work and how the agents coordinate.',
    mode: 'simulation',
  },
  {
    id: 'content-sprint',
    name: 'Content Sprint',
    description: 'Draft a content plan with hooks, risks, and distribution notes.',
    task: 'Create a content sprint brief for this week based on recent market context.',
    mode: 'simulation',
  },
  {
    id: 'private-shopper',
    name: 'Private Shopper',
    description: 'Find hard-to-source items, compare trustworthy options, and surface the best deals.',
    task: 'Find me the best trusted options and current deals for a hard-to-find item, then rank them by value and risk.',
    mode: 'simulation',
  },
  {
    id: 'social-manager',
    name: 'Social Manager',
    description: 'Create a social plan with hooks, channel strategy, and posting cadence.',
    task: 'Create a social media plan for this week with platform-specific hooks, posting cadence, and engagement follow-up.',
    mode: 'simulation',
  },
  {
    id: 'ops-briefing',
    name: 'Ops Briefing',
    description: 'Summarize what is active, degraded, or missing right now.',
    task: 'Give me a live operational briefing on agents, memory, graph, and system health.',
    mode: 'simulation',
  },
  {
    id: 'morning-brief',
    name: 'Morning Brief',
    description: 'Prioritize inbox, calendar, and conflicts into a concise morning operator brief.',
    task: 'Create a morning brief that combines inbox priorities, upcoming calendar items, and any conflicts I should resolve first.',
    mode: 'simulation',
  },
  {
    id: 'draft-replies',
    name: 'Draft Replies',
    description: 'Review recent inbox threads and suggest concise draft replies with next steps.',
    task: 'Review recent inbox threads and suggest concise draft replies with the right next step for each.',
    mode: 'simulation',
  },
  {
    id: 'secretary-ops',
    name: 'Secretary',
    description: 'Prepare calls, texts, follow-ups, and scheduling actions through the secretary agent.',
    task: 'Act as my secretary. Prepare the best next call, text, and email follow-ups needed to book or confirm appointments.',
    mode: 'simulation',
  },
  {
    id: 'wellness-coach',
    name: 'Wellness Coach',
    description: 'Set practical goals, habit anchors, accountability prompts, and motivation for the week.',
    task: 'Act as my wellness coach. Help me set one realistic anchor habit, one movement goal, one recovery goal, and one accountability question for this week.',
    mode: 'simulation',
  },
  {
    id: 'live-mission',
    name: 'Live Mission',
    description: 'Prepare a run intended for approved live tools.',
    task: 'Prepare a live-mode mission plan for approved tools and explain the guardrails first.',
    mode: 'live',
  },
];

function withAgentOverrides(
  baseAgents: Record<string, AgentProfile>,
  overrides: Record<string, Partial<AgentProfile>>,
): Record<string, AgentProfile> {
  const next: Record<string, AgentProfile> = {};
  for (const [id, agent] of Object.entries(baseAgents)) {
    next[id] = {
      ...agent,
      ...(overrides[id] ?? {}),
    };
  }
  return next;
}

export function buildCuratedOpenRouterPresets(baseAgents: Record<string, AgentProfile>): SystemPreset[] {
  if (!Object.keys(baseAgents).length) return [];

  return [
    {
      id: 'openrouter-balanced-oss',
      name: 'OpenRouter OSS Balanced',
      theme: 'odyssey',
      agents: withAgentOverrides(baseAgents, {
        coordinator: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
        researcher: { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct' },
        critic: { provider: 'openrouter', model: 'qwen/qwq-32b' },
        writer: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
        coding: { provider: 'openrouter', model: 'qwen/qwen-2.5-coder-32b-instruct' },
        shopper: { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct' },
        social: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' },
        secretary: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
        wellness: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
      }),
    },
    {
      id: 'openrouter-reasoning-stack',
      name: 'OpenRouter Reasoning Stack',
      theme: 'streaming',
      agents: withAgentOverrides(baseAgents, {
        coordinator: { provider: 'openrouter', model: 'qwen/qwq-32b' },
        researcher: { provider: 'openrouter', model: 'deepseek/deepseek-r1-distill-llama-70b' },
        critic: { provider: 'openrouter', model: 'qwen/qwq-32b' },
        writer: { provider: 'openrouter', model: 'google/gemma-3-27b-it' },
        coding: { provider: 'openrouter', model: 'qwen/qwen-2.5-coder-32b-instruct' },
        shopper: { provider: 'openrouter', model: 'deepseek/deepseek-r1-distill-llama-70b' },
        social: { provider: 'openrouter', model: 'google/gemma-3-27b-it' },
        secretary: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
        wellness: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
      }),
    },
    {
      id: 'openrouter-lightweight-oss',
      name: 'OpenRouter Lightweight OSS',
      theme: 'paper',
      agents: withAgentOverrides(baseAgents, {
        coordinator: { provider: 'openrouter', model: 'mistralai/mistral-nemo' },
        researcher: { provider: 'openrouter', model: 'google/gemma-3-27b-it' },
        critic: { provider: 'openrouter', model: 'mistralai/mixtral-8x22b-instruct' },
        writer: { provider: 'openrouter', model: 'google/gemma-3-12b-it' },
        coding: { provider: 'openrouter', model: 'qwen/qwen-2.5-coder-32b-instruct' },
        shopper: { provider: 'openrouter', model: 'google/gemma-3-27b-it' },
        social: { provider: 'openrouter', model: 'google/gemma-3-12b-it' },
        secretary: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
        wellness: { provider: 'anthropic', model: 'claude-3-7-sonnet-latest' },
      }),
    },
  ];
}

export function loadJsonArray<T>(storage: Pick<Storage, 'getItem'> | null | undefined, key: string): T[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function saveJsonArray<T>(storage: Pick<Storage, 'setItem'>, key: string, items: T[]): void {
  storage.setItem(key, JSON.stringify(items));
}

export function mergeMissionTemplates(custom: MissionTemplate[]): MissionTemplate[] {
  const seen = new Set<string>();
  return [...DEFAULT_MISSION_TEMPLATES, ...custom].filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
