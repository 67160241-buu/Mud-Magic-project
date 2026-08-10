# ปั้นดิน 3D Studio

เว็บปั้นเซรามิกแบบ 3D จริง — ลากที่ผนังชิ้นงานเพื่อดัน/บีบเนื้อดิน ไม่ใช่แค่เลือกจาก preset

## วิธีรัน

เปิด `index.html` ด้วยเบราว์เซอร์ได้ตรงๆ หรือใช้ static server เบาๆ:

```bash
python3 -m http.server 5500
# แล้วเปิด http://localhost:5500
```

## ระบบ login (เชื่อมกับ `project-api`)

หน้าเว็บนี้มีช่อง **เข้าสู่ระบบ / สมัครสมาชิก** ที่เรียก REST API จากโปรเจกต์ `project-api`
(Auth + User Management, FastAPI + PostgreSQL + Docker Compose) โดยตรงจากฝั่ง browser

ต้องรัน `project-api` ให้ขึ้นก่อน ถึงจะ login ได้จริง:

```bash
cd ../project-api      # หรือ path ที่แตก zip ของ project-api ไว้
cp .env.example .env
docker compose up -d --build
```

ค่าเริ่มต้นในหน้าเว็บตั้งไว้เป็น `http://localhost:8000` (พอร์ตเดียวกับที่ `project-api` เปิดให้) — ถ้ารัน API
ที่ address อื่น แก้ช่อง **API URL** ใต้ปุ่ม login ได้เลย

### ทำงานอย่างไร

- ปุ่ม "สมัครสมาชิก" → ยิง `POST /register` แล้ว login ให้อัตโนมัติ
- ปุ่ม "เข้าสู่ระบบ" → ยิง `POST /login` ได้ JWT กลับมา แล้วยิง `GET /me` เพื่อดึงชื่อผู้ใช้มาแสดง
- ปุ่ม "ออกจากระบบ" → ยิง `POST /logout` (เพิกถอน token จริงฝั่ง API) แล้วล้าง token ฝั่ง client
- token เก็บไว้ใน **ตัวแปร JavaScript ในหน่วยความจำเท่านั้น** (ไม่ใช้ localStorage/sessionStorage) — รีเฟรชหน้าเว็บแล้ว
  ต้อง login ใหม่ทุกครั้ง เป็นข้อจำกัดที่ตั้งใจไว้สำหรับต้นแบบนี้

### ยังไม่ทำ (ขอบเขตปัจจุบัน)

ตอนนี้ login มีไว้แสดงว่าเว็บเชื่อมกับ API ได้จริง แต่ **ยังไม่ได้ผูก "บันทึกชิ้นงานที่ปั้น" เข้ากับบัญชีผู้ใช้**
เพราะ `project-api` ปัจจุบันมีแค่ endpoint กลุ่ม Authentication/User Management (ตามขอบเขตงานที่ได้รับมอบหมาย)
ยังไม่มี endpoint สำหรับเก็บข้อมูลชิ้นงานเซรามิก (เช่น `POST /pieces`) — ถ้าต้องการฟีเจอร์นี้ต้องเพิ่ม resource
ใหม่ในฝั่ง API ก่อน
