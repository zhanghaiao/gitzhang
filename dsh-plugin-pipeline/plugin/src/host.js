// dsh-pipeline — Host half (Node.js, ESM)
//
// Registers a DSH loopback RPC channel and delegates every operation to the
// bundled local CLI (scripts/dsh_pipeline.py).
//
// DSH connection contract (packages/client/connection):
//   * channel must be a SINGLE segment: /^[A-Za-z0-9._~-]+$/ after the slash,
//     and `/api` is reserved. A two-segment channel such as `/rpc/<name>`
//     is rejected client-side with "connection: invalid RPC target ...".
//   * a handler MUST return an envelope { ok: true, value } or
//     { ok: false, error: { code, message, details } }. Throwing instead makes
//     the Host answer HTTP 500 "handler failure", which the Client sees as a
//     transport error rather than a readable message.
//   * the client posts { type:'client-request', rpcId, method, payload } to
//     `<channel>/<endpoint>` and expects
//     { type:'server-response', rpcId, result } back.

import { spawn } from 'node:child_process'
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync,
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, isAbsolute, resolve, sep } from 'node:path'

const PLUGIN_ID = 'dsh-pipeline'
const RPC_CHANNEL = '/dsh-pipeline'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'scripts', 'dsh_pipeline.py')
const CONFIG = join(ROOT, 'assets', 'pipeline.config.json')

// `fetch` is handled on the Host side; the Python CLI stays purely local.
export const ENDPOINTS = ['fetch', 'validate', 'package', 'install', 'run', 'doctor']

// Runtime trace. Host-side JS is loaded once at startup and its failures are
// swallowed by the loader's inject child fiber, so a file trace is the only
// reliable way to tell which registration path actually ran.
export const TRACE_FILE = join(tmpdir(), 'dsh-pipeline-host-trace.log')
export function trace(line) {
  try {
    appendFileSync(TRACE_FILE,
      `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`, 'utf8')
  } catch (_) { /* diagnostics must never break the plugin */ }
}
trace('MODULE_LOADED ' + HERE)

function pythonCandidates() {
  const out = []
  if (process.env.DSH_PYTHON) out.push(process.env.DSH_PYTHON)
  // Windows 上 `python3` 常解析到 WindowsApps 的商店占位程序（不产生输出），
  // 所以把更可靠的 `python` 放前面，并保留 `py` launcher 作为最后兜底。
  out.push('python', 'python3', 'py')
  return [...new Set(out)]
}

// CLI 的 --json 输出可能是单个聚合对象，也可能是（旧版本）逐阶段的多个对象。
// 顶层扫描只识别完整的 {...}，忽略夹杂的普通文本行。
export function parseJsonStream(text) {
  try { return [JSON.parse(text)] } catch (_) { /* fall through */ }
  const objs = []
  let start = -1, depth = 0, inStr = false, esc = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (start < 0) {
      if (ch === '{') { start = i; depth = 1; inStr = false; esc = false }
      continue
    }
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { objs.push(JSON.parse(text.slice(start, i + 1))) } catch (_) { /* skip */ }
        start = -1
      }
    }
  }
  return objs
}

export function mergeResults(objs, fallbackStage) {
  const last = objs[objs.length - 1]
  const states = objs.map((o) => o.status)
  const merged = { ...last }
  // 中间阶段的关键字段（典型是 package 的 artifact_path）不能因聚合而丢失
  for (const key of ['artifact_path', 'install_path', 'name', 'version', 'src',
    'manifest', 'included', 'broken', 'links', 'actions', 'backup']) {
    if (merged[key] === undefined) {
      for (let i = objs.length - 2; i >= 0; i--) {
        if (objs[i][key] !== undefined) { merged[key] = objs[i][key]; break }
      }
    }
  }
  merged.stage = last.stage ?? fallbackStage
  merged.stages = last.stages ?? objs.map((o) => o.stage)
  merged.results = last.results ?? objs
  merged.status = states.includes('fail') ? 'fail' : states.includes('warn') ? 'warn' : 'pass'
  merged.errors = objs.flatMap((o) => o.errors || [])
  merged.log = objs.flatMap((o) => o.log || [])
  return merged
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const candidates = pythonCandidates()
    let lastErr = null

    const attempt = (i) => {
      if (i >= candidates.length) {
        reject(new Error(`未找到可用的 Python 解释器（已尝试 ${candidates.join(', ')}）。可设置环境变量 DSH_PYTHON 指定路径。${lastErr || ''}`))
        return
      }
      const child = spawn(candidates[i], [CLI, ...args, '--json'], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
      child.on('error', (e) => {
        lastErr = String(e.message || e)
        attempt(i + 1)
      })
      child.on('close', () => {
        // 子进程启动成功但命令失败时，stdout 里通常已有结构化结果
        const text = stdout.trim()
        const objs = parseJsonStream(text)
        if (objs.length) {
          resolve(mergeResults(objs, args[0]))
          return
        }
        // 没有任何结构化输出时，无论 stderr 写的是什么都尝试下一个解释器：
        // WindowsApps 的商店占位程序会正常退出但不产生 stdout，仅靠 ENOENT
        // 判断会漏掉这种情况，导致面板显示「CLI 无有效输出」。
        if (i + 1 < candidates.length) {
          lastErr = stderr.trim() || lastErr || 'CLI 未产生结构化输出'
          attempt(i + 1)
          return
        }
        resolve({ status: 'fail', stage: args[0], errors: [], log: [], raw: text,
                  stderr: (stderr.trim() || lastErr || '').slice(0, 800) })
      })
    }
    attempt(0)
  })
}

