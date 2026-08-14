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
  const SCHEMA_VERSION = 6;
  const FS_DB_NAME = "novel-app-fs";
  const FS_STORE = "handles";

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
  const FS_STATUS_OPTIONS = ["活跃", "已回收", "已废弃"];

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
      fields: {
        no: ["序号", "编号", "no", "number", "id", "序", "伏笔号"],
        name: ["名称", "伏笔名", "伏笔", "name", "title", "线索", "名字"],
        setup: [
          "铺设章节",
          "铺设",
          "埋设",
          "埋设章节",
          "setup",
          "setup_chapter",
          "埋点",
          "出现章节",
          "铺设章",
          "开始章节",
        ],
        payoff: [
          "回收章节",
          "回收",
          "揭晓",
          "揭晓章节",
          "payoff",
          "payoff_chapter",
          "回收章",
          "结束章节",
        ],
        status: ["状态", "status", "state", "进度", "完成度"],
        notes: ["备注", "说明", "notes", "description", "详情", "内容"],
      },
      defaults() {
        return {
          no: 0,
          name: "",
          setup: "",
          payoff: "",
          status: "活跃",
          notes: "",
        };
      },
      makeItem(data, sheet) {
        return {
          id: uid("fs"),
          no: data.no || 0,
          name: data.name || "",
          setup: data.setup || "",
          payoff: data.payoff || "",
          status: data.status || "活跃",
          notes: data.notes || "",
          sheet,
        };
      },
      sortKey(item) {
        return parseChapterNo(item.no);
      },
      newItemLabel: "新增伏笔",
      newItemToast(sheet, no) {
        return sheet
          ? `已新增伏笔 #${no} [${sheet}]`
          : `已新增伏笔 #${no}`;
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
     状态（schema v5 - 多页面）
     ============================================================ */
  // pages[pageId] = {
  //   sheets:        [{name, columns, rowCount, ok}]  // 归到本页面的 sheet
  //   currentSheet:  string | null
  //   items:         [...]                            // 本页面的条目
  //   currentItemId: string | null
  // }
  // sheetsRaw:  [{name, rows2d, columns, rowCount, ok, page}]  // 全量 raw，写回用
  function makePageState() {
    return { sheets: [], currentSheet: null, items: [], currentItemId: null };
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
          it.no = $("#fs-no").value;
          it.name = $("#fs-name").value.trim();
          it.status = $("#fs-status").value || "活跃";
          it.setup = $("#fs-setup").value.trim();
          it.payoff = $("#fs-payoff").value.trim();
          it.notes = $("#fs-notes").value;
        }
      }
    } catch (_) {}
    // 2) 一定存 localStorage
    save();
    // 3) 尝试写回 xlsx（无 handle / 权限丢失则降级跳过）
    let written = false;
    try {
      if (typeof saveToFile === "function") {
        written = await saveToFile({ silent: true });
      }
    } catch (e) {
      // 静默失败；提示用户
      _setAutosaveStatus("已存到本地，写回 xlsx 失败（需重新授权）", "error");
      return;
    }
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    _setAutosaveStatus(
      written ? `已自动保存并写回 xlsx · ${ts}` : `已自动保存到本地 · ${ts}`,
      "saved"
    );
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
      })),
      currentFileName: state.currentFileName,
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
      state.theme = { ...DEFAULT_THEME, ...(data.theme || {}) };
      state.ui = { sort: "asc", layout: {}, ...(data.ui || {}) };
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

  async function pickXlsxFile() {
    if (!fsSupported()) throw new Error("当前浏览器不支持 File System Access API");
    const handles = await window.showOpenFilePicker({
      types: [
        {
          description: "Excel 文件",
          accept: {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
              ".xlsx",
              ".xlsm",
            ],
          },
        },
      ],
      multiple: false,
    });
    return handles[0];
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
      for (const pid of PAGE_IDS) {
        state.pages[pid] = makePageState();
      }
      state.sheetsRaw = [];
    }
    save();
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
    arr.sort((a, b) => {
      const cmp = compareChapterNo(def.sortKey(a), def.sortKey(b));
      return state.ui.sort === "asc" ? cmp : -cmp;
    });
    return arr;
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

  function findColumnIndex(header, candidates) {
    const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
    const nHeader = header.map(norm);
    const nCands = candidates.map(norm);
    for (let i = 0; i < nHeader.length; i++) {
      if (nCands.includes(nHeader[i])) return i;
    }
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
    for (const key of fieldKeys) {
      columns[key] = findColumnIndex(header, def.fields[key]);
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
      // no 字段：保留原始值（数字 / 字符串），让 sortKey 决定如何排序
      if (columns.no >= 0) {
        // 数字字符串 → 转 number；其他 → 保留字符串原始值
        const trimmed = String(data.no || "").trim();
        if (trimmed && /^-?\d+(\.\d+)?$/.test(trimmed)) {
          data.no = Number(trimmed);
        } else if (!trimmed) {
          data.no = 0;
        } else {
          // 字符串形式（"第12章"/"序章"/"Chapter 5"），保留原值，sortKey 负责解析
          data.no = trimmed;
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
  function renderFileSelect() {
    const sel = $("#file-select");
    if (state.recentFiles.length === 0) {
      sel.innerHTML = '<option value="">— 暂无文件 —</option>';
      sel.value = "";
      return;
    }
    sel.innerHTML = state.recentFiles
      .map((f) => {
        const selected = f.name === state.currentFileName ? "selected" : "";
        const icon = f.isMigrated ? "🔒" : f.isDirectory ? "📁" : "📄";
        return `<option value="${escapeHtml(f.name)}" ${selected}>${icon} ${escapeHtml(f.name)}</option>`;
      })
      .join("");
    if (state.currentFileName) sel.value = state.currentFileName;
  }

  function renderFileMeta() {
    const elText = $("#file-meta-text");
    const dot = $("#file-status");
    const removeBtn = $("#file-remove");
    const banner = $("#fs-banner");

    const cur = state.recentFiles.find(
      (f) => f.name === state.currentFileName
    );
    if (!cur) {
      elText.textContent = "请选择一个本地 xlsx 文件";
      dot.dataset.status = "";
      dot.title = "";
      removeBtn.hidden = true;
      banner.hidden = true;
      return;
    }

    // 统计所有页面的总条目数
    let total = 0;
    for (const pid of PAGE_IDS) {
      total += state.pages[pid].items.length;
    }
    const parts = [`${total} 条`];
    if (cur.mtime) {
      parts.push(`修改于 ${new Date(cur.mtime).toLocaleString()}`);
    }
    if (cur.size) parts.push(formatSize(cur.size));
    elText.textContent = parts.join(" · ");
    elText.title = cur.name;

    if (cur.isMigrated) {
      dot.dataset.status = "migrated";
      dot.title = "已迁移的旧数据，无文件访问权限";
      banner.hidden = true;
      removeBtn.hidden = true;
    } else if (cur.handleKey) {
      dot.dataset.status = "ok";
      dot.title = "已授权，可随时重新读取本地文件";
      banner.hidden = true;
      removeBtn.hidden = false;
    } else {
      dot.dataset.status = "need-perm";
      dot.title = "需要重新授权才能读取";
      banner.hidden = false;
      removeBtn.hidden = false;
    }
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
        const wc = (it.content || "").length;
        return `
          <li class="ch-item ${it.id === p.currentItemId ? "active" : ""}" data-id="${escapeHtml(it.id)}">
            <span class="ch-no">${escapeHtml(String(it.no))}</span>
            <span class="ch-title">${escapeHtml(it.title || "（无标题）")}</span>
            <span class="ch-meta">${wc}字</span>
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
    const items = getSortedItems();
    list.className = "fs-list";
    list.innerHTML = items
      .map((it) => {
        const status = it.status || "活跃";
        const cls =
          status === "已回收"
            ? "fs-status-resolved"
            : status === "已废弃"
              ? "fs-status-abandoned"
              : "fs-status-active";
        return `
          <li class="fs-item ${it.id === p.currentItemId ? "active" : ""}" data-id="${escapeHtml(it.id)}">
            <span class="fs-no">${escapeHtml(String(it.no))}</span>
            <span class="fs-name" title="${escapeHtml(it.name || "")}">${escapeHtml(it.name || "（无名）")}</span>
            <span class="fs-status ${cls}">${escapeHtml(status)}</span>
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
          <input id="ch-no" type="text" inputmode="numeric" placeholder="如：12 / 第12章 / 序章" value="${escapeHtml(String(it.no ?? ""))}" />
        </div>
        <div class="meta-field meta-title">
          <label>章节名称</label>
          <input id="ch-title" type="text" value="${escapeHtml(it.title || "")}" placeholder="给本章起个名字" />
        </div>
        <div class="meta-actions">
          <button id="btn-save" class="primary-btn">保存</button>
          <button id="btn-delete" class="danger-btn">删除</button>
        </div>
      </div>
      <div class="editor-body">
        <label class="body-label">文章内容</label>
        <textarea id="ch-content" placeholder="正文…">${escapeHtml(it.content || "")}</textarea>
        <div class="body-stats">
          <span id="word-count" class="muted">${(it.content || "").length} 字</span>
          <span id="save-status" class="muted"></span>
        </div>
      </div>`;
    bindChapterEditorEvents();
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
    editor.innerHTML = `
      <div class="editor-meta editor-meta-fs">
        <div class="meta-field meta-num">
          <label>序号</label>
          <input id="fs-no" type="text" inputmode="numeric" placeholder="如：1 / 序章" value="${escapeHtml(String(it.no ?? ""))}" />
        </div>
        <div class="meta-field meta-title">
          <label>伏笔名称</label>
          <input id="fs-name" type="text" value="${escapeHtml(it.name || "")}" placeholder="给伏笔起个名字" />
        </div>
        <div class="meta-field">
          <label>状态</label>
          <select id="fs-status">${opts}</select>
        </div>
        <div class="meta-actions">
          <button id="btn-fs-save" class="primary-btn">保存</button>
          <button id="btn-fs-delete" class="danger-btn">删除</button>
        </div>
      </div>
      <div class="editor-body">
        <div class="fs-form-row">
          <div class="meta-field">
            <label>铺设章节</label>
            <input id="fs-setup" type="text" value="${escapeHtml(it.setup || "")}" placeholder="如：第三章、第12章" />
          </div>
          <div class="meta-field">
            <label>回收章节</label>
            <input id="fs-payoff" type="text" value="${escapeHtml(it.payoff || "")}" placeholder="如：第二十章、第45章" />
          </div>
        </div>
        <label class="body-label">备注 / 详情</label>
        <textarea id="fs-notes" placeholder="伏笔的具体内容、提示、相关情节等…">${escapeHtml(it.notes || "")}</textarea>
        <div class="body-stats">
          <span id="fs-word-count" class="muted">${(it.notes || "").length} 字</span>
          <span id="fs-save-status" class="muted"></span>
        </div>
      </div>`;
    bindFsEditorEvents();
  }

  function bindChapterEditorEvents() {
    const it = curItem();
    if (!it) return;
    const chContent = $("#ch-content");
    const chNo = $("#ch-no");
    const chTitle = $("#ch-title");
    chContent?.addEventListener("input", () => {
      const len = chContent.value.length;
      const wc = $("#word-count");
      if (wc) wc.textContent = `${len} 字`;
      debouncedPushHistory();
    });
    chNo?.addEventListener("input", debouncedPushHistory);
    chTitle?.addEventListener("input", debouncedPushHistory);
  }

  function bindFsEditorEvents() {
    const it = curItem();
    if (!it) return;
    const fsNotes = $("#fs-notes");
    fsNotes?.addEventListener("input", () => {
      const len = fsNotes.value.length;
      const wc = $("#fs-word-count");
      if (wc) wc.textContent = `${len} 字`;
      debouncedPushHistory();
    });
    ["#fs-no", "#fs-name", "#fs-status", "#fs-setup", "#fs-payoff"].forEach(
      (sel) => $(sel)?.addEventListener("input", debouncedPushHistory)
    );
    ["#fs-no", "#fs-name", "#fs-status", "#fs-setup", "#fs-payoff"].forEach(
      (sel) => $(sel)?.addEventListener("change", debouncedPushHistory)
    );
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
    renderFileMeta();
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
      const ab = await readFileAsArrayBuffer(handle);
      const { sheets } = parseXlsxAllSheets(ab);
      applySheetsToState(sheets);
      const desc = await describeFile(handle);
      state.currentFileName = handle.name;
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

  async function loadFromFile(file) {
    try {
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
      save();
      pushHistory();
      renderAll();
      hideModal("modal-open-file");
      const summary = PAGE_IDS.map((pid) => {
        const n = state.pages[pid].items.length;
        return n > 0 ? `${PAGES[pid].label} ${n}` : null;
      }).filter(Boolean).join(" · ");
      toast(`已读取（本次会话）：${summary}`, "info", 1800);
    } catch (e) {
      console.error("读取失败", e);
      toast("读取失败：" + (e.message || e), "error", 3500);
    }
  }

  /* ============================================================
     写文件 - 把 state 写回 xlsx
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
    if (!state.currentFileName) throw new Error("当前没有打开的文件");
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

  async function saveToFile({ silent = false } = {}) {
    if (!state.currentFileName) {
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
      (f) => f.name === state.currentFileName
    );
    if (meta && meta.handleKey && !meta.isMigrated) {
      try {
        const handle = await fsGet(meta.handleKey);
        if (!handle) {
          triggerDownload(ab, state.currentFileName);
          if (!silent) toast("原文件访问权限已失效，已下载更新版", "info", 2500);
          return true;
        }
        const granted = await ensureWritePermission(handle, true);
        if (!granted) {
          if (!silent) toast("未获得写入权限，已下载更新版", "info", 2500);
          triggerDownload(ab, state.currentFileName);
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
          triggerDownload(ab, state.currentFileName);
          toast("写入失败，已改为下载：" + (e.message || e), "error", 3500);
        }
        return false;
      }
    } else {
      triggerDownload(ab, state.currentFileName);
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

  function triggerDownload(ab, fileName) {
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
      it.no = $("#fs-no").value;
      it.name = $("#fs-name").value.trim();
      it.status = $("#fs-status").value || "活跃";
      it.setup = $("#fs-setup").value.trim();
      it.payoff = $("#fs-payoff").value.trim();
      it.notes = $("#fs-notes").value;
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
    const nextNo = nextNoInCurrentSheet();
    const data = def.defaults();
    data.no = nextNo;
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
    toast(def.newItemToast(targetSheet, nextNo));
  }

  /* ============================================================
     导入（xlsx + 文本） - 路由到正确的页面
     ============================================================ */
  let importAllSheets = null; // xlsx 解析出的所有 sheet（含 page 分类）
  let importTargetPage = null; // 当前选中的 sheet 属于哪个 page
  let importCurrentSheet = null; // 当前选中的 sheet 名

  function bindImportEvents() {
    $("#btn-import").addEventListener("click", () => {
      $("#import-text").value = "";
      $("#import-skip-header").checked = true;
      $("#import-preview").innerHTML = "";
      $("#btn-import-confirm").disabled = true;
      $("#btn-import-confirm").dataset.parsed = "";
      $("#btn-import-confirm").dataset.sheet = "";
      $("#btn-import-confirm").dataset.page = "";
      importAllSheets = null;
      importCurrentSheet = null;
      importTargetPage = null;
      $("#import-file-info").hidden = true;
      $("#import-drop").classList.remove("is-dragover");
      const wrap = $("#import-sheet-wrap");
      if (wrap) wrap.hidden = true;
      setImportStats(null);
      // 默认把目标 page 设到当前页
      $("#import-target-wrap")?.setAttribute("hidden", "");
      showModal("modal-import");
    });

    const drop = $("#import-drop");
    const fileInput = $("#file-xlsx");
    drop.addEventListener("click", () => fileInput.click());
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (f) handleXlsxFile(f);
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
      if (f) handleXlsxFile(f);
    });

    $("#btn-import-clear").addEventListener("click", (e) => {
      e.stopPropagation();
      importAllSheets = null;
      importCurrentSheet = null;
      importTargetPage = null;
      $("#import-file-info").hidden = true;
      $("#import-preview").innerHTML = "";
      $("#btn-import-confirm").disabled = true;
      $("#btn-import-confirm").dataset.parsed = "";
      $("#btn-import-confirm").dataset.sheet = "";
      $("#btn-import-confirm").dataset.page = "";
      const wrap = $("#import-sheet-wrap");
      if (wrap) wrap.hidden = true;
      const tw = $("#import-target-wrap");
      if (tw) tw.hidden = true;
      setImportStats(null);
    });

    $("#import-text").addEventListener("input", () => {
      if (importAllSheets && $("#import-text").value.trim()) {
        importAllSheets = null;
        importCurrentSheet = null;
        importTargetPage = null;
        $("#import-file-info").hidden = true;
        const wrap = $("#import-sheet-wrap");
        if (wrap) wrap.hidden = true;
        const tw = $("#import-target-wrap");
        if (tw) tw.hidden = true;
      }
      refreshImportPreview();
    });

    $("#import-skip-header").addEventListener("change", refreshImportPreview);
    $("#import-sheet-select")?.addEventListener("change", refreshImportPreview);
    $("#import-target-select")?.addEventListener("change", () => {
      importTargetPage = $("#import-target-select").value;
      refreshImportPreview();
    });

    $("#btn-import-confirm").addEventListener("click", () => {
      const raw = $("#btn-import-confirm").dataset.parsed;
      const sheetName = $("#btn-import-confirm").dataset.sheet || "";
      const targetPid = $("#btn-import-confirm").dataset.page || "";
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
      const p = state.pages[targetPid];
      let added = 0,
        replaced = 0;
      rows.forEach((r) => {
        // 用 sheet + no 作为去重 key（仅 chapter / foreshadowing 都有 no）
        const existingIdx = p.items.findIndex(
          (x) => Number(x.no) === Number(r.no) && x.sheet === sheetName
        );
        const data = def.defaults();
        // 把所有 row 字段覆盖到 defaults
        for (const k of Object.keys(def.fields)) {
          if (k in r) data[k] = r[k];
        }
        if (existingIdx >= 0) {
          // 保留 id
          p.items[existingIdx] = { ...p.items[existingIdx], ...data, sheet: sheetName };
          replaced++;
        } else {
          const it = def.makeItem(data, sheetName);
          p.items.push(it);
          added++;
        }
      });
      p.items.sort((a, b) => compareChapterNo(def.sortKey(a), def.sortKey(b)));
      // 把这个 sheet 注册到 state.sheetsRaw（如不存在）+ 该页面的 sheets
      if (sheetName && !state.sheetsRaw.find((s) => s.name === sheetName)) {
        // 没有 raw 缓存时（罕见：用户先 import 后才 open file），构造一个空 raw
        const header = rows[0] ? Object.keys(def.fields) : [];
        const aoa = [header];
        state.sheetsRaw.push({
          name: sheetName,
          rows2d: aoa,
          columns: Object.fromEntries(
            Object.keys(def.fields).map((k, i) => [k, i])
          ),
          rowCount: aoa.length,
          ok: true,
          page: targetPid,
        });
        if (!p.sheets.find((s) => s.name === sheetName)) {
          p.sheets.push({
            name: sheetName,
            columns: Object.fromEntries(
              Object.keys(def.fields).map((k, i) => [k, i])
            ),
            rowCount: 1,
            ok: true,
          });
        }
      }
      save();
      pushHistory();
      hideModal("modal-import");
      // 切到目标页面 + 该 sheet
      state.currentPage = targetPid;
      const tp = state.pages[targetPid];
      tp.currentSheet = sheetName;
      const first = getSortedItems()[0];
      tp.currentItemId = first ? first.id : null;
      renderAll();
      toast(
        `导入完成：[${def.label}·${sheetName}] 新增 ${added} 条，覆盖 ${replaced} 条`
      );
    });
  }

  function handleXlsxFile(file) {
    if (!window.XLSX) {
      toast("xlsx 解析库未加载，请检查网络", "error");
      return;
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!["xlsx", "xlsm"].includes(ext)) {
      toast(`不支持的文件类型：.${ext}（仅支持 .xlsx / .xlsm）`, "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = new Uint8Array(reader.result);
        const wb = XLSX.read(data, {
          type: "array",
          cellDates: true,
          cellNF: true,
        });
        if (!wb.SheetNames || wb.SheetNames.length === 0) {
          toast("xlsx 内没有可用的 sheet", "error");
          return;
        }
        // 解析所有 sheet + 分类
        importAllSheets = wb.SheetNames.map((name) => {
          const sheet = wb.Sheets[name];
          const rows2d = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: "",
            raw: true,
          });
          const header = (rows2d[0] || []).map((c) => unpackCell(c).trim());
          const page = classifySheet(name, header);
          const parsed = page ? parseRowsForPage(rows2d, page) : { rows: [], columns: { header } };
          const ok = !!page && parsed.columns && Object.keys(parsed.columns).some(
            (k) => k !== "header" && parsed.columns[k] >= 0
          );
          return { name, rows2d, parsed, ok, page };
        });
        // sheet 下拉
        const sel = $("#import-sheet-select");
        const wrap = $("#import-sheet-wrap");
        if (sel) {
          sel.innerHTML = importAllSheets
            .map(
              (s) =>
                `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} [${escapeHtml(pageBadge(s.page))}]${s.ok ? "" : "（未匹配字段）"}</option>`
            )
            .join("");
        }
        if (wrap) wrap.hidden = importAllSheets.length <= 1;
        // 默认选第一个 ok 的 sheet
        const firstOk = importAllSheets.find((s) => s.ok);
        if (sel && firstOk) sel.value = firstOk.name;
        else if (sel) sel.value = importAllSheets[0].name;

        const info = $("#import-file-info");
        info.hidden = false;
        const okCount = importAllSheets.filter((s) => s.ok).length;
        info.querySelector(".import-file-name").textContent =
          `${file.name} · ${importAllSheets.length} 个 sheet（${okCount} 个有匹配字段）`;

        // 显示目标页面下拉
        const targetWrap = $("#import-target-wrap");
        const targetSel = $("#import-target-select");
        if (targetSel) {
          // 收集本次出现的 page
          const present = new Set(
            importAllSheets.map((s) => s.page).filter(Boolean)
          );
          // + 当前 currentPage（兜底）
          present.add(state.currentPage);
          const options = Array.from(present).map(
            (pid) =>
              `<option value="${pid}">${PAGES[pid] ? PAGES[pid].icon + " " + PAGES[pid].label : pid}</option>`
          );
          // 加一个"未分类"选项（如果选了未分类的 sheet）
          options.push(`<option value="">— 未分类（不导入）—</option>`);
          targetSel.innerHTML = options.join("");
          // 默认选第一个 ok sheet 的 page
          const def0 = firstOk ? firstOk.page : state.currentPage;
          targetSel.value = def0 || state.currentPage;
          importTargetPage = targetSel.value;
        }
        if (targetWrap) targetWrap.hidden = false;

        $("#import-text").value = "";
        refreshImportPreview();
        if (okCount === 0) {
          toast("没有任何 sheet 匹配已注册的页面字段", "warn", 3000);
        } else if (okCount < importAllSheets.length) {
          toast(`解析完成：${okCount}/${importAllSheets.length} 个 sheet 有匹配字段`, "info", 1800);
        } else {
          toast(`解析完成：${okCount} 个 sheet 均有匹配字段`, "info", 1800);
        }
      } catch (err) {
        console.error(err);
        toast("xlsx 解析失败：" + (err.message || err), "error");
      }
    };
    reader.onerror = () => toast("读取文件失败", "error");
    reader.readAsArrayBuffer(file);
  }

  function parseImportText(text) {
    if (!text || !text.trim()) return [];
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
      const no = Number(parts[0]);
      if (!Number.isFinite(no)) {
        o._error = `章节号不是有效数字："${parts[0]}"`;
        out.push(o);
        continue;
      }
      o.no = no;
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
            <span class="preview-len">${(r.content || r.notes || "").length}字</span>
          </div>`;
      })
      .join("");
  }


  /* ============================================================
     事件：文件 / 列表点击 / 编辑器按钮
     ============================================================ */
  function bindFileEvents() {
    $("#file-select").addEventListener("change", async (e) => {
      const name = e.target.value;
      if (!name) return;
      await openFileByName(name);
    });

    $("#file-pick").addEventListener("click", () => {
      if (!fsSupported()) {
        toast("当前浏览器不支持 File System Access API", "error", 4000);
        return;
      }
      openFileModalReset();
      showModal("modal-open-file");
    });

    $("#btn-open-file-pick").addEventListener("click", async () => {
      try {
        const handle = await pickXlsxFile();
        if (!handle) return;
        const fileKey = `file:${handle.name}`;
        await fsPut(fileKey, handle);
        const desc = await describeFile(handle);
        upsertRecentFile({
          name: handle.name,
          mtime: desc.mtime,
          size: desc.size,
          handleKey: fileKey,
          isDirectory: false,
        });
        save();
        renderAll();
        hideModal("modal-open-file");
        await loadFromHandle(handle, { handleKey: fileKey });
      } catch (e) {
        if (e.name === "AbortError") return;
        console.error(e);
        toast("选择文件失败：" + (e.message || e), "error", 3000);
      }
    });

    $("#file-pick-dir").addEventListener("click", () => {
      if (!fsSupported()) {
        toast("当前浏览器不支持 File System Access API", "error", 4000);
        return;
      }
      showModal("modal-open-dir");
    });

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

    $("#file-remove").addEventListener("click", async () => {
      if (!state.currentFileName) return;
      if (
        !confirm(
          `从列表中移除「${state.currentFileName}」？\n（不会删除磁盘文件）`
        )
      )
        return;
      await removeRecentFile(state.currentFileName);
      renderAll();
    });

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
      const item = e.target.closest(".ch-item, .fs-item");
      if (!item) return;
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
      const isDelete = t.id === "btn-delete" || t.id === "btn-fs-delete";
      if (isSave && curItem()) {
        const ok = saveCurrentItem();
        if (ok) saveToFile().then((written) => {
          if (written) flashSaveStatus("✓ 已保存并写入文件", 1800);
        });
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

      // Ctrl+S / Cmd+S：保存当前章节到本地 + 写回 xlsx
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (!curItem()) {
          toast("没有选中的条目可保存", "error", 1500);
          return;
        }
        const ok = saveCurrentItem();
        if (ok) {
          saveToFile().then((written) => {
            if (written) flashSaveStatus("✓ 已保存并写入文件 (Ctrl+S)", 1800);
            else flashSaveStatus("✓ 已保存到本地（写文件需授权）", 2000);
          });
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

    // JSON 导出
    $("#btn-export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `novel-app-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);
      toast("已导出 JSON");
    });

    // JSON 导入（v5 + 旧 dataSources 兼容）
    $("#file-import").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.pages || data.chapters) {
            if (!confirm("导入将覆盖当前所有数据，确定？")) return;
            // 整体替换 state（保留 theme 不变以免难看）
            const newTheme = state.theme;
            const newUi = state.ui;
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
            state.theme = { ...DEFAULT_THEME, ...(data.theme || {}) };
            state.ui = { sort: "asc", layout: { ...(state.ui.layout || {}) }, ...(data.ui || {}) };
            if (data.ui && data.ui.layout) state.ui.layout = data.ui.layout;
            save();
            renderAll();
            toast("已导入");
          } else if (Array.isArray(data.dataSources)) {
            if (!confirm("检测到老版本数据格式，导入将覆盖当前所有数据，确定？")) return;
            const target =
              data.dataSources.find((d) => d.id === data.currentDataSourceId) ||
              data.dataSources[0];
            if (target) {
              state.pages.chapter.items = target.chapters || [];
              state.currentFileName = null;
              save();
              renderAll();
              toast("已导入（旧格式）");
            }
          } else {
            toast("文件格式不对", "error");
          }
        } catch (err) {
          console.error(err);
          toast("解析失败：文件不是有效 JSON", "error");
        }
        e.target.value = "";
      };
      reader.readAsText(file);
    });
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
      // nav / three-list / two-list：拖右变宽
      // three-right：在右侧，拖左变宽（dx 为负，width 增大）
      const newVal = startVal + dx;
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
      if (e.key === "ArrowLeft") next -= step;
      else if (e.key === "ArrowRight") next += step;
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
        renderFileMeta();
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
