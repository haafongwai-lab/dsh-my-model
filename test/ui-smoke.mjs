import assert from 'node:assert/strict'

let definition
globalThis.window = { __ModuleLoader__: { load: (value) => { definition = value } } }

let stateQueue = []
let stateIndex = 0
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const value = stateIndex < stateQueue.length ? stateQueue[stateIndex] : initial
    stateIndex += 1
    return [value, () => {}]
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
}

await import('../client.js')

assert.equal(definition.id, '@local/dsh-my-model')
const plugin = definition.factory((name) => {
  assert.equal(name, 'react')
  return React
})

let section
const ctx = {
  effect(fn) {
    fn()
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
    getLocale: () => ({ active: 'zh-CN' }),
  },
  slots: {
    inject(_name, fn) {
      fn()
    },
    register(_options, component) {
      section = component
    },
  },
}

plugin.apply(ctx)
assert.equal(typeof section, 'function')

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

function findAll(node, predicate, hits = []) {
  if (node === null || node === undefined || typeof node !== 'object') return hits
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, hits)
    return hits
  }
  if (predicate(node)) hits.push(node)
  for (const child of node.children) findAll(child, predicate, hits)
  return hits
}

stateQueue = []
stateIndex = 0
const loading = section()
assert.match(textOf(loading), /正在读取状态/)
assert.equal(findAll(loading, (node) => node.props.className === 'dsh-mm-card').length, 0)

stateQueue = [
  {
    provider: { id: 'deepseek-web', active: true },
    token: { configured: true, source: 'managed' },
    cookies: { configured: false },
    models: [
      { id: 'deepseek-web-thinking', name: 'DeepSeek Web · Thinking', description: 'reason first', thinking: true, search: false, routable: true },
      { id: 'deepseek-web-search', name: 'DeepSeek Web · Search', description: 'web search', thinking: false, search: true, routable: true },
    ],
    defaultSelection: { provider: 'deepseek-web', model: 'deepseek-web-thinking' },
    lastTest: null,
  },
  '',
  '',
  '',
  null,
]
stateIndex = 0
const loaded = section()
const classes = (name) => findAll(loaded, (node) => node.props.className === name)
assert.equal(classes('dsh-mm-title').length, 1)
assert.equal(classes('dsh-mm-card').length, 2)
assert.equal(classes('dsh-mm-modelRow').length, 2)
assert.equal(findAll(loaded, (node) => node.type === 'input' && node.props.id === 'dsh-mm-token').length, 1)
assert.equal(findAll(loaded, (node) => node.type === 'select').length, 0)
const buttons = findAll(loaded, (node) => node.type === 'button')
assert.equal(buttons.length, 3)
assert.match(textOf(loaded), /我的模型/)
assert.match(textOf(loaded), /模型路由已注册/)
assert.doesNotMatch(textOf(loaded), /默认模型/)
assert.equal(findAll(loaded, (node) => node.props.className === 'dsh-mm-tags').length, 0, 'no mode tags on model rows')
assert.doesNotMatch(textOf(loaded), /快速|联网/)
const style = findAll(loaded, (node) => node.type === 'style')[0]
assert.match(textOf(style), /--dsw-alias-button-primary-fill/)
assert.match(textOf(style), /--dsw-alias-bg-module-platform/)
assert.match(textOf(style), /--dsw-alias-border-l2/)

console.log('ui-smoke: ok')
