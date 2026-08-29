// 自测：验证宽表 CSV 导出/导入的核心逻辑（不依赖 DOM）
// 从 app.js 中拷贝纯函数 / 用 mock 环境包装 DOM 依赖函数

let habitsData = [];
let habitCheckins = {};

// mock localStorage / DOM
const _ls = {};
global.localStorage = {
  getItem: (k) => _ls[k] ?? null,
  setItem: (k, v) => { _ls[k] = v; },
  removeItem: (k) => { delete _ls[k]; }
};

let _lastToast = null;
global.showToast = (msg, type) => { _lastToast = { msg, type }; console.log(`[toast:${type}]`, msg); };
global.saveHabits = () => { localStorage.setItem('ai-task-lens-habits', JSON.stringify(habitsData)); };
global.saveHabitCheckins = () => { localStorage.setItem('ai-task-lens-habit-checkins', JSON.stringify(habitCheckins)); };
global.renderHabits = () => {};

// 复制 app.js 中的核心函数
function formatDateForExport(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const y = parts[0];
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  return `${y}/${m}/${d}`;
}

function parseDateFromImport(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const y = m[1];
  const mo = String(parseInt(m[2], 10)).padStart(2, '0');
  const d = String(parseInt(m[3], 10)).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

const HABIT_AUTO_COLORS = [
  'hsl(142 60% 35%)', 'hsl(25 80% 50%)', 'hsl(330 81% 60%)',
  'hsl(217 91% 60%)', 'hsl(280 65% 55%)', 'hsl(194 97% 37%)',
  'hsl(48 96% 53%)',  'hsl(4 90% 58%)'
];
function pickAutoHabitColor(existingCount) {
  return HABIT_AUTO_COLORS[existingCount % HABIT_AUTO_COLORS.length];
}

// 导出核心（返回 csv 字符串，不写文件）
function exportToCsvString() {
  const activeHabits = habitsData
    .filter(h => h.is_active)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (activeHabits.length === 0) return null;

  const activeIds = new Set(activeHabits.map(h => h.id));
  const dateSet = new Set();
  Object.values(habitCheckins).forEach(ck => {
    if (ck && ck.is_checked && ck.checkin_date && activeIds.has(ck.habit_id)) {
      dateSet.add(ck.checkin_date);
    }
  });
  const sortedDates = Array.from(dateSet).sort();
  const headerCells = ['日期', ...activeHabits.map(h => h.name)];
  const rows = [headerCells.join(',')];
  sortedDates.forEach(dateStr => {
    const row = [formatDateForExport(dateStr)];
    activeHabits.forEach(h => {
      const key = `${h.id}_${dateStr}`;
      const rec = habitCheckins[key];
      row.push(rec && rec.is_checked ? '是' : '否');
    });
    rows.push(row.join(','));
  });
  return rows.join('\r\n') + '\r\n';
}

// 导入核心
function importFromCsvString(csvText) {
  let content = csvText.replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { error: 'empty' };
  const header = lines[0].split(',').map(c => c.trim());
  if (!header[0] || (header[0] !== '日期' && header[0].toLowerCase() !== 'date')) return { error: 'bad-header' };
  const habitNames = header.slice(1).map(c => c.trim()).filter(c => c.length > 0);
  let createdCount = 0;
  const colHabitIds = habitNames.map(name => {
    const existing = habitsData.find(x => x.name === name);
    if (existing) return existing.id;
    const newId = habitsData.length > 0 ? Math.max(...habitsData.map(x => x.id)) + 1 : 1;
    habitsData.push({ id: newId, name, color: pickAutoHabitColor(habitsData.length), sort_order: habitsData.length + 1, is_active: true });
    createdCount++;
    return newId;
  });
  let upsertRows = 0, checkedTrue = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim());
    const dateStr = parseDateFromImport(cells[0]);
    if (!dateStr) continue;
    for (let j = 0; j < colHabitIds.length; j++) {
      const raw = (cells[j + 1] || '').trim();
      const v = raw.toLowerCase();
      let isChecked;
      if (v === '是' || v === '1' || v === 'true' || v === 'yes' || v === 'y') isChecked = true;
      else if (v === '否' || v === '0' || v === 'false' || v === 'no' || v === 'n' || v === '') isChecked = false;
      else continue;
      const habitId = colHabitIds[j];
      const key = `${habitId}_${dateStr}`;
      if (isChecked) { habitCheckins[key] = { habit_id: habitId, checkin_date: dateStr, is_checked: true }; checkedTrue++; }
      else delete habitCheckins[key];
    }
    upsertRows++;
  }
  return { createdCount, upsertRows, checkedTrue };
}

