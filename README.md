# 67160241 น.ส.อรปรียา คล้ายสุวรรณ
# 67160368 น.ส.วชิราภรณ์ แย้มวิเศษ

# ตอนนี้ที่ทำได้ทั้งหมด 85%

## Microservices architecture
<img width="1536" height="1024" alt="Mud Magic Microservices Architecture" src="https://github.com/user-attachments/assets/e11bac3b-021d-46d5-9bac-4b15ff338908" />

## Technology stack diagram
<img width="1671" height="941" alt="Mud Magic Technology Stack Infographic" src="https://github.com/user-attachments/assets/2e77b682-c4d8-41f7-b24b-3704ae9f75bb" />


# Mud Magic

เว็บไซต์ตัวช่วยออกแบบงานเซรามิกด้วย 3D และ AI สำหรับทุกชนิดภาชนะ (แจกัน ชาม เหยือก จาน แก้วมัค ประติมากรรม) ออกแบบในเบราว์เซอร์ ดูระดับความยากว่าปั้นได้จริงไหม แล้วได้คู่มือการปั้นทีละขั้น

เว็บนี้เป็นเครื่องมือออกแบบและ 3D editor เท่านั้น ไม่มีบริการผลิตหรือจัดส่งชิ้นงาน

## ภาพรวมระบบ (Cloudflare)

ทั้งเว็บรันเป็น Cloudflare Worker ตัวเดียวชื่อ `mud-magic` (ตั้งค่าใน `wrangler.jsonc`)

| ส่วน | ทำอะไร |
|---|---|
| `web/` | หน้าเว็บ static (Tailwind, three.js 0.160) เสิร์ฟผ่าน Workers Static Assets |
| `src/auth.js` | `/api/auth/*` สมัคร/ล็อกอินด้วยอีเมล+รหัสผ่าน (PBKDF2) และ Google (OAuth) เซสชันเป็นคุกกี้ `mm_session` (HttpOnly) |
| `src/index.js` | `/api/designs` บันทึก/ดู/ลบแบบของผู้ใช้ที่ล็อกอิน แล้วส่งที่เหลือไปยังไฟล์ใน `web/` |
| `src/ai.js` | `/ai/*` เรียก OpenAI ฝั่งเซิร์ฟเวอร์ (key เป็น secret ไม่ถึงเบราว์เซอร์) |
| D1 `mud-magic-db` | ฐานข้อมูล SQLite ตาราง `users` `sessions` `designs` (สคีมาใน `migrations/`) |

## วิธีรันในเครื่อง (ต้องใช้ Node 22 ขึ้นไป)

```bash
npm install
cp .dev.vars.example .dev.vars        # ใส่ OPENAI_API_KEY / GOOGLE_CLIENT_SECRET เอง (ห้าม commit)
npx wrangler d1 migrations apply mud-magic-db --local
npx wrangler dev                      # http://localhost:8787
```

แก้ไฟล์ใน `web/` หรือ `src/` แล้ว wrangler โหลดใหม่ให้เอง ข้อมูลในเครื่องอยู่ใน `.wrangler/` (ไม่ขึ้น git)

## ขึ้น Cloudflare ครั้งแรก

```bash
npx wrangler login
npx wrangler d1 create mud-magic-db          # คัดลอก database_id ไปใส่ใน wrangler.jsonc
npx wrangler d1 migrations apply mud-magic-db --remote
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

**Google sign-in:** สร้าง OAuth client (ประเภท Web application) ใน Google Cloud Console → APIs & Services → Credentials ใส่ Client ID ใน `vars.GOOGLE_CLIENT_ID` ของ `wrangler.jsonc` และเพิ่ม Authorized redirect URI เป็น `https://<โดเมนของเว็บ>/api/auth/google/callback` (และ `http://localhost:8787/api/auth/google/callback` สำหรับทดสอบในเครื่อง)

