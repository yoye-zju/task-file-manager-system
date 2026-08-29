/**
 * 健康度检查测试公共桩（R2.7）
 *
 * 方法论（沿用 R2.6 已验证的做法）：
 *   从 app.js 里按大括号配对**提取真实函数源码**，用 new Function 注入桩依赖后执行。
 *   绝不在测试里重写一份逻辑——那样只是自测自己，改坏了照样绿灯。
 *
 * 被测函数依赖的外部符号：
 *   tasks / nextId（可变，修复动作会写 nextId）
 *   TYPE_LABELS / statusMap / PRIORITY_VALID / SEVERITY_ORDER / ALLOWED_PARENTS
 *   isArchivedOf / makeTimestamp / rebuildChildren / shortTitle
 */
const fs = require('fs');
const path = require('path');

const APP_PATH = path.join(__dirname, 'app.js');
const src = fs.readFileSync(APP_PATH, 'utf8');

/** 按大括号配对提取一个完整函数声明的源码 */
function extractFunction(source, signature) {
  const startIdx = source.indexOf(signature);
  if (startIdx === -1) throw new Error('找不到函数签名：' + signature);
  let depth = 0, started = false, endIdx = -1;
  for (let i = startIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { endIdx = i + 1; break; } }
  }
  if (endIdx === -1) throw new Error('大括号未配对：' + signature);
  return source.slice(startIdx, endIdx);
}

const SRC_CHECK = extractFunction(src, 'function checkHierarchyHealth(');
const SRC_REBUILD = extractFunction(src, 'function rebuildChildren(');
const SRC_ISARCHIVED = extractFunction(src, 'function isArchivedOf(');

// ── 从 app.js 里取真实常量定义，避免测试和实现两套表 ──
function grabConst(name) {
  const re = new RegExp('const ' + name + '\\s*=\\s*([\\s\\S]*?);\\n');
  const m = src.match(re);
  if (!m) throw new Error('找不到常量：' + name);
  return m[1];
}

const ENV_PREAMBLE = `
  const TYPE_LABELS = ${grabConst('TYPE_LABELS')};
  const statusMap = ${grabConst('statusMap')};
  const PRIORITY_VALID = ${grabConst('PRIORITY_VALID')};
  const SEVERITY_ORDER = ${grabConst('SEVERITY_ORDER')};
  const ALLOWED_PARENTS = ${grabConst('ALLOWED_PARENTS')};
  ${SRC_ISARCHIVED}
  ${SRC_REBUILD}
  function shortTitle(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n) + '…' : t; }
  let __ts = 20260801000000;
  function makeTimestamp() { return ++__ts; }
`;

/**
 * 创建一个隔离的检查环境。
 * @param {Array} taskList 待检数据（会被修复动作原地修改）
 * @param {number} startNextId
 * @returns {{ check: Function, getNextId: Function, getTasks: Function }}
 */
function createEnv(taskList, startNextId) {
  const factory = new Function('__initTasks', '__initNextId', `
    ${ENV_PREAMBLE}
    let tasks = __initTasks;
    let nextId = __initNextId;
    ${SRC_CHECK}
    return {
      check: function (list) { return checkHierarchyHealth(list); },
      getNextId: function () { return nextId; },
      getTasks: function () { return tasks; },
      rebuild: function () { return rebuildChildren(tasks); }
    };
  `);
  return factory(taskList, startNextId === undefined ? 1000 : startNextId);
}

// ── 断言工具 ──
let passed = 0, failed = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; failures.push(msg); console.log('  ✗ ' + msg); }
}

/** 断言存在某 code 的问题，返回该 issue（供后续检查 fix） */
function hasCode(issues, code, msg) {
  const found = issues.filter(i => i.code === code);
  ok(found.length > 0, msg || `应报告 ${code}（实际 codes: ${issues.map(i => i.code).join(',') || '无'}）`);
  return found[0] || null;
}

/** 断言不存在某 code（负例，防误报） */
function noCode(issues, code, msg) {
  const found = issues.filter(i => i.code === code);
  ok(found.length === 0, msg || `不应报告 ${code}，但实际报了 ${found.length} 条`);
}

/** 断言某 issue 的 severity */
function severityIs(iss, sev, label) {
  ok(iss && iss.severity === sev, `${label} 的 severity 应为 ${sev}，实际 ${iss ? iss.severity : '(未找到)'}`);
}

function report(title) {
  console.log('');
  console.log('─'.repeat(56));
  console.log(`${title}：${passed} 通过 / ${failed} 失败`);
  if (failed) {
    console.log('失败明细：');
    failures.forEach(f => console.log('  · ' + f));
  }
  console.log('─'.repeat(56));
  return failed === 0;
}

/** 构造一份最小合法数据：Object → KR → Target → Task，用于负例基线 */
function cleanFixture() {
  const list = [
    { id: 1, type: 'object', parentId: null, children: [2], title: '目标A', priority: '重要不紧急', status: 'progress', progress: 50, deadline: '2026-12-31', startDate: '2026-01-01', deps: [], next: [], isArchived: false, timestamp: 20260101000001 },
    { id: 2, type: 'kr',     parentId: 1,    children: [3], title: 'KR1',   priority: '重要不紧急', status: 'progress', progress: 50, deadline: '2026-11-30', startDate: '2026-01-01', deps: [], next: [], isArchived: false, timestamp: 20260101000002 },
    { id: 3, type: 'target', parentId: 2,    children: [4], title: '子目标1', priority: '紧急不重要', status: 'progress', progress: 50, deadline: '2026-10-31', startDate: '2026-02-01', deps: [], next: [], isArchived: false, timestamp: 20260101000003 },
    { id: 4, type: 'task',   parentId: 3,    children: [],  title: '任务1',  priority: '紧急不重要', status: 'progress', progress: 50, deadline: '2026-09-30', startDate: '2026-03-01', deps: [], next: [], isArchived: false, timestamp: 20260101000004 }
  ];
  return list;
}

module.exports = {
  src, extractFunction, createEnv, cleanFixture,
  ok, hasCode, noCode, severityIs, report,
  counters: () => ({ passed, failed })
};
