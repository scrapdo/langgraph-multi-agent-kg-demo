from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "KG Multi-Agent Demo"
    environment: str = "dev"

    openai_api_key: str = ""
    openai_model: str = "gpt-4.1-mini"

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

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()
