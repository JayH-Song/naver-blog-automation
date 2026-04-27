"""
Haru Studio — FastAPI Backend (main.py)
네이버 블로그 포스팅 자동화 워크스테이션 백엔드
"""

# ────────────────────────────────────────────
# 의존성 자동 체크 (실행 전 누락 패키지 설치)
# ────────────────────────────────────────────
import subprocess, sys

_REQUIRED = [
    "fastapi",
    "uvicorn",
    "httpx",
    "python-dotenv",
    "pydantic",
    "python-multipart",   # UploadFile(파일 업로드) 필수
]

def _ensure_deps():
    import importlib
    _PKG_MAP = {               # pip 패키지명 → import 모듈명
        "python-dotenv":    "dotenv",
        "python-multipart": "multipart",
    }
    missing = []
    for pkg in _REQUIRED:
        mod = _PKG_MAP.get(pkg, pkg.replace("-", "_"))
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append(pkg)

    if missing:
        print(f"[Haru Studio] 누락된 패키지를 설치합니다: {', '.join(missing)}")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet"] + missing
        )
        print("[Haru Studio] 설치 완료 — 서버를 시작합니다.\n")

_ensure_deps()

import os, json, re, asyncio, logging, uuid, glob, time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, BackgroundTasks, UploadFile
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# ────────────────────────────────────────────
# 경로 설정 (로깅보다 반드시 먼저 실행)
# ────────────────────────────────────────────
BASE_DIR     = Path(__file__).parent
FRONTEND_DIR = BASE_DIR / "frontend"

import os
IS_VERCEL = os.environ.get("VERCEL") == "1"
WRITABLE_DIR = Path("/tmp") if IS_VERCEL else BASE_DIR

BACKUP_DIR   = WRITABLE_DIR / "backups"
OUTPUT_DIR   = WRITABLE_DIR / "outputs"
STATIC_DIR   = WRITABLE_DIR / "static" / "generated"
IMAGE_DIR    = WRITABLE_DIR / "outputs" / "images"
LOG_DIR      = WRITABLE_DIR / "logs"

