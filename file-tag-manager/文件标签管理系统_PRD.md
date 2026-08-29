# 文件标签管理系统 PRD

**版本：** v1.8.0  
**更新日期：** 2026-08-07  
**状态：** 已交付

---

## 1. 背景与目标

### 问题
文件散落在多个目录，按文件夹层级管理不灵活，检索困难，无法跨维度查找（如"英飞凌相关、未归档的PDF"）。

### 目标
构建一个本地文件标签管理工具，通过多维度标签体系让文件检索更灵活高效。

**核心理念：文件不动，标签跟着文件路径走。**

---

## 2. 用户

单用户本地工具，用户为工程师/研究人员，文件量 1,000～50,000 级别。

---

## 3. 技术方案

| 项目 | 方案 |
|------|------|
| 前端 | 原生 HTML/CSS/JS，单文件，无框架 |
| 后端 | 纯 Python 标准库（`server.py`，http.server），零依赖 |
| 数据存储 | JSON 文件（`data/db.json`），原子写入（tmp + replace） |
| 端口 | 3456 |
| 启动方式 | 双击 `启动.bat`（自动选择 exe > Python > Node.js） |
| 备份 | 扫描前自动备份 + **每 30 分钟定时自动备份**，保留最近 10 份至 `data/backup/` |

---

## 4. 文件结构

```
文件标签管理系统/
├── index.html          # 前端主界面
├── server.js           # 后端服务
├── 启动.bat            # Windows 启动脚本
├── 启动.ps1            # PowerShell 备选启动脚本
├── README.md
├── PRD.md              # 产品需求文档
├── test/
│   └── test_api.js     # API 自动化测试（独立端口3457，30项断言）
└── data/
    ├── db.json              # 数据库（JSON格式，运行时自动生成）
    ├── scan_filters.json    # 扫描文件类型过滤配置
    └── backup/              # 自动备份目录
```

---

## 5. 功能模块

### 5.1 文件扫描

- 配置扫描目录（可多个），界面内管理
- 手动触发扫描
- 增量扫描（只处理变化文件）
- 自动检测已删除文件
- 扫描前自动备份 `db.json`
- **扫描文件类型过滤**：通过 `data/scan_filters.json` 配置允许的扩展名，目录始终被遍历
  - 默认过滤：pptx / docx / xmind / txt / xlsx / xls / csv / zip / rar / 7z / tar / gz / pdf / vsd / vsdx
  - 设置面板可启用/禁用过滤、增删扩展名
  - 支持手动输入自定义扩展名
  - **包含文件夹选项**：勾选后扫描路径内的子文件夹也入库（显示 📁 图标）
  - 已有文件在扫描时如扩展名不在白名单，也会被清理
  - 过滤配置支持 JSON 导出/导入

### 5.1.1 飞书在线文档扫描（v1.7.0）

- 通过 lark-cli 递归扫描飞书云盘根目录，导入全部 12 种文档类型元数据
  - 文档类型：doc / docx / sheet / bitable / mindnote / slides / file / folder / wiki / shortcut / catalog / apps
  - 仅导入元数据（名称、URL、类型、修改时间、所属文件夹路径、owner_id），不下载文件内容
- **数据模型扩展**：文件记录新增 `source` / `url` / `cloud_id` / `cloud_type` / `folder_path` / `owner_id` 六个字段
  - `source = "feishu"` 的文件 `file_path` 存伪路径 `feishu://drive/<token>`，保证唯一性
  - 飞书文件用 `cloud_id`（token）去重，非 `file_path`（文档可能被重命名/移动）
  - 移除检查跳过 `source == "feishu"` 的文件（伪路径必然 `os.path.exists` 返回 False）
- **scan_config 新增 `type` 字段**（`"local"` / `"feishu"`），飞书配置仅允许一条
- `normalize_db_types()` 启动时自动迁移历史数据（幂等），为所有已有文件追加 6 个字段
- **前端混合显示**：飞书文档与本地文件同列表展示
  - 类型图标映射（docx 📄 / sheet 📊 / bitable 🗂️ / mindnote 🧠 / slides 📽️ / folder 📁 等）
  - 来源徽章：飞书文档显示 🔷 徽章，本地文件无徽章
  - 路径显示 `folder_path`（面包屑），大小显示 `--`
  - 来源筛选栏（全部 / 本地 / 飞书），互斥切换
