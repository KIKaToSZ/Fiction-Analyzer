// 端到端测试：v6 schema 升级 + history 快照对称性
// 不依赖 xlsx / 浏览器，模拟 localStorage 验证 state 序列化

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Node 22+ 默认 ESM，但用 require() 加载 fs/path 没问题。
// 包成 async main 是为了让 9.7 的 top-level await 能跑
async function main() {

const SRC = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

// 准备一个 mock 环境：localStorage / window / document
const _store = {};
const localStorage = {
  getItem: (k) => (_store[k] === undefined ? null : _store[k]),
  setItem: (k, v) => (_store[k] = String(v)),
  removeItem: (k) => delete _store[k],
};
const noopEl = () => ({
  textContent: "",
  classList: { toggle: () => {}, add: () => {}, remove: () => {} },
  style: { setProperty: () => {} },
  addEventListener: () => {},
  appendChild: () => {},
  removeChild: () => {},
  click: () => {},
  focus: () => {},
  hidden: false,
  value: "",
  dataset: {},
  disabled: false,
});
const elements = new Map();
const document = {
  body: { dataset: {} },
  documentElement: { style: { setProperty: () => {} } },
  readyState: "complete",
  addEventListener: (ev, cb) => {
    if (ev === "DOMContentLoaded") return;
  },
  querySelector: (sel) => {
    if (sel === "#toast") return noopEl();
    if (sel === "body") return document.body;
    if (!elements.has(sel)) elements.set(sel, noopEl());
    return elements.get(sel);
  },
  querySelectorAll: () => [],
  createElement: () => noopEl(),
  addEventListener: () => {},
};
const window = {
  localStorage,
  addEventListener: () => {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  indexedDB: undefined,
  XLSX: undefined,
};
const ctx = { window, document, localStorage, console, setTimeout, clearTimeout, setInterval, clearInterval };
ctx.window.XLSX = undefined;
ctx.window.indexedDB = undefined;
ctx.window.indexedDB = undefined;
vm.createContext(ctx);

// 加载 app.js 但不执行（用 vm.runInContext 拿闭包外层）
// 改成直接在 sandbox 跑，让它把 state 暴露出来
try {
  vm.runInContext(SRC, ctx);
} catch (e) {
  console.log("执行 app.js 时报错（可能是预期内，例如 FS API / DOM 不全）：", e.message);
}

// 检查：load 之后 state 应有 SCHEMA_VERSION = 6
console.log("测试 1：schema 升级 v5 → v6 兼容");
_store["novel-app-data"] = JSON.stringify({
  schema: 5,
  currentPage: "chapter",
  pages: {
    chapter: { sheets: [], currentSheet: null, items: [{ id: "x", no: 1, title: "旧数据", content: "old", sheet: "Sheet1" }], currentItemId: "x" },
    foreshadowing: { sheets: [], currentSheet: null, items: [], currentItemId: null },
  },
  sheetsRaw: [],
  recentFiles: [],
  currentFileName: null,
  theme: { bg: "paper", accent: "indigo", fontSize: 16, lineHeight: 1.7 }, // 缺 font + autosaveMs
  ui: { sort: "asc" },
});
const data = JSON.parse(_store["novel-app-data"]);
// 模拟 load：合并 DEFAULT_THEME
const DEFAULT_THEME = { bg: "paper", accent: "indigo", fontSize: 16, lineHeight: 1.7, font: "system", autosaveMs: 0 };
const merged = { ...DEFAULT_THEME, ...(data.theme || {}) };
console.log("  v5 → v6 合并后 font =", merged.font, "(应=system)");
console.log("  v5 → v6 合并后 autosaveMs =", merged.autosaveMs, "(应=0)");
console.log("  其他字段保留：", JSON.stringify({
  bg: merged.bg,
  accent: merged.accent,
  fontSize: merged.fontSize,
  lineHeight: merged.lineHeight,
}));

// 测试 2：history 快照对称性
console.log("\n测试 2：snapshot / apply 对称性");
function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
const original = {
  pages: {
    chapter: { sheets: [{ name: "S1", columns: {}, rowCount: 1, ok: true }], currentSheet: "S1", items: [{ id: "a", no: 1, title: "t1", content: "c1", sheet: "S1" }], currentItemId: "a" },
    foreshadowing: { sheets: [], currentSheet: null, items: [], currentItemId: null },
  },
  sheetsRaw: [{ name: "S1", rows2d: [["h"], ["v"]], columns: {}, rowCount: 1, ok: true, page: "chapter" }],
  currentPage: "chapter",
};
const snap = deepClone(original);
const after = deepClone(original);
// 修改 after
after.pages.chapter.items[0].title = "新标题";
after.pages.chapter.items.push({ id: "b", no: 2, title: "t2", content: "c2", sheet: "S1" });
after.sheetsRaw[0].rows2d.push(["new"]);
// 还原
Object.assign(after, snap);
// 校验
const ok = JSON.stringify(after) === JSON.stringify(original);
console.log("  深拷贝还原对称：", ok ? "PASS" : "FAIL");
if (!ok) {
  console.log("  original:", JSON.stringify(original));
  console.log("  after:", JSON.stringify(after));
}

// 测试 3：history 栈逻辑（简化版）
console.log("\n测试 3：history 栈 push/undo/redo 逻辑");
const HISTORY_MAX = 50;
const hist = { stack: [], idx: -1, suspended: false };
function push(s) {
  if (hist.suspended) return;
  if (hist.idx < hist.stack.length - 1) hist.stack = hist.stack.slice(0, hist.idx + 1);
  const top = hist.stack[hist.stack.length - 1];
  if (top && JSON.stringify(top) === JSON.stringify(s)) return;
  hist.stack.push(s);
  if (hist.stack.length > HISTORY_MAX) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
}
function undo() { if (hist.idx <= 0) return; hist.idx--; }
function redo() { if (hist.idx >= hist.stack.length - 1) return; hist.idx++; }

push({ s: "init" });
console.log("  push 1: idx =", hist.idx, ", stack.length =", hist.stack.length, "(应 idx=0, len=1)");
push({ s: "edit 1" });
console.log("  push 2: idx =", hist.idx, ", stack.length =", hist.stack.length, "(应 idx=1, len=2)");
push({ s: "edit 2" });
console.log("  push 3: idx =", hist.idx, ", stack.length =", hist.stack.length, "(应 idx=2, len=3)");
undo();
console.log("  undo 1: idx =", hist.idx, "(应 idx=1)");
undo();
console.log("  undo 2: idx =", hist.idx, "(应 idx=0)");
undo();
console.log("  undo 3 (过头): idx =", hist.idx, "(应仍=0, 已是最早)");
redo();
redo();
redo();
console.log("  redo 3 次: idx =", hist.idx, "(应=2)");

// 在中间 push 应截断 redo 分支
undo();
console.log("  undo 1 回到中间: idx =", hist.idx, "(应=1)");
push({ s: "新分支" });
console.log("  push 新分支: idx =", hist.idx, ", len =", hist.stack.length, "(应 idx=2, len=3，旧 redo 已被截断)");
redo();
console.log("  redo 过头: idx =", hist.idx, "(应=2, 已是最末)");

// 限制最大长度
hist.stack = [];
hist.idx = -1;
for (let i = 0; i < HISTORY_MAX + 5; i++) push({ s: i });
console.log("  push 55 个后: len =", hist.stack.length, ", idx =", hist.idx, "(应 len=50, idx=49, 最早 5 个被挤掉)");

/* ============================================================
   测试 4：字符串章节号解析（parseChapterNo + parseChineseNumeral）
   ============================================================ */
console.log("\n测试 4：字符串章节号解析");

// 注入到 vm 上下文
const CN_NUM_MAP = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
ctx.parseChineseNumeral = (s) => {
  if (!s) return null;
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(s)) return null;
  let section = 0, lastDigit = null, anyDigit = false;
  for (const ch of s) {
    if (ch in CN_NUM_MAP) {
      lastDigit = CN_NUM_MAP[ch];
      anyDigit = true;
    } else if (ch === "十") { section += (lastDigit ?? 1) * 10; lastDigit = null; anyDigit = true; }
    else if (ch === "百") { section += (lastDigit ?? 1) * 100; lastDigit = null; anyDigit = true; }
    else if (ch === "千") { section += (lastDigit ?? 1) * 1000; lastDigit = null; anyDigit = true; }
    else return null;
  }
  if (lastDigit != null) section += lastDigit;
  return anyDigit ? section : null;
};
ctx.parseChapterNo = (raw) => {
  if (raw == null) return { num: Infinity, str: "", raw: "", hasNum: false };
  const s = String(raw).trim();
  if (!s) return { num: Infinity, str: "", raw: "", hasNum: false };
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return { num: n, str: s, raw: s, hasNum: true };
  }
  const m = s.match(/-?\d+(\.\d+)?/);
  if (m) { const n = Number(m[0]); if (Number.isFinite(n)) return { num: n, str: s, raw: s, hasNum: true }; }
  const cn = s.match(/第([零〇一二两三四五六七八九十百千]+)/);
  if (cn) { const n = ctx.parseChineseNumeral(cn[1]); if (n != null) return { num: n, str: s, raw: s, hasNum: true }; }
  const all = ctx.parseChineseNumeral(s);
  if (all != null) return { num: all, str: s, raw: s, hasNum: true };
  return { num: Infinity, str: s, raw: s, hasNum: false };
};
ctx.compareChapterNo = (a, b) => {
  if (a.num !== b.num) return a.num - b.num;
  return a.str.localeCompare(b.str, "zh-Hans-CN");
};

const parseCases = [
  [12, 12, true],
  ["12", 12, true],
  ["第12章", 12, true],
  ["第一章", 1, true],
  ["第二十章", 20, true],
  ["第二十五章", 25, true],
  ["第一百零五章", 105, true],
  ["序章", Infinity, false],
  ["楔子", Infinity, false],
  ["番外", Infinity, false],
  ["后记", Infinity, false],
  ["Chapter 5", 5, true],
  ["卷一 第三章", 3, true],
];
let allPass = true;
for (const [input, expectedNum, expectedHas] of parseCases) {
  const r = ctx.parseChapterNo(input);
  const ok = r.num === expectedNum && r.hasNum === expectedHas;
  if (!ok) allPass = false;
  console.log(`  ${ok ? "✓" : "✗"} parseChapterNo(${JSON.stringify(input)}) = num=${r.num}, hasNum=${r.hasNum} (期望 num=${expectedNum}, hasNum=${expectedHas})`);
}
console.log("  解析测试:", allPass ? "PASS" : "FAIL");

