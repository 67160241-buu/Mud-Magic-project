import math

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import models, schemas
from app.database import get_db
from app.deps import get_current_user

router = APIRouter(tags=["User Management"])


@router.get("/me", response_model=schemas.UserOut)
def get_me(current_user: models.User = Depends(get_current_user)):
    return current_user


@router.get("/check-username/{name}", response_model=schemas.UsernameAvailability)
def check_username(name: str, db: Session = Depends(get_db)):
    exists = db.query(models.User).filter(models.User.username == name).first() is not None
    return schemas.UsernameAvailability(username=name, available=not exists)


@router.get("/users", response_model=schemas.Page[schemas.UserOut])
def list_users(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    search: str | None = Query(None, description="Filter by username or email substring"),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    query = db.query(models.User)
    if search:
        like = f"%{search}%"
        query = query.filter(models.User.username.ilike(like) | models.User.email.ilike(like))

    total = query.count()
    items = query.order_by(models.User.created_at.desc()).offset((page - 1) * limit).limit(limit).all()
    pages = math.ceil(total / limit) if total else 0
    return schemas.Page(items=items, total=total, page=page, limit=limit, pages=pages)


@router.get("/users/{user_id}", response_model=schemas.UserOut)
def get_user(user_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    return user


def _assert_self_or_admin(target_id: str, current_user: models.User):
    if current_user.id != target_id and not current_user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only manage your own account")


@router.put("/users/{user_id}", response_model=schemas.UserOut)
def update_user(
    user_id: str,
    payload: schemas.UserUpdateRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    _assert_self_or_admin(user_id, current_user)
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    data = payload.model_dump(exclude_unset=True)
    if "is_active" in data and not current_user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can change account activation status")
    if "email" in data and data["email"] != user.email:
        if db.query(models.User).filter(models.User.email == data["email"]).first():
            raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")

    for field, value in data.items():
        setattr(user, field, value)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: str, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _assert_self_or_admin(user_id, current_user)
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")
    db.delete(user)
    db.commit()
    return None
