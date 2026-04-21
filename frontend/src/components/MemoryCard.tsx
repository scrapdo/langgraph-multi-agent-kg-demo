import { BrainCircuit, Calendar, CheckCircle2, ChevronRight, Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getUserProfile, type UserProfile } from '../api/profile';
import { getGoogleStatus, startGoogleOAuth, type GoogleWorkspaceStatus } from '../api/workspace';
import { Badge, Button, Card, CardHeader, Skeleton } from '../ui';

interface Props {
  onEditProfile?: () => void;
}

export function MemoryCard({ onEditProfile }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [google, setGoogle] = useState<GoogleWorkspaceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectBusy, setConnectBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [p, g] = await Promise.allSettled([getUserProfile(), getGoogleStatus()]);
        if (cancelled) return;
        if (p.status === 'fulfilled') setProfile(p.value);
        if (g.status === 'fulfilled') setGoogle(g.value);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const connectGoogle = async () => {
    setConnectBusy(true);
    try {
      const { url } = await startGoogleOAuth();
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setConnectBusy(false);
    }
  };

  const facts: Array<{ label: string; value: string }> = [];
  if (profile) {
    if (profile.name) facts.push({ label: 'Name', value: profile.name });
    if (profile.role) facts.push({ label: 'Role', value: profile.role });
    if (profile.location) facts.push({ label: 'Location', value: profile.location });
    if (profile.timezone) facts.push({ label: 'Timezone', value: profile.timezone });
    if (profile.current_focus) facts.push({ label: 'Focus', value: profile.current_focus });
  }
  const goals = profile?.goals ?? [];
  const empty = !loading && facts.length === 0 && goals.length === 0;

  return (
    <Card>
      <CardHeader
        eyebrow="CONTEXT"
        title="What I know about you"
        description="Auto-injected into every run."
        action={<BrainCircuit size={14} className="text-[var(--color-fg-subtle)]" aria-hidden />}
      />
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : empty ? (
        <div className="p-3 rounded-[var(--radius-md)] bg-[var(--color-bg-sunken)] border border-dashed border-[var(--color-border-default)]">
          <p className="text-[var(--text-sm)] text-[var(--color-fg-muted)] mb-2">
            I don't know anything about you yet. Add a short profile so every run is tailored to you.
          </p>
          {onEditProfile ? (
            <button
              type="button"
              onClick={onEditProfile}
              className="inline-flex items-center gap-1 text-[var(--text-xs)] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
            >
              Set up profile <ChevronRight size={12} aria-hidden />
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          {facts.length > 0 ? (
            <ul className="space-y-1.5 text-[var(--text-sm)]">
              {facts.map((fact) => (
                <li key={fact.label} className="flex items-baseline justify-between gap-3">
                  <span className="text-[var(--color-fg-subtle)] text-[var(--text-xs)] uppercase tracking-wider">
                    {fact.label}
                  </span>
                  <span className="text-right text-[var(--color-fg-default)] truncate">{fact.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {goals.length > 0 ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">
                Active goals
              </p>
              <ul className="flex flex-wrap gap-1">
                {goals.map((goal, i) => (
                  <li key={i}>
                    <Badge tone="neutral" size="sm">
                      {goal}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {profile?.preferences ? (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">
                Style
              </p>
              <p className="text-[var(--text-xs)] text-[var(--color-fg-muted)] leading-relaxed">
                {profile.preferences}
              </p>
            </div>
          ) : null}
          {onEditProfile ? (
            <button
              type="button"
              onClick={onEditProfile}
              className="inline-flex items-center gap-1 text-[var(--text-xs)] text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
            >
              Edit profile <ChevronRight size={12} aria-hidden />
            </button>
          ) : null}

          {google ? (
            <div className="pt-3 mt-3 border-t border-[var(--color-border-subtle)]">
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1.5">
                Integrations
              </p>
              {google.connected ? (
                <div className="flex items-center gap-2 text-[var(--text-xs)] text-[var(--color-fg-muted)]">
                  <CheckCircle2 size={12} className="text-[var(--color-success)]" aria-hidden />
                  <Mail size={12} aria-hidden />
                  <Calendar size={12} aria-hidden />
                  <span>Gmail + Calendar connected</span>
                </div>
              ) : google.oauth_configured ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leading={<Mail size={12} aria-hidden />}
                  onClick={() => void connectGoogle()}
                  loading={connectBusy}
                >
                  Connect Google Workspace
                </Button>
              ) : (
                <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] leading-snug">
                  Set <code className="font-mono">GOOGLE_OAUTH_CLIENT_ID</code> and{' '}
                  <code className="font-mono">GOOGLE_OAUTH_CLIENT_SECRET</code> in{' '}
                  <code className="font-mono">secrets.env</code> to enable Gmail + Calendar.
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
