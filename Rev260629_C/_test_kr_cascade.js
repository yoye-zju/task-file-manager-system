// 测试：快速筛选 KR 级联联动（R2.5）
// 从 app.js 提取 renderEntityFilterButtons 真实源码执行，非重写逻辑
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  PASS ' + msg); }
  else { fail++; console.log('  FAIL ' + msg); }
}

// ---- 提取真实函数源码 ----
const startIdx = src.indexOf('function renderEntityFilterButtons(');
if (startIdx < 0) { console.log('FATAL: 找不到 renderEntityFilterButtons'); process.exit(1); }
let depth = 0, endIdx = -1, started = false;
for (let i = startIdx; i < src.length; i++) {
  if (src[i] === '{') { depth++; started = true; }
  else if (src[i] === '}') { depth--; if (started && depth === 0) { endIdx = i + 1; break; } }
}
const fnSrc = src.slice(startIdx, endIdx);
console.log('提取函数源码 ' + fnSrc.length + ' 字符\n');

// ---- 构造测试数据 ----
// O1 ─ KR1 ─ T1 ─ Task1
//    └ KR2
// O2 ─ KR3
// O3 (无 KR)
// 三种游离 KR：
//   KR9  上级为空 (parentId=null)
//   KR10 上级已删除 (parentId=999，该 id 不存在)
//   KR11 上级非 Object (parentId=12，指向一个 Target，且该 Target 也无 Object 祖先)
const tasks = [
  { id: 1, type: 'object', title: '目标一：DCSTS 项目', parentId: null },
  { id: 2, type: 'kr',     title: 'KR1 五月完成计划',   parentId: 1 },
  { id: 3, type: 'kr',     title: 'KR2 九月拿到样机',   parentId: 1 },
  { id: 4, type: 'target', title: '子目标 A',           parentId: 2 },
  { id: 5, type: 'task',   title: '任务 A1',            parentId: 4 },
  { id: 6, type: 'object', title: '目标二：团队建设',   parentId: null },
  { id: 7, type: 'kr',     title: 'KR3 招聘两人',       parentId: 6 },
  { id: 8, type: 'object', title: '目标三：无 KR 目标', parentId: null },
  { id: 9, type: 'kr',     title: 'KR9 上级为空',       parentId: null },
  { id: 10, type: 'kr',    title: 'KR10 上级已删除',    parentId: 999 },
  { id: 12, type: 'target', title: '游离子目标',        parentId: null },
  { id: 11, type: 'kr',    title: 'KR11 上级非Object',  parentId: 12 },
];
const LOOSE_ALL = [9, 10, 11];   // 三个游离 KR 的 id

// ---- 桩函数 ----
let hiddenFilters = {};
function isEntityHighlighted() { return false; }
function shortTitle(t, m) { m = m || 20; return !t ? '' : (t.length > m ? t.slice(0, m) + '…' : t); }
function isArchivedOf(t) { return t && (t.isArchived === true || t.isArchived === 'true'); }
function entityStateClass() { return ''; }
// R3.19：nearestObjectIdOf 从 renderEntityFilterButtons 内部提升为全局，桩需同语义实现
function nearestObjectIdOf(node) {
  const seen = new Set();
  let cur = node;
  while (cur && cur.parentId !== null && cur.parentId !== undefined && cur.parentId !== '') {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    const p = tasks.find(x => x.id === cur.parentId);
    if (!p) return null;
    if (p.type === 'object') return p.id;
    cur = p;
  }
  return null;
}
// R3.29：实体按钮自定义底色。本测试不设色，桩恒返回空串（同真实逻辑在无配色时的行为）
const entityColors = {};
function entityBtnStyle(id, isActive, isCtx, isHL, st) {
  if (isActive || isCtx || isHL || st) return '';
  return entityColors[id] ? 'background:x;' : '';
}

