// 时间线表格搜索筛选验证（R3.31）
// 覆盖：tlSearchMatch 字段匹配、computeSearchVisibleSet 祖先链/环形安全、
//       渲染短路（搜索优先于日期/类型/实体筛选）、筛选栏静态检查
// 运行：node _test_timeline_search.js

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

let pass = 0, fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + (extra !== undefined ? ' → ' + extra : '')); }
}
function extract(re, label) {
  const m = src.match(re);
  if (!m) { console.error('FAIL: 未找到代码块 ' + label); process.exit(1); }
  return m[0];
}

// ── 1. 纯函数提取（真实源码）──
const codeMatch = extract(/function tlSearchMatch\(t, kw\) \{[\s\S]*?\n\}/, 'tlSearchMatch');
const codeVisible = extract(/function computeSearchVisibleSet\(tasks, kw\) \{[\s\S]*?\n\}/, 'computeSearchVisibleSet');
const fns = new Function(codeMatch + codeVisible +
  '\nreturn { tlSearchMatch: tlSearchMatch, computeSearchVisibleSet: computeSearchVisibleSet };')();
const tlSearchMatch = fns.tlSearchMatch;
const computeSearchVisibleSet = fns.computeSearchVisibleSet;

console.log('=== 时间线搜索筛选测试 ===\n');

// ── 2. tlSearchMatch 字段匹配 ──
console.log('[1] tlSearchMatch 字段匹配');
const t = { title: 'Q3 目标', desc: '完成季度汇报', tag: '重要', assignee: '张三' };
check('标题命中', tlSearchMatch(t, 'Q3'));
check('描述命中', tlSearchMatch(t, '汇报'));
check('标签命中', tlSearchMatch(t, '重要'));
check('负责人命中', tlSearchMatch(t, '张三'));
check('大小写不敏感（英文标题）', tlSearchMatch({ title: 'DCSTS Project' }, 'dcsts'));
check('空关键词全 true', tlSearchMatch(t, '') === true && tlSearchMatch(t, null) === true);
check('无匹配 false', tlSearchMatch(t, '不存在的词') === false);
check('缺字段不崩', tlSearchMatch({}, 'abc') === false && tlSearchMatch(null, 'abc') === false);

// ── 3. computeSearchVisibleSet 祖先链 ──
console.log('\n[2] computeSearchVisibleSet 祖先链');
const tree = [
  { id: 1, type: 'object', title: '目标一', parentId: null },
  { id: 2, type: 'kr', title: 'KR 里程碑', parentId: 1 },
  { id: 3, type: 'target', title: '子目标', parentId: 2 },
  { id: 4, type: 'task', title: '具体任务', parentId: 3 },
  { id: 5, type: 'task', title: '无关任务', parentId: null },
];
let s = computeSearchVisibleSet(tree, '里程碑');
check('命中 KR 含祖先（1,2）', s.has(1) && s.has(2) && s.size === 2, 'size=' + s.size + ' [' + [...s].join(',') + ']');
s = computeSearchVisibleSet(tree, '具体任务');
check('命中 task 含三层祖先（1,2,3,4）', s.has(1) && s.has(2) && s.has(3) && s.has(4) && s.size === 4, '[' + [...s].join(',') + ']');
s = computeSearchVisibleSet(tree, '目标一');
check('命中祖先仅显示自身（后代未命中不显示）', s.has(1) && !s.has(2) && s.size === 1, '[' + [...s].join(',') + ']');
check('无关任务不在集合', !s.has(5));
s = computeSearchVisibleSet(tree, '');
check('空关键词返回全部 id（匹配全量）', s.size === 5, 'size=' + s.size);

// 悬空 parentId 不崩
s = computeSearchVisibleSet([{ id: 9, title: '悬空', parentId: 999 }], '悬空');
check('悬空 parentId 不崩且含自身', s.has(9) && s.size === 1, '[' + [...s].join(',') + ']');

