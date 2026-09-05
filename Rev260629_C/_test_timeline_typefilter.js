// _test_timeline_typefilter.js
// R3.4: 时间线表格视图类型快速筛选（目标/KR/子目标/任务/记录/日程/想法）
// 用法：node _test_timeline_typefilter.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

// ── 括号配平的函数提取 ──
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
const setTypeCode = extractFunc('setTlTableTypeFilter');
const setDateCode = extractFunc('setTlDateFilter');

console.log('=== 时间线表格视图类型快速筛选测试 ===\n');

// ── 1. 静态检查 ──
console.log('[1] 静态检查');
check('renderTimelineTable 函数存在', !!renderCode);
check('setTlTableTypeFilter 函数存在', !!setTypeCode);
check('tlTableTypeFilter 全局变量声明', /let\s+tlTableTypeFilter\s*=\s*null/.test(src));
check('类型按钮包含「目标」', renderCode.includes('🎯 目标'));
check('类型按钮包含「KR」', renderCode.includes('📏 KR'));
check('类型按钮包含「子目标」', renderCode.includes('⬇️ 子目标'));
check('类型按钮包含「任务」', renderCode.includes('📋 任务'));
check('类型按钮包含「记录」', renderCode.includes('📝 记录'));
check('类型按钮包含「日程」', renderCode.includes('📅 日程'));
check('类型按钮包含「想法」', renderCode.includes('💡 想法'));
check('类型按钮共 7 个', (renderCode.match(/\['(object|kr|target|task|record|schedule|idea)','[^']+'\]/g) || []).length === 7);
check('日期按钮仍保留', renderCode.includes('今日待办') && renderCode.includes('已逾期'));
check('类型按钮为 tag-btn 样式', (renderCode.match(/tag-btn/g) || []).length >= 6);
check('类型筛选接入过滤链（R3.31 起合并进短路分支）', /_tlMatch\(t\) && _typeMatch\(t\) && _entityMatch\(t\) && _doneMatch\(t\)/.test(renderCode));
check('类型徽章用 qa-badge', (renderCode.match(/qa-badge/g) || []).length >= 5);
check('空态文案保留', renderCode.includes('暂无内容'));
check('分隔线存在', renderCode.includes('width:1px;height:18px'));

// ── 2. DOM 桩执行 renderTimelineTable ──
console.log('\n[2] 类型筛选行为（DOM 桩）');

const now = new Date();
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = fmt(now);

const testTasks = [
  { id: 1, type: 'object',   status: 'todo', deadline: today, timestamp: '20260815090000', title: '年度目标', tag: '' },
  { id: 2, type: 'kr',       status: 'todo', deadline: today, timestamp: '20260815080000', title: '关键结果A', tag: '' },
  { id: 3, type: 'target',   status: 'todo', deadline: today, timestamp: '20260815070000', title: '子目标B', tag: '' },
  { id: 4, type: 'task',     status: 'todo', deadline: today, timestamp: '20260815060000', title: '任务C', tag: '' },
  { id: 5, type: 'record',   status: 'todo', deadline: today, timestamp: '20260815050000', title: '记录D', tag: '' },
  { id: 6, type: 'schedule', status: 'todo', deadline: today, timestamp: '20260815040000', title: '日程E', tag: '' },
  { id: 7, type: 'idea',     status: 'todo', deadline: today, timestamp: '20260815030000', title: '想法F', tag: '' },
  { id: 8, type: 'task',     status: 'done', deadline: today, timestamp: '20260815020000', title: '已完成任务', tag: '' },
  { id: 9, type: 'task',     status: 'todo', deadline: today, timestamp: '20260815010000', title: '任务G', tag: '' },
];

const fakeEl = { innerHTML: '', style: {}, querySelector: () => null };
const document = {
  getElementById: (id) => (id === 'view-timeline-table' ? fakeEl : null),
};

const TYPE_COLORS = { task: '#4F46E5', schedule: '#F59E0B', record: '#94A3B8', object: '#7C3AED', kr: '#3B82F6', target: '#06B6D4', idea: '#EC4899' };
const TYPE_LABELS = { task: '任务', schedule: '日程', record: '记录', object: '目标', kr: 'KR', target: '子目标', idea: '想法' };
const statusMap = { todo: '待办', preparing: '准备中', progress: '进行中', done: '已完成', blocked: '阻塞', cancel: '已取消' };
const highlightedIds = new Set();
const fileDisplayName = (f) => (f && (f.name || f.file_name)) || '';
let archiveOnly = false, showArchived = false, tlDateFilter = null, tlTableTypeFilter = null, tlDoneFilter = false, tlEntityFilters = null;
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

const factory = new Function(
  'document', 'tasks', 'TYPE_COLORS', 'TYPE_LABELS', 'statusMap', 'highlightedIds',
  'fileDisplayName', 'archiveOnly', 'showArchived', 'tlDateFilter', 'tlTableTypeFilter', 'tlDoneFilter',
  'tlEntityFilters', 'tlSearch', 'tlSearchInput', 'computeSearchVisibleSet', 'renderEntityFilterButtons', 'toggleTlTableEntityFilter',
  'isEntityHighlighted', 'entityStateClass', 'nearestObjectIdOf', 'shortTitle',
  'DEFAULT_PRIORITY', 'PRIORITY_COLORS',
  'isArchivedOf', 'getProgressColor', 'showFileHoverCard', 'scheduleHideFileHoverCard',
  'handleListFileChipClick', 'editTask', 'toggleArchived', 'cycleTaskStatus',
  'addChildTask', 'addNextTask', 'showTaskChain', 'createNewContent',
  renderCode + '\nreturn { renderTimelineTable, setDate: (v) => { tlDateFilter = v; }, setType: (v) => { tlTableTypeFilter = v; } };'
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
const setDate = api.setDate;
const setType = api.setType;

function rowCount() {
  const m = fakeEl.innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/);
  return m ? (m[1].match(/<tr/g) || []).length : 0;
}

// 无筛选：全部 9 条
setDate(null); setType(null);
renderTimelineTable();
check('无筛选显示全部 9 条', rowCount() === 9, '实际 ' + rowCount());

// 筛选 task：id 4, 8, 9 → 3 条
setType('task');
renderTimelineTable();
check('类型=task → 3 条', rowCount() === 3, '实际 ' + rowCount());
check('task 筛选不含其他类型', fakeEl.innerHTML.includes('任务C') && fakeEl.innerHTML.includes('任务G') && !fakeEl.innerHTML.includes('年度目标') && !fakeEl.innerHTML.includes('记录D') && !fakeEl.innerHTML.includes('想法F'));

// 筛选 record：1 条
setType('record');
renderTimelineTable();
check('类型=record → 1 条', rowCount() === 1, '实际 ' + rowCount());
check('record 筛选正确', fakeEl.innerHTML.includes('记录D') && !fakeEl.innerHTML.includes('任务C'));

// 筛选 idea：1 条
setType('idea');
renderTimelineTable();
check('类型=idea → 1 条', rowCount() === 1, '实际 ' + rowCount());

// 筛选 schedule：1 条
setType('schedule');
renderTimelineTable();
check('类型=schedule → 1 条', rowCount() === 1, '实际 ' + rowCount());

// 筛选 object：1 条
setType('object');
renderTimelineTable();
check('类型=object → 1 条', rowCount() === 1, '实际 ' + rowCount());

// 筛选 kr：1 条
setType('kr');
renderTimelineTable();
check('类型=kr → 1 条', rowCount() === 1, '实际 ' + rowCount());

// 筛选 target：1 条
setType('target');
renderTimelineTable();
check('类型=target → 1 条', rowCount() === 1, '实际 ' + rowCount());

// 组合：日期筛选(今日待办) + 类型筛选(task) → 今日到期的未完成 task：id 4, 9（8 已完成排除）→ 2 条
setDate('todayTodo');
setType('task');
renderTimelineTable();
check('组合(今日待办+task) → 2 条', rowCount() === 2, '实际 ' + rowCount());
check('组合排除已完成', fakeEl.innerHTML.includes('任务C') && !fakeEl.innerHTML.includes('已完成任务'));

// 取消类型筛选，保留日期 → 今日待办 = task(4,9) + schedule(6) = 3 条
setType(null);
renderTimelineTable();
check('仅日期(今日待办) → 3 条', rowCount() === 3, '实际 ' + rowCount());

// ── 3. setTlTableTypeFilter 切换/取消 ──
console.log('\n[3] setTlTableTypeFilter 切换');
const scope = {
  tlTableTypeFilter: null,
  renderTimelineTable: () => {},
};
const setTypeBound = new Function('scope', `
  with (scope) {
    ${setTypeCode}
    return setTlTableTypeFilter;
  }
`)(scope);
setTypeBound('object');
check('setTlTableTypeFilter(object) 后 = object', scope.tlTableTypeFilter === 'object');
setTypeBound('object');
check('再次点击同一类型 = 取消(null)', scope.tlTableTypeFilter === null);
setTypeBound('kr');
setTypeBound('task');
check('切换到另一类型 = 覆盖', scope.tlTableTypeFilter === 'task');
setTypeBound(null);
check('setTlTableTypeFilter(null) = 清除', scope.tlTableTypeFilter === null);

// ── 4. 与 setTlDateFilter 相互独立 ──
console.log('\n[4] 两个 setter 相互独立');
const scope2 = { tlDateFilter: null, tlTableTypeFilter: null, renderTimelineTable: () => {} };
const mk = new Function('scope', `
  with (scope) {
    ${setDateCode}
    ${setTypeCode}
    return { setDate: setTlDateFilter, setType: setTlTableTypeFilter };
  }
`)(scope2);
mk.setDate('overdue');
check('setDate 只改 tlDateFilter', scope2.tlDateFilter === 'overdue' && scope2.tlTableTypeFilter === null);
mk.setType('idea');
check('setType 只改 tlTableTypeFilter', scope2.tlTableTypeFilter === 'idea' && scope2.tlDateFilter === 'overdue');

console.log(`\n通过 ${pass} / ${fail + pass}`);
process.exit(fail === 0 ? 0 : 1);
