#!/usr/bin/env python3
"""用无头 Chrome 渲染扩展真实界面，生成商店截图。

商店要求截图展示真实功能，因此这里不使用手绘样张，而是：
  1. 复制真实的 CSS/JS 到临时目录，并用本地 HTTP 服务提供
     （内容脚本需要 http(s) 页面才能识别站点）；
  2. 注入一个 chrome API 桩件，让真实脚本按真实流程渲染；
  3. 用无头 Chrome 以 1280x800 截图。

用法：
    python3 tools/make_screenshots.py
"""

from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
OUT = os.path.join(ROOT, "store", "screenshots")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def js_string(value):
    return json.dumps(value, ensure_ascii=False)


# 示例密码库：覆盖多账号站点、多子域名与 IP 端口场景
ENTRIES = [
    {
        "id": "e1", "name": "企业协作平台", "url": "https://example.com/",
        "hostname": "example.com", "siteKey": "example.com", "groupKey": "example.com",
        "username": "demo.user@example.com", "password": "Kf7!xQp2vLm9#dTb",
        "passwordHistory": [
            {"password": "Rt4@wNs8zKy1%uHd", "changedAt": "2026-08-14T03:12:00.000Z"},
            {"password": "Pm2&vCx7jLq5^zGn", "changedAt": "2026-05-02T09:41:00.000Z"},
            {"password": "Zw9!kBd4tHs6#rFm", "changedAt": "2026-01-19T14:05:00.000Z"},
        ],
        "createdAt": "2025-11-03T02:00:00.000Z", "updatedAt": "2026-10-28T06:30:00.000Z",
    },
    {
        "id": "e2", "name": "企业管理后台", "url": "https://admin.example.com/login",
        "hostname": "admin.example.com", "siteKey": "admin.example.com", "groupKey": "example.com",
        "username": "admin", "password": "Qv3$nEo8tRu2%yIc",
        "passwordHistory": [],
        "createdAt": "2026-02-11T07:22:00.000Z", "updatedAt": "2026-10-30T11:14:00.000Z",
    },
    {
        "id": "e2b", "name": "企业管理后台", "url": "https://admin.example.com/",
        "hostname": "admin.example.com", "siteKey": "admin.example.com", "groupKey": "example.com",
        "username": "demo.user", "password": "Ln5#rWq9tYc2*vDz",
        "passwordHistory": [],
        "createdAt": "2026-03-02T04:08:00.000Z", "updatedAt": "2026-09-27T13:47:00.000Z",
    },
    {
        "id": "e2c", "name": "企业管理后台", "url": "https://admin.example.com/",
        "hostname": "admin.example.com", "siteKey": "admin.example.com", "groupKey": "example.com",
        "username": "ops-team", "password": "Pg8@hXm4wSb6#kNt",
        "passwordHistory": [],
        "createdAt": "2026-05-19T02:31:00.000Z", "updatedAt": "2026-08-06T16:02:00.000Z",
    },
    {
        "id": "e3", "name": "代码仓库", "url": "https://github.com/",
        "hostname": "github.com", "siteKey": "github.com", "groupKey": "github.com",
        "username": "demo.user", "password": "Hw6*pZa1lCs4&vXb",
        "passwordHistory": [],
        "createdAt": "2025-09-20T01:15:00.000Z", "updatedAt": "2026-09-15T03:52:00.000Z",
    },
    {
        "id": "e4", "name": "内网服务", "url": "http://192.168.1.10:8080/login",
        "hostname": "192.168.1.10:8080", "siteKey": "192.168.1.10:8080", "groupKey": "192.168.1.10",
        "username": "root", "password": "Td9@rMu3qNk7!vLp",
        "passwordHistory": [],
        "createdAt": "2026-04-05T10:00:00.000Z", "updatedAt": "2026-10-22T08:09:00.000Z",
    },
    {
        "id": "e5", "name": "云控制台", "url": "https://console.cloud.example.net/",
        "hostname": "console.cloud.example.net", "siteKey": "console.cloud.example.net",
        "groupKey": "example.net", "username": "ops", "password": "Xc2%mBt8wLd5^gRj",
        "passwordHistory": [], "createdAt": "2026-06-18T05:40:00.000Z", "updatedAt": "2026-10-18T12:33:00.000Z",
    },
]

