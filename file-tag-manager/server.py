#!/usr/bin/env python3
"""文件标签管理系统 — Python 后端 (零依赖，纯标准库)"""
import http.server
import json
import logging
import os
import os.path
import re
import socket
import subprocess
import sys
import threading
import urllib.parse
from datetime import datetime, timezone

# ==================== 配置 ====================
VERSION = "1.8.0"

CHANGELOG = [
    {
        "version": "v1.8.0",
        "date": "2026-08-27",
        "changes": [
            "修复 v1.7.1 错误分类修复实际未生效：server.py 存在新旧两份 _lark_cli_exec（旧版在文件后部覆盖新版），删除旧版，错误分类逻辑真正生效",
            "新增「一键重新授权」：设置面板未授权时显示按钮，POST /api/feishu/auth-login 发起设备码授权（lark-cli auth login --domain drive --as user --no-wait --json）返回授权链接，前端引导弹窗展示；POST /api/feishu/auth-complete 用暂存 device_code 完成（--device-code），全程无需命令行",
            "checkFeishuAuth 区分网络异常与认证过期：网络问题提示重试、不引导重新授权；认证过期提示一键授权按钮或命令行命令",
            "设置面板文案修正：lark-cli auth login --domain drive --domain docs → --domain drive --as user；认证处理指引写入设置面板与 PRD 5.1.2",
            "新增测试 _test_feishu_auth_flow.py（纯内存），_test_lark_cli_error_classify.py 14 项回归通过",
        ]
    },
    {
        "version": "v1.7.1",
        "date": "2026-08-27",
        "changes": [
            "修复飞书扫描网络超时被误报为「认证已过期」：lark-cli 网络错误以 exit 0 + JSON(ok=false) 输出到 stdout，旧逻辑只看 returncode/stderr 会漏判或误判",
            "新增 _classify_lark_cli_error 错误分类器：正则词边界匹配，区分 FeishuAuthError(认证) / FeishuNetworkError(网络) / RuntimeError(其他)，folder_token/unexpected token 不再误判为认证错误",
            "run_scan 新增 FeishuNetworkError 分支：网络问题提示「请检查网络后重试」，不再误导用户重新登录；认证过期提示改为 lark-cli auth login --domain drive --as user",
            "GET /api/feishu/auth-status 增加 FeishuNetworkError 处理：网络异常时返回「网络异常（非认证问题）」而非笼统的未授权",
            "新增测试 _test_lark_cli_error_classify.py（纯内存），14 个断言全部通过",
        ]
    },
    {
        "version": "v1.7.0",
        "date": "2026-08-07",
        "changes": [
            "新增飞书在线文档扫描与导入：通过 lark-cli 递归扫描飞书云盘根目录，导入全部 12 种文档类型元数据（名称/URL/类型/修改时间/所属文件夹路径），不下载文件内容",
            "数据模型扩展：文件记录新增 source/url/cloud_id/cloud_type/folder_path/owner_id 六个字段，normalize_db_types 启动时自动迁移历史数据（幂等）",
            "scan_config 新增 type 字段（local/feishu），飞书配置仅允许一条；run_scan 按类型分支，飞书文件用 cloud_id 去重、跳过 os.path.exists 移除检查",
            "前端混合显示：飞书文档与本地文件同列表展示，通过类型图标和来源徽章区分；新增来源筛选栏（全部/本地/飞书），支持互斥切换",
            "设置面板新增飞书云盘区域：授权状态检查、扫描配置管理；打开飞书文档直接 window.open 跳转浏览器",
            "新增 GET /api/feishu/auth-status 端点检查 lark-cli 认证状态",
            "CSV 导出新增 source 列（local/feishu）",
            "subprocess encoding='utf-8' 修复 Windows GBK 环境下 lark-cli 输出解码失败",
        ]
    },
    {
        "version": "v1.6.1",
        "date": "2026-08-06",
        "changes": [
            "新增拖拽打标签功能：左侧筛选面板的标签可拖拽到右侧文件行上释放，直接为文件打标签",
            "拖拽时文件区显示引导提示，文件行高亮虚线边框指示放置目标",
            "支持批量打标签：若目标文件在选中列表中，拖拽释放会对所有选中文件同时打标签",
            "自动跳过已有该标签的文件，Toast 反馈操作结果（添加数量、跳过数量）",
            "复用已有 POST /api/files/update-tags 接口，后端零改动",
        ]
    },
    {
        "version": "v1.6.0",
        "date": "2026-08-06",
        "changes": [
            "新增文件行内备注功能：每行文件右侧显示备注区域，点击即可编辑，失焦自动保存",
            "空备注显示淡化图标 + 占位文字，有内容备注显示金色图标 + 截断预览，悬停提示全文",
            "编辑模式自动展开 textarea，按 Esc 放弃修改，blur 保存；复用已有 PUT /api/files/{id} 接口",
            "备注数据字段 note 从 v1.0 起已存在于文件记录中，后端无需改动",
        ]
    },
    {
        "version": "v1.5.1",
        "date": "2026-08-06",
        "changes": [
            "修复设置面板打开报 HTTP 500（'<' not supported between instances of 'str' and 'int'）：历史数据中某维度 sort_order 被存成字符串 '2'，与其他 int 值一起排序时抛类型错误，导致 /api/dimensions 及标签体系导出全部失败",
            "新增 to_int() 安全转换与 dim_sort_key() 统一排序键，所有维度排序不再直接比较原始值",
            "新增 normalize_db_types()：启动加载后自动把维度/标签/分组的 id、sort_order、dimension_id 等脏数据（字符串数字）归一化为 int 并落盘，幂等且只修一次",
            "维度更新接口写入 sort_order 时强制 to_int，杜绝新脏数据产生",
            "加固文件列表排序：数值列（file_size）走 to_int，文本列统一转小写字符串，混有 None 或字符串数字时不再崩溃",
        ]
    },
    {
        "version": "v1.5.0",
        "date": "2026-08-05",
        "changes": [
            "修复高亮状态丢失：标签/扩展名/分组高亮从『仅前端内存』改为后端持久化（db.json highlight_state），刷新页面、重启服务、换浏览器都不再丢失",
            "修复标签隔天丢失的多重根因：① 启动顺序纠正——先杀旧进程再读数据，杜绝新进程用旧内存覆盖磁盘新标签；② save_db 加全局锁 + 深拷贝快照 + 失败重试，杜绝并发写互踩与『显示成功实际没保存』；③ 写盘失败时打标签接口明确返回 500，不再静默吞错",
            "新增定时自动备份（每 30 分钟），db.json 损坏时最多回退 30 分钟数据（原机制备份仅扫描时产生，可能回退数天）",
            "修复 db.json 持续膨胀：文件列表/详情接口不再把响应 tags 写回数据对象",
            "修正删除标签确认文案：明确提示『将同时移除所有文件上的该标签标记』",
        ]
    },
    {
        "version": "v1.4.0",
        "date": "2026-07-25",
        "changes": [
            "数据安全加固：db.json 损坏时自动从备份恢复，不再静默清空",
            "写入保护：save_db() 改为原子写入（先写 .tmp 再替换），防止断电损坏",
            "新增完整数据库备份/恢复功能（API + 前端 UI）",
            "设置面板新增「数据备份与恢复」区域，支持下载备份/上传恢复/查看自动备份",
            "恢复历史扫描数据：从 7/23 备份恢复 9,197 个文件和 4 个扫描路径",
        ]
    },
    {
        "version": "v1.3.0",
        "date": "2026-07-24",
        "changes": [
            "与 AI 任务透视镜系统打通：content-links API 双向关联",
            "表格视图新增关联任务列，显示文件关联的内容块",
            "关联内容块横排展示，支持悬浮预览和点击跳转",
            "跳回任务透视镜时自动定位到时间线视图并高亮对应行",
            "窗口复用：跳转时复用已打开的标签页，避免窗口越开越多",
            "文件关联数据存储在 data/content_links.json",
        ]
    },
    {
        "version": "v1.2.0",
        "date": "2026-07-23",
        "changes": [
            "新增扫描文件类型过滤：支持按扩展名过滤（文档/图表/压缩包等）",
            "新增 CSV 文件列表导出功能",
            "新增标签体系导入/导出（维度 + 标签 + 分组配置）",
            "新增扫描过滤配置导入/导出",
            "可视化设置面板：扫描路径管理、过滤配置、标签维度管理",
        ]
    },
    {
        "version": "v1.1.0",
        "date": "2026-07-22",
        "changes": [
            "多维度标签体系：维度 → 标签 → 分组，支持层级化标签管理",
            "4 套皮肤切换（默认/暗色/护眼/高对比度）",
            "文件属性面板：编辑标签、查看文件元信息",
            "面包屑导航 / 标签筛选 / 关键字搜索",
            "表格视图 / 卡片视图双模式切换",
        ]
    },
    {
        "version": "v1.0.0",
        "date": "2026-07-21",
        "changes": [
            "初始版本：文件扫描、标签管理、表格展示",
            "基础搜索和筛选功能",
            "文件元信息自动提取（大小、修改时间、扩展名）",
        ]
    },
]
PORT = int(os.environ.get("TAG_SERVER_PORT", "3456"))

# PyInstaller 打包后: sys._MEIPASS 指向 _internal 目录（只读资源）
# 数据目录放在 exe 同级，而不是 _internal 内
if getattr(sys, 'frozen', False):
    # 打包后的 exe 路径
    EXE_DIR = os.path.dirname(sys.executable)
    STATIC_DIR = sys._MEIPASS  # index.html 在这
