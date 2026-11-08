#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh_pipeline.py —— DSH Web UI 插件「校验 → 打包 → 安装」本地流水线

设计要点：纯本地 CLI，不经过插件宿主 Web UI / HTTP transport，
因此不受 /dsh-pipeline/run 一类端点 405 的影响。

子命令：
  validate  --src <源码目录>                     只校验
  package   --src <源码目录> [--out <输出目录>]   只打包
  install   --src <源码目录> [--profile desktop] [--mode link|copy]  只安装
  run       --src <源码目录> ...                 一键串联三步
  doctor    [--profile-root <目录>]              诊断已安装插件的断链

通用参数：
  --config <json>     规则配置（缺省用内置默认 + assets/pipeline.config.json）
  --json              输出结构化 JSON 结果
  --skip-install      run 时跳过安装阶段
  --dry-run           install 只演练不落盘

退出码：0 通过 / 1 存在阻断级错误 / 2 参数或环境错误
"""
import sys, os, re, json, shutil, zipfile, argparse, subprocess, time
from pathlib import Path
from datetime import datetime

DEFAULT_CONFIG = {
    "manifest": "package.json",
    "required_fields": ["name", "version", "type", "main", "dsh"],
    "required_dsh_fields": ["engines", "bundle", "client"],
    "package_files": [
        "package.json", "cordis.patch.yml", "README.md",
        "src/host.js", "src/client.js", "scripts/selftest.mjs",
    ],
    "required_package_files": ["package.json", "cordis.patch.yml", "src/host.js"],
    "package_dirs": ["scripts", "assets"],
    "exclude_names": [".git", "node_modules", ".DS_Store", "__install_backup", ".workbuddy"],
    "exclude_prefixes": ["__backup", "."],
    "profile_root": "~/.dsh/profiles",
    "default_profile": "desktop",
    "install_mode": "link",
    "artifact_dir": "./dist",
    # DSH 宿主只加载 dsh.profile.bundles 里列出的包，光挂载 node_modules 不等于安装
    "register_bundle": True,
    "update_lockfile": True,
}

SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.\-]+)?$")
PKG_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")


def expand(p):
    return Path(os.path.expanduser(str(p)))


def normalize_win_link(s):
    """归一化 Windows 上三种链接目标写法：
    \\\\?\\C:\\Users\\...  (junction/reparse point 的 os.readlink 结果)
    /c/Users/...          (Git Bash 创建的软链)
    C:/Users/...          (标准路径)
    """
    s = str(s).replace("\\", "/")
    if s.startswith("//?/"):
        s = s[4:]
    m = re.match(r"^/([a-zA-Z])/(.*)$", s)
    if m:
        return f"{m.group(1).upper()}:/{m.group(2)}"
    return s


FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def is_link(p):
    """同时识别标准 symlink 与 Windows junction / reparse point。
    Git Bash 在 Windows 创建的目录链接是 junction，Path.is_symlink() 会返回 False。"""
    if p.is_symlink():
        return True
    try:
        st = p.lstat()
        return bool(getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT)
    except OSError:
        return False


def remove_link(p):
    """删除链接本身，不触碰其目标目录内容。"""
    try:
        p.unlink()
    except OSError:
        os.rmdir(str(p))


def diag(level, code, path, reason, fix):
    return {"level": level, "code": code, "path": path, "reason": reason, "fix": fix}


def load_config(path):
    cfg = dict(DEFAULT_CONFIG)
    if path:
        p = expand(path)
        if not p.is_file():
            raise FileNotFoundError(f"配置文件不存在：{p}")
        cfg.update(json.loads(p.read_text(encoding="utf-8")))
    return cfg


def make_result(stage, status, errors=None, **kw):
    r = {"status": status, "stage": stage, "errors": errors or [], "log": []}
    r.update(kw)
    return r


# --------------------------------------------------------------------------
# 1. 校验
# --------------------------------------------------------------------------
def validate(src, cfg):
    d = []
    src = expand(src)
    if not src.is_dir():
        d.append(diag("error", "SRC_NOT_FOUND", str(src), "源码目录不存在或不是目录",
                      "确认路径；注意日期/拼写，DSH 插件源码通常在 WorkBuddy/<时间戳>/<插件名> 下"))
        return make_result("validate", "fail", d), None

    mf = src / cfg["manifest"]
    if not mf.is_file():
        d.append(diag("error", "MANIFEST_MISSING", str(mf), "缺少清单文件",
                      f"在源码根目录创建 {cfg['manifest']}"))
        return make_result("validate", "fail", d), None
    try:
        pkg = json.loads(mf.read_text(encoding="utf-8"))
    except Exception as e:
        d.append(diag("error", "MANIFEST_INVALID_JSON", str(mf), f"JSON 解析失败：{e}",
                      "修正 JSON 语法（尾逗号、注释、引号）"))
        return make_result("validate", "fail", d), None

    for f in cfg["required_fields"]:
        if f not in pkg or pkg[f] in (None, "", [], {}):
            d.append(diag("error", "FIELD_MISSING", str(mf),
                          f"清单缺少必填字段 {f}", f"补充 \"{f}\" 字段"))

    name = pkg.get("name", "")
    ver = pkg.get("version", "")
    if name and not PKG_NAME.match(str(name)):
        d.append(diag("error", "FIELD_INVALID", str(mf), f"name 不符合 npm 包名规范：{name}",
                      "使用小写字母/数字/连字符，如 dsh-my-plugin"))
    if ver and not SEMVER.match(str(ver)):
        d.append(diag("error", "FIELD_INVALID", str(mf), f"version 不是语义化版本：{ver}",
                      "改为 x.y.z，如 0.1.0"))

    dsh = pkg.get("dsh") or {}
    for f in cfg["required_dsh_fields"]:
        if f not in dsh:
            d.append(diag("error", "DSH_FIELD_MISSING", str(mf),
                          f"缺少 dsh.{f}", f"补充 dsh.{f}（DSH 宿主依赖该字段挂载插件）"))

    # 入口与导出路径
    def check_rel(rel, code, label):
        if not rel:
            return
        rel = str(rel).lstrip("./")
        target = src / rel
        if not target.exists():
            d.append(diag("error", code, str(target), f"{label} 指向的文件不存在：{rel}",
                          "修正相对路径，或补建该文件；路径以源码根目录为基准"))

    check_rel(pkg.get("main"), "ENTRY_NOT_FOUND", "main")
    for key, rel in (pkg.get("exports") or {}).items():
        if isinstance(rel, str):
            check_rel(rel, "EXPORT_NOT_FOUND", f"exports.{key}")
    patch = (dsh.get("bundle") or {}).get("patch")
    check_rel(patch, "PATCH_NOT_FOUND", "dsh.bundle.patch")

    # 打包清单文件
    for rel in cfg["required_package_files"]:
        if not (src / rel).exists():
            d.append(diag("error", "PACKAGE_FILE_MISSING", str(src / rel),
                          f"打包必需文件缺失：{rel}", "补建该文件；DSH 安装后宿主会读取它"))
    for rel in cfg["package_files"]:
        if rel not in cfg["required_package_files"] and not (src / rel).exists():
            d.append(diag("warn", "PACKAGE_FILE_OPTIONAL_MISSING", str(src / rel),
                          f"建议一并打包的文件缺失：{rel}", "非阻断；确认是否确实不需要"))

    # manifest 自洽：cordis.patch.yml 中的 id 应与包名一致
    if patch and (src / str(patch).lstrip("./")).is_file():
        txt = (src / str(patch).lstrip("./")).read_text(encoding="utf-8", errors="ignore")
        if name and name not in txt:
            d.append(diag("warn", "PATCH_ID_MISMATCH", str(src / str(patch).lstrip("./")),
                          "patch 中未出现与包名一致的 id/name", "在 insert 条目中填写 id 与 name 为包名"))

    has_error = any(x["level"] == "error" for x in d)
    status = "fail" if has_error else ("warn" if d else "pass")
    meta = {"name": name, "version": ver, "src": str(src), "manifest": str(mf)}
    return make_result("validate", status, d, **meta), meta


# --------------------------------------------------------------------------
# 2. 打包
# --------------------------------------------------------------------------
def package(src, out, cfg, meta):
    d = []
    src = expand(src)
    outdir = expand(out)
    outdir.mkdir(parents=True, exist_ok=True)
    name, ver = meta["name"], meta["version"]
    artifact = outdir / f"{name}-{ver}.zip"
    # 并发安全：每个进程写自己的临时文件，回读校验通过后再原子替换目标。
    # 直接写最终路径会让并发进程互相读到半成品 zip（PACKAGE_VERIFY_FAILED）。
    tmp_artifact = outdir / f".{artifact.name}.{os.getpid()}.tmp"

    included, missing, seen = [], [], set()
    for rel in cfg["package_files"]:
        p = src / rel
        if p.is_file():
            included.append((rel, p))
            seen.add(rel.replace("\\", "/"))
        elif rel in cfg["required_package_files"]:
            missing.append(rel)
    # 递归纳入可配置目录（如 scripts/ 下的 CLI、assets/ 下的规则配置），
    # 保证插件运行时依赖被一并打包，避免装上去后找不到文件。
    for extra_dir in cfg.get("package_dirs", []):
        base = src / extra_dir
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file():
                continue
            parts = p.relative_to(src).parts
            if any(part in cfg["exclude_names"] or
                   any(part.startswith(pre) for pre in cfg["exclude_prefixes"])
                   for part in parts):  # 含文件名本身，隐藏文件也要排除
                continue
            rel = p.relative_to(src).as_posix()
            if rel in seen:
                continue
            included.append((rel, p))
            seen.add(rel)
    if missing:
        d.append(diag("error", "PACKAGE_FILE_MISSING", str(src),
                      f"打包必需文件缺失：{', '.join(missing)}", "补齐后重试"))
        return make_result("package", "fail", d, artifact_path=str(artifact)), None

    try:
        with zipfile.ZipFile(tmp_artifact, "w", zipfile.ZIP_DEFLATED) as z:
            for rel, p in included:
                z.write(p, rel.replace("\\", "/"))
    except Exception as e:
        tmp_artifact.unlink(missing_ok=True)
        d.append(diag("error", "PACKAGE_WRITE_FAILED", str(artifact), f"写入产物失败：{e}",
                      "检查输出目录权限与磁盘空间"))
        return make_result("package", "fail", d, artifact_path=str(artifact)), None

    # 回读验证自己的临时文件，避免并发进程互相干扰
    try:
        with zipfile.ZipFile(tmp_artifact) as z:
            names = z.namelist()
            for rel in cfg["required_package_files"]:
                if rel not in names:
                    raise ValueError(f"产物缺少 {rel}")
            back = json.loads(z.read(cfg["manifest"]).decode("utf-8"))
            if back.get("name") != name or back.get("version") != ver:
                raise ValueError("产物内 manifest 与源码不一致")
    except Exception as e:
        tmp_artifact.unlink(missing_ok=True)
        d.append(diag("error", "PACKAGE_VERIFY_FAILED", str(artifact), f"回读校验失败：{e}",
                      "检查 zip 生成过程；勿手动改动产物"))
        return make_result("package", "fail", d, artifact_path=str(artifact)), None

    # 原子替换；Windows 上目标可能被其他进程短暂占用，重试若干次
    replaced = False
    for _ in range(12):
        try:
            os.replace(str(tmp_artifact), str(artifact))
            replaced = True
            break
        except OSError:
            time.sleep(0.05)
    tmp_artifact.unlink(missing_ok=True)
    if not replaced:
        d.append(diag("error", "PACKAGE_WRITE_FAILED", str(artifact),
                      "产物替换失败：目标文件被其他进程占用",
                      "稍后重试，或换一个 --out 目录"))
        return make_result("package", "fail", d, artifact_path=str(artifact)), None

    return make_result("package", "pass", d, artifact_path=str(artifact),
                       included=[r for r, _ in included]), str(artifact)


# --------------------------------------------------------------------------
# 3. 安装
# --------------------------------------------------------------------------
class _ProfileLock:
    """跨进程文件锁：保护 profile package.json 的「读-改-写」。

    两个插件并发安装到同一 profile 时，若各自基于同一份旧 manifest 写回，
    后写者会覆盖先写者的 bundle 注册，表现为「插件没安上」。
    """
    def __init__(self, pdir, timeout=15.0, stale=30.0):
        self.path = pdir / ".dsh-pipeline.register.lock"
        self.timeout = timeout
        self.stale = stale
        self.fd = None

    def __enter__(self):
        deadline = time.time() + self.timeout
        while True:
            try:
                self.fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > self.stale:
                        self.path.unlink(missing_ok=True)
                        continue
                except OSError:
                    pass
                if time.time() > deadline:
                    raise TimeoutError(f"等待 profile 注册锁超时：{self.path}")
                time.sleep(0.02)

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)
            try:
                self.path.unlink(missing_ok=True)
            except OSError:
                pass
        return False


def register_profile(pdir, src, meta, cfg, dry_run=False):
    """把插件登记进 profile 的 dependencies 与 dsh.profile.bundles。

    DSH 宿主只加载 package.json 中 dsh.profile.bundles 列出的 bundle；仅在
    node_modules 建立链接不构成安装。dependencies 声明则是 pnpm 与插件管理器
    判定「已安装」的依据。两者缺一，宿主都不会加载插件（表现为面板不出现）。
    """
    d, log, actions = [], [], []
    if not cfg.get("register_bundle", True):
        return d, log, actions

    mf = pdir / cfg["manifest"]
    name = meta["name"]
    if not mf.is_file():
        d.append(diag("warn", "PROFILE_MANIFEST_MISSING", str(mf),
                      "目标 profile 缺少 package.json，无法注册 bundle（宿主不会加载该插件）",
                      "在真实 DSH profile 中安装，或补建该 profile 的 package.json"))
        return d, log, actions
    # 读-改-写必须在跨进程锁内：并发安装时重新读取最新 manifest，
    # 否则后写者会用旧内容覆盖先写者的注册。
    with _ProfileLock(pdir):
        try:
            manifest = json.loads(mf.read_text(encoding="utf-8"))
        except Exception as e:
            d.append(diag("error", "PROFILE_MANIFEST_BAD", str(mf),
                          f"profile package.json 无法解析：{e}", "修复该文件后重试"))
            return d, log, actions

        deps = manifest.get("dependencies")
        if not isinstance(deps, dict):
            manifest["dependencies"] = deps = {}
        dsh = manifest.get("dsh")
        if not isinstance(dsh, dict):
            manifest["dsh"] = dsh = {}
        prof = dsh.get("profile")
        if not isinstance(prof, dict):
            dsh["profile"] = prof = {}
        bundles = prof.get("bundles")
        if not isinstance(bundles, list):
            prof["bundles"] = bundles = []

        link_spec = "link:" + str(src).replace("\\", "/")
        changed = False
        if deps.get(name) != link_spec:
            deps[name] = link_spec
            changed = True
            actions.append("register_dependency")
        if name not in bundles:
            bundles.append(name)
            changed = True
            actions.append("register_bundle")

        if not changed:
            log.append(f"已注册：{name} 已在 dependencies 与 dsh.profile.bundles 中")
            return d, log, actions
        if dry_run:
            log.append(f"[dry-run] 将注册 {name} 到 dependencies 与 dsh.profile.bundles")
            return d, log, actions

        bak = pdir / f"package.json.bak-before-{name}"
        try:
            if not bak.exists():
                shutil.copy2(str(mf), str(bak))
            mf.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                          encoding="utf-8")
            log.append(f"已注册 {name} → dependencies + dsh.profile.bundles（备份 {bak.name}）")
        except Exception as e:
            d.append(diag("error", "REGISTER_FAILED", str(mf), f"写入 profile 注册失败：{e}",
                          "检查 profile 目录写权限；必要时用 .bak-before- 文件恢复"))
            return d, log, actions

    if cfg.get("update_lockfile", True):
        exe = shutil.which("pnpm") or shutil.which("pnpm.cmd") or "pnpm"
        try:
            r = subprocess.run([exe, "install", "--lockfile-only", "--ignore-scripts"],
                               cwd=str(pdir), capture_output=True, timeout=180,
                               text=True, encoding="utf-8", errors="replace")
            if r.returncode == 0:
                log.append("pnpm lockfile 已同步")
                actions.append("lockfile_updated")
            else:
                d.append(diag("warn", "LOCKFILE_UPDATE_FAILED", str(pdir / "pnpm-lock.yaml"),
                              "lockfile 同步失败（不影响宿主加载）",
                              "联网后在 profile 目录执行 pnpm install --lockfile-only"))
        except Exception as e:
            d.append(diag("warn", "LOCKFILE_UPDATE_SKIPPED", str(pdir),
                          f"未同步 lockfile：{e}", "手动执行 pnpm install --lockfile-only"))
    return d, log, actions


def install(src, cfg, meta, profile, mode, dry_run=False):
    d = []
    src = expand(src).resolve()
    root = expand(cfg["profile_root"])
    pdir = root / profile
    nm = pdir / "node_modules"
    dest = nm / meta["name"]
    log = []

    def with_registration(acts, **extra):
        """挂载之后必须登记 profile，否则宿主不会加载该插件。"""
        rd, rlog, ract = register_profile(pdir, src, meta, cfg, dry_run)
        d.extend(rd)
        log.extend(rlog)
        status = "fail" if any(x.get("level") == "error" for x in rd) else "pass"
        return make_result("install", status, d, install_path=str(dest), log=log,
                           actions=acts + ract, **extra), (str(dest) if status == "pass" else None)

    if not pdir.is_dir():
        d.append(diag("error", "PROFILE_NOT_FOUND", str(pdir), "目标 profile 目录不存在",
                      "确认 profile 名称（desktop / web / tui），或先创建该 profile"))
        return make_result("install", "fail", d, install_path=str(dest)), None
    if not nm.is_dir():
        d.append(diag("error", "NODE_MODULES_MISSING", str(nm), "profile 下缺少 node_modules",
                      "确认这是有效的 DSH profile 目录"))
        return make_result("install", "fail", d, install_path=str(dest)), None

    # 幂等：已挂载且指向同一源码（含 Windows junction）
    if is_link(dest):
        try:
            target = Path(normalize_win_link(os.readlink(dest)))
            if target.resolve() == src:
                log.append(f"已挂载且目标一致，跳过挂载：{dest}")
                return with_registration(["noop"])
            log.append(f"检测到旧链接，目标不同：{target}，将备份后替换")
        except OSError:
            log.append("检测到链接但无法读取目标，将备份后替换")
    elif dest.exists() and dest.is_dir():
        # 目录复制模式的幂等：已安装同版本则跳过，避免重复安装与脏数据
        try:
            installed = json.loads((dest / cfg["manifest"]).read_text(encoding="utf-8"))
            if installed.get("name") == meta["name"] and installed.get("version") == meta["version"]:
                log.append(f"已安装同版本，跳过挂载：{dest}")
                return with_registration(["noop"])
        except Exception:
            pass
        log.append(f"检测到已存在的实体目录：{dest}，将备份后替换")
    elif dest.exists():
        log.append(f"检测到已存在的非目录项：{dest}，将备份后替换")

    if dry_run:
        log.append(f"[dry-run] 将挂载 {src} -> {dest}（mode={mode}）")
        return with_registration(["dry-run"])

    # 备份
    # 微秒级后缀避免同一秒重跑时备份目录冲突
    ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = pdir / f"__backup_pipeline_{ts}"
    actions = []
    dest_modified = False
    try:
        need_backup = is_link(dest) or dest.exists()
        if need_backup:
            backup.mkdir(parents=True, exist_ok=False)
            bdest = backup / meta["name"]
            if is_link(dest):
                try:
                    (backup / "link_target.txt").write_text(str(os.readlink(dest)), encoding="utf-8")
                except OSError:
                    pass
                remove_link(dest)
            else:
                shutil.move(str(dest), str(bdest))
            dest_modified = True
            actions.append("backup_old")

        if mode == "link":
            made = False
            try:
                os.symlink(str(src), str(dest), target_is_directory=True)
                made = True
                actions.append("symlink")
            except OSError:
                pass
            # Windows：优先 mklink /J 目录联接（无需管理员权限，与现网插件一致）
            if not made and os.name == "nt":
                try:
                    # 不用 text=True：中文 Windows 的 cmd 输出是 GBK，解码会抛异常
                    r = subprocess.run(["cmd", "/c", "mklink", "/J", str(dest), str(src)],
                                       capture_output=True)
                    if r.returncode == 0 and dest.exists():
                        made = True
                        actions.append("junction")
                        log.append("已创建目录联接（junction）")
                except Exception:
                    pass
            if not made:
                # 最后降级为目录复制
                d.append(diag("warn", "LINK_FALLBACK", str(dest),
                              "无法创建符号链接或目录联接，已降级为复制目录",
                              "如需链接挂载，检查目标目录权限；复制模式同样可被宿主加载"))
                shutil.copytree(str(src), str(dest),
                                ignore=shutil.ignore_patterns(*cfg["exclude_names"],
                                                              *[p + "*" for p in cfg["exclude_prefixes"]]))
                actions.append("copy_fallback")
        else:
            shutil.copytree(str(src), str(dest),
                            ignore=shutil.ignore_patterns(*cfg["exclude_names"],
                                                          *[p + "*" for p in cfg["exclude_prefixes"]]))
            actions.append("copy")

        # 安装后验证（关键：避免断链）
        real = Path(normalize_win_link(os.readlink(dest))) if is_link(dest) else dest
        if not real.is_dir():
            raise RuntimeError(f"挂载目标不可解析（断链）：{real}")
        for rel in ["package.json", "src/host.js"]:
            if not (real / rel).is_file():
                raise RuntimeError(f"挂载后缺少必要文件：{real / rel}")
        pkg_back = json.loads((real / "package.json").read_text(encoding="utf-8"))
        if pkg_back.get("name") != meta["name"]:
            raise RuntimeError("挂载后清单 name 不一致")
        if is_link(dest):
            log.append(f"挂载成功（链接）：{dest} -> {real}")
        else:
            log.append(f"安装成功（目录复制）：{dest}")
        backup_path = str(backup) if backup.is_dir() else ""
        if backup_path:
            log.append(f"备份位置：{backup_path}")
        return with_registration(actions, backup=backup_path)

    except Exception as e:
        d.append(diag("error", "INSTALL_FAILED", str(dest), f"安装失败：{e}",
                      "检查 profile 写权限与路径；失败已尝试回滚"))
        # 仅在已改动 dest 之后失败才回滚；备份阶段的失败不应破坏既有安装
        if not dest_modified:
            log.append("失败发生在改动安装目标之前，既有安装保持不变，无需回滚")
        else:
            try:
                if is_link(dest):
                    remove_link(dest)
                elif dest.is_dir():
                    shutil.rmtree(dest)
                elif dest.exists():
                    dest.unlink()
                # 旧挂载是链接时，备份阶段只留下了 link_target.txt（没有实体目录）。
                # 回滚必须按该文件重建链接，否则安装失败会顺带弄丢原有正常挂载。
                link_target = backup / "link_target.txt"
                if link_target.is_file() and not os.path.lexists(dest):
                    raw_target = link_target.read_text(encoding="utf-8").strip()
                    real_target = Path(normalize_win_link(raw_target))
                    restored = False
                    try:
                        os.symlink(str(real_target), str(dest), target_is_directory=True)
                        restored = is_link(dest)
                    except OSError:
                        pass
                    if not restored and os.name == "nt":
                        try:
                            r = subprocess.run(["cmd", "/c", "mklink", "/J",
                                                str(dest), str(real_target)],
                                               capture_output=True)
                            restored = r.returncode == 0 and is_link(dest)
                        except Exception:
                            pass
                    if not restored and real_target.is_dir():
                        shutil.copytree(str(real_target), str(dest))
                        restored = True
                    log.append("已按 link_target.txt 恢复原链接" if restored
                               else "警告：原链接恢复失败，请依 link_target.txt 手工重建")
                bdest = backup / meta["name"]
                if bdest.exists():
                    shutil.move(str(bdest), str(dest))
                log.append("已回滚到安装前状态")
            except Exception as re_:
                log.append(f"回滚出现异常：{re_}")
        return make_result("install", "fail", d, install_path=str(dest), log=log), None


# --------------------------------------------------------------------------
# 4. 断链诊断（针对 HTTP 405 场景）
# --------------------------------------------------------------------------
def doctor(cfg):
    root = expand(cfg["profile_root"])
    rows, broken = [], 0
    if not root.is_dir():
        return make_result("doctor", "fail",
                           [diag("error", "PROFILE_ROOT_MISSING", str(root), "profile 根目录不存在",
                                 "确认 DSH_HOME / profile_root 配置")])
    for pdir in sorted(p for p in root.iterdir() if p.is_dir()):
        nm = pdir / "node_modules"
        if not nm.is_dir():
            continue
        for item in sorted(nm.iterdir()):
            if not is_link(item):
                continue
            try:
                raw = os.readlink(item)
            except OSError:
                continue
            real = Path(normalize_win_link(raw))
            ok = real.is_dir()
            if not ok:
                broken += 1
            rows.append({"profile": pdir.name, "plugin": item.name,
                         "target": raw, "resolved": str(real), "healthy": ok})
    res = make_result("doctor", "fail" if broken else "pass", [],
                      broken=broken, links=rows)
    if broken:
        for r in rows:
            if not r["healthy"]:
                res["errors"].append(diag(
                    "error", "DANGLING_SYMLINK", r["resolved"],
                    f"[{r['profile']}] 插件 {r['plugin']} 为断链，宿主无法加载其后端",
                    "重建插件源码目录，或删除该链接后重新安装；这会导致面板调用返回 HTTP 405"))
    return res


# --------------------------------------------------------------------------
# 输出
# --------------------------------------------------------------------------
def emit(res, as_json, sink=None):
    # --json 时逐阶段结果先缓存在 sink，最后统一输出一个聚合对象。
    # 一次性输出多个 JSON 会让 RPC/HTTP 调用方（如 DSH Host）解析失败。
    if as_json:
        if sink is not None:
            sink.append(res)
        else:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        return
    tag = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}[res["status"]]
    print(f"[{tag}] stage={res['stage']}")
    for k in ("name", "version", "artifact_path", "install_path", "backup", "broken"):
        if k in res:
            print(f"  {k}: {res[k]}")
    for l in res.get("log", []):
        print(f"  · {l}")
    for e in res.get("errors", []):
        if not isinstance(e, dict):
            print(f"  (error) {e}")
            continue
        print(f"  ({e['level']}) {e['code']} @ {e['path']}")
        print(f"      {e['reason']}")
        print(f"      修复：{e['fix']}")
    if res.get("links"):
        print("  已安装软链：")
        for r in res["links"]:
            print(f"    [{'OK' if r['healthy'] else 'BROKEN'}] {r['profile']}/{r['plugin']} -> {r['target']}")


def aggregate(results):
    states = [r.get("status") for r in results]
    if "fail" in states:
        return "fail"
    if "warn" in states:
        return "warn"
    return "pass"


def flush_json(sink):
    """--json 模式只输出一个聚合对象：保留末阶段字段 + 全部阶段明细。"""
    if not sink:
        return
    summary = dict(sink[-1])
    # 中间阶段的关键字段（典型是 package 的 artifact_path）不能因聚合而丢失
    for key in ("artifact_path", "install_path", "name", "version", "src",
                "manifest", "included", "broken", "links", "actions", "backup"):
        if summary.get(key) is None:
            for r in reversed(sink[:-1]):
                if r.get(key) is not None:
                    summary[key] = r[key]
                    break
    summary["stages"] = [r.get("stage") for r in sink]
    summary["results"] = sink
    summary["status"] = aggregate(sink)
    summary["errors"] = [e for r in sink for e in (r.get("errors") or [])]
    summary["log"] = [l for r in sink for l in (r.get("log") or [])]
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser(description="DSH 插件校验/打包/安装本地流水线")
    ap.add_argument("command", choices=["validate", "package", "install", "run", "doctor"])
    ap.add_argument("--src")
    ap.add_argument("--out")
    ap.add_argument("--profile")
    ap.add_argument("--profile-root")
    ap.add_argument("--mode", choices=["link", "copy"])
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--skip-install", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        cfg = load_config(args.config)
    except Exception as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        sys.exit(2)
    if args.profile_root:
        cfg["profile_root"] = args.profile_root
    profile = args.profile or cfg["default_profile"]
    mode = args.mode or cfg["install_mode"]

    sink = [] if args.json else None

    def say(res):
        emit(res, args.json, sink)

    def finish(code):
        if args.json:
            flush_json(sink)
        sys.exit(code)

    if args.command == "doctor":
        res = doctor(cfg)
        say(res)
        finish(0 if res["status"] == "pass" else 1)

    if not args.src:
        print("[FAIL] 需要 --src <插件源码目录>", file=sys.stderr)
        sys.exit(2)

    # run：顺序执行，前一步失败即中断
    if args.command == "run":
        res, meta = validate(args.src, cfg)
        say(res)
        if res["status"] == "fail":
            finish(1)
        pres, artifact = package(args.src, args.out or cfg["artifact_dir"], cfg, meta)
        say(pres)
        if pres["status"] == "fail":
            finish(1)
        if args.skip_install:
            if not args.json:
                print("[PASS] --skip-install：已完成校验与打包，未执行安装")
            finish(0)
        ires, _ = install(args.src, cfg, meta, profile, mode, args.dry_run)
        say(ires)
        finish(0 if ires["status"] != "fail" else 1)

    res, meta = validate(args.src, cfg)
    say(res)
    if res["status"] == "fail":
        finish(1)
    if args.command == "validate":
        finish(0 if res["status"] != "fail" else 1)
    if args.command == "package":
        pres, _ = package(args.src, args.out or cfg["artifact_dir"], cfg, meta)
        say(pres)
        finish(0 if pres["status"] != "fail" else 1)
    if args.command == "install":
        ires, _ = install(args.src, cfg, meta, profile, mode, args.dry_run)
        say(ires)
        finish(0 if ires["status"] != "fail" else 1)


if __name__ == "__main__":
    main()
