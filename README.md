# 小说文章分析

纯前端的小说章节编辑/阅读工具，左中右三栏布局，**把本地 xlsx 拖入浏览器即可阅读/编辑**，无任何后端、无需配置服务器。

## 功能

- **左栏**：文件路径下拉（所有曾打开过的本地 xlsx / json）+ 选择文件 / 当前文件元信息
- **多 Sheet 支持**：xlsx 内多个 sheet 时自动识别所有章节 sheet，顶部出现 sheet 标签可切换；非章节 sheet 原样保留
- **快速保存（默认）**：编辑器"保存"按钮 / `Ctrl+S` / 切章节 / 切 sheet / 切页面 时，自动把当前数据写入同名 `.json`（与 xlsx 同目录，毫秒级），不再每次都重写 xlsx
- **导出 xlsx**：用「主题设置 → 数据 → 导出 xlsx」按钮手动触发，按原 xlsx 格式写回（含所有 sheet）
- **导出 json**：用「主题设置 → 数据 → 导出 json」做备份/迁移
- **打开文件**：在「打开文件」弹窗里把 `.xlsx` 或 `.json` 拖入区域（也支持点击区域选择文件）。拖入 xlsx 时如有数据会先弹覆盖确认；确认后会先把当前数据导出 json 备份，再导入新文件
- **中栏**：章节号 / 章节名 / 正文 编辑、保存、删除（切章节时自动保存当前编辑）
- **右栏**：本章相关内容（人物 / 分析 / 大纲 三个 Tab，目前为占位，等你定义内容后填充）
- **文件列表持久化**：打开过的文件名会记住（recentFiles），下次打开页面下拉菜单仍可见；本次会话内拖入的文件会标「（本次会话）」
- **导入表格数据**：拖拽 / 选择 xlsx / json（json 为数组格式，每项一个对象、keys 作为列名），多 sheet 时可下拉选要导入哪个；或粘贴文本（Tab / 逗号 / 多空格 / JSON 数组）
- **主题设置**：背景材质（宣纸/亮色/暗色）、强调色、字号、行高
- **本地持久化**：所有数据存 localStorage，刷新不丢

## 技术栈

- 纯 HTML + CSS + JavaScript（无任何构建工具、无依赖）
- 单页应用（SPA），刷新不丢状态
- 适配 Vercel / IGA Pages 静态托管
- File System Access API（**仅用于自动写盘**；读取/打开文件完全用拖入，对所有现代浏览器都支持）
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

打开方式：必须用 `http://localhost:8080` 或 `http://127.0.0.1:8080` 这种 http(s) 协议；**不能直接 `file://` 双击** —— 浏览器对 `file://` 协议下的拖入/读取限制较多，IGA Pages 部署后访问最稳。

## 打开 / 读取文件

应用的核心是「拖入 xlsx / json 即可工作」：

1. **打开页面后**，点左栏的文件按钮 📄 弹出"打开文件"弹窗
2. 把本地 `.xlsx` 或 `.json` 文件**拖入弹窗里的虚线区域**（也可以点击该区域选择文件）
3. 选定后区域下方会显示文件名 + 大小，点「确认打开」即开始解析
4. 文件名出现在左栏下拉菜单中
5. **如有数据**：弹覆盖确认（「确定」= 先把当前数据导出 json 备份 + 导入新文件；「取消」= 中止）
6. **自动生成同名 .json**：首次打开 xlsx 时，应用会立即在同目录生成 `<文件名>.json`，后续所有日常保存都走这个 json，毫秒级

**xlsx 格式要求**：每个章节 sheet 的表头需包含「章节号」「章节名」「文章内容」三列（顺序任意，按表头名自动识别）。支持 `.xlsx` / `.xlsm`。**多 sheet 文件**：含表头的 sheet 会被识别为章节 sheet，顶部出现 sheet 标签可切换；不含表头的 sheet（如「人物表」）原样保留，不会被覆盖。

**为什么不用 File System Access API 直接选？** 该 API 在某些沙箱环境（如 IGA Pages 预览）下支持不稳定，且与「先导出 json 再导入」的备份流程冲突。v8 起统一走拖入路径，行为更可控。

**重要提示**：拖入的文件**仅本次会话内可访问**（下拉菜单里会标「（本次会话）」）。关闭页面前请用「主题设置 → 数据 → 导出 json」或「导出 xlsx」手动备份。

## 写入文件

**默认走 json 增量保存（快速）**

每次点「保存」、按 `Ctrl+S`、切章节、切 sheet、切页面时，应用把当前数据写入与 xlsx 同名的 `.json` 文件（与 xlsx 同目录，毫秒级）。流程：

1. 把当前编辑器的修改同步到 localStorage（即时生效）
2. 尝试把整份 state 写入 `原文件名.json`（轻量序列化，无 SheetJS 开销）

**为什么这样改？** 每次直接重写 xlsx 在大文件/慢盘上要等几秒；用 json 增量保存后，所有日常保存都是瞬间完成。

**什么时候写 xlsx？** 只有你明确要"导出 xlsx"时。用「主题设置 → 数据 → 导出 xlsx」按钮触发，按原 xlsx 格式写回原文件（含所有 sheet：当前激活的 sheet 用最新章节替换；其他章节 sheet 同步最新数据；非章节 sheet 原样保留）。

**如果 json 写盘失败**（无 handle / 权限过期），会自动改为下载 `原文件名.json` 到本地。把下载的 json 放回 xlsx 同目录后，下次保存即可自动写盘。

**首次保存**时浏览器会弹一次「允许写入」的权限提示（仅当 xlsx 来自文件夹批量打开等带 handle 的场景；纯拖入的 xlsx 无 handle，第一次保存会下载 json 而不是写盘）。

**导入 json 工作流**：在「打开文件」弹窗里把 `.json` 拖入（也会作为日常工作文件）。后续日常保存会把这份 json 写回原位置；想恢复 xlsx 模式时，导一次 xlsx 即可。

## 浏览器兼容性

| 浏览器 | 支持情况 |
| --- | --- |
| Chrome / Edge / Arc / Brave / Vivaldi 等 Chromium 内核 | ✅ 完整支持（含自动写盘） |
| Firefox | ✅ 拖入 + 读取 + 下载 json，**首次写盘会下载到本地**（不自动写回原文件） |
| Safari | ⚠️ 多数功能可用，部分 API 差异 |

**部署到 IGA Pages 预览版**是国内目前最稳的访问方式（Vercel 在国内访问慢）。

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
├── app.js            # 全部应用逻辑（拖入读取 + IndexedDB 句柄持久化）
├── test-v6-features.js  # Node 端单元测试（schema 升级 / history / normalize）
├── package.json      # npm 脚本（仅 dev / start）
└── README.md
```

## 数据存储位置

| 数据 | 位置 |
| --- | --- |
| 章节内容、主题、UI 设置 | 浏览器 `localStorage` 的 `novel-app-data` key |
| 文件元信息（名称、最近打开时间、isEphemeral 等） | `localStorage` 内嵌 |
| 文件访问 handle（FileSystemFileHandle，文件夹批量导入时才有） | 浏览器 `IndexedDB` 的 `novel-app-fs` 数据库 |
| 自动写入的 `.json` 备份 | 与 xlsx 同目录（无 handle 时下载到本地） |

清理浏览器数据时前两项会一起清掉；IndexedDB handle 单独清。如需在设备间迁移章节：用「主题设置 → 数据 → 导出 json」生成 JSON，新设备「打开文件」弹窗拖入即可。
