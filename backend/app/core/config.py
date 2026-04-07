from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "KG Multi-Agent Demo"
    environment: str = "dev"
    app_timezone: str = "America/New_York"

    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "alloy"
    tts_provider_default: str = "openai"

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

    heygen_api_key: str = ""
    heygen_base_url: str = "https://api.heygen.com"
    heygen_avatar_id: str = ""
    heygen_voice_id: str = ""

    zep_api_key: str = ""
    zep_base_url: str = "https://api.getzep.com"

    neo4j_uri: str = "bolt://neo4j:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "password"

    postgres_dsn: str = "postgresql+psycopg://postgres:postgres@postgres:5432/agentdb"
    redis_url: str = "redis://redis:6379/0"

    max_revision_loops: int = 2
    node_timeout_seconds: int = 30

    side_effect_default_mode: str = "simulation"
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

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()
