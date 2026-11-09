# dsh-plugin-pipeline · DSH 插件上线流水线（Skill + 插件）

把 **DSH（DeepSeek Harness）Web UI 插件从 GitHub 拉取源码 → 校验 → 版本化打包 → 挂载注册到 profile** 的完整流程固化为一条本地流水线，并进一步封装成可复用的 WorkBuddy Skill。

2026-11-08 完成端到端验收；2026-11-09 增加面板「拉取源码」能力。本目录作为独立子项目存放在 `gitzhang` 仓库中，与仓库根目录的 `dsh-sleep-tracker` 互不干扰。

## 目录结构

| 路径 | 内容 |
|---|---|
| `skill/` | WorkBuddy Skill 完整源码：SKILL.md、CLI、插件骨架模板、bootstrap、测试与验收脚本、规范文档（20 个文件） |
| `plugin/` | 已升级的 DSH 插件源码 `dsh-pipeline` v1.0.0：Host / Client、RPC 契约、自检、示例插件（含 `dist/` 打包产物） |
| `acceptance/` | 8 份客观证据报告：基线、验收前后核对、按钮判据、全新安装、分发包验证、fetch 升级验证、最终归档版手动验收清单 |
| `dist/dsh-plugin-pipeline.skill.zip` | 可分发的 Skill 压缩包（解压到 `~/.workbuddy/skills/` 即可跨设备使用） |
| `INSTALL.md` | 给其他人的完整安装说明 |

## 从 GitHub 拉取别人的插件源码

DSH 面板「插件上线流水线」顶部新增三个输入框与「拉取源码」按钮：

| 输入框 | 内容 |
|---|---|
| GitHub 仓库地址 | `https://github.com/owner/repo` 或简写 `owner/repo` |
| 分支 / 标签（可选） | 如 `main`、`v1.2.3`；留空用仓库默认分支 |
| 插件子目录（可选） | monorepo 里含 `package.json` 的那一层，如 `packages/my-plugin` |

点「拉取源码」→ 结果 JSON 中的 `src` 自动回填到「插件源码目录」→ 再点「一键上线」。

实现位于 `plugin/src/host.js` 的 `fetch` endpoint：只接受 `https://github.com/` 白名单地址，
拒绝注入字符与路径穿越；`git clone --depth 1` 使用参数数组（无 shell）、
`GIT_TERMINAL_PROMPT=0`、120 秒超时；目标目录非空或为目录联接时拒绝覆盖。
源码默认保存到 `~/.dsh/plugin-sources/<repo>`。Python CLI 保持纯本地、不联网。
该能力需要本机有 `git` 且网络可达，失败返回 `FETCH_BAD_URL` / `FETCH_DEST_INVALID` /
`FETCH_CLONE_FAILED` 等结构化错误码。

## 快速开始

```bash
# 1. 安装 Skill（跨项目可用）
unzip dist/dsh-plugin-pipeline.skill.zip -d ~/.workbuddy/skills/

# 2. 从骨架生成一个新插件（默认只读校验，不会安装）
python3 skill/scripts/bootstrap_plugin.py --name dsh-my-plugin --out ./my-plugins

# 3. 三步一键上线（显式指定 profile 才会真正安装）
python3 skill/scripts/dsh_pipeline.py run \
  --src ./my-plugins/dsh-my-plugin \
  --config skill/assets/pipeline.config.json \
  --out ./my-plugins/dsh-my-plugin/dist \
  --profile desktop --json
```

CLI 子命令：`validate` / `package` / `install` / `run` / `doctor`；所有命令支持 `--json` 输出单个聚合对象。

## 关键平台契约（易踩坑）

- RPC channel 必须是**单段** `/dsh-pipeline`，DSH 要求匹配 `^\/[A-Za-z0-9._~-]+$`；两段路径会报 `Invalid RPC target`。
- handler 必须返回信封 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`，Client 侧解包 `r.value`。
- 模块级 `export const inject = ['webServer']`；`ctx.effect()` 会立即执行 factory，不能把 `rpc.handle()` 返回的注销函数直接传进去。
- 安装三件套：profile 的 `dependencies` + `dsh.profile.bundles` + `pnpm-lock.yaml`，以及 `node_modules` 下的目录联接（Windows junction）。
- 修改 `host.js` / `client.js` 或 bundles 后必须**完全退出并重启 DSH**，仅刷新界面无效。
- 面板「插件源码目录」要填含 `package.json` 的本地目录，不是宿主 exe，也不是 GitHub URL（填 URL 会得到 `SRC_NOT_FOUND`）；URL 请填到「GitHub 仓库地址」并点「拉取源码」。

## 验收结论

| 项目 | 结果 |
|---|---|
| 插件自检 / 真实 Host 路由层 | 22/22、5/5 |
| 基础冒烟 / 高强度压力冒烟 | 12/12、26/26 |
| 手动验收客观核对 `--phase after` | 7/7 PASS，0 失败（2026-11-08） |
| A1–A8 按钮判据复核 | 9/9 PASS，真实 profile 哈希不变 |
| 隔离 profile 全新安装（非 noop 写路径） | 8/8 PASS |
| 分发包解压独立可用性 | 8/8 PASS |
| 模板与插件源码一致性 | 8/8 一致 |
| fetch 面板升级离线验证 | 10/10 PASS，C5 契约检查 18 项全过 |
| 宿主完整重启后 | 路由探测 PASS、7/7 仍全绿（2026-11-08 21:30） |

`actions: ["noop"]` 是幂等命中的正常结果，表示挂载目标一致、注册已存在，不是失败。

> 升级 `fetch` 后修改了 `plugin/src/host.js`，**必须完全退出并重启 DSH** 才会加载新按钮；
> 重启前 `manual_acceptance_check.py --phase after` 的 C1 会如预期报 FAIL。

## 说明与边界

- 文档与脚本中的 `C:\Users\zhang\...` 为本机环境的示例/默认路径，跨平台使用需按实际目录调整；不含任何令牌、密码或私钥。
- `skill/assets/plugin-template/` 与 `plugin/` 存在同源文件，修改契约文件后用 `skill/scripts/check_template_sync.py` 核对（必要时 `--sync-to-template`）。
- 模板固化的是 RPC 契约与上线流程，具体插件的业务逻辑仍需按需求改写 `src/host.js` / `src/client.js`。
- 安装默认只读：只有显式 `run`/`install` 且指定 `--profile` 才会写入 profile。
- `fetch` 依赖本机 `git` 与网络；离线环境可先在别处下载源码，再把本地目录填进面板。

## 其他人如何安装

完整安装步骤（Skill 安装、插件本体安装、常见坑、各脚本可移植性）见 [INSTALL.md](./INSTALL.md)。

沿用仓库根目录的 MIT 许可证。
