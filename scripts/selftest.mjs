// scripts/selftest.mjs — 离线自测：不启动 DSH，直接以桩对象跑通 Host RPC 与 Client 渲染。
// 运行：node ./scripts/selftest.mjs

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
function step(name) { passed++; console.log('  ✓ ' + name) }

// ===========================================================================
// 1. Host half — RPC handler + JSON persistence
// ===========================================================================
const tmp = mkdtempSync(join(tmpdir(), 'dsh-sleep-'))
process.env.DSH_HOME = tmp

const host = await import('../src/host.js')
let handler = null
let disposed = false
const effects = []

const connection = {
  rpc: {
    handle(channel, fn) {
      assert.equal(channel, host.RPC_CHANNEL)
      handler = fn
      return () => { disposed = true }
    },
  },
}

host.apply({
  inject(names, cb) {
    assert.deepEqual(names, ['connection'])
    cb({
      get(name) { assert.equal(name, 'connection'); return connection },
      effect(fn) { effects.push(fn) },
    })
  },
  logger: { error() {} },
})

await new Promise((r) => setTimeout(r, 60))
assert.equal(typeof handler, 'function', 'Host 未注册 RPC handler')
step('Host apply() 注册 loopback RPC 通道')

const dataFile = join(tmp, 'dsh-sleep-tracker', 'data.json')

const settings = await handler('getSettings', {})
assert.equal(settings.sleepGoalMin, 480)
step('getSettings 返回默认设置')

const courses = await handler('getCourses', {})
assert.equal(courses.length, 18, '默认课表应为 18 条，实际 ' + courses.length)
step('getCourses 首次运行预置 18 条真实课表')

// 按用户提供的课表截图逐格核对：每天节数分布
const perDay = [1, 2, 3, 4, 5].map(function (d) {
  return courses.filter(function (c) { return c.day === d }).length
})
assert.deepEqual(perDay, [5, 2, 4, 3, 4], '周一至周五节数应为 5/2/4/3/4，实际 ' + perDay.join('/'))
const mon4 = courses.filter(function (c) { return c.day === 1 && c.period === 4 })
assert.equal(mon4.length, 2, '周一第 4 节应为思修+形势与政策两门')
assert.ok(mon4.some(function (c) { return c.name === '形势与政策' }))
const fri3 = courses.filter(function (c) { return c.day === 5 && c.period === 3 })
assert.equal(fri3.length, 1, '周五第 3 节应有大模型')
const tue34 = courses.filter(function (c) { return c.day === 2 && (c.period === 3 || c.period === 4) })
assert.equal(tue34.length, 0, '周二第 3、4 节应为空')
step('课表与截图一致：周一 5 / 周二 2 / 周三 4 / 周四 3 / 周五 4（周二下午空、周五第 3 节有课）')

const saved = await handler('saveSleep', {
  dateKey: '2026-11-05',
  sleep: { bedtime: '23:30', wakeTime: '07:00', quality: 4, note: '自测' },
})
assert.equal(saved.sleep.bedtime, '23:30')
assert.ok(existsSync(dataFile), '写入后 data.json 应存在')
step('saveSleep 落盘为 data.json')

const day = await handler('getDay', { dateKey: '2026-11-05' })
assert.equal(day.sleep.wakeTime, '07:00')
step('getDay 回读一致')

const month = await handler('getMonth', { year: 2026, month: 11 })
assert.ok(Object.keys(month).includes('2026-11-05'))
step('getMonth 按月前缀过滤')

const diaryDay = await handler('saveDiary', { dateKey: '2026-11-05', diary: '今天睡了 7.5 小时' })
assert.equal(diaryDay.diary, '今天睡了 7.5 小时')
step('saveDiary 与睡眠记录共存于同一天')

await handler('setSettings', { sleepGoalMin: 450, theme: 'dark' })
assert.equal((await handler('getSettings', {})).theme, 'dark')
step('setSettings 持久化')

const snap = await handler('exportAll', {})
assert.equal(Object.keys(snap.days).length, 1)
assert.equal(snap.settings.sleepGoalMin, 450)
step('exportAll 导出完整快照')

