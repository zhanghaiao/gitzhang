# DSH Web UI 插件规范（从本机真实源码提取）

本文件记录从本机 `deepseek-harness-master`、`dsh-sleep-tracker` 源码与
`~/.dsh/profiles/desktop` 实际配置中提取的规范，作为校验/打包/安装的事实依据。
不依赖猜测，也不套用其他插件体系（浏览器扩展、IDE 扩展等）。

## 1. 插件包结构（以 `dsh-sleep-tracker@0.2.8` 为基准）

```
<plugin>/
├── package.json          # 清单，必需
├── cordis.patch.yml      # bundle patch，必需（由 package.json 的 dsh.bundle.patch 指向）
├── README.md
├── src/
│   ├── host.js           # Node 侧：持久化 + loopback RPC，必需
│   └── client.js         # 浏览器侧：UI
├── scripts/
│   └── selftest.mjs      # 离线自测
└── LICENSE
```

## 2. package.json 关键字段

```json
{
  "name": "dsh-sleep-tracker",
  "version": "0.2.8",
  "type": "module",
  "main": "./src/host.js",
  "dsh": {
    "engines": { "dsh": ">=0.2.0" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-slots", "..."]
    }
  },
  "exports": {
    ".": "./src/host.js",
    "./client": "./src/client.js",
    "./package.json": "./package.json"
  },
  "scripts": { "selftest": "node ./scripts/selftest.mjs" },
  "engines": { "node": ">=18" }
}
```

关键点：
- `main` 指向 Node 侧入口；`exports` 中每个相对路径都必须真实存在。
- `dsh.bundle.patch` 是宿主挂载插件的依据，文件必须存在。
- `dsh.client.platform` 表明是 Web UI 插件；`inject` 声明依赖的客户端服务。
- 包名为 npm 风格（小写/数字/连字符，可带 scope），版本为语义化版本。

## 3. cordis.patch.yml

```yaml
- insert:
  - id: dsh-sleep-tracker
    name: 'dsh-sleep-tracker'
```
顶层为 YAML 数组，`insert` 条目中的 `id`/`name` 应与包名一致。
宿主按 `dsh.bundle.patch` 组合插件层，**不需要**改写 profile 的
`cordis.yml` 或 `cordis.patch.yml`；但 profile 的 `package.json` 必须登记该包
（见第 5 节），否则这个 patch 根本不会被读到。

## 4. 打包产物

真实产物 `dsh-sleep-tracker-0.2.8.zip` 内容（扁平、无顶层目录）：
```
src/client.js
src/host.js
scripts/selftest.mjs
package.json
cordis.patch.yml
README.md
```
排除：`.git/`、`node_modules/`、`__backup*`、`__install_backup/`、临时与备份文件。
命名：`<name>-<version>.zip`。

## 5. 安装位置与方式

- profile 根目录：`~/.dsh/profiles/<profile>/`，本机已有 `desktop`、`web`、`tui`。
- 挂载点：`~/.dsh/profiles/<profile>/node_modules/<name>`。
- 本机实测两个插件均以**符号链接**挂载到源码目录：
  - `dsh-sleep-tracker -> C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-sleep-tracker`（目标存在，可用）
  - `dsh-pipeline      -> C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-plugin-pipeline`（目标不存在，断链）
- profile 目录还含 `package.json`、`cordis.yml`（空数组 `[]`）、`cordis.patch.yml`、
  `pnpm-workspace.yaml`、`pnpm-lock.yaml`。`cordis.yml` 注释明确：应修改
  `cordis.patch.yml`，而非 `cordis.yml`；插件层由 bundle patch 叠加。
- 安装前本机留有 `__backup_before_sleep_tracker` 备份目录，说明安装动作需备份。

### 5.1 注册（决定「是否真的装上」，最易漏的一步）

宿主 `packages/boot/app-boot/src/profile.ts` 的 `loadProfileDirectory()` 明确：
只遍历 `package.json` 里 `dsh.profile.bundles` 列出的包名，用 `resolveBundleDir()`
按 Node 模块解析找到 `node_modules/<name>`，读取其 `dsh.bundle.patch` 作为一层。
因此**安装 = 挂载 + 注册**，缺一不可：

```json
{
  "dependencies": {
    "dsh-pipeline": "link:C:/Users/.../dsh-plugin-pipeline"
  },
  "dsh": {
    "profile": {
      "bundles": [ "...已有插件...", "dsh-pipeline" ]
    }
  }
}
```

- `dependencies` 声明是 pnpm 与插件管理器判定「已安装 / installed」的依据；
  官方 `plugin-manager/src/operations.ts` 的 `reconcile()` 也只把新增依赖
  且有 `dsh.bundle.patch` 的包追加进 bundles。
- 之后执行 `pnpm install --lockfile-only --ignore-scripts` 同步 `pnpm-lock.yaml`，
  否则下次通过 UI 安装其它插件时，手动链接可能被重算清除。
- **只在 node_modules 建链接、不写 packages.json，等于没装**：
  宿主加载器看不到这个 bundle，表现为插件列表无此项、面板不出现。
  `doctor` 只检查链接健康度，无法发现「未注册」，所以两者都要验。
