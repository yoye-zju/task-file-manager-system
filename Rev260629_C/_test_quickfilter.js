// 互斥单选 DOM 级验证：模拟 5 个按钮 + updateQuickActionStates
// 重点验证「时间线」和「本月到期」不会同时带 active class

let activeQuickFilter = null;
let dateFilter = null;
let showArchived = false;
let currentView = 'list';

// 模拟 DOM
const btns = {};
['qa-today','qa-week','qa-month','qa-timeline-tl','qa-archived'].forEach(id => {
  btns[id] = {
    id,
    _cls: new Set(),
    classList: {
      toggle(name, force) {
        if (force) btns[id]._cls.add(name);
        else btns[id]._cls.delete(name);
      },
    },
  };
});
const document = { getElementById: (id) => btns[id] || null };

// ==== 被测函数（与 app.js 保持一致）====
function updateQuickActionStates() {
  const map = {
    'qa-today': 'todayTodo',
    'qa-week': 'weekDue',
    'qa-month': 'monthDue',
    'qa-timeline-tl': 'timelineTable',
    'qa-archived': 'archived',
  };
  Object.entries(map).forEach(([id, key]) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', activeQuickFilter === key);
  });
}

function clearAllFilters(silent) {
  dateFilter = null;
  activeQuickFilter = null;
  showArchived = false;
  updateQuickActionStates();
  if (silent) return;
}

function quickFilter(type) {
  if (activeQuickFilter === type) {
    clearAllFilters(true);
    updateQuickActionStates();
    return;
  }
  clearAllFilters(true);
  activeQuickFilter = type;
  if (type === 'timelineTable') {
    currentView = 'timeline-table';
    updateQuickActionStates();
    return;
  }
  switch(type) {
    case 'todayTodo': dateFilter = 'todayTodo'; break;
    case 'weekDue': dateFilter = 'weekDeadline'; break;
    case 'monthDue': dateFilter = 'monthDeadline'; break;
    case 'archived': showArchived = true; break;
  }
  updateQuickActionStates();
}

// ==== 断言辅助 ====
function litButtons() {
  return Object.keys(btns).filter(id => btns[id]._cls.has('active'));
}
let pass = 0, fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + desc); }
  else { fail++; console.log('  FAIL  ' + desc + (extra ? '  → ' + extra : '')); }
}

console.log('\n=== 用户报告的原始 bug 场景：时间线 + 本月到期 ===');
quickFilter('monthDue');
console.log('  点「本月到期」后点亮:', litButtons());
check('只点亮 1 个', litButtons().length === 1, '实际 ' + litButtons().length);
check('点亮的是 qa-month', litButtons()[0] === 'qa-month');

quickFilter('timelineTable');
console.log('  再点「时间线」后点亮:', litButtons());
check('仍只点亮 1 个（原 bug 会是 2 个）', litButtons().length === 1, '实际 ' + litButtons().length + ' → ' + litButtons());
check('点亮的是 qa-timeline-tl', litButtons()[0] === 'qa-timeline-tl');
check('本月到期已灭', !btns['qa-month']._cls.has('active'));
check('dateFilter 已清空', dateFilter === null, 'dateFilter=' + dateFilter);

console.log('\n=== 遍历所有 5 个按钮，任意切换后都只亮 1 个 ===');
const all = ['todayTodo','weekDue','monthDue','timelineTable','archived'];
all.forEach(a => {
  all.forEach(b => {
    if (a === b) return;
    activeQuickFilter = null; dateFilter = null; showArchived = false;
    updateQuickActionStates();
    quickFilter(a);
    quickFilter(b);
    const lit = litButtons();
    check(`${a} → ${b} 只亮1个`, lit.length === 1, '亮了 ' + lit.length + ': ' + lit);
  });
});

console.log('\n=== 再次点击同一按钮 = 取消 ===');
activeQuickFilter = null; updateQuickActionStates();
quickFilter('todayTodo');
check('第1次点击点亮', litButtons().length === 1);
quickFilter('todayTodo');
check('第2次点击全灭', litButtons().length === 0, '仍亮 ' + litButtons());
check('activeQuickFilter 归零', activeQuickFilter === null);
check('dateFilter 归零', dateFilter === null);

console.log('\n=== 已归档按钮不再是 toggle 累加 ===');
activeQuickFilter = null; showArchived = false; updateQuickActionStates();
quickFilter('archived');
check('已归档点亮', litButtons()[0] === 'qa-archived');
check('showArchived=true', showArchived === true);
quickFilter('monthDue');
check('切到本月后已归档灭', !btns['qa-archived']._cls.has('active'));
check('showArchived 被重置为 false', showArchived === false, 'showArchived=' + showArchived);

console.log('\n=== 主导航切换清除点亮态 ===');
activeQuickFilter = null; updateQuickActionStates();
quickFilter('monthDue');
check('切换前有点亮', litButtons().length === 1);
// 模拟手动点 nav-item（_navFromQuickFilter=false 分支）
activeQuickFilter = null;
updateQuickActionStates();
check('切主导航后全灭', litButtons().length === 0, '仍亮 ' + litButtons());

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
