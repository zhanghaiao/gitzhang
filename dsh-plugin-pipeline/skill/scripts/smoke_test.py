#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH 插件流水线冒烟测试（可重复执行）。

覆盖安装后的关键路径，不改动用户正在使用的 profile：
  T01 doctor 链接健康          T02 profile 注册一致性      T03 Node 模块解析
  T04 宿主真实加载(loadProfileDirectory / composeEntries)
  T05 插件自检                 T06 静态语法/契约
  T07 CLI 校验/打包/演练安装    T08 loopback RPC 端到端(含 run)
  T09 临时 profile 全新安装     T10 幂等重跑               T11 负向阻断
  T12 真实 Host 路由层（apply() 注册保持 + 真实 RPC POST，HTTP 405 防线）

用法：
  python3 smoke_test.py --src <插件源码目录> --work <测试产物目录> [--host-root <harness 源码根目录>]
  python3 smoke_test.py --report <报告输出路径>
"""

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path

HOME = Path.home()
DEFAULT_SRC = Path("C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-plugin-pipeline")
DEFAULT_SKILL = HOME / ".workbuddy" / "skills" / "dsh-plugin-pipeline"
DEFAULT_HOST_ROOT = Path("D:/豆包文件/deepseek-harness-master")
DEFAULT_PROFILE_ROOT = HOME / ".dsh" / "profiles"
DEFAULT_WORK = Path("C:/Users/zhang/WorkBuddy/2026-10-30-18-36-40/我的大学梦/dsh_pipeline_test/smoke")


class RequireError(Exception):
    pass


def require(cond, msg):
    if not cond:
        raise RequireError(msg)


def json_stream(text):
    """从 stdout 中解析一个或多个 JSON 对象（run 会逐阶段输出）。"""
    dec = json.JSONDecoder()
    out, i, n = [], 0, len(text)
    while i < n:
        while i < n and text[i].isspace():
            i += 1
        if i >= n:
            break
        try:
            obj, end = dec.raw_decode(text, i)
            out.append(obj)
            i = end
        except ValueError:
            nl = text.find("\n", i)
            if nl < 0:
                break
            i = nl + 1
    return out


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def flatten(objs):
    """CLI 的 --json 输出是单个聚合对象时，取出其中的逐阶段结果列表。"""
    if len(objs) == 1 and isinstance(objs[0].get("results"), list):
        return objs[0]["results"]
    return objs


class Smoke:
    def __init__(self, args):
        self.src = Path(args.src).resolve()
        self.skill = Path(args.skill).resolve()
        self.cli_py = self.skill / "scripts" / "dsh_pipeline.py"
        self.config = self.skill / "assets" / "pipeline.config.json"
        self.host_root = Path(args.host_root).resolve()
        self.profile_root = Path(args.profile_root).resolve()
        self.work = Path(args.work).resolve()
        self.work.mkdir(parents=True, exist_ok=True)
        self.tmp = self.work / "profiles"
        self.tmp_profile = self.tmp / "smoke"
        self.results = []
        self.meta = json.loads((self.src / "package.json").read_text(encoding="utf-8"))
        self.name = self.meta["name"]
        self._prepare_sandbox()
        self._write_node_helpers()

    # ---------- 基础设施 ----------
    def _prepare_sandbox(self):
        """隔离的临时 profile：只用于端到端安装测试，绝不碰 desktop/web/tui。

        每次重建为全新状态，保证 T09 真的走「首次安装」路径而非幂等分支。
        junction 必须用 rmdir 只删链接本身，不能 rmtree（会跟随到源码目录）。
        """
        self.tmp_profile.mkdir(parents=True, exist_ok=True)
        nm = self.tmp_profile / "node_modules"
        nm.mkdir(exist_ok=True)
        mount = nm / self.name
        if os.path.lexists(mount):
            try:
                reparse = bool(os.stat(mount, follow_symlinks=False).st_file_attributes
                               & stat.FILE_ATTRIBUTE_REPARSE_POINT)
            except (AttributeError, OSError):
                reparse = os.path.islink(mount)
            try:
                os.rmdir(mount) if reparse else shutil.rmtree(mount)
            except OSError as e:
                raise RequireError(f"无法清理上次测试残留挂载 {mount}: {e}")
        for bak in self.tmp_profile.glob("package.json.bak-before-*"):
            bak.unlink()
        for old in self.tmp_profile.glob("__backup_pipeline_*"):
            shutil.rmtree(old, ignore_errors=True)
        mf = self.tmp_profile / "package.json"
        mf.write_text(json.dumps({
            "name": "dsh-smoke-profile", "private": True, "version": "1.0.0",
            "dependencies": {}, "dsh": {"profile": {"bundles": []}},
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        cfg = json.loads(self.config.read_text(encoding="utf-8"))
        cfg["profile_root"] = str(self.tmp)
        cfg["update_lockfile"] = False  # 隔离测试不联网、不改全局 lock
        (self.work / "config.sandbox.json").write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _write_node_helpers(self):
        (self.work / "probe_host.mjs").write_text("""\