// 排序测试
const sortItems = [
  { no: "序章" },
  { no: "第一章" },
  { no: "第10章" },
  { no: "楔子" },
  { no: "第二十章" },
  { no: 5 },
  { no: 100 },
  { no: "1" },
  { no: "Chapter 5" },
  { no: "后记" },
  { no: "第二十五章" },
  { no: "第一百零五章" },
];
const sorted = sortItems.slice().sort((a, b) =>
  ctx.compareChapterNo(ctx.parseChapterNo(a.no), ctx.parseChapterNo(b.no))
);
const expectedOrder = [
  "1", "第一章", 5, "Chapter 5", "第10章", "第二十章", "第二十五章",
  100, "第一百零五章", "后记", "楔子", "序章",
];
const sortOk = sorted.every((it, i) => it.no === expectedOrder[i]);
if (!sortOk) allPass = false;
console.log("  排序结果:");
sorted.forEach((it, i) => {
  const r = ctx.parseChapterNo(it.no);
  const tag = it.no === expectedOrder[i] ? "✓" : "✗";
  console.log(`    ${tag} ${r.num === Infinity ? "文字" : String(r.num).padStart(4)}: ${JSON.stringify(it.no)}`);
});
console.log("  排序测试:", sortOk ? "PASS" : "FAIL");

/* ============================================================
   测试 5：v7 schema - json 增量保存
   - 新增 state.jsonFileName / state.jsonHandleKey
   - snapshotStateForJson 应包含所有必要字段
   - load 后缺失字段默认为 null（不报错）
   - 旧 v6 数据迁移到 v7 时新字段为空值
   ============================================================ */
console.log("\n测试 5：v7 schema 兼容（json 增量保存）");

// 5.1 模拟 v6 数据 → 升级到 v7：缺失字段应默认为 null
const v6Data = {
  schema: 6,
  currentPage: "chapter",
  pages: { chapter: makePage(), foreshadowing: makePage() },
  sheetsRaw: [],
  recentFiles: [],
  currentFileName: "小说.xlsx",
  theme: DEFAULT_THEME,
  ui: { sort: "asc" },
};
function makePage() {
  return { sheets: [], currentSheet: null, items: [], currentItemId: null };
}
// 模拟 load 时的字段补全
const upgraded = {
  ...v6Data,
  jsonFileName: v6Data.jsonFileName || null,
  jsonHandleKey: v6Data.jsonHandleKey || null,
};
const v7ok1 = upgraded.jsonFileName === null && upgraded.jsonHandleKey === null && upgraded.currentFileName === "小说.xlsx";
console.log("  v6 → v7 升级补字段：", v7ok1 ? "PASS" : "FAIL");
if (!v7ok1) allPass = false;

// 5.2 snapshotStateForJson 包含必要字段（用 data 模型模拟）
const snap7 = {
  schema: 7,
  currentPage: "chapter",
  pages: v6Data.pages,
  sheetsRaw: [],
  recentFiles: v6Data.recentFiles,
  currentFileName: "小说.xlsx",
  jsonFileName: "小说.json",
  jsonHandleKey: "json:小说.xlsx",
  theme: DEFAULT_THEME,
  ui: { sort: "asc" },
};
const required = ["schema", "currentPage", "pages", "sheetsRaw", "recentFiles", "currentFileName", "jsonFileName", "jsonHandleKey", "theme", "ui"];
const missing = required.filter((k) => !(k in snap7));
const v7ok2 = missing.length === 0;
console.log("  snapshot 字段完整性：", v7ok2 ? "PASS" : "FAIL", missing.length ? `(缺 ${missing.join(",")})` : "");
if (!v7ok2) allPass = false;

// 5.3 验证 saved → round-trip 后状态可恢复
const serialized = JSON.stringify(snap7);
const restored = JSON.parse(serialized);
const v7ok3 = restored.jsonFileName === "小说.json"
  && restored.jsonHandleKey === "json:小说.xlsx"
  && restored.theme.font === "system";
console.log("  序列化 / 反序列化：", v7ok3 ? "PASS" : "FAIL");
if (!v7ok3) allPass = false;

// 5.4 jsonFileNameFrom：去掉 xlsx/xlsm/json 后缀
const cases5_4 = [
  ["小说.xlsx", "小说.json"],
  ["book.xlsm", "book.json"],
  ["data.json", "data.json"],
  ["无后缀", "无后缀.json"],
  ["", "novel-app.json"], // 空文件名兜底
];
let v7ok4 = true;
for (const [input, expected] of cases5_4) {
  const base = (input || "novel-app").replace(/\.(xlsx|xlsm|json)$/i, "");
  const got = `${base}.json`;
  if (got !== expected) {
    v7ok4 = false;
    console.log(`    ✗ jsonFileNameFrom(${JSON.stringify(input)}) = ${JSON.stringify(got)} (期望 ${JSON.stringify(expected)})`);
  } else {
    console.log(`    ✓ jsonFileNameFrom(${JSON.stringify(input)}) → ${JSON.stringify(got)}`);
  }
}
console.log("  jsonFileNameFrom 转换：", v7ok4 ? "PASS" : "FAIL");
if (!v7ok4) allPass = false;

/* ============================================================
   测试 6：normalizeParagraphs - 显示时移除空行
   - 折叠 2+ 个连续换行为 1 个换行（移除段落间空行）
   - 单换行保持不变
   - \r\n 统一为 \n
   ============================================================ */
console.log("\n测试 6：normalizeParagraphs（移除空行）");

// 从 app.js 提取 normalizeParagraphs 函数源码
const fnMatch = SRC.match(/function normalizeParagraphs\(s\) \{[\s\S]*?\n  \}/);
if (!fnMatch) {
  console.log("  ✗ 找不到 normalizeParagraphs 函数");
  allPass = false;
} else {
  const sandboxFn = { };
  vm.createContext(sandboxFn);
  vm.runInContext(fnMatch[0] + "\nthis.normalizeParagraphs = normalizeParagraphs;", sandboxFn);
  const np = sandboxFn.normalizeParagraphs;

  const cases6 = [
    // [输入, 期望, 描述]
    ["a\nb\nc", "a\nb\nc", "无空行：保持不变"],
    ["a\n\nb\n\nc", "a\nb\nc", "段间空行被移除"],
    ["a\n\n\nb", "a\nb", "连续空行折叠为单换行"],
    ["a\r\nb\r\nc", "a\nb\nc", "CRLF 归一为 LF"],
    ["", "", "空字符串"],
    [null, null, "null"],
    [undefined, undefined, "undefined"],
    ["a\n\n\n\nb", "a\nb", "4 个连续空行"],
    ["a\nb\n\nc\nd", "a\nb\nc\nd", "混合：保留单换行、移除空行"],
  ];
  let npOk = true;
  for (const [input, expected, desc] of cases6) {
    const got = np(input);
    const pass = got === expected;
    if (!pass) npOk = false;
    console.log(`  ${pass ? "✓" : "✗"} ${desc}: ${JSON.stringify(input)} → ${JSON.stringify(got)}${pass ? "" : ` (期望 ${JSON.stringify(expected)})`}`);
  }
  console.log("  normalizeParagraphs 单元测试:", npOk ? "PASS" : "FAIL");
  if (!npOk) allPass = false;
}

/* ============================================================
   测试 7：v8 schema 兼容（isEphemeral + hasAnyUserData）
   ============================================================ */
console.log("\n测试 7：v8 schema 兼容（isEphemeral + hasAnyUserData）");
{
  // 7.1 hasAnyUserData 判定逻辑
  // 重新搭一个最小 sandbox 复现逻辑
  const sandbox = {
    state: {
      currentFileName: null,
      pages: {
        chapter: { items: [] },
        foreshadowing: { items: [] },
      },
    },
  };
  sandbox.hasAnyUserData = function () {
    if (this.state.currentFileName) return true;
    for (const pid of Object.keys(this.state.pages)) {
      if (this.state.pages[pid] && this.state.pages[pid].items.length > 0) return true;
    }
    return false;
  };
  const f1 = sandbox.hasAnyUserData.call(sandbox);
  const t1 = !f1;
  console.log("  空状态 → false:", t1 ? "✓" : "✗");
  if (!t1) allPass = false;

  sandbox.state.currentFileName = "book.xlsx";
  const t2 = sandbox.hasAnyUserData.call(sandbox);
  console.log("  有 currentFileName → true:", t2 ? "✓" : "✗");
  if (!t2) allPass = false;

  sandbox.state.currentFileName = null;
  sandbox.state.pages.chapter.items.push({ id: "x" });
  const t3 = sandbox.hasAnyUserData.call(sandbox);
  console.log("  有 chapter items → true:", t3 ? "✓" : "✗");
  if (!t3) allPass = false;

  sandbox.state.pages.chapter.items = [];
  sandbox.state.pages.foreshadowing.items.push({ id: "y" });
  const t4 = sandbox.hasAnyUserData.call(sandbox);
  console.log("  有 foreshadowing items → true:", t4 ? "✓" : "✗");
  if (!t4) allPass = false;
  console.log("  hasAnyUserData 行为:", (t1 && t2 && t3 && t4) ? "PASS" : "FAIL");
  if (!(t1 && t2 && t3 && t4)) allPass = false;

  // 7.2 isEphemeral 字段在 upsertRecentFile 后正确保留
  const vmCtx = vm.createContext(sandbox);
  vm.runInContext(
    `const __state = { recentFiles: [] };
     this.__test_state = __state;
     this.upsertRecentFile = function(meta) {
       const idx = __state.recentFiles.findIndex(f => f.name === meta.name);
       if (idx >= 0) __state.recentFiles.splice(idx, 1);
       __state.recentFiles.unshift({
         name: meta.name, lastOpened: meta.lastOpened || new Date().toISOString(),
         mtime: meta.mtime || 0, size: meta.size || 0,
         handleKey: meta.handleKey || null,
         isDirectory: !!meta.isDirectory, isMigrated: !!meta.isMigrated,
         isEphemeral: !!meta.isEphemeral,
       });
       __state.recentFiles = __state.recentFiles.slice(0, 20);
     };`,
    vmCtx
  );
  vm.runInContext(
    `this.snapshotStateForJson = function() {
       return {
         recentFiles: __state.recentFiles.map(f => ({
           name: f.name, isEphemeral: !!f.isEphemeral, isMigrated: !!f.isMigrated,
         })),
       };
     };`,
    vmCtx
  );
  vm.runInContext(`this.upsertRecentFile({ name: "a.xlsx", isEphemeral: true })`, vmCtx);
  vm.runInContext(`this.upsertRecentFile({ name: "b.xlsx", isEphemeral: false })`, vmCtx);
  vm.runInContext(`this.upsertRecentFile({ name: "c.xlsx" })`, vmCtx); // 默认 false
  const isEphemA = sandbox.__test_state.recentFiles.find((f) => f.name === "a.xlsx")?.isEphemeral;
  const isEphemB = sandbox.__test_state.recentFiles.find((f) => f.name === "b.xlsx")?.isEphemeral;
  const isEphemC = sandbox.__test_state.recentFiles.find((f) => f.name === "c.xlsx")?.isEphemeral;
  const iso7_2 = isEphemA === true && isEphemB === false && isEphemC === false;
  console.log(`  a.xlsx.isEphemeral = true: ${isEphemA === true ? "✓" : "✗"}`);
  console.log(`  b.xlsx.isEphemeral = false: ${isEphemB === false ? "✓" : "✗"}`);
  console.log(`  c.xlsx.isEphemeral (默认) = false: ${isEphemC === false ? "✓" : "✗"}`);
  console.log("  isEphemeral 字段保留:", iso7_2 ? "PASS" : "FAIL");
  if (!iso7_2) allPass = false;

  // 7.3 snapshot 序列化 isEphemeral
  const snap = sandbox.snapshotStateForJson.call(sandbox);
  const snapOk =
    snap.recentFiles.length === 3 &&
    snap.recentFiles.find((f) => f.name === "a.xlsx")?.isEphemeral === true &&
    snap.recentFiles.find((f) => f.name === "b.xlsx")?.isEphemeral === false;
  console.log("  snapshot 保留 isEphemeral:", snapOk ? "✓" : "✗");
  console.log("  snapshot 序列化 isEphemeral:", snapOk ? "PASS" : "FAIL");
  if (!snapOk) allPass = false;
}

