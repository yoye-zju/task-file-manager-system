// 每日金句编辑功能验证（R3.32）
// 覆盖：startEditQuote 回填/按钮切换、handleAddQuote 编辑态更新/新增态添加、
//       cancelEditQuote 重置、deleteQuote 清理编辑态、空内容校验
// 运行：node _test_quotes_edit.js

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

console.log('=== 每日金句编辑功能测试 ===\n');

// 桩 localStorage
const storage = (function() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; })();

// 桩 DOM：输入框 value + 按钮容器
const domState = { textVal: '', authorVal: '', formHtml: '' };
const documentStub = {
  getElementById(id) {
    if (id === 'quote-add-text') return { set value(v) { domState.textVal = v; }, get value() { return domState.textVal; }, focus() {} };
    if (id === 'quote-add-author') return { set value(v) { domState.authorVal = v; }, get value() { return domState.authorVal; } };
    if (id === 'quote-add-form-actions') return { set innerHTML(v) { domState.formHtml = v; }, get innerHTML() { return domState.formHtml; } };
    return null;
  },
};
const toasts = [];
const showToast = (msg, type) => { toasts.push({ msg, type }); };
const noop = () => {};

// 提取真实函数源码（按依赖顺序拼接）
const codeSave = extract(/function saveQuotes\(\) \{[\s\S]*?\n\}/, 'saveQuotes');
const codeAdd = extract(/function addQuote\(text, author\) \{[\s\S]*?\n\}/, 'addQuote');
const codeDel = extract(/function deleteQuote\(id\) \{[\s\S]*?\n\}/, 'deleteQuote');
const codeStart = extract(/function startEditQuote\(id\) \{[\s\S]*?\n\}/, 'startEditQuote');
const codeCancel = extract(/function cancelEditQuote\(\) \{[\s\S]*?\n\}/, 'cancelEditQuote');
const codeHandle = extract(/function handleAddQuote\(\) \{[\s\S]*?\n\}/, 'handleAddQuote');

let quotesData = [];
let quoteEditingId = null;
const api = new Function('localStorage', 'document', 'showToast', 'renderQuotesManagementModal', 'renderQuotesPanel',
  'quotesData', 'quoteEditingId',
  codeSave + codeAdd + codeDel + codeStart + codeCancel + codeHandle +
  '\nreturn { saveQuotes, addQuote, deleteQuote, startEditQuote, cancelEditQuote, handleAddQuote };'
)(storage, documentStub, showToast, noop, noop, quotesData, quoteEditingId);

// 通过闭包保持引用一致：new Function 参数是快照，用返回的 setter 更新
// 简化：直接操作 api 内部状态——改为每次调用前重建环境
function freshEnv() {
  const s = (function() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; })();
  const ds = { textVal: '', authorVal: '', formHtml: '' };
  const doc = {
    getElementById(id) {
      if (id === 'quote-add-text') return { set value(v) { ds.textVal = v; }, get value() { return ds.textVal; }, focus() {} };
      if (id === 'quote-add-author') return { set value(v) { ds.authorVal = v; }, get value() { return ds.authorVal; } };
      if (id === 'quote-add-form-actions') return { set innerHTML(v) { ds.formHtml = v; }, get innerHTML() { return ds.formHtml; } };
      return null;
    },
  };
  const toasts2 = [];
  const t = (msg, type) => { toasts2.push({ msg, type }); };
  // 模拟 renderQuotesManagementModal：重渲染表单（按钮恢复「添加金句」）——与真实代码一致
  const nop = () => { ds.formHtml = '<button class="btn btn-primary btn-sm" onclick="handleAddQuote()">+ 添加金句</button>'; };
  let data = [];
  let editingId = null;
  let currentIds = [];
  const f = new Function('localStorage', 'document', 'showToast', 'renderQuotesManagementModal', 'renderQuotesPanel',
    'quotesData', 'quoteEditingId', 'currentQuoteIds',
    codeSave + codeAdd + codeDel + codeStart + codeCancel + codeHandle +
    '\nreturn { addQuote, deleteQuote, startEditQuote, cancelEditQuote, handleAddQuote, getData: () => quotesData, setData: (d) => { quotesData = d; }, getEditing: () => quoteEditingId, setEditing: (v) => { quoteEditingId = v; } };'
  )(s, doc, t, nop, nop, data, editingId, currentIds);
  return { f, s, ds, toasts2 };
}