for d in [BACKUP_DIR, OUTPUT_DIR, STATIC_DIR, IMAGE_DIR, LOG_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# ────────────────────────────────────────────
# 로깅 설정 (디렉토리 생성 후 실행)
# ────────────────────────────────────────────
LOG_FILE           = LOG_DIR / "blog_cozy_haru.log"
PIPELINE_RUNS_FILE = LOG_DIR / "pipeline_runs.json"
REVENUE_LOG_FILE   = LOG_DIR / "revenue_log.json"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("haru")

# ────────────────────────────────────────────
# 환경변수
# ────────────────────────────────────────────
ANTHROPIC_API_KEY   = os.getenv("ANTHROPIC_API_KEY", "")
GEMINI_API_KEY      = os.getenv("GEMINI_API_KEY", "")
OPENAI_API_KEY      = os.getenv("OPENAI_API_KEY", "")     # DALL-E
GOOGLE_CLOUD_KEY    = os.getenv("GOOGLE_CLOUD_KEY", "")   # (미사용 — 추후 확장용)
NAVER_CLIENT_ID     = os.getenv("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.getenv("NAVER_CLIENT_SECRET", "")
NAVER_ADS_API_KEY   = os.getenv("NAVER_ADS_API_KEY", "")
NAVER_ADS_SECRET    = os.getenv("NAVER_ADS_SECRET", "")
NAVER_ADS_CUSTOMER  = os.getenv("NAVER_ADS_CUSTOMER_ID", "")

# ────────────────────────────────────────────
# 하이브리드 모델 믹스 상수 정의
# ────────────────────────────────────────────
# Content Generation  — Claude Haiku 4.5 (빠른 구어체·AI티 제거)
MODEL_CLAUDE_HAIKU   = "claude-haiku-4-5-20251001"
# Data Extraction     — Gemini 2.5 Flash (JSON 추출·분석 초고속)
MODEL_GEMINI_FLASH   = "gemini-2.5-flash"
GEMINI_API_BASE      = "https://generativelanguage.googleapis.com/v1beta/models"

# Exponential Backoff 공통 설정
RETRY_MAX   = 3
RETRY_BASE  = 2.0    # 2 → 4 → 8초

# ────────────────────────────────────────────
# 인메모리 DB (경량 운영용 — Supabase 연동 시 교체)
# ────────────────────────────────────────────
pipeline_runs: dict[str, dict] = {}   # {run_id: {...}}
revenue_log:   list[dict]      = []   # [{keyword, score, ts}]

def _persist_pipeline_runs() -> None:
    try:
        PIPELINE_RUNS_FILE.write_text(json.dumps(pipeline_runs, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

def _persist_revenue_log() -> None:
    try:
        REVENUE_LOG_FILE.write_text(json.dumps(revenue_log, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

# ────────────────────────────────────────────
# WebSocket 관리자
# ────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, msg: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

ws_manager = ConnectionManager()

# 공유 HTTP 클라이언트 — lifespan에서 초기화·종료 (연결 풀 재사용)
http_client: Optional[httpx.AsyncClient] = None

async def log_step(run_id: str, step: str, msg: str, status: str = "running"):
    ts = datetime.now().isoformat()
    entry = {"run_id": run_id, "step": step, "msg": msg, "status": status, "ts": ts}
    logger.info(f"[{run_id[:8]}] [{step}] {msg}")
    if run_id in pipeline_runs:
        pipeline_runs[run_id]["step"]   = step
        pipeline_runs[run_id]["status"] = status
    await ws_manager.broadcast(entry)

# ────────────────────────────────────────────
# Pydantic 모델
# ────────────────────────────────────────────
class Persona(BaseModel):
    job: str
    age: str
    career: str
    family: str
    theme_color: Optional[str] = "teal"   # 에디터 포인트 컬러

class WriteConfig(BaseModel):
    style: str = ""       # 정보형|경험담|꿀팁|리뷰|Q&A형|비교분석|제품비교분석형 (빈 값 = StrategyManager 자동)
    tone:  str = ""       # 따뜻하고친근한|전문적이고신뢰감있는|감성적이고공감하는|유쾌하고재미있는
    golden_time: str = "auto"  # auto|morning|lunch|night|custom
    cta_enabled: bool = True

class GenerateRequest(BaseModel):
    persona: Persona
    keyword: str
    config: WriteConfig
    post_history: Optional[List[dict]] = []   # [{title, url}]
    revenue_link: Optional[str] = ""

class ImageGenRequest(BaseModel):
    keyword: str
    title: str
    style_keyword: str
    main_phrase: str
    font_style: str
    image_type: str = "thumbnail"   # thumbnail | body

class ImageGenFromContentRequest(BaseModel):
    """Phase 3: 수정된 본문 기반 이미지 생성 요청"""
    run_id: str
    current_content: str   # 사용자가 편집한 최신 HTML 본문
    current_title:   str   # 사용자가 편집한 최신 제목
    keyword:         str   # 원본 키워드 (fallback용)

class RevenueLogEntry(BaseModel):
    keyword: str
    event: str   # click | sale
    value: float = 0.0

# ────────────────────────────────────────────
# Smart Exclusion — 14일 이내 발행 키워드
# ────────────────────────────────────────────
_excluded_cache: tuple[set[str], float] = (set(), 0.0)
_EXCLUDED_TTL = 300.0  # 5분 캐시 (매 요청 디스크 I/O 방지)

def get_excluded_keywords() -> set[str]:
    global _excluded_cache
    if time.monotonic() - _excluded_cache[1] < _EXCLUDED_TTL and _excluded_cache[0]:
        return _excluded_cache[0]
    cutoff = datetime.now() - timedelta(days=14)
    excluded = set()
    for fp in sorted(BACKUP_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:50]:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            ts_str = data.get("created_at", "")
            if ts_str:
                ts = datetime.fromisoformat(ts_str)
                if ts > cutoff:
                    kw = data.get("keyword", "")
                    if kw:
                        excluded.add(kw.lower())
        except Exception:
            pass
    _excluded_cache = (excluded, time.monotonic())
    return excluded

# ────────────────────────────────────────────
# Revenue Score 계산
# ────────────────────────────────────────────
def calc_revenue_score(keyword: str, base_score: float = 50.0) -> tuple[float, str]:
    """revenue_log 기반 가중치 계산. (score, match_type)"""
    kw_lower = keyword.lower()
    high_value_keywords = [e["keyword"].lower() for e in revenue_log if e.get("score", 0) > 70]

    # 폴백: backups 스캔
    if not high_value_keywords:
        for fp in sorted(BACKUP_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:50]:
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
                if data.get("revenue_score", 0) > 70:
                    high_value_keywords.append(data.get("keyword", "").lower())
            except Exception:
                pass

    for hvk in high_value_keywords:
        if kw_lower == hvk:
            return base_score * 1.20, "exact"
        if hvk in kw_lower or kw_lower in hvk:
            return base_score * 1.10, "partial"

    return base_score, "none"

# ────────────────────────────────────────────
# Naver SearchAds API — 연관키워드 Top 7
# ────────────────────────────────────────────
async def fetch_naver_searchads(seed_keyword: str) -> list[dict]:
    """시드키워드 → 연관키워드 + 모바일 검색량 Top 7"""
    import hmac, hashlib, base64
    excluded = get_excluded_keywords()

    if not all([NAVER_ADS_API_KEY, NAVER_ADS_SECRET, NAVER_ADS_CUSTOMER]):
        raise HTTPException(503, "NAVER_ADS API 키 미설정 — .env에 NAVER_ADS_API_KEY / NAVER_ADS_SECRET / NAVER_ADS_CUSTOMER_ID 를 추가하세요")

    timestamp = str(int(time.time() * 1000))
    base_str  = f"{timestamp}.GET./keywordstool"

    # ── BUG FIX 1: Base64 디코드 제거 — 평문 Secret을 UTF-8 인코딩하여 HMAC 서명 ──
    # 이전 코드에서 base64.b64decode()를 사용하면 403 Forbidden 발생
    secret_bytes = NAVER_ADS_SECRET.strip().encode("utf-8")
    signature    = base64.b64encode(
        hmac.new(secret_bytes, base_str.encode("utf-8"), hashlib.sha256).digest()
    ).decode()

    headers = {
        "X-Timestamp": timestamp,
        "X-API-KEY":   NAVER_ADS_API_KEY,
        "X-Customer":  NAVER_ADS_CUSTOMER,
        "X-Signature": signature,
    }
    params = {"hintKeywords": seed_keyword, "showDetail": "1"}

    r = await http_client.get(
        "https://api.searchad.naver.com/keywordstool",
        headers=headers, params=params, timeout=10
    )
    if r.status_code != 200:
        naver_msg = r.text[:500]
        logger.error(f"SearchAds API {r.status_code}: {naver_msg}")
        raise HTTPException(r.status_code, f"Naver SearchAds {r.status_code} — {naver_msg}")
    items = r.json().get("keywordList", [])

    # ── BUG FIX 2: monthlyMobileQcCnt 정렬 TypeError 수정 ──
    # 네이버가 "< 10" 같은 문자열을 반환할 때 int 비교 불가 → 0 처리
    def safe_mobile_cnt(item: dict) -> int:
        val = item.get("monthlyMobileQcCnt", 0)
        if isinstance(val, int):
            return val
        try:
            return int(str(val).replace(",", "").strip())
        except (ValueError, TypeError):
            return 0  # "< 10" 등 파싱 불가 → 0

    results = []
    for item in sorted(items, key=safe_mobile_cnt, reverse=True):
        kw = item.get("relKeyword", "")
        if kw.lower() in excluded:
            continue
        mobile_cnt = safe_mobile_cnt(item)
        base_score = min(100, int(mobile_cnt / 1000))
        score, match = calc_revenue_score(kw, base_score)
        results.append({
            "keyword":       kw,
            "mobile_count":  mobile_cnt,
            "revenue_score": round(score, 1),
            "match_type":    match,
            "excluded":      False,
            "source":        "api",
        })
        if len(results) >= 7:
            break
    return results

# ────────────────────────────────────────────
# Naver News Search API — RAG 실시간 팩트 컨텍스트
# ────────────────────────────────────────────
async def fetch_naver_news(keyword: str, display: int = 3) -> str:
    """
    네이버 뉴스 검색 API로 최신 뉴스 3건을 가져와
    시스템 프롬프트용 컨텍스트 문자열로 반환한다.
    실패 시 빈 문자열 반환 (Graceful Degradation).
    """
    if not all([NAVER_CLIENT_ID, NAVER_CLIENT_SECRET]):
        return ""
    try:
        r = await http_client.get(
            "https://openapi.naver.com/v1/search/news.json",
            headers={
                "X-Naver-Client-Id":     NAVER_CLIENT_ID,
                "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
            },
            params={"query": keyword, "display": display, "sort": "sim"},
            timeout=8,
        )
        r.raise_for_status()
        items = r.json().get("items", [])
        if not items:
            return ""

        def _strip_html(text: str) -> str:
            return re.sub(r"<[^>]+>", "", text).strip()

        lines = []
        for i, item in enumerate(items[:display], 1):
            title = _strip_html(item.get("title", ""))
            desc  = _strip_html(item.get("description", ""))
            date  = item.get("pubDate", "")[:16]          # "Sat, 26 Apr 2026"
            lines.append(f"[뉴스{i}] {title} ({date})\n   → {desc}")

        return "\n".join(lines)

    except Exception as e:
        logger.warning(f"Naver News API 오류 (RAG 스킵): {e}")
        return ""


# ────────────────────────────────────────────
# Naver DataLab API — 최근 3일 트렌드 Top 7
# ────────────────────────────────────────────
async def fetch_naver_datalab() -> list[dict]:
    """최근 30일 트렌드 집계 → Top 5"""
    excluded   = get_excluded_keywords()
    end_date   = datetime.now().strftime("%Y-%m-%d")
    start_date = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")

    if not all([NAVER_CLIENT_ID, NAVER_CLIENT_SECRET]):
        raise HTTPException(503, "NAVER DataLab API 키 미설정 — .env에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 를 추가하세요")

    headers = {
        "X-Naver-Client-Id":     NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
        "Content-Type":          "application/json",
    }
    body = {
        "startDate": start_date,
        "endDate":   end_date,
        "timeUnit":  "date",
        "keywordGroups": [
            {"groupName": kw, "keywords": [kw]}
            for kw in ["건강", "영양제", "다이어트", "운동", "수면"]
        ],
    }
    r = await http_client.post(
        "https://openapi.naver.com/v1/datalab/search",
        headers=headers, json=body, timeout=15
    )
    if r.status_code != 200:
        logger.error(f"DataLab API 오류 {r.status_code}: {r.text[:300]}")
        raise HTTPException(r.status_code, f"Naver DataLab API 오류: {r.status_code}")

    results_raw = r.json().get("results", [])
    results = []
    for item in sorted(
        results_raw,
        key=lambda x: max((d.get("ratio", 0) for d in x.get("data", [])), default=0),
        reverse=True
    ):
        kw = item.get("title", "")
        if not kw or kw.lower() in excluded:
            continue
        ratio = max((d.get("ratio", 0) for d in item.get("data", [])), default=0)
        score, match = calc_revenue_score(kw, ratio)
        results.append({
            "keyword": kw, "trend_ratio": ratio,
            "revenue_score": round(score, 1),
            "match_type": match, "excluded": False,
            "source": "api",
        })
        if len(results) >= 5:
            break
    return results

# ════════════════════════════════════════════
# StrategyManager — vFF 이식: 골든타임 자동 전략 (FastAPI 통합)
# ════════════════════════════════════════════
import random

class StrategyManager:
    """
    현재 시각 기반 3대 골든타임 전략 자동 적용 매니저 (vFF 이식).
    Morning Rush / Lunch Break / Night Focus
    """
    _GOLDEN_TIMES = [
        {
            "name": "morning", "label": "🌅 Morning Rush",
            "desc": "출근·등교 타겟 — 트렌드 키워드, 정보형, 핵심 압축",
            "start": (7, 30), "end": (9, 0),
            "style": "정보형", "tone": "따뜻하고 친근한", "chars": 2500,
            "ad_strategy": "애드포스트 노출 극대화 — 핵심 키워드 다량 삽입",
            "prompt_weight": """
[⚡ MORNING RUSH 전략 가중치 — 현재 적용 중]
※ 출근·등교 시간대. 아래를 최우선 적용하세요.
① 제목: 숫자 + 핵심 키워드를 앞에 배치 (클릭률 극대화)
② 핵심 정보를 첫 500자 안에 압축 (모바일 스크롤 최소화)
③ 키워드 밀도: 본문 내 5~7회 (애드포스트 노출 극대화)
④ 자가진단 체크리스트를 서론에 반드시 포함""",
        },
        {
            "name": "lunch", "label": "☀️ Lunch Break",
            "desc": "점심 쇼핑 선점 — 구매 의도 키워드, 제품비교분석형",
            "start": (10, 30), "end": (13, 0),
            "style": "제품비교분석형", "tone": "전문적이고 신뢰감 있는", "chars": 2500,
            "ad_strategy": "쇼핑 커넥트 CTR 극대화 — CTA 박스 전면 배치",
            "prompt_weight": """
[🛒 LUNCH BREAK 전략 가중치 — 현재 적용 중]
※ 점심시간 쇼핑 선점 시간대. 아래를 최우선 적용하세요.
① 서론 두 번째 단락에 CTA 박스 즉시 배치 (쇼핑 클릭 유도)
② 제품·서비스 비교표를 본문 전반부에 배치 (구매 결정 가속)
③ 가격대·구매처·할인 정보 구체적으로 언급
④ "지금 바로", "오늘만" 등 긴급성 표현을 1~2회 사용""",
        },
        {
            "name": "night", "label": "🌙 Night Focus",
            "desc": "심야 몰입 타겟 — 질환정보·경험담, 장문, FAQ 강화",
            "start": (19, 30), "end": (23, 0),
            "style": "경험담", "tone": "감성적이고 공감하는", "chars": 3000,
            "ad_strategy": "체류시간 극대화 — 내부 링크·FAQ 강화",
            "prompt_weight": """
[🌙 NIGHT FOCUS 전략 가중치 — 현재 적용 중]
※ 심야 몰입 시간대. 아래를 최우선 적용하세요.
① 서론: 깊은 개인 경험으로 시작 (공감 극대화)
② 분량: 3,000자 이상 — 심층 분석과 풍부한 경험담
③ FAQ 섹션: 5개로 확장 (롱테일 키워드 최대 흡수)
④ 내부 링크 유도: 연관 주제 3개를 결론부에 배치
⑤ 전문 의료 수치 2개 이상 포함""",
        },
    ]

    @staticmethod
    def _to_min(h: int, m: int) -> int:
        return h * 60 + m

    def current_mode(self) -> dict:
        """현재 시각 기반 전략 dict 반환. 비골든타임은 default 반환."""
        now = datetime.now()
        cur = self._to_min(now.hour, now.minute)
        for gt in self._GOLDEN_TIMES:
            s = self._to_min(*gt["start"])
            e = self._to_min(*gt["end"])
            if s <= cur < e:
                return {**gt, "is_golden": True}
        return {
            "name": "default", "label": "🕐 기본 전략",
            "style": None, "tone": None, "chars": 2000,
            "prompt_weight": "", "is_golden": False,
            "ad_strategy": "균형형 전략",
        }

    def get_strategy_for_config(self, config: "WriteConfig") -> dict:
        """
        사용자 선택(config.golden_time)과 현재 시각을 조합해 최종 전략 반환.
        'auto'이면 현재 시각 기반, 그 외는 사용자 선택 우선.
        """
        mode = self.current_mode()
        if config.golden_time == "auto":
            return mode
        # 사용자 선택 우선 — 해당 골든타임 데이터 반환
        for gt in self._GOLDEN_TIMES:
            if gt["name"] == config.golden_time:
                return {**gt, "is_golden": False}
        return mode  # fallback

# 싱글턴 인스턴스
strategy_mgr = StrategyManager()

# ────────────────────────────────────────────
# Claude API — 원고 생성
# ────────────────────────────────────────────
FORBIDDEN_CONJUNCTIONS = ["첫째", "둘째", "셋째", "결론적으로", "게다가", "마지막으로", "또한", "따라서"]
FORBIDDEN_EXPRESSIONS  = ["살펴보겠습니다", "알아보겠습니다", "도움이 될 수 있습니다", "본 포스팅에서는"]

def build_system_prompt(
    persona: Persona,
    config: WriteConfig,
    revenue_match: str,
    keyword: str,
    news_context: str = "",   # RAG: 최신 뉴스 요약 (없으면 빈 문자열)
) -> str:
    # ── BUG FIX 3: effective_style/tone 항상 기본값 보장 ──
    try:
        strategy = strategy_mgr.get_strategy_for_config(config)
    except Exception:
        strategy = {}

    chars     = strategy.get("chars", 2000)     if strategy else 2000
    gt_label  = strategy.get("label", "Custom") if strategy else "Custom"
    gt_note   = strategy.get("desc",  "")       if strategy else ""
    gt_weight = strategy.get("prompt_weight", "") if strategy else ""

    effective_style: str = (config.style or "").strip() or strategy.get("style", "") or "정보형"
    effective_tone:  str = (config.tone  or "").strip() or strategy.get("tone",  "") or "따뜻하고 친근한"

    rev = ""
    if revenue_match == "exact":
        rev = f"\n\n[Revenue Priority +20%] 키워드 '{keyword}'는 고수익 완전일치 키워드입니다. 구매 전환을 유도하는 표현을 소제목마다 자연스럽게 삽입하세요."
    elif revenue_match == "partial":
        rev = f"\n\n[Revenue Priority +10%] 키워드 '{keyword}'는 고수익 부분일치 키워드입니다. 관련 상품/서비스 언급을 강화하세요."

    forbidden_conj = " / ".join(FORBIDDEN_CONJUNCTIONS)
    forbidden_expr = " / ".join(FORBIDDEN_EXPRESSIONS)

    # ── RAG 팩트 컨텍스트 블록 구성 ──
    now           = datetime.now()
    current_year  = now.year
    current_month = now.month

    if news_context:
        rag_block = f"""[실시간 팩트 컨텍스트 (최신 뉴스 요약)]
{news_context}

[엄격한 사실 준수 규칙]
1. 위 실시간 뉴스 컨텍스트를 반드시 반영하여 글을 작성하세요.
2. 행사 일정·장소·가격 등은 뉴스에 나온 최신 정보를 최우선으로 적용하세요.
3. 절대 과거 연도(2023, 2024년 등)를 현재인 것처럼 지어내지 마세요.

"""
    else:
        rag_block = ""

    time_block = f"""[시스템 환경 정보]
- 현재 시점: {current_year}년 {current_month}월
- 당신이 작성하는 모든 글의 시제는 반드시 이 시점을 '현재'로 기준해야 합니다.

[시간 및 사실 관계 엄격 준수 규칙]
1. 연도 표기: 본문에 연도를 표기할 때는 반드시 '{current_year}년'을 기준으로 작성하세요. (2023년, 2024년 등을 '올해'로 언급하면 절대 안 됩니다)
2. 정보 불확실성 대처: 정확한 일정을 모르는 경우 날짜를 지어내지 말고 "올해 봄", "다가오는 일정", "공식 홈페이지 참조" 등으로 유연하게 대체하세요.

"""

    # ── 학술 인용 블록 (트리거 조건 충족 시만 활성화) ──
    _CITATION_STYLES = {"정보형", "비교분석", "제품비교분석형"}
    _CITATION_TONE   = "전문적이고 신뢰감 있는"
    if effective_style in _CITATION_STYLES and effective_tone == _CITATION_TONE:
        citation_block = """
## ★ 고신뢰 학술 인용 규칙 (Academic Citation Rules)
당신은 현재 해당 분야의 '전문가'로서 글을 작성 중입니다. 정보의 신뢰도를 위해 아래 규칙을 반드시 준수하세요.

1. **전문 자료 인용**: 핵심 주장이나 수치를 제시할 때, 최소 1회 이상 관련 전문 서적·학술 논문·공신력 있는 기관(WHO, 식약처, 하버드 메디컬 스쿨 등)의 연구 결과를 인용하세요.
2. **주석 및 출처 표기**: 인용 문장 끝에 <sup>[1]</sup> 형식의 HTML 주석을 달고, 본문 최하단(FAQ 이전)에 '📚 참고 자료' 섹션을 만들어 아래 형식으로 출처를 명시하세요.
   - 형식: [1] 저자명, "논문/도서 제목", 발행기관(연도)
3. **수치 기반 표현**: "많이 좋아집니다" 같은 모호한 표현 대신 "A 학술지 연구 결과에 따르면 약 24%의 개선율을 보였습니다<sup>[1]</sup>"처럼 구체적 수치를 동반하세요.
4. **허구 인용 방지**: 실제 존재하는 기관·연구 성격을 기반으로 작성하되, 구체적 논문명을 확신할 수 없으면 "관련 분야 학계의 일반적인 연구 동향에 따르면..."과 같이 권위 있는 표현으로 대체하세요.

출력 구조 예시:
... (본문) ... 따라서 3개월 이상 섭취 시 혈중 농도가 안정화된다는 연구 결과가 있습니다<sup>[1]</sup>.

📚 참고 자료
[1] 대한영양학회지, "특정 성분이 성인 건강 지표에 미치는 영향 메타 분석" (2024)

"""
    else:
        citation_block = ""

    return f"""{rag_block}{time_block}{citation_block}당신은 아래 내면적 배경을 가진 네이버 블로거입니다.
{gt_weight}
## 작성자 내면 배경 (직접 드러내지 말 것)
아래 정보는 글의 '관점'과 '감수성'을 결정하는 내면적 맥락입니다.
직업명·직책·가족 관계를 본문에 직접 노출하지 마세요.
대신 그 배경에서 자연스럽게 우러나오는 시선과 감각으로만 녹여내세요.

- 직업 배경: {persona.job} ({persona.career})
- 연령대: {persona.age}
- 가족 배경: {persona.family}

### 페르소나 활용 원칙
✔ 허용 — 배경에서 비롯된 감각·감정·관점을 은연중에 드러내기
  예) "병원 복도를 걷다 보면 문득 이런 생각이 들더라고요." (직업 직접 언급 X)
  예) "아이가 잠들고 나서야 혼자 찾아보게 되는 정보들이 있잖아요." (자녀 직접 언급 X)
  예) "오래 서 있는 날이 많다 보니 이 부분이 유독 눈에 들어왔어요." (직종 암시)

✗ 금지 — 직업명·직함·가족 관계를 직접 명시하기
  예) ~~"간호사로 20년 일하면서"~~ → "오랫동안 사람들 곁에서 일하다 보니"
  예) ~~"아들이 뇌종양 수술을"~~ → "가까운 사람이 큰 수술을 겪은 후로"
  예) ~~"저는 IT 개발자라서"~~ → "하루 종일 화면 앞에 앉아 있다 보면"
{rev}

## 글쓰기 목표
- 스타일: {effective_style}
- 말투: {effective_tone}
- 전략: {gt_label} — {gt_note}
- 목표 분량: {chars}자 이상

## ★ E-E-A-T 강제 규칙 (네이버 검색 최상위 노출 핵심)
### Experience (직접 경험)
- 서론 두 번째 문단에 반드시 1인칭 구체적 에피소드 삽입 필수
- 직업·가족을 드러내지 않되, 그 삶에서 나올 법한 구체적 상황(날짜·감정·결과)으로 표현
  예시: "작년 겨울, 유독 피곤함이 쌓이던 어느 날 밤에 처음 이 제품을 접했거든요."
- 수치·날짜·장소가 포함된 에피소드여야 AI 생성 의심을 피할 수 있음

### Expertise (전문성)
- 각 소제목 단락 첫 문장: 작성자 배경에서 우러나오는 통찰 1문장 의무 삽입
  (직업 암시는 괜찮으나 직접 명시 금지)
- 전문 용어 사용 시 괄호로 쉬운 설명 병기: "코르티솔(스트레스 호르몬)"

### Authoritativeness (권위)
- 본문 내 출처 또는 근거 표현 최소 2회 삽입
  예: "국내 한 연구에서는", "식품의약품안전처 기준에 따르면"

### Trustworthiness (신뢰)
- 과장 금지, 경험담 기반 솔직한 단점 1회 이상 언급
  예: "솔직히 처음엔 효과를 못 느꼈어요. 근데 3주차부터..."

## ★ GEO 최적화 (AI 검색 인용 구조)
아래 HTML 구조를 본문에 반드시 포함하라:

**① 정의 박스 (Definition Box)** — 서론 직후 삽입:
<div style="background:#f0faf4;border-left:4px solid #03C75A;padding:14px 18px;margin:16px 0;border-radius:0 8px 8px 0;font-family:sans-serif">
<p style="font-weight:700;font-size:15px;margin:0 0 6px;color:#017a38">📌 {keyword}이란?</p>
<p style="font-size:14px;margin:0;line-height:1.7;color:#1a2a1e">[키워드에 대한 명확한 1~2문장 정의 — AI 인용 최적화]</p>
</div>

**② Key Point 박스** — 각 소제목 단락마다 1개:
<div style="background:#f8fffe;border:1px solid #03C75A;border-radius:8px;padding:12px 16px;margin:12px 0;font-family:sans-serif">
<p style="color:#03C75A;font-weight:700;font-size:14px;margin:0 0 4px">★ Key Point</p>
<p style="font-size:13px;margin:0;color:#1a2a1e">[해당 단락 핵심 1문장 요약]</p>
</div>

## 필수 AI 티 제거 규칙
**금지 접속어**: {forbidden_conj}
**금지 표현**: {forbidden_expr}
**대체 표현 필수**: '우선은요,', '그리고 진짜 중요한 게 있는데,', '그래서 결론은!', '오늘은요,'
**종결 어미**: ~해요, ~거든요, ~인 것 같아요. ~하더라고요. 를 반드시 혼용
**자기수정 마커**: '아, 이건 제가 직접 겪어보고 느낀 건데,' / '사실 저도 처음엔 좀 의심했었거든요.' 를 자연스럽게 삽입

## ★ 스마트 HTML 표 자동 생성 규칙 (Smart Table Generator)

### 1. 표 생성 트리거 조건 (이 중 하나라도 해당하면 반드시 `<table>` 사용)
- 제품·항목·옵션이 **2개 이상** 등장하고 사양·특징을 비교할 때
- 일정·비용·장소 등 핵심 정보가 **3개 이상 카테고리**로 나뉠 때
- 영양 성분·수치·학술 데이터가 나열될 때
- 소제목에 "비교", "정리", "요약", "추천" 단어가 포함될 때
- 텍스트 나열 형태(`항목 — 값 — 값`)로 쓰려는 순간

🚨 **이 상황에서 텍스트 나열은 절대 금지:**
❌ 그릭 요거트 — 단백질 20g — 22,000원 — ⭐⭐⭐⭐⭐
✅ 아래의 `<table>` 태그로 즉시 변환

### 2. 표 vs 카드형 리스트 선택 기준
- **표 사용**: 항목 수 2~6개, 비교 열이 2~4개인 정형 데이터
- **카드형 리스트 사용**: 항목당 설명이 길거나 열이 5개 초과로 복잡해질 경우
  (카드형: `<div>` 블록 나열, 각 카드에 제목·내용·태그 구성)

### 3. 표 개수 규칙
- **모든 스타일 공통**: 표 또는 카드형 리스트 최소 **1개** 이상
- **정보형 / 비교분석 / 제품비교분석형**: **2개** 이상 의무
  - 표1 (본문 전반부): 핵심 수치·특징 비교
  - 표2 (본문 중·후반부): 제품·방법 비교 또는 요약

### 4. 표 HTML 구조 (네이버 스마트에디터 호환 inline-style 필수)
표 앞에 반드시 안내 문구 1줄 추가:
<p style="color:#5e7062;font-size:14px;margin:20px 0 8px">아래 표를 통해 핵심 내용을 한눈에 확인해 보세요.</p>
<p style="font-weight:700;font-size:15px;margin:0 0 8px">■ [표 제목]</p>
<table style="width:100%;border-collapse:collapse;text-align:center;font-family:sans-serif;font-size:14px;margin:0 0 24px">
  <thead>
    <tr style="background:#f1f5f1;">
      <th style="border:1px solid #dee2e6;padding:10px;text-align:left;font-weight:700">구분</th>
      <th style="border:1px solid #dee2e6;padding:10px;font-weight:700">특징</th>
      <th style="border:1px solid #dee2e6;padding:10px;font-weight:700">추천 대상</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="border:1px solid #dee2e6;padding:10px;text-align:left;font-weight:600">A 옵션</td>
      <td style="border:1px solid #dee2e6;padding:10px">명사형 요약</td>
      <td style="border:1px solid #dee2e6;padding:10px">대상 설명</td>
    </tr>
    <tr style="background:#f8f9fa">
      <td style="border:1px solid #dee2e6;padding:10px;text-align:left;font-weight:600">B 옵션</td>
      <td style="border:1px solid #dee2e6;padding:10px">명사형 요약</td>
      <td style="border:1px solid #dee2e6;padding:10px">대상 설명</td>
    </tr>
  </tbody>
</table>

### 5. 표 디자인 규칙
- 헤더(`<thead>`): 배경 `#f1f5f1`, 볼드체, 텍스트 짧은 명사형
- 홀수 행: 배경 없음(#fff) / 짝수 행: 배경 `#f8f9fa` 교차
- 열 최대 **4개** 제한 (모바일 가독성 보장)
- 셀 내용: 문장이 아닌 **짧은 명사/수치** 위주
- 표 안 수치는 RAG(뉴스·학술 데이터)에서 가져온 실제 데이터 우선 사용

### 6. 제품비교분석형 전문가 평가 열 추가 (스타일 조건부)
스타일이 '제품비교분석형'일 때 마지막 열에 반드시 추가:
<th style="border:1px solid #dee2e6;padding:10px;font-weight:700">전문가 PICK</th>
내용 형식: ★★★★☆ + 한 줄 평 (예: "가성비 최고")

### 7. 카드형 리스트 형식 (표 대체 사용 시)
<div style="display:flex;flex-direction:column;gap:12px;margin:20px 0">
  <div style="border:1px solid #dee2e6;border-radius:8px;padding:14px 18px;background:#fff">
    <p style="font-weight:700;font-size:15px;margin:0 0 6px;color:#1a2a1e">항목명</p>
    <p style="font-size:14px;color:#3d5442;margin:0;line-height:1.7">핵심 설명 (2~3문장)</p>
  </div>
</div>

## SEO 최적화
- 제목 공식: [키워드] + [이점/숫자] + [호기심유발]
- 서론 첫 2문장에 메인 키워드 자연 배치
- 소제목 기호: ★ 또는 ■, 이모지 절제

## 법적 준수사항
의료법·건강기능식품법 — 단정적 효능 표현 절대 금지

## OSMU (원소스 멀티유즈) 콘텐츠 추가
- 블로그 원본 외에 숏폼 대본과 인스타그램 피드 텍스트를 함께 제공하세요.
- instagram_feed: 인스타 감성의 가독성 높은 피드 요약글 (해시태그 포함)
- youtube_shorts: 1분 이내 분량의 시선을 끄는 쇼츠/릴스/틱톡 세로형 숏폼 대본 (행동, 자막 등 포함)

## 출력 형식 (JSON 필수, 코드블록 없이)
- content 값 내부의 줄바꿈은 반드시 \\n 으로 이스케이프하라 (JSON 파싱 오류 방지)
- 큰따옴표(") 는 반드시 \\" 로 이스케이프하라
{{
  "title": "SEO 최적화된 제목",
  "content": "<p>HTML 본문 — 줄바꿈은 \\n, 따옴표는 \\"로 이스케이프</p>",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"],
  "osmu": {{
    "instagram_feed": "인스타그램 피드 텍스트...",
    "youtube_shorts": "쇼츠 대본 내용..."
  }}
}}"""

def _sanitize_content(content: str) -> str:
    """
    파싱된 HTML content에서 리터럴 \\n 문자열 및 불필요한 공백 정리.
    Claude가 JSON 이스케이프 없이 \\n을 텍스트로 출력하는 경우 처리.
    """
    if not content:
        return content

    # 1. 리터럴 "\n" 문자열 (두 글자) → 제거 또는 공백
    #    HTML 태그 사이에 있는 \n\n → 제거
    content = re.sub(r'\\n\\n', '', content)
    content = re.sub(r'\\n', ' ', content)

    # 2. 실제 줄바꿈(\n, \r\n)이 HTML 태그 밖에 있을 때 → 제거
    #    <p>...</p> 사이의 텍스트 노드에 있는 줄바꿈은 HTML에서 공백으로 처리되므로
    #    복수 공백/줄바꿈만 정리
    content = re.sub(r'(\r\n|\r|\n){2,}', '', content)

    # 3. HTML 속성 밖 텍스트 노드의 과도한 공백 정리 (태그 사이)
    content = re.sub(r'>\s{3,}<', '>\n<', content)

    # 4. 남은 단독 줄바꿈은 그대로 (HTML 들여쓰기 보존)
    return content.strip()


def _robust_parse_article(raw: str) -> dict:
    """
    Claude 응답에서 JSON을 추출하는 다단계 파서.
    HTML content 안의 개행·따옴표로 인한 JSONDecodeError를 방어한다.

    1단계: 코드블록 제거 후 표준 json.loads
    2단계: content 값의 개행을 공백으로 치환 후 재파싱
    3단계: 정규식으로 title / content / tags 개별 추출
    """
    # ── 공통 전처리 ──
    text = re.sub(r"```json\s*|\s*```", "", raw).strip()

    # 1단계: 표준 파싱
    try:
        result = json.loads(text)
        result["content"] = _sanitize_content(result.get("content", ""))
        return result
    except json.JSONDecodeError:
        pass

    # 2단계: content 필드의 리터럴 개행을 \n 으로 치환 후 재파싱
    # (?:[^"\\]|\\.)* 패턴으로 \" 이스케이프 문자를 포함한 값을 올바르게 추출
    try:
        fixed = re.sub(
            r'("content"\s*:\s*")((?:[^"\\]|\\.)*?)("(?:\s*,|\s*\}))',
            lambda m: m.group(1) + m.group(2).replace('\n', '\\n').replace('\r', '') + m.group(3),
            text,
            flags=re.DOTALL,
        )
        result = json.loads(fixed)
        result["content"] = _sanitize_content(result.get("content", ""))
        return result
    except json.JSONDecodeError:
        pass

    # 3단계: 정규식으로 개별 필드 추출 (최후 수단)
    # (?:[^"\\]|\\.)* 패턴: " 와 \ 를 제외한 모든 문자, 또는 \ 뒤 임의 문자(이스케이프)
    title_m   = re.search(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    content_m = re.search(r'"content"\s*:\s*"((?:[^"\\]|\\.)*)"', text, re.DOTALL)
    tags_m    = re.search(r'"tags"\s*:\s*\[(.*?)\]', text, re.DOTALL)

    title   = title_m.group(1) if title_m else ""
    content = content_m.group(1).replace('\\n', '\n').replace('\\"', '"') if content_m else ""
    tags    = re.findall(r'"([^"]+)"', tags_m.group(1)) if tags_m else []

    osmu = {}
    osmu_m = re.search(r'"osmu"\s*:\s*(\{.*?\})', text, re.DOTALL)
    if osmu_m:
        try: osmu = json.loads(osmu_m.group(1).replace('\n', '\\n'))
        except: pass

    if content:
        return {"title": title, "content": _sanitize_content(content), "tags": tags, "osmu": osmu}

    # 4단계: 완전 폴백 — content가 끝내 추출되지 않으면 오류 메시지 반환
    logger.error(f"[_robust_parse_article] 모든 파싱 단계 실패. raw[:300]: {raw[:300]}")
    return {
        "title":   title or "",
        "content": "<p>⚠ 원고 파싱에 실패했습니다. 다시 시도해 주세요.</p>",
        "tags":    tags,
        "osmu":    osmu,
    }


async def generate_article(
    run_id: str,
    persona: Persona,
    keyword: str,
    config: WriteConfig,
    post_history: list,
    revenue_match: str,
    revenue_link: str = "",
    news_context: str = "",   # RAG: api_generate에서 주입
) -> dict:
    """Claude API를 통한 원고 생성 (Retry 3회 + 강건한 JSON 파서)"""
    await log_step(run_id, "WRITE", f"글 빌드 시작 — {keyword}")

    history_str = ""
    if post_history:
        history_str = "\n\n## 내부 링크 목록 (이 중에서만 3개 선택, 환각 금지)\n"
        for p in post_history:
            history_str += f"- [{p.get('title', '')}]({p.get('url', '')})\n"

    rev_str = ""
    if revenue_link:
        rev_str = f'\n\n수익 링크: <a href="{revenue_link}" class="revenue-link" rel="sponsored">[추천 상품 보기]</a> — 이 링크를 CTA 박스 내에 자연스럽게 삽입하세요.'

    system_prompt = build_system_prompt(persona, config, revenue_match, keyword, news_context)
    user_prompt   = f'키워드: "{keyword}"\n{history_str}{rev_str}\n\n위 키워드로 블로그 포스팅을 작성하세요. 반드시 JSON 형식으로만 응답하세요.'

    for attempt in range(RETRY_MAX):
        try:
            r = await http_client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key":         ANTHROPIC_API_KEY,
                    "anthropic-version":  "2023-06-01",
                    "content-type":       "application/json",
                },
                json={
                    "model":      MODEL_CLAUDE_HAIKU,
                    "max_tokens": 8192,
                    "system":     system_prompt,
                    "messages":   [{"role": "user", "content": user_prompt}],
                },
                timeout=120,
            )
            r.raise_for_status()
            raw    = r.json()["content"][0]["text"]
            result = _robust_parse_article(raw)

            # 필수 키 검증
            if not result.get("content"):
                raise ValueError("파싱된 content가 비어 있습니다")

            await log_step(run_id, "WRITE", f"드래프트 완료 [{MODEL_CLAUDE_HAIKU}]", "done")
            return result

        except Exception as e:
            wait = RETRY_BASE ** attempt + random.uniform(0, 1)
            logger.warning(f"원고 생성 시도 {attempt+1}/{RETRY_MAX} 실패 ({wait:.1f}초 후 재시도): {e}")
            if attempt == RETRY_MAX - 1:
                await log_step(run_id, "WRITE", f"드래프트 생성 실패: {e}", "error")
                return {
                    "title":   f"{keyword} 완벽 가이드",
                    "content": f"<p>원고 생성에 실패했습니다. 다시 시도해 주세요. (오류: {str(e)[:100]})</p>",
                    "tags":    [keyword],
                }
            await asyncio.sleep(wait)

# ────────────────────────────────────────────
# Gemini API — 이미지 키워드 추출
# ────────────────────────────────────────────
async def extract_image_keywords(
    run_id: str,
    title: str,
    content: str,
    current_content: str = "",   # 수정된 본문 (있으면 우선 사용)
) -> dict:
    """Gemini로 본문 분석 → 이미지 생성용 키워드 JSON 추출
    current_content가 있으면 수정된 본문 기준으로 재추출 (Context-Aware)
    """
    await log_step(run_id, "IMG_KW", "비주얼 키워드 추출 중")
    # 수정된 본문이 있으면 우선 사용 — Context-Aware Prompting
    source_content = current_content if current_content.strip() else content
    source_title   = title

    prompt = f"""다음 블로그 제목과 본문을 분석하여 이미지 생성에 필요한 키워드를 추출하세요.

제목: {source_title}
본문 (앞 500자): {source_content[:500]}

JSON 형식으로만 응답하세요:
{{
  "thumbnail": {{
    "blog_title": "{title}",
    "style_keyword": "스타일 키워드 (예: modern, warm, professional)",
    "main_phrase": "썸네일 메인 문구 (15자 이내 한국어)",
    "font_style": "bold sans-serif",
    "extra_keywords": ["키워드1", "키워드2"]
  }},
  "body_images": [
    {{
      "core_subject": "핵심 피사체",
      "detail_desc":  "상세 묘사",
      "background":   "배경 묘사"
    }}
  ],
  "alt_texts": ["이미지1 alt", "이미지2 alt", "이미지3 alt", "이미지4 alt", "이미지5 alt"]
}}
body_images는 본문 흐름에 맞게 5개 생성하세요."""

    for attempt in range(3):
        try:
            r = await http_client.post(
                f"{GEMINI_API_BASE}/{MODEL_GEMINI_FLASH}:generateContent?key={GEMINI_API_KEY}",
                json={"contents": [{"parts": [{"text": prompt}]}]},
                timeout=30,
            )
            if r.status_code != 200:
                raise RuntimeError(f"Gemini {r.status_code}: {r.text[:200]}")
            raw = r.json()["candidates"][0]["content"]["parts"][0]["text"]
            raw = re.sub(r"```json\s*|\s*```", "", raw).strip()
            result = json.loads(raw)
            await log_step(run_id, "IMG_KW", "비주얼 키워드 추출 완료", "done")
            return result
        except Exception as e:
            logger.warning(f"Gemini 키워드 추출 시도 {attempt+1}/3 실패: {e}")
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
    await log_step(run_id, "IMG_KW", "비주얼 키워드 추출 실패", "error")
    raise RuntimeError("Gemini 이미지 키워드 추출 실패 — API 키 및 모델 상태를 확인하세요")

# ────────────────────────────────────────────
# DALL-E 4 — 썸네일 생성
# ────────────────────────────────────────────
async def generate_thumbnail_dalle(run_id: str, kw_data: dict, keyword: str) -> list[str]:
    """DALL-E로 썸네일 2개 생성 → /static/generated/ 저장"""
    await log_step(run_id, "THUMB", "썸네일 렌더링 중")
    t   = kw_data.get("thumbnail", {})
    prompt = (
        f"A professional blog thumbnail for a post titled '{t.get('blog_title', keyword)}'. "
        f"The design should be {t.get('style_keyword', 'modern')}. "
        f"Place the text '{t.get('main_phrase', keyword)}' clearly in the center using a "
        f"{t.get('font_style', 'bold sans-serif')} font with high contrast against the background. "
        f"Ensure the text is accurately spelled in Korean. "
        f"Cinematic lighting, 16:9 aspect ratio, high resolution, 8k, minimalist but impactful."
    )
    today = datetime.now().strftime("%Y%m%d")
    saved = []

    for i in range(2):
        for attempt in range(3):
            try:
                r = await http_client.post(
                    "https://api.openai.com/v1/images/generations",
                    headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                    json={"model": "dall-e-3", "prompt": prompt, "n": 1, "size": "1792x1024"},
                    timeout=60,
                )
                r.raise_for_status()
                url = r.json()["data"][0]["url"]

                # 로컬 저장
                img_r = await http_client.get(url, timeout=60)
                fname = f"{today}_title_{keyword[:10]}_{i+1:02d}.png"
                fpath = STATIC_DIR / fname
                fpath.write_bytes(img_r.content)
                saved.append(f"/static/generated/{fname}")
                break
            except Exception as e:
                logger.warning(f"DALL-E 썸네일 {i+1} 시도 {attempt+1}/3 실패: {e}")
                if attempt == 2:
                    saved.append("")   # 빈 URL (스켈레톤 유지)

    await log_step(run_id, "THUMB", f"썸네일 {len([s for s in saved if s])}장 완료", "done")
    return saved

# ────────────────────────────────────────────
# DALL-E 4 — 본문 실사 이미지 병렬 생성 (asyncio.gather)
# ────────────────────────────────────────────
async def _generate_single_body_image(
    idx: int, bi: dict, keyword: str, alt: str, today: str
) -> dict:
    """단일 본문 이미지 생성 (Retry 3회) — 병렬 호출용"""
    prompt = (
        f"A high-end commercial photo of {bi.get('core_subject', keyword)}. "
        f"{bi.get('detail_desc', '')}. "
        f"Shot on 35mm lens, f/1.8, cinematic lighting, sharp focus, hyper-realistic textures. "
        f"Background is {bi.get('background', 'clean studio')}. "
        f"Professional studio lighting, 8k resolution, highly detailed."
    )
    for attempt in range(3):
        try:
            r = await http_client.post(
                "https://api.openai.com/v1/images/generations",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={"model": "dall-e-3", "prompt": prompt, "n": 1, "size": "1024x1024"},
                timeout=90,
            )
            r.raise_for_status()
            img_url = r.json()["data"][0]["url"]
            img_r   = await http_client.get(img_url, timeout=90)
            fname   = f"{today}_main_{keyword[:10]}_{idx+1:02d}.png"
            fpath   = STATIC_DIR / fname
            fpath.write_bytes(img_r.content)
            return {"url": f"/static/generated/{fname}", "alt": alt}
        except Exception as e:
            logger.warning(f"DALL-E 본문이미지 {idx+1} 시도 {attempt+1}/3 실패: {e}")
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
    return {"url": "", "alt": alt}


async def generate_body_images_dalle(run_id: str, kw_data: dict, keyword: str) -> list[dict]:
    """DALL-E 4로 본문 실사 이미지 5개 asyncio.gather 병렬 생성"""
    await log_step(run_id, "BODY_IMG", "본문 비주얼 병렬 렌더링 중 (5장)")
    body_items = kw_data.get("body_images", [])[:5]
    alt_texts  = kw_data.get("alt_texts", [])
    today      = datetime.now().strftime("%Y%m%d")

    tasks = [
        _generate_single_body_image(
            i, bi, keyword,
            alt_texts[i] if i < len(alt_texts) else f"{keyword} 이미지 {i+1}",
            today
        )
        for i, bi in enumerate(body_items)
    ]
    results = list(await asyncio.gather(*tasks, return_exceptions=False))
    success = len([r for r in results if r.get("url")])
    await log_step(run_id, "BODY_IMG", f"본문 비주얼 {success}/{len(tasks)}장 완료", "done")
    return results

# ────────────────────────────────────────────
# Gemini — 쇼핑 키워드 추출
# ────────────────────────────────────────────
async def extract_shopping_keywords(run_id: str, content: str) -> dict:
    """구매 퍼널 단계별 쇼핑 전용 명사 키워드 5개 + 타겟 상품 추천 (강화된 JSON 스키마)"""
    await log_step(run_id, "SHOP_KW", "쇼핑 인사이트 추출 중")
    prompt = f"""다음 블로그 본문을 분석하여 네이버 쇼핑 검색에 최적화된 키워드와 상품 정보를 추출하세요.

본문 (앞 1500자): {content[:1500]}

## 추출 규칙
- keywords: 반드시 구매 가능한 **상품명 또는 성분명 중심의 명사형** 키워드 5개
  (예: "오메가3 영양제", "프로바이오틱스 유산균", "마그네슘 보충제")
  (금지: "효능", "방법", "추천" 같은 정보성 단어)
- funnel_stage: 각 키워드의 구매 퍼널 단계 (awareness/interest/consideration/intent/loyalty)
- target_product: 본문 주제와 가장 연관성 높은 구체적 상품 1개 (브랜드+제품명 형태 권장)
- cpc_estimate: 예상 경쟁도 (low/medium/high)

JSON 형식으로만 응답 (백틱·설명 없이):
{{
  "keywords": [
    {{"keyword": "상품명 키워드1", "funnel_stage": "consideration", "cpc_estimate": "high"}},
    {{"keyword": "상품명 키워드2", "funnel_stage": "intent",        "cpc_estimate": "medium"}},
    {{"keyword": "상품명 키워드3", "funnel_stage": "awareness",     "cpc_estimate": "low"}},
    {{"keyword": "상품명 키워드4", "funnel_stage": "interest",      "cpc_estimate": "medium"}},
    {{"keyword": "상품명 키워드5", "funnel_stage": "loyalty",       "cpc_estimate": "low"}}
  ],
  "target_product": "구체적 상품명 (예: 종근당 오메가3 1000mg 120캡슐)",
  "category": "네이버 쇼핑 카테고리명",
  "search_volume_estimate": "월 예상 검색량 (예: 5만~10만)"
}}"""

    for attempt in range(3):
        try:
            r = await http_client.post(
                f"{GEMINI_API_BASE}/{MODEL_GEMINI_FLASH}:generateContent?key={GEMINI_API_KEY}",
                json={"contents": [{"parts": [{"text": prompt}]}]},
                timeout=30,
            )
            r.raise_for_status()
            raw = r.json()["candidates"][0]["content"]["parts"][0]["text"]
            raw = re.sub(r"```json\s*|\s*```", "", raw).strip()
            result = json.loads(raw)

            # 하위 호환: keywords 리스트를 flat string 배열로도 제공
            flat_keywords = [
                k["keyword"] if isinstance(k, dict) else k
                for k in result.get("keywords", [])
            ]
            result["keywords_flat"] = flat_keywords
            result["target_product"] = result.get("target_product", "")

            await log_step(run_id, "SHOP_KW", f"쇼핑 인사이트 {len(flat_keywords)}개 완료", "done")
            return result
        except Exception as e:
            logger.warning(f"쇼핑 키워드 추출 시도 {attempt+1}/3 실패: {e}")
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)

    await log_step(run_id, "SHOP_KW", "쇼핑 인사이트 추출 실패 — 스킵", "warn")
    return {"keywords": [], "keywords_flat": [], "target_product": "", "category": "", "search_volume_estimate": ""}

# ────────────────────────────────────────────
# Engagement 모듈 — 독립 컴포넌트 빌더
# ────────────────────────────────────────────
def _build_module_cta(keyword: str, revenue_link: str, target_product: str) -> str:
    """Module A: 심리적 트리거 CTA 박스"""
    product_label = target_product or f"{keyword} 추천 상품"
    link_tag = f'<a href="{revenue_link}" class="revenue-link" rel="sponsored" style="color:#fff;text-decoration:none;font-weight:700">→ {product_label} 최저가 확인</a>' if revenue_link else f'<span style="font-weight:700">{product_label} 검색 추천</span>'
    return f'''<div style="background:linear-gradient(135deg,#03C75A,#02a44c);border-radius:12px;padding:18px 22px;margin:20px 0;font-family:sans-serif;color:#fff">
<p style="font-size:13px;margin:0 0 4px;opacity:.85">⏰ 지금 이 순간만</p>
<p style="font-size:17px;font-weight:700;margin:0 0 10px">오늘 구매하면 가장 저렴해요</p>
<p style="font-size:13px;margin:0 0 14px;opacity:.9">재고 소진 시 가격이 오를 수 있어요. 지금 바로 확인해보세요.</p>
{link_tag}
</div>'''


async def _build_module_checklist(run_id: str, keyword: str, content: str) -> str:
    """
    Module B: 문맥 기반 동적 자가진단 체크리스트 (Gemini Flash 호출).
    도메인(행사/건강/IT/여행 등)을 정확히 파악하여 맞춤형 항목 5개를 생성한다.
    """
    await log_step(run_id, "ENGAGE", "체크리스트 모듈 생성 중")

    content_preview = re.sub(r"<[^>]+>", " ", content)[:500].strip()

    prompt = f"""다음 블로그 포스팅 주제를 분석하여, 독자의 공감과 관여도를 높일 수 있는 '자가진단 체크리스트' 항목 5가지를 생성하세요.

주제: {keyword}
본문 미리보기: {content_preview}

[엄격한 문맥 및 도메인 규칙]
1. 주제의 성격(도메인)을 가장 먼저 분류하고, 그에 맞는 질문을 생성하세요.
   - [행사/전시/축제] (예: 꽃박람회, 페스티벌): 방문 계획, 예매/할인 정보 탐색 여부, 주차/교통편 고민, 동반자(가족/연인) 유무 등 (절대 질환·증상·의사 상담 언급 금지)
   - [건강/영양제/질환]: 최근 겪은 증상, 관리 루틴, 제품 구매 경험, 전문가 상담 여부 등
   - [IT/가전/제품]: 기존 제품의 불편함, 새로운 기능 필요성, 가성비 고민 등
   - [여행/장소]: 일정 계획의 막막함, 핫플 탐색 여부, 동선 고민 등
   - 도메인에 어긋나는 항목 절대 금지
2. 각 항목은 독자가 "맞아, 나 이런 고민 했어!"라고 공감할 수 있는 15자 이내 간결한 의문문

JSON 배열만 출력 (다른 텍스트·설명 절대 금지):
["항목1", "항목2", "항목3", "항목4", "항목5"]"""

    try:
        r = await http_client.post(
            f"{GEMINI_API_BASE}/{MODEL_GEMINI_FLASH}:generateContent?key={GEMINI_API_KEY}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=20,
        )
        r.raise_for_status()
        raw   = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        raw   = re.sub(r"```json\s*|\s*```", "", raw).strip()
        items = json.loads(raw)

        if not items:
            return ""

        labels_html = "\n".join(
            f'<label style="display:block;margin:7px 0;font-size:14px;cursor:pointer">'
            f'<input type="checkbox" style="accent-color:#03C75A;margin-right:8px"> {item}</label>'
            for item in items[:5]
        )

        return f'''<div style="background:#f0faf4;border:1px solid #03C75A;border-radius:10px;padding:16px 20px;margin:16px 0;font-family:sans-serif">
<p style="font-weight:700;font-size:15px;margin:0 0 12px;color:#017a38">✔ {keyword} 자가진단 체크리스트</p>
{labels_html}
<p style="font-size:12px;color:#5e7062;margin:10px 0 0">3개 이상 체크 → 지금 바로 아래 내용을 꼼꼼히 읽어보세요!</p>
</div>'''

    except Exception as e:
        logger.warning(f"동적 체크리스트 생성 실패: {e}")
        return ""   # 실패 시 원본 원고 보호


async def _build_module_faq(run_id: str, keyword: str, content: str) -> str:
    """
    Module C: 문맥 기반 동적 FAQ 생성 (Gemini Flash 호출).
    본문 미리보기를 전달해 도메인(행사/제품/장소 등)을 정확히 인지하고
    주제에 맞는 롱테일 FAQ 3개를 생성한다.
    """
    await log_step(run_id, "ENGAGE", "FAQ 모듈 생성 중")

    content_preview = re.sub(r"<[^>]+>", " ", content)[:800].strip()

    prompt = f"""다음 블로그 포스팅 주제와 본문을 분석하여, 네이버 지식iN에서 실제 독자들이 가장 많이 검색할 법한 '롱테일 FAQ' 3가지를 생성하세요.

주제: {keyword}
본문 미리보기: {content_preview}

[엄격한 문맥 규칙]
1. 주제의 도메인(제품, 장소, 행사, 질환 등)을 정확히 파악하세요.
   - 행사/장소(예: 꽃 박람회, 전시회): 예매 방법, 주차 꿀팁, 관람 소요 시간, 주변 맛집 등
   - 제품/영양제/건강식품: 성분 비교, 섭취 기간, 주의사항 등
   - 의료/질환: 증상, 진단, 치료법 등
   - 도메인에 어긋나는 질문은 절대 금지 (행사인데 복용법, 장소인데 성분 등)
2. 질문(Q): 독자가 실제로 검색할 구체적 상황이 담긴 30자 이내 문장
3. 답변(A): 친근한 구어체(~해요, ~거든요)로 50자 이내 작성

JSON 배열만 출력 (다른 텍스트·설명 절대 금지):
[
  {{"q": "구체적인 질문 1", "a": "경험이 담긴 답변 1"}},
  {{"q": "구체적인 질문 2", "a": "경험이 담긴 답변 2"}},
  {{"q": "구체적인 질문 3", "a": "경험이 담긴 답변 3"}}
]"""

    try:
        r = await http_client.post(
            f"{GEMINI_API_BASE}/{MODEL_GEMINI_FLASH}:generateContent?key={GEMINI_API_KEY}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=20,
        )
        r.raise_for_status()
        raw  = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        raw  = re.sub(r"```json\s*|\s*```", "", raw).strip()
        faqs = json.loads(raw)

        faq_items = ""
        for i, faq in enumerate(faqs[:3]):
            q = faq.get("q", "")
            a = faq.get("a", "")
            if not q or not a:
                continue
            border_style = "border:1px solid #d0ddd2;border-radius:8px;padding:14px 18px;margin-bottom:10px;background:#fff"
            if i == len(faqs[:3]) - 1:
                border_style = border_style.replace("margin-bottom:10px;", "")
            faq_items += f'''
<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question" style="{border_style}">
  <p itemprop="name" style="font-weight:700;margin:0 0 8px;font-size:15px;color:#1a2a1e">Q. {q}</p>
  <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
    <p itemprop="text" style="color:#3d5442;font-size:14px;margin:0;line-height:1.7">A. {a}</p>
  </div>
</div>'''

        if not faq_items:
            return ""

        return f'''<div style="margin:24px 0;font-family:sans-serif" itemscope itemtype="https://schema.org/FAQPage">
<h3 style="font-size:17px;font-weight:700;margin:0 0 14px;color:#1a2a1e">❓ {keyword} 자주 묻는 질문 TOP 3</h3>
{faq_items.strip()}
</div>'''

    except Exception as e:
        logger.warning(f"동적 FAQ 생성 실패: {e}")
        return ""   # 실패 시 원본 원고 보호 — 빈 문자열 반환


async def _build_module_hashtags(run_id: str, keyword: str, content: str) -> tuple[list[str], str]:
    """
    Module D: 해시태그 30개 동적 생성 (Gemini Flash).
    - SEO + 네이버 블로그 검색 최적화 태그 30개 생성
    - (tags_list, hashtag_html) 튜플 반환
    """
    await log_step(run_id, "ENGAGE", "태그 30개 생성 중")

    content_preview = re.sub(r"<[^>]+>", " ", content)[:600].strip()

    prompt = f"""다음 블로그 포스팅의 주제와 본문을 분석하여, 네이버 블로그 SEO에 최적화된 해시태그를 정확히 30개 생성하세요.

주제: {keyword}
본문 미리보기: {content_preview}

[생성 규칙]
1. 메인 키워드(주제 직접 포함) 5개
2. 연관 키워드(주제와 밀접한 세부 주제) 10개
3. 롱테일 키워드(구체적 상황·특징 포함) 8개
4. 감성/공감 키워드(독자 감정·경험 유발) 4개
5. 계절·시기·트렌드 키워드 3개
- 각 태그는 # 없이 순수 텍스트만, 2~10자 사이
- 영문 혼용 허용, 공백 없이 작성

JSON 배열만 출력 (30개 정확히, 다른 텍스트 금지):
["태그1","태그2","태그3",...,"태그30"]"""

    try:
        r = await http_client.post(
            f"{GEMINI_API_BASE}/{MODEL_GEMINI_FLASH}:generateContent?key={GEMINI_API_KEY}",
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=20,
        )
        r.raise_for_status()
        raw  = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        raw  = re.sub(r"```json\s*|\s*```", "", raw).strip()
        tags = json.loads(raw)

        # 최대 30개, 빈 항목 제거
        tags = [t.strip().replace(" ", "").replace("#", "") for t in tags if t.strip()][:30]

        if not tags:
            return [], ""

        # 본문 하단 삽입용 HTML
        tag_links = " ".join(
            f'<a style="display:inline-block;background:#f0faf4;color:#017a38;border:1px solid #b2d8bf;'
            f'border-radius:20px;padding:4px 12px;font-size:13px;margin:3px 2px;text-decoration:none;'
            f'font-family:sans-serif">#{t}</a>'
            for t in tags
        )
        html = f'''<div style="margin:32px 0 8px;padding:20px;background:#f8fcfa;border-top:2px solid #03C75A;border-radius:0 0 10px 10px;font-family:sans-serif">
<p style="font-size:13px;color:#5e7062;font-weight:600;margin:0 0 10px">🏷️ 관련 태그 ({len(tags)}개)</p>
<div style="line-height:2">{tag_links}</div>
</div>'''

        await log_step(run_id, "ENGAGE", f"태그 {len(tags)}개 생성 완료", "done")
        return tags, html

    except Exception as e:
        logger.warning(f"해시태그 생성 실패: {e}")
        return [], ""


async def apply_engagement_modules(
    run_id: str,
    content_html: str,
    keyword: str,
    persona: Persona,
    style: str,
    cta_enabled: bool,
    revenue_link: str,
    shopping: dict,
) -> str:
    """
    Engagement 모듈 독립 주입 엔진.
    각 모듈 실패 시 원본 HTML 보호 — 전체 파이프라인 중단 없음.
    """
    await log_step(run_id, "ENGAGE", "콘텐츠 강화 모듈 주입 시작")
    result = content_html  # 원본 보호 기준점

    target_product = shopping.get("target_product", "")
    flat_keywords  = shopping.get("keywords_flat", shopping.get("keywords", []))
    kw_str         = ", ".join(
        k["keyword"] if isinstance(k, dict) else k
        for k in flat_keywords
    )

    # ── Module B: Checklist — 서론 첫 </p> 직후 삽입 ──
    try:
        checklist_html = await _build_module_checklist(run_id, keyword, result)
        if checklist_html and "</p>" in result:
            idx    = result.index("</p>") + len("</p>")
            result = result[:idx] + "\n" + checklist_html + result[idx:]
            await log_step(run_id, "ENGAGE", "Module B (Checklist) 삽입 완료")
    except Exception as e:
        logger.warning(f"Module B 삽입 실패 — 원본 유지: {e}")

    # ── Module A: CTA 박스 — 2번째 <h2> 직후 삽입 ──
    try:
        if cta_enabled:
            cta_html = _build_module_cta(keyword, revenue_link, target_product)
            h2_positions = [i for i in range(len(result)) if result[i:i+4] == "<h2>"]
            if len(h2_positions) >= 2:
                close_tag = result.find("</h2>", h2_positions[1])
                if close_tag != -1:
                    idx    = close_tag + len("</h2>")
                    result = result[:idx] + "\n" + cta_html + result[idx:]
                    await log_step(run_id, "ENGAGE", "Module A (CTA) 삽입 완료")
            elif h2_positions:
                close_tag = result.find("</h2>", h2_positions[0])
                if close_tag != -1:
                    idx    = close_tag + len("</h2>")
                    result = result[:idx] + "\n" + cta_html + result[idx:]
    except Exception as e:
        logger.warning(f"Module A 삽입 실패 — 원본 유지: {e}")

    # ── Module C: Long-tail FAQ — 본문 끝 직전 삽입 ──
    # Gemini로 본문 맥락을 분석해 도메인에 맞는 FAQ 동적 생성
    try:
        faq_html = await _build_module_faq(run_id, keyword, result)
        if faq_html:
            result = result.rstrip() + "\n" + faq_html
            await log_step(run_id, "ENGAGE", "Module C (FAQ) 삽입 완료")
        else:
            await log_step(run_id, "ENGAGE", "Module C FAQ 스킵 (빈 결과)", "warn")
    except Exception as e:
        logger.warning(f"Module C 삽입 실패 — 원본 유지: {e}")

    # ── 제품 비교표 (제품비교분석형 스타일만) ──
    # Claude API 호출로 정교한 비교표 생성
    if style == "제품비교분석형":
        try:
            compare_prompt = f"""다음 블로그 본문에 제품 비교표를 삽입하세요.

## 규칙
- 본문 내용 기반으로 3개 제품 비교 (성분·성능·가성비 수치화)
- 작성자 관점의 5점 평가 포함 (직업명 직접 언급 없이 경험에서 우러난 시선으로)
- inline-style HTML 표 형태
- 삽입 위치: 본문의 약 60% 지점 (글자 수 기준)
- 타겟 상품: {target_product}

원본 HTML:
{result[:3000]}

수정된 완성본 HTML만 반환 (코드블록 없이):"""
            r = await http_client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key":        ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type":      "application/json",
                },
                json={
                    "model":      MODEL_CLAUDE_HAIKU,
                    "max_tokens": 8192,
                    "messages": [{"role": "user", "content": compare_prompt}],
                },
                timeout=60,
            )
            r.raise_for_status()
            result = r.json()["content"][0]["text"].strip()
            await log_step(run_id, "ENGAGE", "벤치마크 비교표 삽입 완료")
        except Exception as e:
            logger.warning(f"제품 비교표 삽입 실패 — 원본 유지: {e}")

    await log_step(run_id, "ENGAGE", "콘텐츠 강화 완료", "done")

    # ── Module D: 해시태그 30개 — 본문 맨 끝 삽입 ──
    try:
        tags_list, hashtag_html = await _build_module_hashtags(run_id, keyword, result)
        if hashtag_html:
            result = result.rstrip() + "\n" + hashtag_html
    except Exception as e:
        logger.warning(f"Module D 삽입 실패 — 원본 유지: {e}")
        tags_list = []

    return _sanitize_content(result), tags_list


# 하위 호환 alias
async def enrich_engagement(
    run_id: str, content_html: str, keyword: str,
    persona: Persona, style: str, cta_enabled: bool,
    revenue_link: str, shopping: dict,
) -> tuple[str, list]:
    return await apply_engagement_modules(
        run_id, content_html, keyword, persona,
        style, cta_enabled, revenue_link, shopping
    )

# ────────────────────────────────────────────
# 백업 저장
# ────────────────────────────────────────────
def save_backup(run_id: str, keyword: str, title: str, content: str, tags: list, score: float) -> str:
    ts    = datetime.now().strftime("%Y%m%d_%H%M%S")
    fname = f"blog_{ts}.json"
    fpath = BACKUP_DIR / fname
    data  = {
        "run_id":        run_id,
        "created_at":    datetime.now().isoformat(),
        "keyword":       keyword,
        "title":         title,
        "content":       content,
        "tags":          tags,
        "revenue_score": score,
        "posted":        False,
    }
    fpath.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    global _excluded_cache
    _excluded_cache = (set(), 0.0)  # 새 포스팅 → 제외 키워드 캐시 무효화

    # 사람이 읽기 쉬운 txt
    txt_path = OUTPUT_DIR / f"blog_{ts}.txt"
    txt_path.write_text(
        f"제목: {title}\n태그: {' '.join('#'+t for t in tags)}\n\n{content}",
        encoding="utf-8"
    )
    return fname


# ════════════════════════════════════════════
# FastAPI App & Lifespan
# ════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client, pipeline_runs, revenue_log
    # 공유 HTTP 클라이언트 초기화
    http_client = httpx.AsyncClient(follow_redirects=True)
    # 영속화된 상태 복원
    if PIPELINE_RUNS_FILE.exists():
        try:
            pipeline_runs.update(json.loads(PIPELINE_RUNS_FILE.read_text(encoding="utf-8")))
            logger.info(f"pipeline_runs 복원: {len(pipeline_runs)}건")
        except Exception as e:
            logger.warning(f"pipeline_runs 로드 실패: {e}")
    if REVENUE_LOG_FILE.exists():
        try:
            revenue_log.extend(json.loads(REVENUE_LOG_FILE.read_text(encoding="utf-8")))
            logger.info(f"revenue_log 복원: {len(revenue_log)}건")
        except Exception as e:
            logger.warning(f"revenue_log 로드 실패: {e}")
    logger.info("Haru Studio Backend 시작")
    yield
    await http_client.aclose()
    logger.info("Haru Studio Backend 종료")

app = FastAPI(title="Haru Studio API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=str(WRITABLE_DIR / "static")), name="static")
app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR)), name="assets")

