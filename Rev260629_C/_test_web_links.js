// _test_web_links.js
// 验证：相关文件支持 http/https 网络链接（新增/保存/回填/渲染/单击打开/CSV 往返）
// 用法：node _test_web_links.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf-8');
let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log('  ✓ ' + desc); }
  else { fail++; console.log('  ✗ ' + desc); }
}

console.log('=== 网络链接支持测试 ===\n');

// ── 工具：从源码提取单个函数（含函数级依赖注入）
function extractFn(name) {
  const m = src.match(new RegExp('function\\s+' + name + '\\s*\\([\\s\\S]*?\\n\\}'));
  return m ? m[0] : '';
}

// 1. 纯函数行为
const code = [
  extractFn('fileUrl'),
  extractFn('isWebLink'),
  extractFn('sanitizeWebUrl'),
  extractFn('fileDisplayName'),
  extractFn('fileObj')
].join('\n');
let pure;
try {
  pure = new Function(code + '\nreturn { fileUrl, isWebLink, sanitizeWebUrl, fileDisplayName, fileObj };')();
} catch (e) {
  console.log('  ✗ 纯函数提取/编译失败: ' + e.message);
  process.exit(1);
}

check('fileUrl 提取本地文件 url 字段', pure.fileUrl({ fileId: 1, url: 'https://a.com' }) === 'https://a.com');
check('fileUrl 对无 url 返回空串', pure.fileUrl({ fileId: 1, path: '/x' }) === '');
check('isWebLink 识别 https 链接', pure.isWebLink({ url: 'https://example.com' }) === true);
check('isWebLink 识别 http 链接', pure.isWebLink({ url: 'http://example.com' }) === true);
check('isWebLink 拒绝本地文件', pure.isWebLink({ fileId: 3, path: '/x/y.pdf' }) === false);
check('isWebLink 拒绝空值', pure.isWebLink({}) === false);
check('sanitizeWebUrl 通过合法 https', pure.sanitizeWebUrl('https://a.com/x?y=1') === 'https://a.com/x?y=1');
check('sanitizeWebUrl 拒绝 javascript: 协议', pure.sanitizeWebUrl('javascript:alert(1)') === '');
check('sanitizeWebUrl 拒绝 file: 协议', pure.sanitizeWebUrl('file:///c:/x') === '');
check('sanitizeWebUrl 拒绝裸文本', pure.sanitizeWebUrl('不是链接') === '');
check('fileDisplayName 链接项优先显示 name', pure.fileDisplayName({ name: '腾讯文档', url: 'https://x' }) === '腾讯文档');
check('fileDisplayName 无 name 时回退 url', pure.fileDisplayName({ name: '', url: 'https://x' }) === 'https://x');
check('fileObj 对象原样保留引用', pure.fileObj({ fileId: 1, name: 'a' }).fileId === 1);
check('fileObj 字符串包装为对象', pure.fileObj('abc').name === 'abc');
check('fileObj 字符串包装含 url 空串', pure.fileObj('abc').url === '');

// 2. handleListFileChipClick 链接分流（DOM 级）
const chipStub = {
  getAttribute: (k) => ({ 'data-file-url': 'https://open.example.com/p' }[k] || '')
};
let openedUrl = null;
let jumped = false;
const clickCode = [
  extractFn('handleListFileChipClick'),
  'return handleListFileChipClick;'
].join('\n');
const clickFn = new Function('openWebLink', 'jumpToFileInManager', clickCode)(function(u) { openedUrl = u; }, function() { jumped = true; });
clickFn({ stopPropagation() {}, preventDefault() {} }, chipStub);
check('点击链接 chip 调用 openWebLink 且 URL 正确', openedUrl === 'https://open.example.com/p');
check('点击链接 chip 不再跳转文件管理', jumped === false);

// 本地文件 chip 仍走 jumpToFileInManager
const localChip = { getAttribute: (k) => ({ 'data-file-id': '7', 'data-file-path': '/x.pdf', 'data-file-name': 'x.pdf' }[k] || '') };
openedUrl = null; jumped = false;
clickFn({ stopPropagation() {}, preventDefault() {} }, localChip);
check('点击本地文件 chip 仍跳转文件管理', jumped === true);
check('点击本地文件 chip 不触发 openWebLink', openedUrl === null);