else:
    EXE_DIR = os.path.dirname(os.path.abspath(__file__))
    STATIC_DIR = EXE_DIR

DATA_DIR = os.path.join(EXE_DIR, "data")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")
DB_FILE = os.path.join(DATA_DIR, "db.json")
FILTER_FILE = os.path.join(DATA_DIR, "scan_filters.json")
CL_FILE = os.path.join(DATA_DIR, "content_links.json")

# ==================== 数据存储 ====================
# 全局写锁：保护 db 的修改 + save_db 落盘全过程（ThreadingHTTPServer 多线程并发下
# 两个请求同时写同一个 .tmp 文件会互踩；json.dump 中途字典被改会抛 RuntimeError）。
DB_LOCK = threading.Lock()

db = {
    "scan_config": [],
    "dimensions": [],
    "tags": [],
    "files": [],
    "file_tags": [],
    "tag_groups": [],
    "group_tags": [],
    "scan_history": [],
    "highlight_state": {"tag_ids": [], "exts": [], "group_ids": []},
    "_fileId": 1,
    "_tagId": 1,
    "_groupId": 1,
    "_dimId": 1,
    "_configId": 1,
}

def load_db():
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(BACKUP_DIR):
        os.makedirs(BACKUP_DIR, exist_ok=True)
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            db.update(loaded)
            # 旧数据兜底：缺少 highlight_state（v1.4 之前）时补齐默认值
            if not isinstance(db.get("highlight_state"), dict):
                db["highlight_state"] = {"tag_ids": [], "exts": [], "group_ids": []}
        except Exception as e:
            print(f"[ERROR] Failed to load db.json: {e}", file=sys.stderr)
            # ① Back up the corrupted file for forensics
            try:
                ts = datetime.now().isoformat().replace(":", "-").replace(".", "-")
                corrupted = os.path.join(BACKUP_DIR, f"db-corrupted-{ts}.json")
                with open(DB_FILE, "rb") as src:
                    with open(corrupted, "wb") as dst:
                        dst.write(src.read())
                print(f"[WARN] Corrupted db.json saved to {corrupted}", file=sys.stderr)
            except Exception as be:
                print(f"[ERROR] Could not back up corrupted db.json: {be}", file=sys.stderr)
            # ② Try to recover from the latest valid backup
            recovered = False
            try:
                backups = sorted(
                    [f for f in os.listdir(BACKUP_DIR)
                     if f.startswith("db-") and not f.startswith("db-corrupted") and f.endswith(".json")],
                    reverse=True
                )
                for bak in backups:
                    bak_path = os.path.join(BACKUP_DIR, bak)
                    try:
                        with open(bak_path, "r", encoding="utf-8") as f:
                            backup_data = json.load(f)
                        if backup_data.get("files") is not None:
                            db.update(backup_data)
                            print(f"[INFO] Recovered from backup: {bak}", file=sys.stderr)
                            recovered = True
                            break
                    except Exception:
                        continue
            except Exception:
                pass
            # ③ Only fall back to empty data if no valid backup found
            if not recovered:
                print("[WARN] No valid backup found, starting with empty data", file=sys.stderr)
                init_default_data()
            save_db()
    else:
        init_default_data()
        save_db()
    # 归一化历史脏数据（字符串数字 → int），修好即落盘，避免每次启动重复修
    try:
        fixed = normalize_db_types()
        if fixed:
            print(f"[INFO] Normalized {fixed} numeric field(s) from legacy data", file=sys.stderr)
            save_db()
    except Exception as ne:
        print(f"[ERROR] normalize_db_types failed: {ne}", file=sys.stderr)

def save_db():
    """Safe write: try os.replace → remove+rename → copy+delete fallback.
    - DB_LOCK 全程保护：避免并发请求互踩 .tmp 文件
    - json.dump 失败（并发修改字典导致 RuntimeError）自动重试最多 3 次
    - 彻底失败返回 False（调用方应回 500，杜绝"显示成功实际没保存"）"""
    global db
    with DB_LOCK:
        tmp = DB_FILE + ".tmp"
        saved = False
        for attempt in range(3):
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    import copy
                    # 深拷贝快照隔离：dump 期间其他线程对 db 的修改不会污染本次序列化
                    json.dump(copy.deepcopy(db), f, ensure_ascii=False, indent=2)
                # On Windows, os.replace can fail with ERROR_NOT_SAME_DEVICE (17)
                # even when paths are on the same drive. Try fallbacks.
                try:
                    os.replace(tmp, DB_FILE)
                    saved = True
                except OSError:
                    pass
                if not saved:
                    try:
                        if os.path.exists(DB_FILE):
                            os.remove(DB_FILE)
                        os.rename(tmp, DB_FILE)
                        saved = True
                    except OSError:
                        pass
                if not saved:
                    import shutil
                    shutil.copy2(tmp, DB_FILE)
                    os.unlink(tmp)
                    saved = True
                break
            except Exception as e:
                if attempt < 2:
                    import time
                    time.sleep(0.02)  # 等待并发修改完成再重试
                    continue
                # 彻底失败：记录日志 + 返回 False
                try:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                except Exception:
                    pass
                print(f"[save_db] FAILED (after 3 attempts): {e}", file=sys.stderr)
                return False
        # Quick verification
        try:
            with open(DB_FILE, "r", encoding="utf-8") as vf:
                v = json.load(vf)
            print(f"[save_db] OK — files:{len(v.get('files',[]))}  file_tags:{len(v.get('file_tags',[]))}  tags:{len(v.get('tags',[]))}", file=sys.stderr)
        except Exception:
            print("[save_db] WARNING: wrote but could not verify", file=sys.stderr)
        return True

def backup_db():
    if not os.path.exists(DB_FILE):
        return
    with DB_LOCK:
        ts = datetime.now().isoformat().replace(":", "-").replace(".", "-")
        bak = os.path.join(BACKUP_DIR, f"db-{ts}.json")
        try:
            with open(DB_FILE, "rb") as src:
                with open(bak, "wb") as dst:
                    dst.write(src.read())
        except Exception as e:
            print(f"备份失败: {e}", file=sys.stderr)
        # 清理旧备份
        try:
            files = sorted(os.listdir(BACKUP_DIR), reverse=True)
            for f in files[10:]:
                try:
                    os.unlink(os.path.join(BACKUP_DIR, f))
                except Exception:
                    pass
        except Exception:
            pass

# ==================== 扫描过滤 ====================
scan_filters = {"enabled": True, "extensions": [], "include_folders": True}