from fastapi import Request
from starlette.responses import JSONResponse

HARU_PASSWORD = os.environ.get("HARU_PASSWORD", "cozy1234")

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        token = auth_header.split(" ")[1]
        if token != HARU_PASSWORD:
            return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    response = await call_next(request)
    return response

@app.get("/api/verify")
async def api_verify():
    # Middleware already checked the token
    return {"ok": True}

@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIR / "index.html"))

# ────────────────────────────────────────────
# WebSocket — 실시간 로그 스트리밍
# ────────────────────────────────────────────
@app.websocket("/ws/pipeline")
async def ws_pipeline(ws: WebSocket):
    token = ws.query_params.get("token")
    if token != HARU_PASSWORD:
        await ws.close(code=1008)
        return
    await ws_manager.connect(ws)
    try:
        while True:
            await ws.receive_text()   # keep-alive ping
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)

# ────────────────────────────────────────────
# API 라우터
# ────────────────────────────────────────────
@app.get("/api/keywords/searchads")
async def api_searchads(seed: str):
    return await fetch_naver_searchads(seed)

@app.get("/api/keywords/datalab")
async def api_datalab():
    result = await fetch_naver_datalab()
    if not result:
        raise HTTPException(502, "DataLab API가 빈 결과를 반환했습니다")
    return result