- 修改 profile `package.json` 前先备份（`package.json.bak-before-<name>`）。
- 装完必须**重启宿主 / 重新加载 profile** 才生效。

## 6. HTTP 405 的成因（本机实例）

现象：`transport failure for /dsh-pipeline/run: HTTP 405`。
成因链：插件源码目录不存在 → `node_modules/dsh-pipeline` 为断链 →
宿主无法解析并加载插件后端 → `/dsh-pipeline/run` 路由从未注册 →
Web UI 面板调用时返回 405（Method Not Allowed，常见于路由未注册/方法不匹配）。
结论：这是**插件宿主通信层**问题，与提示词、业务流程、manifest 内容无关；
换提示词无法消除。修复方式只有两条：恢复源码目录并重装，或绕开该 UI/HTTP 通道。

### 6.1 `invalid RPC target`（2026-11-07 实测，另一类通信层失败）

现象：点「一键上线」返回
`失败: connection: Invalid RPC target "/rpc/dsh-pipeline/run"`。
这是 **Client 在发 HTTP 请求之前**就抛出的本地校验错误，和 405 不是一回事：
`packages/client/connection/src/client/rpc.ts` 的 `assertTarget()` 要求
`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`，channel 只能有一个路径段，
两段 `/rpc/dsh-pipeline` 直接被拒；Host 侧 `rpc-host.ts` 的 `assertChannel()`
同样拒绝两段 channel 与保留的 `/api`。

还发现第二个契约错误：DSH handler 必须返回
`{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`
（`rpcFetchHandler` 交给 `fullResponse()` 包装），而 `rpc.call()` resolve 的也是
这个信封、不是业务对象。直接返回业务对象会让响应结构校验失败；
抛异常则 Host 回 HTTP 500 `handler failure`，Client 只看到 transport error。

修复：channel 统一为单段 `/dsh-pipeline`；Host 返回信封并把参数错误转成
可读 error；Client 解包 `r.value`。**改完 `src/host.js` 必须重启宿主** ——
Client 资源可热加载（面板文字会更新），但 Host 侧常驻 JS 不会自动重载。

## 7. 使用 `doctor` 检测此类问题

`doctor` 遍历各 profile 的 `node_modules` 链接并解析目标，列出断链插件。
本机实测结果：`desktop/dsh-pipeline` 与 `web/dsh-hello-dsh` 均为断链，
目标都落在不存在的 `dsh-plugin-pipeline` 目录下；`desktop/dsh-sleep-tracker`
与 `web/dsh-sleep-tracker` 正常。

Windows 链接识别有两个坑，脚本均已处理：
- 这些挂载点是 **junction / reparse point**（`st_file_attributes = 0x410`），
  `Path.is_symlink()` 返回 `False`，必须检查 `FILE_ATTRIBUTE_REPARSE_POINT (0x400)`。
- `os.readlink()` 返回 `\\?\C:\Users\...` 或 `/c/Users/...`，需统一归一化为
  `C:/Users/...` 后再判断目标是否存在。

## 8. Windows 安装方式降级

`os.symlink()` 在无开发者模式/管理员权限时抛 `[WinError 1314]`。
流水线优先尝试 `cmd /c mklink /J` 创建**目录联接 junction**（与现网插件一致，
且不需要管理员权限），仍失败才降级为**目录复制**（排除 `.git`、`__backup*` 等）
并发出 `LINK_FALLBACK` 警告。复制模式同样可被宿主加载，且通过清单版本比对保证幂等。

## 9. 如何验证「真的装上了」

只检查文件齐全、或直接调用 `src/host.js` 的 `makeHandler()` 都是自测，
不能证明宿主会加载。权威验证是调用宿主自己的加载器：

```js
const mod = await import('file:///D:/豆包文件/deepseek-harness-master/packages/boot/app-boot/lib/index.js')
const p = mod.loadProfileDirectory('dsh', 'C:/Users/zhang/.dsh/profiles/desktop',
                                  'D:/豆包文件/deepseek-harness-master/package.json',
                                  { userLayer: false })
console.log(p.layers.map(l => l.packageName))   // 应包含 dsh-pipeline
console.log(p.skippedBundles)                   // 不应包含 dsh-pipeline
```

`layers` 中出现该包名且不在 `skippedBundles` 里，才说明注册生效。
`skippedBundles` 里的其它条目（如版本不兼容、官方 base 包未解析）属于该 profile
既有状态，与本次安装无关。

## 10. HTTP 405 的第二个成因：cordis `effect` 被误当成「注销钩子」

现象：Client 已能发出请求（不再报 `invalid RPC target`），但 POST
`/dsh-pipeline/run` 返回 `transport failure ... HTTP 405`。

405 来自 `packages/host/webserver` 的**静态资源 fallback**：它对非 GET/HEAD
请求一律回 405。也就是说 `connection.rpc.handle()` 注册的 prefix 路由**没有生效**。
逐层排查后确认不是没安装，也不是没重启，而是代码写法：

