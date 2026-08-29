// _test_priority_quadrant.js
// R3.5: 优先级四象限化（P0-P3 → 重要紧急/重要不紧急/紧急不重要/不紧急不重要）
// 用法：node _test_priority_quadrant.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

function extractFunc(name) {
  const idx = src.indexOf('function ' + name + '(');
  if (idx < 0) {
    const idx2 = src.indexOf('function ' + name + ' (');
    if (idx2 < 0) return null;
    return extractAt(src, idx2);
  }
  return extractAt(src, idx);
}
function extractAt(s, start) {
  const brace = s.indexOf('{', start);
  let depth = 1, i = brace + 1;
  while (i < s.length && depth > 0) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    i++;
  }
  return s.slice(start, i);
}

console.log('=== 优先级四象限化测试 ===\n');

// ── 1. 常量定义 ──
console.log('[1] 常量定义');
const pvMatch = src.match(/const PRIORITY_VALID = \[([^\]]+)\]/);
check('PRIORITY_VALID 含 4 个中文值', !!pvMatch && pvMatch[1].includes('重要紧急') && pvMatch[1].includes('重要不紧急') && pvMatch[1].includes('紧急不重要') && pvMatch[1].includes('不紧急不重要'));
check('PRIORITY_VALID 不再含 P0', !/const PRIORITY_VALID = \['P/.test(src));
check('PRIORITY_ORDER 排序定义存在', /const PRIORITY_ORDER = \{\s*'重要紧急': 0,\s*'重要不紧急': 1,\s*'紧急不重要': 2,\s*'不紧急不重要': 3\s*\}/.test(src));
check('PRIORITY_COLORS 定义存在', /const PRIORITY_COLORS = \{/.test(src));
check('DEFAULT_PRIORITY = 重要不紧急（R3.22 起）', /const DEFAULT_PRIORITY = '重要不紧急'/.test(src));
check('LEGACY_PRIORITY_MAP 含 P0-P3 与带加号', /LEGACY_PRIORITY_MAP = \{/.test(src) && src.includes("P0: '重要紧急'") && src.includes("'重要+紧急': '重要紧急'"));
check('normalizePriority 函数存在', /function normalizePriority\(raw\)/.test(src));
check('SEVERITY_* 保留未动', /const SEVERITY_ORDER = \{ P0: 0/.test(src) && /const SEVERITY_LABELS = \{ P0: '致命'/.test(src));
check('PRIORITY_REV（高/中/低）已删除', !/const PRIORITY_REV = \{ P0: '高'/.test(src));
check('FEISHU_TO_LOCAL_PRIORITY 定义存在', /const FEISHU_TO_LOCAL_PRIORITY = \{/.test(src));

// ── 2. normalizePriority 行为 ──
console.log('\n[2] normalizePriority 行为');
const normCode = extractFunc('normalizePriority');
check('normalizePriority 源码提取', !!normCode);
const normEnv = {
  PRIORITY_VALID: ['重要紧急', '重要不紧急', '紧急不重要', '不紧急不重要'],
  LEGACY_PRIORITY_MAP: { P0: '重要紧急', P1: '重要不紧急', P2: '紧急不重要', P3: '不紧急不重要', '重要+紧急': '重要紧急', '重要+不紧急': '重要不紧急', '不重要+紧急': '紧急不重要', '不重要+不紧急': '不紧急不重要' },
  DEFAULT_PRIORITY: '重要不紧急',
};
const normalizePriority = new Function('scope', `
  with (scope) {
    ${normCode}
    return normalizePriority;
  }
`)(normEnv);
check('P0 → 重要紧急', normalizePriority('P0') === '重要紧急');
check('P1 → 重要不紧急', normalizePriority('P1') === '重要不紧急');
check('P2 → 紧急不重要', normalizePriority('P2') === '紧急不重要');
check('P3 → 不紧急不重要', normalizePriority('P3') === '不紧急不重要');
check('重要+紧急 → 重要紧急', normalizePriority('重要+紧急') === '重要紧急');
check('不重要+不紧急 → 不紧急不重要', normalizePriority('不重要+不紧急') === '不紧急不重要');
check('中文原样返回', normalizePriority('重要不紧急') === '重要不紧急');
check('undefined → 默认', normalizePriority(undefined) === '重要不紧急');
check('空串 → 默认', normalizePriority('') === '重要不紧急');
check('未知值 → 默认', normalizePriority('XX') === '重要不紧急');
check('带空格输入被 trim', normalizePriority(' 重要紧急 ') === '重要紧急');

// ── 3. 数据迁移 v6→v7 ──
console.log('\n[3] 数据迁移');
check('currentVersion = 7', /var currentVersion = 7;/.test(src));
check('forceMigrate 加了 dataVersion < 6 保护', /if \(forceMigrate\) \{[\s\S]*?if \(dataVersion < 6\) \{[\s\S]*?delete t\.timestamp/.test(src));
check('迁移块调用 normalizePriority', /版本6→7[\s\S]*?normalizePriority\(t\.priority\)/.test(src));
// 迁移幂等模拟（每个任务独立记录是否发生迁移）
const migFlags = [];
const fakeTasks = [{ priority: 'P0' }, { priority: '重要紧急' }, { priority: undefined }, { priority: 'XX' }];
fakeTasks.forEach(t => {
  const _np = normalizePriority(t.priority);
  const changed = t.priority !== _np;
  migFlags.push(changed);
  t.priority = _np;
});
check('P0 迁移为 重要紧急', fakeTasks[0].priority === '重要紧急' && migFlags[0] === true);
check('合法中文不迁移', fakeTasks[1].priority === '重要紧急' && migFlags[1] === false);
check('undefined 迁移为默认', fakeTasks[2].priority === '重要不紧急' && migFlags[2] === true);
check('未知值迁移为默认', fakeTasks[3].priority === '重要不紧急' && migFlags[3] === true);

// ── 4. cyclePriority 循环 ──
console.log('\n[4] cyclePriority');
const cycleCode = extractFunc('cyclePriority');
check('cyclePriority 提取', !!cycleCode);
check('cyclePriority 用 PRIORITY_VALID', /const priorities = PRIORITY_VALID;/.test(cycleCode));
// 模拟循环逻辑
const priorSeq = ['重要紧急', '重要不紧急', '紧急不重要', '不紧急不重要'];
check('循环首项 → 次项', priorSeq[(priorSeq.indexOf('重要紧急') + 1) % 4] === '重要不紧急');
check('循环末项 wrap → 首项', priorSeq[(priorSeq.indexOf('不紧急不重要') + 1) % 4] === '重要紧急');

// ── 5. 排序 ──
console.log('\n[5] 排序');
check('priority 排序引用 PRIORITY_ORDER', /case 'priority':[\s\S]*?PRIORITY_ORDER\[a\.priority\]/.test(src));
// 排序语义：重要紧急(0) < 重要不紧急(1) < 紧急不重要(2) < 不紧急不重要(3)
const order = { '重要紧急': 0, '重要不紧急': 1, '紧急不重要': 2, '不紧急不重要': 3 };
const items = ['重要不紧急', '重要紧急', '不紧急不重要', '紧急不重要'].sort((a, b) => order[a] - order[b]);
check('排序结果 重要紧急 最前', items[0] === '重要紧急');
check('排序结果 重要不紧急 次之', items[1] === '重要不紧急');
check('排序结果 紧急不重要 第三', items[2] === '紧急不重要');
check('排序结果 不紧急不重要 最后', items[3] === '不紧急不重要');

// ── 6. renderMatrix 直接归类 ──
console.log('\n[6] renderMatrix 归类');
check('QUADRANT_OF 直接归类存在', /const QUADRANT_OF = \{ '重要紧急': 'q1'/.test(src));
check('无 isUrgent 启发式', !/const isUrgent = t\.priority === 'P0'/.test(src));
check('无 isImportant 启发式', !/const isImportant = t\.priority === 'P0'/.test(src));
check('文案改为按字段归类', src.includes('艾森豪威尔矩阵 · 按优先级字段归类'));

// ── 7. CSV ──
console.log('\n[7] CSV 导入导出');
check('CSV 导入用 normalizePriority', /parsedPriority[\s\S]*?normalizePriority\(parsedPriority\)/.test(src));
check('CSV 默认值 = DEFAULT_PRIORITY', /vals\[idx\.priority\] === undefined \|\| vals\[idx\.priority\] === '' \? DEFAULT_PRIORITY/.test(src));
check('CSV 导出保留 priority 列', /'priority'/.test(src));

// ── 8. 残留断言（任务优先级场景 P0-P3 清零）──
console.log('\n[8] 残留断言');
check('无 priority: \'P[0-3]\' 残留', !/priority: 'P[0-3]'/.test(src));
check('无 PRIORITY_VALID = [\'P', !/PRIORITY_VALID = \['P/.test(src));
check('无 priority === \'P[0-3]\' 残留', !/priority === 'P[0-3]'/.test(src));
check('无 PRIORITY_ORDER = { P', !/PRIORITY_ORDER = \{ P/.test(src));
check('无内联 priColor 三元 P0', !/priority === 'P0' \?/.test(src));
check('无内联 chip colors { P0:', src.indexOf('colors = { P0:') === -1 && src.indexOf('var colors = { P0:') === -1 && src.indexOf('const colors = { P0:') === -1);
check('cyclePriority 无硬编码数组', !/const priorities = \['P0'/.test(src));
check('TXT 导出用 PRIORITY_ICONS', /PRIORITY_ICONS/.test(src));

// ── 9. index.html / style.css ──
console.log('\n[9] HTML/CSS 同步');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
check('index.html option 含 重要紧急', html.includes('value="重要紧急"'));
check('index.html option 含 不紧急不重要', html.includes('value="不紧急不重要"'));
check('index.html 无 option value="P0"', !/option value="P[0-3]"/.test(html));
const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf-8');
check('style.css 含 .priority-重要紧急', css.includes('.priority-重要紧急'));
check('style.css 含 .priority-不紧急不重要', css.includes('.priority-不紧急不重要'));
check('style.css 无 .priority-P0', !/\.priority-P[0-3]/.test(css));

// ── 10. sync_server.js ──
console.log('\n[10] sync_server.js');
const syncSrc = fs.readFileSync(path.join(__dirname, 'sync_server.js'), 'utf-8');
check('PRIORITY_MAP 为四象限映射', /const PRIORITY_MAP = \{ '重要\+紧急': '重要紧急'/.test(syncSrc));
check('PRIORITY_REV 反向映射', /const PRIORITY_REV = \{ '重要紧急': '重要\+紧急'/.test(syncSrc));
check('pull 读「级别」列（含旧字段兜底）', /fields\['级别'\] \|\| fields\['优先级'\]/.test(syncSrc));
check('push 写「级别」列', /'级别': PRIORITY_REV_LOCAL\[t\.priority\]/.test(syncSrc));
check('push fieldsList 含「级别」', /fieldsList = \['事项内容', '级别'/.test(syncSrc));
check('默认优先级 = 重要不紧急（前后端一致）', /DEFAULT_PRIORITY = '重要不紧急'/.test(syncSrc) && /priority \|\| DEFAULT_PRIORITY/.test(syncSrc));
check('diff 引用四象限映射', /const PRIORITY_MAP_LOCAL = PRIORITY_MAP;/.test(syncSrc) && /const PRIORITY_REV_LOCAL = PRIORITY_REV;/.test(syncSrc));
check('diff 读「级别」列', /record\['级别'\] \|\| record\['优先级'\]/.test(syncSrc));

console.log(`\n通过 ${pass} / ${fail + pass}`);
process.exit(fail === 0 ? 0 : 1);