@app.get("/api/keywords/excluded")
async def api_excluded():
    return list(get_excluded_keywords())

@app.post("/api/revenue/log")
async def api_revenue_log(entry: RevenueLogEntry):
    score = entry.value if entry.value > 0 else (80 if entry.event == "sale" else 60)
    revenue_log.append({
        "keyword": entry.keyword, "event": entry.event,
        "score": score, "ts": datetime.now().isoformat()
    })
    _persist_revenue_log()
    return {"ok": True}

@app.post("/api/generate")
async def api_generate(req: GenerateRequest, bg: BackgroundTasks):
    """
    Phase 1 — Text-First Pipeline
    이미지 생성 없이 원고·쇼핑키워드·Engagement 만 처리 → 빠른 응답
    이미지는 /api/generate/images 에서 On-Demand 처리
    """
    run_id = str(uuid.uuid4())
    pipeline_runs[run_id] = {
        "run_id": run_id, "status": "running", "step": "START",
        "created_at": datetime.now().isoformat(), "keyword": req.keyword,
        # 이미지 상태 초기화
        "images_status": "pending",
        "thumbnails":    [],
        "body_images":   [],
    }
    # StrategyManager: 현재 골든타임 자동 감지
    current_strategy = strategy_mgr.get_strategy_for_config(req.config)
    strategy_label   = current_strategy.get("label", "기본 전략")
    await log_step(run_id, "START",
        f"[Text-First | {strategy_label}] 글 빌드 시작 — {req.keyword}")

    try:
        # 1. Revenue Score
        score, match = calc_revenue_score(req.keyword)
        await log_step(run_id, "SCORE", f"Revenue Score: {score:.1f} ({match})")

        # 1-B. 실시간 뉴스 RAG 컨텍스트 수집 (Graceful Degradation)
        await log_step(run_id, "NEWS_RAG", f"뉴스 컨텍스트 수집 중 — {req.keyword}")
        try:
            news_context = await fetch_naver_news(req.keyword)
            if news_context:
                await log_step(run_id, "NEWS_RAG", "뉴스 팩트 주입 완료 (3건)", "done")
            else:
                await log_step(run_id, "NEWS_RAG", "뉴스 컨텍스트 없음 — 스킵", "warn")
        except Exception as e:
            news_context = ""
            await log_step(run_id, "NEWS_RAG", f"뉴스 수집 실패(스킵): {e}", "warn")

        # 2. 원고 생성 — news_context 주입
        # ▶ Claude Haiku + 실시간 뉴스 팩트 컨텍스트
        article = await generate_article(
            run_id, req.persona, req.keyword,
            req.config, req.post_history, match, req.revenue_link,
            news_context=news_context,
        )

        # article 방어 — 폴백 딕셔너리는 "content" 키가 없을 수 있음
        article_content = article.get("content", "")
        article_title   = article.get("title", req.keyword)
        article_tags    = article.get("tags", [])

        # 3. 쇼핑 키워드 추출 (Gemini 2.5 Flash) — 원고 완성 후 즉시 실행
        # ▶ Gemini Flash — JSON 구조화 추출 초고속
        shopping = await extract_shopping_keywords(run_id, article_content)

        # 4. Engagement 후처리 — effective_style 안전 계산 후 전달
        _strategy       = strategy_mgr.get_strategy_for_config(req.config)
        effective_style = (req.config.style or "").strip() or _strategy.get("style", "정보형")
        enriched_content, generated_tags = await enrich_engagement(
            run_id, article_content, req.keyword,
            req.persona, effective_style, req.config.cta_enabled,
            req.revenue_link, shopping,
        )

        # tags: Gemini 생성 30개 우선, 없으면 Claude 원고 태그 사용
        final_tags = generated_tags if generated_tags else article_tags

        # 5. 저장
        backup_fname = save_backup(
            run_id, req.keyword, article_title,
            enriched_content, final_tags, score
        )
        await log_step(run_id, "SAVE", f"드래프트 저장 완료: {backup_fname}", "done")

        pipeline_runs[run_id]["status"] = "text_done"
        _persist_pipeline_runs()
        await log_step(run_id, "TEXT_DONE",
            "✓ 글 빌드 완료 — [AI 이미지] 버튼으로 비주얼을 생성하세요", "done")

        return {
            "run_id":          run_id,
            "title":           article_title,
            "content":         enriched_content,
            "tags":            final_tags,
            "shopping":        shopping,
            "revenue_score":   score,
            "revenue_match":   match,
            "backup_file":     backup_fname,
            "thumbnails":      [],
            "body_images":     [],
            "images_status":   "pending",
        }

    except Exception as e:
        pipeline_runs[run_id]["status"] = "error"
        _persist_pipeline_runs()
        await log_step(run_id, "ERROR", f"빌드 오류: {str(e)[:200]}", "error")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/generate/images")