const imported = await handler('importAll', {
  data: {
    settings: { sleepGoalMin: 480, wakeBy: '06:30', theme: 'light' },
    days: {
      '2026-10-01': { sleep: { bedtime: '23:00', wakeTime: '07:00' } },
      '2026-10-02': { diary: '导入的日记' },
    },
    courses: [{ day: 1, period: 1, name: '测试课', teacher: 'T', room: 'R' }],
  },
})
assert.deepEqual(imported, { ok: true, days: 2, courses: 1 })
assert.equal((await handler('getSettings', {})).wakeBy, '06:30')
step('importAll 覆盖式恢复（2 天记录 / 1 条课表）')

const range = await handler('getRange', { from: '2026-10-01', to: '2026-10-01' })
assert.equal(Object.keys(range).length, 1)
const range2 = await handler('getRange', { from: '2026-09-26', to: '2026-10-02' })
assert.equal(Object.keys(range2).length, 2)
step('getRange 按日期区间取记录（供近 7 天缺口计算）')

const cleared = await handler('clearAll', {})
assert.deepEqual(cleared, { ok: true })
assert.equal(await handler('getDay', { dateKey: '2026-10-01' }), null)
assert.equal((await handler('getCourses', {})).length, 0)
step('clearAll 清空记录与课表（主动清空后不回填）')

const restored = await handler('restoreCourses', {})
assert.equal(restored.length, 18, '恢复后应为 18 条，实际 ' + restored.length)
step('restoreCourses 一键恢复 18 条内置课表')

const info = await handler('getInfo', {})
assert.equal(info.file, dataFile)
assert.equal(info.lastError, null)
step('getInfo 返回存储路径')

await assert.rejects(() => handler('nope', {}), /unknown endpoint/)
step('未知 endpoint 抛错而不是静默返回')

const onDisk = JSON.parse(readFileSync(dataFile, 'utf8'))
assert.deepEqual(Object.keys(onDisk).sort(), ['courses', 'coursesCleared', 'days', 'settings'])
step('磁盘 JSON 结构为 settings / days / courses / coursesCleared')

// 旧数据（课表为空、无 coursesCleared 标记）重新加载时应自动回填
writeFileSync(dataFile, JSON.stringify({ settings: {}, days: {}, courses: [] }), 'utf8')
const reopened = await new host.Store(join(tmp, 'dsh-sleep-tracker')).load()
assert.equal(reopened.getCourses().length, 18, '空课表应回填 18 条，实际 ' + reopened.getCourses().length)
step('旧数据课表为空且未主动清空 → 加载时自动回填 18 条')

effects.forEach((fn) => fn())
assert.equal(disposed, true)
step('effect 清理会释放 RPC 通道')

// ===========================================================================
// 2. Client half — module loader + slot wiring + 渲染不崩
// ===========================================================================
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

let clientModule = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'dsh-sleep-tracker')
      clientModule = factory((name) => {
        assert.equal(name, 'react')
        return reactStub
      })
    },
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  confirm: () => false,
}

await import('../src/client.js')
assert.ok(clientModule && typeof clientModule.apply === 'function', 'Client 未导出 apply')
step('Client 经 window.__ModuleLoader__ 加载成功')

const registered = []
clientModule.apply({
  get: (name) => {
    assert.equal(name, 'connection')
    return {
      rpc: { call: (channel, endpoint, payload) => Promise.resolve(handler(endpoint, payload)) },
    }
  },
  slots: {
    inject(name, fn) { assert.ok(['sidebar.panellist', 'main'].includes(name)); fn() },
    register(spec, render) { registered.push({ spec, render }); return () => {} },
  },
})

assert.equal(registered.length, 2)
assert.equal(registered[0].spec.name, 'sidebar.panellist')
assert.equal(registered[0].spec.id, 'dsh-sleep-tracker')
assert.equal(registered[1].spec.name, 'main')
assert.equal(registered[1].spec.key, 'dsh-sleep-tracker')
step('注册侧边栏入口 sidebar.panellist + 主面板 main（同 id 关联）')

function collect(el, out) {
  if (el === null || el === undefined || typeof el === 'boolean') return out
  if (typeof el === 'string' || typeof el === 'number') { out.push(String(el)); return out }
  if (Array.isArray(el)) { el.forEach((c) => collect(c, out)); return out }
  if (typeof el === 'object') {
    if (typeof el.type === 'function') { collect(el.type(el.props), out); return out }
    collect(el.children, out)
    return out
  }
  return out
}

