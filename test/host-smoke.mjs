import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'
import { PROVIDER } from '../deepseek-web.js'
import { PROVIDER as CHATGPT_PROVIDER } from '../chatgpt-web.js'

const routes = new Map()
const effects = []
const writes = []
const stored = new Map()
const savedDefaults = []
let pendingWebServer

const webServer = {
  register(route) {
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}

const ctx = {
  logger: { warn() {} },
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
  },
  inject(deps, callback) {
    assert.deepEqual(deps, ['webServer'])
    pendingWebServer = callback
  },
  get(key) {
    if (key === 'credentials') {
      return {
        async resolve(ref) {
          return stored.has(ref) ? { value: stored.get(ref), source: 'managed' } : undefined
        },
        async describe(ref) {
          return { configured: stored.has(ref), source: 'managed', writable: true }
        },
        async set(ref, value) {
          stored.set(ref, value)
        },
        async unset(ref) {
          stored.delete(ref)
        },
      }
    }
    if (key === 'agentDefaultModel') {
      return {
        currentSelection() {
          return { provider: 'deepseek-account', model: 'deepseek-flash' }
        },
        async saveSelection(next) {
          savedDefaults.push(next)
        },
      }
    }
    return undefined
  },
  llm: {
    registerAdapter(providers, adapter) {
      assert.equal(providers.length, 1)
      if (providers[0] === PROVIDER) {
        globalThis.__adapter = adapter
      } else if (providers[0] === CHATGPT_PROVIDER) {
        globalThis.__chatgptAdapter = adapter
      } else {
        throw new Error(`unexpected provider ${providers[0]}`)
      }
      return () => {}
    },
    listProviders() {
      return [
        { id: PROVIDER, name: 'My Model' },
        { id: CHATGPT_PROVIDER, name: 'My Model · ChatGPT Web' },
      ]
    },
    async listModels(provider) {
      const target = provider === CHATGPT_PROVIDER ? globalThis.__chatgptAdapter : globalThis.__adapter
      return target.listModels()
    },
  },
}

// `baseUrl` anchors at the profile directory; the settings page persists its
// fingerprint overrides there.
const profileDir = mkdtempSync(join(tmpdir(), 'my-model-profile-'))
ctx.baseUrl = pathToFileURL(`${profileDir}/`)

apply(ctx, {})
assert.ok(globalThis.__adapter, 'adapter registered')
assert.ok(globalThis.__chatgptAdapter, 'chatgpt adapter registered')
assert.equal(existsSync(join(profileDir, 'my-model.log')), true, 'plugin log file is written')
assert.equal((await globalThis.__adapter.listModels()).length, 3)
assert.equal((await globalThis.__chatgptAdapter.listModels()).length, 1)
assert.equal((await globalThis.__adapter.resolveModel(PROVIDER, 'deepseek-web-chat')).id, 'deepseek-web-chat')
assert.equal((await globalThis.__adapter.prepareCall(PROVIDER, 'deepseek-web-thinking')).model.reasoning.defaultEffort, 'high')
assert.equal((await globalThis.__chatgptAdapter.resolveModel(CHATGPT_PROVIDER, 'chatgpt-web-chat')).provider, CHATGPT_PROVIDER)
assert.equal(globalThis.__chatgptAdapter.client.baseURL, 'https://chatgpt.com')
assert.equal(globalThis.__chatgptAdapter.modelSlug, 'gpt-6-luna')

// The web routes must wait for the webServer fiber: reading it eagerly during
// apply used to return undefined and left the settings page on HTTP 404.
assert.equal(routes.size, 0, 'routes are not registered before webServer is ready')
assert.equal(typeof pendingWebServer, 'function', 'apply subscribes to webServer')
pendingWebServer({
  webServer,
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
  },
})
assert.equal(routes.size, 10, 'all settings routes registered once webServer is ready')

function request(url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.url = url
  req.method = body === undefined ? 'GET' : 'POST'
  req.headers = {}
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body += body ?? ''
    },
  }
}

