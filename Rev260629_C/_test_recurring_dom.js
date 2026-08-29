/**
 * 周期任务表单联动 DOM 桩测试（R3.1）
 *
 * 方法论（项目铁律：前端 UI 状态必须 DOM 级测试）：
 *   从 app.js 提取**整个 RECURRING TASKS 区块**的真实源码，注入 DOM 桩执行，
 *   断言"勾选周期/改日期/点选日期"这些 UI 交互的联动结果。
 *   提取整块保证区块内部函数互引完整，绝不在测试里重写逻辑。
 *
 * 覆盖：
 *   1. toggleRecurringUI 勾选后 → 面板显示、startDate=deadline（原则1）
 *   2. syncRecurringDates 改截止 → 开始同步（双向）
 *   3. _readRecurRuleFromForm 读频率/星期/日号
 *   4. toggleMiniDate 手选/删除
 *   5. _recurDateList 规则∪手选去重升序
 */
const fs = require('fs');
const path = require('path');

const APP_PATH = path.join(__dirname, 'app.js');
const src = fs.readFileSync(APP_PATH, 'utf8');

// 提取整个 RECURRING 区块
const startMarker = '// ============ RECURRING TASKS';
const endMarker = '// ============ DAILY QUOTES';
const blockStart = src.indexOf(startMarker);
const blockEnd = src.indexOf(endMarker);
if (blockStart === -1 || blockEnd === -1) throw new Error('找不到 RECURRING TASKS 区块边界');
const block = src.slice(blockStart, blockEnd);

// ── DOM 桩 ──
const domStub = `
  var _els = {};
  function _el(id) {
    if (!_els[id]) {
      _els[id] = {
        id: id, value: '', checked: false, style: {}, innerHTML: '', _display: '',
        querySelectorAll: function() { return []; }
      };
      Object.defineProperty(_els[id], 'display', {
        get: function() { return this._display; },
        set: function(v) { this._display = v; }
      });
    }
    return _els[id];
  }
  function getElementById(id) { return _el(id); }
  function querySelectorAll(sel) {
    if (sel === '.recur-wd:checked') return _wdAll.filter(function(c) { return c.checked; });
    if (sel === '.recur-wd') return _wdAll;
    return [];
  }
  var _wdAll = [1,2,3,4,5,6,7].map(function(v) { return { value: String(v), checked: false }; });
  _wdAll[0].checked = true;  // 周一
  _wdAll[2].checked = true;  // 周三
  var document = { getElementById: getElementById, querySelectorAll: querySelectorAll };
  var editingTaskId = null;
  var tasks = [];
  function formatDateLocal(d) {
    var y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }
  function saveData() {}
  function renderCalendar() {}
`;

const runtime = new Function(domStub + '\n' + block + `
  return {
    _el: _el,
    wdAll: function() { return _wdAll; },
    toggleRecurringUI: toggleRecurringUI,
    syncRecurringDates: syncRecurringDates,
    toggleMiniDate: toggleMiniDate,
    readRule: _readRecurRuleFromForm,
    dateList: _recurDateList,
    autoDates: function() { return Array.from(_recurAutoDates); },
    manualDates: function() { return Array.from(_recurManualDates); },
    setTask: function(v) { tasks = v; },
    setEditing: function(v) { editingTaskId = v; },
    applyRule: _applyRecurRule,
    _resetRecurringState: _resetRecurringState,
  };
`)();

let passed = 0, failed = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + '\n     期望 ' + e + '\n     实际 ' + a); }
}

console.log('== 周期任务表单联动 DOM 桩测试 ==');

// 1. 勾选周期 → 面板显示 + startDate 强制=deadline（原则1）+ 不自动生成日期
runtime._el('task-deadline').value = '2026-08-10';
runtime._el('task-startdate').value = '2026-08-15';
runtime._el('recur-freq').value = 'daily';
runtime._el('task-recurring').checked = true;
runtime.toggleRecurringUI();
assertEq('勾选周期后面板显示', runtime._el('recurring-panel').style.display, 'block');
assertEq('勾选周期后 startDate=deadline（原则1）', runtime._el('task-startdate').value, '2026-08-10');
assertEq('勾选后不自动生成日期（auto 空）', runtime.autoDates().length, 0);
assertEq('勾选后 manual 也为空', runtime.manualDates().length, 0);

// 2. 手动触发「按规则生成」→ 才生成日期
runtime.applyRule();
assertEq('按规则生成（daily 90天）', runtime.autoDates().length, 91);
assertEq('按规则生成首日=开始日', runtime.autoDates()[0], '2026-08-10');

// 3. 周期态下改截止日期 → 开始同步，但已选日期不重算（默认手选模式）
runtime._el('task-deadline').value = '2026-08-20';
runtime.syncRecurringDates('deadline');
assertEq('改截止→开始同步', runtime._el('task-startdate').value, '2026-08-20');
assertEq('改截止不重算已生成日期', runtime.autoDates()[0], '2026-08-10');

// 4. 改开始日期 → 截止同步（反向）
runtime._el('task-startdate').value = '2026-08-25';
runtime.syncRecurringDates('startDate');
assertEq('改开始→截止同步', runtime._el('task-deadline').value, '2026-08-25');

// 5. 读规则：weekly 周一+周三
runtime._el('recur-freq').value = 'weekly';
assertEq('读取 weekly 规则', runtime.readRule(), { freq: 'weekly', interval: 1, weekdays: [1, 3] });

// 6. 读规则：monthly 15号
runtime._el('recur-freq').value = 'monthly';
runtime._el('recur-dom').value = '15';
assertEq('读取 monthly 规则', runtime.readRule(), { freq: 'monthly', interval: 1, dayOfMonth: 15 });

// 7. 迷你月历点选：手选加入 manual（8/15 是周六，weekly 周一+周三规则不含）
runtime._el('task-recurring').checked = true;
runtime._el('recur-freq').value = 'weekly';
runtime._el('task-deadline').value = '2026-08-10';
runtime._resetRecurringState(); // 清掉上一步 daily 生成结果，模拟重新勾选
runtime.applyRule();
assertEq('weekly 规则生成（桩勾周一+周三）', runtime.autoDates().slice(0, 3), ['2026-08-10', '2026-08-12', '2026-08-17']);
runtime.setEditing(999);
const fakeTask = { id: 999 };
runtime.setTask([fakeTask]);
runtime.toggleMiniDate('2026-08-15'); // 手选一个非规则日期（周六）
assertEq('手选加入 manual', runtime.manualDates(), ['2026-08-15']);
assertEq('总集合含手选', runtime.dateList().indexOf('2026-08-15') !== -1, true);
runtime.toggleMiniDate('2026-08-10'); // 点掉一个规则日期（周一）
assertEq('点掉 auto 日期', runtime.autoDates().indexOf('2026-08-10') === -1, true);
runtime.toggleMiniDate('2026-08-15'); // 再点掉手选日期
assertEq('再点掉 manual', runtime.manualDates(), []);

// 8. 取消勾选 → 状态清空
runtime._el('task-recurring').checked = false;
runtime.toggleRecurringUI();
assertEq('取消勾选后面板隐藏', runtime._el('recurring-panel').style.display, 'none');
assertEq('取消勾选后 auto 清空', runtime.autoDates().length, 0);
assertEq('取消勾选后 manual 清空', runtime.manualDates().length, 0);

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
