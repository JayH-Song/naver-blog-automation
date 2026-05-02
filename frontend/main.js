  function doLogin() {
    const pwd = document.getElementById('login-pwd').value;
    if (!pwd) return;
    localStorage.setItem('haru_token', pwd);
    apiFetch('/api/verify').then(() => {
      document.getElementById('login-overlay').style.opacity = '0';
      setTimeout(() => document.getElementById('login-overlay').style.display = 'none', 300);
      connectWS(); // 웹소켓 토큰 갱신
    }).catch(() => {
      document.getElementById('login-err').style.display = 'block';
      localStorage.removeItem('haru_token');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('haru_token');
    if (token) {
      apiFetch('/api/verify').then(() => {
        document.getElementById('login-overlay').style.display = 'none';
      }).catch(() => {
        document.getElementById('login-overlay').style.display = 'flex';
      });
    }
  });

/* ─── 상태 관리 (localStorage 동기화) ─── */
const STATE_KEY = 'haru_studio_state';

const defaultState = {
  personas:           [null, null, null],
  selectedPersonaIdx: 0,
  selectedKeyword:    '',
  personalContext:    '',   // 키워드 관련 개인 관심사/경험
  style:              '정보 큐레이션',
  tone:               '친근하고 부드럽게',
  goldenTime:         'morning',
  personaColor:       '#2cc4a0',
  lastResult:         null,
  currentRunId:       null,
};

let S = { ...defaultState };

function loadState() {
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (saved) S = { ...defaultState, ...JSON.parse(saved) };
    // 구버전 S.persona → S.personas[0] 마이그레이션
    if (S.persona && (!S.personas || !S.personas.some(Boolean))) {
      S.personas = [S.persona, null, null];
    }
    if (!Array.isArray(S.personas) || S.personas.length !== 3)
      S.personas = [null, null, null];
    if (S.selectedPersonaIdx == null) S.selectedPersonaIdx = 0;
    delete S.persona;
  } catch(e) {}
}

function currentPersona() {
  return S.personas[S.selectedPersonaIdx] || null;
}

function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(S)); } catch(e) {}
}

/* ─── Tiptap 에디터 초기화 ─── */
let editor;
function _doInitEditor() {
  const extensions = [
    window['@tiptap/starter-kit'].StarterKit,
    window['@tiptap/extension-underline'].Underline,
    window['@tiptap/extension-image'].Image.configure({ HTMLAttributes: { class: 'editor-img' } }),
    window['@tiptap/extension-highlight'].Highlight,
    window['@tiptap/extension-link'].Link.configure({ openOnClick: false }),
  ];
  editor = new window['@tiptap/core'].Editor({
    element: document.getElementById('editor'),
    extensions,
    content: '<p>왼쪽에서 키워드를 선택하고 원고를 생성하세요 ✦</p>',
    editorProps: {
      attributes: { class: 'ProseMirror' },
    },
    onUpdate: () => { if (typeof updateSeoScore === 'function') updateSeoScore(); },
  });
}
function initEditor() {
  if (window['@tiptap/core'] && window['@tiptap/starter-kit']) {
    try {
      _doInitEditor();
      window.dispatchEvent(new Event('editor-ready'));
    } catch(e) {
      console.error('[initEditor]', e);
      const wrapper = document.getElementById('editor');
      if (wrapper) wrapper.innerHTML = '<p style="color:var(--red);padding:16px">⚠ 에디터 초기화 오류 — 콘솔을 확인하세요.</p>';
      if (typeof logTerm === 'function') logTerm('EDITOR', '에디터 초기화 실패', 'error');
    }
  } else {
    window.addEventListener('tiptap-loaded', () => {
      try {
        _doInitEditor();
        window.dispatchEvent(new Event('editor-ready'));
      } catch(e) {
        console.error('[initEditor]', e);
        const wrapper = document.getElementById('editor');
        if (wrapper) wrapper.innerHTML = '<p style="color:var(--red);padding:16px">⚠ 에디터 초기화 오류 — 콘솔을 확인하세요.</p>';
        if (typeof logTerm === 'function') logTerm('EDITOR', '에디터 초기화 실패', 'error');
      }
    }, { once: true });
    window.addEventListener('tiptap-load-error', () => {
      const wrapper = document.getElementById('editor');
      if (wrapper) wrapper.innerHTML = '<p style="color:var(--red);padding:16px">⚠ 에디터 로드 실패 — 인터넷 연결을 확인하고 새로고침하세요.</p>';
      if (typeof logTerm === 'function') logTerm('EDITOR', '에디터 모듈 로드 실패', 'error');
    }, { once: true });
  }
}

/* ─── Persona 관련 ─── */
function savePersona() {
  const job    = document.getElementById('p-job').value.trim();
  const age    = document.getElementById('p-age').value.trim();
  const career = document.getElementById('p-career').value.trim();
  const family = document.getElementById('p-family').value.trim();
  if (!job) { alert('직업을 입력해주세요'); return; }
  S.personas[S.selectedPersonaIdx] = { job, age, career, family, theme_color: S.personaColor };
  saveState();
  renderPersonaSlots();
  renderPersonaBadge();
  logTerm('PERSONA', `슬롯 ${S.selectedPersonaIdx + 1} 저장 완료 — ${job}`, 'done');
}

function savePersonaFromSlideover() {
  const cur = currentPersona() || {};
  S.personas[S.selectedPersonaIdx] = {
    job:         document.getElementById('so-job').value.trim()    || cur.job    || '',
    age:         document.getElementById('so-age').value.trim()    || cur.age    || '',
    career:      document.getElementById('so-career').value.trim() || cur.career || '',
    family:      document.getElementById('so-family').value.trim() || cur.family || '',
    theme_color: S.personaColor,
  };
  saveState();
  renderPersonaSlots();
  renderPersonaBadge();
  closeDrawer();
  logTerm('PERSONA', `슬롯 ${S.selectedPersonaIdx + 1} 업데이트 — ${S.personas[S.selectedPersonaIdx].job}`, 'done');
}

function renderPersonaBadge() {
  const p = currentPersona();
  if (!p) return;
  document.getElementById('persona-setup').style.display = 'none';
  const badge = document.getElementById('persona-badge');
  badge.style.display = 'block';
  badge.classList.remove('persona-fade');
  void badge.offsetWidth;              // reflow → 애니메이션 재트리거
  badge.classList.add('persona-fade');
  document.getElementById('badge-name').textContent = `${p.job} · ${p.age}`;
  document.getElementById('badge-meta').textContent = (p.career || '').slice(0, 40);
  applyPersonaColor(p.theme_color || S.personaColor);
}

function renderPersonaSlots() {
  const container = document.getElementById('persona-slots');
  if (!container) return;
  container.innerHTML = '';
  S.personas.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = [
      'persona-slot-btn',
      i === S.selectedPersonaIdx ? 'active' : '',
      !p ? 'empty' : '',
    ].join(' ').trim();
    btn.title = p ? p.job : '미설정';
    btn.innerHTML = `<i data-lucide="user"></i><span>${i + 1}</span>`;
    btn.onclick = () => selectPersonaSlot(i);
    container.appendChild(btn);
  });
  if (window.lucide) lucide.createIcons({ el: container });
}

function selectPersonaSlot(idx) {
  S.selectedPersonaIdx = idx;
  saveState();
  renderPersonaSlots();
  const p = currentPersona();
  if (p) {
    S.personaColor = p.theme_color || '#2cc4a0';
    renderPersonaBadge();
  } else {
    document.getElementById('persona-badge').style.display = 'none';
    document.getElementById('persona-setup').style.display = 'flex';
    ['p-job', 'p-age', 'p-career', 'p-family'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    applyPersonaColor('#2cc4a0');
  }
}

function setPersonaColor(color) {
  S.personaColor = color;
  applyPersonaColor(color);
  document.querySelectorAll('#so-colors .color-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.color === color);
  });
}

function selectInitColor(color, el) {
  S.personaColor = color;
  document.querySelectorAll('#p-colors .color-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  applyPersonaColor(color);
}

function applyPersonaColor(color) {
  document.documentElement.style.setProperty('--persona-accent', '#03C75A');
}

/* ─── 스마트 이미지 대시보드 ─── */

let _dashAllImages  = [];   // 전체 캐시
let _dashFilter     = 'all';

async function loadImageDashboard() {
  const grid = document.getElementById('img-dashboard-grid');
  if (!grid) return;
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:16px;color:var(--text2);font-size:13px">불러오는 중...</div>`;
  try {
    _dashAllImages = await apiFetch('/api/images');
    renderDashboard(_dashFilter);
    logTerm('DASH', `이미지 ${_dashAllImages.length}개 로드 완료`, 'done');
  } catch(e) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:14px;color:var(--red);font-size:13px">로드 실패: ${e.message}</div>`;
  }
}

