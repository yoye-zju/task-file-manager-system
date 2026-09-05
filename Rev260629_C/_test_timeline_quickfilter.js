// _test_timeline_quickfilter.js
// R3.4: 时间线表格视图快速筛选（今日待办/本周到期/本月到期/已逾期/清除）
// 用法：node _test_timeline_quickfilter.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

// ── 括号配平的函数提取（比正则 \n\} 更可靠）──
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

const renderCode = extractFunc('renderTimelineTable');
const setCode = extractFunc('setTlDateFilter');

console.log('=== 时间线视图快速筛选测试 ===\n');

// ── 1. 静态检查 ──
console.log('[1] 静态检查');
check('renderTimelineTable 函数存在', !!renderCode);
check('setTlDateFilter 函数存在', !!setCode);
check('tlDateFilter 全局变量声明', /let\s+tlDateFilter\s*=\s*null/.test(src));
check('快速筛选栏包含「今日待办」', renderCode.includes('今日待办'));
check('快速筛选栏包含「本周到期」', renderCode.includes('本周到期'));
check('快速筛选栏包含「本月到期」', renderCode.includes('本月到期'));
check('快速筛选栏包含「已逾期」', renderCode.includes('已逾期'));
check('快速筛选栏包含「清除筛选」', renderCode.includes('清除筛选'));
check('筛选按钮为 tag-btn 样式', (renderCode.match(/tag-btn/g) || []).length >= 5);
check('徽章使用 qa-badge 样式', (renderCode.match(/qa-badge/g) || []).length >= 4);
check('空态文案保留', renderCode.includes('暂无内容'));

// ── 2. DOM 桩执行 renderTimelineTable ──
console.log('\n[2] 筛选行为（DOM 桩）');

// 准备测试数据：deadline 基于“今天”（用本地日期，与 renderTimelineTable 内部 _dfToday 边界一致，避免 UTC 跨午夜错位）
const now = new Date();
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = fmt(now);
const d3ago = fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3));
const d4ago = fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 4));
const tomorrow = fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
const nextMonth = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 5));

const testTasks = [
  { id: 1, type: 'task',     status: 'todo',  deadline: today,      timestamp: '20260815080000', title: '今天到期任务', tag: '' },
  { id: 2, type: 'task',     status: 'todo',  deadline: d3ago,      timestamp: '20260815070000', title: '3天前到期(近3天含)', tag: '' },
  { id: 3, type: 'task',     status: 'todo',  deadline: d4ago,      timestamp: '20260815060000', title: '4天前到期=逾期', tag: '' },
  { id: 4, type: 'schedule', status: 'todo',  deadline: tomorrow,   timestamp: '20260815050000', title: '明天日程=本周', tag: '' },
  { id: 5, type: 'task',     status: 'done',  deadline: today,      timestamp: '20260815040000', title: '已完成不算', tag: '' },
  { id: 6, type: 'task',     status: 'todo',  deadline: '',         timestamp: '20260815030000', title: '无截止日期', tag: '' },
  { id: 7, type: 'record',   status: 'todo',  deadline: today,      timestamp: '20260815020000', title: 'record类型不算', tag: '' },
  { id: 8, type: 'task',     status: 'todo',  deadline: nextMonth,  timestamp: '20260815010000', title: '下月到期', tag: '' },
];

// 桩 DOM
const fakeEl = { innerHTML: '', style: {}, querySelector: () => null };
const document = {
  getElementById: (id) => (id === 'view-timeline-table' ? fakeEl : null),
};

// 桩环境变量/函数
const TYPE_COLORS = { task: '#4F46E5', schedule: '#F59E0B', record: '#94A3B8', object: '#7C3AED', kr: '#3B82F6', target: '#06B6D4', idea: '#EC4899' };
const TYPE_LABELS = { task: '任务', schedule: '日程', record: '记录', object: '目标', kr: 'KR', target: '子目标', idea: '想法' };
const statusMap = { todo: '待办', preparing: '准备中', progress: '进行中', done: '已完成', blocked: '阻塞', cancel: '已取消' };
const highlightedIds = new Set();
const fileDisplayName = (f) => (f && (f.name || f.file_name)) || '';
let tasks = [];
let archiveOnly = false, showArchived = false, tlDateFilter = null, tlDoneFilter = false, tlEntityFilters = null;
const isEntityHighlighted = () => false;
const entityStateClass = () => '';
const nearestObjectIdOf = () => null;
const shortTitle = (t) => t;
const renderEntityFilterButtons = () => '';
const toggleTlTableEntityFilter = () => {};

const isArchivedOf = (t) => !!(t && (t.isArchived === true || t.isArchived === 'true'));
const getProgressColor = () => '#6366F1';
const showFileHoverCard = () => {};
const scheduleHideFileHoverCard = () => {};
const handleListFileChipClick = () => {};
const editTask = () => {};
const toggleArchived = () => {};
const cycleTaskStatus = () => {};
const addChildTask = () => {};
const addNextTask = () => {};
const showTaskChain = () => {};
const createNewContent = () => {};
const setTlDateFilter = new Function(setCode + '\nreturn setTlDateFilter;')();

