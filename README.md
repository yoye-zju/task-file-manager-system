# 任务和文件管理系统

本地优先的个人任务与文件管理双工具。纯前端 + 零依赖服务，数据全部保存在本地（浏览器 localStorage 或运行时数据目录），**仓库不含任何个人数据、本地路径或飞书凭证**。

## 目录结构

```
├── Rev260629_C/          # AI 任务透视镜
│   ├── index.html        # 主页面（任务四层体系 / 八种视图 / CSV / 飞书同步）
│   ├── app.js            # 前端逻辑（约 9000 行，原生 JS）
│   ├── style.css
│   ├── sync_server.js    # 飞书双向同步服务（Node.js）
│   └── server.js         # 静态站备用服务
└── file-tag-manager/     # 文件标签管理器
    ├── server.py         # 后端（Python 标准库，零第三方依赖，端口 3456）
    ├── index.html        # 前端（文件扫描 / 多维标签 / 表达式搜索 / 高亮）
    └── 文件标签管理系统_PRD.md
```

## 快速启动

- **Windows**：双击 `Rev260629_C\一键启动.bat`（自动启动两个服务并打开浏览器）
- **手动启动**：
  - 文件标签管理器：`cd file-tag-manager && python server.py`（端口 3456）
  - AI 任务透视镜：`cd Rev260629_C && python start_server.py`（端口 8080）

环境要求：Python 3、Node.js（仅飞书同步需要）。

## 飞书同步（可选）

1. 安装 lark-cli 并完成授权：`lark-cli auth login --domain drive --as user`
2. 配置环境变量（或复制 `feishu.credentials.js.template` 为 `feishu.credentials.js` 填写）：

| 环境变量 | 说明 |
|----------|------|
| `FEISHU_BASE_TOKEN` | 飞书多维表格 app_token |
| `FEISHU_OKR_TABLE_ID` | OKR 表 table_id |
| `FEISHU_INBOX_TABLE_ID` | 收件箱表 table_id |

3. 启动同步服务：`node sync_server.js`（默认端口 **9877**），前端状态灯显示在线后可拉取/推送。

> 注意：`feishu.credentials.js` 已被 .gitignore 排除，**请勿将任何凭证提交入库**。

## 数据存储

- AI 任务透视镜：数据存浏览器 `localStorage`（可用顶栏「💾 备份」导出完整 JSON）
- 文件标签管理器：数据存 `file-tag-manager/data/`（运行时自动生成，不入库）

## 测试

- `Rev260629_C`：`node _test_*.js`（约 27 个桩测试，无浏览器依赖，需在目录内运行）
- `file-tag-manager`：`python _test_ftm_fix.py` 等（纯内存模式）

## 端口一览

| 端口 | 服务 |
|------|------|
| 8080 | AI 任务透视镜（静态站） |
| 3456 | 文件标签管理器 |
| 9877 | 飞书同步服务 |

## 隐私红线

本仓库不接受任何凭证、绝对路径、真实用户名等敏感信息合入。发现请立即提出 issue 说明。
