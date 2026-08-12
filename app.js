/* ============================================================
   小说文章分析 - 应用主逻辑
   纯前端 SPA，无外部依赖
   ============================================================ */

(function () {
  "use strict";

  /* ============================================================
     常量与默认数据
     ============================================================ */
  const STORAGE_KEY = "novel-app-data";
  const SCHEMA_VERSION = 2;
  const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
  const SYNC_DEBOUNCE_MS = 600; // 同步按钮节流

  // 字段名兜底表：默认字段名找不到时，尝试这些同义词
  const FIELD_FALLBACKS = {
    no: ["章节号", "章号", "序章", "序号", "number", "no", "chapter_no"],
    title: ["章节名", "章节名称", "标题", "title", "name", "chapter_name"],
    content: ["文章内容", "内容", "正文", "content", "text", "body"],
  };

  const DEFAULT_DATA_SOURCES = [
    {
      id: "ds_builtin",
      name: "示例小说 · 墨笺",
      url: "",
      note: "内置示例，可删除",
      builtIn: true,
      // 飞书同步配置（内置数据源不启用）
      appId: "",
      appSecret: "",
      tableName: "章节正文",
      fieldNo: "章节号",
      fieldTitle: "章节名",
      fieldContent: "文章内容",
      lastSyncAt: null,
      syncStatus: "idle", // idle | syncing | success | error | no-config
      syncError: "",
      chapters: [
        {
          id: "ch_b1",
          no: 1,
          title: "寒江初雪",
          content:
            "江面如镜，第一片雪落下来的时候，渡口的青石板已经积了薄薄一层白。\n\n苏子期站在船头，把斗笠压低了些，雾里传来一声唤——是他等了三年的人。\n\n「你来迟了。」\n「雪也迟。」\n\n两人相视，都没笑。",
        },
        {
          id: "ch_b2",
          no: 2,
          title: "旧馆逢君",
          content:
            "重游旧馆，梁上燕子已不识主人。\n\n她坐在当年他常坐的位置，要了一壶他爱喝的茶，自己却没喝。\n\n「先生，你又迟了三年。」\n\n窗外风起，吹得桌上那张写了一半的信簌簌作响。她伸手按住，停了停，没读，又松开。",
        },
        {
          id: "ch_b3",
          no: 3,
          title: "夜宴暗流",
          content:
            "夜宴设在城东的临波楼，灯火通明，丝竹不断。\n\n席间觥筹，觥筹之间，藏着几把不见血的刀。\n\n她笑得很轻，抬眼时眼底却冷得如同窗外的江。\n\n——这一局，从她坐下的那一刻起，便已经开始了。",
        },
      ],
    },
  ];

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
     状态
     ============================================================ */
  const state = {
    schema: SCHEMA_VERSION,
    dataSources: [],
    currentDataSourceId: null,
    currentChapterId: null,
    theme: { ...DEFAULT_THEME },
    ui: { sort: "asc" },
  };

  /* ============================================================
     工具函数
     ============================================================ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const uid = (prefix = "id") =>
    `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const debounce = (fn, ms = 300) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

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

  /* ============================================================
     持久化
     ============================================================ */
  function save() {
    const data = {
      schema: SCHEMA_VERSION,
      dataSources: state.dataSources,
      currentDataSourceId: state.currentDataSourceId,
      currentChapterId: state.currentChapterId,
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
      if (!raw) {
        initDefault();
        return;
      }
      const data = JSON.parse(raw);

      // 旧数据迁移
      if (!data.schema || data.schema < SCHEMA_VERSION) {
        // 兼容老结构（如果以后有需要）
      }

      state.dataSources = Array.isArray(data.dataSources) ? data.dataSources : [];
      state.currentDataSourceId = data.currentDataSourceId;
      state.currentChapterId = data.currentChapterId || null;
      state.theme = { ...DEFAULT_THEME, ...(data.theme || {}) };
      state.ui = { sort: "asc", ...(data.ui || {}) };

      // 给老数据源补齐 schema v2 新增字段
      state.dataSources = state.dataSources.map((d) => ({
        appId: "",
        appSecret: "",
        tableName: "章节正文",
        fieldNo: "章节号",
        fieldTitle: "章节名",
        fieldContent: "文章内容",
        lastSyncAt: null,
        syncStatus: "idle",
        syncError: "",
        ...d,
      }));

      // 保底：若没有数据源，加默认
      if (state.dataSources.length === 0) {
        state.dataSources = cloneDefault();
        state.currentDataSourceId = state.dataSources[0].id;
      }

      // 校正 currentDataSourceId
      if (
        !state.dataSources.find((d) => d.id === state.currentDataSourceId)
      ) {
        state.currentDataSourceId = state.dataSources[0].id;
      }
    } catch (e) {
      console.error("读取失败，使用默认数据", e);
      initDefault();
    }
  }

  function initDefault() {
    state.dataSources = cloneDefault();
    state.currentDataSourceId = state.dataSources[0].id;
    state.currentChapterId = null;
    state.theme = { ...DEFAULT_THEME };
    state.ui = { sort: "asc" };
    save();
  }

  function cloneDefault() {
    return JSON.parse(JSON.stringify(DEFAULT_DATA_SOURCES));
  }

  /* ============================================================
     数据访问辅助
     ============================================================ */
  function getCurrentDataSource() {
    return state.dataSources.find((d) => d.id === state.currentDataSourceId) || null;
  }

  function getCurrentChapter() {
    const ds = getCurrentDataSource();
    if (!ds) return null;
    return (ds.chapters || []).find((c) => c.id === state.currentChapterId) || null;
  }

  function getSortedChapters(ds) {
    const chapters = [...(ds.chapters || [])];
    chapters.sort((a, b) => {
      const an = Number(a.no) || 0;
      const bn = Number(b.no) || 0;
      return state.ui.sort === "asc" ? an - bn : bn - an;
    });
    return chapters;
  }

  /* ============================================================
     飞书多维表格同步
     ============================================================ */

  // 从飞书表格链接解析 app_token
  // 例：https://xxx.feishu.cn/base/{app_token}?table=...
  function parseAppTokenFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
      return m ? m[1] : null;
    } catch {
      // 兼容非标准 URL
      const m = String(url).match(/\/base\/([A-Za-z0-9]+)/);
      return m ? m[1] : null;
    }
  }

  // 1. 获取 tenant_access_token
  async function getTenantAccessToken(appId, appSecret) {
    const res = await fetch(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`获取 token 失败：${data.msg || "code=" + data.code}`);
    }
    return data.tenant_access_token;
  }

  // 2. 列出多维表格的所有数据表
  async function listTables(token, appToken) {
    const res = await fetch(
      `${FEISHU_API_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.code !== 0) {
      throw new Error(`列子表失败：${data.msg || "code=" + data.code}`);
    }
    return data.data?.items || [];
  }

  // 3. 列出数据表的所有记录（自动分页）
  async function listRecords(token, appToken, tableId) {
    const all = [];
    let pageToken = null;
    do {
      const url = new URL(
        `${FEISHU_API_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`
      );
      url.searchParams.set("page_size", "500");
      url.searchParams.set("automatic_fields", "false");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.code !== 0) {
        throw new Error(`拉记录失败：${data.msg || "code=" + data.code}`);
      }
      all.push(...(data.data?.items || []));
      pageToken = data.data?.has_more ? data.data.page_token : null;
    } while (pageToken);
    return all;
  }

  // 字段名匹配：先按用户配置的字段名，再回退到 FIELD_FALLBACKS 中的同义词
  function pickFieldValue(fields, preferred, fallbacks) {
    if (!fields) return null;
    if (preferred && fields[preferred] !== undefined) return fields[preferred];
    for (const name of fallbacks) {
      if (fields[name] !== undefined) return fields[name];
    }
    return null;
  }

  // 把飞书记录转成章节对象
  function recordToChapter(record, ds) {
    const fields = record.fields || {};
    const noRaw = pickFieldValue(fields, ds.fieldNo, FIELD_FALLBACKS.no);
    const titleRaw = pickFieldValue(fields, ds.fieldTitle, FIELD_FALLBACKS.title);
    const contentRaw = pickFieldValue(
      fields,
      ds.fieldContent,
      FIELD_FALLBACKS.content
    );
    // 飞书文本字段可能是 {text, type} 嵌套对象；也可能是数组（多行文本/选项）
    const unpack = (v) => {
      if (v == null) return "";
      if (Array.isArray(v)) return v.map(unpack).join("");
      if (typeof v === "object") {
        if (typeof v.text === "string") return v.text;
        // 多选 / 关联 退化为转字符串
        return JSON.stringify(v);
      }
      return String(v);
    };
    return {
      id: uid("ch"),
      no: Number(unpack(noRaw).trim()) || 0,
      title: unpack(titleRaw).trim(),
      content: unpack(contentRaw),
    };
  }

  // 同步主流程（async）：拉取飞书多维表格 → 替换当前数据源的 chapters
  async function syncDataSource(ds, opts = {}) {
    const { silent = false } = opts;
    if (!ds) return;
    // 互斥锁：避免同一数据源并发
    if (ds._syncing) {
      if (!silent) toast("正在同步中…");
      return;
    }
    ds._syncing = true;
    ds.syncStatus = "syncing";
    ds.syncError = "";
    renderSyncStatus(ds);
    try {
      const appToken = parseAppTokenFromUrl(ds.url);
      if (!appToken) {
        throw new Error("URL 里解析不到 app_token（请用 https://xxx.feishu.cn/base/... 这种完整链接）");
      }
      if (!ds.appId || !ds.appSecret) {
        ds.syncStatus = "no-config";
        throw new Error("未配置 App ID / App Secret，请打开数据源编辑填写");
      }
      const token = await getTenantAccessToken(ds.appId, ds.appSecret);
      const tables = await listTables(token, appToken);
      const targetName = ds.tableName || "章节正文";
      const target = tables.find((t) => t.name === targetName);
      if (!target) {
        const names = tables.map((t) => t.name).join("、") || "（无）";
        throw new Error(`找不到子表「${targetName}」，多维表格中现有子表：${names}`);
      }
      const records = await listRecords(token, appToken, target.table_id);
      if (records.length === 0) {
        throw new Error(`子表「${targetName}」是空的，没有任何记录`);
      }
      const chapters = records
        .map((r) => recordToChapter(r, ds))
        .filter((c) => c.no > 0 || c.title || c.content) // 过滤空记录
        .sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
      if (chapters.length === 0) {
        throw new Error("所有记录都缺少有效字段（章节号/章节名/内容）");
      }
      // 替换并保留当前选中章节（如果新数据里还有）
      const prevId = state.currentChapterId;
      ds.chapters = chapters;
      if (prevId && !chapters.find((c) => c.id === prevId)) {
        state.currentChapterId = chapters[0]?.id || null;
      }
      ds.lastSyncAt = new Date().toISOString();
      ds.syncStatus = "success";
      ds.syncError = "";
      save();
      renderAll();
      if (!silent) toast(`同步成功：${chapters.length} 章`);
    } catch (e) {
      console.error("同步失败", e);
      ds.syncStatus = ds.syncStatus === "syncing" ? "error" : ds.syncStatus;
      ds.syncError = e.message || String(e);
      renderSyncStatus(ds);
      renderDataSourceMeta();
      if (!silent) toast("同步失败：" + (e.message || "未知错误"), "error", 3500);
    } finally {
      ds._syncing = false;
    }
  }

  // 渲染同步状态点（ds-meta 左侧的小圆点）
  function renderSyncStatus(ds) {
    const dot = $("#ds-status");
    const label = $("#sync-label");
    if (!dot) return;
    dot.className = "ds-status"; // reset
    if (!ds) {
      dot.dataset.status = "";
      dot.title = "";
      if (label) label.textContent = "同步";
      return;
    }
    const status = ds.syncStatus || "idle";
    dot.dataset.status = status;
    let title = "";
    switch (status) {
      case "syncing":
        title = "同步中…";
        if (label) label.textContent = "同步中";
        break;
      case "success":
        title = ds.lastSyncAt
          ? `已同步于 ${new Date(ds.lastSyncAt).toLocaleString()}`
          : "已同步";
        if (label) label.textContent = "已同步";
        break;
      case "error":
        title = "同步失败：" + (ds.syncError || "未知错误");
        if (label) label.textContent = "重试";
        break;
      case "no-config":
        title = "未配置飞书同步凭证，点击「同步」打开数据源编辑";
        if (label) label.textContent = "去配置";
        break;
      default:
        title = "未同步";
        if (label) label.textContent = "同步";
    }
    dot.title = title;
  }

  /* ============================================================
     渲染
     ============================================================ */
  function renderDataSourceSelect() {
    const sel = $("#ds-select");
    sel.innerHTML = state.dataSources
      .map(
        (d) =>
          `<option value="${escapeHtml(d.id)}" ${
            d.id === state.currentDataSourceId ? "selected" : ""
          }>${escapeHtml(d.name)}</option>`
      )
      .join("");
  }

  function renderDataSourceMeta() {
    const ds = getCurrentDataSource();
    const el = $("#ds-meta-text");
    const link = $("#ds-bind-link");
    if (!ds) {
      el.textContent = "—";
      link.hidden = true;
      renderSyncStatus(null);
      return;
    }
    const parts = [];
    if (ds.chapters && ds.chapters.length) {
      parts.push(`${ds.chapters.length} 章`);
    }
    if (ds.url) {
      parts.push(ds.appId && ds.appSecret ? "已配置同步" : "已绑定表格");
    } else {
      parts.push("未绑定表格");
    }
    if (ds.note) {
      parts.push(ds.note);
    }
    el.textContent = parts.join(" · ");
    el.title = ds.note || "";
    if (!ds.url) {
      link.hidden = false;
      link.dataset.dsId = ds.id;
    } else {
      link.hidden = true;
      link.dataset.dsId = "";
    }
    renderSyncStatus(ds);
  }

  function renderChapterList() {
    const ds = getCurrentDataSource();
    const list = $("#chapter-list");
    if (!ds) {
      list.innerHTML = "";
      return;
    }
    const chapters = getSortedChapters(ds);
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
    const n = content.length;
    $("#word-count").textContent = `${n} 字`;
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

    // 控件状态
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
    renderDataSourceSelect();
    renderDataSourceMeta();
    renderChapterList();
    renderEditor();
    renderTheme();
  }

  /* ============================================================
     事件：数据源
     ============================================================ */
  function bindDataSourceEvents() {
    $("#ds-select").addEventListener("change", (e) => {
      state.currentDataSourceId = e.target.value;
      state.currentChapterId = null;
      save();
      renderAll();
    });

    $("#ds-open").addEventListener("click", () => {
      const ds = getCurrentDataSource();
      if (!ds) return;
      if (ds.url) {
        window.open(ds.url, "_blank", "noopener");
      } else {
        toast("当前数据源未绑定飞书表格链接");
      }
    });

    // 顶部「+」按钮：直接打开"新增数据源"弹窗
    $("#ds-new").addEventListener("click", () => {
      openDataSourceEdit(null);
    });

    // 顶部「⚙」按钮：打开管理数据源弹窗
    $("#ds-manage").addEventListener("click", () => {
      renderDataSourceList();
      showModal("modal-manage");
    });

    // 「点此绑定飞书表格」快捷链接
    $("#ds-bind-link").addEventListener("click", (e) => {
      e.preventDefault();
      const ds = getCurrentDataSource();
      if (ds) openDataSourceEdit(ds);
    });

    // 兼容：工具栏中已不再有"管理"按钮（已移至顶部），如仍存在则保留绑定
    const legacyManage = $("#btn-manage");
    if (legacyManage) {
      legacyManage.addEventListener("click", () => {
        renderDataSourceList();
        showModal("modal-manage");
      });
    }

    $("#btn-ds-add").addEventListener("click", () => {
      openDataSourceEdit(null);
    });

    // 弹窗关闭
    $$('[data-close]').forEach((el) =>
      el.addEventListener("click", (e) => {
        const modal = e.target.closest(".modal");
        if (modal) modal.hidden = true;
      })
    );

    // 数据源编辑保存
    $("#btn-ds-save").addEventListener("click", () => {
      const editingId = $("#btn-ds-save").dataset.editingId || null;
      const name = $("#ds-name").value.trim();
      const url = $("#ds-url").value.trim();
      const note = $("#ds-note").value.trim();
      const appId = $("#ds-app-id").value.trim();
      const appSecret = $("#ds-app-secret").value;
      const tableName = $("#ds-table-name").value.trim() || "章节正文";
      const fieldNo = $("#ds-field-no").value.trim() || "章节号";
      const fieldTitle = $("#ds-field-title").value.trim() || "章节名";
      const fieldContent = $("#ds-field-content").value.trim() || "文章内容";
      if (!name) {
        toast("名称不能为空", "error");
        return;
      }
      const fields = {
        name, url, note,
        appId, appSecret, tableName,
        fieldNo, fieldTitle, fieldContent,
      };
      if (editingId) {
        const ds = state.dataSources.find((d) => d.id === editingId);
        if (ds) Object.assign(ds, fields);
      } else {
        state.dataSources.push({
          id: uid("ds"),
          ...fields,
          builtIn: false,
          chapters: [],
          lastSyncAt: null,
          syncStatus: "idle",
          syncError: "",
        });
      }
      save();
      hideModal("modal-ds-edit");
      renderAll();
      if ($("#modal-manage").hidden === false) renderDataSourceList();
      toast(editingId ? "已更新" : "已新增");
    });

    // 工具栏「同步」按钮
    let syncDebounceTimer = null;
    $("#btn-sync").addEventListener("click", () => {
      const ds = getCurrentDataSource();
      if (!ds) {
        toast("请先选择数据源", "error");
        return;
      }
      if (!ds.url) {
        toast("当前数据源未绑定飞书表格链接，请先在编辑中配置");
        return;
      }
      // 错误状态或未配置：点同步 → 打开编辑弹窗让用户配置
      if (ds.syncStatus === "no-config" || (!ds.appId || !ds.appSecret)) {
        openDataSourceEdit(ds);
        toast("请先在「飞书同步配置」中填写 App ID / App Secret", "info", 3000);
        return;
      }
      // 简单节流
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(() => syncDataSource(ds), SYNC_DEBOUNCE_MS);
    });
  }

  function renderDataSourceList() {
    const ul = $("#ds-list");
    ul.innerHTML = state.dataSources
      .map((d) => {
        const ch = (d.chapters || []).length;
        const urlHtml = d.url
          ? `<a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">打开表格</a>`
          : `<span class="muted">无链接</span>`;
        return `
          <li class="ds-item ${d.id === state.currentDataSourceId ? "active" : ""}" data-id="${escapeHtml(d.id)}">
            <div class="ds-item-info">
              <div class="ds-item-name">${escapeHtml(d.name)}${d.builtIn ? ' <span class="muted">·内置</span>' : ""}</div>
              <div class="ds-item-meta">${ch} 章 · ${urlHtml}${d.note ? " · " + escapeHtml(d.note) : ""}</div>
            </div>
            <div class="ds-item-actions">
              <button class="icon-btn" data-act="switch" title="切换为当前">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <button class="icon-btn" data-act="edit" title="编辑">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              <button class="icon-btn" data-act="delete" title="删除" ${d.builtIn ? "disabled" : ""}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
              </button>
            </div>
          </li>
        `;
      })
      .join("");

    // 绑定列表操作
    $$("#ds-list .ds-item").forEach((el) => {
      const id = el.dataset.id;
      el.querySelector('[data-act="switch"]').addEventListener("click", () => {
        state.currentDataSourceId = id;
        state.currentChapterId = null;
        save();
        renderAll();
        renderDataSourceList();
        toast("已切换");
      });
      el.querySelector('[data-act="edit"]').addEventListener("click", () => {
        const ds = state.dataSources.find((d) => d.id === id);
        if (ds) openDataSourceEdit(ds);
      });
      const delBtn = el.querySelector('[data-act="delete"]');
      if (delBtn && !delBtn.disabled) {
        delBtn.addEventListener("click", () => {
          if (!confirm(`确定删除数据源「${state.dataSources.find((d) => d.id === id)?.name}」？其下所有章节也会一并删除。`))
            return;
          state.dataSources = state.dataSources.filter((d) => d.id !== id);
          if (state.currentDataSourceId === id) {
            state.currentDataSourceId = state.dataSources[0]?.id || null;
            state.currentChapterId = null;
          }
          save();
          renderAll();
          renderDataSourceList();
          toast("已删除");
        });
      }
    });
  }

  function openDataSourceEdit(ds) {
    $("#ds-edit-title").textContent = ds ? "编辑数据源" : "新增数据源";
    $("#ds-name").value = ds ? ds.name : "";
    $("#ds-url").value = ds ? ds.url || "" : "";
    $("#ds-note").value = ds ? ds.note || "" : "";
    $("#ds-app-id").value = ds ? ds.appId || "" : "";
    $("#ds-app-secret").value = ds ? ds.appSecret || "" : "";
    $("#ds-table-name").value = ds ? ds.tableName || "章节正文" : "章节正文";
    $("#ds-field-no").value = ds ? ds.fieldNo || "章节号" : "章节号";
    $("#ds-field-title").value = ds ? ds.fieldTitle || "章节名" : "章节名";
    $("#ds-field-content").value = ds ? ds.fieldContent || "文章内容" : "文章内容";
    $("#btn-ds-save").dataset.editingId = ds ? ds.id : "";
    showModal("modal-ds-edit");
    setTimeout(() => $("#ds-name").focus(), 50);
  }

  /* ============================================================
     事件：章节
     ============================================================ */
  function bindChapterEvents() {
    // 点击章节
    $("#chapter-list").addEventListener("click", (e) => {
      const item = e.target.closest(".ch-item");
      if (!item) return;
      state.currentChapterId = item.dataset.id;
      save();
      renderChapterList();
      renderEditor();
    });

    // 新增
    $("#btn-new").addEventListener("click", () => {
      const ds = getCurrentDataSource();
      if (!ds) {
        toast("请先选择或新增数据源", "error");
        return;
      }
      const nextNo = (ds.chapters || []).reduce(
        (m, c) => Math.max(m, Number(c.no) || 0),
        0
      ) + 1;
      const ch = {
        id: uid("ch"),
        no: nextNo,
        title: "",
        content: "",
      };
      ds.chapters = ds.chapters || [];
      ds.chapters.push(ch);
      state.currentChapterId = ch.id;
      save();
      renderAll();
      setTimeout(() => $("#ch-title").focus(), 50);
      toast(`已新增第 ${nextNo} 章`);
    });

    // 保存
    $("#btn-save").addEventListener("click", () => {
      const ch = getCurrentChapter();
      if (!ch) return;
      ch.no = Number($("#ch-no").value) || 0;
      ch.title = $("#ch-title").value.trim();
      ch.content = $("#ch-content").value;
      save();
      renderChapterList();
      const s = $("#save-status");
      s.textContent = "✓ 已保存";
      s.classList.add("saved");
      clearTimeout(s._t);
      s._t = setTimeout(() => {
        s.textContent = "";
        s.classList.remove("saved");
      }, 1500);
    });

    // 删除
    $("#btn-delete").addEventListener("click", () => {
      const ds = getCurrentDataSource();
      const ch = getCurrentChapter();
      if (!ds || !ch) return;
      if (!confirm(`确定删除章节「${ch.title || ch.no}」？`)) return;
      ds.chapters = ds.chapters.filter((c) => c.id !== ch.id);
      state.currentChapterId = null;
      save();
      renderAll();
      toast("已删除");
    });

    // 内容编辑时实时更新字数（不保存）
    $("#ch-content").addEventListener("input", () => {
      updateWordCount();
    });

    // 清空当前数据源章节
    $("#btn-clear").addEventListener("click", () => {
      const ds = getCurrentDataSource();
      if (!ds) return;
      if (!ds.chapters || ds.chapters.length === 0) {
        toast("当前数据源已经是空的");
        return;
      }
      if (!confirm(`确定清空「${ds.name}」下的所有 ${ds.chapters.length} 章？此操作不可恢复。`))
        return;
      ds.chapters = [];
      state.currentChapterId = null;
      save();
      renderAll();
      toast("已清空");
    });

    // 排序
    $("#btn-sort").addEventListener("click", () => {
      state.ui.sort = state.ui.sort === "asc" ? "desc" : "asc";
      save();
      renderChapterList();
    });
  }

  /* ============================================================
     事件：导入
     ============================================================ */
  function bindImportEvents() {
    $("#btn-import").addEventListener("click", () => {
      $("#import-text").value = "";
      $("#import-skip-header").checked = true;
      $("#import-preview").innerHTML = "";
      $("#btn-import-confirm").disabled = true;
      $("#btn-import-confirm").dataset.parsed = "";
      showModal("modal-import");
      setTimeout(() => $("#import-text").focus(), 50);
    });

    $("#import-text").addEventListener("input", () => {
      const rows = parseImport($("#import-text").value);
      renderImportPreview(rows);
      $("#btn-import-confirm").disabled = rows.length === 0;
      $("#btn-import-confirm").dataset.parsed = JSON.stringify(rows);
    });

    $("#btn-import-confirm").addEventListener("click", () => {
      const ds = getCurrentDataSource();
      if (!ds) {
        toast("当前数据源无效", "error");
        return;
      }
      const raw = $("#btn-import-confirm").dataset.parsed;
      if (!raw) return;
      const rows = JSON.parse(raw);
      if (rows.length === 0) {
        toast("没有可导入的内容", "error");
        return;
      }
      ds.chapters = ds.chapters || [];
      let added = 0,
        replaced = 0;
      rows.forEach((r) => {
        const existingIdx = ds.chapters.findIndex((c) => Number(c.no) === r.no);
        const ch = { id: existingIdx >= 0 ? ds.chapters[existingIdx].id : uid("ch"), ...r };
        if (existingIdx >= 0) {
          ds.chapters[existingIdx] = ch;
          replaced++;
        } else {
          ds.chapters.push(ch);
          added++;
        }
      });
      // 按 no 排序
      ds.chapters.sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
      save();
      hideModal("modal-import");
      renderAll();
      toast(`导入完成：新增 ${added} 章，覆盖 ${replaced} 章`);
    });
  }

  function parseImport(text) {
    if (!text || !text.trim()) return [];
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];

    // 尝试自动检测分隔符：Tab 优先，其次多空格，最后逗号
    const detectSep = (sample) => {
      if (sample.includes("\t")) return "\t";
      // 多空格分隔（避免单空格被误判为标题内的空格）
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
      if (parts.length < 2) continue;
      const no = Number(parts[0]);
      if (!Number.isFinite(no)) continue;
      // 标题在第 2 列，内容是第 3 列往后（可能含分隔符）
      const title = parts[1] || "";
      const content = parts.slice(2).join(" ").trim();
      out.push({ no, title, content });
    }
    return out;
  }

  function renderImportPreview(rows) {
    const wrap = $("#import-preview");
    if (rows.length === 0) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = rows
      .map(
        (r) => `
        <div class="preview-row">
          <span class="preview-no">${escapeHtml(String(r.no))}</span>
          <span class="preview-title" title="${escapeHtml(r.title)}">${escapeHtml(r.title || "（无标题）")}</span>
          <span class="preview-len">${r.content.length}字</span>
        </div>
      `
      )
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
     事件：主题 / 导入导出
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

    // 导出
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

    // 导入
    $("#file-import").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (!data.dataSources) {
            toast("文件格式不对", "error");
            return;
          }
          if (!confirm("导入将覆盖当前所有数据，确定？")) return;
          state.dataSources = data.dataSources;
          state.currentDataSourceId = data.currentDataSourceId || data.dataSources[0]?.id;
          state.currentChapterId = null;
          if (data.theme) state.theme = { ...DEFAULT_THEME, ...data.theme };
          if (data.ui) state.ui = { sort: "asc", ...data.ui };
          save();
          renderAll();
          toast("已导入");
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
  function init() {
    load();
    renderAll();
    bindDataSourceEvents();
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

    // 打开页面时自动同步：当前数据源有 URL + 凭证时，异步拉取最新章节
    // 失败/未配置 → 用本地缓存（已经在 renderAll 里渲染过了）
    setTimeout(() => {
      const ds = getCurrentDataSource();
      if (ds && ds.url && ds.appId && ds.appSecret) {
        syncDataSource(ds, { silent: true });
      } else if (ds && ds.url) {
        // 有 URL 但无凭证：标记为 no-config 让用户知道该去配置
        ds.syncStatus = "no-config";
        renderSyncStatus(ds);
      }
    }, 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