import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL(process.argv[2]).href)
const p = mod.loadProfileDirectory('dsh', process.argv[3], process.argv[4], { userLayer: false })
const names = p.layers.map(l => l.packageName)
const entries = mod.composeEntries(p.layers.map(l => l.patches ?? []))
console.log(JSON.stringify({
  layerCount: names.length,
  loaded: names.includes('dsh-pipeline'),
  skipped: p.skippedBundles.some(s => s.packageName === 'dsh-pipeline'),
  composed: entries.some(e => JSON.stringify(e).includes('dsh-pipeline')),
}))
""", encoding="utf-8")
        (self.work / "probe_rpc.mjs").write_text("""\
import { pathToFileURL } from 'node:url'
const root = process.argv[2], tmp = process.argv[3]
const host = await import(pathToFileURL(root + '/src/host.js').href)
const h = host.makeHandler()
const unwrap = async (ep, payload) => {
  const r = await h(ep, payload)
  if (r && r.ok === true) return r.value
  return { status: 'exception', message: r && r.error ? r.error.message : 'bad envelope' }
}
const calls = [
  ['doctor', { profileRoot: tmp }],
  ['validate', { src: root }],
  ['package', { src: root, out: tmp + '/rpc-dist' }],
  ['run', { src: root, out: tmp + '/rpc-dist', profileRoot: tmp,
            profile: 'smoke', dryRun: true }],
]
const out = {}
for (const [ep, payload] of calls) {
  try {
    const r = await unwrap(ep, payload)
    out[ep] = { status: r.status, stage: r.stage,
                errors: (r.errors || []).length, actions: r.actions,
                stages: r.stages, artifact: r.artifact_path || null,
                raw: r.raw ? String(r.raw).slice(0, 120) : null }
  } catch (e) { out[ep] = { status: 'exception', message: String(e.message || e) } }
}
const u = await h('nope', {})
out.unknownEndpoint = (u && u.ok === false && /unknown endpoint/.test(u.error.message))
  ? 'REJECTED' : 'WRONG_ERROR'
