---
name: dsh-plugin-pipeline
description: "This skill automates the FULL DSH Web UI plugin lifecycle: bootstrap a new plugin from an acceptance-verified template, validate manifests, package a versioned zip, mount and register into a dsh profile (desktop/web/tui), restart-check the live host RPC route, and run objective acceptance checks. The core CLI has no dependency on the plugin host Web UI or its HTTP transport. Use it whenever a DSH plugin needs to be created, checked, packed, installed, verified, or debugged, and whenever a plugin panel reports transport failure, HTTP 405, or SRC_NOT_FOUND. Triggers: DSH 插件校验, 打包插件, 安装插件, 插件上线, 从零生成插件, 固化上线流程, 手动验收, dsh-pipeline, /dsh-pipeline/run 405, SRC_NOT_FOUND, 插件断链, 一键上线."
agent_created: true
---

# DSH 插件一键上线（本地流水线）

## 概述

把 DSH Web UI 插件从源码到安装上线的全流程固化为**一条本地命令**：
`校验 → 打包 → 安装`。与插件形态的实现不同，本技能**不经过宿主的 Web UI 面板与 HTTP
transport**，因此不受 `/dsh-pipeline/run` 一类端点返回 405 的影响。
写完任何插件源码后，直接调用本技能即可上线，无需手工敲命令、逐项核对清单字段或排查路径。

平台真实规范见 `references/plugin-spec.md`（从本机 harness 源码与已安装插件提取，非推测）；
端到端闭环与实测故障决策树见 `references/acceptance-and-troubleshooting.md`。

本 Skill **自包含**：`assets/plugin-template/` 是已通过完整验收（三阶段 pass、客观核对 7/7）
的插件骨架，`scripts/bootstrap_plugin.py` 可从骨架一键生成新插件，无需依赖任何工作区里的
插件源码目录；CLI、测试脚本与规则配置均在包内。

## 何时使用

- 需要从零生成一个 DSH Web UI 插件骨架，或把已跑通的上线流程固化为可复用能力。
- 用户写完/改完一个 DSH Web UI 插件源码，需要上线到某个 profile。
- 需要单独校验 manifest、单独打包、单独安装，或三步一键跑完。
- 手动验收前后需要客观核对：真实宿主路由探测、7 项一致性检查、成功判据判定。
- 插件面板报 `transport failure`、`HTTP 405`、`SRC_NOT_FOUND`、插件不生效、疑似断链 → 先查决策树，必要时用 `doctor`。

## 标准流程

### 第 0 步之前：从零生成插件骨架（可选）

当还没有插件源码时，从包内已验收模板生成，而不是重新手写 Host/Client 契约：

```bash
python3 scripts/bootstrap_plugin.py --name dsh-my-plugin --out <父目录>
```

脚本复制 `assets/plugin-template/` 的 8 个文件，全局一致地改写
`package.json` 的 name、`cordis.patch.yml` 的 id/name、
`src/host.js` 与 `src/client.js` 的单段 RPC channel、trace 名、error code，
以及 `scripts/selftest.mjs` 中的对应断言，随后做六项一致性自检并默认执行
只读 `validate`。输出单个结构化 JSON，含 `files / checks / results`。

- `--chain none|validate|package|run`：默认 `validate`（**不安装、不改 profile**）；
  `run` 才执行完整三阶段，配合 `--skip-install` 可只做校验与打包。
- `--version` / `--title` 可覆盖版本号与面板标题。
- 拒绝覆盖已存在的非空目录；安装到真实 profile 必须显式 `--chain run --profile <name>`。

生成后仍需按业务需求改写 `src/host.js` / `src/client.js` 的业务逻辑，
但 RPC 契约、模块级 `inject`、双路径注册等易错部分已由模板固化。

> **骨架双份维护**：同一骨架既存在于 Skill 的 `assets/plugin-template/`，
> 也存在于已安装的插件源码目录（默认 `~/.dsh/profiles/desktop/node_modules/dsh-pipeline`）。
> 修改契约文件后运行 `python3 scripts/check_template_sync.py` 检查漂移；
> 确认以源码为准时加 `--sync-to-template` 显式同步模板。默认只读，退出码 1 表示不一致。

### 第 0 步：确认输入
确认插件源码目录（含 `package.json`）、目标 profile（默认 `desktop`）、
产物输出目录（默认 `./dist`）。源码目录不存在时**不要猜测路径**，先向用户确认。

### 第 1 步：诊断（若用户报告"卡住/405"）
```bash
python3 scripts/dsh_pipeline.py doctor --config assets/pipeline.config.json
```
列出所有 profile 下插件软链的健康状态。若出现 `DANGLING_SYMLINK`，
须先恢复源码目录或重新安装，否则后续任何 UI 调用都会失败。

