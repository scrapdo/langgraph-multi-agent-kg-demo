import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createHeyGenLiveSession,
  createHeyGenVideo,
  getAgentProfiles,
  getHeyGenAssets,
  getHeyGenVideoStatus,
  sendHeyGenLiveTask,
  startHeyGenLiveSession,
  stopHeyGenLiveSession,
} from '../api/client';
import type { AgentProfile, HeyGenAssetsResponse, RunDetail } from '../types';

declare global {
  interface Window {
    LivekitClient?: {
      Room: new () => {
        connect: (url: string, token: string) => Promise<void>;
        disconnect: () => void;
        on: (event: string, cb: (track: { kind: string; mediaStreamTrack: MediaStreamTrack }) => void) => void;
      };
      RoomEvent: { TrackSubscribed: string };
    };
  }
}

interface Props {
  run: RunDetail | null;
}

function avatarIdOf(avatar: HeyGenAssetsResponse['avatars'][number]) {
  return avatar.avatar_id || avatar.id || '';
}

function avatarLabelOf(avatar: HeyGenAssetsResponse['avatars'][number]) {
  return avatar.avatar_name || avatar.name || avatarIdOf(avatar) || 'Avatar';
}

function voiceIdOf(voice: HeyGenAssetsResponse['voices'][number]) {
  return voice.voice_id || voice.id || '';
}

function voiceLabelOf(voice: HeyGenAssetsResponse['voices'][number]) {
  const base = voice.name || voiceIdOf(voice) || 'Voice';
  const parts = [voice.language, voice.gender].filter(Boolean);
  return parts.length ? `${base} (${parts.join(' • ')})` : base;
}

async function ensureLiveKitScript() {
  if (window.LivekitClient) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load LiveKit client'));
    document.head.appendChild(script);
  });
}

