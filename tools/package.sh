#!/usr/bin/env bash
# 打包可直接上传到 Chrome Web Store / Microsoft Edge Add-ons 的扩展 zip。
#
# 用法：
#   bash tools/package.sh            # 生成 dist/local-password-vault-<version>.zip
#   bash tools/package.sh --edge     # 同时生成 Edge 版本（去掉 Chrome 专属字段）
#
# 商店要求：
#   - manifest.json 必须位于 zip 根目录（不能把整个文件夹压进去）
#   - 不能包含 .git、node_modules、__MACOSX 等无关文件
#   - 每次上传新包必须提高 manifest.json 里的 version

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/manifest.json'))['version'])")"
SLUG="local-password-vault"

# 扩展运行时真正需要的文件
INCLUDE=(
  "manifest.json"
  "icons/icon16.png"
  "icons/icon48.png"
  "icons/icon128.png"
  "src/background.js"
  "src/content.js"
  "src/content.css"
  "src/popup.html"
  "src/popup.js"
  "src/popup.css"
  "src/manager.html"
  "src/manager.js"
  "src/manager.css"
  "src/shared/crypto.js"
  "src/shared/domain.js"
  "src/shared/csv.js"
  "src/shared/password.js"
  "src/vendor/psl.js"
  "src/vendor/PSL-LICENSE"
)

STAGE="$DIST/stage"
CHROME_ZIP="$DIST/${SLUG}-${VERSION}-chrome.zip"
EDGE_ZIP="$DIST/${SLUG}-${VERSION}-edge.zip"

echo "==> 清理并准备打包目录"
rm -rf "$STAGE" "$CHROME_ZIP" "$EDGE_ZIP"
mkdir -p "$STAGE"

echo "==> 复制扩展文件"
for item in "${INCLUDE[@]}"; do
  if [[ ! -e "$ROOT/$item" ]]; then
    echo "缺少文件：$item" >&2
    exit 1
  fi
  mkdir -p "$STAGE/$(dirname "$item")"
  cp "$ROOT/$item" "$STAGE/$item"
done

echo "==> 生成 Chrome Web Store 包"
( cd "$STAGE" && zip -q -r -X "$CHROME_ZIP" . -x '.*' '*/.*' '__MACOSX/*' )

if [[ "${1:-}" == "--edge" ]]; then
  echo "==> 生成 Edge Add-ons 包（移除 Chrome 专属字段）"
  python3 - "$STAGE/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    manifest = json.load(handle)
# Edge 不使用 Chrome 的自动更新地址
manifest.pop("update_url", None)
# 注意：manifest 的 description 在 Chrome 侧上限 132 字符，
# 而 Edge 商店列表页的 Description 字段（250~10000 字符）
# 是在 Partner Center 后台单独填写的，不在 manifest 里。
# 因此这里保持 manifest description 原样，不要为 Edge 加长。
description = manifest.get("description", "")
assert len(description) <= 132, f"manifest description 超过 Chrome 的 132 字符上限：{len(description)}"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
  ( cd "$STAGE" && zip -q -r -X "$EDGE_ZIP" . -x '.*' '*/.*' '__MACOSX/*' )
fi

rm -rf "$STAGE"

echo ""
echo "打包完成："
for zipfile in "$CHROME_ZIP" "$EDGE_ZIP"; do
  [[ -f "$zipfile" ]] || continue
  size="$(du -h "$zipfile" | cut -f1)"
  echo "  $zipfile  ($size)"
done
echo ""
echo "下一步："
echo "  Chrome Web Store  → https://chrome.google.com/webstore/devconsole  （新建商品 → 上传 zip）"
echo "  Edge Add-ons      → https://partnercenter.microsoft.com  （创建新扩展 → 上传 zip）"
