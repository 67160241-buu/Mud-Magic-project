from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from .. import deps, models, schemas, security

router = APIRouter(tags=["User Management"])


@router.get("/me", response_model=schemas.UserOut)
def read_me(current_user: models.User = Depends(deps.get_current_user)):
    """ดึงข้อมูลของตัวเอง (ผู้ใช้ที่ login อยู่)"""
    return current_user


@router.get("/users", response_model=schemas.UserListOut)
def list_users(
    page: int = Query(1, ge=1, description="เลขหน้า เริ่มที่ 1"),
    limit: int = Query(10, ge=1, le=100, description="จำนวนต่อหน้า สูงสุด 100"),
    db: Session = Depends(deps.get_db),
    current_user: models.User = Depends(deps.get_current_user),
):
    """ดึงข้อมูล user ทั้งหมด แบบแบ่งหน้า (pagination)"""
    query = db.query(models.User).order_by(models.User.id)
    total = query.count()
    items = query.offset((page - 1) * limit).limit(limit).all()
    return {"total": total, "page": page, "limit": limit, "items": items}


@router.get("/check-username/{username}", response_model=schemas.UsernameAvailable)
def check_username(username: str, db: Session = Depends(deps.get_db)):
    """ตรวจสอบว่า username นี้ว่างพอสมัครได้หรือไม่ (ไม่ต้อง login — ใช้ตอนกรอกฟอร์มสมัคร)"""
    taken = db.query(models.User).filter(models.User.username == username).first() is not None
    return {"username": username, "available": not taken}


@router.get("/users/{user_id}", response_model=schemas.UserOut)
def get_user(
    user_id: int,
    db: Session = Depends(deps.get_db),
    current_user: models.User = Depends(deps.get_current_user),
):
    """ดึงข้อมูล user รายคนตาม id"""
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้นี้")
    return user


@router.put("/users/{user_id}", response_model=schemas.UserOut)
def update_user(
    user_id: int,
    payload: schemas.UserUpdate,
    db: Session = Depends(deps.get_db),
    current_user: models.User = Depends(deps.get_current_user),
):
    """แก้ไขข้อมูล user — แก้ได้เฉพาะบัญชีตัวเอง หรือ admin แก้ของใครก็ได้"""
    if current_user.id != user_id and current_user.role != models.Role.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="แก้ไขได้เฉพาะข้อมูลของตัวเองเท่านั้น")

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้นี้")

    if payload.email is not None:
        clash = (
            db.query(models.User)
            .filter(models.User.email == payload.email, models.User.id != user_id)
            .first()
        )
        if clash:
            raise HTTPException(status_code=400, detail="email นี้ถูกใช้งานแล้ว")
        user.email = payload.email

    if payload.password is not None:
        user.hashed_password = security.hash_password(payload.password)

    db.commit()
    db.refresh(user)
    return user


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: int,
    db: Session = Depends(deps.get_db),
    current_user: models.User = Depends(deps.get_current_user),
):
    """ลบ user — ลบได้เฉพาะบัญชีตัวเอง หรือ admin ลบของใครก็ได้"""
    if current_user.id != user_id and current_user.role != models.Role.admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="ลบได้เฉพาะบัญชีของตัวเองเท่านั้น")

    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="ไม่พบผู้ใช้นี้")

    db.delete(user)
    db.commit()
    return None
