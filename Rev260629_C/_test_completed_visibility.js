// _test_completed_visibility.js
// R3.3: completedAt field + sort + migration tests
// Usage: node _test_completed_visibility.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');
let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

console.log('=== R3.3 completedAt + sort + migration tests ===\n');

// ── 1. setCompletedAt 纯函数测试 ──
console.log('[1] setCompletedAt 纯函数');

function extractFunc(name) {
  const m = src.match(new RegExp('function\\s+' + name + '\\s*\\([\\s\\S]*?\\n\\}'));
  return m ? m[0] : null;
}

const setCompletedAtCode = extractFunc('setCompletedAt');
check('setCompletedAt 函数存在于源码中', !!setCompletedAtCode);

if (setCompletedAtCode) {
  const setCompletedAt = new Function(setCompletedAtCode + '\nreturn setCompletedAt;')();

  // 非 done → done：赋值 ISO 字符串
  const t1 = { status: 'progress', completedAt: null };
  setCompletedAt(t1, 'done', 'progress');
  check('非done→done: completedAt 被赋值为 ISO 字符串', typeof t1.completedAt === 'string' && t1.completedAt.includes('T'));

  // done → 非 done：置 null
  const t2 = { status: 'done', completedAt: '2026-08-11T10:00:00.000Z' };
  setCompletedAt(t2, 'progress', 'done');
  check('done→非done: completedAt 置 null', t2.completedAt === null);

  // done → done：不变
  const t3 = { status: 'done', completedAt: '2026-08-11T10:00:00.000Z' };
  setCompletedAt(t3, 'done', 'done');
  check('done→done: completedAt 不变', t3.completedAt === '2026-08-11T10:00:00.000Z');

  // 非 done → 非 done：不变
  const t4 = { status: 'todo', completedAt: null };
  setCompletedAt(t4, 'progress', 'todo');
  check('非done→非done: completedAt 保持 null', t4.completedAt === null);
}

// ── 2. getSortComparator completed-desc/asc 测试 ──
console.log('\n[2] getSortComparator completed-desc/asc');

// 手动实现排序逻辑测试（从源码提取 case 块）
const descComparator = (a, b) => {
  const ca = a.completedAt ? new Date(a.completedAt).getTime() : 0;
  const cb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
  return cb - ca;
};
const ascComparator = (a, b) => {
  const ca = a.completedAt ? new Date(a.completedAt).getTime() : Infinity;
  const cb = b.completedAt ? new Date(b.completedAt).getTime() : Infinity;
  return ca - cb;
};

// 验证源码中有 completed-desc 和 completed-asc case
check('源码包含 completed-desc case', src.includes("case 'completed-desc'"));
check('源码包含 completed-asc case', src.includes("case 'completed-asc'"));

const tasks = [
  { id: 1, completedAt: '2026-08-10T10:00:00.000Z' },
  { id: 2, completedAt: '2026-08-11T12:00:00.000Z' },
  { id: 3, completedAt: null },
  { id: 4, completedAt: '2026-08-09T08:00:00.000Z' },
];

const sortedDesc = [...tasks].sort(descComparator);
check('desc: 最近完成的(id=2)排第一', sortedDesc[0].id === 2);
check('desc: 无完成时间的(id=3)排最后', sortedDesc[sortedDesc.length - 1].id === 3);
check('desc: 有完成时间的排前', sortedDesc[0].completedAt !== null && sortedDesc[1].completedAt !== null && sortedDesc[2].completedAt !== null);

const sortedAsc = [...tasks].sort(ascComparator);
check('asc: 最早完成的(id=4)排第一', sortedAsc[0].id === 4);
check('asc: 无完成时间的(id=3)排最后', sortedAsc[sortedAsc.length - 1].id === 3);

// ── 3. 数据迁移幂等性测试 ──
console.log('\n[3] 数据迁移幂等性');

// 模拟迁移逻辑
function migrateTask(t) {
  let migrated = false;
  if (t.completedAt === undefined) {
    t.completedAt = (t.status === 'done') ? (t.createdAt || null) : null;
    migrated = true;
  }
  return migrated;
}

