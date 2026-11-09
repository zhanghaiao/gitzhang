# DSH 插件上线流水线 · 使用手册

> **适用版本**：`dsh-pipeline` v1.0.0（含 2026-11-09 新增的「拉取源码」能力）
> **适用对象**：已装好插件本体、能在 DSH 侧栏看到 `↑` 面板的人。安装与获取方式见 [INSTALL.md](./INSTALL.md)。
> **本手册只讲怎么使用面板**；平台契约、验收数据与开发说明见 [README.md](./README.md)。

---

## 0. 一分钟速查

| 我要做什么 | 填哪些框 | 点哪个按钮 | 看结果里的哪个字段 |
|---|---|---|---|
| 把本地插件源码上线 | 插件源码目录、目标 profile | **一键上线** | `status: pass` + `stages: [validate, package, install]` |
| 只检查源码是否合法（不写盘） | 插件源码目录 | **校验** | `status`、`name`、`version`、`errors[]` |
| 只生成 zip（不安装） | 插件源码目录 | **打包** | `artifact_path`、`included[]` |
| 只挂载注册（不重新打包） | 插件源码目录、目标 profile | **安装** | `install_path`、`actions[]` |
| 从 GitHub 取别人的插件源码 | GitHub 仓库地址（+可选分支/子目录） | **拉取源码** | `src`（会自动回填到「插件源码目录」） |
| 插件不生效、面板报 405 | 不需要填任何框 | **断链诊断** | `broken: 0`、`links[].healthy` |

**最容易搞错的两点**：

1. 「GitHub 仓库地址」和「插件源码目录」是**两组独立输入**。URL 填到上面三个框并点「拉取源码」；本地路径填到下面两个框供其余五个按钮使用。把 URL 直接填进「插件源码目录」会得到 `SRC_NOT_FOUND`。
2. 「插件源码目录」必须是**含 `package.json` 的那一层目录**，不是仓库根目录，更不是 `DeepSeek Harness.exe` 的路径。

---

## 1. 前置条件与打开面板

| 依赖 | 要求 | 用途 |
|---|---|---|
| DSH（DeepSeek Harness） | 已安装且有可用 profile | 运行插件 |
| Python | 3.9+，命令可被调用 | 执行 `scripts/dsh_pipeline.py` |
| Git | 任意近期版本，在 PATH 中 | **仅「拉取源码」需要** |
| 网络 | 能访问 `github.com` | **仅「拉取源码」需要** |
| Node.js | 18+ | 仅运行自检脚本时需要 |

面板入口：DSH 侧栏的 `↑` 图标，标题「插件上线流水线」。主区域从上到下依次是说明文字、三个 GitHub 输入框、两个本地输入框、六个按钮、结果区。

> **生效规则**：Host 侧 JS 只在 DSH **进程启动时**加载。修改 `src/host.js`、`src/client.js` 或 profile 的 bundles 之后，必须**完全退出 DSH**（任务管理器确认 `DeepSeek Harness.exe` 全部消失）再启动；刷新页面无效。

---

## 2. 界面元素

### 2.1 输入框

| 顺序 | 标签 | 默认值 | 使用者 | 说明 |
|---|---|---|---|---|
| 1 | GitHub 仓库地址 | 空 | 拉取源码 | `https://github.com/owner/repo` 或 `owner/repo` |
| 2 | 分支 / 标签（可选） | 空 | 拉取源码 | 如 `main`、`v1.2.3`；留空用仓库默认分支 |
| 3 | 插件子目录（可选） | 空 | 拉取源码 | monorepo 中含 `package.json` 的那一层，如 `packages/my-plugin` |
| 4 | 插件源码目录 | 空 | 其余五个按钮 | 本地绝对路径；拉取成功后由结果中的 `src` 自动回填 |
| 5 | 目标 profile | `desktop` | 安装 / 一键上线 | `desktop` / `web` / `tui` |

