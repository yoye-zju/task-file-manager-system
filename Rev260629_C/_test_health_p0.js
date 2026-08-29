/**
 * P0 致命项测试（5 项）：自引用 / 环形引用 / 重复 ID / ID 非法 / type 非法
 * 每项都做「正例报告 + 修复生效 + 负例不误报」三重断言。
 */
const H = require('./_test_health_helper.js');
const { createEnv, cleanFixture, ok, hasCode, noCode, severityIs } = H;

console.log('\n=== P0 致命项（5 项）===\n');

// ── P0-1 自引用 ──
console.log('P0-1 自引用');
{
  const list = cleanFixture();
  list.push({ id: 5, type: 'task', parentId: 5, children: [], title: '自己是自己的爹', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000005 });
  const env = createEnv(list);
  const iss = hasCode(env.check(), 'SELF_PARENT');
  severityIs(iss, 'P0', 'SELF_PARENT');
  ok(iss && iss.ids.indexOf(5) !== -1, 'SELF_PARENT 的 ids 应含实体 5');
  ok(iss && iss.fix && iss.fix.kind === 'auto', 'SELF_PARENT 应可自动修复');
  iss.fix.apply();
  ok(list.find(t => t.id === 5).parentId === null, '修复后 parentId 应为 null');
  noCode(env.check(), 'SELF_PARENT', '修复后不应再报 SELF_PARENT');
}
// 负例：正常父子不误报
{
  const env = createEnv(cleanFixture());
  noCode(env.check(), 'SELF_PARENT', '正常层级不应报 SELF_PARENT');
}

// ── P0-2 环形引用 ──
console.log('P0-2 环形引用');
{
  // 5 → 6 → 7 → 5 三节点环
  const list = cleanFixture();
  list.push(
    { id: 5, type: 'task', parentId: 6, children: [], title: '环A', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000005 },
    { id: 6, type: 'task', parentId: 7, children: [], title: '环B', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000006 },
    { id: 7, type: 'task', parentId: 5, children: [], title: '环C', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000007 }
  );
  const env = createEnv(list);

  // 防死循环：必须能在合理时间内返回
  const t0 = Date.now();
  const issues = env.check();
  const cost = Date.now() - t0;
  ok(cost < 1000, `环形数据检查应快速返回（实际 ${cost}ms）`);

  const iss = hasCode(issues, 'PARENT_CYCLE');
  severityIs(iss, 'P0', 'PARENT_CYCLE');
  ok(iss && iss.ids.length === 3, `环应包含 3 个成员（实际 ${iss ? iss.ids.length : 0}）`);
  // 整环只报一条，不是每个成员报一条
  ok(issues.filter(i => i.code === 'PARENT_CYCLE').length === 1,
    `三节点环应只报 1 条（实际 ${issues.filter(i => i.code === 'PARENT_CYCLE').length} 条）`);

  iss.fix.apply();
  noCode(env.check(), 'PARENT_CYCLE', '断开一条边后环应消失');
}
// 负例：链式深层级不应误判为环
{
  const list = cleanFixture();
  list.push({ id: 5, type: 'task', parentId: 4, children: [], title: '深层任务', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000005 });
  const env = createEnv(list);
  noCode(env.check(), 'PARENT_CYCLE', '正常深层链不应报环');
}

// ── P0-3 重复 ID ──
console.log('P0-3 重复 ID');
{
  const list = cleanFixture();
  list.push({ id: 4, type: 'task', parentId: 3, children: [], title: '撞车的任务', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000009 });
  const env = createEnv(list, 1000);
  const iss = hasCode(env.check(), 'DUP_ID');
  severityIs(iss, 'P0', 'DUP_ID');
  ok(iss && iss.title.indexOf('id=4') !== -1, 'DUP_ID 标题应指明冲突的 id');
  iss.fix.apply();
  const ids = list.map(t => t.id);
  ok(new Set(ids).size === ids.length, `修复后 ID 应全部唯一（实际 ${ids.join(',')}）`);
  ok(list.filter(t => t.id === 4).length === 1, '原 id=4 应只剩一个');
  noCode(env.check(), 'DUP_ID', '修复后不应再报 DUP_ID');
}
// 负例
{
  const env = createEnv(cleanFixture());
  noCode(env.check(), 'DUP_ID', 'ID 唯一时不应报 DUP_ID');
}

