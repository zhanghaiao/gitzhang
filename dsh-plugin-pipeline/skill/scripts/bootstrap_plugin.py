#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Clone the bundled, acceptance-verified DSH plugin template into a new
plugin source directory, rename every identifier consistently, and optionally
run the delivery CLI up to the requested stage.

The template in ``assets/plugin-template`` is the exact plugin that passed
``validate -> package -> install`` and the 7/7 objective acceptance checks.
It already contains the correct single-segment RPC channel, envelope handler,
module-level ``inject = ['webServer']`` and dual registration paths.

Safety:
  * Never overwrites an existing non-empty directory.
  * Default chain is ``validate`` (read-only; no profile changes).
  * Installing into a real profile requires an explicit ``--chain run``.

Output is always a single structured JSON object on stdout.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TEMPLATE = ROOT / "assets" / "plugin-template"
CLI = HERE / "dsh_pipeline.py"
CONFIG = ROOT / "assets" / "pipeline.config.json"

BASE_ID = "dsh-pipeline"
BASE_TITLE = "DSH 插件上线流水线"
BASE_SHORT = "插件上线流水线"
BASE_VERSION = "1.0.0"

# DSH channel constraint: /^[A-Za-z0-9._~-]+$/, and /api is reserved.
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._~-]*$")

# Text files whose identifiers must follow the new plugin name. Rewriting the
# selftest alongside host.js keeps its channel/error-code assertions in sync.
REWRITE = (
    "package.json",
    "cordis.patch.yml",
    "README.md",
    "src/host.js",
    "src/client.js",
    "scripts/selftest.mjs",
)


def emit(payload: dict, code: int) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    sys.exit(code)


def fail(message: str, stage: str = "bootstrap") -> None:
    emit({
        "status": "fail",
        "stage": stage,
        "errors": [{"code": "BOOTSTRAP_ERROR", "message": message}],
        "log": [],
    }, 1)


def run_cli(args: list[str]) -> dict:
    cmd = [sys.executable, str(CLI), *args, "--json"]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    out = (proc.stdout or "").strip()
    try:
        return json.loads(out)
    except (ValueError, TypeError):
        return {
            "status": "fail",
            "stage": args[0],
            "errors": [{"code": "CLI_BAD_OUTPUT",
                        "message": ((proc.stderr or out) or "CLI 无输出")[:800]}],
            "log": [],
        }


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Bootstrap a DSH Web UI plugin from the verified template."
    )
    ap.add_argument("--name", required=True, help="plugin id, e.g. dsh-my-plugin")
    ap.add_argument("--out", default=".", help="parent directory for the new source directory")
    ap.add_argument("--version", default=BASE_VERSION)
    ap.add_argument("--title", default=BASE_TITLE, help="panel title shown in the UI")
    ap.add_argument("--chain", choices=("none", "validate", "package", "run"),
                    default="validate",
                    help="how far to run the delivery CLI (default: validate, read-only)")
    ap.add_argument("--profile", default="desktop", help="target profile for --chain run")
    ap.add_argument("--skip-install", action="store_true",
                    help="with --chain run: validate + package only, no profile changes")
    args = ap.parse_args()

    name = args.name.strip()
    if not NAME_RE.match(name) or name == "api":
        fail("非法插件名：必须匹配 /^[a-z0-9][a-z0-9._~-]*$/，且不能为保留名 api（对应 /api 通道）")
    if not TEMPLATE.is_dir():
        fail(f"模板目录不存在：{TEMPLATE}")

    parent = Path(args.out).expanduser().resolve()
    target = (parent / name).resolve()
    if target.exists():
        if target.is_file() or any(target.iterdir()):
            fail(f"目标目录已存在且非空，拒绝覆盖：{target}")
        target.rmdir()  # empty directory is safe to reuse
    parent.mkdir(parents=True, exist_ok=True)

    shutil.copytree(
        TEMPLATE, target,
        ignore=shutil.ignore_patterns("__pycache__", ".*", "dist", "node_modules"),
    )

    pairs = [(BASE_ID, name)]
    if args.title != BASE_TITLE:
        pairs += [(BASE_TITLE, args.title), (BASE_SHORT, args.title)]
    if args.version != BASE_VERSION:
        pairs += [(f'"version": "{BASE_VERSION}"', f'"version": "{args.version}"')]

    for rel in REWRITE:
        path = target / rel
        if not path.is_file():
            fail(f"模板缺少文件：{rel}")
        text = path.read_text(encoding="utf-8")
        for old, new in pairs:
            text = text.replace(old, new)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)

    # Consistency guard: manifest name, patch id/name and RPC channel must agree.
    manifest = json.loads((target / "package.json").read_text(encoding="utf-8"))
    patch = (target / "cordis.patch.yml").read_text(encoding="utf-8")
    host_js = (target / "src" / "host.js").read_text(encoding="utf-8")
    client_js = (target / "src" / "client.js").read_text(encoding="utf-8")
    channel = f"'/{name}'"
    checks = {
        "manifest.name": manifest.get("name") == name,
        "patch.id": f"id: {name}" in patch,
        "patch.name": f"name: '{name}'" in patch,
        "host.channel": channel in host_js,
        "client.channel": channel in client_js,
        "no-stale-id": BASE_ID not in (manifest.get("name", "") + patch + host_js + client_js),
    }
    if not all(checks.values()):
        fail("标识符替换不一致：" + json.dumps(checks, ensure_ascii=False))

    files = sorted(
        str(p.relative_to(target)).replace("\\", "/")
        for p in target.rglob("*") if p.is_file()
    )

    results: list[dict] = []
    common = ["--src", str(target), "--config", str(CONFIG)]
    out = str(target / "dist")
    if args.chain == "validate":
        results.append(run_cli(["validate", *common]))
    elif args.chain == "package":
        results.append(run_cli(["validate", *common]))
        if results[-1].get("status") == "pass":
            results.append(run_cli(["package", *common, "--out", out]))
    elif args.chain == "run":
        # `run` already performs validate + package internally; do not duplicate.
        run_args = ["run", *common, "--out", out, "--profile", args.profile]
        if args.skip_install:
            run_args.append("--skip-install")
        results.append(run_cli(run_args))

    errors = [e for r in results for e in r.get("errors", [])]
    status = "fail" if any(r.get("status") != "pass" for r in results) else "pass"
    payload = {
        "status": status,
        "stage": "bootstrap",
        "name": name,
        "version": manifest.get("version"),
        "src": str(target),
        "chain": args.chain,
        "files": files,
        "checks": checks,
        "results": results,
        "errors": errors,
        "log": [],
    }
    for key in ("artifact_path", "install_path", "actions"):
        for r in reversed(results):
            if r.get(key) is not None:
                payload[key] = r[key]
                break
    emit(payload, 0 if status == "pass" else 1)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    main()
