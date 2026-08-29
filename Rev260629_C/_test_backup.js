// JSON 完整备份/恢复功能验证（R3.30）
// 桩模式：从 app.js 提取真实函数源码，new Function 注入 localStorage 桩 + BACKUP_FORMAT_VERSION 依赖
// 运行：node _test_backup.js

const fs = require('fs');
const src = fs.readFileSync(__filename.replace('_test_backup.js', 'app.js'), 'utf8');

function extract(re, label) {
  const m = src.match(re);
  if (!m) { console.error('FAIL: 未找到代码块 ' + label); process.exit(1); }
  return m[0];
}

// BACKUP_STORE_KEYS 数组
const mKeys = src.match(/const BACKUP_STORE_KEYS = \[[\s\S]*?\n\];/);
if (!mKeys) { console.error('FAIL: 未找到 BACKUP_STORE_KEYS'); process.exit(1); }
const BACKUP_STORE_KEYS = eval('(function(){ return ' + mKeys[0].replace(/^const BACKUP_STORE_KEYS = /, '').replace(/;$/, '') + ' })()');
const BACKUP_FORMAT_VERSION = 1;

// 桩 localStorage
function makeStorage(seed) {
  const map = Object.assign({}, seed || {});
  return {
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => { map[k] = String(v); },
    removeItem: (k) => { delete map[k]; },
    _map: map,
  };
}

// 提取函数源码（去掉 function 声明包装，供 new Function 使用）
const codeCollect = extract(/function collectBackupData\(\) \{[\s\S]*?\n\}/, 'collectBackupData');
const codePayload = extract(/function buildBackupPayload\(\) \{[\s\S]*?\n\}/, 'buildBackupPayload');
const codeValidate = extract(/function validateBackup\(obj\) \{[\s\S]*?\n\}/, 'validateBackup');
const codeApply = extract(/function applyBackupData\(data\) \{[\s\S]*?\n\}/, 'applyBackupData');

function makeFns(storage) {
  const code = codeCollect + codePayload + codeValidate + codeApply;
  return new Function('localStorage', 'BACKUP_STORE_KEYS', 'BACKUP_FORMAT_VERSION',
    code + '\nreturn { collectBackupData: collectBackupData, buildBackupPayload: buildBackupPayload, validateBackup: validateBackup, applyBackupData: applyBackupData };'
  )(storage, BACKUP_STORE_KEYS, BACKUP_FORMAT_VERSION);
}

let pass = 0, fail = 0;
function check(desc, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc + (extra ? ' → ' + extra : '')); }
}

const seed = {
  'ai-task-lens-tasks': '[{"id":1,"type":"object","title":"目标一","parentId":null}]',
  'ai-task-lens-nextId': '2',
  'ai-task-lens-source': 'manual',
  'ai-task-lens-highlighted': '[1]',
  'ai-task-lens-habits': '[{"id":1,"name":"健身"}]',
  'ai-task-lens-entity-colors': '{"1":"#7C3AED"}',
  'ai-task-lens-health-snapshot': '{"tasks":[]}',
};

console.log('=== JSON 备份/恢复功能测试 ===\n');

// ── 1. BACKUP_STORE_KEYS 覆盖范围 ──
console.log('[1] 覆盖范围');
check('含 11 个业务 key', BACKUP_STORE_KEYS.length === 11, 'len=' + BACKUP_STORE_KEYS.length);
check('含 tasks', BACKUP_STORE_KEYS.includes('ai-task-lens-tasks'));
check('含 habits + checkins', BACKUP_STORE_KEYS.includes('ai-task-lens-habits') && BACKUP_STORE_KEYS.includes('ai-task-lens-habit-checkins'));
check('含 quotes', BACKUP_STORE_KEYS.includes('ai-task-lens-quotes'));
check('含 highlighted/hidden/colors', BACKUP_STORE_KEYS.includes('ai-task-lens-highlighted') && BACKUP_STORE_KEYS.includes('ai-task-lens-hidden-filters') && BACKUP_STORE_KEYS.includes('ai-task-lens-entity-colors'));
check('含 source/sync-paused/data-version/nextId', BACKUP_STORE_KEYS.includes('ai-task-lens-source') && BACKUP_STORE_KEYS.includes('ai-task-lens-sync-paused') && BACKUP_STORE_KEYS.includes('ai-task-lens-data-version') && BACKUP_STORE_KEYS.includes('ai-task-lens-nextId'));
check('不含健康快照（临时恢复点）', !BACKUP_STORE_KEYS.includes('ai-task-lens-health-snapshot'));

