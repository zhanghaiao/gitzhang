// dsh-pipeline — Client half (browser)
//
// Minimal panel: pull source from GitHub (or point at a local directory),
// pick an operation, and render the structured result returned by the Host
// loopback RPC channel.

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
      { key: 'fetch', label: '拉取源码' },
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
      label: { fontSize: 11, opacity: 0.6 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
    }

    function field(label, value, onChange, placeholder) {
      return h('div', { style: st.field },
        h('div', { style: st.label }, label),
        h('input', { style: st.input, value: value, placeholder: placeholder,
                     onChange: function (e) { onChange(e.target.value) } }))
    }

    function App(props) {
      var call = props.call
      var srcState = useState('')
      var src = srcState[0], setSrc = srcState[1]
      var profileState = useState('desktop')
      var profile = profileState[0], setProfile = profileState[1]
      var repoState = useState('')
      var repoUrl = repoState[0], setRepoUrl = repoState[1]
      var branchState = useState('')
      var branch = branchState[0], setBranch = branchState[1]
      var subdirState = useState('')
      var subdir = subdirState[0], setSubdir = subdirState[1]
      var busyState = useState(false)
      var busy = busyState[0], setBusy = busyState[1]
      var resultState = useState('')
      var result = resultState[0], setResult = resultState[1]

      function fire(action) {
        setBusy(true)
        setResult('执行中：' + action)
        var payload
        if (action === 'fetch') {
          payload = { url: repoUrl, ref: branch, subdir: subdir }
        } else {
          payload = { src: src, profile: profile }
          // 打包 / 一键上线显式指定产物目录：Host 进程的工作目录未必可写，
          // CLI 默认的 ./dist 会落到 DSH 安装目录。统一输出到源码目录下的 dist/。
          if ((action === 'package' || action === 'run') && src) {
            payload.out = src.replace(/[\\/]+$/, '') + '/dist'
          }
        }
        call(action, payload)
          .then(function (r) {
            // 拉取成功后把可安装的源码目录自动回填，接着就能点「一键上线」。
            if (action === 'fetch' && r && r.src && r.status !== 'fail') setSrc(r.src)
            setResult(JSON.stringify(r, null, 2))
          })
          .catch(function (e) { setResult('失败：' + (e && e.message ? e.message : String(e))) })
          .finally(function () { setBusy(false) })
      }

      return h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: { fontWeight: 600, fontSize: 15 } }, 'DSH 插件上线流水线'),
        h('div', { style: { fontSize: 12, opacity: 0.75 } },
          '拉取源码 → 校验 → 打包 → 安装；源码默认存到 ~/.dsh/plugin-sources/<repo>，结果由 Host 侧返回。'),
        field('GitHub 仓库地址', repoUrl, setRepoUrl, 'https://github.com/owner/repo 或 owner/repo'),
        h('div', { style: { display: 'flex', gap: 8 } },
          field('分支 / 标签（可选）', branch, setBranch, 'main / v1.2.3'),
          field('插件子目录（可选）', subdir, setSubdir, 'packages/my-plugin')),
        field('插件源码目录', src, setSrc, '拉取成功后自动回填，也可手动填写本地目录'),
        field('目标 profile', profile, setProfile, 'desktop / web / tui'),
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