// 环形引用不死循环（100ms 内）
const ring = [
  { id: 10, title: '环A', parentId: 11 },
  { id: 11, title: '环B', parentId: 10 },
];
let ringOk = true, ringMs = -1;
try {
  const t0 = Date.now();
  const rs = computeSearchVisibleSet(ring, '环A');
  ringMs = Date.now() - t0;
  ringOk = rs.has(10);  // 至少含命中的 A，不因环而死循环
} catch (e) { ringOk = false; }
check('环形引用不死循环（' + ringMs + 'ms）', ringOk && ringMs < 100, 'ringMs=' + ringMs);

// ── 4. DOM 桩：renderTimelineTable 搜索优先行为 ──
console.log('\n[3] renderTimelineTable 搜索优先（DOM 桩）');

// 提取 renderTimelineTable 真实源码
const fnStart = src.indexOf('function renderTimelineTable(');
if (fnStart < 0) { console.error('FAIL: renderTimelineTable 未找到'); process.exit(1); }
let depth = 0, fnEnd = -1, started = false;
for (let i = fnStart; i < src.length; i++) {
  if (src[i] === '{') { depth++; started = true; }
  else if (src[i] === '}') { depth--; if (started && depth === 0) { fnEnd = i + 1; break; } }
}
const renderCode = src.slice(fnStart, fnEnd);

const fakeEl = { innerHTML: '', style: {}, querySelector: () => null };
const document = { getElementById: (id) => (id === 'view-timeline-table' ? fakeEl : null), activeElement: null };
const now = new Date();
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = fmt(now);
const overdue = fmt(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10));
const testTasks = [
  { id: 1, type: 'object', status: 'todo', deadline: '', timestamp: '20260901080000', title: '大目标', tag: '', assignee: '' },
  { id: 2, type: 'task', status: 'todo', deadline: overdue, timestamp: '20260901070000', title: '逾期任务A', tag: '重点', assignee: '李四' },
  { id: 3, type: 'task', status: 'todo', deadline: today, timestamp: '20260901060000', title: '今天任务B', desc: '含特殊标记内容', tag: '', assignee: '' },
];

// 桩环境（与 renderTimelineTable 引用的全部变量对齐）
const TYPE_COLORS = { task: '#4F46E5', schedule: '#F59E0B', record: '#94A3B8', object: '#7C3AED', kr: '#3B82F6', target: '#06B6D4', idea: '#EC4899' };
const TYPE_LABELS = { task: '任务', schedule: '日程', record: '记录', object: '目标', kr: 'KR', target: '子目标', idea: '想法' };
const statusMap = { todo: '待办', preparing: '准备中', progress: '进行中', done: '已完成', blocked: '阻塞', cancel: '已取消' };
const highlightedIds = new Set();
const fileDisplayName = (f) => (f && (f.name || f.file_name)) || '';
let archiveOnly = false, showArchived = false, tlDateFilter = null, tlTableTypeFilter = null, tlDoneFilter = false, tlEntityFilters = null, tlSearch = '';
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
const isEntityHighlighted = () => false;
const entityStateClass = () => '';
const nearestObjectIdOf = () => null;
const shortTitle = (t) => t;
const renderEntityFilterButtons = () => '';
const toggleTlTableEntityFilter = () => {};
const setTlDateFilter = () => {};
const setTlTableTypeFilter = () => {};
const setTlDoneFilter = () => {};
const debouncedRenderTimelineTable = () => {};

