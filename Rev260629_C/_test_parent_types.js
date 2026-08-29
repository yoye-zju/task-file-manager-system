// 上级类型候选验证：ALLOWED_PARENTS 单一来源推导（R3.26 修复）
// 验证 record/schedule/idea 选择上级时，候选包含 KR（修复前回落 ['object']，KR 不可选）
// 运行：node _test_parent_types.js

const fs = require('fs');
const src = fs.readFileSync(__filename.replace('_test_parent_types.js', 'app.js'), 'utf8');

// 提取 ALLOWED_PARENTS 定义（只取对象字面量，避免 TDZ）
const mAllowed = src.match(/const ALLOWED_PARENTS = (\{[\s\S]*?\n\};)/);
if (!mAllowed) { console.error('FAIL: 未找到 ALLOWED_PARENTS'); process.exit(1); }
const ALLOWED_PARENTS = eval('(function(){ return ' + mAllowed[1] + ' })()');

// 复刻 onTypeChange 中的推导逻辑（与 app.js 保持一致）
function parentTypesOf(type) {
  const allowed = ALLOWED_PARENTS[type];
  return allowed === '*' ? ['object', 'kr', 'target', 'task', 'record', 'schedule', 'idea'] : (allowed || ['object']);
}

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); }
}

// 模拟任务数据：含一条「9月15号 立项技术准备」KR 和若干 Object
const tasks = [
  { id: 1, type: 'object', title: 'Q3 目标', parentId: null },
  { id: 2, type: 'kr', title: '9月15号 立项技术准备', parentId: 1 },
  { id: 3, type: 'kr', title: '另一个 KR', parentId: 1 },
  { id: 4, type: 'target', title: '子目标 A', parentId: 2 },
  { id: 5, type: 'task', title: '任务 X', parentId: 4 },
];

// 1. record 的上级候选包含 kr（修复点）
assert('record 上级类型含 kr', parentTypesOf('record').includes('kr'), parentTypesOf('record').join(','));
assert('record 上级类型含 object', parentTypesOf('record').includes('object'));
assert('record 上级类型为全部 7 类', parentTypesOf('record').length === 7, 'len=' + parentTypesOf('record').length);

// 2. 模拟候选过滤：record 编辑时能看到那条 KR
const recordCandidates = tasks.filter(t => parentTypesOf('record').includes(t.type));
assert('record 候选含「立项技术准备」KR', recordCandidates.some(t => t.title.includes('立项技术准备')), JSON.stringify(recordCandidates.map(t => t.title)));

// 3. 模拟搜索「9月15号」能命中
const kw = '9月15号'.toLowerCase();
const hit = recordCandidates.filter(t => t.title.toLowerCase().includes(kw));
assert('按「9月15号」搜索命中 KR', hit.some(t => t.type === 'kr' && t.title.includes('立项技术准备')), JSON.stringify(hit.map(t => t.title)));

// 4. 原层级类型不受影响：kr 只能挂 object
assert('kr 上级仅 object', parentTypesOf('kr').join() === 'object', parentTypesOf('kr').join(','));
assert('target 上级为 kr+object', parentTypesOf('target').join() === 'kr,object', parentTypesOf('target').join(','));
assert('task 上级为 target+kr+object', parentTypesOf('task').join() === 'target,kr,object', parentTypesOf('task').join(','));

// 5. schedule / idea 同样放开
assert('schedule 上级类型含 kr', parentTypesOf('schedule').includes('kr'));
assert('idea 上级类型含 kr', parentTypesOf('idea').includes('kr'));

// 6. object 顶级：无上级（编辑弹窗不显示上级选择器，此处推导返回空）
assert('object 上级为空', parentTypesOf('object').length === 0, parentTypesOf('object').join(','));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);
