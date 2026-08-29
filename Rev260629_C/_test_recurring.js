/**
 * 周期任务日期生成函数测试（R3.1）
 *
 * 方法论（沿用 _test_health_helper.js 已验证的做法）：
 *   从 app.js 里按大括号配对**提取真实函数源码**，用 new Function 注入桩依赖后执行。
 *   绝不在测试里重写一份逻辑——那样只是自测自己，改坏了照样绿灯。
 *
 * 被测函数：generateRecurringDates(rule, startDate, endDate)
 *   依赖外部符号：pad2（同文件，一并提取注入）
 */
const fs = require('fs');
const path = require('path');

const APP_PATH = path.join(__dirname, 'app.js');
const src = fs.readFileSync(APP_PATH, 'utf8');

/** 按大括号配对提取一个完整函数声明的源码 */
function extractFunction(source, signature) {
  const startIdx = source.indexOf(signature);
  if (startIdx === -1) throw new Error('找不到函数签名：' + signature);
  let depth = 0, started = false, endIdx = -1;
  for (let i = startIdx; i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { endIdx = i + 1; break; } }
  }
  if (endIdx === -1) throw new Error('大括号未配对：' + signature);
  return source.slice(startIdx, endIdx);
}

const SRC_GEN = extractFunction(src, 'function generateRecurringDates(');
const SRC_PAD2 = extractFunction(src, 'function pad2(');

const gen = new Function(SRC_PAD2 + '\n' + SRC_GEN + '\nreturn generateRecurringDates;')();

let passed = 0, failed = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + '\n     期望 ' + e + '\n     实际 ' + a); }
}

console.log('== generateRecurringDates 测试 ==');

// 1. daily interval=1，3 天
assertEq('daily 每日×3天',
  gen({ freq: 'daily', interval: 1 }, '2026-08-10', '2026-08-12'),
  ['2026-08-10', '2026-08-11', '2026-08-12']);

// 2. daily interval=2（隔天）
assertEq('daily 隔天×3',
  gen({ freq: 'daily', interval: 2 }, '2026-08-10', '2026-08-14'),
  ['2026-08-10', '2026-08-12', '2026-08-14']);

// 3. weekly 选周一[1]+周三[3]，跨两周
assertEq('weekly 周一+周三 跨两周',
  gen({ freq: 'weekly', weekdays: [1, 3] }, '2026-08-10', '2026-08-23'),
  ['2026-08-10', '2026-08-12', '2026-08-17', '2026-08-19']);

// 4. weekly 跨月边界（8/28 周五 → 9/4 周五）
assertEq('weekly 周五 跨月',
  gen({ freq: 'weekly', weekdays: [5] }, '2026-08-28', '2026-09-06'),
  ['2026-08-28', '2026-09-04']);

// 5. monthly 31号跳过无31日的月（2月）
assertEq('monthly 31号跳过2月',
  gen({ freq: 'monthly', dayOfMonth: 31 }, '2026-01-01', '2026-04-30'),
  ['2026-01-31', '2026-03-31']);

// 6. monthly 常规 15 号
assertEq('monthly 15号',
  gen({ freq: 'monthly', dayOfMonth: 15 }, '2026-08-01', '2026-10-31'),
  ['2026-08-15', '2026-09-15', '2026-10-15']);

// 7. 缺省 endDate → 生成到 startDate+90 天，daily 应产出 91 个日期
const d90 = gen({ freq: 'daily', interval: 1 }, '2026-08-10');
assertEq('daily 缺省end 90天共91个', d90.length, 91);
assertEq('daily 缺省end 首尾正确', [d90[0], d90[90]], ['2026-08-10', '2026-11-08']);

// 8. 非法参数
assertEq('空 rule', gen(null, '2026-08-10', '2026-08-12'), []);
assertEq('空 startDate', gen({ freq: 'daily' }, '', '2026-08-12'), []);
assertEq('end < start', gen({ freq: 'daily' }, '2026-08-12', '2026-08-10'), []);

// 9. interval 非法值兜底为 1
assertEq('interval=0 兜底为1',
  gen({ freq: 'daily', interval: 0 }, '2026-08-10', '2026-08-12'),
  ['2026-08-10', '2026-08-11', '2026-08-12']);

// 10. weekly 空 weekdays 兜底为起始日星期（周一=1）
assertEq('weekly 空weekdays 兜底起始日',
  gen({ freq: 'weekly', weekdays: [] }, '2026-08-10', '2026-08-24'),
  ['2026-08-10', '2026-08-17', '2026-08-24']);

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
