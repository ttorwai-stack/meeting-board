#!/usr/bin/env bash
# 브라우저 통합 테스트: 실제 Code.gs 로직을 메모리 시트로 흉내낸 로컬 서버 + index.html 사본(API_URL만 로컬로 교체)
# 필요: node, python3 + playwright(chromium)   예) pip install playwright && playwright install chromium
set -e
cd "$(dirname "$0")/.."
SITE=$(mktemp -d)
sed "s#^const API_URL = .*#const API_URL = 'http://localhost:8790/exec';#" index.html > "$SITE/index.html"
node tests/e2e/mock-server.js & NODE_PID=$!
(cd "$SITE" && python3 -m http.server 8791 >/dev/null 2>&1) & HTTP_PID=$!
trap 'kill $NODE_PID $HTTP_PID 2>/dev/null; rm -rf "$SITE"' EXIT
sleep 1.5
python3 tests/e2e/e2e.py