// ── P0-4 ID 非法 ──
console.log('P0-4 ID 非法');
{
  const list = cleanFixture();
  list.push({ id: 'abc', type: 'task', parentId: null, children: [], title: 'ID是字符串', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000010 });
  list.push({ id: undefined, type: 'task', parentId: null, children: [], title: 'ID缺失', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000011 });
  const env = createEnv(list);
  const issues = env.check();
  ok(issues.filter(i => i.code === 'BAD_ID').length === 2, `两个非法 ID 应报 2 条（实际 ${issues.filter(i => i.code === 'BAD_ID').length}）`);
  const iss = hasCode(issues, 'BAD_ID');
  severityIs(iss, 'P0', 'BAD_ID');
  issues.filter(i => i.code === 'BAD_ID').forEach(i => i.fix.apply());
  ok(list.every(t => Number.isFinite(+t.id)), '修复后所有 ID 应为有限数字');
  noCode(env.check(), 'BAD_ID', '修复后不应再报 BAD_ID');
}
// 负例
{
  const env = createEnv(cleanFixture());
  noCode(env.check(), 'BAD_ID', 'ID 合法时不应报 BAD_ID');
}

// ── P0-5 type 非法 ──
console.log('P0-5 type 非法');
{
  const list = cleanFixture();
  list.push({ id: 5, type: 'unknown_type', parentId: null, children: [], title: '野类型', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000012 });
  list.push({ id: 6, type: undefined, parentId: null, children: [], title: '无类型', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 20260101000013 });
  const env = createEnv(list);
  const issues = env.check();
  ok(issues.filter(i => i.code === 'BAD_TYPE').length === 2, `两个非法 type 应报 2 条（实际 ${issues.filter(i => i.code === 'BAD_TYPE').length}）`);
  severityIs(hasCode(issues, 'BAD_TYPE'), 'P0', 'BAD_TYPE');
  issues.filter(i => i.code === 'BAD_TYPE').forEach(i => i.fix.apply());
  ok(list.find(t => t.id === 5).type === 'task', '非法 type 应降级为 task');
  ok(list.find(t => t.id === 6).type === 'task', '缺失 type 应降级为 task');
  noCode(env.check(), 'BAD_TYPE', '修复后不应再报 BAD_TYPE');
}
// 负例：七种合法类型都不应报错
{
  const list = [
    { id: 1, type: 'object',   parentId: null, children: [], title: 'o', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 1 },
    { id: 2, type: 'kr',       parentId: 1,    children: [], title: 'k', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 2 },
    { id: 3, type: 'target',   parentId: 2,    children: [], title: 't', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 3 },
    { id: 4, type: 'task',     parentId: 3,    children: [], title: 'a', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 4 },
    { id: 5, type: 'record',   parentId: 4,    children: [], title: 'r', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 5 },
    { id: 6, type: 'schedule', parentId: 4,    children: [], title: 's', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 6 },
    { id: 7, type: 'idea',     parentId: null, children: [], title: 'i', deps: [], next: [], status: 'todo', priority: '紧急不重要', progress: 0, isArchived: false, timestamp: 7 }
  ];
  const env = createEnv(list);
  env.rebuild();
  noCode(env.check(), 'BAD_TYPE', '七种合法类型都不应报 BAD_TYPE');
}

module.exports = { done: true };
if (require.main === module) {
  const c = H.counters();
  process.exit(H.report('P0 致命项') ? 0 : 1);
}
