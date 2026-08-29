/**
 * 执行推送：将本地独有的数据推送到飞书
 * 
 * 前置条件：
 * 1. 已运行 safe_push.cjs 并确认要推送的数据
 * 2. sync_report.json 中包含要推送的数据列表
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
const SYNC_REPORT_FILE = path.join(__dirname, 'sync_report.json');
const PUSH_LOG_FILE = path.join(__dirname, 'push_log.json');

async function runLark(...args) {
  const { stdout } = await execFileAsync(LARK_NODE, [LARK_SCRIPT, ...args], {
    encoding: 'utf-8',
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// 状态映射
const STATUS_REV = { todo: '待处理', preparing: '准备中', progress: '进行中', done: '已处理', blocked: '已取消' };
const PRIORITY_REV = { P0: '高', P1: '中', P2: '低' };

async function main() {
  console.log('=== 执行推送 ===\n');

  // 1. 检查前置文件
  if (!fs.existsSync(LOCAL_TASKS_FILE)) {
    console.error('❌ 未找到 local_tasks.json');
    return;
  }
  if (!fs.existsSync(SYNC_REPORT_FILE)) {
    console.error('❌ 未找到 sync_report.json，请先运行 safe_push.cjs');
    return;
  }

  // 2. 加载数据
  const localTasks = JSON.parse(fs.readFileSync(LOCAL_TASKS_FILE, 'utf8'));
  const report = JSON.parse(fs.readFileSync(SYNC_REPORT_FILE, 'utf8'));
  const pushLog = fs.existsSync(PUSH_LOG_FILE) ? JSON.parse(fs.readFileSync(PUSH_LOG_FILE, 'utf8')) : {};

  console.log(`本地数据：${localTasks.length} 条`);
  console.log(`待推送：${report.uniqueLocal} 条`);

  if (report.uniqueLocal === 0) {
    console.log('\n没有需要推送的数据。');
    return;
  }

  // 3. 获取要推送的任务详情
  const uniqueIds = report.uniqueTasks.map(t => t.id);
  const toPush = localTasks.filter(t => uniqueIds.includes(t.id));

  // 4. 分离 KR 和 Task
  const krsToPush = toPush.filter(t => t.type === 'kr');
  const tasksToPush = toPush.filter(t => t.type === 'task');
  const objectsToPush = toPush.filter(t => t.type === 'object');
  const targetsToPush = toPush.filter(t => t.type === 'target');

  console.log(`\n待推送分类：`);
  console.log(`  Object: ${objectsToPush.length} 条（飞书不支持独立推送，需合并到KR）`);
  console.log(`  KR: ${krsToPush.length} 条`);
  console.log(`  Target: ${targetsToPush.length} 条（飞书不支持，跳过）`);
  console.log(`  Task: ${tasksToPush.length} 条`);

  // 5. 构建 Object → 标题映射
  const objTitleMap = {};
  localTasks.filter(t => t.type === 'object').forEach(o => {
    objTitleMap[String(o.id)] = o.title || '未分类';
  });

  // 6. 推送 KR
  let createdKrs = 0;
  let krRecordIdMap = {};
  
  if (krsToPush.length > 0) {
    console.log(`\n正在推送 KR...`);
    const BATCH = 50;
    for (let i = 0; i < krsToPush.length; i += BATCH) {
      const batch = krsToPush.slice(i, i + BATCH);
      const fieldsList = ['关键目标', '关键结果（KR）', '日期', '工作方向', '时间戳(14位)'];
      const rows = batch.map(kr => [
        objTitleMap[String(kr.parentId)] || '未分类',
        kr.title || `KR-${kr.id}`,
        kr.deadline || null,
        kr.tag || null,
        kr.timestamp || '',
      ]);

      try {
        const result = await runLark('base', '+record-batch-create',
          '--base-token', BASE_TOKEN, '--table-id', OKR_TABLE_ID,
          '--json', JSON.stringify({ fields: fieldsList, rows }),
          '--format', 'json', '--as', 'user');
        
        const d = result.data || result;
        const returnedIds = d.record_id_list || [];
        for (let j = 0; j < batch.length; j++) {
          krRecordIdMap[String(batch[j].id)] = returnedIds[j] || '';
          pushLog[batch[j].timestamp] = { time: new Date().toISOString(), title: batch[j].title };
        }
        createdKrs += batch.length;
        console.log(`  ✅ 推送 ${batch.length} 条 KR (累计 ${createdKrs}/${krsToPush.length})`);
      } catch (e) {
        console.error(`  ❌ 推送 KR 失败: ${e.message}`);
      }
    }
  }

  // 7. 推送 Task
  let createdTasks = 0;
  
  if (tasksToPush.length > 0) {
    console.log(`\n正在推送 Task...`);
    const BATCH = 50;
    for (let i = 0; i < tasksToPush.length; i += BATCH) {
      const batch = tasksToPush.slice(i, i + BATCH);
      const fieldsList = ['事项内容', '优先级', '截止时间', '备注', '状态', '类型', '处理方式', '所属OKR', '时间戳(14位)'];
      const rows = batch.map(t => {
        const pid = String(t.parentId || '');
        const okrLink = krRecordIdMap[pid] ? [{ id: krRecordIdMap[pid] }] : null;
        const isMilestone = String(t.isMilestone) === 'true';
        return [
          (t.title || `Task-${t.id}`).substring(0, 200),
          PRIORITY_REV[t.priority] || '中',
          t.deadline || null,
          t.desc || null,
          STATUS_REV[t.status] || '待处理',
          isMilestone ? '重要+紧急' : null,
          t.tag || null,
          okrLink,
          t.timestamp || '',
        ];
      });

      try {
        const result = await runLark('base', '+record-batch-create',
          '--base-token', BASE_TOKEN, '--table-id', INBOX_TABLE_ID,
          '--json', JSON.stringify({ fields: fieldsList, rows }),
          '--format', 'json', '--as', 'user');
        
        const d = result.data || result;
        const returnedIds = d.record_id_list || [];
        for (let j = 0; j < batch.length; j++) {
          pushLog[batch[j].timestamp] = { time: new Date().toISOString(), title: batch[j].title };
        }
        createdTasks += batch.length;
        console.log(`  ✅ 推送 ${batch.length} 条 Task (累计 ${createdTasks}/${tasksToPush.length})`);
      } catch (e) {
        console.error(`  ❌ 推送 Task 失败: ${e.message}`);
      }
    }
  }

  // 8. 更新推送日志
  fs.writeFileSync(PUSH_LOG_FILE, JSON.stringify(pushLog, null, 2), 'utf8');
  console.log(`\n✅ 推送日志已更新`);

  // 9. 总结
  console.log(`\n=== 推送完成 ===`);
  console.log(`KR 推送成功：${createdKrs} 条`);
  console.log(`Task 推送成功：${createdTasks} 条`);
  console.log(`总计：${createdKrs + createdTasks} 条`);
  
  if (objectsToPush.length > 0 || targetsToPush.length > 0) {
    console.log(`\n⚠️ 以下数据未推送（飞书不支持此类型）：`);
    console.log(`  Object: ${objectsToPush.length} 条`);
    console.log(`  Target: ${targetsToPush.length} 条`);
    console.log('这些数据仍保存在本地，不会丢失。');
  }
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});