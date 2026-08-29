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

async function runLark(...args) {
  try {
    const { stdout, stderr } = await execFileAsync(LARK_NODE, [LARK_SCRIPT, ...args], {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stderr) console.error('stderr:', stderr);
    return JSON.parse(stdout);
  } catch (e) {
    console.error('Error:', e.message);
    throw e;
  }
}

async function fetchAllRecords(baseToken, tableId, pageSize = 200) {
  const all = [];
  let offset = 0;
  while (true) {
    console.log(`Fetching offset ${offset}...`);
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

async function main() {
  console.log('=== 开始获取飞书数据 ===');
  console.log('Node:', LARK_NODE);
  console.log('Script:', LARK_SCRIPT);
  console.log('Node exists:', fs.existsSync(LARK_NODE));
  console.log('Script exists:', fs.existsSync(LARK_SCRIPT));
  
  console.log('\n=== OKR 表 ===');
  const okrRecords = await fetchAllRecords(BASE_TOKEN, OKR_TABLE_ID);
  console.log(`OKR 总数: ${okrRecords.length}`);
  
  // 输出前5条记录作为示例
  console.log('\n前5条 OKR 记录:');
  okrRecords.slice(0, 5).forEach(({ record, rid }, i) => {
    console.log(`${i+1}. ID: ${rid}`);
    console.log('   关键目标:', record['关键目标']);
    console.log('   关键结果:', record['关键结果（KR）']);
    console.log('   日期:', record['日期']);
    console.log('   工作方向:', record['工作方向']);
    console.log('   时间戳:', record['时间戳(14位)']);
  });

  console.log('\n=== 日程待办表 ===');
  const inboxRecords = await fetchAllRecords(BASE_TOKEN, INBOX_TABLE_ID);
  console.log(`日程待办 总数: ${inboxRecords.length}`);
  
  // 输出前5条记录作为示例
  console.log('\n前5条日程待办记录:');
  inboxRecords.slice(0, 5).forEach(({ record, rid }, i) => {
    console.log(`${i+1}. ID: ${rid}`);
    console.log('   事项内容:', record['事项内容']);
    console.log('   状态:', record['状态']);
    console.log('   优先级:', record['优先级']);
    console.log('   截止时间:', record['截止时间']);
    console.log('   所属OKR:', record['所属OKR']);
    console.log('   时间戳:', record['时间戳(14位)']);
  });

  // 保存完整数据到文件
  const outputPath = path.join(__dirname, 'feishu_data.json');
  fs.writeFileSync(outputPath, JSON.stringify({ okr: okrRecords, inbox: inboxRecords }, null, 2), 'utf8');
  console.log(`\n完整数据已保存到: ${outputPath}`);
}

main().catch(e => {
  console.error('Failed:', e);
  process.exit(1);
});