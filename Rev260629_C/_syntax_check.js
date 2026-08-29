// 模拟 renderTimelineTable 输出，验证：
// 1. 每行 .row-actions 存在（悬浮按钮组）
// 2. 编辑属性 / 任务链 / +下级内容(仅 object/kr/target) / +后置内容
// 3. row-highlighted class 生效
// 4. 归档 checkbox（onchange toggleArchived）存在
// 5. 归档任务被过滤（不出现）

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// 提取 renderTimelineTable 函数体（正则简单匹配）
const startIdx = src.indexOf('function renderTimelineTable()');
if (startIdx < 0) { console.log('FAIL: renderTimelineTable not found'); process.exit(1); }

// 构造最小执行环境
const TYPE_COLORS = { object:'#DC2626', kr:'#7C3AED', target:'#3B82F6', task:'#06B6D4', record:'#94A3B8', schedule:'#EA580C', idea:'#F59E0B' };
const TYPE_LABELS = { object:'目标', kr:'KR', target:'子目标', task:'任务', record:'记录', schedule:'日程', idea:'想法' };
const statusMap = { todo:'待办', doing:'进行中', done:'已完成', blocked:'阻塞', cancel:'已取消' };
function getProgressColor(){ return '#6366F1'; }
function isArchivedOf(t) { if (!t) return false; const v = t.isArchived; return v === true || v === 'true' || v === 1 || v === '1'; }
const archiveOnly = false;  // mock for syntax check context
const showArchived = false; // mock for syntax check context
const highlightedIds = new Set([2]);  // task id=2 高亮
const tasks = [
  { id: 1, type: 'object', title: '目标A', timestamp: '20260724110000', status: 'doing', priority: '重要紧急', progress: 50, deadline: '2026-08-01', startDate: '2026-07-01', assignee: '小明', tag: '产品', files: [], isMilestone: false, isArchived: false },
  { id: 2, type: 'task', title: '任务B', timestamp: '20260724120000', status: 'todo', priority: '重要不紧急', progress: 0, deadline: '2026-08-05', startDate: '', assignee: '', tag: '', files: [{}], isMilestone: true, isArchived: false },
  { id: 3, type: 'record', title: '已归档记录', timestamp: '20260724100000', status: 'done', priority: '紧急不重要', progress: 100, deadline: '', startDate: '', assignee: '', tag: '', files: [], isMilestone: false, isArchived: true },  // 应被过滤
  { id: 4, type: 'idea', title: '想法D', timestamp: '20260724130000', status: 'todo', priority: '紧急不重要', progress: 0, deadline: '', startDate: '', assignee: '', tag: '', files: [], isMilestone: false, isArchived: false },
];

// mock DOM
const capturedHTML = { view: '' };
const document = {
  getElementById: (id) => id === 'view-timeline-table' ? {
    set innerHTML(v) { capturedHTML.view = v; },
    get innerHTML() { return capturedHTML.view; },
  } : null,
};

// 找到函数体结束位置：从 startIdx 开始，配对花括号
let depth = 0, inString = null, i = startIdx;
let bodyStart = -1;
for (; i < src.length; i++) {
  const c = src[i];
  if (inString) {
    if (c === '\\') { i++; continue; }
    if (c === inString) inString = null;
    continue;
  }
  if (c === "'" || c === '"' || c === '`') { inString = c; continue; }
  if (c === '{') { if (bodyStart < 0) bodyStart = i; depth++; }
  else if (c === '}') { depth--; if (depth === 0) break; }
}
const funcBody = src.substring(startIdx, i + 1);

// 用 new Function 执行
const runFn = new Function('document', 'tasks', 'highlightedIds', 'TYPE_COLORS', 'TYPE_LABELS', 'statusMap', 'getProgressColor', 'archiveOnly', 'isArchivedOf', 'showArchived',
  'tlDateFilter', 'tlTableTypeFilter', 'DEFAULT_PRIORITY', 'PRIORITY_COLORS',
  funcBody + '\nrenderTimelineTable();'
);
runFn(document, tasks, highlightedIds, TYPE_COLORS, TYPE_LABELS, statusMap, getProgressColor, archiveOnly, isArchivedOf, showArchived, null, null, '紧急不重要', {});

const html = capturedHTML.view;
console.log('=== HTML length:', html.length);

const checks = [
  ['悬浮按钮容器 .row-actions', /class="row-actions"/g, 3],       // 只 3 条未归档
  ['编辑属性按钮', /编辑属性/g, 3],
  ['任务链按钮', /📋 任务链/g, 3],
  ['+ 下级内容（仅 object）', /\+ 下级内容/g, 1],                    // 只 object 有
  ['+ 后置内容按钮', /\+ 后置内容/g, 3],
  ['归档 checkbox', /toggleArchived\(\d+\)/g, 3],
  ['已归档任务被过滤', /已归档记录/g, 0],
  ['高亮 class 生效', /class="row-highlighted"/g, 1],              // id=2 高亮
  ['task-add 类（object 下的子按钮 childType=kr → kr-add）', /kr-add/g, 1],
  ['时间戳倒序', null, null],  // 单独检查
];

let allPass = true;
for (const [name, pattern, expected] of checks) {
  if (pattern === null) continue;
  const matches = (html.match(pattern) || []).length;
  const pass = matches === expected;
  console.log(`${pass ? '✅' : '❌'} ${name}: 找到 ${matches} 处 (期望 ${expected})`);
  if (!pass) allPass = false;
}

// 时间戳倒序验证
const tsOrder = [...html.matchAll(/(\d{14})/g)].map(m => m[1]);
const isDesc = tsOrder.every((v, i) => i === 0 || tsOrder[i-1] >= v);
console.log(`${isDesc ? '✅' : '❌'} 时间戳倒序: ${tsOrder.join(', ')}`);
if (!isDesc) allPass = false;

// 表头顺序：时间戳→归档→类型→标题
const headerOrder = ['<th>时间戳</th>', '归档</th>', '<th>类型</th>', '<th>标题</th>'];
let lastIdx = -1;
let headerPass = true;
for (const h of headerOrder) {
  const idx = html.indexOf(h);
  if (idx < 0 || idx <= lastIdx) { headerPass = false; console.log(`❌ 表头顺序断裂：${h} 位置 ${idx}`); break; }
  lastIdx = idx;
}
console.log(`${headerPass ? '✅' : '❌'} 表头顺序：时间戳 → 归档 → 类型 → 标题 ...`);
if (!headerPass) allPass = false;

console.log(allPass ? '\n🎉 全部通过' : '\n💥 有失败');
process.exit(allPass ? 0 : 1);