def load_scan_filters():
    global scan_filters
    if os.path.exists(FILTER_FILE):
        try:
            with open(FILTER_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            scan_filters["enabled"] = data.get("enabled", True)
            scan_filters["extensions"] = [e.lower() for e in data.get("extensions", [])]
            scan_filters["include_folders"] = data.get("include_folders", True)
        except Exception as e:
            print(f"加载过滤配置失败: {e}", file=sys.stderr)

def save_scan_filters():
    with open(FILTER_FILE, "w", encoding="utf-8") as f:
        json.dump(scan_filters, f, ensure_ascii=False, indent=2)

# --- content_links ---
content_links = {"links": [], "updated_at": ""}

def load_content_links():
    global content_links
    if os.path.exists(CL_FILE):
        try:
            with open(CL_FILE, "r", encoding="utf-8") as f:
                content_links = json.load(f)
        except Exception as e:
            print(f"加载 content_links 失败: {e}", file=sys.stderr)
            content_links = {"links": [], "updated_at": ""}

def save_content_links():
    content_links["updated_at"] = datetime.now().isoformat()
    with open(CL_FILE, "w", encoding="utf-8") as f:
        json.dump(content_links, f, ensure_ascii=False, indent=2)

def is_extension_allowed(file_name):
    if not scan_filters["enabled"] or len(scan_filters["extensions"]) == 0:
        return True
    ext = os.path.splitext(file_name)[1].lower().lstrip(".")
    return ext in scan_filters["extensions"]

def init_default_data():
    db["dimensions"] = [
        {"id": 1, "name": "状态", "sort_order": 0},
        {"id": 2, "name": "知识领域", "sort_order": 1},
        {"id": 3, "name": "供应商", "sort_order": 2},
        {"id": 4, "name": "文件类型", "sort_order": 3},
        {"id": 5, "name": "项目", "sort_order": 4},
    ]
    db["_dimId"] = 6
    default_tags = {
        1: ["待阅读", "已完成", "待确认", "进行中", "归档"],
        2: ["PSU", "IDC", "VRM", "DC-DC", "散热", "EMC"],
        3: ["英飞凌", "TI", "MPS", "ADI", "NXP"],
        4: ["技术手册", "产品规格书", "应用笔记", "学术论文", "市场推广", "内部报告"],
        5: ["STS", "XX项目"],
    }
    colors = ["#4A90D9", "#50C878", "#FF6B6B", "#FFA500", "#9B59B6", "#00CED1", "#FF69B4", "#708090"]
    tid = 1
    for dim_id, names in default_tags.items():
        for i, name in enumerate(names):
            db["tags"].append({"id": tid, "dimension_id": dim_id, "name": name, "color": colors[i % len(colors)]})
            tid += 1
    db["_tagId"] = tid
    db["scan_config"].append({"id": 1, "path": "", "enabled": 1})  # 默认扫描路径留空，由用户首次启动后自行配置
    db["_configId"] = 2

def next_id(type_key):
    key = f"_{type_key}Id"
    val = db[key]
    db[key] = val + 1
    return val

def find_by_id(arr, item_id):
    for item in arr:
        if item["id"] == int(item_id):
            return item
    return None

def to_int(val, default=0):
    """把任意来源（字符串/浮点/None）的值安全转成 int。

    历史数据、CSV 导入、前端表单都可能把数字传成字符串（如 '2'），
    直接参与 sorted() 会抛 TypeError（'<' not supported between str and int）。
    所有排序字段与数值字段写入前后都必须过这个函数。
    """
    if isinstance(val, bool):
        return int(val)
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        return int(val)
    if isinstance(val, str):
        s = val.strip()
        try:
            return int(s)
        except (TypeError, ValueError):
            try:
                return int(float(s))
            except (TypeError, ValueError):
                return default
    return default

def dim_sort_key(d):
    """维度排序键：始终返回 (int, str)，任何脏数据都不会让 sorted 崩。"""
    return (to_int(d.get("sort_order", 0)), str(d.get("name", "")))

def normalize_db_types():
    """加载后归一化关键数值字段，把历史脏数据（字符串数字）转成真 int。

    返回被修正的字段数量，供启动日志与健康检查使用。
    """
    fixed = 0
    for d in db.get("dimensions", []) or []:
        raw = d.get("sort_order", 0)
        if not isinstance(raw, int) or isinstance(raw, bool):
            d["sort_order"] = to_int(raw)
            fixed += 1
        raw_id = d.get("id")
        if not isinstance(raw_id, int) or isinstance(raw_id, bool):
            d["id"] = to_int(raw_id)
            fixed += 1
    for t in db.get("tags", []) or []:
        for key in ("id", "dimension_id"):
            raw = t.get(key)
            if raw is not None and (not isinstance(raw, int) or isinstance(raw, bool)):
                t[key] = to_int(raw)
                fixed += 1
    for g in db.get("tag_groups", []) or []:
        raw = g.get("id")
        if raw is not None and (not isinstance(raw, int) or isinstance(raw, bool)):
            g["id"] = to_int(raw)
            fixed += 1
    # scan_config: 确保 type 字段存在（向后兼容）
    for c in db.get("scan_config", []) or []:
        if "type" not in c:
            c["type"] = "local"
            fixed += 1
        if c.get("type") == "feishu" and "feishu_folder_token" not in c:
            c["feishu_folder_token"] = ""
            fixed += 1
    # files: 确保来源和云文档字段存在
    for f in db.get("files", []) or []:
        for key in ("source", "url", "cloud_id", "cloud_type", "folder_path", "owner_id"):
            if key not in f:
                f[key] = "local" if key == "source" else ""
                fixed += 1
    return fixed

# ==================== CSV 解析 ====================
def parse_csv_line(line):
    result = []
    current = ""
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if in_quotes:
            if ch == '"' and i + 1 < len(line) and line[i + 1] == '"':
                current += '"'
                i += 1
            elif ch == '"':
                in_quotes = False
            else:
                current += ch
        else:
            if ch == '"':
                in_quotes = True
            elif ch == ',':
                result.append(current)
                current = ""
            else:
                current += ch
        i += 1
    result.append(current)
    return result

# ==================== 表达式解析 ====================
def tokenize_expression(expr):
    tokens = []
    pattern = re.compile(r'\s*(AND(?=\s|$)|OR(?=\s|$)|NOT(?=\s|$)|\\(|\\)|[^\s()]+)\s*')
    for m in pattern.finditer(expr):
        v = m.group(1)
        if v.upper() == "AND":
            tokens.append({"type": "AND"})
        elif v.upper() == "OR":
            tokens.append({"type": "OR"})
        elif v.upper() == "NOT":
            tokens.append({"type": "NOT"})
        elif v == "(":
            tokens.append({"type": "LPAREN"})
        elif v == ")":
            tokens.append({"type": "RPAREN"})
        else:
            tokens.append({"type": "TAG", "value": v})
    return tokens

def parse_expression(tokens):
    """递归下降解析器，返回 AST 节点或 None"""
    pos = [0]

    def peek():
        if pos[0] < len(tokens):
            return tokens[pos[0]]
        return None

    def consume():
        t = tokens[pos[0]]
        pos[0] += 1
        return t

    def parse_expr():
        node = parse_term()
        while peek() and peek()["type"] == "OR":
            consume()
            node = {"type": "OR", "left": node, "right": parse_term()}
        return node

    def parse_term():
        node = parse_factor()
        while peek() and peek()["type"] == "AND":
            consume()
            node = {"type": "AND", "left": node, "right": parse_factor()}
        return node

    def parse_factor():
        if peek() and peek()["type"] == "NOT":
            consume()
            return {"type": "NOT", "child": parse_factor()}
        if peek() and peek()["type"] == "LPAREN":
            consume()
            node = parse_expr()
            if peek() and peek()["type"] == "RPAREN":
                consume()
            return node
        tok = consume()
        return {"type": "TAG", "value": tok["value"]}

    ast = parse_expr()
    if pos[0] < len(tokens):
        return None  # 语法错误
    return ast

def evaluate_expression(ast, tag_names):
    if ast["type"] == "TAG":
        return ast["value"] in tag_names
    elif ast["type"] == "AND":
        return evaluate_expression(ast["left"], tag_names) and evaluate_expression(ast["right"], tag_names)
    elif ast["type"] == "OR":
        return evaluate_expression(ast["left"], tag_names) or evaluate_expression(ast["right"], tag_names)
    elif ast["type"] == "NOT":
        return not evaluate_expression(ast["child"], tag_names)
    return False

def validate_expression(expr_str, all_tag_names):
    tokens = tokenize_expression(expr_str)
    if len(tokens) == 0:
        return {"ok": False, "error": "表达式为空"}
    for t in tokens:
        if t["type"] == "TAG" and t["value"] not in all_tag_names:
            return {"ok": False, "error": f"标签「{t['value']}」不存在，请检查拼写"}
    ast = parse_expression(tokens)
    if ast is None:
        return {"ok": False, "error": "表达式语法错误，请检查括号是否匹配"}
    return {"ok": True}

# ==================== 扫描 ====================
scan_tasks = {}
scan_lock = threading.Lock()

# ==================== 飞书云文档扫描 ====================

class FeishuAuthError(Exception):
    """lark-cli 认证缺失或过期"""
    pass

class FeishuNetworkError(Exception):
    """lark-cli 网络问题（超时/连接失败），与认证无关"""
    pass

def _classify_lark_cli_error(stdout_text, stderr_text):
    """将 lark-cli 的错误输出分类为认证/网络/其他。

    同时检查 stderr（进程非零退出）和 stdout JSON（ok=false，lark-cli 部分错误
    以 exit 0 + JSON 形式输出到 stdout，如网络超时）。返回 (异常类, 错误信息)。
    用正则词边界匹配关键词，避免 folder_token/page_token 中的 token 被误判为认证错误。
    """
    import re
    text = ((stdout_text or "") + " " + (stderr_text or "")).lower()
    # 网络特征词：TLS/握手/超时/连接失败/网络错误
    net_kw = [r"\btls\b", r"\bhandshake\b", r"\btimeout", r"\btimed out", r"\bconnection\b",
              r"\bnetwork\b", r"\bunreachable\b", r"econnreset", r"dial tcp", r"connect: connection"]
    # 认证特征词：仅在明确认证语义时匹配（token 需限定搭配，避免 folder_token/unexpected token 误判）
    auth_kw = [r"\bauth\b", r"\blogin\b", r"unauthorized", r"access_denied",
               r"not authenticated", r"expired", r"(access|auth|refresh|bearer)\s+token",
               r"token\s+(expired|invalid|revoked)", r"invalid token"]
    if any(re.search(k, text) for k in net_kw) and not re.search(r"(auth|access) token", text):
        return FeishuNetworkError, (stdout_text or stderr_text or "网络错误")[:300]
    if any(re.search(k, text) for k in auth_kw):
        return FeishuAuthError, (stdout_text or stderr_text or "认证错误")[:300]
    return RuntimeError, (stdout_text or stderr_text or "lark-cli 错误")[:300]

def _lark_cli_exec(cmd, timeout=30):
    """执行 lark-cli 命令，返回解析后的 JSON dict。
    cmd 可以是字符串（shell=True）或列表（shell=False，避免转义问题）。
    异常: FeishuAuthError (认证问题), FeishuNetworkError (网络问题), RuntimeError (其他错误)
    """
    env = os.environ.copy()
    env["LARKSUITE_CLI_NO_UPDATE_NOTIFIER"] = "1"
    env["LARKSUITE_CLI_NO_SKILLS_NOTIFIER"] = "1"
    if isinstance(cmd, list):
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', timeout=timeout, env=env)
    else:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', timeout=timeout, env=env)
    if result.returncode != 0:
        err_cls, msg = _classify_lark_cli_error(result.stdout, result.stderr)
        raise err_cls(msg)
    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"lark-cli output parse error: {e}")
    # lark-cli 部分错误以 exit 0 + JSON 输出（如网络超时 ok=false）
    if isinstance(parsed, dict) and parsed.get("ok") is False:
        err_obj = parsed.get("error") or {}
        err_text = err_obj.get("message", "") if isinstance(err_obj, dict) else str(err_obj)
        err_cls, msg = _classify_lark_cli_error(err_text, result.stderr)
        raise err_cls(msg or parsed.get("error"))
    return parsed

def _feishu_time_to_iso(ts_str):
    """飞书时间戳（毫秒字符串）转 ISO UTC 字符串"""
    if not ts_str:
        return ""
    try:
        return datetime.fromtimestamp(int(ts_str) / 1000, tz=timezone.utc).isoformat()
    except (ValueError, TypeError):
        return ""

