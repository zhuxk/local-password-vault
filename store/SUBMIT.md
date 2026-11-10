# 上架指南

本项目是一个 Manifest V3 浏览器扩展，代码零依赖、无构建步骤，源码即发布物。
本目录包含上架所需的全部素材与文案。

## 一、快速开始

```bash
# 1. 生成图标与商店素材（已生成过可跳过）
python3 tools/make_icons.py
python3 tools/make_promo.py
python3 tools/make_privacy_page.py

# 2. 渲染商店截图（需要本机安装 Chrome）
python3 tools/make_screenshots.py

# 3. 打包
bash tools/package.sh --edge
```

产物：

```
dist/local-password-vault-0.4.0-chrome.zip   上传 Chrome Web Store
dist/local-password-vault-0.4.0-edge.zip     上传 Microsoft Edge Add-ons
```

## 二、目录结构

```
manifest.json            扩展清单（图标、权限、最低 Chrome 版本）
icons/                   扩展图标（16 / 48 / 128）
src/                     扩展源码
docs/
  index.html             隐私政策网页（GitHub Pages 发布目录，与 store/privacy.html 同源生成）
store/
  PRIVACY.md             隐私政策（Markdown 源文件）
  privacy.html           隐私政策（独立单文件网页，可拖到任意静态托管）
  LISTING.md             两个商店的文案与填写清单  ← 先读这个
  icon-128.png           Chrome 商店列表图
  edge-logo-300.png      Edge 商店 Logo
  promo-tile-440x280.png Chrome 小宣传图块
  marquee-1400x560.png   Chrome 滚动宣传图
  screenshots/           5 张 1280×800 真实界面截图
tools/                   素材生成与打包脚本（不包含在发布包内）
```

## 三、发布前必须自己做的三件事

### 1. 托管隐私政策页面 ✅ 已完成

**隐私政策地址（直接复制到商店后台）：**

```
https://zhuxk.github.io/local-password-vault/
```