const render = new Function(
  'tasks', 'hiddenFilters', 'isEntityHighlighted', 'shortTitle', 'isArchivedOf', 'entityStateClass', 'nearestObjectIdOf', 'entityColors', 'entityBtnStyle',
  fnSrc + '; return renderEntityFilterButtons;'
)(tasks, hiddenFilters, isEntityHighlighted, shortTitle, isArchivedOf, entityStateClass, nearestObjectIdOf, entityColors, entityBtnStyle);

// ---- 断言辅助 ----
function parseBtns(html) {
  const out = [];
  const re = /<button[^>]*class="([^"]*)"[^>]*data-eid="(\d+)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({
      id: parseInt(m[2]),
      cls: m[1],
      isObj: /entity-object/.test(m[1]),
      isKr: /entity-kr\b/.test(m[1]),
      isLoose: /entity-kr-loose/.test(m[1]),
      active: /\bactive\b/.test(m[1]),
      ctx: /\bctx\b/.test(m[1]),
    });
  }
  return out;
}
// A 组：归属明确的 KR（受 Object 门控）
function krIds(html) {
  return parseBtns(html).filter(b => b.isKr && !b.isLoose).map(b => b.id).sort((a,b)=>a-b);
}
// B 组：游离 KR（常驻显示）
function looseIds(html) {
  return parseBtns(html).filter(b => b.isLoose).map(b => b.id).sort((a,b)=>a-b);
}
function objIds(html) { return parseBtns(html).filter(b => b.isObj).map(b => b.id).sort((a,b)=>a-b); }
function activeIds(html) { return parseBtns(html).filter(b => b.active).map(b => b.id).sort((a,b)=>a-b); }
function hasKrGroupLabel(html) { return html.includes('entity-group-label-kr">关键结果</span>'); }
function hasLooseGroupLabel(html) { return html.includes('游离 KR</span>'); }

// ===== 场景 1：未选中任何 Object → 不显示 A 组，但 B 组游离 KR 常驻 =====
console.log('[场景1] activeId = null');
var h1 = render(null, 'toggleEntityFilter', true);
ok(objIds(h1).join(',') === '1,6,8', 'Object 按钮全部显示 (1,6,8)');
ok(krIds(h1).length === 0, 'A 组（归属明确的 KR）数为 0');
ok(!hasKrGroupLabel(h1), 'A 组分组标签不出现');
ok(!h1.includes('暂无 KR'), '未选中时不显示"暂无KR"提示');
ok(looseIds(h1).join(',') === LOOSE_ALL.join(','), 'B 组三个游离 KR 全部常驻显示 ← 核心回归修复');
ok(hasLooseGroupLabel(h1), '「游离 KR」分组标签出现');
ok(activeIds(h1).length === 0, '无任何按钮点亮');

// ===== 场景 2：选中 O1 → A 组只显示 KR1、KR2；B 组不受影响 =====
console.log('\n[场景2] activeId = 1 (目标一)');
var h2 = render(1, 'toggleEntityFilter', true);
ok(objIds(h2).join(',') === '1,6,8', 'Object 按钮仍全部显示');
ok(krIds(h2).join(',') === '2,3', 'A 组只显示 O1 名下的 KR1,KR2');
ok(!krIds(h2).includes(7), 'A 组不显示 O2 名下的 KR3');
ok(looseIds(h2).join(',') === LOOSE_ALL.join(','), 'B 组游离 KR 不受 Object 选中影响，仍全显示');
ok(hasKrGroupLabel(h2), 'A 组分组标签出现');
ok(activeIds(h2).join(',') === '1', '只有 O1 点亮');

// ===== 场景 3：选中 O2 → A 组只显示 KR3 =====
console.log('\n[场景3] activeId = 6 (目标二)');
var h3 = render(6, 'toggleEntityFilter', true);
ok(krIds(h3).join(',') === '7', 'A 组只显示 O2 名下的 KR3');
ok(looseIds(h3).join(',') === LOOSE_ALL.join(','), 'B 组仍全显示');
ok(activeIds(h3).join(',') === '6', '只有 O2 点亮');

