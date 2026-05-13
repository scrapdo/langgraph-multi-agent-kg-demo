import { Activity, AlertTriangle, Clock, Cpu, DollarSign, LineChart as LineChartIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getUsage, type UsageResponse, type UsageSeriesPoint } from '../api/analytics';
import { Badge, Card, CardHeader, Skeleton } from '../ui';
import { cn } from '../ui/cn';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatDuration(ms: number): string {
  if (!ms) return '0s';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatUSD(amount: number | undefined): string {
  if (!amount || amount <= 0) return '$0';
  if (amount < 0.01) return '<$0.01';
  if (amount < 10) return `$${amount.toFixed(2)}`;
  if (amount < 1000) return `$${amount.toFixed(0)}`;
  return `$${(amount / 1000).toFixed(1)}k`;
}

interface SparklineProps {
  data: number[];
  labels: string[];
  stroke: string;
  ariaLabel: string;
}

function Sparkline({ data, labels, stroke, ariaLabel }: SparklineProps) {
  // Inline SVG sparkline with grid + hover dots. Pure SVG, zero deps.
  const width = 680;
  const height = 140;
  const pad = { top: 14, right: 12, bottom: 20, left: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...data);
  const n = data.length;

  const points = data.map((v, i) => {
    const x = pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = pad.top + plotH - (v / max) * plotH;
    return { x, y, v, label: labels[i] };
  });

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const fillPath = `${path} L ${points[points.length - 1]?.x.toFixed(1) ?? 0} ${(pad.top + plotH).toFixed(1)} L ${points[0]?.x.toFixed(1) ?? 0} ${(pad.top + plotH).toFixed(1)} Z`;

  // Two reference lines: max + midpoint.
  const midY = pad.top + plotH / 2;
  const topY = pad.top;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
      className="block"
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.24" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Gridlines */}
      <line x1={pad.left} y1={topY} x2={width - pad.right} y2={topY} stroke="rgba(255,255,255,0.04)" />
      <line x1={pad.left} y1={midY} x2={width - pad.right} y2={midY} stroke="rgba(255,255,255,0.04)" />
      {/* Y labels */}
      <text x="6" y={topY + 4} fill="var(--color-fg-subtle)" fontSize="10" fontFamily="var(--font-mono)">
        {formatNumber(max)}
      </text>
      <text x="6" y={midY + 4} fill="var(--color-fg-subtle)" fontSize="10" fontFamily="var(--font-mono)">
        {formatNumber(Math.round(max / 2))}
      </text>
      {/* Axis labels — first + last only */}
      {labels.length > 0 ? (
        <>
          <text
            x={pad.left}
            y={height - 4}
            fill="var(--color-fg-subtle)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {labels[0]}
          </text>
          <text
            x={width - pad.right}
            y={height - 4}
            textAnchor="end"
            fill="var(--color-fg-subtle)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {labels[labels.length - 1]}
          </text>
        </>
      ) : null}
      {/* Area under curve */}
      <path d={fillPath} fill="url(#spark-fill)" />
      {/* Line */}
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      {/* Dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="1.6" fill={stroke}>
          <title>{`${p.label}: ${formatNumber(p.v)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function KPICard({
  icon,
  label,
  value,
  sublabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <div className="p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]">
      <div className="flex items-center gap-1.5 mb-1 text-[var(--color-fg-muted)]">
        <span className="[&_svg]:h-3 [&_svg]:w-3" aria-hidden>
          {icon}
        </span>
        <span className="text-[10px] uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-[var(--text-2xl)] font-semibold font-mono leading-none">{value}</p>
      {sublabel ? <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] mt-0.5">{sublabel}</p> : null}
    </div>
  );
}

export function UsageDashboard() {
  const [days, setDays] = useState<7 | 14 | 30 | 90>(30);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getUsage(days)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load usage');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const shortLabels = useMemo<string[]>(() => {
    if (!data) return [];
    return data.series.map((p: UsageSeriesPoint) => p.date.slice(5)); // MM-DD
  }, [data]);

  return (
    <Card>
      <CardHeader
        eyebrow="USAGE"
        title="Runs, tokens, and latency"
        description="Aggregated from the durable run store. Works whether tokens came from real metadata or the estimate fallback."
        action={
          <div className="flex items-center gap-1 p-0.5 rounded-[var(--radius-sm)] bg-[var(--color-bg-sunken)] border border-[var(--color-border-subtle)]">
            {([7, 14, 30, 90] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={cn(
                  'px-2 h-6 text-[var(--text-xs)] rounded-[var(--radius-xs)] font-medium',
                  days === d
                    ? 'bg-[var(--color-bg-elevated)] text-[var(--color-fg-default)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg-default)]',
                )}
              >
                {d}d
              </button>
            ))}
          </div>
        }
      />

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      ) : error ? (
        <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
            <KPICard
              icon={<Activity aria-hidden />}
              label="Runs"
              value={formatNumber(data.totals.runs)}
              sublabel={`${data.totals.sessions} session${data.totals.sessions === 1 ? '' : 's'}`}
            />
            <KPICard
              icon={<Cpu aria-hidden />}
              label="Tokens"
              value={formatNumber(data.totals.tokens)}
              sublabel={
                data.totals.token_accuracy.actual > 0
                  ? `${data.totals.token_accuracy.actual} actual · ${data.totals.token_accuracy.estimated} est.`
                  : `${data.totals.token_accuracy.estimated} estimated`
              }
            />
            <KPICard
              icon={<DollarSign aria-hidden />}
              label="Spend (est.)"
              value={formatUSD(data.totals.cost_usd)}
              sublabel={
                data.totals.runs > 0 && data.totals.cost_usd
                  ? `${formatUSD(data.totals.cost_usd / data.totals.runs)} avg / run`
                  : 'price table applied'
              }
            />
            <KPICard
              icon={<Clock aria-hidden />}
              label="Avg latency"
              value={formatDuration(data.totals.avg_latency_ms)}
            />
            <KPICard
              icon={<AlertTriangle aria-hidden />}
              label="Failures"
              value={String((data.by_status.failed ?? 0) + (data.by_status.degraded ?? 0))}
              sublabel={
                data.totals.runs > 0
                  ? `${(((data.by_status.failed ?? 0) + (data.by_status.degraded ?? 0)) * 100 /
                      data.totals.runs).toFixed(1)}% of runs`
                  : undefined
              }
            />
          </div>

          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-1.5 text-[var(--text-xs)] text-[var(--color-fg-muted)]">
                <LineChartIcon size={12} className="text-[var(--color-accent)]" aria-hidden />
                <span>Runs per day</span>
              </div>
              <Sparkline
                data={data.series.map((p) => p.runs)}
                labels={shortLabels}
                stroke="#29d8ff"
                ariaLabel="Runs per day"
              />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1.5 text-[var(--text-xs)] text-[var(--color-fg-muted)]">
                <LineChartIcon size={12} className="text-[var(--color-accent)]" aria-hidden />
                <span>Tokens per day</span>
              </div>
              <Sparkline
                data={data.series.map((p) => p.tokens)}
                labels={shortLabels}
                stroke="#9b8cff"
                ariaLabel="Tokens per day"
              />
            </div>
            {data.totals.cost_usd && data.totals.cost_usd > 0 ? (
              <div>
                <div className="flex items-center gap-2 mb-1.5 text-[var(--text-xs)] text-[var(--color-fg-muted)]">
                  <DollarSign size={12} className="text-[var(--color-success)]" aria-hidden />
                  <span>Cost per day (USD, estimated)</span>
                </div>
                <Sparkline
                  data={data.series.map((p) => Number(p.cost_usd ?? 0))}
                  labels={shortLabels}
                  stroke="#34d399"
                  ariaLabel="Cost per day"
                />
              </div>
            ) : null}
          </div>

          {data.by_model && Object.keys(data.by_model).length > 0 ? (
            <div className="mt-5 pt-4 border-t border-[var(--color-border-subtle)]">
              <p className="uppercase tracking-wider text-[var(--color-fg-subtle)] text-[10px] mb-2">
                By model
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-[var(--text-xs)]">
                  <thead>
                    <tr className="text-[var(--color-fg-subtle)]">
                      <th className="text-left font-medium py-1.5 pr-3">Model</th>
                      <th className="text-right font-medium py-1.5 pr-3">Runs</th>
                      <th className="text-right font-medium py-1.5 pr-3">Tokens</th>
                      <th className="text-right font-medium py-1.5">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.by_model)
                      .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
                      .map(([model, m]) => (
                        <tr key={model} className="border-t border-[var(--color-border-subtle)]">
                          <td className="py-1.5 pr-3 font-mono truncate max-w-[260px]">
                            {model === '(unknown)' ? (
                              <span className="text-[var(--color-fg-subtle)] italic">(model not recorded)</span>
                            ) : (
                              model
                            )}
                          </td>
                          <td className="text-right py-1.5 pr-3">{formatNumber(m.runs)}</td>
                          <td className="text-right py-1.5 pr-3 font-mono text-[var(--color-fg-muted)]">
                            {formatNumber(m.tokens)}
                          </td>
                          <td className="text-right py-1.5 font-mono">{formatUSD(m.cost_usd)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-[var(--color-fg-subtle)] mt-2 italic">
                Prices are a best-effort estimate from an internal table (USD per 1K tokens).
                Unknown models fall back to a mid-range rate. Actual invoices come from your providers.
              </p>
            </div>
          ) : null}

          <div className="mt-5 pt-4 border-t border-[var(--color-border-subtle)] grid grid-cols-1 md:grid-cols-2 gap-3 text-[var(--text-xs)]">
            <div>
              <p className="uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">By status</p>
              <div className="flex flex-wrap gap-1">
                {Object.entries(data.by_status)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => (
                    <Badge
                      key={k}
                      size="sm"
                      tone={
                        k === 'completed'
                          ? 'success'
                          : k === 'failed' || k === 'degraded'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {k} · {v}
                    </Badge>
                  ))}
              </div>
            </div>
            <div>
              <p className="uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">By specialist</p>
              <div className="flex flex-wrap gap-1">
                {Object.entries(data.by_specialist).map(([k, v]) => (
                  <Badge key={k} size="sm" tone="neutral">
                    {k} · {v}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}
