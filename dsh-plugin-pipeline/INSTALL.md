# 安装说明（给其他人）

本仓库的 `dsh-plugin-pipeline/` 子目录里有两样东西，先分清你要装哪一个：

| 你想做什么 | 装哪个 | 装到哪 |
|---|---|---|
| 在 WorkBuddy 里用一句话生成/校验/打包/上线 DSH 插件 | **Skill** → 用 `dist/dsh-plugin-pipeline.skill.zip` | `~/.workbuddy/skills/` |
| 在 DSH 界面上直接用那个「一键上线」面板 | **插件本体** → 用 `plugin/` 源码目录 | `~/.dsh/profiles/<profile>/` |

大多数人只需要第一个。两个都装也可以，互不冲突。

> 注意：这是 `gitzhang` 仓库里的一个**子目录**，仓库根目录属于另一个插件 `dsh-sleep-tracker`。不要把整个仓库根当成 Skill 目录使用。

---

## 0. 前置条件

| 依赖 | 版本 | 什么时候需要 |
|---|---|---|
| Python | 3.9+ | 必需（CLI、bootstrap 都是 Python 脚本） |
| Node.js | 18+ | 运行 `selftest.mjs` 或 DSH 宿主时需要 |
| WorkBuddy | 任意近期版本 | 想通过对话触发 Skill 时需要 |
| DSH（DeepSeek Harness） | 已安装并有可用 profile | 想把插件装进 DSH 时需要 |

不需要 `pip install`，Skill 的 CLI 只用 Python 标准库。

---

## 1. 安装 Skill（推荐，最简）

### 1.1 拿到安装包

三选一：

**A. 直接下载（最省事）**

`https://raw.githubusercontent.com/zhanghaiao/gitzhang/main/dsh-plugin-pipeline/dist/dsh-plugin-pipeline.skill.zip`

也可以在 GitHub 网页进入 `dsh-plugin-pipeline/dist/`，点 `dsh-plugin-pipeline.skill.zip` → **Download raw file**。

**B. 命令行下载并解压**

Windows PowerShell：

```powershell
$zip = "$env:TEMP\dsh-plugin-pipeline.skill.zip"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/zhanghaiao/gitzhang/main/dsh-plugin-pipeline/dist/dsh-plugin-pipeline.skill.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath "$env:USERPROFILE\.workbuddy\skills" -Force
```

macOS / Linux：

```bash
curl -fL -o /tmp/dsh-plugin-pipeline.skill.zip \
  https://raw.githubusercontent.com/zhanghaiao/gitzhang/main/dsh-plugin-pipeline/dist/dsh-plugin-pipeline.skill.zip
mkdir -p ~/.workbuddy/skills
unzip -o /tmp/dsh-plugin-pipeline.skill.zip -d ~/.workbuddy/skills/
```

**C. 只检出这个子目录（想拿全部源码和验收报告时）**

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/zhanghaiao/gitzhang.git
cd gitzhang
git sparse-checkout set dsh-plugin-pipeline
# 之后 dsh-plugin-pipeline/skill/ 就是 Skill 源码，可复制或软链到 ~/.workbuddy/skills/
```

### 1.2 确认目录结构

解压后必须是下面这样（`SKILL.md` 直接在该目录下，不能再多套一层）：

```
~/.workbuddy/skills/dsh-plugin-pipeline/
├── SKILL.md
├── assets/
├── references/
└── scripts/
```

Windows 对应 `%USERPROFILE%\.workbuddy\skills\dsh-plugin-pipeline\`。

### 1.3 验证安装

```bash
python3 ~/.workbuddy/skills/dsh-plugin-pipeline/scripts/bootstrap_plugin.py \
  --name dsh-demo --out ./my-plugins --chain validate
```

Windows 把 `python3` 换成 `python`。看到 `"status": "pass"` 且 `checks` 六项全为 `true` 即安装成功（该命令只读，不会改动任何 profile）。

再跑一次插件自检（可选）：

```bash
cd my-plugins/dsh-demo && node scripts/selftest.mjs
# 期望输出：自检通过：13 项
```

### 1.4 使用

重启或刷新 WorkBuddy 后，直接说：

> 用 dsh-plugin-pipeline 生成一个 DSH 插件并上线

也可以只用命令行：

```bash
SKILL=~/.workbuddy/skills/dsh-plugin-pipeline

# 生成插件骨架（默认只读）
python3 $SKILL/scripts/bootstrap_plugin.py --name dsh-my-plugin --out ./my-plugins