// ===== 场景 4：选中 O3（名下无 KR）→ 显示提示，B 组仍在 =====
console.log('\n[场景4] activeId = 8 (目标三，无 KR)');
var h4 = render(8, 'toggleEntityFilter', true);
ok(krIds(h4).length === 0, 'A 组无 KR 按钮');
ok(!hasKrGroupLabel(h4), '不显示 A 组分组标签');
ok(h4.includes('该目标下暂无关键结果'), '显示"该目标下暂无关键结果"提示');
ok(looseIds(h4).join(',') === LOOSE_ALL.join(','), 'B 组游离 KR 仍显示（与 A 组空态无关）');

// ===== 场景 5：选中 KR2 → 同 Object 下 KR 全显示，父 Object 呈 ctx 态 =====
console.log('\n[场景5] activeId = 3 (KR2，属于 O1)');
var h5 = render(3, 'toggleEntityFilter', true);
ok(krIds(h5).join(',') === '2,3', 'A 组同级 KR1,KR2 都显示（可横向切换）');
ok(activeIds(h5).join(',') === '3', '只有 KR2 点亮');
var o1btn = parseBtns(h5).find(b => b.id === 1);
ok(o1btn && o1btn.ctx, '父 Object(O1) 带 ctx 上下文态');
var o2btn = parseBtns(h5).find(b => b.id === 6);
ok(o2btn && !o2btn.ctx && !o2btn.active, '非父 Object(O2) 无 ctx 无 active');

// ===== 场景 6：选中深层 Task（非 Object/KR）=====
console.log('\n[场景6] activeId = 5 (Task，O1>KR1>T1>Task)');
var h6 = render(5, 'toggleEntityFilter', true);
ok(krIds(h6).length === 0, '选中非 Object/非 KR 时 A 组不显示（无上下文）');
ok(!hasKrGroupLabel(h6), '无 A 组分组标签');
ok(looseIds(h6).join(',') === LOOSE_ALL.join(','), 'B 组仍显示');

// ===== 场景 7：三种游离形态逐一验证 + 选中游离 KR 时的行为 =====
console.log('\n[场景7] 三种游离形态');
var h7a = render(9,  'toggleEntityFilter', true);   // 上级为空
var h7b = render(10, 'toggleEntityFilter', true);   // 上级已删除
var h7c = render(11, 'toggleEntityFilter', true);   // 上级非 Object
ok(looseIds(h7a).includes(9),  'KR9（上级为空）在 B 组');
ok(looseIds(h7b).includes(10), 'KR10（上级已删除，parentId=999）在 B 组');
ok(looseIds(h7c).includes(11), 'KR11（上级非 Object）在 B 组');
ok(activeIds(h7a).join(',') === '9',  '选中游离 KR9 时它自己点亮');
ok(activeIds(h7b).join(',') === '10', '选中游离 KR10 时它自己点亮');
ok(krIds(h7a).length === 0, '选中游离 KR 时 A 组不显示（它没有 Object 归属）');
ok(parseBtns(h7a).filter(b => b.ctx).length === 0, '选中游离 KR 时没有任何 Object 呈 ctx 态');
ok(objIds(h7a).join(',') === '1,6,8', 'Object 按钮不受影响');