function buildArgs(endpoint, payload = {}) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const args = [endpoint, '--config', p.config || CONFIG]
  if (endpoint === 'doctor') {
    if (p.profileRoot) args.push('--profile-root', p.profileRoot)
    return args
  }
  if (!p.src || typeof p.src !== 'string') {
    throw new Error('缺少参数 src（插件源码目录），且必须是非空字符串')
  }
  args.push('--src', p.src)
  if (p.out) args.push('--out', p.out)
  if (p.profile) args.push('--profile', p.profile)
  if (p.profileRoot) args.push('--profile-root', p.profileRoot)
  if (p.mode) args.push('--mode', p.mode)
  if (p.skipInstall) args.push('--skip-install')
  if (p.dryRun) args.push('--dry-run')
  return args
}

// ---- fetch: pull third-party plugin source from GitHub --------------------
// The Python CLI remains offline-only. Everything that reaches spawn() is
// validated first: no shell, no user-controlled protocol, no path traversal,
// and an existing non-empty target is never overwritten.
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/
const SAFE_PATH = /^[A-Za-z0-9._~/-]+$/

export function parseRepoUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new Error('缺少参数 url（GitHub 仓库地址）')
  if (/[\s"'`$;&|<>\\]/.test(raw) || raw.includes('..')) {
    throw new Error('仓库地址包含非法字符')
  }
  if (/^[a-z]+:\/\//i.test(raw) && !raw.startsWith('https://')) {
    throw new Error('只允许 https://github.com/ 开头的仓库地址')
  }
  let owner, repo, ref = '', subdir = ''
  if (raw.startsWith('https://')) {
    let u
    try { u = new URL(raw) } catch (_) { throw new Error('仓库地址不是合法 URL') }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') {
      throw new Error('只允许 https://github.com/ 开头的仓库地址')
    }
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length < 2 || !parts[0] || !parts[1]) throw new Error('仓库地址缺少 owner/repo')
    owner = parts[0]
    repo = parts[1].replace(/\.git$/, '')
    if (parts[2] === 'tree' && parts[3]) {
      ref = parts[3]
      subdir = parts.slice(4).join('/')
    }
  } else {
    const parts = raw.split('/')
    if (parts.length !== 2) {
      throw new Error('简写格式应为 owner/repo，或完整 https://github.com/owner/repo')
    }
    owner = parts[0]
    repo = parts[1].replace(/\.git$/, '')
  }
  if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo) ||
      owner === '..' || repo === '..' || repo === '.') {
    throw new Error('owner / repo 含非法字符')
  }
  if (ref && (!SAFE_PATH.test(ref) || ref.includes('..'))) {
    throw new Error('分支或标签含非法字符')
  }
  if (subdir && (!SAFE_PATH.test(subdir) || subdir.includes('..') || subdir.startsWith('/'))) {
    throw new Error('子目录含非法字符')
  }
  return { owner, repo, ref, subdir, cloneUrl: `https://github.com/${owner}/${repo}.git` }
}

export function resolveFetchTarget(payload, parsed, homeDir = homedir()) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const base = p.dest ? resolve(String(p.dest)) : resolve(join(homeDir, '.dsh', 'plugin-sources'))
  if (!isAbsolute(base)) throw new Error('保存目录必须是绝对路径')
  if (base === resolve(homeDir) || base === sep || /^[A-Za-z]:[\\/]?$/i.test(base)) {
    throw new Error('保存目录不能是磁盘根目录或用户主目录')
  }
  const target = join(base, parsed.repo)
  if (target === base) throw new Error('目标目录无效')
  let st = null
  try { st = lstatSync(target) } catch (_) { st = null }
  if (st) {
    // Windows junctions appear here too; never write through them.
    if (st.isSymbolicLink()) throw new Error('目标是符号链接/目录联接，拒绝写入：' + target)
    if (!st.isDirectory()) throw new Error('目标已存在且不是目录：' + target)
    if (readdirSync(target).length > 0) {
      throw new Error('目标目录已存在且非空，拒绝覆盖：' + target)
    }
  }
  return { base, target, src: parsed.subdir ? join(target, parsed.subdir) : target }
}

