# Kez gpt-image — Claude용 이미지 생성 MCP 서버

OpenAI **gpt-image**를 Claude(claude.ai · 데스크탑 · 폰)에 붙여, **채팅 안에서** 이미지를 생성하고 화풍·캐릭터를 일관되게 관리하는 MCP 서버입니다. Cloudflare Worker로 **1인 1배포**, Cloudflare는 무료 한도 안에서 사실상 0원(과금은 본인 OpenAI 사용량만).

---

## 뭐가 다른가 — 이 서버만의 장점

단순히 이미지를 뱉는 게 아니라, 결과가 **Claude 채팅 안의 위젯**으로 떠서 한눈에 보이고 관리됩니다.

- 🖼️ **결과 위젯** — 생성된 이미지가 **비용($)·해상도·모델·사용 토큰·전체 프롬프트**까지 담긴 카드로 표시됩니다. 이미지를 클릭하면 확대(라이트박스), 호버하면 다운로드 버튼.
- 🎨 **레퍼런스(화풍·캐릭터) 등록을 채팅 안에서** — 채팅에 뜨는 **끌어놓기 위젯**에 이미지를 드롭하면 곧바로 저장소(R2)에 올라가 앵커로 등록됩니다. 이미지 바이트가 LLM(대화)을 **통과하지 않아** 토큰을 쓰지 않습니다. 등록한 화풍/캐릭터로 **일관된 시리즈**를 생성할 수 있습니다.
- 🧩 **화풍 일관성 게이트** — style을 필수로 두고 등록된 앵커 + 고정 프롬프트를 자동 결합해, 여러 컷을 뽑아도 그림체가 흔들리지 않습니다. (미완성 화풍은 생성 단계에서 막아 "조용한 실패"를 방지)
- ⚡ **배치 생성** — 여러 컷을 한 번의 호출로 큐에 올리고(`generate_batch`), 완성된 컷들을 한 번에 위젯으로 회수(`check_jobs`). 분당 페이싱·자동 재시도·10분 시간초과까지 서버가 알아서 처리.
- 🔐 **보안 내장** — 비공개 R2 + HMAC 서명 URL, Bearer 인증, 업로드 전용 저권한 토큰 분리.

**제공 도구(claude.ai가 자동 인식):**
`generate_image` · `generate_batch` · `check_jobs` · `show_creations` · `open_reference_uploader` · `register_character` · `register_style` · `list_assets` · `get_asset` · `delete_asset`

---

## 필요한 것

- **Cloudflare 계정**(무료) — 워커·R2 저장소
- **OpenAI API 키** — https://platform.openai.com/api-keys (이미지 사용량만큼 본인 OpenAI에 과금)
- **Node.js 22+**, 터미널

---

## 설치 — 방법 1: Claude Code 한 프롬프트 (제일 쉬움)

이 저장소를 받은 뒤, **클로드 코드에 아래를 그대로 붙여넣으세요.** 나머지는 클로드가 합니다.

```
이 폴더(kez-gpt-image-mcp)를 내 Cloudflare에 배포해줘.
1) node가 22+ 인지 확인하고 npm install.
2) npx wrangler login 하고 어느 계정인지 보여줘.
3) wrangler.toml의 bucket_name 으로 R2 버킷을 만들어줘 (npx wrangler r2 bucket create ...).
4) OPENAI_API_KEY 시크릿에 내 OpenAI 키를 넣어줘 — 나한테 물어보고, 화면·로그에 절대 출력하지 마.
5) openssl rand -hex 32 로 MCP_AUTH_TOKEN 을 만들어 시크릿에 넣고, 그 토큰 값은 나한테 보여줘(커넥터에 쓸 거라).
6) npm run build:widget 후 npx wrangler deploy 하고 워커 URL을 알려줘.
끝나면 claude.ai 커넥터에 넣을 URL과 Bearer 토큰을 정리해서 보여줘.
```

## 설치 — 방법 2: 셋업 스크립트 (터미널 원터치)

```bash
npm run setup
```

로그인 → R2 버킷 → OpenAI 키 입력 → 인증 토큰 자동 생성 → 빌드·배포 까지 차례로 처리하고, 끝에 **커넥터에 넣을 URL·토큰**을 출력합니다.

## 설치 — 방법 3: 수동 (CLI)

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create kez-gpt-image-assets      # wrangler.toml의 bucket_name과 동일하게
npx wrangler secret put OPENAI_API_KEY                  # 본인 OpenAI 키 입력
openssl rand -hex 32                                    # 출력값 복사 (커넥터 Bearer 토큰)
npx wrangler secret put MCP_AUTH_TOKEN                  # 위 openssl 값을 입력
npm run deploy                                          # 위젯 빌드 + 배포 → 끝에 워커 URL
```

---

## claude.ai 커넥터 등록

claude.ai → **Settings → Connectors → Add custom connector**:

| 필드 | 값 |
|------|-----|
| URL | 배포된 워커 URL (예: `https://kez-gpt-image-mcp.<본인>.workers.dev`) |
| Authentication | **Bearer** |
| Bearer Token | 위에서 만든 `MCP_AUTH_TOKEN` 값 |

저장하면 도구가 자동 인식됩니다. 대화창의 도구 아이콘에서 이 커넥터를 **ON**.

---

## 써보기

- **생성:** "노을 지는 한강을 webtoon 화풍으로 그려줘" → 결과 위젯(비용·해상도·프롬프트) 표시
- **레퍼런스 등록:** "이 그림 화풍으로 등록할래" → 채팅에 뜬 끌어놓기 위젯에 이미지 드롭 → 이름 정하고 등록 → 그 style로 일관 생성
- **배치:** "이 장면 4컷으로 뽑아줘" → 한 번에 큐 적재 → 완성되면 갤러리로 한 번에 표시
- **관리:** "등록된 화풍 목록 보여줘" / "이 결과 다시 띄워줘"

---

## 비용·운영 메모

- **과금:** OpenAI gpt-image 사용량만큼 **본인 OpenAI 계정**에 과금됩니다(컷당 대략 수 센트, 화질·해상도에 따라). Cloudflare(Worker·R2·DO)는 무료 한도 안에서 사실상 0원.
- **R2:** Cloudflare 대시보드에서 R2를 1회 활성화해야 합니다(버킷 생성 포함).
- **Cloudflare Images(선택):** 앵커 다운스케일에 쓰이며, 미활성이면 원본 전송으로 자동 폴백 — 기능 저하 없음.
- **시크릿 안전:** `OPENAI_API_KEY`·`MCP_AUTH_TOKEN`은 `wrangler secret` 으로만 등록되고 **코드·git에 절대 들어가지 않습니다.** (로컬 개발은 `.dev.vars.example` 참고)
- **갱신:** 코드를 고치면 `npm run deploy` 로 다시 배포(워커는 git push로 자동 반영되지 않습니다).

---

## 개발

```bash
npm run typecheck     # 타입 검사
npm test              # vitest
npm run dev           # 로컬 (.dev.vars 필요 — .dev.vars.example 복사해서 채움)
npm run build:widget  # 위젯(gallery/uploader) 빌드 → src/gallery-html.ts 재생성
```

위젯 원본은 `widget/gallery.js`·`widget/uploader.js` 이고, 수정 후 `npm run build:widget` 으로 인라인 번들을 재생성합니다.
