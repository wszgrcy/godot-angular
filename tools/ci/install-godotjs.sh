#!/usr/bin/env bash
# 下载 GodotJS 引擎并放到 bin/<平台>-<运行时>/ 下，路径要和 packages/builder/shared/godot-bin.ts
# 的 BIN_TABLE 对上。CI 与本地共用这一份实现，版本号不在别处重复。
#
# 版本号由环境变量给出（CI 在 workflow 的 env 里集中设置，本地临时指定即可）：
#   GODOTJS_REPO     发布仓库，上游 godotjs/GodotJS 或 fork wszgrcy/GodotJS，资产名规则一致
#   GODOTJS_TAG      release 标签，例如 1.3.2
#   GODOT_VERSION    资产名里的 Godot 版本，例如 4.7.2
#   GODOT_RUNTIME    运行时：v8 / qjs-ng
#
# 用法：
#   tools/ci/install-godotjs.sh [linux|windows]     # 不给参数按当前系统推断
#   GODOTJS_ZIP=/path/to.zip tools/ci/install-godotjs.sh linux   # 用本地包，跳过下载（调试用）
set -euo pipefail

platform="${1-}"
if [ -z "$platform" ]; then
  case "$(uname -s)" in
    Linux) platform=linux ;;
    MINGW* | MSYS* | CYGWIN*) platform=windows ;;
    *)
      echo "[godotjs] 无法从 $(uname -s) 推断平台，请显式传 linux 或 windows" >&2
      exit 1
      ;;
  esac
fi

case "$platform" in
  linux) exe="godot.linuxbsd.editor.x86_64" ;;
  windows) exe="godot.windows.editor.x86_64.exe" ;;
  *)
    echo "[godotjs] 未知平台：$platform（支持 linux / windows）" >&2
    exit 1
    ;;
esac

missing=()
for name in GODOTJS_REPO GODOTJS_TAG GODOT_VERSION GODOT_RUNTIME; do
  [ -n "${!name-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "[godotjs] 缺少环境变量：${missing[*]}（见脚本开头说明）" >&2
  exit 1
fi

asset="${platform}-editor-${GODOT_VERSION}-${GODOT_RUNTIME}.zip"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin_dir="$repo_root/bin/${platform}-${GODOT_RUNTIME}"

if [ -n "${GODOTJS_ZIP-}" ]; then
  echo "[godotjs] 用本地包 $GODOTJS_ZIP"
  zip="$GODOTJS_ZIP"
else
  zip="$(mktemp)"
  trap 'rm -f "$zip"' EXIT
  url="https://github.com/${GODOTJS_REPO}/releases/download/${GODOTJS_TAG}/${asset}"
  echo "[godotjs] 下载 $url"
  curl -fsSL --retry 3 -o "$zip" "$url"
fi

# release 的 zip 里只有一个可执行文件（不带目录），解到 bin/<平台>-<运行时>/ 下才和 BIN_TABLE 一致
mkdir -p "$bin_dir"
unzip -q -o "$zip" -d "$bin_dir"
chmod +x "$bin_dir/$exe"

# 拉错包（标签与资产对不上）在这里就挡住，别等测试跑到一半才发现引擎不对
version="$("$bin_dir/$exe" --headless --version | head -n1)"
case "$version" in
  "$GODOT_VERSION."*) echo "[godotjs] $version -> ${bin_dir#"$repo_root"/}/$exe" ;;
  *)
    echo "[godotjs] 引擎版本 $version 与 GODOT_VERSION=$GODOT_VERSION 不符" >&2
    exit 1
    ;;
esac