function renderDashboard(filter) {
  _dashFilter = filter;
  const grid  = document.getElementById('img-dashboard-grid');
  const empty = document.getElementById('dashboard-empty');
  if (!grid) return;
  grid.innerHTML = '';

  const list = filter === 'all'
    ? _dashAllImages
    : _dashAllImages.filter(img => img.category === filter);

  if (!list.length) {
    const msg = document.createElement('div');
    msg.style.cssText = 'grid-column:1/-1;text-align:center;padding:20px;color:var(--text2);font-size:13px';
    msg.textContent = '이미지가 없습니다';
    grid.appendChild(msg);
    return;
  }

  list.forEach(img => {
    const card   = document.createElement('div');
    card.className = 'dash-img-card';
    card.dataset.url = img.url;
    card.dataset.cat = img.category;

    const catLabel = img.category === 'generated' ? 'AI' : '업로드';
    card.innerHTML = `
      <span class="dash-img-cat">${catLabel}</span>
      <img src="${img.url}" alt="${img.filename}"
           loading="lazy"
           onerror="this.style.display='none'"
           title="${img.filename}"/>
      <div class="dash-img-actions">
        <button class="dash-act-btn copy">📋 복사</button>
        <button class="dash-act-btn insert"><i data-lucide="download"></i> 다운</button>
      </div>`;
    card.querySelector('.dash-act-btn.copy').onclick =
      () => copyImageToClipboard(img.url, card);
    card.querySelector('img').onclick =
      () => downloadImage(img.url, img.filename);
    card.querySelector('.dash-act-btn.insert').onclick =
      () => downloadImage(img.url, img.filename);
    grid.appendChild(card);
  });
  if (window.lucide) lucide.createIcons({ el: grid });
}

function filterDashboard(filter, btn) {
  _dashFilter = filter;
  document.querySelectorAll('.img-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderDashboard(filter);
}

function insertImageFromDash(url, alt) {
  if (!editor) return;
  editor.chain().focus().setImage({ src: url, alt }).run();
  logTerm('DASH', `이미지 삽입: ${alt}`, 'done');
}

async function copyImageToClipboard(url, card) {
  // 동일 origin(/static-file/...)이므로 CORS 없이 fetch 가능
  try {
    card.classList.add('copying');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();

    // PNG로 변환 (ClipboardItem은 image/png 필요)
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const cv  = document.createElement('canvas');
      cv.width  = bmp.width;
      cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      pngBlob = await new Promise(res => cv.toBlob(res, 'image/png'));
    }

    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': pngBlob })
    ]);

    showCopyToast();
    logTerm('DASH', '이미지 클립보드 복사 완료 ✓', 'done');
  } catch(e) {
    logTerm('DASH', `클립보드 복사 실패: ${e.message}`, 'error');
    alert(`복사 실패: ${e.message}\n\n이미지를 우클릭 → "이미지 복사"를 이용하세요.`);
  } finally {
    setTimeout(() => card?.classList.remove('copying'), 800);
  }
}

function showCopyToast() {
  const toast = document.getElementById('img-copy-toast');
  if (!toast) return;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

async function openImageFolder() {
  try {
    const r = await apiFetch('/api/open-folder');
    logTerm('DASH', `폴더 열기: ${r.path}`, 'done');
  } catch(e) {
    logTerm('DASH', `폴더 열기 실패: ${e.message}`, 'error');
  }
}

async function uploadImages(files) {
  if (!files || files.length === 0) return;
  const progress     = document.getElementById('upload-progress');
  const progressBar  = document.getElementById('upload-progress-bar');
  const progressLabel= document.getElementById('upload-progress-label');
  progress.style.display = 'block';

  let done = 0;
  const total = files.length;

  for (const file of files) {
    progressLabel.textContent = `업로드 중... (${done+1}/${total}) ${file.name}`;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/images/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`${res.status}: ${err.slice(0,80)}`);
      }
      const data = await res.json();
      logTerm('DASH', `업로드 완료: ${data.filename}`, 'done');
    } catch(e) {
      logTerm('DASH', `업로드 실패 (${file.name}): ${e.message}`, 'error');
    }
    done++;
    progressBar.style.width = `${Math.round(done / total * 100)}%`;
  }

  progress.style.display = 'none';
  progressBar.style.width = '0%';

  // 파일 input 초기화
  const inp = document.getElementById('img-upload-input');
  if (inp) inp.value = '';

  // 갤러리 새로고침
  await loadImageDashboard();
}

/* ─── 테마 스위처 (Lume) ─── */
function setTheme(mode, save = true) {
  document.documentElement.setAttribute('data-theme', mode);
  if (save) localStorage.setItem('haru_theme', mode);
  ['dark','white','warm'].forEach(m => {
    const btn = document.getElementById('btn-' + m);
    if (!btn) return;
    if (m === mode) {
      btn.style.background  = 'var(--naver-greenbg)';
      btn.style.color       = 'var(--naver-green)';
      btn.style.borderColor = 'var(--naver-green)';
    } else {
      btn.style.background  = 'rgba(255,255,255,.04)';
      btn.style.color       = 'var(--text1)';
      btn.style.borderColor = 'transparent';
    }
  });
  document.documentElement.style.setProperty('--persona-accent', '#03C75A');
}

/* ─── Drawer / Adaptive Sheet 시스템 ─── */
function openDrawer(id) {
  const drawer   = document.getElementById(id);
  const backdrop = document.getElementById('drawer-backdrop');
  if (!drawer) return;
  // 다른 드로어 닫기
  document.querySelectorAll('.side-drawer.open').forEach(d => { if (d.id !== id) d.classList.remove('open'); });
  // 모바일 전략 패널 닫기
  document.getElementById('left')?.classList.remove('mobile-open');

  if (id === 'persona-drawer') {
    const p = currentPersona();
    document.getElementById('so-job').value    = p?.job    || '';
    document.getElementById('so-age').value    = p?.age    || '';
    document.getElementById('so-career').value = p?.career || '';
    document.getElementById('so-family').value = p?.family || '';
    const color = p?.theme_color || S.personaColor;
    document.querySelectorAll('#so-colors .color-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.color === color);
    });
  }

  drawer.classList.add('open');
  backdrop.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('open'));
  document.getElementById('left')?.classList.remove('mobile-open');
  document.getElementById('right')?.classList.remove('mobile-open');
  document.getElementById('drawer-backdrop')?.classList.remove('show');
  document.body.style.overflow = '';
  if (window.innerWidth <= 768) {
    document.querySelectorAll('.mobile-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.panel === 'center');
    });
  }
}

/* 기존 코드 호환 */
function openSlideover()  { openDrawer('persona-drawer'); }
function closeSlideover() { closeDrawer(); }

/* ─── Keyword 탭 ─── */
function setKwTab(tab) {
  ['ads','lab','manual'].forEach(t => {
    document.getElementById(`kw-${t}-panel`).style.display = t === tab ? 'block' : 'none';
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
  });
}

async function fetchAdsKeywords() {
  const seed = document.getElementById('seed-keyword').value.trim();
  if (!seed) return;
  logTerm('KW', `SearchAds 조회: ${seed}`);
  renderKwSkeletons();
  try {
    const res = await apiFetch(`/api/keywords/searchads?seed=${encodeURIComponent(seed)}`);
    logTerm('KW', `✓ 실시간 네이버 SearchAds 데이터 (${res.length}개)`, 'done');
    renderKeywordCards(res);
  } catch(e) {
    logTerm('KW', `SearchAds 오류: ${e.message}`, 'error');
  }
}

async function fetchDatalabKeywords() {
  logTerm('KW', 'DataLab 트렌드 로드 중...');
  renderKwSkeletons();
  try {
    const res = await apiFetch('/api/keywords/datalab');
    logTerm('KW', `✓ 실시간 네이버 DataLab 데이터 (${res.length}개)`, 'done');
    renderKeywordCards(res);
  } catch(e) {
    logTerm('KW', `DataLab 오류: ${e.message}`, 'error');
  }
}

function setManualKeyword() {
  const kw = document.getElementById('manual-keyword').value.trim();
  if (!kw) return;
  S.selectedKeyword = kw;
  saveState();
  renderKeywordCards([{ keyword: kw, revenue_score: 0, match_type: 'none', excluded: false }]);
  logTerm('KW', `수동 키워드 설정: ${kw}`, 'done');
  showPersonalContextSection(kw);
}

function renderKwSkeletons() {
  const container = document.getElementById('keyword-cards');
  container.innerHTML = Array(5).fill(0).map(() =>
    `<div class="kw-card" style="background:var(--bg3);height:38px;animation:shimmer 1.5s infinite"></div>`
  ).join('');
}

function renderKeywordCards(list) {
  const container  = document.getElementById('keyword-cards');
  const srcBadge   = document.getElementById('kw-source-badge');
  container.innerHTML = '';
  if (list.length > 0 && srcBadge) {
    srcBadge.style.display = 'block';
    srcBadge.innerHTML = '<span style="font-size:10px;color:var(--green);background:var(--naver-greenbg);padding:2px 8px;border-radius:4px">✓ 실시간 네이버 API</span>';
  }
  list.forEach(item => {
    const score = item.revenue_score || 0;
    const scoreClass = score >= 60 ? 'high' : score >= 40 ? 'medium' : '';
    const card = document.createElement('div');
    card.className = `kw-card${item.excluded ? ' excluded' : ''}${S.selectedKeyword === item.keyword ? ' selected' : ''}`;
    card.innerHTML = `
      <div class="kw-text">${item.keyword}</div>
      <div class="kw-score ${scoreClass}">${score.toFixed(0)}</div>
      ${item.match_type === 'exact' ? '<span style="font-size:10px;color:var(--amber)">★</span>' : ''}
      ${item.excluded ? '<span style="font-size:10px;color:var(--text2)">중복</span>' : ''}
    `;
    if (!item.excluded) {
      card.onclick = () => {
        document.querySelectorAll('.kw-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        S.selectedKeyword = item.keyword;
        updateRevenueScore(score, item.match_type);
        saveState();
        logTerm('KW', `키워드 선택: ${item.keyword} (Score: ${score})`, 'done');
        showPersonalContextSection(item.keyword);
      };
    }
    container.appendChild(card);
  });
}

function updateRevenueScore(score, match) {
  const scoreLabel = document.getElementById('rev-score-label');
  const barFill    = document.getElementById('rev-bar-fill');
  const badge      = document.getElementById('high-value-badge');
  if (scoreLabel) scoreLabel.textContent      = `Score ${score.toFixed(0)}`;
  if (barFill)    barFill.style.width         = `${Math.min(score, 100)}%`;
  if (badge)      badge.style.display         = score >= 60 ? 'inline-block' : 'none';
}

/** 원고 생성에 사용된 AI 모델명을 harvest-bar에 표시 */
function updateModelBadge(modelName) {
  const wrap  = document.getElementById('model-used-badge');
  const label = document.getElementById('model-used-label');
  if (!wrap || !label) return;
  if (!modelName) { wrap.style.display = 'none'; return; }

  // 모델명 → 짧은 레이블 매핑
  const SHORT = {
    'claude-3-5-sonnet-latest':        'Sonnet 3.5',
    'claude-haiku-4-5-20251001':       'Haiku 4.5',
    'gpt-4o':                          'GPT-4o',
    'gpt-4o-mini':                     'GPT-4o mini',
    'gemini-2.5-pro':                  'Gemini 2.5 Pro',
    'gemini-2.5-pro-preview-05-06':    'Gemini 2.5 Pro',
    'gemini-2.5-flash':                'Gemini 2.5 Flash',
    'gemini-2.5-flash-preview-04-17':  'Gemini 2.5 Flash',
  };
  const short = SHORT[modelName] || modelName;
  label.textContent = short;
  label.title       = modelName;   // 전체 모델명은 툴팁으로 확인 가능
  wrap.style.display = 'flex';
}

/* ─── Pill 선택 ─── */
function setPill(groupId, el) {
  document.querySelectorAll(`#${groupId} .pill`).forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  const val = el.dataset.val;
  if (groupId === 'style-pills')  S.style = val;
  if (groupId === 'tone-pills')   S.tone = val;
  if (groupId === 'gt-pills')     S.goldenTime = val;
  saveState();
}



/* ─── 메인 생성 파이프라인 ─── */
async function generate() {
  if (!currentPersona()) { alert('페르소나를 먼저 설정하세요'); return; }
  if (!S.selectedKeyword) { alert('키워드를 선택하세요'); return; }
  if (!editor) { alert('에디터가 초기화되지 않았습니다. 새로고침하세요.'); return; }

  const btn  = document.getElementById('gen-btn');
  const span = document.getElementById('gen-btn-text');
  btn.disabled = true;
  btn.classList.add('loading');
  span.textContent = '빌드 중...';
  setProgress(5);

  // 에디터에 스트리밍 시작 표시
  editor.commands.setContent(`<p class="stream-cursor"><strong>${S.selectedKeyword}</strong> 글을 빌드하고 있어요...</p>`);

  try {
    const personalCtx = (document.getElementById('personal-context-input')?.value || S.personalContext || '').trim();

    const payload = {
      persona:      currentPersona(),   // 현재 슬롯 데이터만 전송 (백엔드 단일 객체 형식 유지)
      keyword:      S.selectedKeyword,
      user_context: personalCtx,
      config: {
        style:       S.style,
        tone:        S.tone,
        golden_time: S.goldenTime,
      },
      post_history:  [],
    };

    logTerm('GEN', `글 빌드 시작 — ${S.selectedKeyword}`);
    if (personalCtx) logTerm('GEN', `개인 관심사 반영 — "${personalCtx.slice(0, 50)}${personalCtx.length > 50 ? '...' : ''}"`, 'done');
    setProgress(15);

    const result = await apiFetch('/api/generate', 'POST', payload, 180000);

    setProgress(90);

    // Phase 1 완료: 에디터에 원고 표시
    editor.commands.setContent(result.content || '');
    checkForbiddenWords();
    updateRevenueScore(result.revenue_score || 0, result.revenue_match || 'none');
    updateModelBadge(result.model_used || '');
    updateStatusBarModel(result.model_used || '');
    updateRagStatus(!!(result.news_context_used || result.rag_used));
    renderShoppingKw(result.shopping || {});
    setTimeout(updateSeoScore, 100);

    // run_id 저장 (Phase 3 이미지 생성에 사용)
    S.lastResult  = result;
    S.currentRunId = result.run_id;
    setArticleTitle(result.title || '');
    saveState();

    // 이미지 갤러리는 placeholder 유지
    document.getElementById('thumb-placeholder')?.style.setProperty('display', 'block');
    document.getElementById('body-placeholder')?.style.setProperty('display', 'block');

    // Phase 3 이미지 생성 버튼 활성화
    const imgBtn  = document.getElementById('img-gen-trigger-btn');
    const imgHint = document.getElementById('img-gen-hint');
    if (imgBtn)  { imgBtn.disabled = false; }
    if (imgHint) { imgHint.textContent = '편집 후 클릭하여 비주얼을 생성하세요'; }

    setProgress(100);
    logTerm('TEXT_DONE', `✓ 글 빌드 완료 — ${result.title?.slice(0,20)} | [AI 이미지] 버튼으로 비주얼 생성`, 'done');

    setTimeout(() => setProgress(0), 2000);

  } catch(e) {
    const msg = e.message || String(e) || '알 수 없는 오류';
    logTerm('ERROR', `생성 실패: ${msg}`, 'error');
    console.error('[generate] 오류:', e);
    console.error('[generate] 스택:', e.stack);
    if (editor) editor.commands.setContent(`<p style="color:var(--red);padding:16px">⚠ 오류: ${msg}</p>`);
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    span.textContent = '글 빌드하기';
  }
}

/* ─── Phase 3: On-Demand 이미지 생성 ─── */
async function triggerImageGeneration() {
  const runId   = S.currentRunId || S.lastResult?.run_id;
  const content = editor.getHTML();
  const title   = S.lastResult?.title || S.selectedKeyword || '';

  if (!runId && !content.trim()) {
    alert('먼저 글을 빌드하세요');
    return;
  }

  const imgBtn     = document.getElementById('img-gen-trigger-btn');
  const imgSpinner = document.getElementById('img-btn-spinner');
  const imgLabel   = document.getElementById('img-btn-label');
  const imgRetry   = document.getElementById('img-retry-btn');
  const imgHint    = document.getElementById('img-gen-hint');

  imgBtn.disabled          = true;
  imgSpinner.style.display = 'block';
  imgLabel.textContent     = '생성 중...';
  imgRetry.style.display   = 'none';

  // Optimistic UI: 스켈레톤 즉시 표시
  const tg = document.getElementById('thumb-gallery');
  const bg = document.getElementById('body-gallery');
  tg.innerHTML = Array(2).fill('<div class="gallery-skeleton"></div>').join('');
  bg.innerHTML = Array(5).fill('<div class="gallery-skeleton" style="height:72px;margin-bottom:6px"></div>').join('');

  logTerm('IMG_START', `[Phase 3] On-Demand 이미지 생성 시작 — 수정된 본문 반영`);

  try {
    const result = await apiFetch('/api/generate/images', 'POST', {
      run_id:          runId || `front_${Date.now()}`,
      current_content: content,
      current_title:   title,
      keyword:         S.selectedKeyword || '',
    }, 300000);

    renderThumbGallery(result.thumbnails || []);
    renderBodyGallery(result.body_images  || []);

    logTerm('IMG_DONE', `✓ 이미지 생성 완료 — ${result.success || 0}장 저장됨`, 'done');

    imgLabel.textContent     = '이미지 재생성';
    imgSpinner.style.display = 'none';
    imgBtn.disabled          = false;
    imgHint.textContent      = '';

    if (S.lastResult) {
      S.lastResult.thumbnails  = result.thumbnails;
      S.lastResult.body_images = result.body_images;
      saveState();
    }

  } catch(e) {
    logTerm('IMG_ERROR', `이미지 생성 실패: ${e.message}`, 'error');
    tg.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:14px;color:var(--red);font-size:13px">이미지 생성 실패</div>`;
    bg.innerHTML = '';
    imgRetry.style.display   = 'block';
    imgSpinner.style.display = 'none';
    imgLabel.textContent     = 'AI 이미지 생성';
    imgBtn.disabled          = false;
  }
}

/* ─── Personal Angle — 개인 관심사 입력 ─── */

function showPersonalContextSection(keyword) {
  const section = document.getElementById('personal-context-section');
  const prompt  = document.getElementById('personal-context-prompt');
  if (!section || !prompt) return;
  prompt.textContent = `"${keyword}"와 관련해서 어떤 개인적인 경험이나 관심사가 있으신가요? (선택사항)`;
  section.style.display = 'block';
  _updatePcBadge();
}

function savePersonalContext() {
  const val = (document.getElementById('personal-context-input')?.value || '').trim();
  S.personalContext = val;
  saveState();
  _updatePcBadge();
}

function skipPersonalContext() {
  const ta = document.getElementById('personal-context-input');
  if (ta) ta.value = '';
  S.personalContext = '';
  saveState();
  _updatePcBadge();
  document.getElementById('personal-context-section').style.display = 'none';
}

function _updatePcBadge() {
  const badge = document.getElementById('pc-active-badge');
  if (!badge) return;
  const ctx = S.personalContext?.trim();
  if (ctx) {
    badge.textContent = `✦ 개인 관심사 반영 중 — "${ctx.slice(0, 40)}${ctx.length > 40 ? '...' : ''}"`;
    badge.classList.add('visible');
  } else {
    badge.textContent = '';
    badge.classList.remove('visible');
  }
}

/* ─── 금지어 검사 ─── */
const FORBIDDEN = ['첫째','둘째','셋째','결론적으로','게다가','마지막으로','또한','따라서',
  '살펴보겠습니다','알아보겠습니다','도움이 될 수 있습니다','본 포스팅에서는'];

function checkForbiddenWords() {
  if (!editor) return;
  const text = editor.getText();
  const found = FORBIDDEN.filter(w => text.includes(w));
  if (found.length > 0) {
    logTerm('CHECK', `⚠ 검수 필요 — ${found.join(', ')}`, 'warn');
  } else {
    logTerm('CHECK', '원고 검수 완료 ✓', 'done');
  }
  return found.length === 0;
}

/* ─── 이미지 갤러리 ─── */
function renderThumbGallery(urls) {
  const gallery = document.getElementById('thumb-gallery');
  gallery.innerHTML = '';
  if (urls.length === 0) {
    gallery.innerHTML = `<div class="gallery-skeleton"></div><div class="gallery-skeleton"></div>`;
    return;
  }
  urls.forEach(url => {
    if (!url) {
      const sk = document.createElement('div');
      sk.className = 'gallery-skeleton';
      gallery.appendChild(sk);
      return;
    }
    const container = document.createElement('div');
    const img = document.createElement('img');
    img.className = 'gallery-img';
    img.src = url;
    img.alt = '썸네일';
    const btn = document.createElement('button');
    btn.className = 'img-insert-btn';
    btn.innerHTML = '<i data-lucide="download"></i> 이미지 다운';
    btn.onclick = () => downloadImage(url, _makeDownloadName('_thumb.png'));
    container.appendChild(img);
    container.appendChild(btn);
    gallery.appendChild(container);
  });
  if (window.lucide) lucide.createIcons({ el: gallery });
}

function renderBodyGallery(images) {
  const gallery = document.getElementById('body-gallery');
  gallery.innerHTML = '';
  images.forEach((item, i) => {
    const container = document.createElement('div');
    container.style.cssText = 'margin-bottom:8px';
    if (!item.url) {
      container.innerHTML = `<div class="gallery-skeleton" style="height:80px"></div>`;
    } else {
      const fname = _makeDownloadName(`_body${i + 1}.png`);
      const img   = document.createElement('img');
      img.src         = item.url;
      img.alt         = item.alt || '';
      img.className   = 'gallery-img';
      img.style.cssText = 'width:100%;height:80px;object-fit:cover;display:block;cursor:pointer';
      img.onclick     = () => downloadImage(item.url, fname);

      const btn       = document.createElement('button');
      btn.className   = 'img-insert-btn';
      btn.innerHTML   = '<i data-lucide="download"></i> 이미지 다운';
      btn.onclick     = () => downloadImage(item.url, fname);

      container.appendChild(img);
      container.appendChild(btn);
    }
    gallery.appendChild(container);
  });
  if (window.lucide) lucide.createIcons({ el: gallery });
}

function insertImage(url, alt) {
  if (!url) return;
  editor.chain().focus().setImage({ src: url, alt }).run();
  logTerm('IMG', `이미지 삽입: ${url.split('/').pop()}`, 'done');
}

function _makeDownloadName(suffix) {
  const raw = (S.lastResult?.title || S.selectedKeyword || 'image')
    .replace(/[\s/\\:*?"<>|]+/g, '_').slice(0, 30);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `haru_${raw}_${date}${suffix}`;
}

async function downloadImage(url, filename) {
  logTerm('IMG', `이미지 다운로드 시작 — ${filename}`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href     = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    logTerm('IMG', `✓ 다운로드 완료 — ${filename}`, 'done');
  } catch(e) {
    logTerm('IMG', `다운로드 실패: ${e.message}`, 'error');
  }
}


/* ─── 인라인 이미지 생성 ─── */
async function generateImage(type) {
  const prompt    = document.getElementById('img-prompt-input').value.trim();
  const keyword   = S.selectedKeyword || '건강';
  const title     = S.lastResult?.title || keyword;

  logTerm('IMG_GEN', `${type === 'thumbnail' ? '썸네일' : '본문'} 이미지 생성 중...`);

  // Optimistic UI: 스켈레톤 즉시 삽입
  const pos = editor.view.state.selection.from;
  editor.chain().focus().insertContent('<div class="img-skeleton"></div>').run();

  try {
    const result = await apiFetch('/api/image/generate', 'POST', {
      keyword, title,
      style_keyword: 'modern minimal',
      main_phrase:   prompt || title.slice(0, 15),
      font_style:    'bold sans-serif',
      image_type:    type,
    });

    if (result.urls && result.urls[0]) {
      if (type === 'thumbnail') {
        renderThumbGallery(result.urls);
      } else {
        const imgs = result.urls.map(u => ({ url: u, alt: keyword }));
        renderBodyGallery(imgs);
      }
      logTerm('IMG_GEN', `이미지 생성 완료 (${result.urls.filter(Boolean).length}개)`, 'done');
    }
  } catch(e) {
    logTerm('IMG_GEN', `이미지 생성 실패: ${e.message}`, 'error');
  }
}

/* ─── 쇼핑 키워드 렌더 ─── */
const FUNNEL_LABELS = ['인지','관심','고려','결정','재구매'];
function renderShoppingKw(shopping) {
  const list   = document.getElementById('shop-kw-list');
  const target = document.getElementById('target-product-area');
  if (!list || !target) return;
  list.innerHTML = '';
  target.innerHTML = '';

  if (shopping.target_product) {
    target.innerHTML = `<div class="target-product">🎯 추천 상품: <strong>${shopping.target_product}</strong></div>`;
  }
  if (shopping.category) {
    target.innerHTML += `<div style="font-size:11px;color:var(--text2);padding:4px 10px 0">${shopping.category}${shopping.search_volume_estimate ? ' · ' + shopping.search_volume_estimate : ''}</div>`;
  }

  // 백엔드가 객체 배열({keyword, funnel_stage, cpc_estimate})로 반환하는 경우와
  // 문자열 배열(keywords_flat) 모두 처리
  const rawKws = shopping.keywords || [];
  rawKws.forEach((kw, i) => {
    const kwText = (typeof kw === 'object') ? kw.keyword : kw;
    const stage  = (typeof kw === 'object') ? (kw.funnel_stage || FUNNEL_LABELS[i] || '') : (FUNNEL_LABELS[i] || '');
    const cpc    = (typeof kw === 'object' && kw.cpc_estimate) ? kw.cpc_estimate : '';
    const item   = document.createElement('div');
    item.className = 'shop-kw-item';
    item.innerHTML = `<span class="funnel">${stage}</span><span class="kw-text">${kwText}</span>${cpc ? `<span class="kw-cpc">${cpc}</span>` : ''}`;
    list.appendChild(item);
  });
}

/* ─── Engagement 블록 삽입 ─── */
function insertEngagementBlock(type) {
  const kw = S.selectedKeyword || '주제';
  const colors = ['#667eea,#764ba2', '#f093fb,#f5576c', '#4facfe,#00f2fe', '#43e97b,#38f9d7'];
  const gradient = colors[Math.floor(Math.random() * colors.length)];

  let html = '';
  if (type === 'checklist') {
    html = `<div style="background:rgba(93,141,238,.08);border:1px solid rgba(93,141,238,.3);border-radius:10px;padding:16px 20px;margin:16px 0;font-family:sans-serif">
<p style="font-weight:700;margin:0 0 12px;font-size:14px">✔ ${kw} 자가진단 체크리스트</p>
<label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox"> 1. 최근 1개월 내 관련 증상을 경험했나요?</label>
<label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox"> 2. 관련 제품을 구매한 경험이 있나요?</label>
<label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox"> 3. 전문가 상담을 받아본 적 있나요?</label>
<label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox"> 4. 정기적인 관리를 실천하고 있나요?</label>
<label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox"> 5. 가족 중 같은 고민을 가진 분이 있나요?</label>
</div>`;
  } else if (type === 'faq') {
    html = `<div style="margin:24px 0;font-family:sans-serif" itemscope itemtype="https://schema.org/FAQPage">
<h3 style="font-size:16px;font-weight:700;margin-bottom:12px">❓ 자주 묻는 질문</h3>
<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question" style="border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:14px;margin-bottom:8px">
<p itemprop="name" style="font-weight:600;margin:0 0 8px;font-size:13px">Q. ${kw}의 효과는 언제부터 나타나나요?</p>
<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text" style="color:#888;font-size:13px;margin:0">A. 개인차가 있지만, 보통 2~4주 꾸준히 실천하면 변화를 느끼기 시작하는 분들이 많아요.</p></div>
</div>
<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question" style="border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:14px;margin-bottom:8px">
<p itemprop="name" style="font-weight:600;margin:0 0 8px;font-size:13px">Q. ${kw} 시 주의해야 할 점은?</p>
<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text" style="color:#888;font-size:13px;margin:0">A. 전문가와 상담 후 자신의 상태에 맞게 적용하는 것이 가장 중요해요.</p></div>
</div>
<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question" style="border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:14px">
<p itemprop="name" style="font-weight:600;margin:0 0 8px;font-size:13px">Q. 비슷한 제품이 너무 많은데 어떻게 선택하나요?</p>
<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text" style="color:#888;font-size:13px;margin:0">A. 성분표를 꼭 확인하고, 인증 여부와 후기를 종합적으로 비교해보세요.</p></div>
</div>
</div>`;
  } else if (type === 'summary') {
    html = `<div style="background:linear-gradient(135deg,${gradient});border-radius:14px;padding:20px 24px;margin:24px 0;font-family:sans-serif">
<p style="font-size:13px;font-weight:700;color:#fff;margin:0 0 10px;opacity:.85">✦ 핵심 요약</p>
<ul style="margin:0;padding-left:18px;color:#fff;font-size:13px;line-height:1.9">
<li>${kw}에 대한 핵심 정보를 정리했어요</li>
<li>꾸준한 실천이 가장 중요하더라고요</li>
<li>전문가 상담을 병행하면 더욱 효과적이에요</li>
</ul>
</div>`;
  }

  editor.chain().focus().insertContent(html).run();
}

/* ─── Harvest Modal ─── */
let harvestChecks   = [false, false, false];
let manualOverrides = [false, false, false];

/* ─── 에디터 상단 제목 칸 ─── */
function setArticleTitle(title) {
  const el = document.getElementById('article-title-input');
  if (el) el.value = title || '';
}

function onArticleTitleInput(val) {
  if (S.lastResult) S.lastResult.title = val;
  // 모달 제목 칸도 동기화
  const modal = document.getElementById('harvest-title-input');
  if (modal) modal.value = val;
  reVerifyItem(2);   // idx 2 = 제목 SEO
  updateSeoScore();
}

async function copyArticleTitle() {
  const val = document.getElementById('article-title-input')?.value.trim();
  if (!val) { logTerm('HARVEST', '복사할 제목이 없습니다', 'warn'); return; }
  try {
    await navigator.clipboard.writeText(val);
  } catch(e) {
    const tmp = document.createElement('textarea');
    tmp.value = val;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
  }
  logTerm('HARVEST', `제목 복사 완료 — ${val.slice(0, 30)}`, 'done');
  _flashBtn('article-title-copy-btn');  // 버튼 피드백 재사용 불가(class이므로 직접 처리)
}

function onHarvestTitleInput(val) {
  if (S.lastResult) S.lastResult.title = val;
  // 에디터 상단 제목 칸도 동기화
  setArticleTitle(val);
  reVerifyItem(2);   // idx 2 = 제목 SEO
}

async function copyHarvestTitle() {
  const val = document.getElementById('harvest-title-input')?.value.trim();
  if (!val) return;
  try {
    await navigator.clipboard.writeText(val);
    logTerm('HARVEST', `제목 복사 완료 — ${val.slice(0, 30)}`, 'done');
  } catch(e) {
    const tmp = document.createElement('textarea');
    tmp.value = val;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
    logTerm('HARVEST', '제목 복사 완료 (fallback)', 'done');
  }
}

function autoVerifyHarvestChecks() {
  const html    = editor.getHTML();
  const keyword = (S.selectedKeyword || '').trim();

  // 파싱 실패 상태 감지 — 에러 content가 에디터에 있으면 모두 실패 처리
  if (html.includes('원고 파싱에 실패') || html.includes('글을 빌드하세요')) {
    return [false, false, false, false];
  }

  // 유효 원고 최소 길이 가드 (에러 메시지 수준의 짧은 content)
  const textLen = editor.getText().trim().length;
  if (textLen < 200) {
    return [false, false, false];
  }

  // 0: 금지 접속어 — checkForbiddenWords() 반환값 활용
  const r0 = !!checkForbiddenWords();

  // 1: FAQ / 핵심요약 — schema.org 마크업 또는 자가진단 체크리스트로만 판정
  const r1 = html.includes('schema.org/FAQPage')
    || html.includes('자가진단 체크리스트');

  // 2: 제목에 키워드 포함 여부
  // S.lastResult.title 우선 신뢰, 없으면 에디터 첫 h1/h2 텍스트로 판정
  const resultTitle   = S.lastResult?.title || '';
  const editorHeading = document.querySelector('.ProseMirror h1, .ProseMirror h2')?.textContent?.trim() || '';
  const titleSrc = resultTitle || editorHeading;
  const r2 = keyword ? titleSrc.includes(keyword) : false;

  return [r0, r1, r2];
}

function openHarvestModal() {
  if (!S.lastResult && !editor.getText().trim()) {
    alert('먼저 글을 빌드하세요');
    return;
  }
  document.getElementById('harvest-modal').classList.add('open');

  // 모달 제목 칸 — 에디터 상단 제목 칸 값 우선, 없으면 lastResult
  const titleInput = document.getElementById('harvest-title-input');
  if (titleInput) {
    const editorTitle = document.getElementById('article-title-input')?.value.trim();
    titleInput.value = editorTitle || S.lastResult?.title || '';
  }

  // 열릴 때마다 수동 확인 초기화
  manualOverrides = [false, false, false];

  // 자동 검증
  const results = autoVerifyHarvestChecks();
  harvestChecks = [...results];

  results.forEach((pass, idx) => {
    const item = document.querySelector(`.check-item[data-idx="${idx}"]`);
    if (!item) return;
    item.classList.remove('checked', 'failed', 'manual');
    item.classList.add(pass ? 'checked' : 'failed');
    const statusEl = item.querySelector('.check-status');
    if (statusEl) {
      if (pass) {
        statusEl.textContent = '자동 확인';
        statusEl.onclick     = null;
        statusEl.title       = '';
      } else {
        statusEl.textContent = '확인 필요';
        statusEl.onclick     = () => manualOverrideCheck(idx);
        statusEl.title       = '수동으로 확인 처리하려면 클릭하세요';
      }
    }
  });

  const summary = document.getElementById('harvest-summary');
  if (summary) summary.classList.add('visible');
  _updateHarvestSummary();
  _updateConfirmBtn();
}

function closeHarvestModal() {
  document.getElementById('harvest-modal').classList.remove('open');
  harvestChecks   = [false, false, false];
  manualOverrides = [false, false, false];
  const _ti = document.getElementById('harvest-title-input');
  if (_ti) _ti.value = '';
  document.querySelectorAll('.check-item').forEach(c => {
    c.classList.remove('checked', 'failed', 'manual');
    const s = c.querySelector('.check-status');
    if (s) { s.textContent = ''; s.onclick = null; s.title = ''; }
  });
  const summary = document.getElementById('harvest-summary');
  if (summary) { summary.textContent = ''; summary.classList.remove('visible'); }
  document.getElementById('confirm-copy-btn').disabled = true;
}

/* 항목 재검증 — fix 후 개별 항목 상태 갱신 */
function reVerifyItem(idx) {
  const results = autoVerifyHarvestChecks();
  harvestChecks[idx] = results[idx];
  // 자동 검증 통과 시 수동 확인도 자동 해제
  if (results[idx]) manualOverrides[idx] = false;

  const item = document.querySelector(`.check-item[data-idx="${idx}"]`);
  if (!item) return;
  item.classList.remove('checked', 'failed', 'manual');
  item.classList.add(results[idx] ? 'checked' : 'failed');
  const statusEl = item.querySelector('.check-status');
  if (statusEl) {
    if (results[idx]) {
      statusEl.textContent = '자동 확인';
      statusEl.onclick     = null;
      statusEl.title       = '';
    } else {
      statusEl.textContent = '확인 필요';
      statusEl.onclick     = () => manualOverrideCheck(idx);
      statusEl.title       = '수동으로 확인 처리하려면 클릭하세요';
    }
  }
  _updateHarvestSummary();
  _updateConfirmBtn();
}

/* ── 확인 버튼 활성화 조건 ── */
function _updateConfirmBtn() {
  const allDone = harvestChecks.every((v, i) => v || manualOverrides[i]);
  document.getElementById('confirm-copy-btn').disabled = !allDone;
}

/* ── 요약 텍스트 업데이트 ── */
function _updateHarvestSummary() {
  const autoCount   = harvestChecks.filter(Boolean).length;
  const manualCount = manualOverrides.filter(Boolean).length;
  const totalPassed = harvestChecks.reduce((acc, v, i) => acc + ((v || manualOverrides[i]) ? 1 : 0), 0);
  const summary = document.getElementById('harvest-summary');
  if (!summary) return;
  const total = harvestChecks.length;   // 항목 수 기준 — 배열 길이에서 자동 산출
  if (autoCount === 0 && manualCount === 0) {
    summary.textContent = '⚠ 원고 빌드 완료 후 다시 시도하세요';
    summary.style.color = 'var(--red)';
  } else if (totalPassed === total && manualCount === 0) {
    summary.textContent = `${total} / ${total} 자동 확인 완료`;
    summary.style.color = 'var(--emerald)';
  } else if (totalPassed === total) {
    summary.textContent = `${total} / ${total} 확인 완료 (수동 확인 ${manualCount}개 포함)`;
    summary.style.color = 'var(--amber)';
  } else {
    summary.textContent = `${totalPassed} / ${total} 확인 완료`;
    summary.style.color = 'var(--amber)';
  }
}

/* ── 수동 확인 토글 ── */
function manualOverrideCheck(idx) {
  manualOverrides[idx] = !manualOverrides[idx];
  const item = document.querySelector(`.check-item[data-idx="${idx}"]`);
  if (!item) return;
  const statusEl = item.querySelector('.check-status');
  if (manualOverrides[idx]) {
    item.classList.remove('failed');
    item.classList.add('manual');
    if (statusEl) {
      statusEl.textContent = '수동 확인';
      statusEl.title       = '클릭하면 수동 확인을 취소합니다';
      statusEl.onclick     = () => manualOverrideCheck(idx);
    }
  } else {
    item.classList.remove('manual');
    item.classList.add('failed');
    if (statusEl) {
      statusEl.textContent = '확인 필요';
      statusEl.title       = '수동으로 확인 처리하려면 클릭하세요';
      statusEl.onclick     = () => manualOverrideCheck(idx);
    }
  }
  _updateHarvestSummary();
  _updateConfirmBtn();
}

/* ── 개별 수정 함수 ── */

function _fix1_forbiddenWords() {
  const text = editor.getText();
  const found = FORBIDDEN.filter(w => text.includes(w));
  if (!found.length) { reVerifyItem(0); return; }

  // 텍스트 노드 내 금지어 제거.
  // 패턴: 태그 경계(>…<) 사이의 평문, 또는 태그에 감싸진 금지어(<tag>금지어</tag>)
  let html = editor.getHTML();
  found.forEach(w => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // ① 텍스트 노드 내 금지어 — > 와 < 사이
    html = html.replace(
      new RegExp(`(>)([^<]*)${escaped}([^<]*)(<)`, 'g'),
      (_, open, pre, post, close) => `${open}${pre}${post}${close}`
    );

    // ② 태그로 감싸진 금지어 — <tag ...>금지어</tag> 통째 제거
    html = html.replace(
      new RegExp(`<[^>]+>${escaped}</[^>]+>`, 'g'),
      ''
    );
  });

  editor.commands.setContent(html);
  logTerm('FIX', `금지 접속어 제거 완료 — ${found.join(', ')}`, 'done');
  reVerifyItem(0);   // idx 0 = 금지 접속어 항목
}

function _fix3_faqBlock() {
  const kw = S.selectedKeyword || '주제';
  const faqHtml = `
<div itemscope itemtype="https://schema.org/FAQPage" style="margin:32px 0;padding:24px;background:#f8f9fa;border-radius:10px;border:1px solid #e5e7eb;">
<h2 style="font-size:17px;font-weight:700;margin-bottom:16px;">❓ ${kw} 자주 묻는 질문 TOP 3</h2>
<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question" style="margin-bottom:14px;">
<h3 itemprop="name" style="font-size:14px;font-weight:600;margin-bottom:6px;">${kw}을(를) 처음 시작할 때 무엇부터 준비해야 할까요?</h3>
<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text" style="font-size:13px;color:#555;">기초 준비물과 방법을 여기에 입력하세요.</p></div>
</div>
<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question" style="margin-bottom:14px;">
<h3 itemprop="name" style="font-size:14px;font-weight:600;margin-bottom:6px;">${kw} 초보자가 가장 많이 하는 실수는 무엇인가요?</h3>
<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text" style="font-size:13px;color:#555;">흔한 실수와 해결 방법을 여기에 입력하세요.</p></div>
</div>
<div itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
<h3 itemprop="name" style="font-size:14px;font-weight:600;margin-bottom:6px;">${kw} 관련 비용이 얼마나 드나요?</h3>
<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text" style="font-size:13px;color:#555;">예상 비용 범위와 절약 팁을 여기에 입력하세요.</p></div>
</div>
</div>`;
  editor.commands.setContent(editor.getHTML() + faqHtml);
  logTerm('FIX', 'FAQ 블록(schema.org)을 원고 하단에 삽입했습니다 — 내용을 수정하세요', 'done');
  reVerifyItem(1);   // idx 1 = FAQ
}

function _fix4_seoTitle() {
  const keyword = S.selectedKeyword;
  if (!keyword) {
    logTerm('FIX', '키워드가 선택되지 않았습니다', 'warn');
    return;
  }
  // S.lastResult.title에 키워드가 이미 포함되어 있으면 에디터 수정 없이 통과
  if (S.lastResult?.title?.includes(keyword)) {
    reVerifyItem(2);   // idx 2 = 제목 SEO
    return;
  }
  let html = editor.getHTML();
  // H1 또는 H2 — 첫 번째 헤딩을 대상으로 처리
  const headMatch = html.match(/<(h1|h2)([^>]*)>([\s\S]*?)<\/\1>/i);
  if (!headMatch) {
    logTerm('FIX', '에디터에 H1/H2 제목이 없습니다 — 제목 줄을 먼저 추가하세요', 'warn');
    return;
  }
  const tag     = headMatch[1];
  const attrs   = headMatch[2];
  const curText = headMatch[3].replace(/<[^>]+>/g, '').trim();
  if (curText.includes(keyword)) {
    if (S.lastResult) S.lastResult.title = curText;
    reVerifyItem(2);   // idx 2 = 제목 SEO
    return;
  }
  const newTitle = `${keyword} — ${curText}`;
  html = html.replace(/<(h1|h2)([^>]*)>[\s\S]*?<\/\1>/i, `<${tag}${attrs}>${newTitle}</${tag}>`);
  editor.commands.setContent(html);
  if (S.lastResult) S.lastResult.title = newTitle;
  logTerm('FIX', `제목에 키워드를 삽입했습니다 — ${newTitle.slice(0, 40)}`, 'done');
  reVerifyItem(2);   // idx 2 = 제목 SEO
}

/* ── fixCheck 디스패처 ── */
function fixCheck(idx, e) {
  if (e) e.stopPropagation();
  switch (idx) {
    case 0: _fix1_forbiddenWords(); break;
    case 1: _fix3_faqBlock();       break;
    case 2: _fix4_seoTitle();       break;
  }
}

async function doHtmlCopy() {
  // 수동 확인 항목이 있으면 한 번 더 고지
  const _MANUAL_LABELS = ['금지 접속어', 'FAQ/요약', '제목 SEO'];
  const _skipped = manualOverrides.map((v, i) => v ? _MANUAL_LABELS[i] : null).filter(Boolean);
  if (_skipped.length > 0) {
    if (!confirm(`아래 항목은 자동 검증을 통과하지 못했으나 수동 확인 처리되었습니다:\n\n${_skipped.join('\n')}\n\n그래도 내보내시겠습니까?`)) return;
    logTerm('HARVEST', `수동 확인 포함 내보내기 — ${_skipped.join(', ')}`, 'warn');
  }
  try {
    const html    = editor.getHTML();
    const blob    = new Blob([html], { type: 'text/html' });
    const plain   = new Blob([editor.getText()], { type: 'text/plain' });
    const clipItem = new ClipboardItem({ 'text/html': blob, 'text/plain': plain });
    await navigator.clipboard.write([clipItem]);
    logTerm('HARVEST', '블로그 내보내기 완료 ✓ — 네이버 스마트에디터에 Ctrl+V', 'done');
    closeHarvestModal();
  } catch(e) {
    // Fallback
    const tmp = document.createElement('textarea');
    tmp.value = editor.getHTML();
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
    logTerm('HARVEST', '블로그 내보내기 완료 ✓ (fallback)', 'done');
    closeHarvestModal();
  }
}


const _CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

function _flashBtn(id) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const origHTML = btn.innerHTML;
  btn.innerHTML = `${_CHECK_SVG} 복사 완료`;
  btn.classList.add('btn-flash');
  setTimeout(() => {
    btn.innerHTML = origHTML;
    btn.classList.remove('btn-flash');
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
  }, 1800);
}

/* ─── Terminal ─── */
const STEP_PROGRESS = {START:5,SCORE:15,WRITE:30,IMG_KW:45,THUMB:55,BODY_IMG:65,SHOP_KW:70,ENGAGE:85,SAVE:95,DONE:100};

const STEP_TAGS = {
  GEN:       { label: 'BUILD',     cls: 'build'   },
  WRITE:     { label: 'BUILD',     cls: 'build'   },
  TEXT_DONE: { label: 'BUILD',     cls: 'build'   },
  START:     { label: 'BUILD',     cls: 'build'   },
  DONE:      { label: 'BUILD',     cls: 'build'   },
  SAVE:      { label: 'SAVE',      cls: 'system'  },
  IMG_START: { label: 'AI_AGENT',  cls: 'ai'      },
  IMG_KW:    { label: 'AI_AGENT',  cls: 'ai'      },
  IMG_GEN:   { label: 'AI_AGENT',  cls: 'ai'      },
  IMG_DONE:  { label: 'AI_AGENT',  cls: 'ai'      },
  IMG_ERROR: { label: 'AI_AGENT',  cls: 'ai'      },
  IMG:       { label: 'AI_AGENT',  cls: 'ai'      },
  THUMB:     { label: 'AI_AGENT',  cls: 'ai'      },
  BODY_IMG:  { label: 'AI_AGENT',  cls: 'ai'      },
  CHECK:     { label: 'SEO_AUDIT', cls: 'seo'     },
  SCORE:     { label: 'INSIGHT',   cls: 'insight' },
  KW:        { label: 'INSIGHT',   cls: 'insight' },
  ENGAGE:    { label: 'ENRICH',    cls: 'enrich'  },
  SHOP_KW:   { label: 'ENRICH',    cls: 'enrich'  },
  HARVEST:   { label: 'PUBLISH',   cls: 'publish' },
  PERSONA:   { label: 'SYSTEM',    cls: 'system'  },
  SYSTEM:    { label: 'SYSTEM',    cls: 'system'  },
  DASH:      { label: 'DASH',      cls: 'system'  },
  EDITOR:    { label: 'SYSTEM',    cls: 'system'  },
  LOG:       { label: 'SYSTEM',    cls: 'system'  },
  REVENUE:   { label: 'REVENUE',   cls: 'revenue' },
  NEWS_RAG:  { label: 'RAG',       cls: 'rag'     },
  ERROR:     { label: 'ERROR',     cls: 'error'   },
  JS_ERR:    { label: 'ERROR',     cls: 'error'   },
};

function toggleTerminal() {
  const term  = document.getElementById('terminal');
  const badge = document.getElementById('log-unread-badge');
  const isOpen = term.classList.toggle('log-open');
  if (isOpen && badge) badge.classList.remove('show');
}

function logTerm(step, msg, status = '') {
  const log  = document.getElementById('term-log');
  const line = document.createElement('div');
  line.className = 'log-line';
  const ts      = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const tagInfo = STEP_TAGS[step] || { label: step, cls: 'default' };
  const dotCls  = status || 'running';
  line.innerHTML = `
    <span class="log-ts">${ts}</span>
    <span class="log-tag log-tag-${tagInfo.cls}">${tagInfo.label}</span>
    <span class="log-status-dot ${dotCls}"></span>
    <span class="log-msg ${status}">${msg}</span>
  `;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;

  // 패널이 닫혀 있으면 뱃지 표시
  const term = document.getElementById('terminal');
  if (!term?.classList.contains('log-open')) {
    document.getElementById('log-unread-badge')?.classList.add('show');
  }

  if (STEP_PROGRESS[step]) setProgress(STEP_PROGRESS[step]);
}

function clearTerminal() {
  document.getElementById('term-log').innerHTML = '';
}

function setProgress(pct) {
  const el = document.getElementById('progress-fill');
  if (el) el.style.width = `${pct}%`;
}

/* ─── WebSocket 연결 ─── */
let ws;
function connectWS() {
  if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  const token = localStorage.getItem('haru_token') || '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/pipeline?token=${token}`);
  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      logTerm(data.step || 'LOG', data.msg || '', data.status || '');

      // ── 실시간 모델 배지 업데이트 ─────────────────────────────────
      if (data.step === 'WRITE') {
        const msg = data.msg || '';

        // "[N/6] PROVIDER / model-name 시도 중…" 패턴 → 해당 모델 즉시 표시
        const tryMatch = msg.match(/\[\d+\/\d+\]\s+\S+\s+\/\s+(.+?)\s+시도 중/);
        if (tryMatch) {
          updateModelBadge(tryMatch[1].trim());
        }

        // "드래프트 완료 [model-name]" 패턴 → 최종 확정 모델 표시
        const doneMatch = msg.match(/드래프트 완료\s+\[(.+?)\]/);
        if (doneMatch) {
          updateModelBadge(doneMatch[1].trim());
        }
      }
    } catch(e) {}
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

/* ─── API 헬퍼 ─── */
async function apiFetch(url, method = 'GET', body = null, timeout = 30000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeout);
  const token = localStorage.getItem('haru_token') || '';
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body:    body ? JSON.stringify(body) : undefined,
      signal:  ctrl.signal,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
    }
    return await res.json();
  } catch(e) {
    if (e.name === 'AbortError') throw new Error(`요청 시간 초과 (${timeout/1000}초)`);
    if (e.message === 'Failed to fetch') throw new Error('백엔드 연결 실패 — http://localhost:8000 접속 확인');
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

/* ─── Mobile 탭 (Bottom Sheet) ─── */
function showMobileTab(panel) {
  document.querySelectorAll('.mobile-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.panel === panel);
  });

  const left  = document.getElementById('left');
  const right = document.getElementById('right');

  if (panel === 'left') {
    document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('open'));
    right?.classList.remove('mobile-open');
    const isOpen = !left.classList.contains('mobile-open');
    left.classList.toggle('mobile-open', isOpen);
    document.getElementById('drawer-backdrop').classList.toggle('show', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  } else if (panel === 'right') {
    document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('open'));
    left?.classList.remove('mobile-open');
    const isOpen = !right.classList.contains('mobile-open');
    right.classList.toggle('mobile-open', isOpen);
    document.getElementById('drawer-backdrop').classList.toggle('show', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  } else if (panel === 'center') {
    left?.classList.remove('mobile-open');
    right?.classList.remove('mobile-open');
    closeDrawer();
    if (editor) setTimeout(() => editor.commands.focus(), 100);
  } else if (panel === 'images') {
    left?.classList.remove('mobile-open');
    right?.classList.remove('mobile-open');
    openDrawer('image-drawer');
  }
}

/* ─── 바텀시트 스와이프 다운 해제 (공통) ─── */
function attachSwipeToDismiss(el) {
  if (!el) return;
  let startY = 0, lastY = 0, dragging = false;

  el.addEventListener('touchstart', e => {
    if (el.scrollTop > 0) return;
    startY = lastY = e.touches[0].clientY;
    dragging = true;
    el.style.setProperty('transition', 'transform 0s', 'important');
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!dragging) return;
    lastY = e.touches[0].clientY;
    const dy = lastY - startY;
    if (dy > 0 && el.scrollTop === 0) {
      el.style.setProperty('transform', `translateY(${Math.min(dy, 280)}px)`, 'important');
    } else {
      dragging = false;
      el.style.removeProperty('transform');
      el.style.removeProperty('transition');
    }
  }, { passive: true });

  function finishSwipe() {
    if (!dragging) return;
    dragging = false;
    el.style.removeProperty('transform');
    el.style.removeProperty('transition');
    if (lastY - startY > 80) closeDrawer();
  }

  el.addEventListener('touchend', finishSwipe);
  el.addEventListener('touchcancel', () => {
    dragging = false;
    el.style.removeProperty('transform');
    el.style.removeProperty('transition');
  });
}

attachSwipeToDismiss(document.getElementById('left'));
attachSwipeToDismiss(document.getElementById('image-drawer'));
attachSwipeToDismiss(document.getElementById('persona-drawer'));