### 第 2 步：一键跑完
```bash
python3 scripts/dsh_pipeline.py run \
  --src <插件源码目录> \
  --config assets/pipeline.config.json \
  --out <产物目录> \
  --profile desktop \
  [--skip-install] [--dry-run] [--json] [--mode link|copy]
```
三阶段串行，任一阶段出现阻断级错误立即停止，不产生半成品。
`--json` 输出结构化结果，便于上层编排。

### 分阶段调用
```bash
python3 scripts/dsh_pipeline.py validate --src <目录> --config assets/pipeline.config.json
python3 scripts/dsh_pipeline.py package  --src <目录> --out ./dist --config assets/pipeline.config.json
python3 scripts/dsh_pipeline.py install  --src <目录> --profile desktop --config assets/pipeline.config.json
```

## 各阶段行为

**校验**：清单存在且为合法 JSON；必填字段（`name/version/type/main/dsh`）齐全；
`dsh.engines`、`dsh.bundle`、`dsh.client` 存在；`main`、`exports.*`、
`dsh.bundle.patch` 指向的文件真实存在；打包必需文件齐全；包名与版本格式合法；
patch 中的 id/name 与包名一致。每条问题给出
`level / code / path / reason / fix`，阻断级错误会中止后续阶段。

**打包**：按真实产物清单生成 `<name>-<version>.zip`（扁平结构），
排除 `.git`、`node_modules`、`__backup*`、`__install_backup` 及隐藏文件（含文件名本身）；
先写进程独占临时文件、回读校验后再 `os.replace` 原子替换，
因此多进程并发写同一 `--out` 也不会互相读到半成品 zip。

**安装**：分两件事，缺一不可。

1. **挂载**：校验 profile 与 `node_modules` 存在；备份同名旧挂载；
   默认以链接挂载（Windows 优先 `mklink /J` junction，失败降级目录复制并警告）；
   安装后验证目标可解析、必要文件可读、清单 name 一致；失败自动回滚，
   且会按备份中的 `link_target.txt` 重建原有链接（不会弄丢既有挂载）。
2. **注册**（关键）：把插件登记进 profile `package.json` 的
   `dependencies`（`link:<源码绝对路径>`）与 `dsh.profile.bundles`，
   并同步 `pnpm-lock.yaml`。**宿主只加载 bundles 中列出的包**——
   仅在 `node_modules` 建链接不会被加载，表现为「插件没安上 / 面板不出现」。
   注册前自动备份 `package.json.bak-before-<name>`；读-改-写由跨进程文件锁保护，
   多个插件并发安装到同一 profile 也不会互相覆盖注册。

重复执行幂等（挂载一致且已注册则跳过）。注册失败会返回阻断级错误。
其它 profile 配置文件（`cordis.yml`、`cordis.patch.yml`）不需要改动：
插件自己的 `dsh.bundle.patch` 由宿主按 bundle 层自动加载。

**安装后必须重启 DSH 宿主 / 重新加载 profile**，新 bundle 才会被加载。
修改 `src/host.js` 后同样必须重启：Host 侧 JS 由常驻进程在启动时加载，
Client 侧资源可热加载（面板文字会更新），但 Host 的 RPC 注册不会自动重建。

### DSH loopback RPC 契约（实测踩坑记录）

来自 `packages/client/connection` 的硬约束，写插件时必须遵守：

1. **channel 必须单段**：`/^[A-Za-z0-9._~-]+$/`，且 `/api` 是保留通道。
   Host 的 `connection.rpc.handle(channel, handler)` 与 Client 的
   `connection.rpc.call(channel, endpoint, payload)` 必须用同一个单段 channel。
   两段如 `/rpc/<name>` 会在 Client **发请求之前**抛
   `connection: invalid RPC target "<channel>/<endpoint>"`；
   Host 侧 `assertChannel()` 也会拒绝注册该通道。
2. **handler 必须返回信封**：`{ ok: true, value }` 或
   `{ ok: false, error: { code, message, details } }`。
   直接返回业务对象会被 `fullResponse()` 当成失败结果、
   Client 的 `parseConnectionResponse()` 随后校验失败；
   抛异常则 Host 回 HTTP 500 `handler failure`，Client 只看到 transport error。
3. **`rpc.call()` resolve 的是信封，不是 `value`**。Client 需自行解包
   `r.ok === true ? r.value : throw new Error(r.error.message)`。
4. **`rpc.handle()` 返回的是注销函数，不要在 `ctx.effect()` 里调用它**。
   cordis 的 `effect(factory)` 会**立即执行** factory 并把返回值收为 disposer；
   写成 `ctx.effect(() => dispose())` 等于刚注册就撤销，POST 落到静态资源
   fallback（非 GET/HEAD 一律 **HTTP 405**）。正确写法是
   `ctx.effect(() => dispose, ...)`：返回 disposer 本身，由插件 fiber 管理生命周期。
   这一层只有挂载真实 `apply()` 才能发现：只调 `makeHandler()` 的自测永远全绿。