# 三步一键上线：校验 → 打包 → 安装（只有这一步会写入 profile）
python3 $SKILL/scripts/dsh_pipeline.py run \
  --src ./my-plugins/dsh-my-plugin \
  --config $SKILL/assets/pipeline.config.json \
  --out ./my-plugins/dsh-my-plugin/dist \
  --profile desktop --json
```

`--chain run` / `run` 才会真正安装；默认是只读的 `validate`。

---

## 2. 安装 DSH 插件本体（想要那个面板）

前提：本机已装 DSH，且存在 `desktop`（或 `web` / `tui`）profile。

```bash
SKILL=~/.workbuddy/skills/dsh-plugin-pipeline      # 或仓库里 skill/ 的路径
PLUGIN=./gitzhang/dsh-plugin-pipeline/plugin      # 或任意放 plugin/ 源码的位置

python3 $SKILL/scripts/dsh_pipeline.py install \
  --src "$PLUGIN" \
  --config "$SKILL/assets/pipeline.config.json" \
  --profile desktop --json
```

首次安装成功后 `actions` 应包含 `junction` / `register_dependency` / `register_bundle` / `lockfile_updated`；重复安装返回 `actions: ["noop"]`，表示挂载一致、无需重写，**不是失败**。

然后 **完全退出 DSH 进程再重新启动**（只刷新页面无效，slot 与 Host 侧 JS 只在启动时加载）。启动后在侧栏找到 `↑` 图标，第一个输入框填**插件源码目录**（含 `package.json` 的目录），第二个填 profile，点「一键上线」。

成功返回的 JSON 应满足：`status: pass`、`errors: []`、`stages: [validate, package, install]`。

---

## 3. 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| `SRC_NOT_FOUND`，路径指向 `DeepSeek Harness.exe` | 第一个输入框要填**插件源码目录**，不是宿主 exe |
| `Invalid RPC target` 或 HTTP 405 | RPC channel 必须是单段 `/xxx`；用了旧版插件就会这样，换用本仓库的 `plugin/src/` |
| 装完面板不出现 / 仍报旧错 | 没有完全退出 DSH；任务管理器确认 `DeepSeek Harness.exe` 全部消失后重启 |
| WorkBuddy 里触发不到 Skill | `SKILL.md` 不在 `skills/dsh-plugin-pipeline/` 根目录，多半是解压时多套了一层文件夹 |
| 安装时报权限 / junction 创建失败 | Windows 上换管理员终端，或检查 `node_modules/<name>` 是否已被占用 |
| 想验证又怕改坏 profile | 所有 `install` / `run` 都支持 `--profile-root <临时目录>`，可指向隔离 profile |

---

## 4. 各脚本在别人机器上的可用性

已在干净目录里实测：解压 zip → `bootstrap_plugin.py --chain validate` → `status: pass` → 生成目录 `node scripts/selftest.mjs` → 13/13 通过。核心链路完全可移植。

| 脚本 | 别人直接跑 | 说明 |
|---|---|---|
| `dsh_pipeline.py`、`bootstrap_plugin.py`、`probe_live_route.py` | ✅ | 路径基于脚本自身位置或 `~`，无本机绝对路径 |
| `check_template_sync.py` | ✅ / 需参数 | 默认源为 `~/.dsh/profiles/desktop/node_modules/dsh-pipeline`；未装插件时用 `--src <仓库>/dsh-plugin-pipeline/plugin` |
| `smoke_test.py`、`smoke_stress_test.py` | ✅ / 需参数 | 默认值指向作者本机，请显式传 `--src --skill --work` |
| `rpc_route_test.mjs` | ✅ / 需环境变量 | 设置 `DSH_PLUGIN=<插件源码目录>` |
| `manual_acceptance_check.py` | ❌ | 4 个常量写死了作者本机路径，是本机验收专用记录脚本，别人**不需要运行**；若要复跑需改文件第 30–34 行 |

文档 `references/` 与 `acceptance/` 报告里出现的 `C:\Users\zhang\...` 是作者当时的实测路径，仅作示例，不参与运行。

---

## 5. 安全边界

- `bootstrap_plugin.py` 拒绝覆盖任何非空目录；默认 `--chain validate` 只读。
- 只有显式 `install` / `run` + `--profile` 才会写 profile 注册信息。
- 包内不含任何令牌、密钥或私钥。
- 沿用仓库根目录的 MIT 许可证。

有问题可在仓库提 issue，或对照 `README.md` 的「关键平台契约」一节排查。