function fetchFail(code, message, extra) {
  return {
    status: 'fail', stage: 'fetch', stages: ['fetch'], results: [],
    errors: [{ level: 'error', code, message }], log: [], actions: [],
    ...(extra || {}),
  }
}

// opts.spawnFn / opts.homeDir are injection points for offline self-tests.
export async function runFetch(payload, opts = {}) {
  const spawnFn = opts.spawnFn || spawn
  const homeDir = opts.homeDir || homedir()
  const p = payload && typeof payload === 'object' ? payload : {}
  let parsed
  try { parsed = parseRepoUrl(p.url) }
  catch (e) { return fetchFail('FETCH_BAD_URL', String(e && e.message || e)) }

  if (typeof p.ref === 'string' && p.ref.trim()) {
    const r = p.ref.trim()
    if (!SAFE_PATH.test(r) || r.includes('..')) return fetchFail('FETCH_BAD_REF', '分支或标签含非法字符')
    parsed.ref = r
  }
  if (typeof p.subdir === 'string' && p.subdir.trim()) {
    const s = p.subdir.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!SAFE_PATH.test(s) || s.includes('..')) return fetchFail('FETCH_BAD_SUBDIR', '子目录含非法字符')
    parsed.subdir = s
  }

  let paths
  try { paths = resolveFetchTarget(p, parsed, homeDir) }
  catch (e) { return fetchFail('FETCH_DEST_INVALID', String(e && e.message || e)) }

  const args = ['clone', '--depth', '1']
  if (parsed.ref) args.push('--branch', parsed.ref)
  args.push(parsed.cloneUrl, paths.target)

  try {
    if (existsSync(paths.target)) rmSync(paths.target, { recursive: true, force: true })
    mkdirSync(paths.base, { recursive: true })
  } catch (e) {
    return fetchFail('FETCH_DEST_IO', '准备目录失败：' + String(e && e.message || e))
  }

  const run = await new Promise((done) => {
    let stdout = '', stderr = ''
    let child
    try {
      child = spawnFn('git', args, {
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 120000,
      })
    } catch (e) {
      done({ code: -1, stderr: String(e && e.message || e), stdout }); return
    }
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (e) => done({ code: -1, stdout, stderr: String(e && e.message || e) }))
    child.on('close', (code) => done({ code, stdout, stderr }))
  })
  if (run.code !== 0) {
    return fetchFail('FETCH_CLONE_FAILED',
      `git clone 失败（退出码 ${run.code}）：${(run.stderr || '').trim().slice(-800)}`,
      { target: paths.target, url: parsed.cloneUrl })
  }

  const errors = []
  let name = null, version = null, manifest = null
  if (!existsSync(paths.src)) {
    errors.push({ level: 'warn', code: 'FETCH_SUBDIR_MISSING',
                  message: '子目录不存在，请确认 subdir：' + paths.src })
  } else {
    const manifestPath = join(paths.src, 'package.json')
    if (!existsSync(manifestPath)) {
      errors.push({ level: 'warn', code: 'FETCH_NO_MANIFEST',
                    message: '该目录没有 package.json；插件在子目录时请填写子目录' })
    } else {
      try {
        const j = JSON.parse(readFileSync(manifestPath, 'utf8'))
        name = j.name || null
        version = j.version || null
        manifest = manifestPath
      } catch (e) {
        errors.push({ level: 'warn', code: 'FETCH_BAD_MANIFEST',
                      message: 'package.json 无法解析：' + String(e && e.message || e) })
      }
    }
  }
  return {
    status: errors.length ? 'warn' : 'pass',
    stage: 'fetch', stages: ['fetch'], results: [], errors,
    log: ['git clone --depth 1 ' + parsed.cloneUrl, '目标目录：' + paths.target],
    actions: ['clone'],
    url: parsed.cloneUrl, ref: parsed.ref || null, subdir: parsed.subdir || null,
    target: paths.target, src: paths.src, manifest, name, version,
  }
}