5. **必须声明模块级 `export const inject = ['webServer']`**。cordis 可能在 web
   carrier 就绪之前就调用 `apply()`；只在 `apply()` 内部用
   `ctx.inject(['connection'], ...)` 等待并不可靠——而且 inject 子 fiber 抛出的
   异常会被 loader **静默吞掉**，插件仍显示 ACTIVE，路由却根本没注册。
   已验证可用的第三方插件（`dsh-completed-ding`）都用模块级 inject 并注明
   “apply may run first on boot”。
6. **不要只依赖 `connection` 服务**。`webServer.register({kind:'prefix',
   path, handler})` 可直接挂路由；`makeFallbackHandler()` 自行实现 DSH 的 RPC
   线协议（`{type:'client-request',rpcId,method,payload}` →
   `{type:'server-response',rpcId,result}`），当 `connection` 不可用或
   `rpc.handle()` 抛错时兜底注册。这是「面板可见但一直 405」的最终防线。

本插件使用 `/dsh-pipeline`，endpoint 为 `validate/package/install/run/doctor`。
`src/host.js` 在模块加载、`apply()`、两条注册路径处写入运行时日志
（`os.tmpdir()/dsh-pipeline-host-trace.log`），可用 `scripts/probe_live_route.py`
在**不点 UI** 的情况下直接探测真实宿主进程：静态 fallback 对 POST 返回 405，
路由注册后则返回 401/200。`scripts/selftest.mjs`（13 项）、`smoke_test.py` 的
T12 与 `scripts/rpc_route_test.mjs`（真实 `HostConnectionService` 挂载后发真实 POST）
均对上述契约做了断言。

### 第 3 步：安装后冒烟测试（推荐）
```bash
python3 scripts/smoke_test.py \
  --src <插件源码目录> \
  --host-root <harness 源码根目录> \
  --work <测试产物目录> \
  --report <报告输出路径>
```
共 12 项检查：doctor 链接健康、profile 注册一致性、Node 模块解析、
宿主 `loadProfileDirectory` / `composeEntries` 真实加载、插件自检、静态语法与契约、
CLI 三阶段、loopback RPC 端到端（doctor/validate/package/run）、
隔离 profile 上的全新安装、幂等重跑、坏 manifest 负向阻断、
**T12 真实 Host 路由层**（挂载 `apply()` 后验证 prefix 路由仍在，再发真实 RPC POST
断言 HTTP 200 + DSH 信封 —— 这是 HTTP 405 的唯一可靠防线）。

单独跑路由层（需 DSH 源码仓库，用 `DSH_SRC` / `DSH_PLUGIN` 覆盖路径）：
```bash
node scripts/rpc_route_test.mjs --json
```
测试只使用 `--work/profiles/smoke` 这个隔离 profile，**不会改动 desktop/web/tui**；
退出码 0 表示全绿，同时输出结构化 `smoke_report.json`，失败时按 `cases[].detail` 定位。

**JSON 输出约定**：`--json` 模式只输出一个聚合对象（`status / stage / stages[] /
results[] / errors[] / log[]`，并保留末阶段关键字段如 `artifact_path`）。
Host 的 `parseJsonStream()` / `mergeResults()` 同时兼容旧版逐阶段多对象输出，
避免 UI 点击「打包」「一键上线」时因解析失败而误报失败；
`buildArgs()` 会拒绝非字符串 / 空的 `src`。

### 第 4 步：高强度压力冒烟测试（可选）
```bash
python3 scripts/smoke_stress_test.py \
  --src <插件源码目录> \
  --work <测试产物目录> \
  --report <报告输出路径>
```
26 项 / 6 组：**A** 循环稳定性（12 次确定性打包、10 次一键上线幂等、
40 次混合命令并发、24 个 manifest 变体矩阵）、**B** 多进程并发
（doctor/validate/package/install、双插件并发注册同一 profile）、
**C** 20 路 loopback RPC 并发 + 10 个畸形 payload、
**D** 8 类故障注入 + 断链检出/恢复 + 安装失败回滚、
**E** 中文空格路径 / 8 MB 产物 / 排除规则 / copy 模式安装、
**F** 真实 profile 零改动与全局错误预算。
全程在 `--work/profiles/*` 隔离目录执行，退出码 0 表示全绿。

