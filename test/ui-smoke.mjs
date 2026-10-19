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
let sectionOptions
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
    register(options, component) {
      sectionOptions = options
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

// The settings shell falls back to the Settings gear for unknown section ids,
// so the section label carries its own 16px glyph and the fallback gear is
// hidden by the injected nav stylesheet.
assert.equal(sectionOptions.id, 'my-model')
const navLabel = sectionOptions.label()
assert.equal(navLabel.props.className, 'dsh-mm-navLabel')
assert.equal(findAll(navLabel, (node) => node.props.className === 'dsh-mm-navGlyph').length, 1)
assert.match(textOf(navLabel), /我的模型/)

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
const actionButtons = buttons.filter((node) => String(node.props.className ?? '').includes('dsh-mm-button'))
assert.equal(actionButtons.length, 3)
assert.ok(
  buttons.some((node) => String(node.props.className ?? '').includes('dsh-mm-link')),
  'model rows expose a set-default action',
)
assert.match(textOf(loaded), /我的模型/)
assert.match(textOf(loaded), /模型路由已注册/)
assert.doesNotMatch(textOf(loaded), /默认模型/)
assert.equal(findAll(loaded, (node) => node.props.className === 'dsh-mm-tags').length, 0, 'no mode tags on model rows')
assert.doesNotMatch(textOf(loaded), /快速|联网/)
const style = findAll(loaded, (node) => node.type === 'style')[0]
assert.match(textOf(style), /--dsw-alias-button-primary-fill/)
assert.match(textOf(style), /--dsw-alias-bg-module-platform/)
assert.match(textOf(style), /--dsw-alias-border-l2/)

// Every control shares one base: geometry is fixed, motion is colour-only, and
// host-level transforms/filters are neutralised on each pseudo class so a hover
// can never nudge a button (the "保存指纹 jumps up" regression).
const css = textOf(style)
assert.match(css, /\.dsh-mm-button,\.dsh-mm-link\{[^}]*transform:none/)
assert.match(css, /\.dsh-mm-button,\.dsh-mm-link\{[^}]*transition:background-color \.12s ease/)
assert.match(css, /\.dsh-mm-section \.dsh-mm-button:hover,[\s\S]*?\{transform:none;filter:none;animation:none/)
assert.match(
  css,
  /\.dsh-mm-button:focus-visible,\.dsh-mm-link:focus-visible,\.dsh-mm-summary:focus-visible\{[^}]*box-shadow:0 0 0 var\(--dsw-focus-ring-width,2px\)/,
)
assert.match(css, /\.dsh-mm-input:focus\{border-color:var\(--dsw-alias-state-business-primary\)/)
assert.match(css, /\.dsh-mm-button\{[^}]*border-radius:var\(--dsw-radius-md,12px\)/)
assert.match(css, /\.dsh-mm-card\{[^}]*border-radius:var\(--dsw-radius-xl,20px\)/)

// A status payload with a fingerprint block renders the advanced editor and its
// save/reset actions without disturbing the primary account actions.
stateQueue = [
  {
    provider: { id: 'deepseek-web', active: true },
    token: { configured: true, source: 'managed' },
    cookies: { configured: false },
    models: [
      { id: 'deepseek-web-thinking', name: 'DeepSeek Web · Thinking', description: 'reason first', thinking: true, search: false, routable: true },
    ],
    defaultSelection: { provider: 'deepseek-web', model: 'deepseek-web-thinking' },
    fingerprint: {
      userAgent: 'UA-TEST',
      secChUa: '"Test";v="1"',
      secChUaPlatform: '"Windows"',
      secChUaMobile: '?0',
      acceptLanguage: 'zh-CN',
      clientVersion: '9.9.9',
      overridden: true,
      persistable: true,
    },
    lastTest: null,
  },
  '',
  '',
  '',
  null,
]
stateIndex = 0
const withFingerprint = section()
assert.equal(findAll(withFingerprint, (node) => node.props.className === 'dsh-mm-card').length, 3)
assert.equal(
  findAll(withFingerprint, (node) => node.type === 'input' && node.props.id === 'dsh-mm-fp-userAgent').length,
  1,
)
assert.equal(
  findAll(withFingerprint, (node) => String(node.props.className ?? '').includes('dsh-mm-button')).length,
  5,
  'account actions plus fingerprint save/reset',
)
assert.match(textOf(withFingerprint), /浏览器指纹/)

// A reported failure is surfaced on the account card so a silent disconnect
// has a visible cause, and disappears again once the status clears it.
stateQueue = [
  {
    provider: { id: 'deepseek-web', active: true },
    token: { configured: true, source: 'managed' },
    cookies: { configured: false },
    models: [
      { id: 'deepseek-web-chat', name: 'DeepSeek Web · Chat', description: 'chat', thinking: false, search: false, routable: true },
    ],
    defaultSelection: { provider: 'deepseek-web', model: 'deepseek-web-chat' },
    lastFailure: { code: 'STALE_SESSION', message: 'starting a fresh session.', at: 1792313830728 },
    lastTest: null,
  },
  '',
  '',
  '',
  null,
]
stateIndex = 0
const withFailure = section()
assert.match(textOf(withFailure), /上次失败原因：STALE_SESSION/)
assert.match(textOf(withFailure), /starting a fresh session\./)
assert.match(textOf(withFailure), /my-model\.log/)

// With a ChatGPT account in the payload the second account card appears next to
// the DeepSeek one, and the model list covers both providers.
stateQueue = [
  {
    provider: { id: 'deepseek-web', active: true },
    token: { configured: true, source: 'managed' },
    cookies: { configured: false },
    models: [
      { id: 'deepseek-web-chat', name: 'DeepSeek Web · Chat', description: 'chat', thinking: false, search: false, routable: true },
    ],
    defaultSelection: { provider: 'deepseek-web', model: 'deepseek-web-chat' },
    chatgpt: {
      provider: { id: 'chatgpt-web', name: 'My Model · ChatGPT Web', active: true },
      token: { configured: true, source: 'managed' },
      cookies: { configured: false },
      models: [
        {
          id: 'chatgpt-web-chat',
          name: 'ChatGPT Web · Chat',
          description: 'chatgpt web chat',
          thinking: false,
          search: false,
          routable: true,
        },
      ],
      baseURL: 'https://chatgpt.com',
      lastFailure: { code: 'INVALID_CREDENTIAL', message: 'HTTP 401', at: 1792313830728 },
    },
    lastTest: null,
  },
  '',
  '',
  '',
  null,
  '',
  '',
]
stateIndex = 0
const withChatgpt = section()
assert.equal(findAll(withChatgpt, (node) => node.props.className === 'dsh-mm-card').length, 3, 'account cards plus models')
assert.equal(findAll(withChatgpt, (node) => node.props.className === 'dsh-mm-modelRow').length, 2)
assert.equal(
  findAll(withChatgpt, (node) => node.type === 'input' && node.props.id === 'dsh-mm-chatgpt-token').length,
  1,
)
assert.match(textOf(withChatgpt), /ChatGPT 网页版账号/)
assert.match(textOf(withChatgpt), /上次失败原因：INVALID_CREDENTIAL/)

// In CDP mode the browser tab holds the session, so the test button must stay
// clickable even with no token and no cookie configured (a reported regression:
// it stayed disabled and the mode looked broken).
stateQueue = [
  {
    provider: { id: 'deepseek-web', active: true },
    token: { configured: true, source: 'managed' },
    cookies: { configured: false },
    models: [
      { id: 'deepseek-web-chat', name: 'DeepSeek Web · Chat', description: 'chat', thinking: false, search: false, routable: true },
    ],
    defaultSelection: { provider: 'deepseek-web', model: 'deepseek-web-chat' },
    chatgpt: {
      provider: { id: 'chatgpt-web', name: 'My Model · ChatGPT Web', active: true },
      token: { configured: false },
      cookies: { configured: false },
      models: [
        { id: 'chatgpt-web-chat', name: 'ChatGPT Web', description: 'chatgpt default', thinking: false, search: false, routable: true },
      ],
      transport: 'cdp',
      cdp: { host: '127.0.0.1', port: 9222, reachable: true, browser: 'Chrome/155.0.8059.84' },
      lastTest: null,
    },
    lastTest: null,
  },
  '',
  '',
  '',
  null,
  '',
  '',
  '',
]
stateIndex = 0
const withCdp = section()
const chatgptCard = findAll(withCdp, (node) => node.props.className === 'dsh-mm-card')[1]
assert.ok(chatgptCard, 'the ChatGPT card is rendered')
const testButton = findAll(chatgptCard, (node) => node.type === 'button' && textOf(node) === '测试连接')[0]
assert.ok(testButton, 'the ChatGPT card exposes a test button')
assert.equal(testButton.props.disabled, false, 'the test button is clickable in CDP mode without credentials')
assert.match(textOf(chatgptCard), /已连上 Chrome/)
assert.match(textOf(chatgptCard), /可以留空/)

// One click must be enough to get the debug browser: the launcher lives on the
// ChatGPT card, works without any pasted credential, and says what it will do.
const launchButton = findAll(
  chatgptCard,
  (node) => node.type === 'button' && textOf(node) === '一键启动本地 Chrome',
)[0]
assert.ok(launchButton, 'the ChatGPT card exposes the one-click Chrome launcher')
assert.equal(launchButton.props.disabled, false, 'the launcher needs no token or cookie')
assert.match(textOf(chatgptCard), /独立配置目录/, 'the launcher explains the dedicated profile')

console.log('ui-smoke: ok')