注意：**「断链诊断」不读取任何输入框**，它扫描配置里 `profile_root` 下的所有 profile。**「校验」只读取第 4 个框**。

### 2.2 按钮

| 按钮 | RPC endpoint | 是否写盘 | 是否联网 | 前置条件 |
|---|---|---|---|---|
| 拉取源码 | `fetch` | 写 `~/.dsh/plugin-sources/` | 是 | `git` + 网络 |
| 一键上线 | `run` | 写 `dist/` 与 profile | 否 | 源码目录有效 |
| 校验 | `validate` | 否（只读） | 否 | 源码目录有效 |
| 打包 | `package` | 写 `<源码目录>/dist/` | 否 | 源码目录有效 |
| 安装 | `install` | 写 profile 注册信息 | 否 | 源码目录 + profile 有效 |
| 断链诊断 | `doctor` | 否（只读） | 否 | 无 |

「打包」和「一键上线」会把产物目录**自动设为 `<插件源码目录>/dist`**，面板不需要也不提供产物目录输入框。这样可避免 CLI 默认的相对 `./dist` 落到 DSH 安装目录（该目录可能不可写）。

---

## 3. 六个操作详解

### 3.1 拉取源码（fetch）

**输入**：第 1–3 个框。Host 侧执行 `git clone --depth 1 [--branch <ref>] <cloneUrl> <target>`，使用参数数组调用、不经过 shell、`GIT_TERMINAL_PROMPT=0`、超时 120 秒。

**支持的地址格式**：

| 写法 | 结果 |
|---|---|
| `https://github.com/owner/repo` | 默认分支，插件在仓库根 |
| `owner/repo` | 同上（简写） |
| `https://github.com/owner/repo/tree/v1.2.3` | 指定 tag；等价于第 2 框填 `v1.2.3` |
| `https://github.com/owner/repo/tree/main/packages/my-plugin` | 同时指定分支与子目录 |
| `owner/repo.git` | `.git` 后缀会被去掉 |

**保存位置**：`~/.dsh/plugin-sources/<repo>`；填了子目录时，回填的 `src` 为 `<target>/<subdir>`。

**成功返回**（关键字段）：

```json
{
  "status": "pass",
  "stage": "fetch",
  "actions": ["clone"],
  "url": "https://github.com/owner/repo.git",
  "ref": null,
  "subdir": null,
  "target": "C:\\Users\\...\\.dsh\\plugin-sources\\repo",
  "src": "C:\\Users\\...\\.dsh\\plugin-sources\\repo",
  "manifest": "...\\repo\\package.json",
  "name": "repo-plugin",
  "version": "1.0.0"
}
```

只要 `status` 不是 `fail`，面板就把 `src` 自动回填到「插件源码目录」，接着可直接点「一键上线」。

**`status: warn` 不算失败**，常见于以下三条警告码：

| 码 | 含义 | 处理 |
|---|---|---|
| `FETCH_SUBDIR_MISSING` | 填的子目录不存在 | 检查第 3 个框的拼写 |
| `FETCH_NO_MANIFEST` | 目标目录没有 `package.json` | 多为 monorepo，补填插件子目录 |
| `FETCH_BAD_MANIFEST` | `package.json` 无法解析 | 修源码或换版本 |

**安全约束**：只接受 `https://github.com/` 域名；拒绝 `http://`、非 GitHub 域名、空白与 shell 元字符、含 `..` 的路径穿越；目标目录已存在且非空、是符号链接/目录联接、或是盘符根/用户主目录时一律拒绝写入，不覆盖既有文件。

### 3.2 校验（validate）

只读检查：源码目录存在、`package.json` 可解析、必填字段齐全（`name / version / type / main / dsh`，以及 `dsh.engines / dsh.bundle / dsh.client`）、`main` 与 `exports` 与 `dsh.bundle.patch` 指向的文件存在、打包必需文件齐全（`package.json`、`cordis.patch.yml`、`src/host.js`）。

