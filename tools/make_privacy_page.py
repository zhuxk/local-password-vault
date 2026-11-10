#!/usr/bin/env python3
"""把 store/PRIVACY.md 转成可托管的静态 HTML 页面。

商店要求隐私政策是一个可直接访问的公开 URL（不能需要登录）。
用 GitHub Pages / Cloudflare Pages / Netlify 托管本文件即可。

用法：
    python3 tools/make_privacy_page.py
"""

from __future__ import annotations

import html
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "store", "PRIVACY.md")
TARGET = os.path.join(ROOT, "store", "privacy.html")
# GitHub Pages 的发布目录：Pages 的 source.path 只接受 / 或 /docs，
# 所以固定放在仓库根的 docs/ 下，index.html 即站点根入口。
SITE_DIR = os.path.join(ROOT, "docs")
SITE_TARGET = os.path.join(SITE_DIR, "index.html")


def inline_markdown(text: str) -> str:
    """把受限的 Markdown 转成 HTML（本文件只用到标题、表格、列表、强调、行内代码）。"""
    lines = text.split("\n")
    out = []
    in_table = False
    in_list = False

    def close_list():
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    def close_table():
        nonlocal in_table
        if in_table:
            out.append("</tbody></table>")
            in_table = False

    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()

        if not stripped:
            close_list()
            close_table()
            out.append("")
            continue

        # 表格
        if stripped.startswith("|"):
            close_list()
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", cell) for cell in cells):
                continue
            if not in_table:
                out.append("<table><thead><tr>")
                out.append(
                    "".join(f"<th>{inline_text(cell)}</th>" for cell in cells)
                )
                out.append("</tr></thead><tbody>")
                in_table = True
                continue
            out.append(
                "<tr>" + "".join(f"<td>{inline_text(cell)}</td>" for cell in cells) + "</tr>"
            )
            continue

        close_table()

        # 标题
        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            close_list()
            level = len(heading.group(1))
            out.append(f"<h{level}>{inline_text(heading.group(2))}</h{level}>")
            continue

        # 水平线
        if re.fullmatch(r"-{3,}", stripped):
            close_list()
            out.append("<hr>")
            continue

        # 列表
        bullet = re.match(r"^[-*]\s+(.*)$", stripped)
        if bullet:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inline_text(bullet.group(1))}</li>")
            continue

        close_list()
        out.append(f"<p>{inline_text(stripped)}</p>")

    close_list()
    close_table()
    return "\n".join(out)


def inline_text(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    return text


PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>隐私政策 — 本地密码匣</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    padding: 40px 24px 72px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
    font-size: 16px;
    line-height: 1.8;
    color: #1b2520;
    background: radial-gradient(circle at 15% 0%, #e9f3ea 0, transparent 38%), #f6f7f3;
  }}
  main {{
    max-width: 760px;
    margin: 0 auto;
    padding: 40px 44px;
    border: 1px solid #dfe6e0;
    border-radius: 18px;
    background: #fff;
    box-shadow: 0 18px 48px rgba(31, 62, 41, .08);
  }}
  h1 {{ margin: 0 0 8px; font-size: 30px; line-height: 1.3; }}
  h2 {{ margin: 34px 0 10px; padding-bottom: 8px; font-size: 20px; border-bottom: 1px solid #e6ece7; }}
  h3 {{ margin: 24px 0 8px; font-size: 17px; }}
  p {{ margin: 12px 0; }}
  ul {{ margin: 12px 0; padding-left: 24px; }}
  li {{ margin: 6px 0; }}
  code {{
    padding: 2px 5px;
    border-radius: 5px;
    background: #eef4ef;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
  }}
  table {{ width: 100%; margin: 16px 0; border-collapse: collapse; font-size: 14px; }}
  th, td {{ padding: 10px 12px; border: 1px solid #dfe6e0; text-align: left; vertical-align: top; }}
  th {{ background: #f0f6f1; font-weight: 700; }}
  hr {{ margin: 32px 0; border: 0; border-top: 1px solid #e6ece7; }}
  footer {{ margin-top: 36px; font-size: 13px; color: #6f7c73; }}
  @media (max-width: 640px) {{
    body {{ padding: 18px 12px 40px; }}
    main {{ padding: 26px 20px; }}
  }}
</style>
</head>
<body>
<main>
{content}
<footer>本地密码匣 · 数据仅保存在你的浏览器中</footer>
</main>
</body>
</html>
"""


def main() -> None:
    with open(SOURCE, encoding="utf-8") as handle:
        markdown = handle.read()

    body = inline_markdown(markdown)
    # 移除审核备注附录（面向审核员，不随公开页面发布）
    body = body.split("<h2>附：审核备注")[0].rstrip()

    with open(TARGET, "w", encoding="utf-8") as handle:
        handle.write(PAGE.format(content=body))

    # 同步产出可部署站点目录（index.html 在根目录）
    os.makedirs(SITE_DIR, exist_ok=True)
    with open(SITE_TARGET, "w", encoding="utf-8") as handle:
        handle.write(PAGE.format(content=body))

    print(f"已生成 {os.path.relpath(TARGET, ROOT)}  ({os.path.getsize(TARGET)} 字节)")
    print(f"已生成 {os.path.relpath(SITE_TARGET, ROOT)}  (GitHub Pages 发布目录)")
    print("托管方式：GitHub Pages 选 source.path=/docs；或直接把 store/privacy.html 拖到任意静态托管")


if __name__ == "__main__":
    main()