// 3. 列表视图渲染：链接 chip 带 data-file-url 与 🔗
const listTd = src.match(/<td style="font-size:11px;color:var\(--gray-500\);max-width:160px[^"]*"[^>]*title="\$\{\(t\.files\|\|\[\]\)\.map\(fileDisplayName\)[\s\S]*?list-file-chip[\s\S]*?<\/td>/);
const listBlock = listTd ? listTd[0] : src.split('function renderTable')[1] || '';
check('列表视图渲染含 data-file-url 属性', listBlock.includes('data-file-url="${_furl}"'));
check('列表视图渲染链接图标分支 🔗', listBlock.includes("${_web ? '🔗' : '📄'}"));
check('列表视图 _linked 判定包含 url', listBlock.includes('(_fid || _fpath || _web)'));

// 4. 时间线视图渲染：链接 chip 带 data-file-url
const tlBlock = src.match(/function\s+renderTimelineTable\s*\([\s\S]*?\n\}/);
const tlBody = tlBlock ? tlBlock[0] : '';
check('时间线视图渲染含 data-file-url 属性', tlBody.includes("data-file-url=\"'+_furl+'\""));
check('时间线视图渲染链接图标分支 🔗', tlBody.includes("'\\uD83D\\uDD17' : '\\uD83D\\uDCC4'"));
check('时间线视图 _linked 判定包含 url', tlBody.includes('(_fid || _fpath || _web)'));

// 5. 悬浮卡链接分支（showFileHoverCard）
const hoverFn = extractFn('showFileHoverCard');
check('悬浮卡读取 data-file-url', hoverFn.includes("chip.getAttribute('data-file-url')"));
check('悬浮卡链接分支含「打开链接」按钮', hoverFn.includes('打开链接') && hoverFn.includes('openWebLink'));

// 6. CSV 导出：链接输出 URL（可往返）
const csvExportLine = src.match(/`"\$\{\(t\.files \|\| \[\]\)\.map\(function\(f\)\{ return isWebLink\(f\) \? fileUrl\(f\) : fileDisplayName\(f\); \}\)\.join\(';'\)\}"`/);
check('CSV 导出链接项输出 URL', !!csvExportLine);

// 7. CSV 导入：识别链接并重建 url 字段
const importBlock = src.match(/files: parseCSVStringArray\(vals\[idx\.files\]\)[\s\S]*?\}\),/);
const importSrc = importBlock ? importBlock[0] : '';
check('CSV 导入使用 sanitizeWebUrl 识别链接', importSrc.includes('sanitizeWebUrl(s)'));
check('CSV 导入链接项带 url 字段', importSrc.includes("url: _url"));

// 8. 编辑弹窗：添加链接控件存在（index.html）
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
check('index.html 有链接输入框 file-link-url', html.includes('id="file-link-url"'));
check('index.html 有显示名称输入框 file-link-name', html.includes('id="file-link-name"'));
check('index.html 有添加链接按钮', html.includes('id="btn-add-file-link"'));
check('index.html 标签文案更新', html.includes('相关文件或网络链接'));

// 9. app.js 添加链接逻辑：协议校验 + 去重 + 结构
const addLinkCode = src.match(/function addLink\(\) \{[\s\S]*?\n  \}/);
const addLinkBody = addLinkCode ? addLinkCode[0] : '';
check('添加链接先经 sanitizeWebUrl 校验', addLinkBody.includes('sanitizeWebUrl(urlInput.value)'));
check('添加链接结构含 url 字段', addLinkBody.includes("{ fileId: null, name: name, path: '', url: url }"));
check('添加链接有去重', addLinkBody.includes('fileUrl(f) === url'));
check('保存时 files 直接存 selectedFiles 副本', src.includes('files: selectedFiles.slice()'));

// 10. 语法完整性兜底：app.js 能整体解析（node --check 等价）
try {
  new Function(src.replace(/^import[^\n]*$/gm, ''));
  check('app.js 可整体解析', true);
} catch (e) {
  check('app.js 可整体解析: ' + e.message, false);
}

console.log(`\n通过 ${pass} / ${fail + pass}`);
process.exit(fail === 0 ? 0 : 1);
