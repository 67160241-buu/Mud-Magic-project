# หมายเหตุลิขสิทธิ์ — โค้ดที่ดัดแปลงจาก PotterDraw

ไฟล์ต่อไปนี้ไม่ใช่โค้ดที่เขียนขึ้นใหม่ทั้งหมด — เป็นการ **port คณิตศาสตร์และอัลกอริทึมจาก PotterDraw**:

- `web/js/wave.js` — waveform / motif / power / การปรับรัศมีแบบ scallop, ripple, ruffle
- `web/js/pot-mesh.js` — การสร้างเมชภาชนะแบบวงแหวน (ดัดแปลงจาก `CalcPotMesh`): การสุ่มตัวอย่างเส้นโค้งโปรไฟล์, ผนังด้านใน (รัศมีนอก − ความหนา ÷ cos(atan(ความชัน))), หน้าตัดหลายเหลี่ยมพร้อมความมน/ความป่อง, bend, helix, twist, aspect และตรรกะลายสี (stripes / rings / petals)
- `web/js/vessels.js` และ `web/js/profile-editor.js` — ใช้คำศัพท์การออกแบบและแนวคิดแถบเส้นโค้งโปรไฟล์ของ PotterDraw (ข้อมูลภาชนะ ตัวประเมินความยาก และตัวสร้างคู่มือเป็นงานเขียนใหม่ของโปรเจกต์นี้)

- โปรแกรมต้นทาง: PotterDraw โดย Chris Korda
- เว็บไซต์: http://potterdraw.sourceforge.net/
- สัญญาอนุญาต: **GNU General Public License v2.0 or later (GPL-2.0-or-later)**
- ส่วนที่นำมา: ฟังก์ชัน `CPotGraphics::GetWave`, `ApplyMotif`, `ApplyPower`
  และตรรกะของ `CalcPotMesh` (การปรับรัศมีแบบ scallop / ripple / ruffle, หน้าตัดหลายเหลี่ยม, bend, helix, twist, aspect, ผนังด้านใน, ลายสี)
  (ไฟล์ `PotterDraw/PotGraphics.cpp`)

## สิ่งที่นำมาและไม่ได้นำมา

นำมา: สูตรคณิตศาสตร์และขั้นตอนการสร้างเมช (waveform, motif, power, ring/profile, ผนังด้านใน, polygon, bend, helix ฯลฯ) แปลงจาก C++ เป็น JavaScript ด้วยมือ

ไม่ได้นำมา: ไม่มีไฟล์ไบนารี ไม่มีโค้ด DirectX ไม่มีโค้ด MFC/UI
ไม่มีไฟล์ source ของ PotterDraw อยู่ใน repo นี้

## ผลทางกฎหมายที่ต้องรู้ (สำคัญ)

GPL-2.0 เป็นสัญญาอนุญาตแบบ copyleft ผลคือ:

1. **`wave.js`, `pot-mesh.js` และงานที่รวมมันเข้าไป (รวมถึง Studio ใหม่) ต้องเผยแพร่ภายใต้ GPL-2.0-or-later ด้วย**
   จะเอาไปอยู่ใต้ MIT อย่างเดียวไม่ได้
2. ปัจจุบัน `api/LICENSE` ของโปรเจกต์นี้เป็น **MIT** ซึ่ง**ขัดกัน**กับส่วนนี้
   ถ้าจะเผยแพร่ทั้งโปรเจกต์ ต้องเลือกอย่างใดอย่างหนึ่ง:
   - เปลี่ยนทั้งโปรเจกต์ (หรืออย่างน้อยส่วน `web/`) เป็น GPL-2.0-or-later หรือ
   - ถอด `wave.js` และ `pot-mesh.js` ออก แล้วเขียนสูตรเองใหม่โดยไม่อ้างอิงโค้ดต้นทาง (Studio จะสร้างทรงไม่ได้จนกว่าจะเขียนเอนจินใหม่)
3. ถ้าแจกจ่ายไบนารี/เว็บที่ build แล้ว ต้องให้ source code ด้วยตามเงื่อนไข GPL

สำหรับงานส่งในชั้นเรียน โดยทั่วไปไม่มีปัญหา ตราบใดที่ให้เครดิตต้นทางชัดเจน
(ไฟล์นี้ + header comment ใน `wave.js` และ `pot-mesh.js` ทำหน้าที่นั้นแล้ว)
แต่ถ้าจะเอาไปใช้เชิงพาณิชย์หรือเผยแพร่สู่สาธารณะ ต้องจัดการเรื่องสัญญาอนุญาตก่อน

สำเนา GPL-2.0 ฉบับเต็ม: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt
