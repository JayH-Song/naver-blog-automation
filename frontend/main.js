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
  persona:        null,
  selectedKeyword:'',
  style:          '정보 큐레이션',
  tone:           '친근하고 부드럽게',
  goldenTime:     'morning',
  ctaEnabled:     true,
  revenueLink:    '',
  postHistory:    [],
  personaColor:   '#2cc4a0',
  lastResult:     null,
  currentRunId:   null,   // Phase 3 On-Demand 이미지 생성용 run_id
};

let S = { ...defaultState };

function loadState() {
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (saved) S = { ...defaultState, ...JSON.parse(saved) };
  } catch(e) {}
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
  S.persona = { job, age, career, family, theme_color: S.personaColor };
  saveState();
  renderPersonaBadge();
  logTerm('PERSONA', `페르소나 저장 완료 — ${job}`, 'done');
}

function savePersonaFromSlideover() {
  S.persona = {
    job:    document.getElementById('so-job').value.trim() || S.persona?.job || '',
    age:    document.getElementById('so-age').value.trim() || S.persona?.age || '',
    career: document.getElementById('so-career').value.trim() || S.persona?.career || '',
    family: document.getElementById('so-family').value.trim() || S.persona?.family || '',
    theme_color: S.personaColor,
  };
  saveState();
  renderPersonaBadge();
  closeDrawer();
  logTerm('PERSONA', `페르소나 업데이트 완료 — ${S.persona.job}`, 'done');
}

function renderPersonaBadge() {
  document.getElementById('persona-setup').style.display = 'none';
  document.getElementById('persona-badge').style.display = 'block';
  document.getElementById('badge-name').textContent = `${S.persona.job} · ${S.persona.age}`;
  document.getElementById('badge-meta').textContent = S.persona.career.slice(0, 40);
  applyPersonaColor(S.personaColor);
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
  // 네이버 그린 포인트 컬러 고정
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

  if (id === 'persona-drawer' && S.persona) {
    document.getElementById('so-job').value    = S.persona.job    || '';
    document.getElementById('so-age').value    = S.persona.age    || '';
    document.getElementById('so-career').value = S.persona.career || '';
    document.getElementById('so-family').value = S.persona.family || '';
    document.querySelectorAll('#so-colors .color-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.color === S.personaColor);
    });
  }

  drawer.classList.add('open');
  backdrop.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('open'));
  document.getElementById('left')?.classList.remove('mobile-open');
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
      };
    }
    container.appendChild(card);
  });
}

