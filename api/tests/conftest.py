import os

# Point the app at a dedicated test database *before* importing anything
# from `app`, since Settings/engine are constructed once at import time.
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://project_user:project_pass@localhost:5432/project_db_test",
)
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-not-for-production")

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.database import Base, SessionLocal, engine
from app.main import app


@pytest.fixture(scope="session", autouse=True)
def _schema():
    """Build the schema once per test session (mirrors what Alembic would
    produce), and tear it down afterwards."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture(autouse=True)
def _clean_tables():
    """Every test starts with empty tables so tests don't leak state into
    each other (order-independent, parallel-safe within one worker)."""
    yield
    db = SessionLocal()
    try:
        db.execute(text("TRUNCATE TABLE tasks, project_members, projects, refresh_tokens, users CASCADE"))
        db.commit()
    finally:
        db.close()


@pytest.fixture
def client():
    return TestClient(app)


def register_and_login(client: TestClient, username: str, password: str = "secret123") -> dict:
    """Test helper: register + login a fresh user, return id/tokens/headers."""
    client.post(
        "/register",
        json={"username": username, "email": f"{username}@example.com", "password": password},
    )
    resp = client.post("/login", json={"username": username, "password": password})
    tokens = resp.json()
    me = client.get("/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}).json()
    return {
        "id": me["id"],
        "username": username,
        "access_token": tokens["access_token"],
        "refresh_token": tokens["refresh_token"],
        "headers": {"Authorization": f"Bearer {tokens['access_token']}"},
    }
