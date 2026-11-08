// dsh-pipeline — Client half (browser)
//
// Minimal panel: pick an operation, point at a plugin source directory,
// and render the structured result returned by the Host loopback RPC channel.

window.__ModuleLoader__.load({
  id: 'dsh-pipeline',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState

    var PANEL_ID = 'dsh-pipeline'
    var RPC_CHANNEL = '/dsh-pipeline'
    var ACTIONS = [
      { key: 'run', label: '一键上线' },
      { key: 'validate', label: '校验' },
      { key: 'package', label: '打包' },
      { key: 'install', label: '安装' },
      { key: 'doctor', label: '断链诊断' },
    ]

    var st = {
      input: { border: '1px solid var(--dsh-border, #3a3f4a)', borderRadius: 8, padding: '6px 10px',
               background: 'var(--dsh-panel-2, #23272f)', color: 'var(--dsh-fg, #e6e8ec)', fontSize: 13, width: '100%' },
      btn: { border: '1px solid var(--dsh-border, #3a3f4a)', borderRadius: 8, padding: '6px 12px',
             cursor: 'pointer', fontSize: 13, background: 'var(--dsh-panel-2, #23272f)', color: 'var(--dsh-fg, #e6e8ec)' },
      pre: { background: 'var(--dsh-panel-2, #23272f)', color: 'var(--dsh-fg, #e6e8ec)', borderRadius: 8,
             padding: 12, fontSize: 12, overflow: 'auto', maxHeight: 320, whiteSpace: 'pre-wrap' },
    }

    function App(props) {
      var call = props.call
      var srcState = useState('')
      var src = srcState[0], setSrc = srcState[1]
      var profileState = useState('desktop')
      var profile = profileState[0], setProfile = profileState[1]
      var busyState = useState(false)
      var busy = busyState[0], setBusy = busyState[1]
      var resultState = useState('')
      var result = resultState[0], setResult = resultState[1]

      function fire(action) {
        setBusy(true)
        setResult('执行中：' + action)
        var payload = { src: src, profile: profile }
        // 打包 / 一键上线显式指定产物目录：Host 进程的工作目录未必可写，
        // CLI 默认的 ./dist 会落到 DSH 安装目录。统一输出到源码目录下的 dist/。
        if ((action === 'package' || action === 'run') && src) {
          payload.out = src.replace(/[\\/]+$/, '') + '/dist'
        }
        call(action, payload)
          .then(function (r) { setResult(JSON.stringify(r, null, 2)) })
          .catch(function (e) { setResult('失败：' + (e && e.message ? e.message : String(e))) })
          .finally(function () { setBusy(false) })
      }

      return h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
        h('div', { style: { fontWeight: 600, fontSize: 15 } }, 'DSH 插件上线流水线'),
        h('div', { style: { fontSize: 12, opacity: 0.75 } },
          '校验 → 打包 → 安装，一次完成；产物写入源码目录 dist/，结果由 Host 侧本地 CLI 返回。'),
        h('input', { style: st.input, value: src, placeholder: '插件源码目录，如 C:/.../dsh-my-plugin',
                     onChange: function (e) { setSrc(e.target.value) } }),
        h('input', { style: st.input, value: profile, placeholder: '目标 profile（desktop / web / tui）',
                     onChange: function (e) { setProfile(e.target.value) } }),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          ACTIONS.map(function (a) {
            return h('button', { key: a.key, style: st.btn, disabled: busy,
                                 onClick: function () { fire(a.key) } }, a.label)
          })),
        result ? h('pre', { style: st.pre }, result) : null
      )
    }

    var inject = ['slots', 'connection']
    function apply(ctx) {
      var connection = ctx.get('connection')
      // connection.rpc.call() resolves to the DSH envelope { ok, value } /
      // { ok: false, error }, not the business payload. Unwrap it here so the
      // panel shows the CLI result; failures become readable Error messages.
      var call = function (endpoint, payload) {
        return connection.rpc.call(RPC_CHANNEL, endpoint, payload)
          .then(function (r) {
            if (r && r.ok === true) return r.value
            var err = r && r.error ? r.error : {}
            throw new Error(err.message || ('RPC 返回异常：' + JSON.stringify(r)))
          })
      }
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 60,
          label: function () { return '插件上线流水线' },
        }, function () {
          return h('span', { title: '插件上线流水线', style: { fontSize: 18 } }, '↑')
        })
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, function () {
          return h(App, { call: call })
        })
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = PANEL_ID
    return module.exports
  },
})
