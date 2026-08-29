// 归档状态一致性测试：checkbox checked 状态 + 三种模式的过滤结果
// 从 app.js 中提取 isArchivedOf 真实实现来跑断言，避免测试和实现脱节
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');

// 提取真实的 isArchivedOf 函数定义
const m = src.match(/function isArchivedOf\(t\) \{[\s\S]*?\n\}/);
if (!m) { console.error('FAIL: 未找到 isArchivedOf 定义'); process.exit(1); }
eval(m[0]);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('\n[1] isArchivedOf 判据覆盖各种数据类型');
ok(isArchivedOf({ isArchived: true }) === true, 'boolean true → 已归档');
ok(isArchivedOf({ isArchived: 'true' }) === true, "string 'true' → 已归档");
ok(isArchivedOf({ isArchived: 1 }) === true, 'number 1 → 已归档');
ok(isArchivedOf({ isArchived: '1' }) === true, "string '1' → 已归档");
ok(isArchivedOf({ isArchived: false }) === false, 'boolean false → 未归档');
ok(isArchivedOf({ isArchived: 'false' }) === false, "string 'false' → 未归档（关键：旧写法会误判为已归档）");
ok(isArchivedOf({ isArchived: '' }) === false, '空字符串 → 未归档');
ok(isArchivedOf({ isArchived: undefined }) === false, 'undefined → 未归档');
ok(isArchivedOf({}) === false, '字段缺失 → 未归档');
ok(isArchivedOf(null) === false, 'null 任务 → 未归档（不抛错）');

console.log('\n[2] renderTimelineTable 的 checkbox checked 必须与过滤结果一致');
// 模拟数据集：混合类型
const tasks = [
  { id: 1, title: 'A', isArchived: true,    timestamp: '2026-07-01 10:00' },
  { id: 2, title: 'B', isArchived: 'true',  timestamp: '2026-07-02 10:00' },
  { id: 3, title: 'C', isArchived: false,   timestamp: '2026-07-03 10:00' },
  { id: 4, title: 'D', isArchived: 'false', timestamp: '2026-07-04 10:00' },
  { id: 5, title: 'E',                      timestamp: '2026-07-05 10:00' },
];

// 复刻 renderTimelineTable 的 filter 表达式（与 app.js line 2367 一致）
function tlFilter(showArchived, archiveOnly) {
  return tasks.filter(t => t && (archiveOnly ? isArchivedOf(t) : (!isArchivedOf(t) || showArchived)));
}

// 默认模式：排除已归档 → 应只剩 3,4,5
let r = tlFilter(false, false).map(t => t.id);
ok(JSON.stringify(r) === JSON.stringify([3, 4, 5]), '默认模式排除已归档 → [3,4,5]，实际 [' + r + ']');

// 叠加模式：全部显示
r = tlFilter(true, false).map(t => t.id);
ok(JSON.stringify(r) === JSON.stringify([1, 2, 3, 4, 5]), '叠加模式显示全部 → [1..5]，实际 [' + r + ']');

// 筛选模式：仅已归档 → 应只剩 1,2
r = tlFilter(false, true).map(t => t.id);
ok(JSON.stringify(r) === JSON.stringify([1, 2]), '筛选模式仅已归档 → [1,2]，实际 [' + r + ']');

console.log('\n[3] 一致性铁律：过滤器保留的行，其 checkbox 状态必须与判据一致');
// 叠加模式下所有行都在，逐行核对 checked
const all = tlFilter(true, false);
const expectChecked = { 1: true, 2: true, 3: false, 4: false, 5: false };
all.forEach(t => {
  const rendered = isArchivedOf(t);   // 这就是 checkbox 的 checked 依据
  ok(rendered === expectChecked[t.id],
     `id=${t.id} (isArchived=${JSON.stringify(t.isArchived)}) checkbox checked=${rendered}，期望 ${expectChecked[t.id]}`);
});

// 筛选模式下留下的行，checkbox 必须全部勾选（用户诉求：不能有空框）
const onlyArchived = tlFilter(false, true);
ok(onlyArchived.length > 0 && onlyArchived.every(t => isArchivedOf(t) === true),
   '筛选模式下留下的所有行，checkbox 必须全部为勾选态（无空框）');

console.log('\n[4] toggleArchived 归一化：字符串取反不能出错');
function toggleSim(t) { t.isArchived = !isArchivedOf(t); return t.isArchived; }
ok(toggleSim({ isArchived: 'false' }) === true,  "'false' 取反 → true（旧写法 !'false' = false，是 bug）");
ok(toggleSim({ isArchived: 'true' }) === false,  "'true' 取反 → false");
ok(toggleSim({ isArchived: true }) === false,    'true 取反 → false');
ok(toggleSim({}) === true,                       '字段缺失 取反 → true');

console.log('\n[5] 静态检查：源码中不应再有裸 t.isArchived 真值判断');
const bad = [];
src.split('\n').forEach((line, i) => {
  if (/function isArchivedOf/.test(line)) return;
  if (/const v = t\.isArchived/.test(line)) return;
  if (/t\.isArchived\s*=/.test(line)) return;              // 赋值语句
  if (/t\.isArchived === undefined/.test(line)) return;     // 迁移检查
  if (/typeof t\.isArchived/.test(line)) return;            // 迁移归一化
  if (/JSON\.stringify\(t\.isArchived\)/.test(line)) return; // 错误信息里展示值，非真值判断
  if (/isArchived:\s*isArchivedOf/.test(line)) return;
  if (/idx\.isArchived/.test(line)) return;                  // CSV 导入列索引
  if (/'isArchived'/.test(line) || /"isArchived"/.test(line)) return;  // header 声明
  if (/\.isArchived/.test(line) && !/isArchivedOf/.test(line)) {
    bad.push((i + 1) + ': ' + line.trim().slice(0, 110));
  }
});
if (bad.length) { bad.forEach(b => console.log('    ! ' + b)); }
ok(bad.length === 0, '无遗留的裸 .isArchived 真值判断（发现 ' + bad.length + ' 处）');

console.log('\n[6] 静态检查：时间线表格 checkbox 已绑定 checked');
const tlCheckbox = src.split('\n').find(l => /toggleArchived/.test(l) && /event\.stopPropagation/.test(l));
ok(!!tlCheckbox && /\$\{isArchivedFlag \? 'checked' : ''\}/.test(tlCheckbox),
   '时间线表格 checkbox 含 ${isArchivedFlag ? \'checked\' : \'\'} 绑定');
ok(!!tlCheckbox && /isArchivedFlag \? '点击取消归档' : '点击归档'/.test(tlCheckbox),
   '时间线表格 checkbox title 随状态变化');

console.log(`\n===== 结果: ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
