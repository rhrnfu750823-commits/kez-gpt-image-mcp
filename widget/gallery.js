/**
 * kez-image-mcp 갤러리 위젯 (MCP Apps iframe 내부 스크립트)
 *
 * 빌드: scripts/build-widget.mjs가 ext-apps SDK까지 단일 IIFE로 번들해
 * src/gallery-html.ts에 인라인한다 — 런타임 외부 스크립트 의존 0.
 *
 * 렌더 모드 2종:
 *   - 상세 카드: structuredContent.items[].metadata(사이드카)가 있으면
 *     큰 이미지 → PROMPT(요약+전체보기 토글) → 2열 메타 그리드 → REFERENCES 행
 *   - 단순 그리드: metadata 없는 과거 이미지/외부 URL은 이미지만 (폴백)
 *
 * 상태 설계(모든 실패가 화면에 보이게):
 *   ① 마운트 즉시 placeholder 표시 (정적 HTML — 스크립트가 죽어도 남는다)
 *   ② 5초 내 호스트 데이터(tool-input/result) 미수신 → 타임아웃 문구
 *   ③ <img> 로드 실패 → "이미지 로드 차단" + 새 탭 링크 폴백
 */
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

const grid = document.getElementById('grid');
const status = document.getElementById('status');
let gotData = false;
let appRef = null; // App SDK 인스턴스 — 호스트 매개 다운로드(app.downloadFile)에 사용