async def api_generate_images(req: ImageGenFromContentRequest):
    """
    Phase 3 — On-Demand Image Generation
    수정된 본문(current_content)을 Gemini에 재분석 → DALL-E 병렬 생성
    Context-Aware: 편집된 핵심 피사체 변경사항 자동 반영
    """
    run_id = req.run_id
    if run_id not in pipeline_runs:
        # run_id 없어도 이미지 생성 가능 (standalone)
        pipeline_runs[run_id] = {
            "run_id": run_id, "status": "img_running",
            "created_at": datetime.now().isoformat(),
            "keyword": req.keyword,
        }

    pipeline_runs[run_id]["images_status"] = "generating"
    await log_step(run_id, "IMG_START",
        "[On-Demand] 비주얼 생성 시작")

    try:
        # Gemini로 수정된 본문 재분석 — Context-Aware
        await log_step(run_id, "IMG_KW",
            "편집 내용 기반 비주얼 키워드 재추출 중...")
        img_kw = await extract_image_keywords(
            run_id,
            title           = req.current_title,
            content         = req.current_content,
            current_content = req.current_content,   # 수정 본문 우선 사용
        )

        # DALL-E 썸네일 2장 + 본문 이미지 5장 병렬 생성
        await log_step(run_id, "IMG_GEN", "비주얼 병렬 렌더링 중 (7장)...")
        thumb_task = asyncio.create_task(
            generate_thumbnail_dalle(run_id, img_kw, req.keyword)
        )
        body_task  = asyncio.create_task(
            generate_body_images_dalle(run_id, img_kw, req.keyword)
        )
        thumbnails, body_images = await asyncio.gather(thumb_task, body_task)

        # pipeline_runs 상태 갱신
        pipeline_runs[run_id]["images_status"] = "done"
        pipeline_runs[run_id]["thumbnails"]    = thumbnails
        pipeline_runs[run_id]["body_images"]   = body_images
        _persist_pipeline_runs()

        success_count = (
            len([u for u in thumbnails if u]) +
            len([i for i in body_images if i.get("url")])
        )
        await log_step(run_id, "IMG_DONE",
            f"✓ 비주얼 생성 완료 — {success_count}장 저장", "done")

        return {
            "run_id":      run_id,
            "thumbnails":  thumbnails,
            "body_images": body_images,
            "success":     success_count,
        }

    except Exception as e:
        pipeline_runs[run_id]["images_status"] = "error"
        _persist_pipeline_runs()
        await log_step(run_id, "IMG_ERROR",
            f"비주얼 생성 오류: {str(e)[:200]}", "error")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/strategy")
