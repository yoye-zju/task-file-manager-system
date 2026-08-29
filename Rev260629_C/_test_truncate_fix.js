// _test_truncate_fix.js
// 静态验证两处截断样式已修复
// 用法：node _test_truncate_fix.js
const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'style.css');
const css = fs.readFileSync(cssPath, 'utf8');

let passed = 0;
let failed = 0;

function check(label, ok, hint) {
  if (ok) { passed++; console.log(`✓ ${label}`); }
  else    { failed++; console.error(`✗ ${label}\n    ${hint}`); }
}

// 提取 .breadcrumb-seg 的样式块
function extractBlock(selector, cssText) {
  // 简单策略：找选择器后的 { ... } 块
  const idx = cssText.indexOf(selector + ' {');
  if (idx < 0) return null;
  const braceStart = cssText.indexOf('{', idx);
  let depth = 1; let i = braceStart + 1;
  while (i < cssText.length && depth > 0) {
    const c = cssText[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return cssText.slice(braceStart + 1, i - 1);
}

const breadcrumb = extractBlock('.breadcrumb-seg', css);
check('找到 .breadcrumb-seg 样式块', breadcrumb !== null,
  '.breadcrumb-seg 可能被删除或重命名');
check('.breadcrumb-seg 含 white-space: normal', breadcrumb && /white-space:\s*normal/.test(breadcrumb),
  '应为 white-space: normal');
check('.breadcrumb-seg 含 overflow-wrap: anywhere', breadcrumb && /overflow-wrap:\s*anywhere/.test(breadcrumb),
  '应为 overflow-wrap: anywhere（中文场景更优雅断词）');
check('.breadcrumb-seg 含 word-break: break-word', breadcrumb && /word-break:\s*break-word/.test(breadcrumb),
  '应为 word-break: break-word（兜底）');
check('.breadcrumb-seg 已移除 nowrap', breadcrumb && !/white-space:\s*nowrap/.test(breadcrumb),
  '不应再含 white-space: nowrap');
check('.breadcrumb-seg 已移除 text-overflow: ellipsis', breadcrumb && !/text-overflow:\s*ellipsis/.test(breadcrumb),
  '不应再含 text-overflow: ellipsis');
check('.breadcrumb-seg 已移除 overflow: hidden', breadcrumb && !/overflow:\s*hidden/.test(breadcrumb),
  '不应再含 overflow: hidden');
check('.breadcrumb-seg max-width 放宽到 >=160', breadcrumb && /max-width:\s*(\d+)px/.test(breadcrumb) && parseInt(breadcrumb.match(/max-width:\s*(\d+)px/)[1]) >= 160,
  'max-width 建议加大以容纳更多文本');

const treeNode = extractBlock('.preview-tree .tree-node', css);
check('找到 .preview-tree .tree-node 样式块', treeNode !== null,
  '.preview-tree .tree-node 可能被删除或重命名');
check('.preview-tree .tree-node 含 white-space: normal', treeNode && /white-space:\s*normal/.test(treeNode),
  '应为 white-space: normal');
check('.preview-tree .tree-node 含 overflow-wrap: anywhere', treeNode && /overflow-wrap:\s*anywhere/.test(treeNode),
  '应为 overflow-wrap: anywhere');
check('.preview-tree .tree-node 含 word-break: break-word', treeNode && /word-break:\s*break-word/.test(treeNode),
  '应为 word-break: break-word（兜底）');
check('.preview-tree .tree-node 已移除 nowrap', treeNode && !/white-space:\s*nowrap/.test(treeNode),
  '不应再含 white-space: nowrap');
check('.preview-tree .tree-node 已移除 text-overflow: ellipsis', treeNode && !/text-overflow:\s*ellipsis/.test(treeNode),
  '不应再含 text-overflow: ellipsis');
check('.preview-tree .tree-node 已移除 overflow: hidden', treeNode && !/overflow:\s*hidden/.test(treeNode),
  '不应再含 overflow: hidden');

// 顺便确认 modal-breadcrumb 的容器不应禁掉换行（如果是 nowrap 会约束子元素）
const mb = extractBlock('.modal-breadcrumb', css);
// .modal-breadcrumb 是水平滚动容器，本身 white-space: nowrap 是为了让箭头不换行（视觉）
// 这里不强制改动，只打印当前状态供参考
console.log(`(参考) .modal-breadcrumb 当前 white-space: ${mb && /white-space:\s*(\w+)/.test(mb) ? mb.match(/white-space:\s*(\w+)/)[1] : '未设'}`);

console.log(`\n通过 ${passed} / ${failed + passed}`);
process.exit(failed === 0 ? 0 : 1);
