// scripts/selftest.mjs — 离线自测：不启动 DSH，用桩对象验证 Host 契约。
// 运行：node ./scripts/selftest.mjs

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

let passed = 0
function step(name) { passed++; console.log('  ✓ ' + name) }

const host = await import('../src/host.js')

// 1. 元数据：channel 必须是单段且不能是保留的 /api
assert.equal(host.PLUGIN_ID, 'dsh-pipeline')
assert.equal(host.RPC_CHANNEL, '/dsh-pipeline')
assert.ok(/^\/[A-Za-z0-9._~-]+$/.test(host.RPC_CHANNEL), 'channel 必须是单段')
assert.notEqual(host.RPC_CHANNEL, '/api', '/api 是保留通道')
assert.deepEqual(host.inject, ['webServer'],
  '必须声明模块级 inject：apply 可能先于 webServer 就绪执行')
step('插件 ID / 单段 RPC 通道 / 模块级 inject 符合 DSH 规范')

// 桩：模拟 cordis 的 effect(factory) —— 立即执行 factory，把返回值收为 disposer。
function makeCtx(connection, webServer) {
  const disposers = []
  return {
    disposers,
    get(name) {
      if (name === 'connection') return connection
      if (name === 'webServer') return webServer
      return undefined
    },
    effect(factory) { disposers.push(factory()) },
  }
}

// 2. 路径 A：connection 就绪时用官方 rpc.handle，且不得立即注销路由
let channel = null
let handler = null
let disposed = false
const connection = {
  rpc: {
    handle(ch, fn) {
      channel = ch
      handler = fn
      return () => { disposed = true }
    },
  },
}
const ctxA = makeCtx(connection, { register() { throw new Error('路径 A 不应使用 webServer') } })
host.apply(ctxA)
assert.equal(channel, host.RPC_CHANNEL)
assert.equal(typeof handler, 'function')
assert.equal(disposed, false, 'apply() 不得立即注销刚注册的 RPC 通道（否则 POST → HTTP 405）')
assert.equal(ctxA.disposers.length, 1, 'disposer 应绑定到插件 fiber')
assert.equal(typeof ctxA.disposers[0], 'function')
step('路径 A：rpc.handle 注册且不会立即注销')

// 3. 路径 B：connection 缺失时用 webServer 兜底注册 prefix 路由
let route = null
let bDisposed = false
const webServer = {
  register(r) {
    route = r
    return () => { bDisposed = true }
  },
}
const ctxB = makeCtx(undefined, webServer)
host.apply(ctxB)
assert.ok(route, 'connection 不可用时必须回退到 webServer.register')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, host.RPC_CHANNEL)
assert.equal(bDisposed, false, '兜底路由不得被立即注销')
assert.equal(ctxB.disposers.length, 1)
step('路径 B：connection 缺失时 webServer 兜底路由生效')

// 4. 兜底路由的 DSH 线协议（client 侧 connection.rpc.call 期望的格式）
function fakeReq(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  Object.assign(req, {
    url, method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req
}
function fakeRes() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    set statusCode(v) { state.status = v },
    get statusCode() { return state.status },
    setHeader(k, v) { state.headers[k] = v },
    end(v) { state.body = v === undefined ? '' : String(v) },
  }
}
const fallback = host.makeFallbackHandler({ get: () => undefined }, host.makeHandler())
const probe = { type: 'client-request', rpcId: 'probe-1', method: 'doctor', payload: {} }
const res = fakeRes()
await fallback(fakeReq(`${host.RPC_CHANNEL}/doctor`, probe), res)
const wire = JSON.parse(res.state.body)
assert.equal(res.state.status, 200)
assert.equal(wire.type, 'server-response')
assert.equal(wire.rpcId, probe.rpcId)
assert.equal(wire.result.ok, true)
assert.equal(wire.result.value.stage, 'doctor')
step('兜底路由返回标准 server-response 信封与 CLI 结果')

const badRes = fakeRes()
await fallback(fakeReq(`${host.RPC_CHANNEL}/nope`,
  { type: 'client-request', rpcId: 'probe-2', method: 'nope', payload: {} }), badRes)
assert.equal(badRes.state.status, 404, '未知 endpoint 必须 404，不能落到静态 fallback 的 405')
step('兜底路由对未知 endpoint 返回 404')

// 5. 参数构造
const args = host.buildArgs('run', { src: 'C:/tmp/my-plugin', profile: 'web', skipInstall: true })
assert.equal(args[0], 'run')
assert.ok(args.includes('C:/tmp/my-plugin'))
assert.ok(args.includes('--profile') && args.includes('web'))
assert.ok(args.includes('--skip-install'))
assert.ok(args.includes('--config'))
step('buildArgs 正确映射 src / profile / 开关 / 配置')

assert.throws(() => host.buildArgs('validate', {}), /缺少参数 src/)
assert.throws(() => host.buildArgs('validate', { src: 123 }), /缺少参数 src/)
assert.throws(() => host.buildArgs('validate', { src: '' }), /缺少参数 src/)
step('缺少 src / src 非字符串 / src 为空时明确报错')

const dargs = host.buildArgs('doctor', {})
assert.equal(dargs[0], 'doctor')
assert.ok(!dargs.includes('--src'))
step('doctor 不需要 src，且不会误带 src 参数')

// 6. DSH 信封契约：handler 必须返回 { ok, value } / { ok: false, error }
const unknown = await handler('nope', {})
assert.equal(unknown.ok, false)
assert.equal(unknown.error.code, 'dsh-pipeline/unknown-endpoint')
assert.match(unknown.error.message, /unknown endpoint/)
assert.equal(typeof unknown.error.details, 'object')
step('未知 endpoint 返回结构化 error 信封')

const badArgs = await handler('validate', {})
assert.equal(badArgs.ok, false)
assert.equal(badArgs.error.code, 'dsh-pipeline/invalid-arguments')
assert.match(badArgs.error.message, /缺少参数 src/)
step('参数错误转为可读 error，不再触发 HTTP 500')

const okRes = await handler('doctor', {})
assert.equal(okRes.ok, true)
assert.ok(okRes.value && typeof okRes.value === 'object', 'value 必须是业务结果对象')
assert.equal(okRes.value.stage, 'doctor')
step('成功调用返回 { ok: true, value } 信封')

// 7. CLI 输出解析：单段聚合 JSON + 旧版逐阶段多段 JSON 都要能被 Host 消费
const single = host.parseJsonStream(JSON.stringify({
  status: 'pass', stage: 'run', stages: ['validate', 'package'], results: [],
}))
assert.equal(single.length, 1)
step('Host 能解析单段聚合 JSON 输出')

const multi = [
  { status: 'pass', stage: 'validate', errors: [] },
  { status: 'pass', stage: 'package', errors: [], artifact_path: 'demo.zip' },
  { status: 'pass', stage: 'install', errors: [], actions: ['noop'] },
].map((o) => JSON.stringify(o)).join('\n')
const parsed = host.parseJsonStream(multi)
assert.equal(parsed.length, 3)
const merged = host.mergeResults(parsed, 'run')
assert.equal(merged.status, 'pass')
assert.deepEqual(merged.stages, ['validate', 'package', 'install'])
assert.equal(merged.artifact_path, 'demo.zip')
step('Host 能解析并合并旧版 CLI 的多段 JSON 输出')

console.log(`\n自检通过：${passed} 项`)