// ── 2. collectBackupData ──
console.log('\n[2] collectBackupData');
const fns1 = makeFns(makeStorage(seed));
const collected = fns1.collectBackupData();
check('收集存在的 6 个 key', Object.keys(collected).length === 6, JSON.stringify(Object.keys(collected)));
check('不收集健康快照', !('ai-task-lens-health-snapshot' in collected));
check('tasks 原样保留（含层级结构）', collected['ai-task-lens-tasks'] === seed['ai-task-lens-tasks']);

// ── 3. buildBackupPayload ──
console.log('\n[3] buildBackupPayload');
const payload = fns1.buildBackupPayload();
check('含 _formatVersion = 1', payload._formatVersion === 1);
check('含 _appVersion', typeof payload._appVersion === 'string' && payload._appVersion.length > 0);
check('含 _exportedAt 时间戳', !!payload._exportedAt);
check('data 含 tasks', payload.data && payload.data['ai-task-lens-tasks'] !== undefined);
check('data 含习惯', payload.data && payload.data['ai-task-lens-habits'] !== undefined);

// ── 4. validateBackup 正负例 ──
console.log('\n[4] validateBackup');
const fns2 = makeFns(makeStorage({}));
const good = { _formatVersion: 1, data: { 'ai-task-lens-tasks': '[{"id":1}]' } };
check('合法备份通过', fns2.validateBackup(good) === null);
check('null 拒绝', fns2.validateBackup(null) !== null);
check('字符串拒绝', fns2.validateBackup('hello') !== null);
check('数组拒绝', fns2.validateBackup([1, 2]) !== null);
check('版本不符拒绝', fns2.validateBackup({ _formatVersion: 99, data: {} }) !== null);
check('缺 data 拒绝', fns2.validateBackup({ _formatVersion: 1 }) !== null);
check('缺 tasks 拒绝', fns2.validateBackup({ _formatVersion: 1, data: { 'ai-task-lens-quotes': '[]' } }) !== null);
check('tasks 非数组拒绝', fns2.validateBackup({ _formatVersion: 1, data: { 'ai-task-lens-tasks': '{"a":1}' } }) !== null);
check('tasks 非法 JSON 拒绝', fns2.validateBackup({ _formatVersion: 1, data: { 'ai-task-lens-tasks': '{broken' } }) !== null);
check('空数组合法', fns2.validateBackup({ _formatVersion: 1, data: { 'ai-task-lens-tasks': '[]' } }) === null);

// ── 5. applyBackupData 往返保真 ──
console.log('\n[5] applyBackupData');
const ls2 = makeStorage({});
const fns3 = makeFns(ls2);
const restoreData = {
  'ai-task-lens-tasks': '[{"id":5,"type":"kr","title":"还原的KR","parentId":1}]',
  'ai-task-lens-quotes': '[{"id":1,"text":"金句"}]',
};
fns3.applyBackupData(restoreData);
check('写回 tasks', ls2._map['ai-task-lens-tasks'] === restoreData['ai-task-lens-tasks']);
check('写回 quotes', ls2._map['ai-task-lens-quotes'] === restoreData['ai-task-lens-quotes']);
check('未写入其他 key', Object.keys(ls2._map).length === 2, JSON.stringify(Object.keys(ls2._map)));

// ── 6. 端到端往返：collect → payload → validate → apply → 一致性 ──
console.log('\n[6] 端到端往返');
const fnsE = makeFns(makeStorage(seed));
const p = fnsE.buildBackupPayload();
check('payload 可被 JSON 序列化/反序列化', (() => { try { JSON.parse(JSON.stringify(p)); return true; } catch(e) { return false; } })());
const p2 = JSON.parse(JSON.stringify(p));
check('反序列化后校验通过', fnsE.validateBackup(p2) === null);
const ls3 = makeStorage({});
const fnsF = makeFns(ls3);
fnsF.applyBackupData(p2.data);
check('恢复后 tasks 一致', ls3._map['ai-task-lens-tasks'] === seed['ai-task-lens-tasks']);
check('恢复后 habits 一致', ls3._map['ai-task-lens-habits'] === seed['ai-task-lens-habits']);
check('恢复后 nextId 一致', ls3._map['ai-task-lens-nextId'] === '2');
check('健康快照未混入备份', !('ai-task-lens-health-snapshot' in ls3._map));

console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
