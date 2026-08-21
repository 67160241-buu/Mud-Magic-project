from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import models, schemas, security
from app.database import get_db
from app.deps import get_current_user

router = APIRouter(tags=["Authentication"])


@router.post("/register", response_model=schemas.UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: schemas.RegisterRequest, db: Session = Depends(get_db)):
    if db.query(models.User).filter(models.User.username == payload.username).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already taken")
    if db.query(models.User).filter(models.User.email == payload.email).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")

    user = models.User(
        username=payload.username,
        email=payload.email,
        full_name=payload.full_name,
        hashed_password=security.hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _issue_tokens(user: models.User, db: Session) -> schemas.TokenPair:
    access_token = security.create_access_token(subject=user.id)
    refresh_token, expires_at = security.create_refresh_token(subject=user.id)
    db.add(
        models.RefreshToken(
            user_id=user.id,
            token_hash=security.hash_token(refresh_token),
            expires_at=expires_at,
        )
    )
    db.commit()
    return schemas.TokenPair(access_token=access_token, refresh_token=refresh_token)


@router.post("/login", response_model=schemas.TokenPair)
def login(payload: schemas.LoginRequest, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == payload.username).first()
    if user is None or not security.verify_password(payload.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid username or password")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has been deactivated")
    return _issue_tokens(user, db)


@router.post("/refresh", response_model=schemas.TokenPair)
def refresh(payload: schemas.RefreshRequest, db: Session = Depends(get_db)):
    try:
        claims = security.decode_token(payload.refresh_token)
    except ValueError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired refresh token") from exc
    if claims.get("type") != "refresh":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not a refresh token")

    token_hash = security.hash_token(payload.refresh_token)
    stored = db.query(models.RefreshToken).filter_by(token_hash=token_hash, revoked=False).first()
    if stored is None or stored.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token is no longer valid")

    user = db.get(models.User, claims.get("sub"))
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or inactive")

    # Rotate: revoke the used refresh token and issue a fresh pair.
    stored.revoked = True
    db.commit()
    return _issue_tokens(user, db)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(payload: schemas.LogoutRequest, db: Session = Depends(get_db)):
    token_hash = security.hash_token(payload.refresh_token)
    stored = db.query(models.RefreshToken).filter_by(token_hash=token_hash).first()
    if stored is not None:
        stored.revoked = True
        db.commit()
    return None


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: schemas.ChangePasswordRequest,
    current_user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not security.verify_password(payload.old_password, current_user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Old password is incorrect")

    current_user.hashed_password = security.hash_password(payload.new_password)
    db.add(current_user)
    # Changing password revokes every outstanding refresh token as a safety measure.
    db.query(models.RefreshToken).filter_by(user_id=current_user.id, revoked=False).update({"revoked": True})
    db.commit()
    return None
