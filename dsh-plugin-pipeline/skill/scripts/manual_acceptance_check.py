#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH 插件上线流水线 · 手动验收客观核对（只读，不修改任何被验收对象）。

用法：
    # 第 1 次：重启宿主之前，记录真实 profile 基线
    python3 manual_acceptance_check.py --phase before

    # 第 2 次：在 UI 上手动点完所有按钮之后，核对结果
    python3 manual_acceptance_check.py --phase after

before 阶段允许「宿主尚未重载」「产物尚未生成」；after 阶段严格判定。
唯一写入的文件是验收目录下的基线/报告 JSON。
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SRC = Path("C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-plugin-pipeline")
PROFILE = Path("C:/Users/zhang/.dsh/profiles/desktop")
APP_BOOT_LIB = Path("D:/豆包文件/deepseek-harness-master/packages/boot/app-boot/lib")
SKILL_CLI = Path("C:/Users/zhang/.workbuddy/skills/dsh-plugin-pipeline/scripts/dsh_pipeline.py")
OUT_DIR = Path("C:/Users/zhang/WorkBuddy/2026-10-30-18-36-40/我的大学梦/dsh_pipeline_test/acceptance")
BASELINE = OUT_DIR / "acceptance_baseline.json"
PLUGIN = "dsh-pipeline"
ARTIFACT = SRC / "dist" / "dsh-pipeline-1.0.0.zip"
EXE_NAME = "DeepSeek Harness.exe"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True,
                          encoding="utf-8", errors="replace")


def fmt_time(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def text(path):
    return Path(path).read_text(encoding="utf-8", errors="replace")


def normalize_link(raw):
    return raw[4:] if raw.startswith("\\\\?\\") else raw


def host_process():
    """返回 (最早主进程启动时间, 主进程 PID 列表)。"""
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name = '%s'\" | " % EXE_NAME
        + "Where-Object { $_.CommandLine -notmatch '--type=' } | "
        + "ForEach-Object { \"$($_.ProcessId)|$($_.CreationDate.ToString('yyyy-MM-dd HH:mm:ss'))\" }"
    )
    r = run(["powershell", "-NoProfile", "-Command", ps])
    times, pids = [], []
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if "|" not in line:
            continue
        pid, _, created = line.partition("|")
        try:
            times.append(datetime.strptime(created.strip(), "%Y-%m-%d %H:%M:%S"))
            pids.append(pid.strip())
        except ValueError:
            pass
    return (min(times) if times else None), pids, (r.stderr or "").strip()


def code_mtime():
    files = [PROFILE / "package.json", SRC / "src/host.js", SRC / "src/client.js", SKILL_CLI]
    return max(datetime.fromtimestamp(p.stat().st_mtime) for p in files if p.is_file())


def loader_state():
    """用 DSH 宿主自己的 app-boot 加载器验证 bundle 是否真的会被加载。"""
    if not APP_BOOT_LIB.is_dir():
        return {"error": "找不到 app-boot/lib，跳过宿主加载器验证"}
    js = (
        "import('./index.js').then(m=>{"
        "const r=m.loadProfileDirectory('dsh',%s,%s,{userLayer:false});"
        "const n=r.layers.map(l=>l.packageName);"
        "const s=(r.skippedBundles||[]).map(x=>x.packageName);"
        "console.log('__RESULT__'+JSON.stringify({layers:n.length,"
        "has:n.includes('dsh-pipeline'),skipped:s.includes('dsh-pipeline')}))"
        "}).catch(e=>{console.log('__RESULT__'+JSON.stringify({error:String(e&&e.message||e)}))})"
        % (json.dumps(str(PROFILE)), json.dumps(str(PROFILE / "package.json")))
    )
    r = run(["node", "-e", js], cwd=str(APP_BOOT_LIB))
    for line in (r.stdout or "").splitlines():
        if line.startswith("__RESULT__"):
            try:
                return json.loads(line[len("__RESULT__"):])
            except json.JSONDecodeError:
                return {"error": "加载器输出无法解析"}
    return {"error": (r.stderr or "无输出").strip()[:300]}


