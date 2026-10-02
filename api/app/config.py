from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg2://project_user:project_pass@localhost:5432/project_db"
    jwt_secret_key: str = "change-this-to-a-long-random-secret"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # OpenAI — optional. Leave blank to disable the AI design endpoint;
    # the front end then falls back to its offline keyword generator.
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_timeout_seconds: float = 30.0

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
