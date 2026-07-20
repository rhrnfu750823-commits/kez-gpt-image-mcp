/**
 * kez-gpt-image-mcp — OpenAI gpt-image 이미지 생성 MCP 서버 (Cloudflare Worker)
 *
 * 도구 7종 (JSON-RPC 2.0 over HTTP — vault-mcp-worker와 동일 배포 패턴):
 *   generate_image                       (생성 — 결과를 image block으로 인라인 렌더)
 *   show_creations                       (기존 결과 URL/key → 채팅 인라인 렌더)
 *   register_character, register_style   (참조 자산 등록 = 데이터, 배포 불필요)
 *   list_assets, get_asset, delete_asset (자산 관리)
 *
 * 인증: Bearer (MCP_AUTH_TOKEN secret) — 핸들러 진입 직후 검증, 불일치 시 즉시 401.
 * 백엔드: OpenAI Images API (OPENAI_API_KEY secret — 권한 제한 키 + 월 예산 캡 전제).
 * 저장: R2(ASSETS, 비공개 버킷)
 *   characters/{slug}/01.png~05.png + meta.json
 *   styles/{slug}/anchor-01.png~     + meta.json
 *   outputs/{YYYY-MM}/{uuid}.png
 * 파일 서빙: GET /files/{key}?sig=HMAC — 버킷을 공개하지 않고 서명 URL로만 노출.
 */
import { z } from 'zod';
import { GALLERY_HTML, UPLOADER_HTML } from './gallery-html';

/** Cloudflare Images 바인딩 최소 인터페이스 — 선택 기능이라 workers-types 버전에 의존하지 않게 자체 선언. */
interface ImagesService {
  input(stream: ReadableStream): {
    transform(options: { width?: number; height?: number; fit?: string }): ReturnType<ImagesService['input']>;
    output(options: { format: string; quality?: number }): Promise<{ response(): Response }>;
  };
}

export interface Env {
  OPENAI_API_KEY: string;
  MCP_AUTH_TOKEN: string;
  /**
   * 커넥터 연결 비밀번호 (OAuth /authorize 게이트). claude.ai가 URL만으로 OAuth를 강제하므로,
   * 이 비번을 통과해야만 access_token을 발급한다 — URL만 아는 익명 호출자의 토큰 탈취(옆문)를 차단.
   * 필수: 미설정이면 /authorize POST가 무조건 거부(열린 서버 방지).
   */
  OAUTH_PASSCODE?: string;
  /**
   * OAuth 서명 code/refresh_token의 HMAC 키. 미설정 시 MCP_AUTH_TOKEN으로 폴백.
   * 별도 랜덤값으로 두면 access_token이 유출돼도 인증 code 위조가 불가(블래스트 반경 격리).
   */
  OAUTH_SIGNING_KEY?: string;
  ASSETS: R2Bucket;
  /**
   * 선택 — wrangler.toml에 `[images] binding = "IMAGES"` 추가 시 활성.
   * 인라인 image block 한도를 넘는 대형 이미지의 자동 축소에 사용.
   * 미바인딩이면 원본 그대로 인코딩 (maybeShrinkForInline 참고).
   */
  IMAGES?: ImagesService;
  /**
   * 잠긴 자산 slug 목록 (쉼표 구분, wrangler.toml vars). 교육 시리즈용 고정 레퍼런스가
   * 디자인 작업 중 실수로 덮어써지는 것을 방지. `edu-*`처럼 *로 끝나면 접두 매칭.
   */
  PROTECTED_SLUGS?: string;
  /** OpenAI 호출 중계용 DO (위치 힌트 enam) — 미지원 지역 엣지發 403 회피. */
  RELAY?: DurableObjectNamespace;
  /** 비동기 생성 job 큐 DO — wait:false 주문의 적재·페이싱·재시도·회수. */
  JOBS?: DurableObjectNamespace;
}

/**
 * OpenAI 호출 릴레이 DO. 위치 힌트(enam, 미국 동부)로 생성되어 그곳에서 실행되므로
 * 아웃바운드가 항상 OpenAI 지원 지역에서 나간다. Smart Placement는 휴리스틱이라
 * 실행 위치가 HKG 등 미지원 지역으로 회귀할 수 있음이 실측됨(403 Country not supported 재발).
 */
export class OpenAIRelay {
  async fetch(req: Request): Promise<Response> {
    return fetch(req);
  }
}

/** slug가 보호 목록에 해당하는지 — 정확 일치 또는 `prefix-*` 접두 매칭. */
function isProtectedSlug(env: Env, slug: string): boolean {
  return (env.PROTECTED_SLUGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((p) => (p.endsWith('*') ? slug.startsWith(p.slice(0, -1)) : slug === p));
}

// ---------- utilities ----------

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 바이트 → 순수 base64. MCP image block의 data 필드 규격 — data URI 접두사 금지. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000; // String.fromCharCode 인자 수 한도 회피
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 에러 메시지 등 외부 유래 문자열에서 API 키 형태를 마스킹 — 응답·로그 비노출 원칙. */
export function sanitize(msg: string): string {
  return msg.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

// ---------- 서명 파일 URL (비공개 버킷 + HMAC 쿼리) ----------

export async function fileSig(env: Env, key: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.MCP_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(key));
  return [...new Uint8Array(mac)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function fileUrl(env: Env, origin: string, key: string): Promise<string> {
  const encoded = key
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `${origin}/files/${encoded}?sig=${await fileSig(env, key)}`;
}

// ---------- 업로드 토큰 (MCP_AUTH_TOKEN에서 결정론적 파생 — 별도 secret 불필요) ----------
//
// HMAC은 일방향이라 이 토큰이 유출돼도 MCP_AUTH_TOKEN 복원·파일서명(fileSig) 위조가 불가능하다.
// → 업로드 권한과 파일서명 키를 분리(블래스트 반경 격리)하면서도 사용자는 secret 하나(MCP_AUTH_TOKEN)만
//   관리한다. 값은 결정론적이라 MCP_AUTH_TOKEN이 바뀌지 않는 한 고정 → 클라이언트가 재사용 가능.
const UPLOAD_TOKEN_LABEL = 'kez-upload-v1';
async function uploadToken(env: Env): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.MCP_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(UPLOAD_TOKEN_LABEL));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 업로드 허용 mime → 확장자. 그 외 mime은 415로 거절. */
const UPLOAD_MIME_EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — 앵커 레퍼런스 용도엔 충분, 남용 차단

// ---------- R2 자산 레이어 ----------

type AssetKind = 'character' | 'style';

interface AssetMeta {
  slug: string;
  kind: AssetKind;
  description: string;
  fixed_prompt: string;
  files: string[]; // R2 키, 첨부 순서 그대로
  updated_at: string;
  source?: 'tool' | 'widget'; // 등록 경로 (위젯 업로드는 'widget')
  status?: 'draft' | 'ready'; // fixed_prompt 미작성이면 'draft' (generate 불가)
}

/** 빈 문자열·공백뿐이면 false. fixed_prompt 게이트 판정의 단일 기준. */
const hasText = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0;

const kindPrefix = (kind: AssetKind): string => (kind === 'character' ? 'characters/' : 'styles/');

async function listAllKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.ASSETS.list({ prefix, cursor });
    keys.push(...res.objects.map((o) => o.key));
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

async function loadMeta(env: Env, kind: AssetKind, slug: string): Promise<AssetMeta | null> {
  const obj = await env.ASSETS.get(`${kindPrefix(kind)}${slug}/meta.json`);
  if (!obj) return null;
  return (await obj.json()) as AssetMeta;
}

/** 이 버킷의 이미지 key 패턴 — 생 base64와 같은 분기를 공유하므로 좁게 판별한다. */
// uploads/ = /assets/upload 엔드포인트가 만든 외부 업로드 앵커 (register image_urls에 bare key로 직접 넣을 수 있게).
const R2_IMAGE_KEY_RE = /^(outputs|characters|styles|uploads)\/[^?\s]+\.(png|webp|jpe?g|gif)$/i;

/**
 * 등록 입력 1건 → 이미지 바이트 + contentType.
 * 형식 5종을 한 관문에서 흡수: ① 자기 서명 URL(/files/…) ② R2 key ③ 외부 http(s) URL
 * ④ data URI ⑤ 생 base64. ①②는 같은 버킷이므로 HTTP 왕복 없이 R2에서 직접 읽는다 —
 * Workers는 자기 도메인 fetch를 차단(1042)하므로 ①을 fetch로 처리하면 404가 났었다.
 */
async function loadImageSource(env: Env, src: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  // ①② 자기 서명 URL 또는 R2 key → 버킷 직접 read (show_creations의 resolveToKey 재사용)
  const maybeKey = /^https?:\/\//.test(src) ? resolveToKey(src) : R2_IMAGE_KEY_RE.test(src) ? src : null;
  if (maybeKey !== null) {
    const obj = await env.ASSETS.get(maybeKey);
    if (!obj) throw new Error(`이미지 없음: ${maybeKey} — generate_image 결과 key/URL인지 확인하라.`);
    return {
      bytes: new Uint8Array(await obj.arrayBuffer()),
      contentType: obj.httpMetadata?.contentType ?? 'image/png',
    };
  }
  // ③ 외부 URL
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`참조 이미지 다운로드 실패 (${r.status}): ${src}`);
    const contentType = (r.headers.get('Content-Type') ?? 'image/png').split(';')[0];
    return { bytes: new Uint8Array(await r.arrayBuffer()), contentType };
  }
  // ④⑤ data URI / 생 base64
  const dataUri = /^data:(image\/\w+);base64,(.+)$/s.exec(src);
  const b64 = dataUri ? dataUri[2] : src;
  try {
    return { bytes: base64ToBytes(b64), contentType: dataUri ? dataUri[1] : 'image/png' };
  } catch {
    throw new Error('이미지 입력 해석 실패 — R2 key, http(s) URL, data URI, 또는 base64 문자열이어야 한다.');
  }
}

// ---------- OpenAI Images API ----------

/**
 * 단가표 (USD / 1M tokens). 변경 시 여기만 갱신 — openai.com/api/pricing 대조.
 * 미등록 모델은 gpt-image-1 단가로 폴백(보수적 추정).
 */
const PRICING: Record<string, { textIn: number; imageIn: number; imageOut: number }> = {
  'gpt-image-1': { textIn: 5, imageIn: 10, imageOut: 40 },
  'gpt-image-1.5': { textIn: 5, imageIn: 8, imageOut: 32 },
  'gpt-image-2': { textIn: 5, imageIn: 8, imageOut: 32 },
};

interface OpenAIUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

interface OpenAIImagesResponse {
  data: Array<{ b64_json: string }>;
  usage?: OpenAIUsage;
  /** 일부 응답에 포함되는 실제 스냅샷 모델명 (예: gpt-image-2-2026-04-21). 없으면 미포함. */
  model?: string;
}

export function estimateCost(model: string, usage: OpenAIUsage | undefined): number | null {
  if (!usage) return null;
  const rate = PRICING[model] ?? PRICING['gpt-image-1'];
  const textIn = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const usd = (textIn * rate.textIn + imageIn * rate.imageIn + out * rate.imageOut) / 1_000_000;
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * OpenAI 에러 → 에이전트가 다음 행동을 판단할 수 있는 메시지로 변환.
 * 키·토큰은 절대 포함하지 않는다 (sanitize 이중 방어).
 */
function mapOpenAIError(status: number, body: string): Error {
  let message = '';
  let code = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string; type?: string } };
    message = parsed.error?.message ?? '';
    code = parsed.error?.code ?? parsed.error?.type ?? '';
  } catch {
    message = body.slice(0, 300);
  }
  message = sanitize(message);

  if (status === 400 && (code.includes('moderation') || /moderation|safety|content policy/i.test(message))) {
    return new Error(
      `moderation 차단 — 프롬프트에서 정책 저촉 가능 표현(실존 인물·폭력·선정성 등)을 완화해 재시도하라. OpenAI 응답: ${message}`,
    );
  }
  if (status === 401) {
    return new Error('OpenAI 인증 실패 — OPENAI_API_KEY 시크릿이 유효한지 확인하라 (wrangler secret put OPENAI_API_KEY).');
  }
  if (status === 402 || code === 'insufficient_quota' || /quota|billing.*limit|budget/i.test(message)) {
    return new Error('예산 소진 — OpenAI 프로젝트 월 예산 캡 또는 크레딧 한도 도달. 대시보드에서 사용량 확인 후 캡 상향 또는 대기.');
  }
  if (status === 429) {
    return new Error('레이트리밋 — 요청이 너무 잦다. 잠시 후 재시도하라.');
  }
  return new Error(`OpenAI 오류 (${status}): ${message || '상세 없음'}`);
}

