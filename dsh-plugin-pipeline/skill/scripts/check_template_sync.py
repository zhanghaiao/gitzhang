#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Compare the bundled plugin template against the live plugin source directory.

The acceptance-verified skeleton exists twice: as the installed plugin source
(loaded by the DSH host) and as ``assets/plugin-template/`` inside this skill
(used by bootstrap_plugin.py). After editing a contract file such as
``src/host.js`` in the source, run this script to detect drift, or pass
``--sync-to-template`` to copy the source files into the template explicitly.

Default source: ``~/.dsh/profiles/desktop/node_modules/dsh-pipeline``
(the junction resolver gives the real source path). Override with --src or the
``DSH_PLUGIN_SRC`` environment variable. Output is always a single JSON object.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "assets" / "plugin-template"
DEFAULT_SRC = Path.home() / ".dsh" / "profiles" / "desktop" / "node_modules" / "dsh-pipeline"

FILES = (
    "package.json",
    "cordis.patch.yml",
    "README.md",
    "src/host.js",
    "src/client.js",
    "scripts/selftest.mjs",
    "scripts/dsh_pipeline.py",
    "assets/pipeline.config.json",
)


def sha256(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def compare(src: Path):
    rows = []
    for rel in FILES:
        t, s = TEMPLATE / rel, src / rel
        th, sh = sha256(t), sha256(s)
        rows.append({
            "file": rel,
            "template_sha256": th,
            "source_sha256": sh,
            "same": th is not None and th == sh,
        })
    return rows


def emit(payload: dict, code: int) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    sys.exit(code)


def main() -> None:
    ap = argparse.ArgumentParser(description="Check template/source drift.")
    ap.add_argument("--src", default=os.environ.get("DSH_PLUGIN_SRC", str(DEFAULT_SRC)),
                    help="live plugin source directory")
    ap.add_argument("--sync-to-template", action="store_true",
                    help="copy source files into the bundled template (explicit, overwrites template)")
    args = ap.parse_args()

    src = Path(args.src).expanduser().resolve()
    if not TEMPLATE.is_dir():
        emit({"status": "fail", "error": f"template missing: {TEMPLATE}", "files": []}, 1)
    if not src.is_dir():
        emit({"status": "fail", "error": f"source directory missing: {src}",
              "hint": "pass --src <plugin source dir> or set DSH_PLUGIN_SRC", "files": []}, 1)

    synced = []
    if args.sync_to_template:
        for rel in FILES:
            s = src / rel
            if not s.is_file():
                continue
            t = TEMPLATE / rel
            t.parent.mkdir(parents=True, exist_ok=True)
            if sha256(t) != sha256(s):
                shutil.copy2(s, t)
                synced.append(rel)

    rows = compare(src)
    mismatched = [r["file"] for r in rows if not r["same"]]
    payload = {
        "status": "pass" if not mismatched else "fail",
        "template": str(TEMPLATE),
        "source": str(src),
        "synced": synced,
        "mismatched": mismatched,
        "files": rows,
        "summary": {"same": len(rows) - len(mismatched), "total": len(rows)},
        "hint": "Run with --sync-to-template after intentionally editing the plugin source."
                if mismatched else "Template and source are identical.",
    }
    emit(payload, 0 if not mismatched else 1)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    main()
