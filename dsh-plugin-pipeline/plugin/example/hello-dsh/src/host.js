// Minimal DSH plugin Host half.
//
// DSH connection contract: the channel must be a single segment (and not /api),
// and the handler must return { ok: true, value } or
// { ok: false, error: { code, message, details } }.
//
// Module-level `inject` is required: cordis may call apply() before the web
// carrier exists. Waiting only via ctx.inject() inside apply() is unreliable.

const PLUGIN_ID = 'dsh-hello-dsh'
const RPC_CHANNEL = '/dsh-hello-dsh'

export const inject = ['webServer']

export function apply(ctx) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || typeof connection.rpc?.handle !== 'function') return

  const handler = async (endpoint, payload) => {
    if (endpoint === 'ping') return { ok: true, value: { plugin: PLUGIN_ID, pong: true } }
    return {
      ok: false,
      error: {
        code: 'dsh-hello-dsh/unknown-endpoint',
        message: `unknown endpoint: ${endpoint}`,
        details: {},
      },
    }
  }

  // rpc.handle() registers the route and returns its disposer. effect(factory)
  // runs factory immediately and collects the RETURN VALUE as the disposer —
  // return it, never call it (calling it would undo the registration → 405).
  const dispose = connection.rpc.handle(RPC_CHANNEL, handler)
  ctx.effect(() => (typeof dispose === 'function' ? dispose : () => {}),
    `${PLUGIN_ID}: rpc channel`)
}

export const name = PLUGIN_ID
export { RPC_CHANNEL, PLUGIN_ID }
