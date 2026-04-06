from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "KG Multi-Agent Demo"
    environment: str = "dev"

    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"
    openai_base_url: str = "https://api.openai.com/v1"
    openai_tts_model: str = "gpt-4o-mini-tts"
    openai_tts_voice: str = "alloy"

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

    agent_profile_store_path: str = "/app/data/agent_profiles.json"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()