```json
{ "status": "pass", "stage": "validate", "errors": [],
  "name": "dsh-pipeline", "version": "1.0.0",
  "src": "...", "manifest": "...\\package.json" }
```

`PACKAGE_FILE_OPTIONAL_MISSING`（缺 README / selftest）与 `PATCH_ID_MISMATCH` 是**非阻断警告**，仍可继续打包。任何 `level: error` 的项都会让后续阶段中止。

### 3.3 打包（package）

生成版本化 zip 到 `<源码目录>/dist/<name>-<version>.zip`；采用临时文件 + 原子替换，写入后回读校验 CRC。

```json
{ "status": "pass", "stage": "package",
  "artifact_path": "...\\dist\\dsh-pipeline-1.0.0.zip",
  "included": ["package.json", "cordis.patch.yml", "README.md",
               "src/host.js", "src/client.js", "scripts/selftest.mjs",
               "scripts/dsh_pipeline.py", "assets/pipeline.config.json"] }
```

打包会排除 `.git`、`node_modules`、`__pycache__`、隐藏文件、备份目录与上次产物；不会把 `dist/` 递归打进包里。

### 3.4 安装（install）

把源码挂载到 `<profile_root>/<profile>/node_modules/<name>`（Windows 优先用目录联接 junction，失败自动降级为复制），并写入 profile 三件套：`package.json` 的 `dependencies`、`dsh.profile.bundles`、`pnpm-lock.yaml`。

```json
{ "status": "pass", "stage": "install",
  "install_path": "C:\\Users\\...\\.dsh\\profiles\\desktop\\node_modules\\dsh-pipeline",
  "actions": ["noop"],
  "log": ["已挂载且目标一致，跳过挂载：...", "已注册：dsh-pipeline 已在 dependencies 与 dsh.profile.bundles 中"] }
```

**`actions: ["noop"]` 是成功**，表示挂载目标一致且注册已存在，流水线幂等跳过写入。首次安装时 `actions` 应包含 `junction`（或 `symlink` / `copy`）、`register_dependency`、`register_bundle`、`lockfile_updated`。

> 安装写入的是**目标插件**的注册信息，不会改动流水线插件自身的配置；`noop` 命中时 `desktop` 的 `package.json` / `pnpm-lock.yaml` 哈希保持不变。

### 3.5 一键上线（run）

顺序执行 `validate → package → install`，前一步失败即中断。结果是一个**聚合对象**：顶层保留末阶段字段，并把中间阶段的关键字段（`artifact_path` 等）提升上来。

```json
{
  "status": "pass",
  "stage": "install",
  "stages": ["validate", "package", "install"],
  "results": [ { "status": "pass", "stage": "validate", "...": "..." },
               { "status": "pass", "stage": "package", "...": "..." },
               { "status": "pass", "stage": "install", "...": "..." } ],
  "errors": [],
  "log": [ "..." ],
  "artifact_path": "...\\dist\\dsh-pipeline-1.0.0.zip",
  "install_path": "...\\node_modules\\dsh-pipeline",
  "actions": ["noop"],
  "name": "dsh-pipeline",
  "version": "1.0.0"
}
```

**成功判据（四项同时满足）**：`status == "pass"`、`errors == []`、`stages` 三段齐全、`results` 三段各自 `pass`。

### 3.6 断链诊断（doctor）

扫描 `~/.dsh/profiles/*/node_modules` 下的所有链接，报告是否有指向已失效源码目录的挂载。**不读取任何输入框**。

```json
{ "status": "pass", "stage": "doctor",
  "broken": 0,
  "links": [ { "profile": "desktop", "plugin": "dsh-pipeline",
               "target": "...", "resolved": "...", "healthy": true } ] }
```

