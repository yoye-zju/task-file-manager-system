# _test_feishu_auth_flow.py — 纯内存测试，不写盘
# 验证「一键重新授权」设备码流程：auth-login 发起、device_code 暂存、auth-complete 完成、用后即清
# 运行：python _test_feishu_auth_flow.py

import sys, os, json, re, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.py'), encoding='utf-8').read()

# 提取所需函数定义
def extract(pattern):
    m = re.search(pattern, src, re.S)
    if not m:
        raise RuntimeError('未找到: ' + pattern[:50])
    return m.group(0)

ns = {'os': os, 'json': json, 'subprocess': subprocess, 're': re}
exec(extract(r'class FeishuAuthError.*?pass'), ns)
exec(extract(r'class FeishuNetworkError.*?pass'), ns)
exec(extract(r'def _classify_lark_cli_error.*?(?=\ndef )'), ns)
exec(extract(r'def _lark_cli_exec.*?(?=\ndef _feishu_time_to_iso)'), ns)
exec(extract(r'def _feishu_auth_login_start.*?(?=\ndef _feishu_auth_login_complete)'), ns)
exec(extract(r'def _feishu_auth_login_complete.*?(?=\ndef collect_files)'), ns)

_lark_cli_exec = ns['_lark_cli_exec']
_feishu_auth_login_start = ns['_feishu_auth_login_start']
_feishu_auth_login_complete = ns['_feishu_auth_login_complete']
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

# ── 模拟 lark-cli 设备码响应 ──
FAKE_URL = 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=xxx&user_code=ABC-123'
FAKE_CODE = 'fake_device_code_123'
LOGIN_RESP = json.dumps({
    'device_code': FAKE_CODE,
    'expires_in': 600,
    'verification_url': FAKE_URL,
})
COMPLETE_RESP = json.dumps({'ok': True, 'identity': 'user'})

# 记录 subprocess 收到的命令
calls = []

class FakeResult:
    def __init__(self, stdout, stderr='', returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode

class FakeSubprocess:
    @staticmethod
    def run(cmd, *a, **kw):
        calls.append(cmd if isinstance(cmd, str) else ' '.join(cmd))
        if '--no-wait' in (cmd if isinstance(cmd, str) else ' '.join(cmd)):
            return FakeResult(LOGIN_RESP)
        if '--device-code' in (cmd if isinstance(cmd, str) else ' '.join(cmd)):
            return FakeResult(COMPLETE_RESP)
        return FakeResult('{}')

# 注入桩
import subprocess
orig_run = subprocess.run
subprocess.run = FakeSubprocess.run

try:
    # ── 场景 1：auth-login 发起，返回 URL + 暂存 device_code ──
    url, expires_in = _feishu_auth_login_start()
    assert_eq('login 返回授权链接', url, FAKE_URL)
    assert_eq('login 返回有效期', expires_in, 600)
    assert_eq('暂存 device_code', _feishu_auth_login_start.__globals__.get('_feishu_pending_code'), FAKE_CODE)

    # ── 场景 2：auth-complete 用暂存 code 完成，成功后清空 ──
    ok = _feishu_auth_login_complete()
    assert_eq('complete 成功', ok, True)
    assert_eq('完成后清空 device_code', _feishu_auth_login_start.__globals__.get('_feishu_pending_code'), None)
    # 命令中必须携带 device_code
    dev_cmds = [c for c in calls if '--device-code' in c]
    assert_eq('complete 命令含 device_code', len(dev_cmds) > 0 and FAKE_CODE in dev_cmds[0], True)

    # ── 场景 3：无 pending code 时 complete 抛错 ──
    try:
        _feishu_auth_login_complete()
        assert_eq('无 pending 时 complete 抛异常', '未抛异常', 'RuntimeError')
    except RuntimeError:
        assert_eq('无 pending 时 complete 抛异常', 'RuntimeError', 'RuntimeError')

    # ── 场景 4：网络错误分类（auth-login 时 TLS 超时）──
    class NetResult:
        stdout = json.dumps({'ok': False, 'error': {'type': 'network', 'subtype': 'timeout',
            'message': 'Get "https://open.feishu.cn/...": net/http: TLS handshake timeout'}})
        stderr = ''
        returncode = 0
    subprocess.run = lambda cmd, *a, **kw: NetResult()
    try:
        _feishu_auth_login_start()
        assert_eq('网络超时 → 抛 Network', '未抛异常', 'FeishuNetworkError')
    except FeishuNetworkError:
        assert_eq('网络超时 → 抛 Network', 'FeishuNetworkError', 'FeishuNetworkError')
    except Exception as e:
        assert_eq('网络超时 → 抛 Network', type(e).__name__, 'FeishuNetworkError')
finally:
    subprocess.run = orig_run

print(f'\n结果: {pass_count} 通过, {fail_count} 失败')
sys.exit(1 if fail_count else 0)
