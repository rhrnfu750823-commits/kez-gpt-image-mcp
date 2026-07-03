/**
 * 위젯 빌드 — widget/*.js를 ext-apps SDK까지 단일 IIFE로 번들해 완성 HTML로 조립하고
 * src/gallery-html.ts(생성 파일)에 GALLERY_HTML / UPLOADER_HTML로 출력한다.
 *
 * 생성 파일을 커밋하므로 typecheck/test/deploy는 이 스크립트 없이도 돌지만,
 * widget/*.js를 수정하면 반드시 `npm run build:widget` 후 커밋할 것.
 *
 * UPLOADER_HTML에는 __UPLOAD_TOKEN__ / __WORKER_ORIGIN__ 플레이스홀더가 남아 있고,
 * 워커가 resources/read(Bearer 게이트 안)에서 실제 값으로 치환해 내려준다.
 */
import * as esbuild from 'esbuild';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function bundle(entry) {
  const result = await esbuild.build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    charset: 'utf8', // 한글 문자열을 \uXXXX로 이스케이프하지 않음 (HTML이 utf-8 선언)
    write: false,
  });
  // 인라인 <script> 안에 들어가므로 스크립트 조기 종료 시퀀스를 이스케이프
  return result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

function page(styleCss, bodyHtml, js) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${styleCss}
</style>
</head>
<body>
${bodyHtml}
<script>
${js}
</script>
</body>
</html>`;
}

// ---------- 갤러리 위젯 ----------

const galleryStyle = `  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 200px; font-family: var(--font-sans, system-ui, sans-serif); background: transparent; }
  #grid { display: grid; gap: 8px; padding: 8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  #grid.single { grid-template-columns: 1fr; }
  #grid a { display: block; }
  #grid img { width: 100%; height: auto; display: block; border-radius: var(--border-radius-md, 8px); }
  #grid .err { display: flex; align-items: center; justify-content: center; min-height: 120px;
    border: 1px dashed var(--color-border-primary, #999); border-radius: var(--border-radius-md, 8px);
    font-size: 13px; padding: 8px; }
  #status { padding: 16px 12px; font-size: 13px; color: var(--color-text-secondary, #888); }
  /* 일괄 저장 툴바 — 여러 장일 때만 채워진다 (비면 숨김) */
  #bar { padding: 8px 8px 0; }
  #bar:empty { display: none; }
  .zip-btn { font-size: 12.5px; font-weight: 600; padding: 7px 12px; cursor: pointer; border-radius: 8px;
    border: 1px solid var(--color-border-primary, #3333); background: var(--color-background-secondary, #8881);
    color: var(--color-text-primary, inherit); }
  .zip-btn:disabled { opacity: .5; cursor: default; }
  /* 상세 카드 (사이드카 메타 있는 항목) */
  .card { border: 1px solid var(--color-border-primary, #3333); border-radius: var(--border-radius-md, 10px);
    padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .card .label { font-size: 10px; letter-spacing: 0.08em; font-weight: 700;
    color: var(--color-text-secondary, #888); margin-bottom: 2px; }
  .card .value { font-size: 13px; color: var(--color-text-primary, inherit); word-break: break-word; }
  .card .toggle { margin-top: 4px; font-size: 11px; padding: 2px 8px; cursor: pointer;
    background: transparent; color: var(--color-text-secondary, #888);
    border: 1px solid var(--color-border-primary, #3333); border-radius: 6px; }
  .card .full-prompt { font-size: 11.5px; white-space: pre-wrap; word-break: break-word; margin: 6px 0 0;
    padding: 8px; background: var(--color-background-secondary, #8881);
    border-radius: 6px; max-height: 220px; overflow: auto; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
  .refs .ref-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .ref { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ref-thumbs { display: flex; gap: 4px; flex-wrap: wrap; }
  /* #grid img(width:100%)보다 명시도를 높여야 함 — .ref img는 ID 규칙에 져서 전폭으로 터졌었다 */
  #grid .ref img { width: 44px; height: 44px; object-fit: cover; border-radius: 6px; flex: none; }
  .ref-slug { font-size: 12px; font-weight: 600; }
  .ref-kind { font-size: 10px; color: var(--color-text-secondary, #888); }
  /* 클릭 확대 커서 (출력·레퍼런스 공통) */
  .thumb { cursor: zoom-in; }
  /* 출력 이미지 래퍼 — 호버 다운로드 버튼 기준 */
  .shot { position: relative; }
  .dl-btn { position: absolute; top: 8px; right: 8px; width: 30px; height: 30px; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center; font-size: 16px; text-decoration: none;
    cursor: pointer; color: #fff; background: rgba(0,0,0,.55); border: 0; border-radius: 6px;
    opacity: 0; transition: opacity .12s; }
  .shot:hover .dl-btn { opacity: 1; }
  @media (hover: none) { .dl-btn { opacity: 1; } }
  /* 프롬프트 헤더 — 라벨 + 복사 버튼들 한 줄 */
  .prompt-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
  .prompt-head .label { margin-bottom: 0; }
  .copy-btn { font-size: 10.5px; padding: 2px 8px; cursor: pointer;
    background: transparent; color: var(--color-text-secondary, #888);
    border: 1px solid var(--color-border-primary, #3333); border-radius: 6px; }
  /* 라이트박스 — iframe 내부 오버레이 */
  .kez-lb { position: fixed; inset: 0; background: rgba(0,0,0,.82); display: flex;
    align-items: center; justify-content: center; z-index: 9999; cursor: zoom-out; }
  .kez-lb img { max-width: 92vw; max-height: 92vh; object-fit: contain; border-radius: 6px; }
  .kez-lb-x { position: absolute; top: 14px; right: 18px; font-size: 26px; color: #fff;
    background: none; border: 0; cursor: pointer; }`;

const galleryBody = `<div id="status">갤러리 초기화 중…</div>
<div id="bar"></div>
<div id="grid"></div>`;

// ---------- 업로더 위젯 ----------

const uploaderStyle = `  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--font-sans, system-ui, sans-serif); background: transparent;
    color: var(--color-text-primary, inherit); }
  #app { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .drop { border: 2px dashed var(--color-border-primary, #999); border-radius: 12px; padding: 22px 14px;
    text-align: center; cursor: pointer; transition: background .12s, border-color .12s; }
  .drop.over { border-color: var(--color-text-primary, #4a90d9); background: var(--color-background-secondary, #8881); }
  .drop-inner { display: flex; flex-direction: column; gap: 4px; pointer-events: none; }
  .drop-inner strong { font-size: 14px; }
  .drop-inner span { font-size: 11.5px; color: var(--color-text-secondary, #888); }
  .thumbs { display: flex; gap: 8px; flex-wrap: wrap; }
  .thumb { position: relative; }
  .thumb img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; display: block; }
  .thumb .rm { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%;
    border: 0; cursor: pointer; background: rgba(0,0,0,.7); color: #fff; font-size: 13px; line-height: 20px; padding: 0; }
  .count { font-size: 11.5px; color: var(--color-text-secondary, #888); }
  .form { display: flex; flex-direction: column; gap: 8px; }
  .kind-row { display: flex; gap: 16px; font-size: 13px; }
  .kind-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  .inp { width: 100%; padding: 7px 9px; font-size: 13px; border-radius: 8px;
    border: 1px solid var(--color-border-primary, #3333); background: transparent; color: inherit; }
  .btn { padding: 9px 12px; font-size: 13px; font-weight: 600; cursor: pointer; border-radius: 8px; border: 0;
    background: var(--color-text-primary, #4a90d9); color: var(--color-background-primary, #fff); }
  .btn:disabled { opacity: .5; cursor: default; }
  .status { font-size: 12px; color: var(--color-text-secondary, #888); white-space: pre-wrap; word-break: break-word; }
  .status.err { color: var(--color-text-danger, #d9534f); }`;

const uploaderBody = `<div id="app">
  <div id="drop" class="drop">
    <div class="drop-inner">
      <strong>이미지를 여기에 끌어다 놓기</strong>
      <span>또는 클릭해서 선택 · 최대 5장 · webp·png·jpeg·gif</span>
    </div>
    <input type="file" id="file" accept="image/*" multiple hidden />
  </div>
  <div id="thumbs" class="thumbs"></div>
  <div id="count" class="count"></div>
  <div class="form">
    <div class="kind-row">
      <label><input type="radio" name="kind" value="character" checked /> 캐릭터</label>
      <label><input type="radio" name="kind" value="style" /> 화풍</label>
    </div>
    <input id="slug" class="inp" placeholder="이름 (예: toon-wizard) — 영소문자·숫자·하이픈" />
    <input id="fixed" class="inp" placeholder="고정 프롬프트 (선택) — 생성 시 자동 결합" />
    <input id="desc" class="inp" placeholder="설명 (선택)" />
    <button id="register" class="btn">이 레퍼런스로 등록</button>
  </div>
  <div id="status" class="status"></div>
</div>`;

// ---------- 빌드 ----------

const galleryJs = await bundle('widget/gallery.js');
const uploaderJs = await bundle('widget/uploader.js');
const galleryHtml = page(galleryStyle, galleryBody, galleryJs);
const uploaderHtml = page(uploaderStyle, uploaderBody, uploaderJs);

const out = `// 자동 생성 파일 — 직접 수정 금지. 원본: widget/gallery.js·widget/uploader.js, 빌드: npm run build:widget
export const GALLERY_HTML = ${JSON.stringify(galleryHtml)};
export const UPLOADER_HTML = ${JSON.stringify(uploaderHtml)};
`;

writeFileSync(resolve(root, 'src/gallery-html.ts'), out);
console.log(
  `src/gallery-html.ts 생성 완료 — gallery ${(galleryHtml.length / 1024).toFixed(1)}KB, uploader ${(uploaderHtml.length / 1024).toFixed(1)}KB`,
);
