// _test_quick_create_next.js — R3.34 后置任务「＋ 新建」打开完整新建弹窗测试
// 从 app.js 提取 quickCreateNextTask / addNextTask 真实源码，new Function 注入桩依赖，不重写逻辑。
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  => ' + extra : '')); }
}

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ── 静态检查 ──
console.log('== 静态结构 ==');
check('app.js 定义 quickCreateNextTask', /function quickCreateNextTask\(/.test(src));
check('app.js 定义 addNextTask', /function addNextTask\(/.test(src));
check('index.html 含 btn-quick-create-next 按钮', html.includes('id="btn-quick-create-next"'));
check('按钮文案「＋ 新建」', html.includes('＋ 新建'));
check('按钮位于后置任务 label 行', /后置任务[\s\S]{0,200}btn-quick-create-next/.test(html));
check('按钮 type=button（不触发表单提交）', /type="button"[^>]*id="btn-quick-create-next"/.test(html));
check('事件绑定 quickCreateNextTask', /getElementById\('btn-quick-create-next'\)[\s\S]{0,120}quickCreateNextTask\(/.test(src));
check('style.css 有 .dep-create-btn 样式', fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8').includes('.dep-create-btn'));
check('quickCreateNextTask 不再用 prompt（改为完整弹窗）', !/function quickCreateNextTask\(\) \{[\s\S]*?\nprompt\(/.test(src.match(/function quickCreateNextTask\(\) \{[\s\S]*?\n\}/)[0]));
check('quickCreateNextTask 先 saveTask 再 addNextTask', /saveTask\(\)[\s\S]{0,120}addNextTask\(/.test(src.match(/function quickCreateNextTask\(\) \{[\s\S]*?\n\}/)[0]));
check('addNextTask 预填开始时间为前置 deadline', /resetTaskForm\(\{[^\}]*startDate:\s*parent\.deadline/.test(src.match(/function addNextTask\(parentId\) \{[\s\S]*?\n\}/)[0]));

// ── 提取真实函数源码 ──
const qm = src.match(/function quickCreateNextTask\(\) \{[\s\S]*?\n\}/);
const am = src.match(/function addNextTask\(parentId\) \{[\s\S]*?\n\}/);
check('成功提取 quickCreateNextTask 源码', !!qm);
check('成功提取 addNextTask 源码', !!am);

// ── quickCreateNextTask 行为测试 ──
// 桩：editingTaskId 用 holder 承载（函数内只读，但模拟不同场景）
function runQuick(opts) {
  const calls = { save: 0, addNext: [], timers: 0, toasts: [] };
  const holder = { editingTaskId: opts.editingTaskId };
  const saveTask = () => { calls.save++; return opts.saveResult; };
  const addNextTask = (pid) => { calls.addNext.push(pid); };
  const showToast = (msg, type) => calls.toasts.push({ msg, type });
  // setTimeout 同步执行
  const setTimeout = (fn) => { calls.timers++; fn(); };
  const factory = new Function(
    'holder', 'saveTask', 'addNextTask', 'showToast', 'setTimeout',
    qm[0].replace(/\beditingTaskId\b/g, 'holder.editingTaskId') + '\nreturn quickCreateNextTask;'
  );
  const fn = factory(holder, saveTask, addNextTask, showToast, setTimeout);
  fn();
  return { calls, holder };
}

console.log('== 行为：编辑已有任务，保存成功 → 打开新建弹窗 ==');
let r = runQuick({ editingTaskId: 42, saveResult: true });
check('先调用 saveTask 静默保存', r.calls.save === 1, 'save=' + r.calls.save);
check('保存成功后调 addNextTask', r.calls.addNext.length === 1, 'addNext=' + r.calls.addNext.length);
check('addNextTask 入参 = 当前任务 id（前置锚点）', r.calls.addNext[0] === 42, 'arg=' + r.calls.addNext[0]);
check('通过 setTimeout 延时打开（等 saveTask 内 close/render 完成）', r.calls.timers === 1);
check('无 warn 提示', !r.calls.toasts.some(t => t.type === 'warn'));

console.log('== 行为：保存失败/取消（saveTask 返回 false）→ 中止 ==');
r = runQuick({ editingTaskId: 42, saveResult: false });
check('调用了 saveTask', r.calls.save === 1);
check('保存失败时不打开 addNextTask', r.calls.addNext.length === 0, 'addNext=' + r.calls.addNext.length);
check('不设 setTimeout', r.calls.timers === 0);

console.log('== 行为：新建未保存模式（editingTaskId=null）→ 提示先保存 ==');
r = runQuick({ editingTaskId: null, saveResult: true });
check('不调用 saveTask', r.calls.save === 0);
check('不打开 addNextTask', r.calls.addNext.length === 0);
check('弹 warn 提示先保存', r.calls.toasts.some(t => t.type === 'warn' && t.msg.includes('先保存')));

// ── addNextTask 开始时间预填测试 ──
function runAddNext(parentTask) {
  const tasks = [parentTask];
  const calls = { reset: null, renderDep: 0, renderNext: 0, renderParent: 0, preview: 0, snapshot: 0, title: '', modalShown: false, deps: null, nexts: null };
  const elements = {};
  const mkEl = (id) => {
    if (!elements[id]) elements[id] = { style: {}, value: '', textContent: '', _id: id };
    return elements[id];
  };
  const document = { getElementById: mkEl };
  const resetTaskForm = (defaults) => { calls.reset = defaults; };
  const renderDepSelector = () => { calls.renderDep++; };
  const renderNextSelector = () => { calls.renderNext++; };
  const renderParentSelector = (pid, type) => { calls.renderParent++; calls.parentArgs = [pid, type]; };
  const updateTaskPreview = () => { calls.preview++; };
  const snapshotForm = () => { calls.snapshot++; };
  // selectedDeps / selectedNexts / nextParentTaskId / editingTaskId 用 holder 承载
  const holder = { editingTaskId: 999, nextParentTaskId: null, selectedDeps: new Set([1, 2]), selectedNexts: new Set([3]) };
  const factory = new Function(
    'tasks', 'holder', 'document', 'resetTaskForm',
    'renderDepSelector', 'renderNextSelector', 'renderParentSelector', 'updateTaskPreview', 'snapshotForm',
    am[0]
      .replace(/\beditingTaskId\b/g, 'holder.editingTaskId')
      .replace(/\bnextParentTaskId\b/g, 'holder.nextParentTaskId')
      .replace(/\bselectedDeps\b/g, 'holder.selectedDeps')
      .replace(/\bselectedNexts\b/g, 'holder.selectedNexts')
    + '\nreturn addNextTask;'
  );
  const fn = factory(tasks, holder, document, resetTaskForm, renderDepSelector, renderNextSelector, renderParentSelector, updateTaskPreview, snapshotForm);
  fn(parentTask.id);
  return { calls, holder, elements };
}

console.log('== 行为：addNextTask 预填前置 + 开始时间 ==');
r = runAddNext({ id: 7, type: 'task', parentId: 99, deadline: '2026-09-10' });
check('resetTaskForm 收到 type=task', r.calls.reset && r.calls.reset.type === 'task');
check('开始时间预填 = 前置 deadline（2026-09-10）', r.calls.reset && r.calls.reset.startDate === '2026-09-10', 'startDate=' + (r.calls.reset && r.calls.reset.startDate));
check('editingTaskId 置 null（新建模式）', r.holder.editingTaskId === null);
check('nextParentTaskId = 前置 id', r.holder.nextParentTaskId === 7);
check('selectedDeps 重置为仅含前置（[7]）', r.holder.selectedDeps.size === 1 && r.holder.selectedDeps.has(7), 'deps=[' + [...r.holder.selectedDeps] + ']');
check('selectedNexts 清空', r.holder.selectedNexts.size === 0);
check('弹窗标题为「添加后置任务」', r.elements['modal-task-title'] && r.elements['modal-task-title'].textContent.includes('后置任务'));
check('modal 显示', r.elements['modal-task'] && r.elements['modal-task'].style.display === 'flex');
check('renderParentSelector 用前置 parentId/type', r.calls.parentArgs && r.calls.parentArgs[0] === 99 && r.calls.parentArgs[1] === 'task');
check('调用 updateTaskPreview + snapshotForm', r.calls.preview === 1 && r.calls.snapshot === 1);

console.log('== 行为：前置无 deadline 时 startDate 传空串（由 resetTaskForm 回落今天）==');
r = runAddNext({ id: 8, type: 'task', parentId: null, deadline: null });
check('startDate 为空串（不硬编码今天，交给 resetTaskForm 统一回落）', r.calls.reset && r.calls.reset.startDate === '', 'startDate=' + JSON.stringify(r.calls.reset && r.calls.reset.startDate));

console.log('== 行为：前置不存在直接 return ==');
(function () {
  const tasks = [];
  const holder = { editingTaskId: 1, nextParentTaskId: null, selectedDeps: new Set(), selectedNexts: new Set() };
  const document = { getElementById: () => ({ style: {}, textContent: '' }) };
  let resetCalled = false;
  const noop = () => {};
  const factory = new Function(
    'tasks', 'holder', 'document', 'resetTaskForm',
    'renderDepSelector', 'renderNextSelector', 'renderParentSelector', 'updateTaskPreview', 'snapshotForm',
    am[0]
      .replace(/\beditingTaskId\b/g, 'holder.editingTaskId')
      .replace(/\bnextParentTaskId\b/g, 'holder.nextParentTaskId')
      .replace(/\bselectedDeps\b/g, 'holder.selectedDeps')
      .replace(/\bselectedNexts\b/g, 'holder.selectedNexts')
    + '\nreturn addNextTask;'
  );
  const fn = factory(tasks, holder, document, () => { resetCalled = true; }, noop, noop, noop, noop, noop);
  fn(999);  // 不存在的 id
  check('前置不存在时不调 resetTaskForm', resetCalled === false);
  check('前置不存在时 nextParentTaskId 保持 null', holder.nextParentTaskId === null);
})();

console.log('\n================ 结果 ================');
console.log('通过 ' + pass + '，失败 ' + fail);
if (fail > 0) process.exit(1);
