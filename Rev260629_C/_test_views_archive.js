// 测试：各视图 isArchived 过滤感知 showArchived/archiveOnly
// 模拟各视图的过滤函数片段

let showArchived = false;
let archiveOnly = false;
let pass = 0, fail = 0;
function ck(d, cond) { if (cond) pass++; else { fail++; console.log('  FAIL  '+d); } }

// 模拟任务
const normalTask = { isArchived: false, type: 'schedule', deadline: '2026-08-15', status: 'progress', timestamp: '20260801' };
const normalDone = { isArchived: false, type: 'task', deadline: '2026-08-15', status: 'done', timestamp: '20260801' };
const archivedTask = { isArchived: true, type: 'schedule', deadline: '2026-08-15', status: 'progress', timestamp: '20260801' };
const archivedDone = { isArchived: true, type: 'task', deadline: '2026-08-15', status: 'done', timestamp: '20260801' };

// === renderCalendar 模拟 (line 1443) ===
function calFilter(t) {
  if (t.type !== 'schedule' || !t.deadline) return false;
  if (t.isArchived && !showArchived && !archiveOnly) return false;
  return true;
}

console.log('=== renderCalendar ===');
ck('1a 默认-普通', calFilter(normalTask) === true);
ck('1b 默认-已归档排除', calFilter(archivedTask) === false);
showArchived = true;
ck('1c 叠加-已归档显示', calFilter(archivedTask) === true);
showArchived = false; archiveOnly = true;
ck('1d 筛选-已归档显示', calFilter(archivedTask) === true);
ck('1e 筛选-普通排除(类型OK但...)', calFilter(normalTask) === true); // 普通未归档仍显示，由 matchSt 筛
archiveOnly = false;

// === renderTimelineLegacy 模拟 (line 1761) ===
function tlLegacyFilter(t) {
  if (t.status === 'done' || !t.deadline) return false;
  if (t.isArchived && !showArchived && !archiveOnly) return false;
  return true;
}
console.log('\n=== renderTimelineLegacy ===');
ck('2a 默认-普通', tlLegacyFilter(normalTask) === true);
ck('2b 默认-done排除', tlLegacyFilter(normalDone) === false);
ck('2c 默认-已归档排除', tlLegacyFilter(archivedTask) === false);
showArchived = true;
ck('2d 叠加-已归档显示', tlLegacyFilter(archivedTask) === true);
ck('2e 叠加-archivedDone仍排除', tlLegacyFilter(archivedDone) === false); // done 永远排除
showArchived = false; archiveOnly = true;
ck('2f 筛选-已归档显示', tlLegacyFilter(archivedTask) === true);

// === renderTimelineTable 模拟 (line 2360) ===
function tlTableFilter(t) {
  return t && (!t.isArchived || showArchived || archiveOnly);
}
console.log('\n=== renderTimelineTable ===');
archiveOnly = false; showArchived = false;
ck('3a 默认-普通', tlTableFilter(normalTask) === true);
ck('3b 默认-已归档排除', tlTableFilter(archivedTask) === false);
showArchived = true;
ck('3c 叠加-已归档显示', tlTableFilter(archivedTask) === true);
showArchived = false; archiveOnly = true;
ck('3d 筛选-已归档显示', tlTableFilter(archivedTask) === true);

// === renderMatrix 模拟 (line 2109) ===
function matrixFilter(t) {
  return t.status !== 'done' && (!t.isArchived || showArchived || archiveOnly);
}
console.log('\n=== renderMatrix ===');
archiveOnly = false; showArchived = false;
ck('4a 默认-普通', matrixFilter(normalTask) === true);
ck('4b 默认-done排除', matrixFilter(normalDone) === false);
ck('4c 默认-已归档排除', matrixFilter(archivedTask) === false);
showArchived = true;
ck('4d 叠加-已归档显示', matrixFilter(archivedTask) === true);
ck('4e 叠加-archivedDone仍排除', matrixFilter(archivedDone) === false);
showArchived = false; archiveOnly = true;
ck('4f 筛选-已归档显示', matrixFilter(archivedTask) === true);

// === renderBoard 模拟 (line 2219) ===
function boardFilter(t) {
  if (t.status === 'done') return false;
  if (t.isArchived && !showArchived && !archiveOnly) return false;
  return true;
}
console.log('\n=== renderBoard ===');
archiveOnly = false; showArchived = false;
ck('5a 默认-普通', boardFilter(normalTask) === true);
ck('5b 默认-已归档排除', boardFilter(archivedTask) === false);
showArchived = true;
ck('5c 叠加-已归档显示', boardFilter(archivedTask) === true);
ck('5d 叠加-archivedDone仍排除', boardFilter(archivedDone) === false);
showArchived = false; archiveOnly = true;
ck('5e 筛选-已归档显示', boardFilter(archivedTask) === true);

// === buildRow 模拟 (line 639) ===
function buildRowSkip(t) {
  return t.isArchived && !showArchived && !archiveOnly;
}
console.log('\n=== buildRow ===');
archiveOnly = false; showArchived = false;
ck('6a 默认-已归档跳过', buildRowSkip(archivedTask) === true);
ck('6b 默认-普通不跳过', buildRowSkip(normalTask) === false);
showArchived = true;
ck('6c 叠加-已归档不跳过', buildRowSkip(archivedTask) === false);
showArchived = false; archiveOnly = true;
ck('6d 筛选-已归档不跳过', buildRowSkip(archivedTask) === false);

// === 提示文字 ===
console.log('\n=== 提示文字 ===');
archiveOnly = false; showArchived = false;
ck('7a 默认=排除已归档', (archiveOnly ? '仅已归档' : (showArchived ? '含已归档' : '排除已归档')) === '排除已归档');
showArchived = true;
ck('7b 叠加=含已归档', (archiveOnly ? '仅已归档' : (showArchived ? '含已归档' : '排除已归档')) === '含已归档');
showArchived = false; archiveOnly = true;
ck('7c 筛选=仅已归档', (archiveOnly ? '仅已归档' : (showArchived ? '含已归档' : '排除已归档')) === '仅已归档');

console.log('\n结果: '+pass+' pass / '+fail+' fail');
if (fail > 0) process.exit(1);