function nodesOf(el, out = []) {
  if (el === null || el === undefined || typeof el === 'boolean' || typeof el === 'string' || typeof el === 'number') return out
  if (Array.isArray(el)) { el.forEach((c) => nodesOf(c, out)); return out }
  if (typeof el === 'object') {
    if (typeof el.type === 'function') { nodesOf(el.type(el.props), out); return out }
    out.push(el)
    nodesOf(el.children, out)
    return out
  }
  return out
}

const sidebarText = collect(registered[0].render(), [])
assert.ok(sidebarText.includes('🌙'))
step('侧边栏渲染出 🌙 图标')

const appText = collect(registered[1].render(), [])
assert.ok(appText.includes('🌙 作息睡眠'), '主面板标题缺失')
assert.ok(appText.includes('2026 年 11 月'), '日历应停在 2026 年 11 月')
assert.ok(appText.includes('就寝时间') && appText.includes('每日日记'))
assert.ok(appText.includes('当天无课'))
step('主面板渲染：标题 / 日历 / 当日表单 / 日记 / 课程区')

const { SettingsPanel, CourseManager, Calendar } = clientModule.__components

const settingsText = collect(SettingsPanel({
  settings: { sleepGoalMin: 480, wakeBy: '07:00', theme: 'auto' },
  call: (endpoint, payload) => Promise.resolve(handler(endpoint, payload)),
  onSaved: () => {}, onThemeChange: () => {}, onReload: () => {},
}), [])
assert.ok(settingsText.includes('数据备份'))
assert.ok(settingsText.includes('导出数据') && settingsText.includes('导入数据') && settingsText.includes('清空数据'))
step('设置页渲染：目标时长 / 主题 / 数据备份三按钮')

const courseText = collect(CourseManager({
  courses: [], call: () => Promise.resolve([]), onChange: () => {},
}), [])
assert.ok(courseText.includes('暂无课表'))
step('课表页渲染空态')

const calendarText = collect(Calendar({
  year: 2026, month: 11,
  days: { '2026-11-05': { sleep: { bedtime: '23:30', wakeTime: '07:00' } } },
  courses: [{ day: 4, period: 1, name: '测试课' }],
  selected: '2026-11-05', onSelect: () => {}, goal: 480, todayKey: '2026-11-05',
}), [])
assert.ok(calendarText.includes('7.5h'), '日历应显示 7.5h 时长：' + calendarText.slice(0, 40))
assert.ok(calendarText.includes('1课'))
step('日历渲染睡眠时长与课程角标')

const ev1 = clientModule.__components.evaluate({ bedtime: '23:00', wakeTime: '07:00' }, { sleepGoalMin: 480 })
assert.equal(ev1.durationMin, 480)
assert.equal(ev1.status, 'good')
const ev2 = clientModule.__components.evaluate({ bedtime: '23:30', wakeTime: '07:00' }, { sleepGoalMin: 480 })
assert.equal(ev2.status, 'warn')
const ev3 = clientModule.__components.evaluate({ bedtime: '01:00', wakeTime: '07:00' }, { sleepGoalMin: 480 })
assert.equal(ev3.status, 'bad')
step('睡眠评估：8h=充足 / 7.5h=偏少 / 6h=不足')

// ===========================================================================
// 3. 按课表推算作息（planAdvice）
// ===========================================================================
const { planAdvice, DayPanel } = clientModule.__components

