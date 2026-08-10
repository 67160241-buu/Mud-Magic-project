from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field

from .models import Role


# ---------- Auth ----------

class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50, examples=["nan_ceramic"])
    email: EmailStr
    password: str = Field(min_length=8, examples=["S3cur3Passw0rd!"])


class UserLogin(BaseModel):
    username: str
    password: str


class ChangePassword(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8)


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MessageOut(BaseModel):
    message: str


class UsernameAvailable(BaseModel):
    username: str
    available: bool


# ---------- User management ----------

class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    password: Optional[str] = Field(default=None, min_length=8)


class UserOut(BaseModel):
    id: int
    username: str
    email: EmailStr
    role: Role
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class UserListOut(BaseModel):
    total: int
    page: int
    limit: int
    items: List[UserOut]