def _lark_cli_drive_list(folder_token, page_token=""):
    """调用 lark-cli drive files list，返回 data dict。"""
    params = {"folder_token": folder_token or "", "page_size": 200}
    if page_token:
        params["page_token"] = page_token
    params_json = json.dumps(params)
    # Windows cmd.exe: 双引号包裹 JSON，内部双引号用 \" 转义
    escaped = params_json.replace('"', '\\"')
    cmd = f'lark-cli drive files list --params "{escaped}" --format json --as user'
    output = _lark_cli_exec(cmd, timeout=30)
    return output.get("data", output) if isinstance(output, dict) else {}

def collect_feishu_files(root_folder_token, task):
    """递归扫描飞书云盘，返回文件列表。
    DFS 遍历，folder 类型递归，生成 folder_path 面包屑。
    """
    import time
    results = []
    queue = [(root_folder_token or "", "飞书云盘")]
    visited_pages = set()
    while queue:
        folder_token, folder_display = queue.pop(0)
        page_token = ""
        while True:
            page_key = (folder_token, page_token or "first")
            if page_key in visited_pages:
                break
            try:
                data = _lark_cli_drive_list(folder_token, page_token)
            except FeishuAuthError:
                raise
            except Exception as e:
                print(f"[feishu-scan] Error listing '{folder_display}': {e}", file=sys.stderr)
                break
            visited_pages.add(page_key)
            files = data.get("files", [])
            for f in files:
                ftype = f.get("type", "")
                ftoken = f.get("token", "")
                fname = f.get("name", "")
                pseudo_path = f"feishu://drive/{ftoken}"
                results.append({
                    "name": fname,
                    "file_path": pseudo_path,
                    "url": f.get("url", ""),
                    "cloud_id": ftoken,
                    "cloud_type": ftype,
                    "modified_time": _feishu_time_to_iso(f.get("modified_time")),
                    "folder_path": folder_display,
                    "is_folder": ftype == "folder",
                    "owner_id": f.get("owner_id", ""),
                })
                if task:
                    task["processed"] = task.get("processed", 0) + 1
                    task["total"] = task.get("total", 0) + 1
                if ftype == "folder":
                    queue.append((ftoken, f"{folder_display}/{fname}"))
            if data.get("has_more") is not True:
                break
            next_token = data.get("next_page_token", "")
            if not next_token:
                break
            page_token = next_token
        time.sleep(0.1)
    return results

def _lark_cli_auth_status():
    """检查 lark-cli 是否已认证 drive 域。
    兼容新旧两种 lark-cli 版本的输出格式：
    - 新版 (workbuddy): identities.user.userName 嵌套结构
    - 旧版 (npm global): userName 顶层平铺
    两个版本默认都输出 JSON，不需要 --json 标志（旧版不支持）。
    """
    try:
        output = _lark_cli_exec("lark-cli auth status --verify", timeout=10)
        verified = output.get("verified", False)
        identities = output.get("identities", {})
        user = identities.get("user", {})
        user_name = user.get("userName") or output.get("userName", "")
        token_status = user.get("tokenStatus") or output.get("tokenStatus", "")
        user_status = user.get("status") or token_status or ""
        return {
            "authenticated": bool(verified and user_status in ("active", "needs_refresh", "ready", "valid")),
            "user_name": user_name,
            "identity": output.get("identity", ""),
            "error": "" if verified else "用户身份未验证或已过期",
        }
    except FileNotFoundError:
        return {"authenticated": False, "error": "lark-cli 未安装或不在 PATH 中"}
    except subprocess.TimeoutExpired:
        return {"authenticated": False, "error": "lark-cli 命令超时（网络问题，请重试）"}
    except FeishuNetworkError as e:
        return {"authenticated": False, "error": f"网络异常（非认证问题）: {e}。请检查网络后重试"}
    except Exception as e:
        return {"authenticated": False, "error": str(e)[:200]}

# 一键授权设备码暂存（device_code 有效 600 秒，用后即清；单用户本地工具，全局一个即可）
_feishu_pending_code = None

def _feishu_auth_login_start():
    """发起飞书设备码授权，返回 (verification_url, expires_in) 或抛异常。"""
    global _feishu_pending_code
    # --no-wait --json：发起授权并立即返回，不等用户完成
    output = _lark_cli_exec(
        "lark-cli auth login --domain drive --as user --no-wait --json", timeout=30)
    device_code = output.get("device_code", "")
    verification_url = output.get("verification_url", "")
    expires_in = output.get("expires_in", 600)
    if not device_code or not verification_url:
        raise RuntimeError("lark-cli 未返回有效的授权链接")
    _feishu_pending_code = device_code
    return verification_url, int(expires_in)

def _feishu_auth_login_complete():
    """用暂存的 device_code 完成授权。成功返回 True，失败抛异常。"""
    global _feishu_pending_code
    if not _feishu_pending_code:
        raise RuntimeError("没有进行中的授权请求，请先点击「一键重新授权」")
    code = _feishu_pending_code
    try:
        _lark_cli_exec(f'lark-cli auth login --device-code "{code}"', timeout=30)
        _feishu_pending_code = None
        return True
    except Exception:
        # 失败保留 device_code 供重试（未过期前仍有效）
        raise

def collect_files(root_dir):
    results = []
    stack = [root_dir]
    while stack:
        current = stack.pop()
        try:
            entries = os.scandir(current)
        except OSError:
            continue
        for entry in entries:
            full = os.path.join(current, entry.name)
            try:
                if entry.is_dir():
                    stack.append(full)
                    if scan_filters["enabled"] and scan_filters["include_folders"]:
                        root_name = os.path.basename(root_dir)
                        if entry.name != root_name:
                            st = os.stat(full)
                            results.append({
                                "name": entry.name, "path": full,
                                "size": 0, "mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                                "is_folder": True
                            })
                elif entry.is_file():
                    if not is_extension_allowed(entry.name):
                        continue
                    st = os.stat(full)
                    results.append({
                        "name": entry.name, "path": full,
                        "size": st.st_size, "mtime": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
                    })
            except OSError:
                pass
    return results

def run_scan(task_id, configs):
    try:
        with scan_lock:
            task = scan_tasks.get(task_id)
            if not task:
                return
            task["status"] = "scanning"

        # 按类型分离配置
        local_configs = [c for c in configs if c.get("type", "local") == "local"]
        feishu_configs = [c for c in configs if c.get("type", "local") == "feishu"]

        # --- Phase 1: 预计数（仅本地，飞书无法预知总数）---
        total_files = 0
        for c in local_configs:
            if not os.path.exists(c["path"]):
                continue
            try:
                total_files += len(collect_files(c["path"]))
            except Exception:
                continue
        task["total"] = total_files
        task["processed"] = 0
        task["message"] = ""
        now = datetime.now(timezone.utc).isoformat()
        added = 0
        new_files = []

        # --- Phase 2a: 本地文件扫描（现有逻辑，补 source 字段）---
        for c in local_configs:
            if not os.path.exists(c["path"]):
                continue
            try:
                files = collect_files(c["path"])
            except Exception:
                continue
            for i, f in enumerate(files):
                existing = next((f2 for f2 in db["files"] if f2["file_path"] == f["path"]), None)
                if existing:
                    existing["file_size"] = f["size"]
                    existing["modified_time"] = f["mtime"]
                    existing["status"] = 1
                else:
                    db["files"].append({
                        "id": next_id("file"),
                        "file_name": f["name"],
                        "file_path": f["path"],
                        "file_size": f["size"],
                        "modified_time": f["mtime"],
                        "status": 1,
                        "note": "",
                        "is_folder": f.get("is_folder", False),
                        "created_at": now,
                        "updated_at": now,
                        "source": "local",
                        "url": "",
                        "cloud_id": "",
                        "cloud_type": "",
                        "folder_path": "",
                        "owner_id": "",
                    })
                    added += 1
                    new_files.append({"name": f["name"], "path": f["path"]})
                task["processed"] = i + 1

        # --- Phase 2b: 飞书云盘扫描 ---
        seen_feishu_tokens = set()
        if feishu_configs:
            task["message"] = "正在扫描飞书云盘..."
            for c in feishu_configs:
                folder_token = c.get("feishu_folder_token", "")
                try:
                    feishu_files = collect_feishu_files(folder_token, task)
                except FeishuAuthError as e:
                    save_db()
                    task["status"] = "error"
                    task["error"] = f"飞书授权失败: {e}。请运行 lark-cli auth login --domain drive --as user 重新授权"
                    return
                except FeishuNetworkError as e:
                    save_db()
                    task["status"] = "error"
                    task["error"] = f"飞书扫描网络异常（非认证问题）: {e}。请检查网络后重试"
                    return
                except Exception as e:
                    task["message"] = f"飞书扫描部分失败: {e}"
                    print(f"[feishu-scan] error: {e}", file=sys.stderr)
                    continue
                for ff in feishu_files:
                    seen_feishu_tokens.add(ff["cloud_id"])
                    existing = next((f2 for f2 in db["files"]
                                     if f2.get("cloud_id") == ff["cloud_id"]), None)
                    if existing:
                        existing["file_name"] = ff["name"]
                        existing["file_path"] = ff["file_path"]
                        existing["url"] = ff["url"]
                        existing["cloud_type"] = ff["cloud_type"]
                        existing["folder_path"] = ff["folder_path"]
                        existing["modified_time"] = ff["modified_time"]
                        existing["owner_id"] = ff.get("owner_id", "")
                        existing["status"] = 1
                    else:
                        db["files"].append({
                            "id": next_id("file"),
                            "file_name": ff["name"],
                            "file_path": ff["file_path"],
                            "file_size": 0,
                            "modified_time": ff["modified_time"],
                            "status": 1,
                            "note": "",
                            "is_folder": ff.get("is_folder", False),
                            "created_at": now,
                            "updated_at": now,
                            "source": "feishu",
                            "url": ff["url"],
                            "cloud_id": ff["cloud_id"],
                            "cloud_type": ff["cloud_type"],
                            "folder_path": ff["folder_path"],
                            "owner_id": ff.get("owner_id", ""),
                        })
                        added += 1
                        new_files.append({"name": ff["name"], "path": ff["file_path"]})
            task["message"] = ""

        # --- Phase 3: 标记移除 ---
        removed = 0
        for f in db["files"]:
            if f["status"] != 1:
                continue
            # 铁律：飞书文档永远不走 os.path.exists（伪路径必然返回 False）
            if f.get("source") == "feishu":
                if feishu_configs and f.get("cloud_id") and f["cloud_id"] not in seen_feishu_tokens:
                    f["status"] = 0
                    removed += 1
                continue
            # 本地文件检查
            if not os.path.exists(f["file_path"]):
                f["status"] = 0
                removed += 1
                continue
            if not f.get("is_folder") and not is_extension_allowed(f["file_name"]):
                f["status"] = 0
                removed += 1

        # --- Phase 4: 保存与记录 ---
        db["scan_history"].append({
            "id": len(db["scan_history"]) + 1,
            "scan_time": now,
            "file_count": len([f for f in db["files"] if f["status"] == 1]),
            "added_count": added,
            "removed_count": removed,
        })
        save_db()
        task["status"] = "done"
        task["added"] = added
        task["removed"] = removed
        task["new_files"] = new_files
    except Exception as e:
        task["status"] = "error"
        task["error"] = str(e)

