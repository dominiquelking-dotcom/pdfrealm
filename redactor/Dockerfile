FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir pymupdf fastapi uvicorn

WORKDIR /app
COPY app.py /app/app.py

EXPOSE 9100
CMD ["uvicorn","app:app","--host","0.0.0.0","--port","9100"]
