# dsh-sleep-tracker · 规律作息 / 睡眠记录 DSH Web UI 插件

一个 **DSH（DeepSeek Harness）Web UI 插件**：以浏览器端日历界面记录每日睡眠、查看当日课表、撰写日记，并支持深/浅主题切换与完整数据备份。所有用户数据在 **Host 侧本地文件**持久化，Client 只通过 Host↔Client 的 loopback RPC 读写，**不**写入浏览器 `localStorage`。

当前版本 **0.2.2**，修复了日历「日期与星期对不上」的排版问题、课表被清空后无法自愈的问题，并把每天的建议改成按「当天/次日课表 + 近 7 天睡眠缺口」动态生成（不再天天同一句模板）。

---

## 一、功能

| 功能 | 说明 |
|---|---|
| 睡眠记录 + 建议 | 日历点某天填就寝/起床时间、质量星级、备注；按目标时长判定「充足 / 偏少 / 不足」 |
| 每日智能建议 | 日历顶部与当日面板都有「今日建议」：按当天课量/首课、次日首课、近 7 天睡眠均值与累计缺口、午休空档动态生成；欠睡走「补觉优先」、连续不足走「连续不足」、早课日、明早无课、明早晚课各走不同分支，文案与数字逐日变化 |
| 课表推算作息 | 由**当天首课**倒推最晚起床时间，由**次日首课**倒推当晚就寝时间；提前量＝洗漱早餐 30 + 通勤 20 + 提前 20 到教室 = 70 分钟 |
| 日历视图 | 月历，日期格与星期表头等宽对齐（flex:1 1 0），每格显示当日睡眠时长、「N课」角标与状态色点 |
| 当日课程 | 依据内置的真实课表（淄博职业技术大学 人工智能实验班，2026-2027-1 学期，5 大节）显示当天课程、教师、地点、周次 |
| 课表管理 | 粘贴 JSON 数组导入，覆盖式保存；可「载入示例」或「恢复内置课表」；课表意外为空（旧数据 / 误清空）时启动自动回填 |
| 日记 | 与日期绑定的每日日记，和睡眠记录存在同一天记录里 |
| 设置 | 目标睡眠时长、常用起床时间、主题（跟随系统 / 浅色 / 深色，切换即时预览） |
| 数据备份 | 导出 `.json`（走 Host 全量快照）、导入恢复、一键清空；设置页显示真实存储路径 |

**明确不做**：不向对话模型暴露 tool；不做对话内联卡片；不依赖任何外部服务器或云存储。

---

## 二、架构

```
┌─────────────────────────────────────────────────────────────┐
│ DSH Web GUI (浏览器)                                          │
│   sidebar.panellist ──► 🌙 作息睡眠 (入口)                     │
│   main (key=dsh-sleep-tracker) ──► 日历 / 课表 / 设置 (页面)   │
│        │                                                      │
│   Client  src/client.js  (React，require('react'))             │
│        │  connection.rpc.call('/rpc/dsh-sleep-tracker', ...)   │
└────────┼──────────────────────────────────────────────────────┘
         │  loopback RPC（authority: 'loopback'）
┌────────┼──────────────────────────────────────────────────────┐
│ Host  src/host.js  (Node.js)                                  │
│   connection.rpc.handle(...)  ◄── 所有读写经此通道             │
│   原子写入 JSON：<DSH_HOME>/dsh-sleep-tracker/data.json        │
└───────────────────────────────────────────────────────────────┘
```

- **数据模型**（`data.json`）
  - `settings`: `{ sleepGoalMin, wakeBy, theme }`
  - `days`: `{ 'YYYY-MM-DD': { sleep: { bedtime, wakeTime, quality, note }, diary, dateKey } }`
  - `courses`: `[{ day(1-7), period(1-5), name, teacher, room, weeks }]`
  - `coursesCleared`: 用户是否主动清空过课表（`true` 时不再自动回填内置课表）
- **RPC 方法**：`getDay / getMonth / getRange / saveSleep / saveDiary / getCourses / saveCourses / restoreCourses / getSettings / setSettings / exportAll / importAll / clearAll / getInfo`

首次运行（`data.json` 不存在）会自动预置 18 条真实课表，装完打开就有数据可看；若旧数据里课表为空且没有 `coursesCleared` 标记，也会在加载时自动回填。

---

## 三、安装

```bash
# 装进桌面版（DeepSeek Harness 桌面应用使用的 profile）
dsh plugin --profile desktop add "C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-sleep-tracker"

# 或装进命令行 web 版
dsh plugin --profile web add "C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-sleep-tracker"
```

> 桌面版 DSH 的 `desktop` profile 由 Electron 独占，只走 `dsh plugin` 安装。
> slot 注册发生在启动阶段，**装完 / 改完代码都要重启 DSH** 才生效。

卸载：

```bash
dsh plugin --profile desktop remove dsh-sleep-tracker
```

用户数据在 `<DSH_HOME>/dsh-sleep-tracker/`，卸载不删数据；彻底清除请手动删该目录。

---

## 四、自测（不启动 DSH）

```bash
node ./scripts/selftest.mjs
```

用桩对象跑通 Host 的 14 个 RPC endpoint（含落盘、区间取数、快照、导入、清空、恢复课表）和 Client 的模块加载、槽位注册、日历/设置/课表渲染、睡眠评估分级、每日建议分支切换、按课表推算作息（含跨日、次日无课回落）、日历 30 个日期格等宽对齐，共 34 项断言。

---

## 五、隐私

- **纯本地**：数据只写入本机 `<DSH_HOME>/dsh-sleep-tracker/data.json`，不联网、不上传。
- 写入采用「临时文件 → rename」的原子方式；解析失败不会静默清空。
- 插件不向模型暴露任何函数工具，仅作为独立 Web UI 存在。

## 六、已知限制

- DSH 仍处 developer preview，客户端 slot / token / RPC 契约可能随升级变化，升级后建议回归一次。
- 周次（`weeks` 字段）仅展示，未参与「按周过滤课表」的计算。
