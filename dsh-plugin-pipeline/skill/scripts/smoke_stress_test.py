#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DSH 插件流水线高强度冒烟 / 压力测试。

在 smoke_test.py 的 11 项基础上，追加并发、循环确定性、故障注入矩阵、
安装回滚、路径与大产物边界、隔离性校验。全部在临时目录进行，
不改动用户正在使用的 desktop / web / tui profile。

用法：
  python3 smoke_stress_test.py --src <插件源码目录> --work <产物目录> [--report <报告路径>]
"""

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import random
import shutil
import stat
import subprocess
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

HOME = Path.home()
DEFAULT_SRC = Path("C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-plugin-pipeline")
DEFAULT_SKILL = HOME / ".workbuddy" / "skills" / "dsh-plugin-pipeline"
DEFAULT_WORK = Path("C:/Users/zhang/WorkBuddy/2026-10-30-18-36-40/我的大学梦/dsh_pipeline_test/smoke/stress")
REAL_PROFILE = HOME / ".dsh" / "profiles" / "desktop"


class RequireError(Exception):
    pass


def require(cond, msg):
    if not cond:
        raise RequireError(msg)


def json_stream(text):
    dec, out, i, n = json.JSONDecoder(), [], 0, len(text)
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


def flatten(objs):
    if len(objs) == 1 and isinstance(objs[0].get("results"), list):
        return objs[0]["results"]
    return objs


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def is_reparse(p):
    try:
        return bool(os.stat(p, follow_symlinks=False).st_file_attributes
                    & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except (AttributeError, OSError):
        return os.path.islink(p)


def safe_rmtree(root):
    """先摘掉所有 junction/symlink 再删目录，避免 rmtree 跟随链接删掉源码。"""
    if not root.exists():
        return
    links = []
    for dirpath, dirnames, _ in os.walk(root, topdown=True, followlinks=False):
        keep = []
        for d in dirnames:
            p = Path(dirpath) / d
            if is_reparse(p):
                links.append(p)
            else:
                keep.append(d)
        dirnames[:] = keep
    for p in sorted(links, key=lambda x: len(x.parts), reverse=True):
        try:
            os.rmdir(p)
        except OSError:
            pass
    shutil.rmtree(root, ignore_errors=True)


def codes(result):
    return {e.get("code") for e in (result.get("errors") or []) if isinstance(e, dict)}


class Stress:
    def __init__(self, args):
        self.src = Path(args.src).resolve()
        self.skill = Path(args.skill).resolve()
        self.cli_py = self.skill / "scripts" / "dsh_pipeline.py"
        self.config = self.skill / "assets" / "pipeline.config.json"
        self.work = Path(args.work).resolve()
        safe_rmtree(self.work)
        self.work.mkdir(parents=True, exist_ok=True)
        self.profiles = self.work / "profiles"
        self.profiles.mkdir()
        self.results = []
        self.stderrs = []
        self.meta = json.loads((self.src / "package.json").read_text(encoding="utf-8"))
        self.name = self.meta["name"]
        self.baseline = self._baseline()
        self._sandbox_config()
        self._make_profiles(["loop", "shared", "copymode", "rollback", "dry",
                             "p1", "p2", "p3", "p4", "p5", "p6"])
        self._write_rpc_probe()

    # ---------------- 基础设施 ----------------
    def _baseline(self):
        mf = REAL_PROFILE / "package.json"
        d = json.loads(mf.read_text(encoding="utf-8"))
        return {
            "package.json": sha(mf),
            "pnpm-lock.yaml": sha(REAL_PROFILE / "pnpm-lock.yaml"),
            "bundles": list(d["dsh"]["profile"]["bundles"]),
            "dep": d["dependencies"].get(self.name),
            "backups": len(list(REAL_PROFILE.glob("package.json.bak-before-*"))),
        }

    def _make_profiles(self, names):
        for n in names:
            p = self.profiles / n
            p.mkdir(exist_ok=True)
            (p / "node_modules").mkdir(exist_ok=True)
            (p / "package.json").write_text(json.dumps({
                "name": "dsh-stress-" + n, "private": True, "version": "1.0.0",
                "dependencies": {}, "dsh": {"profile": {"bundles": []}},
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _sandbox_config(self):
        cfg = json.loads(self.config.read_text(encoding="utf-8"))
        cfg["profile_root"] = str(self.profiles)
        cfg["update_lockfile"] = False
        self.cfg = self.work / "config.stress.json"
        self.cfg.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")

    def _write_rpc_probe(self):
        (self.work / "probe_rpc_stress.mjs").write_text("""\
