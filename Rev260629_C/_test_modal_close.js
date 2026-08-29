// _test_modal_close.js
// R3.4: 编辑弹窗防误关保护测试
// Usage: node _test_modal_close.js

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');
let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

console.log('=== R3.4 编辑弹窗防误关保护测试 ===\n');

// ── 1. 静态检查：核心函数存在 ──
console.log('[1] 核心函数存在');
check('源码包含 getFormSnapshot', src.includes('function getFormSnapshot()'));
check('源码包含 snapshotForm', src.includes('function snapshotForm()'));
check('源码包含 closeTaskModal', src.includes('function closeTaskModal(force)'));
check('源码包含 formSnapshot 声明', src.includes("let formSnapshot = ''"));

// ── 2. 静态检查：遮罩点击关闭已删除 ──
console.log('\n[2] 遮罩点击关闭已删除');
check('不再有 modal-task 遮罩点击关闭监听', !/modal-task'\)\.addEventListener\('click'/.test(src));
check('保留 modal-ai 遮罩点击关闭', /modal-ai'\)\.addEventListener\('click'/.test(src));

// ── 3. 静态检查：入口函数调用 snapshotForm ──
console.log('\n[3] 入口函数调用 snapshotForm');
const fnBlocks = [
  'function createScheduleOn',
  'function addChildTask',
  'function addNextTask',
  'function createNewContent',
  'function editTask',
];
fnBlocks.forEach(function(name) {
  const start = src.indexOf(name);
  const savePos = src.indexOf('function saveTask', start);
  const snapPos = src.indexOf('snapshotForm()', start);
  check(name + ' 函数内调用 snapshotForm()', start >= 0 && snapPos > start && (savePos < 0 || snapPos < savePos));
});
// btn-add-task 是内联点击处理，紧跟其后的 snapshotForm()
check('btn-add-task 处理内调用 snapshotForm()', /btn-add-task'\)\.addEventListener\('click'[\s\S]*?snapshotForm\(\);/.test(src));

// ── 4. 静态检查：关闭路径改造 ──
console.log('\n[4] 关闭路径改造');
check('✕ 按钮调 closeTaskModal(false)', /btn-task-close'\)\.addEventListener\('click', \(\) => \{\s*\n\s*closeTaskModal\(false\);/.test(src));
check('取消按钮调 closeTaskModal(false)', /btn-task-cancel'\)\.addEventListener\('click', \(\) => \{\s*\n\s*closeTaskModal\(false\);/.test(src));
check('删除按钮调 closeTaskModal(true)', src.includes('deleteTask(editingTaskId); closeTaskModal(true);'));
check('navigateToEntity 新建模式调 closeTaskModal(false)', src.includes('if (!closeTaskModal(false)) return;'));
check('saveTask 成功调 closeTaskModal(true)', src.includes("closeTaskModal(true);\n  dataSource = 'manual';"));

// ── 5+6. 动态测试：提取三连块，用 eval 建立闭包 ──
console.log('\n[5] 动态行为测试');
const blockStart = src.indexOf('function getFormSnapshot()');
const blockEnd = src.indexOf('function saveTask()');
const block = blockStart >= 0 && blockEnd > blockStart ? src.slice(blockStart, blockEnd) : null;
check('成功提取 getFormSnapshot/snapshotForm/closeTaskModal 块', !!block);

if (block) {
  function runBlock(state) {
    const fields = Object.assign({}, state.fields);
    const document = {
      getElementById: function(id) {
        return {
          get value() { return fields[id] !== undefined ? fields[id] : ''; },
          set value(v) { fields[id] = v; },
          checked: fields[id + ':c'] === true,
          style: { display: '' },
        };
      },
      querySelectorAll: function() { return []; },
    };
    const confirmCalls = [];
    const confirm = function(msg) { confirmCalls.push(msg); return !!state.confirmRet; };
    let selectedDeps = new Set(state.deps || []);
    let selectedNexts = new Set(state.nexts || []);
    let selectedFiles = (state.files || []).slice();
    const _recurDateList = function() { return state.recurDates || []; };
    let editingTaskId = state.editingTaskId || null;
    let nextParentTaskId = state.nextParentTaskId || null;
    let formSnapshot = state.formSnapshot || '';

    // eslint-disable-next-line no-eval
    const api = eval('(function(){' + block +
      '\nreturn { getFormSnapshot: getFormSnapshot, snapshotForm: snapshotForm, closeTaskModal: closeTaskModal,' +
      ' get editingTaskId(){return editingTaskId;}, get nextParentTaskId(){return nextParentTaskId;},' +
      ' get selectedDeps(){return selectedDeps;}, get selectedNexts(){return selectedNexts;}, get selectedFiles(){return selectedFiles;},' +
      ' get confirmCalls(){return confirmCalls;}, setFormSnapshot: function(s){formSnapshot=s;} };})()');
    return { api: api, fields: fields };
  }

  // 5a. getFormSnapshot 序列化关键字段
  const s1 = runBlock({
    fields: {
      'task-type': 'task', 'task-parent': '123', 'task-title': '测试任务',
      'task-priority': '重要不紧急', 'task-status': 'todo', 'task-deadline': '2026-08-20',
      'task-progress': '30', 'task-tag': '研究', 'task-assignee': '张三',
      'task-startdate': '2026-08-14', 'task-desc': '描述内容',
    },
    deps: [5, 3], nexts: [9], files: [{ name: 'a.pdf' }],
  });
  const snapObj = JSON.parse(s1.api.getFormSnapshot());
  check('getFormSnapshot 序列化 title 正确', snapObj.title === '测试任务');
  check('getFormSnapshot 序列化 deps 排序', snapObj.deps === '3,5');
  check('getFormSnapshot 序列化 next', snapObj.next === '9');
  check('getFormSnapshot 序列化 files', snapObj.files === 'a.pdf');

  // 5b. 无改动：不弹确认直接关
  const s2 = runBlock({ fields: { 'task-title': 'A' }, editingTaskId: 1, nextParentTaskId: 2 });
  s2.api.snapshotForm();
  const r2 = s2.api.closeTaskModal(false);
  check('无改动时 closeTaskModal 返回 true', r2 === true);
  check('无改动时不弹确认', s2.api.confirmCalls.length === 0);

  // 5c. 有改动：弹确认，confirm=false 不关闭
  const s3 = runBlock({ fields: { 'task-title': 'A' }, editingTaskId: 1, nextParentTaskId: 2, confirmRet: false });
  s3.api.snapshotForm();
  s3.fields['task-title'] = 'B';
  const r3 = s3.api.closeTaskModal(false);
  check('有改动时弹确认', s3.api.confirmCalls.length === 1);
  check('confirm=false 时 closeTaskModal 返回 false', r3 === false);
  check('confirm=false 时 editingTaskId 未清空', s3.api.editingTaskId === 1);

  // 5d. 有改动：confirm=true 关闭并清理
  const s4 = runBlock({ fields: { 'task-title': 'A' }, editingTaskId: 1, nextParentTaskId: 2, confirmRet: true, deps: [1,2], nexts: [3], files: [{name:'x'}] });
  s4.api.snapshotForm();
  s4.fields['task-title'] = 'B';
  const r4 = s4.api.closeTaskModal(false);
  check('confirm=true 时 closeTaskModal 返回 true', r4 === true);
  check('confirm=true 时 editingTaskId 清空为 null', s4.api.editingTaskId === null);
  check('confirm=true 时 nextParentTaskId 清空为 null', s4.api.nextParentTaskId === null);
  check('confirm=true 时 selectedDeps 清空', s4.api.selectedDeps.size === 0);
  check('confirm=true 时 selectedNexts 清空', s4.api.selectedNexts.size === 0);
  check('confirm=true 时 selectedFiles 清空', s4.api.selectedFiles.length === 0);

  // 5e. force=true 跳过确认
  const s5 = runBlock({ fields: { 'task-title': 'A' }, editingTaskId: 1, confirmRet: false });
  s5.api.snapshotForm();
  s5.fields['task-title'] = 'B';
  const r5 = s5.api.closeTaskModal(true);
  check('force=true 跳过确认直接关闭', r5 === true && s5.api.confirmCalls.length === 0);
}

console.log('\n===== 结果: ' + pass + ' 通过, ' + fail + ' 失败 =====');
process.exit(fail > 0 ? 1 : 0);
