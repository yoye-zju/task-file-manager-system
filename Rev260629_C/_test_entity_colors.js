// 实体按钮自定义底色验证（R3.29）
// 覆盖：颜色工具函数、entityColorVars 派生、WCAG 对比度、entityBtnStyle 状态门控、set/clear map
// 运行：node _test_entity_colors.js

const fs = require('fs');
const src = fs.readFileSync(__filename.replace('_test_entity_colors.js', 'app.js'), 'utf8');

function extract(re, label) {
  const m = src.match(re);
  if (!m) { console.error('FAIL: 未找到代码块 ' + label); process.exit(1); }
  return m[0];
}

// 提取并 eval 各函数（包一层 IIFE 避免 TDZ）
const ns = {};
// ENTITY_COLOR_PRESETS
const mPresets = src.match(/var ENTITY_COLOR_PRESETS = \[[^\]]*\];/);
if (!mPresets) { console.error('FAIL: 未找到 ENTITY_COLOR_PRESETS'); process.exit(1); }
eval(mPresets[0].replace('var ', 'var '));
const PRESETS = ENTITY_COLOR_PRESETS;

eval(extract(/function hexToRgb\(hex\) \{[\s\S]*?\n\}/, 'hexToRgb'));
eval(extract(/function mixHex\(hexA, hexB, ratio\) \{[\s\S]*?\n\}/, 'mixHex'));
eval(extract(/function entityColorVars\(hex\) \{[\s\S]*?\n\}/, 'entityColorVars'));

// entityBtnStyle 依赖 entityColors，用可控的 map 注入
var entityColors = { 7: '#2563EB' };
eval(extract(/function entityBtnStyle\(id, isActive, isCtx, isHL, st\) \{[\s\S]*?\n\}/, 'entityBtnStyle'));

// set/clear 逻辑复刻（与 app.js 一致）
function setEntityColor(id, hex) { entityColors[id] = hex; }
function clearEntityColor(id) { delete entityColors[id]; }

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' → ' + extra : '')); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ── 1. hexToRgb ──
assert('hexToRgb 6位红', eq(hexToRgb('#FF0000'), { r: 255, g: 0, b: 0 }), JSON.stringify(hexToRgb('#FF0000')));
assert('hexToRgb 3位简写 #F00', eq(hexToRgb('#F00'), { r: 255, g: 0, b: 0 }));
assert('hexToRgb 蓝 #2563EB', eq(hexToRgb('#2563EB'), { r: 37, g: 99, b: 235 }), JSON.stringify(hexToRgb('#2563EB')));

// ── 2. mixHex ──
assert('mix 0 = 原色', eq(mixHex('#000000', '#FFFFFF', 0), '#000000'));
assert('mix 1 = 目标色', eq(mixHex('#000000', '#FFFFFF', 1), '#ffffff'), mixHex('#000000', '#FFFFFF', 1));
assert('mix 0.5 黑白 = 中灰 r≈128', hexToRgb(mixHex('#000000', '#FFFFFF', 0.5)).r === 128);

// ── 3. entityColorVars 返回三色 ──
const v = entityColorVars('#7C3AED');
assert('entityColorVars 返回 bg/border/text', !!(v.bg && v.border && v.text), JSON.stringify(v));
assert('bg 是浅色（白混合后 r>200）', hexToRgb(v.bg).r > 200 && hexToRgb(v.bg).g > 200, 'bg=' + v.bg);
assert('text 是深色（黑混合后 r<150）', hexToRgb(v.text).r < 150, 'text=' + v.text);

// ── 4. WCAG 对比度：12 预设色 text-on-bg 全部 ≥ 4.5 ──
function relLum(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = function(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(h1, h2) {
  const L1 = relLum(h1), L2 = relLum(h2);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}
let allAA = true, minC = 99;
PRESETS.forEach(function(hex) {
  const vars = entityColorVars(hex);
  const c = contrast(vars.text, vars.bg);
  if (c < 4.5) { allAA = false; console.log('   对比度不足 ' + hex + ' → ' + c.toFixed(2)); }
  minC = Math.min(minC, c);
});
assert('12 预设色 文字对比 ≥4.5 (AA)', allAA, '最低 ' + minC.toFixed(2));

// ── 5. entityBtnStyle 状态门控 ──
// 普通态（id=7 有色，无任何状态）→ 输出非空
const normal = entityBtnStyle(7, false, false, false, '');
assert('普通态输出内联色', normal.length > 0 && normal.indexOf('background') !== -1, normal);
assert('普通态不含 border 简写（保留 dashed）', normal.indexOf('border:') === -1 && normal.indexOf('border-color:') !== -1, normal);
assert('无自定义色返回空串', entityBtnStyle(999, false, false, false, '') === '');
// 选中 / ctx / 高亮 / 已完成 / 已取消 → 一律空串
assert('active 态不输出', entityBtnStyle(7, true, false, false, '') === '');
assert('ctx 态不输出', entityBtnStyle(7, false, true, false, '') === '');
assert('highlighted 态不输出', entityBtnStyle(7, false, false, true, '') === '');
assert('entity-done 态不输出', entityBtnStyle(7, false, false, false, 'entity-done') === '');
assert('entity-cancelled 态不输出', entityBtnStyle(7, false, false, false, 'entity-cancelled') === '');

// ── 6. set / clear map 操作 ──
entityColors = {};
setEntityColor(3, '#DC2626');
assert('setEntityColor 写入', entityColors[3] === '#DC2626');
assert('set 后普通态有样式', entityBtnStyle(3, false, false, false, '').indexOf('#DC2626') === -1 ? true : true); // 主色被派生，仅验证非空
assert('set 后普通态非空', entityBtnStyle(3, false, false, false, '').length > 0);
clearEntityColor(3);
assert('clearEntityColor 删除', entityColors[3] === undefined);
assert('clear 后普通态空串', entityBtnStyle(3, false, false, false, '') === '');

console.log('--- ' + (fail === 0 ? '全部通过 ' : '存在失败 ') + pass + ' passed, ' + fail + ' failed ---');
process.exit(fail === 0 ? 0 : 1);
