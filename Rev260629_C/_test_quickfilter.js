// _test_quickfilter.js — 侧边栏快速筛选按钮测试（R3.37 更新）
// 背景：R3.36 移除侧边栏「今日待办/本周到期/本月到期」三按钮；R3.37 移除「已完成」按钮。
//   互斥组：仅时间线(qa-timeline-tl) —— 由 activeQuickFilter 统一决定
//   独立 toggle：叠加(qa-archive-overlay, showArchived)、筛选(qa-archive-filter, archiveOnly)
// 已完成任务的查看改由列表视图「状态」筛选器承担；仪表盘日期快捷卡片与时间线表格筛选栏不受影响。

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + (extra ? '  → ' + extra : '')); }
}

// ───────────────────────── 静态断言（读真实源码）─────────────────────────
console.log('=== 静态：已移除按钮 DOM 不存在 ===');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

['qa-today', 'qa-week', 'qa-month', 'qa-done'].forEach(id => {
  check('index.html 不含 id="' + id + '"', !html.includes('id="' + id + '"'));
});
['badge-today', 'badge-week', 'badge-month', 'badge-done'].forEach(id => {
  check('index.html 不含徽章 id="' + id + '"', !html.includes('id="' + id + '"'));
});
check('index.html 不含 quickFilter(\'done\') 内联调用', !html.includes("quickFilter('done')"));
check('index.html 不含 quickFilter(\'todayTodo\') 内联调用', !html.includes("quickFilter('todayTodo')"));
check('index.html 不含 quickFilter(\'weekDue\') 内联调用', !html.includes("quickFilter('weekDue')"));
check('index.html 不含 quickFilter(\'monthDue\') 内联调用', !html.includes("quickFilter('monthDue')"));
// 剩余按钮仍在
['qa-timeline-tl', 'qa-archive-overlay', 'qa-archive-filter'].forEach(id => {
  check('index.html 保留按钮 id="' + id + '"', html.includes('id="' + id + '"'));
});

console.log('=== 静态：app.js 点亮/徽章/分支清理 ===');
// updateQuickActionStates 的 map 不含已删按钮键
const statesBlock = src.match(/function updateQuickActionStates\(\) \{[\s\S]*?\n\}/)[0];
['qa-today', 'qa-week', 'qa-month', 'qa-done'].forEach(id => {
  check('updateQuickActionStates map 不含 ' + id, !statesBlock.includes("'" + id + "'"));
});
check('updateQuickActionStates 保留 qa-timeline-tl', statesBlock.includes("'qa-timeline-tl': 'timelineTable'"));
// 徽章函数不再读已删徽章
const badgesBlock = src.match(/function updateQuickActionBadges\(\) \{[\s\S]*?\n\}/)[0];
['badge-today', 'badge-week', 'badge-month', 'badge-done'].forEach(id => {
  check('updateQuickActionBadges 不再读 ' + id, !badgesBlock.includes("getElementById('" + id + "')"));
});
check('updateQuickActionBadges 不含 doneCount', !badgesBlock.includes('doneCount'));
check('updateQuickActionBadges 保留 badge-timeline-tl', badgesBlock.includes("getElementById('badge-timeline-tl')"));
check('updateQuickActionBadges 保留 badge-archive-overlay', badgesBlock.includes("getElementById('badge-archive-overlay')"));
// quickFilter 不再有已删 case
const quickFilterBlock = src.match(/function quickFilter\(type\) \{[\s\S]*?\n\}/)[0];
['weekDue', 'monthDue', 'todayTodo', 'done'].forEach(c => {
  check('quickFilter 不含 case \'' + c + '\'', !new RegExp("case '" + c + "'").test(quickFilterBlock));
});
check('quickFilter 取消分支不再有 done 特殊排序处理', !/activeQuickFilter === type[\s\S]{0,200}?type === 'done'/.test(quickFilterBlock));
// R3.38：列表视图已移除，「已完成」查看改由时间线表格 tlDoneFilter 承接
check('时间线表格已完成筛选 tlDoneFilter 存在', src.includes('tlDoneFilter') && src.includes('function setTlDoneFilter'));
// R3.38：navigateToListWithFilter 已改道到时间线表格，映射到 tl* 变量
const navBlock = src.match(/function navigateToListWithFilter[\s\S]*?\n\}/)[0];
check('日期卡片映射到 tlDateFilter（todayTodo/weekDue/monthDue/overdue）',
  navBlock.includes("tlDateFilter = 'todayTodo'") && navBlock.includes("tlDateFilter = 'weekDue'") &&
  navBlock.includes("tlDateFilter = 'monthDue'") && navBlock.includes("tlDateFilter = 'overdue'"));