已通过 GitHub Pages 上线：仓库 [`zhuxk/local-password-vault`](https://github.com/zhuxk/local-password-vault) 的 `docs/` 目录即站点根，源文件由 `store/PRIVACY.md` 经 `tools/make_privacy_page.py` 生成。未登录可直接访问并返回 200。

页面样式全部内联（无外部 CSS/字体请求），任意静态托管都能直接显示。

**以后要改隐私政策时：**

1. 改 `store/PRIVACY.md`
2. `python3 tools/make_privacy_page.py`（同时更新 `store/privacy.html` 和 `docs/index.html`）
3. `git push` → GitHub Pages 自动重新构建，约 1–2 分钟生效

**换用其他托管（可选）：** `store/privacy.html` 是完全独立的单文件，直接拖到 Cloudflare Pages / Netlify Drop 即可，无需构建。

<details>
<summary>手动配置 GitHub Pages 的步骤（备用）</summary>

1. 新建一个仓库（Public 或 Private 都可以，Private 需要 GitHub Pro 才能开 Pages）
2. 建一个 `docs/` 目录，把 `index.html` 放进去
3. 仓库 → **Settings** → 左侧 **Pages** → Source 选 `main` 分支 / `docs` 目录 → Save
4. 等 1–2 分钟，页面顶部显示 "Your site is live at https://xxx.github.io/repo/"

> 注意：Pages 的 `source.path` 只接受 `/` 或 `/docs`，不能填其他子目录。
</details>

### 2. 注册开发者账号

| 商店 | 地址 | 费用 | 关键点 |
| --- | --- | --- | --- |
| Chrome Web Store | <https://chrome.google.com/webstore/devconsole> | 一次性 5 美元 | 账号必须开启两步验证 |
| Microsoft Edge Add-ons | <https://partnercenter.microsoft.com> | **免费** | 用个人 Microsoft 账号；账号类型注册后不可改 |

建议 Chrome 用一个独立的 Google 账号，不要和主邮箱绑定。

#### Microsoft Edge Add-ons（免费）注册分步

官方文档：<https://learn.microsoft.com/zh-cn/microsoft-edge/extensions/publish/create-dev-account>

1. **准备 Microsoft 账号（MSA）**：用 Outlook.com / Hotmail.com / Live.com 邮箱注册。
   Edge 计划**不接受工作或学校账号**注册。
   已有 GitHub 账号也行 —— 用 GitHub 账号登录 Partner Center 会自动帮你创建并关联一个 MSA。
   没有的话去 <https://signup.live.com/> 免费开一个即可。
2. **进入 Partner Center**：打开 <https://partnercenter.microsoft.com>，用 MSA 登录。
3. **注册 Microsoft Edge 计划**：首次登录会直接弹出「Microsoft Edge 开发人员帐户注册」表单；若没有弹出，依次点
   **Account settings** → **Account details** → **Enroll for the Microsoft Edge program**。
4. **填表**：
   - **Account country/region**：选你的国家/地区，**注册后不可更改**
   - **Account type**：选 **Individual account（个人）**（选 Company 需要企业营业执照 + 审批人，审核慢得多；且**公司账号不能改成个人账号**）
   - **Publisher display name**：显示在商店里的发布者名称（个人账号建议填一个稳定的名字，以后别改）
   - **Contact info**：邮箱 + 电话
5. **同意协议**：在 Developer agreement 区点 **Apply for the Developer Agreement**，阅读
   <https://developer.microsoft.com/store/agreements/developer-agreement-msa>，回到表单勾选
   **"I accept the terms and conditions"** → 点 **Finish**。
6. **等验证邮件**：Microsoft 审核账号注册后会发确认邮件。期间可以先做打包和素材准备，不浪费时间。
   查询状态：Partner Center → **Open Account Settings** → 看 enrollment 状态。
7. **就绪**：验证通过后，Partner Center 里会出现「Microsoft Edge」工作区，可以开始创建产品。

> 注册本身免费，Edge Add-ons 不收上架费。提交后认证审核**最长 7 个工作日**（新扩展和更新都是）。

### 3. 填写商店表单

所有文案、权限理由、数据使用声明、审核备注都整理在 **[`store/LISTING.md`](store/LISTING.md)**，按章节复制即可。

## 四、需要重点说明的三项

审核员最常在这三处卡住，务必照 LISTING.md 的写法填：

**权限理由**——`http://*/*` 与 `https://*/*` 是密码管理器的必需权限（必须在任意站点识别登录框），但宽泛主机权限会触发更严格的人工审核，审核时间从 1–3 天拉长到 3–7 天。理由必须具体，不能写"需要访问网页"这类空话。

**数据使用**——虽然数据完全不出本机，但扩展确实会读取登录表单里的用户名密码并保存，所以必须勾选 **Authentication information** 与 **Website content**。少勾是隐私类驳回的首要原因。Limited Use 三项认证全部勾选即可（不卖、不用于无关用途、不用于信用评估）。

**manifest description 长度**——Chrome 对 manifest 里的 `description` 限制 132 字符，超了会直接拒绝上传。详细信息请放到商店表单的"详细说明"里，不要写进 manifest。

## 五、更新已发布的版本

1. 提高 `manifest.json` 里的 `version`（商店不接受重复版本号）
2. `bash tools/package.sh --edge`
3. 在商店后台重新上传 zip 并提交审核

如果这次更新改了权限或数据处理方式，**必须先更新 `store/PRIVACY.md` 并重新生成 `privacy.html`**，再提交审核。商店会核对隐私政策、后台披露和实际行为是否一致，不一致会导致下架。

## 六、本地开发

开发时仍然是"加载已解压的扩展程序"：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 开启右上角"开发者模式"
3. 点击"加载已解压的扩展程序"，选择本项目根目录

修改 `src/` 下的文件后，在扩展管理页点击本扩展的"重新加载"即可生效。
