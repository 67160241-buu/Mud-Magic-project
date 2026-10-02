# Mud Magic — Full Stack

เว็บไซต์ Mud Magic กับ Project API ตอนนี้เชื่อมกันเป็น **ระบบเดียวจริงๆ**: สั่ง `docker compose up` ครั้งเดียว รัน Postgres + API + เว็บไซต์พร้อมกัน และเว็บไซต์คุยกับ API จริง — มีระบบสมัคร/ล็อกอินจริง และบันทึกแบบมัคที่ออกแบบไว้เป็นข้อมูลในฐานข้อมูลจริง ไม่ใช่แค่ `localStorage` อย่างเดียว

```
mudmagic-project/
├── docker-compose.yml   ← รันทุกอย่างพร้อมกัน
├── web/                  ← เว็บไซต์ Mud Magic (เสิร์ฟด้วย nginx)
└── api/                   ← Project API (FastAPI + Postgres)
```

## รันทุกอย่างพร้อมกัน

```bash
cp api/.env.example api/.env   # แก้ JWT_SECRET_KEY ก่อนใช้งานจริง
docker compose up --build
```

| Service | URL |
|---|---|
| เว็บไซต์ | http://localhost:8080 |
| API | http://localhost:8000 |
| API docs (Swagger) | http://localhost:8000/docs |
| Postgres | localhost:5432 |

แค่นี้จบ — 3 container (`db`, `api`, `web`) คำสั่งเดียว ทั้งสองฝั่งทำงานร่วมกัน

---

## หน้าเว็บทั้งหมด

| หน้า | คืออะไร |
|---|---|
| `index.html` | หน้าแรก — ผลงานตัวอย่างพร้อมระดับความยาก และผลงานจริงที่มีคนอัปโหลดผ่าน `create.html` |
| **`create.html`** | **AI Design Journey** — ทำตาม User Journey ทีละขั้นแบบเต็ม: กรอกไอเดีย → เลือกระดับฝีมือ (มีแบบทดสอบสั้นๆ ช่วยแนะนำระดับ) → ดูแบบที่ AI คัดมาให้ (กรองแล้วว่าปั้นได้จริงตามระดับ พร้อม Difficulty x/5 และ Feasibility %) → เปรียบเทียบสูงสุด 3 แบบ (มีป้าย Recommended) → ปรับแต่งใน 3D สด รวมโหมด **ปั้นอิสระ** (ใช้ตัว sculptor ตัวเดียวกับ Studio) พร้อมแถบเตือนความยากแบบ real-time → ยืนยันและดาวน์โหลดคู่มือเป็นไฟล์เดียว → ขั้นตอนลงมือปั้น (ออฟไลน์ ไม่มีการตอบสนองจากระบบ) → อัปโหลดรูปผลงานจริงพร้อมให้คะแนน |
| `studio.html` | Studio แบบอิสระ (free-form) — เลือกทรง/หูจับ/ผิว/สีเองโดยตรง ไม่ผ่านขั้นตอนแนะนำ พร้อม AI variation panel และปั้นอิสระ |
| `login.html` | เข้าสู่ระบบ/สมัครสมาชิกจริงผ่าน API |

`create.html` ครอบคลุม edge case ทุกข้อจาก User Journey doc:
- คำอธิบายกว้างเกินไป (เช่น "สวยๆ") → มีคำแนะนำให้เลือกแทนสุ่มแบบออกมา
- ปรับแต่งจนเกินระดับที่เลือกไว้ → แถบเตือนสีเหลืองแบบ real-time (ไม่บล็อก แค่แจ้ง)
- โหมดสตูดิโอ/โรงเรียน → กำหนดจำนวนคนได้ สร้างแบบแยกให้แต่ละคน วนขั้นตอนที่ 3-9 ต่อคน
- อินเทอร์เน็ตหลุด/ปิดแท็บกลางคัน → บันทึก draft ไว้ใน localStorage กลับมาทำต่อได้
- สร้างแบบซ้ำหลายรอบแล้วไม่ถูกใจ → หลัง regenerate ครบ 3 ครั้งโดยยังไม่เลือกอะไรเลย ระบบเสนอทางเลือกอื่น (แก้ไขไอเดีย หรือดูผลงานจริงแทน) แทนที่จะให้สุ่มไปเรื่อยๆ



