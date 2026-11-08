# 端到端闭环与故障决策树（实测记录）

本文记录一次完整验收中真实出现过的失败与判据，供再次执行时直接对照。
所有结论均来自本机真实 DSH 宿主与 `desktop` profile 的实测，非推测。

## 1. 从零到上线的闭环顺序

| 步 | 动作 | 客观判据 |
|---|---|---|
| 1 | 确认输入：源码目录（含 `package.json`）、目标 profile、产物目录 | 目录真实存在；不是宿主 `.exe` |
| 2 | 生成骨架：`bootstrap_plugin.py --name <id> --out <父目录>` | `status: pass`，`checks` 六项全 true |
| 3 | 实现 `src/host.js` / `src/client.js` 业务逻辑 | `node scripts/selftest.mjs` 13 项通过 |
| 4 | `validate` | `status: pass`、`errors: []` |
| 5 | `package` | `artifact_path` 指向 `<name>-<version>.zip`，CRC 完好 |
| 6 | `install` | `install_path` 可解析；`dependencies` + `dsh.profile.bundles` + lock 三件套齐全 |
| 7 | **完全退出 DSH 宿主并重启** | 进程列表中 `DeepSeek Harness.exe` 先归零再出现 |
| 8 | `probe_live_route.py` | PASS；`POST /<channel>/doctor` 返回 401/200，而非 405 |
| 9 | UI 点「一键上线」 | `status: pass`、`stages` 三段齐全、`errors: []` |
| 10 | `manual_acceptance_check.py --phase after` | 7/7 PASS，C6 由 SKIP 转 PASS，C7 真实 profile 零改动 |
| 11 | 人工目视：面板文案、点击响应、结果可读性 | 主观判定，自动测试不覆盖 |

**关键顺序约束**：Host 侧 JS 与 bundle 列表只在宿主**启动**时加载。第 6 步之后只刷新界面无效，必须完整退出再启动；否则第 8–9 步必然失败。

## 2. 成功判据（不要只看 `status`）

一键上线成功的结构化结果应同时满足：

- `status: "pass"`、`errors: []`
- `stages: ["validate", "package", "install"]`，`results[]` 三段各自 `pass`
- `artifact_path` 存在且 zip CRC 通过、`included` 含 8 个必需文件
- `install_path` 指向 `~/.dsh/profiles/<profile>/node_modules/<name>` 且可解析
- `actions: ["noop"]` **不是失败**：表示挂载目标一致且已注册，流水线正确幂等跳过，避免破坏既有 junction 与 profile 注册

客观核对全绿样本：`C1..C7 = 7 PASS / 0 warn / 0 fail / 0 skip`，其中
C6「UI 打包产物」在点击之前为 SKIP 属正常，点击后才应转 PASS。

## 3. 故障决策树

### 3.1 `SRC_NOT_FOUND`（本次实测）

- 现象：`stage: validate`、`errors[0].code: SRC_NOT_FOUND`，`path` 形如
  `C:\...\DeepSeek Harness\DeepSeek Harness.exe`。
- 根因：面板第一个输入框要求**插件源码目录**，被误填为**宿主主程序 exe**。
- 处置：改为含 `package.json` 的目录，例如
  `C:\Users\zhang\WorkBuddy\2026-10-26-22-11-53\dsh-plugin-pipeline`；
  profile 保持 `desktop`。不需要重启，不需要改其它输入。
- 防呆：调用前用 `Path(src).is_dir()` 且 `(src / "package.json").is_file()` 双重确认。

### 3.2 HTTP 405 / `transport failure`

- 优先运行 `probe_live_route.py`：FAIL 说明路由根本没注册，不是输入问题。
- 查运行时 trace（`<tmpdir>/dsh-pipeline-host-trace.log`）：
  - 无 `MODULE_LOADED` → 模块未被导入，检查 junction 与 bundles 注册。
  - 有 `MODULE_LOADED` 无 `APPLY_CALLED` → `apply()` 未执行，检查模块级 `inject`。
  - 有 `APPLY_CALLED` 无 `PATH_A_OK`/`PATH_B_OK` → web carrier 未就绪。
  - 有 `PATH_A_OK`/`PATH_B_OK` 但仍 405 → 宿主未重启，仍在跑旧 JS。
- 代码层三个硬约束：单段 channel、handler 返回 `{ok,value}` 信封、
  `ctx.effect(() => dispose, ...)` 返回 disposer 而不是调用它。

### 3.3 `connection: invalid RPC target`

channel 写成了两段（如 `/rpc/dsh-pipeline`）。改为单段 `/dsh-pipeline`，
Host 与 Client 必须一致；`/api` 为保留通道。

### 3.4 HTTP 500 `handler failure`

handler 抛异常或未返回 DSH 信封。改为返回
`{ ok: false, error: { code, message, details } }`，Client 侧自行解包 `r.value`。

### 3.5 面板不出现 / 插件「没安上」

只建了 `node_modules` 链接而未写入 profile 注册。宿主只加载
`dsh.profile.bundles` 中列出的包。核对 `dependencies`（`link:<绝对路径>`）、
`bundles`、`pnpm-lock.yaml` 三件套，并确认该 bundle 不在 `skippedBundles`。

### 3.6 CLI 无任何结构化输出

Windows 的 `WindowsApps/python3.exe` 是商店占位程序，会正常退出但无 stdout。
Host 已按 `python → python3 → py` 依次回退；仍失败时设置 `DSH_PYTHON` 为解释器绝对路径。

### 3.7 产物路径异常 / 缺文件

面板的「打包」「一键上线」显式传 `--out <源码目录>/dist`，不要依赖 CLI 默认的
`./dist`（相对 Host 进程工作目录，可能不可写）。打包会排除
`.git`、`node_modules`、`__backup*`、隐藏文件及隐藏路径段。

## 4. 复制即用的核对命令

```bash
SKILL=C:/Users/zhang/.workbuddy/skills/dsh-plugin-pipeline
cd "$SKILL"

# 生成骨架（只读，默认只做 validate，不改任何 profile）
python scripts/bootstrap_plugin.py --name dsh-demo --out <父目录>

# 从零到上线（跳过安装，安全）
python scripts/bootstrap_plugin.py --name dsh-demo --out <父目录> --chain run --skip-install

# 真实宿主路由探测（重启后、点 UI 前）
python scripts/probe_live_route.py

# 客观核对
python scripts/manual_acceptance_check.py --phase before
python scripts/manual_acceptance_check.py --phase after

# 回归测试
python scripts/smoke_test.py --src <源码目录> --host-root <harness 源码> --work <临时目录> --report <报告>
node scripts/rpc_route_test.mjs --json
```

## 5. 安全边界

- 测试安装使用隔离 profile（`--profile-root <临时目录>`），未确认前不改动 `desktop`。
- bootstrap 拒绝覆盖任何已存在的非空目录。
- 默认 `--chain validate` 不安装、不写 profile；真实安装需显式 `--chain run`。
- `install` 前自动备份，失败自动回滚并按 `link_target.txt` 重建原有 junction。
