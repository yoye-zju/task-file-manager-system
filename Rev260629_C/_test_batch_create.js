/**
 * _test_batch_create.js — 周期任务批量创建逻辑测试
 *
 * 测试 saveTask 周期模式下的批量创建路径：
 * 1. N 个日期 → N 个独立任务（独立 id/timestamp，相同 recurringGroupId，deadline=对应日期）
 * 2. 超过 365 上限 → 拒绝创建
 * 3. 空日期集合 → 拒绝创建
 *
 * 方法：直接模拟 saveTask 批量创建路径的核心逻辑（不依赖 DOM/浏览器）
 */

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + '\n     期望 ' + e + '\n     实际 ' + a); }
}

// ---- 模拟环境 ----
let tasks = [];
let nextId = 1;
const _tsUsed = {};

function makeTimestamp() {
  var d = new Date();
  var base = '' + d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    String(d.getSeconds()).padStart(2, '0');
  var ts = base;
  var offset = 0;
  while (offset < 60) {
    if (!_tsUsed[ts] && !tasks.some(function(t) { return t.timestamp === ts; })) break;
    offset++;
    ts = String(parseInt(base) + offset);
  }
  if (offset >= 60) {
    ts = base + String(offset).padStart(2, '0');
    if (ts.length > 14) ts = ts.slice(0, 14);
  }
  _tsUsed[ts] = true;
  return ts;
}

// ---- 模拟 saveTask 批量创建路径 ----
function simulateBatchCreate(data, dates) {
  if (dates.length === 0) return { error: '请至少选择一个日期' };
  if (dates.length > 365) return { error: '单批最多 365 个任务' };

  const groupId = makeTimestamp();
  const created = [];

  dates.forEach(ds => {
    const task = Object.assign({}, data, {
      deadline: ds, startDate: ds, recurringGroupId: groupId
    });
    task.id = nextId++;
    task.timestamp = makeTimestamp();
    task.children = [];
    task.createdAt = new Date().toISOString();
    if (task.parentId) {
      const parent = tasks.find(t => t.id === task.parentId);
      if (parent) { parent.children = parent.children || []; parent.children.push(task.id); }
    }
    tasks.push(task);
    created.push(task);
  });

  return { created, groupId };
}

// ---- 测试用例 ----

console.log('== 周期任务批量创建测试 ==');

// 1. 正常批量创建：3 个日期 → 3 个独立任务
const baseData = {
  type: 'schedule', parentId: null, title: '每周例会',
  priority: '紧急不重要', status: 'todo', progress: 0,
  deps: [], next: [], tag: '', assignee: '',
  files: [], isMilestone: false, isArchived: false, desc: ''
};

const result1 = simulateBatchCreate(baseData, ['2026-08-10', '2026-08-17', '2026-08-24']);
assertEq('创建 3 个任务', result1.created.length, 3);
assertEq('每个有独立 id', result1.created.map(t => t.id), [1, 2, 3]);
assertEq('每个有独立 timestamp', new Set(result1.created.map(t => t.timestamp)).size, 3);
assertEq('共享 recurringGroupId', new Set(result1.created.map(t => t.recurringGroupId)).size, 1);
assertEq('deadline 各自对应', result1.created.map(t => t.deadline), ['2026-08-10', '2026-08-17', '2026-08-24']);
assertEq('startDate = deadline', result1.created.every(t => t.startDate === t.deadline), true);
assertEq('groupId 等于第一个 timestamp', result1.groupId, result1.created[0].recurringGroupId);
assertEq('children 为空数组', result1.created.every(t => Array.isArray(t.children) && t.children.length === 0), true);

// 2. 空日期 → 拒绝
const result2 = simulateBatchCreate(baseData, []);
assertEq('空日期拒绝', result2.error, '请至少选择一个日期');

// 3. 超过 365 → 拒绝
const bigDates = [];
for (let i = 0; i < 366; i++) bigDates.push('2026-01-01');
const result3 = simulateBatchCreate(baseData, bigDates);
assertEq('超过 365 拒绝', result3.error, '单批最多 365 个任务');

// 4. 不同批次 groupId 不同
const result4 = simulateBatchCreate(baseData, ['2026-09-01', '2026-09-08']);
assertEq('第二批 groupId 不同', result4.groupId !== result1.groupId, true);
assertEq('第二批 id 继续', result4.created.map(t => t.id), [4, 5]);

// 5. parentId 维护：批量创建后 parent.children 更新
const parentTask = { id: 100, type: 'target', title: '父目标', children: [] };
tasks.push(parentTask);
const childData = Object.assign({}, baseData, { parentId: 100, type: 'task' });
const result5 = simulateBatchCreate(childData, ['2026-10-01', '2026-10-08', '2026-10-15']);
assertEq('子任务 3 个', result5.created.length, 3);
assertEq('parent.children 含全部 3 个', parentTask.children.length, 3);
assertEq('parent.children 内容', parentTask.children, result5.created.map(t => t.id));

// 6. 大批量创建（30 个）性能验证
const perfDates = [];
for (let i = 0; i < 30; i++) perfDates.push('2026-' + String(Math.floor(i / 28) + 1).padStart(2, '0') + '-' + String((i % 28) + 1).padStart(2, '0'));
const t0 = Date.now();
const result6 = simulateBatchCreate(baseData, perfDates);
const elapsed = Date.now() - t0;
assertEq('30 个任务全部创建', result6.created.length, 30);
assertEq('30 个 timestamp 全唯一', new Set(result6.created.map(t => t.timestamp)).size, 30);
assertEq('30 个创建耗时 < 1 秒', elapsed < 1000, true);

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