- **打开飞书文档**：`window.open(url)` 直接在浏览器新标签打开飞书在线文档
- **设置面板**：新增飞书云盘区域，含授权状态检查按钮和扫描配置管理
- **API 新增**：`GET /api/feishu/auth-status` 检查 lark-cli 认证状态
- **依赖**：需已安装 lark-cli 并完成 drive 域用户认证（`lark-cli auth login --domain drive --as user`）

#### 5.1.2 认证过期处理（v1.8.0）

**判定方式**：设置面板「检查授权状态」按钮 → `GET /api/feishu/auth-status`：

| 返回 | 含义 | 处理 |
|------|------|------|
| `authenticated: true` | 认证有效 | 无需处理 |
| `error` 含「网络异常（非认证问题）」 | 网络抖动/TLS 超时，**不是认证问题** | 检查网络后重试扫描，**不要重新授权** |
| `authenticated: false` + 「未授权/认证错误」 | 认证真过期 | 重新授权（见下） |

**重新授权方式（二选一）**：
1. **一键重新授权（推荐）**：设置面板飞书区域点击「🔑 一键重新授权」→ 浏览器打开授权链接完成授权 → 回到页面点「✅ 我已完成授权」自动确认。后端流程：`POST /api/feishu/auth-login` 发起设备码（`lark-cli auth login --domain drive --as user --no-wait --json`，链接 10 分钟有效）→ `POST /api/feishu/auth-complete` 用暂存 device_code 完成（`lark-cli auth login --device-code <code>`）
2. **命令行**：`lark-cli auth login --domain drive --as user`，按浏览器提示完成

**经验说明**：access token 过期但 refresh token 仍有效时，lark-cli 会自动刷新，`auth-status` 仍返回 `authenticated: true`；「认证已过期」误报多为网络超时（lark-cli 以 exit 0 + JSON(ok=false) 输出到 stdout，错误分类器按 `error.type` 区分网络与认证，见 v1.7.1）。

### 5.2 多维度标签体系

- 支持自定义维度（默认：状态 / 知识领域 / 供应商 / 文件类型 / 项目）
- 维度下可挂任意数量标签
- 界面内可视化管理维度和标签（CRUD）

### 5.3 打标签 / 撤标签

- 右键文件 → 弹出标签面板
- 已有标签显示选中状态
- 取消勾选 = 移除标签（撤标签）
- 支持批量操作（多选文件后右键）
- **拖拽打标签**（v1.6.1）：左侧筛选面板的标签可直接拖拽到右侧文件行上释放，为文件打标签
  - 拖拽时文件区显示引导提示，目标文件行高亮虚线边框
  - 若目标文件在选中列表中，释放后对所有选中文件批量打标签
  - 自动跳过已有该标签的文件，Toast 反馈添加数量和跳过数量

### 5.4 文件筛选

| 筛选方式 | 说明 |
|----------|------|
| 关键词搜索 | 顶部搜索框，按文件名或路径过滤 |
| 标签筛选 | 左侧面板按维度点选标签 |
| 扩展名筛选栏 | 文件列表上方快捷栏，支持 Excel/Word/PPT/PDF/XMind/TXT/图片/压缩包 |
| 快捷分组 | 预设常用标签组合，一键筛选（位于扩展名筛选栏下方） |
| 来源筛选（v1.7.0） | 文件列表上方来源筛选栏：全部 / 本地 / 飞书，互斥切换 |
| 清除筛选 | 一键清除所有筛选条件 |

### 5.5 标签分组

- **简单模式**：选择标签列表 + 逻辑（OR / AND）
- **高级模式**：直接编写表达式，支持 `AND` / `OR` / `NOT` / 括号
- 表达式验证接口（`/api/tag-groups/validate`）
- 分组切换不刷新整个设置面板（就地 DOM 更新）

