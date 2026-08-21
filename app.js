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
  // v32：抽屉改常驻 panel（fsDrawerId → fsDetailId）
//      去 fsEditing 编辑态（always editable）
//      履历跳转改箭头 icon 按钮触发
//      保存策略：200ms 防抖写 state + 1.5s 静默期入 history
//      flush 时机：切卡/切页面/切 sheet/Ctrl+S/60s 定时/关页
  const SCHEMA_VERSION = 17;
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
      // v36：主表末尾新增【简介】字段——xlsx 写回时自动追加为最后一列
      //   卡片中下位置展示简介预览；详情 panel 顶部 meta 区下方、履历上方加可编辑 textarea
      fields: {
        fsNo: ["伏笔编号"],
        name: ["伏笔名称"],
        status: ["状态", "伏笔状态", "回收状态"],
        intro: ["简介", "介绍", "概要", "summary", "intro"],
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
          // v36：简介默认空
          intro: "",
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
          // v36：简介字段——兼容旧数据（缺字段时默认空）
          intro: data.intro || "",
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

    // v19：财物详情页
    //  - 物品 / 灵石的台账（手动维护：名称 / 类别 / 数量 / 来源章节 / 备注）
    //  - 灵石条目可在「数量」填入正负数表示收支
    //  - 不与任何 sheet 自动归类（matchName / matchHeaders 都返回 false）——纯用户录入
    // v21：财物详情改为「复合」类型（compound）
    //   - tab 入口仍然是「财物详情」(goods)
    //   - 内部拆分为两个独立子页：灵石台账(lingshi) + 物品台账(items)
    //   - state.pages 不再存 goods，所有数据在 state.pages.lingshi / state.pages.items
    //   - 导入时由用户主动选 section（类似伏笔页的 fs-main / fs-record 双 section）
    //   - 自身无 items/fields/makeItem，渲染时调 renderCompoundGoods 一次性渲染两个子列
    goods: {
      id: "goods",
      kind: "compound",
      label: "财物详情",
      icon: "💰",
      matchName() { return false; },
      matchHeaders() { return false; },
      emptyStateHtml() {
        return `
          <div class="empty-state-inner">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2">
              <circle cx="12" cy="12" r="9" />
              <path d="M9 12h6M12 9v6" />
            </svg>
            <p>左侧灵石台账 · 右侧物品台账</p>
            <p class="hint">灵石用正负数表示收支，物品台账管理装备/丹药/法器等</p>
          </div>`;
      },
    },

    // v21：灵石台账
    //  - 5 字段：章节号 / 收支类型 / 数量 / 类型 / 原文描述
    //  - quantity 允许正负数：正数=收入，负数=支出（与「收支类型」字段冗余但方便直接录入）
    // v23：ling 时 state.pages.lingshi 仍存数据，goods tab 内部双栏渲染用到；
    // 但 PAGES 暴露成 tab 后用户觉得多余，标记 hiddenInNav 从导航移除
    lingshi: {
      id: "lingshi",
      kind: "list",
      hiddenInNav: true,
      label: "灵石台账",
      icon: "💎",
      matchName(name) {
        if (!name) return false;
        return /灵石|收支|lingshi/i.test(name);
      },
      matchHeaders(header) {
        const norm = (header || []).map((h) =>
          String(h || "").replace(/\s+/g, "").toLowerCase()
        );
        const has = (cands) =>
          cands.some((c) => norm.some((h) => h.includes(c.toLowerCase())));
        return has(["灵石", "收支", "余额"]);
      },
      fields: {
        chapter: ["章节号", "章节", "章号"],
        type: ["收支类型", "收支", "类型"],
        quantity: ["数量", "灵石数", "余额", "灵石"],
        category: ["类型", "币种", "灵石类型", "品级"],
        description: ["原文描述", "描述", "备注", "说明"],
      },
      defaults() {
        return { chapter: "", type: "收入", quantity: 0, category: "下品灵石", description: "" };
      },
      makeItem(data, sheet) {
        return {
          id: uid("ls"),
          chapter: String(data.chapter ?? "").trim(),
          type: data.type === "支出" ? "支出" : "收入",
          quantity: typeof data.quantity === "number"
            ? data.quantity
            : (parseFloat(data.quantity) || 0),
          category: data.category || "下品灵石",
          description: data.description || "",
          sheet,
        };
      },
      sortKey(item) {
        // 按章节号排序（parseChapterNo 兼容 "第3章" / "3" 等）
        return parseChapterNo(item.chapter);
      },
      newItemLabel: "新增灵石",
      newItemToast(sheet, label) {
        return label ? `已新增灵石（${label}）` : "已新增灵石";
      },
      emptyStateHtml() {
        return `
          <div class="empty-state-inner">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2">
              <polygon points="12,2 22,12 12,22 2,12" />
            </svg>
            <p>暂无灵石记录，点上方「+ 新增灵石」添加</p>
            <p class="hint">正数=收入 · 负数=支出；类型填"下品灵石/中品/上品"等</p>
          </div>`;
      },
    },

    // v21：物品台账
    //  - 6 字段：章节号 / 物品名称 / 数量 / 类型 / 状态 / 原文描述
    //  - 状态：持有 / 使用 / 丢失 / 赠与 / 出售 等
    // v23：同 lingshi，state.pages.items 仍存数据，goods tab 内部双栏渲染用到
    items: {
      id: "items",
      kind: "list",
      hiddenInNav: true,
      label: "物品台账",
      icon: "📦",
      matchName(name) {
        if (!name) return false;
        return /物品|道具|装备|法器|丹药|材料|items?|goods/i.test(name);
      },
      matchHeaders(header) {
        const norm = (header || []).map((h) =>
          String(h || "").replace(/\s+/g, "").toLowerCase()
        );
        const has = (cands) =>
          cands.some((c) => norm.some((h) => h.includes(c.toLowerCase())));
        return (
          (has(["物品", "道具", "装备", "法器", "丹药"]) || has(["物品名称"])) &&
          !has(["灵石", "收支", "余额"])
        );
      },
      fields: {
        chapter: ["章节号", "章节", "章号"],
        name: ["物品名称", "名称", "物品"],
        quantity: ["数量"],
        category: ["类型", "类别", "分类"],
        status: ["状态"],
        description: ["原文描述", "描述", "备注", "说明"],
      },
      defaults() {
        return { chapter: "", name: "", quantity: 1, category: "", status: "持有", description: "" };
      },
      makeItem(data, sheet) {
        return {
          id: uid("it"),
          chapter: String(data.chapter ?? "").trim(),
          name: data.name || "",
          quantity: typeof data.quantity === "number"
            ? data.quantity
            : (parseFloat(data.quantity) || 1),
          category: data.category || "",
          status: data.status || "持有",
          description: data.description || "",
          sheet,
        };
      },
      sortKey(item) {
        // 按物品名称字典序排序
        return { num: 0, str: item.name || "" };
      },
      newItemLabel: "新增物品",
      newItemToast(sheet, name) {
        return name ? `已新增「${name}」` : "已新增物品";
      },
      emptyStateHtml() {
        return `
          <div class="empty-state-inner">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M21 8L12 3 3 8v8l9 5 9-5z" />
              <path d="M3 8l9 5 9-5" />
            </svg>
            <p>暂无物品记录，点上方「+ 新增物品」添加</p>
            <p class="hint">武器/丹药/法器/功法/材料/符箓等都在此管理</p>
          </div>`;
      },
    },

    // v43：故事脉络页
    //  - 从 v19/v42 的 dashboard 聚合类型 改为 list 类型
    //  - 字段顺序（用户要求）：章节号 / 章节梗概 / 剧情时间 / 地点 / 人物 / 物品
    //  - 支持 .xlsx / .json / 文本粘贴 导入（v43 新加 IMPORT_SECTIONS.storyline）
    storyline: {
      id: "storyline",
      kind: "list",
      label: "故事脉络",
      icon: "📜",
      matchName() { return false; },
      matchHeaders() { return false; },
      fields: {
        no: ["章节号", "章号", "序号"],
        summary: ["章节梗概", "梗概", "概要", "剧情概要", "章节概要"],
        plotTime: ["剧情时间", "时间", "日期", "剧情日期"],
        location: ["地点", "场景"],
        chars: ["人物", "出场人物", "登场人物"],
        items: ["物品", "道具"],
      },
      defaults() {
        return { no: 0, summary: "", plotTime: "", location: "", chars: "", items: "" };
      },
      makeItem(data, sheet) {
        return {
          id: uid("sl"),
          // no 字段 parseRowsForPage 已经把 "第12章"→12 / "序章"→"序章" 标准化了
          no: data.no != null ? data.no : 0,
          summary: String(data.summary || "").trim(),
          plotTime: String(data.plotTime || "").trim(),
          location: String(data.location || "").trim(),
          chars: String(data.chars || "").trim(),
          items: String(data.items || "").trim(),
          sheet,
        };
      },
      sortKey(item) {
        // 跟章节一致：no 走 parseChapterNo，能解析出数字优先按数字排，否则按字符串
        return parseChapterNo(item.no);
      },
      newItemLabel: "新增脉络",
      newItemToast(sheet, summary) {
        return summary ? `已新增脉络「${summary}」` : "已新增脉络";
      },
      emptyStateHtml() {
        return `
          <div class="empty-state-inner">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M3 12h4l3 -8l4 16l3 -8h4" />
            </svg>
            <p>故事脉络</p>
            <p class="hint">支持 .xlsx / .json / 文本粘贴导入。字段：章节号 / 章节梗概 / 剧情时间 / 地点 / 人物 / 物品。</p>
          </div>`;
      },    },

    // v19：角色详情页
    //  - 角色台账（手动维护：名称 / 身份 / 描述 / 首次出场章节）
    //  - 描述可填角色在文章中的相关描述 + 剧情走向
    // v38：新增「角色信息」(info, 单 textarea) + 「角色履历」(多 record，章节号+原文描述)
    //   - 履历存储在 state.pages.character.records[]，跟伏笔履历同样的数据形态
    //   - 切角色时由 flushCharacterDetail 把当前 panel 的 input/textarea 写回 state
    // v43：角色详情页——字段重写
    //   旧字段（v19/v38）：name / role / firstCh / description / info + record: setup+notes（按 name 关联）
    //   新字段（v43 用户要求）：
    //     基础数据表（5 字段）：编号 / 名称 / 势力 / 最后出现章节 / 信息
    //     履历表（4 字段）：编号 / 出现章节 / 原文描述 / 备注
    //   - 履历存储在 state.pages.character.records[]，按「编号」关联（不是 name）
    //   - 切角色时由 flushCharacterDetail 把当前 panel 的 input/textarea 写回 state
    //   - 旧 role/firstCh/description 字段在 v43 迁移时被丢弃（load() v16→v17）
    character: {
      id: "character",
      kind: "list",
      label: "角色详情",
      icon: "👤",
      matchName() { return false; },
      matchHeaders() { return false; },
      fields: {
        no: ["编号", "角色编号", "序号"],
        name: ["名称", "角色名", "姓名", "人物", "名字"],
        faction: ["势力", "组织", "门派", "宗门", "帮派"],
        lastCh: ["最后出现章节", "最后出现", "末次出场", "最终出现", "最后出场"],
        // 信息字段——单 textarea，存放角色设定/背景/外貌/性格等长描述
        info: ["信息", "角色信息", "角色简介", "设定"],
      },
      // v43：角色履历表 recordFields（4 列：编号 / 出现章节 / 原文描述 / 备注）
      //   - 履历按「编号」(no) 关联角色（不是 name，编号是用户核心标识）
      //   - 旧 v38 履历字段 setup/notes + name 关联 在 v43 迁移时被丢弃
      recordFields: {
        no: ["编号", "角色编号", "序号"],
        setup: ["出现章节", "章节号", "章节", "提及章节"],
        notes: ["原文描述", "描述"],
        remark: ["备注", "说明", "附注"],
      },
      defaults() {
        return { no: "", name: "", faction: "", lastCh: "", info: "" };
      },
      recordDefaults() {
        return { no: "", setup: "", notes: "", remark: "" };
      },
      makeItem(data, sheet) {
        // no 字段：能解析为数字就提（"第12章"→12），纯汉字保留原字符串
        let noVal = data.no;
        if (typeof noVal === "string" && noVal.trim()) {
          const p = parseChapterNo(noVal);
          if (p.hasNum && Number.isFinite(p.num)) noVal = p.num;
        }
        return {
          id: uid("ch2"),
          no: noVal != null ? noVal : "",
          name: data.name || "",
          faction: data.faction || "",
          lastCh: String(data.lastCh ?? "").trim(),
          info: data.info || "",
          sheet,
        };
      },
      makeRecord(data, sheet) {
        // 履历按「编号」关联——no 标准化为字符串（兼容数字/字符串输入）
        let noVal = data.no;
        if (typeof noVal === "string") noVal = noVal.trim();
        else if (noVal != null) noVal = String(noVal);
        return {
          id: uid("ch2r"),
          no: noVal || "",
          setup: data.setup || "",
          notes: data.notes || "",
          remark: data.remark || "",
          sheet,
        };
      },
      recordSortKey(rec) {
        // 角色履历按 setup 章节号排序
        return parseChapterNo(rec.setup);
      },
      sortKey(item) {
        // v43：按「编号」升序（无 role 字段后不再主角置顶）
        return parseChapterNo(item.no);
      },
      newItemLabel: "新增角色",
      newItemToast(sheet, name) {
        return name ? `已新增角色「${name}」` : "已新增角色";
      },
      emptyStateHtml() {
        return `
          <div class="empty-state-inner">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0 -4 4 -7 8 -7s8 3 8 7" />
            </svg>
            <p>从左侧选一个角色查看，或新增一个</p>
            <p class="hint">基础数据表字段：编号 / 名称 / 势力 / 最后出现章节 / 信息；履历表：编号 / 出现章节 / 原文描述 / 备注</p>
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

  // v19：检测现有伏笔编号的"格式模板"
  //  - 拿当前 sheet（或全量）的 fsNo 样本，看哪种 "前缀 + 数字宽度" 出现最多
  //  - 出现 2 次及以上就视为已建立格式；否则返回 null（沿用纯数字）
  //  - 例子：
  //      ["1", "2", "3"]              → {prefix: "",     padWidth: 1}
  //      ["FS-001", "FS-002", "FS-3"] → {prefix: "FS-",  padWidth: 3}  （少数服从多数）
  //      ["F1", "F2", "F10"]          → {prefix: "F",    padWidth: 1}
  //      ["序章", "1", "2"]           → null                 （样本不统一）
  function detectFsNoFormat(items) {
    const samples = (items || [])
      .map((it) => String(it && it.fsNo != null ? it.fsNo : "").trim())
      .filter(Boolean);
    if (samples.length < 2) return null; // 不到 2 个样本，不足以定格式
    const re = /^(.*?)(\d+)$/;
    let best = null;
    for (const s of samples) {
      const m = s.match(re);
      if (!m) continue;
      const prefix = m[1];
      const num = m[2];
      const pad = num.length;
      // 数这个 prefix+pad 在样本里出现多少次
      let count = 0;
      for (const o of samples) {
        const om = o.match(re);
        if (om && om[1] === prefix && om[2].length === pad) count++;
      }
      if (!best || count > best.count) {
        best = { prefix, padWidth: pad, count };
      }
    }
    if (!best || best.count < 2) return null;
    return { prefix: best.prefix, padWidth: best.padWidth };
  }

  // v19：按格式模板格式化新伏笔编号
  //  - fmt 为 null 时直接返回纯数字字符串
  function formatFsNoByFormat(num, fmt) {
    if (!fmt) return String(num);
    const numStr = String(num).padStart(fmt.padWidth, "0");
    return fmt.prefix + numStr;
  }
  // v23：派生时跳过 hiddenInNav（如 lingshi/items——其数据仍存在 state.pages，但不在左侧 tab 暴露）
  const PAGE_IDS = Object.keys(PAGES).filter((pid) => !PAGES[pid]?.hiddenInNav);
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
  // v32.1：判断是否窄屏（与 styles.css @media (max-width: 899px) 对齐）
  const NARROW_VIEWPORT_PX = 900;
  const isNarrowViewport = () =>
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia(`(max-width: ${NARROW_VIEWPORT_PX - 1}px)`).matches;
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
      // v19：storyline / character
      // v21：goods 拆分为 lingshi + items 两个独立 list
      //   - lingshi 存灵石台账（5 字段：chapter/type/quantity/category/description）
      //   - items 存物品台账（6 字段：chapter/name/quantity/category/status/description）
      //   - storyline 是 dashboard 类型（聚合章节数据，无 items）
      storyline: makePageState(),
      character: makePageState(),
      // v21 修复：goods 是 compound wrapper (kind: "compound"), 不存数据, 但 state.pages
      // 必须有这个 key, 否则 renderNavTabs 在 pid="goods" 时访问 .items 会 TypeError
      // （PAGES 含 goods, 但 init 默认 state.pages 不含 → 首次访问 throw → tab 消失）
      goods: makePageState(),
      lingshi: makePageState(),
      items: makePageState(),
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
        // v19/v21：page 快照
        //   - storyline / character 跟 v19 一致
        //   - goods 是 compound wrapper，state 不存数据
        //   - lingshi / items 是 v21 新增的 list
        storyline: {
          sheets: JSON.parse(JSON.stringify(state.pages.storyline.sheets || [])),
          currentSheet: state.pages.storyline.currentSheet,
          items: JSON.parse(JSON.stringify(state.pages.storyline.items || [])),
          currentItemId: state.pages.storyline.currentItemId,
        },
        character: {
          sheets: JSON.parse(JSON.stringify(state.pages.character.sheets || [])),
          currentSheet: state.pages.character.currentSheet,
          items: JSON.parse(JSON.stringify(state.pages.character.items || [])),
          currentItemId: state.pages.character.currentItemId,
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
        ...(snap.pages.chapter || {}),
      },
      foreshadowing: {
        ...makePageState(),
        ...(snap.pages.foreshadowing || {}),
      },
      // v19/v21：page 快照
      //   - goods 是 compound wrapper，state 不存数据（用 makePageState 兜底）
      //   - lingshi / items 是 v21 新增
      storyline: {
        ...makePageState(),
        ...(snap.pages.storyline || {}),
      },
      character: {
        ...makePageState(),
        ...(snap.pages.character || {}),
      },
      lingshi: {
        ...makePageState(),
        ...(snap.pages.lingshi || {}),
      },
      items: {
        ...makePageState(),
        ...(snap.pages.items || {}),
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

  // 持续编辑场景下用：1500ms 停顿才入栈（v32 加大：避免长文本输入产生海量 undo 步骤）
  //   与 debouncedSyncFsState（200ms 写 state）配合：
  //     - 输入时 200ms 内就写 state（不丢数据）
  //     - 但 1.5s 静默期才入 history 栈（按"停顿"为粒度切 undo）
  let _pushHistoryDebounce = null;
  function debouncedPushHistory(delay = 1500) {
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
          // v36：简介字段
          it.intro = String($("#fs-intro")?.value ?? it.intro ?? "").trim();
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
        } else if (state.currentPage === "character") {
          // v38：主表字段实时写 state，这里只同步 info
          it.info = String($("#ch2-info")?.value ?? it.info ?? "");
          // 履历由 input 事件实时写回 state.pages.character.records，这里不重复处理
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
      // v19：新增 3 个页面（goods / storyline / character）——schema 12 → 13
      //  - 给 v12 之前的数据补上这 3 个 page state 的空结构
      //  - 老数据升级时这些 page 一定是空的（用户没填过），不影响
      for (const pid of ["goods", "storyline", "character"]) {
        if (!state.pages[pid]) {
          state.pages[pid] = makePageState();
        }
      }
      state.schema = 13;
      // v21：goods 拆分（schema 13 → 14）
      //  - 旧 goods.items 按 category 分到 lingshi / items
      //  - 旧 item: {id, name, category, quantity, sourceCh, note, sheet}
      //    - category 含"灵石" → lingshi
      //    - 其他 → items
      //  - 字段重命名：
      //    - sourceCh → chapter
      //    - note → description
      //    - type: quantity < 0 ? "支出" : "收入"（启发式）
      //    - status: "持有"（默认）
      {
        const oldGoods = state.pages.goods;
        if (oldGoods && Array.isArray(oldGoods.items) && oldGoods.items.length > 0) {
          const lingshiItems = [];
          const itemItems = [];
          for (const old of oldGoods.items) {
            const cat = String(old.category || "");
            const isLingshi = /灵石/i.test(cat);
            const qty = typeof old.quantity === "number"
              ? old.quantity
              : (parseFloat(old.quantity) || 0);
            const base = {
              id: old.id || (isLingshi ? uid("ls") : uid("it")),
              chapter: String(old.sourceCh ?? "").trim(),
              quantity: qty,
              category: cat,
              description: old.note || "",
              sheet: old.sheet,
            };
            if (isLingshi) {
              lingshiItems.push({
                ...base,
                type: qty < 0 ? "支出" : "收入",
              });
            } else {
              itemItems.push({
                ...base,
                name: old.name || "",
                status: old.status || "持有",
              });
            }
          }
          if (!state.pages.lingshi) state.pages.lingshi = makePageState();
          if (!state.pages.items) state.pages.items = makePageState();
          state.pages.lingshi.items = lingshiItems;
          state.pages.lingshi.currentItemId = lingshiItems[0]?.id || null;
          state.pages.items.items = itemItems;
          state.pages.items.currentItemId = itemItems[0]?.id || null;
        }
        // 不管有没有数据，goods 都不再是 page 状态
        delete state.pages.goods;
      }
      state.schema = 14;
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
    fsDetailId: null,      // v32：panel 显示的伏笔 id（null = panel 显示空态）
    // v32 兼容：v31 用 fsDrawerId 表示"右侧抽屉打开的伏笔 id"；
    //        v32 改常驻 panel 后语义一致（指向当前显示的伏笔），
    //        load() 末尾会把 fsDrawerId 迁移到 fsDetailId 并删除旧字段
    // v38：角色履历排序（按章节号正/倒序）——独立字段，不复用 fsRecordSort
    ch2RecordSort: "asc",
    layout: {},
    ...(data.ui || {}),
  };
  // 旧数据兼容：补默认值
  if (!state.ui.fsSort) state.ui.fsSort = "asc";
  if (!state.ui.fsStatusFilter) state.ui.fsStatusFilter = "all";
  if (!state.ui.fsRecordSort) state.ui.fsRecordSort = "asc";
  if (!state.ui.ch2RecordSort) state.ui.ch2RecordSort = "asc";  // v38：角色履历排序默认值
  if (state.ui.fsDetailId === undefined) {
    // v32 兼容：v31 用 fsDrawerId 标记抽屉打开的伏笔，新版改 fsDetailId
    state.ui.fsDetailId = state.ui.fsDrawerId || null;
    if (state.ui.fsDrawerId !== undefined) delete state.ui.fsDrawerId;
  }
  if (state.ui.fsExpandedId !== undefined) delete state.ui.fsExpandedId;
  // v32 兼容：v28 之前的 fsEditing 字段——v32 起不再有"编辑态"概念
  if (state.ui.fsEditing !== undefined) delete state.ui.fsEditing;
      // 兜底：ui.layout 各字段补默认
      state.ui.layout = {
        nav: LAYOUT_DEFAULTS.nav,
        threeList: LAYOUT_DEFAULTS.threeList,
        threeRight: LAYOUT_DEFAULTS.threeRight,
        twoList: LAYOUT_DEFAULTS.twoList,
        // v35：伏笔 panel 宽度兜底
        fsPanel: LAYOUT_DEFAULTS.fsPanel,
        ...(state.ui.layout || {}),
      };

      // 兜底：确保每个 page 至少有基本结构
      for (const pid of PAGE_IDS) {
        if (!state.pages[pid]) state.pages[pid] = makePageState();
        if (!Array.isArray(state.pages[pid].items))
          state.pages[pid].items = [];
        if (!Array.isArray(state.pages[pid].sheets))
          state.pages[pid].sheets = [];
        // v38：character 加 records 字段（兼容旧数据）
        if (pid === "character" && !Array.isArray(state.pages[pid].records)) {
          state.pages[pid].records = [];
        }
      }
      // v23：hiddenInNav 类型的 page（lingshi/items）不参与 PAGE_IDS，但 state.pages 仍要存数据
      // ——load() 上面 1088 行的循环按 PAGE_IDS 遍历，lingshi/items 数据不会回填；
      // 兜底必须从 data.pages 显式搬过来
      for (const pid of Object.keys(PAGES)) {
        if (!PAGES[pid]?.hiddenInNav) continue;
        if (data.pages && data.pages[pid]) {
          state.pages[pid] = {
            ...makePageState(),
            ...data.pages[pid],
          };
        } else if (!state.pages[pid]) {
          state.pages[pid] = makePageState();
        }
        if (!Array.isArray(state.pages[pid].items))
          state.pages[pid].items = [];
        if (!Array.isArray(state.pages[pid].sheets))
          state.pages[pid].sheets = [];
        // v38：character records 兼容（虽然 character 不是 hiddenInNav，但保持字段统一）
        if (pid === "character" && !Array.isArray(state.pages[pid].records)) {
          state.pages[pid].records = [];
        }
      }
      // 兜底：sheetsRaw 里的 sheet 必须有 page 字段（默认 chapter）
      for (const s of state.sheetsRaw) {
        if (!s.page) s.page = "chapter";
      }
      // v40：迁移 lingshi items.type ↔ quantity 同步——旧数据可能 type 与 quantity 不一致
      //   （v40 移除 收支类型 select 后，type 完全由 quantity 派生，确保旧数据也一致）
      if (state.pages.lingshi && Array.isArray(state.pages.lingshi.items)) {
        for (const it of state.pages.lingshi.items) {
          const q = Number(it.quantity) || 0;
          it.type = q < 0 ? "支出" : "收入";
        }
      }
      // v43：角色详情页字段重写 + 履历按编号关联（schema 16 → 17）
      //  旧字段：items = {name, role, firstCh, description, info}（v19/v38 时代）
      //          records = {setup, notes}（v38 时代，按 name 关联）
      //  新字段：items = {no, name, faction, lastCh, info}（v43）
      //          records = {no, setup, notes, remark}（v43，按 no 关联）
      //  迁移策略：
      //   - items: 按原数组顺序赋 1-based 编号；role→faction；firstCh→lastCh；
      //            description/info 同时存在时 info 优先，description 备份到 info
      //   - records: 用 nameToNo Map 把旧 name 关联转为 no 关联；remark 字段空字符串
      {
        const ch = state.pages.character;
        if (ch && Array.isArray(ch.items)) {
          const nameToNo = new Map();
          ch.items = ch.items.map((old, idx) => {
            const no = idx + 1;
            if (old.name) nameToNo.set(String(old.name), no);
            return {
              id: old.id || uid("ch2"),
              no,
              name: old.name || "",
              faction: old.faction || old.role || "",
              lastCh: String(old.lastCh ?? old.firstCh ?? "").trim(),
              info: old.info || old.description || "",
              sheet: old.sheet,
            };
          });
          if (Array.isArray(ch.records)) {
            ch.records = ch.records.map((r) => {
              let noVal = "";
              if (r.name && nameToNo.has(String(r.name))) {
                noVal = nameToNo.get(String(r.name));
              } else if (r.no != null) {
                noVal = typeof r.no === "number" ? r.no : String(r.no).trim();
              }
              return {
                id: r.id || uid("ch2r"),
                no: noVal,
                setup: r.setup || "",
                notes: r.notes || "",
                remark: r.remark || "",
                sheet: r.sheet,
              };
            });
          }
        }
        state.schema = 17;
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
  // v19：检查伏笔编辑器（主表字段 + 履历）相对当前 item 的 state 是否有未保存的修改
  //  - 主表字段（fsNo / name / status）：DOM input 的 .value vs it.fsNo/it.name/it.status
  //  - 履历（setup / notes）：每行 .fs-record-row 的 input/textarea .value vs 匹配的 record
  //  - 用途：toggle 按钮切回查看态时、以及切伏笔时，决定是否调 saveCurrentItem()
  //    （避免无变化时也调 save → pushHistory 产生无意义 undo 节点）

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
      // v21 修复：防御 state.pages[pid] 缺失（goods 是 compound, load 迁移末尾会 delete；
      // 首次访问无 localStorage 时 load() 在 try 开头就 throw, catch 后走默认 state,
      // 默认 state.pages 可能不含某个 PAGES 项）
      const p = state.pages[pid] || { items: [] };
      const count = p.items ? p.items.length : 0;
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

  // v32：渲染伏笔网格
  //   - 卡片只有 head（编号/名称/状态/删除）
  //   - 右侧常驻 panel 显示 state.ui.fsDetailId 指向的伏笔详情（null = panel 显示空态）
  //   - 点卡片 → 切到该卡（panel 同步切换）
  // v36：把 fsNo 字符串里的数字部分用 span.fs-fsno-num 包裹，文字部分保持原样
  //   例："FS-001" → "FS-"(.fs-fsno-text) + "001"(.fs-fsno-num) + ""
  //       "12"    → "" + "12" + ""
  //   数字部分在卡片里用 22px（2 倍）显示，文字部分保持 11px（1 倍 = 不变）
  function highlightFsNo(raw) {
    if (!raw) return "";
    const safe = String(raw);
    // 拆分：prefix(文字) + num(数字) + suffix(文字)
    const m = safe.match(/^(\D*)(\d+)(.*)$/);
    if (!m) return `<span class="fs-fsno-text">${escapeHtml(safe)}</span>`;
    const [, pre, num, suf] = m;
    return (
      (pre ? `<span class="fs-fsno-text">${escapeHtml(pre)}</span>` : "") +
      `<span class="fs-fsno-num">${escapeHtml(num)}</span>` +
      (suf ? `<span class="fs-fsno-text">${escapeHtml(suf)}</span>` : "")
    );
  }

  function renderFsList() {
    const grid = $("#fs-grid");
    if (!grid) return;
    const p = curPage();
    // v18：列表用「筛选 + 排序」结果
    const items = getFilteredItems();
    // v18：同步排序按钮文字
    const sortLabel = $("#fs-sort-label");
    if (sortLabel) sortLabel.textContent = state.ui.fsSort === "asc" ? "正序" : "倒序";
    // v36：同步状态筛选按钮 active 态（左侧纵向 tab）
    const seg = $("#fs-status-filter");
    if (seg) {
      seg.querySelectorAll(".fs-filter-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.fsStatus === state.ui.fsStatusFilter);
      });
    }
    // v32：兜底——fsDetailId 指向已删除/不存在的项时，重置为 null（panel 显示空态）
    if (state.ui.fsDetailId && !items.some((it) => it.id === state.ui.fsDetailId)) {
      state.ui.fsDetailId = null;
    }
    if (items.length === 0) {
      grid.innerHTML = `
        <div class="fs-empty">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
            <path d="M3 7h18M3 12h18M3 17h12" />
          </svg>
          <p>暂无伏笔，点上方「+ 新增伏笔」添加</p>
          <p class="hint">伏笔 = 故事里提前铺设、后续回收的剧情线索</p>
        </div>`;
      const count = $("#fs-count");
      if (count) count.textContent = `0 条`;
      return;
    }
    grid.innerHTML = items
      .map((it) => {
        const status = it.status || FS_STATUS_DEFAULT;
        // v17：状态 class 映射（未回收 / 部分回收 / 已回收）
        const cls =
          status === "已回收"
            ? "fs-status-resolved"
            : status === "部分回收"
              ? "fs-status-partial"
              : "fs-status-unresolved";
        // v32：选中态 = panel 里正在显示的那张卡（active + 描边工具类）
        const isInPanel = it.id === state.ui.fsDetailId;
        // v36：伏笔编号解析——数字部分放大 2 倍，前缀/后缀文字保持原样
        // 例："FS-001" → "FS-"(文字 11px) + "001"(数字 22px) + ""
        //     "12"    → "" + "12"(22px) + ""
        const fsNoRaw = it.fsNo || "";
        const fsNoDisplay = fsNoRaw
          ? highlightFsNo(fsNoRaw)
          : '<span class="fs-fsno-empty">（无编号）</span>';
        // v36：简介预览——空简介不渲染整块
        const introRaw = it.intro || "";
        const introDisplay = introRaw
          ? `<div class="fs-col-intro" title="${escapeHtml(introRaw)}">${escapeHtml(introRaw)}</div>`
          : "";
        // v34：item 整张用状态色作背景，删掉内部状态文字 span（颜色已足够表达状态）
        return `
          <article class="fs-item ${cls} ${isInPanel ? "active border-selected" : ""}" data-id="${escapeHtml(it.id)}" data-action="open-panel">
            <header class="fs-card-head" data-id="${escapeHtml(it.id)}">
              <span class="fs-cell fs-col-fsno" title="伏笔编号 ${escapeHtml(fsNoRaw)}">${fsNoDisplay}</span>
              <span class="fs-cell fs-col-name" title="${escapeHtml(it.name || "")}">${escapeHtml(it.name || "（无名）")}</span>
              ${introDisplay}
              <button class="fs-delete" data-id="${escapeHtml(it.id)}" title="删除该伏笔" aria-label="删除该伏笔" type="button">×</button>
            </header>
          </article>`;
      })
      .join("");
    const count = $("#fs-count");
    if (count) count.textContent = `${items.length} 条`;
  }

  // v32：渲染伏笔详情 panel（宽屏常驻 + 窄屏 modal）
  //   - 宽屏（≥900）：panel 常驻右侧，无 drawer/mask 动画
  //   - 窄屏（≤899）：panel 走 v31 modal 式样（fixed + transform 滑入 + mask 遮罩）
  //   - state.ui.fsDetailId 决定显示哪条伏笔
  //     - null → 空态（窄屏下 panel 滑出隐藏区，宽屏下显示空态提示）
  //     - 有值 → 渲染该伏笔的 meta + 履历
  //   - always editable：删除"查看/编辑"切换；字段直接 input，无 readonly
  //   - 履历每行右侧新增箭头 icon 按钮触发跳转（替代"点原文描述"）
  function renderFsPanel() {
    const panel = $("#fs-panel");
    if (!panel) return;
    const pageBody = panel.parentElement; // v39：fs-page-body，需要切换 fs-panel-collapsed 类
    const mask = $("#fs-panel-mask");
    const detailId = state.ui.fsDetailId;
    // v39：默认收起 panel——没有选中伏笔时隐藏右侧详情区（resizer + panel 都不显示）
    //      选中有 fs 时移除 collapsed 类，panel 展开显示详情
    if (!detailId) {
      pageBody?.classList.add("fs-panel-collapsed");
    } else {
      pageBody?.classList.remove("fs-panel-collapsed");
    }
    // v32.1：同步 panel + mask 的 modal 状态（窄屏 modal 模式才会用到）
    if (detailId) {
      panel.classList.add("has-detail");
      panel.classList.add("open");
      if (mask) {
        mask.hidden = false;
        // 下一帧再加 .open（保证 hidden=false 先 commit，触发 transition）
        requestAnimationFrame(() => {
          if (mask) mask.classList.add("open");
        });
      }
    } else {
      panel.classList.remove("has-detail");
      panel.classList.remove("open");
      if (mask) {
        mask.classList.remove("open");
        // 略等动画结束再 hidden（避免 mask 闪一下）
        setTimeout(() => {
          if (mask && !state.ui.fsDetailId) mask.hidden = true;
        }, 300);
      }
      // v39：收起态不再显示空态提示（panel 已 display: none，空态自然不显示）
      //      保留 innerHTML 清理，避免下次展开时短暂闪烁
      panel.innerHTML = "";
      return;
    }
    const item = state.pages.foreshadowing.items.find((x) => x.id === detailId);
    if (!item) {
      // 兜底：找不到 item（外部删了/筛选掉了）→ 回到空态
      state.ui.fsDetailId = null;
      renderFsList();
      renderFsPanel();
      return;
    }
    const status = item.status || FS_STATUS_DEFAULT;
    const cls =
      status === "已回收"
        ? "fs-status-resolved"
        : status === "部分回收"
          ? "fs-status-partial"
          : "fs-status-unresolved";
    const recordsHtml = renderFsRecordRows(item.id);
    const recCount = getFsRecordsByFsNo(item).length;
    // v36：panel head 名称长名向下延展（去掉 nowrap/ellipsis）
    // v36：meta 区下方、履历上方加【简介】textarea
    // v32：panel 布局 = head (编号+名称+删除) + meta (状态) + section (履历+底栏)
    panel.innerHTML = `
      <div class="fs-panel-head">
        <div class="fs-panel-head-left">
          <span class="fs-panel-fsno" title="伏笔编号">${highlightFsNo(item.fsNo || "（无编号）")}</span>
          <span class="fs-panel-name" title="${escapeHtml(item.name || "")}">${escapeHtml(item.name || "（无名）")}</span>
        </div>
        <button id="btn-fs-status-toggle" class="fs-panel-status-btn ${cls}" title="点击切换状态" type="button">${escapeHtml(status)}</button>
        <button id="btn-fs-panel-delete" class="fs-panel-delete" title="收起详情面板" aria-label="收起详情面板" type="button">×</button>
      </div>
      <div class="fs-panel-body">
        <div class="fs-panel-meta">
          <div class="fs-panel-meta-row">
            <div class="meta-field">
              <label>伏笔编号</label>
              <input id="fs-fsno" type="text" value="${escapeHtml(item.fsNo || "")}" placeholder="如：FS-001" />
            </div>
            <div class="meta-field meta-title">
              <label>伏笔名称</label>
              <!-- v36：长名向下延展——textarea 替代 input
               * v39：去掉 rows="1" 限制（autoResize 时 height 由 scrollHeight 决定）
               * v41 调整：用户改主意——rows="1" 加回来，初始 1 行，超过 1 行后再向下扩展（autoResize 仍然有效） -->
              <textarea id="fs-name" class="meta-textarea meta-name-textarea" rows="1" placeholder="给伏笔起个名字">${escapeHtml(item.name || "")}</textarea>
            </div>
          </div>
          <!-- v36：简介 textarea——位于伏笔履历上方，可输入，默认空
           * v39：去掉 rows="2" 限制——autoResize 实时拓展高度（输入越多越高，无上限） -->
          <div class="meta-field meta-intro">
            <label>简介</label>
            <textarea id="fs-intro" class="meta-textarea" placeholder="一句话或一段话描述这个伏笔的概要">${escapeHtml(item.intro || "")}</textarea>
          </div>
        </div>
        <div class="fs-panel-section">
          <div class="fs-records-header">
            <span class="fs-records-title">📋 伏笔履历</span>
            <span class="fs-records-meta muted">${recCount} 条</span>
            <button id="btn-fs-record-sort" class="link-btn" title="切换正/倒序（按提及章节）">${state.ui.fsRecordSort === "asc" ? "正序" : "倒序"}</button>
            <button id="btn-fs-add-record" class="link-btn">+ 新增履历</button>
          </div>
          <div class="fs-records-list" id="fs-records-list">
            ${recordsHtml || `<div class="fs-records-empty muted">还没有履历，点上方「+ 新增履历」添加</div>`}
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
    // v10.1：panel innerHTML 重写后 #fs-file-path 是新元素,
    // 必须补一次 updateFilePathDisplay()，否则保存后路径消失
    updateFilePathDisplay();
    // v35：履历 textarea 渲染后调一次 autoResize，让高度匹配内容
    // （rows="1" 是初始默认值，但 r.notes 已有内容时，textarea 高度应自动展开显示全部）
    autoResizeAllNotesTextareas();
    // v39：fs-name / fs-intro 渲染后立刻调一次 autoResize——
    //      让现有内容填满的高度跟 scrollHeight 一致（item.name/item.intro 有内容时）
    autoResizeTextarea($("#fs-name"));
    autoResizeTextarea($("#fs-intro"));
  }

  // v32：设置 panel 显示的伏笔（点卡片 / 新增伏笔时调用）
  //   - 同一项：什么都不做（点击不响应）
  //   - 不同项：flush 旧项（如果 dirty）→ 切到新项 → save → 重渲染
  // v32：setFsDetail（去 fsEditing 拦截；总是 flush + 切换 + 重渲染）
  function setFsDetail(itemId) {
    // v32.1：null = 关闭 modal
    if (!itemId) {
      if (!state.ui.fsDetailId) return;
      try { flushFsDetail(); } catch (_) {}
      state.ui.fsDetailId = null;
      save();
      renderFsList();
      renderFsPanel();
      return;
    }
    if (state.ui.fsDetailId === itemId) return;
    // 切前：把当前 panel 里的伏笔 flush（取消防抖，立即写 state）
    flushFsDetail();
    // 同步 currentItemId（删除/auto-save 等场景仍依赖它）
    const fsPage = state.pages.foreshadowing;
    fsPage.currentItemId = itemId;
    state.ui.fsDetailId = itemId;
    save();
    renderFsList();      // 更新 active 描边
    renderFsPanel();     // 渲染 panel
  }

  // v32：把 panel 当前显示伏笔的"未保存输入"flush 到 state
  //   - 取消防抖：syncMeta/履历 input 的 200ms 防抖 + 1.5s history 入栈
  //   - 直接从 DOM 抓值写回 state + 入 history 栈
  //   - 不需要 dirty check（always editable，input 期间已经在写）
  function flushFsDetail() {
    const itemId = state.ui.fsDetailId;
    if (!itemId) return;
    const item = state.pages.foreshadowing.items.find((x) => x.id === itemId);
    if (!item) return;
    // 从 DOM 抓 fs-fsno/fs-name/fs-intro 当前值（状态按钮已实时写 state）
    const fsFsno = $("#fs-fsno");
    const fsName = $("#fs-name");
    const fsIntro = $("#fs-intro");
    if (fsFsno) item.fsNo = String(fsFsno.value ?? "").trim();
    if (fsName) item.name = fsName.value ?? "";
    // v36：简介字段
    if (fsIntro) item.intro = fsIntro.value ?? "";
    // 履历也 flush
    const rows = document.querySelectorAll("#fs-records-list .fs-record-row");
    rows.forEach((row) => {
      const recId = row.dataset.recordId;
      if (!recId) return;
      const rec = (state.pages.foreshadowing.records || []).find((r) => r.id === recId);
      if (!rec) return;
      const setup = row.querySelector('input[data-field="setup"]');
      const notes = row.querySelector('textarea[data-field="notes"]');
      if (setup) rec.setup = setup.value;
      if (notes) rec.notes = notes.value;
    });
    // 入 history 栈
    clearTimeout(_pushHistoryDebounce);
    _pushHistoryDebounce = null;
    pushHistory();
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
    // v32：grid 模式下没有 #fs-editor 容器——所有渲染都在 renderFsList + renderFsPanel 内联完成
    //   保留这个函数是为了让旧调用点（renderCurrentPage）依然可调
    //   实际效果：grid 模式下 delegate 到 renderFsList；非 grid 模式（理论上不再有）走旧逻辑（已删 fsEditing）
    if ($("#fs-grid") && !$("#fs-editor")) {
      renderFsList();
      return;
    }
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
    // v32：grid 模式下没有 #fs-editor 容器，此函数 grid 分支已 return；这里只服务理论上的非 grid 模式
    //      永远可编辑——没有 readonly/disabled（v32 去掉编辑态）
    //      状态改用 panel head 按钮（renderFsPanel），此处不再渲染 select
    const readonlyAttr = "";
    const statusCls = (s) =>
      s === "已回收" ? "fs-status-resolved" :
      s === "部分回收" ? "fs-status-partial" : "fs-status-unresolved";
    const curStatus = it.status || FS_STATUS_DEFAULT;
    const mainClass = "";
    // 渲染当前伏笔的履历（按提及章节排序）
    const recordsHtml = renderFsRecordRows(it.id);
    // v36：非 grid 模式（理论不再触发，但保留兼容）——加 fs-intro + 名称改 textarea
    editor.innerHTML = `
      <div class="editor-meta editor-meta-fs ${mainClass}">
        <!-- v32：删 btn-fs-toggle（编辑/查看态切换不再需要，常驻可编辑） -->
        <div class="meta-actions meta-actions-first"></div>
        <div class="meta-field meta-fsno">
          <label>伏笔编号</label>
          <input id="fs-fsno" type="text" ${readonlyAttr} value="${escapeHtml(it.fsNo || "")}" placeholder="如：FS-001" />
        </div>
        <div class="meta-field meta-title">
          <label>伏笔名称</label>
          <!-- v39：去掉 rows="1" 限制——autoResize 配合输入动态展开
           * v41 调整：用户改主意——rows="1" 加回来，初始 1 行，超过 1 行后再向下扩展（autoResize 仍然有效） -->
          <textarea id="fs-name" class="meta-textarea meta-name-textarea" rows="1" placeholder="给伏笔起个名字">${escapeHtml(it.name || "")}</textarea>
        </div>
        <div class="meta-field">
          <label>状态</label>
          <span class="fs-panel-status-btn ${statusCls(curStatus)}" title="仅展示，状态在 panel head 切换">${escapeHtml(curStatus)}</span>
        </div>
        <!-- v36：简介 textarea——位于伏笔履历上方，可输入，默认空
         * v39：去掉 rows="2" 限制——autoResize 实时拓展高度（输入越多越高，无上限） -->
        <div class="meta-field meta-intro">
          <label>简介</label>
          <textarea id="fs-intro" class="meta-textarea" placeholder="一句话或一段话描述这个伏笔的概要">${escapeHtml(it.intro || "")}</textarea>
        </div>
        <div class="meta-actions meta-actions-last">
          <!-- v32：移除"保存"按钮 + "完成编辑"按钮（常驻编辑无需切换态）
                 切伏笔时自动 flush panel 内容到 state + 写 localStorage；不需要显式保存按钮 -->
          <!-- v17：编辑按钮旁的"删除"按钮移除——删除统一在左侧列表的 .fs-delete 叉号触发，避免重复入口 -->
        </div>
      </div>
      <div class="editor-body editor-body-fs ${mainClass}">
        <div class="fs-records-section">
          <div class="fs-records-header">
            <span class="fs-records-title">📋 伏笔履历</span>
            <span class="fs-records-meta muted">${getFsRecordsByFsNo(it).length} 条 · 按提及章节</span>
            <!-- v18：履历排序（按提及章节正/倒序） -->
            <button id="btn-fs-record-sort" class="link-btn" title="切换正/倒序（按提及章节）">${state.ui.fsRecordSort === "asc" ? "正序" : "倒序"}</button>
            <button id="btn-fs-add-record" class="link-btn">+ 新增履历</button>
          </div>
          <div class="fs-records-list" id="fs-records-list">
            ${recordsHtml || `<div class="fs-records-empty muted">还没有履历，点上方「+ 新增履历」添加</div>`}
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
    // v35：履历 textarea 渲染后调一次 autoResize（非 grid 模式兼容）
    autoResizeAllNotesTextareas();
    // v36：fs-name/fs-intro 渲染后 autoResize（非 grid 模式兼容）
    const fsName2 = $("#fs-name");
    const fsIntro2 = $("#fs-intro");
    if (fsName2) autoResizeTextarea(fsName2);
    if (fsIntro2) autoResizeTextarea(fsIntro2);
  }

  /* ============================================================
     v19：新增 3 个页面的渲染函数
       - 财物详情 (goods)：list 类型，2 列布局
       - 故事脉络 (storyline)：dashboard 类型，单列时间线
       - 角色详情 (character)：list 类型，2 列布局
     ============================================================ */

  // —— 通用 list 渲染辅助（lingshi / items / character 共用） ——
  // 根据 sortKey 比较函数排序
  function getSortedLingshiItems() {
    const p = state.pages.lingshi;
    const def = PAGES.lingshi;
    if (!p || !def) return [];
    const arr = p.items.slice();
    arr.sort((a, b) => {
      const ka = def.sortKey(a);
      const kb = def.sortKey(b);
      return compareChapterNo(ka, kb);
    });
    return arr;
  }
  function getSortedItemsItems() {
    const p = state.pages.items;
    const def = PAGES.items;
    if (!p || !def) return [];
    const arr = p.items.slice();
    arr.sort((a, b) => {
      const ka = def.sortKey(a);
      const kb = def.sortKey(b);
      // items 的 sortKey 是 {num, str}，按名字字典序
      if (ka.num !== kb.num) return ka.num - kb.num;
      return (ka.str || "").localeCompare(kb.str || "", "zh-CN");
    });
    return arr;
  }
  function getSortedCharacterItems() {
    const p = state.pages.character;
    const def = PAGES.character;
    const arr = p.items.slice();
    arr.sort((a, b) => {
      // character 的 sortKey 是 {num, chNo, str}，先按 num（主角/非主角），再按 chNo，再按名字
      const ka = def.sortKey(a);
      const kb = def.sortKey(b);
      if (ka.num !== kb.num) return ka.num - kb.num;
      const cc = compareChapterNo(
        { num: ka.chNo, str: String(ka.chNo) },
        { num: kb.chNo, str: String(kb.chNo) }
      );
      if (cc !== 0) return cc;
      return (ka.str || "").localeCompare(kb.str || "", "zh-CN");
    });
    return arr;
  }

  // —— 通用：删除指定 page 的某 item（goods tab 下的子 page 用） ——
  // deleteCurrentItem 用 curItem() 走 state.currentPage，对 compound 类型的 goods 不适用
  function deleteItemFromPage(pid, id) {
    const p = state.pages[pid];
    const def = PAGES[pid];
    if (!p || !def) return;
    const it = p.items.find((x) => x.id === id);
    if (!it) return;
    const label = it.name || it.chapter || it.category || "(无标题)";
    if (!confirm(`确定删除${def.label}「${label}」？`)) return;
    p.items = p.items.filter((x) => x.id !== id);
    if (p.currentItemId === id) {
      p.currentItemId = null;
      // v24：抽屉式 — 同步关抽屉
      if (state.currentPage === "goods") {
        const editorId = pid === "lingshi" ? "lingshi-editor" : pid === "items" ? "items-editor" : null;
        if (editorId) {
          const editor = document.getElementById(editorId);
          const drawer = editor ? editor.closest(".compound-col-editor") : null;
          if (drawer) drawer.classList.remove("open");
        }
      }
    }
    save();
    pushHistory();
    renderAll();
    toast("已删除");
  }

  // —— 灵石台账 ——
  // v24：summary 改成 renderLingshiSummary 单独渲染（台账标题上方），本函数只负责列表本身
  function renderLingshiList() {
    const list = $("#lingshi-list");
    if (!list) return;
    const p = state.pages.lingshi;
    const items = getSortedLingshiItems();
    list.innerHTML = items.length === 0
      ? ""
      : items
          .map((it) => {
            const active = it.id === p.currentItemId ? "active" : "";
            const qty = Number(it.quantity) || 0;
            const qtyClass = qty > 0 ? "ls-qty-pos" : qty < 0 ? "ls-qty-neg" : "";
            // v40：type 改成从 quantity 派生——正数=收入、负数=支出（不再有用户可编辑的 select）
            const type = qty < 0 ? "支出" : "收入";
            const typeClass = type === "支出" ? "ls-type-out" : "ls-type-in";
            return `
            <li class="ls-item ${active}" data-id="${escapeHtml(it.id)}">
              <span class="ls-chapter muted" title="章节号">${escapeHtml(it.chapter || "—")}</span>
              <span class="ls-type ${typeClass}">${escapeHtml(type)}</span>
              <span class="ls-qty ${qtyClass}">${qty >= 0 ? "+" : ""}${qty}</span>
              <span class="ls-cat muted" title="灵石类型">${escapeHtml(it.category || "—")}</span>
              <button class="ls-delete" data-id="${escapeHtml(it.id)}" title="删除该条记录" aria-label="删除该条记录" type="button">×</button>
            </li>`;
          })
          .join("");
    const count = $("#lingshi-count");
    if (count) count.textContent = `${items.length} 笔`;
  }

  // v24：灵石小计（v21 在列表底部；v24 移到台账标题上方 .compound-col-stats 区域）
  function renderLingshiSummary() {
    const sumEl = $("#lingshi-summary");
    if (!sumEl) return;
    const items = state.pages.lingshi.items;
    if (!items || items.length === 0) {
      sumEl.innerHTML = `<span class="stat-title">收支</span><span class="stat-empty">尚无数据</span>`;
      return;
    }
    let total = 0, posCount = 0, negCount = 0;
    for (const it of items) {
      const q = Number(it.quantity) || 0;
      total += q;
      if (q > 0) posCount++;
      else if (q < 0) negCount++;
    }
    sumEl.innerHTML = `
      <span class="stat-title">收支</span>
      <span class="lingshi-summary-pill">余额：<b>${total >= 0 ? "+" : ""}${total}</b></span>
      <span class="lingshi-summary-pill lingshi-summary-pos">收入 <b>${posCount}</b> 笔</span>
      <span class="lingshi-summary-pill lingshi-summary-neg">支出 <b>${negCount}</b> 笔</span>`;
  }

  function renderLingshiEditor() {
    const p = state.pages.lingshi;
    const it = p ? p.items.find((x) => x.id === p.currentItemId) : null;
    const empty = $("#lingshi-editor-empty");
    const editor = $("#lingshi-editor");
    // v24：抽屉式 — outer .compound-col-editor 加/去 .open 类
    const drawer = editor ? editor.closest(".compound-col-editor") : null;
    if (!empty || !editor) return;
    if (!it) {
      empty.hidden = false;
      editor.hidden = true;
      if (drawer) drawer.classList.remove("open");
      empty.innerHTML = PAGES.lingshi.emptyStateHtml();
      return;
    }
    empty.hidden = true;
    editor.hidden = false;
    if (drawer) drawer.classList.add("open");
    const qty = Number(it.quantity) || 0;
    editor.innerHTML = `
      <div class="editor-meta editor-meta-lingshi">
        <div class="meta-field">
          <label>章节号</label>
          <input id="ls-chapter" type="text" value="${escapeHtml(it.chapter || "")}" placeholder="如：第3章" />
        </div>
        <!-- v40：移除 收支类型 select——收支类型由「数量」正负自动判断（正=收入、负=支出、0=收入） -->
        <div class="meta-field">
          <label>数量 <span class="muted hint">（正=收入 / 负=支出，自动判断）</span></label>
          <input id="ls-quantity" type="number" step="any" value="${qty}" />
        </div>
        <div class="meta-field">
          <label>类型 <span class="muted hint">（下品/中品/上品灵石）</span></label>
          <input id="ls-category" type="text" value="${escapeHtml(it.category || "")}" placeholder="如：下品灵石" list="ls-cat-suggestions" />
          <datalist id="ls-cat-suggestions">
            <option value="下品灵石"></option>
            <option value="中品灵石"></option>
            <option value="上品灵石"></option>
            <option value="极品灵石"></option>
          </datalist>
        </div>
        <!-- v38：删 meta-actions 区里的"保存"+"删除"按钮——input 实时写 state + 列表行× 删条目 -->
      </div>
      <div class="editor-body">
        <label class="body-label">原文描述</label>
        <textarea id="ls-description" placeholder="灵石收支的原文出处、原因、相关情节…">${escapeHtml(it.description || "")}</textarea>
        <div class="body-stats">
          <div class="stats-left">
            <span id="ls-word-count" class="muted">0 字</span>
            <span id="ls-save-status" class="muted"></span>
          </div>
          <span id="lingshi-file-path" class="muted file-path" title=""></span>
        </div>
      </div>`;
    bindLingshiEditorEvents();
    updateFilePathDisplay();
  }

  function bindLingshiEditorEvents() {
    const p = state.pages.lingshi;
    const it = p ? p.items.find((x) => x.id === p.currentItemId) : null;
    if (!it) return;
    const wire = (id, prop, transform) => {
      const el = $("#" + id);
      if (!el) return;
      el.addEventListener("input", () => {
        let v = el.value;
        if (transform) v = transform(v);
        it[prop] = v;
        if (prop === "quantity" || prop === "type" || prop === "category" || prop === "chapter") {
          renderLingshiList();
        }
        if (id === "ls-description") {
          const wc = $("#ls-word-count");
          if (wc) wc.textContent = `${charCount(it.description)} 字`;
        }
        save();
      });
    };
    // v40：移除 收支类型 select 监听——收支类型由「数量」正负自动判断
    //   quantity wire 的 transform 里同步写 it.type，确保列表渲染时 type 与 quantity 一致
    wire("ls-chapter", "chapter");
    wire("ls-category", "category");
    wire("ls-quantity", "quantity", (v) => {
      const num = parseFloat(v) || 0;
      it.type = num < 0 ? "支出" : "收入"; // 同步 type（负数=支出，否则=收入）
      return num;
    });
    wire("ls-description", "description");

    // 初始字数
    const wc = $("#ls-word-count");
    if (wc) wc.textContent = `${charCount(it.description)} 字`;

    // v38：删 ls-save / ls-delete 按钮监听——input 实时写 state + 列表行× 删条目
  }

  // —— 物品台账 ——
  function renderItemsList() {
    const list = $("#items-list");
    if (!list) return;
    const p = state.pages.items;
    const items = getSortedItemsItems();
    list.innerHTML = items.length === 0
      ? ""
      : items
          .map((it) => {
            const active = it.id === p.currentItemId ? "active" : "";
            const qty = Number(it.quantity) || 0;
            const status = it.status || "持有";
            const statusClass =
              status === "丢失" ? "it-status-lost"
              : status === "使用" ? "it-status-used"
              : status === "赠与" || status === "出售" ? "it-status-gave"
              : "it-status-hold";
            return `
            <li class="it-item ${active}" data-id="${escapeHtml(it.id)}">
              <span class="it-chapter muted" title="章节号">${escapeHtml(it.chapter || "—")}</span>
              <span class="it-name">${escapeHtml(it.name || "（无名）")}</span>
              <span class="it-qty">×${qty}</span>
              <span class="it-cat muted" title="类型">${escapeHtml(it.category || "—")}</span>
              <span class="it-status ${statusClass}">${escapeHtml(status)}</span>
              <button class="it-delete" data-id="${escapeHtml(it.id)}" title="删除该物品" aria-label="删除该物品" type="button">×</button>
            </li>`;
          })
          .join("");
    const count = $("#items-count");
    if (count) count.textContent = `${items.length} 件`;
  }

  function renderItemsEditor() {
    const p = state.pages.items;
    const it = p ? p.items.find((x) => x.id === p.currentItemId) : null;
    const empty = $("#items-editor-empty");
    const editor = $("#items-editor");
    // v24：抽屉式 — outer .compound-col-editor 加/去 .open 类
    const drawer = editor ? editor.closest(".compound-col-editor") : null;
    if (!empty || !editor) return;
    if (!it) {
      empty.hidden = false;
      editor.hidden = true;
      if (drawer) drawer.classList.remove("open");
      empty.innerHTML = PAGES.items.emptyStateHtml();
      return;
    }
    empty.hidden = true;
    editor.hidden = false;
    if (drawer) drawer.classList.add("open");
    const qty = Number(it.quantity) || 1;
    editor.innerHTML = `
      <div class="editor-meta editor-meta-items">
        <div class="meta-field">
          <label>章节号</label>
          <input id="it-chapter" type="text" value="${escapeHtml(it.chapter || "")}" placeholder="如：第3章" />
        </div>
        <div class="meta-field meta-title">
          <label>物品名称</label>
          <input id="it-name" type="text" value="${escapeHtml(it.name || "")}" placeholder="如：九幽玄铁、寒霜剑" />
        </div>
        <div class="meta-field">
          <label>数量</label>
          <input id="it-quantity" type="number" min="0" step="1" value="${qty}" />
        </div>
        <div class="meta-field">
          <label>类型</label>
          <input id="it-category" type="text" value="${escapeHtml(it.category || "")}" placeholder="如：武器 / 丹药 / 法器" list="it-cat-suggestions" />
          <datalist id="it-cat-suggestions">
            <option value="武器"></option>
            <option value="丹药"></option>
            <option value="法器"></option>
            <option value="功法"></option>
            <option value="符箓"></option>
            <option value="材料"></option>
            <option value="服饰"></option>
          </datalist>
        </div>
        <div class="meta-field">
          <label>状态</label>
          <select id="it-status">
            <option value="持有" ${it.status !== "使用" && it.status !== "丢失" && it.status !== "赠与" && it.status !== "出售" ? "selected" : ""}>持有</option>
            <option value="使用" ${it.status === "使用" ? "selected" : ""}>使用</option>
            <option value="丢失" ${it.status === "丢失" ? "selected" : ""}>丢失</option>
            <option value="赠与" ${it.status === "赠与" ? "selected" : ""}>赠与</option>
            <option value="出售" ${it.status === "出售" ? "selected" : ""}>出售</option>
          </select>
        </div>
        <!-- v38：删 meta-actions 区里的"保存"+"删除"按钮——input 实时写 state + 列表行× 删条目 -->
      </div>
      <div class="editor-body">
        <label class="body-label">原文描述</label>
        <textarea id="it-description" placeholder="物品的来历、用途、相关情节…">${escapeHtml(it.description || "")}</textarea>
        <div class="body-stats">
          <div class="stats-left">
            <span id="it-word-count" class="muted">0 字</span>
            <span id="it-save-status" class="muted"></span>
          </div>
          <span id="items-file-path" class="muted file-path" title=""></span>
        </div>
      </div>`;
    bindItemsEditorEvents();
    updateFilePathDisplay();
  }

  function bindItemsEditorEvents() {
    const p = state.pages.items;
    const it = p ? p.items.find((x) => x.id === p.currentItemId) : null;
    if (!it) return;
    const wire = (id, prop, transform) => {
      const el = $("#" + id);
      if (!el) return;
      el.addEventListener("input", () => {
        let v = el.value;
        if (transform) v = transform(v);
        it[prop] = v;
        if (prop === "name" || prop === "category" || prop === "quantity" || prop === "chapter" || prop === "status") {
          renderItemsList();
        }
        if (id === "it-description") {
          const wc = $("#it-word-count");
          if (wc) wc.textContent = `${charCount(it.description)} 字`;
        }
        save();
      });
    };
    wire("it-chapter", "chapter");
    wire("it-name", "name");
    wire("it-category", "category");
    wire("it-quantity", "quantity", (v) => Math.max(0, parseInt(v, 10) || 0));
    wire("it-description", "description");

    // 状态 select
    const statusSel = $("#it-status");
    if (statusSel) {
      statusSel.addEventListener("change", () => {
        it.status = statusSel.value || "持有";
        renderItemsList();
        save();
      });
    }

    // 初始字数
    const wc = $("#it-word-count");
    if (wc) wc.textContent = `${charCount(it.description)} 字`;

    // v38：删 it-save / it-delete 按钮监听——input 实时写 state + 列表行× 删条目
  }

  // v24：物品未使用 top5 — 同一物品 name 分组取最新一条，
  //   若该条 status === "持有" 且最后提及章节 < 当前最新章节则入选
  //   按「最新章节 - 最后提及章节」差值降序排前 5
  function renderItemsTop5() {
    const top5 = $("#items-top5");
    if (!top5) return;
    const items = (state.pages.items && state.pages.items.items) || [];
    // 当前最新章节号
    const chItems = (state.pages.chapter && state.pages.chapter.items) || [];
    let latestChNo = -Infinity;
    for (const ch of chItems) {
      const n = parseChapterNo(ch.no).num;
      if (Number.isFinite(n) && n > latestChNo) latestChNo = n;
    }
    if (!Number.isFinite(latestChNo)) {
      // 没有章节数据时，不显示排名
      top5.innerHTML = `<span class="stat-title">未使用 top5</span><span class="stat-empty">暂无章节信息</span>`;
      return;
    }
    // 按 name 分组：记录每个 name 的最后一条（按 chapter 数字最大）
    const byName = new Map();
    for (const it of items) {
      const name = (it.name || "").trim();
      if (!name) continue;
      const chNo = parseChapterNo(it.chapter).num;
      if (!Number.isFinite(chNo)) continue;
      const cur = byName.get(name);
      if (!cur || chNo > cur.lastChNo) {
        byName.set(name, { lastChNo: chNo, lastItem: it });
      }
    }
    // 筛选 status === "持有" 且 最后提及章节 < 最新章节
    const candidates = [];
    for (const [name, info] of byName.entries()) {
      const status = info.lastItem.status || "持有";
      if (status !== "持有") continue;
      if (info.lastChNo >= latestChNo) continue;
      candidates.push({ name, lastChNo: info.lastChNo, gap: latestChNo - info.lastChNo });
    }
    candidates.sort((a, b) => b.gap - a.gap);
    const top = candidates.slice(0, 5);
    if (top.length === 0) {
      top5.innerHTML = `<span class="stat-title">未使用 top5</span><span class="stat-empty">尚无数据</span>`;
      return;
    }
    const lis = top.map((c, i) => `
      <li class="it-top5-item" title="最后一次提及：第${c.lastChNo}章">
        <span class="it-top5-rank">#${i + 1}</span>
        <span class="it-top5-name">${escapeHtml(c.name)}</span>
        <span class="it-top5-gap">差 ${c.gap} 章</span>
      </li>`).join("");
    top5.innerHTML = `<span class="stat-title">未使用 top5</span><ul class="it-top5-list">${lis}</ul>`;
  }

  // —— 复合入口：goods tab 一次性渲染 lingshi + items ——
  // v24：加 renderLingshiSummary（顶栏小计）+ renderItemsTop5（未使用排名）
  function renderCompoundGoods() {
    renderLingshiSummary();
    renderLingshiList();
    renderLingshiEditor();
    renderItemsTop5();
    renderItemsList();
    renderItemsEditor();
  }

  // —— 故事脉络 (v43：list 类型 — 左列表 + 右编辑器) ——
  // 字段顺序：章节号 / 章节梗概 / 剧情时间 / 地点 / 人物 / 物品
  // v19/v42 时的 dashboard 聚合视图已在 v43 删除——不再从 chapter / foreshadowing 聚合
  function renderStorylineList() {
    const list = $("#storyline-list");
    if (!list) return;
    const p = curPage();
    const items = getSortedItems();
    list.innerHTML = items.length === 0
      ? ""
      : items
          .map((it) => {
            const active = it.id === p.currentItemId ? "active" : "";
            // 字段显示：no / summary / plotTime / location / chars / items
            return `
            <li class="sl-item ${active}" data-id="${escapeHtml(it.id)}">
              <span class="sl-no muted" title="章节号">${escapeHtml(String(it.no))}</span>
              <span class="sl-summary">${escapeHtml(it.summary || "（无梗概）")}</span>
              <span class="sl-time muted" title="剧情时间">${escapeHtml(it.plotTime || "—")}</span>
              <span class="sl-location muted" title="地点">${escapeHtml(it.location || "—")}</span>
              <span class="sl-chars" title="人物">${escapeHtml(it.chars || "—")}</span>
              <span class="sl-items muted" title="物品">${escapeHtml(it.items || "—")}</span>
              <button class="sl-delete" data-id="${escapeHtml(it.id)}" title="删除该脉络条目" aria-label="删除该脉络条目" type="button">×</button>
            </li>`;
          })
          .join("");
    const count = $("#storyline-count");
    if (count) count.textContent = `${items.length} 条`;
    const sortLabel = $("#storyline-sort-label");
    if (sortLabel) sortLabel.textContent = state.ui.sort === "asc" ? "正序" : "倒序";
  }

  function renderStorylineEditor() {
    const it = curItem();
    const empty = $("#storyline-editor-empty");
    const editor = $("#storyline-editor");
    if (!empty || !editor) return;
    if (!it) {
      empty.hidden = false;
      editor.hidden = true;
      empty.innerHTML = PAGES.storyline.emptyStateHtml();
      return;
    }
    empty.hidden = true;
    editor.hidden = false;
    editor.innerHTML = `
      <div class="editor-meta editor-meta-storyline">
        <div class="meta-field">
          <label>章节号</label>
          <input id="sl-no" type="text" value="${escapeHtml(String(it.no || ""))}" placeholder="如：12 / 第12章 / 序章" />
        </div>
        <div class="meta-field meta-title">
          <label>章节梗概</label>
          <input id="sl-summary" type="text" value="${escapeHtml(it.summary || "")}" placeholder="本章的核心剧情概要" />
        </div>
        <div class="meta-field">
          <label>剧情时间</label>
          <input id="sl-plotTime" type="text" value="${escapeHtml(it.plotTime || "")}" placeholder="如：景和三年秋" />
        </div>
        <div class="meta-field">
          <label>地点</label>
          <input id="sl-location" type="text" value="${escapeHtml(it.location || "")}" placeholder="如：北荒·玄冰原" />
        </div>
        <div class="meta-field">
          <label>人物</label>
          <input id="sl-chars" type="text" value="${escapeHtml(it.chars || "")}" placeholder="如：林渊、萧婉儿（多个人物用逗号/顿号分隔）" />
        </div>
        <div class="meta-field">
          <label>物品</label>
          <input id="sl-items" type="text" value="${escapeHtml(it.items || "")}" placeholder="如：九幽玄铁、寒霜剑（多个用逗号/顿号分隔）" />
        </div>
      </div>
      <div class="body-stats">
        <div class="stats-left">
          <span id="sl-save-status" class="muted"></span>
        </div>
        <span id="sl-file-path" class="muted file-path" title=""></span>
      </div>`;
    bindStorylineEditorEvents();
    updateFilePathDisplay();
  }

  function bindStorylineEditorEvents() {
    const it = curItem();
    if (!it) return;
    const wire = (id, prop) => {
      const el = $("#" + id);
      if (!el) return;
      el.addEventListener("input", () => {
        let v = el.value;
        if (prop === "no") {
          // no 字段：parseChapterNo 标准化
          const p = parseChapterNo(v);
          if (p.hasNum && Number.isFinite(p.num)) v = p.num;
          else if (p.raw) v = p.raw;
        } else {
          v = String(v).trim();
        }
        it[prop] = v;
        if (prop === "no" || prop === "summary") {
          renderStorylineList();
        }
        save();
      });
    };
    wire("sl-no", "no");
    wire("sl-summary", "summary");
    wire("sl-plotTime", "plotTime");
    wire("sl-location", "location");
    wire("sl-chars", "chars");
    wire("sl-items", "items");
  }

  // —— 角色详情 ——
  // v43：角色列表——5 字段（编号 / 名称 / 势力 / 最后出现章节 / 信息）都要在左侧显示
  //   列表按 sortKey（按编号升序），删除走每行 ×
  function renderCharacterList() {
    const list = $("#character-list");
    if (!list) return;
    const p = state.pages.character;
    const items = getSortedCharacterItems();
    list.innerHTML = items.length === 0
      ? ""
      : items
          .map((it) => {
            const active = it.id === p.currentItemId ? "active" : "";
            // 信息在列表里只显示一行截断（完整内容在右侧 editor）
            const infoShort = (it.info || "").length > 0
              ? (it.info.length > 30 ? it.info.slice(0, 30) + "…" : it.info)
              : "—";
            return `
            <li class="ch2-item ${active}" data-id="${escapeHtml(it.id)}">
              <span class="ch2-no muted" title="编号">${escapeHtml(String(it.no || "—"))}</span>
              <span class="ch2-name">${escapeHtml(it.name || "（无名）")}</span>
              <span class="ch2-faction">${escapeHtml(it.faction || "—")}</span>
              <span class="ch2-lastCh muted" title="最后出现章节">${escapeHtml(it.lastCh || "—")}</span>
              <span class="ch2-info-line muted" title="信息">${escapeHtml(infoShort)}</span>
              <button class="ch2-delete" data-id="${escapeHtml(it.id)}" title="删除该角色" aria-label="删除该角色" type="button">×</button>
            </li>`;
          })
          .join("");
    const count = $("#character-count");
    if (count) count.textContent = `${items.length} 个`;
    const sortLabel = $("#character-sort-label");
    if (sortLabel) sortLabel.textContent = state.ui.sort === "asc" ? "正序" : "倒序";
  }

  // v43：角色详情面板——5 字段（编号 / 名称 / 势力 / 最后出现章节 / 信息）+ 履历 4 列
  function renderCharacterEditor() {
    const it = curItem();
    const empty = $("#character-editor-empty");
    const editor = $("#character-editor");
    if (!empty || !editor) return;
    if (!it) {
      empty.hidden = false;
      editor.hidden = true;
      empty.innerHTML = PAGES.character.emptyStateHtml();
      return;
    }
    empty.hidden = true;
    editor.hidden = false;
    // v43：履历按「编号」关联（不再是 name）—— 改用 getCharacterRecordsByNo
    const recordsHtml = renderCharacterRecordRows(it.id);
    const recCount = getCharacterRecordsByNo(it).length;
    editor.innerHTML = `
      <div class="editor-meta editor-meta-character">
        <div class="meta-field">
          <label>编号</label>
          <input id="ch2-no" type="text" value="${escapeHtml(String(it.no || ""))}" placeholder="如：1 / C-001" />
        </div>
        <div class="meta-field">
          <label>名称</label>
          <input id="ch2-name" type="text" value="${escapeHtml(it.name || "")}" placeholder="角色的名字" />
        </div>
        <div class="meta-field">
          <label>势力</label>
          <input id="ch2-faction" type="text" value="${escapeHtml(it.faction || "")}" placeholder="如：青云宗 / 玄霜阁" list="ch2-faction-suggestions" />
          <datalist id="ch2-faction-suggestions">
            <option value="青云宗"></option>
            <option value="玄霜阁"></option>
            <option value="万妖谷"></option>
            <option value="天机阁"></option>
            <option value="散修"></option>
          </datalist>
        </div>
        <div class="meta-field">
          <label>最后出现章节</label>
          <input id="ch2-lastCh" type="text" value="${escapeHtml(it.lastCh || "")}" placeholder="如：第 88 章" />
        </div>
      </div>
      <div class="editor-body">
        <label class="body-label">信息 <span class="muted hint">（设定/背景/外貌/性格等）</span></label>
        <textarea id="ch2-info" class="ch2-info" placeholder="角色的设定、背景、性格、外貌、能力、关系网络等长描述…">${escapeHtml(it.info || "")}</textarea>
        <!-- v43：角色履历——4 列（编号 / 出现章节 / 原文描述 / 备注） + 删除按钮 -->
        <div class="ch2-records-section">
          <div class="ch2-records-header">
            <span class="ch2-records-title">📋 角色履历</span>
            <span class="ch2-records-meta muted">${recCount} 条 · 按出现章节</span>
            <button id="btn-ch2-record-sort" class="link-btn" title="切换正/倒序（按出现章节）">${state.ui.ch2RecordSort === "desc" ? "倒序" : "正序"}</button>
            <button id="btn-ch2-add-record" class="link-btn">+ 新增履历</button>
          </div>
          <div class="ch2-records-list" id="ch2-records-list">
            ${recordsHtml || `<div class="ch2-records-empty muted">还没有履历，点上方「+ 新增履历」添加</div>`}
          </div>
        </div>
        <div class="body-stats">
          <div class="stats-left">
            <span id="ch2-info-word-count" class="muted">0 字</span>
            <span id="ch2-save-status" class="muted"></span>
          </div>
          <span id="ch2-file-path" class="muted file-path" title=""></span>
        </div>
      </div>`;
    bindCharacterEditorEvents();
    updateFilePathDisplay();
  }

  // v43：角色详情事件绑定——5 字段 wire + 履历 4 列 (no/setup/notes/remark) 增/删/排/编辑
  function bindCharacterEditorEvents() {
    const it = curItem();
    if (!it) return;
    const wire = (id, prop, options = {}) => {
      const el = $("#" + id);
      if (!el) return;
      el.addEventListener("input", () => {
        let v = el.value;
        if (options.parseChapterNo) {
          // no 字段：parseChapterNo 标准化（"第12章"→12 / "序章"→"序章"）
          const p = parseChapterNo(v);
          if (p.hasNum && Number.isFinite(p.num)) v = p.num;
          else if (p.raw) v = p.raw;
        } else {
          v = String(v);
        }
        it[prop] = v;
        // 5 字段任意变化都同步刷新左侧列表（编号 / 名称 / 势力 / 最后出现章节 / 信息 都要在左侧显示）
        if (["no", "name", "faction", "lastCh", "info"].includes(prop)) {
          renderCharacterList();
        }
        if (id === "ch2-info") {
          const wc = $("#ch2-info-word-count");
          if (wc) wc.textContent = `${charCount(it.info)} 字`;
        }
        save();
      });
    };
    wire("ch2-no", "no", { parseChapterNo: true });
    wire("ch2-name", "name");
    wire("ch2-faction", "faction");
    wire("ch2-lastCh", "lastCh");
    wire("ch2-info", "info");

    const wc = $("#ch2-info-word-count");
    if (wc) wc.textContent = `${charCount(it.info)} 字`;

    // 履历排序（按出现章节正/倒序切换）
    $("#btn-ch2-record-sort")?.addEventListener("click", () => {
      state.ui.ch2RecordSort = state.ui.ch2RecordSort === "asc" ? "desc" : "asc";
      save();
      renderCharacterEditor();
    });
    // 新增履历——按当前角色的「编号」自动填 no 字段
    $("#btn-ch2-add-record")?.addEventListener("click", () => {
      if (!Array.isArray(state.pages.character.records)) {
        state.pages.character.records = [];
      }
      const newRec = PAGES.character.makeRecord(
        { no: it.no || "", setup: "", notes: "", remark: "" },
        it.sheet
      );
      state.pages.character.records.push(newRec);
      renderCharacterEditor();
      // 聚焦到新行的 setup 输入
      setTimeout(() => {
        const row = document.querySelector(
          `.ch2-record-row[data-record-id="${CSS.escape(newRec.id)}"]`
        );
        const input = row?.querySelector(".ch2-rec-setup");
        if (input) input.focus();
      }, 30);
    });
    // 履历编辑（事件委托：input/textarea input 时写回 state，4 字段：no/setup/notes/remark）
    const list = $("#ch2-records-list");
    list?.addEventListener("input", (e) => {
      const target = e.target;
      if (!target) return;
      const field = target.dataset?.field;
      const row = target.closest(".ch2-record-row");
      const recId = row?.dataset?.recordId;
      if (!field || !recId) return;
      const rec = (state.pages.character.records || []).find(
        (r) => r.id === recId
      );
      if (rec) {
        rec[field] = target.value;
        debouncedPushHistory();
        // notes textarea 自动拓展
        if (field === "notes" || field === "remark") {
          autoResizeTextarea(target);
        }
      }
    });
    // 删除履历（点击每行 × 按钮）
    list?.addEventListener("click", (e) => {
      const btn = e.target.closest(".ch2-rec-delete");
      if (!btn) return;
      const recId = btn.dataset?.recordId;
      if (!recId) return;
      const idx = (state.pages.character.records || []).findIndex(
        (r) => r.id === recId
      );
      if (idx < 0) return;
      state.pages.character.records.splice(idx, 1);
      save();
      pushHistory();
      renderCharacterEditor();
    });
  }

  // v43：渲染角色履历行 HTML——4 列（编号 / 出现章节 / 原文描述 / 备注） + 删除按钮
  function renderCharacterRecordRows(itemId) {
    const item = state.pages.character.items.find((x) => x.id === itemId);
    if (!item) return "";
    const records = getCharacterRecordsByNo(item);
    if (records.length === 0) return "";
    return records
      .map((r) => {
        return `
          <div class="ch2-record-row" data-record-id="${escapeHtml(r.id)}">
            <div class="ch2-rec-col-no">
              <input type="text" data-field="no" value="${escapeHtml(String(r.no ?? ""))}" placeholder="编号" class="ch2-rec-no-input ch2-rec-underline" />
            </div>
            <div class="ch2-rec-col-setup">
              <input type="text" data-field="setup" value="${escapeHtml(r.setup || "")}" placeholder="章节号" class="ch2-rec-setup-big ch2-rec-underline" />
            </div>
            <div class="ch2-rec-col-notes">
              <textarea data-field="notes" rows="1" placeholder="原文描述" class="ch2-rec-underline ch2-rec-notes-autogrow">${escapeHtml(r.notes || "")}</textarea>
            </div>
            <div class="ch2-rec-col-remark">
              <textarea data-field="remark" rows="1" placeholder="备注" class="ch2-rec-underline ch2-rec-notes-autogrow">${escapeHtml(r.remark || "")}</textarea>
            </div>
            <button class="ch2-rec-delete" data-record-id="${escapeHtml(r.id)}" title="删除该履历" aria-label="删除该履历" type="button">×</button>
          </div>`;
      })
      .join("");
  }

  // v43：取当前角色的所有履历（按「编号」关联，按 setup 章节号排序，方向取 state.ui.ch2RecordSort）
  function getCharacterRecordsByNo(item) {
    if (!item) return [];
    const noKey = String(item.no ?? "").trim();
    const p = state.pages.character;
    if (!Array.isArray(p.records)) p.records = [];
    // 履历按「编号」关联（不按 id，删除角色后履历仍可保留）
    const list = p.records.filter(
      (r) => String(r.no ?? "").trim() === noKey
    );
    const dir = state.ui.ch2RecordSort === "desc" ? "desc" : "asc";
    list.sort((a, b) => {
      const ka = PAGES.character.recordSortKey(a);
      const kb = PAGES.character.recordSortKey(b);
      const cmp = compareChapterNo(ka, kb);
      return dir === "asc" ? cmp : -cmp;
    });
    return list;
  }

  // v43：切角色时从 DOM 抓 records / info 写回 state——4 字段 (no/setup/notes/remark)
  function flushCharacterDetail() {
    const it = curItem();
    if (!it) return;
    if (!Array.isArray(state.pages.character.records)) {
      state.pages.character.records = [];
    }
    // ch2-info
    const chInfo = $("#ch2-info");
    if (chInfo) it.info = chInfo.value ?? "";
    // 履历：遍历所有 ch2-record-row 抓 no/setup/notes/remark
    const rows = document.querySelectorAll("#ch2-records-list .ch2-record-row");
    const records = state.pages.character.records;
    rows.forEach((row) => {
      const recId = row.dataset.recordId;
      if (!recId) return;
      const rec = records.find((r) => r.id === recId);
      if (!rec) return;
      const noEl = row.querySelector('input[data-field="no"]');
      const setup = row.querySelector('input[data-field="setup"]');
      const notes = row.querySelector('textarea[data-field="notes"]');
      const remark = row.querySelector('textarea[data-field="remark"]');
      if (noEl) rec.no = noEl.value;
      if (setup) rec.setup = setup.value;
      if (notes) rec.notes = notes.value;
      if (remark) rec.remark = remark.value;
    });
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

  // v35：textarea 自动拓展
  //  - el 高度先 reset 成 auto（让 scrollHeight 重新计算）
  //  - 然后设成 scrollHeight（精确匹配内容，不出现滚动条）
  //  - 仅作于 .fs-rec-notes-autogrow，限定范围防误伤
  // v35：textarea 自动拓展——根据 scrollHeight 实时调高度
  //   v36：去掉 "fs-rec-notes-autogrow" class 限制——任何有 auto-resize 行为的 textarea 都可调
  //   （fs-name、fs-intro 也走这个函数）
  function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }

  // v35：把 fs-records-list 里所有 notes textarea 调一次 autoResize
  function autoResizeAllNotesTextareas() {
    const list = $("#fs-records-list");
    if (!list) return;
    list.querySelectorAll(".fs-rec-notes-autogrow").forEach(autoResizeTextarea);
  }

  // v14：渲染履历列表 HTML
  //  - 编辑态：每行可编辑（提到章节 / 原文描述）+ 删除按钮
  //  - 查看态：原文描述 clickable，hover 高亮，点击跳转章节
  // v35：原文描述 textarea 恢复 value 渲染（v34 误删导致 textarea 是空白的），
  //      rows 改 1，autoResize 初始化后调一次让高度匹配内容
  function renderFsRecordRows(itemId) {
    const item = state.pages.foreshadowing.items.find((x) => x.id === itemId);
    if (!item) return "";
    const records = getFsRecordsByFsNo(item);
    if (records.length === 0) return "";
    // v32：always editable —— 删查看态/编辑态分支，所有行统一为可编辑
    // v34：删每行右侧的 → 跳转按钮（跳转改成点整条履历空白区域触发）
    // v34：删【原文描述】小标题（输入框已有 placeholder + 下划线样式，无需标题）
    return records
      .map((r) => {
        // 数字解析自 r.setup (parseChapterNo)
        // - 有数字 → 显示数字；无数字（"序章"等）→ 留空
        const setupParsed = parseChapterNo(r.setup || "");
        const setupNum = setupParsed.hasNum && Number.isFinite(setupParsed.num)
          ? String(setupParsed.num)
          : "";
        return `
          <div class="fs-record-row" data-record-id="${escapeHtml(r.id)}">
            <div class="fs-rec-col-setup">
              <input type="text" data-field="setup" value="${escapeHtml(r.setup || "")}" placeholder="章节号" class="fs-rec-setup-big fs-rec-underline" />
            </div>
            <div class="fs-rec-col-notes">
              <textarea data-field="notes" rows="1" placeholder="原文描述" class="fs-rec-underline fs-rec-notes-autogrow">${escapeHtml(r.notes || "")}</textarea>
            </div>
            <button class="fs-rec-delete" data-record-id="${escapeHtml(r.id)}" title="删除该履历" aria-label="删除该履历" type="button">×</button>
          </div>`;
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
    // v32：主表字段（fsNo/name/status）实时写回 state
    //   - input 事件立即写 state + 同步卡片 head 显示（无 200ms 防抖，避免闪字）
    //   - 入 history 栈仍走 debouncedPushHistory（1.5s 静默期）
    //   - always editable：删 readonly/disabled + 删 fsEditing 切换按钮
    const fsFsno = $("#fs-fsno");
    const fsName = $("#fs-name");
    // v36：fs-intro 简介输入框
    const fsIntro = $("#fs-intro");
    // 状态按钮 class 映射：未回收/部分回收/已回收 → 不同颜色
    const statusCls = (s) =>
      s === "已回收" ? "fs-status-resolved" :
      s === "部分回收" ? "fs-status-partial" : "fs-status-unresolved";
    // 同步状态按钮 + 卡片背景状态 class
    // v34：fs-item 不再有内部 .fs-col-status 文字 span（item 背景色已表示状态），
    //   这里改同步 fs-item 的状态 class（resolved/partial/unresolved）
    const syncStatusCell = (s) => {
      const text = s || FS_STATUS_DEFAULT;
      const li = document.querySelector(`.fs-item[data-id="${CSS.escape(it.id)}"]`);
      if (li) {
        // 移除旧状态 class，加上新的
        li.classList.remove("fs-status-resolved", "fs-status-partial", "fs-status-unresolved");
        li.classList.add(statusCls(text));
      }
      const panelBtn = $("#btn-fs-status-toggle");
      if (panelBtn) {
        panelBtn.textContent = text;
        panelBtn.className = "fs-panel-status-btn " + statusCls(text);
      }
    };
    const syncMeta = () => {
      it.fsNo = String(fsFsno?.value ?? it.fsNo ?? "").trim();
      it.name = fsName?.value ?? it.name;
      // v36：fs-name 改 textarea 后，输入时高度要随内容自动拓展
      if (fsName) autoResizeTextarea(fsName);
      // 同步左侧卡片的 head 显示（编号/名称）
      const li = document.querySelector(`.fs-item[data-id="${CSS.escape(it.id)}"]`);
      if (li) {
        const nameCell = li.querySelector(".fs-col-name");
        if (nameCell) nameCell.textContent = it.name || "（无名）";
      }
      // panel head 上的编号/名称也要同步
      const panelFsNo = $(".fs-panel-fsno");
      const panelName = $(".fs-panel-name");
      if (panelFsNo) panelFsNo.textContent = it.fsNo || "（无编号）";
      if (panelName) panelName.textContent = it.name || "（无名）";
      debouncedPushHistory();
    };
    [fsFsno, fsName].forEach((el) => {
      el?.addEventListener("input", syncMeta);
      el?.addEventListener("change", syncMeta);
    });
    // v36：简介同步——根据 it.intro 是否为空，增/删/改卡片底部的 .fs-col-intro
    // v39 调整：用户要求「简介输入框逐渐向下扩张，不限制行数」——
    //      syncIntro 内调 autoResizeTextarea(fsIntro) 让高度跟随内容自动延展
    const syncIntro = () => {
      it.intro = String(fsIntro?.value ?? it.intro ?? "");
      // v39：简介输入框 auto-resize——输入越多越高，无行数限制
      if (fsIntro) autoResizeTextarea(fsIntro);
      // 同步卡片预览：找到当前 item 卡片，删旧 intro 节点（如果存在），按 it.intro 重建
      const li = document.querySelector(`.fs-item[data-id="${CSS.escape(it.id)}"]`);
      if (li) {
        const oldIntro = li.querySelector(".fs-col-intro");
        if (oldIntro) oldIntro.remove();
        if (it.intro) {
          const nameCell = li.querySelector(".fs-col-name");
          const delBtn = li.querySelector(".fs-delete");
          const introNode = document.createElement("div");
          introNode.className = "fs-col-intro";
          introNode.title = it.intro;
          introNode.textContent = it.intro;
          if (delBtn && delBtn.parentNode) {
            delBtn.parentNode.insertBefore(introNode, delBtn);
          } else if (nameCell && nameCell.parentNode) {
            nameCell.parentNode.appendChild(introNode);
          }
        }
      }
      debouncedPushHistory();
    };
    // v36：fs-intro 独立监听——避免每次输入都触发 syncMeta 的重逻辑
    fsIntro?.addEventListener("input", syncIntro);
    fsIntro?.addEventListener("change", syncIntro);
    // 状态按钮：点一下循环切换（未回收→部分回收→已回收→未回收）
    const statusBtn = $("#btn-fs-status-toggle");
    statusBtn?.addEventListener("click", () => {
      const cur = it.status || FS_STATUS_DEFAULT;
      const idx = FS_STATUS_OPTIONS.indexOf(cur);
      const next = FS_STATUS_OPTIONS[(idx + 1) % FS_STATUS_OPTIONS.length];
      it.status = next;
      syncStatusCell(next);
      save();
      debouncedPushHistory();
    });
    // v32：常驻编辑、无 btn-fs-toggle
    // v18：履历排序（按提及章节正/倒序）
    $("#btn-fs-record-sort")?.addEventListener("click", () => {
      state.ui.fsRecordSort = state.ui.fsRecordSort === "asc" ? "desc" : "asc";
      save();
      renderFsPanel();
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
      renderFsPanel();
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
    // v14 → v32 改造：履历编辑（事件委托：input/textarea change 时写回 state）
    //   v32：input 期间不重渲染 panel（避免 textarea 失焦），仅写 state + 入 history
    //   v35：textarea input 时同步调 autoResize——用户输入时 textarea 实时拓展显示全部
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
        // v35：textarea 自动拓展（仅作用于 .fs-rec-notes-autogrow）
        if (field === "notes") {
          autoResizeTextarea(target);
        }
      }
    });
    // v14：删除履历（点击每行 × 按钮）
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
      renderFsPanel();
    });
    // v34：履历跳转——点整条履历的空白区域 → 复用 jumpToChapterForRecord
    //   排除 input / textarea / .fs-rec-delete 上的点击（这些元素自己处理交互）
    list?.addEventListener("click", (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.target.closest(".fs-rec-delete")) return;
      const row = e.target.closest(".fs-record-row");
      if (!row) return;
      const recId = row.dataset?.recordId;
      if (!recId) return;
      const rec = state.pages.foreshadowing.records.find(
        (r) => r.id === recId
      );
      if (!rec) return;
      // 跳转前先 flush 当前 panel（避免 input 内容未保存）
      flushFsDetail();
      jumpToChapterForRecord(rec);
    });
    // v32：panel head 上的删除按钮 → 删当前 panel 显示的伏笔
    // v39 调整：用户改主意——×按钮改成「收起详情面板」（点 item 自动展开，点 × 收起）
    $("#btn-fs-panel-delete")?.addEventListener("click", () => {
      setFsDetail(null);
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
    // v44：只改当前页可见的对应按钮（不再统一 setLabel 所有 5 个按钮的 span）
    //   原因：之前 5 个 setLabel 会把所有按钮的 span 都改成当前页的 label；
    //   一旦用户切到 storyline 之前在 chapter 页，#btn-new-ch2 / #btn-new-storyline 的
    //   span 已被覆盖成「新增章节」；虽然它们是 hidden 的，但某些情况下（例如子面板/
    //   弹窗复用）仍会显示出错。改为只更新当前页的那个按钮，保证字面永远正确。
    //   5 个按钮对应的 page：
    //     #btn-new          → chapter
    //     #btn-new-fs       → foreshadowing
    //     #btn-new-lingshi  → goods (lingshi)
    //     #btn-new-items    → goods (items)
    //     #btn-new-ch2      → character
    //     #btn-new-storyline → storyline
    const def = curPageDef();
    const pid = state.currentPage;
    const label = def.newItemLabel || "新增";
    // 复合页 goods 当前激活的子页（goods 页面有两个新增按钮：灵石 / 物品）
    //   简化处理：goods 页面时两个按钮都用 lingshi 标签，因为 ls 是默认显示
    const setLabel = (btn) => {
      if (!btn || typeof btn.querySelector !== "function") return;
      const span = btn.querySelector("span");
      if (span) span.textContent = label;
      btn.title = label;
    };
    if (pid === "chapter") setLabel($("#btn-new"));
    else if (pid === "foreshadowing") setLabel($("#btn-new-fs"));
    else if (pid === "goods") {
      setLabel($("#btn-new-lingshi"));
      setLabel($("#btn-new-items"));
    }
    else if (pid === "storyline") setLabel($("#btn-new-storyline"));
    else if (pid === "character") setLabel($("#btn-new-ch2"));
  }

  function renderGlobal() {
    renderFileSelect();
    renderNavTabs();
    renderTheme();
  }

  function renderCurrentPage() {
    // v19：通用 page-view 显隐控制 + 按 kind 分发渲染
    //   - 5 个 page-view 各自 hidden 控制；只把当前页设为可见
    const views = ["chapter", "foreshadowing", "goods", "storyline", "character"];
    for (const pid of views) {
      const el = $(`[data-page-view="${pid}"]`);
      if (el) el.hidden = pid !== state.currentPage;
    }
    if (state.currentPage === "chapter") {
      renderSheetTabs();
      renderChapterList();
      renderChapterEditor();
    } else if (state.currentPage === "foreshadowing") {
      renderFsList();
      // v32：panel（详情/编辑）独立渲染；renderFsList 之后立即调 renderFsPanel
      //   renderFsPanel 会根据 state.ui.fsDetailId 决定渲染指定伏笔或空态
      renderFsPanel();
    } else if (state.currentPage === "goods") {
      // v21：goods 是 compound，渲染时调 renderCompoundGoods 一次性渲染 lingshi + items
      renderCompoundGoods();
    } else if (state.currentPage === "storyline") {
      // v43：storyline 改 list 类型——左列表 + 右编辑器（跟 chapter/character 一样结构）
      renderStorylineList();
      renderStorylineEditor();
    } else if (state.currentPage === "character") {
      renderCharacterList();
      renderCharacterEditor();
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
      // v36：简介字段
      it.intro = String($("#fs-intro")?.value ?? it.intro ?? "").trim();
      // 履历编辑在 input 事件里已经实时写回 records，这里不再处理
    } else if (state.currentPage === "character") {
      // v38：主表字段（name/role/firstCh/description）实时写 state 已经在 input 事件里处理
      // 这里调 flushCharacterDetail 抓 info + records（切 tab / 切 sheet 等场景兜底用）
      //  - input 事件里 records 已经实时写回 state.pages.character.records
      //  - 切 tab 时 saveCurrentItem 走这条路径，确保 records 不丢
      try { flushCharacterDetail(); } catch (_) {}
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
    // v32：伏笔页删除时——如果删的就是 panel 里正在显示的项，fsDetailId 要重置
    if (state.currentPage === "foreshadowing" && state.ui.fsDetailId === it.id) {
      state.ui.fsDetailId = null;
    }
    p.items = p.items.filter((x) => x.id !== it.id);
    p.currentItemId = null;
    save();
    pushHistory();
    renderAll();
    toast("已删除");
  }

  // v21：通用 addNewItemInPage(pid)
  //  - 由 addNewItem 调用（pid = state.currentPage）
  //  - 也可被工具栏的独立按钮直接调用（如 goods tab 下的"新增灵石"/"新增物品"按钮）
  //  - storyLine 是 dashboard 类型，没有 makeItem/defaults，调用前应避免
  function addNewItemInPage(pid) {
    if (!pid) pid = state.currentPage;
    const p = state.pages[pid];
    const def = PAGES[pid];
    if (!p || !def || !def.defaults || !def.makeItem) return;
    const targetSheet =
      p.currentSheet || (p.sheets[0] && p.sheets[0].name) || null;
    const data = def.defaults();
    if (pid === "chapter") {
      data.no = nextNoInCurrentSheet();
    } else if (pid === "foreshadowing") {
      // v19：伏笔编号 fsNo 自动生成——
      //   1) 取当前 sheet 内最大编号 +1（数字部分）
      //   2) 检测现有数据的"格式模板"（前缀 + 数字宽度），
      //      多数样本一致 → 新条目沿用同一格式（如 FS-001 → FS-004）
      //      样本不足或不统一 → 沿用纯数字
      const sheetList = targetSheet
        ? p.items.filter((it) => it.sheet === targetSheet)
        : p.items;
      let max = 0;
      for (const it of sheetList) {
        const k = parseFsNoKey(it.fsNo);
        if (Number.isFinite(k.num) && k.num > max) max = k.num;
      }
      const nextNum = max + 1;
      const fmt = detectFsNoFormat(sheetList);
      data.fsNo = formatFsNoByFormat(nextNum, fmt);
    }
    // lingshi / items / character 直接用 defaults()，不需要额外编号
    const it = def.makeItem(data, targetSheet);
    p.items.push(it);
    p.currentItemId = it.id;
    // v32：新增伏笔时 panel 自动定位到该伏笔——用户新建后马上能填字段（常驻 panel 总是可编辑）
    if (pid === "foreshadowing") {
      state.ui.fsDetailId = it.id;
    }
    save();
    pushHistory();
    renderAll();
    // v44 修：保险——renderAll 后下一 tick 再 renderCurrentPage 一次。
    //   原因：用户报告「所有页面点击新增后未及时出现，需切 tab 后才显示」；
    //   puppeteer 测试本地 OK，但部分浏览器/部署环境下可能因事件循环时序问题
    //   首次 render 不可见。这一次额外 render 是无害的（renderCurrentPage 内部只重写
    //   innerHTML，对已渲染内容 idempotent），但能保证新条目在下一帧前一定显示。
    setTimeout(() => {
      try { renderCurrentPage(); } catch (_) {}
    }, 0);
    // v40：新增伏笔时，如果当前是正序，fs-grid 自动滚到最底端（让用户看到新加的那张卡）
    //      倒序时新加的卡在列表顶部，本来就可见，不用滚
    if (pid === "foreshadowing" && state.ui.fsSort === "asc") {
      setTimeout(() => {
        const grid = $("#fs-grid");
        if (grid) grid.scrollTop = grid.scrollHeight;
      }, 60); // 略等 renderAll 后 grid 高度稳定
    }
    setTimeout(() => {
      // focus 第一个可输入字段
      const focusSel =
        pid === "chapter" ? "#ch-title"
        : pid === "foreshadowing" ? "#fs-name"
        : pid === "lingshi" ? "#ls-chapter"
        : pid === "items" ? "#it-chapter"
        : pid === "character" ? "#ch2-name"
        : null;
      if (focusSel) {
        const el = $(focusSel);
        if (el) el.focus();
      }
    }, 50);
    // toast 文案：foreshadowing 用 fsNo，lingshi 用「类型+数量」，其他用 name
    let displayKey = data.no;
    if (pid === "foreshadowing") displayKey = data.fsNo || data.no;
    else if (pid === "lingshi") displayKey = `${data.type} ${data.quantity}`;
    else if (data.name) displayKey = data.name;
    toast(def.newItemToast(targetSheet, displayKey));
  }

  function addNewItem() {
    addNewItemInPage(state.currentPage);
  }

  // v21：伏笔重新编号（v25 重构：先做连续性检查，根据检查结果决定是否真的重编号）
  //  - 用途：删除中间的伏笔后，后续 fsNo 不连续（如 1/2/4/5），点此按钮让列表按 sortKey 排序后重排为 1/2/3/4
  //  - 沿用 detectFsNoFormat 检测的格式模板（FS-001/FS-002... → 新编号也是 FS-001/FS-002...）
  //  - 走 ui.fsSort 的当前方向（正序/倒序），与列表显示顺序一致
  //  - 会 pushHistory（撤销可恢复），**不再 saveAsJson**——避免每次点按钮都写一份 json
  //    （重编号是临时性批量改动，自动保存/手动保存已经会落盘；写盘由用户操作触发）
  function renumberForeshadowing() {
    const p = state.pages.foreshadowing;
    if (!p || !Array.isArray(p.items) || p.items.length === 0) {
      toast("当前没有伏笔，无需重新编号", "info", 1500);
      return;
    }
    // v25：先弹"检测中"弹窗 → 跑连续性检查 → 按结果显示"连续无需编号"或"不连续+上下编号+询问"
    showRenumberCheckModal();
    // 模拟一点延迟（给用户看到"检测中"动画，实际是同步计算）
    setTimeout(() => {
      const result = checkForeshadowingContinuity();
      renderRenumberCheckResult(result);
    }, 350);
  }

  // v25：检测伏笔编号的连续性
  //  - 按 sortKey 排序（同列表展示顺序）
  //  - 只检查"可解析为数字"的伏笔（"序章"/"楔子"等字符串前缀不参与检查）
  //  - 返回 { continuous: true } 或 { continuous: false, gaps: [{prev, next}, ...] }
  //    gaps 元素是「不连续的上下编号」对（保留原始 fsNo 字符串）
  function checkForeshadowingContinuity() {
    const p = state.pages.foreshadowing;
    if (!p || !Array.isArray(p.items) || p.items.length === 0) {
      return { continuous: true, total: 0 };
    }
    const sortDir = state.ui.fsSort === "desc" ? -1 : 1;
    const sorted = p.items.slice().sort((a, b) => {
      const ka = PAGES.foreshadowing.sortKey(a);
      const kb = PAGES.foreshadowing.sortKey(b);
      if (ka.num !== kb.num) return (ka.num - kb.num) * sortDir;
      return ((ka.str || "").localeCompare(kb.str || "", "zh-CN")) * sortDir;
    });
    // 只取"有可解析数字"的项做检查
    const numericItems = sorted
      .map((it) => {
        const parsed = parseChapterNo(it.fsNo);
        return parsed.hasNum && Number.isFinite(parsed.num)
          ? { it, num: parsed.num, display: String(it.fsNo || "").trim() || String(parsed.num) }
          : null;
      })
      .filter(Boolean);
    if (numericItems.length === 0) {
      return { continuous: true, total: 0, sorted };
    }
    const gaps = [];
    for (let i = 1; i < numericItems.length; i++) {
      const a = numericItems[i - 1];
      const b = numericItems[i];
      // v40 修复：原代码 b.num - a.num !== 1 只对正序有效——倒序时 b.num - a.num = -1
      //   全报不连续。改为 Math.abs 兼容正/倒序（"连续"=绝对差 1，跟方向无关）
      if (Math.abs(b.num - a.num) !== 1) {
        gaps.push({ prev: a.display, next: b.display });
      }
    }
    return {
      continuous: gaps.length === 0,
      gaps,
      total: numericItems.length,
      sorted,
    };
  }

  // v25：把 sorted 顺序重排 fsNo（检测通过/用户点"是"后调用）
  function applyRenumber(sorted) {
    const p = state.pages.foreshadowing;
    if (!p) return 0;
    const fmt = detectFsNoFormat(p.items);
    let n = 1;
    for (const it of sorted) {
      it.fsNo = formatFsNoByFormat(n, fmt);
      n++;
    }
    pushHistory();
    // 注意：不再 saveAsJson()——用户明确要求"无需同步导出一个 json 文件"
    //   状态通过 save()（localStorage 同步）保持；写盘由用户后续的"保存/导出"动作触发
    save();
    renderAll();
    return sorted.length;
  }

  // v25：弹"检测中" → 渲染"检测结果"二态弹窗
  //  - 检测中：显示 spinner + 「正在检查伏笔编号连续性…」
  //  - 完成 + 连续：显示 ✓「编号连续，无需重新编号」+ 关闭按钮
  //  - 完成 + 不连续：显示不连续的「上下编号」列表 + 「是 / 否」按钮
  function showRenumberCheckModal() {
    const m = $("#modal-renumber-check");
    if (!m) return;
    m.hidden = false;
    // 初始：检测中态
    const status = $("#renumber-check-status");
    if (status) {
      status.innerHTML = `
        <div class="renumber-spinner" aria-hidden="true"></div>
        <div class="renumber-status-text">正在检查伏笔编号连续性…</div>`;
    }
    // 隐藏结果区
    const result = $("#renumber-check-result");
    if (result) result.hidden = true;
    // 隐藏底部按钮
    const footer = $("#renumber-check-footer");
    if (footer) footer.hidden = true;
  }

  function renderRenumberCheckResult(result) {
    const status = $("#renumber-check-status");
    const resultEl = $("#renumber-check-result");
    const footer = $("#renumber-check-footer");
    if (!status || !resultEl || !footer) return;
    if (result.continuous) {
      // 连续：清掉 spinner，显示成功文案
      status.innerHTML = `
        <div class="renumber-status-icon renumber-status-ok">✓</div>
        <div class="renumber-status-text">编号连续，无需重新编号</div>`;
      resultEl.hidden = true;
      footer.innerHTML = `<button class="primary-btn" data-renumber-action="close">关闭</button>`;
      footer.hidden = false;
      return;
    }
    // 不连续：显示不连续的「上下编号」列表
    status.innerHTML = `
      <div class="renumber-status-icon renumber-status-warn">!</div>
      <div class="renumber-status-text">检测到 <strong>${result.gaps.length}</strong> 处编号不连续</div>`;
    const listHtml = result.gaps
      .map(
        (g) =>
          `<li class="renumber-gap-row"><span class="renumber-gap-from">${escapeHtml(g.prev)}</span><span class="renumber-gap-arrow">→</span><span class="renumber-gap-to">${escapeHtml(g.next)}</span></li>`
      )
      .join("");
    resultEl.innerHTML = `<p class="muted hint renumber-gap-hint">以下位置的编号有跳跃：</p><ul class="renumber-gap-list">${listHtml}</ul>`;
    resultEl.hidden = false;
    footer.innerHTML = `
      <button class="secondary-btn" data-renumber-action="no">否</button>
      <button class="primary-btn" data-renumber-action="yes">是，重新编号</button>`;
    footer.hidden = false;
    // 把 sorted 暂存到 footer dataset 备用
    footer.dataset.renumberApply = "1";
  }

  // v25：连续性检查弹窗的按钮委托（data-renumber-action）
  function bindRenumberCheckEvents() {
    const footer = $("#renumber-check-footer");
    if (!footer) return;
    footer.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-renumber-action]");
      if (!btn) return;
      const action = btn.dataset.renumberAction;
      if (action === "close" || action === "no") {
        hideModal("modal-renumber-check");
        return;
      }
      if (action === "yes") {
        // 重新跑一次连续性检查拿到 sorted（保证按最新列表顺序），直接 apply
        const result = checkForeshadowingContinuity();
        if (!result.continuous) {
          const n = applyRenumber(result.sorted);
          hideModal("modal-renumber-check");
          toast(`已重新编号 ${n} 条伏笔`, "success", 1500);
        } else {
          // 极端情况：检查后又变连续了
          hideModal("modal-renumber-check");
          toast("编号已经连续，无需重新编号", "info", 1500);
        }
      }
    });
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
      // v25：伏笔两个 section 共享 #btn-import-fs-confirm 一个按钮，confirmId 在 HTML 上已隐藏
      // 实际按钮状态由 updateFsCombinedConfirmBtn() 统一控制
      confirmId: "btn-import-fs-confirm",
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
      // v25：同上，共享 #btn-import-fs-confirm
      confirmId: "btn-import-fs-confirm",
      allowTargetPage: false,
      isRecord: true,
    },
    // v21：灵石台账导入
    lingshi: {
      key: "lingshi",
      pid: "lingshi",
      table: "items",
      containerId: "import-section-lingshi",
      dropId: "import-lingshi-drop",
      fileInputId: "file-lingshi",
      textId: "import-lingshi-text",
      sheetWrapId: "import-lingshi-sheet-wrap",
      sheetSelectId: "import-lingshi-sheet-select",
      skipHeaderId: "import-lingshi-skip-header",
      statsId: "import-lingshi-stats",
      previewId: "import-lingshi-preview",
      fileInfoId: "import-lingshi-file-info",
      clearSel: '[data-clear-section="lingshi"]',
      confirmId: "btn-import-lingshi-confirm",
      allowTargetPage: false,
      isRecord: false,
    },
    // v21：物品台账导入
    items: {
      key: "items",
      pid: "items",
      table: "items",
      containerId: "import-section-items",
      dropId: "import-items-drop",
      fileInputId: "file-items",
      textId: "import-items-text",
      sheetWrapId: "import-items-sheet-wrap",
      sheetSelectId: "import-items-sheet-select",
      skipHeaderId: "import-items-skip-header",
      statsId: "import-items-stats",
      previewId: "import-items-preview",
      fileInfoId: "import-items-file-info",
      clearSel: '[data-clear-section="items"]',
      confirmId: "btn-import-items-confirm",
      allowTargetPage: false,
      isRecord: false,
    },
    // v43：故事脉络导入（章节号 / 章节梗概 / 剧情时间 / 地点 / 人物 / 物品）
    storyline: {
      key: "storyline",
      pid: "storyline",
      table: "items",
      containerId: "import-section-storyline",
      dropId: "import-storyline-drop",
      fileInputId: "file-storyline",
      textId: "import-storyline-text",
      sheetWrapId: "import-storyline-sheet-wrap",
      sheetSelectId: "import-storyline-sheet-select",
      skipHeaderId: "import-storyline-skip-header",
      statsId: "import-storyline-stats",
      previewId: "import-storyline-preview",
      fileInfoId: "import-storyline-file-info",
      clearSel: '[data-clear-section="storyline"]',
      confirmId: "btn-import-storyline-confirm",
      allowTargetPage: false,
      isRecord: false,
    },
    // v43：角色主表导入（编号 / 名称 / 势力 / 最后出现章节 / 信息）
    "character-main": {
      key: "character-main",
      pid: "character",
      table: "items",
      containerId: "import-section-character",
      dropId: "import-character-main-drop",
      fileInputId: "file-character-main",
      textId: "import-character-main-text",
      sheetWrapId: "import-character-main-sheet-wrap",
      sheetSelectId: "import-character-main-sheet-select",
      skipHeaderId: "import-character-main-skip-header",
      statsId: "import-character-main-stats",
      previewId: "import-character-main-preview",
      fileInfoId: "import-character-main-file-info",
      clearSel: '[data-clear-section="character-main"]',
      confirmId: "btn-import-character-main-confirm",
      allowTargetPage: false,
      isRecord: false,
    },
    // v43：角色履历表导入（编号 / 出现章节 / 原文描述 / 备注）
    "character-record": {
      key: "character-record",
      pid: "character",
      table: "records",
      containerId: "import-section-character",
      dropId: "import-character-record-drop",
      fileInputId: "file-character-record",
      textId: "import-character-record-text",
      sheetWrapId: "import-character-record-sheet-wrap",
      sheetSelectId: "import-character-record-sheet-select",
      skipHeaderId: "import-character-record-skip-header",
      statsId: "import-character-record-stats",
      previewId: "import-character-record-preview",
      fileInfoId: "import-character-record-file-info",
      clearSel: '[data-clear-section="character-record"]',
      // v43：character-record 独立按钮（character-main 各自独立，user 可单独导入主表/履历表）
      confirmId: "btn-import-character-record-confirm",
      allowTargetPage: false,
      isRecord: true,
    },
  };

  // 每个 section 的运行时状态
  // v25：每个 section 加 lastParsed（伏笔双 section 共享 #btn-import-fs-confirm 时存最近一次解析结果）
  const importState = {
    chapter: { allSheets: null, currentSheet: null, targetPage: null, allSheetsTarget: null, lastParsed: null },
    "fs-main": { allSheets: null, currentSheet: null, targetPage: "foreshadowing", allSheetsTarget: null, lastParsed: null },
    "fs-record": { allSheets: null, currentSheet: null, targetPage: "foreshadowing", allSheetsTarget: null, lastParsed: null },
    // v21：lingshi / items 各自独立的导入 state
    lingshi: { allSheets: null, currentSheet: null, targetPage: "lingshi", allSheetsTarget: null, lastParsed: null },
    items: { allSheets: null, currentSheet: null, targetPage: "items", allSheetsTarget: null, lastParsed: null },
    // v43：storyline / character-main / character-record
    storyline: { allSheets: null, currentSheet: null, targetPage: "storyline", allSheetsTarget: null, lastParsed: null },
    "character-main": { allSheets: null, currentSheet: null, targetPage: "character", allSheetsTarget: null, lastParsed: null },
    "character-record": { allSheets: null, currentSheet: null, targetPage: "character", allSheetsTarget: null, lastParsed: null },
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

  // v21：按 sections 列表打开导入弹窗
  //  - 给 #btn-import 用（按 state.currentPage 自动选）
  //  - 也给 goods tab 的"导入灵石"/"导入物品"按钮用（直接传 ["lingshi"] / ["items"]）
  function openImportModalWithSections(sectionIds) {
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
  }

  function bindImportEvents() {
    // v44：3 个 #btn-import 改成唯一 id（之前都叫 btn-import，$("#btn-import") 只匹配第一个
    //   导致 storyline/character 的导入按钮无 click handler——点开没反应）
    // 各自独立 handler，互不影响
    $("#btn-import-foreshadowing")?.addEventListener("click", () => {
      openImportModalWithSections(["fs-main", "fs-record"]);
    });
    $("#btn-import-storyline")?.addEventListener("click", () => {
      openImportModalWithSections(["storyline"]);
    });
    $("#btn-import-character")?.addEventListener("click", () => {
      openImportModalWithSections(["character-main", "character-record"]);
    });

    // 旧版 fallback：万一页面上还有 id="btn-import" 的残留（用户从旧版本加载/有扩展），仍能工作
    document.querySelectorAll("#btn-import").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pid = state.currentPage;
        let sectionIds;
        if (pid === "foreshadowing") sectionIds = ["fs-main", "fs-record"];
        else if (pid === "goods") sectionIds = ["lingshi", "items"];
        else sectionIds = ["chapter"];
        openImportModalWithSections(sectionIds);
      });
    });

    // v21：goods tab 的独立导入按钮（直接打开弹窗并锁定到对应 section）
    $("#btn-import-lingshi")?.addEventListener("click", () => {
      openImportModalWithSections(["lingshi"]);
    });
    $("#btn-import-items")?.addEventListener("click", () => {
      openImportModalWithSections(["items"]);
    });

    // 通用：每个 section 绑拖拽 / 选择 / 文本输入 / sheet 切换
    for (const key of Object.keys(IMPORT_SECTIONS)) {
      bindImportSectionEvents(key);
    }

    // 通用：每个 section 的确认按钮
    // v25：fs-main / fs-record 共享 #btn-import-fs-confirm，跳过循环绑定（避免双重 handler）
    //   由下面的"#btn-import-fs-confirm 单独绑" 处理
    for (const key of Object.keys(IMPORT_SECTIONS)) {
      const sec = IMPORT_SECTIONS[key];
      if (sec.confirmId === "btn-import-fs-confirm") continue;
      const btn = $("#" + sec.confirmId);
      if (!btn) continue;
      btn.addEventListener("click", () => commitImportSection(key));
    }

    // v25：伏笔双 section 共享的【导入】按钮——智能判断哪些 section 有数据，按 fs-main → fs-record 顺序导入
    $("#btn-import-fs-confirm")?.addEventListener("click", commitImportFsCombined);

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
      // v25：fs combined 场景下保存的"上一次解析结果"
      lastParsed: null,
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
      // v25：fs combined 共享按钮的 dataset 字段也要清
      if (sec.confirmId === "btn-import-fs-confirm") {
        btn.dataset.fsMain = "";
        btn.dataset.fsRecord = "";
      }
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
    // v25：fs-main / fs-record 共享 #btn-import-fs-confirm 一个按钮，状态由 updateFsCombinedConfirmBtn 合并控制
    const isFsCombined = sec.confirmId === "btn-import-fs-confirm";
    if (st.allSheets) {
      const sheetName = ($("#" + sec.sheetSelectId)?.value) || st.currentSheet || st.allSheets[0]?.name;
      const target = st.allSheets.find((s) => s.name === sheetName);
      if (!target) {
        renderImportPreviewSection(null, sec, "items");
        setSectionStats(sec, null);
        if (isFsCombined) updateFsCombinedConfirmBtn();
        else {
          const btn = $("#" + sec.confirmId);
          if (btn) {
            btn.disabled = true;
            btn.dataset.parsed = "";
            btn.dataset.sheet = "";
            btn.dataset.page = "";
          }
        }
        return;
      }
      // rows 来自 target.winner.parsed.rows
      const rows = target.winner?.parsed?.rows || [];
      renderImportPreviewSection(rows, sec, sec.isRecord ? "records" : "items");
      const okCount = rows.filter((r) => !r._error).length;
      if (isFsCombined) {
        // 暂存到 importState 上，combined confirm 按钮会读
        st.lastParsed = { rows, sheet: target.name, page: st.targetPage };
        if (isFsCombined) updateFsCombinedConfirmBtn();
      } else {
        const btn = $("#" + sec.confirmId);
        if (btn) {
          btn.disabled = !st.targetPage || okCount === 0;
          btn.dataset.parsed = JSON.stringify(rows);
          btn.dataset.sheet = target.name;
          btn.dataset.page = st.targetPage;
          btn.dataset.table = sec.table;
        }
      }
      st.currentSheet = target.name;
      setSectionStats(sec, rows, st.targetPage);
    } else {
      // 文本路径
      const text = $("#" + sec.textId)?.value;
      const rows = parseImportTextFor(text, sectionKey);
      renderImportPreviewSection(rows, sec, sec.isRecord ? "records" : "items");
      if (isFsCombined) {
        st.lastParsed = { rows, sheet: "", page: sec.pid };
        if (isFsCombined) updateFsCombinedConfirmBtn();
      } else {
        const btn = $("#" + sec.confirmId);
        if (btn) {
          const okCount = rows.filter((r) => !r._error).length;
          btn.disabled = okCount === 0;
          btn.dataset.parsed = JSON.stringify(rows);
          btn.dataset.sheet = "";
          btn.dataset.page = sec.pid;
          btn.dataset.table = sec.table;
        }
      }
      setSectionStats(sec, rows, sec.pid);
    }
  }

  // v25：合并刷新 fs-main + fs-record 共享的 #btn-import-fs-confirm 按钮  // v25：合并刷新 fs-main + fs-record 共享的 #btn-import-fs-confirm 按钮
  //  - 任一 section 有有效 rows → 按钮启用
  //  - dataset 记录各 section 的解析结果（点击时按 fs-main → fs-record 顺序 commit）
  function updateFsCombinedConfirmBtn() {
    const btn = $("#btn-import-fs-confirm");
    if (!btn) return;
    let anyValid = false;
    for (const key of ["fs-main", "fs-record"]) {
      const st = importState[key];
      const sec = IMPORT_SECTIONS[key];
      const lp = st.lastParsed;
      if (!lp) {
        btn.dataset[key === "fs-main" ? "fsMain" : "fsRecord"] = "";
        continue;
      }
      const okCount = lp.rows.filter((r) => !r._error).length;
      if (okCount > 0) {
        anyValid = true;
        btn.dataset[key === "fs-main" ? "fsMain" : "fsRecord"] = JSON.stringify({
          parsed: lp.rows,
          sheet: lp.sheet,
          page: lp.page,
          table: sec.table,
          okCount,
        });
      } else {
        btn.dataset[key === "fs-main" ? "fsMain" : "fsRecord"] = "";
      }
    }
    btn.disabled = !anyValid;
  }

  // v25：伏笔双 section 共享【导入】按钮的提交
  //  - 按 fs-main → fs-record 顺序逐个 commitImportSection（每个独立走自己的解析/落盘逻辑）
  //  - 没有有效数据的 section 自动跳过
  //  - 全部处理完关闭弹窗
  function commitImportFsCombined() {
    let importedAny = false;
    for (const key of ["fs-main", "fs-record"]) {
      const st = importState[key];
      const lp = st.lastParsed;
      if (!lp) continue;
      const okCount = lp.rows.filter((r) => !r._error).length;
      if (okCount === 0) continue;
      // commitImportSection 内部会读 st.targetPage / st.currentSheet / allSheets 等并自己解析
      //   这里直接调用它即可——refreshImportPreviewSection 已经把所有状态同步到 importState 上
      commitImportSection(key);
      importedAny = true;
    }
    if (importedAny) {
      hideModal("modal-import");
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
    // v25：fs-main / fs-record 共享 #btn-import-fs-confirm，数据从 importState.lastParsed 拿
    //   （不走 btn.dataset.*——dataset 在合并按钮上不区分 section）
    const isFsCombined = sec.confirmId === "btn-import-fs-confirm";
    let raw, sheetName, targetPid, table;
    if (isFsCombined) {
      const st = importState[sectionKey];
      const lp = st && st.lastParsed;
      if (!lp) return;
      raw = JSON.stringify(lp.rows);
      sheetName = lp.sheet || "";
      targetPid = lp.page || sec.pid;
      table = sec.table;
    } else {
      const btn = $("#" + sec.confirmId);
      if (!btn) return;
      raw = btn.dataset.parsed;
      sheetName = btn.dataset.sheet || "";
      targetPid = btn.dataset.page || "";
      table = btn.dataset.table || sec.table;
    }
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
      // 去重 key：items 用 sheet+no（章节/故事脉络都用）；records 通用化——sheet + setup + 第一列 recordFields key
      //   - fs-record：fsNo+setup 唯一
      //   - character-record：no+setup 唯一
      let existingIdx;
      if (isRecord) {
        const firstKey = Object.keys(fieldsDef)[0]; // 履历表第一列（fs-record=fsNo, character-record=no）
        existingIdx = target.findIndex(
          (x) => x.sheet === sheetName &&
                 String(x[firstKey] || "") === String(r[firstKey] || "") &&
                 String(x.setup || "") === String(r.setup || "")
        );
      } else {
        existingIdx = target.findIndex(
          (x) => Number(x.no) === Number(r.no) && x.sheet === sheetName
        );
      }
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
    } else if (sec.confirmId === "btn-import-fs-confirm") {
      // v25：fs combined 场景下不立即 reset——由 commitImportFsCombined 统一处理
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
    // 事件委托 - 所有 list 视图共用
    // v21：goods 拆为 lingshi + items，各自独立 list/editor，删除走 deleteItemFromPage
    // 列表项 class：.ch-item / .fs-item / .ls-item / .it-item / .ch2-item
    // 删除按钮：.ch-delete / .fs-delete / .ls-delete / .it-delete / .ch2-delete
    const chapterList = $("#chapter-list");
    // v25 修复：容器 id 是 #fs-grid（v23 从 .fs-list 改成 .fs-grid），不是 #fs-list
    //   之前绑错 id → onFsClick 永远不触发 → 整个伏笔展开/收起失效
    const fsList = $("#fs-grid");
    const lingshiList = $("#lingshi-list");
    const itemsList = $("#items-list");
    const characterList = $("#character-list");

    // 章节 / 伏笔 / 角色 的「统一切换」处理（依赖 state.currentPage）
    //   - 切前 saveCurrentItem 落盘
    //   - 设 curPage().currentItemId
    const onMainClick = (e) => {
      // 章节列表的"删除"叉号优先处理，阻止冒泡（避免触发选中）
      if (e.target.closest(".ch-delete")) {
        e.stopPropagation();
        const id = e.target.closest(".ch-delete").dataset.id;
        if (!id) return;
        curPage().currentItemId = id;
        deleteCurrentItem();
        return;
      }
      if (e.target.closest(".fs-delete")) {
        e.stopPropagation();
        const id = e.target.closest(".fs-delete").dataset.id;
        if (!id) return;
        curPage().currentItemId = id;
        deleteCurrentItem();
        return;
      }
      if (e.target.closest(".ch2-delete")) {
        e.stopPropagation();
        const id = e.target.closest(".ch2-delete").dataset.id;
        if (!id) return;
        curPage().currentItemId = id;
        deleteCurrentItem();
        return;
      }
      const item = e.target.closest(".ch-item, .fs-item, .ch2-item");
      if (!item) return;
      if (curPage().currentItemId === item.dataset.id) return;
      if (state.currentPage === "chapter" || state.currentPage === "character") {
        // v38：character 也走 flushCharacterDetail 写回 info + records
        //  - 章节页走 saveCurrentItem（独立 textarea，无 records）
        //  - 角色页走 flushCharacterDetail（editor 内有 info + records 履历区）
        if (state.currentPage === "character") {
          try { flushCharacterDetail(); } catch (_) {}
        } else {
          try { saveCurrentItem(); } catch (_) {}
        }
      } else if (state.currentPage === "foreshadowing") {
        // v32：常驻 panel 总是可编辑——切伏笔时直接 flushFsDetail 把当前 panel 的内容写回 state
        try { flushFsDetail(); } catch (_) {}
      }
      curPage().currentItemId = item.dataset.id;
      save();
      renderCurrentPage();
    };

    // 灵石 / 物品 的「子 page」处理（不走 curPage，currentPage 仍是 "goods"）
    //   - 直接设 state.pages[pid].currentItemId
    //   - 删除走 deleteItemFromPage
    //   - v24：再次点同一条时取消选中（currentItemId = null，抽屉收起）
    const onSubListClick = (pid, renderPair) => (e) => {
      if (e.target.closest(".ls-delete") || e.target.closest(".it-delete")) {
        e.stopPropagation();
        const btn = e.target.closest(".ls-delete") || e.target.closest(".it-delete");
        const id = btn.dataset.id;
        if (!id) return;
        deleteItemFromPage(pid, id);
        return;
      }
      const item = e.target.closest(".ls-item, .it-item");
      if (!item) return;
      const p = state.pages[pid];
      if (!p) return;
      // v24：点同一条 = 取消选中
      if (p.currentItemId === item.dataset.id) {
        p.currentItemId = null;
        save();
        renderPair();
        return;
      }
      p.currentItemId = item.dataset.id;
      save();
      renderPair();
    };

    // v32：fs 列表改用 onFsClick——点 .fs-item 切换 panel 显示（不是 currentItemId）
    //   - 删除走 .fs-delete 叉号（与之前一致）
    //   - 切到其他卡 → flush 当前 panel 内容到 state 后再切换
    //   - panel 常驻、无编辑态切换，删除按钮直接在 panel 头部
    const onFsClick = (e) => {
      // 1) 删除按钮（保留原 .fs-delete 行为）
      if (e.target.closest(".fs-delete")) {
        e.stopPropagation();
        const id = e.target.closest(".fs-delete").dataset.id;
        if (!id) return;
        // v23：用 id 定位并走 deleteCurrentItem（需要在 curPage 之前设 currentItemId）
        const fsPage = state.pages.foreshadowing;
        const targetItem = fsPage.items.find((x) => x.id === id);
        if (!targetItem) return;
        // v32：如果删的就是当前 panel 里的项，需要清 fsDetailId
        if (state.ui.fsDetailId === id) {
          state.ui.fsDetailId = null;
        }
        fsPage.currentItemId = id;
        deleteCurrentItem();
        return;
      }
      // 2) 点 .fs-item 卡片（非交互区）→ 设置 panel 显示该伏笔
      const itemEl = e.target.closest(".fs-item");
      if (!itemEl) return;
      // v26 沿用：排除 input/textarea/select/button/label 等交互元素
      //   v32：head 只有纯展示元素（编号/名称/状态/删除），不会命中下面这些
      if (e.target.closest("input, textarea, select, button, label, [contenteditable]")) {
        return;
      }
      const id = itemEl.dataset.id;
      if (!id) return;
      // v32.1：窄屏下点当前 active 卡 → 关闭 modal（v31 抽屉式样）
      //        宽屏下 setFsDetail(id) 无变化（panel 始终显示）
      if (isNarrowViewport() && state.ui.fsDetailId === id) {
        setFsDetail(null);
        return;
      }
      // v32：setFsDetail 无 fsEditing 拦截；总是 flush + 切换 + 重渲染 panel
      setFsDetail(id);
    };
    if (chapterList) chapterList.addEventListener("click", onMainClick);
    if (fsList) fsList.addEventListener("click", onFsClick);
    if (characterList) characterList.addEventListener("click", onMainClick);
    if (lingshiList) lingshiList.addEventListener("click", onSubListClick("lingshi", () => {
      renderLingshiList();
      renderLingshiEditor();
    }));
    if (itemsList) itemsList.addEventListener("click", onSubListClick("items", () => {
      renderItemsList();
      renderItemsEditor();
    }));
    // v32.1：恢复 mask 点击 / Esc 键关闭 modal（窄屏有效，宽屏 mask 不存在无影响）
    const fsPanelMask = $("#fs-panel-mask");
    if (fsPanelMask) {
      fsPanelMask.addEventListener("click", () => {
        if (isNarrowViewport()) setFsDetail(null);
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.currentPage === "foreshadowing" && state.ui.fsDetailId && isNarrowViewport()) {
        setFsDetail(null);
      }
    });
    // v32.1：resize 监听——宽屏→窄屏时关闭 modal（避免 panel 突然滑入）
    let _lastNarrow = isNarrowViewport();
    window.addEventListener("resize", () => {
      const nowNarrow = isNarrowViewport();
      if (_lastNarrow === nowNarrow) return;
      _lastNarrow = nowNarrow;
      // 宽屏 → 窄屏：关闭 modal（保留 fsDetailId 也行，但视觉上 panel 会突然滑出，比较突兀）
      if (nowNarrow && state.ui.fsDetailId) {
        setFsDetail(null);
      }
    });
  }

  function bindEditorButtons() {
    // 章节页：新增 / 导入 / 排序
    $("#btn-new")?.addEventListener("click", addNewItem);
    $("#btn-new-fs")?.addEventListener("click", addNewItem);
    // v21：goods 拆 lingshi + items，各自独立"新增"按钮，指定 pid
    $("#btn-new-lingshi")?.addEventListener("click", () => addNewItemInPage("lingshi"));
    $("#btn-new-items")?.addEventListener("click", () => addNewItemInPage("items"));
    // 角色详情用 addNewItemInPage
    $("#btn-new-ch2")?.addEventListener("click", () => addNewItemInPage("character"));
    // v43：故事脉络（storyline）list 类型，新增按钮走独立 id（不与 #btn-new 冲突）
    $("#btn-new-storyline")?.addEventListener("click", () => addNewItemInPage("storyline"));
    // 故事脉络 + 角色排序按钮
    $("#btn-storyline-sort")?.addEventListener("click", () => {
      state.ui.sort = state.ui.sort === "asc" ? "desc" : "asc";
      save();
      renderStorylineList();
    });
    $("#btn-character-sort")?.addEventListener("click", () => {
      state.ui.sort = state.ui.sort === "asc" ? "desc" : "asc";
      save();
      renderCharacterList();
    });
    // 编辑器按钮是动态生成的，用事件委托
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t) return;
      // v19：#btn-fs-save 已被移除（编辑态下点"完成编辑"自动 dirty 检查 + 落盘；切伏笔也自动 dirty + 退出编辑态）
      const isSave = t.id === "btn-save";
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
    // v21：伏笔页"重新编号"——按当前列表顺序重排 fsNo 为 1,2,3...
    $("#btn-fs-renumber")?.addEventListener("click", () => {
      renumberForeshadowing();
    });
    // v36：状态筛选改到 fs-page-body 左侧（纵向 tab）
    const segFsStatus = $("#fs-status-filter");
    if (segFsStatus) {
      segFsStatus.addEventListener("click", (e) => {
        const btn = e.target.closest(".fs-filter-btn[data-fs-status]");
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
    // v35：伏笔详情 panel 默认宽度（原 420 → +30 = 450）
    fsPanel: 450,
  };
  const LAYOUT_LIMITS = {
    nav: { min: 160, max: 380 },
    threeList: { min: 200, max: 560 },
    threeRight: { min: 240, max: 680 },
    twoList: { min: 200, max: 560 },
    // v35：伏笔 panel 宽度范围（避免过窄看不清 / 过宽挤占卡片）
    fsPanel: { min: 320, max: 700 },
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
    // v35：伏笔详情 panel 宽度变量
    "fs-panel": "--fs-panel-width",
  };
  const RESIZER_DEFAULT = {
    nav: LAYOUT_DEFAULTS.nav,
    "three-list": LAYOUT_DEFAULTS.threeList,
    "three-right": LAYOUT_DEFAULTS.threeRight,
    "two-list": LAYOUT_DEFAULTS.twoList,
    // v35
    "fs-panel": LAYOUT_DEFAULTS.fsPanel,
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
    // v35
    set("fs-panel", layout.fsPanel);
  }
  const RESIZER_DEFAULT_KEY = {
    nav: "nav",
    "three-list": "threeList",
    "three-right": "threeRight",
    "two-list": "twoList",
    // v35
    "fs-panel": "fsPanel",
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
    // 右侧栏（three-right / fs-panel）位于布局最右，鼠标拖右时栏应变窄，方向与鼠标相反
    // v35：fs-panel 也是右侧栏，dir = -1
    const dir = (key === "three-right" || key === "fs-panel") ? -1 : 1;

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
          : ["name", "fsNo", "status"];
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
            // 长字段（content）：每个命中位置都生成一条结果
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
    bindRenumberCheckEvents(); // v25：连续性检查弹窗
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