const thuFri = [
  { day: 4, period: 1, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-10' },
  { day: 4, period: 4, name: '思想道德与法治', teacher: '张佳倩', room: '尚德楼A315室', weeks: '8-19' },
  { day: 5, period: 1, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },
]

const p1 = planAdvice('2026-11-05', thuFri, { sleepGoalMin: 480, wakeBy: '07:00' })
assert.equal(p1.todayFirst.period, 1)
assert.equal(p1.todayWakeTime, '07:10')
assert.equal(p1.tomorrowFirst.period, 1)
assert.equal(p1.wakeTime, '07:10')
assert.equal(p1.bedTime, '23:10')
step('周四首课 08:20 → 07:10 起床 / 23:10 就寝（8h）')

const p2 = planAdvice('2026-11-06', [{ day: 5, period: 3, name: '下午课' }], { sleepGoalMin: 450, wakeBy: '07:00' })
assert.equal(p2.todayWakeTime, '12:40')
assert.equal(p2.wakeTime, '07:00', '次日无课时回落到设定起床时间')
assert.equal(p2.bedTime, '23:30')
step('次日无课回落常用起床时间；目标 7.5h → 23:30 就寝')

const p3 = planAdvice('2026-11-05', [{ day: 5, period: 5, name: '晚课' }], { sleepGoalMin: 480, wakeBy: '07:00' })
assert.equal(p3.wakeTime, '17:20')
assert.equal(p3.bedTime, '09:40', '次日 18:30 才上课，允许晚 20 分钟 → 09:40 就寝')
step('次日只有第 5 大节（18:30）→ 17:20 起床 / 09:40 就寝（跨日推算正确）')

const p4 = planAdvice('2026-11-07', [{ day: 1, period: 1, name: '周一课' }], { sleepGoalMin: 480, wakeBy: '07:00' })
assert.equal(p4.tomorrowFirst, null, '周六的次日是周日，应无课')
assert.equal(p4.nextKey, '2026-11-08')
assert.equal(p4.bedTime, '23:00')
step('周六 → 次日周日无课，回落到 07:00 起 / 23:00 睡')

const dayPanelText = collect(DayPanel({
  dateKey: '2026-11-05', record: {}, courses: thuFri,
  settings: { sleepGoalMin: 480, wakeBy: '07:00' },
  call: () => Promise.resolve(null), onSaved: () => {},
}), []).join(' | ')
assert.ok(dayPanelText.includes('今日建议'), '应渲染「今日建议」卡片')
assert.ok(dayPanelText.includes('23:10') && dayPanelText.includes('07:10'))
assert.ok(dayPanelText.includes('立德楼616室'))
step('当日面板渲染「今日建议」卡片（含地点与时间）')

// ===========================================================================
// 4. 建议差异化 & 日历对齐
// ===========================================================================
const { dailyPlan } = clientModule.__components

const debtDays = {
  '2026-11-04': { sleep: { bedtime: '01:30', wakeTime: '07:00' } },
  '2026-11-03': { sleep: { bedtime: '01:10', wakeTime: '07:00' } },
  '2026-11-02': { sleep: { bedtime: '00:50', wakeTime: '07:00' } },
}
const dDebt = dailyPlan('2026-11-05', thuFri, debtDays, { sleepGoalMin: 480, wakeBy: '07:00' })
assert.equal(dDebt.tag, '补觉优先')
assert.ok(dDebt.headline.includes('欠睡'))
const dEmpty = dailyPlan('2026-11-05', thuFri, {}, { sleepGoalMin: 480, wakeBy: '07:00' })
assert.notEqual(dDebt.headline, dEmpty.headline, '不同数据不能套同一句模板')
assert.equal(dEmpty.bedTime, '23:10', '无记录时仍按目标时长倒推 23:10')
step('「今日建议」按欠睡数据切换分支，文案不再固定')

const dWeekend = dailyPlan('2026-11-06', thuFri, { '2026-11-05': { sleep: { bedtime: '23:30', wakeTime: '06:30' } } }, { sleepGoalMin: 480, wakeBy: '07:00' })
assert.equal(dWeekend.tag, '明早无课')
assert.ok(dWeekend.headline.includes('明天没课'))
step('次日无课时走「明早无课」分支')

const calNodes = nodesOf(Calendar({
  year: 2026, month: 11, days: {}, courses: thuFri,
  selected: '2026-11-05', onSelect: () => {}, goal: 480, todayKey: '2026-11-05',
}))
const dateCells = calNodes.filter((n) => n.props && n.props.style && n.props.style.borderRadius === 8)
assert.equal(dateCells.length, 30, '11 月应有 30 个日期格，实际 ' + dateCells.length)
assert.ok(dateCells.every((n) => n.props.style.flex === '1 1 0'), '日期格必须与星期表头等宽（否则日期会滑列）')
step('日历 30 个日期格全部 flex:1 1 0，与星期表头同宽（修掉日期/星期错位）')

rmSync(tmp, { recursive: true, force: true })
console.log('\n全部 ' + passed + ' 项通过')
