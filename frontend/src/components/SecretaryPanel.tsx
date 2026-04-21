import { useEffect, useState } from 'react';
import { dispatchSecretaryAction, getSecretaryContacts, getSecretaryStatus, saveSecretaryContact } from '../api/client';
import type { RunMode, SecretaryContactPreference } from '../types';

export function SecretaryPanel() {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [contacts, setContacts] = useState<SecretaryContactPreference[]>([]);
  const [selectedContactId, setSelectedContactId] = useState('');
  const [channel, setChannel] = useState<'auto' | 'call' | 'sms' | 'email' | 'telegram'>('auto');
  const [provider, setProvider] = useState<'auto' | 'twilio' | 'telnyx' | 'sendgrid' | 'telegram'>('auto');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('Appointment follow-up from Nora');
  const [message, setMessage] = useState('Hello, this is Nora calling on behalf of Matt to coordinate a time for a short appointment. Please let us know what works best.');
  const [mode] = useState<RunMode>('live');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [contactDraft, setContactDraft] = useState<SecretaryContactPreference>({
    contact_id: '',
    name: '',
    preferred_channel: 'email',
    preferred_provider: 'auto',
    phone_number: '',
    email: '',
    telegram_chat_id: '',
    notes: '',
    relationship: '',
    organization: '',
    timezone: '',
    preferred_contact_window: '',
    channel_priority: ['email'],
    wellness_opt_in: false,
  });

  const refresh = () => {
    void getSecretaryStatus().then(setStatus).catch(() => undefined);
    void getSecretaryContacts().then((payload) => setContacts(payload.contacts)).catch(() => undefined);
  };

  useEffect(() => {
    refresh();
  }, []);

  const submit = async (overrides?: Partial<{ channel: 'auto' | 'call' | 'sms' | 'email' | 'telegram'; mode: RunMode; provider: 'auto' | 'twilio' | 'telnyx' | 'sendgrid' | 'telegram'; subject: string; message: string }>) => {
    setBusy(true);
    setNote('');
    try {
      const finalChannel = overrides?.channel ?? channel;
      const finalProvider = overrides?.provider ?? provider;
      const result = await dispatchSecretaryAction({
        channel: finalChannel,
        to,
        subject: overrides?.subject ?? subject,
        message: overrides?.message ?? message,
        mode: overrides?.mode ?? mode,
        provider: finalProvider,
        contact_id: selectedContactId || undefined,
      });
      const resultProvider = typeof result?.result?.provider === 'string' ? result.result.provider : finalProvider;
      setNote(`${String(result.status)} via ${finalChannel}${resultProvider ? ` (${resultProvider})` : ''}`);
      refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Secretary dispatch failed');
    } finally {
      setBusy(false);
    }
  };

  const providerStatus = (status?.provider_status as Record<string, Record<string, unknown>> | undefined) ?? {};
  const activeProviders = (status?.providers as Record<string, string> | undefined) ?? {};
  const channelStatus = (status?.channel_status as Record<string, unknown> | undefined) ?? {};
  const checklist = (status?.checklist as Array<Record<string, unknown>> | undefined) ?? [];
  const history = (status?.history as Array<Record<string, unknown>> | undefined) ?? [];

  const saveContact = async () => {
    setBusy(true);
    setNote('');
    try {
      const contactId = contactDraft.contact_id.trim() || contactDraft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (!contactId) throw new Error('Contact name is required.');
      await saveSecretaryContact({ ...contactDraft, contact_id: contactId });
      setSelectedContactId(contactId);
      setNote(`Saved contact ${contactDraft.name}`);
      refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Failed to save contact');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel specialist-panel">
      <div className="specialist-head">
        <div>
          <h2>Nora, Secretary</h2>
          <p className="muted">Book appointments and handle outbound calls, texts, and emails with approval-gated live dispatch.</p>
        </div>
      </div>
      <div className="specialist-callout">
        <strong>Channel Status</strong>
        <p className="muted">
          Calls: {String(channelStatus.call ?? false)} ·
          SMS: {String(channelStatus.sms ?? false)} ·
          Email: {String(channelStatus.email ?? false)}
          {' · '}
          Telegram: {String(channelStatus.telegram ?? false)}
        </p>
        <p className="muted small">
          Providers: {JSON.stringify(activeProviders)}
        </p>
        <p className="muted small">
          Setup progress: {String(status?.readiness_percent ?? 0)}%
        </p>
        {status?.missing_config && (
          <p className="muted small">
            Missing config: {JSON.stringify(status.missing_config)}
          </p>
        )}
      </div>
      <div className="secretary-provider-grid">
        {(['twilio', 'telnyx', 'sendgrid', 'telegram'] as const).map((providerId) => {
          const providerMeta = providerStatus[providerId] ?? {};
          const missing = Array.isArray(providerMeta.missing) ? providerMeta.missing : [];
          const channels = Array.isArray(providerMeta.channels) ? providerMeta.channels : [];
          const ready = Boolean(providerMeta.ready);
          return (
            <div key={providerId} className={`secretary-provider-card ${ready ? 'is-ready' : 'is-missing'}`}>
              <div className="secretary-provider-top">
                <strong>{providerId}</strong>
                <span>{ready ? 'Ready' : 'Setup needed'}</span>
              </div>
              <p className="muted small">Channels: {channels.join(', ') || 'none'}</p>
              {missing.length > 0 ? (
                <p className="muted small">Missing: {missing.join(', ')}</p>
              ) : (
                <p className="muted small">Config complete.</p>
              )}
            </div>
          );
        })}
      </div>
      {checklist.length > 0 && (
        <div className="specialist-callout">
          <strong>Setup Checklist</strong>
          <div className="approval-list">
            {checklist.map((item) => (
              <div key={String(item.id)} className="approval-card">
                <div className="shopping-card-head">
                  <strong>{String(item.label)}</strong>
                  <span className={`trust-pill ${item.ok ? 'high' : 'caution'}`}>{item.ok ? 'Ready' : 'Pending'}</span>
                </div>
                <p className="muted small">{String(item.detail ?? '')}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="specialist-callout">
        <strong>Preferred Contacts</strong>
        <label>
          Active Contact
          <select value={selectedContactId} onChange={(e) => setSelectedContactId(e.target.value)}>
            <option value="">No saved contact</option>
            {contacts.map((contact) => (
              <option key={contact.contact_id} value={contact.contact_id}>
                {contact.name} · {contact.preferred_channel}
              </option>
            ))}
          </select>
        </label>
        <div className="secretary-provider-grid">
          <label>
            Name
            <input value={contactDraft.name} onChange={(e) => setContactDraft((prev) => ({ ...prev, name: e.target.value }))} />
          </label>
          <label>
            Preferred Channel
            <select
              value={contactDraft.preferred_channel}
              onChange={(e) => setContactDraft((prev) => ({ ...prev, preferred_channel: e.target.value as SecretaryContactPreference['preferred_channel'] }))}
            >
              <option value="email">email</option>
              <option value="sms">sms</option>
              <option value="call">call</option>
              <option value="telegram">telegram</option>
            </select>
          </label>
          <label>
            Preferred Provider
            <select
              value={contactDraft.preferred_provider}
              onChange={(e) => setContactDraft((prev) => ({ ...prev, preferred_provider: e.target.value as SecretaryContactPreference['preferred_provider'] }))}
            >
              <option value="auto">auto</option>
              <option value="twilio">twilio</option>
              <option value="telnyx">telnyx</option>
              <option value="sendgrid">sendgrid</option>
              <option value="telegram">telegram</option>
            </select>
          </label>
          <label>
            Phone
            <input value={contactDraft.phone_number ?? ''} onChange={(e) => setContactDraft((prev) => ({ ...prev, phone_number: e.target.value }))} />
          </label>
          <label>
            Email
            <input value={contactDraft.email ?? ''} onChange={(e) => setContactDraft((prev) => ({ ...prev, email: e.target.value }))} />
          </label>
          <label>
            Telegram Chat ID
            <input value={contactDraft.telegram_chat_id ?? ''} onChange={(e) => setContactDraft((prev) => ({ ...prev, telegram_chat_id: e.target.value }))} />
          </label>
          <label>
            Relationship
            <input value={contactDraft.relationship ?? ''} onChange={(e) => setContactDraft((prev) => ({ ...prev, relationship: e.target.value }))} />
          </label>
          <label>
            Organization
            <input value={contactDraft.organization ?? ''} onChange={(e) => setContactDraft((prev) => ({ ...prev, organization: e.target.value }))} />
          </label>
          <label>
            Timezone
            <input value={contactDraft.timezone ?? ''} onChange={(e) => setContactDraft((prev) => ({ ...prev, timezone: e.target.value }))} placeholder="America/New_York" />
          </label>
          <label>
            Preferred Contact Window
            <input value={contactDraft.preferred_contact_window ?? ''} onChange={(e) => setContactDraft((prev) => ({ ...prev, preferred_contact_window: e.target.value }))} placeholder="Weekdays 9am-5pm" />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={Boolean(contactDraft.wellness_opt_in)}
              onChange={(e) => setContactDraft((prev) => ({ ...prev, wellness_opt_in: e.target.checked }))}
            />
            Opt this contact into wellness check-ins
          </label>
        </div>
        <div className="action-row">
          <button type="button" onClick={() => void saveContact()} disabled={busy || !contactDraft.name.trim()}>
            Save Contact Preference
          </button>
        </div>
      </div>
      <label>
        Channel
        <select value={channel} onChange={(e) => setChannel(e.target.value as 'auto' | 'call' | 'sms' | 'email' | 'telegram')}>
          <option value="auto">auto (use contact preference)</option>
          <option value="email">Email</option>
          <option value="sms">SMS</option>
          <option value="call">Call</option>
          <option value="telegram">Telegram</option>
        </select>
      </label>
      <label>
        Provider
        <select value={provider} onChange={(e) => setProvider(e.target.value as 'auto' | 'twilio' | 'telnyx' | 'sendgrid' | 'telegram')}>
          <option value="auto">auto</option>
          {(channel === 'call' || channel === 'sms') && <option value="twilio">twilio</option>}
          {(channel === 'call' || channel === 'sms') && <option value="telnyx">telnyx</option>}
          {channel === 'email' && <option value="sendgrid">sendgrid</option>}
          {channel === 'telegram' && <option value="telegram">telegram</option>}
        </select>
      </label>
      <label>
        {channel === 'telegram' ? 'Chat ID' : 'To'}
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder={channel === 'telegram' ? 'Telegram chat id, or leave blank if TELEGRAM_DEFAULT_CHAT_ID is set' : 'email or phone number'}
        />
      </label>
      {channel === 'email' && (
        <label>
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
      )}
      <label>
        Message
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} />
      </label>
      <div className="action-row">
        <button type="button" onClick={() => void submit()} disabled={busy || (!selectedContactId && !to.trim()) || !message.trim()}>
          {busy ? 'Sending...' : 'Dispatch Secretary Action'}
        </button>
        <button type="button" onClick={() => void submit({ channel: 'sms', mode: 'live' })} disabled={busy || (!selectedContactId && !to.trim()) || !message.trim()}>
          Test SMS
        </button>
        <button type="button" onClick={() => void submit({ channel: 'call', mode: 'live' })} disabled={busy || (!selectedContactId && !to.trim()) || !message.trim()}>
          Test Call
        </button>
        <button type="button" onClick={() => void submit({ channel: 'email', mode: 'live' })} disabled={busy || (!selectedContactId && !to.trim()) || !message.trim()}>
          Test Email
        </button>
        <button type="button" onClick={() => void submit({ channel: 'telegram', mode: 'live', provider: 'telegram' })} disabled={busy || !message.trim()}>
          Test Telegram
        </button>
      </div>
      {note && <p className="muted">{note}</p>}
      {history.length > 0 && (
        <div className="specialist-callout">
          <strong>Recent Tests And Dispatches</strong>
          <div className="approval-list">
            {history.slice(0, 6).map((item, index) => (
              <div key={`${String(item.at)}-${index}`} className="approval-card">
                <div className="shopping-card-head">
                  <strong>{String(item.channel)}</strong>
                  <span className={`trust-pill ${item.status === 'dispatched' || item.status === 'simulated' ? 'high' : 'caution'}`}>{String(item.status)}</span>
                </div>
                <p className="muted small">
                  Provider: {String(item.resolved_provider ?? item.provider ?? 'auto')} · To: {String(item.to ?? '(default)')} · At: {String(item.at ?? '')}
                </p>
                {item.error && <p className="muted small">Error: {String(item.error)}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
