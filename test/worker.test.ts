/**
 * kez-image-mcp 단위·스모크 테스트
 *
 * OpenAI Images API를 fetch mock으로, R2를 in-memory mock으로 시뮬레이션해
 * 인증 게이트 → 자산 레이어 → 생성 라우팅 → 에러 매핑을 실제 핸들러 경로 그대로 검증한다.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import worker, {
  callTool,
  fileSig,
  buildStoreZip,
  estimateCost,
  assemblePrompt,
  sanitize,
  TOOLS,
  type Env,
} from '../src/index';

const ORIGIN = 'https://img.example.com';

// ---------- in-memory R2 mock ----------

interface StoredObject {
  bytes: Uint8Array;
  contentType?: string;
}

class MockR2 {
  store = new Map<string, StoredObject>();

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      key,
      body: entry.bytes,
      httpMetadata: { contentType: entry.contentType },
      arrayBuffer: async () =>
        entry.bytes.buffer.slice(entry.bytes.byteOffset, entry.bytes.byteOffset + entry.bytes.byteLength),
      text: async () => new TextDecoder().decode(entry.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(entry.bytes)),
    };
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }) {
    const bytes =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
  }

  async head(key: string) {
    return this.store.has(key) ? { key } : null;
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list(opts?: { prefix?: string; delimiter?: string; cursor?: string }) {
    const prefix = opts?.prefix ?? '';
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix));
    if (opts?.delimiter) {
      const delimited = new Set<string>();
      const objects: Array<{ key: string }> = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const idx = rest.indexOf(opts.delimiter);
        if (idx === -1) objects.push({ key: k });
        else delimited.add(prefix + rest.slice(0, idx + 1));
      }
      return { objects, truncated: false as const, delimitedPrefixes: [...delimited] };
    }
    return { objects: keys.map((key) => ({ key })), truncated: false as const, delimitedPrefixes: [] as string[] };
  }
}

// ---------- OpenAI fetch mock ----------

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

interface CapturedCall {
  url: string;
  init: RequestInit;
}

let openaiCalls: CapturedCall[];
let openaiResponder: (url: string, init: RequestInit) => Response | Promise<Response>;

function okImagesResponse(n = 1): Response {
  return new Response(
    JSON.stringify({
      created: 1,
      data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })),
      usage: {
        input_tokens: 100,
        output_tokens: 1000,
        total_tokens: 1100,
        input_tokens_details: { text_tokens: 60, image_tokens: 40 },
      },
    }),
    { status: 200 },
  );
}

let r2: MockR2;
let env: Env;

beforeEach(() => {
  r2 = new MockR2();
  env = {
    OPENAI_API_KEY: 'sk-test-secret-key-123456',
    MCP_AUTH_TOKEN: 'test-token',
    OAUTH_PASSCODE: 'test-passcode',
    ASSETS: r2 as unknown as R2Bucket,
  };
  openaiCalls = [];
  openaiResponder = () => okImagesResponse();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.openai.com')) {
      openaiCalls.push({ url, init: init ?? {} });
      return openaiResponder(url, init ?? {});
    }
    if (url === 'https://refs.example.com/sheet.png') {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- helpers ----------

async function registerTestCharacter(slug = 'kez-girl', images = 2): Promise<void> {
  const result = await callTool(env, ORIGIN, 'register_character', {
    slug,
    image_urls: Array.from({ length: images }, () => PNG_B64),
    description: '테스트 캐릭터',
    fixed_prompt: '둥근 얼굴과 갈색 단발머리의 소녀',
  });
  expect(result.isError).toBeUndefined();
}

async function registerTestStyle(slug = 'webtoon-flat', images = 3): Promise<void> {
  const result = await callTool(env, ORIGIN, 'register_style', {
    slug,
    image_urls: Array.from({ length: images }, () => PNG_B64),
    description: '테스트 화풍',
    fixed_prompt: '플랫한 셀 셰이딩 웹툰 스타일, 파스텔 팔레트',
  });
  expect(result.isError).toBeUndefined();
}

function rpcRequest(body: unknown, token?: string): Request {
  return new Request('https://img.example.com/', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: JSON.stringify(body),
  });
}

// ---------- 인증 게이트 (보안 원칙 2) ----------

describe('auth gate', () => {
  const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize' };

  it('토큰 없이 POST → 401, OpenAI 호출 0회', async () => {
    const res = await worker.fetch(rpcRequest(initBody), env);
    expect(res.status).toBe(401);
    expect(openaiCalls.length).toBe(0);
  });

  it('잘못된 토큰 → 401', async () => {
    const res = await worker.fetch(rpcRequest(initBody, 'wrong-token'), env);
    expect(res.status).toBe(401);
  });

  it('MCP_AUTH_TOKEN 미설정 환경 → 401 (열린 서버 방지)', async () => {
    const res = await worker.fetch(rpcRequest(initBody, ''), { ...env, MCP_AUTH_TOKEN: '' });
    expect(res.status).toBe(401);
  });

  it('올바른 토큰 → initialize 성공', async () => {
    const res = await worker.fetch(rpcRequest(initBody, 'test-token'), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(json.result.serverInfo.name).toBe('kez-gpt-image-mcp');
    expect(json.result.protocolVersion).toBe('2025-06-18'); // 버전 미지정 → 지원 최신 버전
  });

  it('모든 notifications/* → 202 Accepted, 본문 없음 (에러 응답 금지 — 연결 끊김 방지)', async () => {
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/progress']) {
      const res = await worker.fetch(rpcRequest({ jsonrpc: '2.0', method }, 'test-token'), env);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe('');
    }
  });

  it('GET은 Accept 무관 200 — SSE Accept에 405를 주면 claude.ai가 도구 주입을 중단함 (2026-06-12 진단 확정)', async () => {
    const sse = await worker.fetch(
      new Request('https://img.example.com/', { method: 'GET', headers: { Accept: 'text/event-stream' } }),
      env,
    );
    expect(sse.status).toBe(200);
    const plain = await worker.fetch(new Request('https://img.example.com/'), env);
    expect(plain.status).toBe(200);
  });

  it('OPTIONS preflight → 204', async () => {
    const res = await worker.fetch(new Request('https://img.example.com/', { method: 'OPTIONS' }), env);
    expect(res.status).toBe(204);
  });
});

// ---------- tools/list ----------

describe('tools/list', () => {
  it('10개 도구, inputSchema/outputSchema/annotations 포함', async () => {
    const res = await worker.fetch(rpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'test-token'), env);
    const json = (await res.json()) as { result: { tools: typeof TOOLS } };
    const tools = json.result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_jobs',
      'delete_asset',
      'generate_batch',
      'generate_image',
      'get_asset',
      'list_assets',
      'open_reference_uploader',
      'register_character',
      'register_style',
      'show_creations',
    ]);
    for (const t of tools) {
      expect(t.inputSchema).toBeTruthy();
      expect((t.inputSchema as { type?: string }).type).toBe('object');
      expect(t.outputSchema).toBeTruthy();
      expect(t.annotations).toBeTruthy();
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.list_assets.annotations.readOnlyHint).toBe(true);
    expect(byName.get_asset.annotations.readOnlyHint).toBe(true);
    expect(byName.show_creations.annotations.readOnlyHint).toBe(true);
    // style은 선택(생략 시 순수 생성) — required에 없어야 하고, prompt만 필수.
    const genSchema = byName.generate_image.inputSchema as { required?: string[] };
    expect(genSchema.required).toContain('prompt');
    expect(genSchema.required).not.toContain('style');
    expect(genSchema.required).not.toContain('character');
    expect(byName.delete_asset.annotations.destructiveHint).toBe(true);
    expect(byName.register_character.annotations.destructiveHint).toBe(true);
    // 위젯 자동 렌더: generate_image도 show_creations와 동일하게 UI 리소스를 참조
    const genMeta = byName.generate_image._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(genMeta?.ui?.resourceUri).toBe('ui://kez-image-mcp/gallery.html');
    // 채팅 내 업로더 위젯 트리거
    const upMeta = byName.open_reference_uploader._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(upMeta?.ui?.resourceUri).toBe('ui://kez-image-mcp/uploader.html');
    expect((byName.show_creations._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(
      'ui://kez-image-mcp/gallery.html',
    );
  });
});

// ---------- 자산 레이어 ----------

describe('register_character', () => {
  it('base64 1~5장 → characters/{slug}/NN.png + meta.json 저장', async () => {
    await registerTestCharacter('kez-girl', 2);
    expect(r2.store.has('characters/kez-girl/01.png')).toBe(true);
    expect(r2.store.has('characters/kez-girl/02.png')).toBe(true);
    const meta = JSON.parse(new TextDecoder().decode(r2.store.get('characters/kez-girl/meta.json')!.bytes));
    expect(meta.slug).toBe('kez-girl');
    expect(meta.kind).toBe('character');
    expect(meta.files).toEqual(['characters/kez-girl/01.png', 'characters/kez-girl/02.png']);
    expect(meta.fixed_prompt).toContain('갈색 단발머리');
  });

  it('같은 slug 재등록 → 이전 파일 잔재 없이 교체, replaced=true', async () => {
    await registerTestCharacter('kez-girl', 3);
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'kez-girl',
      image_urls: [PNG_B64],
      description: '교체본',
      fixed_prompt: '교체된 외형 기술문',
    });
    expect(result.structuredContent?.replaced).toBe(true);
    expect(r2.store.has('characters/kez-girl/01.png')).toBe(true);
    expect(r2.store.has('characters/kez-girl/02.png')).toBe(false);
    expect(r2.store.has('characters/kez-girl/03.png')).toBe(false);
  });

  it('URL 소스 다운로드 지원', async () => {
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'url-char',
      image_urls: ['https://refs.example.com/sheet.png'],
      fixed_prompt: '외형 기술문',
    });
    expect(result.isError).toBeUndefined();
    expect(r2.store.get('characters/url-char/01.png')!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('R2 key 입력 → fetch 없이 버킷에서 직접 읽어 등록 (자기참조 문제 회피)', async () => {
    await r2.put('outputs/2026-06/gen1.webp', Buffer.from('fake-png-bytes'), {
      httpMetadata: { contentType: 'image/webp' },
    });
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'from-key',
      image_urls: ['outputs/2026-06/gen1.webp'],
      fixed_prompt: '외형 기술문',
    });
    expect(result.isError).toBeUndefined();
    // contentType 보존: webp 출력물은 webp로 등록
    expect(r2.store.get('characters/from-key/01.webp')!.contentType).toBe('image/webp');
    expect(r2.store.get('characters/from-key/01.webp')!.bytes).toEqual(new Uint8Array(Buffer.from('fake-png-bytes')));
  });

  it('자기 서명 URL 입력 → resolveToKey로 환원해 R2 직접 읽기 (기존 404 케이스)', async () => {
    await r2.put('outputs/2026-06/gen2.webp', Buffer.from('fake-png-bytes'), {
      httpMetadata: { contentType: 'image/webp' },
    });
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'from-signed-url',
      image_urls: [`${ORIGIN}/files/outputs/2026-06/gen2.webp?sig=whatever`],
      fixed_prompt: '외형 기술문',
    });
    expect(result.isError).toBeUndefined();
    expect(r2.store.has('characters/from-signed-url/01.webp')).toBe(true);
  });

  it('없는 R2 key → 명확한 에러 (자산 반파 없음)', async () => {
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'bad-key',
      image_urls: ['outputs/2026-06/nope.webp'],
      fixed_prompt: '외형 기술문',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('이미지 없음');
    expect([...r2.store.keys()].filter((k) => k.startsWith('characters/bad-key/'))).toEqual([]);
  });

  it('slug 형식 위반 → 입력 검증 실패', async () => {
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'Bad Slug!',
      image_urls: [PNG_B64],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('입력 검증 실패');
  });

  it('6장 초과 → 검증 실패', async () => {
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'too-many',
      image_urls: Array.from({ length: 6 }, () => PNG_B64),
    });
    expect(result.isError).toBe(true);
  });
});

describe('register_style', () => {
  it('styles/{slug}/anchor-NN.png 네이밍으로 저장', async () => {
    await registerTestStyle('webtoon-flat', 2);
    expect(r2.store.has('styles/webtoon-flat/anchor-01.png')).toBe(true);
    expect(r2.store.has('styles/webtoon-flat/anchor-02.png')).toBe(true);
    const meta = JSON.parse(new TextDecoder().decode(r2.store.get('styles/webtoon-flat/meta.json')!.bytes));
    expect(meta.kind).toBe('style');
  });
});

describe('list_assets / get_asset', () => {
  it('등록 자산 전체 목록 + 썸네일 서명 URL', async () => {
    await registerTestCharacter();
    await registerTestStyle();
    const result = await callTool(env, ORIGIN, 'list_assets', {});
    const sc = result.structuredContent as {
      characters: Array<{ slug: string; thumbnail_url: string; image_count: number }>;
      styles: Array<{ slug: string }>;
    };
    expect(sc.characters.map((c) => c.slug)).toEqual(['kez-girl']);
    expect(sc.styles.map((s) => s.slug)).toEqual(['webtoon-flat']);
    expect(sc.characters[0].image_count).toBe(2);
    expect(sc.characters[0].thumbnail_url).toContain(`${ORIGIN}/files/characters/kez-girl/01.png?sig=`);
  });

  it('get_asset → 이미지 URL 전체 + meta', async () => {
    await registerTestCharacter();
    const result = await callTool(env, ORIGIN, 'get_asset', { kind: 'character', slug: 'kez-girl' });
    const sc = result.structuredContent as { image_urls: string[]; fixed_prompt: string };
    expect(sc.image_urls.length).toBe(2);
    expect(sc.image_urls[0]).toContain('?sig=');
    expect(sc.fixed_prompt).toContain('갈색 단발머리');
  });

  it('없는 slug → 명확한 에러', async () => {
    const result = await callTool(env, ORIGIN, 'get_asset', { kind: 'character', slug: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('자산 없음');
  });
});

describe('delete_asset', () => {
  it('confirm 없음 → 삭제 미실행 에러, 파일 유지', async () => {
    await registerTestCharacter();
    const result = await callTool(env, ORIGIN, 'delete_asset', { kind: 'character', slug: 'kez-girl' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('confirm');
    expect(r2.store.has('characters/kez-girl/01.png')).toBe(true);
  });

  it('confirm=true → prefix 전체 삭제', async () => {
    await registerTestCharacter('kez-girl', 2);
    const result = await callTool(env, ORIGIN, 'delete_asset', {
      kind: 'character',
      slug: 'kez-girl',
      confirm: true,
    });
    expect(result.structuredContent?.deleted_files).toBe(3); // 01, 02, meta.json
    expect([...r2.store.keys()].filter((k) => k.startsWith('characters/kez-girl/'))).toEqual([]);
  });
});

// ---------- generate_image ----------

describe('generate_image', () => {
  it('style 미지정 → style 없이 순수 생성 성공 (/generations, 앵커 없음)', async () => {
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: '노을 지는 한강' });
    expect(result.isError).toBeUndefined();
    expect(openaiCalls.length).toBe(1);
    expect(openaiCalls[0].url).toContain('/v1/images/generations'); // 앵커 0 → edits 아님
  });

  it('텍스트만 화풍(이미지 0장) 등록 → 그 style로 생성 성공 (fixed_prompt가 프롬프트에 결합, /generations)', async () => {
    const reg = await callTool(env, ORIGIN, 'register_style', {
      slug: 'text-style',
      fixed_prompt: '플랫 셀 셰이딩 웹툰, 파스텔 팔레트',
    });
    expect(reg.isError).toBeUndefined();

    const gen = await callTool(env, ORIGIN, 'generate_image', { prompt: '고양이', style: 'text-style' });
    expect(gen.isError).toBeUndefined();
    expect(openaiCalls.length).toBe(1);
    expect(openaiCalls[0].url).toContain('/v1/images/generations'); // 앵커 0장 → edits 아님
    const body = JSON.parse(String(openaiCalls[0].init.body));
    expect(body.prompt).toContain('플랫 셀 셰이딩'); // 고정 화풍 결합
    expect(body.prompt).toContain('고양이'); // 장면 프롬프트
  });

  it('가드 B: 빈 문자열/공백 style → 거절, OpenAI 호출 0회', async () => {
    for (const style of ['', '   ']) {
      const result = await callTool(env, ORIGIN, 'generate_image', { prompt: 'x', style });
      expect(result.isError).toBe(true);
    }
    expect(openaiCalls.length).toBe(0);
  });

  it('가드 B-2: 미등록 style slug → 거절 + get_asset 안내, OpenAI 호출 0회', async () => {
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: 'x', style: 'ghost-style' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("style 'ghost-style' 미등록");
    expect(result.content[0].text).toContain('get_asset');
    expect(openaiCalls.length).toBe(0);
  });

  it('style만 지정 → edits 호출, 기본값 적용(model/quality/size/n/output_format)', async () => {
    await registerTestStyle('webtoon-flat', 2);
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: '노을 지는 한강', style: 'webtoon-flat' });
    expect(result.isError).toBeUndefined();
    const call = openaiCalls.at(-1)!;
    expect(call.url).toBe('https://api.openai.com/v1/images/edits');
    const form = call.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-flare'); // 기본 모델
    expect(form.get('quality')).toBe('medium');
    expect(form.get('size')).toBe('1024x1536');
    expect(form.get('n')).toBe('1');
    expect(form.get('output_format')).toBe('webp');
    expect(form.get('output_compression')).toBe('80');
    expect((form.getAll('image[]') as File[]).map((f) => f.name)).toEqual(['anchor-01.png', 'anchor-02.png']);
  });

  it('화이트리스트 밖 model → OpenAI 호출 전 거절 + 허용 목록 안내', async () => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', {
      prompt: 'x',
      style: 'webtoon-flat',
      model: 'dall-e-9',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2');
    expect(openaiCalls.length).toBe(0);
  });

  it.each(['gpt-image-1.5', 'gpt-image-1'])('제거된 모델 %s 명시 → OpenAI 호출 전 거절', async (model) => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', {
      prompt: 'x',
      style: 'webtoon-flat',
      model,
    });
    expect(result.isError).toBe(true);
    expect(openaiCalls.length).toBe(0);
  });

  it.each(['gpt-image-2.5-sunburst', 'gpt-image-2'])('%s 명시 → 허용, input_fidelity 생략', async (model) => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', {
      prompt: 'x',
      style: 'webtoon-flat',
      model,
    });
    expect(result.isError).toBeUndefined();
    const form = openaiCalls.at(-1)!.init.body as FormData;
    expect(form.get('model')).toBe(model);
    expect(form.get('input_fidelity')).toBeNull(); // 2.x 계열은 input_fidelity 미사용
  });

  it('gpt-image-2 신규 해상도(1088x1360)가 size 검증을 통과', async () => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', {
      prompt: 'x',
      style: 'webtoon-flat',
      size: '1088x1360',
    });
    expect(result.isError).toBeUndefined();
    expect((openaiCalls.at(-1)!.init.body as FormData).get('size')).toBe('1088x1360');
  });

  it('출력 b64 → outputs/{YYYY-MM}/ 저장 + 서명 URL + usage + 추정 비용 반환', async () => {
    await registerTestStyle('webtoon-flat', 1);
    openaiResponder = () => okImagesResponse(2);
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: '테스트', n: 2, style: 'webtoon-flat' });
    const sc = result.structuredContent as {
      urls: string[];
      usage: { input_tokens: number };
      estimated_cost_usd: number;
    };
    expect(sc.urls.length).toBe(2);
    const month = new Date().toISOString().slice(0, 7);
    expect(sc.urls[0]).toContain(`${ORIGIN}/files/outputs/${month}/`);
    expect(sc.urls[0]).toContain('?sig=');
    const outputKeys = [...r2.store.keys()].filter((k) => k.startsWith('outputs/'));
    expect(outputKeys.length).toBeGreaterThanOrEqual(2);
    expect(sc.usage.input_tokens).toBe(100);
    // 60 text×$5 + 40 image×$8 + 1000 out×$30 (gpt-image-2.5-flare 단가) / 1M = 0.03062 → 4자리 반올림
    expect(sc.estimated_cost_usd).toBe(0.0306);
  });

  it('character+style 지정 → edits multipart, 캐릭터 시트 먼저·앵커 나중', async () => {
    await registerTestCharacter('kez-girl', 2);
    await registerTestStyle('webtoon-flat', 3);
    const result = await callTool(env, ORIGIN, 'generate_image', {
      prompt: '카페에서 책 읽는 장면',
      character: 'kez-girl',
      style: 'webtoon-flat',
    });
    expect(result.isError).toBeUndefined();
    const call = openaiCalls.at(-1)!;
    expect(call.url).toBe('https://api.openai.com/v1/images/edits');
    const form = call.init.body as FormData;
    expect(form.get('input_fidelity')).toBeNull(); // 2.x 계열은 input_fidelity 미사용
    expect(form.get('model')).toBe('gpt-image-2.5-flare'); // 기본 모델
    const images = form.getAll('image[]') as File[];
    // 캐릭터 2장 먼저, 스타일 앵커는 3장 중 앞 2장만
    expect(images.map((f) => f.name)).toEqual(['01.png', '02.png', 'anchor-01.png', 'anchor-02.png']);
  });

  it('프롬프트 조립 순서: [화풍 기술문] + [역할 지시문] + [사용자 prompt]', async () => {
    await registerTestCharacter('kez-girl', 2);
    await registerTestStyle('webtoon-flat', 1);
    await callTool(env, ORIGIN, 'generate_image', {
      prompt: '카페 장면',
      character: 'kez-girl',
      style: 'webtoon-flat',
    });
    const form = openaiCalls.at(-1)!.init.body as FormData;
    const prompt = form.get('prompt') as string;
    const styleIdx = prompt.indexOf('플랫한 셀 셰이딩 웹툰 스타일');
    const roleIdx = prompt.indexOf('레퍼런스 시트');
    const charFixedIdx = prompt.indexOf('갈색 단발머리');
    const userIdx = prompt.indexOf('카페 장면');
    expect(styleIdx).toBeGreaterThanOrEqual(0);
    expect(roleIdx).toBeGreaterThan(styleIdx);
    expect(charFixedIdx).toBeGreaterThan(styleIdx);
    expect(userIdx).toBeGreaterThan(roleIdx);
  });

  it('미등록 캐릭터 지정 → OpenAI 호출 없이 에러', async () => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', {
      prompt: 'x',
      character: 'ghost',
      style: 'webtoon-flat',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('캐릭터 미등록');
    expect(openaiCalls.length).toBe(0);
  });

  it('n 최대 4 초과 → 검증 실패', async () => {
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: 'x', n: 5, style: 'webtoon-flat' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('입력 검증 실패');
  });
});

// ---------- 비동기 job 큐 (패치 3: wait:false + check_jobs) ----------

function fakeJobsNamespace() {
  const ops: Array<Record<string, unknown>> = [];
  return {
    ops,
    idFromName: () => 'queue-id',
    get: () => ({
      fetch: async (_url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? '{}');
        ops.push(body);
        if (body.op === 'enqueue') return new Response(JSON.stringify({ job_id: 'job-test-1' }));
        if (body.op === 'enqueue_batch') {
          const job_ids = (body.argsList ?? []).map((_: unknown, i: number) => `batch-job-${i + 1}`);
          return new Response(JSON.stringify({ job_ids }));
        }
        return new Response(
          JSON.stringify({
            jobs: [{ job_id: 'job-test-1', status: 'done', attempts: 1, result: { urls: ['https://x/o.webp'] } }],
          }),
        );
      },
    }),
  };
}

describe('async jobs (wait:false + check_jobs)', () => {
  it('wait:false → 즉시 job_id 반환, OpenAI 호출 0회, 큐에 적재', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(jenv, ORIGIN, 'generate_image', { prompt: 'x', style: 'webtoon-flat', wait: false });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { job_id: string; status: string; pending: boolean };
    expect(sc.job_id).toBe('job-test-1');
    expect(sc.status).toBe('queued');
    expect(sc.pending).toBe(true); // 위젯이 "생성 중" 안내를 띄우는 표식
    expect(openaiCalls.length).toBe(0); // 요청 수명 안에서 생성 안 함
    expect(jobs.ops[0].op).toBe('enqueue');
  });

  it('wait:false도 검증은 동기 — 미등록 style이면 적재 없이 거절', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    const result = await callTool(jenv, ORIGIN, 'generate_image', { prompt: 'x', style: 'ghost', wait: false });
    expect(result.isError).toBe(true);
    expect(jobs.ops.length).toBe(0); // 큐에 들어가지 않음
  });

  it('wait 미지정 → 기존 동기 동작 그대로 (JOBS 없이도 동작)', async () => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: 'x', style: 'webtoon-flat' });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { urls: string[] }).urls.length).toBe(1);
  });

  it('check_jobs → job별 상태·결과 반환', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    const result = await callTool(jenv, ORIGIN, 'check_jobs', { job_ids: ['job-test-1'] });
    const sc = result.structuredContent as {
      jobs: Array<{ job_id: string; status: string; result?: { urls: string[] } }>;
      count: number;
      urls: string[];
      items: Array<{ url: string; metadata: unknown }>;
    };
    expect(sc.jobs[0].status).toBe('done');
    expect(sc.jobs[0].result!.urls[0]).toContain('.webp');
    expect(jobs.ops[0]).toEqual({ op: 'status', ids: ['job-test-1'] });
    // done 컷을 위젯용 items로 집계 (이 fake는 items 없는 구형 result → urls 폴백 매핑)
    expect(sc.count).toBe(1);
    expect(sc.items[0].url).toBe('https://x/o.webp');
    expect(sc.items[0].metadata).toBeNull();
    expect(sc.urls).toEqual(['https://x/o.webp']);
  });

  it('check_jobs: 21개 초과 → 검증 실패', async () => {
    const result = await callTool(env, ORIGIN, 'check_jobs', {
      job_ids: Array.from({ length: 21 }, (_, i) => `j${i}`),
    });
    expect(result.isError).toBe(true);
  });
});

describe('generate_batch (여러 컷 1회 적재)', () => {
  it('3컷을 한 번에 적재 → job_ids 3개, enqueue_batch 1회, OpenAI 호출 0', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(jenv, ORIGIN, 'generate_batch', {
      defaults: { style: 'webtoon-flat' },
      cuts: [{ prompt: '1컷' }, { prompt: '2컷' }, { prompt: '3컷' }],
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { job_ids: string[]; count: number; pending: boolean };
    expect(sc.count).toBe(3);
    expect(sc.job_ids).toEqual(['batch-job-1', 'batch-job-2', 'batch-job-3']);
    expect(sc.pending).toBe(true);
    expect(openaiCalls.length).toBe(0); // 적재만 — 생성은 큐에서
    const batchOp = jobs.ops.find((o) => o.op === 'enqueue_batch')!;
    expect(batchOp).toBeTruthy();
    expect((batchOp.argsList as unknown[]).length).toBe(3); // 한 번의 op로 3건
  });

  it('defaults는 컷이 덮어쓴다 — 컷별 style 병합', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    await registerTestStyle('webtoon-flat', 1);
    await registerTestStyle('mono-line', 1);
    const result = await callTool(jenv, ORIGIN, 'generate_batch', {
      defaults: { style: 'webtoon-flat' },
      cuts: [{ prompt: 'a' }, { prompt: 'b', style: 'mono-line' }],
    });
    expect(result.isError).toBeUndefined();
    const batchOp = jobs.ops.find((o) => o.op === 'enqueue_batch')!;
    const list = batchOp.argsList as Array<{ style: string }>;
    expect(list[0].style).toBe('webtoon-flat'); // defaults
    expect(list[1].style).toBe('mono-line'); // 컷이 덮어씀
  });

  it('일부 컷이 미등록 style이면 거른 뒤 나머지만 적재 + errors 보고', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(jenv, ORIGIN, 'generate_batch', {
      cuts: [{ prompt: 'ok', style: 'webtoon-flat' }, { prompt: 'bad', style: 'ghost-style' }],
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { count: number; errors: Array<{ index: number }> };
    expect(sc.count).toBe(1); // 통과 1건만 적재
    expect(sc.errors[0].index).toBe(1); // 두 번째 컷 거부
  });

  it('모든 컷 거부 → isError', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    const result = await callTool(jenv, ORIGIN, 'generate_batch', {
      cuts: [{ prompt: 'x', style: 'ghost' }],
    });
    expect(result.isError).toBe(true);
    expect(jobs.ops.some((o) => o.op === 'enqueue_batch')).toBe(false); // 적재 0
  });
});

// ---------- 앵커 다운스케일 (패치 2: IMAGES + R2 512 캐시) ----------

function fakeImages(marker = 'scaled-512') {
  const state = { calls: 0 };
  const chain = {
    transform: () => chain,
    output: async () => ({ response: () => new Response(Buffer.from(marker)) }),
  };
  return {
    state,
    input: () => {
      state.calls += 1;
      return chain;
    },
  };
}

describe('anchor downscale (IMAGES binding)', () => {
  it('IMAGES 있으면 앵커를 512 변환본으로 첨부 + R2 캐시 저장', async () => {
    const images = fakeImages();
    const ienv = { ...env, IMAGES: images as unknown as Env['IMAGES'] };
    await registerTestStyle('webtoon-flat', 2);
    const result = await callTool(ienv, ORIGIN, 'generate_image', { prompt: 'x', style: 'webtoon-flat' });
    expect(result.isError).toBeUndefined();
    const files = (openaiCalls.at(-1)!.init.body as FormData).getAll('image[]') as File[];
    expect(files.map((f) => f.name)).toEqual(['anchor-01.png.512.webp', 'anchor-02.png.512.webp']);
    expect(files[0].type).toBe('image/webp');
    expect(r2.store.has('styles/webtoon-flat/anchor-01.png.512.webp')).toBe(true); // 영구 캐시
    expect(images.state.calls).toBe(2); // 앵커 2장 → 변환 2회
  });

  it('두 번째 생성은 캐시 히트 — 변환 0회', async () => {
    const images = fakeImages();
    const ienv = { ...env, IMAGES: images as unknown as Env['IMAGES'] };
    await registerTestStyle('webtoon-flat', 1);
    await callTool(ienv, ORIGIN, 'generate_image', { prompt: 'x', style: 'webtoon-flat' });
    expect(images.state.calls).toBe(1);
    await callTool(ienv, ORIGIN, 'generate_image', { prompt: 'y', style: 'webtoon-flat' });
    expect(images.state.calls).toBe(1); // 캐시 재사용
  });

  it('IMAGES 없으면 원본 그대로 첨부 (기존 동작 폴백)', async () => {
    await registerTestStyle('webtoon-flat', 1);
    await callTool(env, ORIGIN, 'generate_image', { prompt: 'x', style: 'webtoon-flat' });
    const files = (openaiCalls.at(-1)!.init.body as FormData).getAll('image[]') as File[];
    expect(files[0].name).toBe('anchor-01.png');
  });

  it('변환 실패 시 원본 폴백 — 생성은 계속된다', async () => {
    const broken = {
      input: () => ({
        transform() {
          return this;
        },
        output: async () => {
          throw new Error('images not enabled');
        },
      }),
    };
    const ienv = { ...env, IMAGES: broken as unknown as Env['IMAGES'] };
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(ienv, ORIGIN, 'generate_image', { prompt: 'x', style: 'webtoon-flat' });
    expect(result.isError).toBeUndefined();
    const files = (openaiCalls.at(-1)!.init.body as FormData).getAll('image[]') as File[];
    expect(files[0].name).toBe('anchor-01.png');
  });
});

// ---------- 생성 메타데이터 사이드카 (과제 4) ----------

describe('generation metadata sidecar', () => {
  it('생성 시 출력 키 + .json 사이드카 저장 — 앵커는 서명 없는 R2 키', async () => {
    await registerTestCharacter('kez-girl', 2);
    await registerTestStyle('webtoon-flat', 1);
    await callTool(env, ORIGIN, 'generate_image', {
      prompt: '카페 장면',
      character: 'kez-girl',
      style: 'webtoon-flat',
    });
    const sidecarKey = [...r2.store.keys()].find((k) => k.startsWith('outputs/') && k.endsWith('.webp.json'))!;
    expect(sidecarKey).toBeTruthy();
    const meta = JSON.parse(new TextDecoder().decode(r2.store.get(sidecarKey)!.bytes));
    expect(meta.scene_prompt).toBe('카페 장면');
    expect(meta.combined_prompt).toContain('플랫한 셀 셰이딩 웹툰 스타일'); // style fixed_prompt 결합본
    expect(meta.model).toBe('gpt-image-2.5-flare');
    expect(meta.character).toEqual({ slug: 'kez-girl', anchor_urls: ['characters/kez-girl/01.png', 'characters/kez-girl/02.png'] });
    expect(meta.style.slug).toBe('webtoon-flat');
    expect(meta.style.anchor_urls[0]).not.toContain('?sig='); // R2 키 저장 — 조회 시점 서명
    expect(meta.seed).toBeNull();
    expect(meta.seed_note).toBe('unsupported by gpt-image API');
    expect(meta.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('generate_image 응답에 metadata echo', async () => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: '바다', style: 'webtoon-flat' });
    const sc = result.structuredContent as { metadata: { scene_prompt: string; estimated_cost_usd: number } };
    expect(sc.metadata.scene_prompt).toBe('바다');
    expect(sc.metadata.estimated_cost_usd).toBe(0.0306); // gpt-image-2.5-flare 단가
  });

  it('generate_image 응답에 items[] — 위젯 자동 렌더용, 앵커는 서명 URL 사본', async () => {
    await registerTestCharacter('kez-girl', 2);
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', {
      prompt: '바다',
      character: 'kez-girl',
      style: 'webtoon-flat',
    });
    const sc = result.structuredContent as {
      urls: string[];
      items: Array<{ url: string; metadata: { scene_prompt: string; style: { anchor_urls: string[] }; character: { anchor_urls: string[] } } }>;
    };
    expect(sc.items.length).toBe(sc.urls.length);
    expect(sc.items[0].url).toBe(sc.urls[0]);
    expect(sc.items[0].metadata.scene_prompt).toBe('바다');
    // structuredContent 사본은 썸네일용 서명 URL — 저장 사이드카(R2 키)와 분리
    expect(sc.items[0].metadata.style.anchor_urls[0]).toContain('?sig=');
    expect(sc.items[0].metadata.character.anchor_urls[0]).toContain('?sig=');
    // 저장된 사이드카는 여전히 R2 키 (서명 없음)
    const sidecarKey = [...r2.store.keys()].find((k) => k.startsWith('outputs/') && k.endsWith('.webp.json'))!;
    const meta = JSON.parse(new TextDecoder().decode(r2.store.get(sidecarKey)!.bytes));
    expect(meta.style.anchor_urls[0]).not.toContain('?sig=');
  });

  it('show_creations: 사이드카 있는 항목 → items[].metadata + 앵커 조회시점 재서명', async () => {
    await registerTestStyle('webtoon-flat', 1);
    const gen = await callTool(env, ORIGIN, 'generate_image', { prompt: '바다', style: 'webtoon-flat' });
    const outputUrl = (gen.structuredContent as { urls: string[] }).urls[0];
    const result = await callTool(env, ORIGIN, 'show_creations', { urls: [outputUrl] });
    const sc = result.structuredContent as {
      count: number;
      urls: string[];
      items: Array<{ url: string; metadata: { style: { anchor_urls: string[] }; scene_prompt: string } | null }>;
    };
    expect(sc.items.length).toBe(1);
    expect(sc.items[0].metadata!.scene_prompt).toBe('바다');
    expect(sc.items[0].metadata!.style.anchor_urls[0]).toContain('?sig='); // 조회 시점 서명
    expect(sc.urls.length).toBe(1); // 후방호환 urls 유지
  });

  it('사이드카 없는 과거 이미지 → metadata null 폴백', async () => {
    await r2.put('outputs/2026-05/old.png', Buffer.from('fake-png-bytes'), {
      httpMetadata: { contentType: 'image/png' },
    });
    const result = await callTool(env, ORIGIN, 'show_creations', { urls: ['outputs/2026-05/old.png'] });
    const sc = result.structuredContent as { items: Array<{ metadata: unknown }> };
    expect(sc.items[0].metadata).toBeNull();
  });

  it('위젯 HTML에 상세 카드 요소 포함 (SEED 미지원 표기)', async () => {
    const res = await worker.fetch(
      rpcRequest(
        { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://kez-image-mcp/gallery.html' } },
        'test-token',
      ),
      env,
    );
    const json = (await res.json()) as { result: { contents: Array<{ text: string }> } };
    const html = json.result.contents[0].text;
    expect(html).toContain('미지원 (gpt-image)');
    expect(html).toContain('REFERENCES');
    expect(html).toContain('전체보기');
    expect(html).toContain('#grid .ref img'); // 레퍼런스 44px 규칙이 #grid img(전폭)를 이기는 명시도
    // 1차 UX: 라이트박스·호버 다운로드·복사 — CSS + 번들 JS 문자열이 인라인됐는지
    expect(html).toContain('.kez-lb'); // 라이트박스 오버레이 CSS
    expect(html).toContain('.dl-btn'); // 호버 다운로드 버튼 CSS
    expect(html).toContain('.copy-btn'); // 프롬프트 복사 버튼 CSS
    expect(html).toContain('프롬프트 복사'); // 번들 JS 리터럴 (단일 복사 버튼)
    expect(html).toContain('download='); // 다운로드 앵커: 서버 강제첨부 URL(?download=) 조립
    expect(html).toContain('전체 저장'); // 일괄 ZIP 다운로드 버튼 (번들 JS 리터럴)
    expect(html).toContain('.zip-btn'); // 일괄 저장 버튼 CSS
    expect(html).toContain('/zip?'); // 위젯이 조립하는 일괄 다운로드 엔드포인트
  });
});

// ---------- 고정 자산 잠금 (PROTECTED_SLUGS) ----------

describe('protected slugs', () => {
  let penv: Env;
  beforeEach(() => {
    penv = { ...env, PROTECTED_SLUGS: 'locked-char, locked-style,edu-*' };
  });

  it('보호 slug 재등록 → 거절 + 새 slug 안내', async () => {
    const result = await callTool(penv, ORIGIN, 'register_character', {
      slug: 'locked-char',
      image_urls: [PNG_B64],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('잠긴 자산');
    expect(result.content[0].text).toContain('locked-char-v3');
  });

  it('보호 slug(style) 삭제 → 거절', async () => {
    const result = await callTool(penv, ORIGIN, 'delete_asset', {
      kind: 'style',
      slug: 'locked-style',
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('잠긴 자산');
  });

  it('접두 규약: edu-* → edu-math 등록 거절', async () => {
    const result = await callTool(penv, ORIGIN, 'register_style', {
      slug: 'edu-math',
      image_urls: [PNG_B64],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('잠긴 자산');
  });

  it('비보호 slug 등록·삭제는 정상 동작', async () => {
    const reg = await callTool(penv, ORIGIN, 'register_style', {
      slug: 'project-banner',
      image_urls: [PNG_B64],
      fixed_prompt: '화풍 기술문',
    });
    expect(reg.isError).toBeUndefined();
    const del = await callTool(penv, ORIGIN, 'delete_asset', {
      kind: 'style',
      slug: 'project-banner',
      confirm: true,
    });
    expect(del.isError).toBeUndefined();
  });

  it('PROTECTED_SLUGS 미설정이면 모든 slug 자유 (기존 동작 유지)', async () => {
    const result = await callTool(env, ORIGIN, 'register_character', {
      slug: 'locked-char',
      image_urls: [PNG_B64],
      fixed_prompt: '외형 기술문',
    });
    expect(result.isError).toBeUndefined();
  });
});

// ---------- 인라인 image block ----------

type AnyBlock = { type: string; text?: string; data?: string; mimeType?: string };

describe('generate_image 인라인 image block', () => {
  it('생성 즉시 image block 포함 — n=2면 2개 선두 배치, urls는 후방호환 유지', async () => {
    await registerTestStyle('webtoon-flat', 1);
    openaiResponder = () => okImagesResponse(2);
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: '테스트', n: 2, style: 'webtoon-flat' });
    const content = result.content as AnyBlock[];
    expect(content[0].type).toBe('image'); // image 블록이 맨 앞
    expect(content[1].type).toBe('image');
    expect(content.at(-1)!.type).toBe('text'); // 기존 JSON 텍스트 블록 유지 (후미)
    const images = content.filter((b) => b.type === 'image');
    expect(images.length).toBe(2);
    for (const img of images) {
      expect(img.mimeType).toBe('image/webp'); // webp 출력 — 인라인 한도 대응
      expect(img.data).toBe(PNG_B64); // 순수 base64 — data URI 접두사 없음
      expect(img.data!.startsWith('data:')).toBe(false);
    }
    const sc = result.structuredContent as { urls: string[] };
    expect(sc.urls.length).toBe(2);
    expect(sc.urls[0]).toContain('.webp');
  });
});

describe('show_creations (MCP Apps 위젯 경로)', () => {
  it('R2 key 1개 → structuredContent에 서명 URL + 텍스트 폴백, image block 없음', async () => {
    await r2.put('outputs/2026-06/a.png', Buffer.from('fake-png-bytes'), {
      httpMetadata: { contentType: 'image/png' },
    });
    const result = await callTool(env, ORIGIN, 'show_creations', { urls: ['outputs/2026-06/a.png'] });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { count: number; urls: string[] };
    expect(sc.count).toBe(1);
    expect(sc.urls[0]).toContain(`${ORIGIN}/files/outputs/2026-06/a.png?sig=`);
    const content = result.content as AnyBlock[];
    expect(content.length).toBe(1);
    expect(content[0].type).toBe('text'); // 비-UI 호스트 폴백
    expect(content[0].text).toContain('?sig=');
  });

  it('서명 URL 입력은 key로 환원 후 유효 서명으로 재발급', async () => {
    await r2.put('outputs/2026-06/b.png', Buffer.from('fake-png-bytes'), {
      httpMetadata: { contentType: 'image/png' },
    });
    const result = await callTool(env, ORIGIN, 'show_creations', {
      urls: [`${ORIGIN}/files/outputs/2026-06/b.png?sig=whatever`],
    });
    const sc = result.structuredContent as { urls: string[] };
    const validSig = await fileSig(env, 'outputs/2026-06/b.png');
    expect(sc.urls[0]).toBe(`${ORIGIN}/files/outputs/2026-06/b.png?sig=${validSig}`);
  });

  it('3개 혼용(key + 서명 URL) → urls 3개 순서 유지', async () => {
    await r2.put('outputs/2026-06/c1.png', Buffer.from('fake-png-bytes'), { httpMetadata: { contentType: 'image/png' } });
    await r2.put('outputs/2026-06/c2.png', Buffer.from('fake-png-bytes'), { httpMetadata: { contentType: 'image/png' } });
    const result = await callTool(env, ORIGIN, 'show_creations', {
      urls: ['outputs/2026-06/c1.png', `${ORIGIN}/files/outputs/2026-06/c2.png?sig=x`, 'outputs/2026-06/c1.png'],
    });
    const sc = result.structuredContent as { count: number; urls: string[] };
    expect(sc.count).toBe(3);
    expect(sc.urls[0]).toContain('c1.png');
    expect(sc.urls[1]).toContain('c2.png');
  });

  it('외부 URL은 그대로 통과 (R2 조회·fetch 없음)', async () => {
    const result = await callTool(env, ORIGIN, 'show_creations', { urls: ['https://refs.example.com/sheet.png'] });
    const sc = result.structuredContent as { urls: string[] };
    expect(sc.urls).toEqual(['https://refs.example.com/sheet.png']);
  });

  it('없는 key → 명확한 에러', async () => {
    const result = await callTool(env, ORIGIN, 'show_creations', { urls: ['outputs/nope.png'] });
    expect(result.isError).toBe(true);
    expect((result.content as AnyBlock[])[0].text).toContain('이미지 없음');
  });

  it('10개 초과 → 검증 실패', async () => {
    const result = await callTool(env, ORIGIN, 'show_creations', {
      urls: Array.from({ length: 11 }, (_, i) => `outputs/${i}.png`),
    });
    expect(result.isError).toBe(true);
  });
});

// ---------- 일괄 ZIP 다운로드 (GET /zip) ----------

describe('buildStoreZip (STORE zip 조립기)', () => {
  it('PK 헤더 + EOCD 엔트리수 정확, 무압축(저장=원본크기)', () => {
    const enc = new TextEncoder();
    const files = [
      { name: 'a.webp', data: enc.encode('AAAA') },
      { name: 'b.webp', data: enc.encode('BBBBBB') },
    ];
    const zip = buildStoreZip(files);
    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    // EOCD(끝 22바이트) 내 "total entries"는 offset 8의 u16 → 파일 끝에서 -14/-13
    const entries = zip[zip.length - 14] | (zip[zip.length - 13] << 8);
    expect(entries).toBe(2);
  });
});

describe('일괄 ZIP 다운로드 (GET /zip)', () => {
  async function putOutput(key: string, body = 'fake-webp-bytes') {
    await r2.put(key, Buffer.from(body), { httpMetadata: { contentType: 'image/webp' } });
  }
  async function zipRequest(pairs: Array<[string, string]>, name?: string) {
    const qs = new URLSearchParams();
    if (name) qs.set('n', name);
    for (const [key, sig] of pairs) {
      qs.append('f', key);
      qs.append('s', sig);
    }
    return worker.fetch(new Request(`${ORIGIN}/zip?${qs.toString()}`), env);
  }
  const sigOf = (key: string) => fileSig(env, key);

  it('유효 서명 다중 파일 → 200 application/zip + attachment, 전 파일명 포함', async () => {
    await putOutput('outputs/2026-07/a.webp', 'AAAA');
    await putOutput('outputs/2026-07/b.webp', 'BBBBBB');
    const res = await zipRequest(
      [
        ['outputs/2026-07/a.webp', await sigOf('outputs/2026-07/a.webp')],
        ['outputs/2026-07/b.webp', await sigOf('outputs/2026-07/b.webp')],
      ],
      'insta.zip',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain('insta.zip');
    const text = new TextDecoder('latin1').decode(new Uint8Array(await res.arrayBuffer()));
    expect(text).toContain('a.webp');
    expect(text).toContain('b.webp');
  });

  it('n 미지정 → 기본 파일명 kez_images.zip', async () => {
    await putOutput('outputs/2026-07/a.webp');
    await putOutput('outputs/2026-07/b.webp');
    const res = await zipRequest([
      ['outputs/2026-07/a.webp', await sigOf('outputs/2026-07/a.webp')],
      ['outputs/2026-07/b.webp', await sigOf('outputs/2026-07/b.webp')],
    ]);
    expect(res.headers.get('Content-Disposition')).toContain('kez_images.zip');
  });

  it('서명 하나라도 틀리면 통째로 403 (부분 유출 차단)', async () => {
    await putOutput('outputs/2026-07/a.webp');
    await putOutput('outputs/2026-07/b.webp');
    const res = await zipRequest([
      ['outputs/2026-07/a.webp', await sigOf('outputs/2026-07/a.webp')],
      ['outputs/2026-07/b.webp', 'deadbeef'],
    ]);
    expect(res.status).toBe(403);
  });

  it('f/s 개수 불일치 → 400', async () => {
    const qs = new URLSearchParams();
    qs.append('f', 'outputs/x.webp');
    qs.append('f', 'outputs/y.webp');
    qs.append('s', 'onlyone');
    const res = await worker.fetch(new Request(`${ORIGIN}/zip?${qs.toString()}`), env);
    expect(res.status).toBe(400);
  });

  it('파일 수 상한(20) 초과 → 400', async () => {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < 21; i++) {
      const k = `outputs/2026-07/n${i}.webp`;
      pairs.push([k, await sigOf(k)]);
    }
    const res = await zipRequest(pairs);
    expect(res.status).toBe(400);
  });

  it('서명 유효하나 R2에 전부 없음 → 404', async () => {
    const res = await zipRequest([['outputs/2026-07/ghost.webp', await sigOf('outputs/2026-07/ghost.webp')]]);
    expect(res.status).toBe(404);
  });

  it('basename 충돌(다른 폴더 같은 이름) → zip 내부 접미번호로 분리', async () => {
    await putOutput('outputs/2026-06/shot.webp', 'X');
    await putOutput('outputs/2026-07/shot.webp', 'Y');
    const res = await zipRequest([
      ['outputs/2026-06/shot.webp', await sigOf('outputs/2026-06/shot.webp')],
      ['outputs/2026-07/shot.webp', await sigOf('outputs/2026-07/shot.webp')],
    ]);
    expect(res.status).toBe(200);
    const text = new TextDecoder('latin1').decode(new Uint8Array(await res.arrayBuffer()));
    expect(text).toContain('shot.webp');
    expect(text).toContain('shot_1.webp');
  });
});

// ---------- MCP Apps 리소스 (ui://) ----------

describe('MCP Apps resources', () => {
  it('initialize: resources capability + 지원 버전 에코, 미지원 버전은 최신으로', async () => {
    const res = await worker.fetch(
      rpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, 'test-token'),
      env,
    );
    const json = (await res.json()) as { result: { protocolVersion: string; capabilities: Record<string, unknown> } };
    expect(json.result.protocolVersion).toBe('2025-06-18');
    expect(json.result.capabilities.resources).toBeDefined();

    const future = await worker.fetch(
      rpcRequest({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, 'test-token'),
      env,
    );
    const fj = (await future.json()) as { result: { protocolVersion: string } };
    expect(fj.result.protocolVersion).toBe('2025-06-18');
  });

  it('resources/list: 갤러리 리소스 + mcp-app mimeType + CSP에 워커 출처', async () => {
    const res = await worker.fetch(rpcRequest({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, 'test-token'), env);
    const json = (await res.json()) as {
      result: { resources: Array<{ uri: string; mimeType: string; _meta: { ui: { csp: { resourceDomains: string[] } } } }> };
    };
    const r = json.result.resources[0];
    expect(r.uri).toBe('ui://kez-image-mcp/gallery.html');
    expect(r.mimeType).toBe('text/html;profile=mcp-app');
    // SDK는 HTML에 인라인 번들 — CSP는 이미지 출처(워커)만 필요, 외부 스크립트 출처 없음
    expect(r._meta.ui.csp.resourceDomains).toEqual([ORIGIN]);
  });

  it('resources/read: SDK 인라인 번들 HTML (외부 스크립트 src 없음, placeholder 포함)', async () => {
    const res = await worker.fetch(
      rpcRequest(
        { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://kez-image-mcp/gallery.html' } },
        'test-token',
      ),
      env,
    );
    const json = (await res.json()) as {
      result: { contents: Array<{ uri: string; mimeType: string; text: string }> };
    };
    const c = json.result.contents[0];
    expect(c.mimeType).toBe('text/html;profile=mcp-app');
    expect(c.text).toContain('갤러리 초기화 중'); // 스크립트가 죽어도 보이는 정적 placeholder
    expect(c.text.length).toBeGreaterThan(100_000); // SDK 번들 인라인
    expect(c.text).not.toContain('<script src='); // 런타임 외부 스크립트 의존 0
    expect(c.text).not.toContain('esm.sh');
  });

  it('resources/read: 모르는 uri → 에러', async () => {
    const res = await worker.fetch(
      rpcRequest({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'ui://nope' } }, 'test-token'),
      env,
    );
    const json = (await res.json()) as { error?: { code: number } };
    expect(json.error?.code).toBe(-32002);
  });

  it('tools/list: show_creations에 _meta ui/resourceUri 연결', async () => {
    const res = await worker.fetch(rpcRequest({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, 'test-token'), env);
    const json = (await res.json()) as {
      result: { tools: Array<{ name: string; _meta?: Record<string, unknown> }> };
    };
    const t = json.result.tools.find((x) => x.name === 'show_creations')!;
    expect((t._meta?.ui as { resourceUri: string }).resourceUri).toBe('ui://kez-image-mcp/gallery.html');
    expect(t._meta?.['ui/resourceUri']).toBe('ui://kez-image-mcp/gallery.html');
  });
});

// ---------- 에러 매핑 (구현 디테일 §4) ----------

describe('OpenAI error mapping', () => {
  // style 필수화 이후 OpenAI까지 도달하려면 등록된 style이 필요
  beforeEach(async () => {
    await registerTestStyle('webtoon-flat', 1);
  });
  const genArgs = { prompt: 'x', style: 'webtoon-flat' };

  it('400 moderation → 완화 재시도 안내', async () => {
    openaiResponder = () =>
      new Response(
        JSON.stringify({ error: { code: 'moderation_blocked', message: 'Your request was rejected by safety system' } }),
        { status: 400 },
      );
    const result = await callTool(env, ORIGIN, 'generate_image', genArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('moderation 차단');
    expect(result.content[0].text).toContain('완화');
  });

  it('429 insufficient_quota → 예산 소진 안내', async () => {
    openaiResponder = () =>
      new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), {
        status: 429,
      });
    const result = await callTool(env, ORIGIN, 'generate_image', genArgs);
    expect(result.content[0].text).toContain('예산 소진');
  });

  it('429 일반 → 레이트리밋 안내', async () => {
    openaiResponder = () =>
      new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } }), {
        status: 429,
      });
    const result = await callTool(env, ORIGIN, 'generate_image', genArgs);
    expect(result.content[0].text).toContain('레이트리밋');
  });

  it('401 → 키 점검 안내 (키 값 자체는 비노출)', async () => {
    openaiResponder = () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 });
    const result = await callTool(env, ORIGIN, 'generate_image', genArgs);
    expect(result.content[0].text).toContain('OPENAI_API_KEY');
    expect(result.content[0].text).not.toContain('sk-test-secret-key');
  });

  it('에러 메시지 내 sk- 키 형태 마스킹', () => {
    expect(sanitize('leaked sk-proj-abcdef1234567890 in message')).toBe('leaked sk-*** in message');
  });
});

// ---------- 서명 파일 서빙 ----------

describe('GET /files/{key}?sig=', () => {
  it('서명 불일치 → 403, 서명 일치 → 200 + content-type', async () => {
    await r2.put('outputs/2026-06/test.png', new Uint8Array([9, 9]), { httpMetadata: { contentType: 'image/png' } });
    const key = 'outputs/2026-06/test.png';

    const bad = await worker.fetch(new Request(`${ORIGIN}/files/${key}?sig=deadbeef00000000`), env);
    expect(bad.status).toBe(403);

    const sig = await fileSig(env, key);
    const good = await worker.fetch(new Request(`${ORIGIN}/files/${key}?sig=${sig}`), env);
    expect(good.status).toBe(200);
    expect(good.headers.get('Content-Type')).toBe('image/png');
  });

  it('characters 원본도 서명 없이는 접근 불가 (내부 자산 보호)', async () => {
    await registerTestCharacter();
    const res = await worker.fetch(new Request(`${ORIGIN}/files/characters/kez-girl/01.png`), env);
    expect(res.status).toBe(403);
  });

  it('CORP·expose 헤더 부착 (크로스오리진 iframe blob 다운로드용)', async () => {
    await r2.put('outputs/2026-06/corp.png', new Uint8Array([1]), { httpMetadata: { contentType: 'image/png' } });
    const key = 'outputs/2026-06/corp.png';
    const sig = await fileSig(env, key);
    const res = await worker.fetch(new Request(`${ORIGIN}/files/${key}?sig=${sig}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('cross-origin');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Content-Disposition');
    expect(res.headers.get('Content-Disposition')).toBeNull(); // download 쿼리 없으면 inline
  });

  it('?download= → Content-Disposition attachment + 파일명 새니타이즈', async () => {
    await r2.put('outputs/2026-06/dl.png', new Uint8Array([2]), { httpMetadata: { contentType: 'image/png' } });
    const key = 'outputs/2026-06/dl.png';
    const sig = await fileSig(env, key);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/files/${key}?sig=${sig}&download=${encodeURIComponent('kez bad/name.webp')}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="kez_bad_name.webp"');
  });
});

// ---------- 이미지 업로드 (HTTP 엔드포인트 — MCP 도구 아님, 이미지 바이트 LLM 미통과) ----------

describe('PUT /assets/upload + GET /assets/upload-token', () => {
  // 마스터 토큰으로 파생 업로드 토큰 회수 (실제 클라이언트 흐름 그대로)
  async function getUploadToken(): Promise<string> {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload-token`, { headers: { Authorization: 'Bearer test-token' } }),
      env,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { upload_token: string }).upload_token;
  }

  it('upload-token: 마스터 토큰 필요 — 미인증 401, 인증 시 64-hex 파생 토큰(결정론적)', async () => {
    const bad = await worker.fetch(new Request(`${ORIGIN}/assets/upload-token`), env);
    expect(bad.status).toBe(401);
    const t1 = await getUploadToken();
    const t2 = await getUploadToken();
    expect(t1).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
    expect(t1).toBe(t2); // 결정론적 — 재사용 가능
    expect(t1).not.toBe('test-token'); // 마스터 토큰과 분리(파일서명 키 격리)
  });

  it('upload: 잘못된 토큰 401 (마스터 토큰으로는 업로드 불가 — 분리 검증)', async () => {
    const wrong = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'image/webp' },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
    );
    expect(wrong.status).toBe(401); // 마스터 토큰 ≠ 업로드 토큰
  });

  it('upload: 성공 → {key,url,bytes,mime}, R2 저장, 이미지 바이트 미반환', async () => {
    const token = await getUploadToken();
    const body = new Uint8Array([10, 20, 30, 40, 50]);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/webp' },
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { key: string; url: string; bytes: number; mime: string };
    expect(j.key).toMatch(/^uploads\/\d{4}-\d{2}\/[0-9a-f-]+\.webp$/);
    expect(j.mime).toBe('image/webp');
    expect(j.bytes).toBe(5);
    expect(j.url).toContain(`${ORIGIN}/files/uploads/`);
    expect(j.url).toContain('?sig=');
    // 응답에 이미지 바이트/base64 없음 (불변 원칙)
    expect(JSON.stringify(j)).not.toContain(Buffer.from(body).toString('base64'));
    // R2에 실제 저장 — 업로드 key가 그대로 register의 image_urls 분기 ②로 들어갈 수 있음
    expect(r2.store.has(j.key)).toBe(true);
    expect(r2.store.get(j.key)!.contentType).toBe('image/webp');
  });

  it('upload: 모호한 Content-Type → ?mime= 쿼리로 판별', async () => {
    const token = await getUploadToken();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload?mime=image/png`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array([1]),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { key: string }).key).toMatch(/\.png$/);
  });

  it('upload: 지원 안 하는 mime → 415, 빈 본문 → 400', async () => {
    const token = await getUploadToken();
    const bad = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf' },
        body: new Uint8Array([1]),
      }),
      env,
    );
    expect(bad.status).toBe(415);
    const empty = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/webp' },
        body: new Uint8Array([]),
      }),
      env,
    );
    expect(empty.status).toBe(400);
  });

  it('upload→register 라운드트립: 업로드 key를 register image_urls에 직접 사용', async () => {
    const token = await getUploadToken();
    const up = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
        body: new Uint8Array([9, 8, 7]),
      }),
      env,
    );
    const { key } = (await up.json()) as { key: string };
    // register는 무수정 — loadImageSource 분기 ②(R2 key)가 받는다
    const reg = await callTool(env, ORIGIN, 'register_character', {
      slug: 'uploaded-char',
      image_urls: [key],
      description: '업로드로 등록',
      fixed_prompt: '외형 기술문',
    });
    expect(reg.isError).toBeUndefined();
  });
});

// ---------- [C] 채팅 내 업로더 위젯 (POST /assets/register + 리소스 토큰 주입) ----------

describe('[C] 업로더 위젯 — register 엔드포인트 + 리소스', () => {
  async function getUploadToken(): Promise<string> {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload-token`, { headers: { Authorization: 'Bearer test-token' } }),
      env,
    );
    return ((await res.json()) as { upload_token: string }).upload_token;
  }

  async function uploadOne(token: string, mime = 'image/png'): Promise<string> {
    const res = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
        body: new Uint8Array([1, 2, 3]),
      }),
      env,
    );
    return ((await res.json()) as { key: string }).key;
  }

  it('open_reference_uploader: 위젯 트리거 — kind/slug 프리필 반환', async () => {
    const r = await callTool(env, ORIGIN, 'open_reference_uploader', { kind: 'character', slug: 'toon-wizard' });
    const sc = r.structuredContent as { kind: string; slug: string };
    expect(sc.kind).toBe('character');
    expect(sc.slug).toBe('toon-wizard');
  });

  it('resources/list에 업로더 위젯 포함', async () => {
    const res = await worker.fetch(rpcRequest({ jsonrpc: '2.0', id: 1, method: 'resources/list' }, 'test-token'), env);
    const json = (await res.json()) as { result: { resources: Array<{ uri: string }> } };
    expect(json.result.resources.map((r) => r.uri)).toContain('ui://kez-image-mcp/uploader.html');
  });

  it('resources/read 업로더: 토큰·origin 주입 + connectDomains CSP, 플레이스홀더 잔존 없음', async () => {
    const res = await worker.fetch(
      rpcRequest(
        { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://kez-image-mcp/uploader.html' } },
        'test-token',
      ),
      env,
    );
    const json = (await res.json()) as {
      result: { contents: Array<{ text: string; _meta: { ui: { csp: { connectDomains: string[] } } } }> };
    };
    const c = json.result.contents[0];
    expect(c.text).not.toContain('__UPLOAD_TOKEN__'); // 치환됨
    expect(c.text).not.toContain('__WORKER_ORIGIN__');
    expect(c.text).toContain(await getUploadToken()); // 실제 파생 토큰 주입
    expect(c.text).toContain(ORIGIN);
    expect(c._meta.ui.csp.connectDomains).toEqual([ORIGIN]); // 워커 fetch 허용
  });

  it('POST /assets/register: 틀린 토큰 401, 잘못된 kind 400', async () => {
    const wrong = await worker.fetch(
      new Request(`${ORIGIN}/assets/register`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'character', slug: 'x', image_urls: ['uploads/2026-06/a.png'] }),
      }),
      env,
    );
    expect(wrong.status).toBe(401); // 마스터 토큰으로는 등록 불가(저권한 토큰 전용)

    const token = await getUploadToken();
    const badKind = await worker.fetch(
      new Request(`${ORIGIN}/assets/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'nope', slug: 'x', image_urls: ['uploads/2026-06/a.png'] }),
      }),
      env,
    );
    expect(badKind.status).toBe(400);
  });

  it('POST /assets/register: 업로드한 key로 등록 성공 (위젯 종결 흐름)', async () => {
    const token = await getUploadToken();
    const key1 = await uploadOne(token);
    const key2 = await uploadOne(token);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/assets/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'character', slug: 'toon-wizard', image_urls: [key1, key2], fixed_prompt: '둥근 얼굴 마법사' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { slug: string; files: string[]; error?: string };
    expect(j.error).toBeUndefined();
    expect(j.slug).toBe('toon-wizard');
    expect(j.files.length).toBe(2);
    // 실제 R2에 앵커 2장 + meta.json 저장됐는지
    expect(r2.store.has('characters/toon-wizard/meta.json')).toBe(true);
  });
});

// ---------- 자산 완성도 게이트 (fixed_prompt 필수 + draft + slug 충돌) ----------

describe('자산 완성도 게이트', () => {
  async function masterUploadToken(): Promise<string> {
    const r = await worker.fetch(
      new Request(`${ORIGIN}/assets/upload-token`, { headers: { Authorization: 'Bearer test-token' } }),
      env,
    );
    return ((await r.json()) as { upload_token: string }).upload_token;
  }
  // 위젯 경로(/assets/register)로 draft(이미지만) 등록 — fixed_prompt 없이 허용된다
  async function registerDraft(kind: string, slug: string): Promise<Response> {
    const token = await masterUploadToken();
    return worker.fetch(
      new Request(`${ORIGIN}/assets/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, slug, image_urls: [PNG_B64] }),
      }),
      env,
    );
  }

  it('register_* fixed_prompt="" 또는 공백뿐 → 거부 (도구 경로)', async () => {
    const c = await callTool(env, ORIGIN, 'register_character', { slug: 'no-prompt', image_urls: [PNG_B64], fixed_prompt: '' });
    expect(c.isError).toBe(true);
    expect(c.content[0].text).toContain('fixed_prompt 필수');
    const s = await callTool(env, ORIGIN, 'register_style', { slug: 'no-prompt-s', image_urls: [PNG_B64], fixed_prompt: '   ' });
    expect(s.isError).toBe(true); // 공백만도 거부
    expect(r2.store.has('characters/no-prompt/meta.json')).toBe(false); // 저장 안 됨
  });

  it('위젯 업로드(이미지만) → draft 허용 + 응답에 status/complete/hint + list_assets에서 ⚠️', async () => {
    const reg = await registerDraft('style', 'draft-style');
    expect(reg.status).toBe(200);
    const j = (await reg.json()) as { status: string; complete: boolean; hint: string };
    expect(j.status).toBe('draft');
    expect(j.complete).toBe(false);
    expect(j.hint).toContain('register_style');

    const list = await callTool(env, ORIGIN, 'list_assets', {});
    const sc = list.structuredContent as {
      styles: Array<{ slug: string; complete: boolean; status: string; source: string; warning?: string }>;
    };
    const draft = sc.styles.find((s) => s.slug === 'draft-style')!;
    expect(draft.complete).toBe(false);
    expect(draft.status).toBe('draft');
    expect(draft.source).toBe('widget');
    expect(draft.warning).toContain('⚠️');
  });

  it('draft(미완성) style로 generate → 거부 + 채우는 법 안내, 비용 0', async () => {
    await registerDraft('style', 'draft-style2');
    const gen = await callTool(env, ORIGIN, 'generate_image', { prompt: '바다', style: 'draft-style2' });
    expect(gen.isError).toBe(true);
    expect(gen.content[0].text).toContain('미완성');
    expect(gen.content[0].text).toContain('register_style');
    expect(openaiCalls.length).toBe(0); // OpenAI 호출 0
  });

  it('draft character로 generate → 거부 (정상 style이어도)', async () => {
    await registerTestStyle('webtoon-flat', 1);
    await registerDraft('character', 'draft-char');
    const gen = await callTool(env, ORIGIN, 'generate_image', {
      prompt: '인물',
      style: 'webtoon-flat',
      character: 'draft-char',
    });
    expect(gen.isError).toBe(true);
    expect(gen.content[0].text).toContain('미완성');
    expect(openaiCalls.length).toBe(0);
  });

  it('generate_batch도 draft style 컷을 거른다', async () => {
    const jobs = fakeJobsNamespace();
    const jenv = { ...env, JOBS: jobs as unknown as Env['JOBS'] };
    await registerTestStyle('webtoon-flat', 1);
    await registerDraft('style', 'draft-style3');
    const result = await callTool(jenv, ORIGIN, 'generate_batch', {
      cuts: [{ prompt: 'ok', style: 'webtoon-flat' }, { prompt: 'bad', style: 'draft-style3' }],
    });
    const sc = result.structuredContent as { count: number; errors: Array<{ index: number; error: string }> };
    expect(sc.count).toBe(1); // 정상 1건만
    expect(sc.errors[0].index).toBe(1);
    expect(sc.errors[0].error).toContain('미완성');
  });

  it('character와 같은 slug를 style로 등록 → 거부, confirm:true로 통과', async () => {
    await registerTestCharacter('dup-slug', 1); // character 등록 (fixed_prompt 있음)
    const conflict = await callTool(env, ORIGIN, 'register_style', {
      slug: 'dup-slug',
      image_urls: [PNG_B64],
      fixed_prompt: '화풍 기술문',
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0].text).toContain('이미 character');
    const forced = await callTool(env, ORIGIN, 'register_style', {
      slug: 'dup-slug',
      image_urls: [PNG_B64],
      fixed_prompt: '화풍 기술문',
      confirm: true,
    });
    expect(forced.isError).toBeUndefined();
  });

  it('회귀: fixed_prompt 채워진 정상 자산은 등록·generate 그대로 동작', async () => {
    await registerTestStyle('webtoon-flat', 1);
    const result = await callTool(env, ORIGIN, 'generate_image', { prompt: '노을', style: 'webtoon-flat' });
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as { urls: string[] }).urls.length).toBe(1);
  });
});

// ---------- OAuth 핸드셰이크 (claude.ai Custom Connector) ----------

describe('OAuth handshake (passcode gate + PKCE)', () => {
  const RU = 'https://claude.ai/api/mcp/auth_callback';
  function b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // PKCE(S256): 임의 verifier → SHA-256 → base64url challenge (워커 검증과 동일 방식)
  async function pkce(): Promise<{ verifier: string; challenge: string }> {
    const verifier = 'kez-test-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
    const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return { verifier, challenge: b64url(dig) };
  }
  function postForm(path: string, fields: Record<string, string>): Request {
    return new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });
  }
  const authForm = (challenge: string, passcode: string, extra: Record<string, string> = {}) =>
    postForm('/authorize', {
      redirect_uri: RU,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      passcode,
      ...extra,
    });

  it('.well-known 메타데이터 → 200, PKCE는 S256만 광고(plain 다운그레이드 차단)', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { token_endpoint: string; code_challenge_methods_supported: string[] };
    expect(json.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(json.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('/authorize GET: evil 리다이렉트 400 · PKCE 없으면 400 · 정상은 즉시 code가 아니라 비번 폼(200 HTML)', async () => {
    const { challenge } = await pkce();
    const evil = await worker.fetch(
      new Request(
        `${ORIGIN}/authorize?redirect_uri=${encodeURIComponent('https://evil.com/cb')}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
      ),
      env,
    );
    expect(evil.status).toBe(400);

    const noPkce = await worker.fetch(
      new Request(`${ORIGIN}/authorize?redirect_uri=${encodeURIComponent(RU)}&response_type=code`),
      env,
    );
    expect(noPkce.status).toBe(400);

    const form = await worker.fetch(
      new Request(`${ORIGIN}/authorize?redirect_uri=${encodeURIComponent(RU)}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`),
      env,
    );
    expect(form.status).toBe(200);
    expect(form.headers.get('Content-Type')).toContain('text/html');
    expect(await form.text()).toContain('name="passcode"');
  });

  it('🔒 /authorize POST: 틀린 비번 → 401(code 미발급) · 맞는 비번 → 302(code 발급)', async () => {
    const { challenge } = await pkce();
    const wrong = await worker.fetch(authForm(challenge, 'wrong-passcode'), env);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('Location')).toBeNull();

    const ok = await worker.fetch(authForm(challenge, 'test-passcode', { state: 'xyz' }), env);
    expect(ok.status).toBe(302);
    const loc = ok.headers.get('Location')!;
    expect(loc).toContain(`${RU}?code=`);
    expect(loc).toContain('state=xyz');
  });

  it('🔒 /token: 익명·가짜 code로는 토큰 못 받음 (옆문 차단)', async () => {
    const noCode = await worker.fetch(new Request(`${ORIGIN}/token`, { method: 'POST', body: '' }), env);
    expect(noCode.status).toBe(400);
    const fake = await worker.fetch(
      postForm('/token', { grant_type: 'authorization_code', code: 'anything-i-want', redirect_uri: RU }),
      env,
    );
    expect(fake.status).toBe(400);
    expect(((await fake.json()) as { access_token?: string }).access_token).toBeUndefined();
  });

  it('정상 흐름: 비번 통과 code + 올바른 PKCE verifier → /token 200 access_token (틀린 verifier는 400)', async () => {
    const { verifier, challenge } = await pkce();
    const auth = await worker.fetch(authForm(challenge, 'test-passcode'), env);
    const code = new URL(auth.headers.get('Location')!).searchParams.get('code')!;

    // 틀린 verifier → PKCE 실패 400 (code 를 훔쳐도 verifier 없이는 무용)
    const badVer = await worker.fetch(
      postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: RU, code_verifier: 'not-the-verifier' }),
      env,
    );
    expect(badVer.status).toBe(400);

    // redirect_uri 불일치 → 400
    const badRu = await worker.fetch(
      postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/other', code_verifier: verifier }),
      env,
    );
    expect(badRu.status).toBe(400);

    // 올바른 verifier + redirect_uri → 200
    const tok = await worker.fetch(
      postForm('/token', { grant_type: 'authorization_code', code, redirect_uri: RU, code_verifier: verifier }),
      env,
    );
    expect(tok.status).toBe(200);
    const body = (await tok.json()) as { access_token: string; refresh_token: string };
    expect(body.access_token).toBe('test-token');
    expect(body.refresh_token).toBeTruthy();

    // refresh_token 그랜트 → 다시 access_token
    const refreshed = await worker.fetch(
      postForm('/token', { grant_type: 'refresh_token', refresh_token: body.refresh_token }),
      env,
    );
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { access_token: string }).access_token).toBe('test-token');
  });
});

// ---------- 비용 추정 단위 ----------

describe('estimateCost', () => {
  it('usage 없음 → null', () => {
    expect(estimateCost('gpt-image-2.5-flare', undefined)).toBeNull();
  });

  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])('%s 단가 (text 5 / image 8 / out 30 USD per 1M)', (model) => {
    const cost = estimateCost(model, {
      input_tokens: 150,
      output_tokens: 1000,
      input_tokens_details: { text_tokens: 100, image_tokens: 50 },
    });
    expect(cost).toBeCloseTo((100 * 5 + 50 * 8 + 1000 * 30) / 1_000_000, 6);
  });

  it('미등록 모델 → gpt-image-2 단가 폴백', () => {
    const cost = estimateCost('gpt-image-9', {
      input_tokens: 100,
      output_tokens: 1000,
      input_tokens_details: { text_tokens: 100, image_tokens: 0 },
    });
    expect(cost).toBeCloseTo((100 * 5 + 1000 * 32) / 1_000_000, 6);
  });
});

// ---------- 프롬프트 조립 단위 ----------

describe('assemblePrompt', () => {
  it('참조 전혀 없음 → 사용자 prompt 그대로', () => {
    expect(assemblePrompt('바다 풍경', null, null, 0)).toBe('바다 풍경');
  });
});
