// DSH Sleep Tracker — Host half (Node.js, ESM)
//
// Responsibilities:
//   1. Persist all user data (sleep records, diaries, courses, settings) to a
//      local JSON file under DSH_HOME. The browser client NEVER stores this
//      data itself; it reaches it exclusively through the RPC channel below.
//   2. Expose a loopback RPC channel over the Host's web server so the browser
//      client can read/write the store. No external server is involved.
//
// This file is the package "main" entry. DSH loads it in the Host process and
// calls `apply(ctx)`.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PLUGIN_ID = 'dsh-sleep-tracker'
const RPC_CHANNEL = '/rpc/dsh-sleep-tracker'

const DEFAULT_SETTINGS = {
  sleepGoalMin: 480,        // 目标睡眠时长（分钟），默认 8 小时
  wakeBy: '07:00',          // 默认起床时间，用于推算就寝时间
  theme: 'auto',            // auto | light | dark
}

// 默认课表（淄博职业技术大学 人工智能实验班，2026-2027-1 学期）
// 与 client.js 中的 DEFAULT_COURSES 保持一致。
const DEFAULT_COURSES = [
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

// ---------------------------------------------------------------------------
// Store: atomic JSON persistence
// ---------------------------------------------------------------------------

class Store {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'data.json')
    this.data = { settings: { ...DEFAULT_SETTINGS }, days: {}, courses: [] }
    this.lastError = null
  }

  async load() {
    let existed = false
    try {
      mkdirSync(this.dir, { recursive: true })
      if (existsSync(this.file)) {
        existed = true
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
        this.data = {
          settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
          days: parsed.days || {},
          courses: Array.isArray(parsed.courses) ? parsed.courses : [],
        }
      }
    } catch (e) {
      this.lastError = String(e)
    }
    // 首次运行（无数据文件）时，预置默认课表，使日历直接显示课程。
    if (!existed) this.data.courses = DEFAULT_COURSES.slice()
    return this
  }

  async save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.file)
    this.lastError = null
  }

  getSettings() {
    return this.data.settings
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch }
    return this.data.settings
  }

  getDay(dateKey) {
    return this.data.days[dateKey] || null
  }

  getMonth(year, month) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`
    const out = {}
    for (const [k, v] of Object.entries(this.data.days)) {
      if (k.startsWith(prefix)) out[k] = v
    }
    return out
  }

  saveDay(dateKey, patch) {
    const prev = this.data.days[dateKey] || {}
    this.data.days[dateKey] = { ...prev, ...patch, dateKey }
    return this.data.days[dateKey]
  }

  getCourses() {
    return this.data.courses
  }

  setCourses(courses) {
    this.data.courses = Array.isArray(courses) ? courses : []
    return this.data.courses
  }
}

// ---------------------------------------------------------------------------
// Data directory resolution (prefer DSH_HOME, fall back to ~/.dsh)
// ---------------------------------------------------------------------------

function resolveDataDir() {
  const env = process.env
  const candidates = [
    env.DSH_HOME,
    env.DSH_HOME_DIR,
    join(homedir(), '.dsh'),
    join(homedir(), '.deepseek-harness'),
  ].filter(Boolean)

  for (const base of candidates) {
    if (base && existsSync(base)) return join(base, PLUGIN_ID)
  }
  return join(homedir(), '.dsh', PLUGIN_ID)
}

// ---------------------------------------------------------------------------
// RPC handler — signature is (endpoint, payload, signal, peer), matching the
// HostConnectionService's rpcFetchHandler contract.
// ---------------------------------------------------------------------------

function makeHandler(store) {
  return async (endpoint, payload) => {
    switch (endpoint) {
      case 'getSettings':
        return store.getSettings()
      case 'setSettings':
        store.setSettings(payload || {})
        await store.save()
        return store.getSettings()

      case 'getDay':
        return store.getDay((payload && payload.dateKey) || '')

      case 'getMonth':
        return store.getMonth(
          (payload && payload.year) || new Date().getFullYear(),
          (payload && payload.month) || new Date().getMonth() + 1,
        )

      case 'saveSleep': {
        const dateKey = (payload && payload.dateKey) || ''
        if (!dateKey) throw new Error('saveSleep requires dateKey')
        const day = store.saveDay(dateKey, { sleep: (payload && payload.sleep) || null })
        await store.save()
        return day
      }

      case 'saveDiary': {
        const dateKey = (payload && payload.dateKey) || ''
        if (!dateKey) throw new Error('saveDiary requires dateKey')
        const day = store.saveDay(dateKey, { diary: (payload && payload.diary) || null })
        await store.save()
        return day
      }

      case 'getCourses':
        return store.getCourses()

      case 'saveCourses':
        store.setCourses((payload && payload.courses) || [])
        await store.save()
        return store.getCourses()

      default:
        throw new Error(`unknown endpoint: ${endpoint}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  ctx.inject(['connection'], (cctx) => {
    const connection = cctx.get('connection')
    const store = new Store(resolveDataDir())

    store.load().then(() => {
      const dispose = connection.rpc.handle(RPC_CHANNEL, makeHandler(store))
      cctx.effect(() => {
        if (typeof dispose === 'function') dispose()
      }, 'dsh-sleep-tracker: rpc channel')
    }).catch((e) => {
      ctx.logger?.error?.('[dsh-sleep-tracker] failed to load store:', e)
    })
  })
}

export const name = PLUGIN_ID
