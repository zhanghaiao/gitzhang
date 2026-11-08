# dsh-plugin-pipeline · DSH 插件上线流水线（Skill + 插件）

把 **DSH（DeepSeek Harness）Web UI 插件从源码校验 → 版本化打包 → 挂载注册到 profile** 的完整流程固化为一条本地 CLI 流水线，并进一步封装成可复用的 WorkBuddy Skill。

已于 2026-11-08 完成端到端验收并归档。本目录作为独立子项目存放在 `gitzhang` 仓库中，与仓库根目录的 `dsh-sleep-tracker` 互不干扰。

## 目录结构

| 路径 | 内容 |
|---|---|
| `skill/` | WorkBuddy Skill 完整源码：SKILL.md、CLI、插件骨架模板、bootstrap、测试与验收脚本、规范文档（20 个文件） |
| `plugin/` | 已验收的 DSH 插件源码 `dsh-pipeline` v1.0.0：Host / Client、RPC 契约、自检、示例插件（含 `dist/` 打包产物） |
| `acceptance/` | 7 份客观证据报告：基线、验收前后核对、按钮判据、全新安装、分发包验证、最终归档版手动验收清单 |
| `dist/dsh-plugin-pipeline.skill.zip` | 可分发的 Skill 压缩包（解压到 `~/.workbuddy/skills/` 即可跨设备使用） |

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
- 修改 `host.js` 或 bundles 后必须**完全退出并重启** DSH，仅刷新界面无效。
- 面板第一个输入框要填**插件源码目录**（含 `package.json`），不是宿主 exe 路径；填错会得到 `SRC_NOT_FOUND`。

## 验收结论（2026-11-08）

| 项目 | 结果 |
|---|---|
| 插件自检 / 真实 Host 路由层 | 13/13、5/5 |
| 基础冒烟 / 高强度压力冒烟 | 12/12、26/26 |
| 手动验收客观核对 `--phase after` | 7/7 PASS，0 失败 |
| A1–A8 按钮判据复核 | 9/9 PASS，真实 profile 哈希不变 |
| 隔离 profile 全新安装（非 noop 写路径） | 8/8 PASS |
| 分发包解压独立可用性 | 8/8 PASS |
| 模板与插件源码一致性 | 8/8 一致 |
| 宿主完整重启后 | 路由探测 PASS、7/7 仍全绿 |

`actions: ["noop"]` 是幂等命中的正常结果，表示挂载目标一致、注册已存在，不是失败。

## 说明与边界

- 文档与脚本中的 `C://Users//zhang//...` 为本机环境的示例/默认路径，跨平台使用需按实际目录调整；不含任何令牌、密码或私钥。
- `skill/assets/plugin-template/` 与 `plugin/` 存在同源文件，修改契约文件后用 `skill/scripts/check_template_sync.py` 核对（必要时 `--sync-to-template`）。
- 模板固化的是 RPC 契约与上线流程，具体插件的业务逻辑仍需按需求改写 `src/host.js` / `src/client.js`。
- 安装默认只读：只有显式 `run`/`install` 且指定 `--profile` 才会写入 profile。

沿用仓库根目录的 MIT 许可证。