**ย้ายข้อมูลจาก Firebase:** ใช้ `scripts/firebase-to-d1.mjs` (วิธีใช้อยู่หัวไฟล์) ได้ไฟล์ `seed.sql` แล้วรัน `npx wrangler d1 execute mud-magic-db --remote --file seed.sql` รหัสผ่านเดิมของ Firebase ย้ายมาไม่ได้ ผู้ใช้ที่เคยสมัครด้วยอีเมลต้องเข้าด้วย Google (อีเมลเดียวกัน) ส่วนผู้ใช้ Google เข้าได้ตามปกติ

**ระบบเดิม:** `docker-compose.yml`, `api/` (FastAPI), `firebase.json`, `firestore.rules` ยังเก็บไว้จนกว่าเว็บใหม่จะใช้งานได้ครบ แล้วค่อยลบ ข้อมูลใน Firestore ไม่ได้ถูกลบ

## การตั้งค่า AI (OpenAI)

ใส่ `OPENAI_API_KEY` ใน `.dev.vars` (ในเครื่อง) หรือ `npx wrangler secret put OPENAI_API_KEY` (บน Cloudflare) ส่วนชื่อโมเดลอยู่ที่ `vars.OPENAI_MODEL` ใน `wrangler.jsonc` (ค่าเริ่มต้น `gpt-4o-mini`)
ถ้าไม่ใส่ key เว็บยังใช้งานได้ โดยใช้โหมดออฟไลน์ที่อ่านคำสำคัญจากไอเดียในเบราว์เซอร์ และหน้าจอจะบอกตามจริงว่าเป็นโหมดออฟไลน์

| Endpoint | ใช้ที่ไหน |
|---|---|
| `GET /ai/status` | หน้าเว็บเช็กว่า AI พร้อมไหม |
| `POST /ai/suggest-vessels` | สร้างแบบทั้งชิ้นจากไอเดีย (ทรง โปรไฟล์ รูปทรงหน้าตัด สี ลวดลาย) ใช้ในปุ่ม "ให้ AI ออกแบบ" ของ Create และปุ่มสร้างแบบใน Studio |
| `POST /ai/edit-design` | แถบสั่ง AI ใน Studio เช่น "ทำคอให้สูงขึ้น เปลี่ยนเป็นสีฟ้า" |
| `POST /ai/idea` | ช่วยคิดหรือขัดเกลาไอเดียในขั้นแรกของ Create |
| `POST /ai/suggest-designs` | แบบแก้วมัครุ่นเก่า (ai-design.js) |

AI เสนอได้แค่ค่า ฝั่งเซิร์ฟเวอร์จะกรองฟิลด์ที่อนุญาตและบีบค่าให้อยู่ในช่วงที่ปั้นได้ทุกครั้ง แล้วเบราว์เซอร์ตรวจซ้ำอีกรอบ (`normalizeConfig`) ถ้าเรียก OpenAI ไม่สำเร็จ เหตุผลจะอยู่ใน log ของ Worker (`npx wrangler tail` หรือหน้า Observability ใน Cloudflare, บรรทัด `OpenAI call failed`)

---

## หน้าเว็บ

| หน้า | คืออะไร |
|---|---|
| `index.html` | หน้าแรก แนะนำเว็บในฐานะตัวช่วยออกแบบ มีโมเดล 3D หมุนได้ที่สุ่มแบบใหม่ทุกครั้ง (ชนิดภาชนะ ขนาด เคลือบ ดิน ลวดลาย และรูปทรงพิเศษ) และปุ่มเข้า Studio for Pro |
| `create.html` | **Create with AI** 4 ขั้น: ไอเดีย + ระดับฝีมือ → เลือกแบบ (เปรียบเทียบได้ 3 แบบ และ "คล้ายกัน") → ปรับแต่งใน Studio ที่ฝังอยู่ในหน้า → เสร็จสิ้น (ประมาณดินที่ใช้ เช็กลิสต์ขั้นตอน บันทึกเข้าบัญชี แชร์ลิงก์ พิมพ์ และส่งรูปผลงาน) บันทึก draft อัตโนมัติ กลับมาทำต่อได้ |
| `studio.html` | **Studio for Pro** 3D editor เต็มรูปแบบสำหรับคนที่อยากปั้นใน 3D เอง ปรับทุกค่าได้ละเอียด 6 ชนิดภาชนะ พร้อมแถบสั่ง AI |
| `dashboard.html` | แบบที่บันทึกไว้ (ภาพ 3D ย่อ ระดับความยาก) โปรไฟล์ และทางลัดไปสร้างแบบใหม่ |
| `login.html` | เข้าสู่ระบบ / สมัครสมาชิก ด้วยอีเมลหรือ Google (รองรับ `?next=หน้า.html`) |