### 5.6 高亮功能

- 右键任意标签 → 高亮该标签
- 右键扩展名 chip → 高亮该扩展名
- 右键分组 chip → 高亮该分组
- 命中文件行变金色背景
- **持久化（v1.5 新增）**：高亮状态存入后端 `db.json` 的 `highlight_state` 字段（`tag_ids` / `exts` / `group_ids`），刷新页面、重启服务、换浏览器均不丢失。高亮/取消高亮即时保存，页面加载时自动恢复

### 5.7 文件操作

- 打开文件：`exec('start "" "${filePath}"')`，无 `windowsHide`（否则打开的程序窗口也被隐藏）
- 打开文件所在文件夹：`exec('explorer /select,"${filePath}"')`，回调忽略 explorer 的非零退出码
- 查看文件属性

### 5.8 数据导入导出

- **导出当前筛选结果**：CSV 格式，含文件名/路径/大小/修改时间/标签
- **导出标签体系**：CSV 两段式（`# 标签体系` + `# 分组`）
- **导入标签体系**：从 CSV 批量导入维度、标签、分组

### 5.9 文件备注（v1.6.0 新增）

- 每行文件右侧显示备注区域：空备注显示淡化的 💬 图标 + 占位文字，有内容备注显示金色 📝 图标 + 截断预览文本
- **行内编辑**：点击备注区域进入编辑模式（textarea），失焦自动保存，Esc 放弃修改
- 悬停已有备注时气泡提示全文
- 后端复用 `PUT /api/files/{id}` 接口，数据字段 `note` 自 v1.0 起已存在

---

## 6. API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/files` | GET | 文件列表（支持 keyword/tag_ids/group_id/ext/page/page_size/sort/order） |
| `/api/files/tags` | POST | 添加标签（旧接口保留） |
| `/api/files/update-tags` | POST | 增删标签（`{file_ids, add_tag_ids, remove_tag_ids}`） |
| `/api/files/:id/open` | POST | 打开文件 |
| `/api/files/:id/show` | POST | 打开文件所在文件夹 |
| `/api/dimensions` | GET/POST/PUT/DELETE | 维度 CRUD |
| `/api/tags` | GET/POST/PUT/DELETE | 标签 CRUD |
| `/api/tag-groups` | GET/POST/PUT/DELETE | 分组 CRUD |
| `/api/tag-groups/validate` | POST | 验证表达式 |
| `/api/tags/export` | GET | 导出标签体系 CSV |
| `/api/tags/import` | POST | 导入标签体系 CSV |
| `/api/scan-filters` | GET/PUT | 扫描过滤配置（扩展名白名单 + include_folders），支持导出 JSON / 导入覆盖 |
| `/api/scan-config` | GET/POST/DELETE | 扫描路径配置 |
| `/api/scan` | POST | 触发扫描 |
| `/api/highlight-state` | GET/POST | 高亮状态读写（v1.5 新增：标签/扩展名/分组高亮持久化） |

---

## 7. 已知问题与修复记录