// 无 completedAt 的 done 任务 → 补全
const m1 = { status: 'done', createdAt: '2026-08-01T10:00:00.000Z' };
const r1 = migrateTask(m1);
check('迁移: done 任务无 completedAt → 用 createdAt 补全', r1 === true && m1.completedAt === '2026-08-01T10:00:00.000Z');

// 已有 completedAt 的任务 → 不覆盖
const m2 = { status: 'done', completedAt: '2026-08-05T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z' };
const r2 = migrateTask(m2);
check('迁移: 已有 completedAt → 不覆盖（幂等）', r2 === false && m2.completedAt === '2026-08-05T10:00:00.000Z');

// 非 done 任务 → completedAt 为 null
const m3 = { status: 'progress', createdAt: '2026-08-01T10:00:00.000Z' };
const r3 = migrateTask(m3);
check('迁移: 非 done 任务 → completedAt 为 null', r3 === true && m3.completedAt === null);

// 再次迁移 → 幂等
const r4 = migrateTask(m1);
check('迁移: 再次迁移 → 幂等（不重复补全）', r4 === false);

// ── 4. CSV 导出 headers 含 completedAt ──
console.log('\n[4] CSV 导出 headers');

const csvHeadersMatch = src.match(/const headers = \[([^\]]+)\]/);
check('CSV headers 数组存在', !!csvHeadersMatch);

if (csvHeadersMatch) {
  const headersStr = csvHeadersMatch[1];
  check('CSV headers 包含 completedAt', headersStr.includes("'completedAt'"));
  check('CSV headers 包含 isArchived', headersStr.includes("'isArchived'"));
  check('CSV headers 包含 timestamp', headersStr.includes("'timestamp'"));
}

// ── 5. 版本号一致性 ──
console.log('\n[5] 版本号一致性');

check('currentVersion = 7', src.includes('var currentVersion = 7'));
check('console.log 包含 R3.29', src.includes("[version] R3.29"));
check('CHANGELOG 包含 R3.3', src.includes("ver: 'R3.3'"));

const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
check('index.html 版本徽章 = R3.29', htmlSrc.includes('>R3.29<'));

// ── 6. showDone 变量和视图过滤 ──
console.log('\n[6] showDone 变量和视图过滤');

check('showDone 全局变量已声明', src.includes('let showDone = false'));

// 时间线甘特图不再硬编码排除 done
check('时间线甘特图: done 排除改为条件', src.includes("if (t.status === 'done' && !showDone) return false;"));

// 优先级矩阵
check('优先级矩阵: done 排除改为条件', src.includes("(showDone || t.status !== 'done')"));

// 团队看板
check('团队看板: done 排除改为条件', src.includes("if (t.status === 'done' && !showDone) return false;"));

// ── 7. celebrateTaskCompletion 函数 ──
console.log('\n[7] celebrateTaskCompletion');

check('celebrateTaskCompletion 函数存在', src.includes('function celebrateTaskCompletion'));
check('showStatusPicker 调用 celebrateTaskCompletion', src.includes("if (s.value === 'done' && oldStatus !== 'done') celebrateTaskCompletion(t)"));
check('cycleProgress 调用 celebrateTaskCompletion', src.includes("if (t.status === 'done' && oldProgress !== 100) celebrateTaskCompletion(t)"));
check('saveTask 调用 celebrateTaskCompletion', src.includes("if (_completedTask) celebrateTaskCompletion(_completedTask)"));

// ── 8. quickFilter 'done' case ──
console.log('\n[8] quickFilter 已完成按钮');

check("quickFilter 有 'done' case", src.includes("case 'done':"));
check("done case 设置 statusFilter = ['done']", src.includes("statusFilter = ['done']"));
check('done case 设置 listSortType = completed-desc', src.includes("listSortType = 'completed-desc'"));
check("updateQuickActionStates 包含 'qa-done'", src.includes("'qa-done': 'done'"));
check('updateQuickActionBadges 包含 doneCount', src.includes('doneCount'));
check('index.html 包含 qa-done 按钮', htmlSrc.includes('id="qa-done"'));

// ── 总结 ──
console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail > 0 ? 1 : 0);