`broken > 0` 时返回 `status: fail`，并给出 `DANGLING_SYMLINK`；断链会让宿主加载不到后端，面板调用常表现为 HTTP 405。处理方式是重建源码目录，或删除该链接后重新点「安装」。

---

## 4. 结果 JSON 字段字典

| 字段 | 类型 | 含义 | 出现于 |
|---|---|---|---|
| `status` | `pass` / `warn` / `fail` | 总状态；任一下级 `fail` 即 `fail`，否则有 `warn` 则 `warn` | 全部 |
| `stage` | string | 当前（末）阶段 | 全部 |
| `stages` | string[] | 已执行的阶段序列 | `run`，或聚合后的单阶段结果 |
| `results` | object[] | 各阶段明细 | `run` |
| `errors` | object[] | 诊断项 | 全部 |
| `log` | string[] | 人类可读执行日志 | 全部 |
| `actions` | string[] | 实际执行的写动作 | `fetch` / `install` / `run` |
| `name` / `version` | string | 从 `package.json` 读出 | `validate` / `package` / `run` / `fetch` |
| `src` | string | 可安装的源码目录 | `validate` / `run` / `fetch` |
| `manifest` | string | 清单文件路径 | `validate` / `run` / `fetch` |
| `artifact_path` | string | 打包产物路径 | `package` / `run` |
| `included` | string[] | 产物内文件清单 | `package` / `run` |
| `install_path` | string | 挂载目标路径 | `install` / `run` |
| `broken` | number | 断链数量 | `doctor` |
| `links[]` | object[] | 各链接的 `profile` / `plugin` / `target` / `resolved` / `healthy` | `doctor` |
| `url` / `ref` / `subdir` / `target` | string / null | clone 来源与落点 | `fetch` |
| `raw` / `stderr` | string | CLI 无结构化输出时的原始输出 | 异常兜底 |

`errors[]` 每项结构固定：

```json
{ "level": "error", "code": "SRC_NOT_FOUND", "path": "...",
  "reason": "源码目录不存在或不是目录", "fix": "确认路径；..." }
```

`level: warn` 不阻断流程；`level: error` 会中止 `run` 的后续阶段。

---

## 5. 典型工作流

### 工作流 A：本地已有插件源码 → 上线

1. 「插件源码目录」填含 `package.json` 的目录，例如 `C:\Users\zhang\WorkBuddy\...\dsh-pipeline`。
2. 「目标 profile」保持 `desktop`。
3. 先点 **校验**，确认 `status: pass` 且 `name` / `version` 正确。
4. 点 **一键上线**。
5. 核对四项成功判据；记录 `artifact_path` 与 `install_path`。
6. 若这是首次安装或改过 `host.js` / `client.js`，**完全退出并重启 DSH**。

### 工作流 B：从 GitHub 拉别人的插件 → 上线

1. 「GitHub 仓库地址」填 `https://github.com/owner/repo`（或 `owner/repo`）。
2. 需要固定版本就填「分支 / 标签」；插件在 monorepo 子目录时填「插件子目录」。
3. 点 **拉取源码**。成功时 `src` 自动回填；若为 `warn`，按 `FETCH_*` 警告码调整第 3 个框后重试（目标目录非空时需先手动清理）。
4. 点 **校验**：第三方插件常返回 `status: warn`（缺 README / selftest），属非阻断；出现 `level: error` 则不要安装，先审源码。
5. 建议先审查 `LICENSE`、`package.json` 的 `scripts`、`src/host.js` 的网络请求与文件写入。
6. 想更安全，先装到隔离 profile：把「目标 profile」改成测试用名称，或用命令行的 `--profile-root`。
7. 确认无误后点 **一键上线**，然后**完全重启 DSH**。

> 本机若无法访问 GitHub，会返回 `FETCH_CLONE_FAILED`。此时按 [INSTALL.md](./INSTALL.md) 的方式在别处下载源码并解压，把本地目录填进「插件源码目录」，从工作流 A 第 3 步继续。

