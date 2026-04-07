export type RunMode = 'simulation' | 'live';

export interface RunResponse {
  run_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'degraded';
}

export interface RunDetail {
  run_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'degraded';
  mode: RunMode;
  task: string;
  state: Record<string, unknown>;
  output?: string;
  created_at: string;
  updated_at: string;
}

export interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: Record<string, unknown>;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MemoryReference {
  memory_id: string;
  thread_id?: string | null;
  score?: number | null;
  summary?: string | null;
  facts: string[];
  entities: string[];
  source_type?: string | null;
  created_at?: string | null;
}

export interface EpisodeRecord {
  episode_id: string;
  thread_id?: string | null;
  run_id?: string | null;
  agent_id?: string | null;
  episode_type: string;
  content: string;
  created_at?: string | null;
  metadata: Record<string, unknown>;
}

export interface ClaimRecord {
  claim_id: string;
  text: string;
  source?: string | null;
  confidence?: number | null;
  status?: string | null;
  entity_names: string[];
  created_at?: string | null;
}

export interface EntityMention {
  entity_id: string;
  name: string;
  entity_type: string;
}

export interface RunMemoryResponse {
  run_id: string;
  thread_id?: string | null;
  thread_context?: string | null;
  memory_refs: MemoryReference[];
  episodes: EpisodeRecord[];
  entities: EntityMention[];
  claims: ClaimRecord[];
  desktop_artifacts: DesktopArtifactRecord[];
}

export interface DesktopArtifactRecord {
  artifact_id: string;
  action_id: string;
  kind: string;
  agent_id?: string | null;
  action_type?: string | null;
  title?: string | null;
  output_path?: string | null;
  created_at?: string | null;
}

export interface ThreadDetailResponse {
  thread_id: string;
  user_id?: string | null;
  context?: string | null;
  messages: Array<Record<string, unknown>>;
  episodes: EpisodeRecord[];
}

export interface AgentProfile {
  id: string;
  name: string;
  avatar: string;
  provider: string;
  model: string;
  function: string;
  speech_voice: string;
  speech_style: string;
  speech_persona: string;
  premium_voice_id: string;
  heygen_avatar_id: string;
  heygen_voice_id: string;
  app_execution_mode: 'disabled' | 'approval' | 'auto';
  specialist_apps: string[];
}

export interface AgentProfilesResponse {
  agents: Record<string, AgentProfile>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  enabled: boolean;
  models: string[];
}

export interface ProvidersCatalog {
  providers: ProviderDefinition[];
  recommended_by_function: Record<string, { provider: string; model: string }>;
}

export interface HeyGenAvatar {
  avatar_id?: string;
  id?: string;
  avatar_name?: string;
  name?: string;
  preview_image_url?: string;
}

export interface HeyGenVoice {
  voice_id?: string;
  id?: string;
  name?: string;
  language?: string;
  gender?: string;
}

export interface HeyGenAssetsResponse {
  enabled: boolean;
  avatars: HeyGenAvatar[];
  voices: HeyGenVoice[];
}

export interface HuggingFaceRepoResult {
  id: string;
  link: string;
  downloads?: number | null;
  likes?: number | null;
  pipeline_tag?: string | null;
  library_name?: string | null;
  sdk?: string | null;
  tags?: string[];
}

export interface HuggingFaceSearchResponse {
  items: HuggingFaceRepoResult[];
}

export interface HuggingFaceStatus {
  hub: string;
  inference: string;
  transformers_local: string;
  optimum: string;
  parler_tts: string;
  local_model: string;
  parler_model: string;
  optimum_acceleration: boolean;
}

export interface ShoppingSource {
  title: string;
  domain: string;
  url: string;
  trust_score: number;
  price_signal?: string | null;
  marketplace_type?: string | null;
}

export interface ShoppingSummaryResponse {
  run_id: string;
  task: string;
  trust_notes: string[];
  sources: ShoppingSource[];
  risk_flags: string[];
}

export interface ApprovalItem {
  approval_id: string;
  kind: 'shopping_lead' | 'social_post';
  title: string;
  status: 'queued' | 'approved' | 'rejected';
  platform?: string | null;
  url?: string | null;
  message?: string | null;
  notes: string[];
  executed: boolean;
  simulated: boolean;
  created_at: string;
  updated_at: string;
}

export interface SocialPlatformPlan {
  platform: string;
  notes: string[];
  live_ready: boolean;
}

export interface SocialSummaryResponse {
  run_id: string;
  task: string;
  platforms: SocialPlatformPlan[];
  scheduling_notes: string[];
  publish_status: Array<Record<string, unknown>>;
  approvals: ApprovalItem[];
}

export interface LocalAppDefinition {
  id: string;
  label: string;
  category: string;
  actions: string[];
  notes?: string | null;
}

export interface DesktopAction {
  action_id: string;
  kind: 'writer_doc' | 'social_package' | 'gmail_calendar' | 'ai_influencer';
  agent_id: string;
  status: 'queued' | 'completed' | 'blocked' | 'failed';
  title: string;
  output_path?: string | null;
  notes: string[];
  payload: Record<string, unknown>;
  execution_history: Array<Record<string, unknown>>;
  last_execution_method?: string | null;
  last_error?: string | null;
  executed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesktopSchedule {
  schedule_id: string;
  name: string;
  workflow_kind: string;
  agent_id: string;
  enabled: boolean;
  cadence_label: string;
  rrule: string;
  notes: string[];
  created_at: string;
  updated_at: string;
}
