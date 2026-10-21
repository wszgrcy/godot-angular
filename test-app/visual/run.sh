#!/usr/bin/env bash
# 像素级验证：构建 visual 入口 → 打开真实窗口运行 → 截图并统计颜色 → 输出报告
#
# 用法：
#   ./visual/run.sh              # 构建并运行
#   ./visual/run.sh --no-build   # 仅运行（使用已有的 dist-visual）
#
# 产物位于 visual-out/：report.txt（最后一行为 result=PASS/FAIL）与五张截图。
# 退出码：0 表示全部断言通过，非 0 表示存在断言失败或运行异常。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

GODOT="${GODOT:-../bin/linux-editor-4.6.1-v8/godot.linuxbsd.editor.x86_64}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-$(id -un)}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export DISPLAY="${DISPLAY:-:1}"

if [ ! -x "$GODOT" ]; then
  echo "找不到引擎二进制：$GODOT（用 GODOT=... 覆盖）" >&2
  exit 2
fi

if [ "${1:-}" != "--no-build" ]; then
  echo "== build"
  ../node_modules/.bin/ng run test-app:visual || { echo "构建失败" >&2; exit 1; }
fi

# 新增或修改产物后引擎可能仍使用旧的脚本缓存，显式执行一次导入
"$GODOT" --headless --path . --import >/tmp/visual-import.log 2>&1
echo "== import exit=$?"

rm -rf visual-out
echo "== run (display=$DISPLAY)"
timeout -k 5 180 "$GODOT" --path . res://visual/visual.tscn \
  --rendering-driver vulkan --audio-driver Dummy \
  --resolution 1280x720 --quit-after 1200
code=$?
echo "== engine exit=$code"

if [ -f visual-out/report.txt ]; then
  echo "== report"
  cat visual-out/report.txt
else
  echo "没有生成 report.txt" >&2
fi
exit $code
