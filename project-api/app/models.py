import enum

from sqlalchemy import Boolean, Column, DateTime, Enum, Integer, String
from sqlalchemy.sql import func

from .database import Base


class Role(str, enum.Enum):
    user = "user"
    admin = "admin"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(120), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(Enum(Role), default=Role.user, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class RevokedToken(Base):
    """
    เก็บ jti (token id) ของ access token ที่ถูก logout ไปแล้ว
    เพราะ JWT ปกติเป็น stateless เรียกใช้ได้จนกว่าจะหมดอายุ ไม่มีทางยกเลิกกลางทางได้
    ตารางนี้คือกลไกง่ายๆ ที่ทำให้ POST /logout มีผลจริง (deny-list)
    """
    __tablename__ = "revoked_tokens"

    id = Column(Integer, primary_key=True, index=True)
    jti = Column(String(64), unique=True, index=True, nullable=False)
    revoked_at = Column(DateTime(timezone=True), server_default=func.now())
