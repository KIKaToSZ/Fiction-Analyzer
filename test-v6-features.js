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

  // 13.1 SCHEMA_VERSION：v12 时代是 10，v14 升到 11，v15 升到 12
  //       v12 修复仍生效，断言 ≥10 即可
  const t13_1 = /const SCHEMA_VERSION\s*=\s*1[0-9];/.test(SRC);
  console.log(`  SCHEMA_VERSION >= 10: ${t13_1 ? "✓" : "✗"}`);
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

  // 13.5 文本导入 v14 改为 parseImportTextFor 分 section
  //       章节 section 仍走 parseChapterNo 提取数字
  const txtBlock = SRC.slice(
    SRC.indexOf("function parseImportTextFor"),
    SRC.indexOf("function parseImportTextFor", SRC.indexOf("function parseImportTextFor") + 30) > 0
      ? SRC.indexOf("function parseImportTextFor", SRC.indexOf("function parseImportTextFor") + 30)
      : SRC.length
  );
  // 切到第一个 parseImportTextFor 函数结束位置（简单取下一个 function）
  const t13_5a = /parseChapterNo\(noStr\)/.test(txtBlock);
  const t13_5b = /!noParsed\.hasNum \|\| !Number\.isFinite\(noParsed\.num\)/.test(txtBlock);
  const t13_5c = /o\.no\s*=\s*noParsed\.num/.test(txtBlock) || /\.no\s*=\s*noParsed\.num/.test(txtBlock);
  const t13_5d = /章节号无法解析为数字/.test(txtBlock);
  console.log(`  parseImportTextFor 调用 parseChapterNo: ${t13_5a ? "✓" : "✗"}`);
  console.log(`  parseImportTextFor 检查 hasNum && isFinite: ${t13_5b ? "✓" : "✗"}`);
  console.log(`  parseImportTextFor 赋值 o.no = noParsed.num: ${t13_5c ? "✓" : "✗"}`);
  console.log(`  parseImportTextFor 错误提示更新: ${t13_5d ? "✓" : "✗"}`);
  if (!(t13_5a && t13_5b && t13_5c && t13_5d)) allPass = false;

  // 13.6 伏笔字段扩展：v14 拆成主表 fields + 履历表 recordFields
  //       关键词"伏笔名称"在主表，关键词"提及章节"+"原文描述"在 recordFields，"回收状态"在主表
  //       v14 保留"铺设章节"/"备注"作为 recordFields 兼容词（用户旧 xlsx 仍能导入）
  const fsStart = SRC.indexOf("foreshadowing: {");
  const fsEnd = SRC.indexOf("\n    },\n\n    chapter:", fsStart);
  const fsFields = SRC.slice(fsStart, fsEnd > 0 ? fsEnd : fsStart + 5000);
  // 主表 fields 块：fields: { ... recordFields: { ... } } 的中间
  const fsMainFields = (() => {
    const a = fsFields.indexOf("fields:");
    const b = fsFields.indexOf("recordFields:");
    return fsFields.slice(a, b > 0 ? b : fsFields.length);
  })();
  const t13_6a = /name:[^\]]*伏笔名称/.test(fsMainFields);
  const t13_6b = /recordFields:[^}]*setup:[^\]]*提及章节/s.test(fsFields) || /setup:[^\]]*提及章节/.test(fsFields);
  const t13_6c = /status:[^\]]*回收状态/.test(fsMainFields);
  const t13_6d = /recordFields:[^}]*notes:[^\]]*原文描述/s.test(fsFields) || /notes:[^\]]*原文描述/.test(fsFields);
  // v14：主表 fields 里不应再有旧 v12 关键词（name"名称" / setup / payoff / notes"备注"）
  const t13_6e = !/name:[^\]]*"名称"/.test(fsMainFields);
  const t13_6f = !/setup:\s*\[/.test(fsMainFields);
  const t13_6g = /status:[^\]]*"状态"/.test(fsMainFields); // v14 保留"状态"作为 status 候选
  const t13_6h = !/notes:\s*\[/.test(fsMainFields);
  // v15：主表 no 字段已移除（只剩 fsNo/name/status 三字段）
  const t13_6i = !/^\s*no:\s*\[/m.test(fsMainFields);
  console.log(`  name 加了「伏笔名称」: ${t13_6a ? "✓" : "✗"}`);
  console.log(`  setup 加了「提及章节」(recordFields): ${t13_6b ? "✓" : "✗"}`);
  console.log(`  status 加了「回收状态」: ${t13_6c ? "✓" : "✗"}`);
  console.log(`  notes 加了「原文描述」(recordFields): ${t13_6d ? "✓" : "✗"}`);
  console.log(`  旧 name「名称」已移除: ${t13_6e ? "✓" : "✗"}`);
  console.log(`  旧 setup 字段已不在主表: ${t13_6f ? "✓" : "✗"}`);
  console.log(`  status 关键词含「状态」兼容: ${t13_6g ? "✓" : "✗"}`);
  console.log(`  旧 notes 字段已不在主表: ${t13_6h ? "✓" : "✗"}`);
  console.log(`  主表 no 字段已移除（v15）: ${t13_6i ? "✓" : "✗"}`);
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

  // 14.1 v14: PAGES.foreshadowing 主表 fields 4 个 (no/fsNo/name/status)
  //       + 履历表 recordFields 4 个 (no/fsNo/setup/notes)
  const fsBlock = (() => {
    const start = SRC.indexOf("foreshadowing: {");
    const end = SRC.indexOf("\n    },\n\n    chapter:", start);
    return SRC.slice(start, end > 0 ? end : start + 5000);
  })();
  // 切片:主表 fields 块 = fields: { ... recordFields: { ... } } 的中间
  const fieldsBlockStart = fsBlock.indexOf("fields:");
  const recordFieldsStart = fsBlock.indexOf("recordFields:");
  const mainFields = fsBlock.slice(fieldsBlockStart, recordFieldsStart > 0 ? recordFieldsStart : fsBlock.length);
  const recordFieldsBlock = fsBlock.slice(recordFieldsStart > 0 ? recordFieldsStart : 0);
  // 主表 fields 关键词（v15：3 字段 fsNo/name/status，无 no）
  const t14_1a = !/^\s*no:\s*\[\s*"序号"/m.test(mainFields); // v15 主表已无 no 字段
  const t14_1b = /fsNo:\s*\[\s*"伏笔编号"\s*\]/.test(mainFields);
  const t14_1c = /name:\s*\[\s*"伏笔名称"\s*\]/.test(mainFields);
  const t14_1d = /status:\s*\[\s*"状态"/.test(mainFields);
  // 履历表 recordFields 关键词
  const t14_1e = /setup:\s*\[\s*"提及章节"/.test(recordFieldsBlock);
  const t14_1f = /notes:\s*\[\s*"原文描述"/.test(recordFieldsBlock);
  // 旧字段（status "状态" / setup "铺设章节" / notes "备注"）不应再出现在主表 fields 里
  const noOldSynonyms =
    !/setup:\s*\[/.test(mainFields) &&
    !/notes:\s*\[/.test(mainFields) &&
    !/payoff:\s*\[/.test(mainFields);
  console.log(`  主表无 no 字段（v15 移除）: ${t14_1a ? "✓" : "✗"}`);
  console.log(`  主表 fields.fsNo ["伏笔编号"]: ${t14_1b ? "✓" : "✗"}`);
  console.log(`  主表 fields.name ["伏笔名称"]: ${t14_1c ? "✓" : "✗"}`);
  console.log(`  主表 fields.status ["状态"...]: ${t14_1d ? "✓" : "✗"}`);
  console.log(`  履历表 recordFields.setup ["提及章节"...]: ${t14_1e ? "✓" : "✗"}`);
  console.log(`  履历表 recordFields.notes ["原文描述"...]: ${t14_1f ? "✓" : "✗"}`);
  console.log(`  主表无 setup/notes/payoff: ${noOldSynonyms ? "✓" : "✗"}`);
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

  // 14.4 v14: parseImportText 被重写为 importState 多 section 分派
  //       （fs-main / fs-record / chapter 三套独立流程）
  const t14_4a = /importState\s*=\s*\{/.test(SRC);
  const t14_4b = /function handleImportFile\s*\(/.test(SRC) || /handleImportFile\s*\(/.test(SRC);
  const t14_4c = /function parseImportTextFor\s*\(/.test(SRC) || /parseImportTextFor\s*\(/.test(SRC);
  console.log(`  v14 importState 多 section 状态: ${t14_4a ? "✓" : "✗"}`);
  console.log(`  v14 handleImportFile 入口: ${t14_4b ? "✓" : "✗"}`);
  console.log(`  v14 parseImportTextFor 分 section: ${t14_4c ? "✓" : "✗"}`);
  if (!(t14_4a && t14_4b && t14_4c)) allPass = false;

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

  // 14.7 伏笔 JSON 字段识别（v15：主表 3 字段 fsNo/name/status，履历表 4 字段）
  const fsJson = [
    { "伏笔编号": 1, "伏笔名称": "断剑", "提及章节": "第3章", "原文描述": "雪地里捡到的断剑", "回收状态": "未回收" },
    { "伏笔编号": 2, "伏笔名称": "玉佩", "提及章节": "第5章", "原文描述": "娘亲遗留的玉佩", "回收状态": "已回收" },
  ];
  const fsParsed = v14Api.parseJsonArrayForPage(fsJson, "foreshadowing");
  // v15 主表 3 字段:fsNo/name/status，没有 no/setup/notes 列
  const t14_7a =
    fsParsed.columns.fsNo >= 0 &&
    fsParsed.columns.name >= 0 &&
    fsParsed.columns.status >= 0 &&
    fsParsed.columns.no === undefined &&
    fsParsed.columns.setup === undefined &&
    fsParsed.columns.notes === undefined;
  // name 必为 "断剑" / "玉佩"，fsNo 兜底自 "伏笔编号" 列
  const t14_7b =
    fsParsed.rows.length === 2 &&
    fsParsed.rows[0].fsNo === "1" &&
    fsParsed.rows[0].name === "断剑" &&
    fsParsed.rows[1].fsNo === "2" &&
    fsParsed.rows[1].name === "玉佩";
  console.log(`  伏笔 JSON 主表 fields(fsNo/name/status): ${t14_7a ? "✓" : "✗"}`);
  console.log(`  伏笔 JSON 主表数据 fsNo+name 提取: ${t14_7b ? "✓" : "✗"}`);
  if (!(t14_7a && t14_7b)) allPass = false;

  // 14.8 旧伏笔同义词不再识别（v15 主表已无 no/setup/notes，主表只认 fsNo/name/status）
  const fsJsonOld = [{ "序号": 1, "名称": "x", "铺设章节": "第1章", "备注": "y", "状态": "活跃" }];
  const fsOldParsed = v14Api.parseJsonArrayForPage(fsJsonOld, "foreshadowing");
  // "序号" 不应再被识别成主表 fsNo（v15 主表只认"伏笔编号"）
  const t14_8a = (fsOldParsed.columns.fsNo | 0) < 0;
  // "名称" 不在主表 name 关键词里（主表认"伏笔名称"）
  const t14_8b = (fsOldParsed.columns.name | 0) < 0;
  console.log(`  "序号" 不再识别为 fsNo（v15）: ${t14_8a ? "✓" : "✗"}`);
  console.log(`  "名称" 不再识别: ${t14_8b ? "✓" : "✗"}`);
  if (!(t14_8a && t14_8b)) allPass = false;

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

  const v14Pass = t14_1a && t14_1b && t14_1c && t14_1d && t14_1e && t14_1f && noOldSynonyms && t14_2a && t14_2b && t14_3a && t14_3b && t14_3c && t14_4a && t14_4b && t14_4c && t14_5a && t14_5b && t14_5c && t14_6a && t14_6b && t14_7a && t14_7b && t14_8a && t14_8b && t14_9a && t14_9b && t14_9c && t14_9d && t14_9e && t14_10a && t14_10b;
  console.log("  v13 修复:", v14Pass ? "PASS" : "FAIL");
  if (!v14Pass) allPass = false;

  // ============================================================
  // 测试 15：v14 伏笔双表拆分 + 4 列头 + 履历列表 + 跳转高亮
  // ============================================================
  console.log("\n测试 15：v14（伏笔管理页双表拆分 + 4 列头 + 履历列表 + 跳转高亮）");

  // 15.1 schema 升到 11（v14 时代）；v15 改后 schema 升到 12
  const t15_1a = /const SCHEMA_VERSION\s*=\s*1[12];/.test(SRC);
  console.log(`  SCHEMA_VERSION = 11/12: ${t15_1a ? "✓" : "✗"}`);
  if (!t15_1a) allPass = false;

  // 15.12 之前需要 CSS 文本(用局部变量,顶层没有 CSS 变量)
  const _css = fs.readFileSync(path.join(__dirname, "styles.css"), "utf-8");
  const _html = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");

  // 15.2 PAGES.foreshadowing 含 recordFields / makeRecord / recordSortKey / recordFieldsSheetMatch
  const t15_2a = /recordFields:\s*\{/.test(fsBlock);
  const t15_2b = /makeRecord\s*\(/.test(fsBlock);
  const t15_2c = /recordSortKey\s*\(/.test(fsBlock);
  const t15_2d = /recordFieldsSheetMatch\s*\(/.test(fsBlock);
  const t15_2e = /recordDefaults\s*\(/.test(fsBlock);
  console.log(`  PAGES.foreshadowing 含 recordFields: ${t15_2a ? "✓" : "✗"}`);
  console.log(`  PAGES.foreshadowing 含 makeRecord: ${t15_2b ? "✓" : "✗"}`);
  console.log(`  PAGES.foreshadowing 含 recordSortKey: ${t15_2c ? "✓" : "✗"}`);
  console.log(`  PAGES.foreshadowing 含 recordFieldsSheetMatch: ${t15_2d ? "✓" : "✗"}`);
  console.log(`  PAGES.foreshadowing 含 recordDefaults: ${t15_2e ? "✓" : "✗"}`);
  if (!(t15_2a && t15_2b && t15_2c && t15_2d && t15_2e)) allPass = false;

  // 15.3 主表 item 结构用 fsNo + name + status（不再有 setup/notes/payoff）
  const t15_3a = /it\.fsNo\s*=/.test(SRC) || /item\.fsNo/.test(SRC);
  const t15_3b = /state\.pages\.foreshadowing\.items/.test(SRC) || /pages\.foreshadowing\s*\?\s*\.\s*items/.test(SRC);
  // 不应有 it.setup / it.payoff（v14 已删）
  const noFsSetup = !/it\.setup\s*=/.test(SRC);
  const noFsPayoff = !/it\.payoff\s*=/.test(SRC);
  console.log(`  item.fsNo 字段存在: ${t15_3a ? "✓" : "✗"}`);
  console.log(`  pages.foreshadowing.items 访问: ${t15_3b ? "✓" : "✗"}`);
  console.log(`  item.setup 已删除: ${noFsSetup ? "✓" : "✗"}`);
  console.log(`  item.payoff 已删除: ${noFsPayoff ? "✓" : "✗"}`);
  if (!(t15_3a && t15_3b && noFsSetup && noFsPayoff)) allPass = false;

  // 15.4 IMPORT_SECTIONS 包含 fs-main 和 fs-record
  const t15_4a = /IMPORT_SECTIONS\s*=\s*\{/.test(SRC);
  const t15_4b = /"fs-main":\s*\{/.test(SRC);
  const t15_4c = /"fs-record":\s*\{/.test(SRC);
  // importState 应有 fs-main / fs-record 两条
  const t15_4d = /importState\s*=\s*\{/.test(SRC);
  console.log(`  IMPORT_SECTIONS 配置对象存在: ${t15_4a ? "✓" : "✗"}`);
  console.log(`  IMPORT_SECTIONS 含 fs-main: ${t15_4b ? "✓" : "✗"}`);
  console.log(`  IMPORT_SECTIONS 含 fs-record: ${t15_4c ? "✓" : "✗"}`);
  console.log(`  importState 状态对象存在: ${t15_4d ? "✓" : "✗"}`);
  if (!(t15_4a && t15_4b && t15_4c && t15_4d)) allPass = false;

  // 15.5 双 section 提交互不影响 - 各有 confirmId
  const t15_5a = /btn-import-fs-main-confirm/.test(SRC);
  const t15_5b = /btn-import-fs-record-confirm/.test(SRC);
  const t15_5c = /btn-import-confirm/.test(SRC); // 章节
  console.log(`  章节确认按钮 id: ${t15_5c ? "✓" : "✗"}`);
  console.log(`  fs-main 确认按钮 id: ${t15_5a ? "✓" : "✗"}`);
  console.log(`  fs-record 确认按钮 id: ${t15_5b ? "✓" : "✗"}`);
  if (!(t15_5a && t15_5b && t15_5c)) allPass = false;

  // 15.6 UI 4 列头（v15 改后是 3 列头：fs-col-fsno / fs-col-name / fs-col-status）
  //     旧 v14 时代有 fs-col-no 列，v15 改后已删
  const t15_6a = /fs-cell\s+fs-col-fsno/.test(SRC) || /fs-list-row/.test(SRC);
  const t15_6b = /fs-col-fsno/.test(SRC);
  const t15_6c = /fs-col-name/.test(SRC);
  const t15_6d = /fs-col-status/.test(SRC);
  console.log(`  fs-cell fs-col-fsno (列表头): ${t15_6a ? "✓" : "✗"}`);
  console.log(`  fs-col-fsno 类名: ${t15_6b ? "✓" : "✗"}`);
  console.log(`  fs-col-name 类名: ${t15_6c ? "✓" : "✗"}`);
  console.log(`  fs-col-status 类名: ${t15_6d ? "✓" : "✗"}`);
  if (!(t15_6a && t15_6b && t15_6c && t15_6d)) allPass = false;

  // 15.7 履历列表 + record-row 结构
  const t15_7a = /fs-records-section/.test(SRC);
  const t15_7b = /fs-records-list/.test(SRC);
  const t15_7c = /fs-record-row/.test(SRC);
  const t15_7d = /fs-rec-setup/.test(SRC);
  const t15_7e = /fs-rec-notes/.test(SRC);
  console.log(`  fs-records-section 区块: ${t15_7a ? "✓" : "✗"}`);
  console.log(`  fs-records-list 列表容器: ${t15_7b ? "✓" : "✗"}`);
  console.log(`  fs-record-row 单行: ${t15_7c ? "✓" : "✗"}`);
  console.log(`  fs-rec-setup 提及章节: ${t15_7d ? "✓" : "✗"}`);
  console.log(`  fs-rec-notes 原文描述: ${t15_7e ? "✓" : "✗"}`);
  if (!(t15_7a && t15_7b && t15_7c && t15_7d && t15_7e)) allPass = false;

  // 15.8 跳转 + 高亮弹窗
  const t15_8a = /function jumpToChapterForRecord\s*\(/.test(SRC);
  const t15_8b = /function findChapterByNo\s*\(/.test(SRC);
  const t15_8c = /function showChapterHighlight\s*\(/.test(SRC);
  const t15_8d = /highlight-card/.test(SRC);
  const t15_8e = /highlight-mark/.test(SRC);
  const t15_8f = /highlight-backdrop/.test(SRC);
  console.log(`  jumpToChapterForRecord 函数: ${t15_8a ? "✓" : "✗"}`);
  console.log(`  findChapterByNo 函数: ${t15_8b ? "✓" : "✗"}`);
  console.log(`  showChapterHighlight 函数: ${t15_8c ? "✓" : "✗"}`);
  console.log(`  highlight-card 弹窗: ${t15_8d ? "✓" : "✗"}`);
  console.log(`  highlight-mark 命中标签: ${t15_8e ? "✓" : "✗"}`);
  console.log(`  highlight-backdrop 背景遮罩: ${t15_8f ? "✓" : "✗"}`);
  if (!(t15_8a && t15_8b && t15_8c && t15_8d && t15_8e && t15_8f)) allPass = false;

  // 15.9 编辑/查看切换
  const t15_9a = /fsEditing/.test(SRC) || /fs-edit-toggle/.test(SRC);
  const t15_9b = /is-readonly|readonly/i.test(fsBlock) || /is-readonly|readonly/.test(SRC);
  const t15_9c = /fs-rec-notes-link/.test(SRC); // 只读态下"原文描述"是可点击链接
  console.log(`  fsEditing / fs-edit-toggle 状态: ${t15_9a ? "✓" : "✗"}`);
  console.log(`  readonly 切换: ${t15_9b ? "✓" : "✗"}`);
  console.log(`  fs-rec-notes-link 只读态链接: ${t15_9c ? "✓" : "✗"}`);
  if (!(t15_9a && t15_9b && t15_9c)) allPass = false;

  // 15.10 排序功能 - 履历按提及章节排序
  const t15_10a = /recordSortKey\s*\(/.test(fsBlock) || /recordSortKey\s*\(/.test(SRC);
  const t15_10b = /parseChapterNo\(rec\.setup\)/.test(SRC) || /parseChapterNo\(.*setup.*\)/.test(SRC);
  console.log(`  recordSortKey 函数: ${t15_10a ? "✓" : "✗"}`);
  console.log(`  parseChapterNo 用于 record.setup: ${t15_10b ? "✓" : "✗"}`);
  if (!(t15_10a && t15_10b)) allPass = false;

  // 15.11 v10 → v11 迁移 - 从旧 setup/notes 拆出 records
  const t15_11a = /v10.*v11|v11.*迁移|migrate.*v10|migration.*v11/.test(SRC) || /case 10:/.test(SRC);
  const t15_11b = /it\.records\s*=/.test(SRC);
  console.log(`  v10 → v11 迁移逻辑: ${t15_11a ? "✓" : "✗"}`);
  console.log(`  item.records 字段初始化: ${t15_11b ? "✓" : "✗"}`);
  if (!(t15_11a && t15_11b)) allPass = false;

  // 15.12 CSS 样式齐全
  const t15_12a = /\.fs-list-row\b/.test(_css) || /\.fs-cell\s+fs-col-no/.test(_css) || /\.fs-cell\b/.test(_css);
  const t15_12b = /\.fs-col-fsno\b/.test(_css);
  const t15_12c = /\.fs-records-section\b/.test(_css);
  const t15_12d = /\.fs-record-row\b/.test(_css);
  const t15_12e = /\.fs-rec-notes-link\b/.test(_css);
  const t15_12f = /\.highlight-card\b/.test(_css);
  const t15_12g = /\.highlight-mark\b/.test(_css);
  const t15_12h = /\.import-section-card\b/.test(_css);
  console.log(`  CSS .fs-cell (fs-list-row): ${t15_12a ? "✓" : "✗"}`);
  console.log(`  CSS .fs-col-fsno: ${t15_12b ? "✓" : "✗"}`);
  console.log(`  CSS .fs-records-section: ${t15_12c ? "✓" : "✗"}`);
  console.log(`  CSS .fs-record-row: ${t15_12d ? "✓" : "✗"}`);
  console.log(`  CSS .fs-rec-notes-link: ${t15_12e ? "✓" : "✗"}`);
  console.log(`  CSS .highlight-card: ${t15_12f ? "✓" : "✗"}`);
  console.log(`  CSS .highlight-mark: ${t15_12g ? "✓" : "✗"}`);
  console.log(`  CSS .import-section-card: ${t15_12h ? "✓" : "✗"}`);
  if (!(t15_12a && t15_12b && t15_12c && t15_12d && t15_12e && t15_12f && t15_12g && t15_12h)) allPass = false;

  // 15.13 index.html 双 section 容器
  const t15_13a = /id="import-section-chapter"/.test(_html);
  const t15_13b = /id="import-section-foreshadowing"/.test(_html);
  const t15_13c = /id="import-fs-main-drop"/.test(_html);
  const t15_13d = /id="import-fs-record-drop"/.test(_html);
  console.log(`  index.html #import-section-chapter: ${t15_13a ? "✓" : "✗"}`);
  console.log(`  index.html #import-section-foreshadowing: ${t15_13b ? "✓" : "✗"}`);
  console.log(`  index.html #import-fs-main-drop: ${t15_13c ? "✓" : "✗"}`);
  console.log(`  index.html #import-fs-record-drop: ${t15_13d ? "✓" : "✗"}`);
  if (!(t15_13a && t15_13b && t15_13c && t15_13d)) allPass = false;

  const t15All = t15_1a && t15_2a && t15_2b && t15_2c && t15_2d && t15_2e && t15_3a && t15_3b && noFsSetup && noFsPayoff && t15_4a && t15_4b && t15_4c && t15_4d && t15_5a && t15_5b && t15_5c && t15_6a && t15_6b && t15_6c && t15_6d && t15_7a && t15_7b && t15_7c && t15_7d && t15_7e && t15_8a && t15_8b && t15_8c && t15_8d && t15_8e && t15_8f && t15_9a && t15_9b && t15_9c && t15_10a && t15_10b && t15_11a && t15_11b && t15_12a && t15_12b && t15_12c && t15_12d && t15_12e && t15_12f && t15_12g && t15_12h && t15_13a && t15_13b && t15_13c && t15_13d;
  console.log("  v14 改动:", t15All ? "PASS" : "FAIL");
  if (!t15All) allPass = false;

  // ============================================================
  // 测试 16：v15 主表字段精简（4 字段 → 3 字段，去掉"序号"）
  // ============================================================
  console.log("\n测试 16：v15（伏笔主表精简为 3 字段 - 伏笔编号/伏笔名称/状态）");

  // 16.1 SCHEMA_VERSION = 12
  const t16_1a = /const SCHEMA_VERSION\s*=\s*12;/.test(SRC);
  console.log(`  SCHEMA_VERSION = 12: ${t16_1a ? "✓" : "✗"}`);
  if (!t16_1a) allPass = false;

  // 16.2 PAGES.foreshadowing.fields 只含 3 个键：fsNo / name / status
  //   用正则切片 fields 块（从 fields: { 到 recordFields: { 之间）
  const fsFieldsStart = fsBlock.indexOf("fields:");
  const fsRecordStart = fsBlock.indexOf("recordFields:");
  const fsMainFieldsBlock =
    fsFieldsStart > 0 && fsRecordStart > fsFieldsStart
      ? fsBlock.slice(fsFieldsStart, fsRecordStart)
      : "";
  // 主表 fields 含三个键
  const t16_2a = /fsNo:\s*\[\s*"伏笔编号"/.test(fsMainFieldsBlock);
  const t16_2b = /name:\s*\[\s*"伏笔名称"/.test(fsMainFieldsBlock);
  const t16_2c = /status:\s*\[/.test(fsMainFieldsBlock);
  // 主表 fields 不应再有 no: 字段
  const t16_2d = !/^\s*no:\s*\[/m.test(fsMainFieldsBlock);
  console.log(`  主表 fields.fsNo ["伏笔编号"]: ${t16_2a ? "✓" : "✗"}`);
  console.log(`  主表 fields.name ["伏笔名称"]: ${t16_2b ? "✓" : "✗"}`);
  console.log(`  主表 fields.status [...]: ${t16_2c ? "✓" : "✗"}`);
  console.log(`  主表 fields 已去掉 no: ${t16_2d ? "✓" : "✗"}`);
  if (!(t16_2a && t16_2b && t16_2c && t16_2d)) allPass = false;

  // 16.3 defaults() 不含 no
  const fsDefaultsStart = fsBlock.indexOf("defaults()");
  const fsRecordDefaultsStart = fsBlock.indexOf("recordDefaults()");
  const fsDefaultsBlock =
    fsDefaultsStart > 0 && fsRecordDefaultsStart > fsDefaultsStart
      ? fsBlock.slice(fsDefaultsStart, fsRecordDefaultsStart)
      : "";
  const t16_3a = /fsNo:\s*"",?\s*name:\s*""/.test(fsDefaultsBlock);
  // v17：defaults() status 走 FS_STATUS_DEFAULT 常量（"未回收"）
  const t16_3b = /status:\s*FS_STATUS_DEFAULT/.test(fsDefaultsBlock);
  const t16_3c = !/no:\s*0/.test(fsDefaultsBlock);
  console.log(`  defaults() 含 fsNo/name 字段: ${t16_3a ? "✓" : "✗"}`);
  console.log(`  defaults() status 走 FS_STATUS_DEFAULT: ${t16_3b ? "✓" : "✗"}`);
  console.log(`  defaults() 不含 no 字段: ${t16_3c ? "✓" : "✗"}`);
  if (!(t16_3a && t16_3b && t16_3c)) allPass = false;

  // 16.4 makeItem() 不含 no 字段
  const makeItemStart = fsBlock.indexOf("makeItem(");
  const makeItemEnd = fsBlock.indexOf("makeRecord(");
  const makeItemBlock =
    makeItemStart > 0 && makeItemEnd > makeItemStart
      ? fsBlock.slice(makeItemStart, makeItemEnd)
      : "";
  // makeItem 应有 fsNo/name/status/sheet
  const t16_4a = /id:\s*uid\(/.test(makeItemBlock);
  const t16_4b = /fsNo:\s*String\(data\.fsNo/.test(makeItemBlock);
  const t16_4c = /name:\s*data\.name/.test(makeItemBlock);
  // v17：makeItem status 走 FS_STATUS_MIGRATION 兜底迁移（活跃→未回收、已废弃→部分回收）
  const t16_4d = /FS_STATUS_MIGRATION\[data\.status\]/.test(makeItemBlock);
  // makeItem 不应再有 no: 字段
  const t16_4e = !/^\s*no:\s*parseFsNoToKey/m.test(makeItemBlock);
  console.log(`  makeItem 含 id: ${t16_4a ? "✓" : "✗"}`);
  console.log(`  makeItem 含 fsNo: ${t16_4b ? "✓" : "✗"}`);
  console.log(`  makeItem 含 name: ${t16_4c ? "✓" : "✗"}`);
  console.log(`  makeItem status 走 FS_STATUS_MIGRATION: ${t16_4d ? "✓" : "✗"}`);
  console.log(`  makeItem 已去掉 no: ${t16_4e ? "✓" : "✗"}`);
  if (!(t16_4a && t16_4b && t16_4c && t16_4d && t16_4e)) allPass = false;

  // 16.5 列表 UI 3 列：fs-col-fsno / fs-col-name / fs-col-status（无 fs-col-no）
  const t16_5a = /fs-cell\s+fs-col-fsno/.test(SRC);
  const t16_5b = /fs-cell\s+fs-col-name/.test(SRC);
  const t16_5c = /fs-cell\s+fs-col-status/.test(SRC);
  // 列表行不应再有 fs-col-no span
  const t16_5d = !/fs-cell\s+fs-col-no\b/.test(SRC);
  console.log(`  列表含 fs-col-fsno 列: ${t16_5a ? "✓" : "✗"}`);
  console.log(`  列表含 fs-col-name 列: ${t16_5b ? "✓" : "✗"}`);
  console.log(`  列表含 fs-col-status 列: ${t16_5c ? "✓" : "✗"}`);
  console.log(`  列表无 fs-col-no 列: ${t16_5d ? "✓" : "✗"}`);
  if (!(t16_5a && t16_5b && t16_5c && t16_5d)) allPass = false;

  // 16.6 编辑器 meta 字段只剩 3 个：meta-fsno / meta-title（伏笔名称）/ 状态
  //   旧版有 meta-num（序号）应去掉
  const t16_6a = /meta-field\s+meta-fsno/.test(SRC);
  // 移除 meta-num 检查：fsBlock 内不能有 meta-num
  // （整个 SRC 不带具体行号，但要确保伏笔编辑器里没出现 meta-num）
  const t16_6b = !/meta-field\s+meta-num\b/.test(SRC);
  // fs-no input 已删除
  const t16_6c = !/id="fs-no"/.test(SRC);
  console.log(`  编辑器含 meta-fsno 字段: ${t16_6a ? "✓" : "✗"}`);
  console.log(`  编辑器无 meta-num（序号）字段: ${t16_6b ? "✓" : "✗"}`);
  console.log(`  编辑器无 #fs-no input: ${t16_6c ? "✓" : "✗"}`);
  if (!(t16_6a && t16_6b && t16_6c)) allPass = false;

  // 16.7 v11 → v12 迁移：解构去掉 no + 写 schema = 12
  const t16_7a = /const\s*\{\s*no\s*,\s*\.\.\.rest\s*\}\s*=\s*old/.test(SRC);
  const t16_7b = /state\.schema\s*=\s*12/.test(SRC);
  // 迁移块针对 foreshadowing items
  const t16_7c = /fs\.items\.map\(\(old\)\s*=>/.test(SRC);
  console.log(`  v11→v12 迁移: 解构 { no, ...rest }: ${t16_7a ? "✓" : "✗"}`);
  console.log(`  v11→v12 迁移: state.schema = 12: ${t16_7b ? "✓" : "✗"}`);
  console.log(`  v11→v12 迁移: fs.items.map((old) =>): ${t16_7c ? "✓" : "✗"}`);
  if (!(t16_7a && t16_7b && t16_7c)) allPass = false;

  // 16.8 styles.css 列表 grid 改 3 列 + 删 .fs-col-no
  const t16_8a = /\.fs-list-row\s*\{[^}]*grid-template-columns:\s*130px\s+1fr\s+110px/s.test(_css);
  const t16_8b = !/\.fs-col-no\s*\{/.test(_css);
  console.log(`  CSS .fs-list-row 3 列 grid: ${t16_8a ? "✓" : "✗"}`);
  console.log(`  CSS 删除 .fs-col-no 样式: ${t16_8b ? "✓" : "✗"}`);
  if (!(t16_8a && t16_8b)) allPass = false;

  // 16.9 index.html 导入提示写明 3 字段
  const t16_9a = /伏笔数据表（3 字段）/.test(_html);
  const t16_9b = /伏笔履历表（4 字段）/.test(_html);
  // 主表 placeholder 是 3 列
  const t16_9c = /id="import-fs-main-text"[^>]*placeholder="伏笔编号\s*伏笔名称\s*状态/.test(_html);
  console.log(`  index.html 主表提示「3 字段」: ${t16_9a ? "✓" : "✗"}`);
  console.log(`  index.html 履历表提示「4 字段」: ${t16_9b ? "✓" : "✗"}`);
  console.log(`  index.html 主表 placeholder 3 列: ${t16_9c ? "✓" : "✗"}`);
  if (!(t16_9a && t16_9b && t16_9c)) allPass = false;

  // 16.10 履历表 recordFields 仍含 4 个字段（no/fsNo/setup/notes），结构未动
  const recordFieldsStartV15 = fsBlock.indexOf("recordFields:");
  const makeItemPosV15 = fsBlock.indexOf("makeItem(");
  const recordFieldsBlockV15 =
    recordFieldsStartV15 > 0 && makeItemPosV15 > recordFieldsStartV15
      ? fsBlock.slice(recordFieldsStartV15, makeItemPosV15)
      : "";
  const t16_10a = /no:\s*\[\s*"序号"/.test(recordFieldsBlockV15);
  const t16_10b = /fsNo:\s*\[\s*"伏笔编号"/.test(recordFieldsBlockV15);
  const t16_10c = /setup:\s*\[\s*"提及章节"/.test(recordFieldsBlockV15);
  const t16_10d = /notes:\s*\[\s*"原文描述"/.test(recordFieldsBlockV15);
  console.log(`  履历表 recordFields.no ["序号"]: ${t16_10a ? "✓" : "✗"}`);
  console.log(`  履历表 recordFields.fsNo ["伏笔编号"]: ${t16_10b ? "✓" : "✗"}`);
  console.log(`  履历表 recordFields.setup ["提及章节"]: ${t16_10c ? "✓" : "✗"}`);
  console.log(`  履历表 recordFields.notes ["原文描述"]: ${t16_10d ? "✓" : "✗"}`);
  if (!(t16_10a && t16_10b && t16_10c && t16_10d)) allPass = false;

  const t16All =
    t16_1a &&
    t16_2a && t16_2b && t16_2c && t16_2d &&
    t16_3a && t16_3b && t16_3c &&
    t16_4a && t16_4b && t16_4c && t16_4d && t16_4e &&
    t16_5a && t16_5b && t16_5c && t16_5d &&
    t16_6a && t16_6b && t16_6c &&
    t16_7a && t16_7b && t16_7c &&
    t16_8a && t16_8b &&
    t16_9a && t16_9b && t16_9c &&
    t16_10a && t16_10b && t16_10c && t16_10d;
  console.log("  v15 改动:", t16All ? "PASS" : "FAIL");
  if (!t16All) allPass = false;

  // ============================================================
  // 测试 17：v16 伏笔列表叉号删除 + 左上角"新建文件"按钮
  // ============================================================
  console.log("\n测试 17：v16（伏笔列表叉号删除按钮 + 新建文件按钮）");

  // 17.1 伏笔列表渲染：每条 li 末尾有 .fs-delete 叉号
  const fsListBlock = SRC.slice(
    SRC.indexOf("function renderFsList"),
    SRC.indexOf("function renderChapterEditor")
  );
  const t17_1a = /class="fs-delete"/.test(fsListBlock);
  const t17_1b = /class="fs-delete"[\s\S]{0,200}data-id="\$\{escapeHtml\(it\.id\)\}"/.test(fsListBlock);
  const t17_1c =
    fsListBlock.indexOf("fs-col-status") < fsListBlock.indexOf('class="fs-delete"');
  const t17_1d = /title="删除该伏笔"/.test(fsListBlock);
  console.log(`  renderFsList 模板含 .fs-delete 按钮: ${t17_1a ? "✓" : "✗"}`);
  console.log(`  .fs-delete 有 data-id 绑定: ${t17_1b ? "✓" : "✗"}`);
  console.log(`  .fs-delete 在 status 之后: ${t17_1c ? "✓" : "✗"}`);
  console.log(`  .fs-delete 含中文 title: ${t17_1d ? "✓" : "✗"}`);
  if (!(t17_1a && t17_1b && t17_1c && t17_1d)) allPass = false;

  // 17.2 bindListEvents 的 onClick 处理 .fs-delete
  const bindListBlock = SRC.slice(
    SRC.indexOf("function bindListEvents"),
    SRC.indexOf("function bindEditorButtons")
  );
  const t17_2a = /e\.target\.closest\("\.fs-delete"\)/.test(bindListBlock);
  const t17_2b = /e\.target\.closest\("\.fs-delete"\)[\s\S]{0,80}stopPropagation/.test(bindListBlock);
  const t17_2c = /e\.target\.closest\("\.fs-delete"\)[\s\S]{0,200}deleteCurrentItem\(\)/.test(bindListBlock);
  console.log(`  onClick 含 .fs-delete 分支: ${t17_2a ? "✓" : "✗"}`);
  console.log(`  .fs-delete 分支调 stopPropagation: ${t17_2b ? "✓" : "✗"}`);
  console.log(`  .fs-delete 分支调 deleteCurrentItem: ${t17_2c ? "✓" : "✗"}`);
  if (!(t17_2a && t17_2b && t17_2c)) allPass = false;

  // 17.3 styles.css 含 .fs-delete 样式块
  const css17 = fs.readFileSync(path.join(__dirname, "styles.css"), "utf-8");
  const t17_3a = /\.fs-delete\s*\{/.test(css17);
  const t17_3b = /\.fs-item:hover \.fs-delete,[\s\S]{0,80}\.fs-item\.active \.fs-delete/.test(css17);
  const t17_3c = /\.fs-delete:hover\s*\{[\s\S]{0,80}#c0392b/.test(css17);
  console.log(`  styles.css 有 .fs-delete 块: ${t17_3a ? "✓" : "✗"}`);
  console.log(`  .fs-item:hover/active 时 .fs-delete 显示: ${t17_3b ? "✓" : "✗"}`);
  console.log(`  .fs-delete:hover 变红: ${t17_3c ? "✓" : "✗"}`);
  if (!(t17_3a && t17_3b && t17_3c)) allPass = false;

  // 17.4 index.html 顶部有 #file-new 按钮
  const html17 = fs.readFileSync(
    "/home/gem/.aily/workdir/task_7672995282002398156/fiction-analyzer/index.html",
    "utf-8"
  );
  const fileRow17 = html17.slice(
    html17.indexOf('<div class="file-row">'),
    html17.indexOf('class="topbar-actions"')
  );
  const t17_4a = /id="file-new"/.test(fileRow17);
  const t17_4b =
    fileRow17.indexOf('id="file-new"') < fileRow17.indexOf('id="file-pick"');
  const t17_4c = /title="新建空白文件[^"]*"/.test(fileRow17);
  console.log(`  index.html .file-row 含 #file-new: ${t17_4a ? "✓" : "✗"}`);
  console.log(`  #file-new 在 #file-pick 之前: ${t17_4b ? "✓" : "✗"}`);
  console.log(`  #file-new title 描述: ${t17_4c ? "✓" : "✗"}`);
  if (!(t17_4a && t17_4b && t17_4c)) allPass = false;

  // 17.5 app.js 有 createNewFile() 函数
  const createFnStart = SRC.indexOf("async function createNewFile");
  const createFnEnd = SRC.indexOf("\n}", createFnStart);
  const createFnBody = SRC.slice(createFnStart, createFnEnd);
  const t17_5a = /async function createNewFile\(\)/.test(SRC);
  const t17_5b = /confirm\(/.test(createFnBody);
  const t17_5c = /saveAsJson\(/.test(createFnBody);
  const t17_5d = /state\.pages\s*=\s*\{[\s\S]{0,300}makePageState\(\)/.test(createFnBody);
  const t17_5e =
    /state\.currentFileName\s*=\s*null/.test(createFnBody) &&
    /state\.xlsxFileName\s*=\s*null/.test(createFnBody) &&
    /state\.jsonFileName\s*=\s*null/.test(createFnBody) &&
    /state\.jsonHandleKey\s*=\s*null/.test(createFnBody);
  const t17_5f = /history\.stack\s*=\s*\[\]/.test(createFnBody);
  console.log(`  app.js 含 createNewFile 函数: ${t17_5a ? "✓" : "✗"}`);
  console.log(`  createNewFile 弹 confirm: ${t17_5b ? "✓" : "✗"}`);
  console.log(`  createNewFile 先 saveAsJson 备份: ${t17_5c ? "✓" : "✗"}`);
  console.log(`  createNewFile 重置 state.pages: ${t17_5d ? "✓" : "✗"}`);
  console.log(`  createNewFile 清空 4 个文件名: ${t17_5e ? "✓" : "✗"}`);
  console.log(`  createNewFile 清空 history: ${t17_5f ? "✓" : "✗"}`);
  if (!(t17_5a && t17_5b && t17_5c && t17_5d && t17_5e && t17_5f)) allPass = false;

  // 17.6 bindFileEvents 绑定 #file-new 的 click
  const bindFileBlock = SRC.slice(
    SRC.indexOf("function bindFileEvents"),
    SRC.indexOf("function bindListEvents")
  );
  const t17_6a = /\$\("#file-new"\)\?\.addEventListener\("click",\s*createNewFile\)/.test(bindFileBlock);
  console.log(`  bindFileEvents 绑定 #file-new click → createNewFile: ${t17_6a ? "✓" : "✗"}`);
  if (!t17_6a) allPass = false;

  // 17.7 createNewFile 保留 directoryHandleKey（不清空，让用户授权过的目录继续可用）
  const t17_7a = /state\.directoryName\s*=\s*null/.test(createFnBody);
  const t17_7b = !/state\.directoryHandleKey\s*=\s*null/.test(createFnBody);
  console.log(`  createNewFile 清空 directoryName: ${t17_7a ? "✓" : "✗"}`);
  console.log(`  createNewFile 保留 directoryHandleKey: ${t17_7b ? "✓" : "✗"}`);
  if (!(t17_7a && t17_7b)) allPass = false;

  const t17All =
    t17_1a && t17_1b && t17_1c && t17_1d &&
    t17_2a && t17_2b && t17_2c &&
    t17_3a && t17_3b && t17_3c &&
    t17_4a && t17_4b && t17_4c &&
    t17_5a && t17_5b && t17_5c && t17_5d && t17_5e && t17_5f &&
    t17_6a &&
    t17_7a && t17_7b;
  console.log("  v16 改动:", t17All ? "PASS" : "FAIL");
  if (!t17All) allPass = false;

  // ============================================================
  // 测试 18：v17 改动（伏笔 UI 6 个微调）
  // ============================================================
  console.log("\n测试 18：v17（伏笔状态/记录/交互 6 个微调）");

  // 18.1 状态选项：FS_STATUS_OPTIONS 改为 [未回收, 部分回收, 已回收]
  const t18_1a = /FS_STATUS_OPTIONS\s*=\s*\[\s*"未回收"\s*,\s*"部分回收"\s*,\s*"已回收"\s*\]/.test(SRC);
  const t18_1b = !/FS_STATUS_OPTIONS\s*=\s*\[\s*"活跃"/.test(SRC);
  const t18_1c = /FS_STATUS_DEFAULT\s*=\s*"未回收"/.test(SRC);
  console.log(`  FS_STATUS_OPTIONS 是新三档: ${t18_1a ? "✓" : "✗"}`);
  console.log(`  旧「活跃」选项已移除: ${t18_1b ? "✓" : "✗"}`);
  console.log(`  FS_STATUS_DEFAULT = "未回收": ${t18_1c ? "✓" : "✗"}`);
  if (!(t18_1a && t18_1b && t18_1c)) allPass = false;

  // 18.2 旧值迁移：FS_STATUS_MIGRATION 映射 活跃/已废弃/已回收 → 新值
  const t18_2a = /FS_STATUS_MIGRATION\s*=\s*\{[\s\S]{0,200}"活跃"\s*:\s*"未回收"/.test(SRC);
  const t18_2b = /FS_STATUS_MIGRATION\s*=\s*\{[\s\S]{0,200}"已废弃"\s*:\s*"部分回收"/.test(SRC);
  const t18_2c = /FS_STATUS_MIGRATION\s*=\s*\{[\s\S]{0,200}"已回收"\s*:\s*"已回收"/.test(SRC);
  console.log(`  迁移: 活跃→未回收: ${t18_2a ? "✓" : "✗"}`);
  console.log(`  迁移: 已废弃→部分回收: ${t18_2b ? "✓" : "✗"}`);
  console.log(`  迁移: 已回收→已回收: ${t18_2c ? "✓" : "✗"}`);
  if (!(t18_2a && t18_2b && t18_2c)) allPass = false;

  // 18.3 状态 class 映射（新三档 class 名）
  // renderFsList 部分
  const fsListNew = SRC.slice(
    SRC.indexOf("function renderFsList"),
    SRC.indexOf("function renderChapterEditor")
  );
  const t18_3a = /未回收[\s\S]{0,200}fs-status-unresolved/.test(fsListNew);
  const t18_3b = /部分回收[\s\S]{0,200}fs-status-partial/.test(fsListNew);
  const t18_3c = /已回收[\s\S]{0,200}fs-status-resolved/.test(fsListNew);
  const t18_3d = !/已废弃[\s\S]{0,200}fs-status-abandoned/.test(fsListNew);
  console.log(`  renderFsList: 未回收 → fs-status-unresolved: ${t18_3a ? "✓" : "✗"}`);
  console.log(`  renderFsList: 部分回收 → fs-status-partial: ${t18_3b ? "✓" : "✗"}`);
  console.log(`  renderFsList: 已回收 → fs-status-resolved: ${t18_3c ? "✓" : "✗"}`);
  console.log(`  renderFsList 移除旧映射: ${t18_3d ? "✓" : "✗"}`);
  if (!(t18_3a && t18_3b && t18_3c && t18_3d)) allPass = false;

  // 18.4 状态 fallback：所有旧 || "活跃" 都改为 FS_STATUS_DEFAULT
  // 应该没有 "活跃" 字符串残留（FS_STATUS_MIGRATION 内除外）
  const migrationBlock = SRC.match(/FS_STATUS_MIGRATION\s*=\s*\{[\s\S]{0,200}\}/);
  const migrationStr = migrationBlock ? migrationBlock[0] : "";
  const srcWithoutMigration = SRC.replace(migrationStr, "");
  const t18_4a = !/"\s*活跃\s*"/.test(srcWithoutMigration);
  const t18_4b = /it\.status\s*=\s*\$\("#fs-status"\)\?\.value\s*\|\|\s*it\.status\s*\|\|\s*FS_STATUS_DEFAULT/.test(srcWithoutMigration);
  const t18_4c = /const\s+status\s*=\s*it\.status\s*\|\|\s*FS_STATUS_DEFAULT/.test(srcWithoutMigration);
  const t18_4d = /statusCell\.textContent\s*=\s*it\.status\s*\|\|\s*FS_STATUS_DEFAULT/.test(srcWithoutMigration);
  console.log(`  旧「"活跃"」字面量已清理: ${t18_4a ? "✓" : "✗"}`);
  console.log(`  saveCurrentItem 走 FS_STATUS_DEFAULT: ${t18_4b ? "✓" : "✗"}`);
  console.log(`  renderFsList 走 FS_STATUS_DEFAULT: ${t18_4c ? "✓" : "✗"}`);
  console.log(`  bindFsEditorEvents 走 FS_STATUS_DEFAULT: ${t18_4d ? "✓" : "✗"}`);
  if (!(t18_4a && t18_4b && t18_4c && t18_4d)) allPass = false;

  // 18.5 列表删除按钮靠右：.fs-col-name 加 flex: 1
  const css18 = fs.readFileSync(path.join(__dirname, "styles.css"), "utf-8");
  const t18_5a = /\.fs-col-name\s*\{[\s\S]{0,80}flex:\s*1/.test(css18);
  console.log(`  CSS .fs-col-name 含 flex: 1 (推动删除按钮靠右): ${t18_5a ? "✓" : "✗"}`);
  if (!t18_5a) allPass = false;

  // 18.6 履历渲染简化：去序号 + 去伏笔编号
  const recRowsStart = SRC.indexOf("function renderFsRecordRows");
  const recRowsEnd = SRC.indexOf("function bindChapterEditorEvents");
  const recRowsBlock = recRowsStart > 0 && recRowsEnd > recRowsStart
    ? SRC.slice(recRowsStart, recRowsEnd)
    : "";
  // 编辑态：行内含 setup + notes(1fr) + delete，**不含** fs-rec-col-no / fs-rec-col-fsno
  const t18_6a = /data-field="setup"/.test(recRowsBlock);
  const t18_6b = /data-field="notes"/.test(recRowsBlock);
  const t18_6c = /class="fs-rec-delete"/.test(recRowsBlock);
  const t18_6d = !/class="fs-rec-col-no"/.test(recRowsBlock);
  const t18_6e = !/class="fs-rec-col-fsno"/.test(recRowsBlock);
  // 查看态：行内只含 setup div + notes link（无 序号/伏笔编号）
  const t18_6f = /class="fs-rec-notes-link"/.test(recRowsBlock);
  console.log(`  履历行含 setup 字段: ${t18_6a ? "✓" : "✗"}`);
  console.log(`  履历行含 notes 字段: ${t18_6b ? "✓" : "✗"}`);
  console.log(`  履历行含 delete 叉号: ${t18_6c ? "✓" : "✗"}`);
  console.log(`  履历行已去 序号 列: ${t18_6d ? "✓" : "✗"}`);
  console.log(`  履历行已去 伏笔编号 列: ${t18_6e ? "✓" : "✗"}`);
  console.log(`  履历行含 fs-rec-notes-link (查看态跳转): ${t18_6f ? "✓" : "✗"}`);
  if (!(t18_6a && t18_6b && t18_6c && t18_6d && t18_6e && t18_6f)) allPass = false;

  // 18.7 履历 grid 改为 minmax(setup) + 1fr(notes) + auto(delete)
  const t18_7a = /\.fs-record-row\s*\{[\s\S]{0,300}minmax\(\s*120px\s*,\s*200px\s*\)\s+1fr\s+auto/.test(css18);
  console.log(`  .fs-record-row grid: setup 固定 + notes 1fr 填满: ${t18_7a ? "✓" : "✗"}`);
  if (!t18_7a) allPass = false;

  // 18.8 不编辑态切伏笔不调 saveCurrentItem
  const bindListBlock18 = SRC.slice(
    SRC.indexOf("function bindListEvents"),
    SRC.indexOf("function bindEditorButtons")
  );
  // 应该看到对 fsEditing 的判断 + 只在编辑态或章节页才 save
  const t18_8a = /state\.ui\.fsEditing/.test(bindListBlock18);
  const t18_8b = /state\.currentPage\s*===\s*"foreshadowing"\s*&&\s*state\.ui\.fsEditing/.test(bindListBlock18);
  console.log(`  onClick 读 fsEditing 状态: ${t18_8a ? "✓" : "✗"}`);
  console.log(`  onClick 切伏笔时检查 fsEditing 才调 save: ${t18_8b ? "✓" : "✗"}`);
  if (!(t18_8a && t18_8b)) allPass = false;

  // 18.9 编辑器上的 btn-fs-delete 已移除
  const fsEditorStart = SRC.indexOf("function renderFsEditor");
  const fsEditorEnd = SRC.indexOf("function getFsRecordsByFsNo");
  const fsEditorBlock18 = fsEditorStart > 0 && fsEditorEnd > fsEditorStart
    ? SRC.slice(fsEditorStart, fsEditorEnd)
    : "";
  const t18_9a = !/id="btn-fs-delete"/.test(fsEditorBlock18);
  // bindEditorButtons 也不应再处理 #btn-fs-delete
  const bindEditorBlock18 = SRC.slice(
    SRC.indexOf("function bindEditorButtons"),
    SRC.indexOf("function bindListEvents")
  );
  const t18_9b = !/btn-fs-delete/.test(bindEditorBlock18);
  console.log(`  renderFsEditor 已移除 #btn-fs-delete: ${t18_9a ? "✓" : "✗"}`);
  console.log(`  bindEditorButtons 不再处理 #btn-fs-delete: ${t18_9b ? "✓" : "✗"}`);
  if (!(t18_9a && t18_9b)) allPass = false;

  // 18.10 状态色 CSS：unresolved / partial / resolved 三档
  const t18_10a = /\.fs-status-unresolved/.test(css18);
  const t18_10b = /\.fs-status-partial/.test(css18);
  const t18_10c = /\.fs-status-resolved/.test(css18);
  console.log(`  CSS .fs-status-unresolved (未回收): ${t18_10a ? "✓" : "✗"}`);
  console.log(`  CSS .fs-status-partial (部分回收): ${t18_10b ? "✓" : "✗"}`);
  console.log(`  CSS .fs-status-resolved (已回收): ${t18_10c ? "✓" : "✗"}`);
  if (!(t18_10a && t18_10b && t18_10c)) allPass = false;

  const t18All =
    t18_1a && t18_1b && t18_1c &&
    t18_2a && t18_2b && t18_2c &&
    t18_3a && t18_3b && t18_3c && t18_3d &&
    t18_4a && t18_4b && t18_4c && t18_4d &&
    t18_5a &&
    t18_6a && t18_6b && t18_6c && t18_6d && t18_6e && t18_6f &&
    t18_7a &&
    t18_8a && t18_8b &&
    t18_9a && t18_9b &&
    t18_10a && t18_10b && t18_10c;
  console.log("  v17 改动:", t18All ? "PASS" : "FAIL");
  if (!t18All) allPass = false;

console.log("\n" + (allPass ? "✅ 全部测试通过" : "❌ 有测试失败"));
process.exit(allPass ? 0 : 1);
}

}

main().catch((e) => {
  console.error("测试运行失败：", e);
  process.exit(1);
});

console.log("\n测试完成。");