async def api_strategy():
    """현재 골든타임 전략 조회 — 프론트엔드 자동 전략 표시용"""
    mode = strategy_mgr.current_mode()
    return {
        "name":       mode.get("name", "default"),
        "label":      mode.get("label", "기본 전략"),
        "desc":       mode.get("desc", ""),
        "is_golden":  mode.get("is_golden", False),
        "style":      mode.get("style", ""),
        "tone":       mode.get("tone", ""),
        "chars":      mode.get("chars", 2000),
        "ad_strategy":mode.get("ad_strategy", ""),
        "model_mix": {
            "content":  MODEL_CLAUDE_HAIKU,
            "analysis": MODEL_GEMINI_FLASH,
        },
    }


@app.get("/api/pipeline/{run_id}")
async def api_pipeline_status(run_id: str):
    if run_id not in pipeline_runs:
        raise HTTPException(status_code=404, detail="run_id not found")
    return pipeline_runs[run_id]

@app.post("/api/image/generate")
async def api_image_gen(req: ImageGenRequest):
    """에디터 내 인라인 이미지 생성"""
    run_id = f"img_{uuid.uuid4().hex[:8]}"
    if req.image_type == "thumbnail":
        kw_data = {
            "thumbnail": {
                "blog_title":    req.title,
                "style_keyword": req.style_keyword,
                "main_phrase":   req.main_phrase,
                "font_style":    req.font_style,
            }
        }
        urls = await generate_thumbnail_dalle(run_id, kw_data, req.keyword)
        return {"urls": urls, "type": "thumbnail"}
    else:
        kw_data = {
            "body_images": [
                {"core_subject": req.keyword, "detail_desc": req.main_phrase, "background": "clean"}
            ],
            "alt_texts": [req.keyword],
        }
        imgs = await generate_body_images_dalle(run_id, kw_data, req.keyword)
        return {"urls": [i["url"] for i in imgs], "type": "body"}

