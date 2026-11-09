# dsh-pipeline

DSH Web UI 插件：把「从 GitHub 拉取源码 → 校验 → 打包 → 安装」固化为一次操作。

## 架构

- `src/host.js`：注册 DSH 标准 loopback RPC 通道 `/dsh-pipeline`，
  把 `validate / package / install / run / doctor` 转发给本地 CLI；
  `fetch` 由 Host 侧直接执行 `git clone`（Python CLI 保持纯本地、不联网）。
  channel 必须是**单段**（`/^[A-Za-z0-9._~-]+$/`，`/api` 为保留通道）；
  两段如 `/rpc/<name>` 会被客户端直接拒绝并报 `invalid RPC target`。
  handler 必须返回 DSH 信封 `{ ok: true, value }` 或
  `{ ok: false, error: { code, message, details } }`，抛异常只会得到 HTTP 500。
  **`rpc.handle()` 返回的是注销函数**：用 `ctx.effect(() => dispose, ...)` 把
  disposer **返回**给 cordis 收集；若写成 `effect(() => dispose())` 则 cordis
  立即执行 factory、刚注册就撤销，POST 落到静态 fallback 返回 HTTP 405。
- **注册时机**：`host.js` 导出模块级 `export const inject = ['webServer']`，
  让框架等 web carrier 就绪后再调用 `apply()`。仅在 `apply()` 内用
  `ctx.inject(['connection'], ...)` 等待并不可靠，且子 fiber 的异常会被 loader
  静默吞掉（面板可见、路由却没有 → 持续 405）。
- **双路径注册**：优先 `connection.rpc.handle()`；若 `connection` 不可用或注册
  抛错，`makeFallbackHandler()` 会用 `webServer.register()` 直接挂 prefix 路由，
  并自行实现 DSH 的 `client-request` / `server-response` 线协议。
  `apply()` 各阶段写入 `os.tmpdir()/dsh-pipeline-host-trace.log` 便于定位。
- `src/client.js`：面板，输入仓库地址 / 分支 / 子目录 / 源码目录 / profile；
  解包 RPC 信封后展示结构化结果，拉取成功后自动回填源码目录。
- `scripts/dsh_pipeline.py`：实际执行校验、打包、安装的 CLI。
- `assets/pipeline.config.json`：可编辑规则配置。
- `scripts/selftest.mjs`：离线自测（不启动 DSH），覆盖单段 channel、模块级
  inject、路径 A/B 双注册、兜底路由线协议、信封与参数校验，以及 `fetch` 的
  URL 白名单、无 shell clone、防覆盖与路由分发；共 22 项。
- 修改 `src/host.js` 后**必须完全重启 DSH 宿主**：Host 侧常驻 JS 只在启动时加载，
  Client 侧资源虽可热加载，但 RPC 路由注册不会自动重建。

> 真实路由层验证（覆盖「注册是否保持 + 真实 POST」）在配套 Skill 的
> `scripts/rpc_route_test.mjs`，需 DSH 源码仓库；已并入 `smoke_test.py` 的 T12。

## 使用

### 从 GitHub 拉取别人的插件源码

在「插件上线流水线」面板顶部填：

| 输入框 | 内容 |
|---|---|
| GitHub 仓库地址 | `https://github.com/owner/repo` 或简写 `owner/repo` |
| 分支 / 标签（可选） | 如 `main`、`v1.2.3`；留空用仓库默认分支 |
| 插件子目录（可选） | monorepo 里含 `package.json` 的那一层，如 `packages/my-plugin` |

点「拉取源码」，结果中的 `src` 会自动回填到「插件源码目录」，接着点「校验」，
再点「一键上线」即可。

默认保存位置 `~/.dsh/plugin-sources/<repo>`。只接受 `https://github.com/` 地址，
执行 `git clone --depth 1`（参数数组、无 shell、`GIT_TERMINAL_PROMPT=0`、
120 秒超时）；目标目录非空或是目录联接时拒绝写入，不会覆盖既有文件。
失败以结构化 JSON 返回，错误码为 `FETCH_BAD_URL` / `FETCH_DEST_INVALID` /
`FETCH_CLONE_FAILED` 等。该能力需要本机有 `git` 且网络可达；Python CLI 仍纯本地。

### 本地源码直接上线

填写插件源码目录与目标 profile，点击「一键上线」。也可在命令行直接运行：

```bash
python3 scripts/dsh_pipeline.py run --src <插件源码目录> \
  --config assets/pipeline.config.json --out ./dist --profile desktop
```

其他子命令：`validate` / `package` / `install` / `doctor`。
`doctor` 用于检查各 profile 下插件挂载点是否为断链。

## Python 解释器

Host 依次尝试环境变量 `DSH_PYTHON`、`python`、`python3`、`py`；
任一候选未产出结构化 JSON 就换下一个（Windows 的 `WindowsApps/python3.exe`
是商店占位程序，会正常退出但无输出）。
Windows 上若解释器不在 PATH，可设置 `DSH_PYTHON` 为绝对路径。

## 安装与重载

挂载点：`~/.dsh/profiles/<profile>/node_modules/dsh-pipeline`。
安装或更新后需**重启 DSH 宿主 / 重新加载 profile** 才会生效。
