/**
 * My Model — a Harness model provider backed by a DeepSeek web account.
 *
 * The Host half registers the `deepseek-web` LLM route and a small same-origin
 * settings API used by the "My Model" settings page. The token and optional
 * cookie blob live in the Harness credential store, never in the profile
 * patch.
 */
import {
  DEFAULT_CLIENT_VERSION,
  DeepSeekWebAdapter,
  DeepSeekWebClient,
  MODELS,
  PROVIDER,
  PROVIDER_NAME,
  normalizeToken,
} from './deepseek-web.js'

export const name = 'my-model'
export const inject = ['llm']

const DEFAULTS = {
  baseURL: 'https://chat.deepseek.com',
  clientVersion: DEFAULT_CLIENT_VERSION,
  tokenEnv: 'DEEPSEEK_WEB_TOKEN',
  cookiesEnv: 'DEEPSEEK_WEB_COOKIES',
  timeoutMs: 300000,
  maxPromptChars: 1_000_000,
  // Rate-limit shaping for the shared web account. One generation at a time,
  // a short gap between turn starts, and a capped exponential cooldown.
  minTurnGapMs: 1200,
  maxConcurrentTurns: 1,
  maxAutoWaitMs: 20000,
  cooldownBaseMs: 15000,
  maxCooldownMs: 120000,
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-my-model',
    validate(value) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'my-model config must be an object' }] }
      }
      return { value }
    },
  },
}

class ApiError extends Error {
  constructor(status, message, code = 'BAD_REQUEST') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function optionsOf(config) {
  const input = config && typeof config === 'object' ? config : {}
  const cooldownBaseMs = clampNumber(input.cooldownBaseMs, DEFAULTS.cooldownBaseMs, 500, 600000)
  return {
    baseURL: typeof input.baseURL === 'string' && input.baseURL.trim() ? input.baseURL.trim() : DEFAULTS.baseURL,
    clientVersion:
      typeof input.clientVersion === 'string' && input.clientVersion.trim()
        ? input.clientVersion.trim()
        : DEFAULTS.clientVersion,
    tokenEnv:
      typeof input.tokenEnv === 'string' && input.tokenEnv.trim() ? input.tokenEnv.trim() : DEFAULTS.tokenEnv,
    cookiesEnv:
      typeof input.cookiesEnv === 'string' && input.cookiesEnv.trim()
        ? input.cookiesEnv.trim()
        : DEFAULTS.cookiesEnv,
    timeoutMs: Math.max(15000, Number(input.timeoutMs) || DEFAULTS.timeoutMs),
    maxPromptChars: Math.max(20000, Number(input.maxPromptChars) || DEFAULTS.maxPromptChars),
    minTurnGapMs: clampNumber(input.minTurnGapMs, DEFAULTS.minTurnGapMs, 0, 60000),
    maxConcurrentTurns: Math.round(clampNumber(input.maxConcurrentTurns, DEFAULTS.maxConcurrentTurns, 1, 4)),
    maxAutoWaitMs: clampNumber(input.maxAutoWaitMs, DEFAULTS.maxAutoWaitMs, 0, 120000),
    cooldownBaseMs,
    maxCooldownMs: clampNumber(input.maxCooldownMs, DEFAULTS.maxCooldownMs, cooldownBaseMs, 600000),
  }
}

async function resolveSecret(ctx, ref) {
  const credentials = safeGet(ctx, 'credentials')
  if (credentials) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      // Fall through to the ambient environment.
    }
  }
  return process.env[ref]
}

async function describeSecret(ctx, ref) {
  const credentials = safeGet(ctx, 'credentials')
  if (credentials) {
    try {
      const info = await credentials.describe(ref)
      return {
        configured: info.configured === true,
        ...(info.source === undefined ? {} : { source: info.source }),
        writable: info.writable === true,
      }
    } catch {
      // Fall through to the ambient environment.
    }
  }
  const value = process.env[ref]
  return {
    configured: typeof value === 'string' && value.length > 0,
    ...(value ? { source: 'environment' } : {}),
    writable: false,
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 128 * 1024) throw new ApiError(413, 'request body is too large', 'BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ApiError(400, 'request body must be a JSON object')
    }
    return value
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'request body is not valid JSON')
  }
}

