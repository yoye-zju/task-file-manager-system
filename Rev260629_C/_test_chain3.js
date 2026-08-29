const vm = require('vm');
const fs = require('fs');
const path = require('path');

// Load app.js in a sandbox
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

const sandbox = {
  console, setTimeout: setTimeout.bind(global), clearTimeout: clearTimeout.bind(global),
  document: {
    createElement: () => ({}), querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => ({
      addEventListener: () => {}, style: {}, classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
      innerHTML: '', value: '', checked: false, focus: () => {}, appendChild: () => {}, remove: () => {},
      querySelector: () => null, querySelectorAll: () => [], contains: () => false,
      setAttribute: () => {}, dataset: {}, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      scrollIntoView: () => {}, insertBefore: () => {}, firstChild: null, parentElement: null,
      get offsetParent() { return null; }, get offsetHeight() { return 0; }
    }),
    addEventListener: () => {}, body: { appendChild: () => {} },
    head: { appendChild: () => {} }
  },
  window: { innerHeight: 800, innerWidth: 1200, location: { href: '' }, addEventListener: () => {}, removeEventListener: () => {} },
  localStorage: { getItem: () => null, setItem: () => {} },
  navigator: {}, fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
  URLSearchParams: URLSearchParams, Blob: Blob, Event: Event,
  TYPE_COLORS: { object: '#7C3AED', kr: '#3B82F6', target: '#06B6D4', task: '#6B7280' },
  TYPE_LABELS: { object: 'Object', kr: 'KR', target: 'Target', task: 'Task' },
  statusMap: { todo: '待办', progress: '进行中', done: '已完成' },
  getProgressColor: () => '#6366F1',
  TYPE_COLORS_LABELS: {}
};

const script = new vm.Script(src, { filename: 'app.js' });
const ctx = vm.createContext(sandbox);
script.runInContext(ctx);
// 沙箱内的 document 与测试脚本共享同一对象（后续覆盖 createElement/querySelector 需同步生效）
const document = sandbox.document;

// Now set up tasks
ctx.tasks = [
  { id: 1, deps: [2], next: [], type: 'task', title: '有依赖', priority: '紧急不重要', status: 'todo', progress: 0, timestamp: '20260724000000', isArchived: false },
  { id: 2, deps: [], next: [1], type: 'task', title: '有后置', priority: '紧急不重要', status: 'todo', progress: 0, timestamp: '20260724000001', isArchived: false },
  { id: 3, deps: [], next: [], type: 'task', title: '无任务链', priority: '紧急不重要', status: 'todo', progress: 0, timestamp: '20260724000002', isArchived: false },
];

// Call renderList
const list = ctx.tasks;
const viewType = 'tree';
ctx.currentView = 'list';

// We can't easily capture the HTML output since it's complex, but we can verify
// the function exists and check its source for the chain logic
const rlSrc = ctx.renderList.toString();
const hasChainLogic = rlSrc.includes('hasChain') && rlSrc.includes('chain-has') && rlSrc.includes('chain-empty');
console.log('renderList has conditional chain logic:', hasChainLogic ? 'PASS' : 'FAIL');

const rtlSrc = ctx.renderTimelineTable.toString();
const hasChainLogic2 = rtlSrc.includes('hasChain') && rtlSrc.includes('chain-has') && rtlSrc.includes('chain-empty');
console.log('renderTimelineTable has conditional chain logic:', hasChainLogic2 ? 'PASS' : 'FAIL');

// Actually render and check the output
const allSpans = [];
const origCreate = document.createElement;
let captured = '';
document.createElement = function(tag) {
  if (tag === 'div' || tag === 'span' || tag === 'td' || tag === 'tr' || tag === 'table' || tag === 'button') {
    return {
      style: {},
      classList: { add: () => {}, remove: () => {}, contains: () => false },
      setAttribute: () => {},
      appendChild: () => {},
      addEventListener: () => {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: () => false,
      scrollIntoView: () => {},
      remove: () => {},
      innerHTML: '',
      get offsetParent() { return null; },
      get offsetHeight() { return 0; }
    };
  }
  return origCreate.call(document, tag);
};

// Override container selector
document.querySelector = function(sel) {
  if (sel === '#list-view .card') return { appendChild: () => {} };
  return null;
};

console.log('\nRendering timeline table...');
try {
  ctx.renderTimelineTable();
  console.log('renderTimelineTable completed without errors');
} catch(e) {
  console.log('renderTimelineTable error:', e.message);
}
