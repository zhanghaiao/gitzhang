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

    function useDarkMode(settings) {
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
      if (settings && settings.theme === 'light') return false
      if (settings && settings.theme === 'dark') return true
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
          if (dayNum == null) { row.push(h('div', { style: { padding: 6 } }, '')); continue }
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
              position: 'relative', padding: '8px 4px', margin: 2, borderRadius: 8,
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
            return h('div', { key: w, style: { flex: 1, textAlign: 'center', fontSize: 12, color: 'var(--muted)' } }, '周' + w)
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
      { day: 2, period: 3, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },
      { day: 3, period: 3, name: '大模型应用与数字实践', teacher: '耿直', room: '立德楼616室', weeks: '8-9' },

      { day: 1, period: 4, name: '思想道德与法治', teacher: '张佳倩', room: '尚德楼A315室', weeks: '8-11,14-17' },
      { day: 2, period: 4, name: '形势与政策', teacher: '张佳倩', room: '尚德楼A315室', weeks: '12-13' },
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
            '支持 JSON 数组导入，字段：day(1-7 周一~周日)、period(1-5 大节)、name、teacher、room。'),
          h('textarea', {
            value: text, onChange: function (e) { setText(e.target.value) }, rows: 10,
            placeholder: '在此粘贴课表 JSON，或点击“载入示例”',
            style: Object.assign({}, inputStyle(), { width: '100%', resize: 'vertical', fontFamily: 'monospace' }),
          }),
          h('div', { style: { marginTop: 10, display: 'flex', gap: 8 } }, [
            btn('载入示例', loadSample),
            btn('导入课表', importText, 'primary'),
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
    // Settings
    // -------------------------------------------------------------------
    function SettingsPanel(props) {
      var s = props.settings || {}
      var [goal, setGoal] = useState(s.sleepGoalMin || 480)
      var [wakeBy, setWakeBy] = useState(s.wakeBy || '07:00')
      var [theme, setTheme] = useState(s.theme || 'auto')
      var save = function () {
        props.call('setSettings', { sleepGoalMin: goal, wakeBy: wakeBy, theme: theme })
          .then(function (ns) { props.onSaved(ns); setMsg2('已保存设置') })
          .catch(function (e) { setMsg2('保存失败：' + e.message) })
      }
      var [m2, setMsg2] = useState('')
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
                key: t, onClick: function () { setTheme(t) },
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
        m2 ? h('div', { style: { fontSize: 12, color: 'var(--muted)' } }, m2) : null,
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
        year + '-' + String(month).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0'))
      var [courses, setCourses] = useState([])
      var [tab, setTab] = useState('calendar')
      var [record, setRecord] = useState(null)
      var [loadingDay, setLoadingDay] = useState(false)

      var todayKey = year + '-' + String(month).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')

      var refreshMonth = useCallback(function () {
        call('getMonth', { year: year, month: month }).then(setDays).catch(function () {})
      }, [year, month, call])
      var refreshSettings = useCallback(function () {
        call('getSettings', {}).then(setSettings).catch(function () {})
        call('getCourses', {}).then(setCourses).catch(function () {})
      }, [call])
      useEffect(function () { refreshSettings() }, [refreshSettings])
      useEffect(function () { refreshMonth() }, [refreshMonth])

      var loadDay = useCallback(function (key) {
        setLoadingDay(true)
        call('getDay', { dateKey: key }).then(function (d) { setRecord(d); setLoadingDay(false) }).catch(function () { setRecord(null); setLoadingDay(false) })
      }, [call])
      useEffect(function () { loadDay(selected) }, [selected, loadDay])

      var onDaySaved = function (d) { setRecord(d); refreshMonth() }

      var dark = useDarkMode(settings)
      var pal = palette(dark)

      var styleVars = {}
      for (var k in pal) styleVars[k] = pal[k]

      return h('div', {
        style: Object.assign({
          position: 'absolute', inset: 0, overflow: 'auto', padding: 18,
          background: 'var(--bg)', color: 'var(--fg)', fontSize: 14, boxSizing: 'border-box',
        }, styleVars),
      }, [
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 14 } }, [
          h('div', { style: { fontSize: 18, fontWeight: 700 } }, '🌙 作息睡眠'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } }, [
            tabBtn('calendar', '日历', tab, setTab),
            tabBtn('courses', '课表', tab, setTab),
            tabBtn('settings', '设置', tab, setTab),
          ]),
        ]),
        tab === 'calendar'
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' } }, [
              card({ flex: '1 1 420px', minWidth: 320, position: 'relative' }, [
                h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 10 } }, [
                  btn('‹', function () { shiftMonth(-1) }, null),
                  h('div', { style: { fontWeight: 600, minWidth: 120, textAlign: 'center' } }, year + ' 年 ' + month + ' 月'),
                  btn('›', function () { shiftMonth(1) }, null),
                ]),
                h(Calendar, { year: year, month: month, days: days, courses: courses, selected: selected, onSelect: setSelected, goal: settings.sleepGoalMin, todayKey: todayKey }),
              ]),
              card({ flex: '1 1 360px', minWidth: 320 }, loadingDay ? '加载中…' : h(DayPanel, {
                dateKey: selected, record: record, courses: courses, settings: settings, call: call, onSaved: onDaySaved,
              })),
            ])
          : null,
        tab === 'courses' ? h(CourseManager, { courses: courses, call: call, onChange: setCourses }) : null,
        tab === 'settings' ? h(SettingsPanel, { settings: settings, call: call, onSaved: setSettings }) : null,
      ])

      function shiftMonth(delta) {
        var m = month + delta
        var y = year
        if (m < 1) { m = 12; y-- }
        if (m > 12) { m = 1; y++ }
        setYear(y); setMonth(m)
      }
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
    return module.exports
  },
})
