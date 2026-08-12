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
  const SCHEMA_VERSION = 1;

  const DEFAULT_DATA_SOURCES = [
    {
      id: "ds_builtin",
      name: "示例小说 · 墨笺",
      url: "",
      note: "内置示例，可删除",
      builtIn: true,
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
      return;
    }
    const parts = [];
    if (ds.chapters && ds.chapters.length) {
      parts.push(`${ds.chapters.length} 章`);
    }
    if (ds.url) {
      parts.push("已绑定表格");
    } else {
      parts.push("未绑定表格");
    }
    if (ds.note) {
      parts.push(ds.note);
    }
    el.textContent = parts.join(" · ");
    el.title = ds.note || "";
    // 当未绑定表格时，显示「点此绑定」链接
    if (!ds.url) {
      link.hidden = false;
      link.dataset.dsId = ds.id;
    } else {
      link.hidden = true;
      link.dataset.dsId = "";
    }
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
      if (!name) {
        toast("名称不能为空", "error");
        return;
      }
      if (editingId) {
        const ds = state.dataSources.find((d) => d.id === editingId);
        if (ds) {
          ds.name = name;
          ds.url = url;
          ds.note = note;
        }
      } else {
        state.dataSources.push({
          id: uid("ds"),
          name,
          url,
          note,
          builtIn: false,
          chapters: [],
        });
      }
      save();
      hideModal("modal-ds-edit");
      renderAll();
      if ($("#modal-manage").hidden === false) renderDataSourceList();
      toast(editingId ? "已更新" : "已新增");
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