| 问题 | 修复方案 |
|------|---------|
| better-sqlite3 编译失败 | 改为纯 JSON 存储，零依赖 |
| express 安装失败（node_modules 锁定） | 改用纯 Node.js http 模块 |
| API 404（前缀缺失） | `const API = ''` 改为 `const API = '/api'` |
| 设置面板无反应 | openSettings 加 try/catch，先显示 loading 再请求数据 |
| 标签无法撤回 | 新增 `/api/files/update-tags` 接口，前端记录原始标签，取消勾选=移除 |
| 打开文件/打开文件夹静默失败 | 多次迭代：exec+shell:cmd.exe → execFile → spawn → 最终 exec 无 windowsHide（结束） |
| 高级模式窗口消失 | switchGroupMode 不再调用 openSettings() 重新渲染，改为就地更新 DOM |
| 浏览器缓存旧页面 | 加禁用缓存 meta 标签，用 `?v=N` 参数强制刷新 |
| 扫描启动 EPERM 失败 | backupDB() 清理旧备份文件时 try-catch 容错 |
| 扫描过滤不生效 | path.extname() 返回 `.pptx`，配置文件存 `pptx`，加 `.replace('.', '')` 修复 |
| 扫描新增0文件 | 上次 bug 已将文件标记删除，本次扫描恢复而非新增，实际 129 文件正常 |
| 设置面板滚动跳动 | 全文件 `<button>` 加 `type="button"`；过滤操作用 `renderFilterChips()` 局部刷新 |
| 打开文件夹跳到 C:\Users | spawn 参数被 explorer 截断；改回 exec 用双引号包路径 |
| 打开功能不好使（最新） | exec 加了 `windowsHide: true` 导致程序窗口被隐藏；去掉后正常 |
| **高亮状态总是消失（v1.5）** | 高亮只存前端内存变量，刷新/重启即丢。修复：后端 `db.json` 新增 `highlight_state` 字段 + GET/POST `/api/highlight-state` 接口，前端高亮操作即时保存、页面加载自动恢复 |
| **打的标签隔天丢（v1.5）** | 多重根因修复：① 启动顺序错误——旧进程 `main()` 先 `load_db()` 再 taskkill 旧进程，新进程用旧内存数据覆盖磁盘新标签；改为**先杀旧进程再读数据**。② `save_db()` 并发无锁——ThreadingHTTPServer 多线程同时写同一 `.tmp` 文件互踩、`json.dump` 中途字典被改抛异常被静默吞掉（接口仍返回 200）；改为**全局 DB_LOCK + 深拷贝快照 + 3 次重试 + 失败返回 500**。③ `load_db()` 损坏自动恢复的备份只在扫描时产生（可隔天）；新增**每 30 分钟定时备份**，回退窗口降至 30 分钟 |
| **db.json 持续膨胀（v1.5）** | `/api/files` 与文件详情接口把响应 `tags` 字段直接写回 `db["files"]` 对象，后续 save_db 把冗余快照落盘（已 7.3MB 且持续增长）；改为在响应副本上附加 tags |
| **删除标签确认文案误导（v1.5）** | 文案"已打此标签的文件不受影响"与实际级联删除所有文件上的该标签相反；改为明确提示"将同时移除所有文件上的该标签标记，且不可恢复" |
| **设置面板打开报 HTTP 500（v1.5.1）** | 报错原文 `'<' not supported between instances of 'str' and 'int'`。根因：历史数据中 id=14 的维度 `sort_order` 被存成字符串 `'2'`，其余维度为 int，`sorted(db["dimensions"], key=lambda d: d["sort_order"])` 混合类型比较直接抛 TypeError → `/api/dimensions` 500 → 设置面板 `Promise.all` 五个接口整体失败。修复三层：① 新增 `to_int()` + `dim_sort_key()` 统一排序键，排序不再直接比较原始值；② 新增 `normalize_db_types()` 在 `load_db()` 后归一化维度/标签/分组的 `id`、`sort_order`、`dimension_id`，修好即落盘且幂等；③ 维度更新接口写入 `sort_order` 强制 `to_int`，堵住新脏数据来源。另加固文件列表排序（`file_size` 走 `to_int`，文本列统一 `str(... or "")`），避免同列混有 None/字符串时崩溃 |

---

## 8. 默认预置

- 扫描路径：用户首次启动后自行配置（默认为空）
- 标签维度：状态、知识领域、供应商、文件类型、项目
- 预置标签示例：待阅读 / 已完成、PSU / IDC / VRM、英飞凌 / TI 等

---