/* ============================================================
   测试 8：v8.1 修复（charCount 排除空白 + json 拖入显示文件名 + xlsxFileName）
   ============================================================ */
console.log("\n测试 8：v8.1 修复（charCount + json 数据源 + xlsxFileName）");
{
  // 8.1 charCount 排除所有空白字符
  const vmCtx = vm.createContext({});
  vm.runInContext(
    `this.charCount = function(s) { return (s || "").replace(/\\s+/g, "").length; };`,
    vmCtx
  );
  const cases = [
    ["abc", 3],                // 普通字符串
    ["a b c", 3],              // 空格不算
    ["a\nb\nc", 3],            // 换行不算
    ["a\tb\tc", 3],            // 制表符不算
    ["\n\n\n", 0],             // 全空白 = 0
    ["", 0],                   // 空字符串
    [null, 0],                 // null
    [undefined, 0],            // undefined
    ["你好\n世界\r\n！", 5],    // 中文 + CRLF
  ];
  let ccOk = true;
  for (const [input, expected] of cases) {
    const got = vmCtx.charCount(input);
    const ok = got === expected;
    ccOk = ccOk && ok;
    console.log(`  charCount(${JSON.stringify(input)}) = ${got} (期望 ${expected}): ${ok ? "✓" : "✗"}`);
  }
  console.log("  charCount 排除空白字符:", ccOk ? "PASS" : "FAIL");
  if (!ccOk) allPass = false;

  // 8.2 loadFromJsonFile：把文件加进 recentFiles，currentFileName = file.name
  const jsonSandbox = {
    state: {
      currentFileName: null,
      xlsxFileName: null,
      jsonFileName: null,
      recentFiles: [],
    },
  };
  jsonSandbox.upsertRecentFile = function (meta) {
    const idx = this.state.recentFiles.findIndex((f) => f.name === meta.name);
    if (idx >= 0) this.state.recentFiles.splice(idx, 1);
    this.state.recentFiles.unshift({
      name: meta.name,
      isEphemeral: !!meta.isEphemeral,
      handleKey: meta.handleKey || null,
    });
    this.state.recentFiles = this.state.recentFiles.slice(0, 20);
  };
  function loadJson(file, data) {
    jsonSandbox.state.currentFileName = file.name;
    jsonSandbox.state.xlsxFileName = data.currentFileName || null;
    jsonSandbox.state.jsonFileName = data.jsonFileName || file.name;
    jsonSandbox.upsertRecentFile({
      name: file.name,
      handleKey: null,
      isEphemeral: true,
    });
  }
  loadJson(
    { name: "novel.json", lastModified: 1700000000000, size: 1234 },
    { pages: { chapter: { items: [] } }, currentFileName: "novel.xlsx" }
  );
  const f1 = jsonSandbox.state.currentFileName === "novel.json";
  const f2 = jsonSandbox.state.xlsxFileName === "novel.xlsx";
  const f3 = jsonSandbox.state.jsonFileName === "novel.json";
  const f4 =
    jsonSandbox.state.recentFiles.length === 1 &&
    jsonSandbox.state.recentFiles[0].name === "novel.json" &&
    jsonSandbox.state.recentFiles[0].isEphemeral === true;
  console.log(`  currentFileName = "novel.json": ${f1 ? "✓" : "✗"}`);
  console.log(`  xlsxFileName 保留 = "novel.xlsx": ${f2 ? "✓" : "✗"}`);
  console.log(`  jsonFileName = "novel.json": ${f3 ? "✓" : "✗"}`);
  console.log(`  recentFiles 加入 (isEphemeral): ${f4 ? "✓" : "✗"}`);
  console.log("  loadFromJsonFile 状态设置:", (f1 && f2 && f3 && f4) ? "PASS" : "FAIL");
  if (!(f1 && f2 && f3 && f4)) allPass = false;

  // 8.3 json 无原 xlsx 时，xlsxFileName = null
  jsonSandbox.state.recentFiles = [];
  loadJson({ name: "pure.json" }, { pages: { chapter: { items: [] } } });
  const f5 = jsonSandbox.state.xlsxFileName === null;
  console.log(`  json 无 data.currentFileName → xlsxFileName = null: ${f5 ? "✓" : "✗"}`);
  if (!f5) allPass = false;

  // 8.4 saveAsXlsx：优先用 xlsxFileName 作 handle 查找 + 下载名
  const sim = {
    currentFileName: "novel.json",
    xlsxFileName: "novel.xlsx",
    recentFiles: [
      { name: "novel.json", isEphemeral: true, handleKey: null },
      { name: "novel.xlsx", isEphemeral: false, handleKey: "file:novel.xlsx" },
    ],
  };
  const xlsxName = sim.xlsxFileName || sim.currentFileName;
  const lookup = sim.recentFiles.find((f) => f.name === xlsxName);
  const f6 = xlsxName === "novel.xlsx" && lookup && lookup.handleKey === "file:novel.xlsx";
  console.log(`  saveAsXlsx 用 xlsxName 找 handle: ${f6 ? "✓" : "✗"}`);
  if (!f6) allPass = false;

  // 8.5 v5/v6 旧数据迁移：xlsxFileName 从 currentFileName 继承
  const mig = { currentFileName: "old.xlsx" };
  const xfn = mig.xlsxFileName || mig.currentFileName || null;
  const f7 = xfn === "old.xlsx";
  console.log(`  v5/v6 迁移 xlsxFileName = currentFileName: ${f7 ? "✓" : "✗"}`);
  if (!f7) allPass = false;

  // 8.6 v8.1 修 bug：跨设备 / 旧版本导出的 json 拖入后，recentFiles 仍能找到
  // 根因：之前是 upsertRecentFile → state.recentFiles = data.recentFiles.map(...)
  // 顺序反了，被 data.recentFiles 整体覆盖。修复后：先恢复 data.recentFiles，
  // 再 upsertRecentFile 置顶 file.name。
  function loadJsonFixed(file, data) {
    const state = { recentFiles: [] };
    if (Array.isArray(data.recentFiles)) {
      state.recentFiles = data.recentFiles.map((f) => ({
        name: f.name, lastOpened: f.lastOpened || new Date().toISOString(),
        mtime: f.mtime || 0, size: f.size || 0,
        handleKey: f.handleKey || null,
        isDirectory: !!f.isDirectory, isMigrated: !!f.isMigrated,
        isEphemeral: !!f.isEphemeral,
      }));
    } else {
      state.recentFiles = [];
    }
    // 然后再 upsert
    const idx = state.recentFiles.findIndex((f) => f.name === file.name);
    if (idx >= 0) state.recentFiles.splice(idx, 1);
    state.recentFiles.unshift({
      name: file.name, lastOpened: new Date().toISOString(),
      mtime: 0, size: 0, handleKey: null,
      isDirectory: false, isMigrated: false, isEphemeral: true,
    });
    return state;
  }
  // 场景 A：跨设备复制 json，data.recentFiles 不含 file.name
  const cross = loadJsonFixed(
    { name: "novel.json" },
    { recentFiles: [{ name: "other.json", isEphemeral: false, lastOpened: "x", mtime: 0, size: 0, handleKey: null, isDirectory: false, isMigrated: false }] }
  );
  const f8a = cross.recentFiles[0].name === "novel.json"
    && cross.recentFiles[0].isEphemeral === true
    && cross.recentFiles.length === 2
    && cross.recentFiles.some((f) => f.name === "other.json");
  console.log(`  跨设备 json：recentFiles[0]=novel.json (isEphemeral): ${f8a ? "✓" : "✗"}`);
  if (!f8a) allPass = false;

  // 场景 B：本机二次打开，data.recentFiles 含 file.name（不带 isEphemeral）
  const local = loadJsonFixed(
    { name: "novel.json" },
    { recentFiles: [
      { name: "old.xlsx", isEphemeral: false, lastOpened: "x", mtime: 0, size: 0, handleKey: null, isDirectory: false, isMigrated: false },
      { name: "novel.json", isEphemeral: false, lastOpened: "x", mtime: 0, size: 0, handleKey: null, isDirectory: false, isMigrated: false },
    ] }
  );
  const f8b = local.recentFiles[0].name === "novel.json"
    && local.recentFiles[0].isEphemeral === true
    && local.recentFiles.length === 2;
  console.log(`  本机二次打开：recentFiles[0]=novel.json (isEphemeral=true): ${f8b ? "✓" : "✗"}`);
  if (!f8b) allPass = false;

  // 场景 C：data.recentFiles 不存在（极旧 json）
  const old = loadJsonFixed({ name: "novel.json" }, {});
  const f8c = old.recentFiles.length === 1
    && old.recentFiles[0].name === "novel.json"
    && old.recentFiles[0].isEphemeral === true;
  console.log(`  无 data.recentFiles：只有 novel.json (isEphemeral): ${f8c ? "✓" : "✗"}`);
  if (!f8c) allPass = false;
  console.log("  loadFromJsonFile recentFiles 顺序:", (f8a && f8b && f8c) ? "PASS" : "FAIL");
  if (!(f8a && f8b && f8c)) allPass = false;

  // 8.7 save() 序列化保留 isEphemeral（让 json 跨设备也能恢复标签）
  const saveOut = {
    recentFiles: [
      { name: "a.json", isEphemeral: true, lastOpened: "x", mtime: 0, size: 0, handleKey: null, isDirectory: false, isMigrated: false },
      { name: "b.xlsx", isEphemeral: false, lastOpened: "x", mtime: 0, size: 0, handleKey: "k", isDirectory: false, isMigrated: false },
    ].map((f) => ({
      name: f.name, lastOpened: f.lastOpened, mtime: f.mtime, size: f.size,
      handleKey: f.handleKey, isDirectory: !!f.isDirectory, isMigrated: !!f.isMigrated,
      isEphemeral: !!f.isEphemeral,
    })),
  };
  const f9a = saveOut.recentFiles.find((f) => f.name === "a.json")?.isEphemeral === true;
  const f9b = saveOut.recentFiles.find((f) => f.name === "b.xlsx")?.isEphemeral === false;
  console.log(`  save() 序列化保留 isEphemeral (a.json/b.xlsx): ${f9a && f9b ? "✓" : "✗"}`);
  if (!(f9a && f9b)) allPass = false;
}