/* ─── ESC 키로 드로어/패널 닫기 ─── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDrawer();
});

/* ─── 전역 에러 캐치 (디버깅용) ─── */
window.addEventListener('error', (e) => {
  if (typeof logTerm === 'function') {
    logTerm('JS_ERR', `${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`, 'error');
  }
  console.error('[Global JS Error]', e);
});
window.addEventListener('unhandledrejection', (e) => {
  if (typeof logTerm === 'function') {
    logTerm('JS_ERR', `Unhandled Promise: ${e.reason?.message || e.reason}`, 'error');
  }
  console.error('[Unhandled Promise]', e);
});

/* ─── 초기화 ─── */
document.addEventListener('DOMContentLoaded', () => {
  loadState();
  initEditor();
  connectWS();

  // 저장된 상태 복원 (editor 불필요한 항목)
  renderPersonaSlots();
  if (currentPersona()) renderPersonaBadge();
  else if (S.personaColor) applyPersonaColor(S.personaColor);

  if (S.style) {
    document.querySelectorAll('#style-pills .pill').forEach(p => {
      p.classList.toggle('active', p.dataset.val === S.style);
    });
  }
  if (S.tone) {
    document.querySelectorAll('#tone-pills .pill').forEach(p => {
      p.classList.toggle('active', p.dataset.val === S.tone);
    });
  }
  if (S.goldenTime) {
    document.querySelectorAll('#gt-pills .pill').forEach(p => {
      p.classList.toggle('active', p.dataset.val === S.goldenTime);
    });
  }
  // 개인 관심사 복원
  if (S.personalContext) {
    const ta = document.getElementById('personal-context-input');
    if (ta) ta.value = S.personalContext;
  }
  if (S.selectedKeyword) {
    showPersonalContextSection(S.selectedKeyword);
  }


  // 테마 복원 (editor 불필요)
  const savedTheme = localStorage.getItem('haru_theme') || 'dark';
  setTheme(savedTheme, false);

  // ── editor 복원은 에디터 초기화 완료 후 실행 ──
  // initEditor()가 비동기(CDN 대기) 일 수 있으므로 'editor-ready' 이벤트 후 처리
  function restoreEditorContent() {
    if (!editor) return;
    if (S.lastResult?.content) {
      editor.commands.setContent(S.lastResult.content);
      setArticleTitle(S.lastResult.title || '');
      renderShoppingKw(S.lastResult.shopping || {});
      updateRevenueScore(S.lastResult.revenue_score || 0, S.lastResult.revenue_match || 'none');
      updateModelBadge(S.lastResult.model_used || '');
      if (S.lastResult.thumbnails?.length || S.lastResult.body_images?.length) {
        renderThumbGallery(S.lastResult.thumbnails || []);
        renderBodyGallery(S.lastResult.body_images  || []);
      } else {
        const imgBtn  = document.getElementById('img-gen-trigger-btn');
        const imgHint = document.getElementById('img-gen-hint');
        if (imgBtn)  imgBtn.disabled = false;
        if (imgHint) imgHint.textContent = '편집 후 클릭하여 이미지를 생성하세요';
      }
    }
    logTerm('SYSTEM', 'Haru Studio 초기화 완료', 'done');
    if (window.lucide) lucide.createIcons();

    // Cursor lume tracking — rAF throttle으로 Layout Thrashing 방지
    // getBoundingClientRect()는 rAF 내부에서 한 번만 실행, 스타일 쓰기도 동일 프레임에 묶음
    let _lumeRafId = null;
    let _lumeX = 0, _lumeY = 0, _lumeBtn = null;
    document.addEventListener('mousemove', (e) => {
      const btn = e.target.closest('.btn-sm, .harvest-btn, #gen-btn');
      _lumeBtn = btn || null;
      _lumeX   = e.clientX;
      _lumeY   = e.clientY;
      if (_lumeRafId) return;          // 이미 예약된 프레임이 있으면 스킵
      _lumeRafId = requestAnimationFrame(() => {
        _lumeRafId = null;
        if (!_lumeBtn) return;
        const r = _lumeBtn.getBoundingClientRect();   // read
        _lumeBtn.style.setProperty('--bx', ((_lumeX - r.left) / r.width  * 100).toFixed(1) + '%');  // write
        _lumeBtn.style.setProperty('--by', ((_lumeY - r.top)  / r.height * 100).toFixed(1) + '%');  // write
      });
    });

    // 이미지 대시보드 자동 로드
    loadImageDashboard().catch(() => {});
  }

  // editor가 이미 준비됐으면 즉시 실행, 아니면 이벤트 대기
  if (editor) {
    restoreEditorContent();
  } else {
    window.addEventListener('editor-ready', restoreEditorContent, { once: true });
  }
});