const factory = new Function(
  'document', 'tasks', 'TYPE_COLORS', 'TYPE_LABELS', 'statusMap', 'highlightedIds',
  'fileDisplayName', 'archiveOnly', 'showArchived', 'tlDateFilter', 'tlTableTypeFilter', 'tlDoneFilter', 'tlEntityFilters', 'tlSearch', 'tlSearchComposing', 'tlSearchInput',
  'computeSearchVisibleSet', 'DEFAULT_PRIORITY', 'PRIORITY_COLORS',
  'isArchivedOf', 'getProgressColor', 'showFileHoverCard', 'scheduleHideFileHoverCard',
  'handleListFileChipClick', 'editTask', 'toggleArchived', 'cycleTaskStatus',
  'addChildTask', 'addNextTask', 'showTaskChain', 'createNewContent',
  'isEntityHighlighted', 'entityStateClass', 'nearestObjectIdOf', 'shortTitle',
  'renderEntityFilterButtons', 'toggleTlTableEntityFilter',
  'setTlDateFilter', 'setTlTableTypeFilter', 'setTlDoneFilter', 'debouncedRenderTimelineTable',
  renderCode + '\nreturn { renderTimelineTable: renderTimelineTable, setSearch: (v) => { tlSearch = v; }, setDate: (v) => { tlDateFilter = v; } };'
);
const api = factory(
  document, testTasks, TYPE_COLORS, TYPE_LABELS, statusMap, highlightedIds,
  fileDisplayName, archiveOnly, showArchived, tlDateFilter, tlTableTypeFilter, tlDoneFilter, tlEntityFilters, tlSearch, false, null,
  computeSearchVisibleSet, '重要不紧急', {},
  isArchivedOf, getProgressColor, showFileHoverCard, scheduleHideFileHoverCard,
  handleListFileChipClick, editTask, toggleArchived, cycleTaskStatus,
  addChildTask, addNextTask, showTaskChain, createNewContent,
  isEntityHighlighted, entityStateClass, nearestObjectIdOf, shortTitle,
  renderEntityFilterButtons, toggleTlTableEntityFilter,
  setTlDateFilter, setTlTableTypeFilter, setTlDoneFilter, debouncedRenderTimelineTable
);
const renderTimelineTable = api.renderTimelineTable;
const setSearch = api.setSearch;
const setDate = api.setDate;

function rowCount() {
  const m = fakeEl.innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/);
  return m ? (m[1].match(/<tr/g) || []).length : 0;
}

// 3a. 无搜索 → 3 条全显
setSearch(''); setDate(null);
renderTimelineTable();
check('无搜索显示全部 3 条', rowCount() === 3, '实际 ' + rowCount());

// 3b. 搜索"特殊标记"（desc 命中 id3）→ 只显示 id3
setSearch('特殊标记');
renderTimelineTable();
check('搜索命中 1 条', rowCount() === 1, '实际 ' + rowCount());
check('显示的是命中行', fakeEl.innerHTML.includes('今天任务B') && !fakeEl.innerHTML.includes('逾期任务A'));

// 3c. 搜索优先：同时设日期筛选 overdue，仍按搜索结果显示（id3 非逾期仍显示）
setDate('overdue');
renderTimelineTable();
check('搜索优先于日期筛选（overdue 下仍显示命中行）', rowCount() === 1 && fakeEl.innerHTML.includes('今天任务B'), '实际 ' + rowCount());

// 3d. 清空搜索 → 恢复日期筛选（overdue 只剩 id2）
setSearch('');
renderTimelineTable();
check('清空后恢复日期筛选（overdue = 1 条）', rowCount() === 1 && fakeEl.innerHTML.includes('逾期任务A'), '实际 ' + rowCount());

// ── 5. 静态检查：筛选栏结构与交互 ──
console.log('\n[4] 静态检查');
const tbStart = renderCode.indexOf('tl-table-filter-bar');
const tbBlock = tbStart >= 0 ? renderCode.slice(tbStart, tbStart + 4000) : '';
check('筛选栏含 slot 占位 + 输入框节点复用创建', tbBlock.includes('id="tl-search-slot"') && /tlSearchInput\.id = 'tl-search-input'/.test(renderCode));
check('input 事件触发防抖（不拦截，防抖+回调兜底）', /addEventListener\('input', function\(\) \{ tlSearch = this\.value; debouncedRenderTimelineTable\(\); \}\)/.test(renderCode));
check('Esc 清空并立即重渲染（keydown 监听）', /e\.key === 'Escape'/.test(renderCode) && renderCode.includes("tlSearch = ''") && renderCode.includes('renderTimelineTable();'));
check('IME 保护：compositionstart/end 监听 + 标志', /addEventListener\('compositionstart'/.test(renderCode) && /addEventListener\('compositionend'/.test(renderCode) && /tlSearchComposing = false/.test(renderCode));
check('头部已筛选提示含 tlSearch', /tlEntityFilters \|\| tlDoneFilter \|\| tlSearch/.test(renderCode));
check('清除按钮重置 tlSearch', renderCode.includes("tlSearch=''") && renderCode.includes("getElementById('tl-search-input')"));

console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