### 工作流 C：指定 tag 的 monorepo 插件

```
GitHub 仓库地址 : https://github.com/owner/monorepo
分支 / 标签     : v2.1.0
插件子目录      : packages/dsh-widget
```

等价于直接填 `https://github.com/owner/monorepo/tree/v2.1.0/packages/dsh-widget`（URL 形式里的 ref / subdir 会被自动解析）。回填的 `src` 为 `<target>\packages\dsh-widget`。

### 工作流 D：面板点不动 / 返回 405 / 插件不生效

1. 点 **断链诊断**：`broken: 0` 且对应 `links[].healthy: true` 为正常；否则按提示重建挂载。
2. 若出现 `Invalid RPC target` 或 HTTP 405，多为插件用了两段式 channel 的旧版代码；换用本仓库的 `plugin/src/`。
3. 若路由完全未注册，运行 `probe_live_route.py`（见第 9 节）判断是路由问题还是鉴权问题：POST 返回 **401** 表示路由存在且被鉴权拦截，属正常；返回 **405** 才是未注册。
4. 修改过 `host.js` / `client.js` 后，**刷新页面无效**，必须完全退出进程再启动。

---

## 6. 错误码速查

### 6.1 Host / 参数层

| 码 / 现象 | 原因 | 处理 |
|---|---|---|
| `dsh-pipeline/invalid-arguments`：「缺少参数 src…」 | 第 4 个框为空或不是字符串 | 填本地源码目录 |
| `dsh-pipeline/unknown-endpoint` | 调用了不存在的 endpoint | 升级插件到当前版本 |
| `dsh-pipeline/handler-failure` / `gateway/bad-request` | RPC 线协议异常 | 重启 DSH；仍报错看 trace 日志 |
| 面板显示「未找到可用的 Python 解释器」 | `python` / `python3` / `py` 都不可用 | 设置环境变量 `DSH_PYTHON` 指向 python.exe，然后重启 DSH |
| 结果里只有 `raw` / `stderr` | CLI 未产生结构化输出 | 多为解释器是商店占位程序；同上用 `DSH_PYTHON` 指定 |

### 6.2 拉取源码

| 码 | 原因 | 处理 |
|---|---|---|
| `FETCH_BAD_URL` | 地址为空、非 https、非 github.com、含非法字符或 `..` | 改用标准地址 |
| `FETCH_BAD_REF` / `FETCH_BAD_SUBDIR` | 分支或子目录含非法字符 | 去掉空格、`..`、前导 `/` |
| `FETCH_DEST_INVALID` | 目标已存在且非空、是链接/junction、或保存目录是根目录 | 换目标或先手动清理；插件不会替你删除 |
| `FETCH_DEST_IO` | 目录创建/清理失败 | 检查权限与占用 |
| `FETCH_CLONE_FAILED` | `git` 缺失、网络/证书/代理问题、仓库不存在或私有 | 看 `errors[].message` 末尾的 git stderr；或改用工作流 A |
| `FETCH_SUBDIR_MISSING` / `FETCH_NO_MANIFEST` / `FETCH_BAD_MANIFEST` | 非阻断警告 | 校正子目录或换版本 |

### 6.3 校验 / 打包 / 安装 / 诊断