// 构造可执行环境
const factory = new Function(
  'document', 'tasks', 'TYPE_COLORS', 'TYPE_LABELS', 'statusMap', 'highlightedIds',
  'fileDisplayName', 'archiveOnly', 'showArchived', 'tlDateFilter', 'tlTableTypeFilter',
  'tlDoneFilter', 'tlEntityFilters', 'tlSearch', 'tlSearchInput', 'computeSearchVisibleSet', 'renderEntityFilterButtons', 'toggleTlTableEntityFilter',
  'isEntityHighlighted', 'entityStateClass', 'nearestObjectIdOf', 'shortTitle',
  'DEFAULT_PRIORITY', 'PRIORITY_COLORS',
  'isArchivedOf', 'getProgressColor', 'showFileHoverCard', 'scheduleHideFileHoverCard',
  'handleListFileChipClick', 'editTask', 'toggleArchived', 'cycleTaskStatus',
  'addChildTask', 'addNextTask', 'showTaskChain', 'createNewContent',
  renderCode + '\nreturn { renderTimelineTable, setTl: (v) => { tlDateFilter = v; } };'
);
const api = factory(
  document, testTasks, TYPE_COLORS, TYPE_LABELS, statusMap, highlightedIds,
  fileDisplayName, false, false, null, null, false, null, '', null,
  function computeSearchVisibleSet() { return new Set(); }, renderEntityFilterButtons, toggleTlTableEntityFilter, isEntityHighlighted, entityStateClass, nearestObjectIdOf, shortTitle,
  '紧急不重要', {},
  isArchivedOf, getProgressColor, showFileHoverCard, scheduleHideFileHoverCard,
  handleListFileChipClick, editTask, toggleArchived, cycleTaskStatus,
  addChildTask, addNextTask, showTaskChain, createNewContent
);
const renderTimelineTable = api.renderTimelineTable;
const setTl = api.setTl;

function rowCount() {
  const m = fakeEl.innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/);
  return m ? (m[1].match(/<tr/g) || []).length : 0;
}

// 无筛选：全部 8 条
setTl(null);
renderTimelineTable();
check('无筛选显示全部 8 条', rowCount() === 8, '实际 ' + rowCount());

// 今日待办（今天 + 近3天，task/schedule，未完成）：1,2 共2条
setTl('todayTodo');
renderTimelineTable();
check('今日待办 = 2 条（今天+3天前）', rowCount() === 2, '实际 ' + rowCount());
check('今日待办不含已完成/record/无截止', fakeEl.innerHTML.includes('今天到期任务') && fakeEl.innerHTML.includes('3天前到期(近3天含)') && !fakeEl.innerHTML.includes('已完成不算') && !fakeEl.innerHTML.includes('record类型不算') && !fakeEl.innerHTML.includes('无截止日期'));

// 本周到期：今天~周末。今天(1)、明天(4) 在 [今天, 周末] 内；3天前(2) 不在
setTl('weekDue');
renderTimelineTable();
check('本周到期 = 今天起至周末（含 1,4）', rowCount() === 2, '实际 ' + rowCount());

// 本月到期：今天(1)、明天(4) 在 [今天, 月底] 内；3天前(2)、4天前(3)、下月(8) 不在 → 2条
setTl('monthDue');
renderTimelineTable();
check('本月到期 = 2 条（今天+明天）', rowCount() === 2, '实际 ' + rowCount());

// 已逾期：deadline < 今天 → 3天前(2) 和 4天前(3) 都 < 今天 → 2条
setTl('overdue');
renderTimelineTable();
check('已逾期 = 2 条（3天前+4天前）', rowCount() === 2, '实际 ' + rowCount());

// ── 3. setTlDateFilter 切换/取消 ──
console.log('\n[3] setTlDateFilter 切换');
const scope = {
  tlDateFilter: null,
  renderTimelineTable: () => {},
};
const setFnBound = new Function('scope', `
  with (scope) {
    ${setCode}
    return setTlDateFilter;
  }
`)(scope);
setFnBound('todayTodo');
check('setTlDateFilter(todayTodo) 后 tlDateFilter = todayTodo', scope.tlDateFilter === 'todayTodo');
setFnBound('todayTodo');
check('再次点击同一档位 = 取消(null)', scope.tlDateFilter === null);
setFnBound('overdue');
setFnBound('todayTodo');
check('切换到另一档位 = 覆盖', scope.tlDateFilter === 'todayTodo');
setFnBound(null);
check('setTlDateFilter(null) = 清除', scope.tlDateFilter === null);

console.log(`\n通过 ${pass} / ${fail + pass}`);
process.exit(fail === 0 ? 0 : 1);