TRASH = [
    {
        "id": "t1", "name": "旧版论坛", "url": "https://forum.example.org/",
        "hostname": "forum.example.org", "siteKey": "forum.example.org", "groupKey": "example.org",
        "username": "demo.user", "password": "Pd5!xKt2mVz9#bNc", "passwordHistory": [],
        "createdAt": "2025-08-02T02:00:00.000Z", "updatedAt": "2026-07-11T09:00:00.000Z",
        "deletedAt": "2026-10-05T09:20:00.000Z",
    }
]

SITE_SETTINGS = {"example.com": {"defaultEntryId": "e1"}}

SETTINGS = {
    "autoLockMinutes": 15,
    "generator": {"length": 20, "uppercase": True, "lowercase": True, "numbers": True, "symbols": True},
}


def build_stub(forced_site: str | None = None) -> str:
    """chrome API 桩件：按真实消息协议返回数据。

    forced_site 用于内容脚本截图：页面地址是本地服务器，
    需要显式指定站点才能返回对应账号。
    """
    entries = js_string(ENTRIES)
    trash = js_string(TRASH)
    site_settings = js_string(SITE_SETTINGS)
    settings = js_string(SETTINGS)
    forced = js_string(forced_site)

    return f"""
<script>
(function () {{
  const ENTRIES = {entries};
  const TRASH = {trash};
  const SITE_SETTINGS = {site_settings};
  const SETTINGS = {settings};
  const FORCED_SITE = {forced};

  function ok(data) {{ return Promise.resolve({{ ok: true, data: data }}); }}

  function siteFor(url) {{
    if (FORCED_SITE) return FORCED_SITE;
    if (url.indexOf("admin.example.com") >= 0) return "admin.example.com";
    if (url.indexOf("github.com") >= 0) return "github.com";
    if (url.indexOf("example.com") >= 0) return "example.com";
    return "";
  }}

  const handlers = {{
    STATUS: function () {{ return {{ initialized: true, unlocked: true, damaged: false }}; }},
    LIST_ENTRIES: function () {{
      return {{ entries: ENTRIES, trash: TRASH, siteSettings: SITE_SETTINGS, settings: SETTINGS }};
    }},
    CURRENT_ENTRIES: function (message) {{
      const siteKey = siteFor(message.url || "");
      const matched = ENTRIES.filter((e) => e.siteKey === siteKey)
        .map((e) => {{ const copy = Object.assign({{}}, e); delete copy.passwordHistory; return copy; }});
      const setting = SITE_SETTINGS[siteKey] || {{}};
      return {{
        siteKey: siteKey,
        hostname: siteKey,
        fillMode: setting.fillMode || "auto",
        defaultEntryId: setting.defaultEntryId || "",
        generatorSettings: SETTINGS.generator,
        entries: matched
      }};
    }},
    GET_STEP_USERNAME: function () {{ return {{ username: "" }}; }},
    GET_PENDING_CREDENTIAL: function () {{ return {{ action: "none", pending: null }}; }},
    CAPTURE_CREDENTIAL: function (message) {{
      const siteKey = siteFor((message.credential && message.credential.url) || "");
      const matched = ENTRIES.filter((e) => e.siteKey === siteKey)[0] || {{}};
      return {{
        action: "save",
        pending: {{
          id: "pending-1",
          siteKey: siteKey || "admin.example.com",
          name: "企业管理后台",
          username: (message.credential && message.credential.username) || "admin",
          password: (message.credential && message.credential.password) || "",
          capturedAt: Date.now()
        }}
      }};
    }}
  }};

  window.chrome = {{
    runtime: {{
      sendMessage: function (message) {{
        const handler = handlers[message && message.type];
        if (!handler) return Promise.resolve({{ ok: false, error: "unsupported" }});
        return ok(handler(message || {{}}));
      }},
      onMessage: {{ addListener: function () {{}} }},
      openOptionsPage: function () {{}},
      getURL: function (path) {{ return path; }}
    }},
    tabs: {{
      query: function () {{
        return Promise.resolve([{{
          id: 1,
          url: "https://admin.example.com/login",
          title: "企业管理后台 - 登录"
        }}]);
      }},
      sendMessage: function () {{ return Promise.resolve({{ ok: true, data: {{}} }}); }}
    }},
    storage: {{
      local: {{ get: function () {{ return Promise.resolve({{}}); }}, set: function () {{}} }},
      session: {{ get: function () {{ return Promise.resolve({{}}); }}, set: function () {{}} }}
    }}
  }};
}})();
</script>
"""


