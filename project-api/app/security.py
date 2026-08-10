from datetime import datetime, timedelta, timezone
from uuid import uuid4

import bcrypt
from jose import jwt

from .config import settings

ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())
    return hashed.decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


def create_access_token(subject: str) -> str:
    jti = str(uuid4())
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": subject, "jti": jti, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    # ปล่อยให้ jose.JWTError โยนออกไปให้ caller (deps.py) จัดการเป็น 401
    return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
