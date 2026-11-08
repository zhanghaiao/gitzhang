// 真实 Host 路由层回归测试（补齐 makeHandler() 单测覆盖不到的那一层）
//
// 之前的冒烟测试只直接调用 makeHandler()，从不执行 apply()，于是漏掉了
// 「RPC 通道注册后是否真的挂在 webServer 上」——线上表现为 POST 落到静态资源
// fallback，返回 HTTP 405。本测试用 DSH 真实的 cordis + HostConnectionService
// 挂载插件 apply()，再发一个真实的 RPC POST，端到端验证路由注册与分发。
//
// 用法：
//   node rpc_route_test.mjs [--json]
// 可通过环境变量覆盖路径：
//   DSH_SRC    DSH 源码仓库根（需含 vendor/cordis 与 packages/client/connection）
//   DSH_PLUGIN 被测插件源码目录

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_SRC = process.env.DSH_SRC || 'D:/豆包文件/deepseek-harness-master'
const PLUGIN = process.env.DSH_PLUGIN || 'C:/Users/zhang/WorkBuddy/2026-10-26-22-11-53/dsh-plugin-pipeline'
const AS_JSON = process.argv.includes('--json')

const results = []
function record(id, title, ok, detail, extra) {
  results.push({ id, title, status: ok ? 'pass' : 'fail', detail, ...(extra ? { extra } : {}) })
  if (!AS_JSON) console.log(`${ok ? '[PASS]' : '[FAIL]'} ${id} ${title} — ${detail}`)
}

function fakeHttpServer(routes) {
  return {
    host: '127.0.0.1',
    protocol: 'http:',
    port: 0,
    register(route) {
      if (routes.some(r => r.kind === route.kind && r.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
    registerUpgrade() { return () => {} },
    tapIndex() { return () => {} },
  }
}

// 只实现 admit() 需要的成员；BrowserAuth 未导出，按真实接口做 duck typing。
const fakeBrowserAuth = {
  isAuthenticated: () => true,
  authenticateApi: () => undefined,
  authorizeConnect() {},
  authorizeIndex() { return true },
  authenticatedUrl: (u) => u,
}

function fakePost(url, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  Object.assign(req, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:3080' },
  })
  return req
}

function fakeResponse() {
  const state = { status: undefined, body: undefined }
  const chunks = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead(value) { state.status = value; return this },
    setHeader() { return this },
    write(value) { chunks.push(Buffer.from(value)); return true },
    end(value) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      if (chunks.length) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  })
  return { response, state }
}

async function main() {
  const cordis = await import(pathToFileURL(join(DSH_SRC, 'vendor/cordis/lib/index.js')).href)
  const conn = await import(pathToFileURL(join(DSH_SRC, 'packages/client/connection/lib/index.js')).href)
  const host = await import(pathToFileURL(join(PLUGIN, 'src/host.js')).href)
  const { Context } = cordis

  const routes = []
  const ctx = new Context()
  ctx.provide('webServer', fakeHttpServer(routes))
  // 真实服务：rpc.handle() 内部用 owner.effect() 注册 prefix 路由，并返回注销函数。
  new conn.HostConnectionService(ctx, ['127.0.0.1'], fakeBrowserAuth)

  const fiber = ctx.plugin(host)
  await fiber.await()

  const route = routes.find(r => r.kind === 'prefix' && r.path === host.RPC_CHANNEL)
  record('R1', 'apply() 后 RPC 路由已注册且保持',
    !!route,
    route ? `已挂载 ${host.RPC_CHANNEL}（共 ${routes.length} 条路由）`
          : `路由不存在，注册被立即撤销 → POST 会落到静态资源 fallback 并返回 405；当前路由：${routes.map(r => r.path).join(', ') || '(空)'}`,
    { routes: routes.map(r => `${r.kind}:${r.path}`) })

  if (route) {
    const body = {
      type: 'client-request',
      rpcId: 'rpc-route-probe',
      method: 'doctor',
      payload: {},
    }
    const { response, state } = fakeResponse()
    await route.handler(fakePost(`${host.RPC_CHANNEL}/doctor`, body), response)
    let parsed = null
    try { parsed = JSON.parse(state.body || '') } catch (_) { /* keep null */ }
    const value = parsed?.result?.value
    record('R2', 'RPC POST 返回 200 + DSH 信封',
      state.status === 200 && parsed?.type === 'server-response' && parsed?.rpcId === body.rpcId,
      `HTTP ${state.status}，type=${parsed?.type ?? '-'}，rpcId=${parsed?.rpcId ?? '-'}`,
      { raw: String(state.body || '').slice(0, 400) })
    record('R3', '信封内为 ok:true 且携带 CLI 业务结果',
      parsed?.result?.ok === true && !!value && typeof value.status === 'string',
      `ok=${parsed?.result?.ok}，CLI status=${value?.status ?? '-'}`,
      { cli: value ? { status: value.status, stage: value.stage, errors: (value.errors || []).length } : null })

    // 未知 endpoint 必须回 error 信封，而不是 HTTP 500 handler failure
    const bad = { type: 'client-request', rpcId: 'rpc-route-bad', method: 'nope', payload: {} }
    const r2 = fakeResponse()
    await route.handler(fakePost(`${host.RPC_CHANNEL}/nope`, bad), r2.response)
    let pb = null
    try { pb = JSON.parse(r2.state.body || '') } catch (_) { /* keep null */ }
    record('R4', '未知 endpoint 返回结构化 error',
      r2.state.status === 200 && pb?.result?.ok === false && /unknown endpoint/.test(pb?.result?.error?.message || ''),
      `HTTP ${r2.state.status}，ok=${pb?.result?.ok}，code=${pb?.result?.error?.code ?? '-'}`)
  } else {
    for (const [id, title] of [['R2', 'RPC POST 返回 200 + DSH 信封'],
      ['R3', '信封内为 ok:true 且携带 CLI 业务结果'],
      ['R4', '未知 endpoint 返回结构化 error']]) {
      record(id, title, false, '路由未注册，无法发请求（等价于线上 HTTP 405）')
    }
  }

  // 生命周期：销毁插件 fiber 后路由应被撤销（handle 内部 effect 负责）
  await fiber.dispose()
  const stillThere = routes.some(r => r.path === host.RPC_CHANNEL)
  record('R5', '插件卸载后路由被撤销', !stillThere,
    stillThere ? '路由残留，会造成重复注册冲突' : '已清理')

  const pass = results.filter(r => r.status === 'pass').length
  const fail = results.length - pass
  if (AS_JSON) {
    console.log(JSON.stringify({ summary: { total: results.length, pass, fail },
      status: fail ? 'fail' : 'pass', cases: results }, null, 2))
  } else {
    console.log(`\n结论：${fail ? 'FAIL' : 'PASS'} (${pass}/${results.length})`)
  }
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  const msg = `测试脚本异常：${e?.stack || e}`
  if (AS_JSON) console.log(JSON.stringify({ status: 'error', message: msg }, null, 2))
  else console.error(msg)
  process.exit(2)
})
