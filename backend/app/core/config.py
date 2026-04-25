from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _env_files() -> tuple[str, ...]:
    # Project-tree config first (non-secrets), user-home secrets second.
    # Later files override earlier ones, so secrets win.
    candidates: list[str] = [".env"]
    secrets_override = os.environ.get("KG_SECRETS_FILE")
    if secrets_override:
        candidates.append(secrets_override)
    else:
        home_secrets = Path.home() / ".config" / "the-brain" / "secrets.env"
        candidates.append(str(home_secrets))
    return tuple(path for path in candidates if Path(path).expanduser().is_file())


class Settings(BaseSettings):
    app_name: str = "The Brain"
    environment: str = "dev"
    app_timezone: str = "America/New_York"

    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "alloy"
    # Delegator voice (OpenAI Realtime API). Options include: alloy, ash, ballad,
    # coral, echo, sage, shimmer, verse. "ash" is warmer/more conversational than
    # "alloy" — good match for the chief-of-staff persona.
    openai_realtime_voice: str = "ash"
    # Distinct voice for the telephony Secretary so she sounds different from
    # the desktop Delegator. Female-leaning by default — common mental model
    # for an executive secretary. Override in secrets.env if you want another
    # (alloy, ash, ballad, coral, echo, sage, shimmer, verse).
    openai_realtime_secretary_voice: str = "shimmer"
    tts_provider_default: str = "elevenlabs"

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-3-7-sonnet-latest"

    google_api_key: str = ""
    google_model: str = "gemini-2.5-pro"

    perplexity_api_key: str = ""
    perplexity_model: str = "sonar-pro"
    perplexity_base_url: str = "https://api.perplexity.ai"

    xai_api_key: str = ""
    xai_model: str = "grok-3-mini"
    xai_base_url: str = "https://api.x.ai/v1"

    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"
    groq_base_url: str = "https://api.groq.com/openai/v1"

    openrouter_api_key: str = ""
    openrouter_model: str = "meta-llama/llama-3.3-70b-instruct"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"

    huggingface_api_key: str = ""
    transformers_local_model: str = "HuggingFaceTB/SmolLM2-360M-Instruct"
    transformers_device: str = "cpu"
    transformers_use_optimum: bool = False
    transformers_max_new_tokens: int = 220
    parler_tts_model: str = "parler-tts/parler-tts-mini-multilingual-v1.1"
    parler_tts_voice_description: str = (
        "A clear, natural, warm human voice with steady pacing, light studio reverb, "
        "and concise but expressive delivery."
    )

    elevenlabs_api_key: str = ""
    elevenlabs_base_url: str = "https://api.elevenlabs.io/v1"
    elevenlabs_tts_model: str = "eleven_multilingual_v2"
    elevenlabs_voice_id: str = ""

    zep_api_key: str = ""
    zep_base_url: str = "https://api.getzep.com"

    # Neo4j is optional. Leave blank (default) and graph storage becomes a no-op;
    # the app still runs, it just doesn't record the knowledge graph. Only the
    # legacy Docker stack (which includes the neo4j container) sets this.
    neo4j_uri: str = ""
    neo4j_user: str = "neo4j"
    neo4j_password: str = "password"

    # Postgres is optional. Leave blank (default) to use the SQLite checkpointer.
    # Native-app builds ship without Postgres; only the legacy Docker stack sets this.
    postgres_dsn: str = ""
    # Local-file DB path for the LangGraph SQLite checkpointer when postgres_dsn is empty.
    sqlite_checkpoint_path: str = "data/langgraph.sqlite3"
    # Redis is optional too. Leave blank to run without Celery (in-process background tasks).
    redis_url: str = ""

    max_revision_loops: int = 2
    node_timeout_seconds: int = 30

    side_effect_default_mode: str = "live"
    side_effect_live_tools_csv: str = ""
    x_publish_webhook_url: str = ""
    x_publish_bearer_token: str = ""
    linkedin_publish_webhook_url: str = ""
    linkedin_publish_bearer_token: str = ""
    instagram_publish_webhook_url: str = ""
    instagram_publish_bearer_token: str = ""

    agent_profile_store_path: str = "data/agent_profiles.json"
    run_store_path: str = "data/runs.json"
    desktop_action_store_path: str = "data/desktop_actions.json"
    desktop_schedule_store_path: str = "data/desktop_schedules.json"
    browser_workflow_store_path: str = "data/browser_workflows.json"
    browser_script_store_path: str = "data/browser_scripts.json"
    scheduler_store_path: str = "data/scheduler.json"
    desktop_output_dir: str = "data/exports"
    host_automation_base_url: str = ""
    host_automation_token: str = ""
    gmail_calendar_webhook_url: str = ""
    gmail_calendar_bearer_token: str = ""
    ai_influencer_webhook_url: str = ""
    ai_influencer_bearer_token: str = ""
    google_workspace_access_token: str = ""
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_oauth_redirect_uri: str = "http://localhost:8000/google/oauth/callback"
    google_workspace_token_store_path: str = "data/google_workspace_tokens.json"
    google_workspace_user: str = "me"
    google_calendar_id: str = "primary"
    ai_influencer_app_url: str = ""
    ai_influencer_app_name: str = ""
    ai_influencer_app_path: str = ""
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_phone_number: str = ""
    # Public https URL that Twilio can hit for webhooks + media streams.
    # In dev, point this at your Cloudflare tunnel / ngrok host
    # (e.g. https://abc.trycloudflare.com). Without it, inbound telephony
    # routes refuse with a clear setup error.
    telephony_public_base: str = ""
    telnyx_api_key: str = ""
    telnyx_phone_number: str = ""
    telnyx_connection_id: str = ""
    sendgrid_api_key: str = ""
    secretary_email_from: str = ""
    telegram_bot_token: str = ""
    telegram_default_chat_id: str = ""
    secretary_test_store_path: str = "data/secretary_tests.json"
    secretary_contact_store_path: str = "data/secretary_contacts.json"
    github_token: str = ""
    github_owner: str = ""
    github_repo: str = ""
    github_project_id: str = ""
    browser_verify_ssl: bool = False
    playwright_headless: bool = True

    # ------------------------------------------------------------------
    # Per-agent model assignments. Source: the AGENT ECOSYSTEM AI Model
    # Recommendations doc (April 2026) which specifies a primary model per
    # role optimized for cost, latency, and capability. Each role has BOTH
    # a provider and a model slug — we route through model_router_service
    # which owns API-key + base-URL selection. Override any of these in
    # secrets.env if the recommended slug is unavailable on your account.
    #
    # The doc's reasoning at a glance:
    #   coordinator  · gpt-4.1-mini    · best IFEval (instruction following) at sub-frontier price
    #   delegator    · gpt-4.1-nano    · fastest GPT-4.1, pure router (no reasoning needed)
    #   researcher   · gemini-2.5-flash · native Google search grounding, automatic citations
    #   writer       · qwen3-235b      · #1 open-source creative alignment 2026
    #   critic       · claude-haiku-4-5 · best quality-review tone discipline
    #   coding       · devstral 2      · purpose-built agentic coding, beats GPT-5 on SWE-bench
    #   shopper      · gemini flash-lite · cheapest with 1M ctx, fastest TTFT for price lookups
    #   social       · deepseek v3     · strong reasoning + writing at 1/50th frontier cost
    #   secretary    · deepseek v3     · #1 open-source tool calling for calendar/email actions
    #   wellness     · llama-3.3-70b:free · free tier handles wellness coaching well
    # ------------------------------------------------------------------
    agent_provider_coordinator: str = "openai"
    agent_model_coordinator: str = "gpt-4.1-mini"
    # The Delegator is the fast inner router — used by the coordinator to
    # classify intent before dispatching to a specialist. Sub-200ms TTFT.
    agent_provider_delegator_router: str = "openai"
    agent_model_delegator_router: str = "gpt-4.1-nano"
    # Researcher prefers Google direct (native search grounding) but the doc
    # also explicitly endorses "one OpenRouter account for all agents". We
    # default to the openrouter passthrough so it works on stock installs.
    agent_provider_researcher: str = "openrouter"
    agent_model_researcher: str = "google/gemini-2.5-flash"
    agent_provider_writer: str = "openrouter"
    agent_model_writer: str = "qwen/qwen3-235b-a22b-instruct"
    agent_provider_critic: str = "anthropic"
    agent_model_critic: str = "claude-haiku-4-5"
    agent_provider_coding: str = "openrouter"
    agent_model_coding: str = "mistralai/devstral-small-2505"
    # Shopper: same Google passthrough rationale as researcher above.
    agent_provider_shopper: str = "openrouter"
    agent_model_shopper: str = "google/gemini-2.5-flash-lite"
    agent_provider_social: str = "openrouter"
    agent_model_social: str = "deepseek/deepseek-chat"
    agent_provider_secretary: str = "openrouter"
    agent_model_secretary: str = "deepseek/deepseek-chat"
    agent_provider_wellness: str = "openrouter"
    agent_model_wellness: str = "meta-llama/llama-3.3-70b-instruct:free"

    api_bearer_token: str = ""
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    model_config = SettingsConfigDict(
        env_file=_env_files(),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def cors_allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


settings = Settings()
