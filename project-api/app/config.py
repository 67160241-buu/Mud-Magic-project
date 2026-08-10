from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    ตั้งค่าทั้งหมดของแอปอ่านมาจาก environment variable (หรือไฟล์ .env ตอนรันนอก Docker)
    ห้าม hardcode ค่า secret ไว้ในโค้ดเด็ดขาด — ดูตัวอย่างค่าที่ต้องตั้งใน .env.example
    """
    database_url: str = "sqlite:///./dev.db"
    secret_key: str = "dev-secret-change-me"
    access_token_expire_minutes: int = 60

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
