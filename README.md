# 小说文章分析

纯前端的小说章节编辑/阅读工具，左中右三栏布局，**用 File System Access API 直接读取你电脑上的 xlsx**，无任何后端、无需配置服务器。

## 功能

- **左栏**：文件路径下拉（所有曾打开的本地 xlsx）+ 选择文件 / 选择文件夹 / 当前文件元信息
- **中栏**：章节号 / 章节名 / 正文 编辑、保存、删除
- **右栏**：本章相关内容（人物 / 分析 / 大纲 三个 Tab，目前为占位，等你定义内容后填充）
- **本地 xlsx 路径持久化**：打开过的文件路径会记住，下次打开页面自动读最后一次的文件；其他文件在下拉菜单里，点击即可读
- **导入表格数据**：拖拽 / 选择 xlsx，或粘贴文本（Tab / 逗号 / 多空格分隔）
- **主题设置**：背景材质（宣纸/亮色/暗色）、强调色、字号、行高
- **本地持久化**：所有数据存 localStorage，刷新不丢
- **导入/导出 JSON**：可在不同设备间迁移数据

## 技术栈

- 纯 HTML + CSS + JavaScript（无任何构建工具、无依赖）
- 单页应用（SPA），刷新不丢状态
- 适配 Vercel / IGA Pages 静态托管
- File System Access API（Chrome / Edge / Arc 等 Chromium 内核浏览器；Firefox / Safari 不支持）
- SheetJS（CDN 引入）解析 xlsx

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

**注意**：必须用 `http://localhost:8080` 或 `http://127.0.0.1:8080` 打开，**不能直接 `file://` 双击** —— File System Access API 在 `file://` 协议下不可用。

## File System Access API 用法

1. **打开页面后**，点击左栏的文件按钮 📄 或文件夹按钮 📁
2. 浏览器会弹出系统级文件选择器，选一个 `.xlsx` 文件（或一个含 xlsx 的文件夹）
3. 文件路径会出现在左栏下拉菜单中，并自动读取解析
4. **下次打开页面**，应用会自动读取你最后一次打开的文件 —— 无需手动操作
5. 想切换文件？点下拉菜单选其它项即可，每个文件都被记住了
6. 想从列表里移除？点当前文件右侧的 ✕ 按钮（不会删磁盘文件）

**首次恢复访问权限**：浏览器跨会话访问文件句柄需要用户重新确认。如果你的文件 handle 还在但权限过期（罕见），左栏会出现黄色横幅「需要重新授权才能读取本地文件」，点「重新授权」即可。如果文件本身被移动 / 删除 / 清浏览器数据，handle 会失效，需重新选择文件。

**xlsx 格式要求**：表头需包含「章节号」「章节名」「文章内容」三列（顺序任意，按表头名自动识别）。支持 `.xlsx` / `.xlsm`。

## 浏览器兼容性

| 浏览器 | 支持情况 |
| --- | --- |
| Chrome 86+ | ✅ |
| Edge 86+ | ✅ |
| Arc / Brave / Vivaldi 等 Chromium 内核 | ✅ |
| Opera | ✅ |
| Firefox | ❌ 需先开启 `dom.fs.enabled` 实验性 flag，且不稳定 |
| Safari | ❌ 暂不支持 |

打开页面后如果浏览器不支持，左栏会显示红色横幅「当前浏览器不支持 File System Access API」。

## 部署到 Vercel / IGA Pages

本项目是纯静态站点，直接把 `index.html` / `app.js` / `styles.css` 三个文件部署即可：

```bash
# 1) 推 GitHub
git push origin main

# 2) IGA Pages 监听 main 分支，1-2 分钟内自动重新部署
#    URL 不变，刷新即可看到新版本
```

无任何后端、无需 Node.js、无需环境变量。

## 文件结构

```
fiction-analyzer/
├── index.html        # 入口
├── styles.css        # 样式
├── app.js            # 全部应用逻辑（含 File System Access + IndexedDB 持久化）
├── package.json      # npm 脚本（仅 dev / start）
└── README.md
```

## 数据存储位置

| 数据 | 位置 |
| --- | --- |
| 章节内容、主题、UI 设置 | 浏览器 `localStorage` 的 `novel-app-data` key |
| 文件元信息（路径、最后打开时间） | `localStorage` 内嵌 |
| 文件访问 handle（FileSystemFileHandle） | 浏览器 `IndexedDB` 的 `novel-app-fs` 数据库 |
| 主题 | `localStorage` |

清理浏览器数据时三者都会一起清掉。

如需在设备间迁移章节：用「主题设置 → 数据 → 导出」生成 JSON，新设备「导入」即可。文件访问 handle 不会跨设备迁移，需要在新设备重新选择文件。