const statusRes = response()
await routes.get('/my-model/api/status')(request('/my-model/api/status'), statusRes)
assert.equal(statusRes.status, 200)
const status = JSON.parse(statusRes.body)
assert.equal(status.provider.id, PROVIDER)
assert.equal(status.token.configured, false)
assert.equal(status.models.length, 3)
assert.equal(status.chatgpt.provider.id, CHATGPT_PROVIDER)
assert.equal(status.chatgpt.token.configured, false)
assert.equal(status.chatgpt.models.length, 1)
assert.equal(status.chatgpt.baseURL, 'https://chatgpt.com')

const saveRes = response()
await routes.get('/my-model/api/credentials')(
  request('/my-model/api/credentials', { token: '{"value":"secret-token","__version":"0"}', cookies: 'a=b; c=d' }),
  saveRes,
)
assert.equal(saveRes.status, 200)
assert.equal(stored.get('DEEPSEEK_WEB_TOKEN'), 'secret-token')
assert.equal(stored.get('DEEPSEEK_WEB_COOKIES'), 'a=b; c=d')

// The ChatGPT account keeps its own credential keys, so the two web accounts
// never overwrite one another.
const chatgptSaveRes = response()
await routes.get('/my-model/api/chatgpt/credentials')(
  request('/my-model/api/chatgpt/credentials', { token: 'Bearer chatgpt-access', cookies: 'oai-did=x; __Secure-next-auth.session-token=y' }),
  chatgptSaveRes,
)
assert.equal(chatgptSaveRes.status, 200)
assert.equal(stored.get('DEEPSEEK_WEB_TOKEN'), 'secret-token', 'the DeepSeek token is untouched')
assert.equal(stored.get('CHATGPT_WEB_TOKEN'), 'chatgpt-access')
assert.equal(stored.get('CHATGPT_WEB_COOKIES'), 'oai-did=x; __Secure-next-auth.session-token=y')

// A model id decides which provider the default goes to.
const defaultRes = response()
await routes.get('/my-model/api/default')(
  request('/my-model/api/default', { model: 'deepseek-web-thinking' }),
  defaultRes,
)
assert.equal(defaultRes.status, 200)
assert.deepEqual(savedDefaults[0], { provider: PROVIDER, model: 'deepseek-web-thinking' })

const chatgptDefaultRes = response()
await routes.get('/my-model/api/default')(
  request('/my-model/api/default', { model: 'chatgpt-web-chat' }),
  chatgptDefaultRes,
)
assert.equal(chatgptDefaultRes.status, 200)
assert.deepEqual(savedDefaults[1], { provider: CHATGPT_PROVIDER, model: 'chatgpt-web-chat' })

const unknownDefaultRes = response()
await routes.get('/my-model/api/default')(request('/my-model/api/default', { model: 'nope' }), unknownDefaultRes)
assert.equal(unknownDefaultRes.status, 400)

// Cross-site browser writes are rejected even without the host connection guard
// (CSRF protection); a same-origin request is still allowed.
{
  const crossReq = request('/my-model/api/credentials', { token: 'evil-token' })
  crossReq.headers = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', host: '127.0.0.1:8080' }
  const crossRes = response()
  await routes.get('/my-model/api/credentials')(crossReq, crossRes)
  assert.equal(crossRes.status, 403, 'cross-site writes are rejected')
  assert.equal(stored.get('DEEPSEEK_WEB_TOKEN'), 'secret-token', 'the stored token is unchanged')

  const sameReq = request('/my-model/api/credentials', { token: 'same-origin-token' })
  sameReq.headers = { origin: 'http://127.0.0.1:8080', 'sec-fetch-site': 'same-origin', host: '127.0.0.1:8080' }
  const sameRes = response()
  await routes.get('/my-model/api/credentials')(sameReq, sameRes)
  assert.equal(sameRes.status, 200, 'same-origin writes are allowed')
  assert.equal(stored.get('DEEPSEEK_WEB_TOKEN'), 'same-origin-token')
}

