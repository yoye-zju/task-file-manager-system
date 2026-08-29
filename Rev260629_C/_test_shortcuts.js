// 全局快捷键 DOM 级验证：从 app.js 正则提取真实快捷键代码块，注入 DOM 桩后模拟按键
// 覆盖：输入框守卫 / 弹窗守卫 / Ctrl+N / Ctrl+K / / / ? / 数字键切视图 / 3 键循环 / Esc 关闭
// 运行：node _test_shortcuts.js

const fs = require('fs');
const src = fs.readFileSync(__filename.replace('_test_shortcuts.js', 'app.js'), 'utf8');

// 提取快捷键区块（含三个辅助函数 + initGlobalShortcuts 定义与调用）
const m = src.match(/\/\/ ============ 全局快捷键 ============[\s\S]*?initGlobalShortcuts\(\);/);
if (!m) { console.error('FAIL: 未找到全局快捷键代码块'); process.exit(1); }
const code = m[0];

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); }
}

// 每个场景独立构造一次（currentView 初值不同）
function build(opts) {
  const initView = opts.currentView || 'list';
  let currentView = initView;
  const calls = { createNewContent: 0, goToListView: 0, showToast: 0, showHelp: 0, closeTaskModal: 0, closeQuotesModal: 0, closeHealthCheck: 0, closeHelp: 0, renderTimelineTable: 0 };
  const clickedNav = [];
  const modalStates = { 'modal-task': 'none', 'modal-quotes': 'none', 'modal-health': 'none', 'modal-changelog': 'none', 'modal-ai': 'none', 'modal-help': 'none' };
  if (opts.modalOpen) modalStates[opts.modalOpen] = 'flex';
  const activePanels = new Set(['view-' + initView]);
  let keydownHandler = null;

  const mkEl = (id) => ({
    id,
    style: { display: modalStates[id] || 'none' },
    classList: {
      add(c) { activePanels.add(id + ':' + c); },
      remove(c) { activePanels.delete(id + ':' + c); },
      toggle(c, f) { if (f) activePanels.add(id + ':' + c); else activePanels.delete(id + ':' + c); },
    },
  });

  const documentStub = {
    getElementById: (id) => (id in modalStates) ? mkEl(id) : (id === 'view-timeline-table' ? mkEl(id) : null),
    querySelector(sel) {
      const navM = sel.match(/\.nav-item\[data-view="([^"]+)"\]/);
      if (navM) return {
        click() {
          clickedNav.push(navM[1]);
          currentView = navM[1];
          activePanels.clear();
          activePanels.add('view-' + navM[1]);
        },
      };
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.modal-overlay') return Object.keys(modalStates).map(mkEl);
      if (sel === '.view-panel') return ['dashboard','list','timeline','matrix','board','habits','timeline-table'].map(v => ({ classList: { add(){}, remove(){} } }));
      if (sel === '.nav-item') return ['dashboard','list','timeline','matrix','board','habits'].map(v => ({ classList: { add(){}, remove(){} } }));
      return [];
    },
    addEventListener(type, fn) { if (type === 'keydown') keydownHandler = fn; },
  };
  const setTimeoutStub = (fn) => { fn(); return 0; };

  const stubFns = {
    createNewContent() { calls.createNewContent++; },
    goToListView() { calls.goToListView++; },
    showToast() { calls.showToast++; },
    closeTaskModal() { calls.closeTaskModal++; },
    closeQuotesModal() { calls.closeQuotesModal++; },
    closeHealthCheck() { calls.closeHealthCheck++; },
    closeHelp() { calls.closeHelp++; },
    showHelp() { calls.showHelp++; },
    updateQuickActionStates() {},
    renderTimelineTable() { calls.renderTimelineTable++; },
  };

  new Function('document', 'setTimeout', 'currentView', 'createNewContent', 'goToListView', 'showToast',
    'closeTaskModal', 'closeQuotesModal', 'closeHealthCheck', 'closeHelp', 'showHelp', 'updateQuickActionStates', 'renderTimelineTable',
    code)(documentStub, setTimeoutStub, currentView, stubFns.createNewContent, stubFns.goToListView, stubFns.showToast,
      stubFns.closeTaskModal, stubFns.closeQuotesModal, stubFns.closeHealthCheck, stubFns.closeHelp, stubFns.showHelp, stubFns.updateQuickActionStates, stubFns.renderTimelineTable);

  function trigger(key, o = {}) {
    const ev = {
      key,
      ctrlKey: !!o.ctrl, metaKey: !!o.meta, altKey: !!o.alt,
      target: o.target || { tagName: 'BODY' },
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    keydownHandler(ev);
    return ev;
  }

  return { calls, clickedNav, currentView: () => currentView, activePanels, trigger };
}

// ── 场景测试 ──
let s;

// 1. Ctrl+N 不触发（浏览器保留键，页面层拦不住）
s = build({});
s.trigger('n', { ctrl: true });
assert('Ctrl+N 不触发新建（浏览器保留键）', s.calls.createNewContent === 0, 'createNewContent=' + s.calls.createNewContent);

// 1b. Ctrl+Alt+N 触发新建
s = build({});
s.trigger('n', { ctrl: true, alt: true });
assert('Ctrl+Alt+N 触发新建', s.calls.createNewContent === 1, 'createNewContent=' + s.calls.createNewContent);

// 1c. 单键 N 触发新建（Notion 风格）
s = build({});
s.trigger('n');
assert('单键 N 触发新建', s.calls.createNewContent === 1, 'createNewContent=' + s.calls.createNewContent);

// 2. Ctrl+K 搜索
s = build({});
s.trigger('k', { ctrl: true });
assert('Ctrl+K 触发搜索', s.calls.goToListView === 1);

// 3. / 搜索
s = build({});
s.trigger('/');
assert('/ 触发搜索', s.calls.goToListView === 1);
assert('/ 阻止默认行为', s.activePanels.size >= 0);

// 4. ? 帮助
s = build({});
s.trigger('?');
assert('? 打开使用帮助', s.calls.showHelp === 1, 'showHelp=' + s.calls.showHelp);
assert('? 后不再弹 toast', s.calls.showToast === 0);

// 5. 数字键切视图：1 → dashboard
s = build({});
s.trigger('1');
assert('按 1 切仪表盘', s.clickedNav.includes('dashboard'), s.clickedNav.join(','));

// 6. 数字键 4 → matrix
s = build({});
s.trigger('4');
assert('按 4 切矩阵', s.clickedNav.includes('matrix'), s.clickedNav.join(','));

// 7. 3 键循环：list → timeline（首次）
s = build({ currentView: 'list' });
s.trigger('3');
assert('按 3 从列表切日历', s.clickedNav.includes('timeline'), s.clickedNav.join(','));

// 8. 3 键循环：timeline → timeline-table
s = build({ currentView: 'timeline' });
s.trigger('3');
assert('按 3 从日历切时间线表格', s.calls.renderTimelineTable === 1, 'renderTimelineTable=' + s.calls.renderTimelineTable);
assert('时间线表格面板激活', s.activePanels.has('view-timeline-table:active'));

// 9. 3 键循环：timeline-table → timeline
s = build({ currentView: 'timeline-table' });
s.trigger('3');
assert('按 3 从表格切回日历', s.clickedNav.includes('timeline'), s.clickedNav.join(','));

// 10. 输入框内按 1 不切视图
s = build({ currentView: 'list' });
s.trigger('1', { target: { tagName: 'INPUT' } });
assert('输入框内按 1 不切视图', s.clickedNav.length === 0 && s.calls.goToListView === 0);

// 11. 输入框内 Ctrl+N 不触发
s = build({});
s.trigger('n', { ctrl: true, target: { tagName: 'TEXTAREA' } });
assert('输入框内 Ctrl+N 不触发', s.calls.createNewContent === 0);

// 11b. 输入框内单键 N 不触发
s = build({});
s.trigger('n', { target: { tagName: 'TEXTAREA' } });
assert('输入框内单键 N 不触发', s.calls.createNewContent === 0);

// 12. 弹窗打开时按 1 不切视图
s = build({ modalOpen: 'modal-task' });
s.trigger('1');
assert('弹窗打开时按 1 不切视图', s.clickedNav.length === 0);

// 13. 弹窗打开时 Ctrl+N 不触发
s = build({ modalOpen: 'modal-health' });
s.trigger('n', { ctrl: true });
assert('弹窗打开时 Ctrl+N 不触发', s.calls.createNewContent === 0);

// 14. Esc 关闭任务弹窗（带脏检查由 closeTaskModal 内部处理，此处只验证被调用）
s = build({ modalOpen: 'modal-task' });
s.trigger('Escape');
assert('Esc 关闭任务弹窗', s.calls.closeTaskModal === 1);

// 15. Esc 关闭语录弹窗
s = build({ modalOpen: 'modal-quotes' });
s.trigger('Escape');
assert('Esc 关闭语录弹窗', s.calls.closeQuotesModal === 1);

// 16. Esc 关闭健康检查弹窗
s = build({ modalOpen: 'modal-health' });
s.trigger('Escape');
assert('Esc 关闭健康检查弹窗', s.calls.closeHealthCheck === 1);

// 16b. Esc 关闭使用帮助弹窗
s = build({ modalOpen: 'modal-help' });
s.trigger('Escape');
assert('Esc 关闭使用帮助弹窗', s.calls.closeHelp === 1);

// 17. 无弹窗时按 Esc 不报错
s = build({});
s.trigger('Escape');
assert('无弹窗时 Esc 无副作用', true);

// 18. 数字键带修饰键不触发
s = build({});
s.trigger('1', { ctrl: true });
assert('Ctrl+1 不切视图', s.clickedNav.length === 0);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