ทุกหน้าใช้ฟอนต์ Prompt เหมือนกัน เมนูด้านบนเป็นภาษาอังกฤษ เนื้อหาเป็นภาษาไทย

## Studio for Pro

- **เริ่มจากก้อนดิน** เปิดหน้า Studio ตรงๆ จะได้ก้อนดินดิบเหมือนก่อนปั้นจริง แล้วเลือกชนิดภาชนะ เลือกจุดเริ่มต้นดิบ 4 แบบ (แจกัน ชาม จาน แก้วมัค) หรือปั้นอิสระจากก้อนเลย ถ้าอยากกลับไปงานล่าสุดกดปุ่ม "เปิดงานล่าสุดที่บันทึกไว้" (เมื่อเปิดจากลิงก์แชร์ `?d=` หรือฝังในหน้า Create จะโหลดแบบนั้นแทนก้อนดิน)
- **เอนจินสร้างทรง** (`pot-mesh.js`) ดัดแปลงจาก `CalcPotMesh` ของ PotterDraw: วงแหวนซ้อนกันตามเส้นโค้งโปรไฟล์ เติมลวดลาย ripple/scallop/ruffle หน้าตัดหลายเหลี่ยม บิด ยืด โยก เกลียว และผนังด้านในตามความหนาจริง
- **รูปทรงหน้าตัด (มองจากด้านบน):** กลม หัวใจ ดาว ดอกไม้ ก้อนเมฆ ใบโคลเวอร์ หยดน้ำ ใบไม้ เหลี่ยมมน ใช้ได้กับทุกภาชนะ จานและชามตื้นที่มีรูปทรงนับเป็นงานขึ้นรูปแผ่นดิน (Slab) ซึ่งมือใหม่ทำได้
- **ประติมากรรม:** ทรงเริ่มต้นเป็นทรงแบนบิดตัว S และมีรูปแบบสำเร็จรูป 5 แบบ: คลื่นบิด หินซ้อน เอนพลิ้ว เหลี่ยมเกลียว ดอกตูม
- **ตัวแก้เส้นโค้งโปรไฟล์** ลากจุด คลิกเพื่อเพิ่ม ดับเบิลคลิก/คลิกขวาเพื่อลบ
- **การ์ดความเป็นไปได้** ระดับความยาก 1–5 โอกาสปั้นได้ (%) และวิธีขึ้นรูป เทียบกับระดับฝีมือ (เป็นสูตรประเมิน ไม่ใช่การจำลองฟิสิกส์ของดิน)
- **แถบสั่ง AI** พิมพ์คำสั่งเป็นภาษาไทยหรืออังกฤษ ทุกการแก้กด Ctrl+Z ย้อนได้
- **ปั้นอิสระ** 3 โหมด: ดันออก กดเข้า และเกลี่ยเรียบ (ลูบผิวให้เนียน) แปรงขยับผิวทั้งบริเวณไปทางเดียวกันแล้วเกลี่ยให้กลืนกับผิวรอบๆ จึงไม่เกิดหนามหรือเหลี่ยมคม ใช้ได้ทั้งใน Studio และหน้า Create
- ย้อนกลับ/ทำซ้ำ บันทึกอัตโนมัติ แชร์ลิงก์ (`?d=...`) ส่งออกคู่มือ (.md) และโมเดล (.obj หน่วยเซนติเมตร)

**ข้อจำกัด**
- ปรับค่าในแผงซ้ายแล้วเมชถูกสร้างใหม่ งานที่ปั้นอิสระไว้จะหายไป
- หูจับเป็นท่อโค้งตามผนัง ยังปั้นอิสระไม่ได้
- กดแปรงซ้ำจุดเดิมลึกมากๆ ยังเป็นหลุมชันได้ ให้ใช้โหมดเกลี่ยเรียบลูบตาม
- คะแนนความยากเป็นการประมาณ ใช้ประกอบการตัดสินใจ ไม่ใช่คำรับประกัน

