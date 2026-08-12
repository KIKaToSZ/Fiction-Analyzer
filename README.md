# 小说文章分析

纯前端的小说章节编辑/阅读工具，左中右三栏布局，支持多数据源切换、本地持久化。

## 功能

- **左栏**：数据源切换、章节列表（按章节号正/倒序）、新增/导入/管理数据源/清空
- **中栏**：章节号 / 章节名 / 正文 编辑、保存、删除
- **右栏**：本章相关内容（人物 / 分析 / 大纲 三个 Tab，目前为占位，等你定义内容后填充）
- **多数据源**：可管理多个飞书多维表格链接，切换数据源查看不同作品的章节
- **导入表格数据**：复制飞书多维表格的 3 列（章节号 / 章节名 / 文章内容）粘贴进来即可批量导入
- **主题设置**：背景材质（宣纸/亮色/暗色）、强调色、字号、行高
- **本地持久化**：所有数据存 localStorage，刷新不丢
- **导入/导出 JSON**：可在不同设备间迁移数据

## 技术栈

- 纯 HTML + CSS + JavaScript（无任何构建工具、无依赖）
- 单页应用（SPA），刷新不丢状态
- 适配 Vercel 静态托管

## 本地运行

需要 Node.js 18+：

```bash
npm install
npm run dev
```

或直接用任意静态服务器：

```bash
npx serve .
# 或
python3 -m http.server 8080
```

浏览器打开 `http://localhost:8080` 即可。

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
├── index.html      # 入口
├── styles.css      # 样式
├── app.js          # 全部应用逻辑
├── package.json    # 仅用于 npm run dev 本地预览
└── README.md
```

## 数据存储位置

所有数据存在浏览器 `localStorage` 的 `novel-app-data` key 里。

如需在设备间迁移：右栏底部"导出 JSON" → 在新设备打开应用 → "导入 JSON"。
