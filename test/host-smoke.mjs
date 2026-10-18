import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'
import { PROVIDER } from '../deepseek-web.js'

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
      assert.deepEqual(providers, [PROVIDER])
      globalThis.__adapter = adapter
      return () => {}
    },
    listProviders() {
      return [{ id: PROVIDER, name: 'My Model' }]
    },
    async listModels() {
      return globalThis.__adapter.listModels()
    },
  },
}

// `baseUrl` anchors at the profile directory; the settings page persists its
// fingerprint overrides there.
const profileDir = mkdtempSync(join(tmpdir(), 'my-model-profile-'))
ctx.baseUrl = pathToFileURL(`${profileDir}/`)

apply(ctx, {})
assert.ok(globalThis.__adapter, 'adapter registered')
assert.equal(existsSync(join(profileDir, 'my-model.log')), true, 'plugin log file is written')
assert.equal((await globalThis.__adapter.listModels()).length, 3)
assert.equal((await globalThis.__adapter.resolveModel(PROVIDER, 'deepseek-web-chat')).id, 'deepseek-web-chat')
assert.equal((await globalThis.__adapter.prepareCall(PROVIDER, 'deepseek-web-thinking')).model.reasoning.defaultEffort, 'high')

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
assert.equal(routes.size, 5, 'all settings routes registered once webServer is ready')

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

const saveRes = response()
await routes.get('/my-model/api/credentials')(
  request('/my-model/api/credentials', { token: '{"value":"secret-token","__version":"0"}', cookies: 'a=b; c=d' }),
  saveRes,
)
assert.equal(saveRes.status, 200)
assert.equal(stored.get('DEEPSEEK_WEB_TOKEN'), 'secret-token')
assert.equal(stored.get('DEEPSEEK_WEB_COOKIES'), 'a=b; c=d')

const defaultRes = response()
await routes.get('/my-model/api/default')(
  request('/my-model/api/default', { model: 'deepseek-web-thinking' }),
  defaultRes,
)
assert.equal(defaultRes.status, 200)
assert.deepEqual(savedDefaults[0], { provider: PROVIDER, model: 'deepseek-web-thinking' })

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

for (const dispose of effects) if (typeof dispose === 'function') await dispose()
console.log('host-smoke: ok')
