/**
 * kez-image-mcp 레퍼런스 업로더 위젯 (MCP Apps iframe 내부 스크립트)
 *
 * 목적: 사용자가 채팅 안에서 이미지를 끌어다 놓기만 하면 업로드~등록이 이 위젯 안에서 끝난다.
 * 이미지 바이트는 '위젯(브라우저) → 워커/R2' 구간만 흐르고 LLM(대화)은 0회 통과한다.
 *
 * 인증/주소: 워커가 resources/read(=Bearer 게이트 안)에서 저권한 업로드 토큰과 자기 origin을
 *   아래 두 토큰 문자열에 주입한다. connectDomains(CSP connect-src)로 워커 fetch가 허용된다.
 *
 * 빌드: scripts/build-widget.mjs가 ext-apps SDK까지 단일 IIFE로 번들해 src/gallery-html.ts의
 *   UPLOADER_HTML(플레이스홀더 포함 템플릿)로 출력한다. widget 수정 시 npm run build:widget.
 */
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

const ORIGIN = '__WORKER_ORIGIN__';
const TOKEN = '__UPLOAD_TOKEN__';
const MIME_OK = ['image/webp', 'image/png', 'image/jpeg', 'image/gif'];
const MAX = 5;

const uploaded = []; // { key, url, name }

function $(id) {
  return document.getElementById(id);
}

function setStatus(msg, isErr) {
  const s = $('status');
  s.textContent = msg || '';
  s.className = 'status' + (isErr ? ' err' : '');
}

async function uploadFile(file) {
  if (!MIME_OK.includes(file.type)) {
    throw new Error(`지원하지 않는 형식: ${file.type || '알 수 없음'} (webp·png·jpeg·gif만)`);
  }
  const res = await fetch(`${ORIGIN}/assets/upload`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': file.type },
    body: file, // raw 바이너리 — base64 인코딩 안 함
  });
  if (!res.ok) throw new Error(`업로드 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json(); // { key, url, bytes, mime }
}

function renderThumbs() {
  const wrap = $('thumbs');
  wrap.replaceChildren(
    ...uploaded.map((u, i) => {
      const box = document.createElement('div');
      box.className = 'thumb';
      const img = document.createElement('img');
      img.src = u.url;
      img.alt = u.name;
      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.textContent = '×';
      rm.title = '제거';
      rm.onclick = () => {
        uploaded.splice(i, 1);
        renderThumbs();
      };
      box.append(img, rm);
      return box;
    }),
  );
  $('count').textContent = uploaded.length ? `${uploaded.length}/${MAX}장 업로드됨` : '';
}

async function handleFiles(fileList) {
  const list = [...fileList].filter((f) => f.type && f.type.startsWith('image/'));
  if (!list.length) return;
  if (uploaded.length + list.length > MAX) {
    setStatus(`최대 ${MAX}장까지만 등록할 수 있다.`, true);
    return;
  }
  setStatus('업로드 중…');
  for (const f of list) {
    try {
      const r = await uploadFile(f);
      uploaded.push({ key: r.key, url: r.url, name: f.name });
      renderThumbs();
    } catch (e) {
      setStatus((e && e.message) || String(e), true);
      return;
    }
  }
  setStatus(`${uploaded.length}장 준비됨. 종류·이름을 정하고 "등록"을 눌러라.`);
}

async function register() {
  const kind = (document.querySelector('input[name=kind]:checked') || {}).value || 'character';
  const slug = $('slug').value.trim();
  const fixed = $('fixed').value.trim();
  const desc = $('desc').value.trim();
  if (!uploaded.length) {
    setStatus('이미지를 먼저 끌어다 놓아라.', true);
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(slug)) {
    setStatus('이름(slug)은 영소문자·숫자·하이픈만 (예: toon-wizard).', true);
    return;
  }
  $('register').disabled = true;
  setStatus('등록 중…');
  try {
    const res = await fetch(`${ORIGIN}/assets/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, slug, image_urls: uploaded.map((u) => u.key), description: desc, fixed_prompt: fixed }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `등록 실패 (${res.status})`);
    if (j.status === 'draft' || j.hint) {
      // fixed_prompt를 안 채우면 draft — generate에서 못 쓴다. 다음 액션을 명확히.
      setStatus(
        `⚠️ 이미지만 등록됨 — ${kind} "${slug}" (draft). ${j.hint || '고정 프롬프트(fixed_prompt)를 채워 다시 등록해야 generate에서 쓸 수 있다.'}`,
        true,
      );
    } else {
      setStatus(`✅ 등록 완료 — ${kind} "${slug}" (${uploaded.length}장). 이제 generate에서 ${kind}="${slug}"로 쓸 수 있다.`);
    }
  } catch (e) {
    setStatus((e && e.message) || String(e), true);
  } finally {
    $('register').disabled = false;
  }
}

function main() {
  const drop = $('drop');
  const file = $('file');
  drop.addEventListener('click', () => file.click());
  ['dragover', 'dragenter'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }),
  );
  ['dragleave', 'dragend'].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList.remove('over')),
  );
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  });
  file.addEventListener('change', () => handleFiles(file.files));
  $('register').addEventListener('click', register);
  // kind 전환 시 프리필된 slug를 리셋 — character/style 같은 이름 혼동 방지(서버도 거부하지만 입구에서 차단).
  document.querySelectorAll('input[name=kind]').forEach((r) =>
    r.addEventListener('change', () => {
      $('slug').value = '';
    }),
  );

  // App SDK 핸드셰이크 — 실패해도 위젯 자체(정적 폼)는 동작. ontoolresult로 kind/slug 프리필.
  try {
    const app = new App({ name: 'kez-reference-uploader', version: '1.1.0' });
    app.ontoolresult = (r) => {
      const sc = r && r.structuredContent;
      if (!sc) return;
      if (sc.kind) {
        const radio = document.querySelector(`input[name=kind][value=${sc.kind}]`);
        if (radio) radio.checked = true;
      }
      if (sc.slug) $('slug').value = sc.slug;
    };
    app.connect(new PostMessageTransport());
  } catch {
    /* SDK 없이도 동작 */
  }
}

main();