check('类型卡片映射到 tlTableTypeFilter', navBlock.includes('tlTableTypeFilter = value'));
check('已完成卡片映射到 tlDoneFilter', /type === 'status'[\s\S]*?tlDoneFilter = true/.test(navBlock));
check('标题/搜索映射到 tlSearch', navBlock.includes('tlSearch = value'));
check('不支持的状态给 toast 提示', navBlock.includes('showToast') && navBlock.includes('后续版本补齐'));
check('跳转统一走 activateTimelineTable', src.includes('function activateTimelineTable'));
// 仪表盘卡片 DOM 仍在
check('仪表盘今日待办卡片仍在（navigateToListWithFilter(\'todayTodo\')）', src.includes("navigateToListWithFilter('todayTodo')"));
check('仪表盘本周到期卡片仍在（navigateToListWithFilter(\'weekDeadline\')）', src.includes("navigateToListWithFilter('weekDeadline')"));
check('仪表盘本月到期卡片仍在（navigateToListWithFilter(\'monthDeadline\')）', src.includes("navigateToListWithFilter('monthDeadline')"));
// 时间线表格筛选栏保留
check('时间线表格筛选栏 setTlDateFilter 仍在', src.includes("setTlDateFilter('todayTodo')") && src.includes("setTlDateFilter('weekDue')") && src.includes("setTlDateFilter('monthDue')"));

// ───────────────────────── 行为桩（与真实 app.js 同构）─────────────────────────
console.log('\n=== 行为：互斥组（仅时间线）点亮/取消 ===');
let activeQuickFilter = null;
let dateFilter = null;
let statusFilter = [];
let showArchived = false;
let archiveOnly = false;
let currentView = 'list';

const btns = {};
['qa-timeline-tl', 'qa-archive-overlay', 'qa-archive-filter'].forEach(id => {
  btns[id] = { id, _cls: new Set(), classList: {
    toggle(name, force) { if (force) btns[id]._cls.add(name); else btns[id]._cls.delete(name); } } };
});
const documentStub = { getElementById: (id) => btns[id] || null };

function updateQuickActionStates() {
  const map = { 'qa-timeline-tl': 'timelineTable' };
  Object.entries(map).forEach(([id, key]) => {
    const btn = documentStub.getElementById(id);
    if (btn) btn.classList.toggle('active', activeQuickFilter === key);
  });
  const btnOverlay = documentStub.getElementById('qa-archive-overlay');
  if (btnOverlay) btnOverlay.classList.toggle('active', showArchived);
  const btnFilter = documentStub.getElementById('qa-archive-filter');
  if (btnFilter) btnFilter.classList.toggle('active', archiveOnly);
}
function clearAllFilters() {
  dateFilter = null; statusFilter = [];
  activeQuickFilter = null;
  showArchived = false; archiveOnly = false;
  updateQuickActionStates();
}
function quickFilter(type) {
  if (type === 'archiveOverlay') {
    showArchived = !showArchived;
    if (showArchived) archiveOnly = false;
    updateQuickActionStates();
    return;
  }
  if (type === 'archiveFilter') {
    archiveOnly = !archiveOnly;
    if (archiveOnly) showArchived = false;
    updateQuickActionStates();
    return;
  }
  if (activeQuickFilter === type) {
    clearAllFilters();
    return;
  }
  clearAllFilters();
  activeQuickFilter = type;
  if (type === 'timelineTable') { currentView = 'timeline-table'; updateQuickActionStates(); return; }
  updateQuickActionStates();
}
const litButtons = () => Object.keys(btns).filter(id => btns[id]._cls.has('active'));

// 点时间线 → 只亮时间线
quickFilter('timelineTable');
check('点「时间线」只点亮 1 个', litButtons().length === 1, '亮了 ' + litButtons());
check('点亮的是 qa-timeline-tl', litButtons()[0] === 'qa-timeline-tl');
check('currentView 切到 timeline-table', currentView === 'timeline-table');

// 再点时间线 → 取消
quickFilter('timelineTable');
check('再点「时间线」全灭', litButtons().length === 0, '仍亮 ' + litButtons());
check('activeQuickFilter 归零', activeQuickFilter === null);
check('currentView 之外状态复位（dateFilter=null）', dateFilter === null);

console.log('\n=== 行为：叠加 / 筛选 独立 toggle 且互斥 ===');
clearAllFilters();
quickFilter('archiveOverlay');
check('点「叠加」点亮叠加', btns['qa-archive-overlay']._cls.has('active') && showArchived === true);
check('叠加不影响互斥组（时间线不亮）', !btns['qa-timeline-tl']._cls.has('active'));
quickFilter('archiveFilter');
check('点「筛选」点亮筛选', btns['qa-archive-filter']._cls.has('active') && archiveOnly === true);
check('筛选 ON → 叠加 OFF（互斥）', !btns['qa-archive-overlay']._cls.has('active') && showArchived === false);
quickFilter('archiveOverlay');
check('再点「叠加」→ 筛选 OFF（互斥）', !btns['qa-archive-filter']._cls.has('active') && archiveOnly === false);
check('叠加重新点亮', btns['qa-archive-overlay']._cls.has('active') && showArchived === true);
quickFilter('archiveOverlay');
check('再点「叠加」取消', !btns['qa-archive-overlay']._cls.has('active') && showArchived === false);

console.log('\n=== 行为：互斥组与归档 toggle 可共存、清筛选时全灭 ===');
clearAllFilters();
quickFilter('timelineTable');
quickFilter('archiveOverlay');
check('时间线 + 叠加 同时亮（不同组）', litButtons().length === 2 && btns['qa-timeline-tl']._cls.has('active') && btns['qa-archive-overlay']._cls.has('active'));
clearAllFilters();
check('clearAllFilters 后全灭', litButtons().length === 0, '仍亮 ' + litButtons());

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