// ===== 场景 8：hiddenFilters 仅在列表视图生效（A 组与 B 组都要覆盖）=====
console.log('\n[场景8] hiddenFilters 隔离');
hiddenFilters['entity:2'] = true;   // 隐藏 KR1（A 组）
hiddenFilters['entity:6'] = true;   // 隐藏 O2
hiddenFilters['entity:9'] = true;   // 隐藏 KR9（B 组）
var h8a = render(1, 'toggleEntityFilter', true);    // 列表视图 useHidden=true
var h8b = render(1, 'toggleTlEntityFilter', false); // 时间线 useHidden=false
ok(!krIds(h8a).includes(2), '列表视图：被隐藏的 KR1 不显示');
ok(krIds(h8a).join(',') === '3', '列表视图：A 组只剩 KR2');
ok(!objIds(h8a).includes(6), '列表视图：被隐藏的 O2 不显示');
ok(!looseIds(h8a).includes(9), '列表视图：被隐藏的游离 KR9 也不显示 ← B 组同样受 hiddenFilters 管');
ok(looseIds(h8a).join(',') === '10,11', '列表视图：B 组只剩 KR10,KR11');
ok(krIds(h8b).join(',') === '2,3', '时间线视图：忽略 hiddenFilters，A 组 KR1,KR2 都显示');
ok(looseIds(h8b).join(',') === LOOSE_ALL.join(','), '时间线视图：B 组三个游离 KR 都显示');
ok(objIds(h8b).includes(6), '时间线视图：O2 仍显示');
delete hiddenFilters['entity:2'];
delete hiddenFilters['entity:6'];
delete hiddenFilters['entity:9'];
// 全部游离 KR 都被隐藏时，分组标签也应消失（不能留一个孤零零的标签）
hiddenFilters['entity:9'] = true;
hiddenFilters['entity:10'] = true;
hiddenFilters['entity:11'] = true;
var h8c = render(null, 'toggleEntityFilter', true);
ok(looseIds(h8c).length === 0, 'B 组全被隐藏时无按钮');
ok(!hasLooseGroupLabel(h8c), 'B 组全被隐藏时「游离 KR」标签也消失（无空标签残留）');
delete hiddenFilters['entity:9'];
delete hiddenFilters['entity:10'];
delete hiddenFilters['entity:11'];

// ===== 场景 9：toggle 函数名正确注入 =====
console.log('\n[场景9] onclick 函数名');
var h9a = render(1, 'toggleEntityFilter', true);
var h9b = render(1, 'toggleTlEntityFilter', false);
var h9c = render(1, 'toggleBoardEntity', false);
ok(h9a.includes('onclick="toggleEntityFilter(1)"'), '列表视图 onclick=toggleEntityFilter');
ok(h9b.includes('onclick="toggleTlEntityFilter(2)"'), '时间线 KR onclick=toggleTlEntityFilter');
ok(h9c.includes('onclick="toggleBoardEntity(3)"'), '看板 KR onclick=toggleBoardEntity');

// ===== 场景 10：空数据不崩 =====
console.log('\n[场景10] 边界：无 Object 无 KR');
var renderEmpty = new Function(
  'tasks', 'hiddenFilters', 'isEntityHighlighted', 'shortTitle', 'isArchivedOf', 'entityStateClass', 'nearestObjectIdOf', 'entityColors', 'entityBtnStyle',
  fnSrc + '; return renderEntityFilterButtons;'
)([{ id: 99, type: 'task', title: '孤立任务', parentId: null }], {}, isEntityHighlighted, shortTitle, isArchivedOf, entityStateClass, nearestObjectIdOf, entityColors, entityBtnStyle);
ok(renderEmpty(null, 'toggleEntityFilter', true) === '', '无 Object/KR 时返回空串');
ok(renderEmpty(99, 'toggleEntityFilter', true) === '', 'activeId 存在但无 Object/KR 也返回空串');

