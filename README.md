# Haru Studio ✦
> 네이버 블로그 포스팅 전체 라이프사이클 자동화 워크스테이션

---

## 디렉토리 구조

```
haru_studio/
├── main.py              ← FastAPI 백엔드 (단일 파일)
├── index.html           ← 프론트엔드 UI (단일 파일)
├── requirements.txt
├── .env.example         ← 환경변수 템플릿
├── .env                 ← 실제 API 키 (Git 제외 필수)
├── backups/             ← 원고 JSON 백업 (Smart Exclusion 기준)
├── outputs/
│   ├── *.txt            ← 사람이 읽기 쉬운 포맷
│   └── images/          ← 이미지 출력
├── static/
│   └── generated/       ← AI 생성 이미지 (웹서빙)
└── logs/
    └── blog_cozy_haru.log
```

---

## 빠른 시작

### 1. 환경변수 설정
```bash
cp .env.example .env
# .env 파일을 편집하여 API 키 입력
```

### 2. 패키지 설치
```bash
pip install -r requirements.txt
```

### 3. 실행
```bash
python main.py
# 또는
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### 4. 접속
```
http://localhost:8000
```

---

## API 키 취득 방법

| 서비스 | 목적 | 취득 URL |
|--------|------|----------|
| Anthropic | 원고 생성 (Claude) | https://console.anthropic.com |
| Google AI | Gemini (키워드추출/쇼핑) + Imagen (본문이미지) | https://aistudio.google.com |
| OpenAI | DALL-E 썸네일 생성 | https://platform.openai.com |
| Naver DataLab | 트렌드 키워드 | https://developers.naver.com |
| Naver SearchAds | 연관 키워드 + 검색량 | https://searchad.naver.com |

> API 키 없이도 Mock 모드로 UI 테스트 가능합니다.

---

## 7단계 파이프라인

```
[페르소나 설정]
      ↓
[키워드 선정] ← Naver SearchAds / DataLab / 직접입력
      ↓         + Smart Exclusion (14일) + Revenue Score ×1.2
[원고 생성] ← Claude Sonnet + 골든타임 전략 + AI티 제거 규칙
      ↓
[이미지 키워드 추출] ← Gemini Pro
      ↓
[이미지 생성] ← DALL-E 4 (썸네일 2장) + Imagen 4 (본문 5장)
      ↓
[Engagement 후처리] ← 체크리스트 / CTA / FAQ / 핵심요약 카드
      ↓
[Harvest] ← HTML 복사 (Safe Guard 체크리스트 통과 시)
```

---

## 주요 기능

### Persona-Driven Engine
- 직업/연령/경력/가족서사 → 모든 Claude 프롬프트에 주입
- 페르소나별 에디터 테마 컬러 동적 변경
- 소제목 단락마다 페르소나 직업 일화 자동 삽입

### Revenue Score 피드백 루프
- `revenue_log` 테이블 → 고수익 키워드 학습
- 완전 일치: base_score × 1.20 / 부분 일치: × 1.10
- HIGH-VALUE 배지 + 프로그레스 바로 시각화

### Smart Exclusion
- `backups/` 폴더 스캔 → 14일 이내 발행 키워드 자동 회색 처리
- 대소문자 구분 없는 키워드 매칭

### AI 티 제거 규칙
- 금지 접속어: 첫째/둘째/셋째/결론적으로/게다가/마지막으로/또한/따라서
- 금지 표현: 살펴보겠습니다/알아보겠습니다/도움이 될 수 있습니다/본 포스팅에서는
- 에디터 내 실시간 하이라이트 경고

### Harvest Safe Guard
- 수익 링크 장전 확인
- 금지어 검수 완료
- 이미지 ALT 텍스트 확인
- FAQ / 핵심요약 카드 확인
- 제목 SEO 최적화 확인
→ 5가지 모두 체크 시에만 HTML 복사 활성화

---

## Retry 로직 (Fault Tolerance)

각 생성 단계는 독립적인 Retry 로직 보유:

| 단계 | Retry | 지연 | 실패 시 |
|------|-------|------|---------|
| 원고 생성 (Claude) | 3회 | 1→2→4초 | 오류 메시지 반환 |
| 이미지 키워드 (Gemini) | 3회 | 1→2→4초 | Mock 키워드 사용 |
| DALL-E 썸네일 | 3회/장 | 즉시 | 빈 슬롯 유지 |
| Imagen 본문 | 3회/장 | 1초 간격 | 빈 슬롯 유지 |
| Engagement (Claude) | 3회 | 1→2→4초 | 원본 HTML 사용 |

중간 단계 실패 → 전체 파이프라인 중단 없이 다음 단계 진행.

---

## Draft Continuity (PC-모바일 연속성)

- **LocalStorage 캐싱**: 페르소나, 선택 키워드, 옵션, 마지막 결과 자동 저장
- **새로고침 복원**: 모든 상태가 새로고침 후에도 유지
- **기기 간 동기화**: 동일 브라우저 localStorage 공유 (PC-모바일 동일 계정 브라우저 사용 시)

---

## 모바일 반응형

768px 이하에서 자동 전환:
- 3단 레이아웃 → 하단 탭 메뉴 (전략 / 편집 / 도구)
- 에디터 영역 최대화
- Harvest Bar 압축 표시

---

## Naver 호환성

최종 HTML 출력:
- 모든 스타일 inline-style 위주 (네이버 스마트에디터 One 서식 보존)
- `ClipboardItem API` (`text/html` MIME) → 서식 보존 붙여넣기
- FAQ: `schema.org/FAQPage` 마이크로데이터 포함
- 이미지: `<figure>` 태그 + Gemini 생성 Alt Text

---

## 환경변수 목록

```
ANTHROPIC_API_KEY     Claude Sonnet API
GEMINI_API_KEY        Gemini + Imagen API
GOOGLE_CLOUD_KEY      Vertex AI (Imagen 4, 선택)
OPENAI_API_KEY        DALL-E 3/4 API
NAVER_CLIENT_ID       DataLab API
NAVER_CLIENT_SECRET   DataLab API
NAVER_ADS_API_KEY     SearchAds API
NAVER_ADS_SECRET      SearchAds API
NAVER_ADS_CUSTOMER_ID SearchAds API
```