/* ════════════════════════════════════════════════════
   [A] Collapsible Sidebars
   ════════════════════════════════════════════════════ */
const _sidebarState = { left: false, right: false };

function toggleSidebar(side) {
  const panel  = document.getElementById(side);
  const icon   = document.getElementById(`${side}-toggle-icon`);
  if (!panel) return;

  _sidebarState[side] = !_sidebarState[side];
  const collapsed = _sidebarState[side];
  panel.classList.toggle('sidebar-collapsed', collapsed);

  // 아이콘 교체
  if (icon) {
    icon.setAttribute('data-lucide',
      collapsed
        ? (side === 'left' ? 'panel-left-open' : 'panel-right-open')
        : (side === 'left' ? 'panel-left-close' : 'panel-right-close')
    );
    if (window.lucide) lucide.createIcons();
  }

  // 미니 레이블 업데이트
  const miniText = document.getElementById(`${side}-mini-text`);
  if (miniText) {
    miniText.textContent = side === 'left'
      ? (S.selectedKeyword || '키워드 없음')
      : (S.style || 'Custom');
  }
}

/* ════════════════════════════════════════════════════
   [B] Editor Status Bar
   ════════════════════════════════════════════════════ */
function updateSeoScore() {
  const fill  = document.getElementById('seo-gauge-fill');
  const value = document.getElementById('seo-score-value');
  if (!fill || !value || !editor) return;

  const title   = (document.getElementById('article-title-input')?.value || '').trim();
  const content = editor.getText() || '';
  const kw      = (S.selectedKeyword || '').trim();

  let score = 0;
  if (title)                              score += 15;
  if (kw && title.includes(kw))           score += 25;
  if (content.length >= 2000)             score += 25;
  else if (content.length >= 1000)        score += 15;
  if (/faq|자주\s*묻는\s*질문/i.test(editor.getHTML())) score += 20;
  if (content.length >= 500)              score += 15;

  const pct = Math.min(score, 100);
  fill.style.width = pct + '%';
  value.textContent = pct;

  fill.classList.remove('mid', 'low');
  if (pct < 40)      fill.classList.add('low');
  else if (pct < 70) fill.classList.add('mid');
}

