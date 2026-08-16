/* ============================================================
   小说文章分析 - 应用主逻辑（schema v5 - 多页面 / 多 sheet 归类）
   纯前端 SPA，无外部依赖（除 SheetJS CDN）
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     常量
     ============================================================ */
  const STORAGE_KEY = "novel-app-data";
  const SCHEMA_VERSION = 12;
  const FS_DB_NAME = "novel-app-fs";
  const FS_STORE = "handles";
  // 持久化 directory handle 的 key 前缀（完整 key = "dir:" + currentFileName）
  const DIR_HANDLE_KEY_PREFIX = "dir:";

  const DEFAULT_THEME = {
    bg: "paper",
    accent: "indigo",
    fontSize: 16,
    lineHeight: 1.7,
    font: "system", // system | serif | hei | kai | fang
    autosaveMs: 0,  // 0=关闭；60000/180000/300000 = 1/3/5 分钟
  };

  const ACCENT_COLORS = {
    indigo: "#5B7FB9",
    sage: "#7A9B7E",
    amber: "#B89060",
    rose: "#B57A8A",
    slate: "#5C6B7A",
  };

  // 伏笔状态颜色 / 文案
  // v17：状态选项改为「未回收 / 部分回收 / 已回收」三档
  const FS_STATUS_OPTIONS = ["未回收", "部分回收", "已回收"];
  // 旧值 → 新值迁移（活跃→未回收、已废弃→部分回收、已回收→已回收）
  const FS_STATUS_MIGRATION = {
    "活跃": "未回收",
    "已废弃": "部分回收",
    "已回收": "已回收",
  };
  const FS_STATUS_DEFAULT = "未回收";

  /* ============================================================
     页面注册表 - 每个页面是独立的「数据 + UI + 识别」单元
     后续要加新页面（人物 / 大纲等）只需在 PAGES 里加一项
     ============================================================ */
  const PAGES = {
    chapter: {
      id: "chapter",
      label: "章节",
      icon: "📖",
      // sheet 名匹配：含"卷/章/节/章节/chapter/正文"或纯 SheetN 兜底为章节
      matchName(name) {
        if (!name) return false;
        if (/伏笔|铺垫|线索|foreshadow|伏线|人物|角色|character/i.test(name)) return false;
        return /章节|^第.{1,5}(章|节|卷)|卷|chapter|正文|contents?|^Sheet\d*$/i.test(name);
      },
      // 表头匹配：必须同时含"章节号/章号/no 之一"和"内容/正文/content 之一"
      matchHeaders(header) {
        const norm = (header || []).map((h) =>
          String(h || "").replace(/\s+/g, "").toLowerCase()
        );
        const has = (cands) =>
          cands.some((c) =>
            norm.some((h) => h.includes(c.toLowerCase()))
          );
        return (
          (has(["章", "章号", "节号", "no", "number", "序"]) ||
            has(["章", "章名", "节名", "标题", "title", "name"])) &&
          has(["内容", "正文", "content", "text", "body"])
        );
      },
      fields: {
        no: ["章节号", "章号", "序号", "number", "no", "chapter_no", "序章"],
        title: ["章节名", "章节名称", "标题", "title", "name", "chapter_name"],
        content: ["文章内容", "内容", "正文", "content", "text", "body"],
      },
      defaults() {
        return { no: 0, title: "", content: "" };
      },
      makeItem(data, sheet) {
        return {
          id: uid("ch"),
          no: data.no || 0,
          title: data.title || "",
          content: data.content || "",
          sheet,
        };
      },
      sortKey(item) {
        // 返回 {num, str} 复合 key，sort 调用方用 compareChapterNo 比较
        // 数字章节号 → {num: 12, str: "12"}
        // 字符串章节号 → 走 parseChapterNo 解析
        return parseChapterNo(item.no);
      },
      newItemLabel: "新增章节",
      newItemToast(sheet, no) {
        return sheet
          ? `已新增第 ${no} 章 [${sheet}]`
          : `已新增第 ${no} 章`;
      },
      emptyStateHtml() {
        return `
          <div class="empty-state-inner">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <p>从左侧选一章开始阅读，或新增一章</p>
          </div>`;
      },
    },

    foreshadowing: {
      id: "foreshadowing",
      label: "伏笔管理",
      icon: "🔖",
      matchName(name) {
        if (!name) return false;
        return /伏笔|铺垫|线索|foreshadow|伏线|plot.?thread/i.test(name);
      },
      matchHeaders(header) {
        const norm = (header || []).map((h) =>
          String(h || "").replace(/\s+/g, "").toLowerCase()
        );
        const has = (cands) =>
          cands.some((c) =>
            norm.some((h) => h.includes(c.toLowerCase()))
          );
        return has([
          "伏笔",
          "铺垫",
          "foreshadow",
          "plot",
          "线索",
          "伏线",
        ]);
      },
      // v15：伏笔管理拆成两张表（重构）
      //   - 主表 fields：伏笔编号 / 伏笔名称 / 伏笔状态（3 字段，UI 一行展示 3 列）
      //   - 履历表 recordFields：序号 / 伏笔编号 / 提及章节 / 原文描述（4 字段，UI 列表展示）
      // 履历表识别优先级比主表高（如果 sheet 同时含"原文描述"列就归为履历表 sheet），
      // 通过 recordFieldsSheetMatch 单独判定。
      // v15 调整：主表去掉"序号"字段（序号由列表渲染层按 fsNo 排序后 1-based 派生）
      fields: {
        fsNo: ["伏笔编号"],
        name: ["伏笔名称"],
        status: ["状态", "伏笔状态", "回收状态"],
      },
      recordFields: {
        no: ["序号"],
        fsNo: ["伏笔编号"],
        setup: ["提及章节", "铺设章节"],
        notes: ["原文描述", "备注", "描述"],
      },
      defaults() {
        return {
          fsNo: "",
          name: "",
          status: FS_STATUS_DEFAULT,
        };
      },
      recordDefaults() {
        return {
          no: 0,
          fsNo: "",
          setup: "",
          notes: "",
        };
      },
      makeItem(data, sheet) {
        return {
          id: uid("fs"),
          fsNo: String(data.fsNo ?? data.no ?? "").trim(),
          name: data.name || "",
          // v17：旧状态值（活跃/已废弃/已回收）→ 新值（未回收/部分回收/已回收）
          status: FS_STATUS_MIGRATION[data.status] || data.status || FS_STATUS_DEFAULT,
          sheet,
        };
      },
      makeRecord(data, sheet) {
        return {
          id: uid("fsr"),
          no: parseFsNoToKey(data.no),
          fsNo: String(data.fsNo ?? "").trim(),
          setup: data.setup || "",
          notes: data.notes || "",
          sheet,
        };
      },
      // v14：履历表 sheet 判定（同时含 fsNo + setup + notes 三个字段）
      recordFieldsSheetMatch(header) {
        const norm = (header || []).map((h) =>
          String(h || "").replace(/\s+/g, "").toLowerCase()
        );
        const has = (cands) =>
          cands.some((c) => norm.some((h) => h.includes(c.toLowerCase())));
        return (
          has(this.recordFields.fsNo) &&
          has(this.recordFields.setup) &&
          has(this.recordFields.notes)
        );
      },
      sortKey(item) {
        // 主表按 fsNo 排序（字符串 + 数字兼容）
        return parseFsNoKey(item.fsNo || item.no);
      },
      recordSortKey(rec) {
        // 履历按"提及章节"解析成章节号排序
        return parseChapterNo(rec.setup);
      },
      newItemLabel: "新增伏笔",
      newItemToast(sheet, fsNo) {
        return sheet
          ? `已新增伏笔 #${fsNo} [${sheet}]`
          : `已新增伏笔 #${fsNo}`;
      },
      emptyStateHtml() {
        return `
          <div class="empty-state-inner">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M3 7h18M3 12h18M3 17h12" />
            </svg>
            <p>从左侧选一条伏笔查看，或新增一条</p>
            <p class="hint">伏笔 = 故事里提前铺设、后续回收的剧情线索</p>
          </div>`;
      },
    },
  };

  // v14：把 fsNo（伏笔编号）解析为可排序的 key
  // 兼容："1" / "FS-001" / "序章" / "12" 都能正常排序
  function parseFsNoKey(raw) {
    if (raw == null) return { num: Infinity, str: "", raw: "" };
    const s = String(raw).trim();
    if (!s) return { num: Infinity, str: "", raw: "" };
    // 优先走 parseChapterNo 复用阿拉伯/中文数字解析
    const p = parseChapterNo(s);
    return { num: p.num, str: s, raw: s };
  }
  function parseFsNoToKey(no) {
    // 序号字段统一存 number；如果解析不出数字就存 0（UI 仍然按字符串位置排）
    const p = parseChapterNo(no);
    if (p.hasNum && Number.isFinite(p.num)) return p.num;
    if (typeof no === "number" && Number.isFinite(no)) return no;
    return 0;
  }
  const PAGE_IDS = Object.keys(PAGES);
  const DEFAULT_PAGE = "chapter";

  /* ============================================================
     工具函数
     ============================================================ */
  const $ = (sel, root = document) =>
    root && root.querySelector ? root.querySelector(sel) : null;
  const $$ = (sel, root = document) =>
    root && root.querySelectorAll
      ? Array.from(root.querySelectorAll(sel))
      : [];
  const uid = (prefix = "id") =>
    `${prefix}_${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  const toast = (msg, type = "info", duration = 2000) => {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.toggle("error", type === "error");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), duration);
  };
  const showModal = (id) => {
    const m = $(`#${id}`);
    if (m) m.hidden = false;
  };
  const hideModal = (id) => {
    const m = $(`#${id}`);
    if (m) m.hidden = true;
  };
  const formatSize = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  /* ============================================================
     段落规整 - 显示时移除空行（段间紧凑显示）
     规则：
       1. \r\n 统一为 \n
       2. 把 2+ 个连续换行（段落间的空行）折叠为 1 个换行
     效果：
       - 原数据 `a\nb\nc` → 显示成 `a\nb\nc`（无变化，原本就没空行）
       - 原数据 `a\n\nb\n\nc` → 显示成 `a\nb\nc`（空行被移除）
       - 原数据 `a\n\n\nb` → 先折叠为 `a\nb`（连续空行也折叠）
     说明：源数据不修改，只在渲染 textarea 时调用。
     写入 json / xlsx 时存的是原始 content（含空行），便于后续编辑时还原。
     ============================================================ */
  function normalizeParagraphs(s) {
    if (s == null || s === "") return s;
    s = String(s).replace(/\r\n?/g, "\n");
    // 折叠 2+ 个连续换行为 1 个（移除段落间空行）
    s = s.replace(/\n{2,}/g, "\n");
    return s;
  }

  /* ============================================================
     把 textarea 的光标位置"顶"到视口上方约 1/3 处
     - 避免光标紧贴 textarea 底部、看起来很挤
     - 适用于：回车后、输入文字后、删除后 等所有内容变化场景
     - 内容不够长、视口内就装得下时，scrollTop 本来就是 0，不会有副作用
     ============================================================ */
  function ensureCaretInView(ta) {
    if (!ta) return;
    try {
      const cs = window.getComputedStyle(ta);
      const lineHeight = parseFloat(cs.lineHeight);
      const paddingTop = parseFloat(cs.paddingTop) || 0;
      const viewportH = ta.clientHeight;
      if (!lineHeight || !viewportH) return;
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos);
      const caretLine = before.split("\n").length; // 1-based
      const caretTop = (caretLine - 1) * lineHeight + paddingTop;
      // 把光标顶到视口上方 1/3 处（即下方留 2/3 视口高度的"留白"）
      const desired = Math.max(0, caretTop - viewportH / 3);
      if (ta.scrollTop !== desired) ta.scrollTop = desired;
    } catch (_) {}
  }

  /* ============================================================
     状态（schema v5 - 多页面）
     ============================================================ */
  // pages[pageId] = {
  //   sheets:        [{name, columns, rowCount, ok}]  // 归到本页面的 sheet
  //   currentSheet:  string | null
  //   items:         [...]                            // 本页面的条目
  //   currentItemId: string | null
  //   records:       [...]                            // v14：伏笔履历记录（仅 foreshadowing 用）
  // }
  // sheetsRaw:  [{name, rows2d, columns, rowCount, ok, page}]  // 全量 raw，写回用
  function makePageState() {
    return {
      sheets: [],
      currentSheet: null,
      items: [],
      currentItemId: null,
      // v14：履历表——和 items 关联的多次"提及"记录
      // 每条 {id, no, fsNo, setup, notes, sheet}
      records: [],
    };
  }

  // 是否有任何用户数据（用于在覆盖前判断是否需要先导出 json 备份）
  function hasAnyUserData() {
    if (state.currentFileName) return true;
    for (const pid of PAGE_IDS) {
      if (state.pages[pid] && state.pages[pid].items.length > 0) return true;
    }
    return false;
  }

  // 字数统计：排除所有空白字符（空格 / 换行 / 制表符）
  function charCount(s) {
    return (s || "").replace(/\s+/g, "").length;
  }

  const state = {
    schema: SCHEMA_VERSION,
    currentPage: DEFAULT_PAGE,
    pages: {
      chapter: makePageState(),
      foreshadowing: makePageState(),
    },
    sheetsRaw: [], // [{name, rows2d, columns, rowCount, ok, page}]
    recentFiles: [],
    currentFileName: null,
    xlsxFileName: null,    // 当前数据对应的「原 xlsx 文件名」——仅用于「导出 xlsx」命名；json-only 流程下可为 null
    // v7：json 增量保存的关联文件（首次导入 xlsx 后自动生成）
    jsonFileName: null,
    jsonHandleKey: null,
    // v9：用户授权过的目录 handle key（用于"启用自动写盘"功能后持久化写盘）
    // 完整 key = "dir:" + currentFileName；对应 directory handle 存于 indexeddb
    directoryHandleKey: null,
    // v10：directory handle 的 basename（仅显示用，浏览器不暴露绝对路径）
    // ——让用户能区分"导入的 xxx.json"和"启用写盘后创建的 xxx.json"
    directoryName: null,
    theme: { ...DEFAULT_THEME },
    ui: { sort: "asc" },
  };

  /* ============================================================
     撤销 / 重做（history）
     - 快照：state.pages + state.sheetsRaw + state.currentPage
     - 不存：theme / ui / recentFiles / currentFileName（这些是环境变量）
     ============================================================ */
  const HISTORY_MAX = 50;
  const history = {
    stack: [],   // [{pages, sheetsRaw, currentPage}, ...]
    idx: -1,     // 当前指针；-1 表示空
    suspended: false, // undo/redo 期间禁止入栈，避免覆盖
  };

  function snapshotState() {
    return {
      pages: {
        chapter: {
          sheets: JSON.parse(JSON.stringify(state.pages.chapter.sheets || [])),
          currentSheet: state.pages.chapter.currentSheet,
          items: JSON.parse(JSON.stringify(state.pages.chapter.items || [])),
          currentItemId: state.pages.chapter.currentItemId,
        },
        foreshadowing: {
          sheets: JSON.parse(JSON.stringify(state.pages.foreshadowing.sheets || [])),
          currentSheet: state.pages.foreshadowing.currentSheet,
          items: JSON.parse(JSON.stringify(state.pages.foreshadowing.items || [])),
          currentItemId: state.pages.foreshadowing.currentItemId,
          records: JSON.parse(JSON.stringify(state.pages.foreshadowing.records || [])),
        },
      },
      sheetsRaw: JSON.parse(JSON.stringify(state.sheetsRaw || [])),
      currentPage: state.currentPage,
    };
  }

  function applySnapshot(snap) {
    if (!snap) return;
    state.pages = {
      chapter: {
        ...makePageState(),
        ...snap.pages.chapter,
      },
      foreshadowing: {
        ...makePageState(),
        ...snap.pages.foreshadowing,
      },
    };
    state.sheetsRaw = snap.sheetsRaw || [];
    if (PAGE_IDS.includes(snap.currentPage)) {
      state.currentPage = snap.currentPage;
    }
  }

  function pushHistory() {
    if (history.suspended) return;
    // 截断 idx 之后的内容（清空 redo 分支）
    if (history.idx < history.stack.length - 1) {
      history.stack = history.stack.slice(0, history.idx + 1);
    }
    const snap = snapshotState();
    // 和栈顶相同则不入栈（避免连续相同快照污染栈）
    const top = history.stack[history.stack.length - 1];
    if (top && JSON.stringify(top) === JSON.stringify(snap)) return;
    history.stack.push(snap);
    if (history.stack.length > HISTORY_MAX) {
      history.stack.shift();
    }
    history.idx = history.stack.length - 1;
    updateUndoRedoButtons();
  }

  function undo() {
    if (history.idx <= 0) {
      toast("已是最早的操作", "info", 1200);
      return;
    }
    // 先把当前编辑器的"未保存"输入提交到 item，再切快照
    try { saveCurrentItem(); } catch (_) {}
    history.idx--;
    history.suspended = true;
    try {
      applySnapshot(history.stack[history.idx]);
    } finally {
      history.suspended = false;
    }
    save();
    renderAll();
    updateUndoRedoButtons();
    toast("已撤销", "info", 900);
  }

  function redo() {
    if (history.idx >= history.stack.length - 1) {
      toast("已是最新的操作", "info", 1200);
      return;
    }
    try { saveCurrentItem(); } catch (_) {}
    history.idx++;
    history.suspended = true;
    try {
      applySnapshot(history.stack[history.idx]);
    } finally {
      history.suspended = false;
    }
    save();
    renderAll();
    updateUndoRedoButtons();
    toast("已重做", "info", 900);
  }

  function resetHistory() {
    history.stack = [];
    history.idx = -1;
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    const u = $("#btn-undo");
    const r = $("#btn-redo");
    if (u) u.disabled = !(history.idx > 0);
    if (r) r.disabled = !(history.idx >= 0 && history.idx < history.stack.length - 1);
  }

  // 持续编辑场景下用：800ms 停顿才入栈，避免每个字符都打一格
  let _pushHistoryDebounce = null;
  function debouncedPushHistory(delay = 800) {
    if (history.suspended) return;
    clearTimeout(_pushHistoryDebounce);
    _pushHistoryDebounce = setTimeout(() => {
      _pushHistoryDebounce = null;
      pushHistory();
    }, delay);
  }

  /* ============================================================
     自动保存
     - 触发：state.theme.autosaveMs（0=关闭，60000/180000/300000）
     - 动作：把当前编辑器提交到 item → 存 localStorage → 尝试写回 xlsx
     - 不阻塞：写文件失败不报错，只在状态条上提示
     ============================================================ */
  let _autosaveTimer = null;
  let _autosaveRunning = false;
  function startAutosave() {
    stopAutosave();
    const ms = Number(state.theme.autosaveMs) || 0;
    if (ms <= 0) {
      _setAutosaveStatus("已关闭", "");
      return;
    }
    _autosaveTimer = setInterval(async () => {
      if (_autosaveRunning) return;
      _autosaveRunning = true;
      try {
        await runAutosaveOnce();
      } finally {
        _autosaveRunning = false;
      }
    }, ms);
    _setAutosaveStatus(`每 ${formatMinutes(ms)} 自动保存一次`, "");
  }
  function stopAutosave() {
    if (_autosaveTimer) {
      clearInterval(_autosaveTimer);
      _autosaveTimer = null;
    }
  }
  function formatMinutes(ms) {
    if (ms % 60000 === 0) return `${ms / 60000} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
  }
  function _setAutosaveStatus(text, cls) {
    const el = $("#autosave-status");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("saved", "error");
    if (cls) el.classList.add(cls);
  }
  async function runAutosaveOnce() {
    // 1) 把编辑器里的"未保存输入"提交到 item（不弹 toast）
    try {
      const it = curItem();
      if (it) {
        if (state.currentPage === "chapter") {
          it.no = $("#ch-no").value; // 保留原始字符串（数字 / "第12章" / "序章"），排序由 sortKey 处理
          it.title = $("#ch-title").value.trim();
          it.content = $("#ch-content").value;
        } else if (state.currentPage === "foreshadowing") {
          // 序号 it.no 由列表自动管理,这里只同步核心字段
          it.fsNo = String($("#fs-fsno")?.value ?? it.fsNo ?? "").trim();
          it.name = String($("#fs-name")?.value ?? it.name ?? "").trim();
          it.status = $("#fs-status")?.value || it.status || FS_STATUS_DEFAULT;
          // 履历从编辑器 DOM 抓 (records[] 由 record-row 渲染)
          try {
            const rows = document.querySelectorAll("#fs-records-list .fs-record-row");
            const recs = [];
            rows.forEach((row) => {
              const setup = row.querySelector(".fs-rec-setup")?.value?.trim() || "";
              const notes = row.querySelector(".fs-rec-notes")?.value || "";
              if (setup || notes) {
                recs.push({
                  id: row.dataset.recId || undefined,
                  setup,
                  notes,
                });
              }
            });
            it.records = recs;
          } catch (_) {}
        }
      }
    } catch (_) {}
    // 2) 一定存 localStorage
    save();
    // 3) 写 json（性能优先；如要 xlsx 请点"导出 xlsx"按钮）
    let res = { ok: false, mode: "" };
    try {
      res = await saveAsJson({ silent: true });
    } catch (e) {
      _setAutosaveStatus("已存到本地，写 json 失败", "error");
      return;
    }
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    let label = "已自动保存到本地";
    if (res.mode === "handle" || res.mode === "dir") label = `已自动保存到 json · ${ts}`;
    else if (res.mode === "download") label = `已自动保存（json 已下载）· ${ts}`;
    else if (res.mode === "ephemeral") label = `已自动保存到浏览器 · ${ts}`;
    _setAutosaveStatus(label, "saved");
  }

  /* ============================================================
     持久化 - localStorage（不含 file handles）
     ============================================================ */
  function save() {
    const data = {
      schema: SCHEMA_VERSION,
      currentPage: state.currentPage,
      pages: state.pages,
      recentFiles: state.recentFiles.map((f) => ({
        name: f.name,
        lastOpened: f.lastOpened,
        mtime: f.mtime,
        size: f.size,
        handleKey: f.handleKey,
        isDirectory: !!f.isDirectory,
        isMigrated: !!f.isMigrated,
        // v8.1 修：保留 isEphemeral——这样 json 跨设备复制时，下拉框能正确显示
        // 「（本次会话）」标签，loadFromJsonFile 也能据此把当前 json 置顶
        isEphemeral: !!f.isEphemeral,
      })),
      currentFileName: state.currentFileName,
      xlsxFileName: state.xlsxFileName,
      jsonFileName: state.jsonFileName,
      jsonHandleKey: state.jsonHandleKey,
      directoryHandleKey: state.directoryHandleKey,
      // v10：directory handle 的 basename（仅显示用，浏览器不暴露绝对路径）
      directoryName: state.directoryName,
      // v9：每个文件是否已经提示过"启用自动写盘"（避免重复弹）
      autoSavePromptDismissed: state._autoSavePromptDismissed || {},
      theme: state.theme,
      ui: state.ui,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error("保存失败", e);
      toast("保存失败：本地存储已满", "error");
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);

      // 极旧数据迁移（v1/v2 - dataSources 数组 → v3 单文件 → v5）
      if (Array.isArray(data.dataSources)) {
        const target =
          data.dataSources.find((d) => d.id === data.currentDataSourceId) ||
          data.dataSources.find((d) => (d.chapters || []).length > 0) ||
          data.dataSources[0];
        if (target) {
          // 把旧章节全归到 chapter 页
          state.pages.chapter.items = (target.chapters || []).map((c) => ({
            id: c.id || uid("ch"),
            no: c.no ?? 0,
            title: c.title || "",
            content: c.content || "",
            sheet: c.sheet || "Sheet1",
          }));
          state.pages.chapter.currentItemId =
            data.currentChapterId &&
            state.pages.chapter.items.find((c) => c.id === data.currentChapterId)
              ? data.currentChapterId
              : null;
          state.pages.chapter.currentSheet =
            state.pages.chapter.items[0]?.sheet || null;
          state.recentFiles = [
            {
              name: target.name || "已迁移的旧数据源",
              lastOpened: target.lastSyncAt || new Date().toISOString(),
              mtime: 0,
              size: 0,
              handleKey: null,
              isMigrated: true,
            },
          ];
        }
        save();
        return;
      }

      // v4 迁移：state.chapters / state.sheets / state.currentSheet → pages.chapter
      if (Array.isArray(data.chapters)) {
        state.pages.chapter.items = data.chapters.map((c) => ({
          id: c.id || uid("ch"),
          no: c.no ?? 0,
          title: c.title || "",
          content: c.content || "",
          sheet: c.sheet || "Sheet1",
        }));
        state.pages.chapter.currentItemId =
          data.currentChapterId &&
          state.pages.chapter.items.find((c) => c.id === data.currentChapterId)
            ? data.currentChapterId
            : null;
        state.pages.chapter.currentSheet =
          data.currentSheet || state.pages.chapter.items[0]?.sheet || null;
        // v4 的 sheets 元数据 → pages.chapter.sheets
        if (Array.isArray(data.sheets)) {
          state.pages.chapter.sheets = data.sheets.map((s) => ({
            ...s,
            // 兜底：v4 时期所有 sheet 都算 chapter
            page: s.page || "chapter",
          }));
        }
        // v4 的 sheetsRaw → 全量 sheetsRaw
        if (Array.isArray(data.sheetsRaw)) {
          state.sheetsRaw = data.sheetsRaw.map((s) => ({
            ...s,
            page: s.page || "chapter",
          }));
        }
      }

      // v5 直接读
      if (data.pages) {
        for (const pid of PAGE_IDS) {
          if (data.pages[pid]) {
            state.pages[pid] = {
              ...makePageState(),
              ...data.pages[pid],
            };
          }
        }
      }

      // v14：伏笔管理表拆分迁移（v10/v13 → v11）
      // - 旧 item 字段 {id, no, name, setup, payoff, status, notes, sheet}
      //   → 拆成主表 item {id, no, fsNo, name, status, sheet} + 履历 record {id, no, fsNo, setup, notes, sheet}
      // - 迁移策略：旧 no → fsNo（兼容用户在旧数据里把 no 当"伏笔编号"用）
      //             旧 setup/notes 拼成一条 record（fsNo = 旧 no）
      //             旧 payoff 直接丢弃（v11 主表/履历表都不再保留）
      {
        const fs = state.pages.foreshadowing;
        if (!Array.isArray(fs.records)) fs.records = [];
        if (Array.isArray(fs.items)) {
          const migratedItems = [];
          const migratedRecords = fs.records.slice();
          for (const old of fs.items) {
            const fsNoRaw = String(old.fsNo ?? old.no ?? "").trim();
            const newItem = {
              id: old.id || uid("fs"),
              no: parseFsNoToKey(old.no),
              fsNo: fsNoRaw,
              name: old.name || "",
              status: FS_STATUS_MIGRATION[old.status] || old.status || FS_STATUS_DEFAULT,
              sheet: old.sheet,
            };
            migratedItems.push(newItem);
            // 旧 setup / notes 拼成第一条 record（仅当 setup 或 notes 有内容时）
            const oldSetup = String(old.setup || "").trim();
            const oldNotes = String(old.notes || "").trim();
            if (oldSetup || oldNotes) {
              migratedRecords.push({
                id: old.id ? `fsr_${old.id.slice(3)}` : uid("fsr"),
                no: 0,
                fsNo: fsNoRaw,
                setup: oldSetup,
                notes: oldNotes,
                sheet: old.sheet,
              });
            }
          }
          fs.items = migratedItems;
          fs.records = migratedRecords;
          // schema 升到 v11
          state.schema = 11;
        }
      }

      // v15：伏笔主表去掉"序号"字段（v11 主表是 4 字段含 no，v15 只要 3 字段）
      // - 把 items 里的 no 字段移除；records 仍保留 no 字段（履历表结构不动）
      // - 序号由列表渲染层按 fsNo 排序后 1-based 派生
      {
        const fs = state.pages.foreshadowing;
        if (Array.isArray(fs.items)) {
          fs.items = fs.items.map((old) => {
            if (!old || typeof old !== "object") return old;
            // 解构去掉 no，其余字段保留
            const { no, ...rest } = old;
            return rest;
          });
        }
        state.schema = 12;
      }
      if (Array.isArray(data.sheetsRaw)) {
        state.sheetsRaw = data.sheetsRaw;
      }
      if (data.currentPage && PAGE_IDS.includes(data.currentPage)) {
        state.currentPage = data.currentPage;
      }
      state.recentFiles = Array.isArray(data.recentFiles)
        ? data.recentFiles
        : [];
      state.currentFileName = data.currentFileName || null;
      state.xlsxFileName = data.xlsxFileName || data.currentFileName || null;
      state.jsonFileName = data.jsonFileName || null;
      state.jsonHandleKey = data.jsonHandleKey || null;
      // v9：directoryHandleKey 是新字段，旧数据迁移时给个 null
      state.directoryHandleKey = data.directoryHandleKey || null;
      // v10：directoryName（仅显示用，旧数据为 null）
      state.directoryName = data.directoryName || null;
      // v9：恢复自动写盘提示的 dismissed 状态
      state._autoSavePromptDismissed = data.autoSavePromptDismissed || {};
      state.theme = { ...DEFAULT_THEME, ...(data.theme || {}) };
      // v18：伏笔独立排序 + 状态筛选 + 履历排序（章节用 ui.sort,伏笔用 ui.fsSort）
  state.ui = {
    sort: "asc",
    fsSort: "asc",
    fsStatusFilter: "all", // "all" | "未回收" | "部分回收" | "已回收"
    fsRecordSort: "asc",
    layout: {},
    ...(data.ui || {}),
  };
  // 旧数据兼容：补默认值
  if (!state.ui.fsSort) state.ui.fsSort = "asc";
  if (!state.ui.fsStatusFilter) state.ui.fsStatusFilter = "all";
  if (!state.ui.fsRecordSort) state.ui.fsRecordSort = "asc";
      // 兜底：ui.layout 各字段补默认
      state.ui.layout = {
        nav: LAYOUT_DEFAULTS.nav,
        threeList: LAYOUT_DEFAULTS.threeList,
        threeRight: LAYOUT_DEFAULTS.threeRight,
        twoList: LAYOUT_DEFAULTS.twoList,
        ...(state.ui.layout || {}),
      };

      // 兜底：确保每个 page 至少有基本结构
      for (const pid of PAGE_IDS) {
        if (!state.pages[pid]) state.pages[pid] = makePageState();
        if (!Array.isArray(state.pages[pid].items))
          state.pages[pid].items = [];
        if (!Array.isArray(state.pages[pid].sheets))
          state.pages[pid].sheets = [];
      }
      // 兜底：sheetsRaw 里的 sheet 必须有 page 字段（默认 chapter）
      for (const s of state.sheetsRaw) {
        if (!s.page) s.page = "chapter";
      }
      // v11：恢复配置后刷新「写盘目录」按钮文字
      updateAutosaveButton();
    } catch (e) {
      console.error("读取失败，使用默认状态", e);
    }
  }

  /* ============================================================
     IndexedDB - File System handles 持久化
     ============================================================ */
  let _dbPromise = null;
  function openFsDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB 不可用"));
      const req = indexedDB.open(FS_DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(FS_STORE)) {
          db.createObjectStore(FS_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }
  async function fsPut(key, value) {
    const db = await openFsDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_STORE, "readwrite");
      tx.objectStore(FS_STORE).put({ key, value, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function fsGet(key) {
    const db = await openFsDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_STORE, "readonly");
      const req = tx.objectStore(FS_STORE).get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(tx.error);
    });
  }
  async function fsDel(key) {
    const db = await openFsDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(FS_STORE, "readwrite");
      tx.objectStore(FS_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }


  /* ============================================================
     File System Access API
     ============================================================ */
  const fsSupported = () =>
    typeof window.showOpenFilePicker === "function" &&
    typeof window.showDirectoryPicker === "function";

  async function readFileAsArrayBuffer(handle) {
    const file = await handle.getFile();
    return await file.arrayBuffer();
  }

  async function ensureReadPermission(handle, interactive = true) {
    if (!handle) return false;
    if (handle.queryPermission) {
      const cur = await handle.queryPermission({ mode: "read" });
      if (cur === "granted") return true;
      if (!interactive) return false;
      if (handle.requestPermission) {
        const next = await handle.requestPermission({ mode: "read" });
        return next === "granted";
      }
    }
    return false;
  }

  async function pickDirectory() {
    if (!fsSupported()) throw new Error("当前浏览器不支持 File System Access API");
    return await window.showDirectoryPicker({ mode: "read" });
  }

  async function listXlsxInDir(dirHandle) {
    const out = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (
        handle.kind === "file" &&
        /\.(xlsx|xlsm)$/i.test(name)
      ) {
        out.push({ name, handle });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    return out;
  }

  async function describeFile(handle) {
    try {
      const file = await handle.getFile();
      return { name: file.name, size: file.size, mtime: file.lastModified };
    } catch (_) {
      return { name: handle.name, size: 0, mtime: 0 };
    }
  }

  /* ============================================================
     最近文件
     ============================================================ */
  function upsertRecentFile(meta) {
    const idx = state.recentFiles.findIndex((f) => f.name === meta.name);
    if (idx >= 0) state.recentFiles.splice(idx, 1);
    state.recentFiles.unshift({
      name: meta.name,
      lastOpened: meta.lastOpened || new Date().toISOString(),
      mtime: meta.mtime || 0,
      size: meta.size || 0,
      handleKey: meta.handleKey || null,
      isDirectory: !!meta.isDirectory,
      isMigrated: !!meta.isMigrated,
      // v8：仅本次会话有效（拖入的文件，无 handle 不可持久化）
      isEphemeral: !!meta.isEphemeral,
    });
    state.recentFiles = state.recentFiles.slice(0, 20);
  }

  async function removeRecentFile(name) {
    const f = state.recentFiles.find((x) => x.name === name);
    if (f && f.handleKey) {
      try {
        await fsDel(f.handleKey);
      } catch (e) {
        console.warn("删除 handle 失败", e);
      }
    }
    state.recentFiles = state.recentFiles.filter((f) => f.name !== name);
    if (state.currentFileName === name) {
      state.currentFileName = null;
      // v10：移除当前文件后，文件路径显示回到"仅浏览器内"
      state.jsonFileName = null;
      state.directoryName = null;
      for (const pid of PAGE_IDS) {
        state.pages[pid] = makePageState();
      }
      state.sheetsRaw = [];
    }
    save();
    updateFilePathDisplay();
  }

  /* ============================================================
     状态访问 - 简化模板
     ============================================================ */
  function curPage() {
    return state.pages[state.currentPage];
  }
  function curPageDef() {
    return PAGES[state.currentPage];
  }
  function curItem() {
    const p = curPage();
    return p.items.find((it) => it.id === p.currentItemId) || null;
  }
  function curSheet() {
    return curPage().currentSheet;
  }
  function getSortedItems() {
    const p = curPage();
    const def = curPageDef();
    const sheet = p.currentSheet;
    const arr = sheet
      ? p.items.filter((it) => !sheet || it.sheet === sheet)
      : p.items.slice();
    // v18：伏笔页用独立的 fsSort（避免和章节 sort 混用）
    const sortDir = state.currentPage === "foreshadowing"
      ? (state.ui.fsSort === "asc" ? "asc" : "desc")
      : (state.ui.sort === "asc" ? "asc" : "desc");
    arr.sort((a, b) => {
      const cmp = compareChapterNo(def.sortKey(a), def.sortKey(b));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }

  // v18：按状态筛选（用于伏笔列表）
  // filter: "all" | "未回收" | "部分回收" | "已回收"
  function getFilteredItems() {
    const sorted = getSortedItems();
    const filter = state.ui.fsStatusFilter;
    if (!filter || filter === "all") return sorted;
    return sorted.filter((it) => (it.status || FS_STATUS_DEFAULT) === filter);
  }
  // 找章节中最大的 no（只考虑数字序号的；纯文字"序章/楔子"等不参与 max）
  function nextNoInCurrentSheet() {
    const p = curPage();
    const sheet = p.currentSheet;
    const list = sheet
      ? p.items.filter((it) => it.sheet === sheet)
      : p.items;
    let max = 0;
    for (const it of list) {
      const n = parseChapterNo(it.no).num;
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  /* ============================================================
     Sheet 分类
     ============================================================ */
  function classifySheet(name, header) {
    for (const pid of PAGE_IDS) {
      const def = PAGES[pid];
      if (def.matchName(name)) return pid;
    }
    for (const pid of PAGE_IDS) {
      const def = PAGES[pid];
      if (def.matchHeaders(header)) return pid;
    }
    return null; // 未分类
  }

  function unclassifiedLabel() {
    return "未分类";
  }
  function pageBadge(pid) {
    if (!pid) return unclassifiedLabel();
    return PAGES[pid] ? PAGES[pid].label : unclassifiedLabel();
  }

  /* ============================================================
     xlsx 解析
     ============================================================ */
  function unpackCell(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map(unpackCell).join("");
    if (typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      if (v.richText) return v.richText.map((r) => r.text || "").join("");
      if (v instanceof Date) {
        try {
          return v.toISOString().slice(0, 10);
        } catch (_) {
          return String(v);
        }
      }
      try {
        return JSON.stringify(v);
      } catch (_) {
        return String(v);
      }
    }
    return String(v);
  }

  // header: 列名数组；candidates: 候选关键词数组
  // exactOnly: true 时只做完全相等匹配（用户要求"只识别这 5 个关键词"时使用，
  //   否则模糊匹配会让"状态"误匹配到"回收状态"、"名称"误匹配到"伏笔名称"）
  function findColumnIndex(header, candidates, exactOnly = false) {
    const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
    const nHeader = header.map(norm);
    const nCands = candidates.map(norm);
    for (let i = 0; i < nHeader.length; i++) {
      if (nCands.includes(nHeader[i])) return i;
    }
    if (exactOnly) return -1;
    const hits = [];
    for (let i = 0; i < nHeader.length; i++) {
      const h = nHeader[i];
      if (!h) continue;
      for (const c of nCands) {
        if (h.includes(c) || c.includes(h)) {
          hits.push(i);
          break;
        }
      }
    }
    if (hits.length === 1) return hits[0];
    return -1;
  }

  // 通用行解析 - 用 pageId 的字段定义
  function parseRowsForPage(rows2d, pageId) {
    const def = PAGES[pageId];
    if (!def) return { rows: [], columns: null };
    if (!rows2d || rows2d.length === 0) return { rows: [], columns: null };
    const header = rows2d[0].map((c) => unpackCell(c).trim());
    const dataRows = rows2d.slice(1);
    const fieldKeys = Object.keys(def.fields);
    const columns = {};
    // v13：伏笔管理页面要求严格只识别 5 个指定字段名（不做模糊匹配）
    const exactOnly = pageId === "foreshadowing";
    for (const key of fieldKeys) {
      columns[key] = findColumnIndex(header, def.fields[key], exactOnly);
    }
    const out = [];
    const allMissing = fieldKeys.every((k) => (columns[k] | 0) < 0);
    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      if (!r || r.every((c) => unpackCell(c).trim() === "")) continue;
      const o = { _line: i + 2, _error: null };
      if (allMissing) {
        o._error = `表头缺少关键列（当前表头：${header.join(" | ")}）`;
        out.push(o);
        continue;
      }
      const data = {};
      let hasAny = false;
      for (const key of fieldKeys) {
        const idx = columns[key];
        if (idx < 0) {
          data[key] = "";
        } else {
          const v = unpackCell(r[idx]).trim();
          if (v) hasAny = true;
          data[key] = v;
        }
      }
      if (!hasAny) continue;
      // no 字段：能提取出数字就提（如"第12章"→12），纯汉字无数字保留原字符串（"序章"/"楔子"）
      if (columns.no >= 0) {
        const trimmed = String(data.no || "").trim();
        if (!trimmed) {
          data.no = 0;
        } else {
          const parsed = parseChapterNo(trimmed);
          if (parsed.hasNum && Number.isFinite(parsed.num)) {
            // 提取出数字（"12"/"第12章"/"Chapter 5"/"第一章" 全部归一为 number）
            data.no = parsed.num;
          } else {
            // 纯汉字无数字（"序章"/"楔子"/"番外"）→ 保留原字符串，sortKey 负责按 str 排序
            data.no = trimmed;
          }
        }
      } else {
        data.no = 0;
      }
      Object.assign(o, data);
      out.push(o);
    }
    return {
      rows: out,
      columns: { ...columns, header },
    };
  }

  // v13：从 JSON 数组解析（每项是一个对象，keys 是字段名）
  // - 用 findColumnIndex 模糊匹配 def.fields 里的关键词
  // - no 字段同样走 parseChapterNo 提取数字
  // - 输出结构与 parseRowsForPage 一致：{rows, columns}
  //   columns.header 是识别出的字段名（按 def.fields 顺序）
  //   columns[key] 是该字段在原始 JSON 数组里的"匹配列索引"（实际指 JSON 数组第几项的 keys 顺序）
  function parseJsonArrayForPage(jsonArray, pageId) {
    const def = PAGES[pageId];
    if (!def) return { rows: [], columns: null };
    if (!Array.isArray(jsonArray) || jsonArray.length === 0) {
      return { rows: [], columns: null };
    }
    // 用第一行（或第二个有意义的行）的 keys 作为 header
    const headerRow = (() => {
      for (const it of jsonArray) {
        if (it && typeof it === "object" && !Array.isArray(it)) {
          return Object.keys(it);
        }
      }
      return [];
    })();
    if (headerRow.length === 0) return { rows: [], columns: null };
    const fieldKeys = Object.keys(def.fields);
    // v13：伏笔管理页面要求严格只识别 5 个指定字段名（不做模糊匹配），
    // 避免"状态"误匹配到"回收状态"、"名称"误匹配到"伏笔名称"
    const columns = {};
    const exactOnly = pageId === "foreshadowing";
    for (const key of fieldKeys) {
      const idx = findColumnIndex(headerRow, def.fields[key], exactOnly);
      // 找不到就当 -1
      columns[key] = idx;
    }
    // 没有任何字段命中 → 该 JSON 数组不属于这个 page
    const anyHit = fieldKeys.some((k) => (columns[k] | 0) >= 0);
    if (!anyHit) return { rows: [], columns: { ...columns, header: headerRow } };
    const out = [];
    for (let i = 0; i < jsonArray.length; i++) {
      const item = jsonArray[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const o = { _line: i + 1, _error: null };
      const data = {};
      let hasAny = false;
      for (const key of fieldKeys) {
        const idx = columns[key];
        if (idx < 0) {
          data[key] = "";
        } else {
          const keyName = headerRow[idx];
          const v = item[keyName];
          const s = v == null ? "" : (typeof v === "string" ? v.trim() : String(v).trim());
          if (s) hasAny = true;
          data[key] = s;
        }
      }
      if (!hasAny) continue;
      // no 字段：能提取出数字就提（如"第12章"→12），纯汉字无数字保留原字符串
      if (columns.no >= 0) {
        const trimmed = String(data.no || "").trim();
        if (!trimmed) {
          data.no = 0;
        } else {
          const parsed = parseChapterNo(trimmed);
          if (parsed.hasNum && Number.isFinite(parsed.num)) {
            data.no = parsed.num;
          } else {
            data.no = trimmed;
          }
        }
      } else {
        data.no = 0;
      }
      Object.assign(o, data);
      out.push(o);
    }
    return {
      rows: out,
      columns: { ...columns, header: headerRow },
    };
  }

  // v13：尝试把整段文本解析为 JSON 数组
  // - 整段能 parse → 视为 JSON 数组
  // - 整段 parse 失败 → 尝试按行 parse（JSON Lines / 单 JSON 对象）
  // - 都失败 → 返回 null（调用方 fall back 到分隔符逻辑）
  function tryParseJsonText(text) {
    if (!text || !text.trim()) return null;
    const trimmed = text.trim();
    // 快速判断：必须以 [ 或 { 开头
    const first = trimmed[0];
    if (first !== "[" && first !== "{") return null;
    // 1) 整段 parse
    try {
      const v = JSON.parse(trimmed);
      if (Array.isArray(v)) return v;
      // 单个 JSON 对象 → 包装成数组
      if (v && typeof v === "object") return [v];
      return null;
    } catch (_) {}
    // 2) JSON Lines
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return null;
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
      try {
        const v = JSON.parse(t);
        if (Array.isArray(v)) out.push(...v);
        else if (v && typeof v === "object") out.push(v);
        else return null;
      } catch (_) {
        return null;
      }
    }
    return out.length > 0 ? out : null;
  }

  function parseXlsxAllSheets(ab) {
    if (!window.XLSX) throw new Error("xlsx 解析库未加载");
    const wb = XLSX.read(new Uint8Array(ab), {
      type: "array",
      cellDates: true,
      cellNF: true,
    });
    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      throw new Error("xlsx 内没有可用的 sheet");
    }
    const out = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const rows2d = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
        raw: true,
      });
      const header = (rows2d[0] || []).map((c) => unpackCell(c).trim());
      const page = classifySheet(name, header);
      const parsed = page ? parseRowsForPage(rows2d, page) : { rows: [], columns: { header } };
      // 至少有一个字段被识别出来才算"有效"
      const ok = !!page && !!parsed.columns && Object.values(parsed.columns).some(
        (v, i) => i < Object.keys(parsed.columns).length - 1 && v >= 0
      );
      out.push({
        name,
        rows2d,
        columns: parsed.columns,
        rowCount: rows2d.length,
        ok,
        parsedRows: parsed.rows,
        page,
      });
    }
    return { sheets: out };
  }

  // 把 sheets 数组塞进 state（按 page 归类）
  function applySheetsToState(sheets) {
    // 清空所有 page 的 sheets
    for (const pid of PAGE_IDS) {
      state.pages[pid].sheets = [];
      state.pages[pid].items = [];
      state.pages[pid].currentSheet = null;
    }
    state.sheetsRaw = [];
    for (const s of sheets) {
      const entry = {
        name: s.name,
        rows2d: s.rows2d,
        columns: s.columns,
        rowCount: s.rowCount,
        ok: s.ok,
        page: s.page, // null 表示未分类
      };
      state.sheetsRaw.push(entry);
      if (s.page && PAGES[s.page]) {
        state.pages[s.page].sheets.push({
          name: s.name,
          columns: s.columns,
          rowCount: s.rowCount,
          ok: s.ok,
        });
        if (s.ok) {
          for (const r of s.parsedRows) {
            if (r._error) continue;
            const item = PAGES[s.page].makeItem(r, s.name);
            state.pages[s.page].items.push(item);
          }
        }
      }
    }
    // 为每个有 sheet 的 page 选默认 sheet
    for (const pid of PAGE_IDS) {
      const p = state.pages[pid];
      if (p.sheets.length === 0) continue;
      const okSheets = p.sheets.filter((x) => x.ok);
      const sorted = okSheets.length
        ? okSheets.sort((a, b) => {
            const ca = p.items.filter((it) => it.sheet === a.name).length;
            const cb = p.items.filter((it) => it.sheet === b.name).length;
            return cb - ca;
          })
        : p.sheets;
      p.currentSheet = sorted[0]?.name || null;
      // 选中第一个 item
      const first = getSortedItemsForPage(pid)[0];
      p.currentItemId = first ? first.id : null;
    }
    // 如果 currentPage 上没东西，切到第一个有数据的 page
    if (!curPage().sheets.length) {
      for (const pid of PAGE_IDS) {
        if (state.pages[pid].sheets.length > 0) {
          state.currentPage = pid;
          break;
        }
      }
    }
  }

  function getSortedItemsForPage(pid) {
    const p = state.pages[pid];
    const def = PAGES[pid];
    if (!p || !def) return [];
    const sheet = p.currentSheet;
    const arr = sheet
      ? p.items.filter((it) => it.sheet === sheet)
      : p.items.slice();
    arr.sort((a, b) => {
      const cmp = compareChapterNo(def.sortKey(a), def.sortKey(b));
      return state.ui.sort === "asc" ? cmp : -cmp;
    });
    return arr;
  }


  /* ============================================================
     渲染
     ============================================================ */
  // v10：底部「文件路径」显示（替代原来的数据源下拉菜单）
  // ——展示「实际写入目标」：<dirname>/<filename>（浏览器不暴露绝对路径，只能拿到 basename）
  // ——不要显示「导入的源文件」，因为浏览器对拖入文件没有写权限，
  // 启用自动写盘后实际写入的是另一个新文件，跟原文件是两个东西。
  function updateFilePathDisplay() {
    // v10：章节和伏笔编辑器各有独立的 file-path 元素（id 不同避免重复）
    const els = document.querySelectorAll("#ch-file-path, #fs-file-path");
    if (!els || els.length === 0) return;

    const fileName = state.jsonFileName || state.currentFileName || null;
    const dirName = state.directoryName || null;
    const hasDirHandle = !!state.directoryHandleKey;
    const hasJsonHandle = !!state.jsonHandleKey;

    let displayText, tooltip, mode;
    if (fileName && dirName) {
      // 两个都知道：显示 dirname/filename
      displayText = `${dirName}/${fileName}`;
      tooltip = `保存时写入：${dirName}/${fileName}\n（启用自动写盘后这里就是实际写入目标，跟原导入文件可能不同）`;
      mode = "dir";
    } else if (fileName) {
      // 只有文件名
      displayText = fileName;
      if (hasJsonHandle || hasDirHandle) {
        tooltip = `保存目标：${fileName}（目录权限待恢复）`;
        mode = "file-stale";
      } else {
        tooltip = `保存目标：${fileName}（未配置写盘目录，数据仅在浏览器内）`;
        mode = "file-ephemeral";
      }
    } else {
      displayText = "— 数据仅在浏览器内 —";
      tooltip = "尚未打开任何文件。点工具栏的「打开」按钮选择 .xlsx 或 .json";
      mode = "none";
    }

    els.forEach((el) => {
      el.textContent = displayText;
      el.title = tooltip;
      el.dataset.mode = mode;
    });
  }

  // 兼容旧名：保留 renderFileSelect 作为 renderGlobal 的入口
  // ——以前负责下拉菜单的渲染，v10 改名为 updateFilePathDisplay
  function renderFileSelect() {
    updateFilePathDisplay();
  }

  function renderNavTabs() {
    const wrap = $("#nav-tabs");
    if (!wrap) return;
    if (PAGE_IDS.length === 0) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = PAGE_IDS.map((pid) => {
      const def = PAGES[pid];
      const p = state.pages[pid];
      const count = p.items.length;
      const active = pid === state.currentPage ? "active" : "";
      return `<button class="nav-tab ${active}" data-page="${pid}" role="tab" aria-selected="${pid === state.currentPage}"><span class="nav-tab-icon">${def.icon}</span><span class="nav-tab-label">${escapeHtml(def.label)}</span><span class="nav-tab-count">${count}</span></button>`;
    }).join("");
    $$(".nav-tab", wrap).forEach((b) =>
      b.addEventListener("click", () => {
        const pid = b.dataset.page;
        if (!pid || pid === state.currentPage) return;
        // v7：切换页面（章节 ↔ 伏笔）前先保存当前编辑器的输入
        try { saveCurrentItem(); } catch (_) {}
        state.currentPage = pid;
        save();
        renderAll();
      })
    );
  }

  function renderSheetTabs() {
    const wrap = $("#sheet-tabs");
    if (!wrap) return;
    const p = curPage();
    if (!state.currentFileName || !p || p.sheets.length === 0) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      return;
    }
    wrap.hidden = false;
    const counts = {};
    for (const it of p.items) {
      counts[it.sheet] = (counts[it.sheet] || 0) + 1;
    }
    wrap.innerHTML = p.sheets
      .map((s) => {
        const active = s.name === p.currentSheet ? "active" : "";
        const count = counts[s.name] || 0;
        const badge = !s.ok
          ? `<span class="sheet-tab-count" title="该 sheet 没有匹配本章面的表头">⚠</span>`
          : count > 0
            ? `<span class="sheet-tab-count">${count}</span>`
            : "";
        return `<button class="sheet-tab ${active}" data-sheet="${escapeHtml(s.name)}" role="tab" aria-selected="${s.name === p.currentSheet}">${escapeHtml(s.name)}${badge}</button>`;
      })
      .join("");
    $$(".sheet-tab", wrap).forEach((b) =>
      b.addEventListener("click", () => {
        const name = b.dataset.sheet;
        if (!name || name === curPage().currentSheet) return;
        // v7：切 sheet 前先保存当前编辑器的输入
        try { saveCurrentItem(); } catch (_) {}
        curPage().currentSheet = name;
        // 切到当前 sheet 的第一个 item
        const first = getSortedItems()[0];
        curPage().currentItemId = first ? first.id : null;
        save();
        renderAll();
      })
    );
  }

  // 列表渲染统一走"页面"——按 currentPage 路由到具体的列表渲染
  function renderChapterList() {
    const list = $("#chapter-list");
    if (!list) return;
    const p = curPage();
    const items = getSortedItems();
    list.className = "chapter-list";
    list.innerHTML = items
      .map((it) => {
        const wc = charCount(it.content);
        return `
          <li class="ch-item ${it.id === p.currentItemId ? "active" : ""}" data-id="${escapeHtml(it.id)}">
            <span class="ch-no">${escapeHtml(String(it.no))}</span>
            <span class="ch-title">${escapeHtml(it.title || "（无标题）")}</span>
            <span class="ch-meta">${wc}字</span>
            <button class="ch-delete" data-id="${escapeHtml(it.id)}" title="删除该章节" aria-label="删除该章节" type="button">×</button>
          </li>`;
      })
      .join("");
    const count = $("#chapter-count");
    if (count) count.textContent = `${items.length} 章`;
    const sortLabel = $("#sort-label");
    if (sortLabel) sortLabel.textContent = state.ui.sort === "asc" ? "正序" : "倒序";
  }

  function renderFsList() {
    const list = $("#fs-list");
    if (!list) return;
    const p = curPage();
    // v18：列表用「筛选 + 排序」结果
    const items = getFilteredItems();
    // v18：同步排序按钮文字
    const sortLabel = $("#fs-sort-label");
    if (sortLabel) sortLabel.textContent = state.ui.fsSort === "asc" ? "正序" : "倒序";
    // v18：同步状态筛选按钮 active 态
    const seg = $("#seg-fs-status");
    if (seg) {
      seg.querySelectorAll(".seg-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.fsStatus === state.ui.fsStatusFilter);
      });
    }
    list.className = "fs-list";
    list.innerHTML = items
      .map((it, idx) => {
        const status = it.status || FS_STATUS_DEFAULT;
        // v17：状态 class 映射（未回收 / 部分回收 / 已回收）
        const cls =
          status === "已回收"
            ? "fs-status-resolved"
            : status === "部分回收"
              ? "fs-status-partial"
              : "fs-status-unresolved";
        // v15：列表项横向 3 列 [伏笔编号 / 伏笔名称 / 状态]
        // 序号 = 当前 sheet 内按 fsNo 排序后的 1-based 索引（渲染层算，不存数据）
        const displayNo = idx + 1;
        return `
          <li class="fs-item ${it.id === p.currentItemId ? "active" : ""}" data-id="${escapeHtml(it.id)}">
            <span class="fs-cell fs-col-fsno" title="${escapeHtml(it.fsNo || "—")}">${escapeHtml(it.fsNo || "—")}</span>
            <span class="fs-cell fs-col-name" title="${escapeHtml(it.name || "")}">${escapeHtml(it.name || "（无名）")}</span>
            <span class="fs-cell fs-col-status ${cls}">${escapeHtml(status)}</span>
            <button class="fs-delete" data-id="${escapeHtml(it.id)}" title="删除该伏笔" aria-label="删除该伏笔" type="button">×</button>
          </li>`;
      })
      .join("");
    const count = $("#fs-count");
    if (count) count.textContent = `${items.length} 条`;
  }

  function renderChapterEditor() {
    const it = curItem();
    const empty = $("#editor-empty");
    const editor = $("#editor");
    if (!empty || !editor) return;
    if (!it) {
      empty.hidden = false;
      editor.hidden = true;
      empty.innerHTML = PAGES.chapter.emptyStateHtml();
      return;
    }
    empty.hidden = true;
    editor.hidden = false;
    editor.innerHTML = `
      <div class="editor-meta">
        <div class="meta-field">
          <label>章节号</label>
          <input id="ch-no" type="text" class="readonly-field" readonly value="${escapeHtml(String(it.no ?? ""))}" title="章节号不可编辑，由导入数据决定" />
        </div>
        <div class="meta-field meta-title">
          <label>章节名称</label>
          <input id="ch-title" type="text" value="${escapeHtml(it.title || "")}" placeholder="给本章起个名字" />
        </div>
      </div>
      <div class="editor-body">
        <label class="body-label">文章内容</label>
        <textarea id="ch-content" placeholder="正文…">${escapeHtml(normalizeParagraphs(it.content || ""))}</textarea>
        <div class="body-stats">
          <div class="stats-left">
            <span id="word-count" class="muted">${charCount(it.content)} 字</span>
            <span id="save-status" class="muted"></span>
          </div>
          <span id="ch-file-path" class="muted file-path" title=""></span>
        </div>
      </div>`;
    bindChapterEditorEvents();
    // v10.1：editor.innerHTML 重写后 #ch-file-path 是新元素，
    // 必须补一次 updateFilePathDisplay()，否则保存/切章节后路径消失
    updateFilePathDisplay();
  }

  function renderFsEditor() {
    const it = curItem();
    const empty = $("#fs-editor-empty");
    const editor = $("#fs-editor");
    if (!empty || !editor) return;
    if (!it) {
      empty.hidden = false;
      editor.hidden = true;
      empty.innerHTML = PAGES.foreshadowing.emptyStateHtml();
      return;
    }
    empty.hidden = true;
    editor.hidden = false;
    const opts = FS_STATUS_OPTIONS.map(
      (s) =>
        `<option value="${escapeHtml(s)}" ${it.status === s ? "selected" : ""}>${escapeHtml(s)}</option>`
    ).join("");
    // v14：编辑/查看态标记
    const isEditing = !!state.ui.fsEditing;
    const readonlyAttr = isEditing ? "" : "readonly";
    const disabledAttr = isEditing ? "" : "disabled";
    const mainClass = isEditing ? "" : "readonly";
    // 渲染当前伏笔的履历（按提及章节排序）
    const recordsHtml = renderFsRecordRows(it.id);
    editor.innerHTML = `
      <div class="editor-meta editor-meta-fs ${mainClass}">
        <!-- v18：「编辑」按钮挪到「伏笔编号」前 -->
        <div class="meta-actions meta-actions-first">
          <button id="btn-fs-toggle" class="secondary-btn" title="${isEditing ? "切到查看态（履历原文可点击跳转）" : "切到编辑态（可改伏笔字段、新增/编辑履历）"}">${isEditing ? "✓ 完成编辑" : "✎ 编辑"}</button>
        </div>
        <div class="meta-field meta-fsno">
          <label>伏笔编号</label>
          <input id="fs-fsno" type="text" ${readonlyAttr} value="${escapeHtml(it.fsNo || "")}" placeholder="如：FS-001" />
        </div>
        <div class="meta-field meta-title">
          <label>伏笔名称</label>
          <input id="fs-name" type="text" ${readonlyAttr} value="${escapeHtml(it.name || "")}" placeholder="给伏笔起个名字" />
        </div>
        <div class="meta-field">
          <label>状态</label>
          <select id="fs-status" ${disabledAttr}>${opts}</select>
        </div>
        <div class="meta-actions meta-actions-last">
          <button id="btn-fs-save" class="primary-btn" ${isEditing ? "" : "hidden"}>保存</button>
          <!-- v17：编辑按钮旁的"删除"按钮移除——删除统一在左侧列表的 .fs-delete 叉号触发，避免重复入口 -->
        </div>
      </div>
      <div class="editor-body editor-body-fs ${mainClass}">
        <div class="fs-records-section">
          <div class="fs-records-header">
            <span class="fs-records-title">📋 伏笔履历</span>
            <span class="fs-records-meta muted">${isEditing ? `${getFsRecordsByFsNo(it).length} 条 · 按提及章节` : `${getFsRecordsByFsNo(it).length} 条 · 点击原文描述可跳转`}</span>
            <!-- v18：履历排序（按提及章节正/倒序） -->
            <button id="btn-fs-record-sort" class="link-btn" title="切换正/倒序（按提及章节）">${state.ui.fsRecordSort === "asc" ? "正序" : "倒序"}</button>
            <button id="btn-fs-add-record" class="link-btn" ${isEditing ? "" : "hidden"}>+ 新增履历</button>
          </div>
          <div class="fs-records-list" id="fs-records-list">
            ${recordsHtml || `<div class="fs-records-empty muted">${isEditing ? "还没有履历，点上方「+ 新增履历」添加" : "还没有履历"}</div>`}
          </div>
        </div>
        <div class="body-stats">
          <div class="stats-left">
            <span id="fs-save-status" class="muted"></span>
          </div>
          <span id="fs-file-path" class="muted file-path" title=""></span>
        </div>
      </div>`;
    bindFsEditorEvents();
    // v10.1：editor.innerHTML 重写后 #fs-file-path 是新元素，
    // 必须补一次 updateFilePathDisplay()，否则保存/切伏笔后路径消失
    updateFilePathDisplay();
  }

  // v14：获取当前伏笔的所有履历（按"提及章节"排序）
  // v18：增加正/倒序切换 (state.ui.fsRecordSort)
  function getFsRecordsByFsNo(item) {
    if (!item) return [];
    const fsNo = String(item.fsNo || "").trim();
    const p = state.pages.foreshadowing;
    if (!Array.isArray(p.records)) p.records = [];
    const list = p.records.filter(
      (r) => String(r.fsNo || "").trim() === fsNo
    );
    const dir = state.ui.fsRecordSort === "desc" ? "desc" : "asc";
    list.sort((a, b) => {
      const ka = PAGES.foreshadowing.recordSortKey(a);
      const kb = PAGES.foreshadowing.recordSortKey(b);
      const cmp = compareChapterNo(ka, kb);
      return dir === "asc" ? cmp : -cmp;
    });
    return list;
  }

  // v14：渲染履历列表 HTML
  //  - 编辑态：每行可编辑（提到章节 / 原文描述）+ 删除按钮
  //  - 查看态：原文描述 clickable，hover 高亮，点击跳转章节
  function renderFsRecordRows(itemId) {
    const item = state.pages.foreshadowing.items.find((x) => x.id === itemId);
    if (!item) return "";
    const records = getFsRecordsByFsNo(item);
    const isEditing = !!state.ui.fsEditing;
    if (records.length === 0) return "";
    return records
      .map((r) => {
        // v18：编辑态 & 查看态 - 都不再显示"提及章节"标题文字,只显示数字
        //  - 数字解析自 r.setup (parseChapterNo)
        //  - 数字字号放大 2 倍 (~2em),与右侧文本框高度差不多
        //  - 原文描述(label) 保留,跟"右侧文本框高差不多"的对照需要
        const setupParsed = parseChapterNo(r.setup || "");
        const setupNum = setupParsed.hasNum && Number.isFinite(setupParsed.num)
          ? String(setupParsed.num)
          : "";
        if (isEditing) {
          return `
            <div class="fs-record-row" data-record-id="${escapeHtml(r.id)}">
              <div class="fs-rec-col-setup">
                <input type="text" data-field="setup" value="${escapeHtml(r.setup || "")}" placeholder="如：第3章" class="fs-rec-setup-big" />
                <span class="fs-rec-setup-num" title="解析后的章节号">${escapeHtml(setupNum)}</span>
              </div>
              <div class="fs-rec-col-notes">
                <span class="muted small-label">原文描述</span>
                <textarea data-field="notes" rows="2" placeholder="原文描述…">${escapeHtml(r.notes || "")}</textarea>
              </div>
              <button class="fs-rec-delete" data-record-id="${escapeHtml(r.id)}" title="删除该履历" aria-label="删除该履历" type="button">×</button>
            </div>`;
        } else {
          // 查看态：原文描述 clickable
          return `
            <div class="fs-record-row readonly" data-record-id="${escapeHtml(r.id)}">
              <div class="fs-rec-col-setup">
                <span class="fs-rec-setup-num fs-rec-setup-num-static" title="${escapeHtml(r.setup || "")}">${escapeHtml(setupNum || "—")}</span>
              </div>
              <button class="fs-rec-notes-link" data-record-id="${escapeHtml(r.id)}" title="点击跳转到该章节">${escapeHtml(r.notes || "（无描述）")}</button>
            </div>`;
        }
      })
      .join("");
  }

  function bindChapterEditorEvents() {
    const it = curItem();
    if (!it) return;
    const chContent = $("#ch-content");
    const chNo = $("#ch-no");
    const chTitle = $("#ch-title");
    chContent?.addEventListener("input", () => {
      const len = charCount(chContent.value);
      const wc = $("#word-count");
      if (wc) wc.textContent = `${len} 字`;
      // 实时把正文写回 state，并更新左侧列表当前项的字数（不等保存）
      // ——避免每次都调 renderAll() 重渲染整个列表导致 textarea 焦点/选区丢失
      it.content = chContent.value;
      const meta = document.querySelector(".ch-item.active .ch-meta");
      if (meta) meta.textContent = `${len}字`;
      debouncedPushHistory();
      // 让光标始终停留在视口上方 1/3 处，留出下方 2/3 的"留白"
      // 覆盖：回车后自动向上滚（需求 4）+ 输入时下方填充空白保持视野中央（需求 5）
      ensureCaretInView(chContent);
    });
    chNo?.addEventListener("input", debouncedPushHistory);
    chTitle?.addEventListener("input", debouncedPushHistory);
  }
  function bindFsEditorEvents() {
    const it = curItem();
    if (!it) return;
    // v14：主表字段（除 no 只读外）实时写回 state
    const fsFsno = $("#fs-fsno");
    const fsName = $("#fs-name");
    const fsStatus = $("#fs-status");
    const syncMeta = () => {
      it.fsNo = String(fsFsno?.value ?? it.fsNo ?? "").trim();
      it.name = fsName?.value ?? it.name;
      it.status = fsStatus?.value ?? it.status;
      // 同步左侧列表项
      const li = document.querySelector(`.fs-item[data-id="${CSS.escape(it.id)}"]`);
      if (li) {
        const fsnoCell = li.querySelector(".fs-col-fsno");
        const nameCell = li.querySelector(".fs-col-name");
        const statusCell = li.querySelector(".fs-col-status");
        if (fsnoCell) fsnoCell.textContent = it.fsNo || "—";
        if (nameCell) nameCell.textContent = it.name || "（无名）";
        if (statusCell) {
          statusCell.textContent = it.status || FS_STATUS_DEFAULT;
          statusCell.className = "fs-cell fs-col-status " + (
            it.status === "已回收" ? "fs-status-resolved" :
            it.status === "部分回收" ? "fs-status-partial" : "fs-status-unresolved"
          );
        }
      }
      debouncedPushHistory();
    };
    [fsFsno, fsName, fsStatus].forEach((el) => {
      el?.addEventListener("input", syncMeta);
      el?.addEventListener("change", syncMeta);
    });
    // v14：编辑/查看态切换
    $("#btn-fs-toggle")?.addEventListener("click", () => {
      // 切回查看态时如果有未保存的输入，自动写回
      if (state.ui.fsEditing) {
        saveCurrentItem();
      }
      state.ui.fsEditing = !state.ui.fsEditing;
      save();
      renderFsEditor();
      // 重新挂事件（renderFsEditor 会重新生成 DOM）
      // 注：renderFsEditor 内部已经调用了 bindFsEditorEvents
      // 但保存按钮的逻辑在事件委托里（bindEditorButtons），无需重绑
    });
    // v18：履历排序（按提及章节正/倒序）
    $("#btn-fs-record-sort")?.addEventListener("click", () => {
      state.ui.fsRecordSort = state.ui.fsRecordSort === "asc" ? "desc" : "asc";
      save();
      renderFsEditor();
    });
    // v14：新增履历
    $("#btn-fs-add-record")?.addEventListener("click", () => {
      if (!Array.isArray(state.pages.foreshadowing.records)) {
        state.pages.foreshadowing.records = [];
      }
      const newRec = PAGES.foreshadowing.makeRecord(
        { fsNo: it.fsNo, setup: "", notes: "" },
        it.sheet
      );
      state.pages.foreshadowing.records.push(newRec);
      // 不立刻 save()，等用户编辑完输入框内容再统一存
      renderFsEditor();
      // 聚焦到新行的 setup 输入
      setTimeout(() => {
        const row = document.querySelector(
          `.fs-record-row[data-record-id="${CSS.escape(newRec.id)}"]`
        );
        const input = row?.querySelector(".fs-rec-col-setup");
        if (input) {
          input.focus();
        }
      }, 30);
    });
    // v14：履历编辑（事件委托：input/textarea change 时写回 state）
    const list = $("#fs-records-list");
    list?.addEventListener("input", (e) => {
      const target = e.target;
      if (!target) return;
      const field = target.dataset?.field;
      const row = target.closest(".fs-record-row");
      const recId = row?.dataset?.recordId;
      if (!field || !recId) return;
      const rec = state.pages.foreshadowing.records.find(
        (r) => r.id === recId
      );
      if (rec) {
        rec[field] = target.value;
        debouncedPushHistory();
      }
    });
    // v14：删除履历
    list?.addEventListener("click", (e) => {
      const btn = e.target.closest(".fs-rec-delete");
      if (!btn) return;
      const recId = btn.dataset?.recordId;
      if (!recId) return;
      const idx = state.pages.foreshadowing.records.findIndex(
        (r) => r.id === recId
      );
      if (idx < 0) return;
      state.pages.foreshadowing.records.splice(idx, 1);
      save();
      pushHistory();
      renderFsEditor();
    });
    // v14：点击原文描述 → 跳转到章节
    list?.addEventListener("click", (e) => {
      const link = e.target.closest(".fs-rec-notes-link");
      if (!link) return;
      const recId = link.dataset?.recordId;
      if (!recId) return;
      const rec = state.pages.foreshadowing.records.find(
        (r) => r.id === recId
      );
      if (!rec) return;
      jumpToChapterForRecord(rec);
    });
  }

  // v14：点击履历的"原文描述"→ 跳转到对应章节并高亮匹配段
  // 流程：解析 setup（"第3章" / "Chapter 5" / "12"）→ 找到 chapter.items 里同 no 的项
  //     → 切到 chapter 页面 → 选中该章节 → 等渲染后用 overlay 在章节正文里高亮 notes
  function jumpToChapterForRecord(rec) {
    const setup = String(rec.setup || "").trim();
    const notes = String(rec.notes || "").trim();
    if (!setup && !notes) {
      toast("履历没有可定位的章节或原文", "warn");
      return;
    }
    // 1) 解析 setup → 找对应章节（先按章节号精确匹配，再按 sheet 内 fallback）
    const parsed = parseChapterNo(setup);
    const target = findChapterByNo(parsed.num, setup);
    if (!target) {
      toast(
        `未找到「${setup}」对应的章节（先在「章节」页创建章节）`,
        "warn",
        3000
      );
      return;
    }
    // 2) 切到 chapter 页面 + 选中该章节
    state.currentPage = "chapter";
    const cp = state.pages.chapter;
    cp.currentItemId = target.id;
    if (target.sheet) cp.currentSheet = target.sheet;
    save();
    renderAll();
    // 3) 等编辑器渲染完后，定位 textarea 并弹出高亮 overlay
    requestAnimationFrame(() => {
      const ta = $("#ch-content");
      if (!ta) return;
      // 尝试在章节正文里找 notes 字符串 → 选中 + 滚动到中央
      let match = null;
      if (notes) {
        const idx = ta.value.indexOf(notes);
        if (idx >= 0) {
          match = { start: idx, end: idx + notes.length };
        } else {
          // 部分匹配：取前 16 个非空字符
          const head = notes.slice(0, 16).trim();
          if (head) {
            const j = ta.value.indexOf(head);
            if (j >= 0) match = { start: j, end: j + head.length };
          }
        }
      }
      showChapterHighlight(target, match, setup, notes);
    });
  }

  // 按章节号找 chapter.items 里的目标
  // num 是 parseChapterNo 出来的数字（无数字时为 Infinity）
  // rawStr 是原文（用于 fallback，比如"序章"等纯汉字）
  function findChapterByNo(num, rawStr) {
    const list = state.pages.chapter.items || [];
    if (Number.isFinite(num)) {
      // 优先精确匹配数字
      const exact = list.find(
        (it) => Number(parseChapterNo(it.no).num) === num
      );
      if (exact) return exact;
    }
    // fallback：按原文字符串匹配
    if (rawStr) {
      const s = String(rawStr).trim();
      const byStr = list.find((it) => String(it.no).trim() === s);
      if (byStr) return byStr;
    }
    return null;
  }

  // v14：在章节内容上弹出"高亮 overlay"——把章节正文渲染到 overlay div，
  //     匹配位置用 <mark> 标黄。3 秒后自动关闭，ESC 也可关闭。
  function showChapterHighlight(target, match, setup, notes) {
    // 移除旧的 overlay
    const old = document.getElementById("chapter-highlight-overlay");
    if (old) old.remove();
    const content = String(target.content || "");
    if (!content) {
      toast(`章节「${target.title || target.no}」暂无正文`, "warn");
      return;
    }
    const overlay = document.createElement("div");
    overlay.id = "chapter-highlight-overlay";
    overlay.className = "highlight-overlay";
    // 把章节正文按匹配段分片渲染
    let bodyHtml;
    if (match && match.start < content.length) {
      const before = content.slice(0, match.start);
      const mid = content.slice(match.start, match.end);
      const after = content.slice(match.end);
      bodyHtml =
        escapeHtml(before) +
        '<mark class="highlight-mark">' +
        escapeHtml(mid) +
        "</mark>" +
        escapeHtml(after);
    } else {
      bodyHtml = escapeHtml(content);
    }
    overlay.innerHTML = `
      <div class="highlight-backdrop" data-close-overlay></div>
      <div class="highlight-card" role="dialog" aria-label="履历原文定位">
        <header class="highlight-header">
          <div class="highlight-meta">
            <span class="highlight-tag">📍 履历定位</span>
            <span class="highlight-target">第 ${escapeHtml(String(target.no))} 章 · ${escapeHtml(target.title || "（无标题）")}</span>
          </div>
          <div class="highlight-actions">
            ${match ? '<span class="highlight-match-info">✓ 已定位原文</span>' : '<span class="highlight-match-info muted">未在正文中精确匹配，按章节定位</span>'}
            <button class="icon-btn" data-close-overlay aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>
        <div class="highlight-context">
          <div class="highlight-context-row">
            <span class="highlight-label">提及章节：</span>
            <span class="highlight-value">${escapeHtml(setup || "—")}</span>
          </div>
          <div class="highlight-context-row">
            <span class="highlight-label">原文描述：</span>
            <span class="highlight-value">${escapeHtml(notes || "—")}</span>
          </div>
        </div>
        <pre class="highlight-body">${bodyHtml}</pre>
        <footer class="highlight-footer">
          <span class="muted">点击空白处或按 ESC 关闭（${match ? "匹配段已高亮" : "无匹配段"}）</span>
        </footer>
      </div>`;
    document.body.appendChild(overlay);
    // 滚到匹配段
    if (match) {
      requestAnimationFrame(() => {
        const mark = overlay.querySelector(".highlight-mark");
        if (mark) {
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }
    // 关闭逻辑
    const close = () => overlay.remove();
    overlay.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-overlay]")) close();
    });
    document.addEventListener(
      "keydown",
      function onEsc(e) {
        if (e.key === "Escape") {
          close();
          document.removeEventListener("keydown", onEsc);
        }
      }
    );
    // 30 秒兜底自动关闭
    setTimeout(close, 30000);
  }

  function renderTheme() {
    document.body.dataset.bg = state.theme.bg;
    document.body.dataset.accent = state.theme.accent;
    document.body.dataset.font = state.theme.font || "system";
    document.documentElement.style.setProperty(
      "--accent",
      ACCENT_COLORS[state.theme.accent] || ACCENT_COLORS.indigo
    );
    document.documentElement.style.setProperty(
      "--reading-font-size",
      `${state.theme.fontSize}px`
    );
    document.documentElement.style.setProperty(
      "--reading-line-height",
      state.theme.lineHeight
    );
    $$(".seg-btn[data-bg]").forEach((b) =>
      b.classList.toggle("active", b.dataset.bg === state.theme.bg)
    );
    $$(".seg-btn[data-accent]").forEach((b) =>
      b.classList.toggle("active", b.dataset.accent === state.theme.accent)
    );
    $$(".seg-btn[data-font]").forEach((b) =>
      b.classList.toggle("active", b.dataset.font === (state.theme.font || "system"))
    );
    $("#font-size").value = state.theme.fontSize;
    $("#font-size-val").textContent = state.theme.fontSize;
    $("#line-height").value = state.theme.lineHeight;
    $("#line-height-val").textContent = state.theme.lineHeight.toFixed(2);
    // 自动保存下拉高亮
    const cur = String(Number(state.theme.autosaveMs) || 0);
    $$(".seg-btn[data-autosave]").forEach((b) =>
      b.classList.toggle("active", b.dataset.autosave === cur)
    );
  }

  function renderNewItemButton() {
    // 文案统一由 curPageDef().newItemLabel 提供；
    // 由于 #btn-new 只在 chapter 视图、#btn-new-fs 只在 foreshadowing 视图，
    // 这里两者都更新一次（每个按钮只在自己视图显示），不影响。
    const def = curPageDef();
    const label = def.newItemLabel || "新增";
    const setLabel = (btn) => {
      if (!btn || typeof btn.querySelector !== "function") return;
      const span = btn.querySelector("span");
      if (span) span.textContent = label;
      btn.title = label;
    };
    setLabel($("#btn-new"));
    setLabel($("#btn-new-fs"));
  }

  function renderGlobal() {
    renderFileSelect();
    renderNavTabs();
    renderTheme();
  }

  function renderCurrentPage() {
    // 控制 page-view 显隐
    const pageChapter = $('[data-page-view="chapter"]');
    const pageFs = $('[data-page-view="foreshadowing"]');
    if (state.currentPage === "chapter") {
      if (pageChapter) pageChapter.hidden = false;
      if (pageFs) pageFs.hidden = true;
      renderSheetTabs();
      renderChapterList();
      renderChapterEditor();
    } else if (state.currentPage === "foreshadowing") {
      if (pageChapter) pageChapter.hidden = true;
      if (pageFs) pageFs.hidden = false;
      renderFsList();
      renderFsEditor();
    }
    renderNewItemButton();
  }

  function renderAll() {
    renderGlobal();
    renderCurrentPage();
  }


  /* ============================================================
     读文件 / 写文件
     ============================================================ */
  async function openFileByName(name) {
    const meta = state.recentFiles.find((f) => f.name === name);
    if (!meta) {
      toast("找不到该文件", "error");
      return;
    }
    if (meta.isMigrated || !meta.handleKey) {
      toast("该文件没有保存访问权限（来自旧版本数据），请重新选择", "error", 3000);
      $("#fs-banner").hidden = false;
      return;
    }
    const handle = await fsGet(meta.handleKey);
    if (!handle) {
      toast("该文件的访问权限已失效，请重新选择", "error");
      await removeRecentFile(name);
      renderAll();
      return;
    }
    const granted = await ensureReadPermission(handle, true);
    if (!granted) {
      toast("未授权读取文件", "error");
      $("#fs-banner").hidden = false;
      return;
    }
    await loadFromHandle(handle, meta);
  }

  async function loadFromHandle(handle, meta) {
    try {
      const lowerName = (handle.name || "").toLowerCase();
      if (lowerName.endsWith(".json")) {
        const file = await handle.getFile();
        await loadFromJsonFile(file);
        return;
      }
      const ab = await readFileAsArrayBuffer(handle);
      const { sheets } = parseXlsxAllSheets(ab);
      applySheetsToState(sheets);
      const desc = await describeFile(handle);
      state.currentFileName = handle.name;
      state.xlsxFileName = handle.name;
      // 首次/重新加载：也立即生成同名 .json（同目录；如无权限则下载）
      state.jsonFileName = jsonFileNameFrom(handle.name);
      state.jsonHandleKey = null;
      upsertRecentFile({
        name: handle.name,
        mtime: desc.mtime,
        size: desc.size,
        handleKey: meta?.handleKey || `file:${handle.name}`,
        isDirectory: false,
      });
      save();
      // 新文件覆盖了数据，纳入 history
      pushHistory();
      renderAll();
      // 异步生成 json 文件（不阻塞 UI）
      saveAsJson({ silent: true }).catch((e) =>
        console.warn("首次生成 json 失败", e)
      );
      // 统计哪些页有数据
      const summary = PAGE_IDS.map((pid) => {
        const n = state.pages[pid].items.length;
        return n > 0 ? `${PAGES[pid].label} ${n}` : null;
      }).filter(Boolean).join(" · ");
      toast(`已读取：${summary || "无有效条目"}`, "info", 1800);
    } catch (e) {
      console.error("读取失败", e);
      toast("读取失败：" + (e.message || e), "error", 3500);
    }
  }

  // 加载任意文件（xlsx / json），同时自动生成同名 .json（首次导入）
  async function loadFromFile(file) {
    const lowerName = (file.name || "").toLowerCase();
    try {
      if (lowerName.endsWith(".json")) {
        await loadFromJsonFile(file);
        return;
      }
      // xlsx / xlsm
      // 1) 覆盖确认 + 先把当前数据导出 json（避免覆盖丢失）
      const hasExistingData = hasAnyUserData();
      if (hasExistingData) {
        if (
          !confirm(
            `打开新文件会覆盖当前所有数据。\n\n点击「确定」：先把当前数据保存为 json，再导入新文件。\n点击「取消」：中止操作，保留当前数据。`
          )
        ) {
          return;
        }
        // 先把当前数据导出 json（不导出 xlsx）
        try {
          const r = await saveAsJson({ silent: true });
          if (r && r.ok && r.mode === "download") {
            toast(
              "已下载当前数据的 json 备份（请放到合适位置后，下次可从「打开文件」恢复）",
              "info",
              3000
            );
          }
        } catch (e) {
          console.warn("保存当前数据为 json 失败", e);
          toast("保存当前数据为 json 失败，已中止导入", "error", 3000);
          return;
        }
      }
      const ab = await file.arrayBuffer();
      const { sheets } = parseXlsxAllSheets(ab);
      applySheetsToState(sheets);
      // 检查是否有任何有效条目
      let total = 0;
      for (const pid of PAGE_IDS) total += state.pages[pid].items.length;
      if (total === 0) {
        toast("未能解析出任何条目，请检查表头是否匹配已注册的页面字段", "error", 4000);
        return;
      }
      state.currentFileName = file.name;
      state.xlsxFileName = file.name;
      // 首次导入：立即生成同名 .json（在同目录写一份；如无 handle 则下载）
      state.jsonFileName = jsonFileNameFrom(file.name);
      state.jsonHandleKey = null;
      // 把拖入的文件加入 recentFiles（isEphemeral=true：仅本次会话）
      upsertRecentFile({
        name: file.name,
        mtime: file.lastModified ? file.lastModified : 0,
        size: file.size || 0,
        handleKey: null,
        isDirectory: false,
        isEphemeral: true,
      });
      save();
      pushHistory();
      renderAll();
      // 异步生成 json 文件，不阻塞 UI
      saveAsJson({ silent: true }).catch((e) =>
        console.warn("首次生成 json 失败", e)
      );
      hideModal("modal-open-file");
      const summary = PAGE_IDS.map((pid) => {
        const n = state.pages[pid].items.length;
        return n > 0 ? `${PAGES[pid].label} ${n}` : null;
      }).filter(Boolean).join(" · ");
      toast(`已读取（本次会话）：${summary}`, "info", 1800);
      // v9：拖入 xlsx 后引导用户启用自动写盘（仅一次 / 文件）
      maybePromptEnableAutoSave();
    } catch (e) {
      console.error("读取失败", e);
      toast("读取失败：" + (e.message || e), "error", 3500);
    }
  }

  // 从 json 文件恢复（v7 自身 + v5 旧 dataSources 兼容）
  async function loadFromJsonFile(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.pages && !Array.isArray(data.chapters) && !Array.isArray(data.dataSources)) {
        toast("文件格式不对（不是有效的 Novel App JSON）", "error", 3500);
        return;
      }
      // v8：先弹覆盖确认；如有数据则先导出 json 备份再恢复
      const hasExistingData = hasAnyUserData();
      if (hasExistingData) {
        if (
          !confirm(
            `打开新文件会覆盖当前所有数据。\n\n点击「确定」：先把当前数据保存为 json，再导入新文件。\n点击「取消」：中止操作，保留当前数据。`
          )
        ) {
          return;
        }
        try {
          const r = await saveAsJson({ silent: true });
          if (r && r.ok && r.mode === "download") {
            toast(
              "已下载当前数据的 json 备份（请放到合适位置后，下次可从「打开文件」恢复）",
              "info",
              3000
            );
          }
        } catch (e) {
          console.warn("保存当前数据为 json 失败", e);
          toast("保存当前数据为 json 失败，已中止导入", "error", 3000);
          return;
        }
      } else {
        if (!confirm("导入 JSON 将覆盖当前所有数据，确定？")) return;
      }
      if (data.pages) {
        for (const pid of PAGE_IDS) {
          state.pages[pid] = data.pages[pid] || makePageState();
        }
        state.currentPage = data.currentPage || DEFAULT_PAGE;
      }
      if (Array.isArray(data.chapters) && !data.pages) {
        state.pages.chapter.items = data.chapters;
      }
      if (Array.isArray(data.sheetsRaw)) state.sheetsRaw = data.sheetsRaw;
      // 数据源是当前拖入的 json；data.currentFileName 仅作为「原 xlsx 名」保留，
      // 给「导出 xlsx」时命名用（避免下载文件叫 xxx.json.xlsx）。
      state.currentFileName = file.name;
      state.xlsxFileName = data.currentFileName || null;
      state.jsonFileName = data.jsonFileName || file.name;
      state.jsonHandleKey = data.jsonHandleKey || null;
      // v9：从 json 恢复 directoryHandleKey
      state.directoryHandleKey = data.directoryHandleKey || null;
      // v10：恢复 directoryName（旧数据为 null）
      state.directoryName = data.directoryName || null;
      // v9：恢复 autoSavePromptDismissed
      state._autoSavePromptDismissed = data.autoSavePromptDismissed || {};
      // v8：先恢复 recentFiles（保留 isEphemeral / isMigrated 等标志）。
      // 必须在 upsertRecentFile 之前——否则后面会被整体覆盖。
      // 跨设备 / 旧版本导出的 json 里 recentFiles 不一定包含 file.name，
      // 这里先把数据恢复，再用 upsertRecentFile 把当前 json 置顶。
      if (Array.isArray(data.recentFiles)) {
        state.recentFiles = data.recentFiles.map((f) => ({
          name: f.name,
          lastOpened: f.lastOpened || new Date().toISOString(),
          mtime: f.mtime || 0,
          size: f.size || 0,
          handleKey: f.handleKey || null,
          isDirectory: !!f.isDirectory,
          isMigrated: !!f.isMigrated,
          isEphemeral: !!f.isEphemeral,
        }));
      } else {
        state.recentFiles = [];
      }
      // v8.1 把拖入的 json 加进 recentFiles（isEphemeral=true），让下拉框能选中它
      upsertRecentFile({
        name: file.name,
        mtime: file.lastModified || 0,
        size: file.size || 0,
        handleKey: null,
        isDirectory: false,
        isEphemeral: true,
      });
      // v8.1 修：之前是 upsertRecentFile → state.recentFiles = data.recentFiles.map(...)
      // 顺序反了，导致跨设备 / 旧版本导出的 json 拖入后，state.recentFiles
      // 被 data.recentFiles 整体覆盖，刚 upsert 的 file.name 丢失——
      // 下拉框里看不到文件名（currentFileName 指到不存在的 option）。
      state.theme = { ...DEFAULT_THEME, ...(data.theme || {}) };
      state.ui = { sort: "asc", layout: { ...(state.ui.layout || {}) }, ...(data.ui || {}) };
      if (data.ui && data.ui.layout) state.ui.layout = data.ui.layout;
      if (Array.isArray(data.dataSources) && !data.pages) {
        // 极旧格式
        const target =
          data.dataSources.find((d) => d.id === data.currentDataSourceId) ||
          data.dataSources[0];
        if (target) {
          state.pages.chapter.items = (target.chapters || []).map((c) => ({
            id: c.id || uid("ch"),
            no: c.no ?? 0,
            title: c.title || "",
            content: c.content || "",
            sheet: c.sheet || "Sheet1",
          }));
          state.pages.chapter.currentItemId = null;
        }
      }
      save();
      pushHistory();
      renderAll();
      hideModal("modal-open-file");
      toast("已从 JSON 导入", "info", 1500);
    } catch (err) {
      console.error(err);
      toast("解析失败：文件不是有效 JSON", "error", 3500);
    }
  }

  /* ============================================================
     保存策略（v7 改造）
     - saveAsJson：日常保存。直接写同名 .json，毫秒级，无 SheetJS 开销
     - saveAsXlsx：导出 xlsx。手动触发（"导出 xlsx" 按钮），保留原逻辑
     - 首次导入 xlsx / 加载 handle 后会自动生成一个同名 .json 留在磁盘
     - state.jsonFileName 记录当前 .json 文件名；state.jsonHandleKey 记录 handle key
     ============================================================ */

  // 构造纯 state 快照（剥离 handle、theme.ui 等可还原信息），便于快速序列化
  function snapshotStateForJson() {
    return {
      schema: SCHEMA_VERSION,
      currentPage: state.currentPage,
      pages: state.pages,
      sheetsRaw: state.sheetsRaw,
      recentFiles: state.recentFiles.map((f) => ({
        name: f.name,
        lastOpened: f.lastOpened,
        mtime: f.mtime,
        size: f.size,
        handleKey: f.handleKey,
        isDirectory: !!f.isDirectory,
        isMigrated: !!f.isMigrated,
        isEphemeral: !!f.isEphemeral,
      })),
      currentFileName: state.currentFileName,
      jsonFileName: state.jsonFileName,
      jsonHandleKey: state.jsonHandleKey,
      directoryHandleKey: state.directoryHandleKey,
      // v10：directory handle 的 basename（仅显示用，浏览器不暴露绝对路径）
      directoryName: state.directoryName,
      theme: state.theme,
      ui: state.ui,
    };
  }

  function buildJsonBlob() {
    const json = JSON.stringify(snapshotStateForJson(), null, 2);
    return new Blob([json], { type: "application/json" });
  }

  function jsonFileNameFrom(xlsxName) {
    if (!xlsxName) return "novel-app.json";
    const base = xlsxName.replace(/\.(xlsx|xlsm|json)$/i, "");
    return `${base}.json`;
  }

  // 触发浏览器下载 json（无 handle 时使用）
  function triggerJsonDownload(blob, suggestedName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName || "novel-app.json";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // 写 json 到磁盘
  // v9 优先级：jsonHandleKey（持久化）→ directoryHandleKey（持久化目录）→ xlsx handle 同目录（v7 旧数据兼容）→ 兜底
  async function saveAsJson({ silent = false } = {}) {
    const blob = buildJsonBlob();
    const suggestedName = state.jsonFileName
      || jsonFileNameFrom(state.currentFileName)
      || "novel-app.json";

    // 1) 优先用专属 json handle（用户授权过自动写盘后会设这个 key）
    if (state.jsonHandleKey) {
      try {
        const handle = await fsGet(state.jsonHandleKey);
        if (handle) {
          const granted = await ensureWritePermission(handle, true);
          if (granted) {
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            state.jsonFileName = handle.name || suggestedName;
            if (!silent) toast("✓ 已保存到 json", "info", 1200);
            return { ok: true, mode: "handle" };
          }
        }
        // handle 失效 → 清掉
        state.jsonHandleKey = null;
      } catch (e) {
        if (e && e.name === "AbortError") {
          if (!silent) toast("已取消写入", "info", 1200);
          return { ok: false, mode: "cancelled" };
        }
        console.warn("写 json handle 失败，降级", e);
      }
    }

    // 1.5) v9：用持久化的 directory handle 写 json（用户授权过"自动写盘"目录）
    if (state.directoryHandleKey) {
      try {
        const dirHandle = await fsGet(state.directoryHandleKey);
        if (dirHandle) {
          const granted = await ensureWritePermission(dirHandle, false);
          if (granted) {
            const jsonName = state.jsonFileName
              || jsonFileNameFrom(state.currentFileName)
              || "novel-app.json";
            const fileHandle = await dirHandle.getFileHandle(jsonName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            // 顺手把 json handle 也持久化，下次走第 1 步更快
            const jsonKey = `json:${state.currentFileName || jsonName}`;
            await fsPut(jsonKey, fileHandle);
            state.jsonHandleKey = jsonKey;
            state.jsonFileName = fileHandle.name || jsonName;
            // v10：dir handle 重新可用时补上 directoryName
            if (!state.directoryName) state.directoryName = dirHandle.name || null;
            updateFilePathDisplay();
            if (!silent) toast("✓ 已保存到 json", "info", 1200);
            return { ok: true, mode: "dir" };
          }
          // 权限失效 → 清掉 directoryHandleKey
          state.directoryHandleKey = null;
        } else {
          state.directoryHandleKey = null;
        }
      } catch (e) {
        if (e && e.name === "AbortError") {
          if (!silent) toast("已取消写入", "info", 1200);
          return { ok: false, mode: "cancelled" };
        }
        console.warn("用 directory handle 写 json 失败，降级", e);
        // 写失败也清掉，避免每次都尝试
        state.directoryHandleKey = null;
      }
    }

    // 2) 退化：与 xlsx 同目录写一个同名 .json（v7 旧数据兼容——xlsx 走 FS Access API 拿过 handle 时）
    if (state.currentFileName) {
      const meta = state.recentFiles.find(
        (f) => f.name === state.currentFileName
      );
      if (meta && meta.handleKey && !meta.isMigrated) {
        try {
          const xlsxHandle = await fsGet(meta.handleKey);
          if (xlsxHandle) {
            const dirHandle = xlsxHandle.getParent
              ? await xlsxHandle.getParent()
              : null;
            if (dirHandle) {
              const jsonName = jsonFileNameFrom(state.currentFileName);
              const newHandle = await dirHandle.getFileHandle(jsonName, { create: true });
              const granted = await ensureWritePermission(newHandle, true);
              if (granted) {
                const writable = await newHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                // 持久化这个 handle，下次直接用
                const jsonKey = `json:${state.currentFileName}`;
                await fsPut(jsonKey, newHandle);
                state.jsonHandleKey = jsonKey;
                state.jsonFileName = jsonName;
                if (!silent) toast("✓ 已保存到 json", "info", 1200);
                return { ok: true, mode: "dir" };
              }
            }
          }
        } catch (e) {
          if (e && e.name === "AbortError") {
            if (!silent) toast("已取消写入", "info", 1200);
            return { ok: false, mode: "cancelled" };
          }
          console.warn("在 xlsx 同目录写 json 失败，降级下载", e);
        }
      }
    }

    // 3) 兜底
    // v9：当前文件是「拖入」（isEphemeral=true）时不再误报"未获得写文件权限"，
    // 也**不下载**（避免污染下载目录）。改为简短提示 + 给"启用自动写盘"入口。
    const curMeta = state.currentFileName
      ? state.recentFiles.find((f) => f.name === state.currentFileName)
      : null;
    const isEphemeral = !!(curMeta && curMeta.isEphemeral);
    if (isEphemeral) {
      if (!silent) {
        toast(
          "已保存到浏览器（拖入文件无写盘权限，要写盘请点「启用自动写盘」）",
          "info",
          2200
        );
      }
      return { ok: true, mode: "ephemeral" };
    }
    // 旧数据 / 未配置写盘权限的兜底：触发下载
    triggerJsonDownload(blob, suggestedName);
    if (!silent) {
      toast(
        state.currentFileName
          ? "未获得写文件权限，已下载 json 到本地（请把同名 .json 放回原目录后下次保存即可自动写盘）"
          : "已下载 json",
        "info",
        2500
      );
    }
    return { ok: true, mode: "download" };
  }

  // v11：自动写盘用 showDirectoryPicker({id}) 时浏览器会"记住"这个 id 对应的目录。
  // ——之后再次用同 id 唤起，浏览器会**直接打开上次的目录**（不需要用户重选），
  // 等于软性地实现了"默认路径"。建议路径是 D:/yuelan，但不强求。
  const AUTOSAVE_DIR_ID = "fiction-analyzer-autosave-yuelan";
  const AUTOSAVE_DEFAULT_HINT = "D:/yuelan";

  // v9：让用户授权一个目录，之后所有保存都自动写 json 到该目录
  // （绕开浏览器对拖入文件无 handle 的限制）
  async function enableAutoSave() {
    if (!window.showDirectoryPicker) {
      toast("当前浏览器不支持目录选择，请用 Chrome / Edge / Arc 等 Chromium 内核浏览器", "error", 3500);
      return false;
    }
    let dirHandle;
    try {
      // v11：传 id，浏览器会记住这个 id 关联的目录（即使跨会话），
      // 下次同 id 唤起会**直接打开**该目录（体验上等于"默认路径"）。
      dirHandle = await window.showDirectoryPicker({
        id: AUTOSAVE_DIR_ID,
        mode: "readwrite",
      });
    } catch (e) {
      if (e && e.name === "AbortError") {
        toast("已取消授权", "info", 1200);
      } else {
        console.warn("选择目录失败", e);
        toast("选择目录失败：" + (e.message || e), "error", 3000);
      }
      return false;
    }
    // 持久化 directory handle
    const dirKey = `${DIR_HANDLE_KEY_PREFIX}${state.currentFileName || "_default"}`;
    try {
      await fsPut(dirKey, dirHandle);
    } catch (e) {
      console.error("保存 directory handle 失败", e);
      toast("保存目录权限失败", "error");
      return false;
    }
    state.directoryHandleKey = dirKey;
    // 立即在该目录写一个 json，并拿到 file handle 存为 jsonHandleKey（之后都走第 1 步）
    const jsonName = state.jsonFileName
      || jsonFileNameFrom(state.currentFileName)
      || "novel-app.json";
    try {
      const fileHandle = await dirHandle.getFileHandle(jsonName, { create: true });
      const blob = buildJsonBlob();
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      const jsonKey = `json:${state.currentFileName || jsonName}`;
      await fsPut(jsonKey, fileHandle);
      state.jsonHandleKey = jsonKey;
      state.jsonFileName = fileHandle.name || jsonName;
      // v10：把 directory handle 的 basename 存下来，给底部「文件路径」显示用
      state.directoryName = dirHandle.name || null;
      save();
      updateFilePathDisplay();
      updateAutosaveButton();
      toast("✓ 已启用自动写盘：之后保存会写到该目录", "info", 2500);
      return true;
    } catch (e) {
      console.error("启用自动写盘后首次写入失败", e);
      toast("首次写入失败：" + (e.message || e), "error", 3000);
      // 回滚
      state.directoryHandleKey = null;
      try { await fsDel(dirKey); } catch (_) {}
      return false;
    }
  }

  // v11：根据是否已配置写盘目录，动态更新「启用自动写盘」按钮的文字 / tooltip
  // ——未配置：提示「建议 D:/yuelan」让用户知道该选哪里
  // ——已配置：显示「写盘目录：xxx（点此修改）」让用户一眼能看到当前写到哪
  function updateAutosaveButton() {
    const btn = document.getElementById("btn-enable-autosave");
    if (!btn) return;
    if (state.directoryHandleKey && state.directoryName) {
      btn.textContent = `写盘目录：${state.directoryName}（点此修改）`;
      btn.title =
        `当前写盘目录：${state.directoryName}\n` +
        `点击可改成其他目录。\n` +
        `建议路径：${AUTOSAVE_DEFAULT_HINT}`;
    } else {
      btn.textContent = `启用自动写盘（建议 ${AUTOSAVE_DEFAULT_HINT}）`;
      btn.title =
        `授权一个目录，让「保存」自动写 json 到磁盘。\n` +
        `推荐选 ${AUTOSAVE_DEFAULT_HINT} 目录。\n` +
        `首次授权后浏览器会记住路径，下次直接打开该目录。`;
    }
  }

  // v9：拖入文件后只提示一次（每个文件名一次）。已经启用过就跳过。
  function maybePromptEnableAutoSave() {
    if (!state.currentFileName) return;
    if (state.directoryHandleKey) return; // 已启用
    if (state.jsonHandleKey) return; // v7 旧路径仍有写盘能力
    if (typeof window === "undefined" || !window.showDirectoryPicker) return;
    const dismissed = state._autoSavePromptDismissed || {};
    if (dismissed[state.currentFileName]) return;
    if (!confirm(
      `要让「保存」自动写 json 到磁盘吗？\n\n` +
      `拖入的文件没有写入权限，每次保存目前只是写浏览器内。\n` +
      `点击「确定」：选择一个目录（建议 ${AUTOSAVE_DEFAULT_HINT}，浏览器会记住路径），之后保存会直接覆盖同名 .json。\n` +
      `点击「取消」：跳过这步，继续用「导出 json」手动备份。`
    )) {
      dismissed[state.currentFileName] = true;
      state._autoSavePromptDismissed = dismissed;
      save();
      return;
    }
    enableAutoSave().then((ok) => {
      if (ok) {
        dismissed[state.currentFileName] = true;
        state._autoSavePromptDismissed = dismissed;
        save();
      }
    });
  }

  /* ============================================================
     写文件 - 把 state 写回 xlsx（导出专用）
     ============================================================ */
  async function ensureWritePermission(handle, interactive = true) {
    if (!handle) return false;
    if (handle.queryPermission) {
      try {
        const cur = await handle.queryPermission({ mode: "readwrite" });
        if (cur === "granted") return true;
      } catch (_) {}
      if (!interactive) return false;
      if (handle.requestPermission) {
        try {
          const next = await handle.requestPermission({ mode: "readwrite" });
          return next === "granted";
        } catch (_) {
          return false;
        }
      }
    }
    return false;
  }

  // 构造某 sheet 写回时的二维数组
  function buildSheetAoa(sheetEntry) {
    const rows2dBase = sheetEntry.rows2d || [];
    const header = rows2dBase[0] ? rows2dBase[0].slice() : null;
    const page = sheetEntry.page;
    if (!page || !PAGES[page]) {
      // 未分类的 sheet：原样返回
      return rows2dBase;
    }
    const def = PAGES[page];
    const cols = sheetEntry.columns || {};
    const fieldKeys = Object.keys(def.fields);
    // 该 sheet 在本页面的 items
    const items = state.pages[page].items
      .filter((it) => it.sheet === sheetEntry.name)
      .sort((a, b) => compareChapterNo(def.sortKey(a), def.sortKey(b)));
    // 决定总列宽
    const validIdx = fieldKeys
      .map((k) => cols[k])
      .filter((v) => typeof v === "number" && v >= 0);
    const totalCols = header
      ? Math.max(header.length, ...validIdx, fieldKeys.length - 1) + 1
      : fieldKeys.length;
    const out = [];
    if (header) {
      const normalized = header.slice(0, totalCols);
      while (normalized.length < totalCols) normalized.push("");
      out.push(normalized);
    } else {
      const empty = new Array(totalCols).fill("");
      out.push(empty);
    }
    for (const it of items) {
      const row = new Array(totalCols).fill("");
      for (const key of fieldKeys) {
        const idx = cols[key];
        if (typeof idx === "number" && idx >= 0) {
          row[idx] = it[key] ?? "";
        }
      }
      out.push(row);
    }
    return out;
  }

  function buildXlsxArrayBuffer() {
    if (!window.XLSX) throw new Error("xlsx 解析库未加载");
    if (!state.xlsxFileName && !state.currentFileName) throw new Error("当前没有打开的文件");
    if (state.sheetsRaw.length === 0)
      throw new Error("缺少原始 sheet 缓存，无法写回");
    const wb = XLSX.utils.book_new();
    for (const raw of state.sheetsRaw) {
      const aoa = buildSheetAoa(raw);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const safeName = raw.name.slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, safeName);
    }
    const ab = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    return ab;
  }

  async function saveAsXlsx({ silent = false } = {}) {
    // 优先用「原 xlsx 名」（json-only 流程下保留的源文件）；否则用当前文件名
    const xlsxName = state.xlsxFileName || state.currentFileName;
    if (!xlsxName) {
      if (!silent) toast("当前没有打开的文件", "error");
      return false;
    }
    if (state.sheetsRaw.length === 0) {
      if (!silent) toast("没有可写的 sheet 缓存，请重新打开文件", "error");
      return false;
    }
    let ab;
    try {
      ab = buildXlsxArrayBuffer();
    } catch (e) {
      console.error("构造 xlsx 失败", e);
      if (!silent) toast("构造 xlsx 失败：" + (e.message || e), "error", 3000);
      return false;
    }

    const meta = state.recentFiles.find(
      (f) => f.name === xlsxName
    );
    if (meta && meta.handleKey && !meta.isMigrated) {
      try {
        const handle = await fsGet(meta.handleKey);
        if (!handle) {
          triggerXlsxDownload(ab, xlsxName);
          if (!silent) toast("原文件访问权限已失效，已下载更新版", "info", 2500);
          return true;
        }
        const granted = await ensureWritePermission(handle, true);
        if (!granted) {
          if (!silent) toast("未获得写入权限，已下载更新版", "info", 2500);
          triggerXlsxDownload(ab, xlsxName);
          return true;
        }
        const writable = await handle.createWritable();
        await writable.write(ab);
        await writable.close();
        if (!silent) toast("已写入 xlsx 文件", "info", 1500);
        return true;
      } catch (e) {
        if (e && e.name === "AbortError") {
          if (!silent) toast("已取消写入", "info", 1500);
          return false;
        }
        console.error("写入文件失败", e);
        if (!silent) {
          triggerXlsxDownload(ab, xlsxName);
          toast("写入失败，已改为下载：" + (e.message || e), "error", 3500);
        }
        return false;
      }
    } else {
      triggerXlsxDownload(ab, xlsxName);
      if (!silent) {
        toast(
          meta && meta.isMigrated
            ? "旧数据无文件权限，已下载更新版"
            : "本次会话文件无写入权限，已下载更新版",
          "info",
          2500
        );
      }
      return true;
    }
  }

  function triggerXlsxDownload(ab, fileName) {
    const blob = new Blob([ab], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = fileName.replace(/\.xlsx?$/i, "");
    a.download = `${base}-updated.xlsx`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  async function openDirectory(dirHandle) {
    let files;
    try {
      files = await listXlsxInDir(dirHandle);
    } catch (e) {
      toast("读取文件夹失败：" + (e.message || e), "error");
      return;
    }
    if (files.length === 0) {
      toast("该文件夹下没有 .xlsx 文件", "error", 3000);
      return;
    }
    try {
      await fsPut(`dir:${dirHandle.name}`, dirHandle);
    } catch (_) {}

    for (const f of files) {
      const fileKey = `file:${dirHandle.name}/${f.name}`;
      try {
        await fsPut(fileKey, f.handle);
      } catch (e) {
        console.warn("持久化 handle 失败", fileKey, e);
      }
      const desc = await describeFile(f.handle);
      upsertRecentFile({
        name: f.handle.name,
        mtime: desc.mtime,
        size: desc.size,
        handleKey: fileKey,
        isDirectory: false,
      });
    }
    save();
    renderAll();
    const target =
      state.currentFileName && files.find((f) => f.name === state.currentFileName)
        ? files.find((f) => f.name === state.currentFileName)
        : files[0];
    if (target) await openFileByName(target.handle.name);
  }


  /* ============================================================
     保存 / 删除 - 当前 item
     ============================================================ */
  function saveCurrentItem() {
    const p = curPage();
    const it = curItem();
    if (!it) return false;
    if (state.currentPage === "chapter") {
      it.no = $("#ch-no").value; // 保留原始字符串，排序由 sortKey 处理
      it.title = $("#ch-title").value.trim();
      it.content = $("#ch-content").value;
    } else if (state.currentPage === "foreshadowing") {
      // v14：主表字段（fsNo/name/status）
      it.fsNo = String($("#fs-fsno")?.value ?? it.fsNo ?? "").trim();
      it.name = String($("#fs-name")?.value ?? it.name ?? "").trim();
      it.status = $("#fs-status")?.value || it.status || FS_STATUS_DEFAULT;
      // 履历编辑在 input 事件里已经实时写回 records，这里不再处理
    }
    save();
    // 显式保存：取消任何在等的 debounce 入栈，立即入栈
    clearTimeout(_pushHistoryDebounce);
    _pushHistoryDebounce = null;
    pushHistory();
    renderCurrentPage();
    flashSaveStatus("✓ 已保存到本地");
    return true;
  }

  function flashSaveStatus(text, ms = 1500) {
    // 兼容章节 (#save-status) 与伏笔 (#fs-save-status)
    const s = $("#save-status") || $("#fs-save-status");
    if (!s) return;
    s.textContent = text;
    s.classList.add("saved");
    clearTimeout(s._t);
    s._t = setTimeout(() => {
      s.textContent = "";
      s.classList.remove("saved");
    }, ms);
  }

  function deleteCurrentItem() {
    const p = curPage();
    const it = curItem();
    if (!it) return;
    const def = curPageDef();
    const label = it.title || it.name || it.no;
    if (!confirm(`确定删除${def.label}「${label}」？`)) return;
    p.items = p.items.filter((x) => x.id !== it.id);
    p.currentItemId = null;
    save();
    pushHistory();
    renderAll();
    toast("已删除");
  }

  function addNewItem() {
    const p = curPage();
    const def = curPageDef();
    const targetSheet =
      p.currentSheet || (p.sheets[0] && p.sheets[0].name) || null;
    const data = def.defaults();
    if (state.currentPage === "chapter") {
      data.no = nextNoInCurrentSheet();
    } else if (state.currentPage === "foreshadowing") {
      // v14：伏笔编号 fsNo 自动生成（取当前 sheet 内最大编号 +1，转字符串）
      const maxFsNo = (() => {
        const list = targetSheet
          ? p.items.filter((it) => it.sheet === targetSheet)
          : p.items;
        let max = 0;
        for (const it of list) {
          const k = parseFsNoKey(it.fsNo);
          if (Number.isFinite(k.num) && k.num > max) max = k.num;
        }
        return max + 1;
      })();
      data.no = maxFsNo;
      data.fsNo = String(maxFsNo);
    }
    const it = def.makeItem(data, targetSheet);
    p.items.push(it);
    p.currentItemId = it.id;
    save();
    pushHistory();
    renderAll();
    setTimeout(() => {
      // focus 第一个可输入字段
      const focusSel =
        state.currentPage === "chapter"
          ? "#ch-title"
          : state.currentPage === "foreshadowing"
            ? "#fs-name"
            : null;
      if (focusSel) {
        const el = $(focusSel);
        if (el) el.focus();
      }
    }, 50);
    const displayKey = state.currentPage === "foreshadowing" ? (data.fsNo || data.no) : data.no;
    toast(def.newItemToast(targetSheet, displayKey));
  }

  /* ============================================================
     导入（xlsx + 文本） - 多 section 通用逻辑
     ============================================================ */
  // v14：导入弹窗支持多 section
  // 每个 section 描述：DOM id 集合 + 目标页/表 + 字段定义 + 是否是"履历表"
  const IMPORT_SECTIONS = {
    chapter: {
      key: "chapter",
      pid: "chapter",
      table: "items",
      containerId: "import-section-chapter",
      dropId: "import-drop",
      fileInputId: "file-xlsx",
      textId: "import-text",
      sheetWrapId: "import-sheet-wrap",
      sheetSelectId: "import-sheet-select",
      skipHeaderId: "import-skip-header",
      statsId: "import-stats",
      previewId: "import-preview",
      fileInfoId: "import-file-info",
      clearId: "btn-import-clear",
      confirmId: "btn-import-confirm",
      allowTargetPage: true,
      isRecord: false,
    },
    "fs-main": {
      key: "fs-main",
      pid: "foreshadowing",
      table: "items",
      containerId: "import-section-foreshadowing",
      dropId: "import-fs-main-drop",
      fileInputId: "file-fs-main",
      textId: "import-fs-main-text",
      sheetWrapId: "import-fs-main-sheet-wrap",
      sheetSelectId: "import-fs-main-sheet-select",
      skipHeaderId: "import-fs-main-skip-header",
      statsId: "import-fs-main-stats",
      previewId: "import-fs-main-preview",
      fileInfoId: "import-fs-main-file-info",
      clearSel: '[data-clear-section="fs-main"]',
      confirmId: "btn-import-fs-main-confirm",
      allowTargetPage: false,
      isRecord: false,
    },
    "fs-record": {
      key: "fs-record",
      pid: "foreshadowing",
      table: "records",
      containerId: "import-section-foreshadowing",
      dropId: "import-fs-record-drop",
      fileInputId: "file-fs-record",
      textId: "import-fs-record-text",
      sheetWrapId: "import-fs-record-sheet-wrap",
      sheetSelectId: "import-fs-record-sheet-select",
      skipHeaderId: "import-fs-record-skip-header",
      statsId: "import-fs-record-stats",
      previewId: "import-fs-record-preview",
      fileInfoId: "import-fs-record-file-info",
      clearSel: '[data-clear-section="fs-record"]',
      confirmId: "btn-import-fs-record-confirm",
      allowTargetPage: false,
      isRecord: true,
    },
  };

  // 每个 section 的运行时状态
  const importState = {
    chapter: { allSheets: null, currentSheet: null, targetPage: null, allSheetsTarget: null },
    "fs-main": { allSheets: null, currentSheet: null, targetPage: "foreshadowing", allSheetsTarget: null },
    "fs-record": { allSheets: null, currentSheet: null, targetPage: "foreshadowing", allSheetsTarget: null },
  };

  function getImportFieldsDef(sectionKey) {
    const sec = IMPORT_SECTIONS[sectionKey];
    if (!sec) return null;
    const page = PAGES[sec.pid];
    if (!page) return null;
    return sec.isRecord ? page.recordFields : page.fields;
  }
  function getImportTable(sectionKey) {
    const sec = IMPORT_SECTIONS[sectionKey];
    if (!sec) return null;
    return state.pages[sec.pid][sec.table];
  }
  function getImportDef(sectionKey) {
    const sec = IMPORT_SECTIONS[sectionKey];
    if (!sec) return null;
    return PAGES[sec.pid];
  }

  function bindImportEvents() {
    // 打开弹窗：按当前页面显示对应 section
    $("#btn-import").addEventListener("click", () => {
      const pid = state.currentPage;
      // 章节 → 单 section；伏笔 → 双 section
      const sectionIds = pid === "foreshadowing"
        ? ["fs-main", "fs-record"]
        : ["chapter"];
      for (const k of Object.keys(IMPORT_SECTIONS)) {
        const sec = IMPORT_SECTIONS[k];
        const container = $("#" + sec.containerId);
        if (!container) continue;
        const visible = sectionIds.includes(k);
        container.hidden = !visible;
        if (visible) resetImportSection(k);
        else {
          importState[k].allSheets = null;
          importState[k].currentSheet = null;
          importState[k].targetPage = null;
        }
      }
      // 底部按钮显隐
      for (const k of Object.keys(IMPORT_SECTIONS)) {
        const btn = $("#" + IMPORT_SECTIONS[k].confirmId);
        if (btn) btn.hidden = !sectionIds.includes(k);
      }
      showModal("modal-import");
    });

    // 通用：每个 section 绑拖拽 / 选择 / 文本输入 / sheet 切换
    for (const key of Object.keys(IMPORT_SECTIONS)) {
      bindImportSectionEvents(key);
    }

    // 通用：每个 section 的确认按钮
    for (const key of Object.keys(IMPORT_SECTIONS)) {
      const sec = IMPORT_SECTIONS[key];
      const btn = $("#" + sec.confirmId);
      if (!btn) continue;
      btn.addEventListener("click", () => commitImportSection(key));
    }

    // chapter 专属：导入到目标页下拉
    $("#import-target-select")?.addEventListener("change", () => {
      importState.chapter.targetPage = $("#import-target-select").value;
      refreshImportPreviewSection("chapter");
    });
  }

  function bindImportSectionEvents(key) {
    const sec = IMPORT_SECTIONS[key];
    const drop = $("#" + sec.dropId);
    const fileInput = $("#" + sec.fileInputId);
    const text = $("#" + sec.textId);
    const sheetSel = $("#" + sec.sheetSelectId);
    const skipHeader = $("#" + sec.skipHeaderId);
    const clear = sec.clearId ? $("#" + sec.clearId) : (sec.clearSel ? document.querySelector(sec.clearSel) : null);
    if (!drop || !fileInput) return;

    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) handleImportFile(f, key);
      e.target.value = "";
    });
    ["dragenter", "dragover"].forEach((evt) =>
      drop.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.add("is-dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      drop.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        drop.classList.remove("is-dragover");
      })
    );
    drop.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (f) handleImportFile(f, key);
    });

    if (clear) {
      clear.addEventListener("click", (e) => {
        e.stopPropagation();
        resetImportSection(key);
      });
    }
    if (text) {
      text.addEventListener("input", () => {
        if (importState[key].allSheets && text.value.trim()) {
          // 一旦用户开始手填文本，就把已解析的 file 清掉（互斥）
          importState[key].allSheets = null;
          importState[key].currentSheet = null;
          const fi = $("#" + sec.fileInfoId);
          if (fi) fi.hidden = true;
          const sw = $("#" + sec.sheetWrapId);
          if (sw) sw.hidden = true;
        }
        refreshImportPreviewSection(key);
      });
    }
    if (skipHeader) skipHeader.addEventListener("change", () => refreshImportPreviewSection(key));
    if (sheetSel) sheetSel.addEventListener("change", () => refreshImportPreviewSection(key));
  }

  function resetImportSection(key) {
    const sec = IMPORT_SECTIONS[key];
    importState[key] = {
      allSheets: null,
      currentSheet: null,
      targetPage: sec.allowTargetPage ? null : sec.pid,
      allSheetsTarget: null,
    };
    const text = $("#" + sec.textId);
    if (text) text.value = "";
    const fi = $("#" + sec.fileInfoId);
    if (fi) fi.hidden = true;
    const sw = $("#" + sec.sheetWrapId);
    if (sw) sw.hidden = true;
    const pv = $("#" + sec.previewId);
    if (pv) pv.innerHTML = "";
    const st = $("#" + sec.statsId);
    if (st) { st.textContent = ""; st.className = "muted"; }
    const btn = $("#" + sec.confirmId);
    if (btn) {
      btn.disabled = true;
      btn.dataset.parsed = "";
      btn.dataset.sheet = "";
      btn.dataset.page = "";
    }
  }

  // 分发：根据扩展名调用 xlsx 或 json 解析
  function handleImportFile(file, sectionKey) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!["xlsx", "xlsm", "json"].includes(ext)) {
      toast(`不支持的文件类型：.${ext}（仅支持 .xlsx / .xlsm / .json）`, "error");
      return;
    }
    if (ext === "json") {
      handleJsonImportFileFor(file, sectionKey);
      return;
    }
    if (!window.XLSX) {
      toast("xlsx 解析库未加载，请检查网络", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result);
        const wb = XLSX.read(data, { type: "array", cellDates: true, cellNF: true });
        if (!wb.SheetNames || wb.SheetNames.length === 0) {
          toast("xlsx 内没有可用的 sheet", "error");
          return;
        }
        const sheets = wb.SheetNames.map((name) => parseXlsxSheetForImport(name, wb.Sheets[name]));
        afterImportParsedSection(file.name, sheets, sectionKey);
      } catch (err) {
        console.error(err);
        toast("xlsx 解析失败：" + (err.message || err), "error");
      }
    };
    reader.onerror = () => toast("读取文件失败", "error");
    reader.readAsArrayBuffer(file);
  }

  // 解析单个 sheet：对每个 page 都尝试（找到能识别的 page）
  // 如果是双 section（fs-main/fs-record），限定只识别自己 pid
  function parseXlsxSheetForImport(name, sheet) {
    const rows2d = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: true,
    });
    const header = (rows2d[0] || []).map((c) => unpackCell(c).trim());
    // 先用 sheet 名分类（这是 sheet 级的 pid 标记）
    const pageFromName = classifySheet(name, header);
    // 解析所有候选 page
    const candidates = [];
    for (const pid of PAGE_IDS) {
      const parsed = parseRowsForPage(rows2d, pid);
      if (parsed.columns) {
        const hitCount = Object.keys(parsed.columns).filter(
          (k) => k !== "header" && (parsed.columns[k] | 0) >= 0
        ).length;
        if (hitCount > 0) {
          candidates.push({ pid, parsed, hitCount, ok: true });
        }
      }
    }
    // 选命中数最多的
    candidates.sort((a, b) => b.hitCount - a.hitCount);
    const winner = candidates[0];
    return {
      name,
      rows2d,
      header,
      candidates,
      winner: winner || null,
      page: winner ? winner.pid : pageFromName,
      ok: !!winner,
    };
  }

  function handleJsonImportFileFor(file, sectionKey) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const arr = tryParseJsonText(text);
        if (!arr) {
          toast("JSON 文件无法解析为数组（应为 JSON 数组 / JSON Lines）", "error", 3500);
          return;
        }
        // 对每个 page 都试一遍解析
        const candidates = [];
        for (const pid of PAGE_IDS) {
          const parsed = parseJsonArrayForPage(arr, pid);
          if (parsed.columns) {
            const hitCount = Object.keys(parsed.columns).filter(
              (k) => k !== "header" && (parsed.columns[k] | 0) >= 0
            ).length;
            if (hitCount > 0) {
              candidates.push({ pid, parsed, hitCount });
            }
          }
        }
        if (candidates.length === 0) {
          toast("JSON 数据未匹配任何已注册的页面字段", "error", 4000);
          return;
        }
        candidates.sort((a, b) => b.hitCount - a.hitCount);
        const baseName = (file.name || "imported").replace(/\.[^.]+$/, "");
        const sheets = candidates.map((c, i) => ({
          name: i === 0 ? baseName : `${baseName}·${PAGES[c.pid].label}`,
          rows2d: [c.parsed.columns.header, ...arr.map((it) =>
            c.parsed.columns.header.map((k) => it[k] != null ? it[k] : "")
          )],
          header: c.parsed.columns.header,
          candidates: [c],
          winner: c,
          page: c.pid,
          ok: true,
        }));
        afterImportParsedSection(file.name, sheets, sectionKey);
        toast(
          `JSON 解析完成：${arr.length} 条 → ${PAGES[candidates[0].pid].label}`,
          "info",
          1800
        );
      } catch (err) {
        console.error(err);
        toast("JSON 解析失败：" + (err.message || err), "error");
      }
    };
    reader.onerror = () => toast("读取文件失败", "error");
    reader.readAsText(file);
  }

  // section 解析完后的 UI 装配
  // 关键过滤：双 section（fs-main/fs-record）只接收自己 pid/table 的 sheet
  function afterImportParsedSection(fileName, sheets, sectionKey) {
    const sec = IMPORT_SECTIONS[sectionKey];
    const def = getImportDef(sectionKey);
    const fields = sec.isRecord ? def.recordFields : def.fields;
    // 过滤：双 section 只接受自己 pid
    let filtered = sheets;
    if (!sec.allowTargetPage) {
      // 伏笔 section：fs-main 接受 page=foreshadowing + hit fields 含 no/name/status；
      //                fs-record 接受 page=foreshadowing + hit 含 no/fsNo/setup/notes
      filtered = sheets
        .map((s) => {
          // 在该 sheet 的所有 candidate 里找匹配的 page
          const matched = s.candidates
            ? s.candidates.find((c) => c.pid === sec.pid)
            : null;
          if (!matched) return null;
          return {
            name: s.name,
            rows2d: s.rows2d,
            header: s.header,
            candidates: [matched],
            winner: matched,
            page: sec.pid,
            ok: true,
          };
        })
        .filter(Boolean);
      if (filtered.length === 0) {
        toast(
          sec.isRecord
            ? "该文件未找到「伏笔履历表」相关字段（需要：伏笔编号 / 提及章节 / 原文描述）"
            : "该文件未找到「伏笔数据表」相关字段（需要：伏笔编号 / 伏笔名称 / 状态）",
          "error",
          3500
        );
        return;
      }
    } else {
      // 章节 section：保留多 sheet 选项，但只显示与该 sheet 名匹配的 page
      filtered = sheets.filter((s) => s.ok);
      if (filtered.length === 0) {
        toast("没有可识别的 sheet 字段", "warn", 3000);
        return;
      }
    }
    importState[sectionKey].allSheets = filtered;
    const sel = $("#" + sec.sheetSelectId);
    const wrap = $("#" + sec.sheetWrapId);
    if (sel) {
      sel.innerHTML = filtered
        .map(
          (s) =>
            `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} → ${escapeHtml(pageBadge(s.page))}</option>`
        )
        .join("");
    }
    if (wrap) wrap.hidden = filtered.length <= 1;
    const info = $("#" + sec.fileInfoId);
    if (info) {
      info.hidden = false;
      const nameEl = info.querySelector(".import-file-name");
      if (nameEl) nameEl.textContent = fileName;
    }
    // 默认 targetPage
    if (sec.allowTargetPage) {
      importState[sectionKey].targetPage = filtered[0].page || state.currentPage;
    } else {
      importState[sectionKey].targetPage = sec.pid;
    }
    // chapter 专属：填「导入到」下拉
    if (sec.allowTargetPage) {
      const tw = $("#import-target-wrap");
      const tsel = $("#import-target-select");
      if (tsel) {
        const present = new Set(filtered.map((s) => s.page).filter(Boolean));
        present.add(state.currentPage);
        const options = Array.from(present).map(
          (pid) =>
            `<option value="${pid}">${PAGES[pid] ? PAGES[pid].icon + " " + PAGES[pid].label : pid}</option>`
        );
        options.push(`<option value="">— 未分类（不导入）—</option>`);
        tsel.innerHTML = options.join("");
        tsel.value = importState[sectionKey].targetPage;
      }
      if (tw) tw.hidden = false;
    }
    refreshImportPreviewSection(sectionKey);
  }

  function refreshImportPreviewSection(sectionKey) {
    const sec = IMPORT_SECTIONS[sectionKey];
    const st = importState[sectionKey];
    if (st.allSheets) {
      const sheetName = ($("#" + sec.sheetSelectId)?.value) || st.currentSheet || st.allSheets[0]?.name;
      const target = st.allSheets.find((s) => s.name === sheetName);
      if (!target) {
        renderImportPreviewSection(null, sec, "items");
        const btn = $("#" + sec.confirmId);
        if (btn) {
          btn.disabled = true;
          btn.dataset.parsed = "";
          btn.dataset.sheet = "";
          btn.dataset.page = "";
        }
        setSectionStats(sec, null);
        return;
      }
      // rows 来自 target.winner.parsed.rows
      const rows = target.winner?.parsed?.rows || [];
      renderImportPreviewSection(rows, sec, sec.isRecord ? "records" : "items");
      const okCount = rows.filter((r) => !r._error).length;
      const btn = $("#" + sec.confirmId);
      if (btn) {
        btn.disabled = !st.targetPage || okCount === 0;
        btn.dataset.parsed = JSON.stringify(rows);
        btn.dataset.sheet = target.name;
        btn.dataset.page = st.targetPage;
        btn.dataset.table = sec.table;
      }
      st.currentSheet = target.name;
      setSectionStats(sec, rows, st.targetPage);
    } else {
      // 文本路径
      const text = $("#" + sec.textId)?.value;
      const rows = parseImportTextFor(text, sectionKey);
      renderImportPreviewSection(rows, sec, sec.isRecord ? "records" : "items");
      const btn = $("#" + sec.confirmId);
      if (btn) {
        const okCount = rows.filter((r) => !r._error).length;
        btn.disabled = okCount === 0;
        btn.dataset.parsed = JSON.stringify(rows);
        btn.dataset.sheet = "";
        btn.dataset.page = sec.pid;
        btn.dataset.table = sec.table;
      }
      setSectionStats(sec, rows, sec.pid);
    }
  }

  // 文本导入：按 section 字段定义解析
  function parseImportTextFor(text, sectionKey) {
    if (!text || !text.trim()) return [];
    const sec = IMPORT_SECTIONS[sectionKey];
    const def = getImportDef(sectionKey);
    if (!sec || !def) return [];
    const fields = sec.isRecord ? def.recordFields : def.fields;
    // 章节 section 走原 parseImportText（已经有完整逻辑）
    if (sectionKey === "chapter") {
      return parseImportText(text);
    }
    // 伏笔 section：通用 TSV/CSV 解析
    // 先尝试 JSON
    const jsonArr = tryParseJsonText(text);
    if (jsonArr) {
      const parsed = parseJsonArrayForPage(jsonArr, sec.pid);
      return parsed.rows;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];
    const detectSep = (sample) => {
      if (sample.includes("\t")) return "\t";
      if (/ {2,}/.test(sample)) return / {2,}/;
      if (sample.includes(",")) return ",";
      return /\s+/;
    };
    const sep = detectSep(lines[0]);
    const splitLine = (line) =>
      sep instanceof RegExp ? line.split(sep) : line.split(sep);
    const skipHeader = $("#" + sec.skipHeaderId)?.checked ?? true;
    const startIdx = skipHeader ? 1 : 0;
    const out = [];
    // 用字段定义构建 header → 字段名映射
    const headerCandidates = [];
    for (const k of Object.keys(fields)) {
      headerCandidates.push({ key: k, cands: fields[k] });
    }
    // 第 0 行（如果 skipHeader=true 实际是第 1 行）解析为 header
    let header = null;
    if (!skipHeader && lines.length > 0) {
      const parts = splitLine(lines[0]).map((s) => s.trim());
      header = parts;
    }
    for (let i = startIdx; i < lines.length; i++) {
      const parts = splitLine(lines[i]).map((s) => s.trim());
      const o = { _line: i + 1, _error: null };
      if (parts.length < 1) {
        o._error = "行内容为空";
        out.push(o);
        continue;
      }
      // 没有 header 时按字段顺序取值
      if (!header) {
        const data = {};
        for (let j = 0; j < headerCandidates.length && j < parts.length; j++) {
          data[headerCandidates[j].key] = parts[j];
        }
        Object.assign(o, data);
      } else {
        // 用 header 名称匹配字段
        const data = {};
        for (let j = 0; j < header.length; j++) {
          const colName = header[j];
          const matchKey = headerCandidates.find((c) =>
            c.cands.some((cand) => cand.toLowerCase() === colName.toLowerCase())
          );
          if (matchKey) data[matchKey.key] = parts[j] || "";
        }
        Object.assign(o, data);
      }
      // no 字段标准化
      if (typeof o.no === "string") {
        const p = parseChapterNo(o.no);
        if (p.hasNum && Number.isFinite(p.num)) o.no = p.num;
        else if (p.raw) o.no = p.raw;
        else o.no = 0;
      }
      out.push(o);
    }
    return out;
  }

  function renderImportPreviewSection(rows, sec, tableKind) {
    const pv = $("#" + sec.previewId);
    if (!pv) return;
    if (!rows || rows.length === 0) {
      pv.innerHTML = "";
      return;
    }
    pv.innerHTML = rows
      .map((r) => {
        if (r._error) {
          return `
            <div class="preview-row preview-error" title="${escapeHtml(r._error)}">
              <span class="preview-no">#${r._line || "-"}</span>
              <span class="preview-title">⚠ ${escapeHtml(r._error)}</span>
              <span class="preview-len">失败</span>
            </div>`;
        }
        let main = "";
        if (sec.isRecord) {
          main = `${r.setup || "—"} · ${r.notes || "（无描述）"}`;
        } else if (sec.key === "chapter") {
          main = r.title || "（无标题）";
        } else {
          main = `${r.fsNo || "—"} · ${r.name || "（无名）"}`;
        }
        const no = r.no != null ? r.no : "—";
        return `
          <div class="preview-row">
            <span class="preview-no">${escapeHtml(String(no))}</span>
            <span class="preview-title" title="${escapeHtml(main)}">${escapeHtml(main)}</span>
            <span class="preview-len">${charCount(r.notes || r.content || "")}字</span>
          </div>`;
      })
      .join("");
  }

  function setSectionStats(sec, rows, pid) {
    const el = $("#" + sec.statsId);
    if (!el) return;
    if (!rows || rows.length === 0) {
      el.textContent = "";
      el.className = "muted";
      return;
    }
    const ok = rows.filter((r) => !r._error).length;
    const err = rows.length - ok;
    el.classList.remove("has-error", "has-success");
    const label = pid && PAGES[pid] ? `→ ${PAGES[pid].label}` : "";
    if (err === 0) {
      el.classList.add("has-success");
      el.textContent = `✓ ${ok} 行可导入 ${label}`;
    } else {
      el.classList.add("has-error");
      el.textContent = `✓ ${ok} 行 / ✗ ${err} 行解析失败 ${label}`;
    }
  }

  // 确认导入 section
  function commitImportSection(sectionKey) {
    const sec = IMPORT_SECTIONS[sectionKey];
    const btn = $("#" + sec.confirmId);
    if (!btn) return;
    const raw = btn.dataset.parsed;
    const sheetName = btn.dataset.sheet || "";
    const targetPid = btn.dataset.page || "";
    const table = btn.dataset.table || sec.table;
    if (!raw) return;
    const rows = JSON.parse(raw).filter((r) => !r._error);
    if (rows.length === 0) {
      toast("没有可导入的内容", "error");
      return;
    }
    if (!targetPid || !PAGES[targetPid]) {
      toast("未指定目标页面", "error");
      return;
    }
    const def = PAGES[targetPid];
    const target = state.pages[targetPid][table];
    if (!Array.isArray(target)) {
      toast("目标表不存在：" + table, "error");
      return;
    }
    const isRecord = table === "records";
    const fieldsDef = isRecord ? def.recordFields : def.fields;
    const defaultsFn = isRecord ? def.recordDefaults : def.defaults;
    const makeFn = isRecord ? def.makeRecord : def.makeItem;
    let added = 0, replaced = 0;
    rows.forEach((r) => {
      // 去重 key：items 用 sheet+no；records 用 sheet+no+fsNo
      const existingIdx = isRecord
        ? target.findIndex(
            (x) => x.sheet === sheetName &&
                   String(x.fsNo || "") === String(r.fsNo || "") &&
                   String(x.setup || "") === String(r.setup || "")
          )
        : target.findIndex(
            (x) => Number(x.no) === Number(r.no) && x.sheet === sheetName
          );
      const data = defaultsFn();
      for (const k of Object.keys(fieldsDef)) {
        if (k in r) data[k] = r[k];
      }
      if (existingIdx >= 0) {
        target[existingIdx] = { ...target[existingIdx], ...data, sheet: sheetName };
        replaced++;
      } else {
        const it = makeFn(data, sheetName);
        target.push(it);
        added++;
      }
    });
    // 排序
    if (isRecord) {
      target.sort((a, b) =>
        compareChapterNo(def.recordSortKey(a), def.recordSortKey(b))
      );
    } else {
      target.sort((a, b) =>
        compareChapterNo(def.sortKey(a), def.sortKey(b))
      );
    }
    // sheet 注册到 state.sheetsRaw（如不存在）
    if (sheetName && !state.sheetsRaw.find((s) => s.name === sheetName)) {
      const header = rows[0] ? Object.keys(fieldsDef) : [];
      const aoa = [header];
      state.sheetsRaw.push({
        name: sheetName,
        rows2d: aoa,
        columns: Object.fromEntries(
          Object.keys(fieldsDef).map((k, i) => [k, i])
        ),
        rowCount: aoa.length,
        ok: true,
        page: targetPid,
      });
      if (!state.pages[targetPid].sheets.find((s) => s.name === sheetName)) {
        state.pages[targetPid].sheets.push({
          name: sheetName,
          columns: Object.fromEntries(
            Object.keys(fieldsDef).map((k, i) => [k, i])
          ),
          rowCount: 1,
          ok: true,
        });
      }
    }
    save();
    pushHistory();
    // 切到目标页面（如未在）
    if (state.currentPage !== targetPid) {
      state.currentPage = targetPid;
    }
    if (sheetName) {
      state.pages[targetPid].currentSheet = sheetName;
    }
    const first = getSortedItems()[0];
    state.pages[targetPid].currentItemId = first ? first.id : null;
    renderAll();
    const tableLabel = isRecord ? "履历表" : "数据表";
    toast(
      `导入完成：${def.label}·${tableLabel} [${sheetName || "(文本)"}] 新增 ${added} 条，覆盖 ${replaced} 条`
    );
    // 章节 section 关弹窗；伏笔 section 留在弹窗让用户可继续填另一区
    if (sectionKey === "chapter") {
      hideModal("modal-import");
    } else {
      // 重置当前 section 让用户继续填
      resetImportSection(sectionKey);
    }
  }

  // 兼容旧调用：handleXlsxFile / handleJsonImportFile 现在按 section 派发
  function handleXlsxFile(file) {
    // 旧调用已不存在；保留为外部代码可能引用，但实际现在通过 handleImportFile
    handleImportFile(file, "chapter");
  }
  function handleJsonImportFile(file) {
    handleImportFile(file, "chapter");
  }
  // 旧 parseImportText / refreshImportPreview 保留为 chapter section 用
  // parseImportText 已经在前面定义过；refreshImportPreview 也保留了
  // 这里补一个"空"的旧函数以防外部意外引用
  function refreshImportPreview() {
    refreshImportPreviewSection("chapter");
  }
  // 旧 afterImportParsed 不再使用
  function afterImportParsed() {
    /* deprecated, see afterImportParsedSection */
  }

  function parseImportText(text) {
    if (!text || !text.trim()) return [];
    // v13：先尝试识别 JSON 数组 / JSON Lines
    const jsonArr = tryParseJsonText(text);
    if (jsonArr) {
      // 按 chapter 解析（文本导入兜底走章节）
      const parsed = parseJsonArrayForPage(jsonArr, "chapter");
      return parsed.rows;
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];
    const detectSep = (sample) => {
      if (sample.includes("\t")) return "\t";
      if (/ {2,}/.test(sample)) return / {2,}/;
      if (sample.includes(",")) return ",";
      return /\s+/;
    };
    const sep = detectSep(lines[0]);
    const splitLine = (line) =>
      sep instanceof RegExp ? line.split(sep) : line.split(sep);
    const skipHeader = $("#import-skip-header").checked;
    const startIdx = skipHeader ? 1 : 0;
    const out = [];
    for (let i = startIdx; i < lines.length; i++) {
      const parts = splitLine(lines[i]).map((s) => s.trim());
      const o = { _line: i + 1, _error: null };
      if (parts.length < 3) {
        o._error = `列数不足（需章节号/章节名/文章内容 3 列），实际 ${parts.length} 列`;
        out.push(o);
        continue;
      }
      const noStr = String(parts[0] || "").trim();
      if (!noStr) {
        o._error = `章节号为空`;
        out.push(o);
        continue;
      }
      const noParsed = parseChapterNo(noStr);
      if (!noParsed.hasNum || !Number.isFinite(noParsed.num)) {
        o._error = `章节号无法解析为数字："${noStr}"`;
        out.push(o);
        continue;
      }
      o.no = noParsed.num;
      o.title = parts[1] || "";
      o.content = parts.slice(2).join(" ").trim();
      out.push(o);
    }
    return out;
  }

  function refreshImportPreview() {
    if (importAllSheets) {
      const sel = $("#import-sheet-select");
      const sheetName = sel
        ? sel.value
        : importCurrentSheet ||
          (importAllSheets[0] && importAllSheets[0].name);
      const target = importAllSheets.find((s) => s.name === sheetName);
      if (!target) {
        renderImportPreview([]);
        $("#btn-import-confirm").disabled = true;
        $("#btn-import-confirm").dataset.parsed = "";
        $("#btn-import-confirm").dataset.sheet = "";
        $("#btn-import-confirm").dataset.page = "";
        setImportStats(null);
        return;
      }
      const rows = target.parsed.rows;
      renderImportPreview(rows, target.page);
      const okCount = rows.filter((r) => !r._error).length;
      const targetPid = $("#import-target-select")?.value || importTargetPage || target.page || "";
      $("#btn-import-confirm").disabled = !targetPid || okCount === 0;
      $("#btn-import-confirm").dataset.parsed = JSON.stringify(rows);
      $("#btn-import-confirm").dataset.sheet = target.name;
      $("#btn-import-confirm").dataset.page = targetPid;
      importCurrentSheet = target.name;
      importTargetPage = targetPid;
      setImportStats(rows, target.page);
    } else {
      // 文本导入：固定走 chapter
      const rows = parseImportText($("#import-text").value);
      renderImportPreview(rows, "chapter");
      $("#btn-import-confirm").disabled =
        rows.filter((r) => !r._error).length === 0;
      $("#btn-import-confirm").dataset.parsed = JSON.stringify(rows);
      $("#btn-import-confirm").dataset.sheet = "";
      $("#btn-import-confirm").dataset.page = "chapter";
      setImportStats(rows, "chapter");
    }
  }

  function setImportStats(rows, pid) {
    const el = $("#import-stats");
    if (!el) return;
    if (!rows || rows.length === 0) {
      el.textContent = "";
      el.className = "muted";
      return;
    }
    const ok = rows.filter((r) => !r._error).length;
    const err = rows.length - ok;
    el.classList.remove("has-error", "has-success");
    const label = pid && PAGES[pid] ? `→ ${PAGES[pid].label}` : "";
    if (err === 0) {
      el.classList.add("has-success");
      el.textContent = `✓ ${ok} 行可导入 ${label}`;
    } else {
      el.classList.add("has-error");
      el.textContent = `✓ ${ok} 行 / ✗ ${err} 行解析失败 ${label}`;
    }
  }

  function renderImportPreview(rows, pid) {
    const wrap = $("#import-preview");
    if (!rows || rows.length === 0) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = rows
      .map((r) => {
        if (r._error) {
          return `
            <div class="preview-row preview-error" title="${escapeHtml(r._error)}">
              <span class="preview-no">#${r._line || "-"}</span>
              <span class="preview-title">⚠ ${escapeHtml(r._error)}</span>
              <span class="preview-len">失败</span>
            </div>`;
        }
        // 显示：序号 + 主标题
        const main =
          pid === "foreshadowing"
            ? r.name || "（无名）"
            : r.title || "（无标题）";
        return `
          <div class="preview-row">
            <span class="preview-no">${escapeHtml(String(r.no))}</span>
            <span class="preview-title" title="${escapeHtml(main)}">${escapeHtml(main)}</span>
            <span class="preview-len">${charCount(r.content || r.notes)}字</span>
          </div>`;
      })
      .join("");
  }


  /* ============================================================
     事件：文件 / 列表点击 / 编辑器按钮
     ============================================================ */
  // v16：新建空白文件
  // - 有用户数据时弹 confirm，确认后先 saveAsJson({silent:true}) 备份到当前写盘位置，再重置 state
  // - 重置 state.pages（每个 page 走 makePageState()）/ sheetsRaw / 4 个文件名 / history 栈
  // - 故意保留 state.directoryHandleKey（之前授权过的写盘目录继续可用，新建后保存直接写到该目录）
  async function createNewFile() {
    if (hasAnyUserData()) {
      const ok = window.confirm(
        "确定要新建空白文件吗？\n\n" +
        "当前数据会保留在内存中，新建后会清空。\n" +
        "如果浏览器已经授权过写盘目录，已写盘的内容会继续保留；\n" +
        "未写盘的内容会先尝试自动备份一次。\n\n" +
        "确定继续？"
      );
      if (!ok) return;
      // 先尝试静默备份（如果有写盘权限/handle，走静默路径；否则兜底会下载到本地）
      try {
        await saveAsJson({ silent: true });
      } catch (e) {
        console.warn("新建前备份失败：", e);
      }
    }
    // 重置 state
    state.pages = {
      chapter: makePageState(),
      foreshadowing: makePageState(),
    };
    state.sheetsRaw = [];
    state.currentFileName = null;
    state.xlsxFileName = null;
    state.jsonFileName = null;
    state.jsonHandleKey = null;
    state.directoryName = null;
    // 故意保留 state.directoryHandleKey —— 让之前授权过的写盘目录继续可用
    // 清空 history 栈
    history.stack = [];
    history.idx = -1;
    save();
    renderAll();
    // 刷新自动写盘按钮文案（因为 directoryName 重置了）
    if (typeof updateAutosaveButton === "function") updateAutosaveButton();
    // 刷新右下角"实际写入文件"显示
    if (typeof updateFilePathDisplay === "function") updateFilePathDisplay();
    toast("已新建空白文件", "info", 1500);
  }

  function bindFileEvents() {
    // v10：数据源下拉菜单已移除。openFileByName 现在只被 openDirectory（文件夹内文件列表）调用。
    // 这里不再绑定 #file-select（已删除）。

    $("#file-pick").addEventListener("click", () => {
      if (!fsSupported()) {
        toast("当前浏览器不支持 File System Access API", "error", 4000);
        return;
      }
      openFileModalReset();
      showModal("modal-open-file");
    });

    $("#file-pick-dir").addEventListener("click", () => {
      if (!fsSupported()) {
        toast("当前浏览器不支持 File System Access API", "error", 4000);
        return;
      }
      showModal("modal-open-dir");
    });

    // v16：左上角"新建文件"按钮
    $("#file-new")?.addEventListener("click", createNewFile);

    $("#btn-open-dir-pick").addEventListener("click", async () => {
      try {
        const dirHandle = await pickDirectory();
        if (!dirHandle) return;
        hideModal("modal-open-dir");
        await openDirectory(dirHandle);
      } catch (e) {
        if (e.name === "AbortError") return;
        console.error(e);
        toast("选择文件夹失败：" + (e.message || e), "error", 3000);
      }
    });

    // ----- 打开文件弹窗 -----
    let openFilePending = null;
    function openFileModalReset() {
      openFilePending = null;
      const info = $("#open-file-info");
      if (info) info.hidden = true;
      const drop = $("#open-file-drop");
      if (drop) drop.classList.remove("is-dragover");
      const confirm = $("#btn-open-file-confirm");
      if (confirm) {
        confirm.disabled = true;
        confirm.dataset.file = "";
      }
      const fi = $("#file-xlsx-open");
      if (fi) fi.value = "";
    }
    function setOpenFilePending(file) {
      openFilePending = file;
      const info = $("#open-file-info");
      if (info) {
        info.hidden = false;
        info.querySelector(".import-file-name").textContent =
          `${file.name}（${formatSize(file.size)}）`;
      }
      const confirm = $("#btn-open-file-confirm");
      if (confirm) {
        confirm.disabled = false;
        confirm.dataset.file = "1";
      }
    }
    const openDrop = $("#open-file-drop");
    const openInput = $("#file-xlsx-open");
    if (openDrop && openInput) {
      openDrop.addEventListener("click", () => openInput.click());
      openDrop.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openInput.click();
        }
      });
      openInput.addEventListener("change", (e) => {
        const f = e.target.files?.[0];
        if (f) setOpenFilePending(f);
        e.target.value = "";
      });
      ["dragenter", "dragover"].forEach((evt) =>
        openDrop.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
          openDrop.classList.add("is-dragover");
        })
      );
      ["dragleave", "drop"].forEach((evt) =>
        openDrop.addEventListener(evt, (e) => {
          e.preventDefault();
          e.stopPropagation();
          openDrop.classList.remove("is-dragover");
        })
      );
      openDrop.addEventListener("drop", (e) => {
        const f = e.dataTransfer?.files?.[0];
        if (f) setOpenFilePending(f);
      });
    }
    $("#btn-open-file-clear")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openFileModalReset();
    });
    $("#btn-open-file-confirm")?.addEventListener("click", async () => {
      if (!openFilePending) return;
      const f = openFilePending;
      openFileModalReset();
      await loadFromFile(f);
    });

    // v10：file-remove 按钮已移除（下拉菜单不在了，「从列表移除」入口也拿掉）。
    // 仍然可以从「主题设置 → 数据 → 导出 xlsx / json」里手动操作；后续如需批量管理再加。

    $("#fs-grant").addEventListener("click", async () => {
      const meta = state.recentFiles.find(
        (f) => f.name === state.currentFileName
      );
      if (!meta) {
        toast("请重新选择文件", "error");
        return;
      }
      if (!meta.handleKey) {
        toast("该文件没有保存访问权限，请重新选择文件", "error");
        return;
      }
      const handle = await fsGet(meta.handleKey);
      if (!handle) {
        toast("访问权限已失效，请重新选择文件", "error");
        return;
      }
      const granted = await ensureReadPermission(handle, true);
      if (granted) {
        $("#fs-banner").hidden = true;
        toast("授权成功", "info", 1500);
        await loadFromHandle(handle, meta);
      } else {
        toast("未授权", "error");
      }
    });
  }

  function bindListEvents() {
    // 事件委托 - 两个列表共用
    const chapterList = $("#chapter-list");
    const fsList = $("#fs-list");
    const onClick = (e) => {
      // 章节列表的"删除"叉号优先处理，阻止冒泡（避免触发选中）
      if (e.target.closest(".ch-delete")) {
        e.stopPropagation();
        const id = e.target.closest(".ch-delete").dataset.id;
        if (!id) return;
        // 先选中该项（让 deleteCurrentItem 找到 curItem），再删
        curPage().currentItemId = id;
        deleteCurrentItem();
        return;
      }
      // v16：伏笔列表的"删除"叉号，行为和章节一致
      if (e.target.closest(".fs-delete")) {
        e.stopPropagation();
        const id = e.target.closest(".fs-delete").dataset.id;
        if (!id) return;
        // 先选中该项（让 deleteCurrentItem 找到 curItem），再删
        curPage().currentItemId = id;
        deleteCurrentItem();
        return;
      }
      const item = e.target.closest(".ch-item, .fs-item");
      if (!item) return;
      // 切到同一条则不做事（避免无谓的 history 抖动）
      if (curPage().currentItemId === item.dataset.id) return;
      // v7：切章节前先保存当前编辑器的输入到 item（防止未保存内容丢失）
      // v17：伏笔页只在编辑态（fsEditing）才需要保存；查看态切伏笔无意义也不该写入
      // （编辑态可能改过 fsNo/name/status/履历；查看态只读，DOM 本身无未存改动）
      if (state.currentPage === "chapter" || (state.currentPage === "foreshadowing" && state.ui.fsEditing)) {
        try { saveCurrentItem(); } catch (_) {}
      }
      curPage().currentItemId = item.dataset.id;
      save();
      renderCurrentPage();
    };
    if (chapterList) chapterList.addEventListener("click", onClick);
    if (fsList) fsList.addEventListener("click", onClick);
  }

  function bindEditorButtons() {
    // 章节页：新增 / 导入 / 排序
    $("#btn-new")?.addEventListener("click", addNewItem);
    $("#btn-new-fs")?.addEventListener("click", addNewItem);
    // 编辑器按钮是动态生成的，用事件委托
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;
      const isSave = t.id === "btn-save" || t.id === "btn-fs-save";
      // v17：#btn-fs-delete 已被移除（删除统一在左侧 .fs-delete 叉号）
      const isDelete = t.id === "btn-delete";
      if (isSave && curItem()) {
        const ok = saveCurrentItem();
        if (ok) {
          // v10.1：toast 已经提示，#save-status 不再重复（避免冗余）
          saveAsJson();
        }
      } else if (isDelete && curItem()) {
        deleteCurrentItem();
      }
    });
    // 排序（仅章节页）
    $("#btn-sort")?.addEventListener("click", () => {
      const prev = state.ui.sort;
      state.ui.sort = prev === "asc" ? "desc" : "asc";
      save();
      // 排序改动不压栈（数据本身没变，只换展示）
      renderCurrentPage();
    });
    // v18：伏笔页排序（按伏笔编号）
    $("#btn-fs-sort")?.addEventListener("click", () => {
      state.ui.fsSort = state.ui.fsSort === "asc" ? "desc" : "asc";
      save();
      renderFsList();
    });
    // v18：伏笔页状态筛选（全部 / 未回收 / 部分回收 / 已回收）
    const segFsStatus = $("#seg-fs-status");
    if (segFsStatus) {
      segFsStatus.addEventListener("click", (e) => {
        const btn = e.target.closest(".seg-btn[data-fs-status]");
        if (!btn) return;
        const v = btn.dataset.fsStatus || "all";
        if (state.ui.fsStatusFilter === v) return;
        state.ui.fsStatusFilter = v;
        save();
        renderFsList();
      });
    }
    // 撤销 / 重做
    $("#btn-undo")?.addEventListener("click", undo);
    $("#btn-redo")?.addEventListener("click", redo);

    // 全局快捷键
    document.addEventListener("keydown", (e) => {
      const inEditable =
        e.target &&
        (e.target.tagName === "INPUT" ||
          e.target.tagName === "TEXTAREA" ||
          e.target.tagName === "SELECT" ||
          e.target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey; // Mac 用 Cmd，Win/Linux 用 Ctrl

      // Ctrl+S / Cmd+S：保存当前章节（性能优先：写 json 而非 xlsx）
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (!curItem()) {
          toast("没有选中的条目可保存", "error", 1500);
          return;
        }
        const ok = saveCurrentItem();
        if (ok) {
          // v10.1：toast 已经提示，#save-status 不再重复（避免冗余）
          saveAsJson();
        }
        return;
      }
      // Ctrl+Z / Cmd+Z：撤销
      if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        undo();
        return;
      }
      // Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y：重做
      if (
        (mod && e.shiftKey && (e.key === "z" || e.key === "Z")) ||
        (mod && (e.key === "y" || e.key === "Y"))
      ) {
        e.preventDefault();
        redo();
        return;
      }
    });
  }

  function bindTabs() {
    $$(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".tab").forEach((t) => t.classList.remove("active"));
        $$(".tab-panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        $(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
      });
    });
  }

  function bindThemeEvents() {
    $$(".seg-btn[data-bg]").forEach((b) =>
      b.addEventListener("click", () => {
        state.theme.bg = b.dataset.bg;
        save();
        renderTheme();
      })
    );
    $$(".seg-btn[data-accent]").forEach((b) =>
      b.addEventListener("click", () => {
        state.theme.accent = b.dataset.accent;
        save();
        renderTheme();
      })
    );
    $$(".seg-btn[data-font]").forEach((b) =>
      b.addEventListener("click", () => {
        state.theme.font = b.dataset.font;
        save();
        renderTheme();
        toast(`已切换为${b.textContent.trim()}字体`);
      })
    );
    $$(".seg-btn[data-autosave]").forEach((b) =>
      b.addEventListener("click", () => {
        state.theme.autosaveMs = Number(b.dataset.autosave) || 0;
        save();
        renderTheme();
        startAutosave();
        if (state.theme.autosaveMs > 0) {
          toast(`自动保存：每 ${formatMinutes(state.theme.autosaveMs)} 一次`);
        } else {
          toast("自动保存已关闭");
        }
      })
    );
    $("#font-size").addEventListener("input", (e) => {
      state.theme.fontSize = Number(e.target.value);
      $("#font-size-val").textContent = state.theme.fontSize;
      save();
      renderTheme();
    });
    $("#line-height").addEventListener("input", (e) => {
      state.theme.lineHeight = Number(e.target.value);
      $("#line-height-val").textContent = state.theme.lineHeight.toFixed(2);
      save();
      renderTheme();
    });

    // 导出 xlsx（手动触发；日常保存走 json）
    $("#btn-export").addEventListener("click", async () => {
      const ok = await saveAsXlsx();
      if (ok) toast("已导出 xlsx", "info", 1500);
    });
    // 导出 json（备份 / 迁移用）
    $("#btn-export-json")?.addEventListener("click", () => {
      const blob = buildJsonBlob();
      const base = (state.currentFileName || "novel-app")
        .replace(/\.(xlsx|xlsm|json)$/i, "");
      triggerJsonDownload(blob, `${base}.json`);
      toast("已导出 json", "info", 1500);
    });
    // v9：启用自动写盘（授权目录，让保存直接写 json 到磁盘）
    $("#btn-enable-autosave")?.addEventListener("click", () => {
      enableAutoSave();
    });
    // v11：按钮文字初始化（已配置则显示「写盘目录：xxx」，未配置则提示「建议 D:/yuelan」）
    updateAutosaveButton();

    // JSON 导入走「打开文件」弹窗的拖入区（v8+），这里不再单独挂事件
  }

  /* ============================================================
     布局可调宽度 - resizer 拖拽
     ============================================================ */
  const LAYOUT_DEFAULTS = {
    nav: 220,
    threeList: 280,
    threeRight: 320,
    twoList: 320,
  };
  const LAYOUT_LIMITS = {
    nav: { min: 160, max: 380 },
    threeList: { min: 200, max: 560 },
    threeRight: { min: 240, max: 680 },
    twoList: { min: 200, max: 560 },
  };

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  // 根据 key 找到对应的 CSS 变量名
  const RESIZER_VAR = {
    nav: "--nav-width",
    "three-list": "--col-list-width",
    "three-right": "--col-right-width",
    "two-list": "--two-col-list-width",
  };
  const RESIZER_DEFAULT = {
    nav: LAYOUT_DEFAULTS.nav,
    "three-list": LAYOUT_DEFAULTS.threeList,
    "three-right": LAYOUT_DEFAULTS.threeRight,
    "two-list": LAYOUT_DEFAULTS.twoList,
  };

  // 初始化：把 state.ui.layout 写到 CSS 变量上
  function applyLayout() {
    const layout = state.ui.layout || {};
    const set = (k, v) => {
      const cssVar = RESIZER_VAR[k];
      const def = RESIZER_DEFAULT[k];
      const lim = LAYOUT_LIMITS[RESIZER_DEFAULT_KEY[k]];
      const n = clamp(Number(v || def), lim.min, lim.max);
      document.documentElement.style.setProperty(cssVar, `${n}px`);
    };
    set("nav", layout.nav);
    set("three-list", layout.threeList);
    set("three-right", layout.threeRight);
    set("two-list", layout.twoList);
  }
  const RESIZER_DEFAULT_KEY = {
    nav: "nav",
    "three-list": "threeList",
    "three-right": "threeRight",
    "two-list": "twoList",
  };

  // 写入 state.ui.layout 并持久化
  function saveLayout(key, value) {
    if (!state.ui.layout) state.ui.layout = {};
    const k = RESIZER_DEFAULT_KEY[key];
    state.ui.layout[k] = value;
    save();
  }

  // 单个 resizer 的拖拽行为
  function bindResizer(el) {
    const key = el.dataset.resizer;
    if (!key || !RESIZER_VAR[key]) return;
    const cssVar = RESIZER_VAR[key];
    const def = RESIZER_DEFAULT[key];
    const lim = LAYOUT_LIMITS[RESIZER_DEFAULT_KEY[key]];
    // 右侧栏（three-right）位于布局最右，鼠标拖右时栏应变窄，方向与鼠标相反
    const dir = key === "three-right" ? -1 : 1;

    let startX = 0;
    let startVal = 0;
    let dragging = false;

    const onDown = (e) => {
      // 只接受左键 / 单指触摸
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      el.classList.add("is-dragging");
      document.body.classList.add("is-resizing");
      const cur = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(cssVar),
        10
      );
      startVal = Number.isFinite(cur) ? cur : def;
      startX = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
    };

    const onMove = (e) => {
      if (!dragging) return;
      const x = e.clientX ?? (e.touches && e.touches[0]?.clientX) ?? 0;
      const dx = x - startX;
      // 鼠标拖右（dx > 0）：
      //   - nav / three-list / two-list 在左侧 → 栏应变宽（dir = +1）
      //   - three-right 在最右侧 → 栏应变窄（dir = -1）
      const newVal = startVal + dx * dir;
      const clamped = clamp(newVal, lim.min, lim.max);
      document.documentElement.style.setProperty(cssVar, `${clamped}px`);
    };

    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      const cur = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(cssVar),
        10
      );
      if (Number.isFinite(cur)) {
        saveLayout(key, cur);
      }
      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    // 双击重置
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      document.documentElement.style.setProperty(cssVar, `${def}px`);
      saveLayout(key, def);
      toast("已重置宽度", "info", 1000);
    });

    // 键盘左右键微调（accessibility）
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 32 : 8;
      const cur = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(cssVar),
        10
      );
      const startVal = Number.isFinite(cur) ? cur : def;
      let next = startVal;
      // 方向与拖拽保持一致：three-right 按 ← 变宽、按 → 变窄
      if (e.key === "ArrowLeft") next -= step * dir;
      else if (e.key === "ArrowRight") next += step * dir;
      else if (e.key === "Home") next = lim.min;
      else if (e.key === "End") next = lim.max;
      else return;
      e.preventDefault();
      const clamped = clamp(next, lim.min, lim.max);
      document.documentElement.style.setProperty(cssVar, `${clamped}px`);
      saveLayout(key, clamped);
    });
  }

  function bindAllResizers() {
    $$(".resizer").forEach(bindResizer);
  }

  /* ============================================================
     全局搜索
     - 输入框：toolbar 上撤销/重做右侧
     - 范围：所有 PAGES（chapter / foreshadowing）所有 item
     - 字段：chapter → no / title / content；foreshadowing → no / name / setup / payoff / status / notes
     - 匹配：忽略大小写、子串匹配；snippet 显示命中前后 30 字
     - 结果：弹下拉，点击切换到对应 page + item
     ============================================================ */
  const SEARCH_RESULT_LIMIT = 50;
  const SEARCH_SNIPPET_RADIUS = 30;
  const searchState = {
    query: "",
    activeIdx: 0,
    results: [],
  };

  // 提取命中位置 + 周围片段（高亮命中部分）
  // occ = 第几个命中（0-based）；传 -1 时取第一个
  function buildSnippet(text, query, occ = 0) {
    if (!text) return { html: "", found: false, pos: -1 };
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let idx = -1;
    let cur = -1;
    for (let i = 0; i <= occ; i++) {
      cur = lower.indexOf(q, cur + 1);
      if (cur < 0) break;
      idx = cur;
    }
    if (idx < 0) return { html: "", found: false, pos: -1 };
    const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + query.length + SEARCH_SNIPPET_RADIUS);
    const before = (start > 0 ? "…" : "") + escapeHtml(text.slice(start, idx));
    const hit = `<mark>${escapeHtml(text.slice(idx, idx + query.length))}</mark>`;
    const after = escapeHtml(text.slice(idx + query.length, end)) + (end < text.length ? "…" : "");
    return { html: `${before}${hit}${after}`, found: true, pos: idx };
  }

  // 找字段里所有命中位置（不区分大小写）
  function findAllOccurrences(text, query) {
    if (!text || !query) return [];
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    const out = [];
    let cur = -1;
    while (true) {
      cur = lower.indexOf(q, cur + 1);
      if (cur < 0) break;
      out.push(cur);
      if (out.length >= 20) break; // 防止极长内容把结果列表撑爆
    }
    return out;
  }

  function gatherSearchResults(query) {
    const results = [];
    const q = query.toLowerCase();
    for (const pid of PAGE_IDS) {
      const def = PAGES[pid];
      const page = state.pages[pid];
      if (!def || !page || page.items.length === 0) continue;
      for (const it of page.items) {
        // 按字段优先级：title 类字段先看，没命中再看 content 类字段
        const fields = def.fields;
        const primaryKeys = pid === "chapter"
          ? ["title", "no", "content"]
          : ["name", "no", "setup", "payoff", "status", "notes"];
        let titleHit = null;
        const contentSnippets = []; // 多个 content 命中
        let matchedField = null;
        for (const key of primaryKeys) {
          const label = def.fields[key] ? def.fields[key][0] : key;
          const v = it[key];
          if (v == null) continue;
          const strVal = String(v);
          if (strVal.toLowerCase().indexOf(q) < 0) continue;
          if (key === "no" || key === "title" || key === "name" || key === "status") {
            // 短字段：只记一次
            if (!titleHit) {
              titleHit = { key, label, value: strVal };
              if (!matchedField) matchedField = label;
            }
          } else {
            // 长字段（content / notes / setup / payoff）：每个命中位置都生成一条结果
            const occs = findAllOccurrences(strVal, query);
            occs.forEach((pos, occIdx) => {
              const snip = buildSnippet(strVal, query, occIdx);
              if (snip.found) {
                contentSnippets.push({
                  html: snip.html,
                  pos,
                  field: key,
                  label,
                  occIdx,
                });
                if (!matchedField) matchedField = label;
              }
            });
          }
        }
        if (!titleHit && contentSnippets.length === 0) continue;
        // 标题：no + title/name
        const tlabel = pid === "chapter"
          ? `${formatItemNo(it.no)}${it.title ? " · " + it.title : ""}`
          : `${formatItemNo(it.no)}${it.name ? " · " + it.name : ""}`;
        if (titleHit && contentSnippets.length === 0) {
          // 只在短字段命中——一条结果
          const display = buildSnippet(String(titleHit.value), query, 0);
          results.push({
            pageId: pid,
            pageLabel: def.label,
            pageIcon: def.icon,
            itemId: it.id,
            sheet: it.sheet,
            field: titleHit.key,
            occIdx: 0,
            pos: display.pos,
            title: tlabel,
            snippetHtml: display.html,
            matchedField,
          });
        } else if (!titleHit && contentSnippets.length > 0) {
          // 只在长字段命中——每处一次（按位置升序）
          contentSnippets.forEach((s) => {
            results.push({
              pageId: pid,
              pageLabel: def.label,
              pageIcon: def.icon,
              itemId: it.id,
              sheet: it.sheet,
              field: s.field,
              occIdx: s.occIdx,
              pos: s.pos,
              title: tlabel,
              snippetHtml: s.html,
              matchedField: s.label,
            });
          });
        } else {
          // 短字段 + 长字段都命中：短字段出一条；长字段每个位置出一次
          const display = buildSnippet(String(titleHit.value), query, 0);
          results.push({
            pageId: pid,
            pageLabel: def.label,
            pageIcon: def.icon,
            itemId: it.id,
            sheet: it.sheet,
            field: titleHit.key,
            occIdx: 0,
            pos: display.pos,
            title: tlabel,
            snippetHtml: display.html,
            matchedField: titleHit.label,
          });
          contentSnippets.forEach((s) => {
            results.push({
              pageId: pid,
              pageLabel: def.label,
              pageIcon: def.icon,
              itemId: it.id,
              sheet: it.sheet,
              field: s.field,
              occIdx: s.occIdx,
              pos: s.pos,
              title: tlabel,
              snippetHtml: s.html,
              matchedField: s.label,
            });
          });
        }
        if (results.length >= SEARCH_RESULT_LIMIT) break;
      }
      if (results.length >= SEARCH_RESULT_LIMIT) break;
    }
    // 按 pos 升序、再按 itemId 分组排序
    results.sort((a, b) => {
      if (a.itemId === b.itemId) return a.pos - b.pos;
      return 0; // 保持原本页/项顺序
    });
    return results;
  }

  function formatItemNo(no) {
    if (no == null || no === "") return "—";
    return String(no);
  }

  function renderSearchResults() {
    const wrap = $("#search-results");
    const meta = $("#search-meta");
    if (!wrap) return;
    const q = searchState.query.trim();
    if (!q) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      return;
    }
    searchState.results = gatherSearchResults(q);
    if (searchState.results.length === 0) {
      wrap.innerHTML = `<div class="search-empty">未找到包含「${escapeHtml(q)}」的内容</div>`;
      wrap.hidden = false;
      return;
    }
    const totalLabel = searchState.results.length >= SEARCH_RESULT_LIMIT
      ? `（前 ${SEARCH_RESULT_LIMIT} 条）`
      : `（共 ${searchState.results.length} 条）`;
    const metaHtml = `<div class="search-meta">在所有 tab 中找到匹配${totalLabel}：按 Enter 跳转</div>`;
    const items = searchState.results.map((r, i) => {
      const active = i === searchState.activeIdx ? "is-active" : "";
      const sheetTag = r.sheet ? `<span class="search-result-tag">${escapeHtml(r.sheet)}</span>` : "";
      // 在长字段里第几处出现，仅当 occIdx > 0 时显示「第2处/第3处…」
      const occTag = r.occIdx > 0
        ? `<span class="search-result-occ">第 ${r.occIdx + 1} 处</span>`
        : "";
      return `<div class="search-result ${active}" data-idx="${i}">
        <div class="search-result-title">${sheetTag}<span>${escapeHtml(r.title)}</span>${occTag}</div>
        ${r.snippetHtml ? `<div class="search-result-snippet">${r.snippetHtml}</div>` : ""}
      </div>`;
    }).join("");
    wrap.innerHTML = metaHtml + items;
    wrap.hidden = false;
  }

  function jumpToSearchResult(idx) {
    const r = searchState.results[idx];
    if (!r) return;
    if (state.currentPage !== r.pageId) {
      state.currentPage = r.pageId;
    }
    const page = state.pages[r.pageId];
    page.currentItemId = r.itemId;
    // 跳到该 item 所在的 sheet
    if (r.sheet) {
      page.currentSheet = r.sheet;
    }
    save();
    renderAll();
    // 让编辑区滚到顶部，光标定位到具体命中位置
    const ta = $("#ch-content") || $("#fs-notes");
    if (ta) {
      // 用 r.pos 定位到具体匹配（多结果时各条跳到不同位置）
      const text = ta.value;
      const lower = text.toLowerCase();
      const q = searchState.query.toLowerCase();
      let pos = -1;
      if (r.pos >= 0) {
        // 先用 occIdx 重新定位（防止 content 切换时 pos 已变）
        let cur = -1;
        for (let i = 0; i <= r.occIdx; i++) {
          cur = lower.indexOf(q, cur + 1);
          if (cur < 0) break;
          pos = cur;
        }
      }
      if (pos < 0) {
        pos = lower.indexOf(q);
      }
      if (pos >= 0) {
        ta.focus();
        ta.setSelectionRange(pos, pos + searchState.query.length);
        // 滚动 textarea，让光标位置可见
        try {
          const cs = window.getComputedStyle(ta);
          const lineHeight = parseFloat(cs.lineHeight) || 22;
          const paddingTop = parseFloat(cs.paddingTop) || 0;
          const before = ta.value.slice(0, pos);
          const lines = before.split("\n").length;
          // 让光标行出现在 textarea 上方约 1/4 处
          const targetTop = Math.max(0, (lines - 5) * lineHeight);
          ta.scrollTop = targetTop;
        } catch (_) {}
      } else {
        ta.focus();
      }
    }
    // 关闭下拉
    hideSearchResults();
  }

  function hideSearchResults() {
    const wrap = $("#search-results");
    if (wrap) {
      wrap.hidden = true;
      wrap.innerHTML = "";
    }
    searchState.activeIdx = 0;
  }

  function bindSearchEvents() {
    const input = $("#search-input");
    const clear = $("#search-clear");
    const wrap = $("#search-wrap");
    if (!input) return;
    let debounce = null;
    input.addEventListener("input", () => {
      const v = input.value;
      searchState.query = v;
      searchState.activeIdx = 0;
      if (clear) clear.hidden = !v;
      clearTimeout(debounce);
      debounce = setTimeout(renderSearchResults, 120);
    });
    input.addEventListener("focus", () => {
      if (searchState.query.trim()) renderSearchResults();
    });
    input.addEventListener("keydown", (e) => {
      const q = searchState.query.trim();
      if (e.key === "Escape") {
        input.value = "";
        searchState.query = "";
        if (clear) clear.hidden = true;
        hideSearchResults();
        input.blur();
        e.preventDefault();
        return;
      }
      if (!q) return;
      if (e.key === "ArrowDown") {
        if (searchState.results.length === 0) return;
        searchState.activeIdx = (searchState.activeIdx + 1) % searchState.results.length;
        renderSearchResults();
        scrollActiveResultIntoView();
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        if (searchState.results.length === 0) return;
        searchState.activeIdx = (searchState.activeIdx - 1 + searchState.results.length) % searchState.results.length;
        renderSearchResults();
        scrollActiveResultIntoView();
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (searchState.results.length === 0) return;
        jumpToSearchResult(searchState.activeIdx);
        e.preventDefault();
      }
    });
    if (clear) {
      clear.addEventListener("click", () => {
        input.value = "";
        searchState.query = "";
        clear.hidden = true;
        hideSearchResults();
        input.focus();
      });
    }
    // 点击结果项
    $("#search-results")?.addEventListener("mousedown", (e) => {
      // 用 mousedown 而非 click，避免 input 失焦先把结果隐藏
      const t = e.target.closest(".search-result");
      if (!t) return;
      const idx = Number(t.dataset.idx);
      if (Number.isFinite(idx)) jumpToSearchResult(idx);
    });
    // 点外部关闭
    document.addEventListener("click", (e) => {
      if (!wrap) return;
      if (!wrap.contains(e.target)) hideSearchResults();
    });
  }

  function scrollActiveResultIntoView() {
    const wrap = $("#search-results");
    if (!wrap) return;
    const el = wrap.querySelector(".search-result.is-active");
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: "nearest" });
    }
  }

  /* ============================================================
     章节号 / 序号 解析 - 兼容字符串
     数字字符串：直接转 Number
     混合（如「第12章」「Chapter 5」「卷一 第三章」）：正则提取第一个数字
     纯中文数字（如「第一章」「第二十章」）：中文数字解析
     纯汉字（如「序章」「楔子」「番外」「后记」）：保字符串，按 localeCompare 排
     ============================================================ */
  const CN_NUM_MAP = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

  // 简易中文数字解析：支持 一 / 十二 / 二十 / 二十五 / 一百零五 / 三百二十五 / 一千 / 〇
  // 不支持万以上复杂组合（对章节号足够）
  function parseChineseNumeral(s) {
    if (!s) return null;
    if (!/^[零〇一二两三四五六七八九十百千]+$/.test(s)) return null;
    let section = 0;
    let lastDigit = null;
    let anyDigit = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch in CN_NUM_MAP) {
        lastDigit = CN_NUM_MAP[ch];
        anyDigit = true;
      } else if (ch === "十") {
        // 上一个数字 * 10（无数字时按 1 处理，即"十"=10）
        section += (lastDigit ?? 1) * 10;
        lastDigit = null;
        anyDigit = true;
      } else if (ch === "百") {
        section += (lastDigit ?? 1) * 100;
        lastDigit = null;
        anyDigit = true;
      } else if (ch === "千") {
        section += (lastDigit ?? 1) * 1000;
        lastDigit = null;
        anyDigit = true;
      } else {
        return null;
      }
    }
    // 结尾还有个位数
    if (lastDigit != null) section += lastDigit;
    return anyDigit ? section : null;
  }

  // 解析章节号，返回 { num, str, hasNum }
  //   num: 数字 key（无数字则为 Infinity，排在所有有数字之后）
  //   str: 原始字符串 key（保证稳定排序）
  //   hasNum: 是否有数字部分（写回时区分）
  function parseChapterNo(raw) {
    if (raw == null) return { num: Infinity, str: "", raw: "", hasNum: false };
    const s = String(raw).trim();
    if (!s) return { num: Infinity, str: "", raw: "", hasNum: false };
    // 1. 纯数字
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n)) return { num: n, str: s, raw: s, hasNum: true };
    }
    // 2. 字符串中含阿拉伯数字 → 取第一段连续数字
    const m = s.match(/-?\d+(\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return { num: n, str: s, raw: s, hasNum: true };
    }
    // 3. 字符串中含「第X章/节/卷」 → 把 X 解析成数字
    const cn = s.match(/第([零〇一二两三四五六七八九十百千]+)/);
    if (cn) {
      const n = parseChineseNumeral(cn[1]);
      if (n != null) return { num: n, str: s, raw: s, hasNum: true };
    }
    // 4. 字符串整体就是中文数字（"一"/"二十"/"三百零五"）
    const allCn = parseChineseNumeral(s);
    if (allCn != null) return { num: allCn, str: s, raw: s, hasNum: true };
    // 5. 纯汉字（"序章"/"楔子"/"番外"/"后记"）→ 按字符串排序
    return { num: Infinity, str: s, raw: s, hasNum: false };
  }

  // 比较两个 parseChapterNo 结果：先按 num（升序），再按 str（localeCompare）
  function compareChapterNo(a, b) {
    if (a.num !== b.num) return a.num - b.num;
    return a.str.localeCompare(b.str, "zh-Hans-CN");
  }

  /* ============================================================
     初始化
     ============================================================ */
  async function init() {
    load();
    // 把 state.ui.layout 写到 CSS 变量（在 renderAll 之前，避免布局闪一下）
    applyLayout();
    renderAll();

    if (!fsSupported()) {
      $("#fs-unsupported").hidden = false;
    }

    bindFileEvents();
    bindListEvents();
    bindEditorButtons();
    bindImportEvents();
    bindTabs();
    bindThemeEvents();
    bindAllResizers();
    bindSearchEvents();

    // 初始化 history：在当前 state 上压一个"基线"快照，让用户可以 undo 回到打开状态
    pushHistory();
    updateUndoRedoButtons();

    // 启动自动保存（state.theme.autosaveMs 决定）
    startAutosave();

    // 跨标签页同步
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) {
        load();
        renderAll();
        // 跨标签页后重置 history（避免引用陈旧快照）
        resetHistory();
        pushHistory();
        startAutosave();
      }
    });

    // ESC 关闭弹窗
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $$(".modal").forEach((m) => (m.hidden = true));
      }
    });

    // data-close 委托
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-close]");
      if (!t) return;
      const modal = t.closest(".modal");
      if (modal) modal.hidden = true;
    });

    tryAutoRestore();
  }

  async function tryAutoRestore() {
    if (!fsSupported()) return;
    if (!state.currentFileName) return;
    const meta = state.recentFiles.find(
      (f) => f.name === state.currentFileName
    );
    if (!meta || !meta.handleKey) return;
    try {
      const handle = await fsGet(meta.handleKey);
      if (!handle) {
        await removeRecentFile(meta.name);
        renderAll();
        return;
      }
      let granted = false;
      try {
        const cur = await handle.queryPermission({ mode: "read" });
        granted = cur === "granted";
      } catch (_) {
        granted = false;
      }
      if (!granted) {
        $("#fs-banner").hidden = false;
        renderFileSelect();
        return;
      }
      await loadFromHandle(handle, meta);
    } catch (e) {
      console.error("自动恢复失败", e);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