async function callOpenAI(env: Env, path: string, body: FormData | string): Promise<OpenAIImagesResponse> {
  const headers: Record<string, string> = { Authorization: `Bearer ${env.OPENAI_API_KEY}` };
  if (typeof body === 'string') headers['Content-Type'] = 'application/json';
  const url = `https://api.openai.com${path}`;
  const init: RequestInit = { method: 'POST', headers, body };
  // RELAY 바인딩이 있으면 미국 동부 DO를 경유 — 엣지 위치와 무관하게 403 지역 차단 회피.
  const r = env.RELAY
    ? await env.RELAY.get(env.RELAY.idFromName('openai-relay'), { locationHint: 'enam' }).fetch(url, init)
    : await fetch(url, init);
  if (!r.ok) throw mapOpenAIError(r.status, await r.text());
  return (await r.json()) as OpenAIImagesResponse;
}

// ---------- 입력 스키마 (Zod — tools/list의 inputSchema도 여기서 생성) ----------

const slugField = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,49}$/, 'slug는 소문자/숫자/하이픈, 1~50자')
  .describe('자산 식별자. 소문자/숫자/하이픈 (예: "kez-girl", "webtoon-flat")');

const registerInput = z.object({
  slug: slugField,
  image_urls: z
    .array(z.string())
    .min(1)
    .max(5)
    .describe(
      '참조 이미지 1~5장. R2 key(예: "outputs/2026-06/….webp"), 이 서버의 서명 URL, 외부 http(s) URL, data URI, base64 모두 허용 — 생성 결과를 그대로 레퍼런스로 등록 가능',
    ),
  description: z.string().default('').describe('자산 설명 (사람용 메모)'),
  fixed_prompt: z
    .string()
    .default('')
    .describe('생성 시 자동 결합되는 고정 기술문 (필수 — 비우면 거부된다). 화풍/외형을 한 문단으로 적어라'),
  confirm: z
    .boolean()
    .default(false)
    .describe('같은 slug가 다른 kind(character↔style)에 이미 있을 때, 충돌을 알고도 등록하려면 true'),
});

/** 채팅 내 업로더 위젯 트리거 입력 — 위젯 프리필용(선택). 이미지 바이트는 받지 않는다. */
const uploaderInput = z.object({
  kind: z.enum(['character', 'style']).optional().describe('위젯에서 미리 선택할 자산 종류 (선택)'),
  slug: slugField.optional().describe('위젯에 미리 채울 이름 (선택)'),
});

/** 허용 모델 화이트리스트 — 기본은 gpt-image-2 (CJK/한글 렌더링 개선, generations·edits 모두 지원). */
const ALLOWED_MODELS = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'] as const;

const generateInput = z.object({
  prompt: z.string().min(1).describe('장면 묘사. style의 화풍 기술문이 자동으로 앞에 결합된다'),
  character: slugField.optional().describe('캐릭터 slug — 등록된 레퍼런스 시트(최대 5장)를 참조로 첨부. 인물 컷이면 지정 권장'),
  // style은 필수 — 화풍 일관성의 핵심 게이트. 스키마(required) + 핸들러 가드 이중화.
  style: slugField.describe('화풍 slug (필수) — 등록된 앵커 1~2장 + 고정 화풍 프롬프트가 자동 결합. list_assets로 등록 목록 확인'),
  quality: z.enum(['low', 'medium', 'high']).default('medium').describe('시안=low, 최종=high'),
  size: z
    .union([z.literal('auto'), z.string().regex(/^\d{3,4}x\d{3,4}$/)])
    .default('1024x1536')
    .describe('출력 크기. 기본 1024x1536(세로형). 인스타 4:5는 gpt-image-2에서 1088x1360'),
  n: z.number().int().min(1).max(4).default(1).describe('생성 매수 (1~4)'),
  model: z
    .enum(ALLOWED_MODELS)
    .default('gpt-image-2')
    .describe('OpenAI 이미지 모델. 기본 gpt-image-2 (한글 텍스트 렌더링 개선). gpt-image-1.5/1도 허용'),
  wait: z
    .boolean()
    .default(true)
    .describe(
      'true(기본)=완성까지 동기 대기 후 결과 이미지를 그 응답에서 위젯으로 바로 표시(권장 — 단일/소량 컷은 항상 이쪽). false=즉시 job_id만 반환(이미지 없음, 위젯은 "생성 중" 표시)하고 여러 컷을 연속 적재 → check_jobs로 회수 시 done 컷이 한 번에 위젯 표시된다. 서버가 분당 5장 페이싱·재시도 처리, 세션이 끊겨도 job은 완료. false는 5장 이상 대량일 때만 쓰고, 그 외엔 wait를 생략(true)해 한 응답에서 끝내라',
    ),
});

// 배치 컷 공통 필드 — generate_image와 동일하되 모두 선택(defaults/컷에서 채움). prompt만 컷 필수.
const batchDefaults = z.object({
  style: slugField.optional().describe('화풍 slug (defaults 또는 각 컷에 필수)'),
  character: slugField.optional().describe('캐릭터 slug (선택)'),
  quality: z.enum(['low', 'medium', 'high']).optional().describe('시안=low, 최종=high'),
  size: z.union([z.literal('auto'), z.string().regex(/^\d{3,4}x\d{3,4}$/)]).optional().describe('출력 크기'),
  n: z.number().int().min(1).max(4).optional().describe('컷당 매수 (1~4)'),
  model: z.enum(ALLOWED_MODELS).optional().describe('OpenAI 이미지 모델'),
});
const batchCut = batchDefaults.extend({
  prompt: z.string().min(1).describe('장면 묘사 (컷 필수). style 화풍 기술문이 자동 결합된다'),
});
const generateBatchInput = z.object({
  defaults: batchDefaults.optional().describe('모든 컷에 공통 적용할 기본값 — 각 컷이 같은 키로 덮어쓴다. 보통 style을 여기 둔다'),
  cuts: z.array(batchCut).min(1).max(20).describe('생성할 컷 목록 (1~20). 각 컷 = generate_image와 같은 인자(prompt 필수)'),
});

const kindField = z.enum(['character', 'style']).describe('자산 종류');

const getAssetInput = z.object({ kind: kindField, slug: slugField });

const deleteAssetInput = z.object({
  kind: kindField,
  slug: slugField,
  confirm: z.boolean().default(false).describe('실수 방지 — 반드시 true로 명시해야 삭제 실행'),
});

const listAssetsInput = z.object({});

const checkJobsInput = z.object({
  job_ids: z
    .array(z.string())
    .min(1)
    .max(20)
    .describe('generate_image(wait:false)가 반환한 job_id 목록 (1~20개)'),
  timeout_seconds: z
    .number()
    .int()
    .min(0)
    .max(90)
    .default(50)
    .describe(
      'long-poll 대기 초(기본 50). 요청한 job이 모두 끝(done/failed)날 때까지 최대 이 시간 동안 서버가 응답을 보류했다가 결과와 함께 한 번에 반환한다 — 따로 지정 안 해도 기본 long-poll이 걸리니 check_jobs를 연달아 반복 호출하지 마라. 0=즉시 1회 조회. (적재 후 10분 지난 job은 서버가 자동으로 시간초과 실패 처리하므로 무한정 기다리지 않는다.)',
    ),
});

const showCreationsInput = z.object({
  urls: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe('이 서버가 발급한 결과 서명 URL 또는 R2 key (예: "outputs/2026-06/….png"). 외부 이미지 URL도 허용. 혼용 가능'),
});

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

// ---------- MCP Apps (SEP-1865) UI 리소스 ----------
//
// MCP image content block은 Claude Desktop에서 크기 무관 렌더되지 않음(3.4MB PNG ✗,
// 130KB webp ✗ 실측). 위젯 경로로 전환: 도구가 ui:// 리소스를 _meta로 참조하면
// 호스트가 샌드박스 iframe에 HTML을 렌더하고, structuredContent를 알림으로 전달한다.
//
// 갤러리 HTML은 widget/gallery.js를 esbuild로 ext-apps SDK까지 인라인 번들한 생성물
// (src/gallery-html.ts, `npm run build:widget`) — 런타임 외부 스크립트 의존 0.

const UI_GALLERY_URI = 'ui://kez-image-mcp/gallery.html';
const UI_UPLOADER_URI = 'ui://kez-image-mcp/uploader.html';
const UI_RESOURCE_MIME = 'text/html;profile=mcp-app';

/** 리소스 _meta — CSP: 이미지(워커 서명 URL) 출처만 허용. 스크립트는 인라인이라 선언 불필요. */
function uiResourceMeta(origin: string): Record<string, unknown> {
  return {
    ui: {
      csp: { resourceDomains: [origin] },
      prefersBorder: true,
    },
  };
}

/**
 * 업로더 위젯 _meta — connectDomains로 워커 origin에 fetch(PUT/POST) 허용(CSP connect-src).
 * 이게 있어야 위젯이 이미지 바이트를 워커로 직접 보낼 수 있다(LLM 미통과). resourceDomains는 썸네일용.
 */
function uiUploaderMeta(origin: string): Record<string, unknown> {
  return {
    ui: {
      csp: { connectDomains: [origin], resourceDomains: [origin] },
      prefersBorder: true,
    },
  };
}

/** 업로더 위젯 HTML에 저권한 업로드 토큰·워커 origin을 주입 (resources/read는 Bearer 게이트 안이라 토큰 비공개). */
async function uploaderHtml(env: Env, origin: string): Promise<string> {
  return UPLOADER_HTML.replaceAll('__UPLOAD_TOKEN__', await uploadToken(env)).replaceAll('__WORKER_ORIGIN__', origin);
}

// ---------- 도구 정의 (tools/list 응답) ----------

const ASSET_SUMMARY_PROPS = {
  slug: { type: 'string' },
  kind: { type: 'string', enum: ['character', 'style'] },
  description: { type: 'string' },
  fixed_prompt: { type: 'string' },
  image_count: { type: 'number' },
  thumbnail_url: { type: 'string' },
  updated_at: { type: 'string' },
  source: { type: 'string', enum: ['tool', 'widget'], description: '등록 경로' },
  status: { type: 'string', enum: ['draft', 'ready'], description: 'draft=fixed_prompt 미작성(generate 불가)' },
  complete: { type: 'boolean', description: 'fixed_prompt가 채워져 generate에서 쓸 수 있는지' },
  warning: { type: 'string', description: 'draft일 때 ⚠️ 안내' },
} as const;