function updateStatusBarModel(modelName) {
  const dot  = document.getElementById('ai-status-dot');
  const name = document.getElementById('ai-model-name-status');
  if (!dot || !name) return;
  if (!modelName) {
    dot.classList.remove('active');
    name.textContent = 'AI 대기중';
    return;
  }
  const SHORT = {
    'claude-haiku-4-5-20251001':       'Haiku 4.5',
    'claude-3-5-sonnet-latest':        'Sonnet 3.5',
    'gemini-2.5-flash':                'Gemini Flash',
    'gemini-2.5-flash-preview-04-17':  'Gemini Flash',
    'gemini-2.5-pro':                  'Gemini Pro',
  };
  dot.classList.add('active');
  name.textContent = SHORT[modelName] || modelName;
}

function updateRagStatus(used) {
  const item = document.getElementById('rag-status-item');
  if (item) item.style.display = used ? 'flex' : 'none';
}

/* ════════════════════════════════════════════════════
   [C] Shopping renderShoppingKw — funnel badges + gauge
   ════════════════════════════════════════════════════ */
const FUNNEL_CLASS = {
  awareness:     'funnel-awareness',
  interest:      'funnel-interest',
  consideration: 'funnel-consideration',
  intent:        'funnel-intent',
  loyalty:       'funnel-loyalty',
};

