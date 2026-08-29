#!/usr/bin/env python3
"""AI Task Lens — HTTP 服务 (多线程 + 日志)"""
import http.server
import logging
import os
import socket
import sys
from datetime import datetime

PORT = 8080
DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(DIR, "task_lens.log")
ERR_LOG = os.path.join(DIR, "task_lens_err.log")

# 配置日志：正常日志 + 错误日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, mode="a", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
err_logger = logging.getLogger("err")
err_handler = logging.FileHandler(ERR_LOG, mode="a", encoding="utf-8")
err_handler.setLevel(logging.WARNING)
err_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
err_logger.addHandler(err_handler)
err_logger.propagate = False


def main():
    os.chdir(DIR)
    logging.info("=" * 50)
    logging.info("AI Task Lens starting...")
    logging.info(f"Working directory: {DIR}")
    logging.info(f"Port: {PORT}")

    # 清理旧进程（防止僵尸进程）
    import subprocess
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
                            logging.warning(f"Killed zombie process PID {pid_int} on port {PORT}")
                    except (ValueError, IndexError):
                        pass
    except Exception as e:
        logging.warning(f"Port cleanup check failed (non-fatal): {e}")

    # 手动创建 socket，避免继承的 fd 冲突
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("127.0.0.1", PORT))
    except OSError as e:
        err_logger.error(f"Failed to bind port {PORT}: {e}")
        logging.error(f"Failed to bind port {PORT}: {e}")
        print(f"\n[ERROR] 端口 {PORT} 已被占用！请检查是否有其他进程在使用。")
        print("按任意键关闭...")
        sys.stdin.read(1)
        sys.exit(1)
    sock.listen(5)
    # 设置 socket 超时，防止长时间无响应的连接占用线程
    sock.settimeout(60.0)

    # 使用 ThreadingHTTPServer 支持并发请求
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", PORT),
        http.server.SimpleHTTPRequestHandler,
        bind_and_activate=False,
    )
    server.socket = sock
    server.server_address = ("127.0.0.1", PORT)
    server.timeout = 0.5  # 空闲时每 0.5 秒检查一次是否继续

    logging.info(f"Serving HTTP on http://127.0.0.1:{PORT}")
    logging.info(f"Server ready.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Server stopped by user (Ctrl+C).")
    except Exception as e:
        err_logger.error(f"Server crashed: {e}", exc_info=True)
        logging.error(f"Server crashed: {e}")
    finally:
        server.server_close()
        sock.close()
        logging.info("Server shut down complete.")


if __name__ == "__main__":
    main()