import { pathToFileURL } from 'node:url'
const root = process.argv[2], tmp = process.argv[3]
const host = await import(pathToFileURL(root + '/src/host.js').href)
const h = host.makeHandler()
const call = async (ep, payload) => {
  const r = await h(ep, payload)
  if (r && r.ok === true) return r.value
  return { status: 'exception', message: r && r.error ? r.error.message : 'bad envelope' }
}
const eps = ['doctor', 'validate', 'package', 'run']
const tasks = []
for (let i = 0; i < 20; i++) {
  const ep = eps[i % 4]
  let payload
  if (ep === 'doctor') payload = { profileRoot: tmp }
  else if (ep === 'validate') payload = { src: root }
  else if (ep === 'package') payload = { src: root, out: tmp + '/rpc-' + i }
  else payload = { src: root, out: tmp + '/rpc-' + i, profileRoot: tmp,
                   profile: 'dry', dryRun: true }
  tasks.push({ ep, i, payload })
}
const settled = await Promise.all(tasks.map(async (t) => {
  try {
    const r = await call(t.ep, t.payload)
    return { ep: t.ep, status: r.status, stage: r.stage, errors: (r.errors || []).length }
  } catch (e) { return { ep: t.ep, status: 'exception', message: String(e.message || e) } }
}))
const bad = settled.filter((s) => s.status !== 'pass')
// 聚合结果的 stage 是「最后执行到的阶段」，不是端点名；只要落在允许集合内即无串扰
const allowed = { doctor: ['doctor'], validate: ['validate'],
  package: ['validate', 'package'], run: ['validate', 'package', 'install'] }
const wrongStage = settled.filter((s) => s.stage && !(allowed[s.ep] || []).includes(s.stage))
// 畸形 payload 必须被明确拒绝，不能崩溃
const malformedCalls = [
  ['validate', {}], ['nope', {}], ['package', {}], ['install', {}],
  ['run', {}], ['validate', { src: 123 }], ['nope', { x: 1 }],
  ['validate', { src: '' }], ['validate', {}], ['nope', {}],
]
const malformed = await Promise.all(malformedCalls.map(async ([ep, payload]) => {
  const r = await h(ep, payload)
  return r && r.ok === true ? 'ACCEPTED' : String(r && r.error ? r.error.message : 'REJECTED')
}))
console.log(JSON.stringify({ total: settled.length, bad, wrongStage,
  malformedAccepted: malformed.filter((m) => m === 'ACCEPTED').length }))