def case(cid, title, status, detail, extra=None):
    row = {"id": cid, "title": title, "status": status, "detail": detail}
    if extra:
        row["extra"] = extra
    return row


def snapshot():
    mf = PROFILE / "package.json"
    manifest = json.loads(text(mf)) if mf.is_file() else {}
    return {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "package_sha": sha(mf) if mf.is_file() else None,
        "lock_sha": sha(PROFILE / "pnpm-lock.yaml") if (PROFILE / "pnpm-lock.yaml").is_file() else None,
        "backups": sorted(p.name for p in PROFILE.glob("package.json.bak-before-*")),
        "bundles": manifest.get("dsh", {}).get("profile", {}).get("bundles", []),
        "dependency": manifest.get("dependencies", {}).get(PLUGIN),
        "artifact_exists": ARTIFACT.is_file(),
        "artifact_mtime": fmt_time(ARTIFACT.stat().st_mtime) if ARTIFACT.is_file() else None,
    }


def main():
    ap = argparse.ArgumentParser(description="DSH 插件手动验收客观核对")
    ap.add_argument("--phase", choices=["before", "after"], default="after")
    args = ap.parse_args()
    phase = args.phase
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    rows = []
    started, pids, ps_err = host_process()
    code_ts = code_mtime()

    # C1 宿主是否已重载（bundle 与 Host JS 都是启动时加载）
    if not started:
        rows.append(case("C1", "宿主运行状态", "FAIL" if phase == "after" else "WARN",
                         "未检测到 DeepSeek Harness 主进程；验收前需启动宿主",
                         {"ps_stderr": ps_err[:200]}))
    elif started >= code_ts:
        rows.append(case("C1", "宿主已重载最新代码", "PASS",
                         "宿主启动 %s 晚于代码/注册最后改动 %s" %
                         (started.strftime("%Y-%m-%d %H:%M:%S"), code_ts.strftime("%Y-%m-%d %H:%M:%S")),
                         {"pids": pids}))
    else:
        rows.append(case("C1", "宿主已重载最新代码", "FAIL" if phase == "after" else "WARN",
                         "主进程启动 %s 早于 Host 代码改动 %s：Host 侧 host.js 只在启动时加载，"
                         "本次修复的正是 RPC 通道注册，不重启则通道仍注册失败，UI 会报 404/405。"
                         "必须完全退出并重新启动宿主" %
                         (started.strftime("%Y-%m-%d %H:%M:%S"), code_ts.strftime("%Y-%m-%d %H:%M:%S")),
                         {"pids": pids}))

    # C2 profile 注册三件套
    mf = PROFILE / "package.json"
    try:
        manifest = json.loads(text(mf))
        want = "link:" + str(SRC).replace("\\", "/")
        dep = manifest.get("dependencies", {}).get(PLUGIN)
        bundles = manifest.get("dsh", {}).get("profile", {}).get("bundles", [])
        lock_ok = PLUGIN in text(PROFILE / "pnpm-lock.yaml")
        ok = dep == want and PLUGIN in bundles and lock_ok
        rows.append(case("C2", "profile 注册完整", "PASS" if ok else "FAIL",
                         "dependencies=%s | bundles 含插件=%s | lock 有记录=%s" %
                         (dep, PLUGIN in bundles, lock_ok),
                         {"expected": want, "bundles_tail": bundles[-3:]}))
    except Exception as e:
        rows.append(case("C2", "profile 注册完整", "FAIL", "读取失败：%s" % e))

    # C3 junction 挂载
    link = PROFILE / "node_modules" / PLUGIN
    try:
        raw = os.readlink(str(link))
        target = Path(normalize_link(raw))
        ok = (target.resolve() == SRC.resolve()
              and (link / "package.json").is_file()
              and (link / "src/host.js").is_file())
        rows.append(case("C3", "链接挂载指向源码且可读", "PASS" if ok else "FAIL",
                         "目标=%s | 指向源码=%s | 必要文件可读=%s" %
                         (target, target.resolve() == SRC.resolve(),
                          (link / "package.json").is_file() and (link / "src/host.js").is_file())))
    except Exception as e:
        rows.append(case("C3", "链接挂载指向源码且可读", "FAIL", "读取链接失败：%s" % e))

    # C4 宿主真实加载器
    st = loader_state()
    if st.get("error"):
        rows.append(case("C4", "宿主加载器包含该 bundle", "WARN", st["error"]))
    else:
        ok = st.get("has") and not st.get("skipped")
        rows.append(case("C4", "宿主加载器包含该 bundle", "PASS" if ok else "FAIL",
                         "layers=%s | 含 dsh-pipeline=%s | 在 skippedBundles=%s" %
                         (st.get("layers"), st.get("has"), st.get("skipped")), st))

    # C5 代码与契约一致性
    cli_copy = SRC / "scripts" / "dsh_pipeline.py"
    host_txt = text(SRC / "src/host.js")
    client_txt = text(SRC / "src/client.js")
    patch_txt = text(SRC / "cordis.patch.yml")
    apply_body = host_txt[host_txt.find("export function apply"):]
    checks = {
        "两份 CLI 一致": cli_copy.is_file() and SKILL_CLI.is_file() and sha(cli_copy) == sha(SKILL_CLI),
        "Host 兼容聚合/多段 JSON": "parseJsonStream" in host_txt and "mergeResults" in host_txt,
        "Host 校验 src 类型": "typeof p.src !== 'string'" in host_txt,
        "Client 显式指定产物目录": "payload.out" in client_txt,
        "两端 RPC 通道一致": "const RPC_CHANNEL = '/dsh-pipeline'" in host_txt
                             and "var RPC_CHANNEL = '/dsh-pipeline'" in client_txt,
        "channel 为单段": bool(re.search(r"RPC_CHANNEL\s*=\s*'/[A-Za-z0-9._~-]+'", host_txt))
                          and not re.search(r"RPC_CHANNEL\s*=\s*'/[^']*/", host_txt + client_txt),
        "Host 返回 DSH 信封": "ok: true, value" in host_txt,
        "Client 解包 DSH 信封": "r.ok === true" in client_txt,
        "apply 未立即注销路由": "dispose()" not in apply_body
                               and "disposer()" not in apply_body,
        "模块级 inject 声明": "export const inject = ['webServer']" in host_txt,
        "双路径注册兜底": "makeFallbackHandler" in host_txt
                          and "webServer.register" in host_txt
                          and "PATH_A_OK" in host_txt and "PATH_B_OK" in host_txt,
        "Host 运行时日志埋点": "APPLY_CALLED" in host_txt and "TRACE_FILE" in host_txt,
        "Python 解释器多重回退": "i + 1 < candidates.length" in host_txt
                                and "'py'" in host_txt,
        "bundle patch id 一致": "id: dsh-pipeline" in patch_txt,
        "fetch endpoint 已注册": "'fetch'" in host_txt
                                 and "ENDPOINTS.includes(endpoint)" in host_txt
                                 and "key: 'fetch'" in client_txt,
        "fetch 限 GitHub https": "u.hostname !== 'github.com'" in host_txt
                                 and "parseRepoUrl" in host_txt
                                 and "raw.includes('..')" in host_txt,
        "fetch 无 shell 且防覆盖": "spawnFn('git', args" in host_txt
                                   and "拒绝覆盖" in host_txt
                                   and "isSymbolicLink()" in host_txt,
        "Client 拉取后自动回填": "setSrc(r.src)" in client_txt
                                 and "action === 'fetch'" in client_txt,
    }
    bad = [k for k, v in checks.items() if not v]
    rows.append(case("C5", "代码与契约一致性", "PASS" if not bad else "FAIL",
                     "%d 项全通过" % len(checks) if not bad else "未通过：" + "、".join(bad), checks))

    # C6 UI 打包产物（after 阶段必须存在且是本次重启之后生成的）
    if phase == "before":
        rows.append(case("C6", "UI 打包产物", "SKIP", "before 阶段跳过；请在 UI 点『打包』或『一键上线』后再核对"))
    else:
        try:
            if not ARTIFACT.is_file():
                raise ValueError("产物不存在：%s（请在 UI 点『打包』或『一键上线』）" % ARTIFACT)
            with zipfile.ZipFile(ARTIFACT) as z:
                crc_bad = z.testzip()
                names = z.namelist()
                need = ["package.json", "cordis.patch.yml", "src/host.js"]
                missing = [n for n in need if n not in names]
            mtime = datetime.fromtimestamp(ARTIFACT.stat().st_mtime)
            fresh = started is None or mtime >= started
            ok = crc_bad is None and not missing and fresh
            rows.append(case("C6", "UI 打包产物", "PASS" if ok else "FAIL",
                             "大小=%d B | CRC=%s | 缺失文件=%s | 生成于 %s（宿主启动后=%s）" %
                             (ARTIFACT.stat().st_size, "OK" if crc_bad is None else crc_bad,
                              missing or "无", mtime.strftime("%Y-%m-%d %H:%M:%S"), fresh),
                             {"artifact": str(ARTIFACT), "files": len(names)}))
        except Exception as e:
            rows.append(case("C6", "UI 打包产物", "FAIL", str(e)))

    # C7 真实 profile 零副作用
    snap = snapshot()
    if phase == "before":
        BASELINE.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
        rows.append(case("C7", "真实 profile 基线", "PASS",
                         "已记录基线（package/lock 哈希、备份数、bundles）；baseline=%s" % BASELINE))
    else:
        if not BASELINE.is_file():
            rows.append(case("C7", "真实 profile 零副作用", "WARN",
                             "缺少 before 基线，无法对比；请先跑 --phase before"))
        else:
            base = json.loads(text(BASELINE))
            diff = []
            for key in ["package_sha", "lock_sha", "backups", "bundles", "dependency"]:
                if base.get(key) != snap.get(key):
                    diff.append(key)
            rows.append(case("C7", "真实 profile 零副作用", "PASS" if not diff else "FAIL",
                             "零改动（安装命中 noop）" if not diff else "发生改动：" + "、".join(diff),
                             {"before": base.get("timestamp"), "after": snap.get("timestamp")}))

    # 输出
    print("=== 手动验收客观核对  phase=%s  %s ===" %
          (phase, datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
    icon = {"PASS": "[PASS]", "FAIL": "[FAIL]", "WARN": "[WARN]", "SKIP": "[SKIP]"}
    for r in rows:
        print("%s %s %-22s %s" % (icon[r["status"]], r["id"], r["title"], r["detail"]))
    fails = [r for r in rows if r["status"] == "FAIL"]
    warns = [r for r in rows if r["status"] == "WARN"]
    verdict = "FAIL" if fails else ("PASS(有提示)" if warns else "PASS")
    print("\n结论：%s  (pass=%d warn=%d fail=%d skip=%d)" %
          (verdict,
           sum(r["status"] == "PASS" for r in rows), len(warns), len(fails),
           sum(r["status"] == "SKIP" for r in rows)))
    if phase == "before":
        print("下一步：完全退出 DSH 宿主并重新启动 → 按《手动验收清单》在 UI 上逐项点击 → 运行 --phase after")
    elif fails:
        print("下一步：按失败项排查；最常见原因是宿主未重启（C1）或未在 UI 点打包（C6）。")
    else:
        print("下一步：客观核对全绿；请结合清单中的 UI 观察项给出最终人工判定。")

    report = OUT_DIR / ("acceptance_check_%s.json" % phase)
    report.write_text(json.dumps({
        "phase": phase, "timestamp": datetime.now().isoformat(timespec="seconds"),
        "verdict": verdict, "host_started": started.strftime("%Y-%m-%d %H:%M:%S") if started else None,
        "code_mtime": code_ts.strftime("%Y-%m-%d %H:%M:%S"),
        "cases": rows,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("报告：%s" % report)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
