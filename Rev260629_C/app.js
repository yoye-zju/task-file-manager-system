
window.onerror = function(msg, url, line, col, err) {
  const fullMsg = '页面错误：' + msg + ' (行:' + line + ')';
  console.error('[global error]', fullMsg, err);
  if (typeof showToast === 'function') showToast(fullMsg, 'error');
  else alert(fullMsg);
  return false;
};
// ============ DATA MODEL ============
let tasks = [];
let nextId = 1;
let currentView = 'dashboard'; // 当前显示的视图，用于 renderAll 优化
let editingTaskId = null;
let nextParentTaskId = null; // 用于「增加后置任务」保存后同步 next 关系
let formSnapshot = '';      // 编辑弹窗打开时的表单快照（用于防误关脏检查）
let highlightChain = null;
let dataSource = '';
let listActiveTags = null;      // 单选：当前选中的标签，null 表示无
let listKissFilter = null;      // KISS 复盘筛选：'KEEP'/'IMPROVE'/'START'/'STOP'，null 表示无
let listEntityFilters = null;    // 单选：当前选中的实体ID，null 表示无
let listColFilters = {};         // 列筛选：{ field: value or null }
let tlActiveTags = null;         // 时间线快速筛选：标签
let tlTableTypeFilter = null;     // 时间线表格视图类型筛选：null | object | kr | target | task | record | schedule | idea（独立于其他视图）
let typeFilter = [];             // 列表类型筛选（数组，空数组表示全部）
let statusFilter = [];           // 列表状态筛选（数组，空数组表示全部）
let showArchived = false;        // 是否显示已归档内容（叠加模式）
let archiveOnly = false;         // 筛选模式：仅显示已归档内容
let searchQuery = '';            // 搜索关键词
let dateFilter = null;           // 日期筛选：todayTodo, weekDeadline, monthDeadline, overdue
let activeQuickFilter = null;     // 侧边栏快速筛选：互斥单选，值为 null | todayTodo | weekDue | monthDue | timelineTable
let tlDateFilter = null;          // 时间线表格视图日期筛选：null | todayTodo | weekDue | monthDue | overdue（独立于列表 dateFilter）
let tlDoneFilter = false;         // 时间线表格视图：仅显示已完成（与日期筛选互斥）
let _navFromQuickFilter = false;  // 标志位：区分「用户手动点主导航」vs「quickFilter 内部触发 .click()」
// 归档状态统一判据：兼容布尔 true / 字符串 'true'，排除字符串 'false' 被误判为真值
function isArchivedOf(t) {
  if (!t) return false;
  const v = t.isArchived;
  return v === true || v === 'true' || v === 1 || v === '1';
}
let tlEntityFilters = null;      // 时间线快速筛选：实体ID
let tlSearch = '';               // 时间线表格搜索关键词（R3.31：非空时搜索优先于其他筛选）
let tlSearchComposing = false;   // R3.31 修复：中文输入法组合状态标志（组合中不触发防抖渲染，避免打断 IME）
let tlSearchInput = null;        // R3.31 修复：搜索框节点缓存——只创建一次、渲染时移动节点而非重建，保护 IME 组合状态
let boardActiveTags = null;      // 团队看板快速筛选：标签
let boardEntityFilters = null;   // 团队看板快速筛选：实体ID
let boardShowAll = false;        // 团队看板：显示全部/仅活跃
let showDone = false;           // 全局：甘特图/矩阵/看板是否显示已完成任务
let listSortType = 'tree';       // 任务列表排序类型
let calYear = new Date().getFullYear();   // 日历：当前显示年份
let calMonth = new Date().getMonth();     // 日历：当前显示月份 (0-11)
let calFilterStatus = 'all';     // 日历：状态筛选 all|active|done
const statusMap = { todo: '待办', preparing: '准备中', progress: '进行中', done: '已完成', blocked: '阻塞', cancel: '已取消' };

function saveData() {
  localStorage.setItem('ai-task-lens-tasks', JSON.stringify(tasks));
  localStorage.setItem('ai-task-lens-nextId', nextId.toString());
  updateQuickActionBadges();
  schedulePushContentLinks();
}

// 去抖推送链接索引到文件管理系统（后端未启动时静默失败）
let _pushLinksTimer = null;
function schedulePushContentLinks() {
  if (_pushLinksTimer) clearTimeout(_pushLinksTimer);
  _pushLinksTimer = setTimeout(pushContentLinksNow, 1500);
}
function pushContentLinksNow() {
  try {
    const links = [];
    (tasks || []).forEach(t => {
      (t.files || []).forEach(f => {
        if (f && f.path) {
          links.push({
            path: f.path,
            blockId: t.id,
            blockTitle: t.title || '',
            blockType: t.type || '',
            timestamp: t.timestamp || ''
          });
        }
      });
    });
    console.log('[content-links] pushing', links.length, 'links');
    if (typeof FileManagerAPI !== 'undefined') FileManagerAPI.pushContentLinks(links);
  } catch (e) { console.error('[content-links] push error:', e); }
}

// 通用防抖：连续触发只在停止 ms 毫秒后执行一次（用于搜索输入等高频事件，避免全量重渲染）
function debounce(fn, ms) {
  let timer = null;
  return function () {
    const self = this, args = arguments;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { fn.apply(self, args); }, ms || 200);
  };
}
// 时间线日历视图搜索输入的防抖版重渲染（输入停止 200ms 后只重渲染一次）
const debouncedRenderTimeline = debounce(() => renderTimeline(), 200);
// 时间线表格搜索输入防抖（R3.31）：停止输入 200ms 后重渲染。
// IME 保护（R3.31 修复）：① 组合中（tlSearchComposing）跳过渲染，等 compositionend 重新触发；
// ② 搜索框节点复用（tlSearchInput 只创建一次，渲染时移动节点而非重建），组合结束后的渲染不打断输入法会话
const debouncedRenderTimelineTable = debounce(function() {
  if (tlSearchComposing) return;   // 中文输入法组合中：不重渲染，避免打断组词
  const hadFocus = tlSearchInput && document.activeElement === tlSearchInput;
  renderTimelineTable();
  if (hadFocus && tlSearchInput) tlSearchInput.focus();   // 节点移动后恢复焦点
}, 200);

function loadData() {
  const saved = localStorage.getItem('ai-task-lens-tasks');
  if (saved) {
    tasks = JSON.parse(saved);
    nextId = parseInt(localStorage.getItem('ai-task-lens-nextId') || '1');
    const src = localStorage.getItem('ai-task-lens-source');
    if (src) dataSource = src;
    // 数据版本：用于触发强制迁移
    var dataVersion = parseInt(localStorage.getItem('ai-task-lens-data-version') || '0');
    var currentVersion = 7;  // 当前数据格式版本
    // 版本1→2: 补全字段 | 版本2→3: 修复重复时间戳 | 版本3→4: 周期任务字段 | 版本4→5: 周期任务展开为独立任务 | 版本5→6: 新增 completedAt 字段 | 版本6→7: P0-P3 优先级 → 四象限中文值
    var forceMigrate = dataVersion < currentVersion;
    if (forceMigrate) {
      // 仅旧版本(<=5)需要重建时间戳；v6 起 timestamp 已是飞书同步 key，不得重建
      if (dataVersion < 6) {
        tasks.forEach(function(t) { delete t.timestamp; });
      }
    }
    // 数据迁移：补全缺失字段
    let migrated = false;
    tasks.forEach(t => {
      if (!t.type) { t.type = 'task'; migrated = true; }
      if (t.parentId === undefined) { t.parentId = null; migrated = true; }
      if (!t.children) { t.children = []; migrated = true; }
      if (!t.deps) { t.deps = []; migrated = true; }
      if (!t.next) { t.next = []; migrated = true; }
      if (!t.assignee) { t.assignee = ''; migrated = true; }
      if (!t.startDate) { t.startDate = null; migrated = true; }
      if (!t.files) { t.files = []; migrated = true; }
      // files 结构升级：字符串 → {fileId, name, path}
      if (Array.isArray(t.files) && t.files.some(f => typeof f === 'string')) {
        t.files = t.files.map(f => typeof f === 'string' ? { fileId: null, name: f, path: '', url: '' } : f);
        migrated = true;
      }
      // 网络链接与本地文件共用 files 数组；旧对象补齐 url 字段
      if (Array.isArray(t.files)) {
        t.files = t.files.map(function(f) {
          if (!f || typeof f !== 'object') return f;
          if (f.url === undefined) { f.url = ''; migrated = true; }
          return f;
        });
      }
      if (t.isMilestone === undefined) { t.isMilestone = false; migrated = true; }
      if (t.isArchived === undefined) { t.isArchived = false; migrated = true; }
      // 版本4→5: 周期任务展开为独立任务（标记，forEach 后统一处理）
      if (t.isRecurring === true && Array.isArray(t.dates) && t.dates.length > 0) {
        t._migrateExpand = true;
        migrated = true;
      }
      if (t.recurringGroupId === undefined) { t.recurringGroupId = null; migrated = true; }
      // 归一化：字符串 'true'/'false'（飞书同步/CSV 导入场景）统一转为布尔
      if (typeof t.isArchived !== 'boolean') {
        t.isArchived = (t.isArchived === 'true' || t.isArchived === 1 || t.isArchived === '1');
        migrated = true;
      }
      // 将旧的 status===archived 转换为 isArchived=true
      if (t.status === 'archived') {
        t.isArchived = true;
        t.status = 'done';
        migrated = true;
      }
      // 版本5→6: 新增 completedAt 字段（幂等：=== undefined 才补）
      if (t.completedAt === undefined) {
        t.completedAt = (t.status === 'done') ? (t.createdAt || null) : null;
        migrated = true;
      }
      // 版本6→7: P0-P3 优先级 → 四象限中文值（幂等：normalizePriority 对合法中文原样返回）
      const _np = normalizePriority(t.priority);
      if (t.priority !== _np) { t.priority = _np; migrated = true; }
      if (!t.timestamp) {
        t.timestamp = makeTimestamp();
        migrated = true;
      }
      _tsUsed[t.timestamp] = true;
    });
    // 第二遍：去重 —— 如果因 createdAt 推导等原因导致重复，重新生成
    var seenTs = {};
    tasks.forEach(function(t) {
      if (seenTs[t.timestamp]) {
        t.timestamp = makeTimestamp();
        migrated = true;
      }
      seenTs[t.timestamp] = true;
      _tsUsed[t.timestamp] = true;
    });
    // 版本4→5: 展开周期任务为多个独立任务
    var toExpand = tasks.filter(function(t) { return t._migrateExpand; });
    if (toExpand.length > 0) {
      toExpand.forEach(function(t) {
        var groupId = makeTimestamp();
        (t.dates || []).forEach(function(ds) {
          var clone = Object.assign({}, t);
          clone.id = nextId++;
          clone.timestamp = makeTimestamp();
          clone.deadline = ds;
          clone.startDate = ds;
          clone.status = (t.doneDates && t.doneDates[ds]) ? 'done' : (t.status || 'todo');
          clone.progress = (t.doneDates && t.doneDates[ds]) ? 100 : (t.progress || 0);
          clone.recurringGroupId = groupId;
          clone.children = [];
          clone.isRecurring = false;
          clone.repeatRule = null;
          clone.dates = [];
          clone.doneDates = {};
          delete clone._migrateExpand;
          tasks.push(clone);
        });
      });
      tasks = tasks.filter(function(t) { return !t._migrateExpand; });
    }
    // 清理普通任务的旧四字段
    tasks.forEach(function(t) {
      delete t.isRecurring;
      delete t.repeatRule;
      delete t.dates;
      delete t.doneDates;
      delete t._migrateExpand;
    });
    if (migrated || forceMigrate) {
      localStorage.setItem('ai-task-lens-data-version', String(currentVersion));
      saveData();
    }
    // 重建 children
    rebuildChildren(tasks);
  }
}

const TYPE_LABELS = { object: '目标', kr: '关键结果', target: '子目标', task: '任务', record: '记录', schedule: '日程', idea: '想法' };
const TYPE_ORDER = { object: 0, kr: 1, target: 2, task: 3, record: 4, schedule: 5, idea: 6 };
const TYPE_COLORS = { object: '#7C3AED', kr: '#3B82F6', target: '#06B6D4', task: '#6B7280', record: '#8B5CF6', schedule: '#F59E0B', idea: '#10B981' };
const PRIORITY_VALID = ['重要紧急', '重要不紧急', '紧急不重要', '不紧急不重要'];
// ── 优先级四象限体系（R3.5）──
const PRIORITY_ORDER = { '重要紧急': 0, '重要不紧急': 1, '紧急不重要': 2, '不紧急不重要': 3 };
const PRIORITY_COLORS = { '重要紧急': '#DC2626', '重要不紧急': '#D97706', '紧急不重要': '#2563EB', '不紧急不重要': '#6B7280' };          // 文字/圆点色
const PRIORITY_BG = { '重要紧急': '#FEE2E2', '重要不紧急': '#FEF3C7', '紧急不重要': '#DBEAFE', '不紧急不重要': '#F3F4F6' };                // 徽章背景
const PRIORITY_GRADIENTS = {
  '重要紧急': 'linear-gradient(135deg,#EF4444,#DC2626)',
  '重要不紧急': 'linear-gradient(135deg,#F59E0B,#D97706)',
  '紧急不重要': 'linear-gradient(135deg,#3B82F6,#2563EB)',
  '不紧急不重要': 'linear-gradient(135deg,#9CA3AF,#6B7280)',
};
const PRIORITY_ICONS = { '重要紧急': '🔴', '重要不紧急': '🟠', '紧急不重要': '🟡', '不紧急不重要': '🟢' };                                    // TXT 导出
const DEFAULT_PRIORITY = '重要不紧急';
// 旧 P0-P3 / 飞书带加号「级别」→ 本地中文（CSV 导入、迁移、健康检查共用）
const LEGACY_PRIORITY_MAP = {
  P0: '重要紧急', P1: '重要不紧急', P2: '紧急不重要', P3: '不紧急不重要',
  '重要+紧急': '重要紧急', '重要+不紧急': '重要不紧急',
  '不重要+紧急': '紧急不重要', '不重要+不紧急': '不紧急不重要',
};
const FEISHU_TO_LOCAL_PRIORITY = { '重要+紧急': '重要紧急', '重要+不紧急': '重要不紧急', '不重要+紧急': '紧急不重要', '不重要+不紧急': '不紧急不重要' };
function normalizePriority(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PRIORITY;
  const s = String(raw).trim();
  if (LEGACY_PRIORITY_MAP[s]) return LEGACY_PRIORITY_MAP[s];
  if (PRIORITY_VALID.indexOf(s) !== -1) return s;
  return DEFAULT_PRIORITY;   // 未知值回落
}
const SEVERITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const SEVERITY_LABELS = { P0: '致命', P1: '严重', P2: '索引一致性', P3: '业务语义' };


// 层级合法父类型白名单：'*' 表示不限制（record/schedule/idea 为附属信息，不参与 OKR 层级）
// 说明：跨层跳级（如 task 直挂 object）是产品设计明确支持的，故各类型的白名单包含所有更高层级
const ALLOWED_PARENTS = {
  object: [],                              // 顶级，不能有上级
  kr:     ['object'],
  target: ['kr', 'object'],
  task:   ['target', 'kr', 'object'],
  record: '*', schedule: '*', idea: '*'
};

// ── children 冗余索引全量重建（唯一真相源是 parentId） ──
// 统一 loadData / 飞书 merge / CSV 导入 / 健康修复 四处此前各写一份的实现。
// 关键点：用 `+t.parentId` 数字化比较，兼容字符串型 parentId（飞书同步/CSV 产物）。
function rebuildChildren(list) {
  const arr = list || tasks;
  arr.forEach(t => { t.children = []; });
  arr.forEach(t => {
    if (t.parentId === null || t.parentId === undefined || t.parentId === '') return;
    const pid = +t.parentId;
    if (!Number.isFinite(pid)) return;
    const p = arr.find(x => x.id === pid);
    if (p && p.id !== t.id && !p.children.includes(t.id)) p.children.push(t.id);
  });
  return arr;
}

// ── 文件管理系统 API 客户端 ──
const FILE_API_BASE = 'http://localhost:3456/api';
let _fileApiWarned = false; // 避免频繁弹提示
const FileManagerAPI = {
  _warn() {
    if (!_fileApiWarned) {
      _fileApiWarned = true;
      if (typeof showToast === 'function') showToast('文件管理系统未启动，请先启动（端口 3456）', 'error');
      setTimeout(() => { _fileApiWarned = false; }, 8000);
    }
  },
  async _fetch(path, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(FILE_API_BASE + path, Object.assign({ signal: ctrl.signal }, options || {}));
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  },
  async checkHealth() {
    try { await this._fetch('/health'); return true; } catch (e) { return false; }
  },
  async listFiles(opts) {
    opts = opts || {};
    const q = new URLSearchParams();
    if (opts.keyword) q.set('keyword', opts.keyword);
    if (opts.ext) q.set('ext', opts.ext);
    q.set('page', String(opts.page || 1));
    q.set('page_size', String(opts.page_size || 50));
    try {
      return await this._fetch('/files?' + q.toString());
    } catch (e) { this._warn(); return { total: 0, data: [] }; }
  },
  async getTags() {
    try { return await this._fetch('/tags'); } catch (e) { this._warn(); return []; }
  },
  async openFile(id) {
    try { return await this._fetch('/files/' + id + '/open', { method: 'POST' }); }
    catch (e) { this._warn(); return { ok: false }; }
  },
  async showFile(id) {
    try { return await this._fetch('/files/' + id + '/show', { method: 'POST' }); }
    catch (e) { this._warn(); return { ok: false }; }
  },
  async pushContentLinks(links) {
    try { return await this._fetch('/content-links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: links })
    }); } catch (e) { return { ok: false }; }
  }
};

// 文件项显示名（兼容旧字符串、本地文件对象与网络链接对象）
function fileUrl(f) { return (f && typeof f === 'object' && typeof f.url === 'string') ? f.url.trim() : ''; }
function isWebLink(f) { return /^https?:\/\//i.test(fileUrl(f)); }
function sanitizeWebUrl(raw) {
  try {
    const value = String(raw || '').trim();
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch (e) { return ''; }
}
function fileDisplayName(f) {
  return (f && typeof f === 'object') ? (f.name || fileUrl(f) || f.path || '') : (f || '');
}
function fileObj(f) {
  return (f && typeof f === 'object') ? f : { fileId: null, name: f || '', path: '', url: '' };
}
function openWebLink(raw) {
  const url = sanitizeWebUrl(raw);
  if (!url) { showToast('链接无效，仅支持 http:// 或 https:// 链接', 'error'); return false; }
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

// ── 列表相关文件 chip 悬浮卡与跳转到文件管理 ──
let _fileHoverShowTimer = null;
let _fileHoverHideTimer = null;
function _ensureFileHoverCard() {
  let el = document.getElementById('file-hover-card');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'file-hover-card';
  el.className = 'file-hover-card';
  el.style.display = 'none';
  el.addEventListener('mouseenter', () => { if (_fileHoverHideTimer) { clearTimeout(_fileHoverHideTimer); _fileHoverHideTimer = null; } });
  el.addEventListener('mouseleave', scheduleHideFileHoverCard);
  document.body.appendChild(el);
  return el;
}
function showFileHoverCard(evt, chip) {
  if (_fileHoverHideTimer) { clearTimeout(_fileHoverHideTimer); _fileHoverHideTimer = null; }
  if (_fileHoverShowTimer) clearTimeout(_fileHoverShowTimer);
  const fid = chip.getAttribute('data-file-id') || '';
  const fpath = chip.getAttribute('data-file-path') || '';
  const furl = chip.getAttribute('data-file-url') || '';
  const fname = chip.getAttribute('data-file-name') || '';
  const webLink = !!furl;
  const linked = !!(fid || fpath || furl);
  _fileHoverShowTimer = setTimeout(() => {
    const card = _ensureFileHoverCard();
    if (webLink) {
      card.innerHTML = `
        <div class="file-hover-card-name" title="${fname}">🔗 ${fname || furl}</div>
        <div class="file-hover-card-path" title="${furl}">${furl}</div>
        <div class="file-hover-card-actions">
          <button class="file-hover-btn" onclick="openWebLink('${furl.replace(/'/g, '%27')}')">↗ 打开链接</button>
        </div>
      `;
    } else {
      const disableAttr = linked ? '' : 'disabled';
      const openable = fid ? '' : 'disabled';
      card.innerHTML = `
        <div class="file-hover-card-name" title="${fname}">📄 ${fname || '(无名)'}</div>
        <div class="file-hover-card-path" title="${fpath}">${fpath || '<span style="color:var(--gray-400);">(该文件未挂载真实路径)</span>'}</div>
        <div class="file-hover-card-actions">
          <button class="file-hover-btn" ${openable} onclick="_fhOpen('${fid}')">📂 打开文件</button>
          <button class="file-hover-btn" ${openable} onclick="_fhShow('${fid}')">📁 打开路径</button>
          <button class="file-hover-btn" ${disableAttr} onclick="_fhJump('${fid}','${fpath}','${fname}')">🔎 到文件管理定位</button>
        </div>
      `;
    }
    // 定位：卡片出现在 chip 右侧，避免遮挡下方文件
    const rect = chip.getBoundingClientRect();
    card.style.display = 'block';
    const cardRect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right + window.scrollX + 8;
    // 右侧空间不够时放到左侧
    if (left + cardRect.width > vw - 8) left = rect.left + window.scrollX - cardRect.width - 8;
    if (left < 8) left = 8;
    let top = rect.top + window.scrollY - 4;
    // 下方空间不够时向上
    if (top + cardRect.height > vh - 8) top = vh - cardRect.height - 8;
    if (top < 4) top = 4;
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }, 200);
}
function scheduleHideFileHoverCard() {
  if (_fileHoverShowTimer) { clearTimeout(_fileHoverShowTimer); _fileHoverShowTimer = null; }
  if (_fileHoverHideTimer) clearTimeout(_fileHoverHideTimer);
  _fileHoverHideTimer = setTimeout(() => {
    const el = document.getElementById('file-hover-card');
    if (el) el.style.display = 'none';
  }, 300);
}
function _fhOpen(fid) { if (fid) FileManagerAPI.openFile(parseInt(fid)); }
function _fhShow(fid) { if (fid) FileManagerAPI.showFile(parseInt(fid)); }
function _fhJump(fid, path, name) { jumpToFileInManager({ fileId: fid ? parseInt(fid) : null, path: path || '', name: name || '' }); }

function handleListFileChipClick(evt, chip) {
  evt.stopPropagation();
  evt.preventDefault();
  const furl = chip.getAttribute('data-file-url') || '';
  if (furl) { openWebLink(furl); return; }
  const fid = chip.getAttribute('data-file-id') || '';
  const fpath = chip.getAttribute('data-file-path') || '';
  const fname = chip.getAttribute('data-file-name') || '';
  jumpToFileInManager({ fileId: fid ? parseInt(fid) : null, path: fpath, name: fname });
}

function jumpToFileInManager(opts) {
  opts = opts || {};
  const hc = document.getElementById('file-hover-card');
  if (hc) hc.style.display = 'none';
  const fid = opts.fileId || '';
  const fpath = opts.path || '';
  const fname = opts.name || '';
  let url = 'http://localhost:3456';
  const params = [];
  if (fid) params.push('file=' + encodeURIComponent(fid));
  if (fpath) params.push('path=' + encodeURIComponent(fpath));
  if (fname) params.push('name=' + encodeURIComponent(fname));
  if (params.length > 0) url += '?' + params.join('&');
  window.open(url, 'file-manager-window');
}

function updateDataSourceBadge() {
  const badge = document.getElementById('data-source-badge');
  if (!badge) return;
  const count = tasks.length;
  const prev = badge.className;
  if (dataSource === 'csv') {
    badge.textContent = `📂 CSV 导入 · ${count} 条`;
    badge.className = 'data-source-badge csv';
  } else if (dataSource === 'demo') {
    badge.textContent = `📦 演示数据 · ${count} 条`;
    badge.className = 'data-source-badge demo';
  } else {
    badge.textContent = `✏️ 手动创建 · ${count} 条`;
    badge.className = 'data-source-badge manual';
  }
  if (prev !== badge.className && dataSource === 'csv') {
    badge.classList.add('flash');
    setTimeout(() => badge.classList.remove('flash'), 2000);
  }
}

function renderAll() {
  // 只渲染当前激活的视图，大幅提升性能
  switch (currentView) {
    case 'dashboard': renderDashboard(); break;
    // R3.38：任务列表视图已移除，任何残留的 'list' 状态统一落到时间线表格视图
    case 'list': renderTimelineTable(); break;
    case 'timeline': renderTimeline(); break;
    case 'matrix': renderMatrix(); break;
    case 'board': renderBoard(); break;
    case 'timeline-table': renderTimelineTable(); break;
    case 'habits': renderHabits(); break;
    case 'files': renderFiles(); break;
  }
  updateTaskCount();
}

function updateTaskCount() {
  // R3.38：task-count 徽章随「任务列表」导航项一并移除；保留计数逻辑，节点不存在时安全跳过
  const el = document.getElementById('task-count');
  if (!el) return;
  const ct = tasks.filter(t => t.status !== 'done' && !isArchivedOf(t)).length;
  el.textContent = ct;
}

function countByType(type) { return tasks.filter(t => t.type === type).length; }

// ---- Dashboard ----
function renderDashboard() {
  const el = document.getElementById('view-dashboard');
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const inProgress = tasks.filter(t => t.status === 'progress').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const archived = tasks.filter(t => isArchivedOf(t)).length;
  const overdue = tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.status !== 'done' && t.status !== 'cancel' && !isArchivedOf(t)).length;
  const nObj = countByType('object'), nKR = countByType('kr'), nTgt = countByType('target'), nTask = countByType('task');
  const nRecord = countByType('record'), nIdea = countByType('idea');
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59, 999);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7 - weekEnd.getDay());
  weekEnd.setHours(23, 59, 59, 999);
  const overdue3Days = new Date(today);
  overdue3Days.setDate(overdue3Days.getDate() - 3);
  overdue3Days.setHours(0, 0, 0, 0);
  const todayTodo = tasks.filter(t => (t.type === 'task' || t.type === 'schedule') && t.status !== 'done' && t.status !== 'cancel' && !isArchivedOf(t) && t.deadline && 
    new Date(t.deadline) >= overdue3Days && new Date(t.deadline) <= todayEnd
  ).length;
  const weekDeadline = tasks.filter(t => (t.type === 'task' || t.type === 'schedule') && t.deadline && t.status !== 'done' && t.status !== 'cancel' && !isArchivedOf(t) && new Date(t.deadline) >= today && new Date(t.deadline) <= weekEnd).length;
  
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  monthEnd.setHours(23, 59, 59, 999);
  const monthDeadline = tasks.filter(t => (t.type === 'task' || t.type === 'schedule') && t.deadline && t.status !== 'done' && t.status !== 'cancel' && !isArchivedOf(t) && new Date(t.deadline) >= today && new Date(t.deadline) <= monthEnd).length;

  const insights = generateInsights();
  const nextActions = getNextActions(3);

  // KISS 复盘数据
  const KISS_META = [
    { tag:'KEEP',    cls:'keep',    icon:'✅' },
    { tag:'IMPROVE', cls:'improve', icon:'📈' },
    { tag:'START',   cls:'start',   icon:'🚀' },
    { tag:'STOP',    cls:'stop',    icon:'🛑' },
  ];
  const kissItems = KISS_META.map(m => ({
    ...m,
    tasks: tasks.filter(t => {
      // R3.35 修复：描述字段名为 desc（非 description），否则描述里的标记永远扫不到
      const text = ((t.title||'') + ' ' + (t.desc||'')).toUpperCase();
      return text.includes('[' + m.tag + ']');
    })
  }));
  const hasKiss = kissItems.some(k => k.tasks.length > 0);

  el.innerHTML = `
    <div class="action-cards">
      <div class="action-card" onclick="navigateToListWithFilter('todayTodo')">
        <div class="action-icon">📅</div>
        <div class="action-info">
          <div class="action-count">${todayTodo}</div>
          <div class="action-label">今日待办</div>
        </div>
        <div class="action-arrow">→</div>
      </div>
      <div class="action-card" onclick="navigateToListWithFilter('weekDeadline')">
        <div class="action-icon">📆</div>
        <div class="action-info">
          <div class="action-count">${weekDeadline}</div>
          <div class="action-label">本周到期</div>
        </div>
        <div class="action-arrow">→</div>
      </div>
      <div class="action-card" onclick="navigateToListWithFilter('monthDeadline')">
        <div class="action-icon">📋</div>
        <div class="action-info">
          <div class="action-count">${monthDeadline}</div>
          <div class="action-label">本月到期</div>
        </div>
        <div class="action-arrow">→</div>
      </div>
    </div>
    <div class="stats-grid">
      <div class="stat-card" onclick="navigateToListWithFilter('type','object')"><div class="stat-icon purple">🎯</div><div><div class="stat-value">${nObj}</div><div class="stat-label">目标 (Object)</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('type','kr')"><div class="stat-icon blue">📊</div><div><div class="stat-value">${nKR}</div><div class="stat-label">关键结果 (KR)</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('type','target')"><div class="stat-icon cyan">🎯</div><div><div class="stat-value">${nTgt}</div><div class="stat-label">子目标 (Target)</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('type','task')"><div class="stat-icon gray">✅</div><div><div class="stat-value">${nTask}</div><div class="stat-label">任务 (Task)</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('type','record')"><div class="stat-icon purple">📝</div><div><div class="stat-value">${nRecord}</div><div class="stat-label">记录 (Record)</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('type','idea')"><div class="stat-icon green">💡</div><div><div class="stat-value">${nIdea}</div><div class="stat-label">想法 (Idea)</div></div><div class="stat-arrow">→</div></div>
    </div>
    <div class="stats-grid">
      <div class="stat-card" onclick="navigateToListWithFilter('status','done')"><div class="stat-icon green">✅</div><div><div class="stat-value">${done}</div><div class="stat-label">已完成</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('status','progress')"><div class="stat-icon amber">⏳</div><div><div class="stat-value">${inProgress}</div><div class="stat-label">进行中</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('overdue')"><div class="stat-icon red">⚠️</div><div><div class="stat-value">${overdue}</div><div class="stat-label">已逾期</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="navigateToListWithFilter('status','blocked')"><div class="stat-icon purple">🚫</div><div><div class="stat-value">${blocked}</div><div class="stat-label">被阻塞</div></div><div class="stat-arrow">→</div></div>
      <div class="stat-card" onclick="quickFilter('archiveOverlay')"><div class="stat-icon indigo">📦</div><div><div class="stat-value">${archived}</div><div class="stat-label">已归档</div></div><div class="stat-arrow">→</div></div>
    </div>
    <div style="text-align:right;margin-bottom:12px;">
      <button class="btn btn-outline btn-sm" onclick="if(confirm('确定要重置为演示案例吗？当前数据将被清空。')){localStorage.clear();location.reload();}">🔄 重置演示数据</button>
    </div>
    ${hasKiss ? `
    <div class="kiss-board">
      ${kissItems.map(k => `
      <div class="kiss-column ${k.cls}">
        <div class="kiss-column-header" onclick="navigateToListWithFilter('kiss','${k.tag}')">
          <span>${k.icon} ${k.tag}</span>
          <span class="kiss-count">${k.tasks.length}</span>
        </div>
        <div class="kiss-column-body">
          ${k.tasks.length === 0
            ? '<div class="kiss-empty-hint">暂无</div>'
            : k.tasks.map(t => {
              const parent = t.parentId ? tasks.find(p => p.id === t.parentId) : null;
              const stIcon = t.status === 'done' ? '✅' : t.status === 'progress' ? '⏳' : t.status === 'blocked' ? '🚫' : t.status === 'cancel' ? '❌' : '⬜';
              return `<div class="kiss-item" onclick="editTask(${t.id})">
                <div class="kiss-item-title">${escapeHtml(t.title)}</div>
                <div class="kiss-item-meta">
                  <span>${stIcon}</span>
                  ${parent ? '<span>📎 ' + escapeHtml(parent.title).substring(0,15) + '</span>' : ''}
                  ${t.deadline ? '<span>📅 ' + t.deadline.substring(0,10) + '</span>' : ''}
                </div>
              </div>`;
            }).join('')
          }
        </div>
      </div>
      `).join('')}
    </div>
    ` : `
    <div class="insight-card" style="margin-bottom:16px;text-align:center;">
      <div style="font-size:14px;color:var(--gray-500);padding:16px;">
        💡 KISS 复盘区：在内容块的标题或描述中添加 <b>[KEEP]</b> / <b>[IMPROVE]</b> / <b>[START]</b> / <b>[STOP]</b> 即可在此展示
      </div>
    </div>
    `}
    <div id="quotes-panel-container"></div>
    <div class="dashboard-grid">
      <div>
        <div class="insight-card" style="margin-bottom:16px;">
          <div class="card-header"><span class="card-title">🧠 AI 洞察与建议</span></div>
          ${insights.map((i, idx) => `<div class="insight-item" onclick="navigateToListWithFilter('insight',${idx})"><span class="insight-icon">${i.icon}</span><span class="insight-text">${i.text}</span><span class="insight-arrow">→</span></div>`).join('')}
          ${insights.length === 0 ? '<div class="empty-state"><p>暂无特殊建议，项目状态良好 👍</p></div>' : ''}
        </div>
      </div>
      <div>
        <div class="insight-card" style="margin-bottom:16px;">
          <div class="card-header"><span class="card-title">⚡ 建议下一步</span></div>
          ${nextActions.map((t, i) => `
            <div class="insight-item" onclick="navigateToListWithFilter('title','${escapeHtml(t.title)}')">
              <span style="font-size:24px;font-weight:800;color:var(--gray-300);width:28px;">${i+1}</span>
              <div>
                <div style="font-weight:600;font-size:14px;">${t.title}</div>
                <div style="font-size:12px;color:var(--gray-500);">${t.reason}</div>
              </div>
              <span class="insight-arrow">→</span>
            </div>
          `).join('')}
          ${nextActions.length === 0 ? '<div class="empty-state"><p>所有任务已完成！🎉</p></div>' : ''}
        </div>
        <div class="insight-card">
          <div class="card-header"><span class="card-title">📈 进度概览</span></div>
          <div style="display:flex;justify-content:space-around;align-items:center;padding:10px 0;">
            <div onclick="navigateToListWithFilter('status','done')" style="cursor:pointer;">${renderMiniRing(total ? (done/total*100) : 0, '完成率')}</div>
            <div onclick="navigateToListWithFilter('status','progress')" style="cursor:pointer;">${renderMiniRing(total ? ((done+inProgress)/total*100) : 0, '覆盖率')}</div>
            <div onclick="navigateToListWithFilter('noDeadline')" style="cursor:pointer;">${renderMiniRing(total ? (countByType('task') ? tasks.filter(t=>t.type==='task').filter(t=>!t.deadline&&t.status!=='done').length/countByType('task')*100 : 0) : 0, '无截止日期任务', true)}</div>
          </div>
        </div>
      </div>
    </div>
  `;
  renderQuotesPanel();
}

// R3.38：任务列表视图已移除，仪表盘等所有「下钻筛选」入口统一改道到时间线表格视图。
// 可承接的筛选映射到时间线表格的 tl* 变量；暂不支持的（进行中/阻塞等状态、KISS、无截止、标签）
// 跳转时间线表格并 toast 提示，不报错、不白屏。函数名保留（仪表盘多处调用）。
function navigateToListWithFilter(type, value) {
  // 先重置时间线表格全部筛选，避免叠加
  tlDateFilter = null;
  tlTableTypeFilter = null;
  tlDoneFilter = false;
  tlEntityFilters = null;
  tlSearch = '';
  listActiveTags = null;
  listKissFilter = null;
  dateFilter = null;
  activeQuickFilter = 'timelineTable';   // 点亮侧边栏「时间线」按钮
  if (tlSearchInput) tlSearchInput.value = '';

  // 暂不支持的下钻：跳到时间线表格但给提示
  const unsupported = {
    'blocked': '「被阻塞」状态筛选暂未在时间线视图支持，后续版本补齐',
    'progress': '「进行中」状态筛选暂未在时间线视图支持，后续版本补齐',
    'todo': '「待办」状态筛选暂未在时间线视图支持，后续版本补齐',
    'preparing': '「准备中」状态筛选暂未在时间线视图支持，后续版本补齐',
    'cancel': '「已取消」状态筛选暂未在时间线视图支持，后续版本补齐',
  };
  let toastMsg = null;
  let focusSearch = false;

  if (type === 'type') {
    tlTableTypeFilter = value;
  } else if (type === 'status') {
    if (value === 'done') {
      tlDoneFilter = true;   // 已完成可承接（时间线表格有「✅ 已完成」开关）
    } else {
      toastMsg = unsupported[value] || ('该状态筛选暂未在时间线视图支持：' + value);
    }
  } else if (type === 'overdue') {
    tlDateFilter = 'overdue';
  } else if (type === 'noDeadline') {
    toastMsg = '「无截止日期」筛选暂未在时间线视图支持，后续版本补齐';
  } else if (type === 'tag') {
    toastMsg = '标签下钻暂未在时间线视图支持，后续版本补齐';
  } else if (type === 'kiss') {
    toastMsg = 'KISS 复盘下钻暂未在时间线视图支持，后续版本补齐';
  } else if (type === 'title') {
    tlSearch = value;
    if (tlSearchInput) tlSearchInput.value = value;
    focusSearch = true;
  } else if (type === 'todayTodo') {
    tlDateFilter = 'todayTodo';
  } else if (type === 'weekDeadline') {
    tlDateFilter = 'weekDue';
  } else if (type === 'monthDeadline') {
    tlDateFilter = 'monthDue';
  } else if (type === 'insight') {
    const idx = parseInt(value);
    const insights = generateInsights();
    if (insights[idx]) {
      const insight = insights[idx];
      if (insight.text.includes('逾期')) { navigateToListWithFilter('overdue'); return; }
      else if (insight.text.includes('阻塞')) { navigateToListWithFilter('status', 'blocked'); return; }
      else if (insight.text.includes('没有截止日期')) { navigateToListWithFilter('noDeadline'); return; }
      else {
        const match = insight.text.match(/「([^」]+)」/);
        if (match) { navigateToListWithFilter('title', match[1]); return; }
      }
    }
    // 无可解析项：直接进时间线表格
  }

  activateTimelineTable(true);

  if (toastMsg) showToast(toastMsg, 'warn');
  if (focusSearch) {
    setTimeout(() => {
      const si = document.getElementById('tl-search-input');
      if (si) { si.focus(); si.select(); }
    }, 120);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderMiniRing(pct, label, isWarning = false) {
  const color = isWarning ? '#F59E0B' : '#4F46E5';
  const r = 28; const circ = 2 * Math.PI * r;
  const dash = circ * pct / 100;
  return `<div style="text-align:center;">
    <svg width="70" height="70"><circle cx="35" cy="35" r="${r}" fill="none" stroke="var(--gray-200)" stroke-width="6"/><circle cx="35" cy="35" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-dasharray="${dash} ${circ}" stroke-linecap="round" transform="rotate(-90 35 35)" style="transition: stroke-dasharray 0.6s;"/><text x="35" y="39" text-anchor="middle" font-size="16" font-weight="700" fill="${color}">${Math.round(pct)}%</text></svg>
    <div style="font-size:11px;color:var(--gray-500);">${label}</div>
  </div>`;
}

function generateInsights() {
  const insights = [];
  const overdue = tasks.filter(t => t.deadline && new Date(t.deadline) < new Date() && t.status !== 'done' && t.status !== 'cancel' && !isArchivedOf(t));
  const noDeadline = tasks.filter(t => !t.deadline && t.status !== 'done' && t.type === 'task');
  const blocked = tasks.filter(t => t.status === 'blocked');
  const noDeps = tasks.filter(t => t.deps && t.deps.length === 0 && t.status !== 'done');

  if (overdue.length > 0) {
    insights.push({ icon: '🔴', text: `<strong>${overdue.length} 个条目已逾期</strong>：${overdue.map(t=>t.title).slice(0,5).join('、')}${overdue.length>5?' 等':''}。建议立即评估是否需要调整截止日期或增加资源。` });
  }
  if (blocked.length > 0) {
    const blockedWithObj = blocked.map(t => {
      let obj = t; while (obj.parentId) { const p = tasks.find(x => x.id === obj.parentId); if (p) obj = p; else break; }
      const objName = obj.title.length > 10 ? obj.title.slice(0, 9) + '…' : obj.title;
      return `${t.title} (${objName})`;
    });
    insights.push({ icon: '🚫', text: `<strong>${blocked.length} 个条目被阻塞</strong>：${blockedWithObj.join('、')}。请检查依赖的前置任务状态。` });
  }
  if (noDeadline.length > 0) {
    insights.push({ icon: '📅', text: `<strong>${noDeadline.length} 个 Task 没有截止日期</strong>。没有时间约束的任务容易无限拖延，建议为它们设定明确的完成时间。` });
  }

  // Check Object-level health
  const objects = tasks.filter(t => t.type === 'object');
  objects.forEach(obj => {
    const children = tasks.filter(t => t.parentId === obj.id);
    const blockedChildren = children.filter(t => t.status === 'blocked');
    if (blockedChildren.length > 0) {
      insights.push({ icon: '⚠️', text: `<strong>目标「${obj.title}」</strong>下有 ${blockedChildren.length} 个阻塞项，可能影响整体进度。` });
    }
  });

  return insights;
}

function getNextActions(n) {
  const active = tasks.filter(t => t.type === 'task' && t.status !== 'done' && t.status !== 'blocked')
    .sort((a, b) => {
      const pOrder = PRIORITY_ORDER;
      const pDiff = pOrder[a.priority] - pOrder[b.priority];
      if (pDiff !== 0) return pDiff;
      if (a.deadline && b.deadline) return new Date(a.deadline) - new Date(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });
  return active.slice(0, n).map(t => ({
    title: t.title,
    reason: t.deadline ? `截止: ${t.deadline}` : (t.priority === '重要紧急' ? '紧急且重要' : '无明确截止日期')
  }));
}

// ---- Task List (Tree) ----
let treeCollapsed = {}; // 折叠状态 { id: true/false }

function renderList() {
  const el = document.getElementById('view-list');
  // R3.38：任务列表视图（view-list 面板）已移除。renderList 函数体保留为死代码
  // （clearAllFilters/列筛选等共用逻辑仍引用），但任何意外调用都安全转时间线表格，杜绝 null 报错。
  if (!el) { renderTimelineTable(); return; }
  if (tasks.length === 0) {
    el.innerHTML = `<div class="card"><div class="empty-state"><div class="empty-icon">📋</div><h3>还没有任务</h3><p>点击顶部「+ 添加任务」开始吧！</p></div></div>`;
    return;
  }

  const sortType = listSortType || document.getElementById('list-sort-filter')?.value || 'tree';
  const isFlatSort = sortType !== 'tree';
  
  const rootIds = new Set(tasks.filter(t => !t.parentId).map(t => t.id));
  const allChildIds = new Set();
  tasks.forEach(t => { if (t.children) t.children.forEach(cid => allChildIds.add(cid)); });
  const orphans = tasks.filter(t => t.parentId && !allChildIds.has(t.id));
  
  let rows = '';
  const levelIndent = { object: 0, kr: 24, target: 44, task: 60, schedule: 64, record: 64, idea: 64 };
  const levelBg = { object: 'object-row', kr: 'kr-row', target: 'target-row', task: 'task-row' };
  const comparator = getSortComparator(sortType);

  function buildRow(t, depth, parentPath, ancestorIds, isAncestorCollapsed) {
    if (isArchivedOf(t) && !showArchived && !archiveOnly) {
      return '';
    }
    const hasChildren = t.children && t.children.length > 0;
    const isCollapsed = treeCollapsed[t.id];
    const indent = levelIndent[t.type] || 0;
    const indentPx = isFlatSort ? 12 : indent + depth * 4;
    const path = parentPath ? `${parentPath} → ${t.title}` : t.title;
    const typeLabel = TYPE_LABELS[t.type];
    const typeColor = TYPE_COLORS[t.type];
    const myAncestors = ancestorIds ? [...ancestorIds] : [];
    const shouldHide = !isFlatSort && isAncestorCollapsed && depth > 0;

    let html = `<tr class="${levelBg[t.type]}${highlightedIds.has(t.id)?' row-highlighted':''}" data-task-id="${t.id}" data-id="${t.id}" data-status="${t.status}" data-type="${t.type}" data-path="${path}" data-ancestors="${myAncestors.join(',')}" data-task='${JSON.stringify(t).replace(/'/g, "&#39;")}'${shouldHide ? ' style="display:none;"' : ''}>
      <td style="padding-left:${indentPx}px;position:relative;min-width:200px;">
        <div class="row-actions" style="left:${indentPx}px;">
          <button class="row-action-btn edit-btn" onclick="editTask(${t.id})">编辑属性</button>
          ${t.parentId ? '<button class="row-action-btn parent-jump" onclick="editTask(' + t.parentId + ')" title="跳转到上级">↑ 上级</button>' : ''}
          ${(() => { const hasChain = (t.deps && t.deps.length > 0) || (t.next && t.next.length > 0); return `<button class="row-action-btn add-btn chain-add ${hasChain ? 'chain-has' : 'chain-empty'}" onclick="showTaskChain(${t.id})">📋 任务链</button>`; })()}
          ${(() => {
            const childMap = { object:'kr', kr:'target', target:'task' };
            const childType = childMap[t.type];
            let btns = '';
            if (childType) {
              const addClass = { kr:'kr-add', target:'target-add', task:'task-add' }[childType] || '';
              btns += `<button class="row-action-btn add-btn ${addClass}" onclick="addChildTask(${t.id},'${childType}')">+ 下级内容</button>`;
            }
            btns += `<button class="row-action-btn add-btn next-add" onclick="addNextTask(${t.id})">+ 后置内容</button>`;
            return btns;
          })()}
        </div>
        ${!isFlatSort && hasChildren ? `<span class="tree-row-toggle ${isCollapsed?'':'expanded'}" onclick="event.stopPropagation();toggleTreeNode(${t.id})">▶</span>` : '<span style="display:inline-block;width:16px;"></span>'}
        <span class="tree-level-tag" style="background:${typeColor}15;color:${typeColor};border:1px solid ${typeColor}40;">${typeLabel}</span>
        <span style="font-weight:${t.type==='object'?700:t.type==='kr'?600:500};">${t.title}</span>
        ${t._syncStatus==='local-only'&&t.type!=='object' ? '<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;font-size:10px;background:#FEF3C7;color:#D97706;font-weight:600;" title="此任务仅在本地存在，飞书上没有">📌 仅本地</span>' : ''}
        ${t._syncStatus === 'new-feishu' ? '<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;font-size:10px;background:#DBEAFE;color:#2563EB;font-weight:600;" title="此任务是从飞书新拉取的">🆕 新同步</span>' : ''}
      </td>
      <td><span style="font-size:12px;color:var(--gray-600);">${t.assignee || '<span style="color:var(--gray-400);">-</span>'}</span></td>
      <td style="text-align:center;">${t.isMilestone===true||t.isMilestone==='true' ? '<span title="里程碑" style="font-size:14px;">🔷</span>' : '<span style="color:var(--gray-300);">-</span>'}</td>
      <td><span class="priority-tag priority-${t.priority}" style="cursor:pointer;" onclick="cyclePriority(${t.id})" title="点击切换优先级">${t.priority}</span></td>
      <td style="text-align:center;"><input type="checkbox" ${isArchivedOf(t) ? 'checked' : ''} onchange="toggleArchived(${t.id})" style="width:18px;height:18px;cursor:pointer;" title="${isArchivedOf(t) ? '点击取消归档' : '点击归档'}"></td>
      <td><span class="status-tag status-${t.status}" style="cursor:pointer;" onclick="cycleTaskStatus(${t.id})" title="点击切换状态">${statusMap[t.status]}</span></td>
      <td style="font-size:12px;">${t.deadline ? (() => {
          if (t.status === 'done' || t.status === 'cancel' || isArchivedOf(t)) {
            return `<span style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:var(--gray-500);" onclick="editDate(${t.id}, 'deadline')">${t.deadline}</span>`;
          }
          const deadlineDate = new Date(t.deadline);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const overdueDays = Math.floor((today - deadlineDate) / (1000 * 60 * 60 * 24));
          if (overdueDays > 3) {
            return `<span style="background:#FEF2F2;color:#DC2626;padding:2px 6px;border-radius:4px;font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" onclick="editDate(${t.id}, 'deadline')">⚠️ ${t.deadline} (逾期${overdueDays}天)</span>`;
          } else if (overdueDays > 0) {
            return `<span style="background:#FFFBEB;color:#D97706;padding:2px 6px;border-radius:4px;font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" onclick="editDate(${t.id}, 'deadline')">${t.deadline} (逾期${overdueDays}天)</span>`;
          } else if (overdueDays === 0) {
            return `<span style="background:#FEF9C3;color:#CA8A04;padding:2px 6px;border-radius:4px;font-weight:600;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" onclick="editDate(${t.id}, 'deadline')">${t.deadline}</span>`;
          }
          return `<span style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:var(--primary);" onclick="editDate(${t.id}, 'deadline')">${t.deadline}</span>`;
        })() : '<span style="color:var(--gray-400);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" onclick="editDate(${t.id}, \'deadline\')">-</span>'}</td>
      <td style="font-size:11px;color:var(--gray-500);font-family:monospace;white-space:nowrap;" title="${t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : ''}">${t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '<span style="color:var(--gray-300);">-</span>'}</td>
      <td style="font-size:12px;">${t.startDate ? `<span style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted;color:var(--primary);" onclick="editDate(${t.id}, 'startDate')">${t.startDate}</span>` : '<span style="color:var(--gray-400);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;" onclick="editDate(${t.id}, \'startDate\')">-</span>'}</td>
      <td>${t.status === 'cancel' ? '<span style="color:var(--gray-400);font-size:12px;">已取消</span>' : t.status === 'blocked' ? '<span style="font-size:16px;color:#DC2626;" title="阻塞">⛔</span>' : `<div class="progress-ring-container ${t.status==='done'?'done-state':''}" style="display:flex;align-items:center;gap:6px;${t.status==='done'||t.status==='blocked'?'cursor:default;':'cursor:pointer;'}" onclick="cycleProgress(${t.id})" title="${t.status==='done'||t.status==='blocked'?'已锁定':'点击增加25%'}">
          <svg class="progress-ring" width="32" height="32" viewBox="0 0 32 32">
            <circle class="progress-ring-bg" cx="16" cy="16" r="13" fill="none" stroke="#E5E7EB" stroke-width="3"/>
            <circle class="progress-ring-fill" cx="16" cy="16" r="13" fill="none" stroke="${getProgressColor(t.progress||0, t.status)}" stroke-width="${t.status==='done'?'4':'3'}" stroke-linecap="round"
              stroke-dasharray="${t.status==='done'?'81.68 81.68':(t.progress||0)/100 * 81.68 + ' 81.68'}"
              transform="rotate(-90 16 16)"/>
            ${t.status === 'done' ? '<text x="16" y="20" text-anchor="middle" font-size="14" fill="#059669">✓</text>' : ''}
          </svg>
          <span class="progress-text" style="font-size:12px;font-weight:600;color:${getProgressColor(t.progress||0, t.status)}">${t.progress||0}%</span>
        </div>`}</td>
      <td style="font-size:11px;color:var(--gray-500);max-width:160px;line-height:1.6;" title="${(t.files||[]).map(fileDisplayName).join(', ')}">${(t.files && t.files.length > 0) ? t.files.map((f, fi) => {
        const _fid = (f && f.fileId) ? f.fileId : '';
        const _fpath = (f && f.path) ? String(f.path).replace(/"/g, '&quot;') : '';
        const _furl = (f && f.url) ? String(f.url).replace(/"/g, '&quot;') : '';
        const _web = !!_furl;
        const _fname = String(fileDisplayName(f)).replace(/"/g, '&quot;');
        const _linked = (_fid || _fpath || _web) ? ' linked' : '';
        const _label = fileDisplayName(f);
        const _short = _label.length > 18 ? _label.slice(0,16) + '…' : _label;
        return `<div class="list-file-chip${_linked}" data-task-id="${t.id}" data-file-idx="${fi}" data-file-id="${_fid}" data-file-path="${_fpath}" data-file-url="${_furl}" data-file-name="${_fname}" onmouseenter="showFileHoverCard(event,this)" onmouseleave="scheduleHideFileHoverCard()" onclick="handleListFileChipClick(event,this)" style="display:block;background:var(--gray-100);padding:2px 6px;border-radius:3px;margin-bottom:2px;font-size:10px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_label}">${_web ? '🔗' : '📄'} ${_short}</div>`;
      }).join('') : '<span style="color:var(--gray-400);">-</span>'}</td>
      <td style="font-size:11px;color:var(--gray-500);font-family:monospace;" title="时间戳 ${t.timestamp}">${t.timestamp || '<span style="color:var(--gray-400);">-</span>'}</td>
      <td style="font-size:12px;color:var(--gray-500);">
        ${t.deps && t.deps.length > 0 ? t.deps.map(did => {
          const depTask = tasks.find(x => x.id === did);
          const name = depTask ? (depTask.title.length > 6 ? depTask.title.slice(0,5)+'…' : depTask.title) : '#'+did;
          return depTask ? `<span title="点击跳转到：${depTask.title}" class="priority-tag priority-${depTask.priority} jump-link" style="font-size:10px;" onclick="scrollToTask(${did})">←${name}</span>` : '';
        }).join(' ') : '-'}
      </td>
      <td style="font-size:12px;color:var(--gray-500);">
        ${t.next && t.next.length > 0 ? t.next.map(nid => {
          const nextTask = tasks.find(x => x.id === nid);
          const name = nextTask ? (nextTask.title.length > 6 ? nextTask.title.slice(0,5)+'…' : nextTask.title) : '#'+nid;
          return nextTask ? `<span title="点击跳转到：${nextTask.title}" class="priority-tag priority-${nextTask.priority} jump-link" style="font-size:10px;background:#10B98115;color:#059669;border-color:#10B98140;" onclick="scrollToTask(${nid})">→${name}</span>` : '';
        }).join(' ') : '-'}
      </td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editTask(${t.id})" style="margin-right:4px;" title="编辑">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTask(${t.id})" title="删除">🗑</button>
      </td>
    </tr>`;

    if (!isFlatSort && hasChildren) {
      const childItems = t.children.map(cid => tasks.find(x => x.id === cid)).filter(Boolean)
        .sort(comparator);
      childItems.forEach(child => { html += buildRow(child, depth + 1, path, [...myAncestors, t.id], isCollapsed || isAncestorCollapsed); });
    }
    return html;
  }

  if (isFlatSort) {
    const allTasks = [...tasks].sort(comparator);
    allTasks.forEach(t => { rows += buildRow(t, 0, '', [t.id], false); });
  } else {
    const roots = [...tasks.filter(t => !t.parentId), ...orphans].sort(comparator);
    roots.forEach(r => { rows += buildRow(r, 0, '', null); });
  }

  el.innerHTML = `
    <div class="card" style="overflow-x:auto;">
      <div class="tag-filter-bar">
        <span style="font-size:12px;color:var(--gray-400);white-space:nowrap;">快速筛选：</span>
        <button class="tag-btn reset-btn" onclick="clearAllFilters()" title="清除所有筛选条件">🗑 清除筛选</button>
        ${['object','kr','target','task','record','schedule','idea'].map(type => {
          const labels = {object:'🎯 目标', kr:'📊 KR', target:'🎯 子目标', task:'📋 任务', record:'📝 记录', schedule:'📅 日程', idea:'💡 想法'};
          if (hiddenFilters['tag:' + type]) return '';
          const isActive = listActiveTags === type;
          return `<button class="tag-btn ${isActive?'active':''} type-${type}" data-tag="${type}" onclick="toggleTagFilter('${type}')">${labels[type]}</button>`;
        }).join('')}
        ${renderEntityFilterButtons(listEntityFilters, 'toggleEntityFilter', true)}
        ${(() => {
          var hiddenCount = Object.keys(hiddenFilters).length;
          return hiddenCount > 0 ? '<button class="tag-btn" style="font-size:10px;border-style:dashed;" onclick="showHiddenFiltersMenu(this)" title="点击查看隐藏的筛选，可逐个恢复">+' + hiddenCount + ' 已隐藏</button>' : '';
        })()}
      </div>
      <div class="card-header">
        <span class="card-title">📋 任务层级 (${tasks.length})</span>
        ${(() => {
          if (!dateFilter) return '';
          const filterNames = { todayTodo: '今日待办', weekDeadline: '本周到期', monthDeadline: '本月到期', overdue: '已逾期' };
          return `<span class="date-filter-badge" onclick="dateFilter=null;activeQuickFilter=null;typeFilter=[];statusFilter=[];updateQuickActionStates();renderList();showToast('已清除日期筛选','success')" style="background:#FFE4E6;color:#DC2626;padding:4px 12px;border-radius:12px;font-size:12px;margin-right:8px;cursor:pointer;border:1px solid #FECACA;">📅 ${filterNames[dateFilter]} ✕</span>`;
        })()}
        <button class="btn btn-primary btn-sm" onclick="createNewContent()" style="margin-right:8px;">➕ 创建内容</button>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-outline btn-sm" onclick="treeCollapsed={};renderList();" title="展开全部">📂 展开</button>
          <button class="btn btn-outline btn-sm" onclick="collapseAll();" title="折叠全部">📁 折叠</button>
          <input type="text" id="list-filter" placeholder="🔍 搜索..." value="${(searchQuery || '').replace(/"/g, '&quot;')}" style="padding:6px 12px;border:1px solid var(--gray-300);border-radius:8px;font-size:13px;outline:none;width:140px;">
          <div class="multi-select" id="status-multi-select" onclick="toggleMultiSelect('status')">
            <div class="multi-select-btn">
              <span>${statusFilter.length === 0 ? '全部状态' : statusFilter.length + ' 项'}</span>
              <span class="multi-select-arrow">▼</span>
            </div>
            <div class="multi-select-dropdown" id="status-dropdown">
              <div class="multi-select-all" onclick="toggleSelectAll('status', event)">
                <input type="checkbox" ${statusFilter.length === 6 ? 'checked' : ''}>
                <span>全选</span>
              </div>
              <div class="multi-select-options">
                ${['todo', 'preparing', 'progress', 'done', 'blocked', 'cancel'].map(v => `
                  <label class="multi-select-option">
                    <input type="checkbox" value="${v}" ${statusFilter.includes(v) ? 'checked' : ''} onclick="toggleMultiOption('status', '${v}', event)">
                    <span>${statusMap[v]}</span>
                  </label>
                `).join('')}
              </div>
            </div>
          </div>
          <div class="multi-select" id="type-multi-select" onclick="toggleMultiSelect('type')">
            <div class="multi-select-btn">
              <span>${typeFilter.length === 0 ? '全部层级' : typeFilter.length + ' 项'}</span>
              <span class="multi-select-arrow">▼</span>
            </div>
            <div class="multi-select-dropdown" id="type-dropdown">
              <div class="multi-select-all" onclick="toggleSelectAll('type', event)">
                <input type="checkbox" ${typeFilter.length === 4 ? 'checked' : ''}>
                <span>全选</span>
              </div>
              <div class="multi-select-options">
                ${[['object', '目标'], ['kr', '关键结果'], ['target', '子目标'], ['task', '任务']].map(([v, l]) => `
                  <label class="multi-select-option">
                    <input type="checkbox" value="${v}" ${typeFilter.includes(v) ? 'checked' : ''} onclick="toggleMultiOption('type', '${v}', event)">
                    <span>${l}</span>
                  </label>
                `).join('')}
              </div>
            </div>
          </div>
          <select id="list-sort-filter" style="padding:6px;border:1px solid var(--gray-300);border-radius:8px;font-size:13px;outline:none;">
            <option value="tree" ${listSortType === 'tree' ? 'selected' : ''}>🌳 层级顺序</option>
            <option value="deadline-asc" ${listSortType === 'deadline-asc' ? 'selected' : ''}>📅 截止日期（近→远）</option>
            <option value="deadline-desc" ${listSortType === 'deadline-desc' ? 'selected' : ''}>📅 截止日期（远→近）</option>
            <option value="timestamp-desc" ${listSortType === 'timestamp-desc' ? 'selected' : ''}>🕐 时间戳（新→旧）</option>
            <option value="timestamp-asc" ${listSortType === 'timestamp-asc' ? 'selected' : ''}>🕐 时间戳（旧→新）</option>
            <option value="priority" ${listSortType === 'priority' ? 'selected' : ''}>🔥 优先级</option>
            <option value="progress-asc" ${listSortType === 'progress-asc' ? 'selected' : ''}>📈 进度（低→高）</option>
            <option value="progress-desc" ${listSortType === 'progress-desc' ? 'selected' : ''}>📈 进度（高→低）</option>
            <option value="start-asc" ${listSortType === 'start-asc' ? 'selected' : ''}>📅 开始时间（早→晚）</option>
            <option value="completed-desc" ${listSortType === 'completed-desc' ? 'selected' : ''}>✅ 完成时间（新→旧）</option>
            <option value="completed-asc" ${listSortType === 'completed-asc' ? 'selected' : ''}>✅ 完成时间（旧→新）</option>
          </select>
        </div>
      </div>
      <table class="tree-table">
        <thead><tr>
          <th>名称</th>
          <th class="filter-th" data-field="assignee">负责人 ▼</th>
          <th class="filter-th" data-field="isMilestone">里程碑 ▼</th>
          <th class="filter-th" data-field="priority">优先级 ▼</th>
          <th class="filter-th" data-field="isArchived">归档 ▼</th>
          <th class="filter-th" data-field="status">状态 ▼</th>
          <th class="filter-th" data-field="deadline">截止日期 ▼</th>
          <th>完成时间</th>
          <th class="filter-th" data-field="startDate">开始时间 ▼</th>
          <th class="filter-th" data-field="progress">进度 ▼</th>
          <th class="filter-th" data-field="files">相关文件 ▼</th>
          <th>时间戳</th>
          <th>依赖</th>
          <th>后置</th>
          <th>操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <!-- 底部占位，确保最后一行可以滚动到可见区域 -->
      <div style="height:180px;"></div>
    </div>
  `;

  document.getElementById('list-filter')?.addEventListener('input', function() {
    searchQuery = this.value;
    if (window._listFilterTimer) clearTimeout(window._listFilterTimer);
    window._listFilterTimer = setTimeout(filterList, 200);
  });
  document.getElementById('list-sort-filter')?.addEventListener('change', function() {
    listSortType = this.value;
    renderList();
  });
  updateFilterThStyle(); // 更新列筛选表头状态
  filterList(); // Apply active tag filters on initial render
}

function toggleTreeNode(id) {
  treeCollapsed[id] = !treeCollapsed[id];
  renderList();
}
// 检查实体及其后代是否有高亮
function isEntityHighlighted(eid) {
  var visited = new Set(); var stack = [eid];
  while (stack.length > 0) {
    var id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    if (highlightedIds.has(id)) return true;
    var children = tasks.filter(function(t) { return t.parentId === id; });
    for (var i = 0; i < children.length; i++) stack.push(children[i].id);
  }
  return false;
}

function toggleTagFilter(tag) {
  listActiveTags = (listActiveTags === tag) ? null : tag;
  renderList();
}
function toggleEntityFilter(eid) {
  listEntityFilters = (listEntityFilters === eid) ? null : eid;
  renderList();
}

function toggleMultiSelect(type) {
  const container = document.getElementById(type + '-multi-select');
  const isOpen = container.classList.toggle('open');
  
  if (isOpen) {
    setTimeout(() => {
      document.addEventListener('click', closeMultiSelectHandler);
    }, 0);
  } else {
    document.removeEventListener('click', closeMultiSelectHandler);
  }
}

function closeMultiSelectHandler(e) {
  const statusSelect = document.getElementById('status-multi-select');
  const typeSelect = document.getElementById('type-multi-select');
  if (!statusSelect.contains(e.target) && !typeSelect.contains(e.target)) {
    statusSelect.classList.remove('open');
    typeSelect.classList.remove('open');
    document.removeEventListener('click', closeMultiSelectHandler);
  }
}

function toggleMultiOption(type, value, event) {
  event.stopPropagation();
  const filter = type === 'status' ? statusFilter : typeFilter;
  const index = filter.indexOf(value);
  if (index > -1) {
    filter.splice(index, 1);
  } else {
    filter.push(value);
  }
  if (dateFilter || activeQuickFilter) {
    dateFilter = null;
    activeQuickFilter = null;
    updateQuickActionStates();
    showToast('已清除日期筛选，应用新的筛选', 'info');
  }
  const openType = document.querySelector('.multi-select.open')?.id?.replace('-multi-select', '');
  renderList();
  if (openType) {
    const el = document.getElementById(openType + '-multi-select');
    if (el) {
      el.classList.add('open');
      setTimeout(() => {
        document.addEventListener('click', closeMultiSelectHandler);
      }, 0);
    }
  }
}

function toggleSelectAll(type, event) {
  event.stopPropagation();
  const filter = type === 'status' ? statusFilter : typeFilter;
  const allOptions = type === 'status' 
    ? ['todo', 'preparing', 'progress', 'done', 'blocked', 'cancel']
    : ['object', 'kr', 'target', 'task'];
  
  if (filter.length === allOptions.length) {
    filter.length = 0;
  } else {
    filter.length = 0;
    filter.push(...allOptions);
  }
  if (dateFilter || activeQuickFilter) {
    dateFilter = null;
    activeQuickFilter = null;
    updateQuickActionStates();
    showToast('已清除日期筛选，应用新的筛选', 'info');
  }
  const openType = document.querySelector('.multi-select.open')?.id?.replace('-multi-select', '');
  renderList();
  if (openType) {
    const el = document.getElementById(openType + '-multi-select');
    if (el) {
      el.classList.add('open');
      setTimeout(() => {
        document.addEventListener('click', closeMultiSelectHandler);
      }, 0);
    }
  }
}

function clearAllFilters(silent) {
  listActiveTags = null;
  listKissFilter = null;
  listEntityFilters = null;
  hiddenFilters = {};
  searchQuery = '';
  const _lf = document.getElementById('list-filter');
  if (_lf) _lf.value = '';
  listColFilters = {};
  dateFilter = null;
  activeQuickFilter = null;
  typeFilter = [];
  statusFilter = [];
  // 注意：showArchived 和 archiveOnly 是独立 toggle，不在这里清除
  //       它们由各自的归档按钮控制，不受互斥组切换影响
  updateQuickActionStates();
  // silent=true：由调用方（quickFilter）稍后自行 render + 设置新筛选，避免重复渲染和多余 toast
  if (silent) return;
  renderList();
  showToast('已清除所有筛选条件', 'success');
}

// ── 列筛选 ──
let _activeColFilter = null;
function showColFilterDropdown(th, field) {
  // 关闭已存在的
  const existing = document.querySelector('.col-filter-dropdown');
  if (existing) existing.remove();
  if (_activeColFilter === field) { _activeColFilter = null; return; }
  _activeColFilter = field;

  // 收集该列的唯一值
  const values = new Set();
  tasks.forEach(t => {
    let val = '';
    switch (field) {
      case 'assignee': val = t.assignee || '(空)'; break;
      case 'isMilestone': val = t.isMilestone === true || t.isMilestone === 'true' ? '是' : '否'; break;
      case 'isArchived': val = isArchivedOf(t) ? '是' : '否'; break;
      case 'priority': val = t.priority || '(空)'; break;
      case 'status': val = statusMap[t.status] || t.status; break;
      case 'deadline': val = t.deadline || '(空)'; break;
      case 'startDate': val = t.startDate || '(空)'; break;
      case 'progress': val = (t.progress || 0) + '%'; break;
      case 'files': val = (t.files && t.files.length > 0) ? '有附件' : '(无)'; break;
    }
    values.add(val);
  });
  const sortedValues = [...values].sort();

  // 创建下拉
  const dropdown = document.createElement('div');
  dropdown.className = 'col-filter-dropdown';

  // 搜索框
  const search = document.createElement('input');
  search.className = 'col-filter-search';
  search.placeholder = '搜索...';
  search.oninput = () => renderOptions(search.value);
  dropdown.appendChild(search);

  const optionsContainer = document.createElement('div');

  function renderOptions(filter) {
    optionsContainer.innerHTML = '';
    sortedValues.filter(v => v.toLowerCase().includes(filter.toLowerCase())).forEach(val => {
      const opt = document.createElement('div');
      opt.className = 'col-filter-option' + (listColFilters[field] === val ? ' selected' : '');
      opt.innerHTML = `<input type="radio" name="col_${field}" ${listColFilters[field] === val ? 'checked' : ''}> ${val}`;
      opt.onclick = () => {
        listColFilters[field] = listColFilters[field] === val ? null : val;
        _activeColFilter = null;
        dropdown.remove();
        updateFilterThStyle();
        filterList();
      };
      optionsContainer.appendChild(opt);
    });
  }
  renderOptions('');
  dropdown.appendChild(optionsContainer);

  // 先添加到 th 以获取高度
  th.appendChild(dropdown);
  const dropdownHeight = dropdown.offsetHeight;
  const thRect = th.getBoundingClientRect();
  const windowHeight = window.innerHeight;

  // 智能判断弹出方向：如果下方空间不足，则向上弹出
  if (thRect.bottom + dropdownHeight + 8 > windowHeight) {
    dropdown.style.top = 'auto';
    dropdown.style.bottom = '100%';
  }

  // 点击外部关闭
  const closeHandler = (e) => {
    if (!th.contains(e.target)) {
      dropdown.remove();
      _activeColFilter = null;
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function updateFilterThStyle() {
  document.querySelectorAll('.filter-th').forEach(th => {
    const field = th.dataset.field;
    th.classList.toggle('active', !!listColFilters[field]);
  });
}

// 点击表头的筛选器
document.addEventListener('click', (e) => {
  const th = e.target.closest('.filter-th');
  if (th) {
    e.stopPropagation();
    showColFilterDropdown(th, th.dataset.field);
  }
});

// ── 右键菜单 & 高亮 ──
var highlightedIds = new Set();
var hiddenFilters = {};
try {
  var savedHL = localStorage.getItem('ai-task-lens-highlighted');
  if (savedHL) highlightedIds = new Set(JSON.parse(savedHL));
  var savedHF = localStorage.getItem('ai-task-lens-hidden-filters');
  if (savedHF) hiddenFilters = JSON.parse(savedHF);
} catch(e) {}

function saveHighlights() { localStorage.setItem('ai-task-lens-highlighted', JSON.stringify([...highlightedIds])); }
function saveHiddenFilters() { localStorage.setItem('ai-task-lens-hidden-filters', JSON.stringify(hiddenFilters)); }

// 实体按钮自定义底色：{ [entityId]: 主色hex }，仅界面偏好，独立持久化（不碰 tasks/CSV/飞书）
var entityColors = {};
try {
  var _savedEC = localStorage.getItem('ai-task-lens-entity-colors');
  if (_savedEC) entityColors = JSON.parse(_savedEC) || {};
} catch(e) { entityColors = {}; }
function saveEntityColors() { try { localStorage.setItem('ai-task-lens-entity-colors', JSON.stringify(entityColors)); } catch(e) {} }
function setEntityColor(id, hex) { entityColors[id] = hex; saveEntityColors(); }
function clearEntityColor(id) { delete entityColors[id]; saveEntityColors(); }

// 实体自定义底色：预设色板（12 色，Tailwind 600 级，浅底深字对比度均达标）
var ENTITY_COLOR_PRESETS = ['#7C3AED', '#4F46E5', '#2563EB', '#0891B2', '#0D9488', '#059669', '#65A30D', '#CA8A04', '#D97706', '#EA580C', '#DC2626', '#DB2777'];

function hexToRgb(hex) {
  hex = (hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(function(c) { return c + c; }).join('');
  var n = parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
// ratio: 0 = 全 hexA 色, 1 = 全 hexB 色
function mixHex(hexA, hexB, ratio) {
  var a = hexToRgb(hexA), b = hexToRgb(hexB);
  var m = function(ch) { return Math.round(a[ch] + (b[ch] - a[ch]) * ratio); };
  return '#' + [m('r'), m('g'), m('b')].map(function(v) { var s = v.toString(16); return s.length < 2 ? '0' + s : s; }).join('');
}
// 由主色派生 浅底 / 中边框 / 深字（文字加深到 mix(hex,黑,0.4)，12 预设色对比度均 ≥ 4.5 AA）
function entityColorVars(hex) {
  return { bg: mixHex(hex, '#FFFFFF', 0.88), border: mixHex(hex, '#FFFFFF', 0.5), text: mixHex(hex, '#000000', 0.4) };
}
// 门控：只在普通未选中态输出内联色；active/ctx/highlighted/done/cancelled 一律返回空串
// active/ctx 的 CSS 不带 !important，内联会盖过它，故这些态必须不输出；HL/done/cancel 自带 !important 是双保险
function entityBtnStyle(id, isActive, isCtx, isHL, st) {
  if (isActive || isCtx || isHL || st) return '';
  var hex = entityColors[id];
  if (!hex) return '';
  var v = entityColorVars(hex);
  return 'background:' + v.bg + ';border-color:' + v.border + ';color:' + v.text + ';';
}

function showCtxMenu(x, y, items) {
  var menu = document.getElementById('ctx-menu');
  menu.innerHTML = items.map(function(it) {
    return '<button class="ctx-menu-item' + (it.cls ? ' ' + it.cls : '') + '" data-action="' + it.action + '">' + it.label + '</button>';
  }).join('');
  menu.style.display = 'block'; menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.onclick = function(e) {
    var btn = e.target.closest('.ctx-menu-item');
    if (btn) {
      var action = btn.dataset.action;
      var handler = items.find(function(it) { return it.action === action; });
      if (handler && handler.fn) handler.fn();
    }
    hideCtxMenu();
  };
}
function hideCtxMenu() { document.getElementById('ctx-menu').style.display = 'none'; }
document.addEventListener('click', function(e) { if (!e.target.closest('#ctx-menu')) hideCtxMenu(); });

// 显示隐藏筛选菜单
function showHiddenFiltersMenu(el) {
  var items = [];
  Object.keys(hiddenFilters).forEach(function(k) {
    var label = k;
    if (k.indexOf('entity:') === 0) {
      var eid2 = parseInt(k.split(':')[1]);
      var t2 = tasks.find(function(x) { return x.id === eid2; });
      label = t2 ? '🎯 ' + t2.title : k;
    } else {
      label = '🏷 ' + k.split(':')[1];
    }
    items.push({
      label: '🔄 ' + label, action: 'rst-' + k,
      fn: (function(key) { return function() { delete hiddenFilters[key]; saveHiddenFilters(); renderAll(); }; })(k)
    });
  });
  items.push({ label: '🗑 全部恢复', action: 'rst-all', fn: function() { hiddenFilters = {}; saveHiddenFilters(); renderAll(); } });
  var r = el.getBoundingClientRect();
  setTimeout(function() { showCtxMenu(r.left, r.bottom + 2, items); }, 50);
}

// 实体按钮右键：自定义底色色板（复用 #ctx-menu 容器，重填色板内容，z-index 沿用 10000）
function showEntityColorMenu(eid, x, y) {
  var menu = document.getElementById('ctx-menu');
  var cur = entityColors[eid] || '';
  var swatches = ENTITY_COLOR_PRESETS.map(function(hex) {
    var isCur = cur && hex.toLowerCase() === cur.toLowerCase();
    return '<button type="button" class="ctx-color-swatch' + (isCur ? ' cur' : '') + '" data-color="' + hex + '" style="background:' + hex + ';" title="' + hex + '"></button>';
  }).join('');
  menu.innerHTML =
    '<div class="ctx-color-title">🎨 选择该按钮底色</div>' +
    '<div class="ctx-color-grid">' + swatches + '</div>' +
    '<label class="ctx-color-custom"><input type="color" id="ctx-color-picker" value="' + (cur || '#7C3AED') + '">自定义颜色</label>' +
    '<button type="button" class="ctx-menu-item" data-action="ec-reset" style="width:100%;text-align:left;">↩️ 恢复默认底色</button>';
  // 视口边缘防溢出
  var mw = 248, mh = 320;
  var left = x, top = y;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  menu.style.display = 'block';
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  var applyColor = function(hex) { setEntityColor(eid, hex); showToast('底色已设置', 'success'); hideCtxMenu(); renderAll(); };
  menu.onclick = function(ev) {
    var sw = ev.target.closest('.ctx-color-swatch');
    if (sw) { applyColor(sw.dataset.color); return; }
    if (ev.target.closest('[data-action="ec-reset"]')) {
      clearEntityColor(eid); showToast('已恢复默认底色', 'success'); hideCtxMenu(); renderAll();
    }
  };
  var picker = document.getElementById('ctx-color-picker');
  if (picker) picker.addEventListener('change', function() { applyColor(picker.value); });
}

// 截断标题
function shortTitle(title, maxLen) {
  maxLen = maxLen || 20;
  if (!title) return '';
  return title.length > maxLen ? title.substring(0, maxLen) + '…' : title;
}

/**
 * 渲染快速筛选栏的 Object / KR 实体按钮（四个视图共用）
 *
 * KR 分两组（R2.6）：
 *   A「归属明确的 KR」—— 能沿 parentId 链回溯到某个 Object
 *      · 未选中任何 Object → 不显示
 *      · 选中 Object       → 只显示该 Object 名下的
 *      · 选中 KR           → 显示其所属 Object 下的全部（保持同级可切换）
 *   B「游离 KR」—— 回溯不到任何 Object（上级为空 / 上级已删除 / 上级非 Object）
 *      · 一律常驻显示，不受 Object 选中状态门控
 *      · 理由：它们本就没有 Object 归属，用 Object 去门控逻辑上不成立，
 *        否则这些 KR 在筛选栏永久失踪（R2.5 的回归 bug）
 *
 * @param {number|null} activeId  当前选中的实体 ID（该视图的 xxxEntityFilters）
 * @param {string} toggleFn       点击时调用的函数名，如 'toggleEntityFilter'
 * @param {boolean} useHidden     是否应用 hiddenFilters（仅列表视图为 true）
 */
/**
 * 实体按钮的状态修饰 class（R2.7）
 *   已取消 → 灰色 + 删除线（还在，但已作废）
 *   已完成 → 绿色（收尾了，但仍可筛选查看）
 *   其余    → 无修饰，走本体配色
 * 已归档的实体不走这里，直接在上游被过滤掉。
 */
function entityStateClass(t) {
  if (!t) return '';
  if (t.status === 'cancel') return 'entity-cancelled';
  if (t.status === 'done') return 'entity-done';
  return '';
}

// 沿 parentId 链向上找最近的 Object，找不到返回 null
// 带 seen guard 防御环形引用（数据损坏时不死循环）
function nearestObjectIdOf(node) {
  const seen = new Set();
  let cur = node;
  while (cur && cur.parentId !== null && cur.parentId !== undefined && cur.parentId !== '') {
    if (seen.has(cur.id)) return null;   // 环形引用
    seen.add(cur.id);
    const p = tasks.find(x => x.id === cur.parentId);
    if (!p) return null;                 // 上级已删除，断链
    if (p.type === 'object') return p.id;
    cur = p;
  }
  return null;                           // 走到根都没撞到 Object
}

// 时间线搜索匹配（R3.31）：标题/描述/标签/负责人，大小写不敏感；null/损坏数据不崩
function tlSearchMatch(t, kw) {
  if (!kw) return true;
  if (!t) return false;
  kw = kw.toLowerCase();
  return String(t.title || '').toLowerCase().includes(kw)
    || String(t.desc || '').toLowerCase().includes(kw)
    || String(t.tag || '').toLowerCase().includes(kw)
    || String(t.assignee || '').toLowerCase().includes(kw);
}
// 计算搜索可见集合（R3.31）= 命中的 id + 全部祖先 id（沿 parentId 回溯；byId Map 缓存 O(N)，seen guard 防环形引用）
function computeSearchVisibleSet(tasks, kw) {
  const byId = new Map();
  (tasks || []).forEach(t => byId.set(t.id, t));
  const visible = new Set();
  (tasks || []).forEach(t => {
    if (!tlSearchMatch(t, kw)) return;
    let cur = t, seen = new Set();
    while (cur) {
      if (seen.has(cur.id)) break;   // 环形引用安全
      seen.add(cur.id);
      visible.add(cur.id);
      cur = (cur.parentId != null && cur.parentId !== '') ? byId.get(cur.parentId) : null;
    }
  });
  return visible;
}

function renderEntityFilterButtons(activeId, toggleFn, useHidden, wrapLines = false) {
  // 已归档的实体不进快速筛选栏 —— 归档意味着「从日常视野里移走」，
  // 若仍出现在筛选栏，等于归档没生效。要看归档内容走「归档」视图。
  const objs = tasks.filter(t => t.type === 'object' && !isArchivedOf(t));
  const allKrs = tasks.filter(t => t.type === 'kr' && !isArchivedOf(t));
  if (objs.length === 0 && allKrs.length === 0) return '';

  // 预计算每个 KR 的归属 Object（一次算完，避免后面反复回溯）
  const krOwner = new Map();
  allKrs.forEach(k => krOwner.set(k.id, nearestObjectIdOf(k)));

  // B 组：游离 KR（归属为 null —— 上级为空/已删除/非 Object）
  const looseKrs = allKrs.filter(k => krOwner.get(k.id) === null);

  // 判定「当前生效的 Object 上下文」：直接选中 Object 用它自己；选中 KR 用其归属 Object
  let ctxObjectId = null;
  if (activeId !== null && activeId !== undefined) {
    const sel = tasks.find(t => t.id === activeId);
    if (sel) {
      if (sel.type === 'object') ctxObjectId = sel.id;
      else if (sel.type === 'kr') {
        const owner = krOwner.get(sel.id);
        ctxObjectId = (owner === undefined) ? null : owner;
      }
    }
  }

  // A 组：当前 Object 上下文下的 KR
  const krs = ctxObjectId === null ? [] : allKrs.filter(k => krOwner.get(k.id) === ctxObjectId);

  let html = '';
  if (objs.length > 0) {
    if (wrapLines) html += '<span class="entity-row-break"></span>';
    html += '<span class="entity-group-label entity-group-label-object">目标</span>';
    objs.forEach(o => {
      if (useHidden && hiddenFilters['entity:' + o.id]) return;
      const isActive = activeId === o.id;
      // 选中的是 KR 时，其所属 Object 显示为「上下文态」（半亮），让用户知道当前在哪个目标下
      const isCtx = !isActive && ctxObjectId === o.id;
      const isHL = isEntityHighlighted(o.id);
      const st = entityStateClass(o);
      const stTip = o.status === 'cancel' ? '（已取消）' : (o.status === 'done' ? '（已完成）' : '');
      html += `<button class="tag-btn entity-btn entity-object ${st} ${isActive?'active':''} ${isCtx?'ctx':''} ${isHL?'highlighted':''}" style="${entityBtnStyle(o.id, isActive, isCtx, isHL, st)}" data-eid="${o.id}" onclick="${toggleFn}(${o.id})" title="筛选「${o.title}」及其所有下级${stTip}（右键可设底色）"><span class="entity-mark">◆</span>${shortTitle(o.title)}</button>`;
    });
  }

  // A 组渲染：仅在有 Object 上下文时出现
  if (ctxObjectId !== null) {
    if (wrapLines) html += '<span class="entity-row-break"></span>';
    if (krs.length > 0) {
      html += '<span class="entity-group-label entity-group-label-kr">关键结果</span>';
      krs.forEach(k => {
        if (useHidden && hiddenFilters['entity:' + k.id]) return;
        const isActive = activeId === k.id;
        const isHL = isEntityHighlighted(k.id);
        const st = entityStateClass(k);
        const stTip = k.status === 'cancel' ? '（已取消）' : (k.status === 'done' ? '（已完成）' : '');
        html += `<button class="tag-btn entity-btn entity-kr ${st} ${isActive?'active':''} ${isHL?'highlighted':''}" style="${entityBtnStyle(k.id, isActive, false, isHL, st)}" data-eid="${k.id}" onclick="${toggleFn}(${k.id})" title="筛选「${k.title}」及其所有下级${stTip}（右键可设底色）"><span class="entity-mark">▸</span>${shortTitle(k.title)}</button>`;
      });
    } else {
      // 选中的 Object 下面没有 KR，给个提示而不是静默留白
      html += '<span style="font-size:11px;color:var(--gray-400);margin:0 4px 0 10px;white-space:nowrap;">该目标下暂无关键结果</span>';
    }
  }

  // B 组渲染：游离 KR 常驻显示，不受 Object 选中状态门控
  const visibleLoose = useHidden ? looseKrs.filter(k => !hiddenFilters['entity:' + k.id]) : looseKrs;
  if (visibleLoose.length > 0) {
    if (wrapLines && ctxObjectId === null) html += '<span class="entity-row-break"></span>';
    html += '<span class="entity-group-label entity-group-label-loose" title="这些关键结果未关联上级目标，不受目标筛选影响，始终显示">游离 KR</span>';
    visibleLoose.forEach(k => {
      const isActive = activeId === k.id;
      const isHL = isEntityHighlighted(k.id);
      const st = entityStateClass(k);
      html += `<button class="tag-btn entity-btn entity-kr entity-kr-loose ${st} ${isActive?'active':''} ${isHL?'highlighted':''}" style="${entityBtnStyle(k.id, isActive, false, isHL, st)}" data-eid="${k.id}" onclick="${toggleFn}(${k.id})" title="「${k.title}」未关联上级目标，建议在编辑弹窗中补上级（右键可设底色）"><span class="entity-mark">▸</span>${shortTitle(k.title)}</button>`;
    });
  }
  return html;
}

// 过滤栏按钮右键
document.addEventListener('contextmenu', function(e) {
  var btn = e.target.closest('.tag-btn');
  if (!btn) return;
  var tag = btn.dataset.tag;
  var eid = btn.dataset.eid;
  if (!tag && !eid) return;
  e.preventDefault();
  var filterKey = tag ? ('tag:' + tag) : ('entity:' + eid);
  var items = [];
  if (eid) {
    var allIds = [parseInt(eid)];
    var queue = [parseInt(eid)];
    var visitedX = new Set();
    while (queue.length > 0) {
      var px = queue.shift();
      if (visitedX.has(px)) continue;
      visitedX.add(px);
      var children = tasks.filter(function(t) { return t.parentId === px; });
      children.forEach(function(c) { allIds.push(c.id); queue.push(c.id); });
    }
    var hasH = allIds.some(function(id) { return highlightedIds.has(id); });
    if (hasH) {
      items.push({ label: '⭐ 取消高亮此对象', action: 'uh', fn: function() { allIds.forEach(function(id) { highlightedIds.delete(id); }); saveHighlights(); renderAll(); } });
    } else {
      items.push({ label: '⭐ 高亮此对象', action: 'h', fn: function() { allIds.forEach(function(id) { highlightedIds.add(id); }); saveHighlights(); renderAll(); } });
    }
    // 自定义底色：setTimeout(0) 让色板在本菜单 hideCtxMenu 之后再弹出
    (function(entityId, cx, cy) {
      items.push({ label: '🎨 设置底色…', action: 'color', fn: function() {
        setTimeout(function() { showEntityColorMenu(entityId, cx, cy); }, 0);
      } });
      if (entityColors[entityId]) {
        items.push({ label: '↩️ 恢复默认底色', action: 'clrcolor', fn: function() {
          clearEntityColor(entityId); showToast('已恢复默认底色', 'success'); renderAll();
        } });
      }
    })(parseInt(eid), e.clientX, e.clientY);
  }
  if (hiddenFilters[filterKey]) {
    items.push({ label: '🔄 恢复显示', action: 'show', fn: function() { delete hiddenFilters[filterKey]; saveHiddenFilters(); renderAll(); } });
  } else {
    items.push({ label: '👁 隐藏此筛选', action: 'hide', fn: function() { hiddenFilters[filterKey] = true; saveHiddenFilters(); renderAll(); } });
  }
  showCtxMenu(e.clientX, e.clientY, items);
});

// 任务行右键高亮+单条同步
document.addEventListener('contextmenu', function(e) {
  var row = e.target.closest('tr[data-task-id]');
  if (!row) return;
  e.preventDefault();
  var tid = parseInt(row.dataset.taskId);
  var t = tasks.find(function(x) { return x.id === tid; });
  if (!t) return;
  var items = [];
  if (highlightedIds.has(tid)) {
    items.push({ label: '⭐ 取消高亮', action: 'unh', fn: function() { highlightedIds.delete(tid); saveHighlights(); renderAll(); } });
  } else {
    items.push({ label: '⭐ 高亮此行', action: 'h', fn: function() { highlightedIds.add(tid); saveHighlights(); renderAll(); } });
  }
  if (t.type === 'kr' || t.type === 'task') {
    items.push({ label: '📤 同步此项到飞书', action: 'sync', fn: function() { syncSingleTask(tid); } });
  }
  showCtxMenu(e.clientX, e.clientY, items);
});
function toggleTlTagFilter(tag) {
  tlActiveTags = (tlActiveTags === tag) ? null : tag;
  renderTimeline();
}
function toggleTlEntityFilter(eid) {
  tlEntityFilters = (tlEntityFilters === eid) ? null : eid;
  renderTimeline();
}

function collapseAll() {
  tasks.forEach(t => { if (t.children && t.children.length > 0) treeCollapsed[t.id] = true; });
  renderList();
}
function priorityOrder(t) { return PRIORITY_ORDER[t.priority] || 2; }

function getSortComparator(sortType) {
  const TYPE_ORDER = { object: 0, kr: 1, target: 2, task: 3, record: 4, schedule: 5, idea: 6 };
  
  switch (sortType) {
    case 'deadline-asc':
      return (a, b) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const da = new Date(a.deadline || '9999-12-31');
        const db = new Date(b.deadline || '9999-12-31');
        const distA = Math.abs(da - today);
        const distB = Math.abs(db - today);
        return distA - distB;
      };
    case 'deadline-desc':
      return (a, b) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const da = new Date(a.deadline || '9999-12-31');
        const db = new Date(b.deadline || '9999-12-31');
        const distA = Math.abs(da - today);
        const distB = Math.abs(db - today);
        return distB - distA;
      };
    case 'timestamp-desc':
      return (a, b) => (parseInt(b.timestamp || '0') - parseInt(a.timestamp || '0'));
    case 'timestamp-asc':
      return (a, b) => (parseInt(a.timestamp || '0') - parseInt(b.timestamp || '0'));
    case 'priority':
      return (a, b) => (PRIORITY_ORDER[a.priority] || 2) - (PRIORITY_ORDER[b.priority] || 2);
    case 'progress-asc':
      return (a, b) => (a.progress || 0) - (b.progress || 0);
    case 'progress-desc':
      return (a, b) => (b.progress || 0) - (a.progress || 0);
    case 'start-asc':
      return (a, b) => {
        const sa = new Date(a.startDate || '1970-01-01');
        const sb = new Date(b.startDate || '1970-01-01');
        return sa - sb;
      };
    case 'completed-desc':
      return (a, b) => {
        const ca = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const cb = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        if (cb !== ca) return cb - ca;
        // 二级键：时间戳倒序（最后修改的在前），解决历史数据 completedAt 相同导致排序无效
        return parseInt(b.timestamp || '0') - parseInt(a.timestamp || '0');
      };
    case 'completed-asc':
      return (a, b) => {
        const ca = a.completedAt ? new Date(a.completedAt).getTime() : Infinity;
        const cb = b.completedAt ? new Date(b.completedAt).getTime() : Infinity;
        if (ca !== cb) return ca - cb;
        return parseInt(a.timestamp || '0') - parseInt(b.timestamp || '0');
      };
    case 'tree':
    default:
      return (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (PRIORITY_ORDER[a.priority] || 2) - (PRIORITY_ORDER[b.priority] || 2);
  }
}

function filterList() {
  const keyword = document.getElementById('list-filter')?.value?.toLowerCase() || '';

  const rows = document.querySelectorAll('#view-list .tree-table tbody tr');
  const hasColFilter = Object.keys(listColFilters).length > 0;

  // 预计算日期筛选边界（只算一次，避免每行重复 new Date）
  let dfToday, dfTodayEnd, dfOverdue3, dfWeekEnd, dfMonthEnd;
  if (dateFilter) {
    dfToday = new Date(); dfToday.setHours(0, 0, 0, 0);
    dfTodayEnd = new Date(dfToday); dfTodayEnd.setHours(23, 59, 59, 999);
    dfOverdue3 = new Date(dfToday); dfOverdue3.setDate(dfOverdue3.getDate() - 3);
    dfWeekEnd = new Date(dfToday); dfWeekEnd.setDate(dfWeekEnd.getDate() + 7 - dfWeekEnd.getDay()); dfWeekEnd.setHours(23, 59, 59, 999);
    dfMonthEnd = new Date(dfToday.getFullYear(), dfToday.getMonth() + 1, 0); dfMonthEnd.setHours(23, 59, 59, 999);
  }

  const matchedIds = new Set();
  // 单次遍历：缓存每行的 id / ancestors，避免第二次循环重复解析
  const rowInfos = [];

  rows.forEach(row => {
    const taskData = JSON.parse(row.dataset.task || '{}');
    const status = row.dataset.status;
    const type = row.dataset.type;
    const taskId = parseInt(row.dataset.taskId);
    const ancestors = (row.dataset.ancestors || '').split(',').filter(Boolean).map(Number);
    rowInfos.push({ row, taskId, ancestors });

    const path = (row.dataset.path || '').toLowerCase();
    const assignee = (taskData.assignee || '').toLowerCase();
    const title = (taskData.title || '').toLowerCase();
    const desc = (taskData.desc || '').toLowerCase();
    const rowTag = row.dataset.tag || '';
    const matchKw = !keyword || path.includes(keyword) || assignee.includes(keyword) || title.includes(keyword) || desc.includes(keyword);
    const isArchived = isArchivedOf(taskData);
    let matchSt;
    if (archiveOnly) {
      // 筛选模式：仅显示已归档
      matchSt = isArchived;
    } else if (statusFilter.length > 0) {
      matchSt = statusFilter.includes(status);
    } else {
      // 叠加模式控制是否显示已归档
      matchSt = showArchived || !isArchived;
    }
    const matchTy = typeFilter.length === 0 || typeFilter.includes(type);
    let matchTag = true;
    if (listActiveTags !== null) {
      matchTag = (type === listActiveTags) || (rowTag === listActiveTags);
    }
    if (listKissFilter !== null) {
      // R3.35 修复：描述字段名为 desc（非 description），与上方关键词搜索保持一致
      const text = ((taskData.title||'') + ' ' + (taskData.desc||'')).toUpperCase();
      matchTag = matchTag && text.includes('[' + listKissFilter + ']');
    }
    let matchEntity = true;
    if (listEntityFilters !== null) {
      matchEntity = ancestors.includes(listEntityFilters) || taskId === listEntityFilters;
    }
    let matchDate = true;
    if (dateFilter) {
      const deadline = taskData.deadline;
      const dd = deadline ? new Date(deadline) : null;
      const baseOk = (type === 'task' || type === 'schedule') && status !== 'done' && status !== 'cancel' && dd;
      if (dateFilter === 'todayTodo') {
        matchDate = baseOk && dd >= dfOverdue3 && dd <= dfTodayEnd;
      } else if (dateFilter === 'weekDeadline') {
        matchDate = baseOk && dd >= dfToday && dd <= dfWeekEnd;
      } else if (dateFilter === 'monthDeadline') {
        matchDate = baseOk && dd >= dfToday && dd <= dfMonthEnd;
      } else if (dateFilter === 'overdue') {
        matchDate = baseOk && dd < dfToday;
      }
    }
    // 列筛选
    let matchCol = true;
    if (hasColFilter) {
      for (const [field, filterVal] of Object.entries(listColFilters)) {
        if (!filterVal) continue;
        let rowVal = '';
        switch (field) {
          case 'assignee': rowVal = taskData.assignee || '(空)'; break;
          case 'isMilestone': rowVal = taskData.isMilestone === true || taskData.isMilestone === 'true' ? '是' : '否'; break;
          case 'isArchived': rowVal = isArchivedOf(taskData) ? '是' : '否'; break;
          case 'priority': rowVal = taskData.priority || '(空)'; break;
          case 'status': rowVal = statusMap[taskData.status] || taskData.status; break;
          case 'deadline': rowVal = taskData.deadline || '(空)'; break;
          case 'startDate': rowVal = taskData.startDate || '(空)'; break;
          case 'progress': rowVal = (taskData.progress || 0) + '%'; break;
          case 'files': rowVal = (taskData.files && taskData.files.length > 0) ? '有附件' : '(无)'; break;
        }
        if (rowVal !== filterVal) { matchCol = false; break; }
      }
    }

    if (matchKw && matchSt && matchTy && matchTag && matchEntity && matchCol && matchDate) {
      matchedIds.add(taskId);
    }
  });

  // O(n): 收集"存在被匹配后代"的祖先集合
  const hasMatchedDescendantSet = new Set();
  rowInfos.forEach(info => {
    if (matchedIds.has(info.taskId)) {
      info.ancestors.forEach(aid => hasMatchedDescendantSet.add(aid));
    }
  });

  const isFilterActive = typeFilter.length > 0 || statusFilter.length > 0 || listActiveTags !== null || listKissFilter !== null || dateFilter !== null;

  rowInfos.forEach(info => {
    const { row, taskId, ancestors } = info;
    const isMatched = matchedIds.has(taskId);
    const isCollapsedByParent = ancestors.some(aid => treeCollapsed[aid]);

    if (isCollapsedByParent) {
      row.style.display = 'none';
    } else if (isMatched) {
      row.style.display = '';
    } else if (!isFilterActive && ancestors.some(aid => matchedIds.has(aid))) {
      row.style.display = '';
    } else if (!isFilterActive && hasMatchedDescendantSet.has(taskId)) {
      row.style.display = '';
    } else {
      row.style.display = 'none';
    }
  });
}

// ---- Timeline ----
// ---- Timeline ----
function renderTimeline() { renderCalendar(); }

function renderCalendar() {
  const el = document.getElementById('view-timeline');
  const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  const weekdays = ['一','二','三','四','五','六','日'];

  // 收集当月日程（schedule 按 deadline），按日期分组
  const schedulesByDate = {};
  tasks.forEach(t => {
    if (t.type !== 'schedule' || !t.deadline) return;
    if (archiveOnly ? !isArchivedOf(t) : (isArchivedOf(t) && !showArchived)) return;
    if (calFilterStatus === 'active' && (t.status === 'done' || t.status === 'cancel')) return;
    if (calFilterStatus === 'done' && t.status !== 'done') return;
    const key = t.deadline.slice(0, 10);
    (schedulesByDate[key] = schedulesByDate[key] || []).push(t);
  });

  // 计算当月网格
  const firstDay = new Date(calYear, calMonth, 1);
  // 转为周一开头：JS getDay() 周日=0，转成周一=0..周日=6
  let startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const gridStart = new Date(calYear, calMonth, 1 - startOffset);
  const todayStr = formatDateLocal(new Date());

  // 42 格（6周）
  let cellsHTML = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const dateStr = formatDateLocal(d);
    const isOtherMonth = d.getMonth() !== calMonth;
    const isToday = dateStr === todayStr;
    const daySchedules = schedulesByDate[dateStr] || [];
    const itemsHTML = daySchedules.map(s => {
      const doneCls = (s.status === 'done' || s.status === 'cancel') ? ' cal-sched-done' : '';
      const recurCls = s.recurringGroupId ? ' cal-recur' : '';
      return `<div class="calendar-schedule-item${doneCls}${recurCls}" onclick="event.stopPropagation();editTask(${s.id})" title="${(s.title||'').replace(/"/g,'&quot;')}">${s.title || '(无标题)'}</div>`;
    }).join('');
    cellsHTML += `<div class="calendar-day-cell${isOtherMonth ? ' calendar-day-other-month' : ''}${isToday ? ' calendar-day-today' : ''}" onclick="createScheduleOn('${dateStr}')">
      <div class="calendar-day-number">${d.getDate()}</div>
      <div class="calendar-day-items">${itemsHTML}</div>
    </div>`;
  }

  el.innerHTML = `
    <div class="card" style="overflow:hidden;">
      <div class="card-header">
        <span class="card-title">📅 日历</span>
        <div class="calendar-nav">
          <button class="calendar-nav-btn" onclick="calShiftMonth(-1)" title="上个月">◀</button>
          <span class="calendar-month-title">${calYear}年${monthNames[calMonth]}</span>
          <button class="calendar-nav-btn" onclick="calShiftMonth(1)" title="下个月">▶</button>
          <button class="calendar-nav-btn calendar-today-btn" onclick="calGoToday()">今天</button>
        </div>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="createScheduleFromCalendar()">➕ 新建日程</button>
          <select style="padding:6px 8px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;"
            onchange="calFilterStatus=this.value;renderCalendar();">
            <option value="all" ${calFilterStatus==='all'?'selected':''}>全部日程</option>
            <option value="active" ${calFilterStatus==='active'?'selected':''}>未完成</option>
            <option value="done" ${calFilterStatus==='done'?'selected':''}>已完成</option>
          </select>
        </div>
      </div>
      <div class="calendar-weekdays">
        ${weekdays.map(w => `<div class="calendar-weekday-header">${w}</div>`).join('')}
      </div>
      <div class="calendar-grid">
        ${cellsHTML}
      </div>
    </div>
  `;
}

function calShiftMonth(delta) {
  calMonth += delta;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  else if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
}

function calGoToday() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
}

function createScheduleFromCalendar() {
  const now = new Date();
  let target;
  if (now.getFullYear() === calYear && now.getMonth() === calMonth) {
    target = formatDateLocal(now);
  } else {
    target = formatDateLocal(new Date(calYear, calMonth, 1));
  }
  createScheduleOn(target);
}

function createScheduleOn(dateStr) {
  editingTaskId = null;
  nextParentTaskId = null;
  document.getElementById('modal-breadcrumb').style.display = 'none';
  resetTaskForm({ type: 'schedule', deadline: dateStr, startDate: dateStr });
  document.getElementById('modal-task-title').textContent = '📅 添加日程';
  document.getElementById('modal-task').style.display = 'flex';
  selectedDeps = new Set();
  selectedNexts = new Set();
  renderDepSelector(false);
  renderNextSelector(false);
  renderParentSelector(null, 'schedule');
  updateTaskPreview();
  snapshotForm();
}

// ---- File Manager View ----
let _filesViewState = { keyword: '', ext: '', page: 1, loading: false, data: [], total: 0, available: null };

async function renderFiles() {
  const el = document.getElementById('view-files');
  if (!el) return;
  // 先检测后端是否可用
  const ok = await FileManagerAPI.checkHealth();
  if (!ok) {
    el.innerHTML = `
      <div class="card" style="overflow:hidden;">
        <div class="card-header">
          <span class="card-title">📁 文件管理</span>
          <div style="margin-left:auto;">
            <button class="btn btn-outline btn-sm" onclick="renderFiles()">🔄 重新检测</button>
          </div>
        </div>
        <div class="empty-state" style="padding:40px;">
          <div class="empty-icon">📁</div>
          <h3>文件管理系统未启动</h3>
          <p>请先启动 <code>file-tag-manager\server.py</code>（默认端口 3456）</p>
          <p style="margin-top:8px;font-size:12px;color:var(--gray-400);">或双击 <code>启动.bat</code> 一键启动</p>
        </div>
      </div>
    `;
    return;
  }
  // 嵌入独立文件管理系统（iframe），复刻全部功能：扫描、筛选、标签、右键菜单、设置等
  const iframeUrl = FILE_API_BASE.replace(/\/api\/?$/, '/');
  // 若已存在同源 iframe 则复用，避免每次切换视图都重载
  const existing = document.getElementById('file-manager-iframe');
  if (existing && existing.getAttribute('src') === iframeUrl) return;
  el.innerHTML = `
    <div class="card" style="overflow:hidden;padding:0;">
      <div class="card-header" style="padding:8px 12px;">
        <span class="card-title">📁 文件管理</span>
        <span style="margin-left:8px;font-size:11px;color:var(--gray-400);">（内嵌独立系统，功能完整）</span>
        <div style="margin-left:auto;display:flex;gap:6px;">
          <button class="btn btn-outline btn-sm" onclick="document.getElementById('file-manager-iframe').src=document.getElementById('file-manager-iframe').src">🔄 刷新</button>
          <button class="btn btn-outline btn-sm" onclick="window.open('${iframeUrl}','_blank')">🗔 在新窗口打开</button>
        </div>
      </div>
      <iframe id="file-manager-iframe" src="${iframeUrl}"
        style="width:100%;height:calc(100vh - 140px);border:none;display:block;"
        onload="_onFileManagerIframeLoad()"></iframe>
    </div>
  `;
}

// iframe 加载完成回调（若有待跳转关键词，注入到搜索框）
function _onFileManagerIframeLoad() {
  if (_pendingFileJumpKeyword) {
    _sendKeywordToFileManagerIframe(_pendingFileJumpKeyword, _pendingFileJumpFileId, _pendingFileJumpPath);
    _pendingFileJumpKeyword = null;
    _pendingFileJumpFileId = null;
    _pendingFileJumpPath = null;
  }
}
let _pendingFileJumpKeyword = null;
let _pendingFileJumpFileId = null;
let _pendingFileJumpPath = null;
function _sendKeywordToFileManagerIframe(kw, fileId, path) {
  const iframe = document.getElementById('file-manager-iframe');
  if (!iframe) return;
  try {
    const doc = iframe.contentDocument;
    if (!doc) return;
    const search = doc.getElementById('searchInput');
    if (search) {
      search.value = kw || '';
      // 触发独立系统内部的搜索
      search.dispatchEvent(new Event('input', { bubbles: true }));
      // 独立系统有 debounce，稍后再高亮
      setTimeout(() => {
        const list = doc.getElementById('fileList');
        if (!list) return;
        // 匹配 file 条目：优先按 data-id/id，其次按名称
        let row = null;
        if (fileId) row = list.querySelector('[data-file-id="' + fileId + '"]');
        if (!row) row = list.querySelector('[data-id="' + fileId + '"]');
        if (!row && path) {
          const norm = String(path).replace(/\\/g, '/').toLowerCase();
          list.querySelectorAll('[data-file-path], [data-path]').forEach(r => {
            const p = (r.getAttribute('data-file-path') || r.getAttribute('data-path') || '').replace(/\\/g,'/').toLowerCase();
            if (!row && p === norm) row = r;
          });
        }
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const oldBg = row.style.background;
          row.style.transition = 'background 0.5s';
          row.style.background = '#FEF3C7';
          setTimeout(() => { row.style.background = oldBg; }, 2000);
        }
      }, 800);
    }
  } catch (e) {
    // 跨域时无法访问 contentDocument，但同源应该没问题
    console.warn('Cannot access file manager iframe:', e);
  }
}

async function _filesViewRefresh() {
  const body = document.getElementById('files-view-body');
  if (!body) return;
  body.innerHTML = '<div class="empty-state">加载中...</div>';
  // 检测后端
  const ok = await FileManagerAPI.checkHealth();
  _filesViewState.available = ok;
  if (!ok) {
    body.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📁</div>
      <h3>文件管理系统未启动</h3>
      <p>请先启动 <code>file-tag-manager</code> 中的后端服务（默认端口 3456）</p>
      <p style="margin-top:8px;font-size:12px;color:var(--gray-400);">启动后点击右上角 🔄 刷新</p>
    </div>`;
    return;
  }
  const res = await FileManagerAPI.listFiles({ keyword: _filesViewState.keyword, ext: _filesViewState.ext, page: 1, page_size: 100 });
  _filesViewState.data = (res && res.data) || [];
  _filesViewState.total = (res && res.total) || 0;
  if (_filesViewState.data.length === 0) {
    body.innerHTML = '<div class="empty-state"><p>没有匹配的文件。请调整筛选或到文件管理系统触发扫描。</p></div>';
    return;
  }
  // 建反向索引 path→[task]
  const pathToTasks = {};
  tasks.forEach(t => {
    (t.files || []).forEach(f => {
      const key = (f && f.path) ? f.path.replace(/\\/g, '/').toLowerCase() : null;
      if (key) (pathToTasks[key] = pathToTasks[key] || []).push(t);
    });
  });
  body.innerHTML = `
    <div style="margin-bottom:8px;font-size:12px;color:var(--gray-500);">共 ${_filesViewState.total} 个文件，显示前 ${_filesViewState.data.length} 个</div>
    <table class="tree-table" style="width:100%;font-size:13px;">
      <thead><tr>
        <th style="width:34%;">文件名</th>
        <th style="width:34%;">路径</th>
        <th style="width:14%;">标签</th>
        <th style="width:10%;">关联任务</th>
        <th style="width:8%;">操作</th>
      </tr></thead>
      <tbody>
        ${_filesViewState.data.map(f => {
          const key = (f.file_path || '').replace(/\\/g, '/').toLowerCase();
          const linked = pathToTasks[key] || [];
          const tagsHTML = (f.tags || []).map(t => `<span style="display:inline-block;background:${'#F3E8FF'};color:#7C3AED;padding:1px 6px;border-radius:8px;margin:1px;font-size:10px;">${t.name}</span>`).join('') || '<span style="color:var(--gray-300);">-</span>';
          const linkedHTML = linked.length === 0
            ? '<span style="color:var(--gray-300);">-</span>'
            : linked.map(t => `<a href="javascript:void(0)" onclick="navigateToTaskFromFile(${t.id})" style="display:inline-block;background:#EEF2FF;color:#4338CA;padding:1px 6px;border-radius:8px;margin:1px;font-size:11px;text-decoration:none;" title="${(t.title||'').replace(/"/g,'&quot;')}">📄 ${(t.title||'').substring(0,10)}${(t.title||'').length>10?'...':''}</a>`).join('');
          return `<tr data-file-id="${f.id}" data-file-path="${(f.file_path || '').replace(/"/g,'&quot;')}">
            <td style="font-weight:500;" title="${(f.file_name || '').replace(/"/g,'&quot;')}">${f.file_name || ''}</td>
            <td style="font-family:monospace;font-size:11px;color:var(--gray-500);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="${(f.file_path || '').replace(/"/g,'&quot;')}">${f.file_path || ''}</td>
            <td>${tagsHTML}</td>
            <td>${linkedHTML}</td>
            <td>
              <button class="btn btn-outline btn-sm" onclick="_filesOpen(${f.id})" title="打开文件">📂</button>
              <button class="btn btn-outline btn-sm" onclick="_filesShow(${f.id})" title="打开路径">📁</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function _filesOpen(id) {
  const r = await FileManagerAPI.openFile(id);
  if (r && r.ok) showToast('已打开文件', 'success');
  else if (r && r.error) showToast(r.error, 'error');
}
async function _filesShow(id) {
  const r = await FileManagerAPI.showFile(id);
  if (r && r.ok) showToast('已定位文件', 'success');
  else if (r && r.error) showToast(r.error, 'error');
}
function navigateToTaskFromFile(taskId) {
  // R3.38：任务列表视图已移除，改为跳转到时间线表格视图并定位/打开任务
  activateTimelineTable(true);
  setTimeout(() => {
    const row = document.querySelector('#view-timeline-table tr[data-task-id="' + taskId + '"]');
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.style.transition = 'background 0.8s ease';
      row.style.background = '#FEF3C7';
      setTimeout(() => { row.style.background = ''; }, 2000);
    } else {
      editTask(taskId);
    }
  }, 200);
}

function renderTimelineLegacy() {
  const el = document.getElementById('view-timeline');
  
  // ── 筛选条件（全局变量，供 onchange 回调使用）──
  if (window._tlFilterStatus === undefined) window._tlFilterStatus = 'all';
  if (window._tlFilterType === undefined) window._tlFilterType = 'all';
  if (window._tlFilterSearch === undefined) window._tlFilterSearch = '';
  if (window._tlViewMode === undefined) window._tlViewMode = 'month'; // day | week | month

  // 获取实体所有后代ID（含自身）
  function getDescendantIds(id) {
    const result = new Set([id]);
    function collect(pid) { tasks.forEach(t => { if (t.parentId === pid) { result.add(t.id); collect(t.id); } }); }
    collect(id);
    return result;
  }

  // 过滤任务
  const filtered = tasks.filter(t => {
    if (!t.deadline) return false;
    if (t.status === 'done' && !showDone) return false;
    if (archiveOnly ? !isArchivedOf(t) : (isArchivedOf(t) && !showArchived)) return false;
    if (window._tlFilterStatus !== 'all' && t.status !== window._tlFilterStatus) return false;
    if (window._tlFilterType !== 'all' && t.type !== window._tlFilterType) return false;
    if (window._tlFilterSearch && !t.title.includes(window._tlFilterSearch)) return false;
    // 快速筛选：标签
    if (tlActiveTags !== null) {
      if (t.type !== tlActiveTags && t.tag !== tlActiveTags) return false;
    }
    // 快速筛选：实体（含后代）
    if (tlEntityFilters !== null) {
      const ancestors = [];
      let cur = t;
      while (cur) { ancestors.push(cur.id); cur = cur.parentId ? tasks.find(x => x.id === cur.parentId) : null; }
      if (!ancestors.includes(tlEntityFilters)) return false;
    }
    return true;
  });
  
  if (filtered.length === 0) {
    if (tasks.length === 0) {
      el.innerHTML = `<div class="card"><div class="empty-state"><div class="empty-icon">📅</div><h3>暂无时间线数据</h3><p>为任务设置截止日期后，时间线视图会在这里展示</p></div></div>`;
    } else {
      el.innerHTML = `<div class="card" style="overflow:hidden;">
        <div class="tag-filter-bar" style="border-bottom:1px solid var(--gray-200);padding:8px 12px;">
          <span style="font-size:12px;color:var(--gray-400);white-space:nowrap;">快速筛选：</span>
          ${['object','kr','target','task'].map(type => {
            const labels = {object:'🎯 目标', kr:'📊 KR', target:'🎯 子目标', task:'📋 任务'};
            const isActive = tlActiveTags === type;
            return `<button class="tag-btn ${isActive?'active':''} type-${type}" data-tag="${type}" onclick="toggleTlTagFilter('${type}')">${labels[type]}</button>`;
          }).join('')}
          ${renderEntityFilterButtons(tlEntityFilters, 'toggleTlEntityFilter', false)}
        </div>
        <div class="card-header">
          <span class="card-title">📅 时间线（按目标分组）</span>
          <div style="display:flex;gap:8px;margin-left:auto;flex-wrap:wrap;">
            <input type="text" id="tl-search" placeholder="🔍 搜索..." value="${window._tlFilterSearch}"
              style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;width:120px;"
              oninput="window._tlFilterSearch=this.value;debouncedRenderTimeline();">
            <select id="tl-status-filter" style="padding:6px 8px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;"
              onchange="window._tlFilterStatus=this.value;renderTimeline();">
              <option value="all" ${window._tlFilterStatus==='all'?'selected':''}>全部状态</option>
              <option value="todo" ${window._tlFilterStatus==='todo'?'selected':''}>待办</option>
              <option value="progress" ${window._tlFilterStatus==='progress'?'selected':''}>进行中</option>
              <option value="cancel" ${window._tlFilterStatus==='cancel'?'selected':''}>已取消</option>
              <option value="blocked" ${window._tlFilterStatus==='blocked'?'selected':''}>阻塞</option>
            </select>
            <select id="tl-type-filter" style="padding:6px 8px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;"
              onchange="window._tlFilterType=this.value;renderTimeline();">
              <option value="all" ${window._tlFilterType==='all'?'selected':''}>全部层级</option>
              <option value="object" ${window._tlFilterType==='object'?'selected':''}>🎯 目标</option>
              <option value="kr" ${window._tlFilterType==='kr'?'selected':''}>📊 关键结果</option>
              <option value="target" ${window._tlFilterType==='target'?'selected':''}>🎯 子目标</option>
              <option value="task" ${window._tlFilterType==='task'?'selected':''}>✅ 任务</option>
            </select>
            <button class="board-toggle-btn ${showDone?'active':''}" style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;cursor:pointer;background:${showDone?'var(--primary)':'transparent'};color:${showDone?'#fff':'var(--gray-600)'};" onclick="showDone=!showDone;renderTimeline();">✅ 含已完成</button>
          </div>
        </div>
        <div class="empty-state"><div class="empty-icon">🔍</div><h3>没有匹配的任务</h3><p>当前筛选条件下暂无时间线数据，请调整筛选条件</p></div>
      </div>`;
    }
    return;
  }

  const now = new Date();
  const allDates = filtered.map(t => new Date(t.deadline));
  filtered.forEach(t => { if (t.startDate) allDates.push(new Date(t.startDate)); });
  allDates.push(now);
  const dataMin = new Date(Math.min(...allDates));
  const dataMax = new Date(Math.max(...allDates));

  let minDate, maxDate;
  if (window._tlViewMode === 'day') {
    minDate = new Date(dataMin); minDate.setDate(minDate.getDate() - 7);
    maxDate = new Date(dataMax); maxDate.setDate(maxDate.getDate() + 14);
  } else if (window._tlViewMode === 'week') {
    minDate = new Date(dataMin); minDate.setDate(minDate.getDate() - 14);
    maxDate = new Date(dataMax); maxDate.setDate(maxDate.getDate() + 14);
  } else {
    minDate = new Date(dataMin); minDate.setMonth(minDate.getMonth() - 2);
    maxDate = new Date(dataMax); maxDate.setMonth(maxDate.getMonth() + 2);
  }
  const totalMs = maxDate - minDate;
  function pct(d) { return ((new Date(d) - minDate) / totalMs) * 100; }

  // 找到每个条目的顶层 Object
  function topObject(t) {
    let cur = t;
    while (cur && cur.parentId) { const p = tasks.find(x => x.id === cur.parentId); if (p) cur = p; else break; }
    return cur;
  }
  const sorted = [...filtered].sort((a, b) => {
    const oa = topObject(a), ob = topObject(b);
    if (oa.id !== ob.id) return (oa.title || '').localeCompare(ob.title || '');
    return new Date(a.deadline) - new Date(b.deadline);
  });

  // 月份标记 — 根据视图模式生成
  const markers = [];
  if (window._tlViewMode === 'day') {
    let cursor = new Date(minDate);
    cursor.setHours(0,0,0,0);
    while (cursor <= maxDate) { markers.push({ date: new Date(cursor), label: (cursor.getMonth()+1)+'/'+cursor.getDate() }); cursor.setDate(cursor.getDate() + 2); }
  } else if (window._tlViewMode === 'week') {
    let cursor = new Date(minDate);
    cursor.setHours(0,0,0,0);
    cursor.setDate(cursor.getDate() - cursor.getDay() + 1); // 周一
    while (cursor <= maxDate) { markers.push({ date: new Date(cursor), label: (cursor.getMonth()+1)+'/'+cursor.getDate() }); cursor.setDate(cursor.getDate() + 7); }
  } else {
    let cursor = new Date(minDate);
    cursor.setDate(1);
    while (cursor <= maxDate) { markers.push({ date: new Date(cursor), label: (cursor.getMonth()+1)+'月' }); cursor.setMonth(cursor.getMonth() + 1); }
  }

  // 行高
  const ROW_H = 46;
  // 根据视图模式计算时间轴最小宽度（确保可横向滚动）
  const daysSpan = Math.round(totalMs / 86400000);
  const timeBodyMinWidth = Math.max(800, daysSpan * (window._tlViewMode === 'day' ? 50 : window._tlViewMode === 'week' ? 20 : 4));
  
  // 依赖箭头数据（在 DOM 渲染后计算）
  const depPairs = [];
  sorted.forEach((t, i) => {
    if (t.deps) t.deps.forEach(depId => {
      const depIdx = sorted.findIndex(x => x.id === depId);
      if (depIdx >= 0) depPairs.push({ from: depIdx, to: i, type: 'dep' });
    });
    if (t.next) t.next.forEach(nextId => {
      const nextIdx = sorted.findIndex(x => x.id === nextId);
      if (nextIdx >= 0) depPairs.push({ from: i, to: nextIdx, type: 'next' });
    });
  });

  let lastObjId = null;
  el.innerHTML = `
    <div class="card" style="overflow:hidden;">
      <div class="tag-filter-bar" style="border-bottom:1px solid var(--gray-200);padding:8px 12px;">
        <span style="font-size:12px;color:var(--gray-400);white-space:nowrap;">快速筛选：</span>
        ${['object','kr','target','task'].map(type => {
          const labels = {object:'🎯 目标', kr:'📊 KR', target:'🎯 子目标', task:'📋 任务'};
          const isActive = tlActiveTags === type;
          return `<button class="tag-btn ${isActive?'active':''} type-${type}" data-tag="${type}" onclick="toggleTlTagFilter('${type}')">${labels[type]}</button>`;
        }).join('')}
        ${renderEntityFilterButtons(tlEntityFilters, 'toggleTlEntityFilter', false)}
      </div>
      <div class="card-header">
        <span class="card-title">📅 时间线（按目标分组）</span>
        <div class="board-toggle" style="margin-right:4px;">
          <button class="board-toggle-btn ${window._tlViewMode==='day'?'active':''}" onclick="window._tlViewMode='day';renderTimeline();">日</button>
          <button class="board-toggle-btn ${window._tlViewMode==='week'?'active':''}" onclick="window._tlViewMode='week';renderTimeline();">周</button>
          <button class="board-toggle-btn ${window._tlViewMode==='month'?'active':''}" onclick="window._tlViewMode='month';renderTimeline();">月</button>
        </div>
        <div style="display:flex;gap:8px;margin-left:auto;flex-wrap:wrap;">
          <input type="text" id="tl-search" placeholder="🔍 搜索..." value="${window._tlFilterSearch}"
            style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;width:120px;"
            oninput="window._tlFilterSearch=this.value;debouncedRenderTimeline();">
          <select id="tl-status-filter" style="padding:6px 8px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;"
            onchange="window._tlFilterStatus=this.value;renderTimeline();">
            <option value="all" ${window._tlFilterStatus==='all'?'selected':''}>全部状态</option>
            <option value="todo" ${window._tlFilterStatus==='todo'?'selected':''}>待办</option>
            <option value="progress" ${window._tlFilterStatus==='progress'?'selected':''}>进行中</option>
            <option value="cancel" ${window._tlFilterStatus==='cancel'?'selected':''}>已取消</option>
            <option value="blocked" ${window._tlFilterStatus==='blocked'?'selected':''}>阻塞</option>
          </select>
          <select id="tl-type-filter" style="padding:6px 8px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;"
            onchange="window._tlFilterType=this.value;renderTimeline();">
            <option value="all" ${window._tlFilterType==='all'?'selected':''}>全部层级</option>
            <option value="object" ${window._tlFilterType==='object'?'selected':''}>🎯 目标</option>
            <option value="kr" ${window._tlFilterType==='kr'?'selected':''}>📊 关键结果</option>
            <option value="target" ${window._tlFilterType==='target'?'selected':''}>🎯 子目标</option>
            <option value="task" ${window._tlFilterType==='task'?'selected':''}>✅ 任务</option>
          </select>
        </div>
      </div>
      <div id="tl-viewport" style="overflow:hidden;position:relative;cursor:grab;user-select:none;">
        <div id="tl-canvas" style="position:relative;min-width:650px;">
          <!-- 时间轴顶部标签 -->
          <div style="position:absolute;left:0;top:0;width:200px;height:30px;z-index:4;background:var(--gray-50);border-bottom:1px solid var(--gray-200);border-right:2px solid var(--gray-200);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--gray-500);letter-spacing:1px;">时间</div>
          <!-- 左侧标签列 -->
          <div id="tl-labels" style="position:absolute;left:0;top:30px;width:200px;z-index:3;background:white;border-right:2px solid var(--gray-200);">
            ${sorted.map((t, i) => {
              const obj = topObject(t);
              let header = '';
              if (obj.id !== lastObjId) { header = `<div style="font-size:10px;font-weight:700;color:#7C3AED;padding:6px 8px 2px;border-top:1px solid var(--gray-200);">${obj.title}</div>`; lastObjId = obj.id; }
              const typeIcon = {object:'🎯', kr:'📊', target:'🎯', task:'✅', record:'📝', schedule:'📅', idea:'💡'}[t.type] || '📄';
              return `${header}<div class="tl-row-label" data-idx="${i}" style="height:${ROW_H}px;display:flex;align-items:center;padding:0 8px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" onclick="editTask(${t.id})" title="${t.title}">${typeIcon} ${t._syncStatus==='local-only'?'📌':t._syncStatus==='new-feishu'?'🆕':''} ${t.title}</div>`;
            }).join('')}
          </div>
          <!-- 时间轴主体（可拖拽平移） -->
          <div id="tl-scroll-area" style="margin-left:202px;position:relative;overflow-x:scroll;overflow-y:hidden;">
            <!-- 横轴时间标签 -->
            <div id="tl-axis" style="height:30px;position:relative;min-width:${timeBodyMinWidth}px;background:var(--gray-50);border-bottom:1px solid var(--gray-200);overflow:hidden;">
              ${markers.map(m => `<div style="position:absolute;top:0;bottom:0;left:${pct(m.date)}%;width:1px;background:var(--gray-300);"><span style="position:absolute;top:50%;transform:translateY(-50%);left:4px;font-size:10px;color:var(--gray-500);white-space:nowrap;line-height:1;">${m.label}</span></div>`).join('')}
              <div style="position:absolute;top:0;bottom:0;left:${pct(now)}%;width:2px;background:var(--danger);z-index:2;" title="今天"><span style="position:absolute;top:50%;transform:translateY(-50%);left:4px;font-size:10px;color:var(--danger);white-space:nowrap;font-weight:700;">今天</span></div>
            </div>
            <div id="tl-time-body" style="position:relative;min-height:${sorted.length * ROW_H + 10}px;min-width:${timeBodyMinWidth}px;">
              <!-- 网格竖线 -->
              ${markers.map(m => `<div style="position:absolute;top:0;bottom:0;left:${pct(m.date)}%;width:1px;background:var(--gray-100);"></div>`).join('')}
              <!-- 今日线 -->
              <div style="position:absolute;top:0;bottom:0;left:${pct(now)}%;width:2px;background:var(--danger);z-index:2;" title="今天"></div>
              <!-- 任务条形 -->
              ${sorted.map((t, i) => {
                const taskStart = t.startDate ? new Date(t.startDate) : null;
                const taskEnd = new Date(t.deadline);
                const effectiveStart = taskStart || (() => { const d = new Date(taskEnd); d.setDate(d.getDate() - 7); return d; })();
                const left = pct(effectiveStart);
                const right = pct(taskEnd);
                const width = Math.max(4, right - left);
                const colors = PRIORITY_GRADIENTS;
                // 条形文字：日视图显示任务名，周/月视图显示日期范围
                let barText = '';
                if (width > 8) {
                  if (window._tlViewMode === 'day') barText = t.title.substring(0, 12);
                  else barText = t.startDate ? t.startDate.slice(5) + '→' + t.deadline.slice(5) : t.deadline.slice(5);
                }
                return `<div class="tl-bar" data-idx="${i}" data-id="${t.id}" style="position:absolute;top:${i * ROW_H + 8}px;left:${left}%;width:${width}%;height:30px;border-radius:6px;background:${colors[t.priority]};display:flex;align-items:center;padding:0 8px;font-size:10px;color:white;font-weight:600;overflow:hidden;cursor:pointer;z-index:1;" onclick="if(!window._tlIgnoreClick)editTask(${t.id})" title="${t.title} | ${t.startDate || '无'} → ${t.deadline}">
                  ${barText}
                </div>`;
              }).join('')}
              <!-- 箭头 SVG 层 -->
              <svg id="tl-arrows" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:4;"></svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // 恢复筛选器的值
  const sf = document.getElementById('tl-status-filter');
  const tf = document.getElementById('tl-type-filter');
  if (sf) sf.value = window._tlFilterStatus;
  if (tf) tf.value = window._tlFilterType;

  // ── 拖拽平移（document 级事件避免冲突）──
  const viewport = document.getElementById('tl-viewport');
  const scrollArea = document.getElementById('tl-scroll-area');
  let tlDrag = { on: false, startX: 0, startScroll: 0, moved: false };
  viewport.onmousedown = (e) => {
    if (e.button !== 0 || e.target.closest('.tl-bar')) return; // 不拦截条形图点击
    tlDrag.on = true;
    tlDrag.startX = e.clientX;
    tlDrag.startScroll = scrollArea.scrollLeft;
    tlDrag.moved = false;
    viewport.style.cursor = 'grabbing';
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!tlDrag.on) return;
    if (Math.abs(e.clientX - tlDrag.startX) > 3) tlDrag.moved = true;
    scrollArea.scrollLeft = tlDrag.startScroll - (e.clientX - tlDrag.startX);
  };
  const onUp = () => {
    if (tlDrag.on && tlDrag.moved) { window._tlIgnoreClick = true; setTimeout(() => { window._tlIgnoreClick = false; }, 200); }
    if (tlDrag.on) { tlDrag.on = false; viewport.style.cursor = 'grab'; }
  };
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  // ── 绘制依赖箭头 ──
  requestAnimationFrame(() => {
    const svg = document.getElementById('tl-arrows');
    const timeBody = document.getElementById('tl-time-body');
    if (!svg || !timeBody) return;
    const bodyRect = timeBody.getBoundingClientRect();
    const barW = timeBody.offsetWidth;
    const svgH = timeBody.offsetHeight;
    svg.setAttribute('viewBox', `0 0 ${barW} ${svgH}`);
    svg.style.width = barW + 'px';
    svg.style.height = svgH + 'px';

    let arrowHTML = '';
    arrowHTML += `<defs>
      <marker id="arrow-dep" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#F59E0B"/></marker>
      <marker id="arrow-next" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#10B981"/></marker>
    </defs>`;

    depPairs.forEach(pair => {
      const fromBar = document.querySelector(`.tl-bar[data-idx="${pair.from}"]`);
      const toBar = document.querySelector(`.tl-bar[data-idx="${pair.to}"]`);
      if (!fromBar || !toBar) return;

      const fb = fromBar.getBoundingClientRect();
      const tb = toBar.getBoundingClientRect();

      // 坐标相对于 #tl-time-body
      const x1 = fb.right - bodyRect.left;
      const y1 = fb.top + fb.height / 2 - bodyRect.top;
      const x2 = tb.left - bodyRect.left;
      const y2 = tb.top + tb.height / 2 - bodyRect.top;

      const cx1 = x1 + Math.abs(x2 - x1) * 0.4;
      const cx2 = x2 - Math.abs(x2 - x1) * 0.4;
      const marker = pair.type === 'dep' ? 'url(#arrow-dep)' : 'url(#arrow-next)';
      const stroke = pair.type === 'dep' ? '#F59E0B' : '#10B981';

      arrowHTML += `<path d="M${x1},${y1} C${cx1},${y1} ${cx2},${y2} ${x2},${y2}" stroke="${stroke}" stroke-width="2" fill="none" marker-end="${marker}" opacity="0.7"/>`;
    });

    svg.innerHTML = arrowHTML;
  });
}

// ---- Priority Matrix ----
function renderMatrix() {
  const el = document.getElementById('view-matrix');
  const active = tasks.filter(t => (showDone || t.status !== 'done') && (archiveOnly ? isArchivedOf(t) : (!isArchivedOf(t) || showArchived)));
  if (active.length === 0) {
    el.innerHTML = `<div class="card"><div class="empty-state"><div class="empty-icon">🎯</div><h3>没有进行中的任务</h3><p>所有任务已完成，太棒了！🎉</p></div></div>`;
    return;
  }

  // Classify into quadrants — 直接按优先级字段归类（R3.5，替代原 deadline 启发式）
  const quadrants = { q1: [], q2: [], q3: [], q4: [] };
  const QUADRANT_OF = { '重要紧急': 'q1', '重要不紧急': 'q2', '紧急不重要': 'q3', '不紧急不重要': 'q4' };
  active.forEach(t => { quadrants[QUADRANT_OF[t.priority] || 'q4'].push(t); });

  function renderMatrixItem(t) {
    const tc = TYPE_COLORS[t.type];
    return `<div class="matrix-item" onclick="editTask(${t.id})">
      <div class="mi-title">
        <span style="font-size:10px;font-weight:700;color:${tc};margin-right:4px;">[${TYPE_LABELS[t.type]}]</span>
        <span class="priority-tag priority-${t.priority}">${t.priority}</span> ${t.title}
      </div>
      ${t.deadline ? `<div class="mi-deadline">⏰ ${t.deadline}</div>` : ''}
    </div>`;
  }

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">🎯 优先级矩阵（四象限）</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="matrix-type-filter" style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;outline:none;" onchange="renderMatrix()">
            <option value="all">全部层级</option>
            <option value="object">目标</option>
            <option value="kr">关键结果</option>
            <option value="target">子目标</option>
            <option value="task">任务</option>
          </select>
          <button class="board-toggle-btn ${showDone?'active':''}" style="padding:6px 10px;border:2px solid var(--gray-200);border-radius:8px;font-size:12px;cursor:pointer;background:${showDone?'var(--primary)':'transparent'};color:${showDone?'#fff':'var(--gray-600)'};" onclick="showDone=!showDone;renderMatrix();">✅ 含已完成</button>
          <span style="font-size:12px;color:var(--gray-400);">艾森豪威尔矩阵 · 按优先级字段归类</span>
        </div>
      </div>
      <div class="matrix-labels" style="margin-bottom:4px;">
        <span>⏰ 紧急</span><span>不急迫</span>
      </div>
      <div style="display:flex;">
        <div class="matrix-y-labels" style="margin-right:4px;">
          <span>重要</span><span></span><span></span><span>不重要</span>
        </div>
        <div class="matrix-container" style="flex:1;">
          <div class="matrix-quadrant q1">
            <h3>🔴 Q1: 紧急且重要 — 立即处理</h3>
            ${quadrants.q1.map(t => renderMatrixItem(t)).join('') || '<div style="font-size:12px;color:var(--gray-400);text-align:center;padding:20px;">暂无</div>'}
          </div>
          <div class="matrix-quadrant q2">
            <h3>🔵 Q2: 重要但不急迫 — 做好计划</h3>
            ${quadrants.q2.map(t => renderMatrixItem(t)).join('') || '<div style="font-size:12px;color:var(--gray-400);text-align:center;padding:20px;">暂无</div>'}
          </div>
          <div class="matrix-quadrant q3">
            <h3>🟡 Q3: 紧急但不重要 — 委派/快速完成</h3>
            ${quadrants.q3.map(t => renderMatrixItem(t)).join('') || '<div style="font-size:12px;color:var(--gray-400);text-align:center;padding:20px;">暂无</div>'}
          </div>
          <div class="matrix-quadrant q4">
            <h3>🟢 Q4: 不急不重要 — 稍后/删除</h3>
            ${quadrants.q4.map(t => renderMatrixItem(t)).join('') || '<div style="font-size:12px;color:var(--gray-400);text-align:center;padding:20px;">暂无</div>'}
          </div>
        </div>
      </div>
    </div>
  `;

  // Apply type filter
  const filter = document.getElementById('matrix-type-filter');
  if (filter) {
    const selType = filter.value;
    if (selType !== 'all') {
      document.querySelectorAll('#view-matrix .matrix-item').forEach(item => {
        const onclick = item.getAttribute('onclick') || '';
        const idMatch = onclick.match(/editTask\((\d+)\)/);
        if (idMatch) {
          const t = tasks.find(x => x.id === parseInt(idMatch[1]));
          if (t && t.type !== selType) item.style.display = 'none';
        }
      });
    }
  }
}

// ---- Team Board ----
function renderBoard() {
  const el = document.getElementById('view-board');
  if (tasks.length === 0) {
    el.innerHTML = `<div class="card"><div class="empty-state"><div class="empty-icon">👥</div><h3>还没有任务</h3><p>添加任务并分配负责人后，团队看板会在这里展示</p></div></div>`;
    return;
  }

  // 收集所有 ancestor（用于实体筛选）
  // seen guard：数据损坏出现 parentId 环（A→B→A）时防止死循环
  function ancestorsOf(t) {
    const a = [];
    const seen = new Set();
    let cur = t;
    while (cur) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      a.push(cur.id);
      cur = cur.parentId ? tasks.find(x => x.id === +cur.parentId) : null;
    }
    return a;
  }

  // 过滤任务
  let filtered = tasks.filter(t => {
    if (t.status === 'done' && !showDone) return false;
    if (archiveOnly ? !isArchivedOf(t) : (isArchivedOf(t) && !showArchived)) return false;
    if (!boardShowAll && !['todo','progress'].includes(t.status)) return false;
    // 快速筛选：标签
    if (boardActiveTags !== null) {
      if (t.type !== boardActiveTags && t.tag !== boardActiveTags) return false;
    }
    // 快速筛选：实体
    if (boardEntityFilters !== null) {
      if (!ancestorsOf(t).includes(boardEntityFilters)) return false;
    }
    return true;
  });

  // 按 assignee 分组
  const groups = {};
  filtered.forEach(t => {
    const key = t.assignee || '未分配';
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });
  // "未分配" 放最后
  const assignees = Object.keys(groups).sort((a, b) => {
    if (a === '未分配') return 1;
    if (b === '未分配') return -1;
    return a.localeCompare(b, 'zh');
  });

  // 头像颜色映射
  const avatarColors = ['#7C3AED','#3B82F6','#F59E0B','#10B981','#EF4444','#8B5CF6','#EC4899'];
  let colorIdx = 0;
  const colorMap = {};
  assignees.forEach(a => { if (a !== '未分配') { colorMap[a] = avatarColors[colorIdx % avatarColors.length]; colorIdx++; } });

  // 状态统计
  function groupStats(tasks) {
    const s = { todo: 0, progress: 0, blocked: 0, cancel: 0 };
    tasks.forEach(t => { if (s[t.status] !== undefined) s[t.status]++; });
    return s;
  }

  // 任务行 HTML
  function taskRow(t) {
    const typeIcon = {object:'🎯', kr:'📊', target:'🎯', task:'✅', record:'📝', schedule:'📅', idea:'💡'}[t.type] || '📄';
    const deadline = t.deadline ? new Date(t.deadline).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
    const statusLabel = statusMap[t.status] || t.status;
    return `<div class="board-task-row" onclick="editTask(${t.id})" data-type="${t.type}" data-tag="${t.tag||''}" data-ancestors="${ancestorsOf(t).join(',')}">
      <span class="board-task-type">${typeIcon}</span>
      <span class="board-task-title" title="${t.title}">${t._syncStatus==='local-only'?'📌':t._syncStatus==='new-feishu'?'🆕':''} ${t.title}</span>
      <span class="status-tag status-${t.status}">${statusLabel}</span>
      <span class="board-task-deadline">${deadline}</span>
    </div>`;
  }

  let html = `
    <div class="card" style="overflow:hidden;">
      <div class="tag-filter-bar" style="border-bottom:1px solid var(--gray-200);padding:8px 12px;">
        <span style="font-size:12px;color:var(--gray-400);white-space:nowrap;">快速筛选：</span>
        ${['object','kr','target','task'].map(type => {
          const labels = {object:'🎯 目标', kr:'📊 KR', target:'🎯 子目标', task:'📋 任务'};
          const isActive = boardActiveTags === type;
          return `<button class="tag-btn ${isActive?'active':''} type-${type}" data-tag="${type}" onclick="toggleBoardTag('${type}')">${labels[type]}</button>`;
        }).join('')}
        ${renderEntityFilterButtons(boardEntityFilters, 'toggleBoardEntity', false)}
      </div>
      <div class="card-header">
        <span class="card-title">👥 团队看板（按负责人）</span>
        <div style="display:flex;gap:8px;margin-left:auto;align-items:center;">
          <div class="board-toggle">
            <button class="board-toggle-btn ${!boardShowAll?'active':''}" onclick="boardShowAll=false;renderBoard();">活跃任务</button>
            <button class="board-toggle-btn ${boardShowAll?'active':''}" onclick="boardShowAll=true;renderBoard();">全部任务</button>
            <button class="board-toggle-btn ${showDone?'active':''}" onclick="showDone=!showDone;renderBoard();">✅ 含已完成</button>
          </div>
        </div>
      </div>
  `;

  if (assignees.length === 0) {
    html += `<div class="board-empty">当前筛选条件下没有匹配的任务</div>`;
  } else {
    assignees.forEach(name => {
      const items = groups[name];
      const stats = groupStats(items);
      const avatarColor = colorMap[name] || 'var(--gray-400)';
      const avatarClass = name === '未分配' ? ' unassigned' : '';
      const initials = name === '未分配' ? '?' : name.charAt(0);
      html += `
        <div class="board-group" id="board-group-${name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g,'_')}">
          <div class="board-group-header" onclick="toggleBoardGroup(this)">
            <div class="board-avatar${avatarClass}" style="background:${avatarColor};">${initials}</div>
            <span class="board-assignee-name">${name}</span>
            <span class="board-collapse-icon" id="board-arrow-${name.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g,'_')}">▼</span>
            <div class="board-stats">
              <span class="board-stat"><span class="dot dot-todo"></span> 待办 <strong>${stats.todo}</strong></span>
              <span class="board-stat"><span class="dot dot-progress"></span> 进行中 <strong>${stats.progress}</strong></span>
              ${stats.blocked > 0 ? `<span class="board-stat"><span class="dot dot-blocked"></span> 阻塞 <strong>${stats.blocked}</strong></span>` : ''}
              ${stats.cancel > 0 ? `<span class="board-stat"><span class="dot dot-cancel"></span> 取消 <strong>${stats.cancel}</strong></span>` : ''}
            </div>
          </div>
          <div class="board-group-body">
            ${items.length === 0 ? '<div class="board-task-row" style="color:var(--gray-400);cursor:default;">暂无匹配任务</div>' : items.map(t => taskRow(t)).join('')}
          </div>
        </div>`;
    });
  }

  html += `</div>`;
  el.innerHTML = html;
}

function toggleBoardTag(tag) {
  boardActiveTags = (boardActiveTags === tag) ? null : tag;
  renderBoard();
}

// ============ TIMELINE TABLE VIEW ============
// 展示所有未归档内容块，按时间戳倒序（新→旧），单一表格视图
function renderTimelineTable() {
  const el = document.getElementById('view-timeline-table');
  if (!el) return;

  // 快速筛选：日期边界（与列表视图今日待办/本周/本月/逾期语义一致）
  const _dfToday = new Date(); _dfToday.setHours(0, 0, 0, 0);
  const _dfTodayEnd = new Date(_dfToday); _dfTodayEnd.setHours(23, 59, 59, 999);
  const _dfOverdue3 = new Date(_dfToday); _dfOverdue3.setDate(_dfOverdue3.getDate() - 3);
  const _dfWeekEnd = new Date(_dfToday); _dfWeekEnd.setDate(_dfWeekEnd.getDate() + 7 - _dfWeekEnd.getDay()); _dfWeekEnd.setHours(23, 59, 59, 999);
  const _dfMonthEnd = new Date(_dfToday.getFullYear(), _dfToday.getMonth() + 1, 0); _dfMonthEnd.setHours(23, 59, 59, 999);
  // 单档位匹配（f: todayTodo|weekDue|monthDue|overdue）
  const _tlMatchF = (t, f) => {
    const type = t.type || '';
    const st = t.status || '';
    const dd = t.deadline ? new Date(t.deadline) : null;
    const baseOk = (type === 'task' || type === 'schedule') && st !== 'done' && st !== 'cancel' && dd;
    if (!baseOk) return false;
    if (f === 'todayTodo') return dd >= _dfOverdue3 && dd <= _dfTodayEnd;
    if (f === 'weekDue') return dd >= _dfToday && dd <= _dfWeekEnd;
    if (f === 'monthDue') return dd >= _dfToday && dd <= _dfMonthEnd;
    if (f === 'overdue') return dd < _dfToday;
    return true;
  };
  // 已完成筛选激活时，日期筛选自动失效（日期档位内部已排除 done，同时开会得到 0 条）
  const _tlMatch = (t) => (tlDoneFilter ? true : !tlDateFilter || _tlMatchF(t, tlDateFilter));
  const _typeMatch = (t) => !tlTableTypeFilter || (t.type || '') === tlTableTypeFilter;
  const _doneMatch = (t) => !tlDoneFilter || (t.status || '') === 'done';
  // 实体筛选：沿 parentId 链向上收集所有祖先 id，选中的实体必须在链上（含自身）
  const _entityMatch = (t) => {
    if (tlEntityFilters === null) return true;
    const ancestors = [];
    let cur = t;
    const seen = new Set();
    while (cur) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      ancestors.push(cur.id);
      cur = cur.parentId ? tasks.find(x => x.id === cur.parentId) : null;
    }
    return ancestors.includes(tlEntityFilters);
  };

  // 一次性归并统计徽章计数：单趟遍历，替代原先每个按钮各 filter 全表（O(11N) → O(N)）
  // 显式日期键遍历：done 档位不走 _tlMatchF（其未知档位会 return true 误计数）
  const _tlDateKeys = ['todayTodo', 'weekDue', 'monthDue', 'overdue'];
  const _badgeCounts = { todayTodo: 0, weekDue: 0, monthDue: 0, overdue: 0, done: 0 };
  const _typeCounts = {};
  (tasks || []).forEach(t => {
    if (!t) return;
    if (!(archiveOnly ? isArchivedOf(t) : (!isArchivedOf(t) || showArchived))) return;
    const _type = t.type || '';
    if (_type && _tlMatch(t)) _typeCounts[_type] = (_typeCounts[_type] || 0) + 1;
    _tlDateKeys.forEach(f => { if (_tlMatchF(t, f)) _badgeCounts[f]++; });
    if ((t.status || '') === 'done') _badgeCounts.done++;
  });
  const _tlCount = (f) => _badgeCounts[f] || 0;

  // R3.31 搜索：关键词非空时计算可见集合（命中行 + 祖先链），搜索优先于日期/类型/实体/已完成筛选
  const _searchVisible = tlSearch ? computeSearchVisibleSet(tasks, tlSearch) : null;

  const list = (tasks || [])
    .filter(t => t && (archiveOnly ? isArchivedOf(t) : (!isArchivedOf(t) || showArchived)))
    .filter(t => tlSearch ? (_searchVisible && _searchVisible.has(t.id)) : (_tlMatch(t) && _typeMatch(t) && _entityMatch(t) && _doneMatch(t)))
    .slice()
    .sort((a, b) => {
      const ta = String(a.timestamp || '');
      const tb = String(b.timestamp || '');
      if (ta === tb) return (b.id || 0) - (a.id || 0);
      return ta < tb ? 1 : -1;  // 倒序：越新越靠前
    });

  const rows = list.map(t => {
    const tc = (typeof TYPE_COLORS !== 'undefined' && TYPE_COLORS[t.type]) || '#6B7280';
    const typeLabel = (typeof TYPE_LABELS !== 'undefined' && TYPE_LABELS[t.type]) || t.type || '-';
    const st = t.status || 'todo';
    const stLabel = (typeof statusMap !== 'undefined' && statusMap[st]) || st;
    const priority = t.priority || DEFAULT_PRIORITY;
    const priColor = PRIORITY_COLORS[priority] || '#94A3B8';
    const progress = Math.max(0, Math.min(100, parseInt(t.progress || 0, 10) || 0));
    const progColor = (typeof getProgressColor === 'function') ? getProgressColor(progress, st) : '#6366F1';
    const deadline = t.deadline || '';
    const startDate = t.startDate || '';
    const assignee = t.assignee || '';
    const tag = t.tag || '';
    const filesCount = Array.isArray(t.files) ? t.files.length : 0;
    const title = (t.title || '(未命名)').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const isMilestone = !!t.isMilestone;
    const isArchivedFlag = isArchivedOf(t);
    const hlClass = highlightedIds.has(t.id) ? ' row-highlighted' : '';

    // 悬浮按钮组：编辑属性 / 任务链 / +下级内容(仅 object/kr/target) / +后置内容
    const childMap = { object: 'kr', kr: 'target', target: 'task' };
    const childType = childMap[t.type];
    const childBtnClass = { kr: 'kr-add', target: 'target-add', task: 'task-add' }[childType] || '';
    const childBtn = childType
      ? `<button class="row-action-btn add-btn ${childBtnClass}" onclick="event.stopPropagation();addChildTask(${t.id},'${childType}')">+ 下级内容</button>`
      : '';

    return `
      <tr class="${hlClass.trim()}" data-task-id="${t.id}" onclick="editTask(${t.id})" style="cursor:pointer;">
        <td style="font-family:monospace;font-size:12px;color:var(--gray-500);white-space:nowrap;position:relative;">
          <div class="row-actions" style="left:8px;">
            <button class="row-action-btn edit-btn" onclick="event.stopPropagation();editTask(${t.id})">编辑属性</button>
            ${(() => { const hasChain = (t.deps && t.deps.length > 0) || (t.next && t.next.length > 0); return `<button class="row-action-btn add-btn chain-add ${hasChain ? 'chain-has' : 'chain-empty'}" onclick="event.stopPropagation();showTaskChain(${t.id})">📋 任务链</button>`; })()}
            ${childBtn}
            <button class="row-action-btn add-btn next-add" onclick="event.stopPropagation();addNextTask(${t.id})">+ 后置内容</button>
          </div>
          ${t.timestamp || '-'}
        </td>
        <td style="text-align:center;"><input type="checkbox" ${isArchivedFlag ? 'checked' : ''} onchange="event.stopPropagation();toggleArchived(${t.id});" onclick="event.stopPropagation();" style="width:18px;height:18px;cursor:pointer;" title="${isArchivedFlag ? '点击取消归档' : '点击归档'}"></td>
        <td><span class="type-badge" style="background:${tc}20;color:${tc};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${typeLabel}</span></td>
        <td style="max-width:360px;">
          <div style="font-weight:500;color:var(--gray-800);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${title.replace(/"/g,'&quot;')}">
            ${isMilestone ? '<span title="里程碑" style="margin-right:4px;">🚩</span>' : ''}${title}
          </div>
        </td>
        <td><span style="color:${priColor};font-weight:600;font-size:12px;">${priority}</span></td>
        <td><span class="status-tag status-${st}" style="font-size:11px;cursor:pointer;" onclick="event.stopPropagation();cycleTaskStatus(${t.id})" title="点击切换状态">${stLabel}</span></td>
        <td style="white-space:nowrap;">
          <div style="display:flex;align-items:center;gap:6px;">
            <div style="flex:1;height:6px;background:var(--gray-100);border-radius:3px;overflow:hidden;min-width:60px;">
              <div style="height:100%;width:${progress}%;background:${progColor};"></div>
            </div>
            <span style="font-size:11px;color:var(--gray-600);min-width:32px;text-align:right;">${progress}%</span>
          </div>
        </td>
        <td style="white-space:nowrap;font-size:12px;color:var(--gray-600);">${deadline || '<span style="color:var(--gray-300);">-</span>'}</td>
        <td style="white-space:nowrap;font-size:12px;color:var(--gray-600);">${startDate || '<span style="color:var(--gray-300);">-</span>'}</td>
        <td style="font-size:11px;color:var(--gray-500);max-width:160px;line-height:1.6;" title="${(t.files||[]).map(function(f){return (f&&f.name)||(f&&f.file_name)||(typeof f==='string'?f:'')}).join(', ')}">${(t.files && t.files.length > 0) ? t.files.map((f, fi) => {
          const _f = f || {};
          const _fid = _f.fileId || '';
          const _fpath = _f.path ? String(_f.path).replace(/"/g,'&quot;') : '';
          const _furl = _f.url ? String(_f.url).replace(/"/g,'&quot;') : '';
          const _web = !!_furl;
          const _fname = (typeof fileDisplayName === 'function' ? String(fileDisplayName(f)).replace(/"/g,'&quot;') : ((_f.name || _f.file_name || '').replace(/"/g,'&quot;')));
          const _linked = (_fid || _fpath || _web) ? ' linked' : '';
          let _label = _fname;
          if (typeof fileDisplayName === 'function') _label = fileDisplayName(f);
          else _label = _f.name || _f.file_name || '';
          const _short = _label.length > 16 ? _label.slice(0,14) + '\u2026' : _label;
          return '<div class="list-file-chip'+_linked+'" data-task-id="'+t.id+'" data-file-idx="'+fi+'" data-file-id="'+_fid+'" data-file-path="'+_fpath+'" data-file-url="'+_furl+'" data-file-name="'+_fname+'" onmouseenter="showFileHoverCard(event,this)" onmouseleave="scheduleHideFileHoverCard()" onclick="handleListFileChipClick(event,this)" style="display:block;background:var(--gray-100);padding:2px 6px;border-radius:3px;margin-bottom:2px;font-size:10px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+_label.replace(/"/g,'&quot;')+'">' + (_web ? '\uD83D\uDD17' : '\uD83D\uDCC4') + ' ' + _short + '</div>';
        }).join('') : '<span style="color:var(--gray-400);">-</span>'}</td>
      </tr>
    `;
  }).join('');

  // R3.31 IME 保护：渲染前记录输入框状态（节点复用，渲染不重建输入框，避免打断输入法组合）
  const _tlOldInput = tlSearchInput || document.getElementById('tl-search-input');
  const _tlHadFocus = _tlOldInput && document.activeElement === _tlOldInput;

  el.innerHTML = `
    <div class="card" style="overflow:hidden;">
      <div class="card-header" style="display:flex;align-items:center;position:relative;">
        <span class="card-title" style="flex-shrink:0;">🕐 时间线</span>
        <span style="font-size:12px;color:var(--gray-500);margin-left:12px;flex-shrink:0;">共 ${list.length} 条${(tlDateFilter || tlTableTypeFilter || tlEntityFilters || tlDoneFilter || tlSearch) ? '<b style="color:#DC2626;">（已筛选）</b>' : ''} · ${archiveOnly ? '仅已归档' : (showArchived ? '含已归档' : '排除已归档')}</span>
        <div style="position:absolute;left:50%;transform:translateX(-50%);display:flex;gap:10px;">
          <button class="btn tl-header-btn" onclick="tlSearch='';var _si=document.getElementById('tl-search-input');if(_si)_si.value='';setTlTableTypeFilter(null);setTlDateFilter(null);tlEntityFilters=null;tlDoneFilter=false;renderTimelineTable();" title="清除所有快速筛选条件" style="background:#FEF2F2;border:2px solid #F87171;color:#DC2626;font-size:13px;font-weight:600;padding:6px 16px;border-radius:8px;box-shadow:0 2px 6px rgba(220,38,38,.15);" ${(tlDateFilter || tlTableTypeFilter || tlEntityFilters || tlDoneFilter || tlSearch) ? '' : 'disabled'}>🗑 清除筛选</button>
          <button class="btn tl-header-btn btn-primary" onclick="createNewContent()" title="新建一条内容（任务/目标/KR 等）" style="font-size:13px;font-weight:600;padding:6px 16px;border-radius:8px;box-shadow:0 2px 8px rgba(79,70,229,.3);">➕ 创建内容</button>
        </div>
      </div>
      <div class="tag-filter-bar tl-table-filter-bar">
        <span style="font-size:12px;color:var(--gray-400);white-space:nowrap;">快速筛选：</span>
        <span id="tl-search-slot"></span>
        <button class="tag-btn ${tlDateFilter==='todayTodo'?'active':''}" onclick="setTlDateFilter('todayTodo')" title="今天（含近3天）到期、未完成的 task/schedule">📅 今日待办 <span class="qa-badge" style="font-size:10px;">${_tlCount('todayTodo')}</span></button>
        <button class="tag-btn ${tlDateFilter==='weekDue'?'active':''}" onclick="setTlDateFilter('weekDue')" title="今天起 7 天内到期、未完成">📆 本周到期 <span class="qa-badge" style="font-size:10px;">${_tlCount('weekDue')}</span></button>
        <button class="tag-btn ${tlDateFilter==='monthDue'?'active':''}" onclick="setTlDateFilter('monthDue')" title="本月内到期、未完成">🗓️ 本月到期 <span class="qa-badge" style="font-size:10px;">${_tlCount('monthDue')}</span></button>
        <button class="tag-btn tl-btn-overdue ${tlDateFilter==='overdue'?'active':''}" onclick="setTlDateFilter('overdue')" title="已超过截止日期、未完成">⚠️ 已逾期 <span class="qa-badge" style="font-size:10px;">${_tlCount('overdue')}</span></button>
        <span style="width:1px;height:18px;background:var(--gray-300);margin:0 4px;"></span>
        ${[['object','🎯 目标'],['kr','📏 KR'],['target','⬇️ 子目标'],['task','📋 任务'],['record','📝 记录'],['schedule','📅 日程'],['idea','💡 想法']].map(([type, label]) => {
          const active = tlTableTypeFilter === type;
          const count = _typeCounts[type] || 0;
          return `<button class="tag-btn ${active ? 'active' : ''} type-${type}" onclick="setTlTableTypeFilter('${type}')" title="仅显示 ${label}">${label} <span class="qa-badge" style="font-size:10px;">${count}</span></button>`;
        }).join('')}
        <span style="width:1px;height:18px;background:var(--gray-300);margin:0 4px;"></span>
        <button class="tag-btn ${tlDoneFilter ? 'active' : ''} type-done" onclick="setTlDoneFilter()" title="仅显示已完成（与日期筛选互斥）">✅ 已完成 <span class="qa-badge" style="font-size:10px;">${_badgeCounts.done}</span></button>
        ${renderEntityFilterButtons(tlEntityFilters, 'toggleTlTableEntityFilter', false, true)}
      </div>
      <div style="overflow-x:auto;">
        <table class="tree-table timeline-table">
          <thead>
            <tr>
              <th>时间戳</th>
              <th title="勾选归档后从时间线中移除">归档</th>
              <th>类型</th>
              <th>标题</th>
              <th>优先级</th>
              <th>状态</th>
              <th style="min-width:120px;">进度</th>
              <th>截止日期</th>
              <th>开始时间</th>
              <th>相关文件</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="10" style="text-align:center;color:var(--gray-400);padding:40px;">' + (tlSearch ? '未找到匹配「' + tlSearch + '」的内容（搜索优先，忽略日期/类型/实体筛选）' : '暂无内容') + '</td></tr>'}</tbody>
        </table>
      </div>
      <div style="height:120px;"></div>
    </div>
  `;

  // R3.31 IME 保护：搜索框节点复用——只创建一次，此后每次渲染移动同一节点到 slot 位置（永不重建）
  const _tlSlot = el.querySelector('#tl-search-slot');
  if (_tlSlot) {
    if (!tlSearchInput) {
      tlSearchInput = document.createElement('input');
      tlSearchInput.id = 'tl-search-input';
      tlSearchInput.type = 'text';
      tlSearchInput.placeholder = '🔍 搜索标题/描述/标签/负责人…';
      tlSearchInput.title = '输入关键词筛选内容块（标题/描述/标签/负责人），停止输入后生效；搜索优先于日期/类型/实体筛选；Esc 清空';
      tlSearchInput.style.cssText = 'width:200px;padding:4px 10px;border:1px solid var(--gray-300);border-radius:6px;font-size:12px;outline:none;flex-shrink:0;';
      tlSearchInput.addEventListener('input', function() { tlSearch = this.value; debouncedRenderTimelineTable(); });
      tlSearchInput.addEventListener('compositionstart', function() { tlSearchComposing = true; });
      tlSearchInput.addEventListener('compositionend', function() { tlSearchComposing = false; tlSearch = this.value; debouncedRenderTimelineTable(); });
      tlSearchInput.addEventListener('keydown', function(e) { if (e.key === 'Escape') { this.value = ''; tlSearch = ''; renderTimelineTable(); } });
    }
    tlSearchInput.value = tlSearch;
    _tlSlot.replaceWith(tlSearchInput);
    if (_tlHadFocus) tlSearchInput.focus();
  }
}

// 时间线表格视图：快速筛选切换（再次点击同一档位 = 取消，null = 全部）
function setTlDateFilter(type) {
  tlDateFilter = (tlDateFilter === type) ? null : type;
  if (tlDateFilter) tlDoneFilter = false;   // 与已完成筛选互斥
  renderTimelineTable();
}

// 时间线表格视图：类型筛选切换（再次点击同一类型 = 取消，null = 全部）
function setTlTableTypeFilter(type) {
  tlTableTypeFilter = (tlTableTypeFilter === type) ? null : type;
  renderTimelineTable();
}

// 时间线表格视图：已完成筛选切换（与日期筛选互斥——激活一方自动关闭另一方）
function setTlDoneFilter() {
  tlDoneFilter = !tlDoneFilter;
  if (tlDoneFilter) tlDateFilter = null;   // 日期档位内部已排除 done，同时开必得 0 条
  renderTimelineTable();
}

// 时间线表格视图：实体筛选切换
// 再次点击已选中的 KR → 回退到其所属 Object（上钻一级），不直接清空
// 再次点击已选中的 Object → 取消选中（真正清空）
// 游离 KR（无上级 Object）再次点击 → 取消选中
function toggleTlTableEntityFilter(eid) {
  if (tlEntityFilters === eid) {
    const t = tasks.find(x => x.id === eid);
    if (t && t.type === 'kr') {
      const ownerObj = nearestObjectIdOf(t);
      tlEntityFilters = ownerObj || null;
    } else {
      tlEntityFilters = null;
    }
  } else {
    tlEntityFilters = eid;
  }
  renderTimelineTable();
}

function toggleBoardEntity(eid) {
  boardEntityFilters = (boardEntityFilters === eid) ? null : eid;
  renderBoard();
}
function toggleBoardGroup(header) {
  const body = header.nextElementSibling;
  const arrow = header.querySelector('.board-collapse-icon');
  if (!body || !arrow) return;
  if (body.style.display === 'none') {
    body.style.display = '';
    arrow.classList.remove('collapsed');
  } else {
    body.style.display = 'none';
    arrow.classList.add('collapsed');
  }
}

// ============ HABITS TRACKING ============
let habitsData = [];
let habitCheckins = {};

function initHabits() {
  const savedHabits = localStorage.getItem('ai-task-lens-habits');
  if (savedHabits) {
    habitsData = JSON.parse(savedHabits);
  } else {
    habitsData = [
      { id: 1, name: '不吃甜食', color: 'hsl(142 60% 35%)', sort_order: 1, is_active: true },
      { id: 2, name: '健身', color: 'hsl(142 60% 35%)', sort_order: 2, is_active: true },
      { id: 3, name: '每日输出一个观点', color: 'hsl(25 80% 50%)', sort_order: 3, is_active: true },
      { id: 4, name: '每日处理邮件', color: 'hsl(330 81% 60%)', sort_order: 4, is_active: true },
    ];
    saveHabits();
  }
  const savedCheckins = localStorage.getItem('ai-task-lens-habit-checkins');
  if (savedCheckins) {
    habitCheckins = JSON.parse(savedCheckins);
  } else {
    habitCheckins = {};
  }
}

function saveHabits() {
  localStorage.setItem('ai-task-lens-habits', JSON.stringify(habitsData));
}

function saveHabitCheckins() {
  localStorage.setItem('ai-task-lens-habit-checkins', JSON.stringify(habitCheckins));
}

function toggleHabitCheckin(habitId, dateStr) {
  const key = `${habitId}_${dateStr}`;
  if (habitCheckins[key]) {
    delete habitCheckins[key];
  } else {
    habitCheckins[key] = { habit_id: habitId, checkin_date: dateStr, is_checked: true };
  }
  saveHabitCheckins();
  renderHabits();
}

function addHabit(name, color) {
  const newId = habitsData.length > 0 ? Math.max(...habitsData.map(h => h.id)) + 1 : 1;
  habitsData.push({
    id: newId,
    name: name,
    color: color || `hsl(${Math.random() * 360} 70% 50%)`,
    sort_order: habitsData.length + 1,
    is_active: true
  });
  saveHabits();
  renderHabits();
}

function deleteHabit(id) {
  habitsData = habitsData.filter(h => h.id !== id);
  Object.keys(habitCheckins).forEach(key => {
    if (key.startsWith(`${id}_`)) {
      delete habitCheckins[key];
    }
  });
  saveHabits();
  saveHabitCheckins();
  renderHabits();
}

function renderHabits() {
  const el = document.getElementById('view-habits');
  if (!el) return;
  
  const activeHabits = habitsData.filter(h => h.is_active);
  const year = new Date().getFullYear();
  const today = new Date();
  
  const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  const weekDays = ['一', '二', '三', '四', '五', '六', '日'];
  
  const firstDay = new Date(year, 0, 1);
  const firstDayOfWeek = firstDay.getDay();
  const startOffset = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
  
  const grid = [];
  for (let i = 0; i < 7; i++) {
    grid[i] = [];
  }
  
  let weekIndex = 0;
  
  for (let i = 0; i < startOffset; i++) {
    for (let j = 0; j < 7; j++) {
      grid[j][weekIndex] = null;
    }
    weekIndex++;
  }
  
  for (let i = 0; i < 365; i++) {
    const d = new Date(year, 0, 1 + i);
    const dayOfWeek = d.getDay();
    const rowIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    
    grid[rowIndex][weekIndex] = {
      date: d,
      dateStr: formatDateLocal(d),
      month: d.getMonth(),
      isFuture: d > today
    };
    
    if (rowIndex === 6) {
      weekIndex++;
    }
  }
  
  const totalWeeks = weekIndex;
  
  for (let j = weekIndex; j < 53; j++) {
    for (let i = 0; i < 7; i++) {
      grid[i][j] = null;
    }
  }
  
  const monthLabels = [];
  let lastMonth = -1;
  
  for (let weekIdx = 0; weekIdx < totalWeeks; weekIdx++) {
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      if (grid[dayIdx][weekIdx]) {
        const month = grid[dayIdx][weekIdx].month;
        if (month !== lastMonth) {
          monthLabels.push({ month: month, week: weekIdx });
          lastMonth = month;
        }
        break;
      }
    }
  }
  
  let monthsHTML = '';
  monthLabels.forEach((ml, idx) => {
    const nextWeek = idx < monthLabels.length - 1 ? monthLabels[idx + 1].week : totalWeeks;
    const span = nextWeek - ml.week;
    monthsHTML += `<div class="heatmap-month-label" style="grid-column: ${ml.week + 1} / span ${span};">${months[ml.month]}</div>`;
  });
  
  let habitsHTML = '';
  activeHabits.forEach(habit => {
    let checkedCount = 0;
    let rowsHTML = '';
    
    for (let rowIdx = 0; rowIdx < 7; rowIdx++) {
      let cellsHTML = '';
      for (let colIdx = 0; colIdx < totalWeeks; colIdx++) {
        const day = grid[rowIdx][colIdx];
        if (!day) {
          cellsHTML += '<div class="heatmap-cell empty"></div>';
        } else {
          const isChecked = habitCheckins[`${habit.id}_${day.dateStr}`];
          if (isChecked) checkedCount++;
          const opacity = day.isFuture ? 0.3 : 1;
          
          cellsHTML += `<div class="heatmap-cell ${isChecked ? 'checked' : ''}" 
            style="background: ${isChecked ? habit.color : '#E5E7EB'}; opacity: ${opacity}; cursor: ${day.isFuture ? 'not-allowed' : 'pointer'};"
            onclick="${day.isFuture ? '' : `toggleHabitCheckin(${habit.id}, '${day.dateStr}')`}"
            title="${habit.name}\n${day.dateStr} ${isChecked ? '✓ 已打卡' : '点击打卡'}"></div>`;
        }
      }
      rowsHTML += `<div class="heatmap-row">${cellsHTML}</div>`;
    }
    
    const daysInYear = Math.min(Math.floor((today - firstDay) / (1000 * 60 * 60 * 24)) + 1, 365);
    const completionRate = daysInYear > 0 ? Math.round((checkedCount / daysInYear) * 100) : 0;
    
    const todayStr = formatDateLocal(new Date());
    const isTodayChecked = habitCheckins[`${habit.id}_${todayStr}`];
    
    habitsHTML += `
      <div class="habit-row">
        <div class="habit-info">
          <div class="habit-color-indicator" style="background: ${habit.color}"></div>
          <span class="habit-name">${habit.name}</span>
          <span class="habit-stats">${checkedCount}/${daysInYear}天 (${completionRate}%)</span>
          <button class="habit-today-btn ${isTodayChecked ? 'checked' : ''}" 
            onclick="toggleHabitCheckin(${habit.id}, '${todayStr}')">
            ${isTodayChecked ? '✅ 今日已打卡' : '📝 今日打卡'}
          </button>
        </div>
        <div class="habit-heatmap-grid">
          <div class="heatmap-months-grid">${monthsHTML}</div>
          <div class="heatmap-body">
            <div class="heatmap-weekdays">
              ${weekDays.map(d => `<div class="heatmap-weekday">${d}</div>`).join('')}
            </div>
            <div class="heatmap-grid-container">${rowsHTML}</div>
          </div>
        </div>
        <button class="habit-delete-btn" onclick="deleteHabit(${habit.id})" title="删除习惯">🗑</button>
      </div>
    `;
  });
  
  el.innerHTML = `
    <div class="habits-container">
      <div class="habits-header">
        <h2>🔥 习惯追踪热力图</h2>
        <div class="habits-actions">
          <button class="btn btn-primary" onclick="showAddHabitModal()">+ 添加习惯</button>
          <button class="btn" onclick="exportHabitsCSV()">📤 导出CSV</button>
          <button class="btn" onclick="importHabitsCSV()">📥 导入CSV</button>
          <button class="btn btn-outline" onclick="exportHabitsData()">📤 导出JSON</button>
          <button class="btn btn-outline" onclick="importHabitsData()">📥 导入JSON</button>
        </div>
      </div>
      <div class="habits-list">${habitsHTML}</div>
      <div class="habits-legend">
        <span>少</span>
        <div class="legend-cell" style="background:#E5E7EB;"></div>
        <div class="legend-cell" style="background:#D1FAE5;"></div>
        <div class="legend-cell" style="background:#34D399;"></div>
        <span>多</span>
      </div>
    </div>
  `;
}

function showAddHabitModal() {
  const name = prompt('请输入习惯名称：');
  if (!name) return;
  const colors = ['hsl(142 60% 35%)', 'hsl(25 80% 50%)', 'hsl(330 81% 60%)', 'hsl(217 91% 60%)', 'hsl(280 65% 55%)', 'hsl(194 97% 37%)'];
  addHabit(name, colors[habitsData.length % colors.length]);
}

function exportHabitsData() {
  const data = {
    version: '1.0',
    exportDate: new Date().toISOString(),
    habits: habitsData,
    checkins: habitCheckins
  };
  
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `习惯数据_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('✅ JSON数据已导出', 'success');
}

function importHabitsData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.txt';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
      try {
        const content = event.target.result;
        const data = JSON.parse(content);
        
        if (!data.habits || !data.checkins) {
          showToast('❌ 无效的导入文件格式', 'error');
          return;
        }
        
        if (confirm(`确定要导入吗？这将覆盖当前的${data.habits.length}个习惯和${Object.keys(data.checkins).length}条打卡记录。`)) {
          habitsData = data.habits;
          habitCheckins = data.checkins;
          saveHabits();
          saveHabitCheckins();
          renderHabits();
          showToast('✅ JSON数据已导入', 'success');
        }
      } catch (err) {
        showToast('❌ 导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function formatDateLocal(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 导出用日期格式：YYYY/M/D（无前导零，Excel 友好）
function formatDateForExport(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const y = parts[0];
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  return `${y}/${m}/${d}`;
}

// 导入用日期解析：兼容 2026/1/1 与 2026-01-01 → 规范化为 YYYY-MM-DD
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

// 自动建习惯时的颜色循环
const HABIT_AUTO_COLORS = [
  'hsl(142 60% 35%)', 'hsl(25 80% 50%)', 'hsl(330 81% 60%)',
  'hsl(217 91% 60%)', 'hsl(280 65% 55%)', 'hsl(194 97% 37%)',
  'hsl(48 96% 53%)',  'hsl(4 90% 58%)'
];
function pickAutoHabitColor(existingCount) {
  return HABIT_AUTO_COLORS[existingCount % HABIT_AUTO_COLORS.length];
}

// ── 宽表 CSV 导出（单文件 · 只导出有打卡的日期 · YYYY/M/D · 是/否）──
function exportHabitsCSV() {
  const activeHabits = habitsData
    .filter(h => h.is_active)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  if (activeHabits.length === 0) {
    showToast('❌ 没有启用中的习惯，无法导出', 'error');
    return;
  }

  // 收集所有 is_checked=true 且对应习惯启用中的日期
  const activeIds = new Set(activeHabits.map(h => h.id));
  const dateSet = new Set();
  Object.values(habitCheckins).forEach(ck => {
    if (ck && ck.is_checked && ck.checkin_date && activeIds.has(ck.habit_id)) {
      dateSet.add(ck.checkin_date);
    }
  });
  const sortedDates = Array.from(dateSet).sort();

  // 表头
  const headerCells = ['日期', ...activeHabits.map(h => h.name)];
  const rows = [headerCells.join(',')];

  // 每天一行
  sortedDates.forEach(dateStr => {
    const row = [formatDateForExport(dateStr)];
    activeHabits.forEach(h => {
      const key = `${h.id}_${dateStr}`;
      const rec = habitCheckins[key];
      row.push(rec && rec.is_checked ? '是' : '否');
    });
    rows.push(row.join(','));
  });

  const csv = rows.join('\r\n') + '\r\n';
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
  a.download = `每日习惯_${ymd}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  if (sortedDates.length === 0) {
    showToast('⚠️ 没有任何打卡记录，导出了仅含表头的空文件', 'info');
  } else {
    showToast(`✅ 已导出 ${sortedDates.length} 天 × ${activeHabits.length} 个习惯`, 'success');
  }
}

function _exportHabitsCSV_OLD_UNUSED() {
  const year = new Date().getFullYear();
  const activeHabits = habitsData.filter(h => h.is_active);
  const habitNames = activeHabits.map(h => h.name);
  
  let csv = '日期,' + habitNames.join(',') + '\n';
  
  for (let i = 0; i < 365; i++) {
    const d = new Date(year, 0, 1 + i);
    const dateStr = formatDateLocal(d);
    let row = dateStr;
    
    activeHabits.forEach(habit => {
      const isChecked = habitCheckins[`${habit.id}_${dateStr}`];
      row += ',' + (isChecked ? '是' : '否');
    });
    
    csv += row + '\n';
  }
  
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `所有习惯-${year}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('✅ CSV数据已导出', 'success');
}

// ── 宽表 CSV 导入（upsert · 未见习惯自动创建）──
function importHabitsCSV() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,text/csv';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
      try {
        let content = event.target.result;
        content = content.replace(/^\uFEFF/, '');
        const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length < 2) {
          showToast('❌ CSV 内容为空或只有表头', 'error');
          return;
        }

        // 表头解析
        const header = lines[0].split(',').map(c => c.trim());
        if (!header[0] || (header[0] !== '日期' && header[0].toLowerCase() !== 'date')) {
          showToast('❌ CSV 格式错误：第一列必须是「日期」', 'error');
          return;
        }
        const habitNames = header.slice(1).map(c => c.trim()).filter(c => c.length > 0);
        if (habitNames.length === 0) {
          showToast('❌ CSV 中没有习惯列', 'error');
          return;
        }

        // 为每个列名解析 habitId：已有→复用，未见过→自动新建
        let createdCount = 0;
        const colHabitIds = habitNames.map(name => {
          const existing = habitsData.find(x => x.name === name);
          if (existing) return existing.id;
          const newId = habitsData.length > 0 ? Math.max(...habitsData.map(x => x.id)) + 1 : 1;
          const newHabit = {
            id: newId,
            name: name,
            color: pickAutoHabitColor(habitsData.length),
            sort_order: habitsData.length + 1,
            is_active: true
          };
          habitsData.push(newHabit);
          createdCount++;
          return newId;
        });

        // 数据行：upsert habitCheckins
        let upsertRows = 0;
        let checkedTrue = 0;
        for (let i = 1; i < lines.length; i++) {
          const cells = lines[i].split(',').map(c => c.trim());
          const dateStr = parseDateFromImport(cells[0]);
          if (!dateStr) continue;

          for (let j = 0; j < colHabitIds.length; j++) {
            const raw = (cells[j + 1] || '').trim();
            const v = raw.toLowerCase();
            let isChecked;
            if (v === '是' || v === '1' || v === 'true' || v === 'yes' || v === 'y') {
              isChecked = true;
            } else if (v === '否' || v === '0' || v === 'false' || v === 'no' || v === 'n' || v === '') {
              isChecked = false;
            } else {
              continue; // 未知值跳过
            }
            const habitId = colHabitIds[j];
            const key = `${habitId}_${dateStr}`;
            if (isChecked) {
              habitCheckins[key] = { habit_id: habitId, checkin_date: dateStr, is_checked: true };
              checkedTrue++;
            } else {
              delete habitCheckins[key];
            }
          }
          upsertRows++;
        }

        saveHabits();
        saveHabitCheckins();
        renderHabits();

        const parts = [`✅ 导入 ${upsertRows} 天`];
        if (createdCount > 0) parts.push(`新建 ${createdCount} 个习惯`);
        parts.push(`打卡=是 ${checkedTrue} 条`);
        showToast(parts.join('，'), 'success');
      } catch (err) {
        console.error('[importHabitsCSV]', err);
        showToast('❌ 导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file, 'utf-8');
  };
  input.click();
}

function _importHabitsCSV_OLD_UNUSED() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
      try {
        let content = event.target.result;
        content = content.replace(/^\uFEFF/, '');
        const lines = content.trim().split('\n');
        if (lines.length < 2) {
          showToast('❌ CSV文件内容为空', 'error');
          return;
        }
        
        const header = lines[0].split(',').map(cell => cell.trim());
        if (header[0] !== '日期') {
          showToast('❌ CSV格式错误：第一列必须是"日期"', 'error');
          return;
        }
        
        const habitNames = header.slice(1);
        const colors = ['hsl(142 60% 35%)', 'hsl(25 80% 50%)', 'hsl(330 81% 60%)', 'hsl(217 91% 60%)', 'hsl(280 65% 55%)', 'hsl(194 97% 37%)'];
        
        if (confirm(`确定要导入吗？这将覆盖当前的${habitNames.length}个习惯和${lines.length - 1}天的打卡记录。`)) {
          habitsData = [];
          habitCheckins = {};
          
          habitNames.forEach((name, idx) => {
            habitsData.push({
              id: idx + 1,
              name: name.trim(),
              color: colors[idx % colors.length],
              sort_order: idx + 1,
              is_active: true
            });
          });
          
          for (let i = 1; i < lines.length; i++) {
            const cells = lines[i].split(',').map(cell => cell.trim());
            const dateStr = cells[0];
            
            for (let j = 1; j < cells.length && j <= habitsData.length; j++) {
              const habitId = j;
              const value = cells[j];
              const isChecked = value === '是';
              
              if (isChecked) {
                habitCheckins[`${habitId}_${dateStr}`] = {
                  habit_id: habitId,
                  checkin_date: dateStr,
                  is_checked: true
                };
              }
            }
          }
          
          saveHabits();
          saveHabitCheckins();
          renderHabits();
          showToast('✅ CSV数据已导入', 'success');
        }
      } catch (err) {
        showToast('❌ 导入失败：' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ============ RECURRING TASKS (周期任务 R3.1) ============
let _recurAutoDates = new Set();   // 规则自动生成的日期（改规则时重置）
let _recurManualDates = new Set(); // 手选添加的日期（改规则时保留）
let miniCalYear = 0, miniCalMonth = 0;  // 迷你月历当前年月

const RECUR_WEEKDAYS = [
  { v: 1, label: '周一' }, { v: 2, label: '周二' }, { v: 3, label: '周三' },
  { v: 4, label: '周四' }, { v: 5, label: '周五' }, { v: 6, label: '周六' }, { v: 7, label: '周日' }
];

/** 当前全集 = 规则 ∪ 手选（去重升序数组） */
function _recurDateList() {
  return Array.from(new Set([..._recurAutoDates, ..._recurManualDates])).sort();
}

/** 按规则生成周期日期集合（纯函数，可测）。
 *  rule: {freq:'daily'|'weekly'|'monthly', interval:Number, weekdays:[1..7], dayOfMonth:Number}
 *  startDate: 'YYYY-MM-DD' | Date；endDate 缺省时生成到 startDate+90 天
 *  返回 'YYYY-MM-DD' 数组（升序） */
function generateRecurringDates(rule, startDate, endDate) {
  if (!rule || !startDate) return [];
  var freq = rule.freq || 'daily';
  var interval = Math.max(1, parseInt(rule.interval) || 1);
  var start = new Date(String(startDate).slice(0, 10) + 'T00:00:00');
  if (isNaN(start.getTime())) return [];
  var end = endDate ? new Date(String(endDate).slice(0, 10) + 'T00:00:00') : new Date(start);
  if (isNaN(end.getTime())) return [];
  if (!endDate) end.setDate(end.getDate() + 90);
  if (end < start) return [];

  var out = [];
  var cur = new Date(start);
  var startWd = (start.getDay() + 6) % 7 + 1; // 起始日星期（周一=1..周日=7）
  var guard = 0;
  while (cur <= end && guard < 2000) {
    guard++;
    var y = cur.getFullYear(), m = cur.getMonth(), d = cur.getDate();
    if (freq === 'daily') {
      out.push(pad2(y) + '-' + pad2(m + 1) + '-' + pad2(d));
      cur.setDate(d + interval);
    } else if (freq === 'weekly') {
      var wd = (cur.getDay() + 6) % 7 + 1; // 周一=1..周日=7
      var weekdays = Array.isArray(rule.weekdays) && rule.weekdays.length ? rule.weekdays : [startWd];
      if (weekdays.indexOf(wd) !== -1) {
        out.push(pad2(y) + '-' + pad2(m + 1) + '-' + pad2(d));
      }
      cur.setDate(d + 1);
    } else if (freq === 'monthly') {
      var dom = Math.max(1, parseInt(rule.dayOfMonth) || 1);
      var dim = new Date(y, m + 1, 0).getDate(); // 当月天数
      if (dom <= dim) {
        // 该月有 dom 日：把 cur 对准 dom 日检查
        cur.setDate(dom);
        if (cur <= end) {
          if (cur >= start) out.push(pad2(y) + '-' + pad2(m + 1) + '-' + pad2(dom));
          cur.setDate(1);
          cur.setMonth(m + 1);
        } else {
          break; // 已超出 end
        }
      } else {
        // 该月无 dom 日（如 31 号跳过 2 月），跳到下月 1 号
        cur.setDate(1);
        cur.setMonth(m + 1);
      }
    }
  }
  return out;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/** 频率选择 → 星期/日号选择器显隐 */
function _syncRecurFreqUI() {
  if (!document.getElementById('recur-freq')) return;
  var freq = document.getElementById('recur-freq').value;
  var wdEl = document.getElementById('recur-weekdays');
  var domEl = document.getElementById('recur-dayofmonth');
  if (wdEl) wdEl.style.display = freq === 'weekly' ? 'inline' : 'none';
  if (domEl) domEl.style.display = freq === 'monthly' ? 'inline' : 'none';
}

/** 从表单读取周期规则对象（批量创建时用于 generateRecurringDates） */
function _readRecurRuleFromForm() {
  var freqEl = document.getElementById('recur-freq');
  if (!freqEl) return null;
  var freq = freqEl.value;
  var rule = { freq: freq, interval: 1 };
  if (freq === 'weekly') {
    rule.weekdays = Array.from(document.querySelectorAll('.recur-wd:checked')).map(function(cb) { return parseInt(cb.value); });
    if (!rule.weekdays.length) rule.weekdays = [1];
  } else if (freq === 'monthly') {
    rule.dayOfMonth = parseInt(document.getElementById('recur-dom').value) || 1;
  }
  return rule;
}

/** 手动触发：按当前频率规则生成 auto 日期（manual 保留）。默认不自动生成，由用户点按钮触发 */
function _applyRecurRule() {
  _syncRecurFreqUI();
  if (!document.getElementById('task-recurring')) return;
  if (!document.getElementById('task-recurring').checked) return;
  var rule = _readRecurRuleFromForm();
  if (!rule) return;
  var startVal = document.getElementById('task-deadline').value || new Date().toISOString().slice(0, 10);
  _recurAutoDates = new Set(generateRecurringDates(rule, startVal));
  renderMiniCalendar();
  _renderRecurChips();
}

/** 迷你月历渲染（内嵌于编辑弹窗） */
function renderMiniCalendar() {
  var el = document.getElementById('recur-minical');
  if (!el) return;
  if (!miniCalYear) {
    var now = new Date();
    miniCalYear = now.getFullYear();
    miniCalMonth = now.getMonth();
  }
  var monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
  var weekdays = ['一','二','三','四','五','六','日'];
  var firstDay = new Date(miniCalYear, miniCalMonth, 1);
  var startOffset = (firstDay.getDay() + 6) % 7;
  var daysInMonth = new Date(miniCalYear, miniCalMonth + 1, 0).getDate();
  var gridStart = new Date(miniCalYear, miniCalMonth, 1 - startOffset);
  var todayStr = formatDateLocal(new Date());

  var cellsHTML = '';
  for (var i = 0; i < 42; i++) {
    var d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    var dateStr = formatDateLocal(d);
    var isOther = d.getMonth() !== miniCalMonth;
    var isToday = dateStr === todayStr;
    var isSel = _recurAutoDates.has(dateStr) || _recurManualDates.has(dateStr);
    var isAuto = _recurAutoDates.has(dateStr);
    cellsHTML += '<div class="mini-cal-day' +
      (isOther ? ' mini-cal-day-other' : '') +
      (isToday ? ' mini-cal-day-today' : '') +
      (isSel ? ' mini-selected' : '') +
      (isAuto ? ' mini-auto' : '') +
      '" onclick="toggleMiniDate(\'' + dateStr + '\')" title="' + (isSel ? '点击移除' : '点击加入') + '">' +
      d.getDate() + '</div>';
  }

  el.innerHTML =
    '<div class="mini-cal">' +
      '<div class="mini-cal-header">' +
        '<button type="button" class="mini-cal-nav" onclick="miniCalShift(-1)">◀</button>' +
        '<span class="mini-cal-title">' + miniCalYear + '年' + monthNames[miniCalMonth] + '</span>' +
        '<button type="button" class="mini-cal-nav" onclick="miniCalShift(1)">▶</button>' +
        '<button type="button" class="mini-cal-today" onclick="miniCalGoToday()">今天</button>' +
      '</div>' +
      '<div class="mini-cal-weekdays">' + weekdays.map(function(w) { return '<div class="mini-cal-wd">' + w + '</div>'; }).join('') + '</div>' +
      '<div class="mini-cal-grid">' + cellsHTML + '</div>' +
    '</div>';
}

function miniCalShift(delta) {
  miniCalMonth += delta;
  if (miniCalMonth < 0) { miniCalMonth = 11; miniCalYear--; }
  else if (miniCalMonth > 11) { miniCalMonth = 0; miniCalYear++; }
  renderMiniCalendar();
}

function miniCalGoToday() {
  var now = new Date();
  miniCalYear = now.getFullYear();
  miniCalMonth = now.getMonth();
  renderMiniCalendar();
}

/** 点选/反选一个日期：auto 中 → 从 auto 移除（规则重算后恢复）；否则加入 manual */
function toggleMiniDate(dateStr) {
  if (_recurAutoDates.has(dateStr)) {
    _recurAutoDates.delete(dateStr);
  } else if (_recurManualDates.has(dateStr)) {
    _recurManualDates.delete(dateStr);
  } else {
    _recurManualDates.add(dateStr);
  }
  renderMiniCalendar();
  _renderRecurChips();
}

/** 已选日期 chips 渲染（可删除） */
function _renderRecurChips() {
  var el = document.getElementById('recur-chips');
  if (!el) return;
  var dates = _recurDateList();
  if (!dates.length) {
    el.innerHTML = '<div class="recur-chips-empty">暂未选择日期：由频率规则自动生成，或点击上方月历手动增删</div>';
    return;
  }
  el.innerHTML = '<div class="recur-chips-title">已选日期（' + dates.length + ' 个）</div><div class="recur-chips-list">' +
    dates.map(function(ds) {
      return '<span class="recur-chip">' + ds +
        '<button type="button" class="recur-chip-del" onclick="toggleMiniDate(\'' + ds + '\')" title="移除">×</button></span>';
    }).join('') + '</div>';
}

/** 清空全部周期状态（取消勾选/弹窗关闭时） */
function _resetRecurringState() {
  _recurAutoDates = new Set();
  _recurManualDates = new Set();
}

/** 查看同批周期任务 */
function viewRecurringBatch(groupId) {
  var batch = tasks.filter(function(t) { return t.recurringGroupId === groupId; });
  if (!batch.length) { showToast('未找到同批任务', 'warn'); return; }
  var lines = batch.map(function(t) {
    return t.deadline + ' | ' + (t.title || '(无标题)') + ' | ' + (t.status || 'todo');
  });
  alert('同批周期任务（共 ' + batch.length + ' 个）:\n\n' + lines.join('\n'));
}

/** 批量删除同批周期任务 */
function deleteRecurringBatch(groupId) {
  var batch = tasks.filter(function(t) { return t.recurringGroupId === groupId; });
  if (!batch.length) { showToast('未找到同批任务', 'warn'); return; }
  if (!confirm('确认删除同批 ' + batch.length + ' 个任务？此操作不可撤销。')) return;
  // 收集要删除的 id
  var idsToDelete = new Set(batch.map(function(t) { return t.id; }));
  // 清理 parent.children 引用
  tasks.forEach(function(t) {
    if (t.children) t.children = t.children.filter(function(c) { return !idsToDelete.has(c); });
  });
  tasks = tasks.filter(function(t) { return !idsToDelete.has(t.id); });
  saveData();
  renderAll();
  closeTaskModal(true);
  showToast('已删除 ' + batch.length + ' 个任务', 'success');
}

function toggleRecurringUI() {
  var cb = document.getElementById('task-recurring');
  var panel = document.getElementById('recurring-panel');
  var isOn = cb.checked;
  panel.style.display = isOn ? 'block' : 'none';
  if (isOn) {
    // 原则1：开始日期 = 截止日期（锁定同步）
    var deadlineEl = document.getElementById('task-deadline');
    var startEl = document.getElementById('task-startdate');
    if (deadlineEl.value && startEl.value !== deadlineEl.value) startEl.value = deadlineEl.value;
    // 不自动生成日期（R3.1 调整）：让用户自己在迷你月历上勾选，或点「按规则生成」
    _resetRecurringState();
    renderMiniCalendar();
    _renderRecurChips();
  } else {
    _resetRecurringState();
  }
}

/** 开始=截止联动：周期态下任一改动同步另一字段（不重算日期——默认手选模式） */
function syncRecurringDates(src) {
  if (!document.getElementById('task-recurring') || !document.getElementById('task-recurring').checked) return;
  var deadlineEl = document.getElementById('task-deadline');
  var startEl = document.getElementById('task-startdate');
  if (src === 'deadline') startEl.value = deadlineEl.value;
  else deadlineEl.value = startEl.value;
}

// ============ DAILY QUOTES ============
let quotesData = [];
let currentQuoteIds = [];
let quoteEditingId = null;   // R3.32：当前正在编辑的金句 id（null = 新增模式）

function initQuotes() {
  const saved = localStorage.getItem('ai-task-lens-quotes');
  if (saved) {
    quotesData = JSON.parse(saved);
  } else {
    quotesData = [];
  }
}

function saveQuotes() {
  localStorage.setItem('ai-task-lens-quotes', JSON.stringify(quotesData));
}

function addQuote(text, author) {
  var newId = quotesData.length > 0 ? Math.max.apply(null, quotesData.map(function(q) { return q.id; })) + 1 : 1;
  quotesData.push({ id: newId, text: text.trim(), author: (author || '').trim() });
  saveQuotes();
}

function deleteQuote(id) {
  quotesData = quotesData.filter(function(q) { return q.id !== id; });
  if (quoteEditingId === id) quoteEditingId = null;   // 删除正在编辑的金句时退出编辑模式
  saveQuotes();
  currentQuoteIds = currentQuoteIds.filter(function(qid) { return qid !== id; });
  renderQuotesPanel();
  renderQuotesManagementModal();
}

// R3.32：进入编辑模式——回填表单，表单按钮切换为「保存修改」+「取消」
function startEditQuote(id) {
  var q = quotesData.find(function(x) { return x.id === id; });
  if (!q) return;
  quoteEditingId = id;
  var textEl = document.getElementById('quote-add-text');
  var authorEl = document.getElementById('quote-add-author');
  if (textEl) textEl.value = q.text;
  if (authorEl) authorEl.value = q.author || '';
  var form = document.getElementById('quote-add-form-actions');
  if (form) {
    form.innerHTML =
      '<button class="btn btn-primary btn-sm" onclick="handleAddQuote()">💾 保存修改</button>' +
      '<button class="btn btn-outline btn-sm" onclick="cancelEditQuote()" style="margin-left:8px;">取消</button>';
  }
  if (textEl) textEl.focus();
}

// R3.32：退出编辑模式——清空表单，按钮恢复「添加金句」
function cancelEditQuote() {
  quoteEditingId = null;
  var textEl = document.getElementById('quote-add-text');
  var authorEl = document.getElementById('quote-add-author');
  if (textEl) textEl.value = '';
  if (authorEl) authorEl.value = '';
  var form = document.getElementById('quote-add-form-actions');
  if (form) {
    form.innerHTML = '<button class="btn btn-primary btn-sm" onclick="handleAddQuote()">+ 添加金句</button>';
  }
}

function getRandomQuotes(count) {
  if (quotesData.length === 0) return [];
  var available = quotesData.filter(function(q) { return currentQuoteIds.indexOf(q.id) === -1; });
  var pool = available.length >= count ? available : quotesData.slice();
  var shuffled = pool.slice().sort(function() { return Math.random() - 0.5; });
  var picked = shuffled.slice(0, Math.min(count, pool.length));
  currentQuoteIds = picked.map(function(q) { return q.id; });
  return picked;
}

function renderQuotesPanel() {
  var container = document.getElementById('quotes-panel-container');
  if (!container) return;

  if (currentQuoteIds.length === 0) {
    getRandomQuotes(3);
  }

  var shown = quotesData.filter(function(q) { return currentQuoteIds.indexOf(q.id) !== -1; });

  if (quotesData.length === 0) {
    container.innerHTML =
      '<div class="quotes-panel">' +
        '<div class="quotes-panel-header">' +
          '<span class="quotes-panel-title">✨ 每日金句</span>' +
          '<div class="quotes-panel-actions">' +
            '<button class="btn btn-outline btn-sm" onclick="showQuotesModal()">管理</button>' +
          '</div>' +
        '</div>' +
        '<div class="quotes-empty">暂无金句，点击「管理」添加你喜欢的金句吧</div>' +
      '</div>';
    return;
  }

  var cards = shown.map(function(q) {
    return '<div class="quote-card">' +
      '<div class="quote-text">' + escapeHtml(q.text) + '</div>' +
      '<div class="quote-author">—— ' + escapeHtml(q.author || '佚名') + '</div>' +
    '</div>';
  }).join('');

  container.innerHTML =
    '<div class="quotes-panel">' +
      '<div class="quotes-panel-header">' +
        '<span class="quotes-panel-title">✨ 每日金句</span>' +
        '<div class="quotes-panel-actions">' +
          '<button class="btn btn-outline btn-sm" onclick="refreshQuotes()">🔄 换一批</button>' +
          '<button class="btn btn-outline btn-sm" onclick="showQuotesModal()">⚙ 管理</button>' +
        '</div>' +
      '</div>' +
      '<div class="quotes-grid">' + cards + '</div>' +
    '</div>';
}

function refreshQuotes() {
  currentQuoteIds = [];
  getRandomQuotes(3);
  renderQuotesPanel();
}

function showQuotesModal() {
  var overlay = document.getElementById('modal-quotes');
  if (!overlay) return;
  overlay.style.display = 'flex';
  renderQuotesManagementModal();
}

function closeQuotesModal() {
  var overlay = document.getElementById('modal-quotes');
  if (overlay) overlay.style.display = 'none';
}

function renderQuotesManagementModal() {
  var body = document.getElementById('quotes-mgmt-body');
  if (!body) return;

  var list = quotesData.map(function(q) {
    return '<div class="quote-mgmt-item">' +
      '<div style="flex:1;">' +
        '<div class="quote-mgmt-text">' + escapeHtml(q.text) + '</div>' +
        '<div class="quote-mgmt-author">—— ' + escapeHtml(q.author || '佚名') + '</div>' +
      '</div>' +
      '<button class="quote-mgmt-edit" onclick="startEditQuote(' + q.id + ')" title="编辑">✏️</button>' +
      '<button class="quote-mgmt-delete" onclick="deleteQuote(' + q.id + ')" title="删除">🗑</button>' +
    '</div>';
  }).join('');

  body.innerHTML =
    '<div class="quote-add-form">' +
      '<div class="form-field">' +
        '<input type="text" id="quote-add-text" placeholder="输入金句内容..." maxlength="200">' +
      '</div>' +
      '<div class="form-field">' +
        '<input type="text" id="quote-add-author" placeholder="作者/出处（可选）" maxlength="50">' +
      '</div>' +
      '<div id="quote-add-form-actions">' +
        '<button class="btn btn-primary btn-sm" onclick="handleAddQuote()">+ 添加金句</button>' +
      '</div>' +
    '</div>' +
    '<div>' + (list || '<div class="quotes-empty">暂无金句</div>') + '</div>';
}

function handleAddQuote() {
  var textEl = document.getElementById('quote-add-text');
  var authorEl = document.getElementById('quote-add-author');
  var text = textEl.value.trim();
  if (!text) {
    showToast('请输入金句内容', 'warn');
    textEl.focus();
    return;
  }
  var author = (authorEl.value || '').trim();
  if (quoteEditingId !== null) {
    // R3.32 编辑模式：更新既有金句
    quotesData = quotesData.map(function(q) { return q.id === quoteEditingId ? { id: q.id, text: text, author: author } : q; });
    quoteEditingId = null;
    saveQuotes();
    renderQuotesManagementModal();
    renderQuotesPanel();
    showToast('金句已更新', 'success');
  } else {
    addQuote(text, author);
    renderQuotesManagementModal();
    renderQuotesPanel();
    showToast('金句已添加', 'success');
  }
}

// ============ DEPENDENCY SELECTOR ============
let selectedDeps = new Set(); // 当前编辑任务已选的依赖 ID 集合
let selectedNexts = new Set(); // 当前编辑任务已选的后置 ID 集合

function onTypeChange() {
  const type = document.getElementById('task-type').value;
  const parentSelector = document.getElementById('parent-selector');
  const parentSearch = document.getElementById('parent-search');
  const parentChips = document.getElementById('parent-chips');
  const parentDropdown = document.getElementById('parent-dropdown');

  // 周期任务属性仅 task/schedule 可用：其他类型隐藏并复位
  const recToggleRow = document.getElementById('recurring-toggle-row');
  if (recToggleRow) {
    const allowed = (type === 'task' || type === 'schedule');
    recToggleRow.style.display = allowed ? '' : 'none';
    if (!allowed) {
      const recCb = document.getElementById('task-recurring');
      if (recCb && recCb.checked) {
        recCb.checked = false;
        toggleRecurringUI();
      }
    }
  }
  
  if (type === 'object') {
    parentSelector.style.display = 'none';
    document.getElementById('task-parent').value = '';
    return;
  }
  parentSelector.style.display = 'flex';
  
  const currentParentId = parseInt(document.getElementById('task-parent').value) || null;
  
  // 上级类型候选：单一来源 = ALLOWED_PARENTS（record/schedule/idea 为 '*' → 全部类型可挂）
  const allowed = ALLOWED_PARENTS[type];
  const parentTypes = allowed === '*' ? ['object', 'kr', 'target', 'task', 'record', 'schedule', 'idea'] : (allowed || ['object']);
  
  let candidates = tasks.filter(t => parentTypes.includes(t.type));
  
  if (editingTaskId) {
    const descendants = new Set();
    function collectDesc(id) { tasks.forEach(t => { if (t.parentId === id) { descendants.add(t.id); collectDesc(t.id); } }); }
    collectDesc(editingTaskId);
    candidates = candidates.filter(t => t.id !== editingTaskId && !descendants.has(t.id));
  }
  
  const existingChips = parentChips.querySelectorAll('.parent-chip');
  existingChips.forEach(chip => chip.remove());
  
  if (currentParentId) {
    const parentTask = tasks.find(t => t.id === currentParentId);
    if (parentTask) {
      const colors = PRIORITY_COLORS;
      const chip = document.createElement('span');
      chip.className = 'parent-chip';
      chip.innerHTML = '<span class="chip-dot" style="background:' + (colors[parentTask.priority]||'#9CA3AF') + ';"></span>' +
        '<span class="chip-title" title="' + parentTask.title + '">' + parentTask.title + '</span>' +
        '<span class="chip-del" data-parent="' + currentParentId + '">&times;</span>';
      chip.querySelector('.chip-del').addEventListener('click', function(e) {
        e.stopPropagation();
        document.getElementById('task-parent').value = '';
        onTypeChange();
        updateTaskPreview();
      });
      parentChips.insertBefore(chip, parentSearch);
    }
  }
  
  parentSearch.oninput = function() {
    const filter = parentSearch.value.toLowerCase().trim();
    const filtered = candidates.filter(t => {
      if (!filter) return true;
      return t.title.toLowerCase().indexOf(filter) !== -1;
    });
    
    if (filtered.length === 0) {
      parentDropdown.innerHTML = '<div class="parent-empty">未找到匹配的上级任务</div>';
      parentDropdown.classList.add('show');
      positionChipDropdown('parent-dropdown', 'parent-search', 'parent-selector');
    } else {
      parentDropdown.innerHTML = filtered.map(t => {
        const shortTitle = t.title.length > 20 ? t.title.slice(0, 19) + '…' : t.title;
        const typeTag = { object: '🎯', kr: '📊', target: '🎯', task: '✅', record: '📝', schedule: '📅', idea: '💡' }[t.type] || '';
        return '<div class="parent-option" data-parent="' + t.id + '">' +
          '<span class="priority-tag priority-' + t.priority + '" style="font-size:10px;">' + t.priority + '</span>' +
          '<span class="opt-title" title="' + t.title + '">' + typeTag + ' ' + shortTitle + '</span>' +
          (t.deadline ? '<span class="opt-tag">⏰ ' + t.deadline + '</span>' : '') +
          '</div>';
      }).join('');
      parentDropdown.classList.add('show');
      positionChipDropdown('parent-dropdown', 'parent-search', 'parent-selector');
      
      parentDropdown.querySelectorAll('.parent-option').forEach(opt => {
        opt.addEventListener('mousedown', function(e) {
          e.preventDefault();
          document.getElementById('task-parent').value = opt.dataset.parent;
          parentSearch.value = '';
          onTypeChange();
          parentSearch.focus();
          updateTaskPreview();
        });
      });
    }
    
    const closeHandler = function(e) {
      if (!parentSelector.contains(e.target)) {
        parentDropdown.classList.remove('show');
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(function() { document.addEventListener('click', closeHandler); }, 100);
  };
  
  parentChips.addEventListener('click', function(e) {
    if (!e.target.closest('.parent-chip')) {
      parentSearch.focus();
      if (!parentSearch.value.trim()) {
        parentDropdown.innerHTML = candidates.map(t => {
          const shortTitle = t.title.length > 20 ? t.title.slice(0, 19) + '…' : t.title;
          const typeTag = { object: '🎯', kr: '📊', target: '🎯', task: '✅', record: '📝', schedule: '📅', idea: '💡' }[t.type] || '';
          return '<div class="parent-option" data-parent="' + t.id + '">' +
            '<span class="priority-tag priority-' + t.priority + '" style="font-size:10px;">' + t.priority + '</span>' +
            '<span class="opt-title" title="' + t.title + '">' + typeTag + ' ' + shortTitle + '</span>' +
            (t.deadline ? '<span class="opt-tag">⏰ ' + t.deadline + '</span>' : '') +
            '</div>';
        }).join('');
        parentDropdown.classList.add('show');
        positionChipDropdown('parent-dropdown', 'parent-search', 'parent-selector');
        
        parentDropdown.querySelectorAll('.parent-option').forEach(opt => {
          opt.addEventListener('mousedown', function(e) {
            e.preventDefault();
            document.getElementById('task-parent').value = opt.dataset.parent;
            parentSearch.value = '';
            onTypeChange();
            parentSearch.focus();
            updateTaskPreview();
          });
        });
        
        const closeHandler = function(e) {
          if (!parentSelector.contains(e.target)) {
            parentDropdown.classList.remove('show');
            document.removeEventListener('click', closeHandler);
          }
        };
        setTimeout(function() { document.addEventListener('click', closeHandler); }, 100);
      }
    }
  });
}

function renderParentSelector(parentId, type) {
  const typeSel = document.getElementById('task-type');
  const parentSel = document.getElementById('task-parent');
  typeSel.value = type;
  parentSel.value = parentId || '';
  onTypeChange();
}

function quickCreateParent() {
  const type = document.getElementById('task-type').value;
  if (type === 'object') { alert('目标(Object)为顶级，无需上级'); return; }
  // 上级类型候选：单一来源 = ALLOWED_PARENTS（record/schedule/idea 为 '*' → 全部类型可挂）
  const allowed = ALLOWED_PARENTS[type];
  const parentTypeOptions = allowed === '*' ? ['object', 'kr', 'target', 'task', 'record', 'schedule', 'idea'] : (allowed || ['object']);
  const defaultParentType = parentTypeOptions[0];
  const parentLabel = TYPE_LABELS[defaultParentType] || defaultParentType;
  let newType = defaultParentType;
  if (parentTypeOptions.length > 1) {
    const choice = prompt(`可选择上级类型：\n${parentTypeOptions.map((t, i) => `${i+1}. ${TYPE_LABELS[t]}`).join('\n')}\n\n输入序号（默认1）：`);
    if (choice === null) return; // 取消
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < parentTypeOptions.length) newType = parentTypeOptions[idx];
  }
  const label = TYPE_LABELS[newType] || newType;
  const title = prompt(`请输入新建${label}的标题：`);
  if (!title || !title.trim()) return;
  // 直接创建，不走 addTask 避免 renderAll 干扰弹窗
  const newParent = {
    id: nextId++,
    timestamp: makeTimestamp(),
    type: newType,
    parentId: null,
    children: [],
    title: title.trim(),
    priority: DEFAULT_PRIORITY,
    status: 'todo',
    deadline: null,
    progress: 0,
    deps: [],
    next: [],
    tag: '',
    assignee: '',
    startDate: null,
    files: [],
    isMilestone: false,
    desc: '',
    createdAt: new Date().toISOString()
  };
  tasks.push(newParent);
  saveData();
  // 刷新上级下拉并选中新建的
  const parentSel = document.getElementById('task-parent');
  parentSel.value = newParent.id;
  onTypeChange();
  showToast(`已新建${label}：${title.trim()}`, 'success');
}

// 统一的 chip selector 渲染（参数化 dep/next 共用）
function renderChipSelector(config) {
  var chipsEl = document.getElementById(config.chipsId);
  var search = document.getElementById(config.searchId);
  var dropdown = document.getElementById(config.dropdownId);
  var hint = document.getElementById(config.hintId);
  var selectorEl = document.getElementById(config.selectorId);

  // 清空 chips
  var existingChips = chipsEl.querySelectorAll('.dep-chip');
  for (var i = 0; i < existingChips.length; i++) existingChips[i].remove();

  // 已选的放前面
  var ordered = Array.from(config.selectedSet);
  ordered.forEach(function(taskId) {
    var depTask = tasks.find(function(x) { return x.id === taskId; });
    if (!depTask) return;
    var colors = PRIORITY_COLORS;
    var chip = document.createElement('span');
    chip.className = 'dep-chip';
    chip.innerHTML = '<span class="chip-dot" style="background:' + (colors[depTask.priority]||'#9CA3AF') + ';"></span>' +
      '<span class="chip-title" title="' + depTask.title + '">' + depTask.title + '</span>' +
      '<span class="chip-del" data-dep="' + taskId + '">&times;</span>';
    chip.querySelector('.chip-del').addEventListener('click', function(e) {
      e.stopPropagation();
      config.selectedSet.delete(taskId);
      config.renderFn();
      updateTaskPreview();
    });
    chipsEl.insertBefore(chip, search);
  });

  hint.textContent = config.selectedSet.size > 0
    ? config.hintSelected.replace('{n}', config.selectedSet.size)
    : config.hintEmpty;

  // 搜索过滤
  var filter = (search.value || '').toLowerCase().trim();
  var candidates = tasks.filter(function(t) {
    if (editingTaskId && t.id === editingTaskId) return false;
    if (config.selectedSet.has(t.id)) return false;
    if (filter && t.title.toLowerCase().indexOf(filter) === -1) return false;
    return true;
  });

  if (candidates.length === 0) {
    dropdown.innerHTML = '<div class="dep-empty">未找到匹配的任务</div>';
    dropdown.classList.add('show');
    positionChipDropdown(config.dropdownId, config.searchId, config.selectorId);
  } else if (config.autoOpen || filter) {
    dropdown.innerHTML = candidates.map(function(t) {
      var shortTitle = t.title.length > 20 ? t.title.slice(0, 19) + '…' : t.title;
      return '<div class="dep-option" data-dep="' + t.id + '">' +
        '<span class="priority-tag priority-' + t.priority + '" style="font-size:10px;">' + t.priority + '</span>' +
        '<span class="opt-title" title="' + t.title + '">' + shortTitle + '</span>' +
        (t.deadline ? '<span class="opt-tag">⏰ ' + t.deadline + '</span>' : '') +
        '</div>';
    }).join('');
    dropdown.classList.add('show');
    positionChipDropdown(config.dropdownId, config.searchId, config.selectorId);

    dropdown.querySelectorAll('.dep-option').forEach(function(opt) {
      opt.addEventListener('mousedown', function(e) {
        e.preventDefault();
        config.selectedSet.add(parseInt(opt.dataset.dep));
        search.value = '';
        config.renderFn();
        search.focus();
        updateTaskPreview();
      });
    });
  } else {
    dropdown.classList.remove('show');
  }

  var closeHandler = function(e) {
    if (!selectorEl.contains(e.target)) {
      dropdown.classList.remove('show');
      document.removeEventListener('click', closeHandler);
    }
  };
  if (config.autoOpen || filter) {
    setTimeout(function() { document.addEventListener('click', closeHandler); }, 100);
  }
}

function renderDepSelector(autoOpen) {
  if (autoOpen === undefined) autoOpen = false;
  renderChipSelector({
    chipsId: 'dep-chips', searchId: 'dep-search', dropdownId: 'dep-dropdown',
    hintId: 'dep-hint', selectorId: 'dep-selector',
    selectedSet: selectedDeps,
    hintEmpty: '尚未选择依赖。此任务将独立存在，没有前置条件。',
    hintSelected: '已选择 {n} 个前置依赖任务',
    autoOpen: autoOpen,
    renderFn: renderDepSelector
  });
}

function renderNextSelector(autoOpen) {
  if (autoOpen === undefined) autoOpen = false;
  renderChipSelector({
    chipsId: 'next-chips', searchId: 'next-search', dropdownId: 'next-dropdown',
    hintId: 'next-hint', selectorId: 'next-selector',
    selectedSet: selectedNexts,
    hintEmpty: '尚未选择后置任务。此任务完成后不需要等待其他任务。',
    hintSelected: '已选择 {n} 个后置任务',
    autoOpen: autoOpen,
    renderFn: renderNextSelector
  });
}

// R3.34：编辑弹窗内「＋ 新建」——打开完整的新建任务弹窗（与时间线行内「+ 后置内容」同一窗口），
// 自动预填前置任务（当前编辑的任务）与开始时间（= 前置任务截止日期，由 addNextTask 处理）。
// 编辑已有任务时先静默保存当前修改（参照 navigateToEntity 的"先存再跳"语义）：
// saveTask 校验不通过或用户取消时返回 false，中止打开；保存成功后其内部已 closeTaskModal + renderAll，
// 延时再调 addNextTask 打开新建弹窗。新建未保存模式下当前任务尚无 id、无法作为前置锚点，提示先保存。
function quickCreateNextTask() {
  if (editingTaskId === null) {
    showToast('请先保存当前任务，再为它新建后置任务', 'warn');
    return;
  }
  var parentId = editingTaskId;
  var saved = saveTask();   // 内部成功时已 closeTaskModal(true)；失败/取消返回 false
  if (!saved) return;
  setTimeout(function() {
    addNextTask(parentId);  // 同一完整弹窗：selectedDeps 预填前置、开始时间预填前置截止日期
  }, 150);
}

// ── 文件选择器（关联文件管理系统）──
let selectedFiles = []; // [{fileId, name, path}]
let _fileDropdownOpen = false;
let _fileSearchTimer = null;
let _fileDDPage = 1;
let _fileDDTotal = 0;
let _fileDDKeyword = '';
let _fileDDLoading = false;
let _fileDDActiveIndex = -1;
const _FILE_DD_PAGE_SIZE = 50;
const _FILE_DD_MAX_H = 480;

function renderFileSelector(autoOpen) {
  const chips = document.getElementById('file-chips');
  const dropdown = document.getElementById('file-dropdown');
  const hint = document.getElementById('file-hint');
  if (!chips || !dropdown) return;
  // 保留搜索框
  const searchInput = document.getElementById('file-search');
  // 清空 chip
  Array.from(chips.querySelectorAll('.file-chip')).forEach(el => el.remove());
  selectedFiles.forEach((f, idx) => {
    const chip = document.createElement('span');
    chip.className = 'file-chip' + (isWebLink(f) ? ' web-link-chip' : '');
    const label = fileDisplayName(f);
    const canOpen = !!f.fileId;
    const linkIcon = isWebLink(f) ? '🔗' : '📄';
    const openButton = isWebLink(f)
      ? `<button type="button" class="file-chip-btn" data-act="link" data-idx="${idx}" title="打开网络链接">↗</button>`
      : (canOpen ? `<button type="button" class="file-chip-btn" data-act="open" data-idx="${idx}" title="打开文件">📂</button>
                  <button type="button" class="file-chip-btn" data-act="show" data-idx="${idx}" title="打开所在路径">📁</button>` : '');
    chip.innerHTML = `<span class="file-chip-name" title="${(fileUrl(f) || f.path || label).replace(/"/g, '&quot;')}">${linkIcon} ${label}</span>` +
      openButton +
      `<button type="button" class="file-chip-btn file-chip-remove" data-act="remove" data-idx="${idx}" title="移除">✕</button>`;
    chips.insertBefore(chip, searchInput);
  });
  if (hint) {
    hint.textContent = selectedFiles.length === 0
      ? '未挂载文件。可在此搜索文件管理系统中的真实文件。'
      : '已挂载 ' + selectedFiles.length + ' 个文件';
  }
  if (autoOpen === false) {
    dropdown.style.display = 'none';
    _fileDropdownOpen = false;
  }
}

function positionFileDropdown() {
  const dd = document.getElementById('file-dropdown');
  const selector = document.getElementById('file-selector');
  const fs = document.getElementById('file-search');
  if (!dd || !selector || !fs) return;
  const selRect = selector.getBoundingClientRect();
  const fsRect = fs.getBoundingClientRect();
  const gap = 6;
  const spaceBelow = window.innerHeight - fsRect.bottom;
  const spaceAbove = fsRect.top;
  // 优先向下；下方空间不足且上方更大时向上
  const useAbove = spaceBelow < (_FILE_DD_MAX_H + gap) && spaceAbove > spaceBelow;
  const availH = Math.max(180, (useAbove ? spaceAbove : spaceBelow) - gap - 8);
  const finalH = Math.min(_FILE_DD_MAX_H, availH);
  dd.style.maxHeight = finalH + 'px';
  dd.style.left = selRect.left + 'px';
  dd.style.width = Math.max(selRect.width, 320) + 'px';
  dd.style.top = useAbove
    ? (fsRect.top - finalH - gap) + 'px'
    : (fsRect.bottom + gap) + 'px';
}

const _CHIP_DD_MAX_H = 400;
function positionChipDropdown(dropdownId, searchId, selectorId) {
  const dd = document.getElementById(dropdownId);
  const sel = document.getElementById(selectorId);
  const si = document.getElementById(searchId);
  if (!dd || !sel || !si) return;
  const selRect = sel.getBoundingClientRect();
  const siRect = si.getBoundingClientRect();
  const gap = 4;
  const spaceBelow = window.innerHeight - siRect.bottom;
  const spaceAbove = siRect.top;
  const useAbove = spaceBelow < (_CHIP_DD_MAX_H + gap) && spaceAbove > spaceBelow;
  const availH = Math.max(150, (useAbove ? spaceAbove : spaceBelow) - gap - 8);
  const finalH = Math.min(_CHIP_DD_MAX_H, availH);
  dd.style.maxHeight = finalH + 'px';
  dd.style.left = selRect.left + 'px';
  dd.style.width = selRect.width + 'px';
  dd.style.top = useAbove
    ? (siRect.top - finalH - gap) + 'px'
    : (siRect.bottom + gap) + 'px';
}

async function refreshFileDropdown(keyword, append) {
  const dropdown = document.getElementById('file-dropdown');
  if (!dropdown) return;
  dropdown.style.display = 'block';
  _fileDropdownOpen = true;
  if (!append) {
    _fileDDPage = 1;
    _fileDDKeyword = (keyword || '').toString();
    _fileDDActiveIndex = -1;
    dropdown.innerHTML = '<div class="file-dd-hint">搜索中...</div>';
    positionFileDropdown();
  }
  const res = await FileManagerAPI.listFiles({ keyword: _fileDDKeyword, page: _fileDDPage, page_size: _FILE_DD_PAGE_SIZE });
  _fileDDTotal = (res && res.total) || 0;
  const files = (res && res.data) || [];
  if (!append && files.length === 0) {
    dropdown.innerHTML = '<div class="file-dd-hint">无匹配文件（请确认文件管理系统已启动并已扫描）</div>';
    positionFileDropdown();
    return;
  }
  const selectedIds = new Set(selectedFiles.map(f => f.fileId).filter(Boolean));
  const html = files.map(f => {
    const already = selectedIds.has(f.id);
    return `<div class="file-dd-item${already ? ' file-dd-already' : ''}" data-fid="${f.id}" data-fname="${(f.file_name || '').replace(/"/g,'&quot;')}" data-fpath="${(f.file_path || '').replace(/"/g,'&quot;')}">
      <div class="file-dd-name">📄 ${f.file_name || ''}${already ? ' <span style="color:var(--gray-400);font-size:11px;">(已挂载)</span>' : ''}</div>
      <div class="file-dd-path">${f.file_path || ''}</div>
    </div>`;
  }).join('');
  if (append) {
    const oldFooter = dropdown.querySelector('.file-dd-footer');
    if (oldFooter) oldFooter.remove();
    dropdown.insertAdjacentHTML('beforeend', html);
  } else {
    dropdown.innerHTML = html;
  }
  const shownCount = _fileDDPage * _FILE_DD_PAGE_SIZE;
  if (shownCount < _fileDDTotal) {
    dropdown.insertAdjacentHTML('beforeend', `<div class="file-dd-footer">已显示 ${Math.min(shownCount, _fileDDTotal)} / ${_fileDDTotal}，向下滚动加载更多</div>`);
  } else if (_fileDDTotal > 0) {
    dropdown.insertAdjacentHTML('beforeend', `<div class="file-dd-footer">共 ${_fileDDTotal} 个文件</div>`);
  }
  positionFileDropdown();
}

function closeFileDropdown() {
  const dd = document.getElementById('file-dropdown');
  if (dd) dd.style.display = 'none';
  _fileDropdownOpen = false;
  _fileDDPage = 1;
  _fileDDActiveIndex = -1;
  _fileDDLoading = false;
}

// 事件绑定：文件选择器
document.addEventListener('click', function(e) {
  const selector = document.getElementById('file-selector');
  if (!selector) return;
  if (!selector.contains(e.target)) closeFileDropdown();
});

// chip 选择器事件绑定
document.getElementById('dep-chips').addEventListener('click', function(e) {
  if (e.target === this) {
    document.getElementById('dep-search').focus();
    renderDepSelector(true);
  }
});
document.getElementById('dep-search').addEventListener('input', renderDepSelector);
document.getElementById('dep-search').addEventListener('focus', function() { renderDepSelector(true); });

document.getElementById('next-chips').addEventListener('click', function(e) {
  if (e.target === this) {
    document.getElementById('next-search').focus();
    renderNextSelector(true);
  }
});
document.getElementById('next-search').addEventListener('input', renderNextSelector);
document.getElementById('next-search').addEventListener('focus', function() { renderNextSelector(true); });

// R3.33：后置任务「＋ 新建」按钮
(function() {
  var btn = document.getElementById('btn-quick-create-next');
  if (btn) btn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    quickCreateNextTask();
  });
})();

// 文件搜索框事件
(function() {
  const fs = document.getElementById('file-search');
  if (!fs) return;
  const trigger = function() {
    const kw = fs.value.trim();
    if (_fileSearchTimer) clearTimeout(_fileSearchTimer);
    _fileSearchTimer = setTimeout(function() { refreshFileDropdown(kw); }, 200);
  };
  fs.addEventListener('focus', function() { refreshFileDropdown(fs.value.trim()); });
  fs.addEventListener('input', trigger);
  // 键盘导航
  fs.addEventListener('keydown', function(e) {
    const dd = document.getElementById('file-dropdown');
    if (!dd || !_fileDropdownOpen) return;
    const items = Array.from(dd.querySelectorAll('.file-dd-item:not(.file-dd-already)'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length === 0) return;
      _fileDDActiveIndex = Math.min(_fileDDActiveIndex + 1, items.length - 1);
      _highlightFileDDItem(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      _fileDDActiveIndex = Math.max(_fileDDActiveIndex - 1, 0);
      _highlightFileDDItem(items);
    } else if (e.key === 'Enter') {
      if (_fileDDActiveIndex >= 0 && items[_fileDDActiveIndex]) {
        e.preventDefault();
        items[_fileDDActiveIndex].click();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFileDropdown();
    }
  });
})();

function _highlightFileDDItem(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === _fileDDActiveIndex));
  const cur = items[_fileDDActiveIndex];
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

// 下拉框滚动加载更多
(function() {
  const dd = document.getElementById('file-dropdown');
  if (!dd) return;
  dd.addEventListener('scroll', function() {
    if (_fileDDLoading) return;
    if (dd.scrollTop + dd.clientHeight >= dd.scrollHeight - 40) {
      const shown = _fileDDPage * _FILE_DD_PAGE_SIZE;
      if (shown < _fileDDTotal) {
        _fileDDLoading = true;
        _fileDDPage++;
        refreshFileDropdown(_fileDDKeyword, true).finally(function() { _fileDDLoading = false; });
      }
    }
  });
})();

// 窗口 resize / 表单滚动 → 重新定位或关闭
window.addEventListener('resize', function() {
  if (_fileDropdownOpen) positionFileDropdown();
  ['dep-dropdown', 'next-dropdown', 'parent-dropdown'].forEach(function(ddId) {
    var dd = document.getElementById(ddId);
    if (dd && dd.classList.contains('show')) {
      var sId = ddId === 'parent-dropdown' ? 'parent-search' : (ddId === 'dep-dropdown' ? 'dep-search' : 'next-search');
      var selId = ddId === 'parent-dropdown' ? 'parent-selector' : (ddId === 'dep-dropdown' ? 'dep-selector' : 'next-selector');
      positionChipDropdown(ddId, sId, selId);
    }
  });
});
(function() {
  const taskForm = document.querySelector('.modal-task-form');
  if (!taskForm) return;
  taskForm.addEventListener('scroll', function() {
    if (_fileDropdownOpen) {
      const fs = document.getElementById('file-search');
      if (!fs) return;
      const r = fs.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) closeFileDropdown();
      else positionFileDropdown();
    }
    ['dep-dropdown', 'next-dropdown', 'parent-dropdown'].forEach(function(ddId) {
      var dd = document.getElementById(ddId);
      if (!dd || !dd.classList.contains('show')) return;
      var sId = ddId === 'parent-dropdown' ? 'parent-search' : (ddId === 'dep-dropdown' ? 'dep-search' : 'next-search');
      var selId = ddId === 'parent-dropdown' ? 'parent-selector' : (ddId === 'dep-dropdown' ? 'dep-selector' : 'next-selector');
      var si = document.getElementById(sId);
      if (!si) return;
      var r = si.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) dd.classList.remove('show');
      else positionChipDropdown(ddId, sId, selId);
    });
  }, { passive: true });
})();

// 文件下拉项点击 → 添加
(function() {
  const dd = document.getElementById('file-dropdown');
  if (!dd) return;
  dd.addEventListener('click', function(e) {
    const item = e.target.closest('.file-dd-item');
    if (!item) return;
    if (item.classList.contains('file-dd-already')) return;
    const fid = parseInt(item.getAttribute('data-fid'));
    const fname = item.getAttribute('data-fname') || '';
    const fpath = item.getAttribute('data-fpath') || '';
    selectedFiles.push({ fileId: fid, name: fname, path: fpath });
    renderFileSelector();
    // 清空搜索框并刷新下拉
    const fs = document.getElementById('file-search');
    if (fs) { fs.value = ''; refreshFileDropdown(''); fs.focus(); }
  });
})();

// 文件 chip 操作
(function() {
  const chips = document.getElementById('file-chips');
  if (!chips) return;
  chips.addEventListener('click', async function(e) {
    const btn = e.target.closest('.file-chip-btn');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const idx = parseInt(btn.getAttribute('data-idx'));
    if (isNaN(idx)) return;
    const f = selectedFiles[idx];
    if (!f) return;
    if (act === 'remove') {
      selectedFiles.splice(idx, 1);
      renderFileSelector();
    } else if (act === 'link' && isWebLink(f)) {
      openWebLink(f.url);
    } else if (act === 'open' && f.fileId) {
      const r = await FileManagerAPI.openFile(f.fileId);
      if (r && r.ok) showToast('已打开文件', 'success');
      else if (r && r.error) showToast(r.error, 'error');
    } else if (act === 'show' && f.fileId) {
      const r = await FileManagerAPI.showFile(f.fileId);
      if (r && r.ok) showToast('已定位文件', 'success');
      else if (r && r.error) showToast(r.error, 'error');
    }
  });
})();

// 添加网络链接
(function() {
  const urlInput = document.getElementById('file-link-url');
  const nameInput = document.getElementById('file-link-name');
  const addBtn = document.getElementById('btn-add-file-link');
  if (!urlInput || !nameInput || !addBtn) return;
  function addLink() {
    const url = sanitizeWebUrl(urlInput.value);
    if (!url) {
      showToast('请输入有效的 http:// 或 https:// 链接', 'error');
      urlInput.focus();
      return;
    }
    const name = nameInput.value.trim() || url;
    if (selectedFiles.some(function(f) { return fileUrl(f) === url; })) {
      showToast('该链接已经添加', 'warn');
      return;
    }
    selectedFiles.push({ fileId: null, name: name, path: '', url: url });
    urlInput.value = '';
    nameInput.value = '';
    renderFileSelector();
    urlInput.focus();
  }
  addBtn.addEventListener('click', addLink);
  [urlInput, nameInput].forEach(function(input) {
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); addLink(); } });
  });
})();

// ============ TASK OPERATIONS ============
// 统一表单重置
function resetTaskForm(defaults) {
  document.getElementById('task-title').value = defaults.title || '';
  document.getElementById('task-type').value = defaults.type || 'task';
  document.getElementById('task-priority').value = defaults.priority || DEFAULT_PRIORITY;
  document.getElementById('task-status').value = defaults.status || 'todo';
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('task-deadline').value = defaults.deadline || today;
  var prog = defaults.progress || 0;
  document.getElementById('task-progress').value = prog;
  document.getElementById('task-progress-slider').value = prog;
  document.getElementById('task-tag').value = defaults.tag || '';
  document.getElementById('task-assignee').value = defaults.assignee || '';
  document.getElementById('task-startdate').value = defaults.startDate || today;
  selectedFiles = Array.isArray(defaults.files) ? defaults.files.map(fileObj) : [];
  renderFileSelector();
  document.getElementById('task-milestone').checked = defaults.isMilestone || false;
  document.getElementById('task-archived').checked = isArchivedOf(defaults);
  document.getElementById('task-desc').value = defaults.desc || '';
  document.getElementById('task-timestamp').value = defaults.timestamp || '（新建时自动生成）';
  var catEl2 = document.getElementById('task-completedat');
  if (catEl2) catEl2.value = '';
  document.getElementById('btn-task-delete').style.display = defaults.showDelete ? 'inline-flex' : 'none';
  // 周期任务表单重置（新建模式：enable checkbox）
  _resetRecurringState();
  miniCalYear = 0; miniCalMonth = 0;
  const recCb = document.getElementById('task-recurring');
  if (recCb) {
    recCb.checked = false;
    recCb.disabled = false;
    const recPanel = document.getElementById('recurring-panel');
    if (recPanel) recPanel.style.display = 'none';
    if (document.getElementById('recur-freq')) document.getElementById('recur-freq').value = 'daily';
    document.querySelectorAll('.recur-wd').forEach(function(cb) { cb.checked = false; });
    if (document.getElementById('recur-dom')) document.getElementById('recur-dom').value = '1';
    _syncRecurFreqUI();
  }
  // 隐藏批次提示条
  var batchBar = document.getElementById('recurring-batch-bar');
  if (batchBar) batchBar.style.display = 'none';
}

function addChildTask(parentId, childType) {
  var parent = tasks.find(function(t) { return t.id === parentId; });
  if (!parent) return;
  editingTaskId = null;
  nextParentTaskId = null;
  document.getElementById('modal-breadcrumb').style.display = 'none';
  resetTaskForm({ type: childType });
  document.getElementById('modal-task-title').textContent = '📝 添加' + (TYPE_LABELS[childType] || childType);
  document.getElementById('modal-task').style.display = 'flex';
  selectedDeps = new Set();
  selectedNexts = new Set();
  renderDepSelector(false);
  renderNextSelector(false);
  renderParentSelector(parentId, childType);
  updateTaskPreview();
  snapshotForm();
}

function addNextTask(parentId) {
  var parent = tasks.find(function(t) { return t.id === parentId; });
  if (!parent) return;
  editingTaskId = null;
  nextParentTaskId = parentId;
  document.getElementById('modal-breadcrumb').style.display = 'none';
  // R3.34：开始时间预填为前置任务的结束时间（截止日期）；前置无截止日期时 resetTaskForm 回落今天
  resetTaskForm({ type: parent.type || 'task', startDate: parent.deadline || '' });
  document.getElementById('modal-task-title').textContent = '📝 添加后置任务';
  document.getElementById('modal-task').style.display = 'flex';
  selectedDeps = new Set([parentId]);
  selectedNexts = new Set();
  renderDepSelector(false);
  renderNextSelector(false);
  renderParentSelector(parent.parentId, parent.type || 'task');
  updateTaskPreview();
  snapshotForm();
}

function createNewContent() {
  editingTaskId = null;
  nextParentTaskId = null;
  document.getElementById('modal-breadcrumb').style.display = 'none';
  resetTaskForm({ type: 'task' });
  document.getElementById('modal-task-title').textContent = '➕ 创建内容';
  document.getElementById('modal-task').style.display = 'flex';
  selectedDeps = new Set();
  selectedNexts = new Set();
  renderDepSelector(false);
  renderNextSelector(false);
  renderParentSelector(null, 'task');
  updateTaskPreview();
  snapshotForm();
}

// --- 时间戳生成器（14位唯一数字 YYYYMMDDHHMMSS）---
var _tsUsed = {}; // 追踪已用的时间戳，确保唯一
function makeTimestamp() {
  var d = new Date();
  var base = '' + d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    String(d.getSeconds()).padStart(2, '0');
  var ts = base;
  // 冲突时递增，若同一秒内超过60条则跳到下一秒
  var offset = 0;
  while (offset < 60) {
    if (!_tsUsed[ts] && !tasks.some(function(t) { return t.timestamp === ts; })) break;
    offset++;
    ts = String(parseInt(base) + offset); // 整数运算自动进位（秒→分→时）
  }
  // 极端情况：同一秒60次用满，用当前毫秒拼出14位兜底
  if (offset >= 60) {
    var ms = String(d.getMilliseconds()).padStart(3, '0');
    ts = base + String(offset).padStart(2, '0'); // 已超14位，截断
    if (ts.length > 14) ts = ts.slice(0, 14);
  }
  _tsUsed[ts] = true;
  return ts;
}

function addTask(taskData) {
  const task = {
    id: nextId++,
    timestamp: makeTimestamp(),
    type: taskData.type || 'task',
    parentId: taskData.parentId || null,
    children: [],
    title: taskData.title || '新任务',
    priority: taskData.priority || DEFAULT_PRIORITY,
    status: taskData.status || 'todo',
    deadline: taskData.deadline || new Date().toISOString().slice(0, 10),
    progress: taskData.progress || 0,
    deps: taskData.deps || [],
    next: taskData.next || [],
    tag: taskData.tag || '',
    assignee: taskData.assignee || '',
    startDate: taskData.startDate || new Date().toISOString().slice(0, 10),
    files: taskData.files || [],
    isMilestone: taskData.isMilestone || false,
    isArchived: isArchivedOf(taskData),
    recurringGroupId: taskData.recurringGroupId || null,
    desc: taskData.desc || '',
    branches: taskData.branches || [],
    createdAt: new Date().toISOString(),
    completedAt: taskData.status === 'done' ? new Date().toISOString() : null
  };
  tasks.push(task);
  // 维护 parent.children
  if (task.parentId) {
    const parent = tasks.find(t => t.id === task.parentId);
    if (parent) { parent.children = parent.children || []; parent.children.push(task.id); }
  }
  saveData();
  renderAll();
  return task;
}

function editTask(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  editingTaskId = id;
  nextParentTaskId = null;
  document.getElementById('modal-task-title').textContent = '📝 编辑任务';
  document.getElementById('task-title').value = t.title;
  document.getElementById('task-priority').value = t.priority;
  document.getElementById('task-status').value = t.status;
  document.getElementById('task-type').value = t.type || 'task';
  document.getElementById('task-deadline').value = t.deadline || '';
  var prog = t.progress || 0;
  document.getElementById('task-progress').value = prog;
  document.getElementById('task-progress-slider').value = prog;
  document.getElementById('task-tag').value = t.tag || '';
  document.getElementById('task-assignee').value = t.assignee || '';
  document.getElementById('task-startdate').value = t.startDate || '';
  selectedFiles = (t.files || []).map(fileObj);
  renderFileSelector();
  document.getElementById('task-milestone').checked = t.isMilestone || false;
  document.getElementById('task-archived').checked = isArchivedOf(t);
  document.getElementById('task-desc').value = t.desc || '';
  document.getElementById('task-timestamp').value = t.timestamp || '';
  var catEl = document.getElementById('task-completedat');
  if (catEl) catEl.value = t.completedAt ? new Date(t.completedAt).toLocaleString('zh-CN') : '';
  document.getElementById('btn-task-delete').style.display = 'inline-flex';
  document.getElementById('modal-task').style.display = 'flex';
  selectedDeps = new Set(t.deps || []);
  renderDepSelector(false);
  selectedNexts = new Set(t.next || []);
  renderNextSelector(false);
  // 周期任务：编辑模式禁用 checkbox（仅新建可用）
  _resetRecurringState();
  miniCalYear = 0; miniCalMonth = 0;
  const recCb = document.getElementById('task-recurring');
  if (recCb) {
    recCb.checked = false;
    recCb.disabled = true;
    const recPanel = document.getElementById('recurring-panel');
    if (recPanel) recPanel.style.display = 'none';
  }
  // 批次提示条
  var batchBar = document.getElementById('recurring-batch-bar');
  if (batchBar) {
    if (t.recurringGroupId) {
      var batchCount = tasks.filter(function(x) { return x.recurringGroupId === t.recurringGroupId; }).length;
      batchBar.innerHTML = '<span class="batch-info">此任务属于周期批次（共 ' + batchCount + ' 个）</span>' +
        '<button class="batch-btn" onclick="viewRecurringBatch(\'' + t.recurringGroupId + '\')" title="查看同批任务">查看同批</button>' +
        '<button class="batch-btn batch-btn-danger" onclick="deleteRecurringBatch(\'' + t.recurringGroupId + '\')" title="删除同批所有任务">批量删除</button>';
      batchBar.style.display = 'flex';
    } else {
      batchBar.style.display = 'none';
    }
  }
  renderParentSelector(t.parentId, t.type || 'task');
  updateBreadcrumb();
  updateTaskPreview();
  snapshotForm();
}

/**
 * Navigate from current edit modal to another entity's edit modal.
 * Auto-saves current edits before jumping; only jumps when save succeeds.
 */
function navigateToEntity(targetId) {
  if (targetId === editingTaskId) return;
  if (editingTaskId !== null) {
    // 编辑已有实体：先自动保存，保存失败或被取消则停止跳转
    var saved = saveTask();
    if (!saved) return;
  } else {
    // 新建模式：关闭弹窗（有未保存改动时弹确认，取消则停止跳转）
    if (!closeTaskModal(false)) return;
  }
  editingTaskId = null;
  nextParentTaskId = null;
  setTimeout(function() {
    editTask(targetId);
  }, 150);
}

function updateBreadcrumb() {
  var breadcrumb = document.getElementById('modal-breadcrumb');
  if (!breadcrumb) return;
  if (!editingTaskId) {
    breadcrumb.style.display = 'none';
    return;
  }
  var t = tasks.find(function(x) { return x.id === editingTaskId; });
  if (!t) {
    breadcrumb.style.display = 'none';
    return;
  }
  var typeIcon = {object: '\u{1F3AF}', kr: '\u{1F4CA}', target: '\u{1F3AF}', task: '\u2705', record: '\u{1F4DD}', schedule: '\u{1F4C5}', idea: '\u{1F4A1}'};
  var chain = [];
  var cur = t;
  var seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? tasks.find(function(x) { return x.id === cur.parentId; }) : null;
  }
  function short(t) {
    return t.title.length > 16 ? t.title.slice(0, 15) + '\u2026' : t.title;
  }
  var html = '';
  for (var i = 0; i < chain.length; i++) {
    var item = chain[i];
    var isCurrent = item.id === editingTaskId;
    html += '<span class="breadcrumb-seg' + (isCurrent ? ' current' : '') + '"' +
      (isCurrent ? '' : ' onclick="navigateToEntity(' + item.id + ')"') +
      ' title="' + item.title.replace(/"/g, '&quot;') + '">' +
      (typeIcon[item.type] || '\u{1F4C4}') + ' ' + short(item) + '</span>';
    if (i < chain.length - 1) {
      html += '<span class="breadcrumb-arrow">\u25B8</span>';
    }
  }
  breadcrumb.innerHTML = html;
  breadcrumb.style.display = 'flex';
}

function updateTaskPreview() {
  var title = document.getElementById('task-title').value || '(未命名)';
  var progress = parseInt(document.getElementById('task-progress').value) || 0;
  var parentId = parseInt(document.getElementById('task-parent').value) || null;
  var type = document.getElementById('task-type').value;
  var typeIcon = {object:'\u{1F3AF}', kr:'\u{1F4CA}', target:'\u{1F3AF}', task:'\u2705', record:'\u{1F4DD}', schedule:'\u{1F4C5}', idea:'\u{1F4A1}'};

  // 更新进度预览
  var fill = document.getElementById('preview-progress-fill');
  if (fill) {
    fill.style.width = progress + '%';
    fill.classList.toggle('full', progress >= 100);
  }
  var ptext = document.getElementById('preview-progress-text');
  if (ptext) ptext.textContent = progress + '%';

  // ---- 增强的任务位置预览树 ----
  var tree = document.getElementById('preview-tree-content');
  if (tree) {
    var html = '';
    var ancestors = [];
    if (editingTaskId) {
      var t = tasks.find(function(x) { return x.id === editingTaskId; });
      if (t && t.parentId) {
        var cur = tasks.find(function(x) { return x.id === t.parentId; });
        var seen = new Set();
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id);
          ancestors.unshift(cur);
          cur = cur.parentId ? tasks.find(function(x) { return x.id === cur.parentId; }) : null;
        }
      }
    } else if (parentId) {
      var cur = tasks.find(function(x) { return x.id === parentId; });
      var seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        ancestors.unshift(cur);
        cur = cur.parentId ? tasks.find(function(x) { return x.id === cur.parentId; }) : null;
      }
    }
    ancestors.forEach(function(anc) {
      html += '<div class="tree-node ancestor clickable" onclick="navigateToEntity(' + anc.id + ')" title="' + anc.title.replace(/"/g, '&quot;') + '">' +
        (typeIcon[anc.type] || '\u{1F4C4}') + ' ' + anc.title + '</div>';
    });
    html += '<div class="tree-node current" title="' + title.replace(/"/g, '&quot;') + '">\u25CF ' + (typeIcon[type] || '\u{1F4C4}') + ' ' + title + '</div>';
    if (editingTaskId) {
      var children = tasks.filter(function(t) { return t.parentId === editingTaskId; });
      if (children.length > 0) {
        children.forEach(function(c) {
          html += '<div class="tree-node child clickable" onclick="navigateToEntity(' + c.id + ')" title="' + c.title.replace(/"/g, '&quot;') + '">' +
            '&nbsp;&nbsp;\u2514 ' + (typeIcon[c.type] || '\u{1F4C4}') + ' ' + c.title + '</div>';
        });
      }
    }
    tree.innerHTML = html || '<div style="font-size:11px;color:var(--gray-400);">暂无层级信息</div>';
  }

  // ---- 同级节点预览 ----
  var siblingsSection = document.getElementById('preview-siblings-section');
  var siblingsContent = document.getElementById('preview-siblings-content');
  if (siblingsSection && siblingsContent) {
    var actualParentId = null;
    if (editingTaskId) {
      var t = tasks.find(function(x) { return x.id === editingTaskId; });
      if (t) actualParentId = t.parentId;
    } else {
      actualParentId = parentId;
    }
    if (actualParentId) {
      var siblings = tasks.filter(function(t) {
        return t.parentId === actualParentId && t.id !== editingTaskId;
      });
      if (siblings.length > 0) {
        siblingsSection.style.display = 'block';
        var chips = siblings.map(function(s) {
          return '<span class="sibling-chip" onclick="navigateToEntity(' + s.id + ')" title="' + s.title.replace(/"/g, '&quot;') + '">' +
            (typeIcon[s.type] || '\u{1F4C4}') + ' ' + s.title + '</span>';
        }).join('');
        siblingsContent.innerHTML = chips;
      } else {
        siblingsSection.style.display = 'block';
        siblingsContent.innerHTML = '<div class="sibling-empty">无同级节点</div>';
      }
    } else {
      siblingsSection.style.display = 'none';
    }
  }

  // 更新依赖预览（chip 可点击跳转）
  var depPreview = document.getElementById('preview-deps-content');
  if (depPreview) {
    var deps = Array.from(selectedDeps).map(function(id) { return tasks.find(function(t) { return t.id === id; }); }).filter(Boolean);
    var nexts = Array.from(selectedNexts).map(function(id) { return tasks.find(function(t) { return t.id === id; }); }).filter(Boolean);
    var chips = '';
    deps.forEach(function(d) { chips += '<span class="preview-dep-chip dep" style="cursor:pointer;" onclick="navigateToEntity(' + d.id + ')" title="点击跳转到：' + d.title.replace(/"/g, '&quot;') + '">\u2190 ' + d.title + '</span>'; });
    nexts.forEach(function(n) { chips += '<span class="preview-dep-chip next" style="cursor:pointer;" onclick="navigateToEntity(' + n.id + ')" title="点击跳转到：' + n.title.replace(/"/g, '&quot;') + '">\u2192 ' + n.title + '</span>'; });
    depPreview.innerHTML = chips || '<div style="font-size:11px;color:var(--gray-400);">无依赖关系</div>';
  }

  // 更新面包屑
  updateBreadcrumb();
}

// ---- 编辑弹窗防误关保护 ----
// 序列化当前表单内容，用于关闭时对比是否有未保存改动
function getFormSnapshot() {
  return JSON.stringify({
    type: document.getElementById('task-type').value,
    parentId: document.getElementById('task-parent').value,
    title: document.getElementById('task-title').value,
    priority: document.getElementById('task-priority').value,
    status: document.getElementById('task-status').value,
    deadline: document.getElementById('task-deadline').value,
    progress: document.getElementById('task-progress').value,
    tag: document.getElementById('task-tag').value,
    assignee: document.getElementById('task-assignee').value,
    startDate: document.getElementById('task-startdate').value,
    isMilestone: document.getElementById('task-milestone').checked,
    isArchived: document.getElementById('task-archived').checked,
    desc: document.getElementById('task-desc').value,
    deps: Array.from(selectedDeps).sort().join(','),
    next: Array.from(selectedNexts).sort().join(','),
    files: selectedFiles.map(function(f) { return f.id || f.name || f.path || ''; }).sort().join(','),
    recurring: !!(document.getElementById('task-recurring') && document.getElementById('task-recurring').checked),
    recurDates: _recurDateList().join(',')
  });
}

// 记录表单快照（打开弹窗时调用）
function snapshotForm() { formSnapshot = getFormSnapshot(); }

// 统一关闭弹窗：有未保存改动且非 force 时弹确认；统一清理状态
function closeTaskModal(force) {
  if (!force && formSnapshot && getFormSnapshot() !== formSnapshot) {
    if (!confirm('有未保存的修改，确定放弃并关闭吗？')) return false;
  }
  document.getElementById('modal-task').style.display = 'none';
  document.getElementById('modal-breadcrumb').style.display = 'none';
  // 重置「时间与依赖」「标签与附件」分组为展开状态，下次打开默认展开
  document.querySelectorAll('.task-group-time, .task-group-tags').forEach(g => g.classList.add('open'));
  editingTaskId = null;
  nextParentTaskId = null;
  selectedDeps = new Set();
  selectedNexts = new Set();
  selectedFiles = [];
  formSnapshot = '';
  return true;
}

function saveTask() {
  let _completedTask = null;  // 完成后反馈用
  const newType = document.getElementById('task-type').value;
  const newParentId = parseInt(document.getElementById('task-parent').value) || null;
  if (newType !== 'object' && !newParentId) {
    if (!confirm(`${TYPE_LABELS[newType]} 未选择所属上级，将作为独立项保存。确定继续吗？`)) return false;
  }
  const data = {
    type: newType,
    parentId: newType === 'object' ? null : newParentId,
    title: document.getElementById('task-title').value.trim(),
    priority: document.getElementById('task-priority').value,
    status: document.getElementById('task-status').value,
    deadline: document.getElementById('task-deadline').value || null,
    progress: parseInt(document.getElementById('task-progress').value) || 0,
    deps: Array.from(selectedDeps),
    next: Array.from(selectedNexts),
    tag: document.getElementById('task-tag').value.trim(),
    assignee: document.getElementById('task-assignee').value.trim(),
    startDate: document.getElementById('task-startdate').value || null,
    files: selectedFiles.slice(),
    isMilestone: document.getElementById('task-milestone').checked,
    isArchived: document.getElementById('task-archived').checked,
    desc: document.getElementById('task-desc').value.trim(),
  };
  // 周期任务模式（仅新建可用，编辑时 checkbox 被 disabled）
  const recCb = document.getElementById('task-recurring');
  const isRecurring = !!(recCb && recCb.checked && !recCb.disabled);
  if (!data.title) { alert('请输入标题'); return false; }

  if (editingTaskId) {
    const idx = tasks.findIndex(x => x.id === editingTaskId);
    if (idx >= 0) {
      const old = tasks[idx];
      // 检测状态是否变为完成，用于触发粒子效果
      const willTriggerParticle = old.status !== 'done' && data.status === 'done';
      // 处理 parentId 变更: 从旧父级移除，加入新父级
      if (old.parentId !== data.parentId) {
        if (old.parentId) {
          const oldParent = tasks.find(t => t.id === old.parentId);
          if (oldParent) oldParent.children = (oldParent.children || []).filter(c => c !== old.id);
        }
        if (data.parentId) {
          const newParent = tasks.find(t => t.id === data.parentId);
          if (newParent) { newParent.children = newParent.children || []; newParent.children.push(old.id); }
        }
      }
      // 处理 next 数组变更：同步更新关联任务的 deps 数组
      const oldNexts = old.next || [];
      const newNexts = data.next || [];
      const addedNexts = newNexts.filter(nid => !oldNexts.includes(nid));
      const removedNexts = oldNexts.filter(nid => !newNexts.includes(nid));
      addedNexts.forEach(nid => {
        const nextTask = tasks.find(t => t.id === nid);
        if (nextTask) {
          nextTask.deps = nextTask.deps || [];
          if (!nextTask.deps.includes(old.id)) {
            nextTask.deps.push(old.id);
          }
        }
      });
      removedNexts.forEach(nid => {
        const nextTask = tasks.find(t => t.id === nid);
        if (nextTask) {
          nextTask.deps = (nextTask.deps || []).filter(did => did !== old.id);
        }
      });
      // 处理 deps 数组变更：同步更新关联任务的 next 数组
      const oldDeps = old.deps || [];
      const newDeps = data.deps || [];
      const addedDeps = newDeps.filter(did => !oldDeps.includes(did));
      const removedDeps = oldDeps.filter(did => !newDeps.includes(did));
      addedDeps.forEach(did => {
        const depTask = tasks.find(t => t.id === did);
        if (depTask) {
          depTask.next = depTask.next || [];
          if (!depTask.next.includes(old.id)) {
            depTask.next.push(old.id);
          }
        }
      });
      removedDeps.forEach(did => {
        const depTask = tasks.find(t => t.id === did);
        if (depTask) {
          depTask.next = (depTask.next || []).filter(nid => nid !== old.id);
        }
      });
      tasks[idx] = { ...old, ...data };
      setCompletedAt(tasks[idx], data.status, old.status);
      // 状态变为完成时触发粒子爆裂效果
      if (willTriggerParticle) {
        _completedTask = tasks[idx];
        setTimeout(() => {
          // 使用屏幕正中央
          createParticleExplosion(window.innerWidth / 2, window.innerHeight / 2);
        }, 100);
      }
    }
  } else {
    if (isRecurring) {
      // 周期模式：批量创建独立任务
      const dates = _recurDateList();
      if (dates.length === 0) { alert('请至少选择一个日期'); return false; }
      if (dates.length > 365) { alert('单批最多 365 个任务，请减少日期数量'); return false; }
      const groupId = makeTimestamp();
      dates.forEach(ds => {
        const task = Object.assign({}, data, {
          deadline: ds, startDate: ds, recurringGroupId: groupId
        });
        task.id = nextId++;
        task.timestamp = makeTimestamp();
        task.children = [];
        task.createdAt = new Date().toISOString();
        if (task.parentId) {
          const parent = tasks.find(t => t.id === task.parentId);
          if (parent) { parent.children = parent.children || []; parent.children.push(task.id); }
        }
        tasks.push(task);
      });
      // 后置任务：将最后一个任务 ID 追加到原任务 next 数组
      if (nextParentTaskId) {
        const parent = tasks.find(t => t.id === nextParentTaskId);
        if (parent) {
          parent.next = parent.next || [];
          parent.next.push(tasks[tasks.length - 1].id);
        }
      }
      showToast('已创建 ' + dates.length + ' 个任务', 'success');
    } else {
      const newTask = addTask(data);
      // 后置任务：将新任务 ID 追加到原任务 next 数组中
      if (nextParentTaskId && newTask) {
        const parent = tasks.find(t => t.id === nextParentTaskId);
        if (parent) {
          parent.next = parent.next || [];
          parent.next.push(newTask.id);
        }
      }
    }
  }
  closeTaskModal(true);
  dataSource = 'manual';
  localStorage.setItem('ai-task-lens-source', 'manual');
  saveData();
  pushContentLinksNow();
  updateDataSourceBadge();
  renderAll();
  if (_completedTask) celebrateTaskCompletion(_completedTask);
  if (!isRecurring) showToast('✅ 任务已保存', 'success');
  return true;
}

// 快速切换任务状态（循环：todo → progress → done → blocked → todo）
function cycleTaskStatus(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  showStatusPicker(t.id, t.status);
}

function cyclePriority(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const priorities = PRIORITY_VALID;
  const currentIdx = priorities.indexOf(t.priority);
  const nextIdx = (currentIdx + 1) % priorities.length;
  t.priority = priorities[nextIdx];
  saveData();
  renderAll();
}

function toggleArchived(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const next = !isArchivedOf(t);   // 统一归一化为布尔，避免字符串 'false' 取反变 false
  t.isArchived = next;
  saveData();
  showToast(next ? '📦 ' + t.title + ' 已归档' : '📋 ' + t.title + ' 已取消归档', next ? 'info' : 'success');
  renderAll();
}

// 状态切换时自动同步进度
function syncProgressOnStatusChange(t, newStatus) {
  const oldProgress = t.progress || 0;
  switch (newStatus) {
    case 'todo':
      t.progress = 0;
      break;
    case 'preparing':
      t.progress = 25;
      break;
    case 'progress':
      t.progress = Math.max(50, oldProgress);
      break;
    case 'done':
      t.progress = 100;
      // 完成时触发粒子效果
      if (oldProgress !== 100) {
        createParticleExplosion(window.innerWidth / 2, window.innerHeight / 2);
      }
      break;
    case 'blocked':
    case 'cancel':
      // 阻塞、取消时保持当前进度不变（冻结）
      break;
  }
}

function setCompletedAt(t, newStatus, oldStatus) {
  if (newStatus === 'done' && oldStatus !== 'done') {
    t.completedAt = new Date().toISOString();
  } else if (newStatus !== 'done' && oldStatus === 'done') {
    t.completedAt = null;
  }
}

function editDate(id, field) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  
  const currentValue = t[field];
  const fieldName = field === 'deadline' ? '截止日期' : '开始时间';
  
  const newDate = prompt(`请输入${fieldName} (格式: YYYY-MM-DD)`, currentValue || '');
  if (newDate === null) return;
  
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    alert('日期格式不正确，请输入 YYYY-MM-DD 格式');
    return;
  }
  
  t[field] = newDate;
  saveData();
  renderList();
}

// 循环进度（根据状态决定可调的进度级别）
function cycleProgress(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;

  // 已完成、阻塞、取消状态不可调
  if (t.status === 'done' || t.status === 'blocked' || t.status === 'cancel') return;

  const levels = t.status === 'todo' ? [0, 25, 50, 75, 0] : [25, 50, 75, 100];
  const currentIdx = levels.indexOf(t.progress || 0);
  const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % levels.length;
  const oldProgress = t.progress || 0;
  const oldStatus = t.status;
  t.progress = levels[nextIdx];

  // 如果进度达到100%，自动转为完成状态
  if (t.progress === 100 && oldProgress !== 100) {
    t.status = 'done';
    setCompletedAt(t, 'done', oldStatus);
    // 触发粒子庆祝效果
    createParticleExplosion(window.innerWidth / 2, window.innerHeight / 2);
  }
  // 如果进度从100%降下来，自动转为进行中
  if (t.progress !== 100 && t.status === 'done') {
    t.status = 'progress';
    setCompletedAt(t, 'progress', 'done');
  }
  // 如果进度达到50%，自动转为进行中状态
  if (t.progress >= 50 && t.status !== 'done') {
    t.status = 'progress';
  }
  // 如果进度为25%且状态为待办，自动转为准备中状态
  if (t.progress === 25 && t.status === 'todo') {
    t.status = 'preparing';
  }

  saveData();
  renderAll();
  if (t.status === 'done' && oldProgress !== 100) celebrateTaskCompletion(t);
}

// 跳转到指定任务并高亮显示
function scrollToTask(taskId) {
  const el = document.querySelector(`[data-task-id="${taskId}"]`);
  if (!el) {
    editTask(taskId);
    return;
  }
  
  const style = window.getComputedStyle(el);
  if (style.display === 'none') {
    editTask(taskId);
    return;
  }
  
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  el.classList.add('task-highlight-flash');
  setTimeout(() => {
    el.classList.remove('task-highlight-flash');
  }, 1500);
}

// 完成任务后的即时反馈：Toast + 滚动 + 高亮
function celebrateTaskCompletion(t) {
  if (!t) return;
  showToast('✅ 「' + (t.title || '任务') + '」已完成', 'success');
  setTimeout(() => {
    const el = document.querySelector(`[data-task-id="${t.id}"]`);
    if (el && el.offsetParent !== null) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('task-highlight-flash');
      setTimeout(() => el.classList.remove('task-highlight-flash'), 1500);
    }
  }, 50);
}

// 显示任务链右键菜单
function showTaskChainContextMenu(taskId, event) {
  const existingMenu = document.getElementById('task-chain-context-menu');
  if (existingMenu) existingMenu.remove();
  
  const menu = document.createElement('div');
  menu.id = 'task-chain-context-menu';
  menu.style.cssText = `
    position: fixed;
    top: ${event.clientY}px;
    left: ${event.clientX}px;
    background: white;
    border: 1px solid #E5E7EB;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    padding: 4px 0;
    z-index: 9999;
    min-width: 140px;
  `;
  
  menu.innerHTML = `
    <div style="padding: 8px 12px;cursor:pointer;color:#374151;font-size:13px;display:flex;align-items:center;gap:8px;" 
         onclick="document.getElementById('task-chain-context-menu').remove();editTask(${taskId})">
      ✏️ 编辑属性
    </div>
  `;
  
  document.body.appendChild(menu);
  
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('contextmenu', closeMenu);
    }
  };
  
  setTimeout(() => {
    document.addEventListener('click', closeMenu);
    document.addEventListener('contextmenu', closeMenu);
  }, 0);
}

// 获取完整任务链（前置+当前+后置）
function getTaskChain(taskId) {
  const chain = [];
  const visited = new Set();
  
  function collectDeps(taskId) {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    if (task.deps && task.deps.length > 0) {
      task.deps.forEach(depId => collectDeps(depId));
    }
    
    chain.push(task);
  }
  
  collectDeps(taskId);
  
  const visitedNext = new Set(visited);
  function collectNexts(taskId) {
    if (visitedNext.has(taskId)) return;
    visitedNext.add(taskId);
    
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    
    chain.push(task);
    
    if (task.next && task.next.length > 0) {
      task.next.forEach(nextId => collectNexts(nextId));
    }
  }
  
  const currentTask = tasks.find(t => t.id === taskId);
  if (currentTask && currentTask.next && currentTask.next.length > 0) {
    currentTask.next.forEach(nextId => collectNexts(nextId));
  }
  
  return chain;
}

// 显示任务链面板
function showTaskChain(taskId) {
  const existingPanel = document.getElementById('task-chain-panel');
  if (existingPanel) existingPanel.remove();
  
  const chain = getTaskChain(taskId);
  if (chain.length <= 1) {
    showToast('当前任务没有前置或后置任务链', 'info');
    return;
  }
  
  const taskEl = document.querySelector(`[data-task-id="${taskId}"]`);
  if (!taskEl) return;
  
  const rect = taskEl.getBoundingClientRect();
  const container = document.querySelector('#list-view .card') || document.body;
  
  const panel = document.createElement('div');
  panel.id = 'task-chain-panel';
  
  const TYPE_COLORS = { object: '#7C3AED', kr: '#3B82F6', target: '#06B6D4', task: '#6B7280', record: '#8B5CF6', schedule: '#F59E0B', idea: '#10B981' };
  const STATUS_COLORS = { todo: '#6B7280', preparing: '#D97706', progress: '#2563EB', done: '#059669', blocked: '#DC2626', cancel: '#9CA3AF' };
  
  const currentIndex = chain.findIndex(t => t.id === taskId);
  const depsCount = currentIndex;
  const nextsCount = chain.length - currentIndex - 1;
  
  let chainHtml = '';
  
  chain.forEach((task, index) => {
    const color = TYPE_COLORS[task.type] || '#6B7280';
    const statusColor = STATUS_COLORS[task.status] || '#6B7280';
    const isLast = index === chain.length - 1;
    const isCurrent = task.id === taskId;
    const isFirst = index === 0;
    
    const nodeClass = isCurrent ? 'task-chain-node task-chain-current' : 'task-chain-node';
    const nodeStyle = isCurrent 
      ? `background:#4F46E5;border-color:#4F46E5;color:white;box-shadow:0 4px 16px rgba(79,70,229,0.3);transform:scale(1.05);` 
      : `background:${color}20;border-color:${color}40;color:${color};`;
    
    let sectionLabel = '';
    if (index === 0 && depsCount > 0) {
      sectionLabel = `<div class="task-chain-section-label">前置任务 (${depsCount})</div>`;
    }
    if (isCurrent && nextsCount > 0) {
      sectionLabel = `<div class="task-chain-section-label">后置任务 (${nextsCount})</div>`;
    }
    
    chainHtml += `
      <div class="task-chain-item" data-chain-id="${task.id}" onclick="editTask(${task.id})" oncontextmenu="event.preventDefault();showTaskChainContextMenu(${task.id}, event)">
        ${sectionLabel}
        <div class="${nodeClass}" style="${nodeStyle}">
          <span class="task-chain-index">${isCurrent ? '●' : index + 1}</span>
          <span class="task-chain-title">${task.title}</span>
          <span class="task-chain-status" style="color:${isCurrent ? 'rgba(255,255,255,0.8)' : statusColor}">${statusMap[task.status] || task.status}</span>
          ${task.priority ? `<span class="task-chain-priority priority-${task.priority}">${task.priority}</span>` : ''}
        </div>
        ${!isLast ? '<div class="task-chain-arrow">' + (isCurrent ? '⬌' : '→') + '</div>' : ''}
      </div>
    `;
  });
  
  const isLongChain = chain.length > 8;
  
  panel.innerHTML = `
    <div class="task-chain-header">
      <span>📋 任务链 (${chain.length}个任务) · 当前任务用紫色高亮标注</span>
      <div class="task-chain-header-right">
        ${isLongChain ? `<button class="task-chain-collapse-btn" onclick="toggleTaskChainCollapse()">📥 折叠</button>` : ''}
        <button class="task-chain-close" onclick="document.getElementById('task-chain-panel').remove()">✕</button>
      </div>
    </div>
    <div class="task-chain-content">
      <div class="task-chain-content-inner" id="task-chain-inner">
        ${chainHtml}
      </div>
    </div>
  `;
  
  container.appendChild(panel);
  
  setTimeout(() => {
    panel.classList.add('task-chain-panel-show');
    
    if (chain.length > 6) {
      panel.classList.add('task-chain-scrollable');
    }
    
    const currentNode = panel.querySelector('.task-chain-current');
    if (currentNode) {
      currentNode.scrollIntoView({ behavior: 'smooth', inline: 'center' });
    }
  }, 300);

  // Click outside to close
  setTimeout(() => {
    const closeChain = (e) => {
      const panel = document.getElementById('task-chain-panel');
      if (!panel) { document.removeEventListener('click', closeChain); return; }
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener('click', closeChain);
      }
    };
    document.addEventListener('click', closeChain);
  }, 100);
}

function toggleTaskChainCollapse() {
  const panel = document.getElementById('task-chain-panel');
  const content = panel.querySelector('.task-chain-content');
  const btn = panel.querySelector('.task-chain-collapse-btn');
  
  if (panel.classList.contains('task-chain-collapsed')) {
    panel.classList.remove('task-chain-collapsed');
    content.style.maxHeight = '250px';
    btn.textContent = '📥 折叠';
  } else {
    panel.classList.add('task-chain-collapsed');
    content.style.maxHeight = '60px';
    btn.textContent = '📤 展开';
  }
}

// 获取进度对应的颜色
function getProgressColor(progress, status) {
  if (status === 'done') return '#059669';
  if (status === 'blocked') return '#DC2626';
  if (progress >= 100) return '#059669';
  if (progress >= 75) return '#10B981';
  if (progress >= 50) return '#F59E0B';
  if (progress >= 25) return '#FB923C';
  return '#94A3B8';
}

// 显示状态选择弹窗
function showStatusPicker(taskId, currentStatus) {
  // 移除已存在的选择器
  const existing = document.getElementById('status-picker');
  if (existing) existing.remove();

  const statusList = [
    { value: 'todo', label: '待办', color: '#6B7280', bg: '#F3F4F6' },
    { value: 'preparing', label: '准备中', color: '#D97706', bg: '#FEF3C7' },
    { value: 'progress', label: '进行中', color: '#2563EB', bg: '#DBEAFE' },
    { value: 'done', label: '已完成', color: '#059669', bg: '#D1FAE5' },
    { value: 'blocked', label: '阻塞', color: '#DC2626', bg: '#FEE2E2' },
    { value: 'cancel', label: '已取消', color: '#9CA3AF', bg: '#F3F4F6' }
  ];

  // 获取状态标签元素的位置（页面上可能存在多个同 data-task-id 的行——任务列表 + 时间线视图，选可见的那个）
  const candidates = document.querySelectorAll(`[data-task-id="${taskId}"] .status-tag`);
  let statusEl = null;
  for (const el of candidates) {
    // offsetParent === null 表示元素或其父级 display:none / 不可见
    if (el.offsetParent !== null) { statusEl = el; break; }
  }
  if (!statusEl) statusEl = candidates[0];
  if (!statusEl) return;
  const rect = statusEl.getBoundingClientRect();

  // 创建选择器容器
  const picker = document.createElement('div');
  picker.id = 'status-picker';
  picker.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.2), 0 2px 8px rgba(0,0,0,0.1);
    padding: 8px;
    z-index: 10001;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 120px;
    animation: statusPickerIn 0.2s ease-out;
  `;

  // 先添加到 body 以获取高度
  document.body.appendChild(picker);
  const pickerHeight = picker.offsetHeight;
  const windowHeight = window.innerHeight;

  // 智能判断弹出方向：如果下方空间不足，则向上弹出
  if (rect.bottom + pickerHeight + 8 > windowHeight) {
    picker.style.top = `${rect.top - pickerHeight - 8}px`;
  } else {
    picker.style.top = `${rect.bottom + 8}px`;
  }

  // 添加动画样式
  if (!document.getElementById('status-picker-anim')) {
    const style = document.createElement('style');
    style.id = 'status-picker-anim';
    style.textContent = `
      @keyframes statusPickerIn {
        from { opacity: 0; transform: translateY(-8px) scale(0.95); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      #status-picker:hover { box-shadow: 0 10px 35px rgba(0,0,0,0.25); }
    `;
    document.head.appendChild(style);
  }

  // 添加状态选项
  statusList.forEach(s => {
    const isActive = s.value === currentStatus;
    const btn = document.createElement('button');
    btn.style.cssText = `
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: none;
      border-radius: 8px;
      background: ${isActive ? s.bg : 'transparent'};
      color: ${isActive ? s.color : '#374151'};
      font-size: 13px;
      font-weight: ${isActive ? '600' : '500'};
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
    `;
    btn.innerHTML = `
      <span style="
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: ${s.color};
        ${isActive ? 'box-shadow: 0 0 0 3px ' + s.bg + ', 0 0 0 4px ' + s.color : ''};
      "></span>
      ${s.label}
      ${isActive ? '<span style="margin-left:auto;font-size:11px;">✓</span>' : ''}
    `;
    btn.onmouseover = () => {
      if (!isActive) {
        btn.style.background = '#F3F4F6';
        btn.style.color = '#111827';
      }
    };
    btn.onmouseout = () => {
      if (!isActive) {
        btn.style.background = 'transparent';
        btn.style.color = '#374151';
      }
    };
    btn.onclick = () => {
      const t = tasks.find(x => x.id === taskId);
      if (t && t.status !== s.value) {
        const oldStatus = t.status;
        t.status = s.value;
        setCompletedAt(t, s.value, oldStatus);
        syncProgressOnStatusChange(t, s.value);
        saveData();
        renderAll();
        if (s.value === 'done' && oldStatus !== 'done') celebrateTaskCompletion(t);
      }
      picker.remove();
    };
    picker.appendChild(btn);
  });

  // 点击外部关闭
  const closeHandler = (e) => {
    if (!picker.contains(e.target)) {
      picker.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function deleteTask(id) {
  // 收集自身及所有后代
  const toDelete = new Set();
  function collectDescendants(pid) {
    tasks.forEach(t => { if (t.parentId === pid) { toDelete.add(t.id); collectDescendants(t.id); } });
  }
  toDelete.add(id);
  collectDescendants(id);
  const names = Array.from(toDelete).map(did => {
    const t = tasks.find(x => x.id === did);
    return t ? t.title : '#'+did;
  });
  if (!confirm(`确定删除「${tasks.find(t=>t.id===id)?.title||'#'+id}」及其 ${toDelete.size-1} 个子项吗？\n\n${names.slice(0,6).join('\n')}${names.length>6?'\n... 等共 '+names.length+' 个':''}`)) return;

  // 从父级的 children 中移除
  const self = tasks.find(t => t.id === id);
  if (self && self.parentId) {
    const parent = tasks.find(t => t.id === self.parentId);
    if (parent) parent.children = (parent.children || []).filter(c => c !== id);
  }

  tasks = tasks.filter(t => !toDelete.has(t.id));
  // 清理 deps / next 引用
  tasks.forEach(t => { t.deps = (t.deps || []).filter(d => tasks.some(x => x.id === d)); });
  tasks.forEach(t => { t.next = (t.next || []).filter(n => tasks.some(x => x.id === n)); });
  // 清理 children 引用
  tasks.forEach(t => { t.children = (t.children || []).filter(c => tasks.some(x => x.id === c)); });
  saveData();
  renderAll();
}

// ============ 层级健康度检查（R2.7） ============
/**
 * 数据完整性体检引擎。纯函数：只读传入的数组并返回问题清单，不碰 DOM、不落盘。
 * 之所以做成纯函数，是为了三处复用：健康度面板、CSV 导入后自动体检、测试脚本直接调用。
 *
 * 返回 [{ code, severity, title, detail, ids, fix }]
 *   code     — 稳定英文标识，测试按它断言，不依赖中文文案
 *   severity — 'P0' 致命 / 'P1' 严重 / 'P2' 索引一致性 / 'P3' 业务语义
 *   ids      — 受影响实体 ID 数组，UI 用来渲染跳转链接
 *   fix      — null（仅诊断）| { kind:'auto', apply() } | { kind:'manual', options, apply(choice) }
 *
 * 约定：fix.apply() 只改内存对象，不调 saveData/renderAll。
 * 落盘和重渲染由调用方在批量修复结束后统一做一次，避免 N 次修复触发 N 次全量渲染。
 */
function checkHierarchyHealth(list) {
  const arr = Array.isArray(list) ? list : tasks;
  const issues = [];
  const add = (code, severity, title, detail, ids, fix) =>
    issues.push({ code, severity, title, detail, ids: ids || [], fix: fix || null });

  // ── 索引：39 项检查若各自 tasks.find() 是 O(39·n²)，建 Map 后降到 O(n) ──
  // 重复 ID 场景下 Map 只留最后一个，所以另用 idCount 单独统计重复。
  const byId = new Map();
  const idCount = new Map();
  arr.forEach(t => {
    byId.set(t.id, t);
    idCount.set(t.id, (idCount.get(t.id) || 0) + 1);
  });
  const validId = v => Number.isFinite(+v) && v !== null && v !== undefined && v !== '';
  const numIds = arr.map(t => +t.id).filter(Number.isFinite);
  // ID 分配器：不直接动全局 nextId，避免纯函数产生副作用；批量修复后由调用方统一校正 nextId
  let idAlloc = (numIds.length ? Math.max.apply(null, numIds) : 0) + 1;
  const label = t => `[${TYPE_LABELS[t.type] || t.type || '?'}] ${t.title || '(无标题)'} #${t.id}`;

  // 把某个实体的 ID 改为 newId。
  // 重复 ID 场景下「谁引用谁」本就有歧义，策略明确为：已有引用（parentId/deps/next）继续
  // 指向保留下来的第一条，被重编号的那条相当于失去了原有的入边，成为独立实体。
  // 这样不会凭猜测把引用挪到错误的目标上，用户可在面板里手动重挂。
  function reassignId(target, newId) {
    target.id = newId;
    target.timestamp = makeTimestamp();
  }

  // ── P0-1 自引用 ──
  arr.filter(t => validId(t.parentId) && +t.parentId === +t.id).forEach(t => {
    add('SELF_PARENT', 'P0', '自引用：上级指向自己', label(t), [t.id],
      { kind: 'auto', apply() { t.parentId = null; } });
  });

  // ── P0-2 parentId 环形引用 ──
  // 从每个节点上溯，撞到已访问节点即为环。整环只报一条（用排序后的成员签名去重）。
  const reportedCycles = new Set();
  arr.forEach(start => {
    const seen = new Set();
    let cur = start;
    while (cur && validId(cur.parentId) && +cur.parentId !== +cur.id) {
      if (seen.has(cur.id)) {
        const sig = Array.from(seen).sort((a, b) => a - b).join(',');
        if (!reportedCycles.has(sig)) {
          reportedCycles.add(sig);
          const members = Array.from(seen);
          const last = byId.get(cur.id);
          add('PARENT_CYCLE', 'P0', '环形引用：上级链首尾相接',
            members.map(id => byId.get(id) ? label(byId.get(id)) : '#' + id).join(' → '),
            members,
            { kind: 'auto', apply() { if (last) last.parentId = null; } });
        }
        break;
      }
      seen.add(cur.id);
      cur = byId.get(+cur.parentId);
    }
  });

  // ── P0-3 重复 ID ──
  idCount.forEach((cnt, id) => {
    if (cnt <= 1) return;
    const dups = arr.filter(t => t.id === id);
    add('DUP_ID', 'P0', `ID 重复：${cnt} 个实体共用 id=${id}`,
      dups.map(label).join(' / ') + '（修复策略：保留第一条，其余重新编号；已有引用仍指向第一条）',
      [id],
      { kind: 'auto', apply() { dups.slice(1).forEach(d => reassignId(d, idAlloc++)); } });
  });

  // ── P0-4 ID 非法 ──
  arr.filter(t => !Number.isFinite(+t.id)).forEach(t => {
    add('BAD_ID', 'P0', 'ID 非法（缺失或非数字）', `${t.title || '(无标题)'} id=${JSON.stringify(t.id)}`, [t.id],
      { kind: 'auto', apply() { t.id = idAlloc++; } });
  });

  // ── P0-5 type 非法 ──
  arr.filter(t => !TYPE_LABELS[t.type]).forEach(t => {
    add('BAD_TYPE', 'P0', '类型非法', `${t.title || '(无标题)'} #${t.id} type=${JSON.stringify(t.type)} → 将置为「任务」`, [t.id],
      { kind: 'auto', apply() { t.type = 'task'; } });
  });

  // ── P1 前置：祖先链缓存（供 P1-9/10/11 复用，避免各自重复上溯） ──
  // 环上的节点祖先链不可信，直接标记为 null，由 P0-2 负责处理。
  const ancCache = new Map();
  function ancestorsOfSafe(t) {
    if (ancCache.has(t.id)) return ancCache.get(t.id);
    const chain = [];
    const seen = new Set();
    let cur = byId.get(+t.parentId);
    while (cur) {
      if (seen.has(cur.id)) { ancCache.set(t.id, null); return null; }  // 环，链不可信
      seen.add(cur.id);
      chain.push(cur);
      cur = validId(cur.parentId) ? byId.get(+cur.parentId) : null;
    }
    ancCache.set(t.id, chain);
    return chain;
  }
  // 生成「可作为上级」的候选下拉选项
  function parentOptions(types) {
    return arr.filter(t => types.indexOf(t.type) !== -1)
              .map(t => ({ value: t.id, text: label(t) }));
  }

  // ── P1-6 悬空 parentId（上级已删除） ──
  arr.filter(t => validId(t.parentId) && +t.parentId !== +t.id && !byId.has(+t.parentId)).forEach(t => {
    add('DANGLING_PARENT', 'P1', '上级已删除（悬空引用）',
      `${label(t)} 的 parentId=${t.parentId} 在数据中不存在 → 将降级为根节点`, [t.id],
      { kind: 'auto', apply() { t.parentId = null; } });
  });

  // ── P1-7 parentId 非数字（CSV/飞书导入产物，如 'abc'、NaN） ──
  arr.filter(t => t.parentId !== null && t.parentId !== undefined && t.parentId !== '' && !Number.isFinite(+t.parentId)).forEach(t => {
    add('NONNUM_PARENT', 'P1', 'parentId 不是数字',
      `${label(t)} parentId=${JSON.stringify(t.parentId)} → 将置空`, [t.id],
      { kind: 'auto', apply() { t.parentId = null; } });
  });

  // ── P1-8 Object 不应有上级 ──
  arr.filter(t => t.type === 'object' && validId(t.parentId)).forEach(t => {
    add('OBJECT_HAS_PARENT', 'P1', '目标（Object）不应有上级',
      `${label(t)} 上级为 ${byId.get(+t.parentId) ? label(byId.get(+t.parentId)) : '#' + t.parentId} → 将置为顶级`, [t.id],
      { kind: 'auto', apply() { t.parentId = null; } });
  });

  // ── P1-9 游离 KR（上溯不到 Object） ──
  arr.filter(t => t.type === 'kr').forEach(t => {
    const chain = ancestorsOfSafe(t);
    if (chain === null) return;                                  // 环，交给 P0-2
    if (chain.some(a => a.type === 'object')) return;             // 正常
    const opts = parentOptions(['object']);
    add('ORPHAN_KR', 'P1', '游离的关键结果（未关联上级目标）',
      `${label(t)} 向上找不到任何目标（Object），在快速筛选中会被归入「⚠ 游离 KR」组`, [t.id],
      opts.length ? { kind: 'manual', prompt: '选择上级目标', options: opts, apply(v) { t.parentId = +v; } } : null);
  });

  // ── P1-10 游离子目标（Target 上级不是 KR/Object） ──
  arr.filter(t => t.type === 'target').forEach(t => {
    const p = validId(t.parentId) ? byId.get(+t.parentId) : null;
    if (p && ALLOWED_PARENTS.target.indexOf(p.type) !== -1) return;
    if (!p && !validId(t.parentId)) {
      // 无上级：属于游离
    } else if (!p) {
      return;   // 悬空已由 P1-6 报过，避免重复
    }
    const opts = parentOptions(['kr', 'object']);
    add('ORPHAN_TARGET', 'P1', '子目标的上级类型不合法',
      `${label(t)} 上级为 ${p ? '「' + (TYPE_LABELS[p.type] || p.type) + '」' + label(p) : '空'}，应为关键结果或目标`, [t.id],
      opts.length ? { kind: 'manual', prompt: '选择上级', options: opts, apply(v) { t.parentId = +v; } } : null);
  });

  // ── P1-11 Task 父类型非法 ──
  // 注意：task 允许无上级（大量独立任务是正常用法），只在「有上级但类型不对」时告警。
  arr.filter(t => t.type === 'task' && validId(t.parentId)).forEach(t => {
    const p = byId.get(+t.parentId);
    if (!p) return;                                               // P1-6 已报
    if (ALLOWED_PARENTS.task.indexOf(p.type) !== -1) return;
    const opts = parentOptions(['target', 'kr', 'object']);
    add('BAD_TASK_PARENT', 'P1', '任务的上级类型不合法',
      `${label(t)} 上级为「${TYPE_LABELS[p.type] || p.type}」${label(p)}，应为子目标/关键结果/目标`, [t.id],
      opts.length ? { kind: 'manual', prompt: '选择上级', options: opts, apply(v) { t.parentId = +v; } } : null);
  });
  // record / schedule / idea：ALLOWED_PARENTS 为 '*'，按产品决定完全跳过父类型校验。
  // 它们是「附属信息」，可挂任意节点也可为根，强行校验只会产生大量假告警。

  // ── P2-12~15 children 冗余索引一致性 ──
  // children 是 parentId 的派生索引，四类问题的修复动作统一是 rebuildChildren()，
  // 但分开报告，让用户看清到底哪里不一致。
  const expectChildren = new Map();   // parentId -> [childId]
  arr.forEach(t => {
    if (!validId(t.parentId) || +t.parentId === +t.id) return;
    if (!byId.has(+t.parentId)) return;
    const k = +t.parentId;
    if (!expectChildren.has(k)) expectChildren.set(k, []);
    expectChildren.get(k).push(t.id);
  });
  const rebuildFix = () => ({ kind: 'auto', apply() { rebuildChildren(arr); } });

  const missKids = [], danglingKids = [], dupKids = [], selfKids = [];
  arr.forEach(t => {
    const actual = Array.isArray(t.children) ? t.children : [];
    const expect = expectChildren.get(+t.id) || [];
    if (expect.some(cid => actual.indexOf(cid) === -1)) missKids.push(t);
    if (actual.some(cid => !byId.has(+cid))) danglingKids.push(t);
    if (new Set(actual).size !== actual.length) dupKids.push(t);
    if (actual.some(cid => +cid === +t.id)) selfKids.push(t);
  });
  if (missKids.length) add('CHILDREN_MISSING', 'P2', `children 索引缺失（${missKids.length} 处）`,
    missKids.slice(0, 8).map(label).join('；') + (missKids.length > 8 ? ` … 等 ${missKids.length} 项` : '') + ' — 子级的 parentId 指向它，但它的 children 里没有',
    missKids.map(t => t.id), rebuildFix());
  if (danglingKids.length) add('CHILDREN_DANGLING', 'P2', `children 含已删除实体（${danglingKids.length} 处）`,
    danglingKids.slice(0, 8).map(label).join('；') + (danglingKids.length > 8 ? ` … 等 ${danglingKids.length} 项` : ''),
    danglingKids.map(t => t.id), rebuildFix());
  if (dupKids.length) add('CHILDREN_DUP', 'P2', `children 存在重复项（${dupKids.length} 处）`,
    dupKids.slice(0, 8).map(label).join('；'), dupKids.map(t => t.id), rebuildFix());
  if (selfKids.length) add('CHILDREN_SELF', 'P2', `children 含自身（${selfKids.length} 处）`,
    selfKids.slice(0, 8).map(label).join('；'), selfKids.map(t => t.id), rebuildFix());

  // ── P2-16~19 deps / next 引用一致性 ──
  [['deps', '前置依赖'], ['next', '后继任务']].forEach(pair => {
    const field = pair[0], cname = pair[1];
    const dangling = arr.filter(t => (t[field] || []).some(d => !byId.has(+d)));
    if (dangling.length) add(field.toUpperCase() + '_DANGLING', 'P2',
      `${cname}指向已删除实体（${dangling.length} 处）`,
      dangling.slice(0, 8).map(t => `${label(t)} → ${(t[field] || []).filter(d => !byId.has(+d)).map(d => '#' + d).join(',')}`).join('；'),
      dangling.map(t => t.id),
      { kind: 'auto', apply() { dangling.forEach(t => { t[field] = (t[field] || []).filter(d => byId.has(+d)); }); } });

    const selfRef = arr.filter(t => (t[field] || []).some(d => +d === +t.id));
    if (selfRef.length) add(field.toUpperCase() + '_SELF', 'P2',
      `${cname}包含自身（${selfRef.length} 处）`,
      selfRef.slice(0, 8).map(label).join('；'),
      selfRef.map(t => t.id),
      { kind: 'auto', apply() { selfRef.forEach(t => { t[field] = (t[field] || []).filter(d => +d !== +t.id); }); } });
  });

  // ── P2-20 deps / next 矛盾：同一对同时出现在两侧 ──
  arr.forEach(t => {
    const both = (t.deps || []).filter(d => (t.next || []).some(n => +n === +d));
    if (!both.length) return;
    add('DEPS_NEXT_CONFLICT', 'P2', '同一实体既是前置依赖又是后继',
      `${label(t)} 与 ${both.map(d => byId.get(+d) ? label(byId.get(+d)) : '#' + d).join('、')} 关系矛盾`,
      [t.id].concat(both),
      { kind: 'manual', prompt: '保留哪一侧', options: [
          { value: 'deps', text: '保留前置依赖（从 next 移除）' },
          { value: 'next', text: '保留后继任务（从 deps 移除）' }
        ],
        apply(v) {
          if (v === 'deps') t.next = (t.next || []).filter(n => both.indexOf(+n) === -1 && both.indexOf(n) === -1);
          else t.deps = (t.deps || []).filter(d => both.indexOf(+d) === -1 && both.indexOf(d) === -1);
        } });
  });

  // ── P2-21 依赖成环（关键路径计算会死循环） ──
  // 白/灰/黑三色 DFS 找回边，每条回边报一条。
  const color = new Map();
  const cycleEdges = [];
  function dfsDeps(id, stack) {
    color.set(id, 1);
    const node = byId.get(+id);
    (node && node.deps || []).forEach(d => {
      const dn = +d;
      if (!byId.has(dn)) return;
      if (color.get(dn) === 1) cycleEdges.push({ from: id, to: dn, path: stack.concat([id, dn]) });
      else if (!color.get(dn)) dfsDeps(dn, stack.concat([id]));
    });
    color.set(id, 2);
  }
  arr.forEach(t => { if (!color.get(t.id)) dfsDeps(t.id, []); });
  cycleEdges.forEach(e => {
    const from = byId.get(+e.from), to = byId.get(+e.to);
    add('DEPS_CYCLE', 'P2', '依赖关系成环',
      `${from ? label(from) : '#' + e.from} 的前置依赖回指到 ${to ? label(to) : '#' + e.to}，形成闭环（会导致关键路径计算无法收敛）`,
      [e.from, e.to],
      { kind: 'manual', prompt: '如何断开', options: [
          { value: 'cut', text: `删除「${from ? shortTitle(from.title, 12) : e.from}」→「${to ? shortTitle(to.title, 12) : e.to}」这条依赖` }
        ],
        apply() { if (from) from.deps = (from.deps || []).filter(d => +d !== +e.to); } });
  });

  // ── P2-22 nextId 过小（新建实体会撞已有 ID） ──
  const maxId = numIds.length ? Math.max.apply(null, numIds) : 0;
  if (typeof nextId === 'number' && nextId <= maxId) {
    add('NEXTID_TOO_SMALL', 'P2', 'nextId 小于现有最大 ID',
      `nextId=${nextId}，现有最大 id=${maxId} → 新建实体会产生 ID 冲突，将修正为 ${maxId + 1}`, [],
      { kind: 'auto', apply() { nextId = maxId + 1; } });
  }

  // ── P2-23 timestamp 缺失或重复 ──
  const tsSeen = new Map();
  const badTs = [];
  arr.forEach(t => {
    if (t.timestamp === null || t.timestamp === undefined || t.timestamp === '') { badTs.push(t); return; }
    const k = String(t.timestamp);
    if (tsSeen.has(k)) badTs.push(t); else tsSeen.set(k, t);
  });
  if (badTs.length) add('BAD_TIMESTAMP', 'P2', `timestamp 缺失或重复（${badTs.length} 处）`,
    badTs.slice(0, 8).map(label).join('；') + (badTs.length > 8 ? ` … 等 ${badTs.length} 项` : ''),
    badTs.map(t => t.id),
    { kind: 'auto', apply() { badTs.forEach(t => { t.timestamp = makeTimestamp(); }); } });

  // ── P3 业务语义（见下方分段） ──
  // ── P3-24 status 非法 ──
  const badStatus = arr.filter(t => !statusMap[t.status]);
  if (badStatus.length) add('BAD_STATUS', 'P3', `状态值非法（${badStatus.length} 处）`,
    badStatus.slice(0, 8).map(t => `${label(t)} status=${JSON.stringify(t.status)}`).join('；') + ' → 将置为「待办」',
    badStatus.map(t => t.id),
    { kind: 'auto', apply() { badStatus.forEach(t => { t.status = 'todo'; }); } });

  // ── P3-25 priority 非法 ──
  const badPrio = arr.filter(t => PRIORITY_VALID.indexOf(t.priority) === -1);
  if (badPrio.length) add('BAD_PRIORITY', 'P3', `优先级非法（${badPrio.length} 处）`,
    badPrio.slice(0, 8).map(t => `${label(t)} priority=${JSON.stringify(t.priority)}`).join('；') + ` → 将置为 ${DEFAULT_PRIORITY}`,
    badPrio.map(t => t.id),
    { kind: 'auto', apply() { badPrio.forEach(t => { t.priority = DEFAULT_PRIORITY; }); } });

  // ── P3-26 progress 越界或非数字 ──
  const badProg = arr.filter(t => {
    const v = t.progress;
    if (v === null || v === undefined || v === '') return true;
    const n = Number(v);
    return !Number.isFinite(n) || n < 0 || n > 100;
  });
  if (badProg.length) add('BAD_PROGRESS', 'P3', `进度值越界或非数字（${badProg.length} 处）`,
    badProg.slice(0, 8).map(t => `${label(t)} progress=${JSON.stringify(t.progress)}`).join('；') + ' → 将裁剪到 0~100',
    badProg.map(t => t.id),
    { kind: 'auto', apply() { badProg.forEach(t => {
        const n = Number(t.progress);
        t.progress = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
      }); } });

  // ── P3-27 isArchived 非真布尔 ──
  // 字符串 'false' 在裸真值判断下为真，历史上引发过「勾选框空白但被过滤器当已归档」的诡异 bug。
  const badArch = arr.filter(t => 'isArchived' in t && typeof t.isArchived !== 'boolean');
  if (badArch.length) add('NONBOOL_ARCHIVED', 'P3', `isArchived 不是布尔值（${badArch.length} 处）`,
    badArch.slice(0, 8).map(t => `${label(t)} isArchived=${JSON.stringify(t.isArchived)}`).join('；') + ' → 将按统一判据归一化',
    badArch.map(t => t.id),
    { kind: 'auto', apply() { badArch.forEach(t => { t.isArchived = isArchivedOf(t); }); } });

  // ── P3-28 / P3-29 进度与状态矛盾 ──
  arr.filter(t => Number(t.progress) === 100 && t.status !== 'done' && t.status !== 'cancel').forEach(t => {
    add('PROGRESS_DONE_MISMATCH', 'P3', '进度 100% 但状态未完成',
      `${label(t)} 当前状态「${statusMap[t.status] || t.status}」`, [t.id],
      { kind: 'manual', prompt: '如何对齐', options: [
          { value: 'status', text: '状态改为「已完成」' },
          { value: 'progress', text: '进度回退到 99%' }
        ],
        apply(v) { if (v === 'status') t.status = 'done'; else t.progress = 99; } });
  });
  arr.filter(t => t.status === 'done' && Number(t.progress) < 100 && Number.isFinite(Number(t.progress))).forEach(t => {
    add('DONE_PROGRESS_MISMATCH', 'P3', '状态已完成但进度不足 100%',
      `${label(t)} progress=${t.progress}%`, [t.id],
      { kind: 'manual', prompt: '如何对齐', options: [
          { value: 'progress', text: '进度补满 100%' },
          { value: 'status', text: '状态改回「进行中」' }
        ],
        apply(v) { if (v === 'progress') t.progress = 100; else t.status = 'progress'; } });
  });

  // ── P3-30 / P3-31 日期格式非法 ──
  const isBadDate = v => v !== null && v !== undefined && v !== '' && isNaN(new Date(v).getTime());
  [['deadline', '截止日期'], ['startDate', '开始日期']].forEach(pair => {
    const field = pair[0], cname = pair[1];
    const bad = arr.filter(t => isBadDate(t[field]));
    if (!bad.length) return;
    add(field === 'deadline' ? 'BAD_DEADLINE' : 'BAD_STARTDATE', 'P3',
      `${cname}格式非法（${bad.length} 处）`,
      bad.slice(0, 8).map(t => `${label(t)} ${field}=${JSON.stringify(t[field])}`).join('；') + ' → 将置空',
      bad.map(t => t.id),
      { kind: 'auto', apply() { bad.forEach(t => { t[field] = null; }); } });
  });

  // ── P3-32 日期倒挂：开始晚于截止 ──
  arr.filter(t => {
    if (!t.startDate || !t.deadline) return false;
    const s = new Date(t.startDate), d = new Date(t.deadline);
    return !isNaN(s.getTime()) && !isNaN(d.getTime()) && s > d;
  }).forEach(t => {
    add('DATE_INVERTED', 'P3', '开始日期晚于截止日期',
      `${label(t)} ${t.startDate} → ${t.deadline}`, [t.id],
      { kind: 'manual', prompt: '如何修正', options: [
          { value: 'swap', text: '交换两个日期' },
          { value: 'clearStart', text: '清空开始日期' },
          { value: 'clearEnd', text: '清空截止日期' }
        ],
        apply(v) {
          if (v === 'swap') { const s = t.startDate; t.startDate = t.deadline; t.deadline = s; }
          else if (v === 'clearStart') t.startDate = null;
          else t.deadline = null;
        } });
  });

  // ── P3-33 子级截止晚于父级（诊断） ──
  const overrun = [];
  arr.forEach(t => {
    if (!t.deadline || !validId(t.parentId)) return;
    const p = byId.get(+t.parentId);
    if (!p || !p.deadline) return;
    const c = new Date(t.deadline), pd = new Date(p.deadline);
    if (isNaN(c.getTime()) || isNaN(pd.getTime())) return;
    if (c > pd) overrun.push({ t, p });
  });
  if (overrun.length) add('CHILD_EXCEEDS_PARENT', 'P3', `子级截止晚于上级（${overrun.length} 处）`,
    overrun.slice(0, 6).map(o => `${label(o.t)} ${o.t.deadline} 晚于上级 ${label(o.p)} ${o.p.deadline}`).join('；')
      + (overrun.length > 6 ? ` … 等 ${overrun.length} 项` : ''),
    overrun.map(o => o.t.id), null);

  // ── P3-34 父级已完成但仍有未完成子级（诊断） ──
  const doneWithOpen = [];
  arr.filter(t => t.status === 'done').forEach(p => {
    const kids = (expectChildren.get(+p.id) || []).map(id => byId.get(+id)).filter(Boolean);
    const open = kids.filter(k => k.status !== 'done' && k.status !== 'cancel');
    if (open.length) doneWithOpen.push({ p, open });
  });
  if (doneWithOpen.length) add('PARENT_DONE_CHILD_OPEN', 'P3', `上级已完成但子级未完成（${doneWithOpen.length} 处）`,
    doneWithOpen.slice(0, 6).map(o => `${label(o.p)} 仍有 ${o.open.length} 个未完成子项：${o.open.slice(0, 3).map(k => shortTitle(k.title, 10)).join('、')}`).join('；'),
    doneWithOpen.map(o => o.p.id), null);

  // ── P3-35 父级进度与子级均值偏差超 20%（诊断） ──
  const progDrift = [];
  arr.forEach(p => {
    const kids = (expectChildren.get(+p.id) || []).map(id => byId.get(+id)).filter(Boolean);
    if (kids.length < 2) return;   // 单子级偏差意义不大，跳过
    const nums = kids.map(k => Number(k.progress)).filter(Number.isFinite);
    if (!nums.length) return;
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const own = Number(p.progress);
    if (!Number.isFinite(own)) return;
    if (Math.abs(own - avg) > 20) progDrift.push({ p, own, avg: Math.round(avg) });
  });
  if (progDrift.length) add('PROGRESS_DRIFT', 'P3', `上级进度与子级均值偏差过大（${progDrift.length} 处）`,
    progDrift.slice(0, 6).map(o => `${label(o.p)} 自身 ${o.own}% vs 子级均值 ${o.avg}%`).join('；'),
    progDrift.map(o => o.p.id), null);

  // ── P3-36 标题为空 ──
  const noTitle = arr.filter(t => !t.title || !String(t.title).trim());
  if (noTitle.length) add('EMPTY_TITLE', 'P3', `标题为空（${noTitle.length} 处）`,
    noTitle.slice(0, 8).map(t => `#${t.id}（${TYPE_LABELS[t.type] || t.type}）`).join('、') + ' → 将填入「未命名 #<id>」',
    noTitle.map(t => t.id),
    { kind: 'auto', apply() { noTitle.forEach(t => { t.title = '未命名 #' + t.id; }); } });

  // ── P3-37 已归档但状态未收尾（诊断） ──
  const archOpen = arr.filter(t => isArchivedOf(t) && t.status !== 'done' && t.status !== 'cancel');
  if (archOpen.length) add('ARCHIVED_NOT_CLOSED', 'P3', `已归档但状态未收尾（${archOpen.length} 处）`,
    archOpen.slice(0, 8).map(t => `${label(t)} 状态「${statusMap[t.status] || t.status}」`).join('；')
      + (archOpen.length > 8 ? ` … 等 ${archOpen.length} 项` : ''),
    archOpen.map(t => t.id), null);

  // ── P3-38 逾期未完成（诊断） ──
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const overdue = arr.filter(t => {
    if (!t.deadline || isArchivedOf(t)) return false;
    if (t.status === 'done' || t.status === 'cancel') return false;
    const d = new Date(t.deadline);
    return !isNaN(d.getTime()) && d < todayStart;
  });
  if (overdue.length) add('OVERDUE', 'P3', `逾期未完成（${overdue.length} 处）`,
    overdue.slice(0, 8).map(t => `${label(t)} 截止 ${t.deadline}`).join('；')
      + (overdue.length > 8 ? ` … 等 ${overdue.length} 项` : ''),
    overdue.map(t => t.id), null);

  // ── P3-39 空壳 KR：关键结果下没有任何子级（诊断） ──
  const emptyKr = arr.filter(t => t.type === 'kr' && (expectChildren.get(+t.id) || []).length === 0);
  if (emptyKr.length) add('EMPTY_KR', 'P3', `关键结果没有任何下级（${emptyKr.length} 处）`,
    emptyKr.slice(0, 8).map(label).join('；') + (emptyKr.length > 8 ? ` … 等 ${emptyKr.length} 项` : '')
      + ' — 无法衡量进展，建议补充子目标或任务',
    emptyKr.map(t => t.id), null);




  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return issues;
}

// ── 修复前快照：只保留最近一次，避免 localStorage 5MB 上限风险 ──
const HEALTH_SNAPSHOT_KEY = 'ai-task-lens-health-snapshot';

/**
 * 写入修复前快照。返回 true 表示备份成功，可以安全动数据。
 * 写不进去（配额超限）时返回 false —— 调用方必须中止修复，
 * 绝不能在没有退路的情况下批量改数据。
 */
function saveHealthSnapshot(fixCount) {
  try {
    localStorage.setItem(HEALTH_SNAPSHOT_KEY, JSON.stringify({
      at: new Date().toISOString(),
      count: fixCount || 0,
      nextId: nextId,
      tasks: tasks
    }));
    return true;
  } catch (e) {
    console.error('[health] 快照写入失败：', e);
    return false;
  }
}

function getHealthSnapshot() {
  try {
    const raw = localStorage.getItem(HEALTH_SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    return (snap && Array.isArray(snap.tasks)) ? snap : null;
  } catch (e) { return null; }
}

/** 回滚到上次修复前的状态 */
function undoHealthFix() {
  const snap = getHealthSnapshot();
  if (!snap) { showToast('没有可撤销的修复记录', 'warn'); return; }
  const when = new Date(snap.at).toLocaleString('zh-CN');
  if (!confirm(`将把全部数据回滚到 ${when} 修复前的状态（${snap.tasks.length} 条），当前的后续改动都会丢失。\n\n确定撤销吗？`)) return;
  tasks = snap.tasks;
  if (Number.isFinite(+snap.nextId)) nextId = +snap.nextId;
  rebuildChildren(tasks);
  saveData();
  localStorage.removeItem(HEALTH_SNAPSHOT_KEY);
  renderAll();
  if (document.getElementById('modal-health') && document.getElementById('modal-health').style.display === 'flex') renderHealthPanel();
  showToast(`已撤销修复，数据回滚到 ${when}`, 'success');
}

// ── 健康度面板 ──
// 每次检查的结果缓存到这里，供勾选与修复引用。
// 用索引作 key，因为 issue 对象带闭包 fix，不能序列化到 DOM 属性里。
let healthIssues = [];
let healthChecked = new Set();     // 已勾选的 issue 索引
let healthChoices = {};            // 半自动项的下拉选择：index -> value

function showHealthCheck() {
  const modal = document.getElementById('modal-health');
  if (!modal) return;
  healthChecked = new Set();
  healthChoices = {};
  renderHealthPanel();
  modal.style.display = 'flex';
}

function closeHealthCheck() {
  const modal = document.getElementById('modal-health');
  if (modal) modal.style.display = 'none';
}

/** 重新体检并重绘面板内容（勾选态会被清空，因为 issue 列表已经变了） */
function renderHealthPanel() {
  const body = document.getElementById('health-body');
  if (!body) return;
  const t0 = Date.now();
  healthIssues = checkHierarchyHealth();
  const cost = Date.now() - t0;
  healthChecked = new Set();
  healthChoices = {};

  if (healthIssues.length === 0) {
    body.innerHTML = '<div class="health-empty">✅ 数据结构健康，未发现问题'
      + `<div class="health-empty-sub">已检查 ${tasks.length} 条数据，耗时 ${cost}ms</div></div>`;
    updateHealthFooter();
    return;
  }

  const groups = ['P0', 'P1', 'P2', 'P3'];
  let html = `<div class="health-summary">共发现 <b>${healthIssues.length}</b> 项问题`
    + groups.map(sev => {
        const n = healthIssues.filter(i => i.severity === sev).length;
        return n ? ` <span class="health-sev health-sev-${sev.toLowerCase()}">${sev} ${SEVERITY_LABELS[sev]} ${n}</span>` : '';
      }).join('')
    + `<span class="health-cost">检查 ${tasks.length} 条 · ${cost}ms</span></div>`;

  groups.forEach(sev => {
    const list = healthIssues.map((iss, idx) => ({ iss, idx })).filter(o => o.iss.severity === sev);
    if (!list.length) return;
    const fixable = list.filter(o => o.iss.fix);
    const openAttr = (sev === 'P0' || sev === 'P1') ? ' open' : '';
    html += `<details class="health-group"${openAttr}>
      <summary>
        <span class="health-sev health-sev-${sev.toLowerCase()}">${sev}</span>
        <span class="health-group-name">${SEVERITY_LABELS[sev]}</span>
        <span class="health-group-count">${list.length} 项</span>
        ${fixable.length ? `<button class="btn btn-xs btn-outline health-selall" onclick="event.preventDefault();event.stopPropagation();healthSelectGroup('${sev}')">全选可修 ${fixable.length}</button>` : '<span class="health-diagnose-only">仅诊断</span>'}
      </summary>
      <div class="health-items">${list.map(o => renderHealthItem(o.iss, o.idx)).join('')}</div>
    </details>`;
  });

  body.innerHTML = html;
  updateHealthFooter();
}

function renderHealthItem(iss, idx) {
  const fixable = !!iss.fix;
  let html = `<div class="health-item${fixable ? '' : ' health-item-diag'}" data-idx="${idx}">`;
  html += '<div class="health-item-head">';
  if (fixable) {
    html += `<label class="health-check"><input type="checkbox" onchange="healthToggle(${idx}, this.checked)"><span></span></label>`;
  } else {
    html += '<span class="health-check-placeholder" title="此项仅诊断，不提供自动修复">🔍</span>';
  }
  html += `<span class="health-item-title">${escapeHtml(iss.title)}</span>`;
  html += `<code class="health-code">${iss.code}</code>`;
  html += '</div>';
  html += `<div class="health-item-detail">${escapeHtml(iss.detail || '')}</div>`;

  // 半自动项：行内下拉让用户选修复目标
  if (fixable && iss.fix.kind === 'manual') {
    const opts = (iss.fix.options || []).map(o => `<option value="${escapeHtml(String(o.value))}">${escapeHtml(o.text)}</option>`).join('');
    html += `<div class="health-item-action"><span class="health-prompt">${escapeHtml(iss.fix.prompt || '选择处理方式')}：</span>
      <select onchange="healthChoose(${idx}, this.value)"><option value="">— 请选择 —</option>${opts}</select></div>`;
  }

  // 受影响实体：点击跳转编辑
  if (iss.ids && iss.ids.length) {
    const links = iss.ids.slice(0, 10).map(id => {
      const t = tasks.find(x => x.id === id);
      return t ? `<a class="health-link" onclick="healthJumpTo(${id})">${escapeHtml(shortTitle(t.title, 14))}</a>`
                : `<span class="health-link-dead">#${id}</span>`;
    }).join('');
    if (links) html += `<div class="health-item-refs">${links}${iss.ids.length > 10 ? `<span class="health-more">… 共 ${iss.ids.length} 个</span>` : ''}</div>`;
  }
  html += '</div>';
  return html;
}

function healthToggle(idx, checked) {
  if (checked) healthChecked.add(idx); else healthChecked.delete(idx);
  updateHealthFooter();
}

function healthChoose(idx, value) {
  if (value) {
    healthChoices[idx] = value;
    // 选了处理方式就自动勾上，省一次点击
    healthChecked.add(idx);
    const box = document.querySelector(`.health-item[data-idx="${idx}"] input[type=checkbox]`);
    if (box) box.checked = true;
  } else {
    delete healthChoices[idx];
  }
  updateHealthFooter();
}

function healthSelectGroup(sev) {
  const targets = healthIssues.map((iss, idx) => ({ iss, idx })).filter(o => o.iss.severity === sev && o.iss.fix);
  // 已经全选则反选，做成开关更顺手
  const allOn = targets.every(o => healthChecked.has(o.idx));
  targets.forEach(o => { if (allOn) healthChecked.delete(o.idx); else healthChecked.add(o.idx); });
  targets.forEach(o => {
    const box = document.querySelector(`.health-item[data-idx="${o.idx}"] input[type=checkbox]`);
    if (box) box.checked = !allOn;
  });
  updateHealthFooter();
}

function healthJumpTo(id) {
  closeHealthCheck();
  try { editTask(id); } catch (e) { showToast('无法打开该实体：' + e.message, 'error'); }
}

function updateHealthFooter() {
  const cnt = document.getElementById('health-selected-count');
  const btnFix = document.getElementById('btn-health-fix');
  const btnUndo = document.getElementById('btn-health-undo');
  // 半自动项必须先选处理方式才算就绪，否则修复时无从下手
  const pending = Array.from(healthChecked).filter(i => healthIssues[i] && healthIssues[i].fix
    && healthIssues[i].fix.kind === 'manual' && !healthChoices[i]);
  if (cnt) {
    cnt.textContent = `已选 ${healthChecked.size} 项`
      + (pending.length ? `（其中 ${pending.length} 项待选择处理方式）` : '');
    cnt.className = pending.length ? 'health-count health-count-warn' : 'health-count';
  }
  if (btnFix) btnFix.disabled = healthChecked.size === 0 || pending.length > 0;
  if (btnUndo) {
    const snap = getHealthSnapshot();
    btnUndo.style.display = snap ? '' : 'none';
    if (snap) btnUndo.title = `回滚到 ${new Date(snap.at).toLocaleString('zh-CN')} 修复前的状态`;
  }
}

/**
 * 执行勾选项的修复。
 * 顺序很重要：先备份 → 逐项 apply（只改内存）→ 统一 rebuildChildren → 一次落盘 → 一次重渲染。
 * 这样避免 N 次修复触发 N 次全量渲染，也保证中途出错时快照仍是干净的。
 */
function applyHealthFixes() {
  const picked = Array.from(healthChecked).sort((a, b) => a - b)
    .map(i => ({ idx: i, iss: healthIssues[i] }))
    .filter(o => o.iss && o.iss.fix);
  if (!picked.length) { showToast('没有勾选任何可修复项', 'warn'); return; }

  const manualPending = picked.filter(o => o.iss.fix.kind === 'manual' && !healthChoices[o.idx]);
  if (manualPending.length) { showToast(`还有 ${manualPending.length} 项未选择处理方式`, 'warn'); return; }

  const names = picked.slice(0, 8).map(o => '· ' + o.iss.title).join('\n');
  if (!confirm(`将修复 ${picked.length} 项问题：\n\n${names}${picked.length > 8 ? `\n… 等共 ${picked.length} 项` : ''}\n\n修复前会自动备份，可随时撤销。确定继续吗？`)) return;

  // 备份失败必须中止 —— 没有退路就不动数据
  if (!saveHealthSnapshot(picked.length)) {
    alert('⚠️ 自动备份失败（浏览器存储空间不足），为避免数据不可恢复，已中止修复。\n\n建议先用「📥 导出数据」备份到本地后再试。');
    return;
  }

  let ok = 0;
  const failed = [];
  picked.forEach(o => {
    try {
      if (o.iss.fix.kind === 'manual') o.iss.fix.apply(healthChoices[o.idx]);
      else o.iss.fix.apply();
      ok++;
    } catch (e) {
      console.error('[health] 修复失败：', o.iss.code, e);
      failed.push(o.iss.code + '（' + e.message + '）');
    }
  });

  // 统一收尾：重建索引 + 校正 nextId（重编号可能让 nextId 落后）
  rebuildChildren(tasks);
  const maxId = Math.max.apply(null, [0].concat(tasks.map(t => +t.id).filter(Number.isFinite)));
  if (nextId <= maxId) nextId = maxId + 1;
  saveData();
  renderAll();
  renderHealthPanel();   // 修复后立即复检，让用户看到剩余问题

  if (failed.length) showToast(`修复 ${ok} 项成功，${failed.length} 项失败：\n${failed.slice(0, 3).join('\n')}`, 'warn');
  else showToast(`已修复 ${ok} 项问题，可点「↩ 撤销上次修复」回滚`, 'success');
}

/** 顶栏按钮红点：只统计 P0+P1，P2/P3 不打扰用户 */
function updateHealthBadge() {
  const badge = document.getElementById('health-badge');
  if (!badge) return;
  try {
    const n = checkHierarchyHealth().filter(i => i.severity === 'P0' || i.severity === 'P1').length;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = n > 0 ? '' : 'none';
    const btn = document.getElementById('btn-health-check');
    if (btn) btn.title = n > 0 ? `发现 ${n} 个严重结构问题，点击查看` : '检查层级与数据完整性问题';
  } catch (e) {
    badge.style.display = 'none';
  }
}

// 健康度面板事件绑定
(function () {
  const close = document.getElementById('btn-health-close');
  if (close) close.addEventListener('click', closeHealthCheck);
  const overlay = document.getElementById('modal-health');
  if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) closeHealthCheck(); });
  const fix = document.getElementById('btn-health-fix');
  if (fix) fix.addEventListener('click', applyHealthFixes);
  const undo = document.getElementById('btn-health-undo');
  if (undo) undo.addEventListener('click', undoHealthFix);
})();

// ============ UI LOGIC ============
// Navigation
document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    const view = this.dataset.view;
    currentView = view; // 跟踪当前视图
    document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    // 用户手动点击主导航切视图时，清掉侧边栏快速筛选的点亮态；
    // 若是 quickFilter/goToListView 内部触发的 .click()，则跳过（_navFromQuickFilter 标志）
    if (!_navFromQuickFilter) {
      activeQuickFilter = null;
      updateQuickActionStates();
    }
    // 渲染当前视图
    renderAll();
  });
});

// Quick AI input
document.getElementById('btn-quick-ai').addEventListener('click', () => {
  const text = document.getElementById('quick-ai-input').value.trim();
  if (!text) return;
  const parsed = AIEngine.parse(text);
  if (parsed.length === 0) { alert('未能解析出任务，请尝试更详细的描述。'); return; }
  let count = 0;
  parsed.forEach(p => { addTask(p); count++; });
  document.getElementById('quick-ai-input').value = '';
  alert(`✅ AI 成功解析了 ${count} 个任务！`);
});

// Enter key on quick input
document.getElementById('quick-ai-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-quick-ai').click();
});

// ============ 全局快捷键 ============
// 视图编号映射：1 仪表盘 / 2 时间线表格（R3.38 起原「列表」已移除，2 改指时间线表格）/ 3 日历(再按切时间线表格) / 4 矩阵 / 5 团队看板 / 6 习惯
const _SHORTCUT_VIEW_KEYS = { '1': 'dashboard', '2': 'timelineTableShortcut', '3': 'timeline', '4': 'matrix', '5': 'board', '6': 'habits' };

// R3.38：统一激活时间线表格视图（该视图不在 nav-item 路由中，需手动激活面板）
// lightQuick=true 时同步点亮侧边栏「时间线」按钮（activeQuickFilter='timelineTable'）
function activateTimelineTable(lightQuick) {
  currentView = 'timeline-table';
  document.querySelectorAll('.view-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('view-timeline-table');
  if (panel) panel.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  if (lightQuick) activeQuickFilter = 'timelineTable';
  updateQuickActionStates();
  renderTimelineTable();
}

// 切换到时间线表格视图（该视图不在 nav-item 中，需手动激活）
function _switchToTimelineTableByShortcut() {
  activateTimelineTable(true);
}

function _isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function initGlobalShortcuts() {
  document.addEventListener('keydown', function(e) {
    const mod = e.ctrlKey || e.metaKey;
    const typing = _isTypingTarget(e.target);

    // Esc：关闭当前打开的最顶层弹窗（优先编辑弹窗，带未保存确认）
    if (e.key === 'Escape') {
      const taskModal = document.getElementById('modal-task');
      if (taskModal && taskModal.style.display === 'flex') { closeTaskModal(); return; }
      const quotes = document.getElementById('modal-quotes');
      if (quotes && quotes.style.display === 'flex') { closeQuotesModal(); return; }
      const health = document.getElementById('modal-health');
      if (health && health.style.display === 'flex') { closeHealthCheck(); return; }
      const help = document.getElementById('modal-help');
      if (help && help.style.display === 'flex') { closeHelp(); return; }
      const changelog = document.getElementById('modal-changelog');
      if (changelog && changelog.style.display === 'flex') { document.getElementById('btn-changelog-close').click(); return; }
      const ai = document.getElementById('modal-ai');
      if (ai && ai.style.display === 'flex') { document.getElementById('btn-modal-close').click(); return; }
      return;
    }

    // 输入框内不触发全局快捷键（Esc 已单独处理）
    if (typing) return;

    // 弹窗打开时，除 Esc 外不响应全局快捷键（避免编辑中误切视图）
    const anyModalOpen = Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.style.display !== 'none');
    if (anyModalOpen) return;

    // 新建内容块：Ctrl/Cmd+Alt+N（浏览器不占用）或单键 N（Notion 风格，无修饰键）
    // 注意：不用 Ctrl+N——那是浏览器「新建窗口」保留快捷键，页面层拦不住
    const keyN = e.key.toLowerCase() === 'n';
    if ((mod && e.altKey && keyN) || (!mod && !e.altKey && keyN)) {
      e.preventDefault();
      createNewContent();
      return;
    }
    // Ctrl/Cmd+K 或 /：搜索（R3.38：切到时间线表格视图并聚焦其搜索框）
    if ((mod && e.key.toLowerCase() === 'k') || e.key === '/') {
      e.preventDefault();
      goToListView();
      // 搜索框是 renderTimelineTable 动态渲染的（节点复用），需等 DOM 生成后聚焦
      setTimeout(() => {
        const si = document.getElementById('tl-search-input');
        if (si) { si.focus(); si.select(); }
      }, 120);
      return;
    }
    // ?：打开使用帮助
    if (e.key === '?') {
      e.preventDefault();
      showHelp();
      return;
    }
    // 数字键 1-6：切换视图（无修饰键时）
    if (!mod && !e.altKey && _SHORTCUT_VIEW_KEYS[e.key]) {
      const view = _SHORTCUT_VIEW_KEYS[e.key];
      if (view === 'timeline') {
        // 3 键循环：日历 ↔ 时间线表格
        if (currentView === 'timeline' || currentView === 'timeline-table') {
          if (currentView === 'timeline-table') {
            const btn = document.querySelector('.nav-item[data-view="timeline"]');
            if (btn) btn.click();
          } else {
            _switchToTimelineTableByShortcut();
          }
        } else {
          const btn = document.querySelector('.nav-item[data-view="timeline"]');
          if (btn) btn.click();
        }
        return;
      }
      // R3.38：数字键 2 由「列表」改指时间线表格（列表视图已移除）
      if (view === 'timelineTableShortcut') {
        activateTimelineTable(true);
        return;
      }
      const btn = document.querySelector('.nav-item[data-view="' + view + '"]');
      if (btn) btn.click();
      return;
    }
  });
}
initGlobalShortcuts();

// AI Modal
document.getElementById('btn-ai-input').addEventListener('click', () => {
  document.getElementById('modal-ai').style.display = 'flex';
});
document.getElementById('btn-modal-close').addEventListener('click', () => {
  document.getElementById('modal-ai').style.display = 'none';
});
document.getElementById('btn-modal-clear').addEventListener('click', () => {
  document.getElementById('ai-textarea').value = '';
});
document.getElementById('btn-modal-demo').addEventListener('click', () => {
  document.getElementById('ai-textarea').value = `1. 下周五前完成Q2业务汇报PPT - 非常紧急重要
2. 汇报前需要先收齐各部门的Q2数据
3. 约王总讨论预算调整方案，这个不着急但很重要
4. 技术方案评审，有A B C三个方案需要对比选择
5. 月度复盘会议纪要整理，这周五完成
6. 团队团建活动策划，下个月中旬办
7. 客户需求文档翻译，明天下午3点前要给`;
});
document.getElementById('btn-modal-parse').addEventListener('click', () => {
  const text = document.getElementById('ai-textarea').value.trim();
  if (!text) { alert('请先输入或粘贴任务描述。'); return; }
  const parsed = AIEngine.parse(text);
  if (parsed.length === 0) { alert('未能解析出任务。请尝试以下格式：\n- 任务描述\n- 包含时间线索（如"下周五""明天"）\n- 包含优先级线索（如"紧急""重要"）'); return; }
  let count = 0;
  parsed.forEach(p => { addTask(p); count++; });
  document.getElementById('modal-ai').style.display = 'none';
  alert(`✨ AI 智能解析完成！成功提取 ${count} 个结构化任务。\n\n切换到「任务列表」查看详情。`);
});

// Task Modal
document.getElementById('btn-add-task').addEventListener('click', () => {
  editingTaskId = null;
  nextParentTaskId = null;
  document.getElementById('modal-breadcrumb').style.display = 'none';
  resetTaskForm({});
  document.getElementById('modal-task-title').textContent = '📝 添加任务';
  document.getElementById('modal-task').style.display = 'flex';
  selectedDeps = new Set();
  selectedNexts = new Set();
  renderDepSelector(false);
  renderNextSelector(false);
  renderParentSelector(null, 'task');
  updateTaskPreview();
  snapshotForm();
});
document.getElementById('btn-task-close').addEventListener('click', () => {
  closeTaskModal(false);
});
document.getElementById('btn-task-cancel').addEventListener('click', () => {
  closeTaskModal(false);
});
document.getElementById('btn-task-save').addEventListener('click', saveTask);
document.getElementById('btn-task-delete').addEventListener('click', () => {
  if (editingTaskId) { deleteTask(editingTaskId); closeTaskModal(true); }
});

// Modal click outside to close
document.getElementById('modal-ai').addEventListener('click', function(e) { if (e.target === this) this.style.display = 'none'; });
// 编辑弹窗：点遮罩不再关闭（防误触丢失编辑内容），仅能通过 ✕/取消/保存 关闭

// Load demo data
document.getElementById('btn-load-demo').addEventListener('click', loadDemoData);

// CSV + TXT Export
document.getElementById('btn-export-csv').addEventListener('click', () => {
  if (tasks.length === 0) { alert('暂无数据可导出'); return; }
  const dateStr = new Date().toISOString().slice(0,10);
  exportCSV();
  setTimeout(() => {
    exportTXT();
    setTimeout(() => {
      showExportResult(dateStr);
    }, 500);
  }, 300);
});

function showExportResult(dateStr) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
    z-index: 1000;
  `;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  
  const content = document.createElement('div');
  content.style.cssText = `
    background: white; border-radius: 16px; padding: 24px; max-width: 420px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.2);
  `;
  
  content.innerHTML = `
    <h3 style="margin:0 0 16px 0;font-size:18px;color:#1F2937;">📥 导出结果</h3>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#ECFDF5;border-radius:8px;">
        <span style="font-size:18px;">✅</span>
        <div>
          <div style="font-weight:600;color:#065F46;">CSV 文件下载成功</div>
          <div style="font-size:12px;color:#047857;">ai-task-lens_${dateStr}.csv</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#FEF3C7;border-radius:8px;">
        <span style="font-size:18px;">✅</span>
        <div>
          <div style="font-weight:600;color:#92400E;">TXT 文件下载成功</div>
          <div style="font-size:12px;color:#B45309;">ai-task-lens_${dateStr}.txt</div>
        </div>
      </div>
    </div>
    <button onclick="this.closest('div').parentElement.remove()" 
      style="margin-top:20px;width:100%;padding:10px;border:none;border-radius:8px;background:#6366F1;color:white;font-weight:600;cursor:pointer;">
      知道了
    </button>
  `;
  
  modal.appendChild(content);
  document.body.appendChild(modal);
}

function exportCSV() {
  if (tasks.length === 0) { alert('暂无数据可导出'); return; }
  const headers = ['id','type','parentId','title','priority','status','deadline','startDate','progress','assignee','isMilestone','isArchived','timestamp','deps','next','files','tag','desc','branches','recurringGroupId','completedAt'];
  const rows = [headers.join(',')];
  const idToTimestamp = {};
  tasks.forEach(t => {
    idToTimestamp[t.id] = t.timestamp || t.id;
  });
  tasks.forEach(t => {
    const rowId = t.timestamp || t.id;
    const parentTs = t.parentId ? (idToTimestamp[t.parentId] || t.parentId) : '';
    const depsTs = (t.deps || []).map(did => idToTimestamp[did] || did);
    const nextTs = (t.next || []).map(nid => idToTimestamp[nid] || nid);
    const row = [
      rowId,
      t.type,
      parentTs ?? '',
      `"${(t.title || '').replace(/"/g, '""')}"`,
      t.priority,
      t.status,
      t.deadline ?? '',
      t.startDate ?? '',
      t.progress ?? 0,
      `"${(t.assignee || '').replace(/"/g, '""')}"`,
      t.isMilestone ? 'true' : 'false',
      isArchivedOf(t) ? 'true' : 'false',
      `"${t.timestamp || t.id}"`,
      `"${depsTs.join(';')}"`,
      `"${nextTs.join(';')}"`,
      `"${(t.files || []).map(function(f){ return isWebLink(f) ? fileUrl(f) : fileDisplayName(f); }).join(';')}"`,
      `"${(t.tag || '').replace(/"/g, '""')}"`,
      `"${(t.desc || '').replace(/"/g, '""')}"`,
      `"${(t.branches || []).join(';')}"`,
      `"${t.recurringGroupId || ''}"`,
      `"${t.completedAt || ''}"`
    ];
    rows.push(row.join(','));
  });
  const csv = '\uFEFF' + rows.join('\n'); // BOM for Excel UTF-8
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-task-lens_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportTXT() {
  if (tasks.length === 0) { alert('暂无数据可导出'); return; }
  
  const TYPE_LABELS_TXT = { object: '🎯 目标', kr: '📊 KR', target: '🎯 子目标', task: '📋 任务', record: '📝 记录', schedule: '📅 日程', idea: '💡 想法' };
  const STATUS_LABELS_TXT = { todo: '待办', preparing: '准备中', progress: '进行中', done: '已完成', blocked: '阻塞', cancel: '已取消' };
  const PRIORITY_COLORS = { P0: '🔴', P1: '🟠', P2: '🟡', P3: '🟢' };
  
  const rootTasks = tasks.filter(t => !t.parentId);
  const childMap = new Map();
  tasks.forEach(t => {
    if (t.children && t.children.length > 0) {
      t.children.forEach(cid => {
        childMap.set(cid, t);
      });
    }
  });
  
  const lines = [];
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push('                    AI 任务透视镜 - 任务导出报告');
  lines.push(`                    导出时间: ${new Date().toLocaleString('zh-CN')}`);
  lines.push(`                    任务总数: ${tasks.length} 条`);
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push('');
  
  function buildTree(tasksList, indent = 0) {
    tasksList.forEach(t => {
      const prefix = ' '.repeat(indent * 2) + (indent > 0 ? '├─ ' : '');
      const typeLabel = TYPE_LABELS_TXT[t.type] || t.type;
      const statusLabel = STATUS_LABELS_TXT[t.status] || t.status;
      const priorityIcon = PRIORITY_COLORS[t.priority] || '';
      
      lines.push(`${prefix}${typeLabel} ${priorityIcon} ${t.title}`);
      
      if (t.priority) lines.push(`${prefix}  ├── 优先级: ${t.priority}`);
      if (t.status) lines.push(`${prefix}  ├── 状态: ${statusLabel}`);
      if (t.progress !== undefined && t.progress !== null) lines.push(`${prefix}  ├── 进度: ${t.progress}%`);
      if (t.deadline) lines.push(`${prefix}  ├── 截止日期: ${t.deadline}`);
      if (t.startDate) lines.push(`${prefix}  ├── 开始时间: ${t.startDate}`);
      if (t.assignee) lines.push(`${prefix}  ├── 负责人: ${t.assignee}`);
      if (t.isMilestone) lines.push(`${prefix}  ├── 里程碑: 是`);
      if (t.deps && t.deps.length > 0) {
        const depNames = t.deps.map(did => {
          const dt = tasks.find(x => x.id === did);
          return dt ? dt.title : `#${did}`;
        }).join('; ');
        lines.push(`${prefix}  ├── 前置依赖: ${depNames}`);
      }
      if (t.next && t.next.length > 0) {
        const nextNames = t.next.map(nid => {
          const nt = tasks.find(x => x.id === nid);
          return nt ? nt.title : `#${nid}`;
        }).join('; ');
        lines.push(`${prefix}  ├── 后置任务: ${nextNames}`);
      }
      if (t.tag) lines.push(`${prefix}  ├── 标签: ${t.tag}`);
      if (t.desc) lines.push(`${prefix}  ├── 描述: ${t.desc.replace(/\n/g, ' ')}`);
      if (t.files && t.files.length > 0) lines.push(`${prefix}  ├── 文件: ${t.files.map(fileDisplayName).join('; ')}`);
      if (t.timestamp) lines.push(`${prefix}  └── 时间戳: ${t.timestamp}`);
      
      const children = tasks.filter(c => c.parentId === t.id);
      if (children.length > 0) {
        lines.push('');
        buildTree(children, indent + 1);
      }
      lines.push('');
    });
  }
  
  buildTree(rootTasks);
  
  lines.push('══════════════════════════════════════════════════════════════════');
  lines.push('                    导出完成');
  lines.push('══════════════════════════════════════════════════════════════════');
  
  const txt = lines.join('\n');
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-task-lens_${new Date().toISOString().slice(0,10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── JSON 完整备份 / 恢复（R3.30）──
// 覆盖所有业务 localStorage key（任务/习惯/金句/高亮/隐藏筛选/实体底色/来源/暂停标记），
// 排除健康检查撤销快照（HEALTH_SNAPSHOT_KEY 是临时恢复点，不随备份迁移）
const BACKUP_STORE_KEYS = [
  'ai-task-lens-tasks',
  'ai-task-lens-nextId',
  'ai-task-lens-source',
  'ai-task-lens-data-version',
  'ai-task-lens-highlighted',
  'ai-task-lens-hidden-filters',
  'ai-task-lens-entity-colors',
  'ai-task-lens-habits',
  'ai-task-lens-habit-checkins',
  'ai-task-lens-quotes',
  'ai-task-lens-sync-paused',
];
const BACKUP_FORMAT_VERSION = 1;

function collectBackupData() {
  const data = {};
  BACKUP_STORE_KEYS.forEach(function(k) {
    const v = localStorage.getItem(k);
    if (v !== null) data[k] = v;
  });
  return data;
}
function buildBackupPayload() {
  return { _formatVersion: BACKUP_FORMAT_VERSION, _appVersion: 'R3.38', _exportedAt: new Date().toISOString(), data: collectBackupData() };
}
// 校验备份对象；通过返回 null，失败返回错误文案
function validateBackup(obj) {
  if (!obj || typeof obj !== 'object') return '备份文件不是有效的 JSON 对象';
  if (obj._formatVersion !== BACKUP_FORMAT_VERSION) return '备份格式版本不兼容（期望 v' + BACKUP_FORMAT_VERSION + '，收到 v' + obj._formatVersion + '）';
  if (!obj.data || typeof obj.data !== 'object') return '备份缺少 data 数据区';
  const raw = obj.data['ai-task-lens-tasks'];
  if (raw === undefined) return '备份缺少任务数据（ai-task-lens-tasks）';
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return '任务数据不是数组';
  } catch (e) { return '任务数据解析失败：' + e.message; }
  return null;
}
function applyBackupData(data) {
  Object.keys(data).forEach(function(k) {
    localStorage.setItem(k, data[k]);
  });
}
function exportJSONBackup() {
  const payload = buildBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  a.download = 'ai-task-lens-backup_' + ymd + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('完整备份已导出（任务/习惯/金句/高亮/颜色）', 'success');
}
function restoreJSONBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = function() {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      let obj;
      try {
        obj = JSON.parse(ev.target.result);
      } catch (e) { alert('备份文件解析失败：' + e.message); return; }
      const err = validateBackup(obj);
      if (err) { alert('备份文件校验失败：' + err); return; }
      const ts = (obj.data['ai-task-lens-tasks'] || '[]').length;
      if (!confirm('将从备份恢复全部数据（任务/习惯/金句/高亮/隐藏筛选/实体底色），覆盖当前本地数据（约 ' + ts + ' 字符）。\n建议先点「💾 备份」导出当前数据以防万一。\n确定继续？')) return;
      applyBackupData(obj.data);
      alert('恢复成功！页面即将刷新加载备份数据。');
      location.reload();
    };
    reader.readAsText(file, 'utf-8');
  };
  input.click();
}

// JSON 完整备份 / 恢复（R3.30）
document.getElementById('btn-backup-json').addEventListener('click', exportJSONBackup);
document.getElementById('btn-restore-json').addEventListener('click', restoreJSONBackup);

// CSV Import
document.getElementById('btn-import-csv').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    function processCSV(text) {
      try {
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) {
          if (!confirm('CSV 中无数据行（仅表头），将清空当前全部内容，确定吗？')) return;
          tasks = [];
          nextId = 1;
          dataSource = 'csv';
          localStorage.setItem('ai-task-lens-source', 'csv');
          saveData();
          updateDataSourceBadge();
          renderAll();
          showToast('已清空全部数据', 'warn');
          return;
        }
        
        const headerLine = lines[0];
        const commaCount = (headerLine.match(/,/g) || []).length;
        const semiCount = (headerLine.match(/;/g) || []).length;
        const DELIMITER = commaCount >= semiCount ? ',' : ';';
        console.log(`📂 CSV 导入分隔符: "${DELIMITER}" (逗号${commaCount} vs 分号${semiCount})`);
        
        const splitLine = (line) => {
          if (DELIMITER === ',') return parseCSVLine(line);
          return line.split(';').map(s => s.replace(/^"|"$/g, '').trim());
        };
        
        const headers = splitLine(headerLine);
        console.log('📂 CSV 表头:', headers.map((h,i) => `[${i}]${h}`).join(' '));
        
        const idx = {};
        ['id','type','parentId','title','priority','status','deadline','startDate','progress','assignee','isMilestone','isArchived','timestamp','deps','next','files','tag','desc','branches','recurringGroupId','completedAt'].forEach(h => {
          idx[h] = headers.indexOf(h);
        });
        console.log('📂 列索引:', JSON.stringify(idx));
        
        if (idx.id < 0 || idx.type < 0 || idx.title < 0) {
          showToast(
            `CSV 缺少必要列：id、type、title\n\n分隔符: "${DELIMITER}"\n首行: ${headerLine.substring(0, 80)}...`,
            'error'
          ); 
          return;
        }

        const newTasks = [];
        let maxId = 0;
        let _csvFixCount = 0;   // 记录导入时静默纠正的字段数，导入后提示用户
        for (let i = 1; i < lines.length; i++) {
          const vals = splitLine(lines[i]);
          const id = parseInt(vals[idx.id]);
          if (isNaN(id)) continue;
          maxId = Math.max(maxId, id);
          // parentId：parseInt('abc') → NaN，必须用 Number.isFinite 守卫，否则 NaN 落库
          const parentIdVal = vals[idx.parentId];
          let parsedParent = null;
          if (parentIdVal !== undefined && parentIdVal !== '') {
            const pv = parseInt(parentIdVal);
            if (Number.isFinite(pv)) parsedParent = pv;
            else _csvFixCount++;
          }
          // type：CSV 里任意字符串都能进来，必须做枚举白名单
          let parsedType = vals[idx.type] || 'task';
          if (!TYPE_LABELS[parsedType]) { parsedType = 'task'; _csvFixCount++; }
          // priority：兼容旧 P0-P3 / 新中文 / 飞书带加号「级别」三种输入，统一归一化
          let parsedPriority = vals[idx.priority] === undefined || vals[idx.priority] === '' ? DEFAULT_PRIORITY : String(vals[idx.priority]).trim();
          const normPriority = normalizePriority(parsedPriority);
          if (normPriority !== parsedPriority && !LEGACY_PRIORITY_MAP[parsedPriority] && PRIORITY_VALID.indexOf(parsedPriority) === -1) { _csvFixCount++; }
          parsedPriority = normPriority;
          let parsedStatus = vals[idx.status] || 'todo';
          if (!statusMap[parsedStatus]) { parsedStatus = 'todo'; _csvFixCount++; }
          const entity = {
            id,
            type: parsedType,
            parentId: parsedParent,
            children: [],
            title: unescapeCSV(vals[idx.title]) || '未命名',
            priority: parsedPriority,
            status: parsedStatus,
            deadline: vals[idx.deadline] || null,
            startDate: vals[idx.startDate] || null,
            progress: parseFloat(vals[idx.progress]) || 0,
            assignee: unescapeCSV(vals[idx.assignee]) || '',
            isMilestone: vals[idx.isMilestone] === 'true',
            isArchived: idx.isArchived >= 0 ? vals[idx.isArchived] === 'true' : false,
            deps: parseCSVArray(vals[idx.deps]),
            next: parseCSVArray(vals[idx.next]),
            files: parseCSVStringArray(vals[idx.files]).map(function(s) {
              const _url = sanitizeWebUrl(s);
              if (_url) return { fileId: null, name: s, path: '', url: _url };
              return { fileId: null, name: s, path: '' };
            }),
            tag: unescapeCSV(vals[idx.tag]) || '',
            desc: unescapeCSV(vals[idx.desc]) || '',
            branches: parseCSVStringArray(vals[idx.branches]),
            recurringGroupId: idx.recurringGroupId >= 0 ? (vals[idx.recurringGroupId] || null) : null,
            completedAt: idx.completedAt >= 0 ? (vals[idx.completedAt] || null) : null,
            createdAt: new Date().toISOString(),
            timestamp: idx.timestamp >= 0 ? (parseInt(vals[idx.timestamp]) || makeTimestamp()) : makeTimestamp(),
          };
          newTasks.push(entity);
        }

        if (newTasks.length === 0) {
          showToast('CSV 中未解析到任何有效数据行（id 列需为数字），请检查格式', 'warn');
          return;
        }

        rebuildChildren(newTasks);

        const stats = { object: 0, kr: 0, target: 0, task: 0 };
        newTasks.forEach(t => { if (stats[t.type] !== undefined) stats[t.type]++; });
        const preview = `🎯 Object: ${stats.object}  |  📊 KR: ${stats.kr}  |  🎯 Target: ${stats.target}  |  📋 Task: ${stats.task}\n\n将替换当前全部数据（${tasks.length} 条 → ${newTasks.length} 条），确定吗？`;
        if (!confirm(preview)) return;

        tasks = newTasks;
        nextId = maxId + 1;
        dataSource = 'csv';
        localStorage.setItem('ai-task-lens-source', 'csv');
        saveData();

        // 导入后立即体检：悬空 parentId 等问题引导用户去健康度面板处理
        let _healthMsg = '';
        try {
          const _issues = checkHierarchyHealth();
          const _bad = _issues.filter(i => i.severity === 'P0' || i.severity === 'P1').length;
          if (_bad > 0) _healthMsg = `\n检测到 ${_bad} 个结构问题，建议点顶栏「🩺 层级健康度」查看`;
          console.log(`🩺 CSV导入后健康检查：共 ${_issues.length} 项问题（P0/P1 ${_bad} 项）`);
        } catch (e) { console.warn('健康检查未执行：', e); }
        if (_csvFixCount > 0 || _healthMsg) {
          showToast(`CSV 导入完成${_csvFixCount > 0 ? `，已自动纠正 ${_csvFixCount} 处非法字段值` : ''}${_healthMsg}`, _healthMsg ? 'warn' : 'success');
        }

        updateDataSourceBadge();
        renderAll();
        console.log(`✅ CSV 导入完成，dataSource=${dataSource}，共 ${newTasks.length} 条`);
        const loadedStats = `Object ${countByType('object')}  ·  KR ${countByType('kr')}  ·  Target ${countByType('target')}  ·  Task ${countByType('task')}`;
        updateDataSourceBadge();
        showToast(`CSV 导入成功！共 ${tasks.length} 条\n${loadedStats}`, 'success');
      } catch (err) {
        console.error('CSV 导入异常:', err);
        showToast('CSV 解析失败：' + err.message, 'error');
      }
    }
    
    const reader = new FileReader();
    reader.onload = (ev) => {
      let text = ev.target.result.replace(/^\uFEFF/, '');
      if (/[\uFFFD]/.test(text)) {
        const readerGBK = new FileReader();
        readerGBK.onload = (ev2) => {
          processCSV(ev2.target.result.replace(/^\uFEFF/, ''));
        };
        readerGBK.onerror = () => {
          showToast('GBK编码读取也失败，请使用UTF-8编码的CSV文件', 'error');
        };
        readerGBK.readAsText(file, 'GBK');
        return;
      }
      processCSV(text);
    };
    reader.onerror = () => {
      showToast('文件读取失败，请检查文件编码（支持 UTF-8 和 GBK）', 'error');
    };
    reader.readAsText(file, 'UTF-8');
  };
  input.click();
});

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'; i++; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current); current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

function unescapeCSV(val) {
  if (!val) return '';
  return val.replace(/""/g, '"');
}

function parseCSVArray(val) {
  if (!val || !val.trim()) return [];
  return val.split(';').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
}

function parseCSVStringArray(val) {
  if (!val || !val.trim()) return [];
  return val.split(';').map(s => s.trim()).filter(Boolean);
}

function loadDemoData(skipConfirm) {
  if (tasks.length > 0 && !skipConfirm && !confirm('加载演示数据将清空当前数据，确定继续吗？')) return;
  tasks = [];
  nextId = 1;

  function createE(type, parentId, data) {
    const task = {
      id: nextId++, type, parentId, children: [],
      title: data.title || '未命名',
      priority: data.priority || DEFAULT_PRIORITY,
      status: data.status || 'todo',
      deadline: data.deadline || null,
      startDate: data.startDate || null,
      progress: data.progress || 0,
      assignee: data.assignee || '',
      isMilestone: data.isMilestone===true||data.isMilestone==='true',
      deps: data.deps || [],
      next: data.next || [],
      files: data.files || [],
      tag: data.tag || '',
      desc: data.desc || '',
      branches: data.branches || [],
      createdAt: new Date().toISOString()
    };
    tasks.push(task);
    if (parentId) {
      const parent = tasks.find(t => t.id === parentId);
      if (parent) { parent.children = parent.children || []; parent.children.push(task.id); }
    }
    return task;
  }

  // ═══════════════════════════════════════════
  // 🎯 Object: Q3 新品"智联"成功上线
  // ═══════════════════════════════════════════
  const obj = createE('object', null, {
    title: 'Q3 新品"智联"成功上线',
    priority: '重要紧急', status: 'progress',
    assignee: '王总',
    startDate: '2026-07-01',
    isMilestone: true,
    desc: 'Q3核心目标：完成智联产品从开发到上线的全流程，首月达成DAU和GMV双指标'
  });

  // ═══════════════════════════════════════════
  // 📦 Object: 已归档项目（测试归档状态）
  // ═══════════════════════════════════════════
  const objArchived = createE('object', null, {
    title: 'Q2 项目"云帆"（已归档）',
    priority: '重要不紧急', status: 'done', isArchived: true,
    assignee: '李总',
    startDate: '2026-04-01',
    desc: 'Q2已完成项目，用于测试归档状态筛选功能'
  });
  const krArchived = createE('kr', objArchived.id, {
    title: 'KR：云帆用户增长目标达成',
    priority: '重要紧急', status: 'done', isArchived: true,
    assignee: '赵经理'
  });
  const taskArchived = createE('task', krArchived.id, {
    title: '任务：云帆渠道拓展（已归档）',
    priority: '重要不紧急', status: 'done', isArchived: true,
    assignee: '小陈',
    deadline: '2026-06-30',
    progress: 100
  });

  // ═══════════ KR1: 产品就绪 ═══════════
  const kr1 = createE('kr', obj.id, {
    title: '产品就绪度100%，6月30日前可发布',
    priority: '重要紧急', status: 'progress',
    assignee: '李经理',
    startDate: '2026-07-01',
    isMilestone: true
  });

  // Target 1.1: 核心功能闭环
  const t1_1 = createE('target', kr1.id, {
    title: '核心功能开发闭环',
    priority: '重要紧急', status: 'progress'
  });
  const t_register = createE('task', t1_1.id, {
    title: '用户注册与登录模块',
    priority: '重要紧急', status: 'done', deadline: getDateStr(-7), progress: 100,
    assignee: '小张',
    startDate: '2026-06-01',
    files: [{ fileId: null, name: '登录模块PRD.docx', path: '' }, { fileId: null, name: 'OAuth对接文档.pdf', path: '' }],
    tag: '前端', desc: '支持手机号+微信OAuth双通道注册登录'
  });
  const t_pay = createE('task', t1_1.id, {
    title: '支付与订单系统集成',
    priority: '重要紧急', status: 'done', deadline: getDateStr(-5), progress: 100,
    tag: '后端', desc: '对接微信支付+支付宝，订单状态机完整闭环'
  });
  const t_push = createE('task', t1_1.id, {
    title: '实时消息推送服务',
    priority: '重要不紧急', status: 'progress', deadline: getDateStr(0), progress: 60,
    tag: '基础设施', desc: '基于WebSocket的消息推送，支持按用户/标签定向推送'
  });

  // Target 1.2: 质量与安全
  const t1_2 = createE('target', kr1.id, {
    title: '质量与安全达标',
    priority: '重要紧急', status: 'progress'
  });
  const t_test = createE('task', t1_2.id, {
    title: '全量回归测试通过（≥98%覆盖率）',
    priority: '重要紧急', status: 'progress', deadline: getDateStr(0), progress: 70,
    tag: 'QA', desc: '覆盖主流程+异常边界，阻塞性Bug数清零'
  });
  const t_sec = createE('task', t1_2.id, {
    title: '安全渗透扫描零高危',
    priority: '重要紧急', status: 'todo', deadline: getDateStr(1),
    tag: '安全', desc: '由安全团队执行渗透测试，高危漏洞必须在发版前修复'
  });
  const t_perf = createE('task', t1_2.id, {
    title: '性能压测QPS≥2000达标',
    priority: '重要不紧急', status: 'todo', deadline: getDateStr(2),
    tag: '运维', desc: '核心接口在2000QPS下P99延迟<200ms'
  });
  t_sec.deps = [t_test.id]; // 安全扫描依赖回归测试
  t_perf.deps = [t_test.id]; // 压测依赖回归测试
  t_test.next = [t_sec.id, t_perf.id];

  // ═══════════ KR2: DAU 突破 ═══════════
  const kr2 = createE('kr', obj.id, {
    title: '上线首月DAU突破5万',
    priority: '重要紧急', status: 'todo'
  });

  // Target 2.1: 市场预热
  const t2_1 = createE('target', kr2.id, {
    title: '市场预热造势',
    priority: '重要紧急', status: 'progress'
  });
  const t_site = createE('task', t2_1.id, {
    title: '产品官网与落地页上线',
    priority: '重要紧急', status: 'progress', deadline: getDateStr(-2), progress: 80,
    tag: '市场', desc: '品牌官网+H5落地页，含产品介绍、预约入口和数据埋点'
  });
  const t_pr = createE('task', t2_1.id, {
    title: 'PR稿件撰写与媒体通发',
    priority: '重要不紧急', status: 'todo', deadline: getDateStr(1),
    tag: 'PR', desc: '3篇PR稿件（产品发布/行业趋势/创始人观点），覆盖20家科技媒体'
  });
  const t_kol = createE('task', t2_1.id, {
    title: '3位行业KOL合作内容产出',
    priority: '重要不紧急', status: 'todo', deadline: getDateStr(6),
    tag: '营销', desc: '选择行业KOL进行产品体验评测，发布视频/图文内容'
  });
  t_pr.deps = [t_site.id];  // PR需要官网
  t_kol.deps = [t_site.id]; // KOL需要官网
  t_site.next = [t_pr.id, t_kol.id];

  // Target 2.2: 渠道铺设
  const t2_2 = createE('target', kr2.id, {
    title: '渠道矩阵铺设',
    priority: '重要不紧急', status: 'todo'
  });
  const t_store = createE('task', t2_2.id, {
    title: '主流应用商店上架审核',
    priority: '重要紧急', status: 'todo', deadline: getDateStr(3),
    tag: '渠道', desc: 'App Store + 华为/小米/OPPO/vivo应用商店提交审核'
  });
  const t_agent = createE('task', t2_2.id, {
    title: '渠道代理商培训与物料下发',
    priority: '紧急不重要', status: 'todo', deadline: getDateStr(8),
    tag: '渠道', desc: '完成10家核心代理商产品培训，下发宣传物料包'
  });

  // ═══════════ KR3: GMV 达标 ═══════════
  const kr3 = createE('kr', obj.id, {
    title: '首月GMV突破200万',
    priority: '重要不紧急', status: 'todo'
  });

  // Target 3.1: 冷启动
  const t3_1 = createE('target', kr3.id, {
    title: '种子用户冷启动',
    priority: '重要紧急', status: 'todo'
  });
  const t_seed = createE('task', t3_1.id, {
    title: '招募500名种子用户内测',
    priority: '重要紧急', status: 'progress', deadline: getDateStr(4), progress: 25,
    tag: '运营', desc: '通过社群+定向邀请招募种子用户，收集首批反馈和使用数据'
  });
  const t_invite = createE('task', t3_1.id, {
    title: '邀请裂变活动上线',
    priority: '重要紧急', status: 'todo', deadline: getDateStr(8),
    tag: '增长', desc: '"邀请3人得会员"裂变活动，含分享海报和奖励发放逻辑'
  });
  t_invite.deps = [t_seed.id]; // 裂变依赖种子用户
  t_seed.next = [t_invite.id];

  // Target 3.2: 付费转化
  const t3_2 = createE('target', kr3.id, {
    title: '付费转化体系搭建',
    priority: '重要不紧急', status: 'todo'
  });
  const t_coupon = createE('task', t3_2.id, {
    title: '首单立减优惠券策略配置',
    priority: '重要不紧急', status: 'todo', deadline: getDateStr(6),
    tag: '运营', desc: '新用户首单立减30元，配置发放条件和核销规则'
  });
  const t_vip = createE('task', t3_2.id, {
    title: '会员成长体系搭建',
    priority: '紧急不重要', status: 'todo', deadline: getDateStr(13),
    tag: '产品', desc: '设计Lv1~Lv5会员等级，含权益说明和升级规则'
  });

  // ═══════════════════════════════════════════
  // 🧪 测试数据：覆盖所有状态（验证筛选功能）
  // ═══════════════════════════════════════════
  const testObj = createE('object', null, {
    title: '测试项目 - 状态筛选验证',
    priority: '紧急不重要', status: 'progress',
    assignee: '测试员',
    desc: '用于验证各状态筛选功能是否正常工作'
  });

  // 待办状态
  createE('task', testObj.id, {
    title: '状态测试：待办',
    priority: '紧急不重要', status: 'todo',
    tag: '测试', desc: '验证待办状态筛选'
  });

  // 准备中状态
  createE('task', testObj.id, {
    title: '状态测试：准备中',
    priority: '紧急不重要', status: 'preparing',
    tag: '测试', desc: '验证准备中状态筛选'
  });

  // 进行中状态
  createE('task', testObj.id, {
    title: '状态测试：进行中',
    priority: '紧急不重要', status: 'progress', progress: 50,
    tag: '测试', desc: '验证进行中状态筛选'
  });

  // 已完成状态
  createE('task', testObj.id, {
    title: '状态测试：已完成',
    priority: '紧急不重要', status: 'done', progress: 100,
    tag: '测试', desc: '验证已完成状态筛选'
  });

  // 阻塞状态
  createE('task', testObj.id, {
    title: '状态测试：阻塞',
    priority: '紧急不重要', status: 'blocked',
    tag: '测试', desc: '验证阻塞状态筛选'
  });

  // 已取消状态
  createE('task', testObj.id, {
    title: '状态测试：已取消',
    priority: '紧急不重要', status: 'cancel',
    tag: '测试', desc: '验证已取消状态筛选'
  });

  // 已归档状态
  createE('task', testObj.id, {
    title: '状态测试：已归档',
    priority: '紧急不重要', status: 'done', isArchived: true,
    tag: '测试', desc: '验证归档状态筛选（默认不显示）'
  });

  // 保存并刷新
  dataSource = 'demo';
  localStorage.setItem('ai-task-lens-source', 'demo');
  saveData();
  updateDataSourceBadge();
  renderAll();
  if (!skipConfirm) {
    alert('✅ 已加载完整四层案例！\n\n🎯 1 个 Object\n📊 3 个 KR\n🎯 6 个 Target\n📋 16 个 Task\n═══════════\n共 26 个实体\n\n切到 🌐 仪表盘 看全局\n切到 📋 列表 看树形结构\n切到 📅 时间线 看进度');
  }
}

function getDateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ============ INIT ============
loadData();
initHabits();
initQuotes();
// 检测陈旧迁移数据：仅当非 CSV 导入时，若无层级则自动加载演示数据
const hasHierarchy = tasks.some(t => t.type !== 'task');
if ((tasks.length === 0 || !hasHierarchy) && dataSource !== 'csv') {
  if (!hasHierarchy && tasks.length > 0) {
    console.log('⚠️ 检测到陈旧迁移数据（全是task），自动加载演示案例...');
  }
  loadDemoData(true);  // 静默加载，不弹确认框
}
renderAll();
updateDataSourceBadge();
updateQuickActionBadges();
console.log('[version] R3.38 2026-09-05 删除「任务列表」视图（与时间线表格功能重叠）：移除侧边栏 data-view="list" 导航项（含 task-count 徽章）与 view-list 面板；renderAll 中 case \'list\' 兜底改渲染时间线表格；renderList 函数体保留为死代码但加守卫（view-list 面板不存在时安全转时间线表格，杜绝 null 报错）。所有原跳转列表的入口统一改道时间线表格——新增 activateTimelineTable() 统一激活逻辑；navigateToListWithFilter() 重写为映射时间线表格筛选（日期→tlDateFilter、类型→tlTableTypeFilter、已完成→tlDoneFilter、标题/搜索→tlSearch），暂不支持的下钻（进行中/阻塞/待办等状态、KISS、无截止、标签）跳时间线表格并 toast 提示"后续版本补齐"，不报错不白屏；goToListView()/navigateToTaskFromFile() 改走时间线表格；快捷键 2 由列表改指时间线表格，Ctrl+K 搜索改聚焦 tl-search-input。底部「🕐 时间线」按钮醒目化（新增 .qa-timeline-feature 类：未激活淡紫渐变底+主题色描边+加粗，激活实心渐变强阴影）。默认视图复核：启动 currentView=\'dashboard\' 直接 renderAll 渲染全局仪表盘，无任何跳列表逻辑。待补齐：时间线表格的状态多选（progress/blocked 等）、KISS 下钻、无截止筛选');
if (typeof showToast === 'function') setTimeout(() => showToast('页面加载完成（含飞书同步修复）', 'success'), 500);

// 飞书同步按钮事件绑定
(function() {
  const btnPull = document.getElementById('btn-feishu-pull');
  const btnPush = document.getElementById('btn-feishu-push');
  if (btnPull) btnPull.addEventListener('click', syncPullFromFeishu);
  if (btnPush) btnPush.addEventListener('click', syncPushToFeishu);
})();

console.log('🔍 AI 任务透视镜 v2 已就绪');

// ── URL 参数定位（从文件标签管理器跳回）──
(function() {
  const q = new URLSearchParams(window.location.search);
  const taskId = parseInt(q.get('task'));
  if (taskId && !isNaN(taskId)) {
    setTimeout(() => {
      // 自动切换到时间线视图
      currentView = 'timeline-table';
      activeQuickFilter = 'timelineTable';   // 同步侧边栏「时间线」按钮点亮态
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.view-panel').forEach(v => v.classList.remove('active'));
      document.getElementById('view-timeline-table').classList.add('active');
      updateQuickActionStates();
      renderTimelineTable();
      // 弹出编辑弹窗并滚动到对应行（暂态高亮，3秒渐隐）
      editTask(taskId);
      setTimeout(() => {
        const row = document.querySelector('#view-timeline-table tr[data-task-id=\"' + taskId + '\"]');
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.style.transition = 'background 0.8s ease';
          row.style.background = '#FEF3C7';
          setTimeout(() => { row.style.background = ''; }, 3000);
        }
      }, 200);
    }, 300);
  }
})();
console.log('  📊 四层层级：Object → KR → Target → Task');
console.log('  📋 五种视图：仪表盘 | 树形列表 | 时间线 | 优先级矩阵 | 团队看板');
console.log('  🤖 AI 能力：中文语义解析 | 优先级推断 | 层级识别 | 依赖发现 | 分支识别');
console.log('  📦 数据保存在浏览器 localStorage');


// ── 粒子爆裂效果 ──
function createParticleExplosion(x, y) {
  // 颜色更鲜艳、对比度更高
  const colors = [
    '#FF006E', '#FF4D6D', '#FFBE0B', '#FF9F1C',  // 橙红黄
    '#00F5D4', '#00BBF9', '#3A86FF', '#8338EC',    // 青蓝紫
    '#FB5607', '#FF006E', '#7B2CBF', '#2EC4B6'     // 鲜艳色
  ];
  const particleCount = 60; // 更多粒子

  // 1. 先创建一个中心闪光
  const flash = document.createElement('div');
  flash.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    width: 20px;
    height: 20px;
    background: radial-gradient(circle, #fff 0%, #FFD700 40%, transparent 70%);
    border-radius: 50%;
    pointer-events: none;
    z-index: 99999;
    transform: translate(-50%, -50%);
    animation: flashExplode 1.2s ease-out forwards;
  `;
  document.body.appendChild(flash);

  // 2. 大量粒子向外爆射
  for (let i = 0; i < particleCount; i++) {
    const particle = document.createElement('div');
    const size = Math.random() * 18 + 8; // 更大粒子 8-26px
    const angle = (Math.PI * 2 * i) / particleCount + (Math.random() - 0.5) * 0.4;
    const velocity = Math.random() * 250 + 150; // 更远距离
    const tx = Math.cos(angle) * velocity;
    const ty = Math.sin(angle) * velocity - 80; // 向上偏移
    const color = colors[Math.floor(Math.random() * colors.length)];
    const duration = 1.8 + Math.random() * 0.8;

    // 随机形状：圆形或方形
    const isSquare = Math.random() > 0.6;
    const borderRadius = isSquare ? '3px' : '50%';

    particle.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${borderRadius};
      pointer-events: none;
      z-index: 99998;
      box-shadow: 0 0 ${size * 2}px ${color}, 0 0 ${size * 4}px ${color}50;
      transform: translate(-50%, -50%);
      transition: all ${duration}s cubic-bezier(0.25, 0.46, 0.45, 0.94);
    `;
    document.body.appendChild(particle);

    // 触发动画
    requestAnimationFrame(() => {
      particle.style.left = (x + tx) + 'px';
      particle.style.top = (y + ty) + 'px';
      particle.style.opacity = '0';
      particle.style.transform = 'translate(-50%, -50%) scale(0.2)';
    });

    setTimeout(() => particle.remove(), duration * 1000 + 100);
  }

  // 3. 添加闪光动画样式（如果还没有）
  if (!document.getElementById('flash-anim-style')) {
    const style = document.createElement('style');
    style.id = 'flash-anim-style';
    style.textContent = `
      @keyframes flashExplode {
        0% { transform: translate(-50%, -50%) scale(0); opacity: 1; }
        50% { transform: translate(-50%, -50%) scale(8); opacity: 0.8; }
        100% { transform: translate(-50%, -50%) scale(12); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  // 4. 显示 "🎉 完成！" 文字
  const textEl = document.createElement('div');
  textEl.style.cssText = `
    position: fixed;
    left: ${x}px;
    top: ${y}px;
    font-size: 28px;
    font-weight: bold;
    color: #FFD700;
    text-shadow: 0 0 20px #FFD700, 0 0 40px #FF6B00;
    pointer-events: none;
    z-index: 100000;
    transform: translate(-50%, -50%);
    animation: textPop 2s ease-out forwards;
    white-space: nowrap;
  `;
  textEl.textContent = '🎉 完成！';
  document.body.appendChild(textEl);

  if (!document.getElementById('text-pop-style')) {
    const style = document.createElement('style');
    style.id = 'text-pop-style';
    style.textContent = `
      @keyframes textPop {
        0% { transform: translate(-50%, -50%) scale(0); opacity: 0; }
        30% { transform: translate(-50%, -50%) scale(1.3); opacity: 1; }
        60% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        100% { transform: translate(-50%, -80px) scale(0.8); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  setTimeout(() => { flash.remove(); textEl.remove(); }, 3000);
}

// ── 涟漪效果 ──
function createRipple(element, e) {
  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  const rect = element.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  ripple.style.width = ripple.style.height = size + 'px';
  ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
  ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
  element.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);
}

// ── Quick Actions ──
// 侧边栏快速筛选：互斥组仅「时间线」（R3.36 移除今日待办/本周到期/本月到期，R3.37 移除已完成），
// 另有「叠加」「筛选」两个独立 toggle。再次点击已点亮的按钮 = 取消筛选。
function quickFilter(type) {
  try {
    // 「叠加」和「筛选」是两个独立 toggle，不参与上方 4 个按钮的互斥组
    if (type === 'archiveOverlay') {
      showArchived = !showArchived;
      if (showArchived) archiveOnly = false;   // 互斥：叠加 ON → 筛选 OFF
      updateQuickActionStates();
      renderAll();   // 保持当前视图，不强制切到列表
      return;
    }
    if (type === 'archiveFilter') {
      archiveOnly = !archiveOnly;
      if (archiveOnly) showArchived = false;   // 互斥：筛选 ON → 叠加 OFF
      updateQuickActionStates();
      renderAll();   // 保持当前视图，不强制切到列表
      return;
    }

    // 再次点击同一个按钮 → 取消（R3.38：列表视图已移除，取消时间线 = 清筛选并回到全局仪表盘）
    if (activeQuickFilter === type) {
      clearAllFilters(true);   // 内部已把 activeQuickFilter 置 null
      const dashBtn = document.querySelector('.nav-item[data-view="dashboard"]');
      if (dashBtn) dashBtn.click();
      else { currentView = 'dashboard'; renderAll(); }
      return;
    }

    // 切换到新按钮：先全清（含清掉上一个点亮态），再只设当前这一个
    clearAllFilters(true);
    activeQuickFilter = type;   // 必须在 clearAllFilters 之后赋值，否则被清掉

    // 特例：时间线表格视图（切到独立的 view-timeline-table，不走 nav-item 路由）
    if (type === 'timelineTable') {
      activateTimelineTable(true);
      return;
    }

    // R3.36/R3.37/R3.38：侧边栏互斥组仅剩时间线（上方已处理 return），其余按钮均已移除。
    goToListView();
  } catch(e) {
    console.error('quickFilter error:', e);
  }
}

// R3.38：任务列表视图已移除，原「切到列表」统一改为切到时间线表格视图
function goToListView() {
  activateTimelineTable(true);
}

function updateQuickActionStates() {
  // 互斥组按钮：仅时间线（R3.36 移除今日待办/本周到期/本月到期，R3.37 移除已完成），由 activeQuickFilter 统一决定
  const map = {
    'qa-timeline-tl': 'timelineTable',
  };
  Object.entries(map).forEach(([id, key]) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', activeQuickFilter === key);
  });
  // 下方 2 个归档按钮：独立 toggle，不参与互斥组
  const btnOverlay = document.getElementById('qa-archive-overlay');
  if (btnOverlay) btnOverlay.classList.toggle('active', showArchived);
  const btnFilter = document.getElementById('qa-archive-filter');
  if (btnFilter) btnFilter.classList.toggle('active', archiveOnly);
}

function updateQuickActionBadges() {
  try {
    if (!tasks || !Array.isArray(tasks)) return;

    // R3.36：侧边栏今日待办/本周到期/本月到期三按钮已移除；R3.37：已完成按钮已移除，
    // 不再计算对应徽章。已完成任务的查看改由列表视图「状态」筛选器（状态=已完成）承担。
    const archived = tasks.filter(t => t && isArchivedOf(t)).length;
    // 时间线（表格视图）徽章：未归档的内容块总数
    const timelineTotal = tasks.filter(t => t && !isArchivedOf(t)).length;

    const badgeTLTable = document.getElementById('badge-timeline-tl');
    const badgeArchived = document.getElementById('badge-archive-overlay');

    if (badgeTLTable) badgeTLTable.textContent = timelineTotal;
    if (badgeArchived) badgeArchived.textContent = archived;
    // 顶栏健康度红点顺带刷新（P0+P1 数量）
    if (typeof updateHealthBadge === 'function') updateHealthBadge();
  } catch(e) {
    console.error('updateQuickActionBadges error:', e);
  }
}

// ── Toast ──
function showToast(msg, type) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'success');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 4000);
}


// ── Sync Progress UI ──
let progressPollInterval = null;
let currentRequestId = null;

function startProgressPolling(requestId, onComplete) {
  currentRequestId = requestId;
  const progressDiv = document.getElementById('sync-progress');
  const statusSpan = document.getElementById('progress-status');
  const messageDiv = document.getElementById('progress-message');
  const logsDiv = document.getElementById('progress-logs');
  const barDiv = document.getElementById('progress-bar');
  
  if (progressDiv) progressDiv.style.display = 'block';
  if (statusSpan) statusSpan.textContent = '连接中...';
  if (messageDiv) messageDiv.textContent = '正在建立连接...';
  if (logsDiv) logsDiv.innerHTML = '';
  if (barDiv) barDiv.style.width = '0%';
  
  const startTime = Date.now();
  const MAX_POLLING_TIME = 10 * 60 * 1000;
  const MAX_RETRY_INTERVAL = 5000;
  let currentInterval = 500;
  let consecutiveFailures = 0;
  let pollTimeout = null;
  
  const poll = async () => {
    if (!currentRequestId || currentRequestId !== requestId) return;
    
    if (Date.now() - startTime > MAX_POLLING_TIME) {
      console.error('[progress] 轮询超时，已停止');
      stopProgressPolling();
      if (onComplete) onComplete({ status: 'error', message: '轮询超时，同步可能仍在后台进行' });
      return;
    }
    
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(SYNC_SERVER + '/progress?requestId=' + requestId, { signal: ctrl.signal });
      const progressData = await res.json();
      updateProgressUI(progressData);
      
      consecutiveFailures = 0;
      currentInterval = 500;
      
      if (progressData.status === 'done' || progressData.status === 'error') {
        stopProgressPolling();
        if (onComplete) onComplete(progressData);
      } else {
        pollTimeout = setTimeout(poll, currentInterval);
      }
    } catch (e) {
      consecutiveFailures++;
      console.error('[progress] 轮询失败 (第 ' + consecutiveFailures + ' 次):', e.message);
      
      if (consecutiveFailures >= 5) {
        console.error('[progress] 连续失败 5 次，已停止轮询');
        stopProgressPolling();
        if (onComplete) onComplete({ status: 'error', message: '与同步服务器失去连接' });
        return;
      }
      
      currentInterval = Math.min(currentInterval * 2, MAX_RETRY_INTERVAL);
      pollTimeout = setTimeout(poll, currentInterval);
    }
  };
  
  progressPollInterval = { cancel: function() { if (pollTimeout) clearTimeout(pollTimeout); } };
  poll();
}

function stopProgressPolling() {
  if (progressPollInterval && typeof progressPollInterval.cancel === 'function') {
    progressPollInterval.cancel();
    progressPollInterval = null;
  } else if (progressPollInterval) {
    clearInterval(progressPollInterval);
    progressPollInterval = null;
  }
}

function updateProgressUI(progressData) {
  var statusSpan = document.getElementById('progress-status');
  var messageDiv = document.getElementById('progress-message');
  var logsDiv = document.getElementById('progress-logs');
  var barDiv = document.getElementById('progress-bar');
  var container = document.getElementById('sync-progress');
  
  if (statusSpan) {
    var statusText = progressData.status === 'starting' ? '初始化...' :
                     progressData.status === 'pulling' ? '拉取中...' :
                     progressData.status === 'pushing' ? '推送中...' :
                     progressData.status === 'done' ? '✅ 推送完成' :
                     progressData.status === 'error' ? '❌ 推送失败' : progressData.status;
    statusSpan.textContent = statusText;
    // 完成/失败时高亮
    if (progressData.status === 'done') statusSpan.style.color = '#16a34a';
    else if (progressData.status === 'error') statusSpan.style.color = '#dc2626';
    else statusSpan.style.color = '';
  }
  
  // 完成时显示结果摘要
  if (messageDiv) {
    if (progressData.status === 'done' && progressData.result) {
      var r = progressData.result;
      var summary = '创建 ' + (r.created || 0) + ' 条 · 更新 ' + (r.updated || 0) + ' 条';
      if (r.errors && r.errors.length > 0) {
        summary += ' · ⚠️ ' + r.errors.length + ' 个错误';
      }
      messageDiv.textContent = summary;
    } else {
      messageDiv.textContent = progressData.message || '';
    }
  }
  
  if (barDiv && progressData.total > 0) {
    var percent = Math.round((progressData.current / progressData.total) * 100);
    barDiv.style.width = percent + '%';
    if (progressData.status === 'done') barDiv.style.background = '#16a34a';
    else if (progressData.status === 'error') barDiv.style.background = '#dc2626';
    else barDiv.style.background = '';
  }
  
  // 完成时自动展开面板确保可见
  if (container && (progressData.status === 'done' || progressData.status === 'error')) {
    container.style.display = 'block';
  }
  
  // 更新日志
  if (logsDiv && progressData.logs) {
    var logEntries = progressData.logs.slice(-50);  // 显示最后 50 条日志
    var logsHTML = '';
    for (var i = 0; i < logEntries.length; i++) {
      var log = logEntries[i];
      var time = new Date(log.time).toLocaleTimeString();
      var levelClass = log.level === 'info' ? 'log-info' : 
                       log.level === 'warn' ? 'log-warn' : 
                       log.level === 'error' ? 'log-error' : '';
      logsHTML += '<div class="' + levelClass + '">[' + time + '] ' + log.message + '</div>';
    }
    logsDiv.innerHTML = logsHTML;
    logsDiv.scrollTop = logsDiv.scrollHeight;
  }
}

function closeProgress() {
  const progressDiv = document.getElementById('sync-progress');
  if (progressDiv) progressDiv.style.display = 'none';
  stopProgressPolling();
}

// ── Feishu Sync ──
const SYNC_SERVER = 'http://127.0.0.1:9877';

let syncInProgress = false;

// 带重试的 fetch 函数（用于推送等关键请求）
async function fetchWithRetry(url, options = {}, maxRetries = 2, baseDelay = 2000) {
  const timeout = options.timeout || 60000;
  
  for (let i = 0; i <= maxRetries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      clearTimeout(timer);
      if (i < maxRetries && e.name !== 'AbortError') {
        console.warn('[sync] 请求失败，重试 ' + (i + 1) + '/' + maxRetries + ': ' + e.message);
        await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, i)));
      } else {
        throw e;
      }
    }
  }
}

// 单条同步到飞书
async function syncSingleTask(taskId) {
  var t = tasks.find(function(x) { return x.id === taskId; });
  if (!t) return;
  if (t.type !== 'kr' && t.type !== 'task') { showToast('仅 KR 和 Task 支持同步', 'warn'); return; }
  if (syncPaused) { showToast('同步已暂停', 'warn'); return; }
  if (syncInProgress) { showToast('同步进行中', 'warn'); return; }
  if (!confirm('确定将「' + t.title + '」同步到飞书？')) return;
  syncInProgress = true;
  try {
    showToast('正在同步...', 'warn');
    if (!await checkSyncServer()) throw new Error('服务器未运行');
    var pd = document.getElementById('sync-progress');
    if (pd) { pd.style.display = 'block'; document.getElementById('progress-status').textContent = '推送中...'; document.getElementById('progress-message').textContent = '单条: ' + t.title; }
    var res = await fetchWithRetry(SYNC_SERVER + '/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entities: [t], force: true }), timeout: 60000 }, 2, 2000);
    var data = await res.json();
    if (data.requestId) {
      startProgressPolling(data.requestId, function(pd2) {
        syncInProgress = false;
        if (pd2.status === 'done') {
          var r = pd2.result || {};
          if (r.feishuIds && r.feishuIds[String(t.id)]) { t.feishuRecordId = r.feishuIds[String(t.id)]; t._lastPushedTs = t.timestamp; saveData(); }
          showToast('✅ 同步成功', 'success');
        } else if (pd2.status === 'error') {
          showToast('失败: ' + pd2.message, 'error');
        }
      });
    } else {
      syncInProgress = false;
      if (data.feishuIds && data.feishuIds[String(t.id)]) { t.feishuRecordId = data.feishuIds[String(t.id)]; t._lastPushedTs = t.timestamp; saveData(); }
      showToast('✅ 同步成功', 'success');
    }
  } catch (err) { syncInProgress = false; showToast('失败: ' + err.message, 'error'); }
}

function setSyncButtons(disabled) {
  syncInProgress = disabled;
  const btnPull = document.getElementById('btn-feishu-pull');
  const btnPush = document.getElementById('btn-feishu-push');
  if (btnPull) btnPull.disabled = disabled;
  if (btnPush) btnPush.disabled = disabled;
  if (disabled) {
    if (btnPull) btnPull.textContent = '⏳ 同步中...';
  } else {
    if (btnPull) btnPull.textContent = '🔄 飞书→本地';
  }
}

// ── 同步暂停开关 ──
var syncPaused = localStorage.getItem('ai-task-lens-sync-paused') === 'true';

function applySyncPauseState() {
  const btnPause = document.getElementById('btn-sync-pause');
  const btnPull = document.getElementById('btn-feishu-pull');
  const btnPush = document.getElementById('btn-feishu-push');
  if (syncPaused) {
    if (btnPause) { btnPause.textContent = '▶️ 恢复同步'; btnPause.style.background = '#fef3c7'; btnPause.style.borderColor = '#f59e0b'; }
    if (btnPull) { btnPull.disabled = true; btnPull.title = '同步已暂停'; }
    if (btnPush) { btnPush.disabled = true; btnPush.title = '同步已暂停'; }
    const dot = document.getElementById('server-status-dot');
    if (dot) { dot.style.background = '#9ca3af'; dot.title = '同步已暂停'; }
  } else {
    if (btnPause) { btnPause.textContent = '⏸️ 暂停同步'; btnPause.style.background = ''; btnPause.style.borderColor = ''; }
    if (btnPull) { btnPull.disabled = false; btnPull.title = '从飞书多维表格拉取数据到本地'; }
    if (btnPush) { btnPush.disabled = false; btnPush.title = '将本地数据推送到飞书多维表格'; }
    updateServerStatusDot();
  }
}

function toggleSyncPause() {
  syncPaused = !syncPaused;
  localStorage.setItem('ai-task-lens-sync-paused', syncPaused ? 'true' : 'false');
  if (syncPaused) {
    // 立即停止正在进行的同步轮询
    stopProgressPolling();
    closeProgress();
    syncInProgress = false;
    setSyncButtons(false);
  }
  applySyncPauseState();
  showToast(syncPaused ? '同步已暂停' : '同步已恢复', syncPaused ? 'warn' : 'success');
}

// 页面加载时应用暂停状态
setTimeout(applySyncPauseState, 100);

// 同步服务器健康检查（支持重试，总共等待最多 10 秒）
async function checkSyncServer(maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const ctrl = new AbortController();
      const timeout = 3000;
      setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(SYNC_SERVER + '/ping', { signal: ctrl.signal });
      const data = await res.json();
      if (data.ok === true) return true;
    } catch (e) {
      console.warn('[sync] 服务器检查失败 (尝试 ' + (i + 1) + '/' + maxRetries + '):', e.message);
    }
    if (i < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, i)));
    }
  }
  return false;
}

// 更新服务器状态指示灯
async function updateServerStatusDot() {
  var dot = document.getElementById('server-status-dot');
  if (!dot) return;
  var ok = await checkSyncServer();
  dot.style.background = ok ? '#22c55e' : '#ef4444';
  dot.title = ok ? '同步服务器运行中 (端口 9877)' : '同步服务器未运行';
  return ok;
}

async function syncPullFromFeishu() {
  console.log('[sync] syncPullFromFeishu CALLED, syncInProgress=', syncInProgress, 'SYNC_SERVER=', SYNC_SERVER);
  if (syncPaused) { showToast('同步已暂停，请先恢复', 'warn'); return; }
  if (syncInProgress) { console.log('[sync] already in progress, returning'); return; }
  setSyncButtons(true);
  try {
    showToast('正在检查同步服务器...', 'warn');
    const serverOk = await checkSyncServer();
    if (!serverOk) throw new Error('同步服务器未运行，请先启动 sync_server.js（端口 ' + SYNC_SERVER.split(':').pop() + '）');
    
    // 立即显示进度面板
    const progressDiv = document.getElementById('sync-progress');
    if (progressDiv) {
      progressDiv.style.display = 'block';
      const statusSpan = document.getElementById('progress-status');
      const messageDiv = document.getElementById('progress-message');
      const barDiv = document.getElementById('progress-bar');
      if (statusSpan) statusSpan.textContent = '连接中...';
      if (messageDiv) messageDiv.textContent = '正在连接同步服务器...';
      if (barDiv) barDiv.style.width = '0%';
    }
    
    showToast('正在从飞书拉取数据...', 'warn');
    const res = await fetchWithRetry(SYNC_SERVER + '/pull', { method: 'POST' }, 2, 2000);
    const data = await res.json();
    
    if (data.requestId && data.async) {
      // 异步模式：立即启动进度轮询，在完成回调中处理合并
      startProgressPolling(data.requestId, function(progressData) {
        if (progressData.status === 'done') {
          var result = progressData.result || {};
          if (!result.success) {
            alert('拉取失败：' + (result.error || '未知错误'));
            showToast('拉取失败', 'error');
            setSyncButtons(false);
            return;
          }
          // 执行合并逻辑
          handlePullMerge(result);
        } else if (progressData.status === 'error') {
          alert('拉取失败：' + progressData.message);
          showToast('拉取失败', 'error');
          setSyncButtons(false);
        }
      });
    } else {
      // 兼容旧模式（同步返回结果）
      if (!data.success) throw new Error(data.error || '拉取失败');
      handlePullMerge(data);
    }
  } catch (err) {
    console.error('[sync] 飞书拉取失败:', err);
    showToast('飞书拉取失败：' + err.message, 'error');
    setSyncButtons(false);
  }
}

// 拉取数据合并处理（从 syncPullFromFeishu 中抽取）
function handlePullMerge(data) {
  // 先清除旧的同步标记
  tasks.forEach(t => { delete t._syncStatus; });
  
  var feishuEntities = data.entities || [];
  console.log('[sync] got', feishuEntities.length, 'feishu entities');

  // ── 合并模式 ──
  var feishuByRid = {};
  feishuEntities.forEach(e => {
    if (e.feishuRecordId) feishuByRid[e.feishuRecordId] = e;
  });

  var stats = { updated: 0, newFeishu: 0, localOnly: 0, unchanged: 0 };
  var merged = [];
  var feishuNew = [];
  var localOnlyTasks = [];
  var feishuMatched = new Set();
  var timestampConflicts = [];

  tasks.forEach(local => {
    if (local.feishuRecordId && feishuByRid[local.feishuRecordId]) {
      var fe = feishuByRid[local.feishuRecordId];
      feishuMatched.add(local.feishuRecordId);
      if (local.timestamp && fe.timestamp && local.timestamp !== fe.timestamp) {
        timestampConflicts.push({
          id: local.id,
          title: local.title || fe.title || '未命名',
          localTs: local.timestamp,
          feishuTs: fe.timestamp
        });
      }
      var updated = Object.assign({}, local, fe, { id: local.id, _syncStatus: 'feishu' });
      if (local.tag) updated.tag = local.tag;
      if (local.assignee) updated.assignee = local.assignee;
      merged.push(updated);
      stats.updated++;
    } else {
      local._syncStatus = 'local-only';
      merged.push(local);
      localOnlyTasks.push(local);
      stats.localOnly++;
    }
  });

  feishuEntities.forEach(fe => {
    if (fe.feishuRecordId && !feishuMatched.has(fe.feishuRecordId)) {
      fe._syncStatus = 'new-feishu';
      feishuNew.push(fe);
    } else if (!fe.feishuRecordId) {
      var exists = merged.find(m => m.type === 'object' && m.title === fe.title);
      if (!exists) {
        fe._syncStatus = 'new-feishu';
        feishuNew.push(fe);
      }
    }
  });

  var idMap = {};
  feishuNew.forEach(fe => {
    var newId = nextId++;
    idMap[fe.id] = newId;
    fe.id = newId;
    merged.push(fe);
    stats.newFeishu++;
  });

  merged.forEach(t => {
    if (t.parentId != null && t.parentId !== '' && idMap[t.parentId]) {
      t.parentId = idMap[t.parentId];
    }
  });

  // parentId 归一化为数字（飞书返回可能是字符串），再统一重建 children
  merged.forEach(t => {
    if (t.parentId === null || t.parentId === undefined || t.parentId === '') { t.parentId = null; return; }
    var pid = Number(t.parentId);
    t.parentId = Number.isFinite(pid) ? pid : null;
  });

  tasks = merged;
  var seen = new Set();
  tasks = tasks.filter(t => { if (seen.has(t.id)) { console.warn('[sync] 合并去重：跳过重复 ID=', t.id, t.title); return false; } seen.add(t.id); return true; });
  rebuildChildren(tasks);
  dataSource = 'feishu';
  localStorage.setItem('ai-task-lens-source', 'feishu');
  saveData();
  updateDataSourceBadge();
  renderAll();

  var parts = [];
  if (stats.updated > 0) parts.push('🔄 更新 ' + stats.updated + ' 条');
  if (stats.newFeishu > 0) parts.push('➕ 飞书新增 ' + stats.newFeishu + ' 条');
  if (stats.localOnly > 0) parts.push('📌 仅本地 ' + stats.localOnly + ' 条（已保留）');
  var msg = parts.join(' | ') || '数据无变化';
  showToast('飞书合并完成 — ' + msg, stats.localOnly > 0 ? 'warn' : 'success');

  var conflictMsg = '';
  if (timestampConflicts.length > 0) {
    conflictMsg = '\n\n⚠️ 时间戳冲突（' + timestampConflicts.length + ' 条）：\n' +
      timestampConflicts.slice(0, 5).map(c =>
        '  · ' + c.title + '\n    本地: ' + c.localTs + '  →  飞书: ' + c.feishuTs
      ).join('\n') +
      (timestampConflicts.length > 5 ? '\n  ... 等共 ' + timestampConflicts.length + ' 条' : '') +
      '\n\n时间戳不一致说明数据可能被篡改，请核对。';
  }

  alert('飞书合并完成！\n\n' + parts.join('\n') + conflictMsg + '\n\n仅本地的任务不会被覆盖，请及时处理。');
  console.log('[sync] Merge done:', stats, 'total:', tasks.length, 'conflicts:', timestampConflicts.length);
  setSyncButtons(false);
}

async function syncPushToFeishu() {
  if (syncPaused) { showToast('同步已暂停，请先恢复', 'warn'); return; }
  if (syncInProgress) return;
  
  // Shift+点击 = 全量推送（忽略增量跳过）
  var event = window.event;
  var forceAll = event && event.shiftKey;
  
  // 推送前去重检测
  var seen = {};
  var deduped = [];
  var dupCount = 0;
  tasks.forEach(function(t) {
    if (seen[t.id]) {
      console.warn('[sync] 发现重复任务 ID=' + t.id + ' title=' + t.title + '，已跳过');
      dupCount++;
    } else {
      seen[t.id] = true;
      deduped.push(t);
    }
  });
  if (dupCount > 0) {
    tasks = deduped;
    saveData();
    alert('检测到 ' + dupCount + ' 条重复记录已自动清理。');
  }
  
  // 增量推送：跳过近期已推送且未变更的记录
  var pushEntities = [];
  var skippedCount = 0;
  tasks.forEach(function(t) {
    if (!forceAll && t._lastPushedTs === t.timestamp) {
      skippedCount++;
    } else {
      pushEntities.push(t);
    }
  });
  
  if (!forceAll && pushEntities.length === 0) {
    alert('所有 ' + tasks.length + ' 条记录均未变更，无需推送。\n\n（按住 Shift 点击按钮可强制全量推送）');
    return;
  }
  
  var confirmMsg = '确定推送数据到飞书？已有记录会更新，新记录会创建。';
  if (skippedCount > 0) {
    confirmMsg += '\n\n已跳过 ' + skippedCount + ' 条未变更记录\n将推送 ' + pushEntities.length + ' 条';
  }
  if (!confirm(confirmMsg)) return;
  
  console.log('[sync] 推送前：总计', tasks.length, '条，跳过', skippedCount, '条，实际推送', pushEntities.length, '条');
  
  setSyncButtons(true);
  try {
    showToast('正在检查同步服务器...', 'warn');
    var serverOk = await checkSyncServer();
    if (!serverOk) throw new Error('同步服务器未运行，请先启动 sync_server.js（端口 ' + SYNC_SERVER.split(':').pop() + '）');
    
    var progressDiv = document.getElementById('sync-progress');
    if (progressDiv) {
      progressDiv.style.display = 'block';
      var statusSpan = document.getElementById('progress-status');
      var messageDiv = document.getElementById('progress-message');
      var barDiv = document.getElementById('progress-bar');
      if (statusSpan) statusSpan.textContent = '连接中...';
      if (messageDiv) messageDiv.textContent = skippedCount > 0 ? '增量推送 ' + pushEntities.length + ' 条（跳过 ' + skippedCount + ' 条未变更）' : '正在连接同步服务器...';
      if (barDiv) barDiv.style.width = '0%';
    }
    
    showToast('正在推送数据到飞书...', 'warn');
    var res = await fetchWithRetry(SYNC_SERVER + '/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entities: pushEntities, force: forceAll }),
      timeout: 60000
    }, 2, 2000);
    var data = await res.json();
    
    if (data.requestId) {
      startProgressPolling(data.requestId, function(progressData) {
        setSyncButtons(false);
        if (progressData.status === 'done') {
          var result = progressData.result || {};
          if (result.feishuIds) {
            tasks.forEach(function(t) {
              if (result.feishuIds[String(t.id)]) {
                t.feishuRecordId = result.feishuIds[String(t.id)];
                t._lastPushedTs = t.timestamp;
              }
            });
            saveData();
          }
          var msg = '推送完成！\n\n创建: ' + (result.created || 0) + ' 条\n更新: ' + (result.updated || 0) + ' 条' +
            (result.errors && result.errors.length > 0 ? '\n错误: ' + result.errors.length + ' 条\n' + result.errors.slice(0, 5).join('\n') : '');
          alert(msg);
          showToast('推送完成', 'success');
          console.log('[sync] Push done:', result);
        } else if (progressData.status === 'error') {
          alert('推送失败：' + progressData.message);
          showToast('推送失败', 'error');
        }
      });
    } else {
      if (!data.success && data.errors && data.errors.length > 0) {
        console.warn('[sync] Push errors:', data.errors);
      }
      if (data.feishuIds) {
        tasks.forEach(function(t) {
          if (data.feishuIds[String(t.id)]) {
            t.feishuRecordId = data.feishuIds[String(t.id)];
            t._lastPushedTs = t.timestamp;
          }
        });
        saveData();
      }
      var msg2 = '推送完成！\n\n创建: ' + (data.created || 0) + ' 条\n更新: ' + (data.updated || 0) + ' 条' +
        (data.errors && data.errors.length > 0 ? '\n错误: ' + data.errors.length + ' 条\n' + data.errors.slice(0, 5).join('\n') : '');
      alert(msg2);
      showToast('推送完成', 'success');
      console.log('[sync] Push done:', data);
    }
  } catch (err) {
    console.error('[sync] 飞书推送失败:', err);
    showToast('飞书推送失败：' + err.message, 'error');
    if (err.name === 'AbortError') {
      alert('推送超时，请检查网络或减少数据量后重试。');
    }
  } finally {
    setSyncButtons(false);
  }
}

async function showSyncDiff() {
  if (syncPaused) { showToast('同步已暂停，请先恢复', 'warn'); return; }
  if (syncInProgress) { showToast('正在同步中，请稍后', 'warn'); return; }

  const serverOk = await checkSyncServer();
  if (!serverOk) {
    alert('同步服务器未运行，请先启动 sync_server.js');
    return;
  }

  showToast('正在对比本地与飞书数据...', 'warn');

  try {
    const res = await fetchWithRetry(SYNC_SERVER + '/diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entities: tasks }),
      timeout: 60000
    }, 2, 2000);

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || '对比失败');
    }

    renderDiffPanel(data);
  } catch (err) {
    console.error('[sync] Diff failed:', err);
    showToast('对比失败：' + err.message, 'error');
  }
}

function renderDiffPanel(data) {
  const { localTotal, feishuTotal, localOnly, feishuOnly, changed, unchanged, details } = data;

  let html = `
    <div class="diff-modal-overlay" onclick="closeDiffPanel(event)">
      <div class="diff-modal" onclick="event.stopPropagation()">
        <div class="diff-modal-header">
          <h2>🔄 双向同步对比</h2>
          <button class="diff-modal-close" onclick="closeDiffPanel()">✕</button>
        </div>
        <div class="diff-summary">
          <div class="summary-item">
            <span class="summary-label">本地数据</span>
            <span class="summary-value">${localTotal} 条</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">飞书数据</span>
            <span class="summary-value">${feishuTotal} 条</span>
          </div>
          <div class="summary-item local-only">
            <span class="summary-label">本地独有</span>
            <span class="summary-value">${localOnly} 条</span>
          </div>
          <div class="summary-item feishu-only">
            <span class="summary-label">飞书独有</span>
            <span class="summary-value">${feishuOnly} 条</span>
          </div>
          <div class="summary-item changed">
            <span class="summary-label">内容变更</span>
            <span class="summary-value">${changed} 条</span>
          </div>
          <div class="summary-item unchanged">
            <span class="summary-label">完全一致</span>
            <span class="summary-value">${unchanged} 条</span>
          </div>
        </div>
        <div class="diff-content">
          <div class="diff-column">
            <div class="column-header local-only-bg">
              <span>📌 本地独有 (${localOnly})</span>
              <button class="btn btn-sm btn-primary" onclick="syncPushLocalOnly()">全部推送</button>
            </div>
            <div class="column-body">
              ${details.localOnly.length === 0 ? '<div class="empty-column">无差异</div>' : details.localOnly.map(item => `
                <div class="diff-item">
                  <div class="item-header">
                    <span class="item-type">${getTypeIcon(item.local.type)}</span>
                    <span class="item-title">${escapeHtml(item.local.title || '(无标题)')}</span>
                  </div>
                  <div class="item-meta">
                    <span>状态: ${statusMap[item.local.status] || item.local.status}</span>
                    <span>优先级: ${item.local.priority || DEFAULT_PRIORITY}</span>
                  </div>
                  <button class="btn btn-xs btn-primary" onclick="syncPushSingle(${item.local.id})">推送</button>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="diff-column">
            <div class="column-header feishu-only-bg">
              <span>☁️ 飞书独有 (${feishuOnly})</span>
              <button class="btn btn-sm btn-primary" onclick="syncPullFeishuOnly()">全部拉取</button>
            </div>
            <div class="column-body">
              ${details.feishuOnly.length === 0 ? '<div class="empty-column">无差异</div>' : details.feishuOnly.map(item => `
                <div class="diff-item">
                  <div class="item-header">
                    <span class="item-type">${getTypeIcon(item.remote.type)}</span>
                    <span class="item-title">${escapeHtml(item.remote.title || '(无标题)')}</span>
                  </div>
                  <div class="item-meta">
                    <span>状态: ${item.remote.status}</span>
                    <span>优先级: ${FEISHU_TO_LOCAL_PRIORITY[item.remote.priority] || item.remote.priority}</span>
                  </div>
                  <button class="btn btn-xs btn-primary" onclick="syncPullSingle('${item.remote.ts}')">拉取</button>
                </div>
              `).join('')}
            </div>
          </div>
          <div class="diff-column">
            <div class="column-header changed-bg">
              <span>🔄 内容变更 (${changed})</span>
              <button class="btn btn-sm btn-primary" onclick="syncPushChanged()">本地覆盖飞书</button>
              <button class="btn btn-sm btn-outline" onclick="syncPullChanged()">飞书覆盖本地</button>
            </div>
            <div class="column-body">
              ${details.changed.length === 0 ? '<div class="empty-column">无差异</div>' : details.changed.map(item => `
                <div class="diff-item">
                  <div class="item-header">
                    <span class="item-type">${getTypeIcon(item.local.type)}</span>
                    <span class="item-title">${escapeHtml(item.local.title || '(无标题)')}</span>
                  </div>
                  <div class="diffs-list">
                    ${item.diffs.map(diff => `
                      <div class="diff-row">
                        <span class="diff-field">${getFieldName(diff.field)}:</span>
                        <span class="diff-local">本地: ${escapeHtml(diff.local)}</span>
                        <span class="diff-arrow">→</span>
                        <span class="diff-remote">飞书: ${escapeHtml(diff.remote)}</span>
                      </div>
                    `).join('')}
                  </div>
                  <div class="item-actions">
                    <button class="btn btn-xs btn-primary" onclick="syncPushSingle(${item.local.id})">本地→飞书</button>
                    <button class="btn btn-xs btn-outline" onclick="syncPullSingle('${item.local.timestamp}')">飞书→本地</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
        <div class="diff-modal-footer">
          <button class="btn btn-outline" onclick="closeDiffPanel()">关闭</button>
          <button class="btn btn-primary" onclick="syncAll()">一键同步全部</button>
        </div>
      </div>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.id = 'diff-panel';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

function closeDiffPanel(e) {
  const panel = document.getElementById('diff-panel');
  if (panel) panel.remove();
}

function getTypeIcon(type) {
  const icons = { object: '🎯', kr: '📊', target: '🎯', task: '📋' };
  return icons[type] || '📌';
}

function getFieldName(field) {
  const names = { title: '标题', status: '状态', priority: '优先级', deadline: '截止日期' };
  return names[field] || field;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function syncPushLocalOnly() {
  const panel = document.getElementById('diff-panel');
  if (!panel) return;

  const items = [];
  panel.querySelectorAll('.diff-column:first-child .diff-item').forEach(el => {
    const id = parseInt(el.querySelector('button').getAttribute('onclick').match(/syncPushSingle\((\d+)\)/)[1]);
    items.push(tasks.find(t => t.id === id));
  });

  if (items.length === 0) {
    showToast('没有要推送的数据', 'warn');
    return;
  }

  if (!confirm(`确定将 ${items.length} 条本地独有数据推送到飞书？`)) return;

  try {
    const res = await fetch(SYNC_SERVER + '/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entities: items, force: true }),
    });
    const data = await res.json();
    if (data.requestId) {
      startProgressPolling(data.requestId, (progressData) => {
        if (progressData.status === 'done') {
          showToast('推送完成', 'success');
          closeDiffPanel();
          renderAll();
        }
      });
    }
  } catch (err) {
    showToast('推送失败：' + err.message, 'error');
  }
}

// ── 更新记录 ──
const CHANGELOG = [
  {
    ver: 'R3.38',
    date: '2026-09-05',
    items: [
      '删除「任务列表」视图（与时间线表格功能高度重叠）：移除侧边栏「📋 任务列表」导航项（含 299 数量徽章）与 view-list 面板。主导航现为 全局仪表盘 / 日历 / 优先级矩阵 / 团队看板 / 每日习惯，全部内容清单统一由底部「🕐 时间线」表格视图承担',
      '所有原跳转列表的入口改道时间线表格：新增 activateTimelineTable() 统一激活；navigateToListWithFilter() 重写为映射时间线表格筛选——日期卡片（今日/本周/本月/逾期）→ tlDateFilter、类型卡片（目标/KR/任务等）→ tlTableTypeFilter、已完成卡片 → tlDoneFilter、建议下一步/洞察标题 → tlSearch 搜索框并聚焦',
      '暂不支持的下钻（仪表盘「进行中/被阻塞」卡片、KISS 复盘列头、无截止日期、标签）点击后跳到时间线表格并 toast 提示"后续版本补齐"，不报错、不白屏；这些筛选能力计划在时间线表格补齐（状态多选、KISS 筛选）',
      '底部「🕐 时间线」入口按钮醒目化：未激活即淡紫渐变底 + 主题色描边 + 加粗文字，在白底按钮群中一眼可见；激活后实心主题色渐变 + 强阴影',
      '快捷键调整：数字键 2 原切列表、现切时间线表格；Ctrl/Cmd+K 或 / 搜索改为切时间线表格并聚焦其搜索框；从文件标签管理器跳回任务也改到时间线表格定位',
      '默认视图确认为全局仪表盘：页面打开即渲染仪表盘（currentView=\'dashboard\'）；在时间线视图再点「时间线」按钮 = 清除筛选并回到全局仪表盘',
      'renderList 函数体保留为不可达死代码（clearAllFilters/列筛选等共用逻辑仍引用），但加了守卫——view-list 面板不存在时任何意外调用都安全转渲染时间线表格，杜绝 null 报错',
      '自测：_test_quickfilter.js（58 断言）、_test_completed_visibility.js（41 断言）、_test_done_sort.js（19 断言）同步更新为验证改道映射；node --check 通过；全量测试回归无失败',
    ],
  },
  {
    ver: 'R3.37',
    date: '2026-09-03',
    items: [
      '继续精简左侧边栏快速操作区：移除「✅ 已完成」按钮（qa-done 及 badge-done 徽章）。侧边栏快速操作区现为三个按钮：时间线（互斥组唯一按钮，再点取消）+ 叠加、筛选（归档独立 toggle，两者互斥）',
      '已完成任务的查看不受影响，改由列表视图「状态」筛选器承担：列表页状态下拉选「已完成」即 statusFilter=[done] 并按完成时间新→旧排序（completed-desc），该筛选器是与侧边栏独立的代码路径，本次未改动',
      '代码清理：updateQuickActionStates 点亮 map 移除 qa-done 键；updateQuickActionBadges 移除 doneCount 计数与 badge-done 写入；quickFilter 移除仅剩的 done case（statusFilter/listSortType 设置）及取消分支里 done 的排序复位特殊处理',
      '自测：_test_quickfilter.js 重写（静态断言 qa-done/badge-done/case done 均已移除、列表状态筛选器仍支持已完成；行为桩收敛为时间线互斥 + 叠加/筛选 toggle）；_test_completed_visibility.js 第 8 节、_test_done_sort.js 第 3 节同步改为断言「按钮已移除 + 列表状态筛选器保留已完成排序能力」',
    ],
  },
  {
    ver: 'R3.36',
    date: '2026-09-03',
    items: [
      '精简左侧边栏快速操作区：移除「今日待办 / 本周到期 / 本月到期」三个日期快捷筛选按钮。日期快捷筛选仍可从两个入口使用——仪表盘顶部的同名快捷卡片（点击跳转列表按日期筛选）、时间线表格视图筛选栏（今日/本周/本月/逾期四档），两者均与侧边栏按钮是独立代码，本次未受影响',
      '侧边栏快速操作区现为四个按钮：时间线、已完成（互斥单选，再点取消）+ 叠加、筛选（归档独立 toggle，两者互斥）',
      '代码清理：updateQuickActionStates 点亮 map 移除三键；updateQuickActionBadges 移除三个徽章计数与写入（仪表盘卡片徽章在 renderDashboard 内独立计算，不受影响）；quickFilter switch 移除 todayTodo/weekDue/monthDue 三个 case；navigateToListWithFilter 仪表盘卡片分支移除三行失效的 activeQuickFilter 点亮赋值（dateFilter 筛选设置保留，仪表盘卡片筛选照常生效）',
      '自测：_test_quickfilter.js 重写为 57 断言——静态防回归（index.html 无 qa-today/qa-week/qa-month 及徽章、app.js map/switch/徽章函数已清理、仪表盘卡片与时间线筛选栏仍在）+ 行为桩（互斥单选/再点取消/叠加筛选互斥/与互斥组共存/清筛选全灭）',
    ],
  },
  {
    ver: 'R3.35',
    date: '2026-09-03',
    items: [
      '修复 KISS 复盘面板漏匹配 bug：仪表盘 KISS 面板与列表页 kiss 筛选在匹配 [KEEP]/[IMPROVE]/[START]/[STOP] 标记时，误读任务描述字段为 description（数据模型中描述字段实际叫 desc，description 恒为 undefined，被 ||"" 兜底成空串），导致只有写在【标题】里的标记能命中，写在【描述】里的标记全部漏匹配——用户反馈"找不到 START 项目"即此因',
      '两处统一改为 t.desc / taskData.desc，与普通关键词搜索（同文件 t.desc）、addTask/editTask/saveTask/CSV 导出的数据模型一致；现在标题或描述任一处含标记均可归入对应列，大小写不敏感',
      '自测：临时桩脚本 8 断言全过（描述[START]命中、标题[KEEP]命中、小写[start]大小写不敏感、无标记不命中、一条可同时归多列、反证旧逻辑 description 漏匹配）；node --check 通过',
    ],
  },
  {
    ver: 'R3.34',
    date: '2026-09-03',
    items: [
      '编辑任务弹窗「后置任务」旁「＋ 新建」改为打开完整的新建任务窗口（与时间线行内「+ 后置内容」是同一个弹窗），不再用 prompt 只填标题——可在新建时一次性设置优先级/状态/截止日期/负责人/描述等全部字段',
      '自动预填：前置任务 = 当前正在编辑的任务；开始时间 = 前置任务的结束时间（截止日期 deadline，前置未设截止日期时回落为今天）。保存新任务后由 next/deps 双向同步自动建立依赖，无需回来再搜',
      '编辑已有任务时点「＋ 新建」会先静默保存当前修改（参照任务链跳转的"先存再跳"逻辑）：当前表单校验不通过（如未选上级、标题为空）或用户在确认框取消时，中止打开新建窗，避免丢失改动；新建未保存模式下当前任务尚无 id，按钮提示先保存',
      'addNextTask 统一支持开始时间预填，时间线行内「+ 后置内容」入口同样默认开始时间=前置截止日期',
    ],
  },
  {
    ver: 'R3.33',
    date: '2026-09-02',
    items: [
      '编辑任务弹窗「后置任务」选择框右侧新增「＋ 新建」按钮：点击后弹窗输入标题，即快速创建一个任务并自动添加为后置依赖，无需先退出弹窗到列表里建任务再回来搜索',
      '新建任务默认采用搜索框已输入的关键词作为标题预填；创建后立即出现在后置 chip 列表，保存当前任务时由 next/deps 双向同步自动建立依赖关系（新任务的前置依赖自动指向当前任务）',
      '新建任务为独立 task 类型（parentId=null，不属于任何目标层级），与行内「添加后置任务」默认同父级的行为区分，避免在弹窗中快速补录后续事项时误挂到错误层级',
      '（R3.34 已升级：该 prompt 快速创建改为打开完整新建任务窗口，本条保留为历史记录）',
    ],
  },
  {
    ver: 'R3.32',
    date: '2026-09-01',
    items: [
      '每日金句管理弹窗新增「✏️ 编辑」：每条金句旁编辑按钮 → 表单回填内容/作者 → 按钮切换为「💾 保存修改 / 取消」→ 保存后更新并重渲染（quoteEditingId 记录编辑态）',
      '删除正在编辑的金句自动退出编辑模式；编辑态保存空内容仍校验拦截',
      '新增 _test_quotes_edit.js（桩 DOM 验证：回填/更新/取消/删除清理/编辑态保存）',
    ],
  },
  {
    ver: 'R3.31',
    date: '2026-09-01',
    items: [
      '时间线表格视图新增搜索筛选：筛选栏「快速筛选：」后新增搜索框，按标题/描述/标签/负责人匹配（大小写不敏感）',
      '命中保留祖先链：子内容块命中时沿 parentId 回溯显示其祖先目标，保持树形结构可读（computeSearchVisibleSet 纯函数，byId Map 缓存 + seen guard 防环形引用）',
      '搜索优先于其他筛选：关键词非空时忽略日期/类型/已完成/实体筛选，清空或 Esc 后恢复；头部「（已筛选）」提示与清除筛选按钮同步纳入搜索条件',
      '输入 200ms 防抖（debouncedRenderTimelineTable），重渲染后自动恢复输入框焦点与光标位置，连续输入不断',
      'IME 修复（最终版）：搜索框节点复用架构——tlSearchInput 只创建一次，渲染时移动节点到 slot 占位而非重建（innerHTML 重写不销毁节点对象），配合组合中跳过渲染（tlSearchComposing 标志 + 防抖回调检查），任何输入法的组词过程都不会被打断；修复"输不进去中文/组合被强制提交"问题',
      '新增 _test_timeline_search.js（纯函数 + DOM 桩断言）；既有时间线测试脚本同步补 tlSearch/computeSearchVisibleSet 桩',
    ],
  },
  {
    ver: 'R3.30',
    date: '2026-08-29',
    items: [
      '新增「💾 备份 / ♻️ 恢复」：顶栏一键导出完整 JSON 备份（覆盖任务层级/依赖/习惯/金句/高亮/隐藏筛选/实体底色等 11 个 localStorage key），可从备份文件完整还原——解决"清浏览器数据即全丢"与 CSV 丢层级/依赖的问题',
      '恢复流程安全兜底：文件格式版本校验（_formatVersion）+ 任务数据必须是数组 + confirm 明确警告覆盖当前数据 + 恢复后自动刷新页面重载',
      '备份排除健康检查撤销快照（HEALTH_SNAPSHOT_KEY，属临时恢复点）；帮助弹窗「数据管理」章节补充备份说明（CSV 不含习惯/金句/高亮，完整备份才全）',
    ],
  },
  {
    ver: 'R3.29',
    date: '2026-08-27',
    items: [
      '实体筛选按钮（目标 / KR / 游离 KR）右键新增「🎨 设置底色」：可给每个实体按钮自定义浅底深字底色，便于视觉区分不同目标',
      '色板含 12 个预设色 + 自定义取色器 + 「恢复默认底色」；颜色存 localStorage（ai-task-lens-entity-colors），刷新/跨视图（列表/日历/看板/表格）一致保留',
      '优先级安全：选中态（深紫发光）、上下文态、⭐高亮、已完成、已取消的状态色均不受自定义色覆盖——这些态下不输出内联样式，自定义色只作用于普通未选中态',
      '新增 _test_entity_colors.js：23 个断言全部通过，含 12 预设色文字对比度 WCAG AA（≥4.5）校验、状态门控、set/clear 逻辑',
    ],
  },
  {
    ver: 'R3.28',
    date: '2026-08-27',
    items: [
      '时间线表格筛选栏「⚠️ 已逾期」按钮加警示色：未选中浅红底红字、悬停加深、选中实心红 + 红色呼吸发光（tl-btn-overdue）',
      '筛选栏日期档位选中统一亮蓝的规则加 :not(.tl-btn-overdue) 排除，避免红色被蓝色覆盖',
    ],
  },
  {
    ver: 'R3.27',
    date: '2026-08-27',
    items: [
      '使用帮助弹窗「数据管理」章节补充「飞书认证过期处理」：提示认证已过期时先重试（可能是网络抖动误报），仍失败则在命令行执行 lark-cli auth login --domain drive --as user 重新授权',
      '说明文件标签管理器设置面板提供「🔑 一键重新授权」按钮，无需命令行',
    ],
  },
  {
    ver: 'R3.26',
    date: '2026-08-26',
    items: [
      '修复 record/schedule/idea 选择上级时找不到 KR/任务的问题：上级选择器的 parentTypes 硬编码映射只含 object/kr/target/task，附属类型回落成「仅 object 可选」，导致记录无法挂到 KR 下',
      'onTypeChange 与 quickCreateParent 改为复用 ALLOWED_PARENTS 单一来源（record/schedule/idea 为 * → 全部 7 类可挂），保存与健康检查本就按 * 处理，UI 现在与数据规则一致',
      '新增测试脚本 _test_parent_types.js：11 个断言全部通过（含模拟「9月15号 立项技术准备」KR 可被搜索命中）',
    ],
  },
  {
    ver: 'R3.25',
    date: '2026-08-26',
    items: [
      '新增「❓ 使用帮助」弹窗：侧边栏底部「使用帮助」按钮 + 快捷键 ? 打开',
      '帮助内容分 5 章：核心概念（OKR 层级/优先级/状态）、视图导览（含快捷键 1-6）、常用操作（新建/任务链/周期任务/归档/AI 录入）、快捷键表、数据管理（localStorage/CSV/飞书/健康检查）',
      '弹窗支持 Esc 关闭、遮罩点击关闭、内部滚动，样式约定与健康检查弹窗一致（文件末尾）',
      '? 快捷键从「弹 toast 提示」升级为「打开完整帮助弹窗」',
      '测试断言更新至 25 个全部通过（新增 ? 打开帮助、Esc 关闭帮助）',
    ],
  },
  {
    ver: 'R3.24',
    date: '2026-08-26',
    items: [
      '修复新建快捷键与浏览器冲突：Ctrl+N 是浏览器「新建窗口」保留键，页面层无法可靠拦截',
      '新建改为 Ctrl/Cmd+Alt+N（浏览器不占用）或单键 N（Notion 风格，无修饰键，非输入态）',
      '测试断言更新至 23 个全部通过（新增 Ctrl+N 不触发、Ctrl+Alt+N 触发、单键 N 触发、输入框内 N 不触发）',
    ],
  },
  {
    ver: 'R3.23',
    date: '2026-08-25',
    items: [
      '新增全局快捷键：Ctrl+N 新建内容块 / Ctrl+K 或 / 搜索（切到列表视图并聚焦搜索框）/ 数字键 1-6 切换视图 / Esc 关闭弹窗 / ? 显示快捷键帮助',
      '数字键 3 在「日历 ↔ 时间线表格」两个视图间循环切换（其余数字键对应仪表盘/列表/矩阵/看板/习惯）',
      '防误触：输入框/文本域聚焦时屏蔽所有快捷键（Esc 除外）；任意弹窗打开时屏蔽视图切换与新建（Esc 除外）',
      '新增测试脚本 _test_shortcuts.js（桩模式，20 个断言全部通过）',
    ],
  },
  {
    ver: 'R3.22',
    date: '2026-08-25',
    items: [
      '新建内容块默认优先级从「紧急不重要」改为「重要不紧急」',
      '修改 DEFAULT_PRIORITY 常量，所有新建入口（createNewContent/addChildTask/addNextTask/addTask）统一生效',
    ],
  },
  {
    ver: 'R3.21',
    date: '2026-08-25',
    items: [
      '编辑属性弹窗中「时间与依赖」「标签与附件」两个分组改为默认展开（原先默认折叠）',
      'closeTaskModal 关闭时重置两个分组为展开，避免用户手动折叠后下次打开仍保持折叠',
      '分组标题颜色鲜艳化：时间与依赖用橙色系（#C2410C 文字 + #FB923C 底边），标签与附件用紫色系（#7C3AED 文字 + #A78BFA 底边），视觉上一眼区分',
    ],
  },
  {
    ver: 'R3.20',
    date: '2026-08-25',
    items: [
      '时间线表格筛选栏在「💡 想法」后新增「✅ 已完成」状态筛选：仅显示 status=done 的条目，带徽章计数',
      '与类型/实体筛选可叠加（如「已完成」+「任务」= 已完成的任务），与日期筛选互斥（激活自动关闭对方，避免 0 条结果）',
      '新增 tlDoneFilter 变量、_doneMatch 匹配函数、setTlDoneFilter 切换函数；徽章计数改用显式日期键遍历，避免未知档位误计数',
      '选中态用亮绿色（#16A34A）+ 独立 tl-glow-done 呼吸发光动画，与想法按钮的深绿色区分',
    ],
  },
  {
    ver: 'R3.19',
    date: '2026-08-25',
    items: [
      '修复再次点击已选中的 KR 实体按钮时视觉上像触发了「清除筛选」：改为回退到其所属 Object（上钻一级），Object 保持 active 发光、第三行 KR 组不消失，只有再点 Object 才真正取消',
      'nearestObjectIdOf 从 renderEntityFilterButtons 内部函数提升为全局函数，供 toggleTlTableEntityFilter 复用',
      '游离 KR（无上级 Object）再次点击仍直接取消，因为没有可回退的上级',
    ],
  },
  {
    ver: 'R3.18',
    date: '2026-08-25',
    items: [
      '修复时间线表格行 hover 时底部出现灰色投影区域、内容上移的问题：外投影 box-shadow 改为 inset 内描边，去掉 translateX(2px) 位移，hover 只变背景色+内描边，不再溢出表格或抖动',
    ],
  },
  {
    ver: 'R3.17',
    date: '2026-08-25',
    items: [
      '选中 KR 时其上级 Object 按钮（ctx 上下文态）同步呼吸发光，目标与关键结果同时亮，视觉上明确归属关系',
      '.tl-table-filter-bar .entity-object.ctx 加紫色 tl-glow-purple 动画 + text-shadow，其他三视图 ctx 态保持不变',
    ],
  },
  {
    ver: 'R3.16',
    date: '2026-08-24',
    items: [
      '【体验强化】选中态发光效果大幅增强：色光环扩散半径 4px→10px、投影模糊 16px→28px，亮度脉冲 brightness(1→1.35)，加白色文字霓虹光晕 text-shadow',
      '动画周期 1.8s→1.2s，呼吸节奏更快更明显；box-shadow + filter:brightness + text-shadow 三重叠加，选中按钮在视觉上明显"跳动"',
      'Object/KR/游离KR 实体按钮选中态同步强化（含 text-shadow）',
      '仍然不改变 font-size/font-weight/transform/尺寸，同行按钮零移位',
    ],
  },
  {
    ver: 'R3.15',
    date: '2026-08-24',
    items: [
      '【体验修复】选中态不再改变按钮尺寸：移除字号增大(13.5-14px)、字重变化(600→800)、transform 上浮、::before ✓ 勾号——这些都会改变按钮宽度导致同行按钮移位换行',
      '改用 CSS 呼吸发光动画（@keyframes，1.8s ease-in-out infinite）：选中时 box-shadow 在 0→4px 色光环 + 8→16px 投影之间脉冲，颜色变化明显但布局零重排',
      '7 种类型各有独立色光 keyframes：蓝(日期/KR)、紫(目标/记录)、青(子目标)、灰(任务)、琥珀(日程/游离KR)、绿(想法)',
      'transition 从 all .15s 改为只过渡 background-color/border-color/color/box-shadow，避免动画与过渡冲突',
      '其他视图（任务列表/日历/看板）的实体按钮保持原有静态选中样式，呼吸动画仅作用于时间线表格筛选栏',
    ],
  },
  {
    ver: 'R3.14',
    date: '2026-08-24',
    items: [
      '【视觉强化】标题栏「清除筛选」「创建内容」按钮改为绝对居中、加大字号(13px)和内边距，带投影更醒目',
      '分组标签「目标」「关键结果」「游离 KR」字号从 10px 放大到 12px、加粗到 800、圆角加大、Object 标签加紫色投影',
      '选中态全面强化：日期/类型/KR 按钮选中时前加 ✓ 勾号、字号放大(13.5-14px)、字重 800、上浮 2px、3-4px 色光投影 + 3px 外环 + 内高光',
      '未选中态降对比度：文字色从 gray-500 降到 gray-400，Object 按钮未选中从深紫实心底改为浅紫底(#EDE9FE)+紫描边，与选中态深紫实心形成强对比',
      'Object「上下文态」(ctx) 适配新底色，加 inset 2px 紫描边 + 投影',
    ],
  },
  {
    ver: 'R3.13',
    date: '2026-08-24',
    items: [
      '【UI 优化】清除筛选按钮从筛选栏移至标题栏，与「创建内容」按钮并排靠右；无筛选条件激活时按钮禁用（灰色不可点）',
      '选中态视觉增强：所有 tag-btn 选中时加粗(font-weight:600)+上浮(translateY(-1px))+投影(box-shadow)，日期档位选中色从深灰改为蓝色(#2563EB)带蓝色发光',
      'Object/KR 实体按钮选中态阴影增强（加入色光投影+上浮），与未选中态形成更强对比',
      '标题栏「（已筛选）」提示改为红色加粗，有筛选条件时一眼可见',
      '修正 R3.12 CHANGELOG：清除按钮最终位置是标题栏而非筛选栏第一行',
    ],
  },
  {
    ver: 'R3.12',
    date: '2026-08-24',
    items: [
      '【UI 优化】时间线表格视图快速筛选栏拆为三行：第一行日期档位+类型档位，第二行目标(Object)实体按钮，第三行关键结果(KR)实体按钮',
      'renderEntityFilterButtons() 新增 wrapLines 参数（默认 false，其他三视图不受影响）；为 true 时在目标/KR 分组前插入 flex-basis:100% 换行占位元素',
      '清除筛选按钮移至第一行末尾（日期+类型行），不再跟实体按钮挤在同一行',
    ],
  },
  {
    ver: 'R3.11',
    date: '2026-08-24',
    items: [
      '【新增】时间线表格视图快速筛选栏接入目标(Object)/关键结果(KR)实体按钮，复用公共函数 renderEntityFilterButtons() 和全局变量 tlEntityFilters',
      '新增 _entityMatch()：沿 parentId 链向上收集祖先 id（含自身），带 seen guard 防御环形引用；筛选条件与日期档位、类型档位叠加生效',
      '新增 toggleTlTableEntityFilter()：表格视图专用切换（旧版 toggleTlEntityFilter 调日历 renderTimeline，不适配表格）',
      '清除筛选按钮联动重置 tlEntityFilters；计数栏「（已筛选）」提示条件扩展为三类筛选任一激活',
    ],
  },
  {
    ver: 'R3.10',
    date: '2026-08-23',
    items: [
      '【核心 bug 修复】已完成视图排序不生效：renderList() 第 858 行原先从 DOM select 读取排序方式，但新 select 在第 991 行 innerHTML 才写入，导致首次进入时读到旧值 tree 而非 completed-desc，排序完全不执行。改为优先读 listSortType 全局变量',
      'completed-desc 比较器增加 timestamp 二级排序键（完成时间相同时按最后修改时间倒序），解决历史数据 completedAt 全部相同导致排序无效',
    ],
  },
  {
    ver: 'R3.9',
    date: '2026-08-22',
    items: [
      '列表视图新增「完成时间」列（只读），位置在「截止日期」与「开始时间」之间，让 completed-desc 排序结果可见可验证',
      '修复编辑弹窗回填完成时间时遗留的 _toDatetimeLocalValue 未定义引用（恢复为 toLocaleString 只读显示）',
    ],
  },
  {
    ver: 'R3.8',
    date: '2026-08-22',
    items: [
      '「已完成视图」默认按完成时间 新→旧 排序：仪表盘「已完成」卡片入口补齐 completed-desc 排序（侧边栏「已完成」快捷按钮本已支持，本次统一两处入口）',
    ],
  },
  {
    ver: 'R3.7',
    date: '2026-08-22',
    items: [
      '时间线表格视图性能优化：筛选徽章（今日/本周/本月/逾期 + 7 种类型）计数由原先每次各自 filter 全表扫描（O(11N)）改为单趟遍历归并（O(N)）',
      '日历视图搜索框输入改为 200ms 防抖：连续击键只触发一次全量重渲染，消除输入卡顿',
      '新增通用 debounce(fn, ms) 工具函数，供后续高频事件复用',
    ],
  },
  {
    ver: 'R3.6',
    date: '2026-08-16',
    items: [
      '相关文件支持网络链接：编辑弹窗可粘贴 http/https 链接（仅放行这两种协议，拒绝 javascript:/file: 等），带可选显示名称',
      '列表/时间线视图链接 chip 以 🔗 图标 + 青色高亮区分，鼠标单击直接新窗口打开链接；悬浮卡显示 URL 并提供「打开链接」按钮',
      'CSV 导出/导入支持链接往返：导出输出 URL，导入自动识别重建链接',
      '本地文件关联行为完全不变：仍跳转文件管理系统定位/打开',
    ],
  },
  {
    ver: 'R3.5',
    date: '2026-08-16',
    items: [
      '优先级体系四象限化：P0/P1/P2/P3 → 重要紧急/重要不紧急/紧急不重要/不紧急不重要（直接存入 priority 字段）',
      '数据迁移 v6→v7：存量 P0-P3 自动迁移为四象限中文值（幂等），并修复 forceMigrate 在 v6+ 误重建时间戳的风险（timestamp 是飞书同步 key）',
      '编辑弹窗优先级下拉、列表/矩阵/时间线/任务链徽章、排序、列筛选、TXT 导出全部改为四象限中文',
      '优先级矩阵改为直接按 priority 字段归类（去掉 deadline 启发式），所见即所得',
      '新增 PRIORITY_COLORS/ORDER/GRADIENTS/ICONS 统一常量，修复时间线表格 P2 误用绿色与其他视图不一致的 bug',
      'CSV 导入兼容三种输入：旧 P0-P3 / 新中文 / 飞书带加号「级别」格式，统一归一化',
      '飞书同步字段源从「优先级」(高/中/低) 切换为「级别」(重要+紧急 等四象限)，pull/push/diff 双向映射',
    ],
  },
  {
    ver: 'R3.4',
    date: '2026-08-14',
    items: [
      '编辑弹窗防误关：点击遮罩不再关闭弹窗，避免误触丢失编辑内容',
      '取消/✕ 按钮：有未保存改动时弹确认框（"有未保存的修改，确定放弃并关闭吗？"），无改动直接关闭',
      '统一关闭逻辑 closeTaskModal()：统一清理 editingTaskId/nextParentTaskId/selectedDeps/selectedNexts/selectedFiles',
      '修复遮罩关闭漏清 nextParentTaskId 的脏状态 bug',
      '编辑弹窗内"完成时间"字段展示（completedAt 只读显示）',
    ],
  },
  {
    ver: 'R3.3',
    date: '2026-08-11',
    items: [
      '新增 completedAt 字段：任务状态变为 done 时记录完成时间（ISO 格式），重新打开置 null',
      '数据迁移 v5→v6：现有 done 任务用 createdAt 推导 completedAt，幂等补全',
      '新增"完成时间"排序选项（新→旧 / 旧→新），有完成时间的任务排前',
      '侧边栏新增"已完成"快捷按钮：一键筛选 done 任务 + 按完成时间倒序排列',
      '甘特图/优先级矩阵/团队看板新增"含已完成"开关，不再硬编码排除 done',
      '完成后即时反馈：Toast 提示任务标题 + 滚动到该行 + 黄色高亮闪烁动画',
      'CSV 导出/导入新增 completedAt 列',
    ],
  },
  {
    ver: 'R3.2',
    date: '2026-08-09',
    items: [
      '周期任务架构重构：从「1个任务+多日期」共享实体模型改为「创建时批量生成独立任务」模型',
      '每个周期任务实例完全独立：独立 id/timestamp/deadline/status，可独立编辑/删除/完成/归档',
      'recurringGroupId 软关联：同批创建的任务共享一个 groupId，日历视图紫色标识，编辑弹窗显示批次提示',
      '编辑弹窗批次操作：查看同批任务列表、批量删除同批任务',
      '数据迁移 v4→v5：旧周期任务（isRecurring+dates）自动展开为多个独立任务，doneDates 映射为 status=done',
      '删除 isRecurring/repeatRule/dates/doneDates 四字段及相关逻辑（toggleDayDone/parseCSVJSON/飞书保护块）',
      'CSV 导出/导入：4 列 JSON 序列化简化为 1 列 recurringGroupId 普通字符串',
      '单批上限 365 个任务，批量创建只 saveData/renderAll 一次保证性能',
    ],
  },
  {
    ver: 'R3.1',
    date: '2026-08-09',
    items: [
      '周期任务属性（task/schedule 专属）：勾选「🔁 周期任务」后开始日期=截止日期自动同步锁定',
      '多次日期默认由用户手动点选：编辑弹窗内嵌迷你月历点击勾选/取消（紫色=规则生成，浅色=手动添加）；频率规则（每天/每周多选星期几/每月选几号）保留，选好后点「⚡ 按规则生成」才自动生成，不替用户做主',
      '日历视图：周期任务的每个日期各显示一条，紫色底色区分普通日程；每条可单独标记/取消当日完成（doneDates），完成态淡色划线',
      '周期日期数据持久化：isRecurring / repeatRule / dates / doneDates 四字段，数据版本 3→4 自动迁移',
      'CSV 导出/导入新增 4 列（isRecurring/repeatRule/dates/doneDates，JSON 序列化），飞书同步合并保护周期字段不被旧值覆盖',
    ],
  },
  {
    ver: 'R3.0',
    date: '2026-08-08',
    items: [
      '全局仪表盘新增「每日金句」面板：用户可自行添加金句，每次随机展示 3 条',
      '金句面板支持「换一批」按钮：点击重新随机选取 3 条，不刷新整个仪表盘',
      '金句管理弹窗：可添加自定义金句（正文+作者），可删除任意金句',
      '金句数据持久化到 localStorage（ai-task-lens-quotes），无内置预设，全部由用户管理',
      '金句面板位置在 KISS 复盘面板与 dashboard-grid 之间，视觉风格与仪表盘一致',
    ],
  },
  {
    ver: 'R2.9',
    date: '2026-08-08',
    items: [
      '全局仪表盘新增 KISS 复盘面板：内容块标题或描述中含有 [KEEP] / [IMPROVE] / [START] / [STOP] 标记的，按四列展示',
      'KISS 面板支持点击列头跳转列表按文字标记筛选、点击任务项打开编辑弹窗',
      'navigateToListWithFilter 新增 kiss 筛选分支，仪表盘→列表的文字标记筛选链路打通',
      '无 KISS 内容时显示引导提示，引导用户在标题或描述中添加 [KEEP] 等标记',
    ],
  },
  {
    ver: 'R2.8',
    date: '2026-08-08',
    items: [
      '上下文导航：编辑弹窗增加面包屑导航条，显示完整祖先链（Object → KR → Target → Task），祖先节点可点击跳转',
      '任务位置预览面板增强：完整祖先链 + 直接子节点 + 同级节点chip，全部可点击跳转到对应实体',
      '依赖关系chip可点击：预览面板的前置(←)和后置(→)可直接跳转到对应实体',
      '列表视图悬浮操作栏新增「↑ 上级」按钮，有父级的实体可一键跳转',
      '跳转前自动保存：编辑弹窗内点击面包屑/树节点/兄弟chip/依赖chip时自动保存当前编辑，不再弹出确认框',
      '附属信息缩进对齐：schedule/record/idea 统一缩进至 task 级别（64px），不再与顶层目标视觉平级',
      '修复编辑弹窗右下角保存按钮被遮挡：.modal-task-layout 固定高度改为弹性布局，header/footer 始终可见',
    ],
  },
  {
    ver: 'R2.7',
    date: '2026-08-02',
    items: [
      '新增「🩺 层级健康度」检查面板：一次体检 39 项数据完整性问题，按 P0 致命 / P1 严重 / P2 索引一致性 / P3 业务语义 四档分组',
      '支持逐条勾选后批量修复，修复前自动写 localStorage 快照，可一键撤销；备份失败时中止修复而非硬改数据',
      '自动修复项统一为「降级到安全值」（悬空 parentId → 置空、非法枚举 → 默认值），不删除任何实体',
      '半自动修复项（游离 KR、依赖成环等）在面板内提供下拉选择上级或断边方式',
      '顶栏按钮带红点角标，实时显示 P0+P1 问题数量',
      '快速筛选：已归档的目标 / 关键结果不再出现在筛选栏；已取消显示为灰底删除线，已完成显示为绿底',
      '快速筛选 Object 与 KR 视觉区分强化为三重编码：形状（方角 vs 胶囊）+ 填充（深紫实心 vs 白底蓝描边）+ 前缀符号（◆ vs ▸）',
      '修复黄色高亮标记撞上 Object 白字导致的「黄底白字不可读」问题',
      '修复飞书同步合并顺序错误：原先在 ID 去重前重建 children，重复 ID 会污染索引',
      '修复 CSV 导入未校验字段：parentId 为非数字时 parseInt 产出 NaN 直接落库；type/priority/status 现改为枚举白名单校验并统计纠正次数',
      '修复 CSV 导入 timestamp 直接取 id 导致的时间戳撞车，改用 makeTimestamp()',
      '修复 ancestorsOf() 遇到环形 parentId 时死循环卡死渲染',
      'children 索引重建逻辑收敛为公共函数 rebuildChildren()，消除 loadData / 飞书合并 / CSV 导入三处重复实现',
    ],
  },
  {
    ver: 'R2.6',
    date: '2026-08-01',
    items: [
      '修复 R2.5 回归：未关联上级目标的 KR 在快速筛选栏永久失踪（因为没有目标可选来"解锁"它）',
      '新增「⚠ 游离 KR」独立分组：上级为空 / 上级已删除 / 上级非目标 三种情况的 KR 一律常驻显示，不受目标选中状态门控',
      '游离 KR 用琥珀色虚线边框区别于正常 KR，悬停提示「建议在编辑弹窗中补上级」',
      'KR 归属回溯加环形引用保护，数据损坏时不再死循环',
    ],
  },
  {
    ver: 'R2.5',
    date: '2026-08-01',
    items: [
      '快速筛选 Object / KR 改为级联联动：未选中目标时不显示任何 KR 按钮，避免筛选栏被大量 KR 撑爆',
      '选中某个目标后，只展示该目标名下的 KR；选中 KR 时同级 KR 保留，可横向切换',
      '选中 KR 时其父目标显示为紫色上下文态（半亮），随时可见当前所处目标',
      '选中的目标名下没有 KR 时给出「该目标下暂无 KR」提示，而非静默留白',
      '四个视图（任务列表 / 时间线 / 时间线空态 / 团队看板）的实体按钮渲染逻辑收敛为公共函数 renderEntityFilterButtons()，消除 4 份重复代码',
    ],
  },
  {
    ver: 'R2.4',
    date: '2026-08-01',
    items: [
      '修复侧边栏底部「叠加 / 筛选」按钮和 footer 在小窗口下被任务栏遮挡的问题',
      '侧边栏导航区改为独立滚动：内容超高时区域内滚动，Logo 与底部说明始终固定可见',
      '新增窗口高度响应式断点（≤760px）：自动收紧导航项与快速筛选按钮的间距，减少滚动需求',
      '修复时间线视图归档勾选框状态错误：已归档的行显示为空框',
      '统一全项目 isArchived 判据为 isArchivedOf()，兼容飞书同步/CSV 导入产生的字符串型布尔值',
    ],
  },
  {
    ver: 'R2.3',
    date: '2026-08-01',
    items: [
      '侧边栏 5 个快速筛选按钮改为严格互斥单选：今日待办 / 本周到期 / 本月到期 / 时间线 / 已归档 同一时刻只能点亮 1 个',
      '修复「时间线」与日期筛选按钮同时点亮的问题：原判据用 currentView / dateFilter / showArchived 三套独立变量，改为统一由 activeQuickFilter 决定',
      '再次点击已点亮的按钮 = 取消该筛选，回到无筛选列表',
      '切换主导航（仪表盘/日历/看板等）时自动清除快速筛选点亮态',
      '仪表盘「已归档」卡片改为复用 quickFilter，避免状态不同步',
    ],
  },
  {
    ver: 'R2.2',
    date: '2026-07-25',
    items: [
      '文件选择器下拉面板重构：position:fixed 浮层化 + JS 动态定位，解决被弹窗 overflow 裁剪仅显示 1 项的问题',
      '下拉面板 max-height 480px，一次可视约 10 个文件',
      '键盘导航：↓↑ 移动高亮、Enter 选中、Esc 关闭',
      '滚动加载更多：page_size 50，滚到底自动追加，支持全部 559 个文件',
      '自动向上/向下展开、resize/滚动自适应定位',
    ],
  },
  {
    ver: 'R2.1',
    date: '2026-07-25',
    items: [
      'AI 任务透视镜 ↔ 文件标签管理系统双向打通：content-links API + 文件选择器',
      '编辑任务时可通过下拉多选文件管理系统中扫描到的文件',
      '两系统支持命名窗口跳转，避免无限开新标签页',
      '文件 chip 横排换行布局优化 + 悬浮卡右侧弹出',
      '时间线视图补齐：悬浮按钮组、行高亮、归档 checkbox、状态点击切换',
      '任务链按钮颜色按有无依赖区分（橙/灰）',
      '从文件管理器跳回任务透视镜时自动切时间线视图 + 滚动定位 + 临时高亮',
      '每日习惯热力图修复：initHabits() 未调用问题',
    ],
  },
  {
    ver: 'R2.0',
    date: '2026-07-24',
    items: [
      '从 v4.x 重构为 R2.0，统一版本命名',
      '项目迁移至新工作目录，启动脚本改用相对路径',
      '启动脚本路径修复：bat 文件改用相对路径',
      '飞书同步服务优化：增量推送对比面板、进度条轮询、本地独有数据强制推送',
    ],
  },
];

// ── 使用帮助（R3.25）──
const HELP_SECTIONS = [
  {
    icon: '🧭',
    title: '核心概念',
    html: `<ul>
      <li><b>层级结构</b>：目标(Object) → 关键结果(KR) → 子目标(Target) → 任务(Task)，上级影响下级</li>
      <li><b>附属内容</b>：记录(Record)、日程(Schedule)、想法(Idea) 不参与层级树，可挂在任意节点下</li>
      <li><b>优先级四象限</b>：重要紧急 / 重要不紧急 / 紧急不重要 / 不紧急不重要，新建默认「重要不紧急」</li>
      <li><b>状态流转</b>：待办 → 进行中 → 已完成 / 阻塞 / 已取消；完成任务自动记录完成时间</li>
    </ul>`,
  },
  {
    icon: '🗺️',
    title: '视图导览（快捷键 1-6 快速切换）',
    html: `<ul>
      <li><b>1 全局仪表盘</b>：统计总览 + AI 洞察 + 下一步行动建议</li>
      <li><b>2 任务列表</b>：树形层级，支持搜索、排序、列筛选、列隐藏、批量高亮</li>
      <li><b>3 日历 / 时间线表格</b>：按月查看任务与日程；表格视图支持日期+类型+目标/KR+已完成组合筛选</li>
      <li><b>4 优先级矩阵</b>：四象限分布，直观看到该做什么</li>
      <li><b>5 团队看板</b>：按负责人分组，拖动理解成员负载</li>
      <li><b>6 每日习惯</b>：习惯打卡与热力图追踪（独立数据）</li>
    </ul>`,
  },
  {
    icon: '⚡',
    title: '常用操作',
    html: `<ul>
      <li><b>新建内容</b>：顶栏「+ 添加任务」或快捷键 <code>Ctrl+Alt+N</code> / <code>N</code>；行内可「+ 下级内容」「+ 后置内容」</li>
      <li><b>编辑属性</b>：点击行 / 行内「编辑属性」，弹窗中可改类型、优先级、日期、负责人、标签等</li>
      <li><b>任务链</b>：行内「📋 任务链」查看依赖/后置关系，或编辑弹窗中搜索添加依赖任务</li>
      <li><b>周期任务</b>：编辑弹窗「🔁 周期任务」开启，支持每天/每周/每月，可点日历勾选具体日期</li>
      <li><b>快速状态切换</b>：列表/时间线中点击状态标签循环切换；点击优先级循环调整</li>
      <li><b>归档</b>：行首勾选框归档（从日常视野移走），侧边栏「叠加/筛选」控制显示方式</li>
      <li><b>AI 智能录入</b>：顶栏输入框用自然语言描述，自动解析为结构化任务（回车或点 ▶）</li>
      <li><b>右键快捷操作</b>：右键实体筛选按钮（目标/KR）可「设置底色 / 高亮 / 隐藏」；右键任务行可「高亮 / 同步到飞书」</li>
      <li><b>时间线搜索</b>：时间线表格筛选栏搜索框按标题/描述/标签/负责人筛选，命中内容连同祖先目标一起显示；搜索优先于日期/类型/实体筛选（Esc 清空恢复）</li>
    </ul>`,
  },
  {
    icon: '⌨️',
    title: '快捷键',
    html: `<table class="help-keys">
      <tr><td><code>Ctrl+Alt+N</code> 或 <code>N</code></td><td>新建内容块</td></tr>
      <tr><td><code>Ctrl+K</code> 或 <code>/</code></td><td>搜索（切到列表并聚焦搜索框）</td></tr>
      <tr><td><code>1</code>-<code>6</code></td><td>切换视图；<code>3</code> 连按在日历 ↔ 时间线表格间循环</td></tr>
      <tr><td><code>Esc</code></td><td>关闭当前弹窗（编辑弹窗带未保存确认）</td></tr>
      <tr><td><code>?</code></td><td>打开本帮助</td></tr>
    </table>`,
  },
  {
    icon: '💾',
    title: '数据管理',
    html: `<ul>
      <li><b>存储位置</b>：全部数据保存在浏览器 localStorage，清除浏览器数据会丢失！建议定期备份</li>
      <li><b>💾 完整备份（推荐）</b>：顶栏「💾 备份」一键导出完整 JSON 文件（含任务层级/依赖/习惯/金句/高亮/隐藏筛选/实体底色），「♻️ 恢复」可从备份还原全部数据。换电脑/清缓存前务必先备份</li>
      <li><b>导入导出</b>：顶栏「📥 导出数据」生成 CSV/TXT；「📤 导入 CSV」可恢复或批量录入（注意 CSV 不包含习惯/金句/高亮）</li>
      <li><b>飞书同步</b>：需先启动 sync_server（端口 9877），然后可「🔄 飞书→本地」「📤 本地→飞书」「🔄 双向同步」</li>
      <li><b>飞书认证过期处理</b>：提示「认证已过期」时先重试（可能是网络抖动误报）；若仍失败，在命令行执行 <code>lark-cli auth login --domain drive --as user</code> 重新授权（文件标签管理器设置面板有一键授权按钮）</li>
      <li><b>数据健康</b>：顶栏「🩺 层级健康度」检查数据完整性，发现的问题可一键修复、支持撤销</li>
      <li><b>文件联动</b>：任务可关联文件管理系统中的文件，两边互相跳转</li>
    </ul>`,
  },
];

function showHelp() {
  const modal = document.getElementById('modal-help');
  const body = document.getElementById('help-body');
  if (!modal || !body) return;
  body.innerHTML = HELP_SECTIONS.map(function(sec) {
    return '<div class="help-section">' +
      '<div class="help-section-title">' + sec.icon + ' ' + sec.title + '</div>' +
      '<div class="help-section-body">' + sec.html + '</div>' +
    '</div>';
  }).join('');
  modal.style.display = 'flex';
}

function closeHelp() {
  const modal = document.getElementById('modal-help');
  if (modal) modal.style.display = 'none';
}

// 使用帮助入口
(function() {
  var btn = document.getElementById('btn-help');
  if (btn) btn.addEventListener('click', showHelp);
  var close = document.getElementById('btn-help-close');
  if (close) close.addEventListener('click', closeHelp);
  var overlay = document.getElementById('modal-help');
  if (overlay) overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeHelp();
  });
})();

function showChangelog() {
  const modal = document.getElementById('modal-changelog');
  const body = document.getElementById('changelog-body');
  if (!modal || !body) return;
  body.innerHTML = CHANGELOG.map(function(entry) {
    return '<div class="changelog-entry">' +
      '<div class="changelog-ver"><span class="ver-tag">' + entry.ver + '</span><span class="ver-date">' + entry.date + '</span></div>' +
      '<ul class="changelog-items">' + entry.items.map(function(it) { return '<li>' + it + '</li>'; }).join('') + '</ul>' +
    '</div>';
  }).join('');
  modal.style.display = 'flex';
}

// 更新记录入口
(function() {
  var badge = document.getElementById('version-badge');
  if (badge) badge.addEventListener('click', showChangelog);
  var close = document.getElementById('btn-changelog-close');
  if (close) close.addEventListener('click', function() {
    document.getElementById('modal-changelog').style.display = 'none';
  });
  var overlay = document.getElementById('modal-changelog');
  if (overlay) overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.style.display = 'none';
  });
})();
