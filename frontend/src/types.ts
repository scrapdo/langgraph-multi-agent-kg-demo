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
  ready: boolean;
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

export interface SecretaryDispatchRequest {
  channel: 'auto' | 'call' | 'sms' | 'email' | 'telegram';
  to: string;
  subject?: string;
  message: string;
  mode: RunMode;
  provider?: 'auto' | 'twilio' | 'telnyx' | 'sendgrid' | 'telegram';
  contact_id?: string;
}

export interface SecretaryContactPreference {
  contact_id: string;
  name: string;
  preferred_channel: 'call' | 'sms' | 'email' | 'telegram';
  preferred_provider: 'auto' | 'twilio' | 'telnyx' | 'sendgrid' | 'telegram';
  phone_number?: string;
  email?: string;
  telegram_chat_id?: string;
  notes?: string;
  relationship?: string;
  organization?: string;
  timezone?: string;
  preferred_contact_window?: string;
  channel_priority?: Array<'call' | 'sms' | 'email' | 'telegram'>;
  wellness_opt_in?: boolean;
  last_contact_at?: string;
  last_contact_channel?: string;
}

export interface OperatorInboxItem {
  item_id: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  source: string;
  agent_id?: string | null;
  run_id?: string | null;
  schedule_id?: string | null;
  action_id?: string | null;
  created_at?: string | null;
  metadata: Record<string, unknown>;
}

export interface OperatorInboxResponse {
  summary: Record<string, number>;
  items: OperatorInboxItem[];
}

export interface DocumentProcessResponse {
  name: string;
  content_type: string;
  size_bytes: number;
  extracted_text: string;
  summary: string;
  sections: string[];
  warnings: string[];
}

export interface BrowserInspectionResult {
  url: string;
  status_code?: number;
  title?: string;
  description?: string;
  h1?: string;
  link_count?: number;
  content_type?: string;
  error?: string;
}

export interface BrowserWorkflow {
  workflow_id: string;
  name: string;
  agent_id: string;
  mode: RunMode;
  start_url: string;
  urls: string[];
  goal: string;
  notes: string[];
  last_run_at?: string;
  last_status?: string;
  created_at: string;
  updated_at: string;
}

export interface PlaywrightScript {
  script_id: string;
  name: string;
  agent_id: string;
  start_url: string;
  steps: Array<Record<string, unknown>>;
  mode?: RunMode;
  approval_required?: boolean;
  notes: string[];
  last_run_at?: string;
  last_status?: string;
  created_at: string;
  updated_at: string;
}

export interface PlaywrightScriptPreset {
  preset_id: string;
  name: string;
  agent_id: string;
  description: string;
  start_url: string;
  mode: RunMode;
  approval_required: boolean;
  steps: Array<Record<string, unknown>>;
}

export interface BrowserStepDraft {
  action: 'wait' | 'click' | 'fill' | 'extract_text';
  label: string;
  selector?: string;
  value?: string;
  timeout_ms?: number;
}

export interface DesktopAction {
  action_id: string;
  kind: 'writer_doc' | 'social_package' | 'gmail_calendar' | 'ai_influencer' | 'wellness_checkin';
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
  mode: 'simulation' | 'live';
  approval_required: boolean;
  output_preset?: string;
  output_subdir?: string;
  template_preset?: string;
  prompt_template?: string;
  content_template?: string;
  cadence_label: string;
  rrule: string;
  notes: string[];
  last_run_at?: string;
  last_run_id?: string;
  last_action_id?: string;
  last_run_status?: string;
  last_error?: string;
  success_count?: number;
  failure_count?: number;
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface DesktopSchedulePreset {
  id: string;
  label: string;
  subdir?: string;
  prompt_template?: string;
  content_template?: string;
}

export interface SchedulerAvailabilityWindow {
  weekday: number;
  start: string;
  end: string;
}

export interface SchedulerEventType {
  event_type_id: string;
  name: string;
  slug: string;
  description: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  minimum_notice_hours: number;
  booking_window_days: number;
  max_bookings_per_day: number;
  is_active: boolean;
}

export interface SchedulerProfile {
  owner_name: string;
  public_slug: string;
  headline: string;
  bio: string;
  timezone: string;
  location_type: string;
  location_value: string;
  booking_window_days: number;
  minimum_notice_hours: number;
  max_bookings_per_day: number;
  availability: SchedulerAvailabilityWindow[];
  blackout_dates: string[];
  event_types: SchedulerEventType[];
}

export interface SchedulerPublicProfile {
  owner_name: string;
  public_slug: string;
  headline: string;
  bio: string;
  timezone: string;
  location_type: string;
  location_value: string;
  event_types: SchedulerEventType[];
}

export interface SchedulerAvailabilitySlot {
  start_at: string;
  end_at: string;
  label: string;
}

export interface SchedulerAvailabilityResponse {
  date: string;
  timezone: string;
  event_type: SchedulerEventType;
  slots: SchedulerAvailabilitySlot[];
}

export interface SchedulerBooking {
  booking_id: string;
  public_slug: string;
  event_type_id: string;
  event_type_slug: string;
  event_type_name: string;
  duration_minutes: number;
  status: string;
  name: string;
  email: string;
  notes: string;
  location_type: string;
  location_value: string;
  timezone: string;
  start_at: string;
  end_at: string;
  created_at: string;
  confirmation_code: string;
}

export interface SchedulerDashboardResponse {
  profile: SchedulerProfile;
  bookings: SchedulerBooking[];
  metrics: Record<string, number>;
}