| 码 | 阶段 | 处理 |
|---|---|---|
| `SRC_NOT_FOUND` | validate | 路径填错（最常见是填成了 exe 或 URL），或目录已移动 |
| `MANIFEST_MISSING` / `MANIFEST_INVALID_JSON` | validate | 指向含 `package.json` 的那一层；修 JSON 语法 |
| `FIELD_MISSING` / `FIELD_INVALID` / `DSH_FIELD_MISSING` | validate | 补齐清单必填字段；`name` 用小写连字符、`version` 用 `x.y.z` |
| `ENTRY_NOT_FOUND` / `EXPORT_NOT_FOUND` / `PATCH_NOT_FOUND` | validate | 修正 `main` / `exports` / `dsh.bundle.patch` 的相对路径 |
| `PACKAGE_FILE_MISSING` | validate / package | 缺 `package.json`、`cordis.patch.yml`、`src/host.js` 之一 |
| `PACKAGE_FILE_OPTIONAL_MISSING` / `PATCH_ID_MISMATCH` | validate（warn） | 非阻断，可继续 |
| `PACKAGE_WRITE_FAILED` / `PACKAGE_VERIFY_FAILED` | package | 检查 `dist/` 权限、磁盘空间、文件占用 |
| `PROFILE_NOT_FOUND` / `NODE_MODULES_MISSING` | install | profile 名写错或目录不是有效 DSH profile |
| `REGISTER_FAILED` / `INSTALL_FAILED` | install | 检查 profile 下文件权限；Windows 上必要时用管理员终端 |
| `PROFILE_MANIFEST_BAD` / `PROFILE_MANIFEST_MISSING` | install | profile 的 `package.json` 损坏或不存在 |
| `LOCKFILE_UPDATE_FAILED` / `LOCKFILE_UPDATE_SKIPPED` / `LINK_FALLBACK` | install（warn） | 非阻断；junction 失败时已降级为复制 |
| `PROFILE_ROOT_MISSING` / `DANGLING_SYMLINK` | doctor | profile 根目录不存在 / 存在断链，按 `fix` 字段重建 |

---

## 7. 默认行为与安全边界

- **只读优先**：`校验`、`断链诊断` 不写任何文件；只有 `打包`、`安装`、`一键上线`、`拉取源码` 会写盘。
- **幂等**：重复安装返回 `noop`，不重复创建备份、不覆盖已一致的挂载。
- **配置固定**：面板使用插件自带的 `assets/pipeline.config.json`；要改规则需编辑该文件（或走命令行的 `--config`）。
- **CLI 离线**：Python CLI 不发起任何网络请求；网络行为只存在于 Host 侧的 `fetch`。
- **通信范围**：面板通过单段 RPC channel `/dsh-pipeline` 与本机 Host 通信，路由只接受 loopback；探测时返回 401 属鉴权正常，不是故障。
- **拉取防护**：GitHub 域名白名单、无 shell 参数数组、120 秒超时、禁止覆盖非空目录/链接、禁止路径穿越。
- **第三方代码风险**：流水线只做结构校验，不做安全审计。安装他人插件前请自行审查源码。

---

## 8. 命令行等价用法

面板只是本地 CLI 的一层封装。CLI 位置：`<插件源码目录>/scripts/dsh_pipeline.py`。

```bash
CLI=<插件源码目录>/scripts/dsh_pipeline.py
CFG=<插件源码目录>/assets/pipeline.config.json
SRC=<待上线插件源码目录>

python "$CLI" validate --src "$SRC" --config "$CFG" --json
python "$CLI" package  --src "$SRC" --config "$CFG" --out "$SRC/dist" --json
python "$CLI" install  --src "$SRC" --config "$CFG" --profile desktop --json
python "$CLI" run      --src "$SRC" --config "$CFG" --out "$SRC/dist" --profile desktop --json
python "$CLI" doctor   --config "$CFG" --json
```

| 参数 | 说明 |
|---|---|
| `--src` | 插件源码目录；`doctor` 不需要 |
| `--out` | 产物目录；`package` / `run` 有效，默认 `./dist` |
| `--profile` | 目标 profile；`install` / `run` 有效，默认 `desktop` |
| `--profile-root` | 覆盖 profile 根目录，可指向隔离目录做安全试装 |
| `--config` | 规则配置文件 |
| `--mode link\|copy` | 安装方式，默认 `link` |
| `--skip-install` | `run` 只做校验 + 打包，不安装 |
| `--dry-run` | 安装阶段演练，不实际写入 |
| `--json` | 输出**单个聚合 JSON 对象** |