function updateRevenueScore(score, match) {
  document.getElementById('rev-score-label').textContent = `Score ${score.toFixed(0)}`;
  document.getElementById('rev-bar-fill').style.width = `${Math.min(score, 100)}%`;
  const badge = document.getElementById('high-value-badge');
  badge.style.display = score >= 60 ? 'inline-block' : 'none';
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

function toggleCta() {
  const t = document.getElementById('cta-toggle');
  S.ctaEnabled = !S.ctaEnabled;
  t.classList.toggle('on', S.ctaEnabled);
  saveState();
}

function armRevenueLink() {
  const val = document.getElementById('revenue-link-input').value.trim();
  S.revenueLink = val;
  saveState();
  const input = document.getElementById('revenue-link-input');
  if (val) {
    input.classList.add('link-armed');
    logTerm('REVENUE', `링크 활성화 완료 — ${val.slice(0,40)}...`, 'done');
  } else {
    input.classList.remove('link-armed');
  }
}

/* ─── Post History ─── */
function addPostHistoryRow() {
  const list = document.getElementById('post-history-list');
  const idx  = list.children.length;
  const row  = document.createElement('div');
  row.className = 'post-history-item';
  row.innerHTML = `
    <input class="post-title-input" placeholder="포스팅 제목" oninput="updatePostHistory(${idx}, 'title', this.value)"/>
    <input class="post-url-input" placeholder="URL" oninput="updatePostHistory(${idx}, 'url', this.value)"/>
    <button class="btn-sm" onclick="removePostHistory(${idx}, this.parentElement)" style="padding:4px 7px;font-size:11px">✕</button>
  `;
  list.appendChild(row);
  if (!S.postHistory[idx]) S.postHistory[idx] = { title: '', url: '' };
  saveState();
}

function updatePostHistory(idx, field, val) {
  if (!S.postHistory[idx]) S.postHistory[idx] = {};
  S.postHistory[idx][field] = val;
  saveState();
}

function removePostHistory(idx, rowEl) {
  S.postHistory.splice(idx, 1);
  rowEl.remove();
  saveState();
}

/* ─── 메인 생성 파이프라인 ─── */
async function generate() {
  if (!S.persona) { alert('페르소나를 먼저 설정하세요'); return; }
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
    const payload = {
      persona:      S.persona,
      keyword:      S.selectedKeyword,
      config: {
        style:       S.style,
        tone:        S.tone,
        golden_time: S.goldenTime,
        cta_enabled: S.ctaEnabled,
      },
      post_history:  S.postHistory.filter(p => p.title || p.url),
      revenue_link:  S.revenueLink,
    };

    logTerm('GEN', `글 빌드 시작 — ${S.selectedKeyword}`);
    setProgress(15);

    const result = await apiFetch('/api/generate', 'POST', payload, 180000);

    setProgress(90);

    // Phase 1 완료: 에디터에 원고 표시
    editor.commands.setContent(result.content || '');
    checkForbiddenWords();
    updateRevenueScore(result.revenue_score || 0, result.revenue_match || 'none');
    renderShoppingKw(result.shopping || {});
    renderOSMU(result.osmu || {});

    // run_id 저장 (Phase 3 이미지 생성에 사용)
    S.lastResult  = result;
    S.currentRunId = result.run_id;
    saveState();

    // 이미지 갤러리는 placeholder 유지
    document.getElementById('thumb-placeholder').style.display = 'block';
    document.getElementById('body-placeholder').style.display  = 'block';

    // Phase 3 이미지 생성 버튼 활성화
    const imgBtn  = document.getElementById('img-gen-trigger-btn');
    const imgHint = document.getElementById('img-gen-hint');
    if (imgBtn)  { imgBtn.disabled = false; }
    if (imgHint) { imgHint.textContent = '편집 후 클릭하여 비주얼을 생성하세요'; }

    // Harvest Bar 버튼 활성화
    ['harvest-btn-title', 'harvest-btn-tags'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = false;
    });

    setProgress(100);
    logTerm('TEXT_DONE', `✓ 글 빌드 완료 — ${result.title?.slice(0,20)} | [AI 이미지] 버튼으로 비주얼 생성`, 'done');

    setTimeout(() => setProgress(0), 2000);

  } catch(e) {
    const msg = e.message || String(e) || '알 수 없는 오류';
    logTerm('ERROR', `생성 실패: ${msg}`, 'error');
    console.error('[generate] 오류:', e);
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

/* ─── OSMU 렌더링 ─── */
function renderOSMU(osmu) {
  const container = document.getElementById('osmu-content');
  const placeholder = document.getElementById('osmu-placeholder');
  if (!container || !placeholder) return;
  
  if (!osmu || (!osmu.youtube_shorts && !osmu.instagram_feed)) {
    container.style.display = 'none';
    placeholder.style.display = 'block';
    return;
  }
  placeholder.style.display = 'none';
  container.style.display = 'flex';
  document.getElementById('osmu-shorts').value = osmu.youtube_shorts || '생성된 대본이 없습니다.';
  document.getElementById('osmu-insta').value = osmu.instagram_feed || '생성된 피드 텍스트가 없습니다.';
}

window.copyOSMU = function(type) {
  const text = type === 'youtube_shorts' ? document.getElementById('osmu-shorts').value : document.getElementById('osmu-insta').value;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    alert('복사되었습니다.');
    logTerm('OSMU', type === 'youtube_shorts' ? '쇼츠 대본 복사 완료' : '인스타 피드 복사 완료', 'done');
  });
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
  list.innerHTML = '';
  target.innerHTML = '';

  if (shopping.target_product) {
    target.innerHTML = `<div class="target-product">🎯 추천 상품: <strong>${shopping.target_product}</strong></div>`;
  }
  if (shopping.category) {
    target.innerHTML += `<div style="font-size:12px;color:var(--text2);padding:4px 10px">${shopping.category}${shopping.search_volume_estimate ? ' · ' + shopping.search_volume_estimate : ''}</div>`;
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
    item.innerHTML = `<span class="funnel">${stage}</span><span>${kwText}</span>${cpc ? `<span style="font-size:11px;color:var(--text2);margin-left:auto">${cpc}</span>` : ''}`;
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
let harvestChecks = [false, false, false, false, false];

function openHarvestModal() {
  if (!S.lastResult && !editor.getText().trim()) {
    alert('먼저 글을 빌드하세요');
    return;
  }
  document.getElementById('harvest-modal').classList.add('open');
}

function closeHarvestModal() {
  document.getElementById('harvest-modal').classList.remove('open');
  harvestChecks = [false, false, false, false, false];
  document.querySelectorAll('.check-item').forEach(c => c.classList.remove('checked'));
  document.getElementById('confirm-copy-btn').disabled = true;
}

function toggleCheck(idx) {
  harvestChecks[idx] = !harvestChecks[idx];
  document.querySelector(`.check-item[data-idx="${idx}"]`).classList.toggle('checked', harvestChecks[idx]);
  document.getElementById('confirm-copy-btn').disabled = !harvestChecks.every(Boolean);
}

async function doHtmlCopy() {
  // Revenue link 미장전 경고
  if (!S.revenueLink && S.ctaEnabled) {
    if (!confirm('Revenue Link가 장전되지 않았습니다. 그래도 복사하시겠습니까?')) return;
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

async function copyTitle() {
  const title = S.lastResult?.title
    || document.querySelector('.ProseMirror h1')?.textContent?.trim()
    || '';
  if (!title) {
    logTerm('HARVEST', '담을 제목이 없습니다 — 먼저 글을 빌드하세요', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(title);
    logTerm('HARVEST', `✓ 제목 담기 완료 — ${title.slice(0,30)}`, 'done');
    _flashBtn('harvest-btn-title');
  } catch(e) {
    logTerm('HARVEST', `제목 담기 실패: ${e.message}`, 'error');
    // 폴백: execCommand
    const tmp = document.createElement('textarea');
    tmp.value = title;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
    logTerm('HARVEST', `✓ 제목 담기 완료 (fallback)`, 'done');
    _flashBtn('harvest-btn-title');
  }
}

async function copyTags() {
  const rawTags = S.lastResult?.tags || [];
  if (!rawTags.length) {
    logTerm('HARVEST', '복사할 태그가 없습니다 — 먼저 글을 빌드하세요', 'error');
    return;
  }
  const tags = rawTags.map(t => `#${t}`).join(' ');
  try {
    await navigator.clipboard.writeText(tags);
    logTerm('HARVEST', `✓ 태그 ${rawTags.length}개 복사 — ${tags.slice(0,50)}`, 'done');
    _flashBtn('harvest-btn-tags');
  } catch(e) {
    logTerm('HARVEST', `태그 복사 실패: ${e.message}`, 'error');
    // 폴백: execCommand
    const tmp = document.createElement('textarea');
    tmp.value = tags;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
    logTerm('HARVEST', `✓ 태그 복사 완료 (fallback)`, 'done');
    _flashBtn('harvest-btn-tags');
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
  OSMU:      { label: 'OSMU',      cls: 'enrich'  },
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

  if (STEP_PROGRESS[step]) setProgress(STEP_PROGRESS[step]);
}

function clearTerminal() {
  document.getElementById('term-log').innerHTML = '';
}

function setProgress(pct) {
  document.getElementById('progress-fill').style.width = `${pct}%`;
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
  // 탭 active 표시 업데이트
  document.querySelectorAll('.mobile-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.panel === panel);
  });

  if (panel === 'left') {
    // 이미지 드로어 닫고 전략 패널 토글
    document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('open'));
    const left = document.getElementById('left');
    const isOpen = !left.classList.contains('mobile-open');
    left.classList.toggle('mobile-open', isOpen);
    document.getElementById('drawer-backdrop').classList.toggle('show', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  } else if (panel === 'center') {
    // 모든 오버레이 닫기, 에디터 포커스
    closeDrawer();
    if (editor) setTimeout(() => editor.commands.focus(), 100);
  } else if (panel === 'images') {
    document.getElementById('left')?.classList.remove('mobile-open');
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
  if (S.persona) renderPersonaBadge();
  if (S.personaColor) applyPersonaColor(S.personaColor);

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
  if (S.revenueLink) {
    document.getElementById('revenue-link-input').value = S.revenueLink;
    if (S.revenueLink) document.getElementById('revenue-link-input').classList.add('link-armed');
  }
  document.getElementById('cta-toggle').classList.toggle('on', S.ctaEnabled !== false);

  S.postHistory.forEach((item, i) => {
    addPostHistoryRow();
    const rows = document.getElementById('post-history-list').children;
    if (rows[i]) {
      rows[i].querySelector('.post-title-input').value = item.title || '';
      rows[i].querySelector('.post-url-input').value   = item.url   || '';
    }
  });

  // 테마 복원 (editor 불필요)
  const savedTheme = localStorage.getItem('haru_theme') || 'dark';
  setTheme(savedTheme, false);

  // ── editor 복원은 에디터 초기화 완료 후 실행 ──
  // initEditor()가 비동기(CDN 대기) 일 수 있으므로 'editor-ready' 이벤트 후 처리
  function restoreEditorContent() {
    if (!editor) return;
    if (S.lastResult?.content) {
      editor.commands.setContent(S.lastResult.content);
      renderShoppingKw(S.lastResult.shopping || {});
      renderOSMU(S.lastResult.osmu || {});
      updateRevenueScore(S.lastResult.revenue_score || 0, S.lastResult.revenue_match || 'none');
      // harvest 버튼 활성화
      ['harvest-btn-title', 'harvest-btn-tags'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });

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

    // Cursor lume tracking — updates --bx/--by CSS vars for ::after gradient
    document.addEventListener('mousemove', (e) => {
      const btn = e.target.closest('.btn-sm, .harvest-btn, #gen-btn');
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      btn.style.setProperty('--bx', ((e.clientX - r.left) / r.width  * 100).toFixed(1) + '%');
      btn.style.setProperty('--by', ((e.clientY - r.top)  / r.height * 100).toFixed(1) + '%');
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