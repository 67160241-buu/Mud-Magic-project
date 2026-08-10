# Project REST API — Authentication & User Management

REST API สำหรับระบบ Project ของกลุ่ม ครอบคลุมโมดูล **Authentication** (สมัคร/ล็อกอิน/ล็อกเอาต์/เปลี่ยนรหัสผ่าน)
และ **User Management** (ดู/แก้ไข/ลบ/แบ่งหน้า/เช็ก username) เขียนด้วย **FastAPI** เก็บข้อมูลจริงใน **PostgreSQL**
ยืนยันตัวตนด้วย **JWT** และรันเป็น container ทั้งหมดผ่าน **Docker & Docker Compose**

## Endpoint ทั้งหมด

### 1. Authentication
| Method | Path | คำอธิบาย | ต้อง login? |
|---|---|---|---|
| POST | `/register` | สมัครสมาชิก | ❌ |
| POST | `/login` | เข้าสู่ระบบ (คืน JWT access token) | ❌ |
| POST | `/logout` | ออกจากระบบ (ยกเลิก token ปัจจุบันจริง ผ่าน deny-list) | ✅ |
| POST | `/change-password` | เปลี่ยนรหัสผ่าน | ✅ |

### 2. User Management
| Method | Path | คำอธิบาย | ต้อง login? |
|---|---|---|---|
| GET | `/me` | ดึงข้อมูลตัวเอง | ✅ |
| GET | `/users/{id}` | ดึงข้อมูล user รายคน | ✅ |
| GET | `/users?page=&limit=` | ดึงข้อมูล user ทั้งหมด (pagination) | ✅ |
| PUT | `/users/{id}` | แก้ไขข้อมูล user (ตัวเอง หรือ admin แก้ของใครก็ได้) | ✅ |
| DELETE | `/users/{id}` | ลบ user (ตัวเอง หรือ admin ลบของใครก็ได้) | ✅ |
| GET | `/check-username/{name}` | ตรวจสอบว่า username ว่างไหม | ❌ |

ทดสอบทุก endpoint แบบ interactive ได้ที่ `/docs` (Swagger UI) หลังรันขึ้นแล้ว

## โครงสร้างโปรเจกต์

```
project-api/
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── .env.example            คัดลอกเป็น .env ก่อนรัน
├── .gitignore
├── README.md
└── app/
    ├── main.py              สร้างแอป FastAPI + รวม router
    ├── config.py             อ่านค่า config จาก environment variable
    ├── database.py           ตั้งค่า SQLAlchemy engine/session
    ├── models.py              ตาราง User, RevokedToken
    ├── schemas.py             Pydantic schema สำหรับ request/response
    ├── security.py            hash รหัสผ่าน (bcrypt) + สร้าง/ตรวจ JWT
    ├── deps.py                dependency กลาง: get_db, get_current_user, require_admin
    └── routers/
        ├── auth.py            /register /login /logout /change-password
        └── users.py           /me /users /users/{id} /check-username/{name}
```

## วิธีรัน (Docker Compose)

```bash
cp .env.example .env
# แก้ SECRET_KEY ใน .env ก่อน (สุ่มค่าใหม่ด้วย: python3 -c "import secrets; print(secrets.token_hex(32))")

docker compose up -d --build
```

จากนั้นเปิด:
- **http://localhost:8000/docs** — Swagger UI ทดสอบ API
- **http://localhost:8080** — Adminer (ดูข้อมูลใน PostgreSQL ผ่านหน้าเว็บ; System: PostgreSQL, Server: `db`, Username/Password/Database ตามที่ตั้งใน `.env`)

ปิดระบบทั้งหมด:
```bash
docker compose down          # ปิด container, เก็บข้อมูลไว้ (volume ยังอยู่)
docker compose down -v       # ปิดและลบข้อมูลใน DB ทิ้งด้วย
```

## สถาปัตยกรรม container (Docker Compose)

