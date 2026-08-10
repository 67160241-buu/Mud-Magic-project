from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import deps, models, schemas, security

router = APIRouter(tags=["Authentication"])


@router.post("/register", response_model=schemas.UserOut, status_code=status.HTTP_201_CREATED)
def register(payload: schemas.UserCreate, db: Session = Depends(deps.get_db)):
    """สมัครสมาชิก"""
    if db.query(models.User).filter(models.User.username == payload.username).first():
        raise HTTPException(status_code=400, detail="username นี้ถูกใช้งานแล้ว")
    if db.query(models.User).filter(models.User.email == payload.email).first():
        raise HTTPException(status_code=400, detail="email นี้ถูกใช้งานแล้ว")

    user = models.User(
        username=payload.username,
        email=payload.email,
        hashed_password=security.hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=schemas.Token)
def login(payload: schemas.UserLogin, db: Session = Depends(deps.get_db)):
    """เข้าสู่ระบบ — คืน JWT access token"""
    user = db.query(models.User).filter(models.User.username == payload.username).first()
    if not user or not security.verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="username หรือ password ไม่ถูกต้อง")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="บัญชีนี้ถูกระงับการใช้งาน")

    token = security.create_access_token(subject=user.username)
    return {"access_token": token, "token_type": "bearer"}


@router.post("/logout", response_model=schemas.MessageOut)
def logout(
    payload: dict = Depends(deps.get_token_payload),
    db: Session = Depends(deps.get_db),
):
    """
    ออกจากระบบ — เพิ่ม jti ของ token ปัจจุบันเข้า deny-list
    ทำให้ token ตัวนี้ใช้ยิง endpoint ที่ต้อง auth ต่อไม่ได้อีก แม้จะยังไม่หมดอายุ
    """
    jti = payload.get("jti")
    if jti and not db.query(models.RevokedToken).filter(models.RevokedToken.jti == jti).first():
        db.add(models.RevokedToken(jti=jti))
        db.commit()
    return {"message": "ออกจากระบบสำเร็จ"}


@router.post("/change-password", response_model=schemas.MessageOut)
def change_password(
    payload: schemas.ChangePassword,
    current_user: models.User = Depends(deps.get_current_user),
    db: Session = Depends(deps.get_db),
):
    """เปลี่ยนรหัสผ่าน (ต้อง login ก่อน)"""
    if not security.verify_password(payload.old_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="รหัสผ่านเดิมไม่ถูกต้อง")

    current_user.hashed_password = security.hash_password(payload.new_password)
    db.commit()
    return {"message": "เปลี่ยนรหัสผ่านสำเร็จ"}