# ==================== HTTP 请求处理 ====================
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".csv": "text/csv; charset=utf-8",
}


class RequestHandler(http.server.BaseHTTPRequestHandler):
    """处理所有 HTTP 请求"""

    def setup(self):
        super().setup()
        # 设置请求超时（60秒），防止慢连接或挂起连接占用线程
        if hasattr(self.request, 'settimeout'):
            self.request.settimeout(60.0)

    def log_message(self, format, *args):
        # 仅记录非健康检查的请求
        if '/api/health' not in self.path:
            print(f"[{self.log_date_time_string()}] {self.address_string()} - {format % args}", file=sys.stderr)

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Connection", "close")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        pathname = parsed.path
        params = urllib.parse.parse_qs(parsed.query)

        # 静态文件
        if not pathname.startswith("/api/"):
            file_path = os.path.join(STATIC_DIR, "index.html" if pathname == "/" else pathname.lstrip("/"))
            if not os.path.exists(file_path):
                self.send_response(404)
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(b"Not Found")
                return
            ext = os.path.splitext(file_path)[1]
            content_type = MIME_TYPES.get(ext, "application/octet-stream")
            with open(file_path, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(content)
            return

        try:
            # health
            if pathname == "/api/health":
                self.send_json({"ok": True})
                return

            # version
            if pathname == "/api/version":
                self.send_json({"version": VERSION})
                return

            # highlight-state（高亮持久化：标签/扩展名/分组 高亮状态）
            if pathname == "/api/highlight-state":
                self.send_json(db.get("highlight_state", {"tag_ids": [], "exts": [], "group_ids": []}))
                return

            # changelog
            if pathname == "/api/changelog":
                self.send_json({"version": VERSION, "changelog": CHANGELOG})
                return

            # scan-config
            if pathname == "/api/scan-config":
                self.send_json(db["scan_config"])
                return

            # feishu auth status
            if pathname == "/api/feishu/auth-status":
                self.send_json(_lark_cli_auth_status())
                return

            # scan-filters
            if pathname == "/api/scan-filters":
                self.send_json(scan_filters)
                return

            # scan last-time
            if pathname == "/api/scan/last-time":
                last = db["scan_history"][-1] if db["scan_history"] else None
                self.send_json({"lastTime": last["scan_time"] if last else None})
                return

            # scan status
            if pathname.startswith("/api/scan/status/"):
                task_id = pathname.split("/")[4]
                task = scan_tasks.get(task_id)
                if not task:
                    self.send_error_json(404, "任务不存在")
                    return
                self.send_json(task)
                return

            # files list
            if pathname == "/api/files":
                self._handle_files_list(params)
                return

            # file detail
            if pathname.startswith("/api/files/") and "/tags" not in pathname:
                self._handle_file_detail(pathname)
                return

            # file tags
            if "/files/" in pathname and "/tags" in pathname:
                self._handle_file_tags(pathname)
                return

            # dimensions
            if pathname == "/api/dimensions":
                dims = sorted(db["dimensions"], key=dim_sort_key)
                self.send_json(dims)
                return

            # tags
            if pathname == "/api/tags":
                self._handle_tags_list(params)
                return

            # tags export
            if pathname == "/api/tags/export":
                self._handle_tags_export()
                return

            # tag groups
            if pathname == "/api/tag-groups":
                self._handle_groups_list()
                return

            # full database backup download
            if pathname == "/api/backup":
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition",
                    f"attachment; filename=file-tag-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "backup_info": {
                        "exported_at": datetime.now(timezone.utc).isoformat(),
                        "scan_config": db["scan_config"],
                    },
                    "db": db,
                    "content_links": content_links,
                }, ensure_ascii=False).encode("utf-8"))
                return

            # list existing backups
            if pathname == "/api/backup/list":
                backups = []
                try:
                    for f in sorted(os.listdir(BACKUP_DIR), reverse=True):
                        fp = os.path.join(BACKUP_DIR, f)
                        if f.endswith(".json"):
                            backups.append({
                                "name": f,
                                "size": os.path.getsize(fp),
                                "mtime": datetime.fromtimestamp(os.path.getmtime(fp), tz=timezone.utc).isoformat()
                            })
                except Exception:
                    pass
                self.send_json(backups)
                return

            # download a specific backup by name
            if pathname.startswith("/api/backup/"):
                bak_name = pathname[len("/api/backup/"):]
                bak_path = os.path.join(BACKUP_DIR, os.path.basename(bak_name))  # prevent path traversal
                if os.path.isfile(bak_path):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Disposition", f"attachment; filename={os.path.basename(bak_path)}")
                    self.end_headers()
                    with open(bak_path, "rb") as f:
                        self.wfile.write(f.read())
                else:
                    self.send_error_json(404, "Backup not found")
                return

            # content-links lookup
            if pathname == "/api/content-links":
                file_path = params.get("path", [None])[0]
                if file_path:
                    matched = [l for l in content_links.get("links", []) if l["path"] == file_path]
                    self.send_json(matched)
                else:
                    self.send_json(content_links.get("links", []))
                return

            # 404
            self.send_error_json(404, f"Not Found: GET {pathname}")

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_error_json(500, str(e))

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        pathname = parsed.path
        body = self._read_body()

        try:
            # highlight-state 保存（高亮持久化）
            if pathname == "/api/highlight-state":
                hs = db.setdefault("highlight_state", {"tag_ids": [], "exts": [], "group_ids": []})
                if isinstance(body.get("tag_ids"), list):
                    hs["tag_ids"] = [int(x) for x in body["tag_ids"]]
                if isinstance(body.get("exts"), list):
                    hs["exts"] = [str(x) for x in body["exts"]]
                if isinstance(body.get("group_ids"), list):
                    hs["group_ids"] = [int(x) for x in body["group_ids"]]
                if not save_db():
                    self.send_error_json(500, "保存失败：高亮状态未写入磁盘")
                    return
                self.send_json({"ok": True})
                return

            # 飞书一键授权：发起（返回验证 URL）
            if pathname == "/api/feishu/auth-login":
                try:
                    url, expires_in = _feishu_auth_login_start()
                    self.send_json({"ok": True, "verification_url": url, "expires_in": expires_in})
                except FeishuAuthError as e:
                    self.send_json({"ok": False, "error": f"认证异常: {e}"})
                except FeishuNetworkError as e:
                    self.send_json({"ok": False, "error": f"网络异常（非认证问题）: {e}。请检查网络后重试"})
                except Exception as e:
                    self.send_json({"ok": False, "error": str(e)[:300]})
                return

            # 飞书一键授权：用户完成后确认
            if pathname == "/api/feishu/auth-complete":
                try:
                    _feishu_auth_login_complete()
                    self.send_json({"ok": True})
                except FeishuAuthError as e:
                    self.send_json({"ok": False, "error": f"授权未完成: {e}。请先在新打开的页面中完成授权"})
                except FeishuNetworkError as e:
                    self.send_json({"ok": False, "error": f"网络异常（非认证问题）: {e}。请检查网络后重试"})
                except Exception as e:
                    self.send_json({"ok": False, "error": str(e)[:300]})
                return

            # scan start
            if pathname == "/api/scan/start":
                configs = [c for c in db["scan_config"] if c["enabled"]]
                if not configs:
                    self.send_error_json(400, "没有启用的扫描路径")
                    return
                backup_db()
                task_id = str(int(datetime.now().timestamp() * 1000))
                scan_tasks[task_id] = {"total": 0, "processed": 0, "status": "pending", "added": 0, "removed": 0}
                self.send_json({"taskId": task_id})
                threading.Thread(target=run_scan, args=(task_id, configs), daemon=True).start()
                return

            # scan-config add
            if pathname == "/api/scan-config":
                config_type = body.get("type", "local")
                p = body.get("path", "")
                if config_type == "feishu":
                    p = "飞书云盘"
                    if any(c.get("type") == "feishu" for c in db["scan_config"]):
                        self.send_error_json(400, "飞书云盘扫描配置已存在")
                        return
                else:
                    if not p:
                        self.send_error_json(400, "path required")
                        return
                    if any(c.get("path") == p and c.get("type", "local") == "local" for c in db["scan_config"]):
                        self.send_error_json(400, "路径已存在")
                        return
                cid = next_id("config")
                config = {"id": cid, "path": p, "enabled": 1, "type": config_type}
                if config_type == "feishu":
                    config["feishu_folder_token"] = body.get("feishu_folder_token", "")
                db["scan_config"].append(config)
                save_db()
                self.send_json({"id": cid})
                return

            # file open
            if pathname.startswith("/api/files/") and "/open" in pathname:
                parts = pathname.split("/")
                f = find_by_id(db["files"], parts[3])
                self._handle_file_open(f)
                return

            # file show
            if pathname.startswith("/api/files/") and "/show" in pathname:
                parts = pathname.split("/")
                f = find_by_id(db["files"], parts[3])
                self._handle_file_show(f)
                return

            # file tags add (legacy)
            if pathname == "/api/files/tags":
                self._handle_file_tags_add(body)
                return

            # file tags update (add/remove)
            if pathname == "/api/files/update-tags":
                self._handle_file_tags_update(body)
                return

            # dimensions add
            if pathname == "/api/dimensions":
                self._handle_dimension_add(body)
                return

            # tags add
            if pathname == "/api/tags":
                self._handle_tag_add(body)
                return

            # tag groups add
            if pathname == "/api/tag-groups":
                self._handle_group_add(body)
                return

            # tag groups validate
            if pathname == "/api/tag-groups/validate":
                self._handle_group_validate(body)
                return

            # tags import
            if pathname == "/api/tags/import":
                self._handle_tags_import(body)
                return

            # backup restore
            if pathname == "/api/backup/restore":
                import json as _json
                data = body.get("data") or body.get("db")
                if not data:
                    self.send_error_json(400, "Missing backup data")
                    return
                # Backup current data before restoring
                backup_db()
                try:
                    if isinstance(data, str):
                        data = _json.loads(data)
                    # Restore from backup structure
                    new_db = data.get("db") or data
                    db.clear()
                    db.update(new_db)
                    # Restore content_links if present
                    if data.get("content_links"):
                        content_links.clear()
                        content_links.update(data["content_links"])
                        save_content_links()
                    save_db()
                    self.send_json({
                        "ok": True,
                        "files": len(db.get("files", [])),
                        "scan_configs": len(db.get("scan_config", [])),
                        "message": "Data restored. Please restart the server for full effect."
                    })
                except Exception as e:
                    self.send_error_json(500, f"Restore failed: {e}")
                return

            # content-links push
            if pathname == "/api/content-links":
                links = body.get("links", [])
                content_links["links"] = links
                save_content_links()
                self.send_json({"ok": True, "count": len(links)})
                return

            self.send_error_json(404, f"Not Found: POST {pathname}")

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_error_json(500, str(e))

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        pathname = parsed.path
        body = self._read_body()

        try:
            # scan-config toggle
            if pathname.startswith("/api/scan-config/"):
                cid = pathname.split("/")[3]
                c = find_by_id(db["scan_config"], cid)
                if c:
                    c["enabled"] = 1 if body.get("enabled") else 0
                    save_db()
                self.send_json({"ok": True})
                return

            # scan-filters update
            if pathname == "/api/scan-filters":
                if "enabled" in body:
                    scan_filters["enabled"] = body["enabled"]
                if "extensions" in body:
                    scan_filters["extensions"] = [e.lower().lstrip(".") for e in body["extensions"]]
                if "include_folders" in body:
                    scan_filters["include_folders"] = body["include_folders"]
                save_scan_filters()
                self.send_json(scan_filters)
                return

            # file note update
            if pathname.startswith("/api/files/") and "/tags" not in pathname:
                cid = pathname.split("/")[3]
                f = find_by_id(db["files"], cid)
                if f and "note" in body:
                    f["note"] = body["note"]
                    f["updated_at"] = datetime.now(timezone.utc).isoformat()
                    save_db()
                self.send_json({"ok": True})
                return

            # dimension update
            if pathname.startswith("/api/dimensions/"):
                d = find_by_id(db["dimensions"], pathname.split("/")[3])
                if d:
                    d["name"] = body.get("name", d["name"])
                    d["sort_order"] = to_int(body.get("sort_order", d["sort_order"]))
                    save_db()
                self.send_json({"ok": True})
                return

            # tag update
            if pathname.startswith("/api/tags/") and "export" not in pathname and "import" not in pathname:
                t = find_by_id(db["tags"], pathname.split("/")[3])
                if t:
                    t["name"] = body.get("name", t["name"])
                    t["color"] = body.get("color", t["color"])
                    save_db()
                self.send_json({"ok": True})
                return

            # group update
            if pathname.startswith("/api/tag-groups/") and "/tags" in pathname:
                gid = int(pathname.split("/")[3])
                db["group_tags"] = [gt for gt in db["group_tags"] if gt["group_id"] != gid]
                for tid in body.get("tag_ids", []):
                    db["group_tags"].append({"group_id": gid, "tag_id": int(tid)})
                save_db()
                self.send_json({"ok": True})
                return

            if pathname.startswith("/api/tag-groups/"):
                g = find_by_id(db["tag_groups"], pathname.split("/")[3])
                if g:
                    g["name"] = body.get("name", g.get("name", ""))
                    if "expression" in body:
                        g["expression"] = body["expression"]
                    if "logic" in body:
                        g["logic"] = body["logic"]
                    save_db()
                self.send_json({"ok": True})
                return

            self.send_error_json(404, f"Not Found: PUT {pathname}")

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_error_json(500, str(e))

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        pathname = parsed.path

        try:
            # scan-config delete
            if pathname.startswith("/api/scan-config/"):
                cid = int(pathname.split("/")[3])
                db["scan_config"] = [c for c in db["scan_config"] if c["id"] != cid]
                save_db()
                self.send_json({"ok": True})
                return

            # file delete
            if pathname.startswith("/api/files/") and "/tags/" in pathname:
                parts = pathname.split("/")
                fid = int(parts[3])
                tid = int(parts[5])
                db["file_tags"] = [ft for ft in db["file_tags"] if not (ft["file_id"] == fid and ft["tag_id"] == tid)]
                save_db()
                self.send_json({"ok": True})
                return

            if pathname.startswith("/api/files/"):
                cid = int(pathname.split("/")[3])
                db["files"] = [f for f in db["files"] if f["id"] != cid]
                db["file_tags"] = [ft for ft in db["file_tags"] if ft["file_id"] != cid]
                save_db()
                self.send_json({"ok": True})
                return

            # dimension delete
            if pathname.startswith("/api/dimensions/"):
                cid = int(pathname.split("/")[3])
                db["dimensions"] = [d for d in db["dimensions"] if d["id"] != cid]
                db["tags"] = [t for t in db["tags"] if t["dimension_id"] != cid]
                save_db()
                self.send_json({"ok": True})
                return

            # tag delete
            if pathname.startswith("/api/tags/"):
                cid = int(pathname.split("/")[3])
                db["tags"] = [t for t in db["tags"] if t["id"] != cid]
                db["file_tags"] = [ft for ft in db["file_tags"] if ft["tag_id"] != cid]
                db["group_tags"] = [gt for gt in db["group_tags"] if gt["tag_id"] != cid]
                save_db()
                self.send_json({"ok": True})
                return

            # group delete
            if pathname.startswith("/api/tag-groups/"):
                cid = int(pathname.split("/")[3])
                db["tag_groups"] = [g for g in db["tag_groups"] if g["id"] != cid]
                db["group_tags"] = [gt for gt in db["group_tags"] if gt["group_id"] != cid]
                save_db()
                self.send_json({"ok": True})
                return

            self.send_error_json(404, f"Not Found: DELETE {pathname}")

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.send_error_json(500, str(e))

    # ---- 辅助方法 ----

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        if self.headers.get("Content-Type", "").startswith("application/json"):
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {}
        return raw if isinstance(raw, dict) else {}

    def _handle_files_list(self, params):
        keyword = params.get("keyword", [""])[0]
        tag_ids = params.get("tag_ids", [""])[0]
        group_id = params.get("group_id", [""])[0]
        ext_filter = params.get("ext", [""])[0]
        path_prefix = params.get("path_prefix", [""])[0]
        source_filter = params.get("source", [""])[0]
        page = int(params.get("page", ["1"])[0])
        page_size = int(params.get("page_size", ["50"])[0])
        sort = params.get("sort", ["modified_time"])[0]
        order = params.get("order", ["desc"])[0]

        files = [f for f in db["files"] if f["status"] == 1]

        if source_filter:
            files = [f for f in files if f.get("source", "local") == source_filter]

        if keyword:
            tokens = [t for t in keyword.lower().split() if t]
            if tokens:
                files = [f for f in files if all(t in f["file_name"].lower() or t in f["file_path"].lower() for t in tokens)]

        if ext_filter:
            exts = [e.lower().lstrip(".") for e in ext_filter.split(",")]
            files = [f for f in files if ("." in f["file_name"] and f["file_name"].rsplit(".", 1)[-1].lower() in exts)]

        if path_prefix:
            # 支持逗号分隔多个路径前缀（OR 逻辑）
            prefixes = [p.strip().rstrip("/\\") for p in path_prefix.split(",") if p.strip()]
            if prefixes:
                files = [f for f in files if any(
                    f["file_path"].replace("\\", "/").lower().startswith(p.replace("\\", "/").lower())
                    for p in prefixes
                )]

        if tag_ids:
            ids = [int(x) for x in tag_ids.split(",")]
            # 按维度分组：同组 OR，跨组 AND
            dim_groups = {}  # dim_id → [tag_id, ...]
            for tid in ids:
                tag = find_by_id(db["tags"], tid)
                if tag:
                    dim_groups.setdefault(tag["dimension_id"], []).append(tid)
            if dim_groups:
                def matches_cross_dim(f):
                    f_tag_ids = {ft["tag_id"] for ft in db["file_tags"] if ft["file_id"] == f["id"]}
                    for dim_id, tids in dim_groups.items():
                        if not f_tag_ids.intersection(tids):
                            return False  # 该维度一个都没匹配 → AND 失败
                    return True  # 所有维度都有匹配
                files = [f for f in files if matches_cross_dim(f)]

        if group_id:
            gid = int(group_id)
            group = next((g for g in db["tag_groups"] if g["id"] == gid), None)
            if group and group.get("expression"):
                all_tag_names = {t["name"] for t in db["tags"]}
                val = validate_expression(group["expression"], all_tag_names)
                if val["ok"]:
                    tokens = tokenize_expression(group["expression"])
                    ast = parse_expression(tokens)
                    def matches_expr(f):
                        f_tags = set()
                        for ft in db["file_tags"]:
                            if ft["file_id"] == f["id"]:
                                t = find_by_id(db["tags"], ft["tag_id"])
                                if t:
                                    f_tags.add(t["name"])
                        return evaluate_expression(ast, f_tags)
                    files = [f for f in files if matches_expr(f)]
            elif group:
                gtids = [gt["tag_id"] for gt in db["group_tags"] if gt["group_id"] == gid]
                if group.get("logic") == "and":
                    files = [f for f in files if len(gtids) == 0 or all(
                        any(ft["file_id"] == f["id"] and ft["tag_id"] == tid for ft in db["file_tags"])
                        for tid in gtids
                    )]
                else:
                    files = [f for f in files if any(
                        any(ft["file_id"] == f["id"] and ft["tag_id"] == tid for ft in db["file_tags"])
                        for tid in gtids
                    )]

        total = len(files)

        key = sort if sort in ("file_name", "file_path", "file_size", "modified_time", "created_at") else "modified_time"
        reverse = order != "asc"
        # 统一排序键：同一列里混有 str / int / None 时不能直接比较，
        # 否则抛 TypeError（'<' not supported between 'str' and 'int'）。
        # 数值列强制转 int，文本列强制转小写字符串。
        numeric_keys = ("file_size",)
        if key in numeric_keys:
            files.sort(key=lambda f: to_int(f.get(key, 0)), reverse=reverse)
        else:
            files.sort(key=lambda f: str(f.get(key) or "").lower(), reverse=reverse)

        offset = (page - 1) * page_size
        # 浅拷贝：给响应附加 tags 字段但不污染 db["files"] 内存对象，
        # 否则 save_db 会把冗余快照落盘导致 db.json 持续膨胀（7MB+ 且在涨）
        page_files = [dict(f) for f in files[offset:offset + page_size]]

        for f in page_files:
            f_tags = []
            for ft in db["file_tags"]:
                if ft["file_id"] == f["id"]:
                    t = find_by_id(db["tags"], ft["tag_id"])
                    if t:
                        d = find_by_id(db["dimensions"], t["dimension_id"])
                        t_copy = dict(t)
                        t_copy["dimension_name"] = d["name"] if d else ""
                        f_tags.append(t_copy)
            f["tags"] = f_tags

        self.send_json({"total": total, "page": page, "page_size": page_size, "data": page_files})

    def _handle_file_detail(self, pathname):
        fid = pathname.split("/")[3].split("?")[0]
        f = find_by_id(db["files"], fid)
        if not f:
            self.send_error_json(404, "文件不存在")
            return
        f_out = dict(f)  # 副本：避免把响应 tags 写回 db 对象（同 list 的膨胀问题）
        f_tags = []
        for ft in db["file_tags"]:
            if ft["file_id"] == f["id"]:
                t = find_by_id(db["tags"], ft["tag_id"])
                if t:
                    d = find_by_id(db["dimensions"], t["dimension_id"])
                    t_copy = dict(t)
                    t_copy["dimension_name"] = d["name"] if d else ""
                    f_tags.append(t_copy)
        f_out["tags"] = f_tags
        self.send_json(f_out)

    def _handle_file_tags(self, pathname):
        fid = int(pathname.split("/")[3])
        tags = []
        for ft in db["file_tags"]:
            if ft["file_id"] == fid:
                t = find_by_id(db["tags"], ft["tag_id"])
                if t:
                    d = find_by_id(db["dimensions"], t["dimension_id"])
                    t_copy = dict(t)
                    t_copy["dimension_name"] = d["name"] if d else ""
                    tags.append(t_copy)
        self.send_json(tags)

    def _handle_file_open(self, f):
        if not f:
            self.send_error_json(404, "文件不存在")
            return
        if f.get("source") == "feishu":
            url = f.get("url", "")
            if url:
                self.send_json({"ok": True, "url": url})
            else:
                self.send_json({"ok": False, "error": "云文档 URL 缺失"})
            return
        fp = f["file_path"].replace("/", "\\")
        if not os.path.exists(fp):
            self.send_json({"ok": False, "error": f"文件不存在于磁盘：{fp}"})
            return
        try:
            subprocess.Popen(f'start "" "{fp}"', shell=True)
        except Exception as e:
            print(f"打开文件失败: {e}", file=sys.stderr)
        self.send_json({"ok": True})

    def _handle_file_show(self, f):
        if not f:
            self.send_error_json(404, "文件不存在")
            return
        if f.get("source") == "feishu":
            url = f.get("url", "")
            if url:
                self.send_json({"ok": True, "url": url})
            else:
                self.send_json({"ok": False, "error": "云文档不支持打开所在文件夹"})
            return
        fp = f["file_path"].replace("/", "\\")
        d = os.path.dirname(fp)
        if not os.path.exists(d):
            self.send_json({"ok": False, "error": f"文件夹不存在：{d}"})
            return
        try:
            subprocess.Popen(f'explorer /select,"{fp}"', shell=True)
        except Exception as e:
            print(f"打开文件夹失败: {e}", file=sys.stderr)
        self.send_json({"ok": True})

    def _handle_file_tags_add(self, body):
        with DB_LOCK:
            for fid in body.get("file_ids", []):
                for tid in body.get("tag_ids", []):
                    if not any(ft["file_id"] == int(fid) and ft["tag_id"] == int(tid) for ft in db["file_tags"]):
                        db["file_tags"].append({"file_id": int(fid), "tag_id": int(tid)})
        if not save_db():
            self.send_error_json(500, "保存失败：数据未写入磁盘，请检查磁盘空间或文件权限")
            return
        self.send_json({"ok": True})

    def _handle_file_tags_update(self, body):
        file_ids = [int(x) for x in body.get("file_ids", [])]
        add_ids = [int(x) for x in body.get("add_tag_ids", [])]
        remove_ids = [int(x) for x in body.get("remove_tag_ids", [])]
        with DB_LOCK:
            for fid in file_ids:
                for tid in add_ids:
                    if not any(ft["file_id"] == fid and ft["tag_id"] == tid for ft in db["file_tags"]):
                        db["file_tags"].append({"file_id": fid, "tag_id": tid})
                db["file_tags"] = [ft for ft in db["file_tags"] if not (ft["file_id"] == fid and ft["tag_id"] in remove_ids)]
        if not save_db():
            self.send_error_json(500, "保存失败：数据未写入磁盘，请检查磁盘空间或文件权限")
            return
        self.send_json({"ok": True})

    def _handle_tags_list(self, params):
        tags = []
        for t in db["tags"]:
            d = find_by_id(db["dimensions"], t["dimension_id"])
            t_copy = dict(t)
            t_copy["dimension_name"] = d["name"] if d else ""
            tags.append(t_copy)
        dim_id = params.get("dimension_id", [""])[0]
        if dim_id:
            tags = [t for t in tags if t["dimension_id"] == int(dim_id)]
        self.send_json(tags)

    def _handle_tags_export(self):
        lines = []
        lines.append("# 标签体系")
        lines.append("维度,标签,颜色")
        for d in sorted(db["dimensions"], key=dim_sort_key):
            dim_tags = [t for t in db["tags"] if t["dimension_id"] == d["id"]]
            if not dim_tags:
                lines.append(f'{d["name"]},,')
            else:
                for t in dim_tags:
                    lines.append(f'{d["name"]},{t["name"]},{t.get("color", "")}')
        lines.append("")
        lines.append("# 分组")
        lines.append("分组名,模式,逻辑,表达式,标签列表")
        for g in db["tag_groups"]:
            mode = "高级" if g.get("expression") else "简单"
            logic = "" if g.get("expression") else g.get("logic", "or")
            expr = g.get("expression", "")
            tag_names = ";".join(
                (find_by_id(db["tags"], gt["tag_id"]) or {}).get("name", "")
                for gt in db["group_tags"] if gt["group_id"] == g["id"]
            )
            tag_names = ";".join(n for n in tag_names.split(";") if n)
            lines.append(f'{g.get("name", "")},{mode},{logic},{expr},{tag_names}')
        csv = "\ufeff" + "\n".join(lines)
        data = csv.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Disposition", "attachment; filename=\"tags_export.txt\"")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle_tags_import(self, body):
        csv_text = body.get("csv", "")
        if not csv_text:
            self.send_error_json(400, "CSV 内容为空")
            return
        lines_list = csv_text.replace("\ufeff", "").split("\n")
        section = ""
        dim_created = tag_created = group_created = 0
        dim_skipped = tag_skipped = group_skipped = 0

        for raw_line in lines_list:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                if "标签体系" in line:
                    section = "tags"
                elif "分组" in line:
                    section = "groups"
                continue
            if line.startswith("维度,") or line.startswith("分组名,"):
                continue

            cols = parse_csv_line(line)
            if section == "tags" and len(cols) >= 2:
                dim_name = cols[0].strip()
                tag_name = cols[1].strip()
                color = cols[2].strip() if len(cols) > 2 else "#4A90D9"
                if not dim_name:
                    continue
                dim = next((d for d in db["dimensions"] if d["name"] == dim_name), None)
                if not dim:
                    cid = next_id("dim")
                    dim = {"id": cid, "name": dim_name, "sort_order": len(db["dimensions"])}
                    db["dimensions"].append(dim)
                    dim_created += 1
                else:
                    dim_skipped += 1
                if tag_name:
                    if not any(t["dimension_id"] == dim["id"] and t["name"] == tag_name for t in db["tags"]):
                        cid = next_id("tag")
                        db["tags"].append({"id": cid, "dimension_id": dim["id"], "name": tag_name, "color": color or "#4A90D9"})
                        tag_created += 1
                    else:
                        tag_skipped += 1
            elif section == "groups" and len(cols) >= 5:
                g_name = cols[0].strip()
                g_mode = cols[1].strip()
                g_logic = cols[2].strip()
                g_expr = cols[3].strip()
                g_tags_str = cols[4].strip()
                if not g_name:
                    continue
                if any(g.get("name", "") == g_name for g in db["tag_groups"]):
                    group_skipped += 1
                    continue
                gid = next_id("group")
                group = {"id": gid, "name": g_name, "expression": "", "logic": "or"}
                if g_mode == "高级" and g_expr:
                    group["expression"] = g_expr
                else:
                    group["logic"] = g_logic or "or"
                db["tag_groups"].append(group)
                if g_tags_str:
                    for tn in g_tags_str.split(";"):
                        t = next((t2 for t2 in db["tags"] if t2["name"] == tn.strip()), None)
                        if t:
                            db["group_tags"].append({"group_id": gid, "tag_id": t["id"]})
                group_created += 1

        save_db()
        self.send_json({
            "ok": True,
            "summary": f"维度: +{dim_created} (跳过{dim_skipped}), 标签: +{tag_created} (跳过{tag_skipped}), 分组: +{group_created} (跳过{group_skipped})"
        })

    def _handle_dimension_add(self, body):
        name = body.get("name", "")
        if any(d["name"] == name for d in db["dimensions"]):
            self.send_error_json(400, "维度已存在")
            return
        cid = next_id("dim")
        db["dimensions"].append({"id": cid, "name": name, "sort_order": int(body.get("sort_order", 0))})
        save_db()
        self.send_json({"id": cid})

    def _handle_tag_add(self, body):
        dim_id = int(body.get("dimension_id", 0))
        name = body.get("name", "")
        if any(t["dimension_id"] == dim_id and t["name"] == name for t in db["tags"]):
            self.send_error_json(400, "标签已存在")
            return
        cid = next_id("tag")
        db["tags"].append({"id": cid, "dimension_id": dim_id, "name": name, "color": body.get("color", "#4A90D9")})
        save_db()
        self.send_json({"id": cid})

    def _handle_group_add(self, body):
        cid = next_id("group")
        db["tag_groups"].append({
            "id": cid,
            "name": body.get("name", ""),
            "expression": body.get("expression", ""),
            "logic": body.get("logic", "or"),
        })
        save_db()
        self.send_json({"id": cid})

    def _handle_group_validate(self, body):
        expr = body.get("expression", "")
        all_tag_names = {t["name"] for t in db["tags"]}
        result = validate_expression(expr, all_tag_names)
        self.send_json(result)

    def _handle_groups_list(self):
        groups = []
        for g in db["tag_groups"]:
            g_copy = dict(g)
            g_tags = []
            for gt in db["group_tags"]:
                if gt["group_id"] == g["id"]:
                    t = find_by_id(db["tags"], gt["tag_id"])
                    if t:
                        d = find_by_id(db["dimensions"], t["dimension_id"])
                        t_copy = dict(t)
                        t_copy["dimension_name"] = d["name"] if d else ""
                        g_tags.append(t_copy)
            g_copy["tags"] = g_tags
            groups.append(g_copy)
        self.send_json(groups)