**เครดิตและสัญญาอนุญาต:** เอนจินสร้างทรงดัดแปลงจาก PotterDraw (GPL-2.0-or-later) ของ Chris Korda ดู [`LICENSE-POTTERDRAW.md`](./LICENSE-POTTERDRAW.md)

---

## โครงสร้างไฟล์

```
Mud-Magic-project/
├── wrangler.jsonc  package.json   ← Cloudflare Worker "mud-magic"
├── src/                      ← index.js (router + /api/designs)  auth.js  ai.js  crypto.js
├── migrations/0001_init.sql  ← สคีมา D1
├── scripts/firebase-to-d1.mjs ← ย้ายผู้ใช้/แบบจาก Firebase เป็น seed.sql
├── docker-compose.yml  nginx/  firebase.json  firestore.rules   ← ระบบเดิม รอลบ
├── web/
│   ├── index.html  create.html  studio.html  dashboard.html  login.html
│   ├── css/style.css
│   ├── img/                  ← โลโก้ (logo-mark, logo-horizontal, logo-stacked) และ favicon/icon
│   └── js/
│       ├── api-client.js        ← window.MudMagicAPI (เรียก /api/auth และ /api/designs)
│       ├── api-client.postgres.js (ตัวเชื่อม Postgres เดิม เก็บไว้อ้างอิง)
│       ├── main.js              ← เมนู สถานะล็อกอิน toast
│       ├── hero3d.js            ← โมเดล 3D หน้าแรก (สุ่มแบบ)
│       ├── vessels.js           ← ข้อมูลภาชนะ รูปทรงหน้าตัด รูปแบบประติมากรรม ประเมินความยาก คู่มือ
│       ├── pot-mesh.js          ← เอนจินสร้างทรง (ไม่ผูกกับ three.js)
│       ├── pot-engine.js        ← แปลงเมชเป็น three.js วัสดุ หูจับ ส่งออก .obj
│       ├── profile-editor.js    ← ตัวแก้เส้นโค้งโปรไฟล์
│       ├── studio.js            ← หน้า Studio for Pro (เริ่มจากก้อนดิน) + แถบสั่ง AI
│       ├── sculpt.js            ← แปรงปั้นอิสระ (ดัน ดึง เกลี่ยเรียบ)
│       ├── vessel-ai.js         ← ไอเดีย → แบบ (OpenAI หรือออฟไลน์)
│       ├── ai-design.js         ← เช็กสถานะ AI
│       ├── journey.js           ← หน้า Create
│       ├── skill-fit.js         ← ลดความยากให้พอดีระดับฝีมือ
│       ├── dashboard.js  wave.js  mug-model.js
└── api/                      ← FastAPI เดิม (ย้ายไป src/ แล้ว รอลบ)
    ├── Dockerfile  entrypoint.sh  requirements.txt  .env.example
    ├── alembic/  scripts/migrate_to_firebase.py   ← ของระบบ Postgres เดิม ไม่ได้ใช้แล้ว
    ├── app/
    │   ├── main.py  config.py  …
    │   └── routers/ai.py        ← /ai/* (OpenAI)
    │       (auth.py users.py projects.py tasks.py = ระบบบัญชีเดิมบน Postgres ไม่ได้เปิดใช้แล้ว)
    └── tests/
```

รายละเอียด API เดิมบน Postgres (ไม่ได้ใช้แล้ว เก็บไว้อ้างอิง) ดูที่ [`api/README.md`](./api/README.md)

## ความลับที่ห้ามขึ้น GitHub

`.gitignore` กันไว้แล้ว: `.dev.vars` และ `api/.env` (OpenAI key / Google secret), `.wrangler/`, `node_modules/`, `seed.sql`, `firebase-service-account*.json`, `*.pem`, `*.key` และโฟลเดอร์สำรอง `.backup-*/` ก่อน commit ให้ดู `git status` ทุกครั้งว่าไม่มีไฟล์เหล่านี้ในรายการ

```bash
git add -A
git status
git commit -m "..."
git push origin main
```