export const TOOLS = [
  {
    name: 'generate_image',
    title: '이미지 생성',
    description:
      'OpenAI 이미지 생성. style slug 필수(화풍 일관성 게이트) — 등록된 앵커를 첨부해 /v1/images/edits로 생성하며, character slug를 더하면 캐릭터 시트도 함께 첨부된다. 결과는 R2에 저장되고 서명 URL과 함께 image block으로 채팅에 인라인으로 띄운다.',
    inputSchema: toInputSchema(generateInput),
    outputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '생성된 이미지 서명 URL 목록' },
        model: { type: 'string' },
        quality: { type: 'string' },
        size: { type: 'string' },
        model_snapshot: { type: ['string', 'null'], description: 'OpenAI가 알려준 실제 스냅샷 (예: gpt-image-2-2026-04-21)' },
        usage: {
          type: ['object', 'null'],
          description: 'OpenAI usage 토큰 (input/output)',
        },
        estimated_cost_usd: { type: ['number', 'null'], description: '단가표 기반 추정 비용 (USD)' },
        metadata: { type: 'object', description: '생성 메타데이터 (사이드카 .json과 동일 — 프롬프트·참조·비용·생성일)' },
        items: {
          type: 'array',
          description: '이미지별 {url, metadata} — 위젯이 상세 카드로 렌더(자동 표시). show_creations와 동일 형태.',
          items: {
            type: 'object',
            properties: { url: { type: 'string' }, metadata: { type: ['object', 'null'] } },
            required: ['url'],
          },
        },
        job_id: { type: 'string', description: 'wait:false일 때만 — check_jobs로 회수할 job 식별자' },
        status: { type: 'string', description: 'wait:false일 때만 — "queued"' },
      },
      required: [],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    // 생성 1회로 갤러리 위젯이 자동 렌더되도록 UI 리소스를 직접 참조(show_creations 수동 호출 불필요).
    _meta: { ui: { resourceUri: UI_GALLERY_URI }, 'ui/resourceUri': UI_GALLERY_URI },
  },
  {
    name: 'generate_batch',
    title: '여러 컷 일괄 생성 (비동기)',
    description:
      '여러 컷을 한 번의 호출로 큐에 적재한다. 컷이 2개 이상이면 generate_image를 여러 번 부르지 말고 반드시 이 도구를 써라 — 호출 1번·카드 1개로 끝나고, check_jobs(기본 long-poll)를 1회 부르면 완성 컷이 한 번에 갤러리로 표시된다(반복 폴링 불필요). 각 컷은 generate_image와 같은 인자(prompt 필수, style 필수)이며, 공통값은 defaults에 두면 컷마다 반복하지 않아도 된다(보통 style). 이미지 바이트는 싣지 않는다(캐릭터/화풍은 등록된 slug로 참조). 서버가 분당 5장 페이싱·재시도·10분 시간초과를 처리한다.',
    inputSchema: toInputSchema(generateBatchInput),
    outputSchema: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'string' }, description: '적재된 컷별 job_id — check_jobs로 회수' },
        count: { type: 'number', description: '적재된 컷 수' },
        status: { type: 'string', description: '"queued"' },
        errors: {
          type: 'array',
          description: '거부된 컷 (있을 때만)',
          items: { type: 'object', properties: { index: { type: 'number' }, error: { type: 'string' } } },
        },
      },
      required: ['job_ids', 'count'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    // 적재 영수증을 "N컷 생성 중" 카드 1개로 — 결과는 check_jobs가 표시.
    _meta: { ui: { resourceUri: UI_GALLERY_URI }, 'ui/resourceUri': UI_GALLERY_URI },
  },
  {
    name: 'show_creations',
    title: '이미지 갤러리 표시',
    description:
      '결과 이미지를 채팅에 인라인 위젯(이미지 그리드)으로 띄운다. 이 서버가 발급한 서명 URL 또는 R2 key를 1~10개 받는다. 호스트가 MCP Apps를 지원하면 iframe 갤러리로 렌더되고, 아니면 텍스트(urls)로 폴백.',
    inputSchema: toInputSchema(showCreationsInput),
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '이미지 수' },
        urls: { type: 'array', items: { type: 'string' }, description: '서명 URL 목록 (후방호환)' },
        items: {
          type: 'array',
          description: '이미지별 {url, metadata} — metadata(사이드카)가 있으면 위젯이 상세 카드로 렌더',
          items: {
            type: 'object',
            properties: { url: { type: 'string' }, metadata: { type: ['object', 'null'] } },
            required: ['url'],
          },
        },
      },
      required: ['count', 'urls', 'items'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: UI_GALLERY_URI }, 'ui/resourceUri': UI_GALLERY_URI },
  },
  {
    name: 'check_jobs',
    title: '생성 job 상태 확인',
    description:
      'generate_image(wait:false)로 적재한 비동기 job들의 상태를 회수하고, done인 컷들을 갤러리 위젯으로 바로 표시한다. timeout_seconds=60으로 호출하면 모든 컷이 끝날 때까지 서버가 보류했다가 결과와 함께 한 번에 반환하므로 반복 호출(폴링) 없이 1회로 끝난다 — check_jobs를 여러 번 부르지 말고 timeout_seconds를 줘라. done이면 result에 urls·metadata 포함. 완료 컷은 이 도구 한 번으로 표시되므로 show_creations를 따로 부를 필요가 없다. 세션이 끊겼어도 job_id만 있으면 회수 가능.',
    inputSchema: toInputSchema(checkJobsInput),
    outputSchema: {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              job_id: { type: 'string' },
              status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'not_found'] },
              attempts: { type: 'number' },
              result: { type: 'object', description: 'done일 때 — generate_image 동기 응답과 동일 형태(urls, metadata 등)' },
              error: { type: 'string', description: '실패/재시도 중일 때 마지막 에러' },
            },
            required: ['job_id', 'status'],
          },
        },
        count: { type: 'number', description: 'done 컷 수 (위젯 렌더용)' },
        urls: { type: 'array', items: { type: 'string' }, description: 'done 컷 서명 URL (후방호환)' },
        items: {
          type: 'array',
          description: 'done 컷별 {url, metadata} — 위젯이 상세 카드로 자동 렌더',
          items: {
            type: 'object',
            properties: { url: { type: 'string' }, metadata: { type: ['object', 'null'] } },
            required: ['url'],
          },
        },
      },
      required: ['jobs'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    // done job들을 한 번에 위젯으로 표시 — 별도 show_creations 호출 불필요(토큰 절약).
    _meta: { ui: { resourceUri: UI_GALLERY_URI }, 'ui/resourceUri': UI_GALLERY_URI },
  },
  {
    name: 'open_reference_uploader',
    title: '레퍼런스 업로드 위젯 열기',
    description:
      '캐릭터/화풍 레퍼런스 이미지를 채팅 안에서 끌어다 놓아 등록하는 위젯을 띄운다. 사용자가 이미지를 첨부/등록하고 싶어 하면(예: "이 이미지 레퍼런스로 등록해줘") 이 도구를 호출하라. 이미지 바이트는 위젯에서 워커로 직접 업로드되어 LLM(이 대화)을 통과하지 않는다 — 토큰을 쓰지 않는다. 사용자가 채팅 메시지에 이미지를 첨부했더라도, 그 base64를 register_character/register_style로 넘기지 말고 이 위젯을 띄워 위젯에 끌어놓게 하라. kind/slug를 미리 채워줄 수 있다.',
    inputSchema: toInputSchema(uploaderInput),
    outputSchema: {
      type: 'object',
      properties: { kind: { type: ['string', 'null'] }, slug: { type: ['string', 'null'] } },
      required: [],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    // 위젯 자동 표시 — 채팅 안에서 끌어놓기 업로드(이미지 바이트 LLM 미통과).
    _meta: { ui: { resourceUri: UI_UPLOADER_URI }, 'ui/resourceUri': UI_UPLOADER_URI },
  },
  {
    name: 'register_character',
    title: '캐릭터 등록',
    description:
      '캐릭터 레퍼런스 시트(1~5장)를 R2에 등록. fixed_prompt 필수(외형 기술문) — 비우면 거부된다. 같은 slug 재등록은 전체 교체(덮어쓰기). fixed_prompt는 생성 시 역할 지시문에 자동 결합된다. 같은 slug가 style에 이미 있으면 거부되니 confirm:true로 통과.',
    inputSchema: toInputSchema(registerInput),
    outputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        kind: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        replaced: { type: 'boolean', description: '기존 자산을 교체했는지' },
      },
      required: ['slug', 'kind', 'files', 'replaced'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'register_style',
    title: '화풍 등록',
    description:
      '화풍 앵커 이미지(1~5장, 생성 시 앞 2장 사용)를 R2에 등록. fixed_prompt 필수(고정 화풍 기술문) — 비우면 거부된다. fixed_prompt는 모든 생성 프롬프트 맨 앞에 결합된다. 같은 slug 재등록은 전체 교체. 같은 slug가 character에 이미 있으면 거부되니 confirm:true로 통과.',
    inputSchema: toInputSchema(registerInput),
    outputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        kind: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        replaced: { type: 'boolean' },
      },
      required: ['slug', 'kind', 'files', 'replaced'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'list_assets',
    title: '자산 목록',
    description: '등록된 캐릭터/화풍 전체 목록 + meta 요약 + 썸네일 URL.',
    inputSchema: toInputSchema(listAssetsInput),
    outputSchema: {
      type: 'object',
      properties: {
        characters: { type: 'array', items: { type: 'object', properties: ASSET_SUMMARY_PROPS } },
        styles: { type: 'array', items: { type: 'object', properties: ASSET_SUMMARY_PROPS } },
      },
      required: ['characters', 'styles'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_asset',
    title: '자산 상세',
    description: '캐릭터/화풍 하나의 상세 — 전체 이미지 서명 URL + meta.',
    inputSchema: toInputSchema(getAssetInput),
    outputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        kind: { type: 'string' },
        description: { type: 'string' },
        fixed_prompt: { type: 'string' },
        image_urls: { type: 'array', items: { type: 'string' } },
        updated_at: { type: 'string' },
      },
      required: ['slug', 'kind', 'image_urls'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'delete_asset',
    title: '자산 삭제',
    description: '캐릭터/화풍 자산을 R2에서 삭제. 실수 방지를 위해 confirm: true 필수.',
    inputSchema: toInputSchema(deleteAssetInput),
    outputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        kind: { type: 'string' },
        deleted_files: { type: 'number' },
      },
      required: ['slug', 'kind', 'deleted_files'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

// ---------- 도구 구현 ----------

async function registerAsset(
  env: Env,
  origin: string,
  kind: AssetKind,
  args: Record<string, unknown>,
  opts: { source?: 'tool' | 'widget'; enforceFixedPrompt?: boolean } = {},
): Promise<Record<string, unknown>> {
  const a = registerInput.parse(args);
  if (isProtectedSlug(env, a.slug)) {
    throw new Error(
      `잠긴 자산이다(고정 레퍼런스): '${a.slug}' — 교육 시리즈 일관성 보호를 위해 덮어쓸 수 없다. 갱신하려면 새 slug(예: ${a.slug}-v3)로 등록하라.`,
    );
  }
  // 게이트: 도구 경로(register_*)는 fixed_prompt 필수. 비면 일관성 게이트가 무력화되므로 거부.
  // (위젯 경로는 enforce 없이 draft로 허용 — 이후 register_*로 채운다.)
  if (opts.enforceFixedPrompt && !hasText(a.fixed_prompt)) {
    throw new Error(
      `거부: fixed_prompt 필수 — ${kind} '${a.slug}'를 generate에서 일관되게 쓰려면 고정 기술문이 있어야 한다. ${kind === 'style' ? '화풍(선·톤·색·매체)' : '외형(얼굴·머리·복장 등)'}을 한 문단으로 적어 다시 등록하라.`,
    );
  }
  // slug 네임스페이스 충돌 가드 — 같은 slug가 다른 kind에 이미 있으면 거부(confirm으로 통과).
  const otherKind: AssetKind = kind === 'character' ? 'style' : 'character';
  if (!a.confirm && (await loadMeta(env, otherKind, a.slug))) {
    throw new Error(
      `경고: slug '${a.slug}'가 이미 ${otherKind}로 등록돼 있다. character와 style가 같은 이름을 공유하면 혼동을 유발한다. 다른 slug를 쓰거나, 의도한 것이면 confirm:true로 다시 호출하라.`,
    );
  }
  const prefix = `${kindPrefix(kind)}${a.slug}/`;

  // 파괴적 교체 전에 입력 전체를 먼저 확보 — 일부 다운로드 실패로 자산이 반파되는 일 방지.
  const blobs: Array<{ bytes: Uint8Array; contentType: string }> = [];
  for (const src of a.image_urls) blobs.push(await loadImageSource(env, src));

  const existing = await listAllKeys(env, prefix);
  for (const key of existing) await env.ASSETS.delete(key);

  const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
  const files: string[] = [];
  for (let i = 0; i < blobs.length; i++) {
    const ext = EXT[blobs[i].contentType] ?? 'png';
    const name = kind === 'style' ? `anchor-${pad2(i + 1)}.${ext}` : `${pad2(i + 1)}.${ext}`;
    const key = prefix + name;
    await env.ASSETS.put(key, blobs[i].bytes, { httpMetadata: { contentType: blobs[i].contentType } });
    files.push(key);
  }

  const complete = hasText(a.fixed_prompt);
  const meta: AssetMeta = {
    slug: a.slug,
    kind,
    description: a.description,
    fixed_prompt: a.fixed_prompt,
    files,
    updated_at: new Date().toISOString(),
    source: opts.source ?? 'tool',
    status: complete ? 'ready' : 'draft',
  };
  await env.ASSETS.put(prefix + 'meta.json', JSON.stringify(meta, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });

  const urls: string[] = [];
  for (const key of files) urls.push(await fileUrl(env, origin, key));
  return {
    slug: a.slug,
    kind,
    files: urls,
    replaced: existing.length > 0,
    source: meta.source,
    status: meta.status,
    complete,
    // draft(이미지만)면 다음 액션을 명시 — 위젯·도구 공통으로 surface된다.
    ...(complete
      ? {}
      : {
          hint: `이미지 등록됨(slug=${a.slug}, kind=${kind}) — 단, fixed_prompt가 비어 draft 상태다. register_${kind}(slug='${a.slug}', fixed_prompt='...')로 ${kind === 'style' ? '화풍' : '외형'} 기술문을 채워야 generate에서 사용 가능하다.`,
        }),
  };
}

async function listAssets(env: Env, origin: string): Promise<Record<string, unknown>> {
  const summarize = async (kind: AssetKind): Promise<Array<Record<string, unknown>>> => {
    const prefix = kindPrefix(kind);
    const res = await env.ASSETS.list({ prefix, delimiter: '/' });
    const out: Array<Record<string, unknown>> = [];
    for (const slugPrefix of res.delimitedPrefixes) {
      const slug = slugPrefix.slice(prefix.length).replace(/\/$/, '');
      const meta = await loadMeta(env, kind, slug);
      if (!meta) continue;
      const complete = hasText(meta.fixed_prompt);
      out.push({
        slug: meta.slug,
        kind,
        description: meta.description,
        fixed_prompt: meta.fixed_prompt,
        image_count: meta.files.length,
        thumbnail_url: meta.files.length ? await fileUrl(env, origin, meta.files[0]) : '',
        updated_at: meta.updated_at,
        source: meta.source ?? 'tool',
        status: meta.status ?? (complete ? 'ready' : 'draft'),
        complete,
        ...(complete ? {} : { warning: `⚠️ draft — fixed_prompt 미작성, generate 불가. register_${kind}로 채워라.` }),
      });
    }
    return out;
  };
  return { characters: await summarize('character'), styles: await summarize('style') };
}

async function getAsset(env: Env, origin: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = getAssetInput.parse(args);
  const meta = await loadMeta(env, a.kind, a.slug);
  if (!meta) throw new Error(`자산 없음: ${a.kind} '${a.slug}' — list_assets로 등록 목록을 확인하라.`);
  const image_urls: string[] = [];
  for (const key of meta.files) image_urls.push(await fileUrl(env, origin, key));
  const complete = hasText(meta.fixed_prompt);
  return {
    slug: meta.slug,
    kind: meta.kind,
    description: meta.description,
    fixed_prompt: meta.fixed_prompt,
    image_urls,
    updated_at: meta.updated_at,
    source: meta.source ?? 'tool',
    status: meta.status ?? (complete ? 'ready' : 'draft'),
    complete,
    ...(complete ? {} : { warning: `⚠️ draft — fixed_prompt 미작성, generate 불가. register_${meta.kind}로 채워라.` }),
  };
}

async function deleteAsset(env: Env, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = deleteAssetInput.parse(args);
  if (isProtectedSlug(env, a.slug)) {
    throw new Error(
      `잠긴 자산이다(고정 레퍼런스): '${a.slug}' — 삭제할 수 없다. 교육 시리즈가 이 자산에 의존한다. 정말 제거가 필요하면 PROTECTED_SLUGS 환경변수에서 먼저 해제하라.`,
    );
  }
  if (a.confirm !== true) {
    throw new Error(`삭제 미실행 — ${a.kind} '${a.slug}'를 정말 삭제하려면 confirm: true를 명시하라.`);
  }
  const prefix = `${kindPrefix(a.kind)}${a.slug}/`;
  const keys = await listAllKeys(env, prefix);
  if (keys.length === 0) throw new Error(`자산 없음: ${a.kind} '${a.slug}'`);
  for (const key of keys) await env.ASSETS.delete(key);
  return { slug: a.slug, kind: a.kind, deleted_files: keys.length };
}

/** OpenAI 입력용 앵커 긴 변 상한 — 레퍼런스는 생김새 참고용이라 512px로 충분 (image_tokens 절감). */
const ANCHOR_MAX_PX = 512;

/**
 * 앵커를 OpenAI 첨부용으로 다운스케일해 가져온다. 결과는 `{key}.512.webp`로 R2에 영구
 * 캐시 — 같은 앵커의 반복 생성에서 변환 0회. 보호 자산도 재등록 없이 첫 생성 때 캐시가 생긴다.
 * IMAGES 바인딩이 없거나 변환 실패면 원본 그대로 (조용한 폴백 — 기존 동작 유지).
 * 사용자에게 보여주는 결과물 해상도와는 무관 — OpenAI로 보내는 입력에만 적용.
 */
async function getScaledAnchor(
  env: Env,
  key: string,
): Promise<{ bytes: ArrayBuffer; name: string; type: string }> {
  const baseName = key.split('/').pop() ?? 'ref.png';
  const cacheKey = `${key}.512.webp`;

  const cached = await env.ASSETS.get(cacheKey);
  if (cached) return { bytes: await cached.arrayBuffer(), name: `${baseName}.512.webp`, type: 'image/webp' };

  const obj = await env.ASSETS.get(key);
  if (!obj) throw new Error(`참조 이미지 누락: ${key} — 해당 자산을 재등록하라.`);
  const original = {
    bytes: await obj.arrayBuffer(),
    name: baseName,
    type: obj.httpMetadata?.contentType ?? 'image/png',
  };
  if (!env.IMAGES) return original;

  try {
    const out = await env.IMAGES.input(new Blob([new Uint8Array(original.bytes)]).stream())
      .transform({ width: ANCHOR_MAX_PX, height: ANCHOR_MAX_PX, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: 85 });
    const scaled = await out.response().arrayBuffer();
    await env.ASSETS.put(cacheKey, scaled, { httpMetadata: { contentType: 'image/webp' } });
    return { bytes: scaled, name: `${baseName}.512.webp`, type: 'image/webp' };
  } catch {
    return original; // 변환 실패는 치명적이지 않음 — 원본으로 생성 진행
  }
}

/**
 * 최종 프롬프트 조립 — 순서 고정:
 *   [style meta의 고정 화풍 기술문] + [참조 이미지 역할 지시문(+캐릭터 고정 기술문)] + [사용자 prompt]
 */
export function assemblePrompt(
  userPrompt: string,
  charMeta: AssetMeta | null,
  styleMeta: AssetMeta | null,
  styleAnchorCount: number,
): string {
  const parts: string[] = [];
  if (styleMeta?.fixed_prompt) parts.push(styleMeta.fixed_prompt);

  const roleLines: string[] = [];
  if (charMeta) {
    roleLines.push(
      `이미지 1~${charMeta.files.length}은 동일 캐릭터의 레퍼런스 시트다. 이 캐릭터의 외형·복장·비율을 정확히 유지하라.`,
    );
    if (charMeta.fixed_prompt) roleLines.push(charMeta.fixed_prompt);
  }
  if (styleAnchorCount > 0) {
    roleLines.push(`마지막 ${styleAnchorCount}장은 화풍 앵커 이미지다. 전체 화풍은 이 앵커를 따른다.`);
  }
  if (roleLines.length) parts.push(roleLines.join(' '));

  parts.push(userPrompt);
  return parts.join('\n\n');
}

// ---------- 인라인 image block (채팅 렌더) ----------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }; // data = 순수 base64 (접두사 없음)

/**
 * 인라인 원본 상한. Claude Desktop은 큰 image 블록을 조용히 드랍한다(실측: 3.4MB base64 미렌더,
 * claude.ai 웹은 렌더). base64 +33% 감안해 1.5MB로 보수 설정 — 초과분은 IMAGES 바인딩 축소 시도.
 */
const MAX_INLINE_BYTES = 1.5 * 1024 * 1024;

/**
 * 인라인 한도 초과 이미지 축소. IMAGES 바인딩(Cloudflare Images)이 있을 때만 동작하고,
 * 없으면 원본 그대로 반환 — Workers 런타임에는 내장 이미지 처리(canvas 등)가 없어
 * 바인딩 없이는 리사이즈가 불가능하다는 한계 때문. 초과분은 클라이언트가 거부할 수 있다.
 */
async function maybeShrinkForInline(
  env: Env,
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (bytes.byteLength <= MAX_INLINE_BYTES || !env.IMAGES) return { bytes, mimeType };
  try {
    const out = await env.IMAGES.input(new Blob([bytes]).stream())
      .transform({ width: 1024 })
      .output({ format: 'image/webp', quality: 80 });
    const resp = out.response();
    return { bytes: new Uint8Array(await resp.arrayBuffer()), mimeType: 'image/webp' };
  } catch {
    return { bytes, mimeType }; // 축소 실패는 치명적이지 않음 — 원본으로 폴백
  }
}

async function toImageBlock(env: Env, bytes: Uint8Array, mimeType: string): Promise<ContentBlock> {
  const shrunk = await maybeShrinkForInline(env, bytes, mimeType);
  return { type: 'image', data: bytesToBase64(shrunk.bytes), mimeType: shrunk.mimeType };
}

/** 생성 메타데이터 사이드카 스키마 — 출력 키 + '.json'에 저장. */
interface GenerationMetadata {
  scene_prompt: string;
  combined_prompt: string;
  model: string;
  size: string;
  quality: string;
  n: number;
  character: { slug: string; anchor_urls: string[] } | null; // anchor_urls = R2 키 (조회 시 서명)
  style: { slug: string; anchor_urls: string[] } | null;
  seed: null;
  seed_note: string;
  usage: OpenAIUsage | null;
  estimated_cost_usd: number | null;
  created_at: string;
}

/** 사이드카의 앵커 R2 키 → 조회 시점 서명 URL로 변환한 사본 (위젯 썸네일용). */
async function signMetadataAnchors(
  env: Env,
  origin: string,
  meta: GenerationMetadata,
): Promise<GenerationMetadata> {
  const sign = async (g: { slug: string; anchor_urls: string[] } | null) =>
    g
      ? { slug: g.slug, anchor_urls: await Promise.all((g.anchor_urls ?? []).map((k) => fileUrl(env, origin, k))) }
      : null;
  return { ...meta, character: await sign(meta.character), style: await sign(meta.style) };
}

/** show_creations 입력 1건 → R2 key (외부 URL이면 null = 그대로 통과). */
function resolveToKey(ref: string): string | null {
  if (!/^https?:\/\//.test(ref)) return ref;
  const u = new URL(ref);
  if (!u.pathname.startsWith('/files/')) return null;
  return u.pathname
    .slice('/files/'.length)
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/');
}

/** 갤러리 위젯이 읽는 structuredContent 형태 — show_creations와 generate_image가 공유. */
function buildGalleryStructured(
  items: Array<{ url: string; metadata: GenerationMetadata | null }>,
): { count: number; urls: string[]; items: Array<{ url: string; metadata: GenerationMetadata | null }> } {
  return { count: items.length, urls: items.map((i) => i.url), items };
}

/**
 * MCP Apps 위젯 경로: 이미지 바이트 대신 서명 URL 배열을 structuredContent로 전달하고,
 * 호스트가 ui:// 갤러리 리소스(iframe)에서 <img>로 로드한다. 텍스트 content는 비-UI 호스트 폴백.
 * 사이드카(.json)가 있으면 items[].metadata로 함께 전달 → 위젯이 상세 카드로 렌더.
 * 사이드카 없는 과거 이미지는 metadata: null → 위젯이 이미지만 표시(폴백).
 */
async function showCreations(env: Env, origin: string, args: Record<string, unknown>): Promise<ToolResult> {
  const a = showCreationsInput.parse(args);
  const items: Array<{ url: string; metadata: GenerationMetadata | null }> = [];
  for (const ref of a.urls) {
    const key = resolveToKey(ref);
    if (key === null) {
      items.push({ url: ref, metadata: null }); // 외부 URL — 위젯 CSP가 차단할 수 있으나 텍스트 폴백으로는 유효
      continue;
    }
    const head = await env.ASSETS.head(key);
    if (!head) throw new Error(`이미지 없음: ${key} — generate_image 결과 URL 또는 R2 key인지 확인하라.`);
    const sidecar = await env.ASSETS.get(`${key}.json`);
    const metadata = sidecar
      ? await signMetadataAnchors(env, origin, (await sidecar.json()) as GenerationMetadata)
      : null;
    items.push({ url: await fileUrl(env, origin, key), metadata });
  }
  const result = buildGalleryStructured(items);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

/**
 * 생성 전 검증·준비 단계 — OpenAI 호출 없이 끝나는 부분만.
 * 동기 경로와 비동기(enqueue 시 빠른 거절) 경로가 공유한다.
 */
async function prepareGeneration(env: Env, args: Record<string, unknown>) {
  // 가드 B: 스키마를 우회한 직접 호출까지 OpenAI 호출 전에 차단 (스키마 필수화 A와 이중화).
  // 모델이 읽고 자기수정할 수 있는 메시지로 거절한다.
  const styleRaw = typeof args.style === 'string' ? args.style.trim() : '';
  if (!styleRaw) {
    throw new Error(
      "거부: 'style' slug가 비어 있다. 화풍 일관성을 위해 등록된 style slug가 필수다. list_assets로 등록 목록을 확인한 뒤 style을 지정해 다시 호출하라.",
    );
  }
  // 모델 화이트리스트 — 스키마(enum)와 이중화. OpenAI 호출 전 거절 + 허용 목록 안내.
  if (args.model !== undefined && !ALLOWED_MODELS.includes(args.model as (typeof ALLOWED_MODELS)[number])) {
    throw new Error(
      `거부: 지원하지 않는 model '${String(args.model)}' — 허용 목록: ${ALLOWED_MODELS.join(', ')}. 미지정 시 기본값 gpt-image-2가 사용된다.`,
    );
  }

  const a = generateInput.parse(args);

  const charMeta = a.character ? await loadMeta(env, 'character', a.character) : null;
  if (a.character && !charMeta) {
    throw new Error(`캐릭터 미등록: '${a.character}' — register_character로 먼저 등록하거나 list_assets로 확인하라.`);
  }
  // 게이트: 미완성(fixed_prompt 빈) character는 외형 일관성을 못 건다 → 조용한 실패 대신 명시적 거부.
  if (charMeta && !hasText(charMeta.fixed_prompt)) {
    throw new Error(
      `거부: character '${a.character}'는 미완성(draft) — fixed_prompt가 비어 외형 일관성 게이트가 작동하지 않는다. register_character(slug='${a.character}', fixed_prompt='외형 기술문…')로 채운 뒤 다시 생성하라.`,
    );
  }
  // 가드 B-2: 미등록 slug(오타 포함) 조기 차단 — OpenAI 비용 발생 전.
  const styleMeta = await loadMeta(env, 'style', a.style);
  if (!styleMeta) {
    throw new Error(`거부: style '${a.style}' 미등록 — get_asset(kind='style', slug='${a.style}')로 확인하거나 list_assets로 등록 목록을 보라.`);
  }
  // 게이트: 미완성(fixed_prompt 빈) style은 화풍 일관성을 못 건다 → 명시적 거부 + 채우는 법 안내.
  if (!hasText(styleMeta.fixed_prompt)) {
    throw new Error(
      `거부: style '${a.style}'는 미완성(draft) — fixed_prompt가 비어 화풍 일관성 게이트가 작동하지 않는다. register_style(slug='${a.style}', fixed_prompt='화풍 기술문…')로 채운 뒤 다시 생성하라.`,
    );
  }
  return { a, charMeta, styleMeta };
}

/**
 * 생성 본체 — OpenAI 호출 → R2 저장(+사이드카) → result.
 * 동기 도구 경로와 JobQueue DO(alarm)가 공유한다.
 */
async function runGeneration(
  env: Env,
  origin: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; imageBlocks: ContentBlock[] }> {
  const { a, charMeta, styleMeta } = await prepareGeneration(env, args);

  // 참조 첨부 순서: 캐릭터 시트 먼저, 스타일 앵커 나중 (gpt-image-1.5는 앞 5장을 고충실도 보존).
  const styleAnchors = styleMeta ? styleMeta.files.slice(0, 2) : [];
  const refKeys = [...(charMeta?.files ?? []), ...styleAnchors];
  const finalPrompt = assemblePrompt(a.prompt, charMeta, styleMeta, styleAnchors.length);

  // webp 출력 고정 — 동일 해상도에서 PNG 대비 ~10분의 1 크기. 인라인 image 블록이
  // 클라이언트 한도(Claude Desktop 실측 수 MB)에 걸리지 않게 하는 핵심 수단.
  let resp: OpenAIImagesResponse;
  if (refKeys.length > 0) {
    const form = new FormData();
    form.append('model', a.model);
    form.append('prompt', finalPrompt);
    form.append('quality', a.quality);
    form.append('size', a.size);
    form.append('n', String(a.n));
    // input_fidelity는 gpt-image-1.x 전용 — gpt-image-2는 미지원(400)이라 생략 (라이브 실측 2026-06-12)
    if (a.model !== 'gpt-image-2') form.append('input_fidelity', 'high');
    form.append('output_format', 'webp');
    form.append('output_compression', '80');
    for (const key of refKeys) {
      const anchor = await getScaledAnchor(env, key);
      form.append('image[]', new File([anchor.bytes], anchor.name, { type: anchor.type }));
    }
    resp = await callOpenAI(env, '/v1/images/edits', form);
  } else {
    resp = await callOpenAI(
      env,
      '/v1/images/generations',
      JSON.stringify({
        model: a.model,
        prompt: finalPrompt,
        quality: a.quality,
        size: a.size,
        n: a.n,
        output_format: 'webp',
        output_compression: 80,
      }),
    );
  }

  // 생성 메타데이터 — 출력 이미지와 같은 키에 .json 사이드카로 보존 (show_creations 상세 카드의 원천).
  // anchor_urls에는 서명 URL이 아니라 R2 키를 저장 — 조회 시점에 새로 서명해 만료 깨짐을 방지.
  const metadata: GenerationMetadata = {
    scene_prompt: a.prompt,
    combined_prompt: finalPrompt,
    model: a.model,
    size: a.size,
    quality: a.quality,
    n: a.n,
    character: charMeta ? { slug: charMeta.slug, anchor_urls: charMeta.files } : null,
    style: { slug: styleMeta.slug, anchor_urls: styleAnchors },
    seed: null,
    seed_note: 'unsupported by gpt-image API',
    usage: resp.usage ?? null,
    estimated_cost_usd: estimateCost(a.model, resp.usage),
    created_at: new Date().toISOString(),
  };

  const month = metadata.created_at.slice(0, 7);
  const urls: string[] = [];
  const imageBlocks: ContentBlock[] = [];
  for (const item of resp.data) {
    const bytes = base64ToBytes(item.b64_json);
    const key = `outputs/${month}/${crypto.randomUUID()}.webp`;
    await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
    await env.ASSETS.put(`${key}.json`, JSON.stringify(metadata, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
    urls.push(await fileUrl(env, origin, key));
    imageBlocks.push(await toImageBlock(env, bytes, 'image/webp'));
  }

  // 위젯 자동 렌더용 items — 앵커 R2키를 조회 시점 서명 URL로 변환한 사본(썸네일용).
  // 저장 사이드카(.json)는 R2키 그대로 유지(서명 만료 깨짐 방지); 여기 사본만 서명한다.
  const signedMeta = await signMetadataAnchors(env, origin, metadata);
  const items = urls.map((url) => ({ url, metadata: signedMeta }));

  // 후방호환: structuredContent(urls 포함)는 기존 형태 유지, image block은 content에만 추가.
  // items는 위젯이 상세 카드로 자동 렌더하는 원천(show_creations와 동일 형태).
  const result = {
    urls,
    model: a.model,
    model_snapshot: resp.model ?? null, // OpenAI가 응답에 스냅샷을 실어주면 echo
    quality: a.quality,
    size: a.size,
    usage: resp.usage ?? null,
    estimated_cost_usd: metadata.estimated_cost_usd,
    metadata,
    items,
  };
  return { result, imageBlocks };
}

async function generateImage(
  env: Env,
  origin: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // 비동기 경로 (wait: false) — 검증·자산 실존 확인까지는 동기로 끝내 빠른 자기수정을 유지하고,
  // 통과한 주문만 JobQueue DO에 적재한다. 호출 세션이 사라져도 job은 알람 체인으로 완료된다.
  if ((args as { wait?: unknown }).wait === false) {
    await prepareGeneration(env, args); // 거절 사유는 여기서 즉시 isError로 반환됨
    if (!env.JOBS) throw new Error('비동기 큐 미구성 — JOBS(Durable Object) 바인딩이 없다. wait를 생략해 동기로 호출하라.');
    const res = await jobsStub(env).fetch('https://jobs/', {
      method: 'POST',
      body: JSON.stringify({ op: 'enqueue', origin, args }),
    });
    const { job_id } = (await res.json()) as { job_id: string };
    const out = {
      job_id,
      status: 'queued',
      pending: true, // 위젯이 "생성 중" 안내를 띄우게 하는 표식 (영수증엔 이미지가 없다)
      hint: `check_jobs({job_ids:["${job_id}"]})로 상태·결과를 회수하라. 분당 ${RATE_LIMIT_PER_MIN}장 페이싱으로 순차 처리되고 실패는 자동 재시도된다.`,
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
  }

  const { result, imageBlocks } = await runGeneration(env, origin, args);
  // image 블록을 맨 앞에 — 일부 클라이언트가 후미 대형 블록을 잘라내는 경우 대비.
  return {
    content: [...imageBlocks, { type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

/**
 * generate_batch — 여러 컷을 한 번의 호출로 큐에 적재(카드 1개). 기존 JobQueue를 재활용한다.
 * 각 컷을 defaults와 병합 → prepareGeneration으로 검증(OpenAI 호출 없음) → 통과분만 배치 enqueue.
 * 이미지 바이트는 싣지 않는다(캐릭터/화풍은 slug 참조). 회수는 check_jobs(기본 long-poll) 1회.
 */
async function generateBatch(env: Env, origin: string, args: Record<string, unknown>): Promise<ToolResult> {
  const a = generateBatchInput.parse(args);
  if (!env.JOBS) throw new Error('비동기 큐 미구성 — JOBS(Durable Object) 바인딩이 없다. generate_image(동기)로 호출하라.');
  const defaults = a.defaults ?? {};
  const valid: Record<string, unknown>[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < a.cuts.length; i++) {
    const merged = { ...defaults, ...a.cuts[i] };
    try {
      await prepareGeneration(env, merged); // 검증만 — 미등록 style/character 등을 적재 전에 거른다
      valid.push(merged);
    } catch (e) {
      errors.push({ index: i, error: sanitize((e as Error).message || String(e)) });
    }
  }
  if (valid.length === 0) {
    throw new Error(`모든 컷 거부됨: ${errors.map((e) => `[${e.index}] ${e.error}`).join(' / ')}`);
  }
  const res = await jobsStub(env).fetch('https://jobs/', {
    method: 'POST',
    body: JSON.stringify({ op: 'enqueue_batch', origin, argsList: valid }),
  });
  const { job_ids } = (await res.json()) as { job_ids: string[] };
  const out = {
    job_ids,
    count: job_ids.length,
    status: 'queued',
    pending: true, // 위젯이 "N컷 생성 중" 안내를 띄우는 표식
    ...(errors.length ? { errors } : {}),
    hint: `${job_ids.length}컷 적재됨${errors.length ? ` (${errors.length}컷 거부)` : ''}. check_jobs({job_ids:${JSON.stringify(job_ids)}, timeout_seconds:50})로 한 번에 회수하라 — 반복 호출 불필요.`,
  };
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
}

// ---------- 비동기 job 큐 (JobQueue DO — 알람 기반, 세션 독립) ----------

const RATE_LIMIT_PER_MIN = 5; // OpenAI Tier 1 이미지 한도
const PACING_MS = 12_000; // 분당 5장 = 12초 간격
const MAX_ATTEMPTS = 5;
const STUCK_RUNNING_MS = 5 * 60_000; // DO 재기동 등으로 끊긴 running job 재큐 기준
const JOB_DEADLINE_MS = 10 * 60_000; // 적재 후 10분 내 못 끝낸 job은 시간초과 실패 — 무한 폴링·큐 점유 방지(서버 강제)
const backoffMs = (attempts: number): number => 30_000 * 2 ** (attempts - 1); // 30s, 1m, 2m, 4m

function jobsStub(env: Env): DurableObjectStub {
  return env.JOBS!.get(env.JOBS!.idFromName('job-queue'));
}

interface JobRow {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  origin: string;
  args: string;
  result: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  next_attempt_at: number | null;
  started_at: number | null;
}

/**
 * 알람 기반 단일 소유자 큐. enqueue 즉시 알람을 걸고, 알람마다 1건씩 처리한다.
 * - 페이싱: 최근 60초 내 시작 5건이면 윈도가 열릴 때까지 알람 연기
 * - 재시도: 실패 시 백오프(30s×2ⁿ) 후 재큐, MAX_ATTEMPTS 도달 시 failed 확정
 * - 복구: 5분 넘게 running인 job(런타임 재기동 등)은 자동 재큐
 * 상태는 DO SQLite(강한 일관성·원자적 갱신), 결과물·사이드카는 기존 R2에 그대로.
 */
export class JobQueue {
  private sql: SqlStorage;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs(
      id TEXT PRIMARY KEY, status TEXT NOT NULL, origin TEXT NOT NULL, args TEXT NOT NULL,
      result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      next_attempt_at INTEGER, started_at INTEGER
    )`);
  }

  async fetch(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      op: string;
      origin?: string;
      args?: unknown;
      argsList?: unknown[];
      ids?: string[];
    };

    if (body.op === 'enqueue') {
      const id = crypto.randomUUID();
      const now = Date.now();
      this.sql.exec(
        'INSERT INTO jobs (id, status, origin, args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, 'queued', body.origin ?? '', JSON.stringify(body.args ?? {}), now, now,
      );
      if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(now + 50);
      return new Response(JSON.stringify({ job_id: id }));
    }

    // 배치 적재 — generate_batch이 검증 통과한 컷들을 한 번에 큐에 넣는다. 알람 한 번만 건다.
    if (body.op === 'enqueue_batch') {
      const now = Date.now();
      const job_ids: string[] = [];
      for (const args of body.argsList ?? []) {
        const id = crypto.randomUUID();
        this.sql.exec(
          'INSERT INTO jobs (id, status, origin, args, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          id, 'queued', body.origin ?? '', JSON.stringify(args ?? {}), now, now,
        );
        job_ids.push(id);
      }
      if (job_ids.length && (await this.state.storage.getAlarm()) === null) {
        await this.state.storage.setAlarm(now + 50);
      }
      return new Response(JSON.stringify({ job_ids }));
    }

    if (body.op === 'status') {
      const ids = body.ids ?? [];
      const placeholders = ids.map(() => '?').join(',');
      const rows = ids.length
        ? (this.sql.exec(`SELECT * FROM jobs WHERE id IN (${placeholders})`, ...ids).toArray() as unknown as JobRow[])
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const now = Date.now();
      const jobs = ids.map((id) => {
        const r = byId.get(id);
        if (!r) return { job_id: id, status: 'not_found' };
        // 10분 초과 + 미완료 → 시간초과 실패로 보고. 알람이 아직 안 돌았어도 read 시점에 terminal로 만들어
        // check_jobs long-poll이 끝나고 모델이 무한 폴링에 빠지지 않게 한다.
        const timedOut = (r.status === 'queued' || r.status === 'running') && now - r.created_at > JOB_DEADLINE_MS;
        return {
          job_id: r.id,
          status: timedOut ? 'failed' : r.status,
          attempts: r.attempts,
          created_at: new Date(r.created_at).toISOString(),
          updated_at: new Date(r.updated_at).toISOString(),
          ...(r.result ? { result: JSON.parse(r.result) } : {}),
          ...(timedOut
            ? { error: '10분 시간초과 — 회수 중단. 필요하면 재생성하라.' }
            : r.error
              ? { error: r.error }
              : {}),
        };
      });
      return new Response(JSON.stringify({ jobs }));
    }

    return new Response(JSON.stringify({ error: `unknown op: ${body.op}` }), { status: 400 });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // 복구: 비정상 종료로 남은 running 재큐
    this.sql.exec(
      "UPDATE jobs SET status='queued', updated_at=? WHERE status='running' AND updated_at < ?",
      now, now - STUCK_RUNNING_MS,
    );

    // 레이트 윈도: 최근 60초 시작 건수가 한도면 윈도가 열릴 때까지 연기
    const recent = this.sql
      .exec('SELECT COUNT(*) AS c, MIN(started_at) AS oldest FROM jobs WHERE started_at > ?', now - 60_000)
      .one() as { c: number; oldest: number | null };
    if (recent.c >= RATE_LIMIT_PER_MIN) {
      await this.state.storage.setAlarm((recent.oldest ?? now) + 60_500);
      return;
    }

    const due = this.sql
      .exec(
        "SELECT * FROM jobs WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT 1",
        now,
      )
      .toArray() as unknown as JobRow[];

    if (due.length === 0) {
      // 백오프 대기 중인 job이 있으면 그 시각으로 알람 재설정
      const next = this.sql.exec("SELECT MIN(next_attempt_at) AS m FROM jobs WHERE status='queued'").one() as {
        m: number | null;
      };
      if (next.m) await this.state.storage.setAlarm(Number(next.m));
      return;
    }

    const job = due[0];
    // 10분 초과 job은 OpenAI 호출 없이 시간초과 실패 처리 — 큐 점유·무한 재시도 차단.
    if (now - job.created_at > JOB_DEADLINE_MS) {
      this.sql.exec(
        "UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?",
        '10분 시간초과 — 생성이 제때 끝나지 않았다. 필요하면 재생성하라.', now, job.id,
      );
      const left = this.sql.exec("SELECT COUNT(*) AS c FROM jobs WHERE status='queued'").one() as { c: number };
      if (left.c > 0) await this.state.storage.setAlarm(Date.now() + 50);
      return;
    }
    this.sql.exec("UPDATE jobs SET status='running', started_at=?, updated_at=? WHERE id=?", now, now, job.id);
    try {
      const { result } = await runGeneration(this.env, job.origin, JSON.parse(job.args));
      this.sql.exec(
        "UPDATE jobs SET status='done', result=?, error=NULL, updated_at=? WHERE id=?",
        JSON.stringify(result), Date.now(), job.id,
      );
    } catch (e) {
      const attempts = job.attempts + 1;
      const msg = sanitize((e as Error).message || String(e));
      if (attempts >= MAX_ATTEMPTS) {
        this.sql.exec(
          "UPDATE jobs SET status='failed', error=?, attempts=?, updated_at=? WHERE id=?",
          msg, attempts, Date.now(), job.id,
        );
      } else {
        this.sql.exec(
          "UPDATE jobs SET status='queued', error=?, attempts=?, next_attempt_at=?, updated_at=? WHERE id=?",
          msg, attempts, Date.now() + backoffMs(attempts), Date.now(), job.id,
        );
      }
    }

    // 남은 작업 페이싱 — 분당 한도에 맞춰 12초 뒤 다음 처리
    const remaining = this.sql.exec("SELECT COUNT(*) AS c FROM jobs WHERE status='queued'").one() as { c: number };
    if (remaining.c > 0) await this.state.storage.setAlarm(Date.now() + PACING_MS);
  }
}

/** check_jobs — job 상태·결과 회수 (폴링용). */
async function checkJobs(env: Env, args: Record<string, unknown>): Promise<ToolResult> {
  const a = checkJobsInput.parse(args);
  if (!env.JOBS) throw new Error('비동기 큐 미구성 — JOBS(Durable Object) 바인딩이 없다.');
  // long-poll: 요청한 job이 전부 끝(done/failed/not_found)날 때까지 최대 timeout_seconds 동안 보류.
  // 모델이 check_jobs를 반복 호출(폴링)하며 빈 위젯을 띄우는 노이즈를 제거 — 1회 호출로 결과 수령.
  const stub = jobsStub(env);
  const deadline = Date.now() + a.timeout_seconds * 1000;
  let data: { jobs: Array<Record<string, unknown>> };
  for (;;) {
    const res = await stub.fetch('https://jobs/', {
      method: 'POST',
      body: JSON.stringify({ op: 'status', ids: a.job_ids }),
    });
    data = (await res.json()) as { jobs: Array<Record<string, unknown>> };
    const pending = data.jobs.some((j) => j.status === 'queued' || j.status === 'running');
    if (!pending || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 3000)); // 3초 간격 재조회 (페이싱 12초/장에 맞춘 가벼운 폴링)
  }

  // done 컷들의 items를 집계해 위젯이 한 번에 렌더하게 한다 (show_creations 재호출 불필요).
  // 이 배포 이전 job(result에 items 없음)은 urls로 폴백 매핑.
  const items: Array<{ url: string; metadata: GenerationMetadata | null }> = [];
  for (const j of data.jobs) {
    if (j.status !== 'done' || !j.result) continue;
    const r = j.result as { items?: Array<{ url: string; metadata: GenerationMetadata | null }>; urls?: string[] };
    if (Array.isArray(r.items) && r.items.length) items.push(...r.items);
    else if (Array.isArray(r.urls)) items.push(...r.urls.map((url) => ({ url, metadata: null })));
  }
  const result = { jobs: data.jobs, ...buildGalleryStructured(items) };
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

/** open_reference_uploader — 채팅 내 업로더 위젯을 띄우는 트리거. 위젯 프리필 힌트만 반환(이미지 바이트 없음). */
function openUploader(args: Record<string, unknown>): ToolResult {
  const a = uploaderInput.parse(args);
  const out = {
    kind: a.kind ?? null,
    slug: a.slug ?? null,
    hint: '위젯에 이미지를 끌어다 놓고 이름을 정해 "등록"을 누르면 끝. 이미지는 위젯→워커로 직접 가며 이 대화로 들어오지 않는다.',
  };
  return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
}

// ---------- tools/call 디스패치 ----------

interface ToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export async function callTool(
  env: Env,
  origin: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    // image block을 직접 구성하는 도구는 ToolResult를 그대로 반환한다.
    if (name === 'generate_image') return await generateImage(env, origin, args);
    if (name === 'generate_batch') return await generateBatch(env, origin, args);
    if (name === 'show_creations') return await showCreations(env, origin, args);
    if (name === 'check_jobs') return await checkJobs(env, args);
    if (name === 'open_reference_uploader') return openUploader(args);

    let result: Record<string, unknown>;
    switch (name) {
      case 'register_character':
        result = await registerAsset(env, origin, 'character', args, { source: 'tool', enforceFixedPrompt: true });
        break;
      case 'register_style':
        result = await registerAsset(env, origin, 'style', args, { source: 'tool', enforceFixedPrompt: true });
        break;
      case 'list_assets':
        result = await listAssets(env, origin);
        break;
      case 'get_asset':
        result = await getAsset(env, origin, args);
        break;
      case 'delete_asset':
        result = await deleteAsset(env, args);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (e) {
    const msg =
      e instanceof z.ZodError
        ? `입력 검증 실패: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        : sanitize((e as Error).message || String(e));
    return { content: [{ type: 'text', text: `오류: ${msg}` }], isError: true };
  }
}

// ---------- MCP JSON-RPC handler ----------

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

async function handleRpc(req: Request, env: Env, origin: string): Promise<Response> {
  let body: RpcRequest;
  try {
    body = (await req.json()) as RpcRequest;
  } catch {
    return jsonResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  const { method, params, id } = body;
  // wrangler tail 진단용 경량 로그 — 시크릿·인자 미포함 (도구명/URI 수준만)
  const detail =
    method === 'tools/call'
      ? (params as { name?: string } | undefined)?.name
      : method === 'resources/read'
        ? (params as { uri?: string } | undefined)?.uri
        : '';
  console.log(`[rpc] ${method}${detail ? ` ${detail}` : ''}`);

  // 모든 JSON-RPC 알림(initialized·cancelled·progress 등)은 202 Accepted, 본문 없음 —
  // 알림에 에러 객체로 응답하면 프로토콜 위반이라 클라이언트가 연결을 끊을 수 있다.
  // 특히 notifications/cancelled는 generate_image(30초+) 도중 사용자가 취소하면 항상 날아온다.
  if (method.startsWith('notifications/')) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  const ok = (result: unknown) => jsonResponse({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) =>
    jsonResponse({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    switch (method) {
      case 'initialize': {
        // 우리가 실제로 의무사항을 구현한 버전만 협상 — 미지원 요청이면 지원 최신 버전 응답(스펙).
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const supported = ['2024-11-05', '2025-03-26', '2025-06-18'];
        return ok({
          protocolVersion:
            typeof requested === 'string' && supported.includes(requested) ? requested : '2025-06-18',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'kez-gpt-image-mcp', version: '1.0.0' },
        });
      }
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'resources/list':
        return ok({
          resources: [
            {
              uri: UI_GALLERY_URI,
              name: 'Kez Image Gallery',
              description: '생성 결과 이미지를 그리드로 렌더하는 MCP Apps 위젯',
              mimeType: UI_RESOURCE_MIME,
              _meta: uiResourceMeta(origin),
            },
            {
              uri: UI_UPLOADER_URI,
              name: 'Kez Reference Uploader',
              description: '레퍼런스 이미지를 채팅 안에서 끌어놓아 업로드·등록하는 MCP Apps 위젯',
              mimeType: UI_RESOURCE_MIME,
              _meta: uiUploaderMeta(origin),
            },
          ],
        });
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });
      case 'resources/read': {
        const uri = (params as { uri?: unknown } | undefined)?.uri;
        if (uri === UI_GALLERY_URI) {
          return ok({
            contents: [
              { uri: UI_GALLERY_URI, mimeType: UI_RESOURCE_MIME, text: GALLERY_HTML, _meta: uiResourceMeta(origin) },
            ],
          });
        }
        if (uri === UI_UPLOADER_URI) {
          // 토큰·origin 주입 (이 응답은 Bearer 게이트 안 — 저권한 토큰이 인증된 호스트에게만 전달됨)
          return ok({
            contents: [
              { uri: UI_UPLOADER_URI, mimeType: UI_RESOURCE_MIME, text: await uploaderHtml(env, origin), _meta: uiUploaderMeta(origin) },
            ],
          });
        }
        return err(-32002, `Resource not found: ${String(uri)}`);
      }
      case 'tools/call': {
        const p = (params || {}) as { name: string; arguments?: Record<string, unknown> };
        return ok(await callTool(env, origin, p.name, p.arguments || {}));
      }
      case 'ping':
        return ok({});
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return err(-32000, sanitize((e as Error).message || String(e)));
  }
}

// ---------- OAuth 2.0 endpoints (claude.ai Custom Connector handshake) ----------
//
// claude.ai의 Custom Connector는 Bearer Token 필드와 무관하게 OAuth 2.0 PKCE를 강제 수행한다.
// 보안: /authorize 에서 소유자(연결 비밀번호 OAUTH_PASSCODE) 인증을 통과해야만 서명된 인증 code 를
// 발급하고, /token 은 그 서명 code(또는 refresh_token)·redirect_uri·PKCE 가 전부 유효해야만
// access_token(=MCP_AUTH_TOKEN) 을 내준다.
// → URL 만 아는 익명 호출자는 유효 code 를 못 얻어 /token 으로 토큰을 못 빼간다(연결 비밀번호 = 진짜 보안 경계).
// (구설계 결함: /authorize 가 즉시 code 를 발급하면 공격자가 자기가 호출해 302 에서 code 를 읽어
//  /token 으로 교환할 수 있었다 — "redirect_uri 제한 = 보안"은 가정 오류였다.)

function b64urlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function hmacSha256(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return b64urlFromBytes(new Uint8Array(sig));
}
// 서명 토큰 = base64url(JSON payload) + "." + HMAC-SHA256(payload). 키는 OAUTH_SIGNING_KEY(없으면 MCP_AUTH_TOKEN).
async function signToken(env: Env, payload: Record<string, unknown>): Promise<string> {
  const body = b64urlFromBytes(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmacSha256(env.OAUTH_SIGNING_KEY || env.MCP_AUTH_TOKEN, body)}`;
}
async function verifyToken(env: Env, token: string): Promise<Record<string, unknown> | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256(env.OAUTH_SIGNING_KEY || env.MCP_AUTH_TOKEN, body);
  if (sig.length !== expected.length || !safeEqual(sig, expected)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
async function issueTokens(env: Env): Promise<Record<string, unknown>> {
  return {
    access_token: env.MCP_AUTH_TOKEN,
    token_type: 'Bearer',
    expires_in: 60 * 60 * 24 * 30,
    refresh_token: await signToken(env, { t: 'refresh', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90 }),
    scope: 'mcp',
  };
}
const OAUTH_CARRY = ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'client_id', 'scope', 'resource'];
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** 연결 비밀번호 입력 폼 — /authorize GET에서 표시, POST로 제출. OAuth 파라미터는 hidden으로 실어 나른다. */
function authorizeFormHtml(get: (k: string) => string | null, error?: string): string {
  const hidden = OAUTH_CARRY.map((k) => {
    const v = get(k);
    return v == null ? '' : `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;
  }).join('');
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>kez gpt-image 연결 인증</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f0f10;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#1a1a1c;border:1px solid #2a2a2e;border-radius:14px;padding:32px;max-width:360px;width:90%}h1{font-size:17px;margin:0 0 6px}p{font-size:13px;color:#9a9aa2;margin:0 0 18px;line-height:1.5}input[type=password]{width:100%;box-sizing:border-box;padding:11px 13px;border-radius:9px;border:1px solid #33333a;background:#101013;color:#fff;font-size:15px}button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:9px;background:#4f7cff;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.err{color:#ff6b6b;font-size:13px;margin:0 0 12px}</style></head><body><div class="card"><h1>🔒 kez gpt-image 연결</h1><p>이 워커에 연결하려면 설정한 <b>연결 비밀번호</b>(OAUTH_PASSCODE)를 입력하세요. 도구를 쓸 때마다가 아니라, <b>연결할 때 한 번만</b> 입력합니다.</p>${err}<form method="POST" action="/authorize">${hidden}<input type="password" name="passcode" placeholder="연결 비밀번호" autofocus required><button type="submit">연결</button></form></div></body></html>`;
}

function oauthMetadata(host: string) {
  return {
    issuer: `https://${host}`,
    authorization_endpoint: `https://${host}/authorize`,
    token_endpoint: `https://${host}/token`,
    registration_endpoint: `https://${host}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp'],
  };
}

function protectedResourceMetadata(host: string) {
  return {
    resource: `https://${host}`,
    authorization_servers: [`https://${host}`],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  };
}

function isAllowedRedirect(uri: string): boolean {
  return uri.startsWith('https://claude.ai/') || uri.startsWith('https://claude.com/');
}

async function handleOAuth(req: Request, env: Env, url: URL): Promise<Response | null> {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
    return jsonResponse(oauthMetadata(url.host));
  }

  if (req.method === 'GET' && pathname === '/.well-known/oauth-protected-resource') {
    return jsonResponse(protectedResourceMetadata(url.host));
  }

  if (req.method === 'POST' && pathname === '/register') {
    let body: { redirect_uris?: string[] } = {};
    try {
      body = (await req.json()) as { redirect_uris?: string[] };
    } catch {
      // claude.ai가 최소 body만 보낼 수 있음 — 무시
    }
    return jsonResponse({
      client_id: `mcp-${crypto.randomUUID()}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris ?? ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  }

  if (req.method === 'GET' && pathname === '/authorize') {
    const params = url.searchParams;
    const redirectUri = params.get('redirect_uri') || '';
    const responseType = params.get('response_type') || '';

    if (!redirectUri) return new Response('Missing redirect_uri', { status: 400, headers: CORS_HEADERS });
    if (!isAllowedRedirect(redirectUri)) {
      return new Response('Invalid redirect_uri (only claude.ai/claude.com allowed)', {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
    if (responseType !== 'code') {
      return new Response('Only response_type=code supported', { status: 400, headers: CORS_HEADERS });
    }
    // PKCE 필수(S256): claude.ai 는 항상 보냄. 없거나 plain 이면 거부해 다운그레이드 차단.
    if (!params.get('code_challenge') || (params.get('code_challenge_method') || '') !== 'S256') {
      return new Response('PKCE code_challenge (S256) required', { status: 400, headers: CORS_HEADERS });
    }

    // 보안: 즉시 code 를 발급하지 않고, 소유자(연결 비밀번호) 인증 폼을 먼저 보여준다.
    return new Response(authorizeFormHtml((k) => params.get(k)), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
    });
  }

  if (req.method === 'POST' && pathname === '/authorize') {
    const form = await req.formData();
    const get = (k: string) => {
      const v = form.get(k);
      return v == null ? null : String(v);
    };
    const redirectUri = get('redirect_uri') || '';
    const state = get('state') || '';
    if (!isAllowedRedirect(redirectUri)) {
      return new Response('Invalid redirect_uri', { status: 400, headers: CORS_HEADERS });
    }
    // 연결 비밀번호 상수시간 비교. 미설정이거나 틀리면 폼 재표시(401) — 열린 서버 방지.
    const passcode = String(form.get('passcode') || '');
    if (!env.OAUTH_PASSCODE || passcode.length !== env.OAUTH_PASSCODE.length || !safeEqual(passcode, env.OAUTH_PASSCODE)) {
      return new Response(authorizeFormHtml(get, '연결 비밀번호가 올바르지 않습니다.'), {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
      });
    }
    // 통과 → PKCE 챌린지·redirect_uri 에 묶인 서명된 단명(2분) code 발급.
    const code = await signToken(env, {
      t: 'code',
      ru: redirectUri,
      cc: get('code_challenge') || '',
      ccm: get('code_challenge_method') || '',
      exp: Math.floor(Date.now() / 1000) + 120,
    });
    const cb = new URL(redirectUri);
    cb.searchParams.set('code', code);
    if (state) cb.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { Location: cb.toString(), ...CORS_HEADERS } });
  }

  if (req.method === 'POST' && pathname === '/token') {
    // 폼/JSON 모두 수용 (claude.ai 는 application/x-www-form-urlencoded).
    let p: Record<string, string> = {};
    const ct = req.headers.get('Content-Type') || '';
    try {
      if (ct.includes('application/json')) {
        p = (await req.json()) as Record<string, string>;
      } else {
        const f = await req.formData();
        for (const [k, v] of f) p[k] = String(v);
      }
    } catch {
      // ignore parse failure
    }

    // refresh_token 그랜트: 이전에 비밀번호로 인증해 발급받은 서명 refresh_token 이어야 한다.
    if (p.grant_type === 'refresh_token') {
      const rt = await verifyToken(env, p.refresh_token || '');
      if (!rt || rt.t !== 'refresh') return jsonResponse({ error: 'invalid_grant' }, 400);
      return jsonResponse(await issueTokens(env));
    }

    // authorization_code 그랜트: 반드시 /authorize→소유자 인증을 통과해 발급된 "서명된 code" 여야 한다.
    // → URL 만 아는 익명 호출자는 유효 code 가 없어 여기서 막힌다(옆문 차단).
    const codePayload = await verifyToken(env, p.code || '');
    if (!codePayload || codePayload.t !== 'code') {
      return jsonResponse({ error: 'invalid_grant', error_description: 'invalid or missing authorization code' }, 400);
    }
    // redirect_uri 는 /authorize 때 묶인 값과 정확히 일치해야 한다(필수).
    if (!p.redirect_uri || p.redirect_uri !== codePayload.ru) {
      return jsonResponse({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
    }
    // PKCE 검증(필수·S256·무조건): code 에 묶인 code_challenge 와 제출된 code_verifier 대조.
    const cc = String(codePayload.cc || '');
    const verifier = p.code_verifier || '';
    const dig = b64urlFromBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    if (!cc || !verifier || dig.length !== cc.length || !safeEqual(dig, cc)) {
      return jsonResponse({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }
    return jsonResponse(await issueTokens(env));
  }

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  return null;
}

// ---------- 서명 파일 서빙 (GET /files/{key}?sig=...) ----------

async function handleFiles(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' || !url.pathname.startsWith('/files/')) return null;
  const key = url.pathname
    .slice('/files/'.length)
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/');
  const sig = url.searchParams.get('sig') || '';
  const expected = await fileSig(env, key);
  if (!sig || !safeEqual(sig, expected)) {
    return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
  }
  const obj = await env.ASSETS.get(key);
  if (!obj) return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  const headers: Record<string, string> = {
    'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    // 위젯(크로스오리진 iframe)의 fetch(mode:cors)→blob 다운로드가 동작하려면 CORP+expose 필요.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Type',
    ...CORS_HEADERS,
  };
  // ?download=파일명 → 강제 첨부. JS가 막힌 호스트의 무-JS 폴백 경로이자 blob 다운로드 바이트 소스.
  const dl = url.searchParams.get('download');
  if (dl) headers['Content-Disposition'] = `attachment; filename="${dl.replace(/[^\w.\-]/g, '_')}"`;
  return new Response(obj.body, { headers });
}

// ---------- 서명 다중파일 ZIP 서빙 (GET /zip?f=<key>&s=<sig>&…&n=<zipname>) ----------
//
// 인스타툰처럼 한 번에 여러 장 뽑았을 때의 "일괄 다운로드". 위젯이 이미 들고 있는 각 파일의
// 서명(fileSig)을 그대로 되보내면, 서버가 파일별로 재검증(safeEqual)한 뒤 R2에서 읽어 STORE(무압축)
// zip으로 묶어 attachment로 내려준다 — 클라이언트에 새 secret이 필요 없다(파일당 기존 서명 재사용).
// webp는 이미 압축돼 있어 압축해도 크기 이득이 거의 없고 CPU만 먹으므로 STORE로 고정.
const ZIP_MAX_FILES = 20; // 인스타툰(9장) 여유 상한
const ZIP_MAX_BYTES = 80 * 1024 * 1024; // 워커 메모리(128MB) 여유 — 초과 시 413

async function handleZip(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' || url.pathname !== '/zip') return null;
  const keys = url.searchParams.getAll('f');
  const sigs = url.searchParams.getAll('s');
  if (keys.length === 0 || keys.length !== sigs.length) {
    return new Response('Bad Request', { status: 400, headers: CORS_HEADERS });
  }
  if (keys.length > ZIP_MAX_FILES) {
    return new Response(`Too many files (max ${ZIP_MAX_FILES})`, { status: 400, headers: CORS_HEADERS });
  }
  // 파일별 서명 재검증 — 하나라도 틀리면 통째로 403 (부분 유출 방지)
  for (let i = 0; i < keys.length; i++) {
    const expected = await fileSig(env, keys[i]);
    if (!sigs[i] || !safeEqual(sigs[i], expected)) {
      return new Response('Forbidden', { status: 403, headers: CORS_HEADERS });
    }
  }
  // R2에서 바이트 수집 (없는 키는 건너뜀 — 나머지라도 받게)
  const files: { name: string; data: Uint8Array }[] = [];
  const usedNames = new Set<string>();
  let total = 0;
  for (const key of keys) {
    const obj = await env.ASSETS.get(key);
    if (!obj) continue;
    const data = new Uint8Array(await obj.arrayBuffer());
    total += data.length;
    if (total > ZIP_MAX_BYTES) {
      return new Response('Payload Too Large', { status: 413, headers: CORS_HEADERS });
    }
    files.push({ name: uniqueZipName(key, usedNames), data });
  }
  if (files.length === 0) return new Response('Not Found', { status: 404, headers: CORS_HEADERS });

  const zip = buildStoreZip(files);
  const rawName = url.searchParams.get('n') || 'kez_images';
  const zipName = (rawName.replace(/[^\w.\-]/g, '_') || 'kez_images').replace(/(\.zip)?$/i, '.zip');
  return new Response(zip, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Content-Length': String(zip.length),
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Type',
      ...CORS_HEADERS,
    },
  });
}

// zip 내부 파일명 — 키의 basename만(경로 구분자 제거로 zip-slip 무해화), 충돌 시 접미 번호.
function uniqueZipName(key: string, used: Set<string>): string {
  const base = (key.split('/').pop() || 'image').replace(/[^\w.\-]/g, '_') || 'image';
  let name = base;
  let i = 1;
  while (used.has(name)) {
    const dot = base.lastIndexOf('.');
    name = dot > 0 ? `${base.slice(0, dot)}_${i}${base.slice(dot)}` : `${base}_${i}`;
    i++;
  }
  used.add(name);
  return name;
}

// ---------- 최소 ZIP(STORE) 조립기 — 무압축, 의존성 0 ----------
// webp/png은 이미 엔트로피가 높아 deflate 이득이 미미 → 압축 없이 그대로 담고 CRC만 계산한다.
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function buildStoreZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = []; // 로컬 헤더 + 이름 + 데이터 (본문)
  const central: Uint8Array[] = []; // 중앙 디렉토리 레코드
  const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    // Local file header (0x04034b50): store 방식(method=0), 시간/날짜 0
    const header = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0),
    ]);
    local.push(header, name, f.data);
    // Central directory header (0x02014b50)
    central.push(
      new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]),
      name,
    );
    offset += header.length + name.length + size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  // End of central directory (0x06054b50)
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0),
  ]);

  const out = new Uint8Array(cdStart + cdSize + eocd.length);
  let p = 0;
  for (const part of local) { out.set(part, p); p += part.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

// ---------- 이미지 업로드 (HTTP 엔드포인트 — MCP 도구 아님) ----------
//
// 불변 원칙: 이미지 바이트는 클라이언트→워커 구간만 흐르고 LLM은 0회 통과한다. 그래서 업로드 입구는
// MCP 도구(인자가 LLM을 통과)가 아니라 인증된 HTTP 엔드포인트로 만든다. 응답은 key·url·메타만 반환.

/** GET /assets/upload-token (Bearer = MCP_AUTH_TOKEN) → 파생 업로드 토큰 회수. */
async function handleUploadToken(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' || url.pathname !== '/assets/upload-token') return null;
  const m = /^Bearer\s+(.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m || !env.MCP_AUTH_TOKEN || !safeEqual(m[1], env.MCP_AUTH_TOKEN)) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }
  const token = await uploadToken(env);
  return jsonResponse({
    upload_token: token,
    usage: `curl -X PUT -H "Authorization: Bearer ${token}" -H "Content-Type: image/webp" --data-binary @img.webp ${url.origin}/assets/upload`,
    note: 'MCP_AUTH_TOKEN이 바뀌지 않는 한 고정 — 재사용 가능. register의 image_urls에 응답 key를 넣어 앵커 등록.',
  });
}

/** PUT /assets/upload (Bearer = upload_token) → R2 저장 후 { key, url, bytes, mime }. 이미지 바이트 미반환. */
async function handleUpload(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== '/assets/upload') return null;
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  }
  const m = /^Bearer\s+(.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m || !safeEqual(m[1], await uploadToken(env))) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }
  // mime 판별 — Content-Type 우선, 모호하면 ?mime= 쿼리.
  const ct = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const mq = (url.searchParams.get('mime') || '').toLowerCase();
  const mime = UPLOAD_MIME_EXT[ct] ? ct : UPLOAD_MIME_EXT[mq] ? mq : '';
  if (!mime) {
    return jsonResponse(
      { error: `지원하지 않는 mime — Content-Type 또는 ?mime= 로 ${Object.keys(UPLOAD_MIME_EXT).join(' / ')} 중 하나를 지정하라.` },
      415,
    );
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength === 0) return jsonResponse({ error: '빈 본문 — raw 이미지 바이너리를 보내라.' }, 400);
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: `너무 큼 (${buf.byteLength} > ${MAX_UPLOAD_BYTES} bytes 한도).` }, 413);
  }
  const key = `uploads/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${UPLOAD_MIME_EXT[mime]}`;
  await env.ASSETS.put(key, buf, { httpMetadata: { contentType: mime } });
  return jsonResponse({ key, url: await fileUrl(env, url.origin, key), bytes: buf.byteLength, mime });
}

/**
 * POST /assets/register (Bearer = upload_token) → registerAsset 내부 호출.
 * 입력은 업로드된 key 배열(이미지 바이트 없음). 업로더 위젯이 등록까지 페이지 안에서 끝내는 통로.
 * 저권한 토큰 전용이라 여기로는 generate(비용)·파일서명 위조가 불가 — 최악도 자산 등록/오염에 한정.
 */
async function handleRegister(req: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== '/assets/register') return null;
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
  const m = /^Bearer\s+(.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m || !safeEqual(m[1], await uploadToken(env))) {
    return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
  }
  let body: {
    kind?: unknown;
    slug?: unknown;
    image_urls?: unknown;
    description?: unknown;
    fixed_prompt?: unknown;
    confirm?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: 'JSON 본문이 필요하다.' }, 400);
  }
  if (body.kind !== 'character' && body.kind !== 'style') {
    return jsonResponse({ error: "kind는 'character' 또는 'style' 이어야 한다." }, 400);
  }
  try {
    // 위젯 경로 — fixed_prompt를 강제하지 않는다(이미지만이면 draft로 등록). source='widget'.
    const result = await registerAsset(
      env,
      url.origin,
      body.kind,
      {
        slug: body.slug,
        image_urls: body.image_urls,
        description: typeof body.description === 'string' ? body.description : '',
        fixed_prompt: typeof body.fixed_prompt === 'string' ? body.fixed_prompt : '',
        confirm: body.confirm === true,
      },
      { source: 'widget', enforceFixedPrompt: false },
    );
    return jsonResponse(result);
  } catch (e) {
    const msg =
      e instanceof z.ZodError
        ? `입력 검증 실패: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        : sanitize((e as Error).message || String(e));
    return jsonResponse({ error: msg }, 400);
  }
}

// ---------- entry ----------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);

    const oauthResp = await handleOAuth(req, env, url);
    if (oauthResp) return oauthResp;

    const fileResp = await handleFiles(req, env, url);
    if (fileResp) return fileResp;

    const zipResp = await handleZip(req, env, url);
    if (zipResp) return zipResp;

    const tokenResp = await handleUploadToken(req, env, url);
    if (tokenResp) return tokenResp;

    const uploadResp = await handleUpload(req, env, url);
    if (uploadResp) return uploadResp;

    const registerResp = await handleRegister(req, env, url);
    if (registerResp) return registerResp;

    if (req.method === 'GET') {
      // GET은 Accept와 무관하게 200 text/plain — 2026-06-12 진단 결과로 확정된 동작.
      // SSE Accept에 405를 반환(스펙 문언상 허용)했더니 claude.ai가 대화 생성 시
      // 도구 주입을 전면 중단했다 (패널 "연결됨" + 주입 0). 정상 주입되는
      // vault-mcp-worker와의 유일한 핸드셰이크 경로 diff가 이 405였음. 405로 되돌리지 말 것.
      return new Response('kez-gpt-image-mcp online\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS },
      });
    }

    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    // 보안 게이트: OpenAI 호출은 물론 어떤 도구 로직보다도 먼저 Bearer 검증.
    const auth = req.headers.get('Authorization') || '';
    const match = /^Bearer\s+(.+)$/.exec(auth);
    if (!match || !env.MCP_AUTH_TOKEN || !safeEqual(match[1], env.MCP_AUTH_TOKEN)) {
      return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
    }

    return handleRpc(req, env, url.origin);
  },
};
