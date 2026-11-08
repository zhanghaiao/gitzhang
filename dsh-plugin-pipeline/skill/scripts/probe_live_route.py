# -*- coding: utf-8 -*-
"""探测「当前正在运行的 DSH 宿主」是否真的挂上了 /dsh-pipeline 路由。

不点 UI、不看截图，直接向真实 web server 发一次 POST：
  * 静态资源 fallback 对任何 POST 返回 405 → 路由没注册（旧症状）
  * 我们的路由（路径 A 或 B）会返回 401/403/200 → 路由已注册

同时打印 Host 侧运行时日志（tmpdir/dsh-pipeline-host-trace.log），
用于区分「模块没被加载」「apply 没跑」「服务没就绪」「注册成功」。

用法：python3 probe_live_route.py [--json]
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

CHANNEL = "/dsh-pipeline"
TRACE = pathlib.Path(tempfile.gettempdir()) / "dsh-pipeline-host-trace.log"


def listening_ports():
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True,
                             text=True, errors="replace", timeout=15).stdout
    except Exception as e:
        return [], str(e)
    ports = set()
    for line in out.splitlines():
        if "LISTENING" not in line:
            continue
        m = re.search(r"127\.0\.0\.1:(\d+)\s", line)
        if m:
            ports.add(int(m.group(1)))
    return sorted(ports), None


def request(port, path, method="POST", body=None):
    data = json.dumps(body).encode("utf-8") if method == "POST" else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=data, method=method,
        headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            try:
                return resp.status, resp.read(500).decode("utf-8", "replace")
            except Exception:
                return resp.status, ""
    except urllib.error.HTTPError as e:
        try:
            text = e.read(500).decode("utf-8", "replace")
        except Exception:
            text = ""
        return e.code, text
    except Exception as e:
        return None, str(e)


def find_web_ports(ports):
    """DSH web server 的唯一特征：GET /index.html 返回带 dsh 认证提示的 401。

    其它本机服务（LLM proxy 的 invalid_api_key、其它 web 服务的 AUTH_REQUIRED）
    也会监听 127.0.0.1，必须排除，否则会把它们的 401 误判成我们的路由。
    """
    hits = []
    for p in ports:
        status, body = request(p, "/index.html", "GET")
        low = (body or "").lower()
        if status in (401, 403) and "dsh web authentication" in low:
            hits.append((p, status, (body or "")[:100]))
    return hits


def route_state(status, body):
    low = (body or "").strip().lower()
    if status == 405:
        return "missing", False
    if "invalid_api_key" in low or "auth_required" in low:
        return "other_service", False
    if status == 200 and "server-response" in low:
        return "registered", True
    if status in (401, 403) and (low in ("unauthorized", "forbidden")
                                 or "dsh web authentication" in low):
        return "registered", True
    return "unknown", False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    ports, err = listening_ports()
    web = find_web_ports(ports) if ports else []
    probes = []
    registered = False
    for port, _, _ in web:
        body = {"type": "client-request", "rpcId": "live-probe",
                "method": "doctor", "payload": {}}
        status, text = request(port, f"{CHANNEL}/doctor", "POST", body)
        state, ok = route_state(status, text)
        if ok:
            registered = True
        probes.append({"port": port, "status": status, "state": state,
                       "body": (text or "")[:160], "route_present": ok})

    trace_lines = []
    if TRACE.is_file():
        try:
            lines = TRACE.read_text(encoding="utf-8", errors="replace").splitlines()
            # 展示最近一段；每行带时间戳与 pid，可据此区分真实宿主与本地自测进程。
            trace_lines = lines[-20:]
        except Exception as e:
            trace_lines = ["读取日志失败：" + str(e)]

    if not ports:
        verdict, reason = "FAIL", f"无法读取监听端口：{err}"
    elif not web:
        verdict, reason = "WARN", "未找到 DSH web server 端口（宿主可能没启动）"
    elif registered:
        verdict, reason = "PASS", "真实宿主已注册 /dsh-pipeline 路由（POST 不再返回 405）"
    else:
        verdict, reason = ("FAIL",
                           "POST /dsh-pipeline/doctor 仍返回 405：Host 侧路由未注册，"
                           "需要完全退出并重启 DSH 宿主；若已重启请看下方 trace 日志")

    result = {
        "verdict": verdict, "reason": reason,
        "listening_ports": ports, "web_ports": [p for p, _, _ in web],
        "probes": probes, "trace_file": str(TRACE), "trace_tail": trace_lines,
    }
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"结论：{verdict} — {reason}")
        print(f"监听端口：{ports}")
        print(f"DSH web server 端口：{[p for p, _, _ in web]}")
        for x in probes:
            print(f"  POST {CHANNEL}/doctor @ {x['port']} → HTTP {x['status']} "
                  f"| 路由存在={x['route_present']} | {x['body'][:90]}")
        print(f"\nHost 运行时日志（{TRACE}）：")
        for line in (trace_lines or ["(暂无：模块可能尚未被 Host 导入)"]):
            print("  " + line)
    sys.exit(0 if verdict in ("PASS", "WARN") else 1)


if __name__ == "__main__":
    main()
