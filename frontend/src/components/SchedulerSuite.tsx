import { useEffect, useMemo, useState } from 'react';
import {
  createPublicSchedulerBooking,
  getPublicSchedulerProfile,
  getPublicSchedulerAvailability,
  getSchedulerDashboard,
  updateSchedulerProfile,
} from '../api/client';
import type {
  SchedulerAvailabilityResponse,
  SchedulerAvailabilityWindow,
  SchedulerDashboardResponse,
  SchedulerEventType,
  SchedulerProfile,
  SchedulerPublicProfile,
} from '../types';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function nextDates(count: number) {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(today);
    value.setDate(today.getDate() + index + 1);
    return value.toISOString().slice(0, 10);
  });
}

function normalizeAvailabilityRows(rows: SchedulerAvailabilityWindow[]) {
  return WEEKDAYS.map((label, weekday) => {
    const found = rows.find((item) => item.weekday === weekday);
    return {
      weekday,
      label,
      start: found?.start ?? '',
      end: found?.end ?? '',
      enabled: Boolean(found),
    };
  });
}

function createDraftEventType(index: number): SchedulerEventType {
  return {
    event_type_id: `event-${index + 1}`,
    name: `Meeting Type ${index + 1}`,
    slug: `meeting-type-${index + 1}`,
    description: '',
    duration_minutes: 30,
    buffer_before_minutes: 0,
    buffer_after_minutes: 15,
    minimum_notice_hours: 24,
    booking_window_days: 30,
    max_bookings_per_day: 4,
    is_active: true,
  };
}

