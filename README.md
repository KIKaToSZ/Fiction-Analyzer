# 小说文章分析

纯前端的小说章节编辑/阅读工具，左中右三栏布局，支持多数据源切换、本地持久化。

## 功能

- **左栏**：数据源切换、章节列表（按章节号正/倒序）、新增/导入/管理数据源/清空
- **中栏**：章节号 / 章节名 / 正文 编辑、保存、删除
- **右栏**：本章相关内容（人物 / 分析 / 大纲 三个 Tab，目前为占位，等你定义内容后填充）
- **多数据源**：可管理多个飞书多维表格链接，切换数据源查看不同作品的章节
- **导入表格数据**：复制飞书多维表格的 3 列（章节号 / 章节名 / 文章内容）粘贴进来即可批量导入
- **主题设置**：背景材质（宣纸/亮色/暗色）、强调色、字号、行高、飞书代理地址
- **本地持久化**：所有数据存 localStorage，刷新不丢
- **导入/导出 JSON**：可在不同设备间迁移数据
- **飞书自动同步**（可选）：在【编辑数据源 → 飞书同步配置】里填 App ID / App Secret，自动从多维表格拉章节

## 技术栈

- 纯 HTML + CSS + JavaScript（无任何构建工具、无依赖）
- 单页应用（SPA），刷新不丢状态
- 适配 Vercel / IGA Pages 静态托管
- 可选：Node.js 18+（仅"飞书自动同步"需要跑本地代理）

## 本地运行

只需要静态服务器：

```bash
npm install
npm run dev
# 浏览器打开 http://localhost:8080
```

或用任意静态服务器：

```bash
npx serve .
# 或
python3 -m http.server 8080
```

## 飞书自动同步（可选）

> **重要**：浏览器从第三方页面直连 `https://open.feishu.cn/open-apis` 会被 CORS 拦截，错误信息是 `Failed to fetch`，**无法用代码绕过**（浏览器安全机制）。
> 本工具默认走本机代理转发，Secret 始终留在浏览器，代理只做透传，不记录任何内容。

需要 Node.js 18+。在项目根目录开两个 terminal：

**Terminal 1 - 静态服务（页面本身）**

```bash
npm install
npm run dev            # 默认 http://localhost:8080
```

**Terminal 2 - 飞书代理（绕开 CORS）**

```bash
npm run proxy          # 默认监听 127.0.0.1:8787
# 自定义端口：npm run proxy:9000
# 或：        node proxy/feishu-proxy.js --port 9000
```

代理启动后控制台会打印：

```
  飞书 OpenAPI 本地代理已启动
  监听地址: http://127.0.0.1:8787
  转发规则: /api/feishu/*  ->  https://open.feishu.cn/open-apis/*
```

**配应用凭证（仅一次）**

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 创建"企业自建应用"
2. 在应用【权限管理】里开通 `bitable:app:readonly`（多维表格只读权限）
3. 打开目标多维表格，右上角 ··· → 【添加文档应用】→ 选刚建的应用
4. 回本工具：【管理数据源】→ 编辑 / 新增 → 展开【飞书同步配置】→ 填 App ID / App Secret → 保存
5. 点工具栏的【同步】按钮拉取章节

**自定义代理地址**

如果改了端口或代理跑在另一台机器，在【左栏底部 → 主题设置 → 飞书代理地址】改即可，留空 = 用默认 `http://localhost:8787/api/feishu`。

## 部署到 Vercel

### 方式 A：网页直接导入（最简单）

1. 把整个 `novel-app-static/` 目录上传到 GitHub 新仓库 `KIKaToSZ/novel-app`
2. 登录 https://vercel.com → "Add New Project" → 选 GitHub 里的 `novel-app` 仓库
3. 框架选 "Other"（纯静态），其他默认即可
4. 点 "Deploy"，1-2 分钟后拿到 `https://novel-app-xxx.vercel.app` 永久 URL

### 方式 B：Vercel CLI

```bash
npm i -g vercel
cd novel-app-static
vercel
```

按提示选择账号和项目，CLI 会自动识别为静态站点并部署。

## 文件结构

```
novel-app-static/
├── index.html        # 入口
├── styles.css        # 样式
├── app.js            # 全部应用逻辑
├── package.json      # npm 脚本（dev / proxy）
├── proxy/
│   └── feishu-proxy.js   # 本地代理（飞书 OpenAPI 转发）
└── README.md
```

## 数据存储位置

所有数据存在浏览器 `localStorage` 的 `novel-app-data` key 里。

如需在设备间迁移：左栏底部"导出" → 在新设备打开应用 → "导入" JSON。