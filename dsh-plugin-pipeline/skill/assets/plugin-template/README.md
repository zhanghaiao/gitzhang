# dsh-pipeline

DSH Web UI 插件：把 DSH 插件从源码到安装上线的 **校验 → 打包 → 安装** 固化为一次操作。

## 架构

- `src/host.js`：注册 DSH 标准 loopback RPC 通道 `/dsh-pipeline`，
  把 `validate / package / install / run / doctor` 转发给本地 CLI。
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
- `src/client.js`：面板，输入源码目录与 profile；解包 RPC 信封后展示结构化结果。
- `scripts/dsh_pipeline.py`：实际执行校验、打包、安装的 CLI。
- `assets/pipeline.config.json`：可编辑规则配置。
- `scripts/selftest.mjs`：离线自测（不启动 DSH），覆盖单段 channel、模块级
  inject、路径 A/B 双注册、兜底路由线协议、信封与参数校验；共 13 项。
- 修改 `src/host.js` 后**必须完全重启 DSH 宿主**：Host 侧常驻 JS 只在启动时加载，
  Client 侧资源虽可热加载，但 RPC 路由注册不会自动重建。

> 真实路由层验证（覆盖「注册是否保持 + 真实 POST」）在配套 Skill 的
> `scripts/rpc_route_test.mjs`，需 DSH 源码仓库；已并入 `smoke_test.py` 的 T12。

## 使用

在 DSH Web UI 打开「插件上线流水线」面板，填写插件源码目录与目标 profile，
点击「一键上线」。也可在命令行直接运行：

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
