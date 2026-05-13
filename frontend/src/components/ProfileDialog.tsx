import { Save, UserPen } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { getUserProfile, saveUserProfile, type UserProfile } from '../api/profile';
import { Button, Dialog, DialogContent, DialogTrigger, Input, Label, Textarea } from '../ui';

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

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (profile: UserProfile) => void;
  trigger?: React.ReactNode;
}

export function ProfileDialog({ open, onOpenChange, onSaved, trigger }: Props) {
  const [profile, setProfile] = useState<UserProfile>(EMPTY);
  const [goalsText, setGoalsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const setField = <K extends keyof UserProfile>(key: K, value: UserProfile[K]) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
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
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        title="Your profile"
        description="Context I'll remember for every single conversation. Takes 60 seconds — skip if you want to, edit later."
        className="!w-[min(94vw,640px)]"
      >
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="pd-name">Name</Label>
              <Input
                id="pd-name"
                autoFocus
                value={profile.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="e.g. Matt"
              />
            </div>
            <div>
              <Label htmlFor="pd-role">Role / what you do</Label>
              <Input
                id="pd-role"
                value={profile.role}
                onChange={(e) => setField('role', e.target.value)}
                placeholder="e.g. Founder building an AI ops system"
              />
            </div>
            <div>
              <Label htmlFor="pd-location">Location</Label>
              <Input
                id="pd-location"
                value={profile.location}
                onChange={(e) => setField('location', e.target.value)}
                placeholder="e.g. Brooklyn, NY"
              />
            </div>
            <div>
              <Label htmlFor="pd-tz">Timezone</Label>
              <Input
                id="pd-tz"
                value={profile.timezone}
                onChange={(e) => setField('timezone', e.target.value)}
                placeholder="America/New_York"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="pd-focus" hint="The thing that matters most right now.">
              Current focus
            </Label>
            <Input
              id="pd-focus"
              value={profile.current_focus}
              onChange={(e) => setField('current_focus', e.target.value)}
              placeholder="e.g. Shipping v1 of the brain"
            />
          </div>
          <div>
            <Label htmlFor="pd-goals" hint="One per line.">
              Ongoing goals
            </Label>
            <Textarea
              id="pd-goals"
              value={goalsText}
              onChange={(e) => setGoalsText(e.target.value)}
              rows={3}
              placeholder={'e.g.\nShip two PRs a week\nKeep inbox zero'}
            />
          </div>
          <div>
            <Label htmlFor="pd-prefs" hint="Tone, length, hard nos.">
              Response style
            </Label>
            <Textarea
              id="pd-prefs"
              value={profile.preferences}
              onChange={(e) => setField('preferences', e.target.value)}
              rows={2}
              placeholder="Direct and concise. No hedging. Cite sources when it's non-obvious."
            />
          </div>
          <div>
            <Label htmlFor="pd-notes" hint="Free-form.">
              Additional context
            </Label>
            <Textarea
              id="pd-notes"
              value={profile.notes}
              onChange={(e) => setField('notes', e.target.value)}
              rows={2}
              placeholder="Anything else worth remembering."
            />
          </div>
          {error ? <p className="text-[var(--text-sm)] text-[var(--color-danger)]">{error}</p> : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="md" onClick={() => onOpenChange(false)}>
              Later
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={saving}
              leading={<Save size={14} aria-hidden />}
            >
              Save profile
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProfileDialogButton({
  onSaved,
}: {
  onSaved?: (profile: UserProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        leading={<UserPen size={14} aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Profile
      </Button>
      <ProfileDialog open={open} onOpenChange={setOpen} onSaved={onSaved} />
    </>
  );
}