// The settings page persists fingerprint overrides to the profile directory and
// applies them to the live client immediately; reset removes the file.
{
  const saveRes = response()
  await routes.get('/my-model/api/fingerprint')(
    request('/my-model/api/fingerprint', { userAgent: 'UA-TEST', clientVersion: '9.9.9' }),
    saveRes,
  )
  assert.equal(saveRes.status, 200)
  const saved = JSON.parse(saveRes.body)
  assert.equal(saved.fingerprint.userAgent, 'UA-TEST')
  assert.equal(saved.fingerprint.clientVersion, '9.9.9')
  assert.equal(saved.fingerprint.overridden, true)
  assert.equal(globalThis.__adapter.client.userAgent, 'UA-TEST')
  assert.equal(globalThis.__adapter.client.clientVersion, '9.9.9')
  const persisted = JSON.parse(readFileSync(join(profileDir, '.my-model.json'), 'utf8'))
  assert.equal(persisted.userAgent, 'UA-TEST')

  const resetRes = response()
  await routes.get('/my-model/api/fingerprint')(request('/my-model/api/fingerprint', { reset: true }), resetRes)
  assert.equal(resetRes.status, 200)
  const reset = JSON.parse(resetRes.body)
  assert.equal(reset.fingerprint.overridden, false)
  assert.notEqual(globalThis.__adapter.client.userAgent, 'UA-TEST')
  assert.equal(existsSync(join(profileDir, '.my-model.json')), false, 'reset removes the overrides file')
}

// The transport switch is applied immediately and persisted per profile; in CDP
// mode a connection test must not demand a pasted credential. The port is one
// nothing listens on, so the assertion does not depend on whether the machine
// running the tests happens to have Chrome open with a debug port.
{
  const transportRes = response()
  await routes.get('/my-model/api/chatgpt/transport')(
    request('/my-model/api/chatgpt/transport', { transport: 'cdp', port: 65001 }),
    transportRes,
  )
  assert.equal(transportRes.status, 200)
  const payload = JSON.parse(transportRes.body)
  assert.equal(payload.chatgpt.transport, 'cdp')
  assert.equal(payload.chatgpt.cdp.port, 65001)
  assert.equal(globalThis.__chatgptAdapter.client.transport, 'cdp')
  const persisted = JSON.parse(readFileSync(join(profileDir, '.my-model-chatgpt.json'), 'utf8'))
  assert.equal(persisted.transport, 'cdp')
  assert.equal(persisted.cdpPort, 65001)

  const cdpTestRes = response()
  await routes.get('/my-model/api/chatgpt/test')(request('/my-model/api/chatgpt/test', {}), cdpTestRes)
  assert.equal(cdpTestRes.status, 400)
  const cdpTest = JSON.parse(cdpTestRes.body)
  assert.equal(
    cdpTest.error.code,
    'CDP_UNAVAILABLE',
    'with no Chrome listening the failure names the transport, not a missing credential',
  )

  const badTransport = response()
  await routes.get('/my-model/api/chatgpt/transport')(
    request('/my-model/api/chatgpt/transport', { transport: 'carrier-pigeon' }),
    badTransport,
  )
  assert.equal(badTransport.status, 400)

  const backRes = response()
  await routes.get('/my-model/api/chatgpt/transport')(
    request('/my-model/api/chatgpt/transport', { transport: 'node' }),
    backRes,
  )
  assert.equal(JSON.parse(backRes.body).chatgpt.transport, 'node')

  // The launcher validates its input before touching the machine, so an invalid
  // body never spawns a browser (and is safe to exercise in a test).
  const badPort = response()
  await routes.get('/my-model/api/chatgpt/launch')(request('/my-model/api/chatgpt/launch', { port: 0 }), badPort)
  assert.equal(badPort.status, 400)
  assert.equal(JSON.parse(badPort.body).error.code, 'BAD_PORT')
  assert.equal(
    globalThis.__chatgptAdapter.client.transport,
    'node',
    'a rejected launch leaves the transport untouched',
  )
}

for (const dispose of effects) if (typeof dispose === 'function') await dispose()
console.log('host-smoke: ok')