// ===== 场景 11：静态检查 —— 四个视图都已改用公共函数，无遗留重复代码 =====
console.log('\n[场景11] 静态检查：调用点收敛');
// 只统计真实代码调用（排除 CHANGELOG 字符串里的文案提及）
var realCalls = (src.match(/\$\{renderEntityFilterButtons\(/g) || []).length;
var defCount  = (src.match(/function renderEntityFilterButtons\(/g) || []).length;
ok(defCount === 1, '函数定义唯一，实际 ' + defCount);
ok(realCalls === 5, '模板插值调用 5 处（列表/时间线×2/看板/时间线表格），实际 ' + realCalls);
ok(!/const isActive = listEntityFilters === o\.id/.test(src), '列表视图旧内联代码已删除');
ok(!/var isHT1|var isHT2|var isHT3|var isHT4|var isHB1|var isHB2|var isHL1|var isHL2/.test(src),
   '旧的 isHT1~4 / isHB1~2 / isHL1~2 临时变量已全部清除');
ok(src.includes("renderEntityFilterButtons(listEntityFilters, 'toggleEntityFilter', true)"), '列表视图调用参数正确');
ok(src.includes("renderEntityFilterButtons(boardEntityFilters, 'toggleBoardEntity', false)"), '看板调用参数正确');
ok((src.match(/renderEntityFilterButtons\(tlEntityFilters, 'toggleTlEntityFilter', false\)/g) || []).length === 2,
   '时间线两处（空态 + 正常态）调用参数正确');
// 死代码检查：原本每个视图各自算的 objs/krs 局部变量应已清除
var tlBody = src.slice(src.indexOf('function renderTimelineLegacy'), src.indexOf('function renderMatrix'));
ok(!/const objs = tasks\.filter/.test(tlBody), '时间线函数内已无残留 objs 局部变量');
var boardBody = src.slice(src.indexOf('function renderBoard'), src.indexOf('function toggleBoardEntity'));
ok(!/const krs = tasks\.filter/.test(boardBody), '看板函数内已无残留 krs 局部变量');

// ===== 场景 12：CSS ctx 样式存在 =====
console.log('\n[场景12] CSS ctx 样式');
var css = fs.readFileSync(__dirname + '/style.css', 'utf8');
var ctxRule = css.match(/\.tag-btn\.entity-btn\.entity-object\.ctx\s*\{([^}]*)\}/);
ok(!!ctxRule, '.entity-object.ctx 规则存在');
if (ctxRule) {
  ok(/border-color:\s*#7C3AED/i.test(ctxRule[1]), 'ctx 有紫色边框');
  ok(/box-shadow:\s*inset/.test(ctxRule[1]), 'ctx 用内描边突出（区别于 active 实心）');
}
// cascade 冲突检查：ctx 规则之后不应有「行首裸选择器」重复（R3.14 起表格筛选栏另有 .tl-table-filter-bar 作用域变体，属有意设计，排除）
var ctxPos = css.indexOf('.tag-btn.entity-btn.entity-object.ctx');
var after = css.slice(ctxPos + 40);
ok(!/(^|\n)\.tag-btn\.entity-btn\.entity-object\.ctx\s*\{/.test(after), 'ctx 规则之后无同选择器重复定义（作用域变体除外）');
// active 优先级：active 单独类，ctx 与 active 互斥由 JS 保证（isCtx = !isActive && ...）
ok(/const isCtx = !isActive/.test(fnSrc), 'JS 层保证 ctx 与 active 互斥');

// ===== 场景 13：三个视图状态变量彼此独立 =====
console.log('\n[场景13] 跨视图状态独立性');
// 模拟：列表选 O1、看板选 O2、时间线未选
var hList  = render(1, 'toggleEntityFilter', true);
var hBoard = render(6, 'toggleBoardEntity', false);
var hTl    = render(null, 'toggleTlEntityFilter', false);
ok(krIds(hList).join(',') === '2,3', '列表(选O1)显示 KR1,KR2');
ok(krIds(hBoard).join(',') === '7', '看板(选O2)显示 KR3');
ok(krIds(hTl).length === 0, '时间线(未选)不显示 KR');
ok(activeIds(hList).join(',') === '1' && activeIds(hBoard).join(',') === '6',
   '三个视图点亮态互不干扰');
// 静态检查：三个变量确实是独立声明
ok(/let listEntityFilters\s*=\s*null/.test(src), 'listEntityFilters 独立声明');
ok(/let tlEntityFilters\s*=\s*null/.test(src), 'tlEntityFilters 独立声明');
ok(/let boardEntityFilters\s*=\s*null/.test(src), 'boardEntityFilters 独立声明');

// ===== 场景 14：toggle 语义 —— 再点同一按钮取消 =====
console.log('\n[场景14] toggle 取消语义');
// toggleEntityFilter 的实现：listEntityFilters = (listEntityFilters === eid) ? null : eid
function simToggle(cur, eid) { return cur === eid ? null : eid; }
ok(simToggle(null, 1) === 1, '未选 → 点 O1 → 选中 O1');
ok(simToggle(1, 1) === null, '已选 O1 → 再点 O1 → 取消');
ok(simToggle(1, 3) === 3, '已选 O1 → 点 KR2 → 切到 KR2');
ok(simToggle(3, 1) === 1, '已选 KR2 → 点 O1 → 切回 O1');
// 关键：取消 KR 后 KR 分组会消失 —— 验证不会残留失效的选中态
ok(krIds(render(simToggle(3, 3), 'toggleEntityFilter', true)).length === 0,
   '取消 KR2 后 activeId=null，KR 分组随之消失（无残留）');
// 切换到另一个 Object 时，原 Object 下的 KR 应被换掉而非累加
ok(krIds(render(simToggle(1, 6), 'toggleEntityFilter', true)).join(',') === '7',
   '从 O1 切到 O2，KR 列表整体替换为 KR3（不累加 KR1/KR2）');

// ===== 场景 15：HTML 结构完整性（无未闭合标签 / 转义问题）=====
console.log('\n[场景15] HTML 结构');
[h1, h2, h4, h5].forEach(function(h, i) {
  var openBtn = (h.match(/<button/g) || []).length;
  var closeBtn = (h.match(/<\/button>/g) || []).length;
  ok(openBtn === closeBtn, '样本' + (i+1) + ' button 开闭标签配平 (' + openBtn + '/' + closeBtn + ')');
  var openSpan = (h.match(/<span/g) || []).length;
  var closeSpan = (h.match(/<\/span>/g) || []).length;
  ok(openSpan === closeSpan, '样本' + (i+1) + ' span 开闭标签配平 (' + openSpan + '/' + closeSpan + ')');
});
ok(!h2.includes('undefined'), '输出中无 undefined');
ok(!h2.includes('NaN'), '输出中无 NaN');

// ===== 场景 16：环形引用不死循环（数据损坏容错）=====
console.log('\n[场景16] 环形引用 guard');
var cyclicTasks = [
  { id: 1, type: 'object', title: '正常目标', parentId: null },
  { id: 2, type: 'kr',     title: '正常KR',   parentId: 1 },
  // KR20 → T21 → KR20 形成环，且环内无 Object
  { id: 20, type: 'kr',     title: 'KR20 环',  parentId: 21 },
  { id: 21, type: 'target', title: 'T21 环',   parentId: 20 },
];
var renderCyclic = new Function(
  'tasks', 'hiddenFilters', 'isEntityHighlighted', 'shortTitle', 'isArchivedOf', 'entityStateClass', 'nearestObjectIdOf', 'entityColors', 'entityBtnStyle',
  fnSrc + '; return renderEntityFilterButtons;'
)(cyclicTasks, {}, isEntityHighlighted, shortTitle, isArchivedOf, entityStateClass, nearestObjectIdOf, entityColors, entityBtnStyle);
var hCyc = null, cycErr = null;
var t0 = Date.now();
try { hCyc = renderCyclic(null, 'toggleEntityFilter', false); }
catch (e) { cycErr = e; }
var elapsed = Date.now() - t0;
ok(cycErr === null, '环形引用不抛异常' + (cycErr ? ' (' + cycErr.message + ')' : ''));
ok(elapsed < 1000, '环形引用不死循环（' + elapsed + 'ms < 1000ms）');
ok(hCyc !== null && looseIds(hCyc).includes(20), '环内 KR20 归为游离 KR（回溯失败→null）');
ok(hCyc !== null && krIds(hCyc).length === 0, '未选目标时环内 KR 不进 A 组');

// ===== 场景 17：分组渲染顺序 = Object → A组KR → B组游离KR =====
console.log('\n[场景17] 分组顺序');
var h17 = render(1, 'toggleEntityFilter', true);
var posObj   = h17.indexOf('entity-group-label-object">目标</span>');
var posKr    = h17.indexOf('关键结果</span>');
var posLoose = h17.indexOf('游离 KR</span>');
ok(posObj >= 0 && posKr >= 0 && posLoose >= 0, '三个分组标签都存在');
ok(posObj < posKr, 'Object 组在 A 组 KR 之前');
ok(posKr < posLoose, 'A 组 KR 在 B 组游离 KR 之前（游离项排最后，不干扰主流程）');
// 未选目标时只有 Object + B 组两个标签
var h17b = render(null, 'toggleEntityFilter', true);
ok(h17b.indexOf('🎯 Object</span>') < h17b.indexOf('游离 KR</span>'), '未选目标时 Object 组仍在 B 组之前');

// ===== 场景 18：游离 KR 的 CSS 样式 =====
console.log('\n[场景18] 游离 KR CSS');
var cssL = fs.readFileSync(__dirname + '/style.css', 'utf8');
var looseRule = cssL.match(/\.tag-btn\.entity-btn\.entity-kr-loose\s*\{([^}]*)\}/);
ok(!!looseRule, '.entity-kr-loose 基础规则存在');
if (looseRule) {
  ok(/border:\s*2px\s+dashed/.test(looseRule[1]), '游离 KR 用虚线边框（视觉上区别于正常 KR）');
  ok(/#FCD34D|#FBBF24/i.test(looseRule[1]), '游离 KR 用琥珀色边框');
}
var looseActive = cssL.match(/\.tag-btn\.entity-btn\.entity-kr-loose\.active\s*\{([^}]*)\}/);
ok(!!looseActive, '.entity-kr-loose.active 规则存在');
if (looseActive) {
  ok(/border-style:\s*solid/.test(looseActive[1]), '选中态改回实线（强调已激活）');
}
// 关键 cascade 检查：loose 规则必须在 .entity-kr 之后，否则被覆盖
var posKrRule = cssL.indexOf('.tag-btn.entity-btn.entity-kr {');
var posLooseRule = cssL.indexOf('.tag-btn.entity-btn.entity-kr-loose {');
ok(posKrRule >= 0 && posLooseRule > posKrRule,
   'loose 规则在 .entity-kr 基础规则之后（否则蓝色底会覆盖琥珀色）');
// loose 按钮同时带 entity-kr 和 entity-kr-loose 两个类，确认 class 串正确
var looseBtn = parseBtns(render(null, 'toggleEntityFilter', false)).find(b => b.id === 9);
ok(looseBtn && /entity-kr\b/.test(looseBtn.cls) && /entity-kr-loose/.test(looseBtn.cls),
   '游离按钮同时带 entity-kr 与 entity-kr-loose 类');

// ===== 场景 19：全部 KR 都游离（极端情况，无一个 Object）=====
console.log('\n[场景19] 极端：只有游离 KR，没有 Object');
var onlyLoose = new Function(
  'tasks', 'hiddenFilters', 'isEntityHighlighted', 'shortTitle', 'isArchivedOf', 'entityStateClass', 'nearestObjectIdOf', 'entityColors', 'entityBtnStyle',
  fnSrc + '; return renderEntityFilterButtons;'
)([
  { id: 1, type: 'kr', title: '游离KR甲', parentId: null },
  { id: 2, type: 'kr', title: '游离KR乙', parentId: null },
], {}, isEntityHighlighted, shortTitle, isArchivedOf, entityStateClass, nearestObjectIdOf, entityColors, entityBtnStyle);
var h19 = onlyLoose(null, 'toggleEntityFilter', false);
ok(looseIds(h19).join(',') === '1,2', '无 Object 时两个游离 KR 仍可见（不会整栏空白）');
ok(!h19.includes('🎯 Object</span>'), '无 Object 时不渲染 Object 分组标签');
ok(hasLooseGroupLabel(h19), '游离分组标签正常出现');

console.log('\n========================================');
console.log('通过 ' + pass + ' / 失败 ' + fail);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);