เว็บไซต์ไม่มีเซิร์ฟเวอร์ของตัวเอง — เป็นไฟล์ static ที่ nginx เสิร์ฟ (service `web`) — แต่ JavaScript ของมันคุยกับ container ของ API ตรงๆ ผ่าน HTTP จากฝั่ง browser

### บัญชีจริงในหน้าล็อกอิน
`web/login.html` เรียก API จริง แทนที่จะปลอมดีเลย์เหมือนเดิม:
- ฟอร์มถามแค่อีเมล + รหัสผ่าน (ไม่มีขั้นตอนสมัครแยก) พอกด submit `web/js/api-client.js` จะสร้าง username จากอีเมลให้เอง เรียก `POST /register` ถ้าเจอ 409 เพราะมีบัญชีอยู่แล้ว ก็จะเรียก `POST /login` ต่อทันที — ฟอร์มเดียวใช้ได้ทั้งคนใหม่และคนที่กลับมาใช้ซ้ำ
- JWT access/refresh token (พร้อมข้อมูลจาก `/me`) ถูกเก็บไว้ใน `localStorage` ภายใต้ key `mudmagic_api_auth`
- ถ้าเรียก API ไม่ได้ ฟอร์มจะแสดง error ชัดเจนและเปิดให้กดใหม่ได้ทันที — ไม่ใช่ค้างเงียบๆ หรือพัง

### แบบมัคที่บันทึกในสตูดิโอ กลายเป็นข้อมูลจริงในฐานข้อมูล
ปุ่ม **Save** ใน `web/studio.html` (`js/studio.js`):
- บันทึกลง `localStorage` เสมอเป็นอันดับแรก (ใช้งานได้แม้ออฟไลน์หรือยังไม่ล็อกอิน)
- ถ้ามี session อยู่ จะเรียก `POST /projects` ที่ API ด้วย — ค่า config ปัจจุบัน (ทรง/หูจับ/พื้นผิว/สี) ถูกเก็บไว้ในฟิลด์ `description` ของแถว `Project` ที่ผูกกับบัญชีนั้น (Project API เป็น API ทั่วไปที่ไม่ได้ออกแบบมาสำหรับเซรามิกโดยเฉพาะ ตรงนี้จึงเป็นการ "ยืมใช้" อย่างตรงไปตรงมา: "แบบมัค 1 ชิ้นที่บันทึกไว้" = "Project 1 แถว" ของบัญชีนั้น ไม่ใช่โมเดล backend ที่สร้างมาเพื่อเซรามิกโดยเฉพาะ)
- ถ้าบันทึกเข้าบัญชีไม่สำเร็จ (เช่น API ล่ม) แต่บันทึกลงเครื่องสำเร็จ ระบบจะบอกตามจริง ไม่ใช่หลอกว่าสำเร็จหมด

### เมนูด้านบนรู้ว่าคุณล็อกอินอยู่ไหม
`js/main.js` เช็ค `window.MudMagicAPI.isLoggedIn()` ทุกครั้งที่โหลดหน้า ถ้าล็อกอินอยู่ ปุ่ม "Get Started" ในเมนูของหน้า Studio จะเปลี่ยนเป็น `Logout (ชื่อผู้ใช้)` — กดเพื่อล้าง session ฝั่งเครื่อง (ตัว JWT เองจะหมดอายุฝั่งเซิร์ฟเวอร์ตามเวลาที่กำหนดอยู่แล้ว ยังไม่มีการเรียก endpoint `/logout` ที่มีอยู่แล้วของ API จากปุ่มนี้จริงๆ — ดูหัวข้อ **ข้อจำกัดที่ยังมีอยู่** ด้านล่าง)

### CORS
ฝั่ง API ตั้งค่า `allow_origins=["*"]` ไว้อยู่แล้ว ดังนั้น browser เรียก `http://localhost:8000` จากหน้าที่เสิร์ฟบน `http://localhost:8080` ได้เลยโดยไม่ต้องตั้งค่าเพิ่ม

---

## ทดสอบจริงแบบ end-to-end แล้ว (ไม่ใช่แค่เขียนแล้วเดาว่าถูก)

การเชื่อมระบบนี้ถูกทดสอบกับ **stack ที่รันจริง** — Postgres จริง, API จริง, nginx จริง, browser จริง — ไม่ใช่ mock:

