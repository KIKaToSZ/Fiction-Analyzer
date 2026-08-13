/* ============================================================
   小说文章分析 - 应用主逻辑
   纯前端 SPA，无外部依赖（除 SheetJS CDN）
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     常量
     ============================================================ */
  const STORAGE_KEY = "novel-app-data";
  const SCHEMA_VERSION = 4;
  const FS_DB_NAME = "novel-app-fs";
  const FS_STORE = "handles";

  // 字段名兜底表：xlsx 表头识别用
  const FIELD_FALLBACKS = {
    no: ["章节号", "章号", "序章", "序号", "number", "no", "chapter_no"],
    title: ["章节名", "章节名称", "标题", "title", "name", "chapter_name"],
    content: ["文章内容", "内容", "正文", "content", "text", "body"],
  };

  const DEFAULT_THEME = {
    bg: "paper",
    accent: "indigo",
    fontSize: 16,
    lineHeight: 1.7,
  };

  const ACCENT_COLORS = {
    indigo: "#5B7FB9",
    sage: "#7A9B7E",
    amber: "#B89060",
    rose: "#B57A8A",
    slate: "#5C6B7A",
  };

  /* ============================================================
     工具函数
     ============================================================ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) =>
    Array.from(root.querySelectorAll(sel));
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
     状态（schema v4 - 多 sheet 读写）
     ============================================================ */
  const state = {
    schema: SCHEMA_VERSION,
    chapters: [], // [{id, no, title, content, sheet}]
    currentChapterId: null,
    currentSheet: null, // 当前激活的 sheet 名；无文件时为 null
    sheets: [], // [{name, columns, rowCount, ok}]  文件打开后填入
    sheetsRaw: [], // [{name, rows2d}]           文件打开后填入，用于写回非章节 sheet
    recentFiles: [], // [{name, lastOpened, mtime, size, handleKey, isMigrated, isDirectory}]
    currentFileName: null,
    theme: { ...DEFAULT_THEME },
    ui: { sort: "asc" },
  };

  /* ============================================================
     持久化 - localStorage（不含 file handles）
     ============================================================ */
  function save() {
    const data = {
      schema: SCHEMA_VERSION,
      chapters: state.chapters,
      currentChapterId: state.currentChapterId,
      currentSheet: state.currentSheet,
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

      // 旧数据迁移（schema v1/v2 - dataSources 数组 → v3 单文件）
      if (Array.isArray(data.dataSources)) {
        const target =
          data.dataSources.find((d) => d.id === data.currentDataSourceId) ||
          data.dataSources.find((d) => (d.chapters || []).length > 0) ||
          data.dataSources[0];
        if (target) {
          state.chapters = target.chapters || [];
          state.currentChapterId =
            data.currentChapterId &&
            state.chapters.find((c) => c.id === data.currentChapterId)
              ? data.currentChapterId
              : null;
          // 旧数据没有 handleKey，作为"已迁移"标记，不能 remove
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
        state.schema = SCHEMA_VERSION;
        save();
        return;
      }

      // v3 直接读
      state.chapters = Array.isArray(data.chapters) ? data.chapters : [];
      state.currentChapterId = data.currentChapterId || null;
      state.recentFiles = Array.isArray(data.recentFiles)
        ? data.recentFiles
        : [];
      state.currentFileName = data.currentFileName || null;
      state.theme = { ...DEFAULT_THEME, ...(data.theme || {}) };
      state.ui = { sort: "asc", ...(data.ui || {}) };

      // v3 → v4 迁移：旧章节无 sheet 字段，补 "Sheet1" 占位
      let needResave = false;
      for (const c of state.chapters) {
        if (!c.sheet) {
          c.sheet = "Sheet1";
          needResave = true;
        }
      }
      // currentSheet 迁移：取第一个章节的 sheet
      if (!state.currentSheet) {
        state.currentSheet = state.chapters[0]?.sheet || null;
        needResave = true;
      }
      if (needResave) save();
    } catch (e) {
      console.error("读取失败，使用默认状态", e);
    }
  }

  /* ============================================================
     IndexedDB - File System handles 持久化
     FileSystemFileHandle 支持 structured clone，
     可直接 put 到 IndexedDB 跨会话恢复。
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
      req.onerror = () => reject(req.error);
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

  // 恢复 handle 时，浏览器需要用户重新确认读权限
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
     状态写入辅助
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
      state.chapters = [];
      state.currentChapterId = null;
      state.currentSheet = null;
      state.sheets = [];
      state.sheetsRaw = [];
    }
    save();
  }

  /* ============================================================
     章节访问
     ============================================================ */
  function getCurrentChapter() {
    return (
      state.chapters.find((c) => c.id === state.currentChapterId) || null
    );
  }

  function getSortedChapters() {
    const cur = state.currentSheet;
    const arr = state.chapters.filter(
      (c) => !cur || c.sheet === cur
    );
    arr.sort((a, b) => {
      const an = Number(a.no) || 0;
      const bn = Number(b.no) || 0;
      return state.ui.sort === "asc" ? an - bn : bn - an;
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

    const parts = [`${state.chapters.length} 章`];
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

  function renderSheetTabs() {
    const wrap = $("#sheet-tabs");
    if (!wrap) return;
    if (!state.currentFileName || state.sheets.length === 0) {
      wrap.hidden = true;
      wrap.innerHTML = "";
      return;
    }
    wrap.hidden = false;
    const counts = {};
    for (const c of state.chapters) {
      counts[c.sheet] = (counts[c.sheet] || 0) + 1;
    }
    wrap.innerHTML = state.sheets
      .map((s) => {
        const active = s.name === state.currentSheet ? "active" : "";
        const count = counts[s.name] || 0;
        const badge = !s.ok
          ? `<span class="sheet-tab-count" title="该 sheet 没有匹配的章节表头">⚠</span>`
          : count > 0
            ? `<span class="sheet-tab-count">${count}</span>`
            : "";
        return `<button class="sheet-tab ${active}" data-sheet="${escapeHtml(
          s.name
        )}" role="tab" aria-selected="${s.name === state.currentSheet}">${escapeHtml(
          s.name
        )}${badge}</button>`;
      })
      .join("");
    // 绑定点击
    $$(".sheet-tab", wrap).forEach((b) =>
      b.addEventListener("click", () => {
        const name = b.dataset.sheet;
        if (!name || name === state.currentSheet) return;
        state.currentSheet = name;
        // 把当前章节切到当前 sheet 的第一个（如果有）
        const firstInSheet = state.chapters
          .filter((c) => c.sheet === name)
          .sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0))[0];
        state.currentChapterId = firstInSheet ? firstInSheet.id : null;
        save();
        renderAll();
      })
    );
  }

  function renderChapterList() {
    const list = $("#chapter-list");
    const chapters = getSortedChapters();
    list.innerHTML = chapters
      .map((c) => {
        const wc = (c.content || "").length;
        return `
          <li class="ch-item ${
            c.id === state.currentChapterId ? "active" : ""
          }" data-id="${escapeHtml(c.id)}">
            <span class="ch-no">${escapeHtml(String(c.no))}</span>
            <span class="ch-title">${escapeHtml(c.title || "（无标题）")}</span>
            <span class="ch-meta">${wc}字</span>
          </li>
        `;
      })
      .join("");
    $("#chapter-count").textContent = `${chapters.length} 章`;
    $("#sort-label").textContent = state.ui.sort === "asc" ? "正序" : "倒序";
  }

  function renderEditor() {
    const ch = getCurrentChapter();
    const empty = $("#editor-empty");
    const editor = $("#editor");
    if (!ch) {
      empty.hidden = false;
      editor.hidden = true;
      return;
    }
    empty.hidden = true;
    editor.hidden = false;
    $("#ch-no").value = ch.no ?? "";
    $("#ch-title").value = ch.title || "";
    $("#ch-content").value = ch.content || "";
    updateWordCount();
  }

  function updateWordCount() {
    const ch = getCurrentChapter();
    const content = ch ? ch.content || "" : $("#ch-content").value;
    $("#word-count").textContent = `${content.length} 字`;
  }

  function renderTheme() {
    document.body.dataset.bg = state.theme.bg;
    document.body.dataset.accent = state.theme.accent;
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
    $("#font-size").value = state.theme.fontSize;
    $("#font-size-val").textContent = state.theme.fontSize;
    $("#line-height").value = state.theme.lineHeight;
    $("#line-height-val").textContent = state.theme.lineHeight.toFixed(2);
  }

  function renderAll() {
    renderFileSelect();
    renderFileMeta();
    renderSheetTabs();
    renderChapterList();
    renderEditor();
    renderTheme();
  }

  /* ============================================================
     读文件 + 切换文件
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
    await loadChaptersFromHandle(handle, meta);
  }

  async function loadChaptersFromHandle(handle, meta) {
    try {
      const ab = await readFileAsArrayBuffer(handle);
      const { sheets } = parseXlsxAllSheets(ab);
      const allChapters = [];
      for (const s of sheets) {
        if (!s.ok) continue;
        for (const ch of rowsToChapters(s.parsedRows, s.name)) {
          allChapters.push(ch);
        }
      }
      const desc = await describeFile(handle);
      state.chapters = allChapters;
      state.sheets = sheets.map((s) => ({
        name: s.name,
        columns: s.columns,
        rowCount: s.rowCount,
        ok: s.ok,
      }));
      state.sheetsRaw = sheets.map((s) => ({ name: s.name, rows2d: s.rows2d }));
      // 选择默认 sheet：优先 ok 状态且章节最多的
      const okSheets = state.sheets.filter((s) => s.ok);
      const candidate = okSheets.length > 0 ? okSheets[0] : state.sheets[0];
      const countBySheet = {};
      for (const c of allChapters) {
        countBySheet[c.sheet] = (countBySheet[c.sheet] || 0) + 1;
      }
      const best =
        okSheets.length > 0
          ? okSheets.sort(
              (a, b) => (countBySheet[b.name] || 0) - (countBySheet[a.name] || 0)
            )[0]
          : candidate;
      state.currentSheet = best ? best.name : null;
      state.currentChapterId =
        allChapters.find((c) => c.sheet === state.currentSheet)?.id || null;
      state.currentFileName = handle.name;
      upsertRecentFile({
        name: handle.name,
        mtime: desc.mtime,
        size: desc.size,
        handleKey: meta?.handleKey || `file:${handle.name}`,
        isDirectory: false,
      });
      save();
      renderAll();
      const okCount = state.sheets.filter((s) => s.ok).length;
      const total = state.sheets.length;
      toast(
        `已读取 ${allChapters.length} 章（${okCount}/${total} 个有效 sheet）`,
        "info",
        1500
      );
    } catch (e) {
      console.error("读取失败", e);
      toast("读取失败：" + (e.message || e), "error", 3500);
    }
  }

  /* ============================================================
     写文件 - 把当前 state.chapters 写回 xlsx
     - 有 file handle：直接写回原文件
     - 无 handle：作为下载文件提供
     ============================================================ */
  async function ensureWritePermission(handle, interactive = true) {
    if (!handle) return false;
    if (handle.queryPermission) {
      try {
        const cur = await handle.queryPermission({ mode: "readwrite" });
        if (cur === "granted") return true;
      } catch (_) {
        // 某些浏览器实现不支持 readwrite，fallback
      }
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

  function buildSheetAoa(sheetMeta, rows2dBase) {
    // rows2dBase = 原始 rows2d（包含 header）
    // 返回新的 rows2d：保留 header（如果原文件有） + 最新的章节行
    const header = rows2dBase && rows2dBase[0] ? rows2dBase[0].slice() : null;
    if (!sheetMeta || !sheetMeta.ok) {
      // 非章节 sheet，原样返回
      return rows2dBase || [];
    }
    const cols = sheetMeta.columns || {};
    const noIdx = cols.no;
    const titleIdx = cols.title;
    const contentIdx = cols.content;
    if (noIdx < 0 || titleIdx < 0 || contentIdx < 0) {
      return rows2dBase || [];
    }
    // 用原 header 的列数决定总列宽（如果原 header 缺失，用三列）
    const totalCols = header
      ? Math.max(header.length, noIdx, titleIdx, contentIdx) + 1
      : 3;
    // 取该 sheet 的章节并按 no 升序
    const chs = state.chapters
      .filter((c) => c.sheet === sheetMeta.name)
      .sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
    // 构造新 rows
    const out = [];
    if (header) {
      const normalized = header.slice(0, totalCols);
      while (normalized.length < totalCols) normalized.push("");
      out.push(normalized);
    } else {
      out.push(["章节号", "章节名", "文章内容"]);
    }
    for (const c of chs) {
      const row = new Array(totalCols).fill("");
      row[noIdx] = c.no;
      row[titleIdx] = c.title || "";
      row[contentIdx] = c.content || "";
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
      const meta = state.sheets.find((s) => s.name === raw.name);
      const aoa = buildSheetAoa(meta, raw.rows2d);
      // aoa 是二维数组，用 sheet_add_aoa 添加
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // 用安全名（≤31 字符）
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
      // 优先用持久化 handle 写回
      try {
        const handle = await fsGet(meta.handleKey);
        if (!handle) {
          // handle 失效 → 走下载
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
          // 写入失败 fallback 下载
          triggerDownload(ab, state.currentFileName);
          toast("写入失败，已改为下载：" + (e.message || e), "error", 3500);
        }
        return false;
      }
    } else {
      // 无 handle：当前会话拖入的文件 / 旧迁移数据
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
    // 名字加 -updated 后缀
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
    // 持久化目录 handle（虽然目录 handle 不直接列文件，但保留以备未来）
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

    // 自动打开当前选中（仍在目录中）或第一个
    const target =
      state.currentFileName && files.find((f) => f.name === state.currentFileName)
        ? files.find((f) => f.name === state.currentFileName)
        : files[0];
    if (target) await openFileByName(target.handle.name);
  }

  /* ============================================================
     xlsx 解析（保留）
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

  function parseXlsxRows(rows2d) {
    if (!rows2d || rows2d.length === 0) return { rows: [], columns: null };
    const header = rows2d[0].map((c) => unpackCell(c).trim());
    const dataRows = rows2d.slice(1);
    const idxNo = findColumnIndex(header, FIELD_FALLBACKS.no);
    const idxTitle = findColumnIndex(header, FIELD_FALLBACKS.title);
    const idxContent = findColumnIndex(header, FIELD_FALLBACKS.content);
    const out = [];
    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      if (!r || r.every((c) => unpackCell(c).trim() === "")) continue;
      const o = { _line: i + 2, _error: null };
      if (idxNo < 0 || idxTitle < 0 || idxContent < 0) {
        o._error = `表头缺少关键列（需含 章节号/章节名/文章内容），当前表头：${header.join(" | ")}`;
        out.push(o);
        continue;
      }
      const noRaw = unpackCell(r[idxNo]).trim();
      const no = Number(noRaw);
      if (!Number.isFinite(no)) {
        o._error = `章节号不是有效数字："${noRaw}"`;
        out.push(o);
        continue;
      }
      o.no = no;
      o.title = unpackCell(r[idxTitle]).trim();
      o.content = unpackCell(r[idxContent]);
      out.push(o);
    }
    return {
      rows: out,
      columns: { no: idxNo, title: idxTitle, content: idxContent, header },
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
      const parsed = parseXlsxRows(rows2d);
      const ok =
        parsed.columns &&
        parsed.columns.no >= 0 &&
        parsed.columns.title >= 0 &&
        parsed.columns.content >= 0;
      out.push({
        name,
        rows2d,
        columns: parsed.columns,
        rowCount: rows2d.length,
        ok,
        parsedRows: parsed.rows,
      });
    }
    return { sheets: out };
  }

  function parseXlsxFromArrayBuffer(ab) {
    const all = parseXlsxAllSheets(ab);
    const first = all.sheets[0];
    if (!first) throw new Error("xlsx 内没有可用的 sheet");
    return {
      ...first,
      sheetName: first.name,
    };
  }

  function rowsToChapters(rows, sheetName) {
    return rows
      .filter((r) => !r._error)
      .map((r) => ({
        id: uid("ch"),
        no: r.no,
        title: r.title || "",
        content: r.content || "",
        sheet: sheetName,
      }));
  }


  /* ============================================================
     事件：文件路径
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

    // 弹窗：打开文件 — 「用浏览器选择」按钮（拿持久 handle）
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
        await loadChaptersFromHandle(handle, { handleKey: fileKey });
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

    // 弹窗：打开文件夹 — 「用浏览器选择」按钮
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

    // ----- 打开文件弹窗（modal-open-file） -----
    // 弹窗状态：用户拖入或选择 xlsx 后暂存为 File 对象，本次会话可读
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

    // 弹窗里拖入或选择的 xlsx：暂存为 File 对象，等用户点"确认打开"再加载
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

    // 从 File 对象加载章节（不持久化 handle，仅本次会话有效）
    async function loadChaptersFromFile(file) {
      try {
        const ab = await file.arrayBuffer();
        const { sheets } = parseXlsxAllSheets(ab);
        const allChapters = [];
        for (const s of sheets) {
          if (!s.ok) continue;
          for (const ch of rowsToChapters(s.parsedRows, s.name)) {
            allChapters.push(ch);
          }
        }
        if (allChapters.length === 0) {
          toast("未能解析出任何章节，请检查表头是否包含「章节号 / 章节名 / 文章内容」", "error", 4000);
          return;
        }
        state.chapters = allChapters;
        state.sheets = sheets.map((s) => ({
          name: s.name,
          columns: s.columns,
          rowCount: s.rowCount,
          ok: s.ok,
        }));
        state.sheetsRaw = sheets.map((s) => ({ name: s.name, rows2d: s.rows2d }));
        const countBySheet = {};
        for (const c of allChapters) {
          countBySheet[c.sheet] = (countBySheet[c.sheet] || 0) + 1;
        }
        const okSheets = state.sheets.filter((s) => s.ok);
        const best =
          okSheets.length > 0
            ? okSheets.sort(
                (a, b) =>
                  (countBySheet[b.name] || 0) - (countBySheet[a.name] || 0)
              )[0]
            : state.sheets[0];
        state.currentSheet = best ? best.name : null;
        state.currentChapterId =
          allChapters.find((c) => c.sheet === state.currentSheet)?.id || null;
        state.currentFileName = file.name;
        save();
        renderAll();
        hideModal("modal-open-file");
        const okCount = state.sheets.filter((s) => s.ok).length;
        const total = state.sheets.length;
        toast(
          `已读取 ${allChapters.length} 章（${okCount}/${total} 个有效 sheet，本次会话有效）`,
          "info",
          1500
        );
      } catch (e) {
        console.error("读取失败", e);
        toast("读取失败：" + (e.message || e), "error", 3500);
      }
    }

    // 拖拽 / 点击 / 键盘 触发 file input
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
      await loadChaptersFromFile(f);
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
        await loadChaptersFromHandle(handle, meta);
      } else {
        toast("未授权", "error");
      }
    });
  }

  /* ============================================================
     事件：章节
     ============================================================ */
  function bindChapterEvents() {
    $("#chapter-list").addEventListener("click", (e) => {
      const item = e.target.closest(".ch-item");
      if (!item) return;
      state.currentChapterId = item.dataset.id;
      save();
      renderChapterList();
      renderEditor();
    });

    $("#btn-new").addEventListener("click", () => {
      const targetSheet = state.currentSheet || (state.sheets[0] && state.sheets[0].name) || null;
      const sameSheetChapters = state.chapters.filter(
        (c) => c.sheet === targetSheet
      );
      const nextNo = sameSheetChapters.reduce(
        (m, c) => Math.max(m, Number(c.no) || 0),
        0
      ) + 1;
      const ch = {
        id: uid("ch"),
        no: nextNo,
        title: "",
        content: "",
        sheet: targetSheet,
      };
      state.chapters.push(ch);
      state.currentChapterId = ch.id;
      save();
      renderAll();
      setTimeout(() => $("#ch-title").focus(), 50);
      toast(
        targetSheet
          ? `已新增第 ${nextNo} 章 [${targetSheet}]`
          : `已新增第 ${nextNo} 章`
      );
    });

    $("#btn-save").addEventListener("click", async () => {
      const ch = getCurrentChapter();
      if (!ch) return;
      ch.no = Number($("#ch-no").value) || 0;
      ch.title = $("#ch-title").value.trim();
      ch.content = $("#ch-content").value;
      save();
      renderChapterList();
      const s = $("#save-status");
      s.textContent = "✓ 已保存到本地";
      s.classList.add("saved");
      clearTimeout(s._t);
      s._t = setTimeout(() => {
        s.textContent = "";
        s.classList.remove("saved");
      }, 1500);
      // 写回 xlsx 文件
      const ok = await saveToFile();
      if (ok) {
        s.textContent = "✓ 已保存并写入文件";
        s.classList.add("saved");
        clearTimeout(s._t);
        s._t = setTimeout(() => {
          s.textContent = "";
          s.classList.remove("saved");
        }, 1800);
      }
    });

    $("#btn-delete").addEventListener("click", () => {
      const ch = getCurrentChapter();
      if (!ch) return;
      if (!confirm(`确定删除章节「${ch.title || ch.no}」？`)) return;
      state.chapters = state.chapters.filter((c) => c.id !== ch.id);
      state.currentChapterId = null;
      save();
      renderAll();
      toast("已删除");
    });

    $("#ch-content").addEventListener("input", () => {
      updateWordCount();
    });

    $("#btn-sort").addEventListener("click", () => {
      state.ui.sort = state.ui.sort === "asc" ? "desc" : "asc";
      save();
      renderChapterList();
    });
  }

  /* ============================================================
     事件：导入（xlsx 拖拽 + 文本粘贴，导入到当前文件）
     ============================================================ */
  let importXlsxAllSheets = null; // xlsx 路径下解析的所有 sheet
  let importCurrentSheet = null; // 当前选中的 sheet 名

  function bindImportEvents() {
    $("#btn-import").addEventListener("click", () => {
      $("#import-text").value = "";
      $("#import-skip-header").checked = true;
      $("#import-preview").innerHTML = "";
      $("#btn-import-confirm").disabled = true;
      $("#btn-import-confirm").dataset.parsed = "";
      $("#btn-import-confirm").dataset.sheet = "";
      importXlsxAllSheets = null;
      importCurrentSheet = null;
      $("#import-file-info").hidden = true;
      $("#import-drop").classList.remove("is-dragover");
      const wrap = $("#import-sheet-wrap");
      if (wrap) wrap.hidden = true;
      setImportStats(null);
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
      importXlsxAllSheets = null;
      importCurrentSheet = null;
      $("#import-file-info").hidden = true;
      $("#import-preview").innerHTML = "";
      $("#btn-import-confirm").disabled = true;
      $("#btn-import-confirm").dataset.parsed = "";
      $("#btn-import-confirm").dataset.sheet = "";
      const wrap = $("#import-sheet-wrap");
      if (wrap) wrap.hidden = true;
      setImportStats(null);
    });

    $("#import-text").addEventListener("input", () => {
      if (importXlsxAllSheets && $("#import-text").value.trim()) {
        importXlsxAllSheets = null;
        importCurrentSheet = null;
        $("#import-file-info").hidden = true;
        const wrap = $("#import-sheet-wrap");
        if (wrap) wrap.hidden = true;
      }
      const rows = parseImportText($("#import-text").value);
      renderImportPreview(rows);
      $("#btn-import-confirm").disabled =
        rows.filter((r) => !r._error).length === 0;
      $("#btn-import-confirm").dataset.parsed = JSON.stringify(rows);
      $("#btn-import-confirm").dataset.sheet = "";
      setImportStats(rows);
    });

    $("#import-skip-header").addEventListener("change", refreshImportPreview);

    // sheet 选择下拉变化时刷新 preview
    $("#import-sheet-select")?.addEventListener("change", () => {
      refreshImportPreview();
    });

    $("#btn-import-confirm").addEventListener("click", () => {
      const raw = $("#btn-import-confirm").dataset.parsed;
      const sheetName = $("#btn-import-confirm").dataset.sheet || "";
      if (!raw) return;
      const rows = JSON.parse(raw).filter((r) => !r._error);
      if (rows.length === 0) {
        toast("没有可导入的内容", "error");
        return;
      }
      let added = 0,
        replaced = 0;
      rows.forEach((r) => {
        const existingIdx = state.chapters.findIndex(
          (c) => Number(c.no) === r.no && c.sheet === sheetName
        );
        const ch = {
          id: existingIdx >= 0 ? state.chapters[existingIdx].id : uid("ch"),
          no: r.no,
          title: r.title,
          content: r.content,
          sheet: sheetName,
        };
        if (existingIdx >= 0) {
          state.chapters[existingIdx] = ch;
          replaced++;
        } else {
          state.chapters.push(ch);
          added++;
        }
      });
      state.chapters.sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
      save();
      hideModal("modal-import");
      renderAll();
      toast(
        `导入完成：${sheetName ? `[${sheetName}] ` : ""}新增 ${added} 章，覆盖 ${replaced} 章`
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
        const wb = XLSX.read(data, { type: "array", cellDates: true, cellNF: true });
        if (!wb.SheetNames || wb.SheetNames.length === 0) {
          toast("xlsx 内没有可用的 sheet", "error");
          return;
        }
        // 解析所有 sheet 暂存
        importXlsxAllSheets = wb.SheetNames.map((name) => {
          const sheet = wb.Sheets[name];
          const rows2d = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: "",
            raw: true,
          });
          const result = parseXlsxRows(rows2d);
          const ok =
            result.columns &&
            result.columns.no >= 0 &&
            result.columns.title >= 0 &&
            result.columns.content >= 0;
          return { name, rows2d, parsed: result, ok };
        });
        // 多 sheet 时加 sheet 选择下拉
        const sel = $("#import-sheet-select");
        const wrap = $("#import-sheet-wrap");
        if (sel) {
          sel.innerHTML = importXlsxAllSheets
            .map(
              (s) =>
                `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}${s.ok ? "" : "（非章节表）"}</option>`
            )
            .join("");
        }
        if (wrap) {
          wrap.hidden = importXlsxAllSheets.length <= 1;
        }
        // 默认选第一个 ok 的 sheet
        const firstOk = importXlsxAllSheets.find((s) => s.ok);
        if (sel && firstOk) sel.value = firstOk.name;
        else if (sel) sel.value = importXlsxAllSheets[0].name;

        const info = $("#import-file-info");
        info.hidden = false;
        const okCount = importXlsxAllSheets.filter((s) => s.ok).length;
        info.querySelector(".import-file-name").textContent =
          `${file.name} · ${importXlsxAllSheets.length} 个 sheet（${okCount} 个有效）`;
        $("#import-text").value = "";
        refreshImportPreview();
        if (okCount === 0) {
          toast("没有任何 sheet 含有效章节表头", "warn", 3000);
        } else if (okCount < importXlsxAllSheets.length) {
          toast(`解析完成：${okCount}/${importXlsxAllSheets.length} 个 sheet 有效`, "info", 1800);
        } else {
          toast(`解析完成：${okCount} 个 sheet 均有效`, "info", 1800);
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
    if (importXlsxAllSheets) {
      const sel = $("#import-sheet-select");
      const sheetName = sel ? sel.value : (importCurrentSheet || (importXlsxAllSheets[0] && importXlsxAllSheets[0].name));
      const target = importXlsxAllSheets.find((s) => s.name === sheetName);
      if (!target) {
        renderImportPreview([]);
        $("#btn-import-confirm").disabled = true;
        $("#btn-import-confirm").dataset.parsed = "";
        $("#btn-import-confirm").dataset.sheet = "";
        setImportStats(null);
        return;
      }
      const rows = target.parsed.rows;
      renderImportPreview(rows);
      const okCount = rows.filter((r) => !r._error).length;
      $("#btn-import-confirm").disabled = !target.ok || okCount === 0;
      $("#btn-import-confirm").dataset.parsed = JSON.stringify(rows);
      $("#btn-import-confirm").dataset.sheet = target.name;
      importCurrentSheet = target.name;
      setImportStats(rows);
      if (!target.ok) {
        setImportStats(rows);
      }
    } else {
      const rows = parseImportText($("#import-text").value);
      renderImportPreview(rows);
      $("#btn-import-confirm").disabled =
        rows.filter((r) => !r._error).length === 0;
      $("#btn-import-confirm").dataset.parsed = JSON.stringify(rows);
      $("#btn-import-confirm").dataset.sheet = "";
      setImportStats(rows);
    }
  }

  function setImportStats(rows) {
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
    if (err === 0) {
      el.classList.add("has-success");
      el.textContent = `✓ ${ok} 行可导入`;
    } else {
      el.classList.add("has-error");
      el.textContent = `✓ ${ok} 行 / ✗ ${err} 行解析失败`;
    }
  }

  function renderImportPreview(rows) {
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
        return `
        <div class="preview-row">
          <span class="preview-no">${escapeHtml(String(r.no))}</span>
          <span class="preview-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title || "（无标题）")}</span>
          <span class="preview-len">${r.content.length}字</span>
        </div>`;
      })
      .join("");
  }


  /* ============================================================
     事件：右栏 Tab
     ============================================================ */
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

  /* ============================================================
     事件：主题 + JSON 导入导出
     ============================================================ */
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

    // JSON 导出（不含 IndexedDB 中的 file handles，只导出章节+主题+UI）
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

    // JSON 导入（兼容 v3 新格式和 v1/v2 dataSources 旧格式）
    $("#file-import").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (Array.isArray(data.chapters)) {
            if (!confirm("导入将覆盖当前所有章节，确定？")) return;
            state.chapters = data.chapters;
            state.currentChapterId =
              data.currentChapterId || data.chapters[0]?.id || null;
            if (data.theme) state.theme = { ...DEFAULT_THEME, ...data.theme };
            if (data.ui) state.ui = { sort: "asc", ...data.ui };
            save();
            renderAll();
            toast("已导入");
          } else if (Array.isArray(data.dataSources)) {
            // 兼容老格式
            if (!confirm("检测到老版本数据格式，导入将覆盖当前所有章节，确定？")) return;
            const target =
              data.dataSources.find((d) => d.id === data.currentDataSourceId) ||
              data.dataSources[0];
            if (target) {
              state.chapters = target.chapters || [];
              state.currentChapterId = null;
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
     初始化
     ============================================================ */
  async function init() {
    load();
    renderAll();

    // 浏览器能力检查
    if (!fsSupported()) {
      $("#fs-unsupported").hidden = false;
    }

    bindFileEvents();
    bindChapterEvents();
    bindImportEvents();
    bindTabs();
    bindThemeEvents();

    // 跨标签页同步
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) {
        load();
        renderAll();
      }
    });

    // ESC 关闭弹窗
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $$(".modal").forEach((m) => (m.hidden = true));
      }
    });

    // data-close 委托：点击带 [data-close] 的元素关闭最近的 .modal
    // 覆盖弹窗背景遮罩、关闭按钮、取消按钮（HTML 里都标了 data-close）
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-close]");
      if (!t) return;
      const modal = t.closest(".modal");
      if (modal) modal.hidden = true;
    });

    // 启动时自动恢复最后打开的文件
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
        // handle 已失效（清浏览器数据 / 句柄过期），从列表移除
        await removeRecentFile(meta.name);
        renderAll();
        return;
      }
      // 不弹 prompt，只查询当前权限
      let granted = false;
      try {
        const cur = await handle.queryPermission({ mode: "read" });
        granted = cur === "granted";
      } catch (_) {
        granted = false;
      }
      if (!granted) {
        // 显示 banner 让用户点"重新授权"
        $("#fs-banner").hidden = false;
        renderFileMeta();
        return;
      }
      await loadChaptersFromHandle(handle, meta);
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