```js
// 错误：handle() 返回的是注销函数，effect 会立即执行 factory → 刚注册就撤销
const dispose = connection.rpc.handle(channel, handler)
cctx.effect(() => { if (typeof dispose === 'function') dispose() }, 'rpc channel')

// 正确：handle() 内部已用 owner.effect() 绑定生命周期，不要再包一层
connection.rpc.handle(channel, handler)
```

依据：
- `rpc-host.ts` 的 `register()`：
  `return owner.effect(() => owner.webServer.register(route), ...)` —— 注册发生在
  `handle()` 调用时，返回值是移除该路由的 disposer；生命周期由 Connection 服务
  的 owner context 管理，调用方无需、也不应再管理。
- `vendor/cordis/lib/index.js` 的 `_execute()`：
  `const effect = runner.execute.call(this)` **立即执行** factory，
  `if (typeof effect === 'function') return runner.collect(effect)` 把返回值收为 disposer。

**测试盲区**：此前所有冒烟用例都直接调用 `makeHandler()`，从不执行 `apply()`，
因此「注册是否被立即撤销」完全没被覆盖。修复方式是用 DSH 真实的
`Context` + `HostConnectionService` + fake `webServer` 挂载插件 `apply()`，
检查 prefix 路由是否仍在 routes 中，并对该路由发真实 RPC POST 断言
HTTP 200 + `{ type:'server-response', result:{ ok:true, value } }`。
脚本：`scripts/rpc_route_test.mjs`（5 项），并已并入 `smoke_test.py` 的 T12。

顺带加固：Windows 上 `python3` 可能解析到 `WindowsApps` 的商店占位程序
（正常退出但无 stdout）。Host 的 `pythonCandidates()` 改为
`DSH_PYTHON → python → python3 → py`，且**任一候选未产出结构化 JSON 就尝试下一个**，
避免修好 405 后卡在「CLI 无有效输出」。

## 11. 修好 effect 之后仍然 405：注册时机与 connection 依赖（最终根因）

宿主在 16:36:12 完整重启（加载的已是修复版 `host.js`），面板正常，点击仍返回
`transport failure for /dsh-pipeline/run: HTTP 405`。这次不再靠推测，直接对**运行中的
真实进程**发请求，并用第三方插件做对照：

| POST 目标 | 结果 | 含义 |
|---|---|---|
| `/index.html` | 405 | 静态 fallback 对非 GET/HEAD 一律 405 |
| `/completed-ding/foreground`（GET） | **200** | 第三方插件 Host 路由确实注册成功 |
| `/api/michengai/dsh-im-connect` | 401 | 第三方插件路由命中了认证 |
| `/dsh-pipeline/doctor`（GET） | **404** | 我们的路由一条都没挂上 |

对照 `dsh-completed-ding` 的 `index.js`：

```js
/** Wait for the Web carrier before registering routes; apply may run first on boot. */
export const inject = ['webServer'];
export function apply(ctx) { const webServer = ctx.get('webServer'); ... }
```

而旧 `host.js` **没有模块级 `inject`**，只在 `apply()` 内用
`ctx.inject(['connection'], cb)` 等 `connection`。问题有两层：

1. cordis 可能在 web carrier 就绪前就调用 `apply()`，等待 `connection` 的子 fiber
   可能一直不触发；
2. `dsh-remote/lib/http-transport.js` 的注释明确指出：**inject 子 fiber 抛出的异常
   会被 loader 捕获并记日志，父插件仍保持 ACTIVE**，失败极易被忽略 —— 正好对应
   「面板可见但路由没有」。

### 最终方案

- `host.js` 增加 `export const inject = ['webServer']`，`apply()` 直接取服务注册，
  不再嵌套等待 `connection`；
- 路径 A：`connection.rpc.handle()`，用 `ctx.effect(() => dispose, ...)` 把 disposer
  **返回**给插件 fiber（返回函数，不调用函数）；
- 路径 B（兜底）：`webServer.register({kind:'prefix', path:'/dsh-pipeline', handler})`，
  `makeFallbackHandler()` 自行实现 DSH RPC 线协议 ——
  请求 `{type:'client-request',rpcId,method,payload}`，
  响应 `{type:'server-response',rpcId,result}`，并按需调用
  `connection.requestRejection({headers})` 做认证。这条路径**完全不依赖 connection 服务**；
- 模块加载 / `apply()` / 两条注册路径均写 `os.tmpdir()/dsh-pipeline-host-trace.log`；
- `scripts/probe_live_route.py` 自动识别真实 web server 端口（靠
  `GET /index.html` 的 `dsh web authentication` 特征，排除本机其它返回 401 的服务），
  直接 POST 判定：405 = 未注册，401/200 = 已注册。

**排查方法论**：前两轮全绿却漏检，是因为自测只调 `makeHandler()`、路由层测试只模拟
`ctx.plugin()`，都没有观测**真实进程**。凡「面板可见但请求 405」，
应优先探测运行中进程的实际路由表，而不是继续读代码猜。
