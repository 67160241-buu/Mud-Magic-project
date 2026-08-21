# Project API

REST API สำหรับระบบ Project ของกลุ่มงาน (auth + user management + projects + tasks)
Stack: **FastAPI (Python) + PostgreSQL + SQLAlchemy + JWT (access/refresh)**, รันด้วย **Docker & Docker Compose**

![Tests](https://github.com/USERNAME/REPO/actions/workflows/tests.yml/badge.svg)

## Push ขึ้น GitHub

```bash
git init
git add .
git commit -m "Initial commit: project management REST API"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

แก้ `USERNAME/REPO` ทั้งใน badge ด้านบนและคำสั่ง `git remote add` ให้ตรงกับ repo จริง
`.gitignore` กัน `.env`, `__pycache__`, `.pytest_cache`, venv ไว้แล้ว —ไม่มี secret หลุดไปกับ commit แรก
`.github/workflows/tests.yml` รัน pytest suite ทั้งหมดกับ Postgres จริงทุกครั้งที่ push/PR เข้า `main`

## Run

```bash
cp .env.example .env      # แก้ JWT_SECRET_KEY ก่อนใช้จริง
docker compose up --build
```

- API: http://localhost:8000
- Swagger docs: http://localhost:8000/docs
- Postgres: localhost:5432 (user/pass ตาม `.env`)

Container จะรัน `alembic upgrade head` อัตโนมัติก่อน start server ทุกครั้ง (ดู `entrypoint.sh`) — ไม่ต้อง migrate มือ

## Migrations (Alembic)

```bash
# สร้าง migration ใหม่หลังแก้ app/models.py
docker compose exec api alembic revision --autogenerate -m "describe change"

# apply / rollback
docker compose exec api alembic upgrade head
docker compose exec api alembic downgrade -1
```

## Tests

Test suite ใช้ Postgres จริง (ไม่ mock DB) ต้องมี database แยกต่างหากชื่อ `project_db_test`:

```bash
# ครั้งแรกเท่านั้น — สร้าง test database
docker compose exec db psql -U project_user -c "CREATE DATABASE project_db_test;"

# รัน tests (ต้องมี db service รันอยู่)
pip install -r requirements-dev.txt
DATABASE_URL="postgresql+psycopg2://project_user:project_pass@localhost:5432/project_db_test" pytest -v
```

`tests/conftest.py` สร้าง/ล้าง schema เองทุก session และ truncate ทุก table หลังแต่ละ test — รันซ้ำได้เรื่อยๆ โดยไม่ชนกัน

## Endpoints

### 1. Authentication
- [x] POST `/register` - สมัครสมาชิก
- [x] POST `/login` - เข้าสู่ระบบ (คืน access + refresh token)
- [x] POST `/refresh` - ขอ access token ใหม่ด้วย refresh token (หมุน token ทุกครั้ง)
- [x] POST `/logout` - ออกจากระบบ (revoke refresh token)
- [x] POST `/change-password` - เปลี่ยนรหัสผ่าน (revoke refresh token เดิมทั้งหมด)

### 2. User Management
- [x] GET `/me` - ดึงข้อมูลตัวเอง
- [x] GET `/users/{id}` - ดึงข้อมูล user
- [x] GET `/users` - ดึงข้อมูล user ทั้งหมด (pagination + search)
- [x] PUT `/users/{id}` - แก้ไขข้อมูล user (เจ้าของ หรือ admin เท่านั้น)
- [x] DELETE `/users/{id}` - ลบ user (เจ้าของ หรือ admin เท่านั้น)
- [x] GET `/check-username/{name}` - ตรวจสอบ username ว่างไหม

### 3. Projects
- [x] POST `/projects` - สร้างโปรเจกต์ (ผู้สร้างเป็น owner อัตโนมัติ)
- [x] GET `/projects` - ดึงโปรเจกต์ที่ตัวเองเป็นสมาชิก (pagination)
- [x] GET `/projects/{id}` - ดึงข้อมูลโปรเจกต์ (ต้องเป็นสมาชิก)
- [x] PUT `/projects/{id}` - แก้ไขโปรเจกต์ (owner/admin เท่านั้น)
- [x] DELETE `/projects/{id}` - ลบโปรเจกต์ (owner/admin เท่านั้น)
- [x] GET `/projects/{id}/members` - ดูสมาชิกในโปรเจกต์
- [x] POST `/projects/{id}/members` - เพิ่มสมาชิก (owner/admin เท่านั้น)
- [x] PUT `/projects/{id}/members/{user_id}` - เปลี่ยน role สมาชิก
- [x] DELETE `/projects/{id}/members/{user_id}` - ลบสมาชิกออกจากโปรเจกต์

### 4. Tasks
- [x] POST `/projects/{id}/tasks` - สร้าง task ในโปรเจกต์
- [x] GET `/projects/{id}/tasks` - ดึง task ทั้งหมด (pagination, filter by status/assignee)
- [x] GET `/tasks/{id}` - ดึงข้อมูล task เดียว
- [x] PUT `/tasks/{id}` - แก้ไข task
- [x] PATCH `/tasks/{id}/status` - อัปเดตสถานะ task อย่างเดียว
- [x] DELETE `/tasks/{id}` - ลบ task

## Auth model

- JWT access token (สั้น, default 30 นาที) ส่งผ่าน `Authorization: Bearer <token>`
- JWT refresh token (ยาว, default 7 วัน) เก็บ hash ไว้ใน DB เพื่อ revoke ได้ (logout / เปลี่ยนรหัสผ่าน)
- Refresh token หมุนทุกครั้งที่ใช้ (rotate-on-use) — token เก่าใช้ซ้ำไม่ได้

## Roles

- **Site-level**: `is_admin` บน user เข้าถึงทุกอย่างข้ามโปรเจกต์ได้ (ใช้กับงาน admin/support)
- **Project-level**: `owner` / `admin` / `member` ต่อโปรเจกต์ — จัดการสมาชิก/แก้ไข/ลบโปรเจกต์ต้องเป็น owner หรือ admin ของโปรเจกต์นั้น

## Project structure

```
project-api/
├── .gitignore
├── .dockerignore
├── LICENSE
├── .github/workflows/tests.yml
├── docker-compose.yml
├── Dockerfile
├── entrypoint.sh       # alembic upgrade head, then start uvicorn
├── requirements.txt
├── requirements-dev.txt
├── pytest.ini
├── .env.example
├── alembic.ini
├── alembic/
│   ├── env.py           # wired to app.config.settings + app.models
│   └── versions/
│       └── ..._initial_schema.py
├── tests/
│   ├── conftest.py       # isolated test DB schema + TestClient fixture
│   ├── test_auth.py
│   ├── test_users.py
│   ├── test_projects.py
│   └── test_tasks.py
└── app/
    ├── main.py          # FastAPI app, CORS
    ├── config.py         # Settings จาก env
    ├── database.py        # SQLAlchemy engine/session
    ├── models.py          # User, Project, ProjectMember, Task, RefreshToken
    ├── schemas.py         # Pydantic request/response models
    ├── security.py        # password hashing + JWT
    ├── deps.py            # auth & authorization dependencies
    └── routers/
        ├── auth.py
        ├── users.py
        ├── projects.py
        └── tasks.py
```

## ทดสอบแล้ว

- **ทดสอบมือแบบ end-to-end** กับ Postgres จริง: สมัคร → ล็อกอิน → refresh (หมุน token + กันใช้ token เก่าซ้ำ) →
  CRUD project/task → เช็ค 403 ข้ามบัญชี → ล็อกเอาท์ → เปลี่ยนรหัสผ่าน
- **pytest อัตโนมัติ 45 เทสต์** (`tests/`) ผ่านหมดกับฐานข้อมูล Postgres ทดสอบจริง (ไม่ mock):
  ครอบคลุม auth flow, การหมุน token, ขอบเขต RBAC (owner/admin/member ของ project, self-vs-admin ของ user), pagination,
  การกรองข้อมูล และ lifecycle เต็มของ project → member → task
- **ตรวจ Alembic migration แบบ round-trip** (`upgrade head` → `downgrade base` → `upgrade head` ซ้ำหลายรอบ
  รวมถึงการล้าง Postgres ENUM type ซึ่ง autogenerate ไม่ได้จัดการให้อัตโนมัติ)

### บั๊กที่เจอและแก้ระหว่างทดสอบ (ไม่ใช่แค่เขียนแล้วเดาว่าถูก)
1. `passlib` กับ `bcrypt>=4.1` โยน `ValueError` ตอน hash รหัสผ่าน — ล็อกเวอร์ชันไว้ที่ `bcrypt==4.0.1`
2. JWT ที่ออกในวินาทีเดียวกันมีค่าเหมือนกันเป๊ะ (ไม่มี claim ที่ unique) ทำให้ `/refresh` พังตอน insert ซ้ำ (duplicate key) —
   แก้โดยเพิ่ม claim `jti` แบบสุ่มในทุก token
3. ฟังก์ชัน `downgrade()` ที่ Alembic สร้างอัตโนมัติลบตารางแต่ไม่ลบ Postgres ENUM type ที่ตารางนั้นใช้ ทำให้
   `upgrade head` รอบสองหลัง `downgrade` พังด้วย error "type already exists" — เพิ่มคำสั่ง
   `sa.Enum(...).drop(bind, checkfirst=True)` เข้าไปใน `downgrade()` ของ migration ให้ชัดเจน
