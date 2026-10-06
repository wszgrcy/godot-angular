#!/usr/bin/env bash
# 一键：编译 core → 打包 demo → 用 GodotJS 引擎跑
# 用法： tools/rebuild.sh [--prod]
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="--mode development"
[[ "${1:-}" == "--prod" ]] && MODE=""

( cd packages/core && corepack pnpm build )
( cd demo && corepack pnpm exec vite build $MODE )
node tools/run-demo.mjs
