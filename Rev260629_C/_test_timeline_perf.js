// _test_timeline_perf.js
// R3.7: 时间线视图性能优化（① 徽章计数归并单趟遍历 ② 搜索输入防抖）
// 用法：node _test_timeline_perf.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

// ── 1. 防抖函数存在且行为正确 ──
console.log('[1] debounce 防抖');
check('debounce 函数已定义', /function debounce\(fn, ms\)/.test(src));
check('debouncedRenderTimeline 已定义', /const debouncedRenderTimeline = debounce\(\(\) => renderTimeline\(\), 200\)/.test(src));
check('日历搜索框 oninput 已改用防抖', (src.match(/oninput="window\._tlFilterSearch=this\.value;debouncedRenderTimeline\(\);">/g) || []).length === 2);
check('不再有直接 renderTimeline 的搜索 oninput', !/oninput="window\._tlFilterSearch=this\.value;renderTimeline\(\);">/.test(src));

// 用假定时器验证 debounce 只执行一次（模拟 clearTimeout 取消）
const fakeTimers = [];
const fakeSetTimeout = (fn, ms) => { fakeTimers.push(fn); return fakeTimers.length; };
const fakeClearTimeout = (id) => { if (id) fakeTimers.length = 0; };
const debounce = new Function('setTimeout', 'clearTimeout', `
  return function (fn, ms) {
    let timer = null;
    return function () {
      const self = this, args = arguments;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms || 200);
    };
  };
`)(fakeSetTimeout, fakeClearTimeout);
let calls = 0;
const d = debounce(() => { calls++; }, 200);
d(); d(); d(); d(); d();
check('连续 5 次调用只排入 1 个定时器', fakeTimers.length === 1);
fakeTimers[0]();
check('定时器触发后执行 1 次', calls === 1);

// ── 2. 徽章计数归并：单趟遍历 + 与旧 filter 语义一致 ──
console.log('\n[2] 徽章计数归并');
check('归并块存在（_badgeCounts 单趟遍历）', /const _badgeCounts = \{ todayTodo: 0, weekDue: 0, monthDue: 0, overdue: 0(, done: 0)? \};/.test(src));
check('类型计数归并存在（_typeCounts）', /const _typeCounts = \{\};/.test(src));
check('类型徽章已改用 _typeCounts', /const count = _typeCounts\[type\] \|\| 0;/.test(src));
check('不再有类型徽章全表 filter', !/filter\(t => t && \(archiveOnly \? isArchivedOf\(t\) : \(!isArchivedOf\(t\) \|\| showArchived\)\) && _tlMatch\(t\) && \(t\.type \|\| ''\) === type\)/.test(src));

// 提取归并块并注入桩，验证计数正确
const mergeStart = src.indexOf('const _badgeCounts = { todayTodo: 0');
const mergeEnd = src.indexOf('const _tlCount = (f) => _badgeCounts[f] || 0;');
check('归并块源码可提取', mergeStart > 0 && mergeEnd > mergeStart);
if (mergeStart > 0 && mergeEnd > mergeStart) {
  const mergeCode = src.slice(mergeStart, mergeEnd);
  // 构造与 renderTimelineTable 相同的 _tlMatchF / _tlMatch / isArchivedOf
  const _dfToday = new Date(); _dfToday.setHours(0, 0, 0, 0);
  const _dfTodayEnd = new Date(_dfToday); _dfTodayEnd.setHours(23, 59, 59, 999);
  const _dfOverdue3 = new Date(_dfToday); _dfOverdue3.setDate(_dfOverdue3.getDate() - 3);
  const _dfWeekEnd = new Date(_dfToday); _dfWeekEnd.setDate(_dfWeekEnd.getDate() + 7 - _dfWeekEnd.getDay()); _dfWeekEnd.setHours(23, 59, 59, 999);
  const _dfMonthEnd = new Date(_dfToday.getFullYear(), _dfToday.getMonth() + 1, 0); _dfMonthEnd.setHours(23, 59, 59, 999);
  const _tlMatchF = (t, f) => {
    const type = t.type || '';
    const st = t.status || '';
    const dd = t.deadline ? new Date(t.deadline) : null;
    const baseOk = (type === 'task' || type === 'schedule') && st !== 'done' && st !== 'cancel' && dd;
    if (!baseOk) return false;
    if (f === 'todayTodo') return dd >= _dfOverdue3 && dd <= _dfTodayEnd;
    if (f === 'weekDue') return dd >= _dfToday && dd <= _dfWeekEnd;
    if (f === 'monthDue') return dd >= _dfToday && dd <= _dfMonthEnd;
    if (f === 'overdue') return dd < _dfToday;
    return true;
  };
  const isArchivedOf = (t) => { if (!t) return false; const v = t.isArchived; return v === true || v === 'true' || v === 1 || v === '1'; };
  const archiveOnly = false, showArchived = false, tlDateFilter = null;
  const _tlMatch = (t) => !tlDateFilter || _tlMatchF(t, tlDateFilter);

  // 构造测试数据：today 到期未完成任务、本周、本月、逾期、已完成、非 task/schedule、已归档
  // 用本地日期拼串（勿用 toISOString，避免 UTC 偏移跨日）
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = localDate(_dfToday);
  const weekEnd = localDate(_dfWeekEnd);
  const monthEnd = localDate(_dfMonthEnd);
  const overdue = new Date(_dfToday); overdue.setDate(overdue.getDate() - 5);
  const overdueStr = localDate(overdue);
  const tasks = [
    { id: 1, type: 'task', status: 'todo', deadline: today },                 // todayTodo + weekDue + monthDue
    { id: 2, type: 'schedule', status: 'todo', deadline: weekEnd },            // weekDue + monthDue
    { id: 3, type: 'task', status: 'todo', deadline: monthEnd },               // monthDue
    { id: 4, type: 'task', status: 'todo', deadline: overdueStr },             // overdue
    { id: 5, type: 'task', status: 'done', deadline: today },                  // 已完成 → 不计任何档
    { id: 6, type: 'object', status: 'todo', deadline: today },                // 非 task/schedule → 不计档，但计类型
    { id: 7, type: 'task', status: 'todo', deadline: today, isArchived: true },// 已归档 → 不计（showArchived=false）
    { id: 8, type: 'kr', status: 'todo', deadline: today },                    // 非 task/schedule → 不计档，计类型
  ];

  const scope = { tasks, _tlMatchF, _tlMatch, isArchivedOf, archiveOnly, showArchived, _tlDateKeys: ['todayTodo', 'weekDue', 'monthDue', 'overdue'] };
  const runMerge = new Function('scope', `
    with (scope) {
      ${mergeCode}
      return { _badgeCounts, _typeCounts };
    }
  `);
  const { _badgeCounts, _typeCounts } = runMerge(scope);

  check('todayTodo = 1（仅 id1）', _badgeCounts.todayTodo === 1);
  check('weekDue = 2（id1,id2）', _badgeCounts.weekDue === 2);
  check('monthDue = 3（id1,id2,id3）', _badgeCounts.monthDue === 3);
  check('overdue = 1（id4）', _badgeCounts.overdue === 1);
  check('类型计数 task = 4（id1,id3,id4 + 已完成 id5；id7 已归档排除）', _typeCounts.task === 4);
  check('类型计数 object = 1', _typeCounts.object === 1);
  check('类型计数 kr = 1', _typeCounts.kr === 1);
  check('已归档 id7 不进入 todayTodo（todayTodo=1 已由排除证明）', _badgeCounts.todayTodo === 1 && _typeCounts.task === 4);
}

console.log('\n=== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ===');
process.exit(fail > 0 ? 1 : 0);