export function makeHandler() {
  return async function handler(endpoint, payload) {
    if (!ENDPOINTS.includes(endpoint)) {
      return {
        ok: false,
        error: {
          code: 'dsh-pipeline/unknown-endpoint',
          message: `unknown endpoint: ${endpoint}`,
          details: {},
        },
      }
    }
    if (endpoint === 'fetch') {
      try {
        return { ok: true, value: await runFetch(payload) }
      } catch (e) {
        return {
          ok: false,
          error: {
            code: 'dsh-pipeline/fetch-failure',
            message: String(e && e.message || e), details: {},
          },
        }
      }
    }
    try {
      return { ok: true, value: await runCli(buildArgs(endpoint, payload)) }
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'dsh-pipeline/invalid-arguments',
          message: String(e && e.message || e),
          details: {},
        },
      }
    }
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (Buffer.byteLength(body) > 1024 * 1024) {
        reject(new Error('request body is too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

// Fallback route: registers straight on webServer and speaks DSH's RPC wire
// protocol itself. It does NOT depend on the `connection` service being ready,
// which is the fragile part of `connection.rpc.handle()`.
export function makeFallbackHandler(ctx, handler) {
  return async function fallback(req, res) {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
      if (connection && typeof connection.requestRejection === 'function') {
        const rejection = connection.requestRejection({ headers: req.headers })
        if (rejection) {
          res.statusCode = rejection
          res.end('unauthorized')
          return
        }
      } else if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      const pathname = (req.url || '').split('?')[0]
      const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`)
        ? pathname.slice(RPC_CHANNEL.length + 1)
        : undefined
      if (!endpoint || !ENDPOINTS.includes(endpoint)) {
        sendJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      const message = await readJsonBody(req)
      if (message && message.type !== 'client-request') {
        sendJson(res, 400, { ok: false, error: 'invalid client-request message' })
        return
      }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      if (message.method !== endpoint) {
        sendJson(res, 200, {
          type: 'server-response', rpcId,
          result: { ok: false, error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          } },
        })
        return
      }
      const result = await handler(endpoint, message.payload)
      sendJson(res, 200, { type: 'server-response', rpcId, result })
    } catch (e) {
      sendJson(res, 200, {
        type: 'server-response', rpcId: 'invalid-request',
        result: { ok: false, error: {
          code: 'dsh-pipeline/handler-failure',
          message: String(e && e.message || e), details: {},
        } },
      })
    }
  }
}

// Module-level `inject` is important: without it cordis calls apply() as soon
// as the entry is composed, possibly BEFORE the web carrier exists. Bundles
// that reliably register Host routes (e.g. dsh-completed-ding) declare it.
export const inject = ['webServer']

export function apply(ctx) {
  trace('APPLY_CALLED')
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  trace('SERVICES webServer=' + (webServer ? typeof webServer.register : 'missing')
    + ' connection=' + (connection ? typeof connection.rpc : 'missing'))

  // Path A: DSH's official generic RPC channel. register() already binds the
  // route's lifetime to its own owner.effect(); wrapping its disposer in
  // ctx.effect() would UNDO the registration immediately (cordis executes the
  // factory at once), which is what produced HTTP 405 in earlier builds.
  if (connection && typeof connection.rpc?.handle === 'function') {
    try {
      const dispose = connection.rpc.handle(RPC_CHANNEL, makeHandler())
      // Bind the disposer to THIS plugin's fiber so unloading removes the route.
      // effect(factory) runs factory at once and collects its return value; here
      // the return value IS the disposer, so we return it instead of calling it.
      ctx.effect(() => (typeof dispose === 'function' ? dispose : () => {}),
        'dsh-pipeline: rpc channel')
      trace('PATH_A_OK rpc.handle registered')
      return
    } catch (e) {
      trace('PATH_A_FAIL ' + String(e && e.message || e))
    }
  }

  // Path B: independent of `connection`. Register the prefix route directly
  // on webServer and speak the same wire protocol the client expects.
  if (webServer && typeof webServer.register === 'function') {
    try {
      const dispose = webServer.register({
        kind: 'prefix',
        path: RPC_CHANNEL,
        handler: makeFallbackHandler(ctx, makeHandler()),
      })
      // ctx.effect(factory) executes factory immediately and collects the
      // RETURN VALUE as the disposer — pass the function itself, never call it.
      ctx.effect(() => (typeof dispose === 'function' ? dispose : () => {}),
        'dsh-pipeline: fallback rpc route')
      trace('PATH_B_OK webServer.register prefix ' + RPC_CHANNEL)
      return
    } catch (e) {
      trace('PATH_B_FAIL ' + String(e && e.message || e))
    }
  }
  trace('NO_ROUTE_REGISTERED webServer/connection unavailable')
}

export const name = PLUGIN_ID
export { RPC_CHANNEL, PLUGIN_ID, CLI, CONFIG, buildArgs }
