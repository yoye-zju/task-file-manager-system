/**
 * 安全推送方案：本地 → 飞书
 * 
 * 步骤：
 * 1. 先备份本地数据（导出 localStorage）
 * 2. 拉取飞书数据，建立时间戳映射
 * 3. 筛选出本地独有的数据（未推送过）
 * 4. 执行推送
 * 
 * 使用方法：
 * 1. 在浏览器打开 index.html
 * 2. 打开开发者工具（F12）
 * 3. 在 Console 中执行：copy(JSON.stringify(JSON.parse(localStorage.getItem('ai-task-lens-tasks'))))
 * 4. 粘贴到 local_tasks.json 文件中
 * 5. 运行此脚本：node safe_push.cjs
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');
const os = require('os');
const fs = require('fs');

// Lark CLI paths
const nodeBin = path.join(os.homedir(), '.workbuddy', 'binaries', 'node');
const LARK_NODE = path.join(nodeBin, 'versions', '22.22.2', 'node.exe');
const LARK_SCRIPT = path.join(nodeBin, 'cli-connector-packages', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');

// Configuration
// 凭证读本地 feishu.credentials.js（不入库）；缺失时回落环境变量/占位符
let _feishuCreds = {};
try { _feishuCreds = require('./feishu.credentials.js'); } catch (e) { /* 发布版无凭证文件 */ }
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN || _feishuCreds.BASE_TOKEN || '<your_feishu_base_token>';
const OKR_TABLE_ID = process.env.FEISHU_OKR_TABLE_ID || _feishuCreds.OKR_TABLE_ID || '<your_okr_table_id>';
const INBOX_TABLE_ID = process.env.FEISHU_INBOX_TABLE_ID || _feishuCreds.INBOX_TABLE_ID || '<your_inbox_table_id>';

const LOCAL_TASKS_FILE = path.join(__dirname, 'local_tasks.json');
const PUSH_LOG_FILE = path.join(__dirname, 'push_log.json');
const BACKUP_FILE = path.join(__dirname, 'local_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');