// ============ 测试 ============
console.log('=== TEST 1: 空习惯导出 ===');
console.log('结果:', exportToCsvString());

console.log('\n=== TEST 2: 基础导出 ===');
habitsData = [
  { id: 1, name: '不吃甜食', color: 'hsl(142 60% 35%)', sort_order: 1, is_active: true },
  { id: 2, name: '健身', color: 'hsl(25 80% 50%)', sort_order: 2, is_active: true },
  { id: 3, name: '每日输出一个观点', color: 'hsl(330 81% 60%)', sort_order: 3, is_active: true },
  { id: 4, name: '停用习惯', color: 'hsl(48 96% 53%)', sort_order: 4, is_active: false },
];
habitCheckins = {
  '1_2026-01-01': { habit_id: 1, checkin_date: '2026-01-01', is_checked: true },
  '2_2026-01-01': { habit_id: 2, checkin_date: '2026-01-01', is_checked: true },
  '1_2026-01-02': { habit_id: 1, checkin_date: '2026-01-02', is_checked: true },
  '3_2026-01-15': { habit_id: 3, checkin_date: '2026-01-15', is_checked: true },
  '4_2026-01-10': { habit_id: 4, checkin_date: '2026-01-10', is_checked: true },  // 停用习惯打卡应导出为空
};
const csv1 = exportToCsvString();
console.log(csv1);
// 验证：
console.log('✓ 第一列为「日期」：', csv1.startsWith('日期,'));
console.log('✓ 表头无「停用习惯」：', !csv1.split('\r\n')[0].includes('停用习惯'));
console.log('✓ 日期格式 2026/1/1 (无前导零)：', csv1.includes('2026/1/1'));
console.log('✓ 只有 3 天数据行 (2026-01-01/02/15)：', csv1.split('\r\n').filter(l => l && !l.startsWith('日期')).length === 3);
console.log('✓ 2026-01-10 不出现（因为只有停用习惯打卡）：', !csv1.includes('2026/1/10'));

console.log('\n=== TEST 3: 导入回来 - 完全一致（round-trip）===');
habitCheckins = {};  // 清空 checkins，习惯保留
const r = importFromCsvString(csv1);
console.log('导入结果:', r);
console.log('checkins 现在的 keys:', Object.keys(habitCheckins).sort());
console.log('✓ 应有 4 条 is_checked=true (排除掉停用习惯的4_2026-01-10)：', Object.keys(habitCheckins).length === 4);

console.log('\n=== TEST 4: 未知习惯自动创建 + 值兼容 ===');
habitsData = [
  { id: 1, name: '不吃甜食', color: 'hsl(142 60% 35%)', sort_order: 1, is_active: true },
];
habitCheckins = {};
const csvNew = '日期,不吃甜食,冥想,读书\r\n2026/1/1,是,1,YES\r\n2026-01-02,否,false,\r\n2026/1/3,y,n,true\r\n';
const r2 = importFromCsvString(csvNew);
console.log('导入结果:', r2);
console.log('习惯列表:', habitsData.map(h => `${h.id}:${h.name}(${h.color})`));
console.log('✓ 应新建 2 个习惯:', r2.createdCount === 2);
console.log('✓ 新习惯颜色不重复:', habitsData[1].color !== habitsData[2].color);
console.log('checkins:', Object.entries(habitCheckins).map(([k,v]) => k));

console.log('\n=== TEST 5: 空文件/坏表头处理 ===');
console.log('空:', importFromCsvString(''));
console.log('只表头:', importFromCsvString('日期,健身\r\n'));
console.log('坏表头:', importFromCsvString('X,健身\r\n2026/1/1,是\r\n'));

console.log('\n=== TEST 6: 带 BOM 的 CSV ===');
habitsData = [{ id: 1, name: '健身', color: 'x', sort_order: 1, is_active: true }];
habitCheckins = {};
const r3 = importFromCsvString('\uFEFF日期,健身\r\n2026/1/1,是\r\n');
console.log('结果:', r3, '  checkins:', habitCheckins);
console.log('✓ BOM 正确处理:', Object.keys(habitCheckins).length === 1);

console.log('\n所有测试完成');
