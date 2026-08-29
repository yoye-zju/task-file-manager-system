#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
纯内存测试：验证 sort_order 脏数据（字符串数字）不再让 /api/dimensions 崩溃。

不写任何文件：save_db 被 stub 掉，直接操作 server.db 字典。
运行：python _test_sort_order_fix.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  [PASS] " + name)
    else:
        FAIL += 1
        print("  [FAIL] " + name)


# 关掉落盘
server.save_db = lambda: True

print("=" * 60)
print("T1  to_int 各类输入")
print("=" * 60)
cases = [
    ("2", 2), (2, 2), (2.9, 2), ("  7 ", 7), ("3.6", 3),
    ("", 0), ("abc", 0), (None, 0), (True, 1), (False, 0), (-5, -5), ("-5", -5),
]
for raw, want in cases:
    got = server.to_int(raw)
    check("to_int(%r) == %r (got %r)" % (raw, want, got), got == want)
check("to_int('x', default=9) == 9", server.to_int("x", 9) == 9)

print("=" * 60)
print("T2  dim_sort_key 混合类型可排序（复现原 bug）")
print("=" * 60)
dirty = [
    {"id": 1, "name": "状态", "sort_order": 0},
    {"id": 14, "name": "其他", "sort_order": "2"},   # 脏数据：字符串
    {"id": 2, "name": "知识领域", "sort_order": 1},
    {"id": 5, "name": "项目", "sort_order": None},   # 更脏：None
    {"id": 6, "name": "作者"},                        # 字段缺失
]

# 先证明旧写法确实会崩
old_crashed = False
try:
    sorted(dirty, key=lambda d: d["sort_order"])
except TypeError:
    old_crashed = True
except KeyError:
    old_crashed = True
check("旧写法 key=d['sort_order'] 会抛异常（bug 已复现）", old_crashed)

new_ok = True
result = []
try:
    result = sorted(dirty, key=server.dim_sort_key)
except Exception as e:
    new_ok = False
    print("    exception: %r" % (e,))
check("新写法 dim_sort_key 不抛异常", new_ok)
check("排序结果条数不变 == 5", len(result) == 5)
if new_ok and result:
    orders = [server.to_int(d.get("sort_order", 0)) for d in result]
    check("排序后 sort_order 单调不减 %r" % (orders,), all(orders[i] <= orders[i + 1] for i in range(len(orders) - 1)))
    check("字符串 '2' 被排到 1 之后", [d["id"] for d in result].index(14) > [d["id"] for d in result].index(2))

print("=" * 60)
print("T3  normalize_db_types 归一化脏数据")
print("=" * 60)
server.db["dimensions"] = [
    {"id": 1, "name": "状态", "sort_order": 0},
    {"id": "14", "name": "其他", "sort_order": "2"},
]
server.db["tags"] = [
    {"id": "3", "name": "标签A", "dimension_id": "14", "color": "#f00"},
    {"id": 4, "name": "标签B", "dimension_id": 1, "color": "#0f0"},
]
server.db["tag_groups"] = [{"id": "9", "name": "组1"}]

fixed = server.normalize_db_types()
check("返回修正字段数 > 0 (got %d)" % fixed, fixed > 0)
check("dimensions[1].sort_order 变 int", isinstance(server.db["dimensions"][1]["sort_order"], int))
check("dimensions[1].sort_order == 2", server.db["dimensions"][1]["sort_order"] == 2)
check("dimensions[1].id 变 int 14", server.db["dimensions"][1]["id"] == 14 and isinstance(server.db["dimensions"][1]["id"], int))
check("tags[0].id 变 int 3", server.db["tags"][0]["id"] == 3 and isinstance(server.db["tags"][0]["id"], int))
check("tags[0].dimension_id 变 int 14", server.db["tags"][0]["dimension_id"] == 14)
check("tag_groups[0].id 变 int 9", server.db["tag_groups"][0]["id"] == 9)
check("干净数据不被破坏 dimensions[0].sort_order == 0", server.db["dimensions"][0]["sort_order"] == 0)
check("color 等非数值字段不受影响", server.db["tags"][0]["color"] == "#f00")

again = server.normalize_db_types()
check("幂等：二次归一化返回 0 (got %d)" % again, again == 0)

print("=" * 60)
print("T4  归一化后 /api/dimensions 的排序路径可用")
print("=" * 60)
ok = True
try:
    dims = sorted(server.db["dimensions"], key=server.dim_sort_key)
except Exception as e:
    ok = False
    print("    exception: %r" % (e,))
check("归一化后排序不抛异常", ok)
check("find_by_id 能按 int id 命中归一化后的维度", server.find_by_id(server.db["dimensions"], 14) is not None)

print("=" * 60)
print("T5  文件列表排序：混合类型不崩")
print("=" * 60)
files = [
    {"id": 1, "file_name": "b.txt", "file_size": 100, "modified_time": "2026-01-01"},
    {"id": 2, "file_name": "a.txt", "file_size": "2048", "modified_time": None},
    {"id": 3, "file_name": None, "modified_time": "2026-05-01"},
]
ok = True
try:
    by_size = sorted(files, key=lambda f: server.to_int(f.get("file_size", 0)))
    by_name = sorted(files, key=lambda f: str(f.get("file_name") or "").lower())
    by_time = sorted(files, key=lambda f: str(f.get("modified_time") or "").lower())
except Exception as e:
    ok = False
    print("    exception: %r" % (e,))
check("三种排序键都不抛异常", ok)
if ok:
    check("file_size 数值序正确 [0,100,2048]", [server.to_int(f.get("file_size", 0)) for f in by_size] == [0, 100, 2048])
    check("file_name 缺失值排最前", by_name[0]["id"] == 3)
    check("modified_time None 视为空串排最前", by_time[0]["id"] == 2)

print("=" * 60)
print("T6  源码静态检查：不残留裸 sort_order 排序")
print("=" * 60)
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py"), encoding="utf-8").read()
check("无 key=lambda d: d[\"sort_order\"]", 'key=lambda d: d["sort_order"]' not in src)
check("无 key=lambda x: x[\"sort_order\"]", 'key=lambda x: x["sort_order"]' not in src)
check("dim_sort_key 被使用 >= 2 处", src.count("key=dim_sort_key") >= 2)
check("dimension update 走 to_int", 'd["sort_order"] = to_int(' in src)
check("load_db 调用 normalize_db_types", "normalize_db_types()" in src)

print()
print("=" * 60)
print("PASS: %d   FAIL: %d" % (PASS, FAIL))
print("=" * 60)
if FAIL:
    print("SOME TESTS FAILED")
    sys.exit(1)
print("ALL PASSED")
