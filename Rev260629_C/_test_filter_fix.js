// 测试：renderTimelineTable / renderMatrix 筛选模式正确过滤
let showArchived = false;
let archiveOnly = false;
let pass = 0, fail = 0;
function ck(d, cond) { if (cond) pass++; else { fail++; console.log('  FAIL  '+d); } }

const normal = { isArchived: false, status: 'progress' };
const archived = { isArchived: true, status: 'progress' };
const archivedDone = { isArchived: true, status: 'done' };
const normalDone = { isArchived: false, status: 'done' };

// 修复后的正确逻辑
function tlTableFilter(t) {
  return t && (archiveOnly ? t.isArchived : (!t.isArchived || showArchived));
}
function matrixFilter(t) {
  return t.status !== 'done' && (archiveOnly ? t.isArchived : (!t.isArchived || showArchived));
}

console.log('=== renderTimelineTable ===');
archiveOnly = false; showArchived = false;
ck('1a 默认-普通', tlTableFilter(normal) === true);
ck('1b 默认-已归档排除', tlTableFilter(archived) === false);
showArchived = true;
ck('1c 叠加-普通', tlTableFilter(normal) === true);
ck('1d 叠加-已归档', tlTableFilter(archived) === true);
showArchived = false; archiveOnly = true;
ck('1e 筛选-普通排除', tlTableFilter(normal) === false);
ck('1f 筛选-已归档显示', tlTableFilter(archived) === true);

console.log('\n=== renderMatrix ===');
archiveOnly = false; showArchived = false;
ck('2a 默认-普通', matrixFilter(normal) === true);
ck('2b 默认-已归档排除', matrixFilter(archived) === false);
ck('2c 默认-done排除', matrixFilter(normalDone) === false);
showArchived = true;
ck('2d 叠加-普通', matrixFilter(normal) === true);
ck('2e 叠加-已归档', matrixFilter(archived) === true);
ck('2f 叠加-archivedDone仍排', matrixFilter(archivedDone) === false);
showArchived = false; archiveOnly = true;
ck('2g 筛选-普通排除', matrixFilter(normal) === false);
ck('2h 筛选-已归档显示', matrixFilter(archived) === true);
ck('2i 筛选-archivedDone仍排', matrixFilter(archivedDone) === false);

console.log('\n结果: '+pass+' pass / '+fail+' fail');
if (fail > 0) process.exit(1);
