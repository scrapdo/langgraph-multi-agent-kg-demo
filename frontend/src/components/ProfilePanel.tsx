import { Save, User2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { getUserProfile, saveUserProfile, type UserProfile } from '../api/profile';
import { Badge, Button, Card, CardHeader, Input, Label, Textarea } from '../ui';

const EMPTY: UserProfile = {
  name: '',
  role: '',
  timezone: 'America/New_York',
  location: '',
  goals: [],
  preferences: '',
  current_focus: '',
  notes: '',
  updated_at: '',
};

export function ProfilePanel() {
  const [profile, setProfile] = useState<UserProfile>(EMPTY);
  const [goalsText, setGoalsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getUserProfile();
        if (!cancelled) {
          setProfile(p);
          setGoalsText((p.goals ?? []).join('\n'));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setField = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const goals = goalsText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const saved = await saveUserProfile({ ...profile, goals });
      setProfile(saved);
      setGoalsText((saved.goals ?? []).join('\n'));
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        eyebrow="ABOUT YOU"
        title="Your profile"
        description="Context the assistant will remember across every conversation."
        action={profile.updated_at ? <Badge tone="neutral" size="sm">updated {new Date(profile.updated_at).toLocaleString()}</Badge> : null}
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={profile.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="e.g. Matt"
              disabled={loading}
            />
          </div>
          <div>
            <Label htmlFor="profile-role">Role / what you do</Label>
            <Input
              id="profile-role"
              value={profile.role}
              onChange={(e) => setField('role', e.target.value)}
              placeholder="e.g. Founder · building an AI ops system"
              disabled={loading}
            />
          </div>
          <div>
            <Label htmlFor="profile-location">Location</Label>
            <Input
              id="profile-location"
              value={profile.location}
              onChange={(e) => setField('location', e.target.value)}
              placeholder="e.g. Brooklyn, NY"
              disabled={loading}
            />
          </div>
          <div>
            <Label htmlFor="profile-timezone">Timezone</Label>
            <Input
              id="profile-timezone"
              value={profile.timezone}
              onChange={(e) => setField('timezone', e.target.value)}
              placeholder="IANA zone like America/New_York"
              disabled={loading}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="profile-focus" hint="The one thing that matters most right now.">
            Current focus
          </Label>
          <Input
            id="profile-focus"
            value={profile.current_focus}
            onChange={(e) => setField('current_focus', e.target.value)}
            placeholder="e.g. Shipping the v1 of the brain"
            disabled={loading}
          />
        </div>

        <div>
          <Label htmlFor="profile-goals" hint="One per line. These guide every run.">
            Ongoing goals
          </Label>
          <Textarea
            id="profile-goals"
            value={goalsText}
            onChange={(e) => {
              setGoalsText(e.target.value);
              setDirty(true);
            }}
            rows={4}
            placeholder={'e.g.\nShip two PRs a week\nKeep inbox zero\nTalk to 5 customers every week'}
            disabled={loading}
          />
        </div>

        <div>
          <Label htmlFor="profile-prefs" hint="Tone, length, style, any hard nos.">
            How should the assistant respond?
          </Label>
          <Textarea
            id="profile-prefs"
            value={profile.preferences}
            onChange={(e) => setField('preferences', e.target.value)}
            rows={3}
            placeholder="e.g. Direct and concise. Cite sources when it's non-obvious. Skip hedging."
            disabled={loading}
          />
        </div>

        <div>
          <Label htmlFor="profile-notes" hint="Anything else worth remembering. Free-form.">
            Additional context
          </Label>
          <Textarea
            id="profile-notes"
            value={profile.notes}
            onChange={(e) => setField('notes', e.target.value)}
            rows={3}
            placeholder="e.g. I work late. Wife's name is Sarah. Using OpenAI gpt-4.1-mini for cost."
            disabled={loading}
          />
        </div>

        {error ? <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p> : null}

        <div className="flex items-center justify-between">
          <p className="text-[var(--text-xs)] text-[var(--color-fg-subtle)] inline-flex items-center gap-1.5">
            <User2 size={12} aria-hidden /> Stored locally in <code className="font-mono">data/user_profile.json</code>
          </p>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={saving}
            disabled={!dirty}
            leading={<Save size={14} aria-hidden />}
          >
            {dirty ? 'Save profile' : 'Saved'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
