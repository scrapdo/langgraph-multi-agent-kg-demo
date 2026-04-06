import { useEffect, useMemo, useState } from 'react';
import { getAgentProfiles, getProvidersCatalog, updateAgentProfiles } from '../api/client';
import type { AgentProfile, ProvidersCatalog } from '../types';

function isImageAvatar(value: string) {
  return /^https?:\/\//i.test(value.trim()) || value.trim().startsWith('data:image/');
}

function AvatarPreview({ value, alt }: { value: string; alt: string }) {
  const trimmed = value.trim();
  if (isImageAvatar(trimmed)) {
    return <img className="avatar-preview-image" src={trimmed} alt={alt} loading="lazy" />;
  }
  return <span className="avatar-preview-text">{trimmed || '•'}</span>;
}

interface OrgNodeProps {
  agent?: AgentProfile;
}

function OrgNode({ agent }: OrgNodeProps) {
  if (!agent) return null;
  return (
    <div className="org-node" title={`${agent.name} (${agent.id})`}>
      <div className="avatar-preview-wrap" aria-hidden>
        <AvatarPreview value={agent.avatar} alt={agent.name} />
      </div>
      <span className="org-node-name">{agent.name}</span>
      <span className="org-node-role">{agent.id}</span>
    </div>
  );
}

export function AgentStudio() {
  const [profiles, setProfiles] = useState<Record<string, AgentProfile>>({});
  const [draft, setDraft] = useState<Record<string, AgentProfile>>({});
  const [catalog, setCatalog] = useState<ProvidersCatalog | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [profilesData, providersData] = await Promise.all([getAgentProfiles(), getProvidersCatalog()]);
      setProfiles(profilesData.agents);
      setDraft(profilesData.agents);
      setCatalog(providersData);
    };
    void load();
  }, []);

  const agentList = useMemo(() => Object.values(draft), [draft]);

  const org = useMemo(
    () => ({
      coordinator: draft.coordinator,
      row2: [draft.researcher, draft.critic].filter(Boolean) as AgentProfile[],
      row3: [draft.writer, draft.coding].filter(Boolean) as AgentProfile[],
    }),
    [draft],
  );

  const updateField = (agentId: string, field: keyof AgentProfile, value: string) => {
    setDraft((prev) => {
      const current = prev[agentId];
      if (!current) return prev;
      return {
        ...prev,
        [agentId]: {
          ...current,
          [field]: value,
        },
      };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, Partial<AgentProfile>> = {};
      for (const [id, profile] of Object.entries(draft)) {
        if (!profiles[id]) continue;
        patch[id] = {
          name: profile.name,
          avatar: profile.avatar,
          provider: profile.provider,
          model: profile.model,
          function: profile.function,
        };
      }
      const updated = await updateAgentProfiles(patch);
      setProfiles(updated.agents);
      setDraft(updated.agents);
    } finally {
      setSaving(false);
    }
  };

  const modelsForProvider = (providerId: string) => catalog?.providers.find((p) => p.id === providerId)?.models ?? [];

  return (
    <section className="panel agent-studio">
      <h2>Agent Studio</h2>
      <p className="muted">Set any avatar per agent (emoji/text or image URL), then route each role to the right model.</p>

      <div className="org-chart" aria-label="Agent organization chart">
        <div className="org-row top">
          <OrgNode agent={org.coordinator} />
        </div>
        <div className="org-link vertical" />
        <div className="org-link horizontal two" />
        <div className="org-row middle two">
          {org.row2.map((a) => (
            <OrgNode key={a.id} agent={a} />
          ))}
        </div>
        <div className="org-link vertical" />
        <div className="org-link horizontal two" />
        <div className="org-row bottom two">
          {org.row3.map((a) => (
            <OrgNode key={a.id} agent={a} />
          ))}
        </div>
      </div>

      <div className="agent-list">
        {agentList.map((agent) => (
          <article key={agent.id} className="agent-card">
            <div className="agent-head">
              <div className="avatar-preview-wrap" aria-hidden>
                <AvatarPreview value={agent.avatar} alt={agent.name} />
              </div>
              <input value={agent.name} onChange={(e) => updateField(agent.id, 'name', e.target.value)} />
            </div>
            <p className="muted small">{agent.id}</p>
            <label>
              Avatar
              <input
                value={agent.avatar}
                onChange={(e) => updateField(agent.id, 'avatar', e.target.value)}
                placeholder="emoji/text or https://image-url"
              />
            </label>
            <label>
              Function
              <input value={agent.function} onChange={(e) => updateField(agent.id, 'function', e.target.value)} />
            </label>
            <label>
              Provider
              <select value={agent.provider} onChange={(e) => updateField(agent.id, 'provider', e.target.value)}>
                {(catalog?.providers ?? []).map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} {provider.enabled ? '' : '(disabled)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model
              <select value={agent.model} onChange={(e) => updateField(agent.id, 'model', e.target.value)}>
                {modelsForProvider(agent.provider).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
                {!modelsForProvider(agent.provider).includes(agent.model) && <option value={agent.model}>{agent.model}</option>}
              </select>
            </label>
          </article>
        ))}
      </div>
      <button type="button" onClick={save} disabled={saving}>
        {saving ? 'Saving...' : 'Save Agent Profiles'}
      </button>
    </section>
  );
}
