from typing import Generator

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
from sqlalchemy.orm import Session

from . import models, security
from .database import SessionLocal

# tokenUrl แค่บอก Swagger UI ว่าไปขอ token ได้จากไหน (endpoint จริงรับ JSON ไม่ใช่ form)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/login", auto_error=False)

credentials_exception = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="ไม่สามารถยืนยันตัวตนได้ กรุณาเข้าสู่ระบบใหม่",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_token_payload(token: str | None = Depends(oauth2_scheme)) -> dict:
    if token is None:
        raise credentials_exception
    try:
        return security.decode_token(token)
    except JWTError:
        raise credentials_exception


def get_current_user(
    payload: dict = Depends(get_token_payload),
    db: Session = Depends(get_db),
) -> models.User:
    username = payload.get("sub")
    jti = payload.get("jti")
    if username is None or jti is None:
        raise credentials_exception

    is_revoked = db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first()
    if is_revoked:
        raise credentials_exception

    user = db.query(models.User).filter(models.User.username == username).first()
    if user is None or not user.is_active:
        raise credentials_exception
    return user


def require_admin(current_user: models.User = Depends(get_current_user)) -> models.User:
    if current_user.role != models.Role.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="ต้องเป็นผู้ดูแลระบบเท่านั้น")
    return current_user