> `fetch` **没有** CLI 子命令，它只存在于 Host 侧。命令行下请直接用 `git clone --depth 1 <url> <dir>`，再把目录交给 `run`。

---

## 9. 自检与排障工具

| 工具 | 命令 | 期望 |
|---|---|---|
| 插件自检 | `node <插件源码目录>/scripts/selftest.mjs` | `自检通过：22 项` |
| 路由层测试 | `node <Skill目录>/scripts/rpc_route_test.mjs --json` | 5/5 PASS |
| 运行中宿主探测 | `python <Skill目录>/scripts/probe_live_route.py` | 结论 PASS；POST 返回 401 而非 405 |
| 客观验收核对 | `python <Skill目录>/scripts/manual_acceptance_check.py --phase after` | 共 7 项；全绿需满足两个时序条件：DSH 已重启（C1）、UI 打包产物生成于重启之后（C6） |
| 模板一致性 | `python <Skill目录>/scripts/check_template_sync.py` | 8/8 一致 |

运行时日志：Windows 为 `%TEMP%\dsh-pipeline-host-trace.log`，其它系统为 `os.tmpdir()/dsh-pipeline-host-trace.log`。其中 `MODULE_LOADED` / `APPLY_CALLED` / `PATH_A_OK` / `PATH_B_OK` 可判断 Host 是否真的加载并注册了路由。

> `manual_acceptance_check.py` 是作者本机的验收记录脚本，含写死的绝对路径，其他人不需要运行。详见 [INSTALL.md](./INSTALL.md) 第 4 节。

---

## 10. FAQ

**Q：点「一键上线」返回 `actions: ["noop"]`，是不是没装上？**
A：不是。表示挂载目标一致、注册已存在，是幂等跳过。判断成功看 `status` / `errors` / `stages` / `results`，不要看 `actions` 是否为空。

**Q：结果框显示 `status: warn`，能继续吗？**
A：能。`warn` 只来自 `level: warn` 的诊断项（如缺可选文件、拉取时子目录无清单）。`fail` 才阻断。

**Q：为什么点按钮报 401？**
A：面板内部不会报 401；401 通常出现在用脚本直接探测路由且未带鉴权时，说明**路由已注册**，属正常。真正的问题是 405（未注册）。

**Q：改了插件代码，刷新页面后面板没变？**
A：Host 侧 JS 只在进程启动时加载。完全退出 DSH（确认所有 `DeepSeek Harness.exe` 消失）再启动。

**Q：产物 zip 去哪了？**
A：`<插件源码目录>/dist/<name>-<version>.zip`。面板已显式指定该目录，不会落到 DSH 安装目录。

**Q：能把 GitHub 链接直接填进「插件源码目录」吗？**
A：不能，会得到 `SRC_NOT_FOUND`。链接填到「GitHub 仓库地址」并点「拉取源码」；或手动下载后填本地目录。

**Q：「目标 profile」该填什么？**
A：与 DSH 实际使用的 profile 名一致，默认 `desktop`。填错会得到 `PROFILE_NOT_FOUND`。

**Q：想试装又怕改坏现有 profile？**
A：命令行用 `--profile <名字> --profile-root <临时目录>` 指向隔离 profile；面板只能按名字选择，不能覆盖根目录。

---

## 11. 文档索引

| 文档 | 内容 |
|---|---|
| [README.md](./README.md) | 项目概览、目录结构、平台契约、验收结论 |
| [INSTALL.md](./INSTALL.md) | 别人如何获取与安装 Skill / 插件本体、脚本可移植性 |
| **本手册** | 面板六个操作、结果字段、错误码、典型工作流 |
| `skill/SKILL.md` | WorkBuddy Skill 的触发条件与完整流程 |
| `acceptance/` | 各阶段客观证据报告与最终归档版手动验收清单 |

沿用仓库根目录的 MIT 许可证。
