FROM python:3.12-slim

WORKDIR /app

# ติดตั้ง dependency ก่อนแล้วค่อย copy โค้ด — เพื่อให้ Docker cache layer นี้ไว้
# ถ้าแก้แค่โค้ดแต่ requirements.txt ไม่เปลี่ยน จะ build ใหม่ได้เร็วมาก (ไม่ต้อง pip install ใหม่)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