### 第 5 步：人工手动验收（可选）
自动测试无法覆盖 UI 观感，需要人工在 DSH 界面点一遍。配套清单与脚本：
```bash
# 重启宿主之后，先做一次不依赖 UI 的客观探测（推荐）
python3 scripts/probe_live_route.py
#   FAIL = POST /dsh-pipeline/doctor 仍返回 405（路由没注册）
#   PASS = 返回 401/200（路由已挂上）；同时打印 Host 运行时 trace 日志
# 之后：记录基线 → 在 UI 逐项点击 → 客观核对
python3 scripts/manual_acceptance_check.py --phase before
python3 scripts/manual_acceptance_check.py --phase after
```
`probe_live_route.py` 会自动找出真实的 DSH web server 端口（靠
`GET /index.html` 的 `dsh web authentication` 特征，排除本机其它 401 服务），
再直接 POST 一次；无需点按钮即可判断 Host 侧路由是否注册成功。
若判 FAIL，先看 trace 日志：无 `MODULE_LOADED` = 模块没被导入；有
`APPLY_CALLED` 但无 `PATH_A_OK`/`PATH_B_OK` = 服务未就绪。
7 项客观核对：宿主是否真的重载、profile 三件套注册、junction 可解析、
宿主加载器含该 bundle、代码契约一致性（14 项）、UI 打包产物、真实 profile 零副作用。

**两类最常见的验收失败原因**：

1. **没有完全退出并重启宿主**：bundle 列表与 Host 侧 JS 只在宿主启动时加载，
   仅刷新界面无效；表现为路由未注册、POST 返回 405。
2. **把宿主主程序 `.exe` 填进「插件源码目录」输入框**：校验阶段直接返回
   `SRC_NOT_FOUND`，`path` 指向 `DeepSeek Harness.exe`。正确值是含
   `package.json` 的目录。调用前用 `is_dir()` + `package.json` 双重确认。

另一个易踩的坑是打包产物路径——面板的 `打包` / `一键上线` 会显式传
`--out <源码目录>/dist`，不要依赖 CLI 默认的 `./dist`（相对 Host 进程工作目录，
可能不可写）。完整决策树见 `references/acceptance-and-troubleshooting.md`。

### 第 6 步：端到端验收闭环（推荐）

完整顺序与每一步的客观判据见
`references/acceptance-and-troubleshooting.md` 第 1 节。要点：

1. 安装或改动 `src/host.js` 后，**完整退出所有 `DeepSeek Harness.exe` 再启动**。
2. 点 UI 之前先跑 `probe_live_route.py`：PASS 才继续，FAIL 先查 trace 日志。
3. UI 点「一键上线」后，成功判据必须同时满足 `status: pass`、`errors: []`、
   `stages` 三段齐全、`artifact_path` 存在且 CRC 完好。
   `actions: ["noop"]` 是**幂等跳过**（挂载与注册本已一致），不是失败。
4. 运行 `manual_acceptance_check.py --phase after`，期望 7/7 PASS，
   C6 由 SKIP 转 PASS、C7 真实 profile 零改动。
5. 最后人工目视 UI 观感（面板文案、点击响应、结果可读性）——自动测试不覆盖。

## 安全约束

- 只读用户源码，不修改、不覆盖插件源目录；产物写入独立输出目录。
- 安装前必备份；失败必回滚；`--dry-run` 只演练不落盘。
- 测试安装时使用临时 profile（`--profile-root <临时目录>`），
  **不要**在未确认时改动用户正在使用的 `desktop` profile。
- 全部规则外置在 `assets/pipeline.config.json`，平台规范变化时改配置即可，勿硬编码。
- `bootstrap_plugin.py` 默认只读（`--chain validate`），拒绝覆盖非空目录；真实安装须显式 `--chain run`。

## 资源索引

- `assets/plugin-template/` —— 已通过完整验收的插件骨架（8 个必需文件，单段 channel / 信封 / 模块级 inject / 双路径注册均已固化）
- `scripts/bootstrap_plugin.py` —— 从骨架生成新插件、一致改写标识符、可选跑到任一阶段
- `scripts/check_template_sync.py` —— 比对/显式同步「插件源码目录」与「Skill 内置模板」的 8 个文件哈希
- `scripts/dsh_pipeline.py` —— 核心 CLI（`validate/package/install/run/doctor`）
- `scripts/smoke_test.py` —— 安装后 12 项端到端冒烟测试
- `scripts/rpc_route_test.mjs` —— 真实 Host 路由层测试（HTTP 405 防线，5 项）
- `scripts/smoke_stress_test.py` —— 26 项高强度压力冒烟测试
- `scripts/probe_live_route.py` —— 直接探测运行中宿主的 RPC 路由是否注册（不点 UI）
- `scripts/manual_acceptance_check.py` —— 人工验收前的基线 / 验收后的客观核对（只读）
- `assets/pipeline.config.json` —— 可编辑规则配置
- `references/plugin-spec.md` —— DSH 插件真实规范与 405 成因分析
- `references/acceptance-and-troubleshooting.md` —— 端到端闭环、成功判据与实测故障决策树