export function SchedulerAdminPanel() {
  const [dashboard, setDashboard] = useState<SchedulerDashboardResponse | null>(null);
  const [draft, setDraft] = useState<SchedulerProfile | null>(null);
  const [status, setStatus] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getSchedulerDashboard().then((data) => {
      setDashboard(data);
      setDraft(data.profile);
    });
  }, []);

  const bookingLink = useMemo(() => {
    if (!draft) return '';
    return `${window.location.origin}${window.location.pathname}#/book/${draft.public_slug}`;
  }, [draft]);

  const availabilityRows = useMemo(() => normalizeAvailabilityRows(draft?.availability ?? []), [draft?.availability]);

  async function saveProfile() {
    if (!draft) return;
    setSaving(true);
    setStatus('');
    try {
      const saved = await updateSchedulerProfile(draft);
      const refreshed = await getSchedulerDashboard();
      setDraft(saved);
      setDashboard(refreshed);
      setStatus('Saved');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (!draft || !dashboard) {
    return <section className="panel scheduler-shell"><p className="muted">Loading scheduler...</p></section>;
  }

  return (
    <section className="panel scheduler-shell">
      <div className="scheduler-admin-header">
        <div>
          <p className="eyebrow">Scheduler</p>
          <h2>Personal Booking Engine</h2>
          <p className="muted">Public link, availability rules, and recent bookings in one place.</p>
        </div>
        <div className="scheduler-link-box">
          <p className="metric-label">Public Link</p>
          <a href={bookingLink} className="scheduler-link">{bookingLink}</a>
          <button type="button" className="secondary-button" onClick={() => navigator.clipboard?.writeText(bookingLink)}>
            Copy link
          </button>
        </div>
      </div>

      <div className="scheduler-metrics">
        <article><p className="metric-label">Upcoming</p><p className="metric-value">{dashboard.metrics.confirmed_upcoming ?? 0}</p></article>
        <article><p className="metric-label">Confirmed Total</p><p className="metric-value">{dashboard.metrics.confirmed_total ?? 0}</p></article>
        <article><p className="metric-label">Meeting Types</p><p className="metric-value">{draft.event_types.length}</p></article>
      </div>

      <div className="scheduler-grid">
        <div className="scheduler-card">
          <h3>Profile</h3>
          <label>Owner Name<input value={draft.owner_name} onChange={(e) => setDraft({ ...draft, owner_name: e.target.value })} /></label>
          <label>Public Slug<input value={draft.public_slug} onChange={(e) => setDraft({ ...draft, public_slug: e.target.value })} /></label>
          <label>Headline<input value={draft.headline} onChange={(e) => setDraft({ ...draft, headline: e.target.value })} /></label>
          <label>Bio<textarea rows={3} value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} /></label>
          <div className="scheduler-two-up">
            <label>Timezone<input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} /></label>
            <label>Location Type<select value={draft.location_type} onChange={(e) => setDraft({ ...draft, location_type: e.target.value })}><option value="video">Video</option><option value="phone">Phone</option><option value="in_person">In Person</option></select></label>
          </div>
          <label>Location Details<input value={draft.location_value} onChange={(e) => setDraft({ ...draft, location_value: e.target.value })} /></label>
          <div className="scheduler-three-up">
            <label>Window Days<input type="number" value={draft.booking_window_days} onChange={(e) => setDraft({ ...draft, booking_window_days: Number(e.target.value) })} /></label>
            <label>Notice Hours<input type="number" value={draft.minimum_notice_hours} onChange={(e) => setDraft({ ...draft, minimum_notice_hours: Number(e.target.value) })} /></label>
            <label>Max Per Day<input type="number" value={draft.max_bookings_per_day} onChange={(e) => setDraft({ ...draft, max_bookings_per_day: Number(e.target.value) })} /></label>
          </div>
        </div>

        <div className="scheduler-card">
          <div className="scheduler-card-header">
            <h3>Meeting Types</h3>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setDraft({ ...draft, event_types: [...draft.event_types, createDraftEventType(draft.event_types.length)] })}
            >
              Add type
            </button>
          </div>
          <div className="scheduler-stack">
            {draft.event_types.map((item, index) => (
              <div key={`${item.event_type_id}-${index}`} className="scheduler-subcard">
                <div className="scheduler-two-up">
                  <label>Name<input value={item.name} onChange={(e) => setDraft({ ...draft, event_types: draft.event_types.map((row, rowIndex) => rowIndex === index ? { ...row, name: e.target.value } : row) })} /></label>
                  <label>Slug<input value={item.slug} onChange={(e) => setDraft({ ...draft, event_types: draft.event_types.map((row, rowIndex) => rowIndex === index ? { ...row, slug: e.target.value } : row) })} /></label>
                </div>
                <label>Description<input value={item.description} onChange={(e) => setDraft({ ...draft, event_types: draft.event_types.map((row, rowIndex) => rowIndex === index ? { ...row, description: e.target.value } : row) })} /></label>
                <div className="scheduler-four-up">
                  <label>Minutes<input type="number" value={item.duration_minutes} onChange={(e) => setDraft({ ...draft, event_types: draft.event_types.map((row, rowIndex) => rowIndex === index ? { ...row, duration_minutes: Number(e.target.value) } : row) })} /></label>
                  <label>Before<input type="number" value={item.buffer_before_minutes} onChange={(e) => setDraft({ ...draft, event_types: draft.event_types.map((row, rowIndex) => rowIndex === index ? { ...row, buffer_before_minutes: Number(e.target.value) } : row) })} /></label>
                  <label>After<input type="number" value={item.buffer_after_minutes} onChange={(e) => setDraft({ ...draft, event_types: draft.event_types.map((row, rowIndex) => rowIndex === index ? { ...row, buffer_after_minutes: Number(e.target.value) } : row) })} /></label>
                  <label>Active<select value={String(item.is_active)} onChange={(e) => setDraft({ ...draft, event_types: draft.event_types.map((row, rowIndex) => rowIndex === index ? { ...row, is_active: e.target.value === 'true' } : row) })}><option value="true">Yes</option><option value="false">No</option></select></label>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="scheduler-card">
          <h3>Weekly Availability</h3>
          <div className="scheduler-stack">
            {availabilityRows.map((row) => (
              <div key={row.weekday} className="scheduler-availability-row">
                <label className="scheduler-inline-check">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...draft.availability.filter((item) => item.weekday !== row.weekday), { weekday: row.weekday, start: row.start || '09:00', end: row.end || '17:00' }]
                        : draft.availability.filter((item) => item.weekday !== row.weekday);
                      setDraft({ ...draft, availability: next });
                    }}
                  />
                  <span>{row.label}</span>
                </label>
                <input
                  type="time"
                  value={row.start}
                  disabled={!row.enabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    availability: draft.availability.map((item) => item.weekday === row.weekday ? { ...item, start: e.target.value } : item),
                  })}
                />
                <input
                  type="time"
                  value={row.end}
                  disabled={!row.enabled}
                  onChange={(e) => setDraft({
                    ...draft,
                    availability: draft.availability.map((item) => item.weekday === row.weekday ? { ...item, end: e.target.value } : item),
                  })}
                />
              </div>
            ))}
          </div>
          <label>Blackout Dates<textarea rows={3} value={draft.blackout_dates.join('\n')} onChange={(e) => setDraft({ ...draft, blackout_dates: e.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })} /></label>
        </div>

        <div className="scheduler-card">
          <h3>Recent Bookings</h3>
          <div className="scheduler-stack">
            {dashboard.bookings.length === 0 && <p className="muted">No bookings yet.</p>}
            {dashboard.bookings.map((booking) => (
              <div key={booking.booking_id} className="scheduler-subcard">
                <strong>{booking.name}</strong>
                <p className="muted">{booking.event_type_name} · {new Date(booking.start_at).toLocaleString()}</p>
                <p className="muted">{booking.email}</p>
                {booking.notes && <p>{booking.notes}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="scheduler-actions">
        <button type="button" className="primary-button" onClick={() => void saveProfile()} disabled={saving}>
          {saving ? 'Saving...' : 'Save scheduler'}
        </button>
        {status && <p className="muted">{status}</p>}
      </div>
    </section>
  );
}

export function SchedulerPublicPage({ slug }: { slug: string }) {
  const [profile, setProfile] = useState<SchedulerPublicProfile | null>(null);
  const [selectedEventType, setSelectedEventType] = useState('');
  const [selectedDate, setSelectedDate] = useState(nextDates(14)[0]);
  const [availability, setAvailability] = useState<SchedulerAvailabilityResponse | null>(null);
  const [selectedStartAt, setSelectedStartAt] = useState('');
  const [form, setForm] = useState({ name: '', email: '', notes: '' });
  const [message, setMessage] = useState('');

  useEffect(() => {
    void getPublicSchedulerProfile(slug).then((data) => {
      setProfile(data);
      setSelectedEventType(data.event_types[0]?.slug ?? '');
    }).catch((error: Error) => setMessage(error.message));
  }, [slug]);

  useEffect(() => {
    if (!profile || !selectedEventType || !selectedDate) return;
    setSelectedStartAt('');
    void getPublicSchedulerAvailability(slug, selectedEventType, selectedDate)
      .then((data) => setAvailability(data))
      .catch((error: Error) => setMessage(error.message));
  }, [profile, selectedEventType, selectedDate, slug]);

  async function submitBooking() {
    if (!selectedStartAt) {
      setMessage('Choose a time first.');
      return;
    }
    try {
      const booking = await createPublicSchedulerBooking(slug, {
        event_type_slug: selectedEventType,
        start_at: selectedStartAt,
        name: form.name,
        email: form.email,
        notes: form.notes,
      });
      setMessage(`Confirmed. Code ${booking.confirmation_code}.`);
      setForm({ name: '', email: '', notes: '' });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Booking failed');
    }
  }

  const dateOptions = useMemo(() => nextDates(14), []);

  return (
    <main className="scheduler-public-shell">
      <section className="scheduler-public-hero">
        <div>
          <p className="eyebrow">Direct Booking</p>
          <h1>{profile?.headline ?? 'Loading booking page...'}</h1>
          <p>{profile?.bio}</p>
        </div>
        {profile && (
          <div className="scheduler-public-summary">
            <p><strong>{profile.owner_name}</strong></p>
            <p>{profile.location_type} · {profile.location_value}</p>
            <p>{profile.timezone}</p>
          </div>
        )}
      </section>

      <section className="scheduler-public-grid">
        <div className="scheduler-card scheduler-public-booking">
          <h2>Choose a time</h2>
          <label>Meeting type
            <select value={selectedEventType} onChange={(e) => setSelectedEventType(e.target.value)}>
              {(profile?.event_types ?? []).map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}
            </select>
          </label>
          <label>Date
            <select value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)}>
              {dateOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <div className="scheduler-slot-list">
            {(availability?.slots ?? []).map((slot) => (
              <button
                key={slot.start_at}
                type="button"
                className={selectedStartAt === slot.start_at ? 'scheduler-slot active' : 'scheduler-slot'}
                onClick={() => setSelectedStartAt(slot.start_at)}
              >
                {slot.label}
              </button>
            ))}
            {availability && availability.slots.length === 0 && <p className="muted">No open slots for that day.</p>}
          </div>
        </div>

        <div className="scheduler-card">
          <h2>Your details</h2>
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>Notes<textarea rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          <button type="button" className="primary-button" onClick={() => void submitBooking()}>
            Confirm booking
          </button>
          {message && <p className="muted">{message}</p>}
        </div>
      </section>
    </main>
  );
}
