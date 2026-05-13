import { Bell, MessageCircle, Save } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  getChatWatchers,
  saveChatWatchers,
  type ChatWatchersConfig,
} from '../api/chat-watchers';
import { Badge, Button, Card, CardHeader, Input, Label, Skeleton, Textarea } from '../ui';

interface Draft {
  slackEnabled: boolean;
  slackToken: string;
  slackChannels: string;
  slackPoll: number;
  discordEnabled: boolean;
  discordToken: string;
  discordGuilds: string;
  discordPoll: number;
}

function toDraft(cfg: ChatWatchersConfig | null): Draft {
  if (!cfg) {
    return {
      slackEnabled: false,
      slackToken: '',
      slackChannels: '',
      slackPoll: 120,
      discordEnabled: false,
      discordToken: '',
      discordGuilds: '',
      discordPoll: 180,
    };
  }
  return {
    slackEnabled: cfg.slack.enabled,
    // Backend returns a masked placeholder; leave the field empty so the user
    // only submits a token when they actually want to change it.
    slackToken: '',
    slackChannels: (cfg.slack.channels || []).join('\n'),
    slackPoll: cfg.slack.poll_seconds,
    discordEnabled: cfg.discord.enabled,
    discordToken: '',
    discordGuilds: (cfg.discord.guild_ids || []).join('\n'),
    discordPoll: cfg.discord.poll_seconds,
  };
}

export function ChatWatchersPanel() {
  const [cfg, setCfg] = useState<ChatWatchersConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft(null));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getChatWatchers();
      setCfg(next);
      setDraft(toDraft(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    setConfirm(null);
    try {
      const patch: Parameters<typeof saveChatWatchers>[0] = {
        slack: {
          enabled: draft.slackEnabled,
          poll_seconds: Math.max(60, Number(draft.slackPoll) || 120),
          channels: draft.slackChannels
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
        discord: {
          enabled: draft.discordEnabled,
          poll_seconds: Math.max(60, Number(draft.discordPoll) || 180),
          guild_ids: draft.discordGuilds
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
      };
      // Only send a token if the user typed one — otherwise preserve what's stored.
      if (draft.slackToken.trim()) patch.slack = { ...patch.slack, bot_token: draft.slackToken.trim() };
      if (draft.discordToken.trim()) patch.discord = { ...patch.discord, bot_token: draft.discordToken.trim() };
      const next = await saveChatWatchers(patch);
      setCfg(next);
      setDraft(toDraft(next));
      setConfirm('Saved. Polling loop picks up new config on the next tick.');
      window.setTimeout(() => setConfirm(null), 4000);
    } catch (err) {
      setConfirm(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !cfg) {
    return (
      <Card>
        <CardHeader eyebrow="CHAT WATCHERS" title="Slack + Discord" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  const slackActive = cfg?.slack.enabled && cfg?.slack.has_token && (cfg?.slack.channels?.length ?? 0) > 0;
  const discordActive =
    cfg?.discord.enabled && cfg?.discord.has_token && (cfg?.discord.guild_ids?.length ?? 0) > 0;

  return (
    <Card>
      <CardHeader
        eyebrow="CHAT WATCHERS"
        title="Slack + Discord"
        description="Poll for new messages, fire a triage run automatically."
        action={
          <div className="flex items-center gap-1">
            <Badge tone={slackActive ? 'success' : 'neutral'} size="sm">
              Slack {slackActive ? 'live' : 'off'}
            </Badge>
            <Badge tone={discordActive ? 'success' : 'neutral'} size="sm">
              Discord {discordActive ? 'live' : 'off'}
            </Badge>
          </div>
        }
      />
      {error ? <p className="text-[var(--text-sm)] text-[var(--color-danger)] mb-2">{error}</p> : null}

      <form onSubmit={save} className="space-y-6">
        {/* Slack */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <MessageCircle size={14} className="text-[var(--color-fg-muted)]" aria-hidden />
            <h4 className="text-[var(--text-sm)] font-semibold">Slack</h4>
            <label className="ml-auto inline-flex items-center gap-2 text-[var(--text-xs)]">
              <input
                type="checkbox"
                checked={draft.slackEnabled}
                onChange={(e) => update('slackEnabled', e.target.checked)}
              />
              Enable watcher
            </label>
          </div>
          <div>
            <Label htmlFor="slack-token" hint={cfg?.slack.has_token ? 'Token saved — leave empty to keep it' : 'xoxb-…'}>
              Bot token
            </Label>
            <Input
              id="slack-token"
              type="password"
              placeholder={cfg?.slack.has_token ? '•••••• (saved)' : 'xoxb-…'}
              value={draft.slackToken}
              onChange={(e) => update('slackToken', e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="slack-channels" hint="Whitespace or newline separated. IDs (C123…) not names.">
              Channels to watch
            </Label>
            <Textarea
              id="slack-channels"
              rows={2}
              placeholder="C0123ABCD"
              value={draft.slackChannels}
              onChange={(e) => update('slackChannels', e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="slack-poll" className="mb-0">
              Poll interval (s)
            </Label>
            <Input
              id="slack-poll"
              type="number"
              min={60}
              max={1800}
              value={draft.slackPoll}
              onChange={(e) => update('slackPoll', Number(e.target.value) || 120)}
              className="w-28"
            />
          </div>
        </section>

        {/* Discord */}
        <section className="space-y-3 pt-4 border-t border-[var(--color-border-subtle)]">
          <div className="flex items-center gap-2">
            <MessageCircle size={14} className="text-[var(--color-fg-muted)]" aria-hidden />
            <h4 className="text-[var(--text-sm)] font-semibold">Discord</h4>
            <label className="ml-auto inline-flex items-center gap-2 text-[var(--text-xs)]">
              <input
                type="checkbox"
                checked={draft.discordEnabled}
                onChange={(e) => update('discordEnabled', e.target.checked)}
              />
              Enable watcher
            </label>
          </div>
          <div>
            <Label htmlFor="discord-token" hint={cfg?.discord.has_token ? 'Token saved' : 'Bot token'}>
              Bot token
            </Label>
            <Input
              id="discord-token"
              type="password"
              placeholder={cfg?.discord.has_token ? '•••••• (saved)' : 'Bot token'}
              value={draft.discordToken}
              onChange={(e) => update('discordToken', e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="discord-guilds" hint="Guild (server) IDs. Whitespace or newline separated.">
              Guilds to watch
            </Label>
            <Textarea
              id="discord-guilds"
              rows={2}
              placeholder="123456789012345678"
              value={draft.discordGuilds}
              onChange={(e) => update('discordGuilds', e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="discord-poll" className="mb-0">
              Poll interval (s)
            </Label>
            <Input
              id="discord-poll"
              type="number"
              min={60}
              max={1800}
              value={draft.discordPoll}
              onChange={(e) => update('discordPoll', Number(e.target.value) || 180)}
              className="w-28"
            />
          </div>
        </section>

        <div className="flex items-center justify-between pt-2">
          <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] inline-flex items-center gap-1.5">
            <Bell size={11} aria-hidden /> Triage prompts are fired as background runs. Check Mission Control history.
          </p>
          <Button type="submit" variant="primary" size="md" loading={saving} leading={<Save size={14} aria-hidden />}>
            Save
          </Button>
        </div>
        {confirm ? <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] italic">{confirm}</p> : null}
      </form>
    </Card>
  );
}
