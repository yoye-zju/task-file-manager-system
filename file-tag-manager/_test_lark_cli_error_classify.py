# _test_lark_cli_error_classify.py — 纯内存测试，不写盘
# 验证 lark-cli 错误分类：网络超时 vs 认证过期 vs 其他（R3.x / v1.7.1）
# 运行：python _test_lark_cli_error_classify.py

import sys, json, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 从 server.py 提取真实函数（不 import 整个模块，避免启动副作用）
import re
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.py'), encoding='utf-8').read()

# 提取异常类和分类函数
ns = {}
exec(re.search(r'class FeishuAuthError.*?pass', src, re.S).group(0), ns)
exec(re.search(r'class FeishuNetworkError.*?pass', src, re.S).group(0), ns)
exec(re.search(r'def _classify_lark_cli_error.*?(?=\ndef )', src, re.S).group(0), ns)

classify = ns['_classify_lark_cli_error']
FeishuAuthError = ns['FeishuAuthError']
FeishuNetworkError = ns['FeishuNetworkError']

pass_count = 0
fail_count = 0
def assert_eq(name, got, exp):
    global pass_count, fail_count
    if got == exp:
        pass_count += 1
        print(f'PASS {name}')
    else:
        fail_count += 1
        print(f'FAIL {name} → got={got}, exp={exp}')

def cls_name(text):
    err_cls, _ = classify('', text)
    return err_cls.__name__

# ── 认证类错误 ──
assert_eq('stderr 含 token → Auth', cls_name('access token is expired'), 'FeishuAuthError')
assert_eq('stderr 含 unauthorized → Auth', cls_name('unauthorized request'), 'FeishuAuthError')
assert_eq('stderr 含 login → Auth', cls_name('please login first'), 'FeishuAuthError')
assert_eq('message 含 token expired → Auth', cls_name('{"message":"token expired"}'), 'FeishuAuthError')

# ── 网络类错误 ──
assert_eq('TLS handshake timeout → Network', cls_name('API call failed: Get "https://open.feishu.cn/...": net/http: TLS handshake timeout'), 'FeishuNetworkError')
assert_eq('timeout → Network', cls_name('request timeout after 10s'), 'FeishuNetworkError')
assert_eq('dial tcp → Network', cls_name('dial tcp 127.0.0.1:443: connect: connection refused'), 'FeishuNetworkError')
assert_eq('network subtype → Network', cls_name('{"error":{"type":"network","subtype":"timeout"}}'), 'FeishuNetworkError')
assert_eq('unreachable → Network', cls_name('no route to host: network is unreachable'), 'FeishuNetworkError')

# ── 关键边界：网络错误文本中不含 token 关键词 → 不误判为认证 ──
assert_eq('超时不误判认证', cls_name('TLS handshake timeout'), 'FeishuNetworkError')

# ── 其他错误 ──
assert_eq('普通错误 → Runtime', cls_name('invalid params: folder_token'), 'RuntimeError')
assert_eq('空输出 → Runtime', cls_name(''), 'RuntimeError')
assert_eq('json 解析错误文本 → Runtime', cls_name('unexpected token'), 'RuntimeError')

# ── _lark_cli_exec 的 ok=false 分支模拟 ──
# 直接模拟真实场景：网络超时以 exit 0 + JSON 输出到 stdout
fake_result_network = type('R', (), {
    'returncode': 0,
    'stdout': json.dumps({"ok": False, "error": {"type": "network", "subtype": "timeout", "message": 'API call failed: Get "https://open.feishu.cn/...": net/http: TLS handshake timeout'}}),
    'stderr': ''
})()

# 模拟 subprocess.run 返回 fake_result
orig_run = __import__('subprocess').run
class FakeSubprocess:
    @staticmethod
    def run(*args, **kwargs):
        return fake_result_network
sys.modules['subprocess'].run = FakeSubprocess.run

# 重新提取 _lark_cli_exec（依赖 subprocess.run 桩）
ns2 = {}
exec('import subprocess, json, os', ns2)
exec('class FeishuAuthError(Exception): pass', ns2)
exec('class FeishuNetworkError(Exception): pass', ns2)
exec(re.search(r'def _classify_lark_cli_error.*?(?=\ndef )', src, re.S).group(0), ns2)
# 替换 subprocess.run 为桩
ns2['subprocess'] = type('M', (), {'run': FakeSubprocess.run})()
exec(re.search(r'def _lark_cli_exec.*?(?=\ndef _feishu_time_to_iso)', src, re.S).group(0), ns2)

try:
    ns2['_lark_cli_exec']('fake cmd')
    assert_eq('ok=false 网络超时 → 抛 Network', '未抛异常', 'FeishuNetworkError')
except FeishuNetworkError:
    assert_eq('ok=false 网络超时 → 抛 Network', 'FeishuNetworkError', 'FeishuNetworkError')
except Exception as e:
    assert_eq('ok=false 网络超时 → 抛 Network', type(e).__name__, 'FeishuNetworkError')

# 恢复真实 subprocess
sys.modules['subprocess'].run = orig_run

print(f'\n结果: {pass_count} 通过, {fail_count} 失败')
sys.exit(1 if fail_count else 0)
