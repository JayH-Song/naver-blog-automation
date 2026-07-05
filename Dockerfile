FROM python:3.11-slim

# 1. 필수 OS 패키지 설치 (Pillow 이미지 라이브러리 빌드 등 대응)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libjpeg-dev \
    zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. 작업 디렉토리 설정
WORKDIR /app

# 3. 의존성 파일 복사 및 설치 (캐시 최적화)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. 소스 코드 복사
COPY . .

# 5. 실행 환경 설정
EXPOSE 8000
ENV PORT=8000
ENV PYTHONUNBUFFERED=1

# 6. 실행 명령 (PORT 환경변수 지원)
CMD ["sh", "-c", "uvicorn naver_blog_v01:app --host 0.0.0.0 --port $PORT"]