- ผู้ใช้ใหม่: สมัคร → ล็อกอิน → เด้งเข้า Studio → เมนูแสดงชื่อผู้ใช้ที่ล็อกอินถูกต้อง ✅
- ผู้ใช้เดิมกลับมาใช้: กรอกอีเมลเดิมรอบสอง → `register` ตอบ 409 ถูกต้อง → `login` ยังสำเร็จ → เข้าถึง Studio ได้เหมือนเดิม ✅
- ปรับแต่งแบบ (ทรง/หูจับ/สี) → กด Save → `POST /projects` ตอบ 201 พร้อม config JSON ที่ตรงเป๊ะใน `description` ✅
- เรียก `GET /projects` แยกต่างหากด้วย token ที่เก็บไว้ เพื่อยืนยันว่าข้อมูลถูกบันทึกจริงใน Postgres ไม่ใช่แค่ browser คิดว่าบันทึกสำเร็จ ✅
- ล็อกเอาท์ → session ถูกล้างออกจาก `localStorage` ✅
- ใช้ Studio แบบไม่ล็อกอิน → กด Save ยังทำงานผ่าน `localStorage` ได้ปกติ ไม่มี error ✅
- จงใจชี้ API ไปที่พอร์ตที่เรียกไม่ได้ → ฟอร์มล็อกอิน fail แบบสุภาพ ปุ่มกลับมากดได้ใหม่ ไม่มี error ค้าง ไม่พัง ✅

**`create.html` (AI Design Journey)** ก็ทดสอบผ่าน browser จริงแบบเต็มขั้นตอนเช่นกัน — กรอกไอเดีย → แบบทดสอบระดับฝีมือ → ผลลัพธ์ AI (thumbnail render จริง, กรองตามระดับถูกต้อง, มี Difficulty/Feasibility) → เปรียบเทียบ (ป้าย Recommended ทำงานถูก) → ปรับแต่ง 3D + ปั้นอิสระ (ลากจริงแล้ว mesh เปลี่ยนรูปจริง) → แถบเตือนความยากขึ้นสีเหลืองถูกจังหวะ → ดาวน์โหลดคู่มือ (ตรวจแล้วว่าตัวอักษรไทยไม่แตก/ไม่เพี้ยน) → ขั้นตอนปั้น → อัปโหลดรูป+ให้คะแนน → บันทึกเข้า `localStorage` และเข้า `POST /projects` ถ้าล็อกอินอยู่ ✅ รวมถึง edge case ทุกข้อ (คำอธิบายกว้างเกินไป, regenerate ซ้ำแล้วไม่เลือกอะไรเลย, ปิดแท็บกลางคันแล้วกลับมาทำต่อ, โหมดหลายคน) ทดสอบผ่านหมด และยืนยันว่าเผยแพร่ผลงานจาก `create.html` ไปโผล่ที่หน้าแรกจริง (`index.html` อ่านจาก localStorage เดียวกัน)

---

## ข้อจำกัดที่ยังมีอยู่ (บอกตรงๆ ไม่ปิดบัง)

- **ปุ่ม "Logout" ในเมนูยังไม่ได้เรียก endpoint `/logout` ของ API จริง** — แค่ล้าง token ออกจาก `localStorage` เท่านั้น ตัว JWT ยังใช้ได้อยู่ฝั่งเซิร์ฟเวอร์จนกว่าจะหมดอายุ (ค่าเริ่มต้น access 30 นาที / refresh 7 วัน) ถ้าจะใช้งานจริงควรทำให้ปุ่ม logout เรียก `POST /logout` พร้อม refresh token ที่เก็บไว้ก่อน
- **ฝั่งเว็บยังไม่หมุน refresh token ให้อัตโนมัติ** ฝั่ง API รองรับการหมุน refresh token อยู่แล้ว (`POST /refresh`) แต่เว็บไซต์ยังไม่เรียกใช้ — พอ access token หมดอายุใน 30 นาที การเรียก API (เช่นตอนกด Save) จะเริ่ม fail ด้วย 401 จนกว่าจะล็อกอินใหม่ ถ้าเป็นระบบจริงควรมีการ refresh เบื้องหลังแบบเงียบๆ
- **การใช้ "Project" แทน "แบบที่บันทึกไว้" เป็นการยืมโมเดลมาใช้ ไม่ใช่โมเดลที่ออกแบบมาเฉพาะ** ยังไม่มีตาราง "แบบมัค" แยกต่างหาก ไม่มีที่เก็บรูปตัวอย่าง (thumbnail) และยังไม่มีทางโหลดแบบที่เคยบันทึกไว้กลับเข้ามาแก้ในสตูดิโอจากบัญชี (มีฟังก์ชัน `listMyDesigns()` อยู่ใน `api-client.js` และใช้งานได้จริง แต่ยังไม่มีปุ่มไหนในหน้าเว็บเรียกใช้)
- **ปุ่มล็อกอินด้วย Google/Apple ในหน้า login ยังใช้งานไม่ได้เหมือนเดิม** — กดแล้วขึ้น toast บอกว่ายังไม่รองรับ เหมือนก่อนหน้านี้