@app.get("/api/backups")
async def api_backups():
    results = []
    for fp in sorted(BACKUP_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:20]:
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            results.append({
                "file":     fp.name,
                "keyword":  data.get("keyword", ""),
                "title":    data.get("title", ""),
                "posted":   data.get("posted", False),
                "created":  data.get("created_at", ""),
                "score":    data.get("revenue_score", 0),
            })
        except Exception:
            pass
    return results

@app.patch("/api/backups/{fname}/posted")
async def api_mark_posted(fname: str):
    safe_name = Path(fname).name          # 디렉터리 순회 차단
    if not safe_name.endswith(".json"):
        raise HTTPException(status_code=400)
    fpath = BACKUP_DIR / safe_name
    if not fpath.exists():
        raise HTTPException(status_code=404)
    data = json.loads(fpath.read_text(encoding="utf-8"))
    data["posted"] = True
    fpath.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


# ────────────────────────────────────────────
# 스마트 이미지 대시보드 API
# ────────────────────────────────────────────
@app.get("/api/images")
async def api_list_images():
    """static/generated + outputs/images 폴더의 이미지 목록 반환"""
    exts   = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    images = []

    def collect(folder: Path, category: str):
        if not folder.exists():
            return
        for fp in sorted(folder.rglob("*"), key=lambda x: x.stat().st_mtime, reverse=True):
            if fp.suffix.lower() in exts:
                rel = fp.relative_to(WRITABLE_DIR)
                images.append({
                    "url":      f"/static-file/{rel.as_posix()}",
                    "filename": fp.name,
                    "category": category,
                    "size":     fp.stat().st_size,
                    "mtime":    fp.stat().st_mtime,
                })

    collect(STATIC_DIR, "generated")
    collect(IMAGE_DIR,  "uploaded")
    return images[:100]   # 최대 100개


