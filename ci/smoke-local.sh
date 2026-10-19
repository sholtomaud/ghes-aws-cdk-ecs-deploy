#!/usr/bin/env bash
# Local smoke test of the three application images, wired the way the ECS task wires them: one shared
# network namespace (like awsvpc), startup gated on health in the order agent -> api -> frontend.
# The agent runs with LLM_PROVIDER=fake, so no AWS credentials or Bedrock access are used.
# Requires images from `ci/build-product-images.sh build`.
set -euo pipefail
# shellcheck source=ci/lib.sh
source "$(dirname "$0")/lib.sh"
cd "$(dirname "$0")/.." || exit 1
require_cmd docker
require_cmd curl

version="$(product_version)"
prefix="${LOCAL_PREFIX:-private-ai-assistant}"
port="${SMOKE_PORT:-18080}"
run="smoke-$$"
cleanup() { docker rm -f "$run-frontend" "$run-api" "$run-agent" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { log "FAIL: $*"; for c in agent api frontend; do log "--- $c logs"; docker logs "$run-$c" 2>&1 | tail -20 >&2 || true; done; exit 1; }
wait_healthy() { # container command...
  local name="$1"; shift
  for _ in $(seq 1 60); do docker exec "$name" "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  fail "$name did not become healthy"
}

log "starting task namespace (agent owns it; frontend port published as $port)"
docker run -d --name "$run-agent" -p "127.0.0.1:$port:8080" \
  -e LLM_PROVIDER=fake -e FAKE_RESPONSES='Hello from the local agent|OK' "$prefix/agent:$version" >/dev/null
wait_healthy "$run-agent" python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"

docker run -d --name "$run-api" --network "container:$run-agent" \
  -e FLASK_SECRET_KEY="local-smoke-$(date +%s)-not-a-real-secret" -e AGENT_URL=http://127.0.0.1:8000 \
  -e APP_HOSTNAME=assistant.corp.example.com -e COGNITO_DOMAIN=example.auth.us-east-1.amazoncognito.com \
  -e COGNITO_CLIENT_ID=localclient -e SMOKE_TEST_ENABLED=true "$prefix/api:$version" >/dev/null
wait_healthy "$run-api" python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/api/healthz', timeout=3)"

docker run -d --name "$run-frontend" --network "container:$run-agent" "$prefix/frontend:$version" >/dev/null
wait_healthy "$run-frontend" wget -q -O /dev/null http://127.0.0.1:8080/healthz

base="http://127.0.0.1:$port"
check() { log "ok: $*"; }

[[ "$(curl -fsS "$base/healthz")" == "ok" ]] || fail "/healthz"; check "frontend /healthz"
curl -fsS "$base/" | grep -q '<div id="root">' || fail "index.html"; check "SPA served"
curl -fsSI "$base/" | grep -qi '^x-frame-options: DENY' || fail "security headers"; check "security headers"
[[ "$(curl -fsS "$base/api/healthz")" == *'"ok"'* ]] || fail "/api/healthz via proxy"; check "/api proxied to Flask"
reply="$(curl -fsS -X POST -H 'Content-Type: application/json' -d '{"message":"hello"}' "$base/api/chat")"
[[ "$reply" == *'Hello from the local agent'* ]] || fail "chat round trip: $reply"; check "chat: frontend -> api -> agent (LangChain) -> reply"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"message":""}' "$base/api/chat")" == 400 ]] || fail "validation"; check "input validation"
[[ "$(curl -fsS "$base/api/selftest")" == *'"bedrock":"ok"'* ]] || fail "selftest"; check "self-test path"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/selftest")" == 429 ]] || fail "selftest rate limit"; check "self-test rate limited"
loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$base/api/logout")"
[[ "$loc" == https://example.auth.us-east-1.amazoncognito.com/logout\?* ]] || fail "logout redirect: $loc"; check "logout redirects to Cognito"

# The API and agent listen on loopback only: unreachable from outside the task namespace.
ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$run-agent")"
if [[ -n "$ip" ]]; then
  docker run --rm --network bridge "$prefix/api:$version" python -c "
import socket,sys
for p in (5000, 8000):
    s=socket.socket(); s.settimeout(2)
    if s.connect_ex(('$ip', p)) == 0: sys.exit(f'port {p} reachable from outside the task')
" || fail "api/agent reachable outside the task"
  check "api (5000) and agent (8000) not reachable from outside the task"
fi
for c in agent api frontend; do
  [[ "$(docker exec "$run-$c" id -u)" != 0 ]] || fail "$c runs as root"
done; check "all containers run as non-root"
docker logs "$run-api" 2>&1 | grep -q '"event": "request"' || fail "structured api logs"
! docker logs "$run-agent" 2>&1 | grep -q 'hello"' || fail "agent logged prompt content"
check "structured logs without prompt content"
log "local smoke test passed"
