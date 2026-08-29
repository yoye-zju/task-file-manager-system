// _test_timeline_create_btn.js
// 验证：时间线表格视图 header 已增加「➕ 创建内容」按钮
// 用法：node _test_timeline_create_btn.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');
let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

console.log('=== 时间线视图「创建内容」按钮测试 ===\n');

// 1. 提取 renderTimelineTable 函数体
const m = src.match(/function\s+renderTimelineTable\s*\([\s\S]*?\n\}/);
check('renderTimelineTable 函数存在于源码', !!m);
const body = m ? m[0] : '';

// 2. header 里应有「➕ 创建内容」按钮
check('header 包含「➕ 创建内容」按钮', /➕\s*创建内容/.test(body));
check('按钮位于 card-header 内', body.includes('card-header') && body.indexOf('创建内容') > body.indexOf('card-header'));
check('按钮为 btn tl-header-btn btn-primary 样式', /btn tl-header-btn btn-primary/.test(body));

// 3. onclick 调用 createNewContent()
check('onclick 指向 createNewContent()', /onclick="createNewContent\(\)"/.test(body) || /onclick="createNewContent\(\)"|onclick='createNewContent\(\)'/.test(body));

// 4. 按钮在标题栏绝对居中（R3.14 起，原 margin-left:auto 方案已废弃）
check('按钮标题栏居中（left:50% + translateX(-50%)）', /left:50%/.test(body) && /translateX\(-50%\)/.test(body));

// 5. createNewContent 函数存在（按钮回调目标）
const cm = src.match(/function\s+createNewContent\s*\([\s\S]*?\n\}/);
check('createNewContent 函数存在', !!cm);

// 6. 不会破坏行内 onclick 引号嵌套（无裸双引号冲突：onclick 属性用双引号，内部无引号）
check('onclick 属性无引号嵌套冲突', /onclick="createNewContent\(\)"/.test(body));

console.log(`\n通过 ${pass} / ${fail + pass}`);
process.exit(fail === 0 ? 0 : 1);
