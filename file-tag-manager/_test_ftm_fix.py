#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
文件标签管理系统 R1.5 修复自测（纯内存模式，零文件写入）
覆盖：
  T1 save_db 并发安全模型（模拟真实落盘：深拷贝 + 锁 + 失败重试，8 线程并发）
  T2 高亮状态 API 往返（GET/POST /api/highlight-state，桩 handler 直调）
  T3 启动顺序静态断言（main() 中 taskkill 必须先于 load_db；锁/重试/500 上报存在）
  T4 快照不写回（_handle_files_list / _handle_file_detail 不污染 db["files"]）
运行：python _test_ftm_fix.py
说明：本脚本不写任何磁盘文件，不触碰真实 db.json。
"""
import io
import json
import os
import re
import sys
import threading
import time

SRC = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SRC)

import server  # noqa: E402  真实模块，直接测生产逻辑

PASS = 0
FAIL = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  OK   {name}")
    else:
        FAIL += 1
        FAILURES.append(f"{name}: {detail}")
        print(f"  FAIL {name} — {detail}")


# ==================== T1: save_db 并发安全模型 ====================
def test_save_db_concurrency():
    """
    用与真实 save_db 相同的模式（DB_LOCK + 深拷贝快照 + 失败重试）构建内存落盘模拟：
    并发下不丢更新、不抛异常、最终"磁盘"与内存一致。
    真实 server.save_db 的锁/重试结构由 T3 静态断言保证。
    """
    print("\n[T1] save_db 并发安全模型（8 线程 × 15 次）")
    disk_lock = threading.Lock()
    disk_mock = {"file_tags": []}
    errors = []

    def mem_save():
        # 模拟真实 save_db 的锁 + 深拷贝快照 + 重试
        with disk_lock:
            for attempt in range(3):
                try:
                    import copy
                    snap = copy.deepcopy(server.db["file_tags"])
                    disk_mock["file_tags"] = snap
                    return True
                except Exception:
                    if attempt < 2:
                        time.sleep(0.005)
                        continue
                    return False

    def worker(n):
        try:
            for i in range(15):
                with server.DB_LOCK:
                    server.db["file_tags"].append({"file_id": 1, "tag_id": n * 100 + i})
                if not mem_save():
                    errors.append(f"worker{n} save failed")
        except Exception as e:
            errors.append(f"worker{n}: {e!r}")

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    check("8 线程 × 15 次并发保存无异常/无失败", len(errors) == 0, errors[:3])
    check("模拟磁盘与内存一致（无丢失）", len(disk_mock["file_tags"]) == len(server.db["file_tags"]),
          f"disk={len(disk_mock['file_tags'])} mem={len(server.db['file_tags'])}")
    check("去重后无重复写入", len({(x['file_id'], x['tag_id']) for x in disk_mock['file_tags']}) == len(disk_mock['file_tags']))

    # 真实 save_db 结构静态断言（锁内深拷贝 + 重试）
    src = io.open(os.path.join(SRC, "server.py"), encoding="utf-8").read()
    sd = src[src.find("def save_db"):src.find("def backup_db")]
    check("真实 save_db 用 DB_LOCK 保护", "with DB_LOCK:" in sd)
    check("真实 save_db 用深拷贝快照", "copy.deepcopy(db)" in sd)
    check("真实 save_db 有 3 次重试", "for attempt in range(3)" in sd)
    check("真实 save_db 失败返回 False", "return False" in sd)


# ==================== T2: 高亮状态 API ====================
class FakeHandler:
    """桩 handler：绑定真实 do_GET/do_POST 及所有私有处理方法，stub 底层 IO；
    save_db 由测试方替换为内存版。"""
    do_GET = server.RequestHandler.do_GET
    do_POST = server.RequestHandler.do_POST
    def __init__(self, path, body=None):
        self.path = path
        self._body = body or {}
        self.resp = None
        self.error = None

    def send_json(self, obj):
        self.resp = obj

    def send_error_json(self, code, msg):
        self.error = (code, msg)

    def _read_body(self):
        return self._body

    def send_response(self, code):
        pass

    def send_header(self, k, v):
        pass

    def end_headers(self):
        pass

    @property
    def wfile(self):
        return io.BytesIO()

    @property
    def rfile(self):
        return io.BytesIO(b"")

    @property
    def headers(self):
        return {"Content-Type": "application/json"}


# 绑定 RequestHandler 的全部私有处理方法（_handle_files_list / _handle_file_detail 等），
# 但跳过已在类里显式 stub 的 IO 方法
_SKIP_STUB = {"send_json", "send_error_json", "send_response", "send_header", "end_headers", "_read_body"}
for _mname in dir(server.RequestHandler):
    if _mname.startswith("__") or _mname in _SKIP_STUB:
        continue
    setattr(FakeHandler, _mname, getattr(server.RequestHandler, _mname))


def test_highlight_api():
    print("\n[T2] 高亮状态 API 往返")
    server.save_db = lambda: True  # 内存模式：不落盘
    # GET 默认空
    h = FakeHandler("/api/highlight-state")
    h.do_GET()
    check("GET 返回默认空状态", h.resp == {"tag_ids": [], "exts": [], "group_ids": []}, repr(h.resp))

    # POST 保存
    h = FakeHandler("/api/highlight-state", body={"tag_ids": [3, 7], "exts": ["pdf", "xlsx"], "group_ids": [2]})
    h.do_POST()
    check("POST 保存成功", h.resp == {"ok": True}, repr(h.resp))

    # GET 读回
    h = FakeHandler("/api/highlight-state")
    h.do_GET()
    check("GET 读回一致", h.resp == {"tag_ids": [3, 7], "exts": ["pdf", "xlsx"], "group_ids": [2]}, repr(h.resp))

    # 部分字段更新（未传字段保留）
    h = FakeHandler("/api/highlight-state", body={"tag_ids": [9]})
    h.do_POST()
    h = FakeHandler("/api/highlight-state")
    h.do_GET()
    check("部分字段更新保留原值", h.resp == {"tag_ids": [9], "exts": ["pdf", "xlsx"], "group_ids": [2]}, repr(h.resp))

    # 非法类型兜底：tag_ids 传字符串应被忽略（保持现值）
    h = FakeHandler("/api/highlight-state", body={"tag_ids": "abc"})
    h.do_POST()
    h = FakeHandler("/api/highlight-state")
    h.do_GET()
    check("非法类型输入被忽略", h.resp.get("tag_ids") == [9], repr(h.resp))

    # save_db 失败时返回 500
    server.save_db = lambda: False
    h = FakeHandler("/api/highlight-state", body={"tag_ids": [1]})
    h.do_POST()
    check("save_db 失败返回 500", h.error and h.error[0] == 500, repr(h.error))


# ==================== T3: 启动顺序静态断言 ====================
def test_main_order():
    print("\n[T3] 启动顺序与防御结构（静态断言）")
    src = io.open(os.path.join(SRC, "server.py"), encoding="utf-8").read()
    m = re.search(r"def main\(\):.*?(?=\nif __name__)", src, re.S)
    body = m.group(0) if m else ""
    pos_kill = body.find("taskkill")
    pos_load = body.find("load_db()")
    check("main() 中存在 taskkill 清理逻辑", pos_kill >= 0, f"taskkill pos={pos_kill}")
    check("main() 中存在 load_db()", pos_load >= 0, f"load_db pos={pos_load}")
    check("taskkill 位于 load_db 之前（先杀旧进程再读数据）", 0 < pos_kill < pos_load,
          f"kill@{pos_kill} load@{pos_load}")
    pos_migrate = body.find("数据迁移")
    check("数据迁移位于 load_db 之后", pos_load < pos_migrate, f"load@{pos_load} migrate@{pos_migrate}")
    check("定时备份线程存在（30 分钟）", "1800" in body and "_periodic_backup" in body, "periodic backup missing")
    check("启动时清理残留 .tmp", 'DB_FILE + ".tmp"' in body and "os.unlink" in body)
    # 打标签接口失败回 500
    check("打标签接口保存失败回 500", src.count("保存失败：数据未写入磁盘") >= 2)
    # 高亮 API 路由存在
    check("GET /api/highlight-state 路由存在", src.count('"/api/highlight-state"') >= 2)
    # DEFAULT_DB 含 highlight_state
    check("DEFAULT_DB 含 highlight_state", '"highlight_state"' in src)
    # load_db 兜底补齐 highlight_state
    check("load_db 兜底补齐 highlight_state", "highlight_state" in src[src.find("def load_db"):src.find("def save_db")])


# ==================== T4: 快照不写回 ====================
def test_no_snapshot_pollution():
    print("\n[T4] list/detail 不污染 db['files']")
    server.save_db = lambda: True  # 内存模式
    server.db["files"] = [
        {"id": 1, "file_name": "a.pdf", "file_path": "D:/a.pdf", "file_size": 10, "modified_time": "2026-01-01T00:00:00+00:00", "status": 1, "note": "", "is_folder": False, "created_at": "", "updated_at": ""},
        {"id": 2, "file_name": "b.docx", "file_path": "D:/b.docx", "file_size": 20, "modified_time": "2026-01-02T00:00:00+00:00", "status": 1, "note": "", "is_folder": False, "created_at": "", "updated_at": ""},
    ]
    server.db["file_tags"] = [{"file_id": 1, "tag_id": 1}]
    server.db["tags"] = [{"id": 1, "dimension_id": 1, "name": "t1", "color": "#fff"}]
    server.db["dimensions"] = [{"id": 1, "name": "d1", "sort_order": 0}]

    # list
    h = FakeHandler("/api/files?page=1&page_size=50")
    h.do_GET()
    check("list 响应带 tags 字段", h.resp and "tags" in h.resp["data"][0], repr(h.resp.get("data", [])[:1]))
    check("list 未污染 db['files']（无 tags 键）", all("tags" not in f for f in server.db["files"]),
          [f.get("tags") for f in server.db["files"]])

    # detail
    h = FakeHandler("/api/files/1")
    h.do_GET()
    check("detail 响应带 tags 字段", h.resp and h.resp.get("tags") is not None, repr(h.resp)[:120])
    check("detail 未污染 db['files']", all("tags" not in f for f in server.db["files"]),
          [f.get("tags") for f in server.db["files"]])


def main():
    print("=" * 60)
    print("文件标签管理系统 R1.5 修复自测（纯内存）")
    print("=" * 60)
    test_save_db_concurrency()
    test_highlight_api()
    test_main_order()
    test_no_snapshot_pollution()
    print("\n" + "=" * 60)
    print(f"结果：{PASS} 通过 / {FAIL} 失败")
    if FAILURES:
        print("失败项：")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("ALL PASSED")
    sys.exit(0)


if __name__ == "__main__":
    main()