```
                 ┌────────────────────────┐
   ┌───────────► │  api   (FastAPI)        │  :8000
   │             │  build จาก Dockerfile   │
   │             └───────────┬─────────────┘
Browser                       │ DATABASE_URL=postgresql://...@db:5432/...
   │             ┌───────────▼─────────────┐
   └───────────► │  db    (postgres:16)    │  :5432
                 │  healthcheck: pg_isready │
                 └───────────┬─────────────┘
                              │
                 ┌───────────▼─────────────┐
                 │  adminer (DB browser)    │  :8080
                 └──────────────────────────┘
```

- `api` เรียก `db` ด้วยชื่อ service ตรงๆ (`db:5432`) — Compose สร้าง network ภายในให้ resolve ชื่อเป็น IP อัตโนมัติ
  (concept เดียวกับตัวอย่าง `web` เรียก `redis` ในเอกสารประกอบการสอน)
- `api` มี `depends_on: db: condition: service_healthy` — จะไม่ start จนกว่า Postgres จะพร้อมรับการเชื่อมต่อจริง
  (ใช้ `pg_isready` เป็น healthcheck) ป้องกันปัญหา "api start ก่อน db พร้อม แล้ว connect ไม่ติด" ตอน `docker compose up`
- ข้อมูลใน Postgres เก็บอยู่ใน named volume `db_data` — ลบ/สร้าง container `db` ใหม่ ข้อมูลไม่หาย (ยกเว้นสั่ง `down -v`)

## หมายเหตุด้านความปลอดภัย/สถาปัตยกรรม

- เปิด **CORS** ไว้แบบกว้าง (`allow_origins=["*"]`) เพื่อให้เว็บ frontend (เช่น `pottery-3d-studio`) เรียก API นี้
  จากคนละ origin ได้ตอน dev — ถ้าจะ deploy จริงควรจำกัดให้เหลือเฉพาะโดเมนของเว็บจริงใน `app/main.py`
- รหัสผ่านไม่เก็บเป็น plain text — hash ด้วย `bcrypt` ก่อนเก็บลง DB เสมอ
- `/logout` ทำงานได้จริงแม้ JWT ปกติจะ stateless: ระบบเก็บ `jti` (token id) ของ token ที่ logout ไปแล้วไว้ในตาราง
  `revoked_tokens` (deny-list) ทุก request ที่ต้อง auth จะเช็กตารางนี้ก่อนเสมอ
- สิทธิ์การแก้ไข/ลบ user: ผู้ใช้ทั่วไปทำได้เฉพาะบัญชีตัวเอง ส่วน role `admin` ทำกับบัญชีใครก็ได้ (ตั้งค่า role ตรงๆ ใน DB
  ผ่าน Adminer สำหรับผู้ดูแลคนแรก เพราะ API นี้ยังไม่มี endpoint แต่งตั้ง admin โดยเฉพาะ)
- ตารางถูกสร้างอัตโนมัติตอนแอป start (`Base.metadata.create_all`) พอสำหรับ scope งานนี้ — ถ้าจะทำต่อระดับ production
  ควรเปลี่ยนไปใช้ Alembic migration เพื่อคุมการเปลี่ยน schema แบบมีเวอร์ชัน

## รันนอก Docker (สำหรับ dev/debug เร็วๆ)

```bash
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

export DATABASE_URL="sqlite:///./dev.db"   # ใช้ SQLite แทน Postgres เร็วๆ ตอน dev เดี่ยว
export SECRET_KEY="dev-secret"

uvicorn app.main:app --reload
```

> โค้ดทดสอบผ่านแล้วด้วยวิธีนี้ (สมัคร → login → เรียก endpoint ที่ต้อง auth → เปลี่ยนรหัสผ่าน → logout → เช็กว่า token
> เดิมใช้ไม่ได้อีก → login ใหม่ด้วยรหัสผ่านใหม่ → ลบบัญชีตัวเอง) ครบทุก endpoint ในรายการด้านบน