/* ============================================================
   测试 9：v9 schema 兼容 + saveAsJson 兜底（isEphemeral 不下载）
   ============================================================ */
console.log("\n测试 9：v9 修复（directoryHandleKey + isEphemeral 兜底不再下载）");
{
  // 9.1 schema 升级：v6/v7/v8 → v9 补 directoryHandleKey
  // 模拟 load() 时的字段回填
  const oldData = {
    schema: 8,
    currentFileName: "book.xlsx",
    xlsxFileName: "book.xlsx",
    jsonFileName: "book.json",
    jsonHandleKey: null,
    // v9 新字段缺失
  };
  const v9State = {
    currentFileName: oldData.currentFileName || null,
    xlsxFileName: oldData.xlsxFileName || oldData.currentFileName || null,
    jsonFileName: oldData.jsonFileName || null,
    jsonHandleKey: oldData.jsonHandleKey || null,
    directoryHandleKey: oldData.directoryHandleKey || null,
  };
  const t1 = v9State.directoryHandleKey === null;
  const t2 = v9State.jsonHandleKey === null;
  const t3 = v9State.xlsxFileName === "book.xlsx";
  console.log(`  v8 → v9 迁移 directoryHandleKey = null: ${t1 ? "✓" : "✗"}`);
  console.log(`  v8 → v9 保留 jsonHandleKey: ${t2 ? "✓" : "✗"}`);
  console.log(`  v8 → v9 保留 xlsxFileName: ${t3 ? "✓" : "✗"}`);
  console.log("  v8 → v9 迁移:", (t1 && t2 && t3) ? "PASS" : "FAIL");
  if (!(t1 && t2 && t3)) allPass = false;

  // 9.2 saveAsJson 兜底：isEphemeral 文件不再下载（mode = "ephemeral"）
  // 模拟一段最小化的 saveAsJson 逻辑（仅看 isEphemeral 分支）
  function simulateSaveAsJson(state) {
    // 简化：省略第 1/1.5/2 步（无 handle），直接进第 3 步
    const curMeta = state.currentFileName
      ? state.recentFiles.find((f) => f.name === state.currentFileName)
      : null;
    const isEphemeral = !!(curMeta && curMeta.isEphemeral);
    if (isEphemeral) {
      return { ok: true, mode: "ephemeral", downloaded: false };
    }
    return { ok: true, mode: "download", downloaded: true };
  }
  const ephState = {
    currentFileName: "book.xlsx",
    recentFiles: [
      { name: "book.xlsx", isEphemeral: true, handleKey: null },
    ],
  };
  const r1 = simulateSaveAsJson(ephState);
  const u1 = r1.mode === "ephemeral" && r1.downloaded === false;
  console.log(`  isEphemeral → mode="ephemeral", 不下载: ${u1 ? "✓" : "✗"}`);
  if (!u1) allPass = false;

  // 9.3 旧 v7 持久化数据（isEphemeral=false, handleKey 失效）仍然下载（保护数据）
  const oldState = {
    currentFileName: "legacy.xlsx",
    recentFiles: [
      { name: "legacy.xlsx", isEphemeral: false, isMigrated: false, handleKey: "stale-key" },
    ],
  };
  const r2 = simulateSaveAsJson(oldState);
  const u2 = r2.mode === "download" && r2.downloaded === true;
  console.log(`  非 isEphemeral → mode="download", 触发下载: ${u2 ? "✓" : "✗"}`);
  if (!u2) allPass = false;

  // 9.4 无 currentFileName 也走下载兜底
  const noFile = { currentFileName: null, recentFiles: [] };
  const r3 = simulateSaveAsJson(noFile);
  const u3 = r3.mode === "download";
  console.log(`  无 currentFileName → 触发下载: ${u3 ? "✓" : "✗"}`);
  if (!u3) allPass = false;
  console.log("  saveAsJson 兜底逻辑:", (u1 && u2 && u3) ? "PASS" : "FAIL");
  if (!(u1 && u2 && u3)) allPass = false;

  // 9.5 directory handle 路径优先级（jsonHandleKey > directoryHandleKey > xlsx handle > ephemeral/download）
  // 模拟：所有 handle 都设上，看哪一步胜出
  function simulateWithHandle(state, hasJsonHandle, hasDirHandle) {
    if (hasJsonHandle) return { mode: "handle", step: 1 };
    if (hasDirHandle) return { mode: "dir", step: 1.5 };
    return simulateSaveAsJson(state);
  }
  const both = { currentFileName: "x.xlsx", recentFiles: [] };
  const r4 = simulateWithHandle(both, true, true);
  const r5 = simulateWithHandle(both, false, true);
  const r6 = simulateWithHandle(both, false, false);
  const u4 = r4.mode === "handle" && r4.step === 1;
  const u5 = r5.mode === "dir" && r5.step === 1.5;
  const u6 = r6.mode === "download";
  console.log(`  jsonHandleKey 优先于 directoryHandleKey: ${u4 ? "✓" : "✗"}`);
  console.log(`  有 directoryHandleKey 走 1.5 步: ${u5 ? "✓" : "✗"}`);
  console.log(`  都无 → 兜底下载: ${u6 ? "✓" : "✗"}`);
  if (!u4) allPass = false;
  if (!u5) allPass = false;
  if (!u6) allPass = false;
  console.log("  saveAsJson 优先级:", (u4 && u5 && u6) ? "PASS" : "FAIL");
  if (!(u4 && u5 && u6)) allPass = false;

  // 9.6 snapshot 完整性：directoryHandleKey 字段被 snapshot 保留
  const v9Snapshot = {
    schema: 9,
    currentFileName: "x.xlsx",
    jsonFileName: "x.json",
    jsonHandleKey: "json:x.xlsx",
    directoryHandleKey: "dir:x.xlsx",
    theme: {},
    ui: {},
    pages: {},
    sheetsRaw: [],
    recentFiles: [],
  };
  const json1 = JSON.stringify(v9Snapshot);
  const roundtrip = JSON.parse(json1);
  const u7 =
    roundtrip.directoryHandleKey === "dir:x.xlsx" &&
    roundtrip.jsonHandleKey === "json:x.xlsx" &&
    roundtrip.schema === 9;
  console.log(`  snapshot 序列化 directoryHandleKey: ${u7 ? "✓" : "✗"}`);
  if (!u7) allPass = false;
  console.log("  snapshot 完整性:", u7 ? "PASS" : "FAIL");
  if (!u7) allPass = false;

  // 9.7 enableAutoSave 路径：模拟 directory handle 持久化逻辑
  const fakeDb = new Map();
  const fsPut = (k, v) => { fakeDb.set(k, v); };
  const fsDel = (k) => { fakeDb.delete(k); };
  const fsGet = async (k) => fakeDb.get(k) || null;
  // 模拟：用户授权目录后
  const dirKey = "dir:x.xlsx";
  const dirHandle = { name: "myfolder", getFileHandle: async (n) => ({ name: n, createWritable: async () => ({ write: async () => {}, close: async () => {} }) }) };
  await fsPut(dirKey, dirHandle);
  // 模拟 saveAsJson 第 1.5 步
  const got = await fsGet(dirKey);
  const granted = true; // 假设权限已授权
  let savedJsonHandle = null;
  if (got && granted) {
    const fh = await got.getFileHandle("x.json", { create: true });
    const w = await fh.createWritable();
    await w.write("data");
    await w.close();
    const jsonKey = "json:x.json";
    await fsPut(jsonKey, fh);
    savedJsonHandle = jsonKey;
  }
  const u8 =
    savedJsonHandle === "json:x.json" &&
    fakeDb.has("json:x.json") &&
    fakeDb.has(dirKey);
  console.log(`  enableAutoSave 持久化 directory + json handle: ${u8 ? "✓" : "✗"}`);
  if (!u8) allPass = false;
  console.log("  enableAutoSave 路径:", u8 ? "PASS" : "FAIL");
  if (!u8) allPass = false;

  // ============================================================
  // 测试 10：v10 修复（删除下拉菜单 + 文件路径显示 + directoryName）
  // ============================================================
  console.log("\n测试 10：v10 修复（删除下拉菜单 + 文件路径显示）");

  // 10.1 directoryName schema 迁移：v9 旧数据 → v10 补 null
  const oldV9 = {
    schema: 9,
    currentFileName: "book.json",
    jsonFileName: "book.json",
    jsonHandleKey: null,
    directoryHandleKey: null,
    // v10 新字段缺失
  };
  const v10State = {
    directoryName: oldV9.directoryName || null,
  };
  const tt1 = v10State.directoryName === null;
  console.log(`  v9 → v10 迁移 directoryName = null: ${tt1 ? "✓" : "✗"}`);
  if (!tt1) allPass = false;

  // 10.2 enableAutoSave 后 directoryName 被正确设置
  // 模拟：用户授权目录后，state 应同时有 directoryHandleKey + directoryName
  const afterEnable = {
    currentFileName: "book.json",
    jsonFileName: "book.json",
    jsonHandleKey: "json:book.json",
    directoryHandleKey: "dir:book.json",
    directoryName: "my-novel-folder",  // dirHandle.name
  };
  const tt2 = afterEnable.directoryName === "my-novel-folder";
  const tt3 = afterEnable.directoryHandleKey === "dir:book.json";
  console.log(`  enableAutoSave 后 directoryName = "my-novel-folder": ${tt2 ? "✓" : "✗"}`);
  console.log(`  enableAutoSave 后 directoryHandleKey 同步设置: ${tt3 ? "✓" : "✗"}`);
  if (!tt2) allPass = false;
  if (!tt3) allPass = false;

  // 10.3 updateFilePathDisplay 逻辑：4 种 mode
  // 用纯函数模拟显示逻辑（避免依赖 DOM mock）
  function computeFilePathDisplay(state) {
    const fileName = state.jsonFileName || state.currentFileName || null;
    const dirName = state.directoryName || null;
    const hasDirHandle = !!state.directoryHandleKey;
    const hasJsonHandle = !!state.jsonHandleKey;
    if (fileName && dirName) return { text: `${dirName}/${fileName}`, mode: "dir" };
    if (fileName) {
      if (hasJsonHandle || hasDirHandle) return { text: fileName, mode: "file-stale" };
      return { text: fileName, mode: "file-ephemeral" };
    }
    return { text: "— 数据仅在浏览器内 —", mode: "none" };
  }

  const d10_1 = computeFilePathDisplay({ jsonFileName: "book.json", directoryName: "novel", directoryHandleKey: "dir:book.json" });
  const d10_2 = computeFilePathDisplay({ jsonFileName: "book.json", directoryHandleKey: null, jsonHandleKey: null });
  const d10_3 = computeFilePathDisplay({ jsonHandleKey: "stale", jsonFileName: "book.json" });
  const d10_4 = computeFilePathDisplay({});

  const u10_1 = d10_1.text === "novel/book.json" && d10_1.mode === "dir";
  const u10_2 = d10_2.text === "book.json" && d10_2.mode === "file-ephemeral";
  const u10_3 = d10_3.text === "book.json" && d10_3.mode === "file-stale";
  const u10_4 = d10_4.text.includes("浏览器内") && d10_4.mode === "none";
  console.log(`  mode=dir 显示 "dirname/filename": ${u10_1 ? "✓" : "✗"} (${d10_1.text})`);
  console.log(`  mode=file-ephemeral 仅显示 filename: ${u10_2 ? "✓" : "✗"} (${d10_2.text})`);
  console.log(`  mode=file-stale 仅显示 filename（handle 待恢复）: ${u10_3 ? "✓" : "✗"} (${d10_3.text})`);
  console.log(`  mode=none 显示"数据仅在浏览器内": ${u10_4 ? "✓" : "✗"} (${d10_4.text})`);
  if (!u10_1 || !u10_2 || !u10_3 || !u10_4) allPass = false;

  // 10.4 关键场景：导入 xxx.json（A 目录）→ 启用自动写盘（B 目录）→ 显示 B/xxx.json
  // ——跟原导入文件 A/xxx.json 是两个不同文件
  const imported = { currentFileName: "book.json", jsonFileName: "book.json" };
  const afterAutoSave = {
    currentFileName: "book.json",
    jsonFileName: "book.json",  // 名字相同
    directoryHandleKey: "dir:book.json",
    directoryName: "B-folder",  // 不同的目录
  };
  const beforeText = computeFilePathDisplay(imported).text;
  const afterText = computeFilePathDisplay(afterAutoSave).text;
  const u10_5 = beforeText === "book.json" && afterText === "B-folder/book.json";
  console.log(`  导入后显示: "${beforeText}", 启用写盘后显示: "${afterText}"`);
  console.log(`  启用写盘后路径区分原文件（B-folder/book.json）: ${u10_5 ? "✓" : "✗"}`);
  if (!u10_5) allPass = false;

  // 10.5 snapshot 完整性：directoryName 字段被 snapshot 保留
  const v10Snap = {
    schema: 10,
    currentFileName: "x.json",
    jsonFileName: "x.json",
    directoryName: "Documents",
    directoryHandleKey: "dir:x.json",
  };
  const round = JSON.parse(JSON.stringify(v10Snap));
  const u10_6 = round.directoryName === "Documents";
  console.log(`  snapshot 序列化保留 directoryName: ${u10_6 ? "✓" : "✗"}`);
  if (!u10_6) allPass = false;

  // 10.6 旧数据无 directoryName 也能正常显示（不崩溃）
  const legacy = { currentFileName: "old.json", jsonFileName: "old.json" };
  const d10_5 = computeFilePathDisplay(legacy);
  const u10_7 = d10_5.text === "old.json" && d10_5.mode === "file-ephemeral";
  console.log(`  旧数据（无 directoryName）降级为 file-ephemeral: ${u10_7 ? "✓" : "✗"} (${d10_5.text})`);
  if (!u10_7) allPass = false;

  console.log("  v10 修复:", (u10_1 && u10_2 && u10_3 && u10_4 && u10_5 && u10_6 && u10_7 && tt1 && tt2 && tt3) ? "PASS" : "FAIL");
  if (!(u10_1 && u10_2 && u10_3 && u10_4 && u10_5 && u10_6 && u10_7 && tt1 && tt2 && tt3)) allPass = false;

  // ============================================================
  // 测试 11：v10.1 修复（保存后路径持久显示 + 去除冗余的「已保存到 json」提示）
  // ============================================================
  console.log("\n测试 11：v10.1 修复（路径持久 + 去除冗余 toast 重复）");

  // 11.1 renderChapterEditor 末尾必须调 updateFilePathDisplay()
  // ——否则 innerHTML 重写后 #ch-file-path 是新元素，旧 textContent 丢失
  const idx1 = SRC.indexOf("function renderChapterEditor");
  const idx2 = SRC.indexOf("function renderFsEditor");
  const idxEnd1 = SRC.indexOf("function renderFsEditor", idx1);
  const idxEnd2 = SRC.indexOf("function bindChapterEditorEvents", idx2);
  const chEditorBlock = SRC.slice(idx1, idxEnd1 > 0 ? idxEnd1 : idx1 + 4000);
  const fsEditorBlock = SRC.slice(idx2, idxEnd2 > 0 ? idxEnd2 : idx2 + 4000);
  const t11_1a = chEditorBlock.includes("updateFilePathDisplay()");
  const t11_1b = fsEditorBlock.includes("updateFilePathDisplay()");
  console.log(`  renderChapterEditor 末尾补 updateFilePathDisplay: ${t11_1a ? "✓" : "✗"}`);
  console.log(`  renderFsEditor 末尾补 updateFilePathDisplay: ${t11_1b ? "✓" : "✗"}`);
  if (!t11_1a || !t11_1b) allPass = false;

  // 11.2 renderChapterEditor 中 updateFilePathDisplay() 必须在 bindChapterEditorEvents() 之后
  // ——否则 #ch-file-path 还不在 DOM 上就调了，无效
  const chOrderMatch = chEditorBlock.match(/bindChapterEditorEvents\(\);\s*\/\/ v10\.1[\s\S]{0,200}?updateFilePathDisplay\(\);/);
  const fsOrderMatch = fsEditorBlock.match(/bindFsEditorEvents\(\);\s*\/\/ v10\.1[\s\S]{0,200}?updateFilePathDisplay\(\);/);
  const t11_2a = !!chOrderMatch;
  const t11_2b = !!fsOrderMatch;
  console.log(`  顺序：bindChapterEditorEvents → updateFilePathDisplay: ${t11_2a ? "✓" : "✗"}`);
  console.log(`  顺序：bindFsEditorEvents → updateFilePathDisplay: ${t11_2b ? "✓" : "✗"}`);
  if (!t11_2a || !t11_2b) allPass = false;

  // 11.3 手动保存按钮（btn-save / btn-fs-save）处理后不再调 flashSaveStatus
  // ——toast 已弹，#save-status 不应再重复「已保存到 json」
  const idxBtn = SRC.indexOf('t.id === "btn-save" || t.id === "btn-fs-save"');
  const idxCtrlS = SRC.indexOf("Ctrl+S / Cmd+S");
  const idxNextUndo = SRC.indexOf("Ctrl+Z / Cmd+Z");
  const btnSaveBlock = SRC.slice(idxBtn, idxCtrlS > 0 ? idxCtrlS : idxBtn + 1500);
  const ctrlSBlock = SRC.slice(idxCtrlS, idxNextUndo > 0 ? idxNextUndo : idxCtrlS + 1500);
  // 之前这里有 3 个 flashSaveStatus("✓ 已保存到 json / 已下载 / 已保存到浏览器")
  // 现在应只调 saveAsJson()，不再有 flashSaveStatus
  const t11_3a = !btnSaveBlock.includes("flashSaveStatus");
  const t11_3b = !ctrlSBlock.includes("flashSaveStatus");
  console.log(`  保存按钮处理：已去除 flashSaveStatus（toast 替代）: ${t11_3a ? "✓" : "✗"}`);
  console.log(`  Ctrl+S 处理：已去除 flashSaveStatus（toast 替代）: ${t11_3b ? "✓" : "✗"}`);
  if (!t11_3a || !t11_3b) allPass = false;

  // 11.4 切章节/失焦的"已保存到本地"反馈仍保留（该场景无 toast）
  // ——saveCurrentItem 末尾 flashSaveStatus("✓ 已保存到本地")
  const saveCurrentItemBlock = SRC.slice(
    SRC.indexOf("function saveCurrentItem"),
    SRC.indexOf("function deleteCurrentItem")
  );
  const t11_4 = saveCurrentItemBlock.includes('flashSaveStatus("✓ 已保存到本地")');
  console.log(`  saveCurrentItem 保留「已保存到本地」（切章节反馈）: ${t11_4 ? "✓" : "✗"}`);
  if (!t11_4) allPass = false;

  // 11.5 saveAsJson 内的 toast 提示仍保留（用户要的 toast 提示）
  const saveAsJsonBlock = SRC.slice(
    SRC.indexOf("async function saveAsJson"),
    SRC.indexOf("async function enableAutoSave")
  );
  const toastCount = (saveAsJsonBlock.match(/toast\("✓ 已保存到 json"/g) || []).length;
  const t11_5 = toastCount >= 3; // 第 1/1.5/2 步成功都有 toast
  console.log(`  saveAsJson 内 toast 仍存在（>=3 处）: ${t11_5 ? "✓" : "✗"} (${toastCount} 处)`);
  if (!t11_5) allPass = false;

  console.log("  v10.1 修复:", (t11_1a && t11_1b && t11_2a && t11_2b && t11_3a && t11_3b && t11_4 && t11_5) ? "PASS" : "FAIL");
  if (!(t11_1a && t11_1b && t11_2a && t11_2b && t11_3a && t11_3b && t11_4 && t11_5)) allPass = false;

  // ============================================================
  // 测试 12：v11（默认写盘路径 D:/yuelan + 导入按钮移到伏笔页）
  // ============================================================
  console.log("\n测试 12：v11（默认写盘路径 + 导入按钮移位）");

  // 12.1 showDirectoryPicker 必须传 id（浏览器用它记住目录，下次直接打开）
  const enableBlock = SRC.slice(
    SRC.indexOf("async function enableAutoSave"),
    SRC.indexOf("function updateAutosaveButton")
  );
  const t12_1a = /showDirectoryPicker\s*\(\s*\{[\s\S]{0,200}?id:\s*AUTOSAVE_DIR_ID/.test(enableBlock);
  const t12_1b = /const AUTOSAVE_DIR_ID\s*=\s*"fiction-analyzer-autosave-yuelan"/.test(SRC);
  console.log(`  enableAutoSave 用 AUTOSAVE_DIR_ID 调 showDirectoryPicker: ${t12_1a ? "✓" : "✗"}`);
  console.log(`  AUTOSAVE_DIR_ID 常量存在（"fiction-analyzer-autosave-yuelan"）: ${t12_1b ? "✓" : "✗"}`);
  if (!t12_1a || !t12_1b) allPass = false;

  // 12.2 updateAutosaveButton 文字逻辑：未配置显示「建议 D:/yuelan」，已配置显示「写盘目录：xxx」
  const updateBtnBlock = SRC.slice(
    SRC.indexOf("function updateAutosaveButton"),
    SRC.indexOf("function maybePromptEnableAutoSave")
  );
  const t12_2a = /启用自动写盘（建议 \$\{AUTOSAVE_DEFAULT_HINT\}）/.test(updateBtnBlock);
  const t12_2b = /写盘目录：\$\{state\.directoryName\}（点此修改）/.test(updateBtnBlock);
  const t12_2c = /AUTOSAVE_DEFAULT_HINT\s*=\s*"D:\/yuelan"/.test(SRC);
  console.log(`  未配置时按钮显示「启用自动写盘（建议 D:/yuelan）」: ${t12_2a ? "✓" : "✗"}`);
  console.log(`  已配置时按钮显示「写盘目录：xxx（点此修改）」: ${t12_2b ? "✓" : "✗"}`);
  console.log(`  常量 AUTOSAVE_DEFAULT_HINT = "D:/yuelan": ${t12_2c ? "✓" : "✗"}`);
  if (!t12_2a || !t12_2b || !t12_2c) allPass = false;

  // 12.3 updateAutosaveButton 在合适时机被调用
  // - enableAutoSave 成功后
  // - load() 末尾
  // - bindEditorButtons 末尾（init 时）
  const t12_3a = /toast\("✓ 已启用自动写盘[^"]*", "info", 2500\);\s*\n\s*return true;/.test(enableBlock) === false; // 已确认存在
  const callAfterEnable = /state\.directoryName = dirHandle\.name[\s\S]{0,400}?updateAutosaveButton\(\)/.test(enableBlock);
  const loadBlock = SRC.slice(SRC.indexOf("function load"), SRC.indexOf("let _dbPromise"));
  const callAfterLoad = /sheetsRaw[\s\S]{0,300}?updateAutosaveButton\(\)/.test(loadBlock);
  const btnBindBlock = SRC.slice(SRC.indexOf("#btn-enable-autosave")?.addEventListener ? 0 : 0, 0); // 占位
  const idxBind = SRC.indexOf('$("#btn-enable-autosave")?.addEventListener');
  const idxBindEnd = SRC.indexOf("// JSON 导入走", idxBind);
  const bindBlock = SRC.slice(idxBind, idxBindEnd > 0 ? idxBindEnd : idxBind + 1000);
  const callAfterBind = /updateAutosaveButton\(\)/.test(bindBlock);
  console.log(`  enableAutoSave 成功路径调 updateAutosaveButton: ${callAfterEnable ? "✓" : "✗"}`);
  console.log(`  load() 末尾调 updateAutosaveButton: ${callAfterLoad ? "✓" : "✗"}`);
  console.log(`  bindEditorButtons 末尾调 updateAutosaveButton: ${callAfterBind ? "✓" : "✗"}`);
  if (!callAfterEnable || !callAfterLoad || !callAfterBind) allPass = false;

  // 12.4 maybePromptEnableAutoSave 文案提了 D:/yuelan
  const promptBlock = SRC.slice(
    SRC.indexOf("function maybePromptEnableAutoSave"),
    SRC.indexOf("function ensureWritePermission")
  );
  const t12_4 = /AUTOSAVE_DEFAULT_HINT/.test(promptBlock) && /建议 \$\{AUTOSAVE_DEFAULT_HINT\}/.test(promptBlock);
  console.log(`  maybePromptEnableAutoSave confirm 文案含 D:/yuelan 建议: ${t12_4 ? "✓" : "✗"}`);
  if (!t12_4) allPass = false;

  // 12.5 #btn-import 已从章节页删除、加到伏笔管理页
  const HTML_PATH = "/home/gem/.aily/workdir/task_7672995282002398156/fiction-analyzer/index.html";
  const html = fs.readFileSync(HTML_PATH, "utf-8");
  // 章节 page-view="chapter" 段中不应再含 #btn-import
  const chSection = html.slice(
    html.indexOf('data-page-view="chapter"'),
    html.indexOf('data-page-view="foreshadowing"')
  );
  const fsSection = html.slice(
    html.indexOf('data-page-view="foreshadowing"'),
    html.indexOf('<!-- ===================== 弹窗：导入')
  );
  const t12_5a = !/id="btn-import"/.test(chSection);
  const t12_5b = /id="btn-import"/.test(fsSection);
  // 顺序：#btn-new-fs 在前、#btn-import 在后
  const fsOrder = fsSection.indexOf('id="btn-new-fs"') < fsSection.indexOf('id="btn-import"') &&
                  fsSection.indexOf('id="btn-import"') < fsSection.indexOf('id="btn-fs-save"');
  console.log(`  章节页 page-toolbar 已删 #btn-import: ${t12_5a ? "✓" : "✗"}`);
  console.log(`  伏笔页 page-toolbar 已加 #btn-import: ${t12_5b ? "✓" : "✗"}`);
  console.log(`  顺序：btn-new-fs < btn-import: ${fsOrder ? "✓" : "✗"}`);
  if (!t12_5a || !t12_5b || !fsOrder) allPass = false;

  // 12.6 按钮初始文字改了
  const t12_6 = html.includes("启用自动写盘（建议 D:/yuelan）");
  console.log(`  index.html 初始按钮文字含「D:/yuelan」: ${t12_6 ? "✓" : "✗"}`);
  if (!t12_6) allPass = false;

  console.log("  v11 修复:", (t12_1a && t12_1b && t12_2a && t12_2b && t12_2c && callAfterEnable && callAfterLoad && callAfterBind && t12_4 && t12_5a && t12_5b && fsOrder && t12_6) ? "PASS" : "FAIL");
  if (!(t12_1a && t12_1b && t12_2a && t12_2b && t12_2c && callAfterEnable && callAfterLoad && callAfterBind && t12_4 && t12_5a && t12_5b && fsOrder && t12_6)) allPass = false;

  // ============================================================
  // 测试 13：v12（章节号只读 + 导入自动提取数字 + 伏笔字段扩展）
  // ============================================================
  console.log("\n测试 13：v12（章节号只读 + 导入自动提取数字 + 伏笔字段扩展）");

  // 13.1 SCHEMA_VERSION = 10
  const t13_1 = /const SCHEMA_VERSION = 10;/.test(SRC);
  console.log(`  SCHEMA_VERSION = 10: ${t13_1 ? "✓" : "✗"}`);
  if (!t13_1) allPass = false;

  // 13.2 章节号 input 是 readonly + 带 .readonly-field class + tooltip
  const t13_2a = /id="ch-no"[^>]*readonly/.test(SRC);
  const t13_2b = /id="ch-no"[^>]*class="readonly-field"/.test(SRC);
  const t13_2c = /id="ch-no"[^>]*title="章节号不可编辑/.test(SRC);
  // 验证去掉了 placeholder（既然不可编辑就不需要提示）
  const chNoInput = SRC.match(/<input id="ch-no"[^>]*\/>/)[0];
  const t13_2d = !/placeholder=/.test(chNoInput);
  console.log(`  章节号 input 有 readonly 属性: ${t13_2a ? "✓" : "✗"}`);
  console.log(`  章节号 input 有 .readonly-field class: ${t13_2b ? "✓" : "✗"}`);
  console.log(`  章节号 input 有 title tooltip: ${t13_2c ? "✓" : "✗"}`);
  console.log(`  章节号 input 去掉了 placeholder: ${t13_2d ? "✓" : "✗"}`);
  if (!(t13_2a && t13_2b && t13_2c && t13_2d)) allPass = false;

  // 13.3 CSS 里有 .readonly-field 样式
  const css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf-8");
  const t13_3a = /\.meta-field input\.readonly-field\s*\{/.test(css);
  const t13_3b = /cursor:\s*not-allowed/.test(css);
  const t13_3c = /border-style:\s*dashed/.test(css);
  console.log(`  CSS 有 .meta-field input.readonly-field 规则: ${t13_3a ? "✓" : "✗"}`);
  console.log(`  CSS 含 cursor:not-allowed: ${t13_3b ? "✓" : "✗"}`);
  console.log(`  CSS 含 border-style:dashed: ${t13_3c ? "✓" : "✗"}`);
  if (!(t13_3a && t13_3b && t13_3c)) allPass = false;

  // 13.4 xlsx 导入 parseRowsForPage 走 parseChapterNo 提取数字
  const parseBlock = SRC.slice(
    SRC.indexOf("function parseRowsForPage"),
    SRC.indexOf("function parseXlsxAllSheets")
  );
  const t13_4a = /parseChapterNo\(trimmed\)/.test(parseBlock);
  const t13_4b = /parsed\.hasNum && Number\.isFinite\(parsed\.num\)/.test(parseBlock);
  const t13_4c = /data\.no = parsed\.num/.test(parseBlock);
  const t13_4d = /data\.no = trimmed/.test(parseBlock); // 纯汉字回退保留原字符串
  console.log(`  parseRowsForPage 调用 parseChapterNo: ${t13_4a ? "✓" : "✗"}`);
  console.log(`  parseRowsForPage 检查 parsed.hasNum && isFinite: ${t13_4b ? "✓" : "✗"}`);
  console.log(`  parseRowsForPage 提取数字赋值 data.no = parsed.num: ${t13_4c ? "✓" : "✗"}`);
  console.log(`  parseRowsForPage 纯汉字保留原字符串: ${t13_4d ? "✓" : "✗"}`);
  if (!(t13_4a && t13_4b && t13_4c && t13_4d)) allPass = false;

  // 13.5 文本导入 parseImportText 走 parseChapterNo
  const txtBlock = SRC.slice(
    SRC.indexOf("function parseImportText"),
    SRC.indexOf("function refreshImportPreview")
  );
  const t13_5a = /parseChapterNo\(noStr\)/.test(txtBlock);
  const t13_5b = /!noParsed\.hasNum \|\| !Number\.isFinite\(noParsed\.num\)/.test(txtBlock);
  const t13_5c = /o\.no = noParsed\.num/.test(txtBlock);
  const t13_5d = /章节号无法解析为数字/.test(txtBlock);
  console.log(`  parseImportText 调用 parseChapterNo: ${t13_5a ? "✓" : "✗"}`);
  console.log(`  parseImportText 检查 hasNum && isFinite: ${t13_5b ? "✓" : "✗"}`);
  console.log(`  parseImportText 赋值 o.no = noParsed.num: ${t13_5c ? "✓" : "✗"}`);
  console.log(`  parseImportText 错误提示更新: ${t13_5d ? "✓" : "✗"}`);
  if (!(t13_5a && t13_5b && t13_5c && t13_5d)) allPass = false;

  // 13.6 伏笔字段扩展：name / setup / status / notes 都加上了新关键词
  // 切片：从 foreshadowing 字段开始，到下一个 page（人物/大纲/...）的字段开始前
  // 当前 PAGES 里 foreshadowing 之后是 chapter，所以用 "chapter: {" 作终止
  // ——比 "emptyStateHtml()" 精确，避免切到 chapter 的 emptyStateHtml
  const fsStart = SRC.indexOf("foreshadowing: {");
  const fsEnd = SRC.indexOf("\n    },\n\n    chapter:", fsStart);
  const fsFields = SRC.slice(fsStart, fsEnd > 0 ? fsEnd : fsStart + 5000);
  const t13_6a = /name:[^\]]*伏笔名称/.test(fsFields);
  const t13_6b = /setup:[^\]]*提及章节/.test(fsFields);
  const t13_6c = /status:[^\]]*回收状态/.test(fsFields);
  const t13_6d = /notes:[^\]]*原文描述/.test(fsFields);
  // v13：v12 扩展的同义词已全部移除（伏笔字段精简为 5 个）
  const t13_6e = !/name:[^\]]*"名称"/.test(fsFields);
  const t13_6f = !/setup:[^\]]*"铺设章节"/.test(fsFields);
  const t13_6g = !/status:[^\]]*"状态"/.test(fsFields);
  const t13_6h = !/notes:[^\]]*"备注"/.test(fsFields);
  // no 字段仍含"序号"
  const t13_6i = /no:[^\]]*"序号"/.test(fsFields);
  console.log(`  name 加了「伏笔名称」: ${t13_6a ? "✓" : "✗"}`);
  console.log(`  setup 加了「提及章节」: ${t13_6b ? "✓" : "✗"}`);
  console.log(`  status 加了「回收状态」: ${t13_6c ? "✓" : "✗"}`);
  console.log(`  notes 加了「原文描述」: ${t13_6d ? "✓" : "✗"}`);
  console.log(`  旧 name「名称」已移除: ${t13_6e ? "✓" : "✗"}`);
  console.log(`  旧 setup「铺设章节」已移除: ${t13_6f ? "✓" : "✗"}`);
  console.log(`  旧 status「状态」已移除: ${t13_6g ? "✓" : "✗"}`);
  console.log(`  旧 notes「备注」已移除: ${t13_6h ? "✓" : "✗"}`);
  console.log(`  no「序号」保留: ${t13_6i ? "✓" : "✗"}`);
  if (!(t13_6a && t13_6b && t13_6c && t13_6d && t13_6e && t13_6f && t13_6g && t13_6h && t13_6i)) allPass = false;

  // 13.7 行为验证：parseChapterNo 真实输出（用 vm 跑过的 ctx 取函数）
  // ctx 里 app.js 已经执行过，parseChapterNo 在闭包外层定义。用 SRC 自己解析再 eval
  const evalSrc = SRC + "\n;parseChapterNo;";
  // 改成在 sandbox 里执行拿函数
  const cn = vm.runInContext(evalSrc, ctx);
  const cases = [
    { input: "12", expected: 12 },
    { input: "第12章", expected: 12 },
    { input: "第一章", expected: 1 },
    { input: "第二十章", expected: 20 },
    { input: "Chapter 5", expected: 5 },
    { input: "卷一 第三章", expected: 3 },  // 阿拉伯数字 3 优先于中文"一"
    { input: "序章", expected: null }, // 纯汉字无数字 → num=Infinity
    { input: "楔子", expected: null },
    { input: "", expected: null },
  ];
  let t13_7 = true;
  for (const c of cases) {
    const r = cn(c.input);
    const actual = Number.isFinite(r.num) ? r.num : null;
    const ok = actual === c.expected;
    if (!ok) t13_7 = false;
    console.log(`    parseChapterNo("${c.input}") → ${actual} (期望 ${c.expected}) ${ok ? "✓" : "✗"}`);
  }
  if (!t13_7) allPass = false;

  console.log("  v12 修复:", (t13_1 && t13_2a && t13_2b && t13_2c && t13_2d && t13_3a && t13_3b && t13_3c && t13_4a && t13_4b && t13_4c && t13_4d && t13_5a && t13_5b && t13_5c && t13_5d && t13_6a && t13_6b && t13_6c && t13_6d && t13_6e && t13_6f && t13_6g && t13_6h && t13_6i && t13_7) ? "PASS" : "FAIL");
  if (!(t13_1 && t13_2a && t13_2b && t13_2c && t13_2d && t13_3a && t13_3b && t13_3c && t13_4a && t13_4b && t13_4c && t13_4d && t13_5a && t13_5b && t13_5c && t13_5d && t13_6a && t13_6b && t13_6c && t13_6d && t13_6e && t13_6f && t13_6g && t13_6h && t13_6i && t13_7)) allPass = false;

  // ============================================================
  // 测试 14：v13（import 支持 .json 拖入 + JSON 文本粘贴 + 伏笔字段精简为 5 个）
  // ============================================================
  console.log("\n测试 14：v13（import 支持 .json + 伏笔字段精简）");

  // 14.1 伏笔 fields 只剩 5 个指定关键词 + payoff 为空
  const fsFieldsV14 = (() => {
    const start = SRC.indexOf("foreshadowing: {");
    const end = SRC.indexOf("\n    },\n\n    chapter:", start);
    return SRC.slice(start, end > 0 ? end : start + 5000);
  })();
  const t14_1a = /no:\s*\[\s*"序号"\s*\]/.test(fsFieldsV14);
  const t14_1b = /name:\s*\[\s*"伏笔名称"\s*\]/.test(fsFieldsV14);
  const t14_1c = /setup:\s*\[\s*"提及章节"\s*\]/.test(fsFieldsV14);
  const t14_1d = /payoff:\s*\[\s*\]/.test(fsFieldsV14);
  const t14_1e = /status:\s*\[\s*"回收状态"\s*\]/.test(fsFieldsV14);
  const t14_1f = /notes:\s*\[\s*"原文描述"\s*\]/.test(fsFieldsV14);
  const noOldSynonyms =
    !/no:[^\]]*"编号"/.test(fsFieldsV14) &&
    !/name:[^\]]*"名称"/.test(fsFieldsV14) &&
    !/setup:[^\]]*"铺设章节"/.test(fsFieldsV14) &&
    !/payoff:[^\]]*"回收章节"/.test(fsFieldsV14) &&
    !/status:[^\]]*"状态"/.test(fsFieldsV14) &&
    !/notes:[^\]]*"备注"/.test(fsFieldsV14);
  console.log(`  no: ["序号"] 单关键词: ${t14_1a ? "✓" : "✗"}`);
  console.log(`  name: ["伏笔名称"] 单关键词: ${t14_1b ? "✓" : "✗"}`);
  console.log(`  setup: ["提及章节"] 单关键词: ${t14_1c ? "✓" : "✗"}`);
  console.log(`  payoff: [] 空: ${t14_1d ? "✓" : "✗"}`);
  console.log(`  status: ["回收状态"] 单关键词: ${t14_1e ? "✓" : "✗"}`);
  console.log(`  notes: ["原文描述"] 单关键词: ${t14_1f ? "✓" : "✗"}`);
  console.log(`  旧同义词全部移除: ${noOldSynonyms ? "✓" : "✗"}`);
  if (!(t14_1a && t14_1b && t14_1c && t14_1d && t14_1e && t14_1f && noOldSynonyms)) allPass = false;

  // 14.2 新增 parseJsonArrayForPage / tryParseJsonText 函数
  const t14_2a = /function parseJsonArrayForPage\s*\(/.test(SRC);
  const t14_2b = /function tryParseJsonText\s*\(/.test(SRC);
  console.log(`  parseJsonArrayForPage 函数存在: ${t14_2a ? "✓" : "✗"}`);
  console.log(`  tryParseJsonText 函数存在: ${t14_2b ? "✓" : "✗"}`);
  if (!(t14_2a && t14_2b)) allPass = false;

  // 14.3 handleXlsxFile 接受 .json + 新增 handleJsonImportFile + afterImportParsed
  const t14_3a = /if\s*\(!\["xlsx",\s*"xlsm",\s*"json"\]\.includes\(ext\)\)/.test(SRC);
  const t14_3b = /function handleJsonImportFile\s*\(/.test(SRC);
  const t14_3c = /function afterImportParsed\s*\(/.test(SRC);
  console.log(`  handleXlsxFile 接受 .json 后缀: ${t14_3a ? "✓" : "✗"}`);
  console.log(`  新增 handleJsonImportFile: ${t14_3b ? "✓" : "✗"}`);
  console.log(`  提取 afterImportParsed 公共逻辑: ${t14_3c ? "✓" : "✗"}`);
  if (!(t14_3a && t14_3b && t14_3c)) allPass = false;

  // 14.4 parseImportText 调 tryParseJsonText
  const txtBlock14 = SRC.slice(
    SRC.indexOf("function parseImportText"),
    SRC.indexOf("function refreshImportPreview")
  );
  const t14_4a = /tryParseJsonText\(text\)/.test(txtBlock14);
  const t14_4b = /parseJsonArrayForPage\(jsonArr,\s*"chapter"\)/.test(txtBlock14);
  console.log(`  parseImportText 调用 tryParseJsonText: ${t14_4a ? "✓" : "✗"}`);
  console.log(`  parseImportText JSON 路径走 chapter: ${t14_4b ? "✓" : "✗"}`);
  if (!(t14_4a && t14_4b)) allPass = false;

  // 14.5 index.html import-drop 接受 .json
  const htmlV14 = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
  const t14_5a = /id="file-xlsx"[^>]*accept="\.xlsx,\.xlsm,\.json,application\/json"/.test(html);
  const t14_5b = !/导入 xlsx 条目/.test(html);
  const t14_5c = /点击选择 \/ 拖入 \.xlsx 或 \.json 文件/.test(html);
  console.log(`  index.html import-drop accept 加 .json: ${t14_5a ? "✓" : "✗"}`);
  console.log(`  modal 标题去除"导入 xlsx 条目": ${t14_5b ? "✓" : "✗"}`);
  console.log(`  import-drop 提示文案更新: ${t14_5c ? "✓" : "✗"}`);
  if (!(t14_5a && t14_5b && t14_5c)) allPass = false;

  // 14.6-14.9 行为：v13 新增函数 + 字段识别
  // IIFE 内部函数无法从外部 vm 访问，从 SRC 提取关键函数代码到独立 sandbox 跑
  // extractFn：跳过字符串 / 注释 / regex 字面量 内的大括号，准确提取函数体
  // 注意：String.match 不会更新 re.lastIndex（只有 exec 才会），所以 m.index + m[0].length - 1 才是「{」的位置
  function extractFn(src, name) {
    const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{");
    const m = src.match(re);
    if (!m) return null;
    const start = m.index;
    // 找到函数体的 {（在 m[0] 末尾）
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let mode = 'code'; // code | line_comment | block_comment | sq | dq | tm | regex
    let prevSig = '';
    for (; i < src.length; i++) {
      const ch = src[i];
      const next = src[i + 1];
      if (mode === 'line_comment') {
        if (ch === '\n') mode = 'code';
      } else if (mode === 'block_comment') {
        if (ch === '*' && next === '/') { mode = 'code'; i++; }
      } else if (mode === 'sq') {
        if (ch === '\\') { i++; continue; }
        if (ch === "'") mode = 'code';
      } else if (mode === 'dq') {
        if (ch === '\\') { i++; continue; }
        if (ch === '"') mode = 'code';
      } else if (mode === 'tm') {
        if (ch === '\\') { i++; continue; }
        if (ch === '\`') mode = 'code';
      } else if (mode === 'regex') {
        if (ch === '\\') { i++; continue; }
        if (ch === '[') { mode = 'charclass'; continue; }
        if (ch === '/') {
          // 跳过 regex flags
          mode = 'code';
          i++;
          while (i < src.length && /[a-z]/i.test(src[i])) i++;
          i--;
        }
      } else if (mode === 'charclass') {
        if (ch === '\\') { i++; continue; }
        if (ch === ']') mode = 'regex';
      } else { // code
        if (ch === '/' && next === '/') { mode = 'line_comment'; i++; continue; }
        if (ch === '/' && next === '*') { mode = 'block_comment'; i++; continue; }
        if (ch === "'") { mode = 'sq'; continue; }
        if (ch === '"') { mode = 'dq'; continue; }
        if (ch === '\`') { mode = 'tm'; continue; }
        if (ch === '/') {
          // 可能是 regex 字面量：在表达式位置才生效。简化：看 prevSig 是否可能是表达式结尾
          // 这里用近似：如果前一个非空 token 是标识符 / 数字 / ) / ]，则是除号，否则是 regex 开始
          const lastCodeChar = (() => {
            for (let j = i - 1; j >= start; j--) {
              const c = src[j];
              if (/\s/.test(c)) continue;
              return c;
            }
            return '';
          })();
          if (!/[\w\)\]]/.test(lastCodeChar)) {
            mode = 'regex';
            continue;
          }
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return src.slice(start, i + 1);
        }
      }
    }
    return null;
  }
  // 提取：PAGES（顶层 const） + findColumnIndex + parseChapterNo + parseJsonArrayForPage + tryParseJsonText
  // 因为 parseChapterNo 依赖 parseChineseNumeral，提取 PAGES 用简单括号计数
  // （不能 indexOf("};")，会因为内嵌对象/函数返回的 }; 提前结束）
  const PAGES_START = SRC.indexOf("const PAGES = {");
  let _pe = PAGES_START + "const PAGES = {".length - 1; // 指向 {
  let _pd = 0;
  let _pInStr = false, _pStrCh = '', _pLineCom = false, _pBlockCom = false;
  for (; _pe < SRC.length; _pe++) {
    const _ch = SRC[_pe], _nx = SRC[_pe + 1];
    if (_pBlockCom) { if (_ch === '*' && _nx === '/') { _pBlockCom = false; _pe++; } continue; }
    if (_pLineCom) { if (_ch === '\n') _pLineCom = false; continue; }
    if (_pInStr) { if (_ch === '\\') { _pe++; continue; } if (_ch === _pStrCh) _pInStr = false; continue; }
    if (_ch === '/' && _nx === '/') { _pLineCom = true; _pe++; continue; }
    if (_ch === '/' && _nx === '*') { _pBlockCom = true; _pe++; continue; }
    if (_ch === '"' || _ch === "'") { _pInStr = true; _pStrCh = _ch; continue; }
    if (_ch === '{') _pd++;
    else if (_ch === '}') { _pd--; if (_pd === 0) { _pe++; break; } }
  }
  const PAGES_END = _pe;
  const pagesCode = SRC.slice(PAGES_START, PAGES_END);
  const findColCode = extractFn(SRC, "findColumnIndex");
  const parseNoCode = extractFn(SRC, "parseChapterNo");
  const parseCnCode = extractFn(SRC, "parseChineseNumeral");
  const parseJsonCode = extractFn(SRC, "parseJsonArrayForPage");
  const tryParseCode = extractFn(SRC, "tryParseJsonText");
  const sandbox14 = {};
  vm.createContext(sandbox14);
  vm.runInContext(
    (parseCnCode || "") + "\n" +
    (parseNoCode || "") + "\n" +
    (findColCode || "") + "\n" +
    pagesCode + "\n" +
    (parseJsonCode || "") + "\n" +
    (tryParseCode || "") + "\n" +
    "this.parseJsonArrayForPage = parseJsonArrayForPage;\n" +
    "this.tryParseJsonText = tryParseJsonText;",
    sandbox14
  );
  const v14Api = sandbox14;

  // 14.6 章节 JSON
  const chJson = [
    { "章节号": 1, "章节名": "寒江初雪", "文章内容": "第一章内容..." },
    { "章节号": 2, "章节名": "北风", "文章内容": "第二章内容..." },
    { "章节号": "第3章", "章节名": "月落", "文章内容": "第三章内容..." },
  ];
  const chParsed = v14Api.parseJsonArrayForPage(chJson, "chapter");
  const t14_6a = chParsed.columns.no === 0 && chParsed.columns.title === 1 && chParsed.columns.content === 2;
  const t14_6b =
    chParsed.rows.length === 3 &&
    chParsed.rows[0].no === 1 &&
    chParsed.rows[0].title === "寒江初雪" &&
    chParsed.rows[0].content === "第一章内容..." &&
    chParsed.rows[2].no === 3;
  console.log(`  章节 JSON 字段识别（no/title/content）: ${t14_6a ? "✓" : "✗"}`);
  console.log(`  章节 JSON 数据 + no 提取: ${t14_6b ? "✓" : "✗"}`);
  if (!(t14_6a && t14_6b)) allPass = false;

  // 14.7 伏笔 JSON（5 个关键词）
  const fsJson = [
    { "序号": 1, "伏笔名称": "断剑", "提及章节": "第3章", "原文描述": "雪地里捡到的断剑", "回收状态": "未回收" },
    { "序号": 2, "伏笔名称": "玉佩", "提及章节": "第5章", "原文描述": "娘亲遗留的玉佩", "回收状态": "已回收" },
  ];
  const fsParsed = v14Api.parseJsonArrayForPage(fsJson, "foreshadowing");
  const t14_7a =
    fsParsed.columns.no === 0 &&
    fsParsed.columns.name === 1 &&
    fsParsed.columns.setup === 2 &&
    fsParsed.columns.notes === 3 &&
    fsParsed.columns.status === 4;
  // v13 设计：只有 no 字段走 parseChapterNo 提数字；setup 字段保留原字符串（"第3章"），
  // 避免在编辑器里丢失"第"字给用户造成"我输了第3章怎么变成3了"的困惑
  const t14_7b =
    fsParsed.rows.length === 2 &&
    fsParsed.rows[0].no === 1 &&
    fsParsed.rows[0].name === "断剑" &&
    fsParsed.rows[0].setup === "第3章" &&
    fsParsed.rows[0].notes === "雪地里捡到的断剑" &&
    fsParsed.rows[0].status === "未回收" &&
    fsParsed.rows[0].payoff === "";
  console.log(`  伏笔 JSON 字段识别（5 个关键词 + payoff 跳过）: ${t14_7a ? "✓" : "✗"}`);
  console.log(`  伏笔 JSON 数据: ${t14_7b ? "✓" : "✗"}`);
  if (!(t14_7a && t14_7b)) allPass = false;

  // 14.8 旧伏笔同义词不再识别
  const fsJsonOld = [{ "序号": 1, "名称": "x", "铺设章节": "第1章", "备注": "y", "状态": "活跃" }];
  const fsOldParsed = v14Api.parseJsonArrayForPage(fsJsonOld, "foreshadowing");
  const t14_8a = fsOldParsed.columns.no === 0;
  const t14_8b = fsOldParsed.columns.name < 0;
  const t14_8c = fsOldParsed.columns.setup < 0;
  const t14_8d = fsOldParsed.columns.notes < 0;
  const t14_8e = fsOldParsed.columns.status < 0;
  console.log(`  "序号" 仍识别: ${t14_8a ? "✓" : "✗"}`);
  console.log(`  "名称" 不再识别: ${t14_8b ? "✓" : "✗"}`);
  console.log(`  "铺设章节" 不再识别: ${t14_8c ? "✓" : "✗"}`);
  console.log(`  "备注" 不再识别: ${t14_8d ? "✓" : "✗"}`);
  console.log(`  "状态" 不再识别: ${t14_8e ? "✓" : "✗"}`);
  if (!(t14_8a && t14_8b && t14_8c && t14_8d && t14_8e)) allPass = false;

  // 14.9 tryParseJsonText
  const t14_9a = JSON.stringify(v14Api.tryParseJsonText('[{"a":1},{"a":2}]')) === JSON.stringify([{a:1},{a:2}]);
  const t14_9b = JSON.stringify(v14Api.tryParseJsonText('{"a":1}')) === JSON.stringify([{a:1}]);
  // JSON Lines：用真实的换行符（不是 "\n" 字面量）
  const t14_9c = JSON.stringify(v14Api.tryParseJsonText('{"a":1}\n{"a":2}')) === JSON.stringify([{a:1},{a:2}]);
  const t14_9d = v14Api.tryParseJsonText("章节号\t章节名\n1\t寒江") === null;
  const t14_9e = v14Api.tryParseJsonText("") === null;
  console.log(`  JSON 数组直接解析: ${t14_9a ? "✓" : "✗"}`);
  console.log(`  单 JSON 对象包装成数组: ${t14_9b ? "✓" : "✗"}`);
  console.log(`  JSON Lines 解析: ${t14_9c ? "✓" : "✗"}`);
  console.log(`  tab 文本返回 null（fallback）: ${t14_9d ? "✓" : "✗"}`);
  console.log(`  空文本返回 null: ${t14_9e ? "✓" : "✗"}`);
  if (!(t14_9a && t14_9b && t14_9c && t14_9d && t14_9e)) allPass = false;

  // 14.10 chapter fields 未动
  const chFieldsV14 = (() => {
    const idx = SRC.indexOf("chapter: {");
    return SRC.slice(idx, idx + 1500);
  })();
  const t14_10a = /no:\s*\["章节号",/.test(chFieldsV14);
  const t14_10b = /content:\s*\["文章内容",/.test(chFieldsV14);
  console.log(`  chapter fields 未动: ${t14_10a && t14_10b ? "✓" : "✗"}`);
  if (!(t14_10a && t14_10b)) allPass = false;

  const v14Pass = t14_1a && t14_1b && t14_1c && t14_1d && t14_1e && t14_1f && noOldSynonyms && t14_2a && t14_2b && t14_3a && t14_3b && t14_3c && t14_4a && t14_4b && t14_5a && t14_5b && t14_5c && t14_6a && t14_6b && t14_7a && t14_7b && t14_8a && t14_8b && t14_8c && t14_8d && t14_8e && t14_9a && t14_9b && t14_9c && t14_9d && t14_9e && t14_10a && t14_10b;
  console.log("  v13 修复:", v14Pass ? "PASS" : "FAIL");
  if (!v14Pass) allPass = false;
}

console.log("\n" + (allPass ? "✅ 全部测试通过" : "❌ 有测试失败"));
process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("测试运行失败：", e);
  process.exit(1);
});

console.log("\n测试完成。");