def build_manager_harness(stub: str, open_dialog: bool) -> str:
    html = open(os.path.join(SRC, "manager.html"), encoding="utf-8").read()
    html = html.replace(
        '<script src="shared/password.js"></script>',
        stub + '\n  <script src="shared/password.js"></script>',
    )
    if open_dialog:
        html = html.replace('</body>', """
<script>
window.addEventListener("load", function () {
  setTimeout(function () {
    try { openDialog(entries[0]); } catch (error) { /* 忽略 */ }
  }, 700);
});
</script>
</body>""")
    return html


def build_popup_harness(stub: str) -> str:
    """把真实弹窗内容放进浏览器窗口框，放大到 1280x800 画布。"""
    popup_html = open(os.path.join(SRC, "popup.html"), encoding="utf-8").read()
    body = re.search(r"<body>(.*)</body>", popup_html, re.S).group(1)
    body = body.replace('<script src="shared/password.js"></script>', "")
    body = body.replace('<script src="popup.js"></script>', "")

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>本地密码匣</title>
<link rel="stylesheet" href="popup.css">
<style>
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    width: 1280px;
    height: 800px;
    font-family: Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(circle at 18% 0%, #e5f2e7 0, transparent 38%), #f4f5f1;
    display: flex;
    align-items: center;
    justify-content: center;
  }}
  .stage {{ display: flex; align-items: center; gap: 56px; }}
  .caption {{ width: 380px; }}
  .caption h1 {{ margin: 0 0 12px; font-size: 34px; line-height: 1.25; color: #19221c; }}
  .caption p {{ margin: 0; font-size: 16px; line-height: 1.7; color: #5d6b62; }}
  .caption ul {{ margin: 18px 0 0; padding-left: 20px; color: #47554b; font-size: 15px; line-height: 1.9; }}
  .window {{
    width: 470px;
    border-radius: 16px;
    overflow: hidden;
    background: #fff;
    box-shadow: 0 26px 70px rgba(31, 62, 41, .22), 0 2px 0 rgba(31, 62, 41, .06);
  }}
  .chrome-bar {{
    display: flex;
    align-items: center;
    gap: 9px;
    height: 42px;
    padding: 0 14px;
    background: #eef1ed;
    border-bottom: 1px solid #dde3dd;
  }}
  .dot {{ width: 11px; height: 11px; border-radius: 50%; }}
  .dot.r {{ background: #f0766a; }} .dot.y {{ background: #f2c14e; }} .dot.g {{ background: #6cc07a; }}
  .address {{
    flex: 1;
    height: 24px;
    border-radius: 12px;
    background: #fff;
    border: 1px solid #e2e7e2;
    display: flex;
    align-items: center;
    padding: 0 11px;
    font-size: 11px;
    color: #6f7c73;
    gap: 6px;
  }}
  .popup-holder {{ width: 380px; background: linear-gradient(155deg, #eff8f1 0%, #f7f5ef 65%); }}
</style>
</head>
<body>
  <div class="stage">
    <div class="caption">
      <h1>在当前网站直接<br>填入账号密码</h1>
      <p>弹窗只显示当前站点的账号，支持填充、复制与设为默认。</p>
      <ul>
        <li>单账号站点自动填充</li>
        <li>多账号可下拉切换</li>
        <li>密码始终加密存放</li>
      </ul>
    </div>
    <div class="window">
      <div class="chrome-bar">
        <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <div class="address">admin.example.com/login</div>
      </div>
      <div class="popup-holder">
        {body}
      </div>
    </div>
  </div>
  {stub}
  <script src="shared/password.js"></script>
  <script src="popup.js"></script>
</body>
</html>
"""


def build_content_harness(stub: str, action: str) -> str:
    """真实内容脚本 + 模拟登录页。"""
    if action == "menu":
        trigger = """
<script>
window.addEventListener("load", function () {
  setTimeout(function () {
    const button = document.getElementById("lpv-field-button");
    if (button) button.click();
  }, 1200);
});
</script>"""
    else:
        trigger = """
<script>
window.addEventListener("load", function () {
  setTimeout(function () {
    const form = document.querySelector("form");
    if (form) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }, 1200);
});
</script>"""

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>登录 - 企业管理后台</title>
<link rel="stylesheet" href="content.css">
<style>
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    min-height: 100vh;
    font-family: Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1b2520;
    background: radial-gradient(circle at 20% 0%, #e8f2ea 0, transparent 42%), #f5f6f2;
    display: flex;
    align-items: center;
    justify-content: center;
  }}
  .card {{
    width: 380px;
    padding: 34px 32px;
    border-radius: 16px;
    background: #fff;
    border: 1px solid #e0e7e1;
    box-shadow: 0 16px 44px rgba(31, 62, 41, .09);
  }}
  .card h1 {{ margin: 0 0 6px; font-size: 21px; }}
  .card p.sub {{ margin: 0 0 24px; font-size: 13px; color: #77837a; }}
  label {{ display: grid; gap: 6px; margin-bottom: 16px; font-size: 12px; font-weight: 650; color: #47554b; }}
  input {{
    padding: 11px 12px;
    border: 1px solid #cbd7cd;
    border-radius: 9px;
    font-size: 14px;
    background: #fff;
    color: #18211b;
  }}
  input:focus {{ outline: none; border-color: #34805a; box-shadow: 0 0 0 3px rgba(52,128,90,.13); }}
  button.submit {{
    width: 100%;
    margin-top: 6px;
    padding: 11px;
    border: 0;
    border-radius: 9px;
    background: #286b49;
    color: #fff;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
  }}
  .foot {{ margin-top: 20px; font-size: 12px; color: #93a096; text-align: center; }}
</style>
</head>
<body>
  <div class="card">
    <h1>企业管理后台</h1>
    <p class="sub">请使用工号账号登录</p>
    <form action="/login" method="post" onsubmit="return false;">
      <label>用户名
        <input id="username" name="username" type="text" autocomplete="username" placeholder="请输入用户名">
      </label>
      <label>密码
        <input id="password" name="password" type="password" autocomplete="current-password" placeholder="请输入密码">
      </label>
      <button class="submit" type="submit">登录</button>
    </form>
    <p class="foot">© 2026 企业协作平台</p>
  </div>
  {stub}
  <script src="content.js"></script>
  {trigger}
</body>
</html>
"""


def copy_assets(target: str) -> None:
    os.makedirs(os.path.join(target, "shared"), exist_ok=True)
    for name in ("popup.css", "manager.css", "content.css", "popup.js", "manager.js", "content.js"):
        shutil.copy(os.path.join(SRC, name), os.path.join(target, name))
    shutil.copy(os.path.join(SRC, "shared", "password.js"), os.path.join(target, "shared", "password.js"))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102 - 静默
        pass


def serve(directory: str):
    handler = lambda *a, **k: QuietHandler(*a, directory=directory, **k)  # noqa: E731
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def shoot(chrome: str, url: str, output: str, width: int = 1280, height: int = 800) -> None:
    os.makedirs(os.path.dirname(output), exist_ok=True)
    command = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--virtual-time-budget=8000",
        f"--window-size={width},{height}",
        f"--screenshot={output}",
        url,
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if not os.path.exists(output):
        raise RuntimeError(f"截图失败 {url}\n{result.stdout}\n{result.stderr}")


def main() -> None:
    if not os.path.exists(CHROME):
        raise SystemExit(f"找不到 Chrome：{CHROME}")

    workspace = tempfile.mkdtemp(prefix="lpv-shots-")
    try:
        copy_assets(workspace)

        jobs = [
            ("manager-list.html", build_manager_harness(build_stub(), False), "01-manager-list.png"),
            ("manager-dialog.html", build_manager_harness(build_stub(), True), "02-password-history.png"),
            ("popup.html", build_popup_harness(build_stub()), "03-popup.png"),
            ("content-menu.html", build_content_harness(build_stub("admin.example.com"), "menu"), "04-autofill.png"),
            ("content-save.html", build_content_harness(build_stub("admin.example.com"), "save"), "05-save-prompt.png"),
        ]

        for filename, content, _ in jobs:
            with open(os.path.join(workspace, filename), "w", encoding="utf-8") as handle:
                handle.write(content)

        httpd, port = serve(workspace)
        try:
            for filename, _, output_name in jobs:
                print(f"渲染 {output_name} …")
                shoot(CHROME, f"http://127.0.0.1:{port}/{filename}", os.path.join(OUT, output_name))
                print(f"  → store/screenshots/{output_name}")
        finally:
            httpd.shutdown()
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


if __name__ == "__main__":
    main()