console.log(JSON.stringify(out))
""", encoding="utf-8")

    def run_cmd(self, argv, cwd=None, timeout=300):
        r = subprocess.run([str(a) for a in argv], cwd=str(cwd) if cwd else None,
                           capture_output=True, timeout=timeout)
        return (r.returncode,
                r.stdout.decode("utf-8", errors="replace"),
                r.stderr.decode("utf-8", errors="replace"))

    def cli(self, *args, timeout=300):
        cmd = [sys.executable, str(self.cli_py), *map(str, args)]
        if "--config" not in args:
            cmd += ["--config", str(self.config)]
        if "--json" not in args:
            cmd += ["--json"]
        rc, out, err = self.run_cmd(cmd, timeout=timeout)
        return rc, out, err, json_stream(out)

    def node(self, *args, cwd=None, timeout=120):
        return self.run_cmd(["node", *map(str, args)], cwd=cwd, timeout=timeout)

    # ---------- 框架 ----------
    def case(self, cid, name, fn):
        t0 = time.time()
        try:
            status, detail, extra = fn()
        except RequireError as e:
            status, detail, extra = "fail", str(e), None
        except Exception as e:
            status, detail, extra = "fail", f"未预期异常: {type(e).__name__}: {e}", None
        rec = {"id": cid, "name": name, "status": status, "detail": detail,
               "ms": int((time.time() - t0) * 1000)}
        if extra is not None:
            rec["extra"] = extra
        self.results.append(rec)
        tag = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}[status]
        print(f"  [{tag}] {cid} {name} — {detail}", flush=True)
        return rec

    # ---------- 用例 ----------
    def t01(self):
        rc, out, err, objs = self.cli("doctor")
        require(bool(objs), f"doctor 无 JSON 输出：{out[:200]} / {err[:200]}")
        r = objs[0]
        require(r.get("status") == "pass", f"doctor status={r.get('status')}")
        require(r.get("broken") == 0, f"存在断链 broken={r.get('broken')}")
        hit = [l for l in r.get("links", []) if l.get("plugin") == self.name]
        require(hit and all(l.get("healthy") for l in hit),
                f"{self.name} 挂载缺失或不健康：{hit}")
        return "pass", f"status=pass, broken=0, {self.name} 链接健康", {"links": r.get("links")}

    def t02(self):
        pdir = self.profile_root / "desktop"
        mf = json.loads((pdir / "package.json").read_text(encoding="utf-8"))
        link = "link:" + str(self.src).replace("\\", "/")
        deps = mf.get("dependencies", {})
        bundles = mf.get("dsh", {}).get("profile", {}).get("bundles", [])
        require(deps.get(self.name) == link,
                f"dependencies[{self.name}]={deps.get(self.name)!r}，期望 {link!r}")
        require(self.name in bundles, f"dsh.profile.bundles 未包含 {self.name}")
        lock = (pdir / "pnpm-lock.yaml").read_text(encoding="utf-8", errors="replace")
        require(self.name in lock, "pnpm-lock.yaml 未记录该 link 依赖")
        return "pass", "dependencies + dsh.profile.bundles + lockfile 三者一致", {
            "link": link, "bundle_count": len(bundles)}

    def t03(self):
        probe = self.work / "probe_resolve.cjs"
        probe.write_text("""\
