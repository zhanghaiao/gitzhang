// Minimal DSH plugin Client half.

window.__ModuleLoader__.load({
  id: 'dsh-hello-dsh',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    function apply(ctx) {
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: 'dsh-hello-dsh' }, function () {
          return h('div', { style: { padding: 16 } }, 'Hello DSH — 最小示例插件')
        })
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.name = 'dsh-hello-dsh'
    return module.exports
  },
})