// ── 1. 新增模式 ──
console.log('[1] 新增模式');
let env = freshEnv();
env.ds.textVal = '不积跬步，无以至千里';
env.ds.authorVal = '荀子';
env.f.handleAddQuote();
check('新增后数据 1 条', env.f.getData().length === 1, JSON.stringify(env.f.getData()));
check('内容与作者正确', env.f.getData()[0].text === '不积跬步，无以至千里' && env.f.getData()[0].author === '荀子');
check('id 为 1', env.f.getData()[0].id === 1);
check('localStorage 已持久化', env.s._m['ai-task-lens-quotes'] && env.s._m['ai-task-lens-quotes'].includes('荀子'));
check('提示已添加', env.toasts2.some(t2 => t2.msg === '金句已添加'));
check('空内容校验拦截', (() => { env2 = freshEnv(); env2.ds.textVal = '   '; env2.f.handleAddQuote(); return env2.f.getData().length === 0 && env2.toasts2.some(t2 => t2.msg === '请输入金句内容'); })());

// ── 2. startEditQuote 回填 + 按钮切换 ──
console.log('\n[2] 编辑模式进入');
env = freshEnv();
env.ds.textVal = '原文'; env.ds.authorVal = '作者A';
env.f.handleAddQuote();   // 新增 id=1
env.f.startEditQuote(1);
check('回填内容', env.ds.textVal === '原文');
check('回填作者', env.ds.authorVal === '作者A');
check('编辑态 id 记录', env.f.getEditing() === 1);
check('按钮切换为保存修改', env.ds.formHtml.includes('保存修改') && env.ds.formHtml.includes('取消'));
check('startEditQuote 不存在的 id 不崩', (() => { const e3 = freshEnv(); e3.f.startEditQuote(999); return e3.f.getEditing() === null; })());

// ── 3. 编辑模式保存更新 ──
console.log('\n[3] 编辑态保存');
env.ds.textVal = '修改后的金句';
env.ds.authorVal = '作者B';
env.f.handleAddQuote();
check('仍只有 1 条（更新非新增）', env.f.getData().length === 1);
check('内容已更新', env.f.getData()[0].text === '修改后的金句' && env.f.getData()[0].author === '作者B');
check('id 不变', env.f.getData()[0].id === 1);
check('编辑态已退出', env.f.getEditing() === null);
check('按钮恢复添加', env.ds.formHtml.includes('+ 添加金句'));
check('localStorage 已更新', env.s._m['ai-task-lens-quotes'].includes('修改后的金句'));
check('提示已更新', env.toasts2.some(t2 => t2.msg === '金句已更新'));

// ── 4. cancelEditQuote 重置 ──
console.log('\n[4] 取消编辑');
env = freshEnv();
env.ds.textVal = '内容1'; env.ds.authorVal = '';
env.f.handleAddQuote();
env.f.startEditQuote(1);
env.ds.textVal = '改了没保存';
env.f.cancelEditQuote();
check('编辑态退出', env.f.getEditing() === null);
check('表单清空', env.ds.textVal === '' && env.ds.authorVal === '');
check('按钮恢复添加', env.ds.formHtml.includes('+ 添加金句'));
check('数据未变（取消不保存）', env.f.getData()[0].text === '内容1');

// ── 5. deleteQuote 删除编辑中的金句 → 清理编辑态 ──
console.log('\n[5] 删除编辑中金句');
env = freshEnv();
env.ds.textVal = '要被删'; env.ds.authorVal = '';
env.f.handleAddQuote();
env.f.startEditQuote(1);
env.f.deleteQuote(1);
check('数据删除', env.f.getData().length === 0);
check('编辑态清理', env.f.getEditing() === null);

// ── 6. 静态检查：列表项含编辑按钮 ──
console.log('\n[6] 静态检查');
const mgmtCode = extract(/function renderQuotesManagementModal\(\) \{[\s\S]*?\n\}/, 'renderQuotesManagementModal');
check('列表项含编辑按钮', mgmtCode.includes('quote-mgmt-edit') && mgmtCode.includes('startEditQuote('));
check('表单按钮区有 id', mgmtCode.includes('id="quote-add-form-actions"'));
check('全局变量 quoteEditingId 声明', /let quoteEditingId = null/.test(src));
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
check('style.css 含 .quote-mgmt-edit', css.includes('.quote-mgmt-edit'));

console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