function showStatus(msg) {
  status.textContent = msg;
  status.style.display = 'block';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------- UX 헬퍼: 라이트박스 / 다운로드 / 복사 (모두 graceful degrade) ----------

// 라이트박스 — iframe 내부 DOM만 사용해 권한 의존 0. 클릭/Esc로 닫힘.
function openLightbox(src) {
  const o = el('div', 'kez-lb');
  o.innerHTML = '<img alt="확대 이미지"><button class="kez-lb-x" aria-label="닫기">×</button>';
  o.querySelector('img').src = src;
  const close = () => {
    o.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  o.addEventListener(
    'click',
    (e) => (e.target === o || e.target.classList.contains('kez-lb-x')) && close(),
  );
  document.addEventListener('keydown', onKey);
  document.body.appendChild(o);
}

// 출력 URL 경로의 uuid 앞 8자 → 파일명 단축 식별자.
function shortIdFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/([0-9a-f]{8})[0-9a-f]*-/i);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function downloadName(url, metadata) {
  const slug = (metadata && metadata.style && metadata.style.slug) || 'img';
  return `kez_${slug}_${shortIdFromUrl(url) || 'out'}.webp`;
}

// 다운로드 — 샌드박스 iframe은 <a download>·새 탭 직접 다운로드가 차단된다("이 콘텐츠는 차단되어
// 있습니다"). 그래서 호스트 매개 다운로드(app.downloadFile, resource_link)를 쓴다 — 호스트가 URL을
// 받아 대신 받아준다. SDK 미연결/거부 시 openLink로, 그것도 막히면 조용히 끝낸다(hard-fail 금지).
function downloadHref(url, filename) {
  return url + (url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(filename);
}

async function doDownload(url, filename) {
  const dlUrl = downloadHref(url, filename);
  if (appRef) {
    try {
      const r = await appRef.downloadFile({
        contents: [{ type: 'resource_link', uri: dlUrl, name: filename, mimeType: 'image/webp' }],
      });
      if (!r || !r.isError) return;
    } catch {}
    try {
      const r = await appRef.openLink({ url: dlUrl }); // 폴백: 호스트가 새 탭/외부 브라우저로 연다
      if (!r || !r.isError) return;
    } catch {}
  }
  try {
    window.open(dlUrl, '_blank'); // 최후 (allow-popups 있을 때만)
  } catch {}
}

// 복사 — async clipboard → execCommand 폴백, 버튼에 1.2초 피드백.
async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {}
  if (!ok) {
    try {
      const ta = Object.assign(document.createElement('textarea'), {
        value: text,
        style: 'position:fixed;opacity:0',
      });
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch {}
  }
  if (btn) {
    const t = btn.textContent;
    btn.textContent = ok ? '복사됨' : '복사 실패';
    setTimeout(() => (btn.textContent = t), 1200);
  }
}

// 출력 이미지 — 클릭→라이트박스, 호버→다운로드 버튼. 드래그-추출은 <img> 네이티브로 보존.
function outputImage(url, className, metadata) {
  const wrap = el('div', className ? className + ' shot' : 'shot');
  const img = el('img', 'thumb');
  img.src = url;
  img.alt = 'generated image';
  img.loading = 'lazy';
  img.addEventListener('click', () => openLightbox(url));
  img.onerror = () => {
    const fallback = el('a', '', '이미지 로드 차단됨 — 새 탭에서 열기');
    fallback.href = url;
    fallback.target = '_blank';
    fallback.rel = 'noopener';
    wrap.classList.add('err');
    wrap.replaceChildren(fallback);
  };
  wrap.appendChild(img);
  const name = downloadName(url, metadata);
  const dl = el('button', 'dl-btn', '↓');
  dl.title = '다운로드';
  dl.setAttribute('aria-label', '다운로드');
  dl.addEventListener('click', (e) => {
    e.stopPropagation(); // 라이트박스(img click)와 분리
    doDownload(url, name);
  });
  wrap.appendChild(dl);
  return wrap;
}

function metaCell(label, value) {
  const cell = el('div', 'cell');
  cell.appendChild(el('div', 'label', label));
  cell.appendChild(el('div', 'value', value));
  return cell;
}

function refThumb(group, kind) {
  const box = el('div', 'ref');
  // 앵커 전체를 작은 썸네일로 한 줄 나열 — "이 레퍼런스를 썼다"는 표식 용도라 44px이면 충분
  const thumbs = el('div', 'ref-thumbs');
  for (const url of (group.anchor_urls || []).slice(0, 5)) {
    const img = el('img', 'thumb');
    img.src = url;
    img.alt = `${kind} anchor`;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(url));
    img.onerror = () => img.remove();
    thumbs.appendChild(img);
  }
  if (thumbs.childNodes.length) box.appendChild(thumbs);
  const cap = el('div', 'ref-cap');
  cap.appendChild(el('div', 'ref-slug', group.slug));
  cap.appendChild(el('div', 'ref-kind', kind));
  box.appendChild(cap);
  return box;
}

function card(item) {
  const m = item.metadata;
  const node = el('div', 'card');
  node.appendChild(outputImage(item.url, 'main', m));

  // PROMPT — 장면 프롬프트 요약 + 결합 최종본 전체보기 토글 + 각각 복사 버튼
  const prompt = el('div', 'prompt');
  const head = el('div', 'prompt-head');
  head.appendChild(el('div', 'label', 'PROMPT'));
  const scene = m.scene_prompt || '';
  // 복사 버튼 1개 — 실제 생성에 쓰인 전체 프롬프트(combined: 화풍+장면 결합본)를 복사. 없으면 장면 프롬프트.
  const fullPrompt = m.combined_prompt || scene;
  if (fullPrompt) {
    const copyBtn = el('button', 'copy-btn', '⧉ 프롬프트 복사');
    copyBtn.addEventListener('click', () => copyText(fullPrompt, copyBtn));
    head.appendChild(copyBtn);
  }
  prompt.appendChild(head);
  const summary = el('div', 'value', scene.length > 140 ? scene.slice(0, 140) + '…' : scene);
  prompt.appendChild(summary);
  if (m.combined_prompt) {
    const full = el('pre', 'full-prompt', m.combined_prompt);
    full.style.display = 'none';
    const toggle = el('button', 'toggle', '전체보기');
    toggle.onclick = () => {
      const open = full.style.display !== 'none';
      full.style.display = open ? 'none' : 'block';
      toggle.textContent = open ? '전체보기' : '접기';
    };
    prompt.appendChild(toggle);
    prompt.appendChild(full);
  }
  node.appendChild(prompt);

  // 2열 메타 그리드 — SEED는 빈칸 대신 미지원 명시 (빈칸은 버그처럼 보인다)
  const meta = el('div', 'meta-grid');
  meta.appendChild(metaCell('MODEL', m.model || '—'));
  meta.appendChild(metaCell('SIZE', m.size || '—'));
  meta.appendChild(metaCell('QUALITY', m.quality || '—'));
  const tokens = m.usage && m.usage.total_tokens ? ` · ${m.usage.total_tokens}tok` : '';
  meta.appendChild(metaCell('COST', (m.estimated_cost_usd != null ? `$${m.estimated_cost_usd}` : '—') + tokens));
  meta.appendChild(metaCell('SEED', m.seed != null ? String(m.seed) : '미지원 (gpt-image)'));
  meta.appendChild(metaCell('CREATED', (m.created_at || '').slice(0, 16).replace('T', ' ') || '—'));
  node.appendChild(meta);

  // REFERENCES — character/style 앵커 썸네일 + slug + kind
  if (m.character || m.style) {
    const refs = el('div', 'refs');
    refs.appendChild(el('div', 'label', 'REFERENCES'));
    const row = el('div', 'ref-row');
    if (m.character) row.appendChild(refThumb(m.character, 'character'));
    if (m.style) row.appendChild(refThumb(m.style, 'style'));
    refs.appendChild(row);
    node.appendChild(refs);
  }
  return node;
}

function renderItems(items) {
  const list = (Array.isArray(items) ? items : []).filter(
    (it) => it && typeof it.url === 'string' && it.url.startsWith('https://'),
  );
  if (!list.length) return false;
  gotData = true;
  status.style.display = 'none';
  grid.classList.toggle('single', list.length === 1);
  grid.replaceChildren(...list.map((it) => (it.metadata ? card(it) : outputImage(it.url, '', it.metadata))));
  return true;
}

function render(urls) {
  return renderItems((Array.isArray(urls) ? urls : []).map((u) => ({ url: u, metadata: null })));
}

async function main() {
  const timer = setTimeout(() => {
    if (!gotData) {
      showStatus('위젯 초기화 실패(5초 타임아웃) — 호스트로부터 데이터를 받지 못했다. 채팅의 서명 URL 텍스트로 확인하라.');
    }
  }, 5000);

  try {
    const app = new App({ name: 'kez-image-gallery', version: '1.5.0' });
    appRef = app; // 호스트 매개 다운로드용 참조
    app.ontoolinput = (p) => render(p && p.arguments && p.arguments.urls);
    app.ontoolresult = (r) => {
      clearTimeout(timer);
      if (r && r.isError) {
        showStatus((r.content && r.content[0] && r.content[0].text) || '도구 오류');
        return;
      }
      const sc = r && r.structuredContent;
      if (sc && renderItems(sc.items)) return; // 상세 카드 (사이드카 있는 항목)
      render(sc && sc.urls); // 과거 형식/사이드카 없음 → 이미지만
      if (gotData) return;
      // wait:false 영수증(job_id만, 이미지 없음) → 에러가 아니라 "생성 중" 안내
      if (sc && (sc.pending || sc.status === 'queued' || sc.status === 'running')) {
        showStatus('⏳ 이미지 생성 중 — 완료되면 check_jobs 결과에 표시된다.');
        return;
      }
      showStatus('결과에 표시할 이미지 URL이 없다.');
    };
    await app.connect(new PostMessageTransport());
  } catch (e) {
    clearTimeout(timer);
    showStatus('위젯 연결 실패: ' + ((e && e.message) || String(e)));
  }
}

main();