function trusted(ctx, req, res) {
  const connection = safeGet(ctx, 'connection')
  if (!connection?.requestRejection) return true
  try {
    const rejection = connection.requestRejection({ headers: req.headers })
    if (rejection) {
      res.writeHead(rejection)
      res.end()
      return false
    }
    return true
  } catch {
    res.writeHead(403)
    res.end()
    return false
  }
}

function createApi(ctx, options, adapter, state) {
  const credentials = () => safeGet(ctx, 'credentials')

  const status = async () => {
    const token = await describeSecret(ctx, options.tokenEnv)
    const cookies = await describeSecret(ctx, options.cookiesEnv)
    let providerActive = false
    let routableModels = []
    try {
      providerActive = ctx.llm.listProviders().some((provider) => provider.id === PROVIDER)
      if (providerActive) routableModels = (await ctx.llm.listModels(PROVIDER)).map((model) => model.id)
    } catch {
      providerActive = false
    }
    const defaultModel = safeGet(ctx, 'agentDefaultModel')
    let defaultSelection = null
    try {
      defaultSelection = defaultModel?.currentSelection?.() ?? null
    } catch {
      defaultSelection = null
    }
    return {
      ok: true,
      provider: { id: PROVIDER, name: PROVIDER_NAME, active: providerActive },
      models: MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        thinking: model.thinking,
        search: model.search,
        routable: routableModels.includes(model.id),
      })),
      token,
      cookies,
      tokenEnv: options.tokenEnv,
      cookiesEnv: options.cookiesEnv,
      baseURL: options.baseURL,
      defaultSelection,
      lastTest: state.lastTest,
    }
  }

  const saveCredentials = async (req) => {
    const store = credentials()
    if (!store) throw new ApiError(409, 'The Harness credential service is unavailable in this profile.', 'NO_CREDENTIALS')
    const body = await readJson(req)
    if (body.clear === true) {
      await store.unset(options.tokenEnv)
      await store.unset(options.cookiesEnv)
      state.lastTest = null
      return status()
    }
    let changed = false
    if (typeof body.token === 'string') {
      const token = normalizeToken(body.token)
      if (!token) throw new ApiError(400, 'The token is empty.', 'EMPTY_TOKEN')
      if (token.length > 16384) throw new ApiError(400, 'The token is too long.', 'TOKEN_TOO_LONG')
      if (/[\r\n]/.test(token)) throw new ApiError(400, 'The token must be one line.', 'TOKEN_MULTILINE')
      await store.set(options.tokenEnv, token)
      changed = true
    }
    if (typeof body.cookies === 'string') {
      const cookies = body.cookies.trim()
      if (cookies.length > 65536) throw new ApiError(400, 'The cookie text is too long.', 'COOKIES_TOO_LONG')
      if (cookies) await store.set(options.cookiesEnv, cookies)
      else await store.unset(options.cookiesEnv)
      changed = true
    }
    if (!changed) throw new ApiError(400, 'Nothing to save; send a token or a cookie value.', 'NOTHING_TO_SAVE')
    state.lastTest = null
    return status()
  }

  const test = async (req) => {
    const body = await readJson(req)
    const token = body.token
      ? normalizeToken(body.token)
      : await resolveSecret(ctx, options.tokenEnv)
    if (!token) {
      throw new ApiError(400, 'Paste a DeepSeek web token first.', 'MISSING_CREDENTIAL')
    }
    const cookies =
      typeof body.cookies === 'string' && body.cookies.trim()
        ? body.cookies.trim()
        : ((await resolveSecret(ctx, options.cookiesEnv)) ?? '')
    const client = new DeepSeekWebClient({
      baseURL: options.baseURL,
      timeoutMs: Math.min(options.timeoutMs, 60000),
      clientVersion: options.clientVersion,
      token,
      cookies,
      logger: ctx.logger,
    })
    try {
      const result = await client.testAuth()
      state.lastTest = {
        ok: true,
        at: new Date().toISOString(),
        latencyMs: result.latencyMs,
        message: 'Token accepted; the PoW challenge was solved locally.',
      }
    } catch (error) {
      state.lastTest = {
        ok: false,
        at: new Date().toISOString(),
        message: error?.message ?? String(error),
      }
      throw new ApiError(400, error?.message ?? String(error), error?.code ?? 'TEST_FAILED')
    }
    return { ok: true, lastTest: state.lastTest, status: await status() }
  }

  const setDefault = async (req) => {
    const body = await readJson(req)
    const model = String(body.model ?? '')
    if (!MODELS.some((entry) => entry.id === model)) {
      throw new ApiError(400, `Unknown model "${model}".`, 'UNKNOWN_MODEL')
    }
    const service = safeGet(ctx, 'agentDefaultModel')
    if (!service?.saveSelection) {
      throw new ApiError(409, 'The default-model service is unavailable in this profile.', 'NO_DEFAULT_MODEL')
    }
    await service.saveSelection({ provider: PROVIDER, model })
    let current = null
    try {
      current = service.currentSelection()
    } catch {
      current = null
    }
    return {
      ok: true,
      defaultSelection: current,
      changed: current?.provider === PROVIDER && current?.model === model,
    }
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      if (path === '/my-model/api/status' && req.method === 'GET') {
        // The status payload contains no secret: only "configured" booleans,
        // model metadata, and the last test message. Keeping it readable lets
        // a local diagnostic surface confirm that the route is live.
        json(res, 200, await status())
        return
      }
      if (!trusted(ctx, req, res)) return
      if (path === '/my-model/api/credentials' && req.method === 'POST') {
        json(res, 200, await saveCredentials(req))
        return
      }
      if (path === '/my-model/api/test' && req.method === 'POST') {
        json(res, 200, await test(req))
        return
      }
      if (path === '/my-model/api/default' && req.method === 'POST') {
        json(res, 200, await setDefault(req))
        return
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown My Model endpoint.' } })
    } catch (error) {
      if (error instanceof ApiError) {
        json(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      ctx.logger?.warn?.('my-model: settings API failed')
      ctx.logger?.warn?.(error)
      json(res, 500, { error: { code: 'INTERNAL', message: error?.message ?? String(error) } })
    }
  }
}

export function apply(ctx, config) {
  const options = optionsOf(config)
  const adapter = new DeepSeekWebAdapter({
    baseURL: options.baseURL,
    timeoutMs: options.timeoutMs,
    clientVersion: options.clientVersion,
    maxPromptChars: options.maxPromptChars,
    logger: ctx.logger,
    resolveToken: () => resolveSecret(ctx, options.tokenEnv),
    resolveCookies: () => resolveSecret(ctx, options.cookiesEnv),
    minTurnGapMs: options.minTurnGapMs,
    maxConcurrentTurns: options.maxConcurrentTurns,
    maxAutoWaitMs: options.maxAutoWaitMs,
    cooldownBaseMs: options.cooldownBaseMs,
    maxCooldownMs: options.maxCooldownMs,
  })

  ctx.llm.registerAdapter([PROVIDER], adapter)

  // `webServer` is a sibling fiber that becomes active only after its listen()
  // resolves. Reading it through ctx.get() at apply time can therefore return
  // undefined and silently skip route registration, so wait for the service;
  // in headless profiles that never provide it this callback simply never runs.
  ctx.inject(['webServer'], (httpCtx) => {
    const state = { lastTest: null }
    const handler = createApi(ctx, options, adapter, state)
    for (const path of [
      '/my-model/api/status',
      '/my-model/api/credentials',
      '/my-model/api/test',
      '/my-model/api/default',
    ]) {
      httpCtx.effect(() => httpCtx.webServer.register({ kind: 'exact', path, handler }))
    }
  })
}

export { MODELS, PROVIDER, PROVIDER_NAME, normalizeToken }
