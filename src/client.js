// DSH Sleep Tracker — Client half (browser)
//
// Loaded by the DSH web client module system through the sanctioned
// `window.__ModuleLoader__.load({ id, factory })` call. The factory receives
// DSH's `require` (which resolves the frozen `react` module) and must export
// the plugin contract `{ name, inject, apply }`.
//
// Design notes:
//   * All persistent data lives on the Host and is reached ONLY through the
//     loopback RPC channel. This client never writes sleep/diary/course data to
//     localStorage or any browser store.
//   * The UI is themed with its own light/dark palette (prefers DSH token names
//     with safe fallbacks) and reacts to a manual toggle stored on the Host.
//   * v0.2.0 ported from the standalone index.html build: adds full data
//     backup (export / import / clear) and live theme preview.

window.__ModuleLoader__.load({
  id: 'dsh-sleep-tracker',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var PANEL_ID = 'dsh-sleep-tracker'
    var RPC_CHANNEL = '/rpc/dsh-sleep-tracker'
    var WEEK = ['一', '二', '三', '四', '五', '六', '日'] // Monday-first

    // -------------------------------------------------------------------
    // Theme palette (self-contained; prefers DSH token names as fallbacks)
    // -------------------------------------------------------------------
    function palette(dark) {
      if (dark) {
        return {
          '--bg': 'var(--dsh-bg, #15171c)',
          '--panel': 'var(--dsh-panel, #1c1f26)',
          '--panel2': 'var(--dsh-panel-2, #23272f)',
          '--fg': 'var(--dsh-fg, #e6e8ec)',
          '--muted': 'var(--dsh-muted, #9aa3af)',
          '--border': 'var(--dsh-border, #2c313a)',
          '--accent': 'var(--dsh-accent, #6ea8fe)',
          '--good': '#4caf7d',
          '--warn': '#e0b34a',
          '--bad': '#e06b6b',
        }
      }
      return {
        '--bg': 'var(--dsh-bg, #f5f6f8)',
        '--panel': 'var(--dsh-panel, #ffffff)',
        '--panel2': 'var(--dsh-panel-2, #f0f2f5)',
        '--fg': 'var(--dsh-fg, #1f2329)',
        '--muted': 'var(--dsh-muted, #6b7280)',
        '--border': 'var(--dsh-border, #e3e6ea)',
        '--accent': 'var(--dsh-accent, #3b82f6)',
        '--good': '#2e9e6b',
        '--warn': '#c79421',
        '--bad': '#d25555',
      }
    }

    function useDarkMode(theme) {
      var getSys = function () {
        return typeof window !== 'undefined' && window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches
      }
      var st = useState(getSys())
      var sysDark = st[0]
      var setSysDark = st[1]
      useEffect(function () {
        if (!window.matchMedia) return
        var mq = window.matchMedia('(prefers-color-scheme: dark)')
        var handler = function (e) { setSysDark(e.matches) }
        if (mq.addEventListener) mq.addEventListener('change', handler)
        else if (mq.addListener) mq.addListener(handler)
        return function () {
          if (mq.removeEventListener) mq.removeEventListener('change', handler)
          else if (mq.removeListener) mq.removeListener(handler)
        }
      }, [])
      if (theme === 'light') return false
      if (theme === 'dark') return true
      return sysDark
    }

    // -------------------------------------------------------------------
    // Sleep suggestion logic (pure)
    // -------------------------------------------------------------------
    function toMin(t) {
      if (!t) return null
      var p = t.split(':')
      return parseInt(p[0], 10) * 60 + parseInt(p[1], 10)
    }
    function durationMin(bed, wake) {
      if (!bed || !wake) return null
      var d = toMin(wake) - toMin(bed)
      if (d <= 0) d += 1440
      return d
    }
    function suggestBed(wakeBy, goalMin) {
      var wb = toMin(wakeBy) - goalMin
      if (wb < 0) wb += 1440
      var hh = Math.floor(wb / 60)
      var mm = wb % 60
      return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
    }
    function evaluate(sleep, settings) {
      if (!sleep || !sleep.bedtime || !sleep.wakeTime) return null
      var dur = durationMin(sleep.bedtime, sleep.wakeTime)
      var goal = (settings && settings.sleepGoalMin) || 480
      var diff = dur - goal
      var status = diff >= 0 ? 'good' : diff >= -30 ? 'warn' : 'bad'
      var msg = []
      if (status === 'good') msg.push('睡眠充足，继续保持。')
      else if (status === 'warn') msg.push('略少于目标，尽量再早一点休息。')
      else msg.push('睡眠不足，建议今晚提前就寝。')
      var wake = sleep.wakeTime
      msg.push('建议就寝时间不晚于 ' + suggestBed(wake, goal) + '（按目标 ' + Math.round(goal / 60 * 10) / 10 + ' 小时）。')
      return { durationMin: dur, diff: diff, status: status, messages: msg }
    }

    // -------------------------------------------------------------------
    // 课表节次时间 & 日期/课程工具
    // -------------------------------------------------------------------
    var PERIOD_TIMES = {
      1: '08:20-10:00', 2: '10:20-12:00', 3: '13:50-15:20',
      4: '15:40-17:10', 5: '18:30-20:00',
    }
    var PERIOD_START = { 1: '08:20', 2: '10:20', 3: '13:50', 4: '15:40', 5: '18:30' }

    // 起床到「坐在教室里」的提前量：洗漱早餐 30 + 通勤 20 + 提前 20 到教室
    var WAKE_LEAD_MIN = 70

    function minToTime(m) {
      m = ((Math.round(m) % 1440) + 1440) % 1440
      return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
    }
    function nextDateKey(dateKey) {
      var p = dateKey.split('-')
      var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + 1)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }
    function firstCourseOf(courses, dateKey) {
      var wd = weekdayOf(dateKey)
      var list = (courses || [])
        .filter(function (c) { return c.day === wd && PERIOD_START[c.period] })
        .sort(function (a, b) { return a.period - b.period })
      return list.length ? list[0] : null
    }

    // -------------------------------------------------------------------
    // 每日建议引擎：按「当天/次日课表 + 近 7 天睡眠缺口」动态生成，
 // 不同日期、不同作息数据会落到不同分支，不是固定模板。
    // -------------------------------------------------------------------
    function addDays(dateKey, n) {
      var p = dateKey.split('-')
      var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + n)
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    }
    function fmtDur(m) {
      if (m == null) return '—'
      if (m >= 90) return (Math.round(m / 6) / 10).toFixed(1) + ' 小时'
      return Math.round(m) + ' 分钟'
    }
    function courseBlocks(courses, dateKey) {
      return (courses || [])
        .filter(function (c) { return c.day === weekdayOf(dateKey) && PERIOD_TIMES[c.period] })
        .map(function (c) {
          var r = PERIOD_TIMES[c.period].split('-')
          return { period: c.period, start: toMin(r[0]), end: toMin(r[1]), course: c }
        })
        .sort(function (a, b) { return a.start - b.start })
    }
    function freeWindows(blocks, from, to) {
      var out = [], cur = from
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i]
        if (b.end <= from || b.start >= to) continue
        if (b.start > cur) out.push({ start: cur, end: Math.min(b.start, to) })
        cur = Math.max(cur, b.end)
        if (cur >= to) break
      }
      if (cur < to) out.push({ start: cur, end: to })
      return out.filter(function (w) { return w.end - w.start >= 15 })
    }
    function napPlan(blocks) {
      var wins = freeWindows(blocks, 700, 960) // 11:40–16:00 之间找最长空档
      if (!wins.length) return null
      var best = wins.slice().sort(function (a, b) { return (b.end - b.start) - (a.end - a.start) })[0]
      var span = best.end - best.start
      if (span < 35) return null
      var start = best.start + Math.min(40, Math.floor(span / 3))
      var dur = span >= 120 ? 30 : 20
      var end = Math.min(start + dur, best.end - 5)
      if (end - start < 15) return null
      return { start: minToTime(start), end: minToTime(end), len: end - start }
    }
    function sleepStats(days, dateKey, goal) {
      var recs = [], total = 0, count = 0, debt = 0
      for (var i = 1; i <= 7; i++) {
        var k = addDays(dateKey, -i)
        var s = days[k] && days[k].sleep
        var dur = (s && s.bedtime && s.wakeTime) ? durationMin(s.bedtime, s.wakeTime) : null
        recs.push({ dateKey: k, dur: dur })
        if (dur != null) { count++; total += dur; debt += Math.max(0, goal - dur) }
      }
      var streak = 0
      for (var j = 0; j < recs.length; j++) {
        if (recs[j].dur != null && recs[j].dur < goal - 30) streak++
        else break
      }
      return { count: count, avg: count ? Math.round(total / count) : null, last: recs[0].dur, debt: Math.round(debt), shortStreak: streak }
    }
    // 可玩性：称号等级 / 连续打卡 / 成就徽章 / 本周挑战 / 睡眠小精灵
    function funStats(history, todayKey, goal) {
      history = history || {}
      var days = []
      for (var i = 30; i >= 0; i--) {
        var k = addDays(todayKey, -i)
        var rec = history[k] && history[k].sleep
        var bed = rec && rec.bedtime, wake = rec && rec.wakeTime
        var dur = (bed && wake) ? durationMin(bed, wake) : null
        var b24 = bed ? toMin(bed) : null
        if (b24 != null && b24 < 12 * 60) b24 += 1440
        days.push({ k: k, bed: bed, wake: wake, dur: dur, b24: b24 })
      }
      var recorded = days.filter(function (d) { return d.dur != null })
      var total = recorded.length
      var streak = 0
      for (var j = days.length - 1; j >= 0; j--) {
        if (days[j].dur != null) streak++
        else if (j === days.length - 1) continue
        else break
      }
      var levels = [
        { need: 0, title: '刚入睡', emoji: '🌱' },
        { need: 1, title: '熬夜熊猫', emoji: '🐼' },
        { need: 3, title: '作息学徒', emoji: '🐣' },
        { need: 7, title: '晨型人', emoji: '🐦' },
        { need: 14, title: '自律王', emoji: '👑' },
      ]
      var lv = levels[0], nextLv = null
      for (var l = 0; l < levels.length; l++) {
        if (total >= levels[l].need) { lv = levels[l]; nextLv = levels[l + 1] || null }
      }
      var early = recorded.some(function (d) { return d.b24 != null && d.b24 <= 23 * 60 })
      var morning = recorded.some(function (d) { return d.wake && toMin(d.wake) <= 7 * 60 + 30 })
      var weekend = days.some(function (d) {
        if (weekdayOf(d.k) < 6) return false
        return d.wake && toMin(d.wake) <= 9 * 60 + 30
      })
      var enoughStreak = 0, maxEnough = 0
      for (var e = 0; e < days.length; e++) {
        if (days[e].dur != null && days[e].dur >= goal) { enoughStreak++; if (enoughStreak > maxEnough) maxEnough = enoughStreak }
        else enoughStreak = 0
      }
      var last7 = days.slice(-7)
      var earlyWeek = last7.filter(function (d) { return d.b24 != null && d.b24 <= 23 * 60 + 30 }).length
      var wdToday = weekdayOf(todayKey)
      var weekEnough = 0
      for (var w = 0; w < wdToday; w++) {
        var wk = addDays(todayKey, -w)
        var rec2 = history[wk] && history[wk].sleep
        if (rec2 && rec2.bedtime && rec2.wakeTime && durationMin(rec2.bedtime, rec2.wakeTime) >= goal) weekEnough++
      }
      var badges = [
        { icon: '🌙', name: '第一夜', got: total >= 1 },
        { icon: '⏰', name: '23点前睡', got: early },
        { icon: '🔥', name: '连打7天', got: streak >= 7 },
        { icon: '💪', name: '连睡3天够', got: maxEnough >= 3 },
        { icon: '🌅', name: '早起党', got: morning },
        { icon: '🛌', name: '周末不赖床', got: weekend },
        { icon: '✨', name: '早睡五天', got: earlyWeek >= 5 },
      ]
      var last = recorded[recorded.length - 1] || null
      var pet = !last ? { emoji: '😴', text: '还没记录，告诉我昨晚睡了多久吧' }
        : last.dur >= goal ? { emoji: '😄', text: '昨晚睡够了，精神满满' }
        : last.dur >= goal - 60 ? { emoji: '🙂', text: '差不多够，今天还行' }
        : { emoji: '😪', text: '昨晚没睡够，今天顶着黑眼圈' }
      return { total: total, streak: streak, lv: lv, nextLv: nextLv, badges: badges, pet: pet, weekEnough: weekEnough }
    }
    function dailyPlan(dateKey, courses, days, settings) {
      settings = settings || {}
      var goal = settings.sleepGoalMin || 480
      var today = courseBlocks(courses, dateKey)
      var tomorrow = courseBlocks(courses, addDays(dateKey, 1))
      var firstToday = today.length ? today[0] : null
      var firstTomorrow = tomorrow.length ? tomorrow[0] : null
      var stats = sleepStats(days || {}, dateKey, goal)
      var nap = napPlan(today)

      var wakeBase = firstTomorrow ? firstTomorrow.start - WAKE_LEAD_MIN : toMin(settings.wakeBy || '07:00')
      var adjust = 0
      if (stats.debt >= 240) adjust -= 35
      else if (stats.debt >= 120) adjust -= 20
      else if (stats.last != null && stats.last <= goal - 90) adjust -= 15
      if (firstTomorrow && firstTomorrow.start >= 620) adjust += 20
      var bed = wakeBase - goal + adjust
      if (bed < 0) bed += 1440 // 早于 0 点 → 记作前一天晚上（如 -50 = 23:10）
      if (wakeBase < 720) {   // 上午起床：就寝落在晚间区间
        if (bed < 1300) bed = 1300 // 不早于 21:40
        if (bed > 1500) bed = 1500 // 不晚于次日 01:00
      }

      var wakeTime = minToTime(wakeBase)
      var bedTime = minToTime(bed)
      var goalH = (goal / 60).toFixed(1)
      var tone = 'info', tag = '建议', headline = '', tips = [], basis = []

      if (stats.count === 0) {
        headline = '近 7 天还没有睡眠记录，先补一条昨晚就寝/起床，建议会按你的实际缺口来算'
      } else if (stats.debt >= 180) {
        tone = 'bad'; tag = '补觉优先'
        headline = '近 7 天累计欠睡 ' + fmtDur(stats.debt) + '，今晚 ' + bedTime + ' 前必须上床，别拖过 ' + minToTime(bed + 40)
      } else if (stats.shortStreak >= 3) {
        tone = 'warn'; tag = '连续不足'
        headline = '已连续 ' + stats.shortStreak + ' 天不到 ' + goalH + ' 小时，今晚把补觉排第一，' + bedTime + ' 关灯'
      } else if (firstToday && stats.last != null && stats.last < goal - 60 && firstToday.start <= 500) {
        tone = 'warn'; tag = '早课日'
        headline = '昨晚只睡 ' + (stats.last / 60).toFixed(1) + ' 小时，今早 ' + minToTime(firstToday.start) + ' 有课，中午别省那 ' + (nap ? nap.len : 20) + ' 分钟午睡'
      } else if (!firstTomorrow) {
        tone = 'good'; tag = '明早无课'
        headline = '明天没课，起床可放宽到 ' + minToTime(wakeBase + 60) + '，今晚仍按 ' + bedTime + ' 睡，别让节律往后漂'
      } else if (firstTomorrow.start >= 620) {
        tone = 'good'; tag = '明早晚课'
        headline = '明天首课 ' + minToTime(firstTomorrow.start) + '，今晚可比平时晚 20 分钟，' + bedTime + ' 上床'
      } else {
        tone = 'good'; tag = '节奏正常'
        headline = '今天 ' + today.length + ' 节大课、首课 ' + (firstToday ? minToTime(firstToday.start) : '无') + '，按 ' + bedTime + ' 睡 / ' + wakeTime + ' 起，正好 ' + goalH + ' 小时'
      }

      if (nap) tips.push('午睡 ' + nap.start + '–' + nap.end + '（' + nap.len + ' 分钟），超过 30 分钟反而更困')
      else if (firstToday) tips.push('今天没有够长的空档，午睡省掉，今晚把就寝往前挪 15 分钟')
      if (firstToday && firstToday.start <= 500) tips.push('最晚 ' + minToTime(firstToday.start - 40) + ' 出门才不赶，闹钟放远一点')
      var lastCourse = today.length ? today[today.length - 1] : null
      if (lastCourse && lastCourse.start >= 1110) tips.push('晚课 ' + minToTime(lastCourse.start) + ' 下课后先洗漱再躺，别在床上刷手机')
      if (stats.debt >= 120) tips.push('今晚比昨天提前 ' + (stats.debt >= 240 ? 35 : 20) + ' 分钟关灯，把欠的 ' + fmtDur(stats.debt) + ' 慢慢还')
      if (!firstTomorrow) tips.push('明天补觉最多多睡 1 小时，睡过头周一更难起')
      if (stats.shortStreak >= 2) tips.push('白天别用咖啡硬撑，14:00 之后停咖啡因')
      if (stats.count === 0) tips.push('填完一条记录后，这里的建议每天都会跟着变')
      tips = tips.slice(0, 4)

      if (firstToday) basis.push('今日 ' + today.length + ' 节 · 首课 ' + minToTime(firstToday.start) + '（' + firstToday.course.name + '）')
      else basis.push('今日无课')
      if (firstTomorrow) basis.push('明日首课 ' + minToTime(firstTomorrow.start) + ' → 倒推今晚就寝')
      else basis.push('明日无课 → 按常用起床时间')
      if (stats.count) basis.push('近 7 天均值 ' + fmtDur(stats.avg) + ' · 缺口 ' + fmtDur(stats.debt))

      return {
        tone: tone, tag: tag, headline: headline, tips: tips, basis: basis,
        wakeTime: wakeTime, bedTime: bedTime, goalMin: goal, nap: nap, stats: stats,
        // 兼容旧字段（自测与外部调用）
        todayFirst: firstToday ? firstToday.course : null,
        todayWakeTime: firstToday ? minToTime(firstToday.start - WAKE_LEAD_MIN) : null,
        nextKey: addDays(dateKey, 1),
        nextWeekday: weekdayOf(addDays(dateKey, 1)),
        tomorrowFirst: firstTomorrow ? firstTomorrow.course : null,
        sleepGoalMin: goal,
        leadMin: WAKE_LEAD_MIN,
      }
    }
    function planAdvice(dateKey, courses, settings, days) {
      return dailyPlan(dateKey, courses, days || {}, settings)
    }
    function weekdayOf(dateKey) {
      var p = dateKey.split('-')
      var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10))
      return (d.getDay() + 6) % 7 + 1 // 1=周一 .. 7=周日
    }
    function coursesOfDay(courses, dateKey) {
      var wd = weekdayOf(dateKey)
      return (courses || []).filter(function (c) { return c.day === wd })
        .sort(function (a, b) { return a.period - b.period })
    }

    // -------------------------------------------------------------------
    // Small UI helpers
    // -------------------------------------------------------------------
    function btn(label, onClick, kind) {
      return h('button', {
        onClick: onClick,
        style: {
          border: '1px solid var(--border)',
          background: kind === 'primary' ? 'var(--accent)' : 'var(--panel2)',
          color: kind === 'primary' ? '#fff' : 'var(--fg)',
          borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
        },
      }, label)
    }
    function card(style, children) {
      return h('div', {
        style: Object.assign({
          background: 'var(--panel)', border: '1px solid var(--border)',
          borderRadius: 12, padding: 16,
        }, style || {}),
      }, children)
    }
    function field(label, control) {
      return h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--muted)' } }, [
        label, control,
      ])
    }
    function inputStyle() {
      return {
        background: 'var(--panel2)', border: '1px solid var(--border)', color: 'var(--fg)',
        borderRadius: 8, padding: '6px 8px', fontSize: 13,
      }
    }

    // -------------------------------------------------------------------
    // Calendar grid
    // -------------------------------------------------------------------
    function Calendar(props) {
      var year = props.year, month = props.month, days = props.days, courses = props.courses
      var first = new Date(year, month - 1, 1)
      var startWeekday = (first.getDay() + 6) % 7 // Monday-first
      var daysInMonth = new Date(year, month, 0).getDate()
      var cells = []
      for (var i = 0; i < startWeekday; i++) cells.push(null)
      for (var d = 1; d <= daysInMonth; d++) cells.push(d)
      while (cells.length % 7 !== 0) cells.push(null)

      var todayKey = props.todayKey
      var rows = []
      for (var r = 0; r < cells.length; r += 7) {
        var row = []
        for (var c = 0; c < 7; c++) {
          var dayNum = cells[r + c]
          if (dayNum == null) { row.push(h('div', { style: { flex: '1 1 0', minWidth: 0, margin: 2 } }, '')); continue }
          var key = year + '-' + String(month).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0')
          var rec = days[key]
          var sleep = rec && rec.sleep
          var dur = sleep && sleep.bedtime && sleep.wakeTime ? durationMin(sleep.bedtime, sleep.wakeTime) : null
          var status = dur == null ? null
            : (dur >= (props.goal || 480) ? 'good' : dur >= (props.goal || 480) - 30 ? 'warn' : 'bad')
          var colorMap = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)' }
          var isSel = key === props.selected
          var isToday = key === todayKey
          var wd = (new Date(year, month - 1, dayNum).getDay() + 6) % 7 + 1
          var cCount = 0
          for (var ci = 0; ci < (courses || []).length; ci++) {
            if (courses[ci].day === wd) cCount++
          }
          row.push(h('div', {
            key: key,
            onClick: function (k) { return function () { props.onSelect(k) } }(key),
            style: {
              position: 'relative', flex: '1 1 0', minWidth: 0, overflow: 'hidden',
              padding: '8px 4px', margin: 2, borderRadius: 8,
              cursor: 'pointer', textAlign: 'center', fontSize: 13,
              background: isSel ? 'var(--accent)' : 'var(--panel2)',
              color: isSel ? '#fff' : 'var(--fg)',
              border: isToday ? '2px solid var(--accent)' : '1px solid var(--border)',
            },
          }, [
            h('div', null, String(dayNum)),
            dur != null ? h('div', { style: { fontSize: 10, color: isSel ? '#fff' : 'var(--muted)' } }, (dur / 60).toFixed(1) + 'h') : null,
            cCount > 0 ? h('div', { style: { fontSize: 9, lineHeight: 1.1, color: isSel ? 'rgba(255,255,255,.92)' : 'var(--accent)' } }, cCount + '课') : null,
            status ? h('span', {
              style: {
                position: 'absolute', top: 4, right: 4, width: 7, height: 7,
                borderRadius: '50%', background: isSel ? '#fff' : colorMap[status],
              },
            }) : null,
          ]))
        }
        rows.push(h('div', { style: { display: 'flex' } }, row))
      }

      return h('div', null, [
        h('div', { style: { display: 'flex', marginBottom: 6 } },
          WEEK.map(function (w) {
            return h('div', { key: w, style: { flex: '1 1 0', minWidth: 0, textAlign: 'center', fontSize: 12, color: 'var(--muted)' } }, '周' + w)
          })),
        rows,
      ])
    }

    // -------------------------------------------------------------------
    // Day detail panel (sleep form + suggestion + diary)
    // -------------------------------------------------------------------
    function DayPanel(props) {
      var dateKey = props.dateKey
      var record = props.record || {}
      var courses = props.courses
      var sleep = record.sleep || {}
      var base = sleep
      var [bedtime, setBedtime] = useState(base.bedtime || '')
      var [wakeTime, setWakeTime] = useState(base.wakeTime || '')
      var [quality, setQuality] = useState(base.quality || 3)
      var [note, setNote] = useState(base.note || '')
      var [diary, setDiary] = useState(record.diary || '')
      var [msg, setMsg] = useState('')

      // keep local form in sync when switching days
      useEffect(function () {
        setBedtime((record.sleep && record.sleep.bedtime) || '')
        setWakeTime((record.sleep && record.sleep.wakeTime) || '')
        setQuality((record.sleep && record.sleep.quality) || 3)
        setNote((record.sleep && record.sleep.note) || '')
        setDiary(record.diary || '')
      }, [dateKey])

      var ev = evaluate({ bedtime: bedtime, wakeTime: wakeTime }, props.settings)
      var saveSleep = function () {
        props.call('saveSleep', { dateKey: dateKey, sleep: { bedtime: bedtime, wakeTime: wakeTime, quality: quality, note: note } })
          .then(function (d) { props.onSaved(d); setMsg('已保存睡眠记录') })
          .catch(function (e) { setMsg('保存失败：' + e.message) })
      }
      var saveDiary = function () {
        props.call('saveDiary', { dateKey: dateKey, diary: diary })
          .then(function (d) { props.onSaved(d); setMsg('已保存日记') })
          .catch(function (e) { setMsg('保存失败：' + e.message) })
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, dateKey + ' 作息与日记'),
        card(null, [
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } }, [
            field('就寝时间', h('input', { type: 'time', value: bedtime, onChange: function (e) { setBedtime(e.target.value) }, style: inputStyle() })),
            field('起床时间', h('input', { type: 'time', value: wakeTime, onChange: function (e) { setWakeTime(e.target.value) }, style: inputStyle() })),
          ]),
          h('div', { style: { marginTop: 10 } }, [
            h('span', { style: { color: 'var(--muted)', fontSize: 13 } }, '睡眠质量：'),
            h('span', { style: { marginLeft: 6 } }, [1, 2, 3, 4, 5].map(function (q) {
              return h('span', {
                key: q, onClick: function () { setQuality(q) },
                style: {
                  cursor: 'pointer', margin: '0 2px', fontSize: 18,
                  color: q <= quality ? 'var(--accent)' : 'var(--border)',
                },
              }, '★')
            })),
          ]),
          h('div', { style: { marginTop: 10 } }, h('input', {
            placeholder: '备注（可选）', value: note, onChange: function (e) { setNote(e.target.value) },
            style: Object.assign({}, inputStyle(), { width: '100%' }),
          })),
          h('div', { style: { marginTop: 12, display: 'flex', gap: 8 } }, [
            btn('保存睡眠', saveSleep, 'primary'),
          ]),
        ]),
        ev ? card({ borderLeft: '3px solid ' + ({ good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)' })[ev.status] }, [
          h('div', { style: { fontWeight: 600, marginBottom: 6 } },
            '睡眠 ' + (ev.durationMin / 60).toFixed(1) + ' 小时 · ' +
            ({ good: '充足', warn: '偏少', bad: '不足' })[ev.status]),
          ev.messages.map(function (m, i) { return h('div', { key: i, style: { fontSize: 13, color: 'var(--muted)', marginTop: 2 } }, '· ' + m) }),
        ]) : null,
        (function () {
          var plan = dailyPlan(dateKey, courses, props.days || {}, props.settings)
          var toneColor = ({ good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--accent)' })[plan.tone]
          return card({ borderLeft: '3px solid ' + toneColor }, [
            h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 } }, [
              h('div', { style: { fontWeight: 600 } }, '今日建议'),
              h('span', {
                style: {
                  fontSize: 11, padding: '1px 8px', borderRadius: 999, lineHeight: 1.6,
                  color: toneColor, border: '1px solid ' + toneColor, background: 'var(--panel2)',
                },
              }, plan.tag),
              h('div', { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' } },
                '起床 ' + plan.wakeTime + ' · 就寝 ' + plan.bedTime),
            ]),
            h('div', { style: { fontSize: 13.5, fontWeight: 600, lineHeight: 1.65, marginBottom: 8 } }, plan.headline),
            plan.tips.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, plan.tips.map(function (t, i) {
              return h('div', { key: i, style: { fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6 } }, '· ' + t)
            })) : null,
            h('div', { style: { marginTop: 9, paddingTop: 8, borderTop: '1px dashed var(--border)', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.7 } },
              plan.basis.join('　·　')),
          ])
        })(),
        card(null, [
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '每日日记'),
          h('textarea', {
            value: diary, onChange: function (e) { setDiary(e.target.value) },
            rows: 5, placeholder: '记下今天的事……',
            style: Object.assign({}, inputStyle(), { width: '100%', resize: 'vertical' }),
          }),
          h('div', { style: { marginTop: 8 } }, btn('保存日记', saveDiary)),
        ]),
        (function () {
          var dayCourses = coursesOfDay(courses, dateKey)
          return card(null, [
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '当日课程（周' + WEEK[weekdayOf(dateKey) - 1] + '）'),
            dayCourses.length
              ? h('div', { style: { fontSize: 13 } }, dayCourses.map(function (c, i) {
                return h('div', { key: i, style: { padding: '6px 0', borderBottom: '1px solid var(--border)' } }, [
                  h('div', { style: { fontWeight: 600 } }, '第' + c.period + '大节 · ' + (PERIOD_TIMES[c.period] || '') + ' · ' + c.name),
                  h('div', { style: { fontSize: 12, color: 'var(--muted)', marginTop: 2 } },
                    (c.teacher ? '教师：' + c.teacher : '') +
                    (c.teacher && c.room ? '　' : '') + (c.room ? '地点：' + c.room : '') +
                    (c.weeks ? '　周次：' + c.weeks : '')),
                ])
              }))
              : h('div', { style: { fontSize: 13, color: 'var(--muted)' } }, '当天无课'),
          ])
        })(),
        msg ? h('div', { style: { fontSize: 12, color: 'var(--muted)' } }, msg) : null,
      ])
    }

    // -------------------------------------------------------------------
    // Course manager
    // -------------------------------------------------------------------
    // 真实课表（淄博职业技术大学 人工智能实验班，2026-2027-1 学期）
    // 字段：day(1-7 周一~周日)、period(1-5 大节)、name、teacher、room、weeks(周次)
    var DEFAULT_COURSES = [
      { day: 1, period: 1, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-10' },
      { day: 2, period: 1, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-10' },
      { day: 3, period: 1, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-10' },
      { day: 4, period: 1, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },
      { day: 5, period: 1, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },

      { day: 1, period: 2, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-10' },
      { day: 2, period: 2, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-10' },
      { day: 3, period: 2, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-10' },
      { day: 4, period: 2, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },
      { day: 5, period: 2, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },

      { day: 1, period: 3, name: '心理健康教育', teacher: '宗涵', room: '尚德楼A315室', weeks: '8-15' },
      { day: 3, period: 3, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },
      { day: 5, period: 3, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },

      { day: 1, period: 4, name: '思想道德与法治', teacher: '张佳倩', room: '尚德楼A315室', weeks: '8-11,14-17' },
      { day: 1, period: 4, name: '形势与政策', teacher: '张佳倩', room: '尚德楼A315室', weeks: '12-13' },
      { day: 3, period: 4, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },
      { day: 4, period: 4, name: '思想道德与法治', teacher: '张佳倩', room: '尚德楼A315室', weeks: '8-19' },
      { day: 5, period: 4, name: '体育与健康', teacher: '申海洋', room: '北校区操场', weeks: '8-19' },
    ]

    function CourseManager(props) {
      var [text, setText] = useState('')
      var [msg, setMsg] = useState('')

      var loadSample = function () {
        setText(JSON.stringify(DEFAULT_COURSES, null, 2))
      }
      var restoreBuiltin = function () {
        props.call('restoreCourses', {})
          .then(function (arr) { props.onChange(arr); setMsg('已恢复内置课表 ' + (arr ? arr.length : 0) + ' 条') })
          .catch(function (e) { setMsg('恢复失败：' + e.message) })
      }
      var importText = function () {
        try {
          var arr = JSON.parse(text)
          if (!Array.isArray(arr)) throw new Error('应为 JSON 数组')
          props.call('saveCourses', { courses: arr })
            .then(function () { props.onChange(arr); setMsg('已导入 ' + arr.length + ' 条课表') })
            .catch(function (e) { setMsg('导入失败：' + e.message) })
        } catch (e) {
          setMsg('解析失败：' + e.message)
        }
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, '课表管理'),
        card(null, [
          h('div', { style: { fontSize: 13, color: 'var(--muted)', marginBottom: 8 } },
            '支持 JSON 数组导入，字段：day(1-7 周一~周日)、period(1-5 大节)、name、teacher、room、weeks。'),
          h('textarea', {
            value: text, onChange: function (e) { setText(e.target.value) }, rows: 10,
            placeholder: '在此粘贴课表 JSON，或点击“载入示例”',
            style: Object.assign({}, inputStyle(), { width: '100%', resize: 'vertical', fontFamily: 'monospace' }),
          }),
          h('div', { style: { marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 } }, [
            btn('载入示例', loadSample),
            btn('导入课表', importText, 'primary'),
            btn('恢复内置课表', restoreBuiltin),
          ]),
        ]),
        msg ? h('div', { style: { fontSize: 12, color: 'var(--muted)' } }, msg) : null,
        card(null, [
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '当前课表（' + (props.courses ? props.courses.length : 0) + ' 条）'),
          (props.courses && props.courses.length)
            ? h('div', { style: { fontSize: 13, maxHeight: 240, overflow: 'auto' } },
                props.courses.map(function (c, i) {
                  return h('div', { key: i, style: { padding: '4px 0', borderBottom: '1px solid var(--border)' } },
                    '周' + WEEK[c.day - 1] + ' 第' + c.period + '节 · ' + c.name + (c.teacher ? '（' + c.teacher + '）' : '') + (c.room ? ' @' + c.room : ''))
                }))
            : h('div', { style: { fontSize: 13, color: 'var(--muted)' } }, '暂无课表'),
        ]),
      ])
    }

    // -------------------------------------------------------------------
    // Settings + data backup
    // -------------------------------------------------------------------
    function SettingsPanel(props) {
      var s = props.settings || {}
      var [goal, setGoal] = useState(s.sleepGoalMin || 480)
      var [wakeBy, setWakeBy] = useState(s.wakeBy || '07:00')
      var [theme, setTheme] = useState(s.theme || 'auto')
      var [msg, setMsg] = useState('')
      var [info, setInfo] = useState(null)

      useEffect(function () {
        props.call('getInfo', {}).then(setInfo).catch(function () {})
      }, [props.call])

      var save = function () {
        props.call('setSettings', { sleepGoalMin: goal, wakeBy: wakeBy, theme: theme })
          .then(function (ns) { props.onSaved(ns); setMsg('已保存设置') })
          .catch(function (e) { setMsg('保存失败：' + e.message) })
      }

      var exportData = function () {
        props.call('exportAll', {})
          .then(function (snap) {
            var blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' })
            var url = URL.createObjectURL(blob)
            var a = document.createElement('a')
            a.href = url
            a.download = 'sleep-data-' + new Date().toISOString().slice(0, 10) + '.json'
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
            setMsg('已导出数据文件')
          })
          .catch(function (e) { setMsg('导出失败：' + e.message) })
      }

      var importData = function (e) {
        var file = e.target.files && e.target.files[0]
        if (!file) return
        var reader = new FileReader()
        reader.onload = function () {
          var parsed
          try {
            parsed = JSON.parse(String(reader.result))
          } catch (err) {
            setMsg('导入失败：' + err.message)
            return
          }
          props.call('importAll', { data: parsed })
            .then(function (r) {
              setMsg('导入成功：' + r.days + ' 天记录、' + r.courses + ' 条课表')
              props.onReload()
            })
            .catch(function (err) { setMsg('导入失败：' + err.message) })
        }
        reader.readAsText(file)
        e.target.value = ''
      }

      var clearData = function () {
        if (!window.confirm('确定清空全部睡眠记录、日记与课表？此操作不可撤销。')) return
        props.call('clearAll', {})
          .then(function () { setMsg('已清空全部数据'); props.onReload() })
          .catch(function (e) { setMsg('清空失败：' + e.message) })
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', { style: { fontSize: 16, fontWeight: 600 } }, '设置'),
        card(null, [
          field('目标睡眠时长（小时）', h('input', {
            type: 'number', min: 4, max: 12, step: 0.5, value: (goal / 60).toFixed(1),
            onChange: function (e) { setGoal(Math.round(parseFloat(e.target.value) * 60)) }, style: inputStyle(),
          })),
          h('div', { style: { marginTop: 10 } }, field('常用起床时间', h('input', {
            type: 'time', value: wakeBy, onChange: function (e) { setWakeBy(e.target.value) }, style: inputStyle(),
          }))),
          h('div', { style: { marginTop: 10 } }, [
            h('span', { style: { color: 'var(--muted)', fontSize: 13 } }, '主题：'),
            ['auto', 'light', 'dark'].map(function (t) {
              return h('button', {
                key: t, onClick: function () { setTheme(t); if (props.onThemeChange) props.onThemeChange(t) },
                style: {
                  marginLeft: 6, padding: '4px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
                  border: '1px solid var(--border)',
                  background: theme === t ? 'var(--accent)' : 'var(--panel2)',
                  color: theme === t ? '#fff' : 'var(--fg)',
                },
              }, t === 'auto' ? '跟随系统' : t === 'light' ? '浅色' : '深色')
            }),
          ]),
          h('div', { style: { marginTop: 12 } }, btn('保存设置', save, 'primary')),
        ]),
        msg ? h('div', { style: { fontSize: 12, color: 'var(--muted)' } }, msg) : null,
        card(null, [
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '数据备份'),
          h('div', { style: { fontSize: 13, color: 'var(--muted)', marginBottom: 10 } },
            '数据由 DSH Host 保存在本机 JSON 文件，不写入浏览器。换设备或重装前建议先导出备份。'),
          info ? h('div', { style: { fontSize: 12, color: 'var(--muted)', marginBottom: 10, wordBreak: 'break-all' } },
            '存储位置：' + info.file) : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } }, [
            btn('导出数据', exportData),
            btn('导入数据', function () { document.getElementById('dsh-sleep-import-file').click() }),
            btn('清空数据', clearData),
            h('input', {
              id: 'dsh-sleep-import-file', type: 'file', accept: 'application/json,.json',
              onChange: importData, style: { display: 'none' },
            }),
          ]),
        ]),
      ])
    }

    // -------------------------------------------------------------------
    // Top-level App
    // -------------------------------------------------------------------
    function App(props) {
      var call = props.call
      var now = new Date()
      var [settings, setSettings] = useState({ sleepGoalMin: 480, wakeBy: '07:00', theme: 'auto' })
      var [year, setYear] = useState(now.getFullYear())
      var [month, setMonth] = useState(now.getMonth() + 1)
      var [days, setDays] = useState({})
      var [selected, setSelected] = useState(
        now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'))
      var [courses, setCourses] = useState([])
      var [tab, setTab] = useState('calendar')
      var [record, setRecord] = useState(null)
      var [loadingDay, setLoadingDay] = useState(false)
      var [previewTheme, setPreviewTheme] = useState(null)
      var [recent, setRecent] = useState({})
      var [hist30, setHist30] = useState({})
      var [checkMsg, setCheckMsg] = useState('')
      var [closed, setClosed] = useState(false)

      var todayKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')

      var refreshMonth = useCallback(function () {
        call('getMonth', { year: year, month: month }).then(setDays).catch(function () {})
      }, [year, month, call])
      var refreshSettings = useCallback(function () {
        call('getSettings', {}).then(setSettings).catch(function () {})
        call('getCourses', {}).then(function (arr) {
          setCourses(Array.isArray(arr) ? arr : [])
        }).catch(function () { setCourses(DEFAULT_COURSES.slice()) })
      }, [call])
      useEffect(function () { refreshSettings() }, [refreshSettings])
      useEffect(function () { refreshMonth() }, [refreshMonth])

      var loadDay = useCallback(function (key) {
        setLoadingDay(true)
        call('getDay', { dateKey: key }).then(function (d) { setRecord(d); setLoadingDay(false) }).catch(function () { setRecord(null); setLoadingDay(false) })
      }, [call])
      useEffect(function () { loadDay(selected) }, [selected, loadDay])

      // 近 7 天睡眠（供「今日建议」算缺口，跨月也能取到）
      var loadRecent = useCallback(function (key) {
        call('getRange', { from: addDays(key, -7), to: key })
          .then(function (r) { setRecent(r || {}) })
          .catch(function () { setRecent({}) })
      }, [call])
      useEffect(function () { loadRecent(selected) }, [selected, loadRecent])

      var loadHist = useCallback(function (key) {
        call('getRange', { from: addDays(key, -30), to: key })
          .then(function (r) { setHist30(r || {}) })
          .catch(function () { setHist30({}) })
      }, [call])
      useEffect(function () { loadHist(todayKey) }, [loadHist])

      var onDaySaved = function (d) { setRecord(d); refreshMonth(); loadRecent(selected); loadHist(todayKey) }
      var onSettingsSaved = function (ns) { setSettings(ns); setPreviewTheme(null) }
      var onReload = function () {
        refreshSettings()
        refreshMonth()
        loadDay(selected)
        loadRecent(selected)
      }

      function shiftMonth(delta) {
        var m = month + delta
        var y = year
        if (m < 1) { m = 12; y-- }
        if (m > 12) { m = 1; y++ }
        setYear(y); setMonth(m)
      }

      var effectiveTheme = previewTheme || (settings && settings.theme) || 'auto'
      var dark = useDarkMode(effectiveTheme)
      var pal = palette(dark)

      var rootStyle = { position: 'absolute', inset: 0, overflow: 'auto', padding: 18, background: 'var(--bg)', color: 'var(--fg)', fontSize: 14, boxSizing: 'border-box' }
      for (var k in pal) rootStyle[k] = pal[k]

      // ---- 日历下方：近 7 天概览 + 今晚就寝倒计时 ----
      var goalMin = (settings && settings.sleepGoalMin) || 480
      var st7 = sleepStats(recent, selected, goalMin)
      var recStreak = 0
      for (var si = 0; si < 14; si++) {
        var rk = addDays(selected, -si)
        var rr = recent[rk] && recent[rk].sleep
        if (rr && rr.bedtime && rr.wakeTime) recStreak++
        else if (si === 0) continue
        else break
      }
      var plan7 = dailyPlan(todayKey, courses, recent, settings)
      var [tick, setTick] = useState(new Date())
      useEffect(function () {
        if (typeof setInterval === 'undefined') return function () {}
        var t = setInterval(function () { setTick(new Date()) }, 30000)
        return function () { clearInterval(t) }
      }, [])
      var nowMin = tick.getHours() * 60 + tick.getMinutes()
      var bedMin = toMin(plan7.bedTime)
      var bedDelta = bedMin - nowMin
      if (bedDelta < -360) bedDelta += 1440
      var wakeMin = toMin(plan7.wakeTime)
      var nowToWake = wakeMin - nowMin
      if (nowToWake < 0) nowToWake += 1440
      function cdText(m) { var h = Math.floor(m / 60); var mm = m % 60; return (h ? h + ' 小时 ' : '') + mm + ' 分' }
      var statCell = function (label, value) {
        return h('div', { style: { flex: '1 1 40%', minWidth: 110, padding: '6px 2px' } }, [
          h('div', { style: { fontSize: 12, color: 'var(--muted)' } }, label),
          h('div', { style: { fontSize: 18, fontWeight: 700, marginTop: 2 } }, value),
        ])
      }
      var tomorrowFirst = firstCourseOf(courses, addDays(todayKey, 1))
      var weekCard = card(null, [
        h('div', { style: { fontWeight: 600, marginBottom: 6, fontSize: 13 } }, '近 7 天概览'),
        st7.count === 0
          ? h('div', { style: { color: 'var(--muted)', fontSize: 13, padding: '4px 0' } }, '还没有记录 — 在右边表单补一条昨晚的睡眠，这里就会开始有数据。')
          : h('div', { style: { display: 'flex', flexWrap: 'wrap' } }, [
              statCell('已记录', st7.count + ' / 7 天'),
              statCell('平均睡眠', fmtDur(st7.avg)),
              statCell('连续记录', recStreak + ' 天'),
              statCell('睡眠欠债', st7.debt + ' 分钟'),
            ]),
      ])
      var nowStr = String(tick.getHours()).padStart(2, '0') + ':' + String(tick.getMinutes()).padStart(2, '0')
      var tonightCard = card(null, [
        h('div', { style: { display: 'flex', alignItems: 'center' } }, [
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, '今晚就寝'),
          h('div', { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' } }, '现在 ' + nowStr),
        ]),
        h('div', { style: { fontSize: 19, fontWeight: 700, margin: '8px 0 4px' } },
          bedDelta > 0 ? '距建议就寝 ' + plan7.bedTime + ' 还有 ' + cdText(bedDelta) : '已过建议就寝 ' + cdText(-bedDelta) + '，该睡了'),
        h('div', { style: { fontSize: 12, color: 'var(--muted)' } },
          '现在睡到 ' + plan7.wakeTime + ' 起床 ≈ ' + fmtDur(nowToWake)
          + (tomorrowFirst ? ' · 明日首节 ' + PERIOD_START[tomorrowFirst.period] + ' ' + (tomorrowFirst.name || '') : ' · 明天没课')),
      ])
      var fs = funStats(hist30, todayKey, goalMin)
      var funCard = card(null, [
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 14 } }, [
          h('div', { style: { fontSize: 42, lineHeight: 1 } }, fs.pet.emoji),
          h('div', { style: { flex: 1 } }, [
            h('div', { style: { fontWeight: 700 } },
              fs.lv.emoji + ' ' + fs.lv.title + (fs.streak >= 2 ? '   🔥 ' + fs.streak + ' 天' : '')),
            h('div', { style: { fontSize: 12, color: 'var(--muted)', marginTop: 3 } },
              fs.nextLv ? '再记录 ' + (fs.nextLv.need - fs.total) + ' 天升到「' + fs.nextLv.title + '」 · ' + fs.pet.text
                        : fs.pet.text),
          ]),
        ]),
        h('div', { style: { marginTop: 12 } }, [
          h('div', { style: { fontSize: 12, color: 'var(--muted)', marginBottom: 4 } },
            '本周挑战：睡够目标 ' + Math.min(fs.weekEnough, 5) + ' / 5 天'),
          h('div', { style: { height: 8, borderRadius: 999, background: 'var(--panel2)', overflow: 'hidden' } },
            h('div', { style: { width: Math.round(Math.min(fs.weekEnough, 5) / 5 * 100) + '%', height: '100%', background: 'var(--accent)', borderRadius: 999 } })),
        ]),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
          fs.badges.map(function (b) {
            return h('div', { key: b.name, title: b.name, style: {
              width: 48, textAlign: 'center', padding: '6px 2px', borderRadius: 10,
              opacity: b.got ? 1 : 0.35,
              background: b.got ? 'var(--panel2)' : 'transparent', border: '1px solid var(--border)',
            } }, [
              h('div', { style: { fontSize: 20, lineHeight: 1.2 } }, b.icon),
              h('div', { style: { fontSize: 10, color: 'var(--muted)', marginTop: 2 } }, b.name),
            ])
          })),
      ])
      var quickCheck = function () {
        call('saveSleep', { dateKey: todayKey, sleep: { bedtime: plan7.bedTime, wakeTime: plan7.wakeTime, quality: 3, note: '' } })
          .then(function () { setCheckMsg('打卡成功 ✔ 小精灵和徽章已更新'); onReload() })
          .catch(function () { setCheckMsg('保存失败，请用右边表单手动记一条') })
      }
      var checkCard = card(null, [
        h('button', {
          onClick: quickCheck,
          style: { width: '100%', border: 'none', borderRadius: 10, padding: '12px', background: 'var(--accent)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' },
        }, '✅ 一键打卡：昨晚 ' + plan7.bedTime + ' 睡 → ' + plan7.wakeTime + ' 起'),
        checkMsg ? h('div', { style: { fontSize: 12, color: 'var(--good)', marginTop: 8, textAlign: 'center' } }, checkMsg) : null,
      ])

      // 退出：DSH 里优先点侧边栏的"对话/聊天"导航切回对话页；其次 history.back；
      // 再兜底点自己的月亮图标；网页版尝试 window.close()。都不行就把面板收成一行提示。
      var inDSH = typeof window !== 'undefined' && !!window.__ModuleLoader__
      var onExit = function () {
        if (inDSH) {
          // 1) 点侧边栏里的"对话 / 聊天 / 首页"导航，真正切回 DSH 对话页
          try {
            var navs = document.querySelectorAll('aside [role="button"], aside button, aside a, nav [role="button"], nav button, [class*="sidebar"] [role="button"], [class*="sidebar"] button')
            var re = /对话|聊天|首页|主页|新会话|新对话|会话|Chat|Home/i
            for (var i = 0; i < navs.length; i++) {
              var n = navs[i]
              var t = ((n.getAttribute && n.getAttribute('aria-label')) || n.title || n.textContent || '') + ''
              if (t && re.test(t) && !/作息睡眠/.test(t)) { n.click(); break }
            }
          } catch (e) {}
          // 2) 路由式返回
          try { if (history.length > 1) history.back() } catch (e2) {}
          // 3) 兜底：点自己的月亮图标（切换关闭面板）
          try {
            var mine = document.querySelector('[title="作息睡眠"], [aria-label="作息睡眠"]')
            if (mine) { var wrap = mine.closest('button,[role="button"],a') || mine; wrap.click() }
          } catch (e3) {}
        } else {
          try { window.close() } catch (e) {}
        }
        setClosed(true)
      }
      if (closed) {
        return h('div', { style: rootStyle },
          h('div', { style: { color: '#9aa5b1', fontSize: 13, padding: '40px 0', textAlign: 'center' } },
            '已退出 · 点左侧 🌙 图标重新打开'))
      }

      return h('div', { style: rootStyle }, [
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } }, [
          h('div', { style: { fontSize: 18, fontWeight: 700 } }, '🌙 作息睡眠'),
          h('div', { title: '当前插件版本', style: { marginLeft: 8, fontSize: 11, color: '#9aa5b1', padding: '2px 6px', border: '1px solid #e4e7eb', borderRadius: 8 } }, 'v0.2.8'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } }, [
            tabBtn('calendar', '日历', tab, setTab),
            tabBtn('courses', '课表', tab, setTab),
            tabBtn('settings', '设置', tab, setTab),
            h('button', {
              onClick: onExit, title: '退出',
              style: { border: '1px solid var(--border)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 13, background: 'var(--panel2)', color: 'var(--fg)', marginLeft: 4 },
            }, '退出 ✕'),
          ]),
        ]),
        tab === 'calendar'
          ? h('div', null, [
              (function () {
                var tp = dailyPlan(todayKey, courses, recent, settings)
                var tc = ({ good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--accent)' })[tp.tone]
                return h('div', {
                  style: {
                    display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
                    marginBottom: 12, padding: '10px 14px', borderRadius: 12,
                    background: 'var(--panel)', border: '1px solid var(--border)', borderLeft: '3px solid ' + tc,
                  },
                }, [
                  h('span', { style: { fontSize: 11, padding: '1px 8px', borderRadius: 999, color: tc, border: '1px solid ' + tc } }, tp.tag),
                  h('span', { style: { fontSize: 13, fontWeight: 600, lineHeight: 1.6 } }, tp.headline),
                  h('span', { style: { marginLeft: 'auto', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' } },
                    '起床 ' + tp.wakeTime + ' · 就寝 ' + tp.bedTime),
                ])
              })(),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' } }, [
              h('div', { style: { flex: '1 1 420px', minWidth: 320, display: 'flex', flexDirection: 'column', gap: 18 } }, [
                card({ position: 'relative' }, [
                  h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 10 } }, [
                    btn('‹', function () { shiftMonth(-1) }, null),
                    h('div', { style: { fontWeight: 600, minWidth: 120, textAlign: 'center' } }, year + ' 年 ' + month + ' 月'),
                    btn('›', function () { shiftMonth(1) }, null),
                  ]),
                  h(Calendar, { year: year, month: month, days: days, courses: courses, selected: selected, onSelect: setSelected, goal: settings.sleepGoalMin, todayKey: todayKey }),
                ]),
                weekCard,
                tonightCard,
                funCard,
                checkCard,
              ]),
              card({ flex: '1 1 360px', minWidth: 320 }, loadingDay ? '加载中…' : h(DayPanel, {
                dateKey: selected, record: record, courses: courses, days: recent, settings: settings, call: call, onSaved: onDaySaved,
              })),
              ]),
            ])
          : null,
        tab === 'courses' ? h(CourseManager, { courses: courses, call: call, onChange: setCourses }) : null,
        tab === 'settings' ? h(SettingsPanel, {
          settings: settings, call: call, onSaved: onSettingsSaved, onThemeChange: setPreviewTheme, onReload: onReload,
        }) : null,
      ])
    }

    function tabBtn(key, label, tab, setTab) {
      var active = tab === key
      return h('button', {
        onClick: function () { setTab(key) },
        style: {
          border: '1px solid var(--border)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 13,
          background: active ? 'var(--accent)' : 'var(--panel2)', color: active ? '#fff' : 'var(--fg)',
        },
      }, label)
    }

    // -------------------------------------------------------------------
    // Plugin wiring
    // -------------------------------------------------------------------
    var inject = ['slots', 'connection']
    function apply(ctx) {
      var connection = ctx.get('connection')
      var call = function (endpoint, payload) {
        return connection.rpc.call(RPC_CHANNEL, endpoint, payload)
      }
      // Sidebar entry (icon). Clicking it opens the main panel with the same id.
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 50,
          label: function () { return '作息睡眠' },
        }, function () {
          return h('span', { title: '作息睡眠', style: { fontSize: 18 } }, '🌙')
        })
      })
      // Central main panel.
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, function () {
          return h(App, { call: call })
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-sleep-tracker'
    // 仅用于 scripts/selftest.mjs 的离线自测，DSH 不会读取该字段。
    exports.__components = {
      App: App, Calendar: Calendar, DayPanel: DayPanel,
      CourseManager: CourseManager, SettingsPanel: SettingsPanel,
      evaluate: evaluate, durationMin: durationMin, planAdvice: planAdvice, dailyPlan: dailyPlan,
    }
    return module.exports
  },
})