# ==================== 日志配置 ====================
LOG_FILE = os.path.join(EXE_DIR, "file_manager.log")
ERR_LOG = os.path.join(EXE_DIR, "file_manager_err.log")

def setup_logging():
    """配置日志：正常日志 + 错误日志"""
    logger = logging.getLogger("fm")
    logger.setLevel(logging.INFO)
    # 控制台输出
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(ch)
    # 文件输出
    fh = logging.FileHandler(LOG_FILE, mode="a", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(fh)
    # 错误日志单独写入错误文件
    err_logger = logging.getLogger("fm_err")
    err_logger.setLevel(logging.WARNING)
    eh = logging.FileHandler(ERR_LOG, mode="a", encoding="utf-8")
    eh.setLevel(logging.WARNING)
    eh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    err_logger.addHandler(eh)
    return logger, err_logger

logger, err_logger = None, None


# ==================== 启动 ====================
def main():
    global logger, err_logger
    logger, err_logger = setup_logging()

    logger.info("=" * 50)
    logger.info(f"文件标签管理系统启动中... PORT={PORT}")
    logger.info(f"数据目录: {DATA_DIR}")

    # ① 先清理旧进程（必须在 load_db 之前！）
    # 旧流程顺序是 load_db → 迁移save_db → taskkill，新进程会用自己的旧内存数据
    # 覆盖旧进程刚写入磁盘的新标签（双进程互写同一 db.json）。先杀后读可消除该竞态。
    import time
    try:
        result = subprocess.run(
            f'netstat -ano | findstr "127.0.0.1:{PORT}"',
            shell=True, capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.strip().split("\n"):
            if "LISTENING" in line:
                parts = line.strip().split()
                if parts:
                    pid = parts[-1]
                    try:
                        pid_int = int(pid)
                        if pid_int != os.getpid():
                            subprocess.run(f"taskkill /f /pid {pid_int}", shell=True,
                                           capture_output=True, timeout=3)
                            logger.warning(f"Killed zombie process PID {pid_int} on port {PORT}")
                    except (ValueError, IndexError):
                        pass
        time.sleep(0.5)  # 等旧进程退出、端口/文件句柄释放
    except Exception as e:
        logger.warning(f"Port cleanup check failed (non-fatal): {e}")

    # ② 清理上次异常退出可能残留的 .tmp 文件（避免 save_db 用脏 tmp 覆盖）
    try:
        if os.path.exists(DB_FILE + ".tmp"):
            os.unlink(DB_FILE + ".tmp")
    except Exception:
        pass

    load_db()
    load_scan_filters()
    load_content_links()

    # ③ 数据迁移（失败时不阻塞启动；此时旧进程已死，无并发写）
    try:
        for g in db["tag_groups"]:
            if "expression" not in g:
                g["expression"] = ""
            if "logic" not in g:
                g["logic"] = "or"
        save_db()
    except Exception as e:
        logger.warning(f"数据迁移保存失败（服务仍可正常启动）: {e}")

    # ④ 定时备份线程（每 30 分钟一次）：降低"db.json 损坏→恢复到隔天旧备份"的损失窗口
    def _periodic_backup():
        while True:
            time.sleep(1800)
            try:
                backup_db()
                logger.info("[periodic-backup] OK")
            except Exception as e:
                err_logger.error(f"[periodic-backup] failed: {e}")
    threading.Thread(target=_periodic_backup, daemon=True).start()

    # 手动创建 socket，避免继承的 fd 冲突
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", PORT))
    except OSError as e:
        err_logger.error(f"Failed to bind port {PORT}: {e}")
        logger.error(f"Failed to bind port {PORT}: {e}")
        print(f"\n[ERROR] 端口 {PORT} 已被占用！请检查是否有其他进程在使用。")
        print("按任意键关闭...")
        sys.stdin.read(1)
        sys.exit(1)
    sock.listen(5)

    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", PORT), RequestHandler,
        bind_and_activate=False,
    )
    server.socket = sock
    server.server_address = ("127.0.0.1", PORT)
    server.timeout = 0.5  # 空闲时每0.5秒检查一次是否继续运行

    logger.info(f"文件标签管理系统已启动: http://localhost:{PORT}")
    logger.info(f"Server ready.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("\n服务已停止")
    except Exception as e:
        err_logger.error(f"服务异常退出: {e}", exc_info=True)
        logger.error(f"服务异常退出: {e}")
    finally:
        server.server_close()
        sock.close()
        logger.info("服务已彻底关闭。")


if __name__ == "__main__":
    main()