## 9. 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v0.1 | 2026-06 | MVP：扫描、标签、基础筛选 |
| v0.2 | 2026-06 | 标签分组支持 AND/OR/表达式模式 |
| v0.3 | 2026-06 | 扩展名筛选栏、快捷分组移位、高亮功能 |
| v0.4 | 2026-07 | 标签撤回修复、打开文件修复、CSV 导入导出 |
| v1.0 | 2026-07-01 | 全功能交付，备份：文件标签管理系统_backup_20260701 |
| v1.1 | 2026-07-01 | 扫描文件类型过滤：scan_filters.json 配置，设置面板管理 |
| v1.1.1 | 2026-07-01 | 修复扫描过滤残留、配置导入导出、backupDB 容错、extname 点号修复 |
| v1.2 | 2026-07-02 | 包含文件夹扫描、设置面板滚动修复、打开文件/文件夹多轮修复（exec→spawn→exec最终方案） |
| v1.3 | 2026-07-02 | Python 重写 (server.py)，PyInstaller 打包 exe (dist/FileTag/FileTag.exe)，启动.bat 自动选择 exe > Python > Node.js |
| v1.5 | 2026-08-05 | **数据安全修复**：① 高亮状态后端持久化（`highlight_state` + `/api/highlight-state`）；② 标签丢失多重根因修复（启动顺序纠正、save_db 加锁+快照+重试+失败500、每 30 分钟定时备份）；③ db.json 膨胀修复（list/detail 不再写回快照）；④ 删除标签确认文案修正。自测：`_test_ftm_fix.py` 27 项断言全过 |
| v1.5.1 | 2026-08-06 | **修复设置面板 HTTP 500**：脏数据 `sort_order: '2'`（字符串）与 int 混排抛 TypeError。新增 `to_int()` / `dim_sort_key()` / `normalize_db_types()` 三件套，启动自动归一化历史脏数据并落盘；维度更新写入强制转 int；文件列表排序同步加固。自测：`_test_sort_order_fix.py` 39 项断言全过，旧套件 27 项无回归 |
| v1.6.0 | 2026-08-06 | **新增文件行内备注**：每行文件右侧显示备注区，空备注淡化占位，有内容金色图标 + 截断预览，点击行内编辑 textarea，失焦自动保存、Esc 放弃。后端零改动（note 字段和 PUT API 自 v1.0 已存在） |
| v1.6.1 | 2026-08-06 | **新增拖拽打标签**：左侧标签可直接拖拽到右侧文件行上释放打标签；支持批量（目标文件在选中列表中时对全部选中文件生效）；自动跳过已有标签的文件，Toast 反馈。后端零改动（复用 POST /api/files/update-tags） |
| v1.7.0 | 2026-08-07 | **新增飞书在线文档扫描与导入**：通过 lark-cli 递归扫描飞书云盘根目录，导入全部 12 种文档类型元数据（不下载内容）；数据模型扩展 6 个字段 + normalize_db_types 自动迁移；scan_config 新增 type 分支；前端混合显示 + 来源筛选；设置面板新增飞书区域（授权检查/配置管理）；打开飞书文档直接跳转浏览器；CSV 导出新增 source 列；subprocess encoding 修复 Windows GBK 解码 |
| v1.7.1 | 2026-08-27 | **修复飞书网络超时误报「认证已过期」**：lark-cli 网络错误以 exit 0 + JSON(ok=false) 输出 stdout，旧逻辑只看 returncode/stderr 导致漏判/误判；新增 `_classify_lark_cli_error` 分类器（正则词边界，区分 认证/网络/其他，folder_token 不误判）；run_scan 与 auth-status 均新增 FeishuNetworkError 分支，网络问题提示重试、认证问题提示 `lark-cli auth login --domain drive --as user`；自测 `_test_lark_cli_error_classify.py` 14 项断言全过 |
| v1.8.0 | 2026-08-27 | **修复 v1.7.1 未生效**（server.py 存在新旧两份 `_lark_cli_exec`，旧版覆盖新版，错误分类实际未启用，删除旧版）；**新增「一键重新授权」**：设置面板未授权时显示按钮，`POST /api/feishu/auth-login` 发起设备码（`--no-wait --json`）返回授权链接，前端引导弹窗展示链接，`POST /api/feishu/auth-complete` 用暂存 device_code 完成（`--device-code`），全程无需命令行；checkFeishuAuth 区分网络异常与认证过期（网络异常不引导重新授权）；设置面板与 PRD 补充认证处理指引，AI任务透视镜「使用帮助」弹窗数据管理章节同步补充；自测 `_test_feishu_auth_flow.py` 新增、`_test_lark_cli_error_classify.py` 14 项回归通过 |
