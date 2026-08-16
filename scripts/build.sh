#!/bin/bash
# Build: copy the zero-dependency host (src/index.js) → lib/, then bundle the
# client with tsdown. No DSH source checkout required.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p lib
cp src/index.js lib/index.js
echo "=== host copied (lib/index.js) ==="

if [ -x node_modules/.bin/tsdown ] || [ -f node_modules/.bin/tsdown.cmd ]; then
  npm run build:client
else
  echo "build: tsdown not installed — run: npm install --legacy-peer-deps" >&2
  exit 1
fi
echo "=== build complete ==="