""", encoding="utf-8")

    def run_cmd(self, argv, timeout=300):
        r = subprocess.run([str(a) for a in argv], capture_output=True, timeout=timeout)
        out = r.stdout.decode("utf-8", errors="replace")
        err = r.stderr.decode("utf-8", errors="replace")
        if err.strip():
            self.stderrs.append(err.strip()[:400])
        return r.returncode, out, err

    def cli(self, *args, timeout=300, config=None):
        cmd = [sys.executable, str(self.cli_py), *map(str, args)]
        if "--config" not in args:
            cmd += ["--config", str(config or self.cfg)]
        if "--json" not in args:
            cmd += ["--json"]
        rc, out, err = self.run_cmd(cmd, timeout=timeout)
        return rc, out, err, json_stream(out), flatten(json_stream(out))

    def cli_real_config(self, *args):
        return self.cli(*args, config=self.config)

    def parallel(self, tasks, workers=8):
        """tasks: list of arg-tuples -> list of (rc, out, err, objs, res)"""
        with ThreadPoolExecutor(max_workers=workers) as ex:
            return list(ex.map(lambda a: self.cli(*a), tasks))

    def case(self, cid, name, fn):
        t0 = time.time()
        try:
            status, detail, extra = fn()
        except RequireError as e:
            status, detail, extra = "fail", str(e), None
        except Exception as e:
            status, detail, extra = "fail", f"未预期异常 {type(e).__name__}: {e}", None
        rec = {"id": cid, "name": name, "status": status, "detail": detail,
               "ms": int((time.time() - t0) * 1000)}
        if extra is not None:
            rec["extra"] = extra
        self.results.append(rec)
        print(f"  [{'PASS' if status == 'pass' else 'WARN' if status == 'warn' else 'FAIL'}] "
              f"{cid} {name} — {detail}", flush=True)
        return rec

    # ---------------- 变体构造 ----------------
    def variant(self, tag, mutate=None, remove=(), patch=None, raw=None):
        d = self.work / "variants" / tag
        if d.exists():
            safe_rmtree(d)
        shutil.copytree(self.src, d,
                        ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__"))
        mf = d / "package.json"
        if raw is not None:
            mf.write_text(raw, encoding="utf-8")
        else:
            pkg = json.loads(mf.read_text(encoding="utf-8"))
            if mutate:
                mutate(pkg)
            mf.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
        for rel in remove:
            p = d / rel
            if p.is_file():
                p.unlink()
        if patch is not None:
            (d / "cordis.patch.yml").write_text(patch, encoding="utf-8")
        return d

    # ================= A 组：循环稳定性 =================
    def a1(self):
        out = self.work / "a1-dist"
        digests = []
        for i in range(12):
            rc, o, e, objs, res = self.cli("run", "--src", self.src, "--out", out,
                                           "--skip-install")
            require(objs and objs[-1]["status"] == "pass", f"第 {i+1} 次 run 失败：{o[:200]}")
            digests.append(sha(out / f"{self.name}-{self.meta['version']}.zip"))
        require(len(set(digests)) == 1, f"12 次打包产物哈希不一致：{len(set(digests))} 种")
        return "pass", "连续 12 次「校验+打包」全部通过，产物字节完全一致（确定性打包）", {
            "rounds": 12, "sha256": digests[0][:16]}

    def a2(self):
        mf = self.profiles / "loop" / "package.json"
        before, backup_count = None, None
        for i in range(10):
            rc, o, e, objs, res = self.cli("run", "--src", self.src,
                                           "--out", self.work / "a2-dist",
                                           "--profile", "loop")
            require(len(res) == 3 and all(x["status"] != "fail" for x in res),
                    f"第 {i+1} 次 run 失败：{o[:250]}")
            cur = sha(mf)
            baks = len(list((self.profiles / "loop").glob("package.json.bak-before-*")))
            mount = self.profiles / "loop" / "node_modules" / self.name
            require((mount / "package.json").is_file(), f"第 {i+1} 次挂载不可读")
            if before is not None:
                require(cur == before, f"第 {i+1} 次改写了 profile package.json")
                require(baks == backup_count, f"第 {i+1} 次产生了新备份")
            before, backup_count = cur, baks
        return "pass", "连续 10 次完整一键上线：全过、挂载始终可读、profile 哈希与备份数恒定", {
            "rounds": 10, "sha256": before[:16], "backups": backup_count}

    def a3(self):
        seq = []
        for i in range(40):
            kind = ["validate", "package", "doctor", "install"][i % 4]
            if kind == "validate":
                seq.append(("validate", "--src", self.src))
            elif kind == "package":
                seq.append(("package", "--src", self.src, "--out", self.work / "a3-dist"))
            elif kind == "doctor":
                seq.append(("doctor",))
            else:
                seq.append(("install", "--src", self.src, "--profile", "loop", "--dry-run"))
        outs = self.parallel(seq, workers=6)
        bad = [(i, o[1][:150]) for i, o in enumerate(outs)
               if not o[3] or o[3][-1].get("status") == "fail"]
        require(not bad, f"{len(bad)} 个调用失败：{bad[:3]}")
        require(all("Traceback" not in o[2] for o in outs), "存在 Python traceback")
        return "pass", "40 次混合命令（6 并发）全部返回结构化结果，无失败、无 traceback", {
            "calls": len(outs), "workers": 6}

    def a4(self):
        ok, bad = [], []
        for i in range(12):
            n = f"dsh-stress-ok-{i:02d}"
            d = self.variant(f"ok-{i:02d}", mutate=lambda p, n=n: (
                p.__setitem__("name", n), p.__setitem__("version", f"1.0.{i}")),
                patch=f"- insert:\n  - id: {n}\n    name: '{n}'\n")
            ok.append((d, n))
        defects = [
            ("no-manifest", {}, ["package.json"], None, "MANIFEST_MISSING", None),
            ("bad-json", {}, [], None, "MANIFEST_INVALID_JSON", "{ not json"),
            ("no-dsh", {"dsh": None}, [], None, "FIELD_MISSING", None),
            ("bad-entry", {"main": "./src/nope.js"}, [], None, "ENTRY_NOT_FOUND", None),
            ("bad-export", {"exports": {"./x": "./src/nope.js"}}, [], None, "EXPORT_NOT_FOUND", None),
            ("bad-patch", {"dsh": {"engines": {}, "bundle": {"patch": "./nope.yml"}, "client": {}}},
             [], None, "PATCH_NOT_FOUND", None),
            ("no-patch-file", {}, ["cordis.patch.yml"], None, "PACKAGE_FILE_MISSING", None),
            ("bad-version", {"version": "one.two"}, [], None, "FIELD_INVALID", None),
            ("bad-name", {"name": "Bad Name!"}, [], None, "FIELD_INVALID", None),
            ("no-host", {}, ["src/host.js"], None, "PACKAGE_FILE_MISSING", None),
            ("empty-name", {"name": ""}, [], None, "FIELD_MISSING", None),
            ("empty-main", {"main": ""}, [], None, "FIELD_MISSING", None),
        ]
        for tag, mods, rem, patch, expect, raw in defects:
            def mut(p, m=mods):
                for k, v in m.items():
                    if v is None:
                        p.pop(k, None)
                    else:
                        p[k] = v
            d = self.variant(tag, mutate=mut, remove=rem, patch=patch, raw=raw)
            bad.append((d, expect))
        tasks = [(("validate", "--src", str(d)),) for d, _ in ok + bad]
        # 展平参数元组
        flat = [t[0] for t in tasks]
        outs = self.parallel(flat, workers=6)
        allcases = ok + bad
        wrong = []
        for (d, expect), (rc, o, e, objs, res) in zip(allcases, outs):
            r = res[-1] if res else {}
            c = codes(r)
            if d in [x[0] for x in ok]:
                if r.get("status") == "fail" or any(x.get("level") == "error" for x in r.get("errors", [])):
                    wrong.append((d.name, "合规变体被误判", sorted(c)))
            elif r.get("status") != "fail" or expect not in c:
                wrong.append((d.name, f"期望 {expect}", sorted(c)))
        require(not wrong, f"分类错误 {len(wrong)} 个：{wrong[:5]}")
        return "pass", f"24 个 manifest 变体（12 合规 / 12 缺陷）并发校验，诊断码命中率 100%", {
            "variants": len(allcases), "defect_codes": [x[4] for x in defects]}

    # ================= B 组：并发 =================
    def b1(self):
        outs = self.parallel([("doctor",)] * 16, workers=8)
        bad = [o for o in outs if not o[3] or o[3][-1].get("status") != "pass"]
        require(not bad, f"{len(bad)} 个 doctor 失败")
        sets = {json.dumps(o[3][-1].get("links"), sort_keys=True) for o in outs}
        require(len(sets) == 1, "并发 doctor 结果不一致")
        return "pass", "16 个 doctor 并发（8 workers）全部 pass 且结果完全一致", {"calls": 16}

    def b2(self):
        outs = self.parallel([("validate", "--src", self.src)] * 16, workers=8)
        bad = [o for o in outs if not o[3] or o[3][-1].get("status") != "pass"]
        require(not bad, f"{len(bad)} 个 validate 失败")
        return "pass", "16 个 validate 并发全部 pass", {"calls": 16}

    def b3(self):
        tasks = [("package", "--src", self.src, "--out", self.work / f"b3/{i}")
                 for i in range(8)]
        outs = self.parallel(tasks, workers=8)
        require(all(o[3] and o[3][-1]["status"] == "pass" for o in outs), "存在打包失败")
        for i in range(8):
            z = self.work / f"b3/{i}/{self.name}-{self.meta['version']}.zip"
            require(z.is_file(), f"产物缺失 {z}")
            with zipfile.ZipFile(z) as f:
                require(f.testzip() is None and "src/host.js" in f.namelist(), f"zip 损坏 {z}")
        return "pass", "8 路并发打包到不同输出目录，全部产物完整（CRC 校验通过）", {"calls": 8}

    def b4(self):
        out = self.work / "b4-same-out"
        outs = self.parallel([("package", "--src", self.src, "--out", out)] * 8, workers=8)
        bad = [o[1][:200] for o in outs if not o[3] or o[3][-1].get("status") != "pass"]
        z = out / f"{self.name}-{self.meta['version']}.zip"
        require(z.is_file(), "并发写同一路径后产物不存在")
        with zipfile.ZipFile(z) as f:
            require(f.testzip() is None, "并发写同一路径导致 zip 损坏")
            require(json.loads(f.read("package.json"))["name"] == self.name,
                    "并发写同一路径导致 manifest 错乱")
        require(not bad, f"{len(bad)} 个并发打包返回失败：{bad[:2]}")
        return "pass", "8 路并发写同一 zip 路径，全部返回 pass 且最终产物 CRC / manifest 完整", {"calls": 8}

    def b5(self):
        tasks = [("run", "--src", self.src, "--out", self.work / f"b5/{i}",
                  "--profile", f"p{i+1}") for i in range(6)]
        outs = self.parallel(tasks, workers=6)
        require(all(len(o[4]) == 3 and all(x["status"] != "fail" for x in o[4]) for o in outs),
                "存在并发安装失败")
        for i in range(6):
            p = self.profiles / f"p{i+1}"
            mf = json.loads((p / "package.json").read_text(encoding="utf-8"))
            require(self.name in mf["dsh"]["profile"]["bundles"], f"p{i+1} 未注册 bundle")
            require((p / "node_modules" / self.name / "package.json").is_file(),
                    f"p{i+1} 挂载不可读")
        return "pass", "6 个隔离 profile 并发首次安装，注册与挂载各自正确、互不干扰", {"profiles": 6}

    def b6(self):
        """两个不同插件并发装到同一 profile：检验注册读-改-写的竞态。"""
        v1 = self.variant("race-a", mutate=lambda p: p.__setitem__("name", "dsh-race-a"),
                          patch="- insert:\n  - id: dsh-race-a\n    name: 'dsh-race-a'\n")
        v2 = self.variant("race-b", mutate=lambda p: p.__setitem__("name", "dsh-race-b"),
                          patch="- insert:\n  - id: dsh-race-b\n    name: 'dsh-race-b'\n")
        tasks = [("install", "--src", v1, "--profile", "shared"),
                 ("install", "--src", v2, "--profile", "shared")]
        outs = self.parallel(tasks, workers=2)
        mf = json.loads((self.profiles / "shared" / "package.json").read_text(encoding="utf-8"))
        bundles = mf["dsh"]["profile"]["bundles"]
        deps = mf["dependencies"]
        missing = [n for n in ("dsh-race-a", "dsh-race-b")
                   if n not in bundles or n not in deps]
        return ("pass" if not missing else "fail",
                ("两个不同插件并发注册同一 profile，两者均保留" if not missing
                 else f"并发注册丢失：{missing}（bundles={bundles}, deps={list(deps)}）"),
                {"bundles": bundles, "deps": deps,
                 "statuses": [o[3][-1].get("status") if o[3] else None for o in outs]})

    # ================= C 组：RPC 并发 =================
    def c1(self):
        rc, out, err = self.run_cmd(["node", str(self.work / "probe_rpc_stress.mjs"),
                                     str(self.src), str(self.work / "profiles")], timeout=300)
        require(rc == 0, f"RPC 并发探针失败：{err[:300]}")
        r = json.loads(out.strip().splitlines()[-1])
        require(r["total"] == 20, f"请求数不符：{r['total']}")
        require(not r["bad"], f"有 {len(r['bad'])} 个 RPC 返回非 pass：{r['bad'][:3]}")
        require(not r["wrongStage"], f"结果串扰：{r['wrongStage'][:3]}")
        require(r["malformedAccepted"] == 0,
                f"{r['malformedAccepted']} 个畸形 payload 被错误接受")
        return "pass", "20 路 loopback RPC 并发（doctor/validate/package/run）全 pass 且无串扰；10 个畸形 payload 全被拒绝", r

    # ================= D 组：故障注入 =================
    def d1(self):
        ghost = self.work / "does-not-exist"
        rc, o, e, objs, res = self.cli("validate", "--src", ghost)
        r = res[-1] if res else {}
        require(r.get("status") == "fail" and "SRC_NOT_FOUND" in codes(r),
                f"期望 SRC_NOT_FOUND，实际 {codes(r)}")
        rc, o, e, objs, res = self.cli("run", "--src", ghost, "--out", self.work / "d1-dist")
        require(len(res) == 1 and res[0]["stage"] == "validate", "run 未在校验阶段阻断")
        return "pass", "不存在的源码目录 → SRC_NOT_FOUND，run 在校验阶段即阻断且不产物", None

    def d2(self):
        cases = []
        d = self.variant("d2-no-mf", remove=["package.json"])
        cases.append((d, "MANIFEST_MISSING"))
        d = self.variant("d2-bad-json", raw="{ broken json")
        cases.append((d, "MANIFEST_INVALID_JSON"))
        for d, expect in cases:
            rc, o, e, objs, res = self.cli("validate", "--src", d)
            require(expect in codes(res[-1]), f"{d.name}: 期望 {expect}，实际 {codes(res[-1])}")
            require("Traceback" not in e, f"{d.name} 抛出了 traceback")
        return "pass", "清单缺失 / JSON 语法损坏 → 对应诊断码，无未捕获异常", {"codes": [x[1] for x in cases]}

    def d3(self):
        checks = [
            ("d3-field", (lambda p: p.pop("dsh", None)), "DSH_FIELD_MISSING"),
            ("d3-name", (lambda p: p.__setitem__("name", "Bad Name!")), "FIELD_INVALID"),
            ("d3-ver", (lambda p: p.__setitem__("version", "v1")), "FIELD_INVALID"),
            ("d3-empty", (lambda p: p.__setitem__("main", "")), "FIELD_MISSING"),
        ]
        for tag, mut, expect in checks:
            d = self.variant(tag, mutate=mut)
            rc, o, e, objs, res = self.cli("validate", "--src", d)
            require(expect in codes(res[-1]), f"{tag}: 期望 {expect}，实际 {codes(res[-1])}")
        return "pass", "必填字段 / 包名 / 版本号 / 空值 4 类非法清单均被准确拦截", None

    def d4(self):
        checks = [
            ("d4-entry", {"main": "./src/nope.js"}, [], "ENTRY_NOT_FOUND"),
            ("d4-export", {"exports": {"./x": "./src/nope.js"}}, [], "EXPORT_NOT_FOUND"),
            ("d4-patch", {"dsh": {"engines": {}, "bundle": {"patch": "./nope.yml"}, "client": {}}},
             [], "PATCH_NOT_FOUND"),
            ("d4-file", {}, ["cordis.patch.yml"], "PACKAGE_FILE_MISSING"),
        ]
        for tag, mods, rem, expect in checks:
            def mut(p, m=mods):
                for k, v in m.items():
                    p[k] = v
            d = self.variant(tag, mutate=mut, remove=rem)
            rc, o, e, objs, res = self.cli("validate", "--src", d)
            require(expect in codes(res[-1]), f"{tag}: 期望 {expect}，实际 {codes(res[-1])}")
        return "pass", "入口 / exports / patch / 打包必需文件 4 类路径错误均被准确拦截", None

    def d5(self):
        # profile 不存在
        rc, o, e, objs, res = self.cli("install", "--src", self.src,
                                       "--profile", "ghost", "--profile-root", self.work / "ghost-root")
        require("PROFILE_NOT_FOUND" in codes(res[-1]), f"期望 PROFILE_NOT_FOUND，实际 {codes(res[-1])}")
        # node_modules 缺失
        nm = self.profiles / "no-nm"
        nm.mkdir(exist_ok=True)
        (nm / "package.json").write_text("{}", encoding="utf-8")
        rc, o, e, objs, res = self.cli("install", "--src", self.src, "--profile", "no-nm")
        require("NODE_MODULES_MISSING" in codes(res[-1]), f"期望 NODE_MODULES_MISSING，实际 {codes(res[-1])}")
        # profile manifest 损坏
        badmf = self.profiles / "bad-mf"
        badmf.mkdir(exist_ok=True)
        (badmf / "node_modules").mkdir(exist_ok=True)
        (badmf / "package.json").write_text("{ not json", encoding="utf-8")
        rc, o, e, objs, res = self.cli("install", "--src", self.src, "--profile", "bad-mf")
        require("PROFILE_MANIFEST_BAD" in codes(res[-1]), f"期望 PROFILE_MANIFEST_BAD，实际 {codes(res[-1])}")
        require("Traceback" not in e, "损坏的 profile manifest 导致 traceback")
        return "pass", "profile 不存在 / 缺 node_modules / manifest 损坏 → 3 个诊断码准确且无崩溃", None

    def d6(self):
        root = self.work / "dangling_root"
        p = root / "dangling"
        nm = p / "node_modules"
        nm.mkdir(parents=True, exist_ok=True)
        (p / "package.json").write_text("{}", encoding="utf-8")
        ghost = self.work / "ghost-target-dir"
        link = nm / "dsh-broken-plugin"
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(ghost)],
                           capture_output=True)
        require(os.path.lexists(link), f"无法创建断链：{r.returncode}")
        rc, o, e, objs, res = self.cli("doctor", "--profile-root", root)
        r = res[-1]
        require(r.get("status") == "fail" and r.get("broken", 0) >= 1,
                f"断链未被检出：broken={r.get('broken')}")
        require("DANGLING_SYMLINK" in codes(r), f"缺少 DANGLING_SYMLINK：{codes(r)}")
        os.rmdir(link)
        rc, o, e, objs, res = self.cli("doctor", "--profile-root", root)
        require(res[-1].get("status") == "pass" and res[-1].get("broken") == 0,
                "断链移除后未恢复健康")
        return "pass", "注入 dangling junction → doctor 报 DANGLING_SYMLINK；移除后恢复 broken=0", None

    def d7(self):
        """白盒：直接调用 install()，构造「挂载后校验失败」验证自动回滚。"""
        spec = importlib.util.spec_from_file_location("dsh_pipe", self.cli_py)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        cfg = dict(mod.DEFAULT_CONFIG)
        cfg.update(json.loads(self.cfg.read_text(encoding="utf-8")))
        cfg["update_lockfile"] = False
        pdir = self.profiles / "rollback"
        nm = pdir / "node_modules"
        dest = nm / self.name
        # 先放一个健康的 junction 作为「安装前状态」
        subprocess.run(["cmd", "/c", "mklink", "/J", str(dest), str(self.src)],
                       capture_output=True)
        require(is_reparse(dest), "预置 junction 失败")
        bad_src = self.variant("d7-bad-src", remove=["src/host.js"])
        bad_meta = {"name": self.name, "version": self.meta["version"],
                    "src": str(bad_src), "manifest": str(bad_src / "package.json")}
        res, _ = mod.install(bad_src, cfg, bad_meta, "rollback", "link")
        c = codes(res)
        require(res["status"] == "fail" and "INSTALL_FAILED" in c,
                f"未触发安装失败：status={res['status']} codes={c} log={res.get('log')}")
        require("回滚" in " ".join(res.get("log", [])), f"未记录回滚：{res.get('log')}")
        # 回滚后必须仍能解析到原来的健康源码
        ok = is_reparse(dest) and (dest / "package.json").is_file() and (dest / "src/host.js").is_file()
        return ("pass" if ok else "fail",
                ("挂载后校验失败被拦截并回滚" if ok else
                 "安装失败后原挂载丢失（回滚未恢复链接）"),
                {"codes": sorted(c), "log": res.get("log"), "restored": ok})

    def d8(self):
        p = self.profiles / "dry"
        before = sha(p / "package.json")
        rc, o, e, objs, res = self.cli("run", "--src", self.src,
                                       "--out", self.work / "d8-dist",
                                       "--profile", "dry", "--dry-run")
        require(res[-1]["status"] != "fail", f"dry-run 失败：{o[:250]}")
        require(sha(p / "package.json") == before, "dry-run 改写了 profile package.json")
        require(not (p / "node_modules" / self.name).exists(), "dry-run 创建了挂载")
        return "pass", "全新 profile 上 run --dry-run 不写 profile、不建挂载，仅演练", None

    # ================= E 组：产物与路径边界 =================
    def e1(self):
        cn = self.work / "中文 路径 带空格"
        d = cn / "plugin src"
        shutil.copytree(self.src, d,
                        ignore=shutil.ignore_patterns("node_modules", ".git", "__pycache__"))
        out = cn / "输出 目录"
        rc, o, e, objs, res = self.cli("validate", "--src", d)
        require(res[-1]["status"] == "pass", f"中文空格路径校验失败：{o[:250]}")
        rc, o, e, objs, res = self.cli("package", "--src", d, "--out", out)
        require(res[-1]["status"] == "pass", f"中文空格路径打包失败：{o[:250]}")
        z = out / f"{self.name}-{self.meta['version']}.zip"
        require(z.is_file(), "中文空格输出目录下产物不存在")
        with zipfile.ZipFile(z) as f:
            require(f.testzip() is None, "中文空格路径产物 CRC 异常")
        require("UnicodeDecodeError" not in e, "中文路径触发编码异常")
        return "pass", "源码与输出均含中文+空格的路径，校验/打包/zip 回读全通过", {"path": str(cn)}

    def e2(self):
        d = self.variant("e2-big")
        big = d / "assets" / "big.bin"
        payload = (b"DSH-STRESS-DATA-" * 512) * 1024  # ~8 MB，可压缩
        big.write_bytes(payload)
        out = self.work / "e2-dist"
        rc, o, e, objs, res = self.cli("package", "--src", d, "--out", out)
        require(res[-1]["status"] == "pass", f"大文件打包失败：{o[:250]}")
        z = out / f"{self.name}-{self.meta['version']}.zip"
        with zipfile.ZipFile(z) as f:
            require(f.testzip() is None, "大文件 zip CRC 校验失败")
            require(f.read("assets/big.bin") == payload, "大文件解压内容不一致")
        return "pass", f"8 MB 附加资源打包/解压字节一致（zip {z.stat().st_size//1024} KB，CRC 全通过）", {
            "payload_bytes": len(payload), "zip_kb": z.stat().st_size // 1024}

    def e3(self):
        d = self.variant("e3-exclude")
        junk = {
            "node_modules/junk.txt": "junk", ".git/config": "git",
            "__backup_old/junk.txt": "backup", ".hidden/secret": "secret",
            "assets/.dotfile": "dot",
        }
        for rel, txt in junk.items():
            p = d / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(txt, encoding="utf-8")
        out = self.work / "e3-dist"
        rc, o, e, objs, res = self.cli("package", "--src", d, "--out", out)
        z = out / f"{self.name}-{self.meta['version']}.zip"
        with zipfile.ZipFile(z) as f:
            names = f.namelist()
        leaked = [n for n in names if any(k in n for k in
                  ("node_modules", ".git", "__backup", "secret", ".dotfile"))]
        require(not leaked, f"排除规则泄漏：{leaked}")
        return "pass", "node_modules / .git / __backup* / 隐藏文件均未被打进产物", {"files": len(names)}

    def e4(self):
        out = self.work / "e4-dist"
        rc, o, e, objs, res = self.cli("package", "--src", self.src, "--out", out)
        summary = objs[-1]
        z = Path(summary["artifact_path"])
        with zipfile.ZipFile(z) as f:
            names = f.namelist()
            require(f.testzip() is None, "zip CRC 异常")
            pkg = json.loads(f.read("package.json"))
        require(pkg["name"] == self.name and pkg["version"] == self.meta["version"],
                "产物内 manifest 与源码不一致")
        inc = set(summary.get("included", []))
        require(set(names) == inc, f"产物清单与 included 不一致：{set(names) ^ inc}")
        return "pass", f"产物 {len(names)} 个文件：回读清单、manifest 自洽、CRC 全通过", {"files": names}

    def e5(self):
        p = self.profiles / "copymode"
        dest = p / "node_modules" / self.name
        rc, o, e, objs, res = self.cli("install", "--src", self.src,
                                       "--profile", "copymode", "--mode", "copy")
        require(res[-1]["status"] != "fail", f"copy 模式安装失败：{o[:250]}")
        require(dest.is_dir() and not is_reparse(dest), "copy 模式未生成实体目录")
        require((dest / "src/host.js").is_file(), "copy 模式文件不完整")
        before = sha(p / "package.json")
        baks = len(list(p.glob("package.json.bak-before-*")))
        rc, o, e, objs, res = self.cli("install", "--src", self.src,
                                       "--profile", "copymode", "--mode", "copy")
        require("noop" in (res[-1].get("actions") or []), "copy 模式重复安装未命中幂等")
        require(sha(p / "package.json") == before, "copy 模式幂等重跑改写了 profile")
        require(len(list(p.glob("package.json.bak-before-*"))) == baks, "copy 模式幂等重跑产生新备份")
        return "pass", "copy 模式生成实体目录、文件齐全；重复安装命中 noop 且无副作用", None

    # ================= F 组：隔离与错误预算 =================
    def f1(self):
        now = self._baseline()
        diff = [k for k in self.baseline if self.baseline[k] != now[k]]
        require(not diff, f"真实 desktop profile 被改动：{diff}")
        return "pass", "真实 desktop profile 全程零改动（package.json / lock / bundles / 依赖 / 备份数）", {
            "checked": list(self.baseline)}

    def f2(self):
        joined = "\n".join(self.stderrs)
        nasty = [k for k in ("Traceback", "UnicodeDecodeError", "WinError", "PermissionError")
                 if k in joined]
        require(not nasty, f"子进程 stderr 出现异常关键字：{nasty} / 样本 {self.stderrs[:2]}")
        return "pass", f"共 {len(self.stderrs)} 条 stderr 样本，无 Traceback / UnicodeDecodeError / WinError / PermissionError", {
            "stderr_samples": len(self.stderrs)}

    def execute(self):
        cases = [
            ("A1", "12 次确定性打包", self.a1), ("A2", "10 次完整一键上线幂等", self.a2),
            ("A3", "40 次混合命令并发稳定性", self.a3), ("A4", "24 个 manifest 变体矩阵", self.a4),
            ("B1", "16 路 doctor 并发", self.b1), ("B2", "16 路 validate 并发", self.b2),
            ("B3", "8 路并发打包（不同输出）", self.b3), ("B4", "8 路并发打包（同一输出）", self.b4),
            ("B5", "6 个 profile 并发首次安装", self.b5), ("B6", "双插件并发注册同一 profile", self.b6),
            ("C1", "20 路 loopback RPC 并发 + 畸形 payload", self.c1),
            ("D1", "故障注入：源码不存在", self.d1), ("D2", "故障注入：清单缺失/损坏", self.d2),
            ("D3", "故障注入：字段与格式非法", self.d3), ("D4", "故障注入：入口路径错误", self.d4),
            ("D5", "故障注入：profile 侧异常", self.d5), ("D6", "故障注入：断链检出与恢复", self.d6),
            ("D7", "故障注入：安装失败回滚", self.d7), ("D8", "dry-run 不落盘", self.d8),
            ("E1", "中文+空格路径边界", self.e1), ("E2", "8 MB 大产物边界", self.e2),
            ("E3", "打包排除规则", self.e3), ("E4", "产物回读一致性", self.e4),
            ("E5", "copy 模式安装与幂等", self.e5),
            ("F1", "真实 profile 零改动", self.f1), ("F2", "全局错误预算", self.f2),
        ]
        print(f"高强度冒烟测试开始：src={self.src}\n共 {len(cases)} 项\n", flush=True)
        for cid, name, fn in cases:
            self.case(cid, name, fn)
        s = {"total": len(self.results),
             "pass": sum(r["status"] == "pass" for r in self.results),
             "warn": sum(r["status"] == "warn" for r in self.results),
             "fail": sum(r["status"] == "fail" for r in self.results)}
        s["verdict"] = "PASS" if s["fail"] == 0 else "FAIL"
        return {
            "suite": "dsh-plugin-pipeline HIGH-INTENSITY smoke/stress test",
            "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
            "environment": {"src": str(self.src), "plugin": f"{self.name}@{self.meta['version']}",
                            "work": str(self.work), "python": sys.version.split()[0],
                            "groups": ["A 循环稳定性", "B 并发", "C RPC 并发",
                                       "D 故障注入", "E 产物/路径边界", "F 隔离与错误预算"]},
            "summary": s, "cases": self.results,
        }


def main():
    ap = argparse.ArgumentParser(description="DSH 插件流水线高强度冒烟测试")
    ap.add_argument("--src", default=str(DEFAULT_SRC))
    ap.add_argument("--skill", default=str(DEFAULT_SKILL))
    ap.add_argument("--work", default=str(DEFAULT_WORK))
    ap.add_argument("--report")
    args = ap.parse_args()
    st = Stress(args)
    report = st.execute()
    target = Path(args.report) if args.report else st.work / "smoke_stress_report.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    s = report["summary"]
    print(f"\n结论：{s['verdict']}  (pass={s['pass']} warn={s['warn']} fail={s['fail']} / {s['total']})")
    print(f"报告：{target}")
    sys.exit(0 if s["fail"] == 0 else 1)


if __name__ == "__main__":
    main()