async function runLark(...args) {
  try {
    const { stdout } = await execFileAsync(LARK_NODE, [LARK_SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (e) {
    console.error('Error:', e.message);
    throw e;
  }
}

async function fetchAllRecords(baseToken, tableId) {
  const all = [];
  let offset = 0;
  while (true) {
    const data = await runLark(
      'base', '+record-list',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--format', 'json',
      '--limit', '200',
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

// 状态映射
const STATUS_MAP = { '待处理': 'todo', '准备中': 'preparing', '进行中': 'progress', '已处理': 'done', '已取消': 'blocked' };
const STATUS_REV = { todo: '待处理', preparing: '准备中', progress: '进行中', done: '已处理', blocked: '已取消' };
const PRIORITY_MAP = { '高': 'P0', '中': 'P1', '低': 'P2' };
const PRIORITY_REV = { P0: '高', P1: '中', P2: '低' };

async function main() {
  console.log('=== 安全推送分析 ===\n');

  // 1. 检查本地数据文件
  if (!fs.existsSync(LOCAL_TASKS_FILE)) {
    console.error('❌ 未找到本地数据文件：local_tasks.json');
    console.log('\n请按以下步骤操作：');
    console.log('1. 在浏览器打开 index.html');
    console.log('2. 按 F12 打开开发者工具');
    console.log('3. 在 Console 中执行：');
    console.log('   copy(JSON.stringify(JSON.parse(localStorage.getItem("ai-task-lens-tasks"))))');
    console.log('4. 创建文件 local_tasks.json，粘贴复制的内容');
    console.log('5. 再次运行此脚本');
    return;
  }

  // 2. 加载本地数据
  const localTasks = JSON.parse(fs.readFileSync(LOCAL_TASKS_FILE, 'utf8'));
  console.log(`✅ 本地数据：${localTasks.length} 条`);

  // 3. 备份本地数据
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(localTasks, null, 2), 'utf8');
  console.log(`✅ 已备份到：${BACKUP_FILE}`);

  // 4. 加载推送日志
  const pushLog = fs.existsSync(PUSH_LOG_FILE) ? JSON.parse(fs.readFileSync(PUSH_LOG_FILE, 'utf8')) : {};
  const pushedTimestamps = Object.keys(pushLog);
  console.log(`✅ 已推送记录：${pushedTimestamps.length} 条`);

  // 5. 拉取飞书数据
  console.log('\n正在拉取飞书数据...');
  const okrRecords = await fetchAllRecords(BASE_TOKEN, OKR_TABLE_ID);
  const inboxRecords = await fetchAllRecords(BASE_TOKEN, INBOX_TABLE_ID);
  console.log(`✅ 飞书 OKR：${okrRecords.length} 条`);
  console.log(`✅ 飞书 日程待办：${inboxRecords.length} 条`);

  // 6. 建立飞书时间戳集合
  const feishuTimestamps = new Set();
  okrRecords.forEach(({ record }) => {
    const ts = record['时间戳(14位)'] || record['时间戳（14位）'];
    if (ts && typeof ts === 'string') feishuTimestamps.add(ts);
  });
  inboxRecords.forEach(({ record }) => {
    const ts = record['时间戳(14位)'] || record['时间戳（14位）'];
    if (ts && typeof ts === 'string') feishuTimestamps.add(ts);
  });
  console.log(`✅ 飞书有时间戳的记录：${feishuTimestamps.size} 条`);

  // 7. 筛选本地独有的数据
  const uniqueLocalTasks = localTasks.filter(t => {
    const ts = t.timestamp || '';
    // 无时间戳的视为未推送（演示数据）
    if (!ts) return false;
    // 时间戳不在飞书和推送日志中的
    return !feishuTimestamps.has(ts) && !pushedTimestamps.includes(ts);
  });

  console.log(`\n=== 分析结果 ===`);
  console.log(`本地总数：${localTasks.length} 条`);
  console.log(`飞书总数：${okrRecords.length + inboxRecords.length} 条`);
  console.log(`差异：${localTasks.length - (okrRecords.length + inboxRecords.length)} 条`);
  console.log(`\n本地独有（未推送）：${uniqueLocalTasks.length} 条`);

  // 8. 分类显示
  const uniqueByType = {
    object: uniqueLocalTasks.filter(t => t.type === 'object'),
    kr: uniqueLocalTasks.filter(t => t.type === 'kr'),
    target: uniqueLocalTasks.filter(t => t.type === 'target'),
    task: uniqueLocalTasks.filter(t => t.type === 'task'),
  };

  console.log(`\n按类型分布：`);
  console.log(`  Object: ${uniqueByType.object.length} 条`);
  console.log(`  KR: ${uniqueByType.kr.length} 条`);
  console.log(`  Target: ${uniqueByType.target.length} 条`);
  console.log(`  Task: ${uniqueByType.task.length} 条`);

  // 9. 显示前10条示例
  if (uniqueLocalTasks.length > 0) {
    console.log(`\n前10条未推送记录：`);
    uniqueLocalTasks.slice(0, 10).forEach((t, i) => {
      console.log(`${i+1}. [${t.type}] ${t.title?.substring(0, 50) || '(无标题)'} (TS: ${t.timestamp})`);
    });
  }

  // 10. 保存分析报告
  const reportFile = path.join(__dirname, 'sync_report.json');
  const report = {
    localTotal: localTasks.length,
    feishuTotal: okrRecords.length + inboxRecords.length,
    uniqueLocal: uniqueLocalTasks.length,
    uniqueByType,
    uniqueTasks: uniqueLocalTasks.map(t => ({
      id: t.id,
      type: t.type,
      title: t.title,
      timestamp: t.timestamp,
      parentId: t.parentId,
      status: t.status,
      priority: t.priority,
    })),
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n✅ 分析报告已保存：${reportFile}`);

  // 11. 询问是否执行推送
  console.log(`\n=== 推送建议 ===`);
  if (uniqueLocalTasks.length === 0) {
    console.log('没有需要推送的新数据。');
  } else {
    console.log(`发现 ${uniqueLocalTasks.length} 条本地独有数据，建议推送。`);
    console.log('\n执行推送的命令：');
    console.log('node push_unique.cjs');
  }
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});