export function HeyGenPanel({ run }: Props) {
  const [assets, setAssets] = useState<HeyGenAssetsResponse | null>(null);
  const [profiles, setProfiles] = useState<Record<string, AgentProfile>>({});
  const [loadingAssets, setLoadingAssets] = useState(true);
  const [script, setScript] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [videoId, setVideoId] = useState('');
  const [videoStatus, setVideoStatus] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [liveMigrationNotice, setLiveMigrationNotice] = useState('');
  const [autoGenerate, setAutoGenerate] = useState(true);
  const [liveSessionId, setLiveSessionId] = useState('');
  const [liveStatus, setLiveStatus] = useState('idle');
  const [liveText, setLiveText] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('writer');
  const pollRef = useRef<number | null>(null);
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const liveRoomRef = useRef<{ disconnect: () => void } | null>(null);
  const lastAutoRunRef = useRef<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoadingAssets(true);
      setError('');
      try {
        const [response, profileResponse] = await Promise.all([getHeyGenAssets(), getAgentProfiles()]);
        setAssets(response);
        setProfiles(profileResponse.agents);
        const writer = profileResponse.agents.writer;
        const firstAvatar = writer?.heygen_avatar_id || avatarIdOf(response.avatars[0] ?? {});
        const firstVoice = writer?.heygen_voice_id || voiceIdOf(response.voices[0] ?? {});
        if (firstAvatar) setAvatarId(firstAvatar);
        if (firstVoice) setVoiceId(firstVoice);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load HeyGen assets');
      } finally {
        setLoadingAssets(false);
      }
    };
    void load();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      liveRoomRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    const profile = profiles[selectedAgent];
    if (!profile) return;
    if (profile.heygen_avatar_id) setAvatarId(profile.heygen_avatar_id);
    if (profile.heygen_voice_id) setVoiceId(profile.heygen_voice_id);
  }, [profiles, selectedAgent]);

  const suggestedScript = useMemo(() => {
    const state = run?.state ?? {};
    return String(state.spoken_response ?? run?.output ?? '').trim();
  }, [run]);

  useEffect(() => {
    if (!autoGenerate || !assets?.enabled || !run?.run_id || run.status !== 'completed') return;
    if (lastAutoRunRef.current === run.run_id) return;
    const profile = profiles.writer;
    const nextScript = suggestedScript;
    const nextAvatar = profile?.heygen_avatar_id || avatarId;
    const nextVoice = profile?.heygen_voice_id || voiceId;
    if (!nextScript || !nextAvatar || !nextVoice) return;
    lastAutoRunRef.current = run.run_id;
    setScript(nextScript);
    void generateVideo(nextScript, nextAvatar, nextVoice);
  }, [autoGenerate, assets?.enabled, run?.run_id, run?.status, suggestedScript, profiles, avatarId, voiceId]);

  const pollStatus = async (nextVideoId: string) => {
    try {
      const payload = await getHeyGenVideoStatus(nextVideoId);
      const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
      const status = String(data.status ?? data.video_status ?? 'pending');
      const url = String(data.video_url ?? data.url ?? '');
      setVideoStatus(status);
      if (url) setVideoUrl(url);
      if (!['completed', 'failed', 'error'].includes(status.toLowerCase())) {
        pollRef.current = window.setTimeout(() => void pollStatus(nextVideoId), 4000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to poll video status');
    }
  };

  const generateVideo = async (nextScript = script, nextAvatar = avatarId, nextVoice = voiceId) => {
    if (!nextScript.trim() || !nextAvatar || !nextVoice) return;
    setSubmitting(true);
    setError('');
    setVideoUrl('');
    setVideoStatus('queued');
    try {
      const payload = await createHeyGenVideo(nextScript.trim(), nextAvatar, nextVoice);
      const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
      const nextVideoId = String(data.video_id ?? data.id ?? '');
      if (!nextVideoId) throw new Error('HeyGen did not return a video id');
      setVideoId(nextVideoId);
      void pollStatus(nextVideoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create HeyGen video');
      setVideoStatus('error');
    } finally {
      setSubmitting(false);
    }
  };

  const startLive = async () => {
    const profile = profiles[selectedAgent];
    const resolvedAvatar = profile?.heygen_avatar_id || avatarId;
    if (!resolvedAvatar) return;
    setError('');
    setLiveStatus('connecting');
    try {
      await ensureLiveKitScript();
      const payload = await createHeyGenLiveSession(resolvedAvatar);
      const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
      const sessionId = String(data.session_id ?? '');
      const url = String(data.url ?? '');
      const token = String(data.access_token ?? '');
      if (!sessionId || !url || !token) throw new Error('Incomplete HeyGen live session response');

      await startHeyGenLiveSession(sessionId);
      const RoomCtor = window.LivekitClient?.Room;
      const roomEvent = window.LivekitClient?.RoomEvent?.TrackSubscribed;
      if (!RoomCtor || !roomEvent) throw new Error('LiveKit client unavailable');

      const room = new RoomCtor();
      const mediaStream = new MediaStream();
      room.on(roomEvent, (track) => {
        if (track.kind === 'video' || track.kind === 'audio') {
          mediaStream.addTrack(track.mediaStreamTrack);
          if (liveVideoRef.current) {
            liveVideoRef.current.srcObject = mediaStream;
          }
        }
      });
      await room.connect(url, token);
      liveRoomRef.current = room;
      setLiveSessionId(sessionId);
      setLiveStatus('connected');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start live avatar';
      if (message.toLowerCase().includes('liveavatar')) {
        setLiveMigrationNotice(message);
      } else {
        setError(message);
      }
      setLiveStatus('error');
    }
  };

  const speakLive = async () => {
    if (!liveSessionId || !liveText.trim()) return;
    try {
      await sendHeyGenLiveTask(liveSessionId, liveText.trim());
      setLiveStatus('speaking');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send live task');
    }
  };

  const stopLive = async () => {
    if (!liveSessionId) return;
    try {
      await stopHeyGenLiveSession(liveSessionId);
    } catch {
      // no-op
    }
    liveRoomRef.current?.disconnect();
    liveRoomRef.current = null;
    if (liveVideoRef.current) liveVideoRef.current.srcObject = null;
    setLiveSessionId('');
    setLiveStatus('idle');
  };

  return (
    <section className="panel">
      <h2>HeyGen</h2>
      <p className="muted">Avatar video generation, writer auto-render, and LiveAvatar migration/testing controls.</p>

      {loadingAssets && <p className="muted">Loading avatars and voices…</p>}
      {!loadingAssets && assets && !assets.enabled && (
        <p className="muted">HeyGen is not enabled yet. Add your API key to activate video generation and LiveAvatar.</p>
      )}
      {error && <p className="muted">{error}</p>}
      {liveMigrationNotice && <p className="muted">{liveMigrationNotice}</p>}

      <label>
        Agent Mapping
        <select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
          {Object.values(profiles).map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>

      <label className="checkbox-row">
        <input type="checkbox" checked={autoGenerate} onChange={(e) => setAutoGenerate(e.target.checked)} />
        Auto-generate writer video after completed runs
      </label>

      <label>
        Script
        <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={5} placeholder="Avatar script" />
      </label>
      <div className="template-save-bar">
        <button type="button" onClick={() => setScript(suggestedScript)} disabled={!suggestedScript}>
          Use Current Run Response
        </button>
      </div>

      <label>
        Avatar
        <select value={avatarId} onChange={(e) => setAvatarId(e.target.value)} disabled={!assets?.enabled}>
          {assets?.avatars.map((avatar) => (
            <option key={avatarIdOf(avatar)} value={avatarIdOf(avatar)}>
              {avatarLabelOf(avatar)}
            </option>
          ))}
        </select>
      </label>

      <label>
        Voice
        <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} disabled={!assets?.enabled}>
          {assets?.voices.map((voice) => (
            <option key={voiceIdOf(voice)} value={voiceIdOf(voice)}>
              {voiceLabelOf(voice)}
            </option>
          ))}
        </select>
      </label>

      <button type="button" onClick={() => void generateVideo()} disabled={!assets?.enabled || submitting || !script.trim()}>
        {submitting ? 'Submitting…' : 'Generate Video'}
      </button>

      {(videoId || videoStatus) && (
        <div className="status-card">
          <h3>Video Status</h3>
          <p><strong>ID:</strong> {videoId || '--'}</p>
          <p><strong>Status:</strong> {videoStatus || '--'}</p>
          {videoUrl && (
            <>
              <video controls className="heygen-video" src={videoUrl} />
              <p><a href={videoUrl} target="_blank" rel="noreferrer">Open video</a></p>
            </>
          )}
        </div>
      )}

      <div className="status-card">
        <h3>LiveAvatar</h3>
        <p><strong>Status:</strong> {liveStatus}</p>
        <div className="template-save-bar">
          <button
            type="button"
            onClick={() => void startLive()}
            disabled={!assets?.enabled || liveStatus === 'connecting' || !!liveSessionId || !!liveMigrationNotice}
          >
            Start Live Session
          </button>
          <button type="button" className="ghost-button" onClick={() => void stopLive()} disabled={!liveSessionId}>
            Stop Live Session
          </button>
        </div>
        {liveMigrationNotice && (
          <p className="muted small">
            The old interactive-avatar endpoints are gone. This panel now needs a LiveAvatar-specific backend migration and key.
          </p>
        )}
        <video ref={liveVideoRef} className="heygen-video" autoPlay playsInline muted />
        <label>
          Live Text
          <textarea value={liveText} onChange={(e) => setLiveText(e.target.value)} rows={3} placeholder="Text to send to live avatar" />
        </label>
        <div className="template-save-bar">
          <button type="button" onClick={() => setLiveText(suggestedScript)} disabled={!suggestedScript}>
            Use Current Run Response
          </button>
          <button type="button" onClick={() => void speakLive()} disabled={!liveSessionId || !liveText.trim()}>
            Send To Avatar
          </button>
        </div>
      </div>
    </section>
  );
}
