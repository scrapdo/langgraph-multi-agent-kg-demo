import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { getAgentProfiles, getLocalAppsCatalog, getProvidersCatalog, updateAgentProfiles } from '../api/client';
import {
  buildCuratedOpenRouterPresets,
  loadJsonArray,
  saveJsonArray,
  SYSTEM_PRESET_STORAGE_KEY,
  type SystemPreset,
} from '../lib/presets';
import type { ThemeId } from '../lib/themes';
import type { AgentProfile, LocalAppDefinition, ProvidersCatalog } from '../types';

const SPEECH_VOICES = ['verse', 'aria', 'ash', 'sage', 'alloy'];
const SPEECH_STYLES = ['natural', 'warm', 'energetic', 'precise', 'cinematic'];

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

async function fileToAvatarDataUrl(file: File): Promise<string> {
  const fileDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read avatar file'));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode avatar image'));
    img.src = fileDataUrl;
  });

  const maxSize = 256;
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return fileDataUrl;

  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/png');
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

interface AgentStudioProps {
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
}

export function AgentStudio({ theme, onThemeChange }: AgentStudioProps) {
  const [profiles, setProfiles] = useState<Record<string, AgentProfile>>({});
  const [draft, setDraft] = useState<Record<string, AgentProfile>>({});
  const [catalog, setCatalog] = useState<ProvidersCatalog | null>(null);
  const [localApps, setLocalApps] = useState<LocalAppDefinition[]>([]);
  const [saving, setSaving] = useState(false);
  const [uploadedFileNames, setUploadedFileNames] = useState<Record<string, string>>({});
  const [presetName, setPresetName] = useState('');
  const [presets, setPresets] = useState<SystemPreset[]>([]);

  useEffect(() => {
    const load = async () => {
      const [profilesData, providersData, localAppsData] = await Promise.all([getAgentProfiles(), getProvidersCatalog(), getLocalAppsCatalog()]);
      setProfiles(profilesData.agents);
      setDraft(profilesData.agents);
      setCatalog(providersData);
      setLocalApps(localAppsData.apps);
      setPresets(loadJsonArray<SystemPreset>(window.localStorage, SYSTEM_PRESET_STORAGE_KEY));
    };
    void load();
  }, []);

  const agentList = useMemo(() => Object.values(draft), [draft]);
  const curatedOpenRouterPresets = useMemo(() => buildCuratedOpenRouterPresets(draft), [draft]);

  const org = useMemo(
    () => ({
      coordinator: draft.coordinator,
      row2: [draft.researcher, draft.critic, draft.writer].filter(Boolean) as AgentProfile[],
      row3: [draft.coding, draft.shopper, draft.social].filter(Boolean) as AgentProfile[],
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

  const toggleSpecialistApp = (agentId: string, appId: string) => {
    setDraft((prev) => {
      const current = prev[agentId];
      if (!current) return prev;
      const specialistApps = current.specialist_apps.includes(appId)
        ? current.specialist_apps.filter((item) => item !== appId)
        : [...current.specialist_apps, appId];
      return {
        ...prev,
        [agentId]: {
          ...current,
          specialist_apps: specialistApps,
        },
      };
    });
  };

  const onAvatarFileChange = (agentId: string, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    void fileToAvatarDataUrl(file)
      .then((data) => {
        if (!data.startsWith('data:image/')) return;
        updateField(agentId, 'avatar', data);
        setUploadedFileNames((prev) => ({ ...prev, [agentId]: file.name }));
      })
      .finally(() => {
        event.target.value = '';
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
          speech_voice: profile.speech_voice,
          speech_style: profile.speech_style,
          speech_persona: profile.speech_persona,
          premium_voice_id: profile.premium_voice_id,
          heygen_avatar_id: profile.heygen_avatar_id,
          heygen_voice_id: profile.heygen_voice_id,
          app_execution_mode: profile.app_execution_mode,
          specialist_apps: profile.specialist_apps,
        };
      }
      const updated = await updateAgentProfiles(patch);
      setProfiles(updated.agents);
      setDraft(updated.agents);
    } finally {
      setSaving(false);
    }
  };

  const applyRecommendedProviders = () => {
    if (!catalog) return;
    setDraft((prev) => {
      const next = { ...prev };
      for (const agent of Object.values(prev)) {
        const recommended = catalog.recommended_by_function[agent.id];
        if (!recommended) continue;
        next[agent.id] = {
          ...agent,
          provider: recommended.provider,
          model: recommended.model,
        };
      }
      return next;
    });
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const nextPreset: SystemPreset = {
      id: crypto.randomUUID(),
      name,
      theme,
      agents: draft,
    };
    const next = [...presets, nextPreset];
    setPresets(next);
    saveJsonArray(window.localStorage, SYSTEM_PRESET_STORAGE_KEY, next);
    setPresetName('');
  };

  const applyPreset = async (preset: SystemPreset) => {
    setDraft(preset.agents);
    onThemeChange(preset.theme);
    const patch: Record<string, Partial<AgentProfile>> = {};
    for (const [id, profile] of Object.entries(preset.agents)) {
      patch[id] = profile;
    }
    const updated = await updateAgentProfiles(patch);
    setProfiles(updated.agents);
    setDraft(updated.agents);
  };

  const deletePreset = (presetId: string) => {
    const next = presets.filter((preset) => preset.id !== presetId);
    setPresets(next);
    saveJsonArray(window.localStorage, SYSTEM_PRESET_STORAGE_KEY, next);
  };

  const modelsForProvider = (providerId: string) => catalog?.providers.find((p) => p.id === providerId)?.models ?? [];

  return (
    <section className="panel agent-studio">
      <h2>Agent Studio</h2>
      <p className="muted">Edit agent identity, voice, model routing, and avatar mappings from one place.</p>

      <div className="org-chart" aria-label="Agent organization chart">
        <div className="org-row top">
          <OrgNode agent={org.coordinator} />
        </div>
        <div className="org-link vertical" />
        <div className="org-link horizontal three" />
        <div className="org-row middle three">
          {org.row2.map((a) => (
            <OrgNode key={a.id} agent={a} />
          ))}
        </div>
        <div className="org-link vertical" />
        <div className="org-link horizontal three" />
        <div className="org-row bottom three">
          {org.row3.map((a) => (
            <OrgNode key={a.id} agent={a} />
          ))}
        </div>
      </div>

      <div className="preset-panel">
        <div className="preset-panel-head">
          <div>
            <h3>System Presets</h3>
            <p className="muted small">Save the current agent roster and theme as a reusable setup.</p>
          </div>
          <div className="preset-save-row">
            <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Preset name" />
            <button type="button" onClick={savePreset}>Save Preset</button>
          </div>
        </div>
        <div className="preset-list">
          {presets.length === 0 && <p className="muted small">No saved presets yet.</p>}
          {presets.map((preset) => (
            <article key={preset.id} className="preset-card">
              <div>
                <strong>{preset.name}</strong>
                <p className="muted small">Theme: {preset.theme}</p>
              </div>
              <div className="preset-actions">
                <button type="button" onClick={() => void applyPreset(preset)}>Apply</button>
                <button type="button" className="ghost-button" onClick={() => deletePreset(preset.id)}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="preset-panel">
        <div className="preset-panel-head">
          <div>
            <h3>Curated OpenRouter Pack</h3>
            <p className="muted small">One-click OSS routing setups tuned for research, writing, and coding roles.</p>
          </div>
          <div className="preset-save-row">
            <button type="button" onClick={applyRecommendedProviders} disabled={!catalog}>
              Apply Recommended Providers
            </button>
          </div>
        </div>
        <div className="preset-list">
          {curatedOpenRouterPresets.map((preset) => (
            <article key={preset.id} className="preset-card curated-card">
              <div>
                <strong>{preset.name}</strong>
                <p className="muted small">
                  Theme: {preset.theme} · Researcher/Writer/Coding prefer OpenRouter open-source models.
                </p>
              </div>
              <div className="preset-actions">
                <button type="button" onClick={() => void applyPreset(preset)}>Apply</button>
              </div>
            </article>
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
            <div className="avatar-upload-row">
              <input
                id={`avatar-upload-${agent.id}`}
                className="avatar-file-input"
                type="file"
                accept="image/*"
                onChange={(e) => onAvatarFileChange(agent.id, e)}
              />
              <label className="avatar-browse-btn" htmlFor={`avatar-upload-${agent.id}`}>
                Browse...
              </label>
              <span className="avatar-upload-name">{uploadedFileNames[agent.id] ?? 'No file selected'}</span>
            </div>
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
            <label>
              Speech Voice
              <select value={agent.speech_voice} onChange={(e) => updateField(agent.id, 'speech_voice', e.target.value)}>
                {SPEECH_VOICES.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Speech Style
              <select value={agent.speech_style} onChange={(e) => updateField(agent.id, 'speech_style', e.target.value)}>
                {SPEECH_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {style}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Spoken Persona
              <textarea
                value={agent.speech_persona}
                onChange={(e) => updateField(agent.id, 'speech_persona', e.target.value)}
                rows={3}
                placeholder="How this agent should sound when speaking"
              />
            </label>
            <label>
              Premium Voice ID
              <input
                value={agent.premium_voice_id}
                onChange={(e) => updateField(agent.id, 'premium_voice_id', e.target.value)}
                placeholder="Optional ElevenLabs voice ID"
              />
            </label>
            <label>
              HeyGen Avatar ID
              <input
                value={agent.heygen_avatar_id}
                onChange={(e) => updateField(agent.id, 'heygen_avatar_id', e.target.value)}
                placeholder="Optional HeyGen avatar id"
              />
            </label>
            <label>
              HeyGen Voice ID
              <input
                value={agent.heygen_voice_id}
                onChange={(e) => updateField(agent.id, 'heygen_voice_id', e.target.value)}
                placeholder="Optional HeyGen voice id"
              />
            </label>
            <label>
              Local App Execution
              <select value={agent.app_execution_mode} onChange={(e) => updateField(agent.id, 'app_execution_mode', e.target.value)}>
                <option value="disabled">Disabled</option>
                <option value="approval">Approval required</option>
                <option value="auto">Automatic</option>
              </select>
            </label>
            <div className="app-specializations">
              <strong>Specialist Apps</strong>
              <p className="muted small">Saved app assignments for future local automation and connector execution.</p>
              <div className="app-chip-grid">
                {localApps.map((app) => (
                  <label key={app.id} className={agent.specialist_apps.includes(app.id) ? 'app-chip active' : 'app-chip'}>
                    <input
                      type="checkbox"
                      checked={agent.specialist_apps.includes(app.id)}
                      onChange={() => toggleSpecialistApp(agent.id, app.id)}
                    />
                    <span>{app.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
      <button type="button" onClick={save} disabled={saving}>
        {saving ? 'Saving...' : 'Save Agent Profiles'}
      </button>
    </section>
  );
}