function _funnelBadge(stage) {
  const s     = (stage || '').toLowerCase();
  const cls   = FUNNEL_CLASS[s] || 'funnel-default';
  const label = { awareness:'인지', interest:'관심', consideration:'검토', intent:'구매', loyalty:'충성' }[s] || stage || '—';
  return `<span class="funnel-badge ${cls}">${label}</span>`;
}

function _competitionGauge(cpc) {
  const level = (cpc || '').toLowerCase();
  const bars = [1, 2, 3].map(n => {
    let cls = 'empty';
    if (level === 'low'    && n <= 1) cls = 'filled-low';
    if (level === 'medium' && n <= 2) cls = 'filled-medium';
    if (level === 'high'   && n <= 3) cls = 'filled-high';
    return `<div class="cg-bar ${cls}"></div>`;
  }).join('');
  return `<div class="competition-gauge" title="경쟁도: ${cpc || '—'}">${bars}</div>`;
}

function renderShoppingKw(shopping) {
  const list   = document.getElementById('shop-kw-list');
  const target = document.getElementById('target-product-area');
  if (!list || !target) return;
  list.innerHTML = '';
  target.innerHTML = '';

  if (shopping.target_product) {
    const naverUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(shopping.target_product)}`;
    target.innerHTML = `
      <div class="target-product">
        <span>🎯 추천 상품: <strong>${shopping.target_product}</strong></span>
        <a class="target-product-link" href="${naverUrl}" target="_blank" rel="noopener" title="네이버 쇼핑 바로가기">
          <i data-lucide="external-link"></i>
        </a>
      </div>`;
    if (window.lucide) lucide.createIcons();
  }
  if (shopping.category) {
    target.innerHTML += `<div style="font-size:11px;color:var(--text2);padding:4px 10px 0">${shopping.category}${shopping.search_volume_estimate ? ' · ' + shopping.search_volume_estimate : ''}</div>`;
  }

  const rawKws = shopping.keywords || [];
  rawKws.forEach((kw) => {
    const kwText = (typeof kw === 'object') ? kw.keyword : kw;
    const stage  = (typeof kw === 'object') ? (kw.funnel_stage || '') : '';
    const cpc    = (typeof kw === 'object') ? (kw.cpc_estimate || '') : '';
    const item   = document.createElement('div');
    item.className = 'shop-kw-item';
    item.innerHTML = `${_funnelBadge(stage)}<span class="kw-text">${kwText}</span>${_competitionGauge(cpc)}`;
    list.appendChild(item);
  });
  if (window.lucide) lucide.createIcons();
}

/* ════════════════════════════════════════════════════
   [D] Guide Chip Insert
   ════════════════════════════════════════════════════ */
function insertPcChip(text) {
  const ta = document.getElementById('personal-context-input');
  if (!ta) return;
  const start = ta.selectionStart ?? ta.value.length;
  const end   = ta.selectionEnd   ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const after  = ta.value.slice(end);
  const sep    = before.length > 0 && !before.endsWith('\n') && !before.endsWith(' ') ? ' ' : '';
  ta.value = before + sep + text + after;
  const pos = (before + sep + text).length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  savePersonalContext();
}