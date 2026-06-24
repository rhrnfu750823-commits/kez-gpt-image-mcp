#!/usr/bin/env bash
# kez-gpt-image-mcp 원터치 설치 — 로그인·버킷·시크릿·배포를 차례로 처리하고
# 끝에 claude.ai 커넥터에 넣을 URL·토큰을 정리해 보여준다.
# 시크릿(OpenAI 키·인증 토큰)은 wrangler secret 로만 등록되고 파일/깃에 남지 않는다.
set -euo pipefail

echo "▶ kez-gpt-image-mcp 설치 시작"

# 1) Node 22+ 점검
command -v node >/dev/null || { echo "❌ Node.js가 없습니다. 22+ 설치 후 다시 실행하세요."; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || { echo "❌ Node.js 22+ 필요 (현재 $(node -v)). 업그레이드 후 다시."; exit 1; }

# 2) 의존성 설치
echo "▶ 의존성 설치…"
npm install

# 3) Cloudflare 로그인 (이미 됐으면 통과)
echo "▶ Cloudflare 로그인 확인…"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login
echo "  로그인 계정:"; npx wrangler whoami 2>/dev/null | grep -i "account" || true

# 4) R2 버킷 생성 (이미 있으면 통과)
BUCKET=$(grep -E '^bucket_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
echo "▶ R2 버킷 '$BUCKET' 준비(이미 있으면 통과)…"
npx wrangler r2 bucket create "$BUCKET" 2>/dev/null || echo "  (이미 존재하거나 R2 비활성 — 대시보드에서 R2 활성화가 필요할 수 있음)"

# 5) OpenAI 키 → 시크릿
echo
read -r -s -p "OpenAI API 키를 붙여넣고 Enter (화면에 안 보입니다): " OPENAI_KEY; echo
[ -n "$OPENAI_KEY" ] || { echo "❌ 키가 비었습니다."; exit 1; }
printf '%s' "$OPENAI_KEY" | npx wrangler secret put OPENAI_API_KEY
unset OPENAI_KEY

# 6) 인증 토큰 생성 → 시크릿
AUTH_TOKEN=$(openssl rand -hex 32)
printf '%s' "$AUTH_TOKEN" | npx wrangler secret put MCP_AUTH_TOKEN

# 7) 위젯 빌드 + 배포
echo "▶ 위젯 빌드 + 배포…"
npm run build:widget
DEPLOY_OUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUT"
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

cat <<EOF

──────────────────────────────────────────────
✅ 배포 완료! 이제 claude.ai에 커넥터를 등록하세요.

  claude.ai → Settings → Connectors → Add custom connector
    • URL            : ${WORKER_URL:-<위 배포 출력의 ...workers.dev URL>}
    • Authentication : Bearer
    • Bearer Token   : $AUTH_TOKEN

  ⚠ 이 Bearer 토큰을 비밀번호 관리자에 지금 저장하세요.
    (보안상 wrangler는 시크릿 값을 다시 보여주지 않습니다 — 이 출력만 유효)
──────────────────────────────────────────────
EOF
