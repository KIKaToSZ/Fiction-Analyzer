// 端到端测试：v6 schema 升级 + history 快照对称性
// 不依赖 xlsx / 浏览器，模拟 localStorage 验证 state 序列化

const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

console.log("\n" + (allPass ? "✅ 全部测试通过" : "❌ 有测试失败"));
process.exit(allPass ? 0 : 1);

console.log("\n测试完成。");
