const API_BASE = (typeof window !== 'undefined' && (window as any).__BRAIN_API_BASE__) || (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:8000';

export interface UsageTotals {
  runs: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  tokens: number;
  cost_usd?: number;
  elapsed_ms_total: number;
  avg_latency_ms: number;
  sessions: number;
  token_accuracy: { actual: number; estimated: number };
}

export interface UsageSeriesPoint {
  date: string;
  runs: number;
  tokens: number;
  avg_latency_ms: number;
  failures: number;
  cost_usd?: number;
}

export interface UsageModelBreakdown {
  runs: number;
  tokens: number;
  cost_usd: number;
}

export interface UsageResponse {
  totals: UsageTotals;
  by_status: Record<string, number>;
  by_specialist: Record<string, number>;
  by_model?: Record<string, UsageModelBreakdown>;
  model_prices?: Record<string, { prompt_per_1k: number; completion_per_1k: number }>;
  series: UsageSeriesPoint[];
}

export async function getUsage(days = 30): Promise<UsageResponse> {
  const res = await fetch(`${API_BASE}/analytics/usage?days=${days}`);
  if (!res.ok) throw new Error(`Failed to load usage: ${res.status}`);
  return res.json();
}