ข้อจำกัดพวกนี้บอกไว้ตรงๆ ไม่ได้ซ่อน — ส่วนหลักของระบบ (สมัคร/ล็อกอิน/บันทึก/ตรวจสอบว่าบันทึกจริง) ทำงานจริงและทดสอบแล้ว ส่วนที่เหลือ (refresh token, logout ที่เรียก API จริง, โหลดแบบเก่ากลับมาแก้) คือขั้นต่อไปที่ทำต่อได้ถ้าอยากพัฒนาต่อ

---

## รันแยกแต่ละส่วนก็ได้

ไม่จำเป็นต้องรันพร้อมกันเสมอไป แต่ละฝั่งยังทำงานเดี่ยวๆ ได้:

**เว็บไซต์อย่างเดียว** (ไม่มีระบบบัญชี ปุ่ม Save จะบันทึกลง `localStorage` อย่างเดียว):
```bash
cd web
python3 -m http.server 8080
```
Browser บล็อกการ import ES module ผ่าน `file://` ดังนั้นต้องมี static server ตัวใดก็ได้รันอยู่ — เปิดไฟล์ `index.html` โดยดับเบิลคลิกตรงๆ ไม่ได้

**API อย่างเดียว:**
```bash
cd api
cp .env.example .env
docker compose up --build
```
ดูรายละเอียดทั้งหมด (endpoint, ระบบ auth/role, คำสั่ง Alembic migration, วิธีรัน pytest 45 เทสต์) ได้ที่ **[`api/README.md`](./api/README.md)**

---

## โครงสร้างไฟล์ทั้งหมด

```
mudmagic-project/
├── README.md                  ← ไฟล์นี้
├── docker-compose.yml          ← รัน db + api + web พร้อมกัน
│
├── web/
│   ├── index.html
│   ├── create.html               ← AI Design Journey (ตาม User Journey doc เต็มขั้นตอน)
│   ├── studio.html
│   ├── login.html
│   ├── css/style.css
│   └── js/
│       ├── api-client.js        ← เชื่อมเว็บไซต์เข้ากับ API จริง
│       ├── mug-model.js          (มี difficulty scoring/naming/step-guide helpers ให้ create.html ด้วย)
│       ├── journey.js            ← ตรรกะทั้งหมดของ create.html
│       ├── sculpt.js             ← ปั้นอิสระ (ใช้ร่วมกันทั้ง studio.html และ create.html)
│       ├── studio.js
│       ├── hero3d.js
│       └── main.js
│
└── api/
    ├── README.md               ← เอกสาร API แบบละเอียด
    ├── LICENSE                 ← MIT
    ├── docker-compose.yml       (ไว้รัน API เดี่ยวๆ)
    ├── Dockerfile
    ├── entrypoint.sh
    ├── requirements.txt / requirements-dev.txt
    ├── pytest.ini
    ├── .env.example
    ├── .gitignore / .dockerignore
    ├── .github/workflows/tests.yml
    ├── alembic.ini
    ├── alembic/
    │   ├── env.py
    │   └── versions/…_initial_schema.py
    ├── app/
    │   ├── main.py / config.py / database.py / deps.py
    │   ├── models.py / schemas.py / security.py
    │   └── routers/ (auth.py, users.py, projects.py, tasks.py)
    └── tests/
        ├── conftest.py
        └── test_auth.py / test_users.py / test_projects.py / test_tasks.py
```

## เอาขึ้น GitHub

```bash
git init
git add .
git commit -m "Mud Magic: integrated website + Project API"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

`api/.gitignore` กัน `api/.env`, `__pycache__`, และ `.pytest_cache` ไว้แล้ว `api/.github/workflows/tests.yml` จะรัน test suite ของ API กับ Postgres จริงทุกครั้งที่ push/PR เข้าไป หลังจากขึ้น GitHub แล้ว
