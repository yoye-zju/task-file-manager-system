// _test_done_sort.js
// R3.8: 「已完成视图」默认按完成时间 新→旧 排序
// 验证已完成入口将 listSortType 设为 completed-desc；R3.37 起侧边栏「已完成」按钮移除，
// 该排序能力由列表视图「状态」筛选器（type==='status' && value==='done'）保留。
// 用法：node _test_done_sort.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  \u2713 ' + desc); }
  else { fail++; console.log('  \u2717 ' + desc); }
}

function extractFunc(name) {
  const idx = src.indexOf('function ' + name + '(');
  if (idx < 0) {
    const idx2 = src.indexOf('function ' + name + ' (');
    if (idx2 < 0) return null;
    return extractAt(src, idx2);
  }
  return extractAt(src, idx);
}
function extractAt(s, start) {
  const brace = s.indexOf('{', start);
  let depth = 1, i = brace + 1;
  while (i < s.length && depth > 0) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    i++;
  }
  return s.slice(start, i);
}

console.log('=== 「已完成视图」默认排序测试 ===\n');
let ngrove = 0;

// ── 1. getSortComparator('completed-desc') 比较器 ──
(() => {
  console.log('[1] completed-desc 比较器');
  const body = extractFunc('getSortComparator');
  check('getSortComparator 存在', !!body);
  if (!body) return;

  const PRIORITY_ORDER = { '重要紧急': 0, '重要不紧急': 1, '紧急不重要': 2, '不紧急不重要': 3 };
  // 包一层，注入 PRIORITY_ORDER 依赖
  const wrap = new Function('PRIORITY_ORDER', 'return (' + body + ')');
  const getComparator = wrap(PRIORITY_ORDER);

  const c = getComparator('completed-desc');
  check('completed-desc 返回函数', typeof c === 'function');

  const mk = (id, at) => ({ id, completedAt: at });
  const a = mk('a', '2026-08-20T10:00:00');
  const b = mk('b', '2026-08-21T10:00:00');   // 更晚完成
  const c2 = mk('c', null);                    // 无完成时间
  check('新完成的排前面（b 在 a 前）', c(b, a) < 0);
  check('新的排在旧的前面（c(b,a) 为负）', c(b, a) < 0);
  check('反向 c(a,b) 为正', c(a, b) > 0);
  check('无完成时间排最后', c(c2, a) > 0 && c(a, c2) < 0);
  check('都是无完成时间则相等', c(c2, c2) === 0);

  // 稳定排序冒烟：构造混排数组，验证排序结果
  const arr = [mk('x', null), mk('y', '2026-08-19T00:00:00'), mk('z', '2026-08-22T12:00:00'), mk('w', '2026-08-21T00:00:00')];
  const sorted = arr.sort(c).map(t => t.id);
  check('整体按完成时间新→旧', deepEq(sorted, ['z', 'w', 'y', 'x']));
  ngrove++;
})();

// ── 2. 仪表盘「已完成」卡片入口（R3.38：列表视图移除，改道时间线表格 tlDoneFilter）──
(() => {
  console.log('\n[2] 仪表盘「已完成」卡片入口（R3.38 改道时间线表格）');
  const navBlock = src.match(/function navigateToListWithFilter[\s\S]*?\n\}/)[0];
  check('status=done 映射到时间线表格 tlDoneFilter', /type === 'status'[\s\S]*?tlDoneFilter = true/.test(navBlock));
  check('跳转走 activateTimelineTable', navBlock.includes('activateTimelineTable'));
  check('不再设置列表 listSortType completed-desc', !/type === 'status'[\s\S]*?listSortType = 'completed-desc'/.test(navBlock));
  ngrove++;
})();

// ── 3. 已完成查看入口（R3.38：列表视图/导航项移除，由时间线表格已完成开关承接）──
(() => {
  console.log('\n[3] 已完成查看入口（R3.38 起列表视图移除）');
  check('侧边栏已完成按钮已移除（无 qa-done）', !html.includes('id="qa-done"'));
  check('任务列表导航项已移除（无 data-view="list"）', !html.includes('data-view="list"'));
  check('view-list 面板已移除', !html.includes('id="view-list"'));
  check('时间线表格已完成开关 setTlDoneFilter 存在', src.includes('function setTlDoneFilter'));
  const _qfBlock = src.match(/function quickFilter\(type\) \{[\s\S]*?\n\}/)[0];
  check('quickFilter 不再有 case \'done\'', !/case 'done':/.test(_qfBlock));
  ngrove++;
})();

// ── 核心 bug 修复：renderList 排序读取优先级 ──
(() => {
  console.log('\n[4] renderList 排序读取优先级（核心 bug）');
  // bug：第 858 行原本从 DOM select 读取排序，但新 select 要到第 991 行 innerHTML 才写入，
  // 导致首次进入已完成视图时读到的是旧 DOM 值 'tree'，排序完全不生效。
  check('sortType 优先读 listSortType 变量（而非 DOM）',
    /const sortType = listSortType \|\| document\.getElementById\('list-sort-filter'\)\?\.value \|\| 'tree';/.test(src));
  check('select change 时同步写回 listSortType',
    /getElementById\('list-sort-filter'\)[\s\S]*?addEventListener\('change'[\s\S]*?listSortType = this\.value;/.test(src));
  check('completed-desc 比较器含 timestamp 二级键',
    /case 'completed-desc':[\s\S]*?parseInt\(b\.timestamp \|\| '0'\) - parseInt\(a\.timestamp \|\| '0'\)/.test(src));
  ngrove++;
})();

// ── 辅助 ──
function deepEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\n=== 汇总 ===');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
