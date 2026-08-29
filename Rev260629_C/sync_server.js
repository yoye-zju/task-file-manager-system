/**
 * AI 任务透视镜 — 飞书同步服务器 (Node.js)
 * 桥接 HTML 前端与飞书 Base，提供双向同步能力。
 *
 * 启动:
 *   node sync_server.js [--port PORT]
 */

const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

// ── Push Log (本地推送记录，用于增量跳过) ──
const PUSH_LOG_FILE = path.join(__dirname, 'push_log.json');
// 格式: { "20260629143005": { "time": "2026-06-29T14:30:05", "title": "xxx" }, ... }

function loadPushLog() {
  try {
    if (fs.existsSync(PUSH_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(PUSH_LOG_FILE, 'utf8'));
    }
    // 文件不存在时创建空的
    savePushLog({});
    return {};
  } catch (e) { console.error('[log] Failed to load push log:', e.message); }
  return {};
}

function savePushLog(log) {
  try {
    fs.writeFileSync(PUSH_LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
  } catch (e) { console.error('[log] Failed to save push log:', e.message); }
}

function getPushLogStats() {
  var log = loadPushLog();
  var keys = Object.keys(log);
  return { total: keys.length, lastPush: keys.length > 0 ? log[keys[keys.length - 1]].time : null };
}

// ── Crash Protection ──
process.on('uncaughtException', (err) => {
  console.error('[crash] Uncaught exception:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('[crash] Port already in use — another instance may be running.');
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('[crash] Unhandled rejection:', reason);
});

// ── Configuration ──
// 凭证读本地 feishu.credentials.js（已被 .gitignore 排除，不入库）；缺失时回落环境变量/占位符
let _feishuCreds = {};
try { _feishuCreds = require('./feishu.credentials.js'); } catch (e) { /* 发布版无凭证文件 */ }
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN || _feishuCreds.BASE_TOKEN || '<your_feishu_base_token>';
const OKR_TABLE_ID = process.env.FEISHU_OKR_TABLE_ID || _feishuCreds.OKR_TABLE_ID || '<your_okr_table_id>';
const INBOX_TABLE_ID = process.env.FEISHU_INBOX_TABLE_ID || _feishuCreds.INBOX_TABLE_ID || '<your_inbox_table_id>';

// Lark CLI paths
const home = os.homedir();
const nodeBin = path.join(home, '.workbuddy', 'binaries', 'node');
const LARK_NODE = path.join(nodeBin, 'versions', '22.22.2', 'node.exe');
const LARK_SCRIPT = path.join(nodeBin, 'cli-connector-packages', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

// ── Progress Store ──
const progressStore = new Map(); // requestId -> progress object
const PROGRESS_TTL = 5 * 60 * 1000; // 5 minutes TTL

function createProgress(requestId) {
  const progress = {
    requestId,
    status: 'starting', // starting | pulling | pushing | done | error
    message: '正在初始化...',
    current: 0,
    total: 0,
    logs: [],
    startTime: Date.now(),
    endTime: null,
    error: null,
  };
  progressStore.set(requestId, progress);
  // Auto-cleanup after TTL
  setTimeout(() => progressStore.delete(requestId), PROGRESS_TTL);
  return progress;
}

function updateProgress(requestId, update) {
  const progress = progressStore.get(requestId);
  if (progress) {
    Object.assign(progress, update);
    if (update.status === 'done' || update.status === 'error') {
      progress.endTime = Date.now();
    }
  }
}

function addLog(requestId, level, message) {
  const progress = progressStore.get(requestId);
  if (progress) {
    progress.logs.push({ time: Date.now(), level, message });
    console.log(`[${requestId}] ${level}: ${message}`);
  }
}

// ── Helpers ──
async function runLark(...args) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      console.log(`[lark] 执行命令 (尝试 ${i + 1}/${MAX_RETRIES}):`, args.slice(0, 5).join(' ') + (args.length > 5 ? '...' : ''));
      const { stdout } = await execFileAsync(LARK_NODE, [LARK_SCRIPT, ...args], {
        encoding: 'utf-8',
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
      });
      try {
        return JSON.parse(stdout);
      } catch (parseErr) {
        console.warn('[lark] JSON 解析失败，返回原始输出:', stdout.substring(0, 500));
        return { data: stdout, raw: true };
      }
    } catch (e) {
      console.error(`[lark] 执行失败 (尝试 ${i + 1}/${MAX_RETRIES}):`, e.message);
      if (i < MAX_RETRIES - 1) {
        const delay = BASE_DELAY * Math.pow(2, i);
        console.log(`[lark] 等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw new Error(`飞书命令执行失败（已重试 ${MAX_RETRIES} 次）: ${e.message}`);
      }
    }
  }
}

// 批量更新记录（真正的逐行不同值批量更新）
async function batchUpdateRecords(baseToken, tableId, records, batchSize = 100) {
  const results = [];
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const payload = JSON.stringify({ records: batch });
    try {
      const result = await runLark('api', 'POST', 
        `/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/batch_update`,
        '--as', 'user',
        '--data', payload,
        '--format', 'json'
      );
      results.push({ success: true, data: result });
      console.log(`  Batch update: ${batch.length} records OK`);
    } catch (e) {
      console.error(`  Batch update failed at offset ${i}:`, e.message);
      results.push({ success: false, error: e.message, offset: i });
    }
  }
  return results;
}

async function fetchAllRecords(baseToken, tableId, pageSize = 200) {
  const all = [];
  let offset = 0;
  while (true) {
    const data = await runLark(
      'base', '+record-list',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--format', 'json',
      '--limit', String(pageSize),
      '--offset', String(offset),
      '--as', 'user'
    );
    const d = data.data || data;
    const rows = d.data || [];
    const fieldNames = d.fields || [];
    const recordIds = d.record_id_list || [];
    const hasMore = d.has_more || false;

    for (let i = 0; i < rows.length; i++) {
      const record = {};
      for (let j = 0; j < fieldNames.length; j++) {
        record[fieldNames[j]] = j < rows[i].length ? rows[i][j] : null;
      }
      all.push({ record, rid: recordIds[i] || '' });
    }
    offset += rows.length;
    if (!hasMore || rows.length === 0) break;
  }
  return all;
}

function extractSelect(val) {
  if (Array.isArray(val) && val.length > 0) return val[0];
  return null;
}

function extractDate(val) {
  if (val && typeof val === 'string') return val.substring(0, 10);
  return '';
}

function escapeCsv(text) {
  if (!text) return '';
  return String(text).replace(/\n/g, '\\n').replace(/\r/g, '');
}

const STATUS_MAP = {
  '待处理': 'todo', '准备中': 'preparing', '进行中': 'progress', '已处理': 'done',
  '已完成': 'done', '已取消': 'blocked', '待观察': 'todo',
};
const PRIORITY_MAP = { '重要+紧急': '重要紧急', '重要+不紧急': '重要不紧急', '不重要+紧急': '紧急不重要', '不重要+不紧急': '不紧急不重要' };
const IS_MILESTONE_MAP = {
  '重要+紧急': true, '重要+不紧急': false,
  '不重要+紧急': false, '不重要+不紧急': false,
};
const STATUS_REV = { todo: '待处理', preparing: '准备中', progress: '进行中', done: '已处理', blocked: '已取消' };
const PRIORITY_REV = { '重要紧急': '重要+紧急', '重要不紧急': '重要+不紧急', '紧急不重要': '不重要+紧急', '不紧急不重要': '不重要+不紧急' };
const DEFAULT_PRIORITY = '重要不紧急';   // R3.22 起与前端保持一致（新建默认「重要不紧急」）

function makeEntity(entId, entType, parentId, title, priority, status,
                    deadline, startDate, progress, assignee,
                    isMilestone, deps, nextVal, files, tag, desc, branches, feishuRecordId, timestamp) {
  let normParent = null;
  if (parentId !== null && parentId !== undefined && parentId !== '' && parentId !== 0 && parentId !== '0') {
    normParent = parseInt(parentId, 10);
    if (isNaN(normParent)) normParent = null;
  }
  return {
    id: entId,
    type: entType,
    parentId: normParent,
    title: title || '',
    priority: priority || DEFAULT_PRIORITY,
    status: status || 'todo',
    deadline: deadline || '',
    startDate: startDate || '',
    progress: progress || 0,
    assignee: assignee || '',
    isMilestone: !!isMilestone,
    deps: deps || '',
    next: nextVal || '',
    files: files || '',
    tag: escapeCsv(tag),
    desc: escapeCsv(desc),
    branches: branches || '',
    feishuRecordId: feishuRecordId || '',
    timestamp: timestamp || '',
  };
}

// ── Pull: Feishu → Local ──
async function pullFromFeishu(requestId) {
  addLog(requestId, 'info', '开始从飞书拉取数据...');
  updateProgress(requestId, { status: 'pulling', message: '正在连接飞书...', current: 0, total: 2 });
  
  console.log('[pull] Fetching OKR table...');
  addLog(requestId, 'info', '正在读取 OKR 表...');
  const okrRecords = await fetchAllRecords(BASE_TOKEN, OKR_TABLE_ID);
  updateProgress(requestId, { current: 1 });
  
  console.log('[pull] Fetching 日程待办 table...');
  addLog(requestId, 'info', '正在读取 日程待办 表...');
  const inboxRecords = await fetchAllRecords(BASE_TOKEN, INBOX_TABLE_ID);
  updateProgress(requestId, { current: 2, message: '数据读取完成，正在处理...' });
  
  addLog(requestId, 'info', `读取完成：OKR ${okrRecords.length} 条，Task ${inboxRecords.length} 条`);
  console.log(`[pull] OKR records: ${okrRecords.length}, Inbox records: ${inboxRecords.length}`);

  const entities = [];
  let csvIdCounter = 1;

  // ── Phase 1: Process OKR table ──
  const targetGroups = {};
  const feishuToKrCsvId = {};

  for (const { record: fields, rid } of okrRecords) {
    const krTitle = (fields['关键结果（KR）'] || '').trim();
    let objTitle = (fields['关键目标'] || '').trim();
    if (!objTitle) objTitle = '未分类';
    const dateVal = extractDate(fields['日期']);
    const workDir = extractSelect(fields['工作方向']) || '';

    if (!targetGroups[objTitle]) targetGroups[objTitle] = [];
    targetGroups[objTitle].push({ feishuId: rid, title: krTitle, krText: krTitle, date: dateVal, workDir, timestamp: fields['时间戳(14位)'] || '' });
  }

  const targetToObjId = {};

  for (const [targetName, items] of Object.entries(targetGroups)) {
    const objId = csvIdCounter++;
    targetToObjId[targetName] = objId;

    const workDirs = [...new Set(items.map(i => i.workDir).filter(Boolean))].sort();
    const objTag = workDirs.length ? workDirs.join(';') : '';

    entities.push(makeEntity(objId, 'object', '', targetName, DEFAULT_PRIORITY, 'progress',
      '', '', 0, '', false, '', '', '', objTag,
      `${items.length} 个关键结果`, '', '', '', ''));

    for (const item of items) {
      const krId = csvIdCounter++;
      const tsVal = item.timestamp || '';
      feishuToKrCsvId[item.feishuId] = krId;
      const krTitle = item.title || `KR-${item.feishuId.substring(0, 8)}`;
      entities.push(makeEntity(krId, 'kr', String(objId), krTitle, DEFAULT_PRIORITY, 'todo',
        item.date, '', 0, '', false, '', '', '', escapeCsv(item.workDir),
        item.krText || '', '', item.feishuId, tsVal));
    }
  }

  console.log(`  Objects: ${Object.keys(targetToObjId).length}, KRs: ${Object.keys(feishuToKrCsvId).length}`);

  // ── Phase 2: Process 日程待办 table ──
  let linkedCount = 0, unlinkedCount = 0;

  for (const { record: fields, rid } of inboxRecords) {
    const taskId = csvIdCounter++;
    const title = (fields['事项内容'] || '').trim();
    const deadline = extractDate(fields['截止时间']);
    const startDate = extractDate(fields['创建时间']);
    const statusRaw = extractSelect(fields['状态']) || '';
    const priorityRaw = extractSelect(fields['级别'] || fields['优先级']) || '';   // R3.5: 改用「级别」列，兼容旧「优先级」缓存
    const typeRaw = extractSelect(fields['类型']) || '';
    const tagRaw = extractSelect(fields['处理方式']) || '';
    const descRaw = (fields['备注'] || '').trim();
    const progressRaw = fields['完成情况'];
    const timestamp = fields['时间戳(14位)'] || '';

    const status = STATUS_MAP[statusRaw] || 'todo';
    const priority = PRIORITY_MAP[priorityRaw] || DEFAULT_PRIORITY;
    const isMilestone = IS_MILESTONE_MAP[typeRaw] || false;
    let progress = 0;
    if (progressRaw) { const p = parseInt(progressRaw, 10); if (!isNaN(p)) progress = p; }

    let parentId = '';
    const okrLink = fields['所属OKR'];
    if (okrLink && Array.isArray(okrLink) && okrLink.length > 0) {
      let linkedId = okrLink[0];
      if (typeof linkedId === 'object' && linkedId) linkedId = linkedId.id || '';
      if (linkedId && feishuToKrCsvId[linkedId]) {
        parentId = String(feishuToKrCsvId[linkedId]);
        linkedCount++;
      }
    }
    if (!parentId) unlinkedCount++;

    entities.push(makeEntity(taskId, 'task', parentId, title.substring(0, 200) || `Task-${rid.substring(0, 8)}`,
      priority, status, deadline, startDate, progress, '',
      isMilestone, '', '', '', escapeCsv(tagRaw), escapeCsv(descRaw), '', rid, timestamp));
  }

  console.log(`  Tasks: ${linkedCount} linked, ${unlinkedCount} unlinked`);
  console.log(`[pull] Total entities: ${entities.length}`);
  addLog(requestId, 'info', `处理完成：共 ${entities.length} 条数据（${Object.keys(targetToObjId).length} 个目标，${Object.keys(feishuToKrCsvId).length} 个 KR，${linkedCount + unlinkedCount} 个任务）`);
  updateProgress(requestId, { status: 'done', message: '拉取完成', current: 2, total: 2 });

  return {
    success: true,
    total: entities.length,
    objects: Object.keys(targetToObjId).length,
    krs: Object.keys(feishuToKrCsvId).length,
    tasksLinked: linkedCount,
    tasksUnlinked: unlinkedCount,
    entities,
  };
}

// ── Push: Local → Feishu ──
async function pushToFeishu(entities, requestId) {
  const results = { created: 0, updated: 0, errors: [], feishuIds: {} };
  
  addLog(requestId, 'info', '开始推送数据到飞书...');
  const objects = entities.filter(e => e.type === 'object');
  const krs = entities.filter(e => e.type === 'kr');
  const tasks = entities.filter(e => e.type === 'task');
  
  const totalWork = krs.length + tasks.length;
  let completed = 0;
  
  updateProgress(requestId, { status: 'pushing', message: '正在推送...', current: 0, total: totalWork });
  addLog(requestId, 'info', `待推送：${krs.length} 个 KR，${tasks.length} 个任务`);
  
  console.log(`[push] Objects:${objects.length} KRs:${krs.length} Tasks:${tasks.length}`);

  const objLookup = {};
  objects.forEach(o => { objLookup[String(o.id)] = o.title || '未分类'; });

  // ── Phase 1: Push KRs ──
  const krIdMap = {};
  const newKrs = krs.filter(k => !k.feishuRecordId);
  const existingKrs = krs.filter(k => k.feishuRecordId);

    if (newKrs.length > 0) {
      console.log(`[push] Creating ${newKrs.length} new KRs...`);
      const BATCH = 200;
      for (let i = 0; i < newKrs.length; i += BATCH) {
        const batch = newKrs.slice(i, i + BATCH);
        const fieldsList = ['关键目标', '关键结果（KR）', '日期', '工作方向', '时间戳(14位)'];
        const rows = batch.map(kr => [
          objLookup[String(kr.parentId || '')] || '未分类',
          kr.title || `KR-${kr.id}`,
          kr.deadline || null,
          kr.tag || null,
          kr.timestamp || '',
        ]);
        const batchJson = JSON.stringify({ fields: fieldsList, rows });
        try {
          const result = await runLark('base', '+record-batch-create',
            '--base-token', BASE_TOKEN, '--table-id', OKR_TABLE_ID,
            '--json', batchJson, '--format', 'json', '--as', 'user');
          const d = result.data || result;
          const returnedIds = d.record_id_list || [];
          for (let j = 0; j < batch.length; j++) {
            const fid = j < returnedIds.length ? returnedIds[j] : '';
            krIdMap[String(batch[j].id)] = fid;
            results.feishuIds[String(batch[j].id)] = fid;
          }
          results.created += batch.length;
          completed += batch.length;
          updateProgress(requestId, { current: completed, message: `已创建 ${completed}/${totalWork}...` });
          addLog(requestId, 'info', `批次创建 ${batch.length} 个 KR 成功`);
          console.log(`  Created ${batch.length} KRs`);
          
          if (i + BATCH < newKrs.length) {
            console.log(`  等待 500ms 后继续下一批...`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (e) {
          results.errors.push(`KR batch ${i}: ${e.message}`);
          addLog(requestId, 'error', `批次创建 KR 失败：${e.message}`);
        }
      }
    }

    // 逐条更新 existing KRs（带重试机制）
    for (let idx = 0; idx < existingKrs.length; idx++) {
      const kr = existingKrs[idx];
      let retries = 3;
      let success = false;
      while (retries > 0 && !success) {
        try {
          const parentTitle = objLookup[String(kr.parentId || '')] || '未分类';
          let fields = {
            '关键目标': parentTitle,
            '关键结果（KR）': kr.title || `KR-${kr.id}`,
            '日期': kr.deadline || null,
            '工作方向': kr.tag || null,
            '时间戳(14位)': kr.timestamp || '',
          };
          fields = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== null));
          await runLark('base', '+record-upsert',
            '--base-token', BASE_TOKEN, '--table-id', OKR_TABLE_ID,
            '--json', JSON.stringify(fields), '--record-id', kr.feishuRecordId,
            '--format', 'json', '--as', 'user');
          krIdMap[String(kr.id)] = kr.feishuRecordId;
          results.feishuIds[String(kr.id)] = kr.feishuRecordId;
          results.updated++;
          completed++;
          updateProgress(requestId, { current: completed, message: `已更新 ${completed}/${totalWork}...` });
          addLog(requestId, "info", `KR "${kr.title || kr.id}" 更新成功`);
          success = true;
        } catch (e) {
          retries--;
          if (retries === 0) {
            results.errors.push(`KR ${kr.id}: ${e.message}`);
            addLog(requestId, "error", `KR "${kr.title || kr.id}" 更新失败：${e.message}`);
          } else {
            console.log(`  KR ${kr.id} 重试... 剩余 ${retries} 次`);
            addLog(requestId, "warn", `KR "${kr.title || kr.id}" 重试... 剩余 ${retries} 次`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }

    // ── Phase 2: Push Tasks ──
    const newTasks = tasks.filter(t => !t.feishuRecordId);
    const existingTasks = tasks.filter(t => t.feishuRecordId);

    function buildTaskFields(t) {
      let okrLink = null;
      const pid = String(t.parentId || '');
      if (pid && krIdMap[pid]) okrLink = [{ id: krIdMap[pid] }];
      const isMilestone = String(t.isMilestone) === 'true';
      const PRIORITY_REV_LOCAL = PRIORITY_REV;
      const STATUS_REV_LOCAL = { todo: '待处理', preparing: '准备中', progress: '进行中', done: '已处理', blocked: '已取消' };
      return {
        '事项内容': (t.title || `Task-${t.id}`).substring(0, 200),
        '级别': PRIORITY_REV_LOCAL[t.priority] || '不重要+紧急',
        '截止时间': t.deadline || null,
        '备注': t.desc || null,
        '状态': STATUS_REV_LOCAL[t.status] || '待处理',
        '类型': isMilestone ? '重要+紧急' : null,
        '处理方式': t.tag || null,
        '所属OKR': okrLink,
        '时间戳(14位)': t.timestamp || null,
      };
    }

    if (newTasks.length > 0) {
      console.log(`[push] Creating ${newTasks.length} new Tasks...`);
      const BATCH = 200;
      for (let i = 0; i < newTasks.length; i += BATCH) {
        const batch = newTasks.slice(i, i + BATCH);
        const fieldsList = ['事项内容', '级别', '截止时间', '备注', '状态', '类型', '处理方式', '所属OKR', '时间戳(14位)'];
        const rows = batch.map(t => {
          const f = buildTaskFields(t);
          return [f['事项内容'], f['级别'], f['截止时间'], f['备注'], f['状态'], f['类型'], f['处理方式'], f['所属OKR'], f['时间戳(14位)']];
        });
        try {
          const result = await runLark('base', '+record-batch-create',
            '--base-token', BASE_TOKEN, '--table-id', INBOX_TABLE_ID,
            '--json', JSON.stringify({ fields: fieldsList, rows }),
            '--format', 'json', '--as', 'user');
          const d = result.data || result;
          const returnedIds = d.record_id_list || [];
          for (let j = 0; j < batch.length; j++) {
            results.feishuIds[String(batch[j].id)] = returnedIds[j] || '';
          }
          results.created += batch.length;
          completed += batch.length;
          updateProgress(requestId, { current: completed, message: `已创建 ${completed}/${totalWork}...` });
          addLog(requestId, "info", `批次创建 ${batch.length} 个 Task 成功`);
          console.log(`  Created ${batch.length} Tasks`);
          
          if (i + BATCH < newTasks.length) {
            console.log(`  等待 500ms 后继续下一批...`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (e) {
          results.errors.push(`Task batch ${i}: ${e.message}`);
          addLog(requestId, "error", `批次创建 Task 失败：${e.message}`);
        }
      }
    }

    // 逐条更新 existing Tasks（带重试机制）
    for (let idx = 0; idx < existingTasks.length; idx++) {
      const t = existingTasks[idx];
      let retries = 3;
      let success = false;
      while (retries > 0 && !success) {
        try {
          let f = buildTaskFields(t);
          f = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null));
          await runLark('base', '+record-upsert',
            '--base-token', BASE_TOKEN, '--table-id', INBOX_TABLE_ID,
            '--json', JSON.stringify(f), '--record-id', t.feishuRecordId,
            '--format', 'json', '--as', 'user');
          results.feishuIds[String(t.id)] = t.feishuRecordId;
          results.updated++;
          completed++;
          updateProgress(requestId, { current: completed, message: `已更新 ${completed}/${totalWork}...` });
          addLog(requestId, "info", `Task "${t.title || t.id}" 更新成功`);
          success = true;
        } catch (e) {
          retries--;
          if (retries === 0) {
            results.errors.push(`Task ${t.id}: ${e.message}`);
            addLog(requestId, "error", `Task "${t.title || t.id}" 更新失败：${e.message}`);
          } else {
            console.log(`  Task ${t.id} 重试... 剩余 ${retries} 次`);
            addLog(requestId, "warn", `Task "${t.title || t.id}" 重试... 剩余 ${retries} 次`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }

  addLog(requestId, "info", `推送完成：创建 ${results.created} 条，更新 ${results.updated} 条` + (results.errors.length > 0 ? `，${results.errors.length} 个错误` : ``));
  updateProgress(requestId, { status: 'done', message: '推送完成', current: totalWork, total: totalWork });

  return {
    success: results.errors.length === 0,
    created: results.created,
    updated: results.updated,
    errors: results.errors,
    feishuIds: results.feishuIds,
  };
}

// ── HTTP Server ──
const port = parseInt(process.argv[process.argv.indexOf('--port') + 1], 10) || 9877;

const server = http.createServer((req, res) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}

      try {
        if (req.url === '/pull') {
          const requestId = crypto.randomBytes(8).toString('hex');
          createProgress(requestId);
          addLog(requestId, 'info', '收到拉取请求');
          updateProgress(requestId, { status: 'pulling', message: '开始从飞书拉取数据...', current: 0, total: 0 });

          // 立即返回 requestId，后台异步执行拉取
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ requestId, async: true, message: '拉取已开始' }));

          // 后台异步执行
          setImmediate(async () => {
            try {
              const result = await pullFromFeishu(requestId);
              const progress = progressStore.get(requestId);
              if (progress) progress.result = result;
              addLog(requestId, 'info', '拉取完成，共 ' + (result.entities ? result.entities.length : 0) + ' 条实体');
              updateProgress(requestId, { status: 'done', message: '拉取完成', current: 1, total: 1 });
            } catch (e) {
              console.error('[pull] ERROR:', e.message);
              addLog(requestId, 'error', '拉取失败: ' + e.message);
              updateProgress(requestId, { status: 'error', message: '拉取失败: ' + e.message });
            }
          });
          return;
        } else if (req.url === '/push') {
          const entities = parsed.entities || [];
          const forcePush = parsed.force === true;  // 强制全量推送标志
          if (!entities.length) {
            res.writeHead(400, corsHeaders);
            res.end(JSON.stringify({ error: 'no entities provided' }));
            return;
          }

          // 加载推送日志，跳过已推送过的记录（force时跳过此逻辑）
          var pushLog = loadPushLog();
          var changed = [];
          var skippedCount = 0;
          var skippedList = [];
          if (!forcePush) {
            for (var i = 0; i < entities.length; i++) {
              var e = entities[i];
              if (e.timestamp && pushLog[e.timestamp]) {
                skippedCount++;
                skippedList.push(e.title || e.id);
              } else {
                changed.push(e);
              }
            }
          } else {
            changed = entities;
          }

          const requestId = crypto.randomBytes(8).toString('hex');
          createProgress(requestId);

          if (forcePush) {
            addLog(requestId, 'info', '⚡ 强制全量推送模式，忽略 push_log.json');
          }
          
          if (skippedCount > 0) {
            addLog(requestId, 'info', '根据 push_log.json 跳过 ' + skippedCount + ' 条已推送记录');
            console.log('[push] Skipped', skippedCount, 'unchanged records:', skippedList.slice(0, 5), skippedList.length > 5 ? '...' : '');
          }
          
          if (changed.length === 0) {
            addLog(requestId, 'info', '所有 ' + entities.length + ' 条记录均已推送过，无需重复推送');
            // 直接返回完成
            res.writeHead(200, corsHeaders);
            res.end(JSON.stringify({ requestId, async: true, message: '无需推送', skipped: entities.length }));
            updateProgress(requestId, { status: 'done', message: '所有记录均已推送，无需重复推送', current: 0, total: 0, result: { created: 0, updated: 0, skipped: entities.length, errors: [], feishuIds: {} } });
            return;
          }

          addLog(requestId, 'info', '收到推送请求，共 ' + entities.length + ' 条（跳过 ' + skippedCount + ' 条，实际推送 ' + changed.length + ' 条）');
          updateProgress(requestId, { status: 'pushing', message: '开始推送到飞书...', current: 0, total: changed.length });

          // 立即返回 requestId，后台异步执行推送
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ requestId, async: true, message: '推送已开始', total: entities.length, changed: changed.length, skipped: skippedCount }));

          // 后台异步执行
          setImmediate(async () => {
            try {
              const result = await pushToFeishu(changed, requestId);
              const progress = progressStore.get(requestId);
              if (progress) progress.result = result;
              
              // 更新推送日志：记录成功推送的记录
              var now = new Date().toISOString();
              for (var j = 0; j < changed.length; j++) {
                var ce = changed[j];
                if (ce.timestamp && !pushLog[ce.timestamp]) {
                  pushLog[ce.timestamp] = { time: now, title: ce.title || '' };
                }
              }
              savePushLog(pushLog);
              
              addLog(requestId, 'info', '推送完成：创建 ' + result.created + ' 条，更新 ' + result.updated + ' 条' + (result.errors.length > 0 ? '，' + result.errors.length + ' 个错误' : ''));
              addLog(requestId, 'info', '推送日志已更新：push_log.json (' + Object.keys(pushLog).length + ' 条记录)');
              updateProgress(requestId, { status: 'done', message: '推送完成', current: result.created + result.updated, total: result.created + result.updated });
            } catch (e) {
              console.error('[push] ERROR:', e.message);
              addLog(requestId, 'error', '推送失败: ' + e.message);
              updateProgress(requestId, { status: 'error', message: '推送失败: ' + e.message });
            }
          });
          return;
        } else if (req.url === '/diff') {
          const localEntities = parsed.entities || [];
          if (!localEntities.length) {
            res.writeHead(400, corsHeaders);
            res.end(JSON.stringify({ error: 'no local entities provided' }));
            return;
          }

          setImmediate(async () => {
            try {
              console.log('[diff] CODE_VERSION=3 - Hardcoded maps');

              const STATUS_MAP_LOCAL = { '待处理': 'todo', '准备中': 'preparing', '进行中': 'progress', '已处理': 'done', '已完成': 'done', '已取消': 'blocked', '待观察': 'todo' };
              const PRIORITY_MAP_LOCAL = PRIORITY_MAP;   // R3.5: 飞书「级别」→ 本地四象限中文
              const STATUS_REV_LOCAL = { todo: '待处理', preparing: '准备中', progress: '进行中', done: '已处理', blocked: '已取消' };
              const PRIORITY_REV_LOCAL = PRIORITY_REV;

              let okrRecords = [];
              let inboxRecords = [];

              try {
                console.log('[diff] Fetching from Feishu API...');
                okrRecords = await fetchAllRecords(BASE_TOKEN, OKR_TABLE_ID);
                inboxRecords = await fetchAllRecords(BASE_TOKEN, INBOX_TABLE_ID);
                console.log('[diff] Fetched from API:', okrRecords.length + inboxRecords.length, 'records');
              } catch (e) {
                console.warn('[diff] Failed to fetch from Feishu API:', e.message);
                console.log('[diff] Using cached feishu_data.json instead');
                const cached = JSON.parse(fs.readFileSync(path.join(__dirname, 'feishu_data.json'), 'utf-8'));
                okrRecords = (cached.okr || []).map(r => ({ record: r.record, rid: r.rid }));
                inboxRecords = (cached.inbox || []).map(r => ({ record: r.record, rid: r.rid }));
                console.log('[diff] Loaded from cache:', okrRecords.length + inboxRecords.length, 'records');
              }

              const feishuByTs = {};
              const feishuByRid = {};

              okrRecords.forEach(({ record, rid }) => {
                const ts = record['时间戳(14位)'] || record['时间戳（14位）'];
                if (ts && typeof ts === 'string' && ts.length === 14) {
                  feishuByTs[ts] = {
                    type: 'kr',
                    rid,
                    title: record['关键结果（KR）'] || record['关键目标'],
                    status: extractSelect(record['状态']),
                    priority: extractSelect(record['级别'] || record['优先级']),
                    deadline: extractDate(record['日期']),
                    tag: extractSelect(record['工作方向']),
                    ts,
                  };
                }
                feishuByRid[rid] = { type: 'kr', record, rid };
              });

              inboxRecords.forEach(({ record, rid }) => {
                const ts = record['时间戳(14位)'] || record['时间戳（14位）'];
                if (ts && typeof ts === 'string' && ts.length === 14) {
                  feishuByTs[ts] = {
                    type: 'task',
                    rid,
                    title: record['事项内容'],
                    status: extractSelect(record['状态']),
                    priority: extractSelect(record['级别'] || record['优先级']),
                    deadline: extractDate(record['截止时间']),
                    tag: extractSelect(record['处理方式']),
                    ts,
                  };
                }
                feishuByRid[rid] = { type: 'task', record, rid };
              });

              const localOnly = [];
              const feishuOnly = [];
              const changed = [];
              const unchanged = [];

              const localTsSet = new Set();
              localEntities.forEach(t => {
                if (t.timestamp) localTsSet.add(t.timestamp);
              });

              const feishuTsSet = new Set(Object.keys(feishuByTs));

              localEntities.forEach(local => {
                if (!local.timestamp) {
                  localOnly.push({
                    type: 'local-only',
                    local,
                    reason: '无时间戳',
                  });
                  return;
                }

                if (!feishuTsSet.has(local.timestamp)) {
                  localOnly.push({
                    type: 'local-only',
                    local,
                    reason: '飞书无此时间戳',
                  });
                } else {
                  const remote = feishuByTs[local.timestamp];
                  const diffs = [];

                  const localStatus = STATUS_MAP_LOCAL[remote.status] || remote.status;
                  if (local.status !== localStatus) {
                    diffs.push({ field: 'status', local: STATUS_REV_LOCAL[local.status] || local.status, remote: remote.status });
                  }

                  const localPriority = PRIORITY_MAP_LOCAL[remote.priority] || remote.priority;
                  if (local.priority !== localPriority) {
                    diffs.push({ field: 'priority', local: PRIORITY_REV_LOCAL[local.priority] || local.priority, remote: remote.priority });
                  }

                  if (local.title !== remote.title) {
                    diffs.push({ field: 'title', local: local.title, remote: remote.title });
                  }

                  const localDeadline = extractDate(local.deadline);
                  if (localDeadline !== remote.deadline) {
                    diffs.push({ field: 'deadline', local: local.deadline, remote: remote.deadline });
                  }

                  if (diffs.length > 0) {
                    changed.push({
                      type: 'changed',
                      local,
                      remote,
                      diffs,
                    });
                  } else {
                    unchanged.push({
                      type: 'unchanged',
                      local,
                      remote,
                    });
                  }
                }
              });

              feishuTsSet.forEach(ts => {
                if (!localTsSet.has(ts)) {
                  feishuOnly.push({
                    type: 'feishu-only',
                    remote: feishuByTs[ts],
                    reason: '本地无此时间戳',
                  });
                }
              });

              const result = {
                success: true,
                localTotal: localEntities.length,
                feishuTotal: okrRecords.length + inboxRecords.length,
                localOnly: localOnly.length,
                feishuOnly: feishuOnly.length,
                changed: changed.length,
                unchanged: unchanged.length,
                details: {
                  localOnly,
                  feishuOnly,
                  changed,
                  unchanged,
                },
              };

              console.log('[diff] Result:', result);
              res.writeHead(200, corsHeaders);
              res.end(JSON.stringify(result));
            } catch (e) {
              console.error('[diff] ERROR:', e.message);
              res.writeHead(500, corsHeaders);
              res.end(JSON.stringify({ success: false, error: e.message }));
            }
          });
          return;
        } else {
          res.writeHead(404, corsHeaders);
          res.end(JSON.stringify({ error: 'not found' }));
        }
      } catch (e) {
        console.error('[server] ERROR:', e.message);
        res.writeHead(500, corsHeaders);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // GET 端点：进度查询
  if (req.method === 'GET' && req.url.startsWith('/progress')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const requestId = params.get('requestId');
      if (!requestId || !progressStore.has(requestId)) {
        res.writeHead(404, corsHeaders);
        res.end(JSON.stringify({ error: 'progress not found' }));
        return;
      }
      const progress = progressStore.get(requestId);
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify(progress));
    } catch (e) {
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET 端点：查看推送日志
  if (req.method === 'GET' && req.url.startsWith('/push-log')) {
    try {
      var params = new URL(req.url, 'http://localhost').searchParams;
      if (params.get('clear') === '1') {
        savePushLog({});
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ ok: true, message: 'Push log cleared' }));
        console.log('[log] Push log cleared');
        return;
      }
      var log = loadPushLog();
      var summary = { total: Object.keys(log).length, records: log };
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify(summary));
    } catch (e) {
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, corsHeaders);
  res.end(JSON.stringify({ error: 'not found' }));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[sync] Port ${port} already in use. Exiting.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => {
  console.log(`[sync] Server running at http://127.0.0.1:${port}`);
  console.log(`[sync] CODE_VERSION=3 - All maps hardcoded locally`);
  console.log(`       POST /pull      -- Feishu -> Local`);
  console.log(`       POST /push      -- Local -> Feishu`);
  console.log(`       GET  /ping      -- Health check`);
  console.log(`       GET  /progress  -- Sync progress`);
  console.log(`       GET  /push-log  -- View push log`);
  console.log(`       Push log: push_log.json (${getPushLogStats().total} records)`);
  console.log(`       Press Ctrl+C to stop.`);
});