const { createRequire } = require('module')
const r = createRequire(process.argv[2])
console.log(r.resolve('dsh-pipeline/package.json'))
""", encoding="utf-8")
        rc, out, err = self.run_cmd(["node", str(probe),
                                     str(self.profile_root / "desktop" / "package.json")])
        p = out.strip().splitlines()[-1] if out.strip() else ""
        require(rc == 0 and p, f"模块解析失败 rc={rc}: {out} {err}")
        require(Path(p).is_file(), f"解析到的路径不存在：{p}")
        require(Path(p).resolve() == (self.src / "package.json").resolve(),
                f"解析到错误副本：{p}")
        return "pass", f"Node 解析到 {p}", {"resolved": p}

    def t04(self):
        boot = self.host_root / "packages/boot/app-boot/lib/index.js"
        require(boot.is_file(), f"宿主加载器不存在：{boot}")
        anchor = self.host_root / "package.json"
        rc, out, err = self.node(self.work / "probe_host.mjs", boot,
                                 self.profile_root / "desktop", anchor)
        require(rc == 0, f"宿主加载器执行失败 rc={rc}: {err[:300]}")
        r = json.loads(out.strip().splitlines()[-1])
        require(r["loaded"], "宿主 bundle layers 未包含 dsh-pipeline")
        require(not r["skipped"], "dsh-pipeline 出现在 skippedBundles")
        require(r["composed"], "composeEntries 结果未包含 dsh-pipeline entry")
        return "pass", (f"宿主加载 {r['layerCount']} 个 bundle 层，dsh-pipeline 在 layers、"
                        "未跳过、已进入合成 entry"), r

    def t05(self):
        rc, out, err = self.node(self.src / "scripts" / "selftest.mjs", cwd=self.src)
        require(rc == 0, f"selftest 退出码 {rc}：{out[-300:]} {err[-300:]}")
        require("自检通过" in out, f"selftest 未打印通过结论：{out[-300:]}")
        return "pass", out.strip().splitlines()[-1], {"stdout": out.strip()[-400:]}

    def t06(self):
        for f in ["src/host.js", "src/client.js", "scripts/selftest.mjs"]:
            rc, out, err = self.node("--check", self.src / f)
            require(rc == 0, f"{f} 语法检查失败：{err[:200]}")
        host_js = (self.src / "src/host.js").read_text(encoding="utf-8")
        client_js = (self.src / "src/client.js").read_text(encoding="utf-8")
        patch = (self.src / "cordis.patch.yml").read_text(encoding="utf-8")
        require("/dsh-pipeline" in host_js and "/dsh-pipeline" in client_js,
                "Host/Client 的 loopback RPC 通道不一致")
        require("RPC_CHANNEL = '/rpc/" not in host_js and "RPC_CHANNEL = '/rpc/" not in client_js,
                "仍在使用两段 channel：DSH 客户端会抛 invalid RPC target")
        require("ok: true, value" in host_js, "Host 未按 DSH 规范返回 { ok, value } 信封")
        require("r.ok === true" in client_js, "Client 未解包 DSH 信封")
        require("id: dsh-pipeline" in patch, "cordis.patch.yml 缺少 bundle entry")
        require("export const inject = ['webServer']" in host_js,
                "缺少模块级 inject：apply 可能先于 webServer 就绪执行")
        require("makeFallbackHandler" in host_js and "webServer.register" in host_js,
                "缺少不依赖 connection 的兜底路由")
        require("dispose()" not in host_js[host_js.find("export function apply"):],
                "apply() 里存在立即注销路由的写法")
        return "pass", "3 个 JS 语法通过；通道/信封/模块级 inject/双路径兜底一致", None

    def t07(self):
        rc, out, err, objs = self.cli("validate", "--src", self.src)
        require(bool(objs) and objs[0].get("status") == "pass", f"validate 失败：{out[:300]}")
        outdir = self.work / "dist-cli"
        rc, out, err, objs = self.cli("package", "--src", self.src, "--out", outdir)
        pres = objs[-1] if objs else {}
        require(pres.get("status") == "pass", f"package 失败：{out[:300]}")
        artifact = Path(pres["artifact_path"])
        require(artifact.is_file(), f"产物不存在：{artifact}")
        with zipfile.ZipFile(artifact) as z:
            names = z.namelist()
        require("package.json" in names and "src/host.js" in names,
                f"zip 内容不完整：{names[:10]}")
        rc, out, err, objs = self.cli("install", "--src", self.src,
                                      "--profile", "desktop", "--dry-run")
        require(bool(objs) and objs[-1].get("status") != "fail", f"dry-run install 失败：{out[:300]}")
        return "pass", f"validate/package/install(dry-run) 全通过，产物 {artifact.name} 含 {len(names)} 个文件", {
            "artifact": str(artifact), "files": len(names)}

    def t08(self):
        rc, out, err = self.node(self.work / "probe_rpc.mjs", self.src, self.tmp, timeout=180)
        require(rc == 0, f"RPC 探针执行失败 rc={rc}: {err[:300]}")
        r = json.loads(out.strip().splitlines()[-1])
        bad = [k for k, v in r.items() if isinstance(v, dict) and v.get("status") not in ("pass",)]
        require(not bad, f"RPC 端点返回非 pass：{bad} -> {json.dumps(r, ensure_ascii=False)[:600]}")
        require(r["unknownEndpoint"] == "REJECTED", f"未知端点未拒绝：{r['unknownEndpoint']}")
        return "pass", "host.makeHandler() 的 doctor/validate/package/run 均返回结构化 pass，无 405/transport failure", r

    def t09(self):
        cfg = self.work / "config.sandbox.json"
        outdir = self.work / "dist-fresh"
        rc, out, err, objs = self.cli("run", "--src", self.src, "--out", outdir,
                                      "--profile", "smoke", "--config", cfg, timeout=300)
        res = flatten(objs)
        stages = [o.get("stage") for o in res]
        require(stages == ["validate", "package", "install"], f"阶段序列异常：{stages}")
        require(all(o.get("status") != "fail" for o in res), f"存在失败阶段：{out[:400]}")
        ins = res[-1]
        mf = json.loads((self.tmp_profile / "package.json").read_text(encoding="utf-8"))
        require(mf["dependencies"].get(self.name) == "link:" + str(self.src).replace("\\", "/"),
                "临时 profile 未写入 dependencies")
        require(self.name in mf["dsh"]["profile"]["bundles"], "临时 profile 未写入 bundles")
        mount = self.tmp_profile / "node_modules" / self.name
        require((mount / "package.json").is_file(), "临时 profile 挂载目录不可读")
        bak = self.tmp_profile / f"package.json.bak-before-{self.name}"
        require(bak.is_file(), "注册前未生成 package.json 备份")
        return "pass", (f"全新 profile 一键上线成功（{'+'.join(stages)}），"
                        f"actions={ins.get('actions')}"), {"actions": ins.get("actions"), "log": ins.get("log")}

    def t10(self):
        cfg = self.work / "config.sandbox.json"
        mf = self.tmp_profile / "package.json"
        before = sha(mf)
        baks = sorted(self.tmp_profile.glob("package.json.bak-before-*"))
        rc, out, err, objs = self.cli("run", "--src", self.src, "--out", self.work / "dist-fresh",
                                      "--profile", "smoke", "--config", cfg, timeout=300)
        res = flatten(objs)
        require(len(res) == 3 and all(o.get("status") != "fail" for o in res),
                f"第二次 run 失败：{out[:400]}")
        ins = res[-1]
        require("noop" in (ins.get("actions") or []), f"第二次未走幂等分支：{ins.get('actions')}")
        require(sha(mf) == before, "幂等重跑改写了 profile package.json")
        require(len(sorted(self.tmp_profile.glob("package.json.bak-before-*"))) == len(baks),
                "幂等重跑产生了新备份或重复注册")
        return "pass", "重复执行命中 noop，package.json 哈希不变、无新增备份", {"actions": ins.get("actions")}

    def t11(self):
        bad = self.work / "bad-plugin"
        if bad.exists():
            shutil.rmtree(bad)
        bad.mkdir()
        (bad / "package.json").write_text(json.dumps({
            "name": "dsh-bad-plugin", "version": "0.0.1", "type": "module",
            "main": "./src/missing.js",
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        rc, out, err, objs = self.cli("validate", "--src", bad)
        vres = flatten(objs)[-1] if objs else {}
        require(vres.get("status") == "fail", "坏 manifest 未被判定为失败")
        errs = vres.get("errors", [])
        require(any(e.get("level") == "error" for e in errs), "缺少阻断级 error 诊断")
        outdir = self.work / "dist-bad"
        rc, out, err, objs = self.cli("run", "--src", bad, "--out", outdir)
        res = flatten(objs)
        require(len(res) == 1 and res[0].get("stage") == "validate",
                f"run 未在校验阶段阻断：{[o.get('stage') for o in res]}")
        require(not outdir.exists() or not list(outdir.glob("*.zip")), "校验失败仍生成了产物")
        return "pass", (f"坏 manifest 被阻断（{len(errs)} 条诊断），run 未进入打包/安装"), {
            "codes": [e.get("code") for e in errs][:8]}

    def t12(self):
        """真实 Host 路由层：挂载 apply() 后验证 prefix 路由仍在，并真实 POST。

        T08 只直接调用 makeHandler()，覆盖不到「注册是否被立即撤销」——
        线上正是因此返回 HTTP 405。R1 是该问题的唯一可靠防线。
        """
        script = self.skill / "scripts" / "rpc_route_test.mjs"
        require(script.is_file(), f"缺少路由层测试脚本：{script}")
        cordis = self.host_root / "vendor" / "cordis" / "lib" / "index.js"
        conn_lib = self.host_root / "packages" / "client" / "connection" / "lib" / "index.js"
        if not (cordis.is_file() and conn_lib.is_file()):
            return "warn", f"DSH 源码不可用（{self.host_root}），跳过真实路由层", None
        env = dict(os.environ, DSH_SRC=str(self.host_root), DSH_PLUGIN=str(self.src))
        p = subprocess.run(["node", str(script), "--json"], capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           env=env, timeout=180)
        objs = json_stream(p.stdout)
        require(bool(objs),
                f"路由层测试无 JSON 输出：rc={p.returncode} {p.stdout[:300]} {p.stderr[:300]}")
        r = objs[0]
        require(r.get("status") == "pass",
                f"路由层测试失败：{json.dumps(r, ensure_ascii=False)[:700]}")
        cases = {c["id"]: c["status"] for c in r.get("cases", [])}
        require(cases.get("R1") == "pass", "R1：RPC 路由注册未保持，POST 会退回 HTTP 405")
        require(cases.get("R3") == "pass", "R3：RPC POST 未拿到 CLI 业务结果")
        return "pass", "apply() 路由保持注册，真实 POST 返回 200 + DSH 信封", {"cases": cases}

    def execute(self):
        cases = [
            ("T01", "doctor 链接健康", self.t01),
            ("T02", "profile 注册一致性", self.t02),
            ("T03", "Node 模块解析", self.t03),
            ("T04", "宿主真实加载", self.t04),
            ("T05", "插件自检", self.t05),
            ("T06", "静态语法与契约", self.t06),
            ("T07", "CLI 三阶段", self.t07),
            ("T08", "loopback RPC 端到端", self.t08),
            ("T09", "临时 profile 全新安装", self.t09),
            ("T10", "幂等重跑", self.t10),
            ("T11", "负向阻断", self.t11),
            ("T12", "真实 Host 路由层(405 防线)", self.t12),
        ]
        print(f"冒烟测试开始：src={self.src}\n", flush=True)
        for cid, name, fn in cases:
            self.case(cid, name, fn)
        s = {"total": len(self.results),
             "pass": sum(r["status"] == "pass" for r in self.results),
             "warn": sum(r["status"] == "warn" for r in self.results),
             "fail": sum(r["status"] == "fail" for r in self.results)}
        s["verdict"] = "PASS" if s["fail"] == 0 else "FAIL"
        report = {
            "suite": "dsh-plugin-pipeline smoke test",
            "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
            "environment": {
                "src": str(self.src), "plugin": f"{self.meta['name']}@{self.meta['version']}",
                "skill_cli": str(self.cli_py), "config": str(self.config),
                "profile_root": str(self.profile_root), "sandbox_profile": str(self.tmp_profile),
                "host_root": str(self.host_root),
                "python": sys.version.split()[0], "work": str(self.work),
            },
            "summary": s, "cases": self.results,
        }
        return report


def main():
    ap = argparse.ArgumentParser(description="DSH 插件流水线冒烟测试")
    ap.add_argument("--src", default=str(DEFAULT_SRC))
    ap.add_argument("--skill", default=str(DEFAULT_SKILL))
    ap.add_argument("--host-root", default=str(DEFAULT_HOST_ROOT))
    ap.add_argument("--profile-root", default=str(DEFAULT_PROFILE_ROOT))
    ap.add_argument("--work", default=str(DEFAULT_WORK))
    ap.add_argument("--report")
    args = ap.parse_args()

    sm = Smoke(args)
    report = sm.execute()
    target = Path(args.report) if args.report else sm.work / "smoke_report.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    s = report["summary"]
    print(f"\n结论：{s['verdict']}  (pass={s['pass']} warn={s['warn']} fail={s['fail']} / {s['total']})")
    print(f"报告：{target}")
    sys.exit(0 if s["fail"] == 0 else 1)


if __name__ == "__main__":
    main()
