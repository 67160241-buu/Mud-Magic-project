from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .database import Base, engine
from .routers import auth, users

# สร้างตารางอัตโนมัติตอนแอป start (พอสำหรับงานนี้ — โปรเจกต์จริงระดับ production
# ควรใช้เครื่องมือ migration เช่น Alembic แทน เพื่อคุมการเปลี่ยน schema แบบมีเวอร์ชัน)
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Project REST API",
    description="Authentication + User Management API — ใช้ FastAPI, PostgreSQL, JWT, containerize ด้วย Docker & Docker Compose",
    version="1.0.0",
)

# เปิด CORS ให้เว็บฝั่ง frontend (เช่น pottery-3d-studio ที่รันคนละ origin) เรียก API นี้ได้
# ตอน dev เปิดกว้างไว้ก่อนเพื่อความสะดวก — ถ้าจะ deploy จริงควรจำกัด allow_origins ให้เหลือเฉพาะโดเมนเว็บจริง
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)


@app.get("/", tags=["Root"])
def root():
    return {"message": "Project API is running", "docs": "/docs"}


@app.get("/health", tags=["Root"])
def health():
    return {"status": "ok"}