@app.post("/api/images/upload")
async def api_upload_image(file: "UploadFile"):
    """사용자 이미지 업로드 → outputs/images/ 저장"""
    from fastapi import UploadFile
    allowed = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(400, f"허용되지 않는 파일 형식: {ext}")
    today    = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe     = re.sub(r"[^\w\-.]", "_", Path(file.filename).stem)[:30]
    fname    = f"{today}_upload_{safe}{ext}"
    fpath    = IMAGE_DIR / fname
    content  = await file.read()
    if len(content) > 20 * 1024 * 1024:   # 20 MB 제한
        raise HTTPException(413, "파일이 너무 큽니다 (최대 20MB)")
    fpath.write_bytes(content)
    rel = fpath.relative_to(WRITABLE_DIR)
    return {"url": f"/static-file/{rel.as_posix()}", "filename": fname}


@app.get("/api/open-folder")
async def api_open_folder():
    """OS 파일 탐색기로 이미지 폴더 열기"""
    import subprocess, sys
    target = str(IMAGE_DIR)
    try:
        if sys.platform == "darwin":
            subprocess.Popen(["open", target])
        elif sys.platform == "win32":
            subprocess.Popen(["explorer", target])
        else:
            subprocess.Popen(["xdg-open", target])
        return {"ok": True, "path": target}
    except Exception as e:
        raise HTTPException(500, str(e))


# 업로드 이미지 정적 서빙 (WRITABLE_DIR 기준 상대 경로)
from fastapi.responses import FileResponse as _FileResponse
@app.get("/static-file/{path:path}")
async def serve_static_file(path: str):
    """outputs/images + static/generated 파일 서빙 (CORS 없는 동일 origin)"""
    fpath = WRITABLE_DIR / path
    # 경로 탈출 방지
    try:
        fpath.resolve().relative_to(WRITABLE_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "접근 불가")
    if not fpath.exists() or not fpath.is_file():
        raise HTTPException(404)
    return _FileResponse(str(fpath))

# ────────────────────────────────────────────
# 로컬 실행
# ────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    import threading
    import webbrowser
    import time

    PORT = 8000
    URL  = f"http://localhost:{PORT}"

    def open_browser():
        # 서버 준비 대기 후 크롬 실행
        time.sleep(1.5)
        try:
            # macOS Chrome
            import subprocess, sys
            if sys.platform == "darwin":
                subprocess.Popen(["open", "-a", "Google Chrome", URL])
            elif sys.platform == "win32":
                subprocess.Popen(["start", "chrome", URL], shell=True)
            else:
                subprocess.Popen(["google-chrome", URL])
        except Exception:
            # Chrome 없으면 기본 브라우저로 폴백
            webbrowser.open(URL)

    threading.Thread(target=open_browser, daemon=True).start()
    uvicorn.run("naver_blog_v01:app", host="0.0.0.0", port=PORT, reload=True)