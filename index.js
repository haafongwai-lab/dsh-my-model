/**
 * My Model — a Harness model provider backed by a DeepSeek web account.
 *
 * The Host half registers the `deepseek-web` LLM route and a small same-origin
 * settings API used by the "My Model" settings page. The token and optional
 * cookie blob live in the Harness credential store, never in the profile
 * patch.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ACCEPT_LANGUAGE,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_PRIORITY,
  DEFAULT_SEC_CH_UA,
  DEFAULT_SEC_CH_UA_MOBILE,
  DEFAULT_SEC_CH_UA_PLATFORM,
  DEFAULT_SEC_FETCH_DEST,
  DEFAULT_SEC_FETCH_MODE,
  DEFAULT_SEC_FETCH_SITE,
  DEFAULT_UA,
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
  // Tool results are truncated and secret-redacted before they reach the web
  // prompt, so a large command output cannot dominate the turn or leak keys.
  maxToolChars: 8000,
  // Rate-limit shaping for the shared web account. One generation at a time,
  // a human-like gap between turn starts, and a capped exponential cooldown.
  minTurnGapMs: 3000,
  maxConcurrentTurns: 1,
  maxAutoWaitMs: 20000,
  cooldownBaseMs: 15000,
  maxCooldownMs: 120000,
  // Human-like pacing (方案A): jitter the inter-turn gap and insert occasional
  // idle pauses so the request cadence resembles a person. Set humanizePacing
  // to false to revert to strict minTurnGapMs.
  humanizePacing: true,
  turnGapJitter: 0.6,
  humanLongPauseChance: 0.25,
  humanLongPauseMinMs: 5000,
  humanLongPauseMaxMs: 20000,
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

const PROFILE_OVERRIDES_FILE = '.my-model.json'
const FINGERPRINT_KEYS = [
  'userAgent',
  'secChUa',
  'secChUaPlatform',
  'secChUaMobile',
  'acceptLanguage',
  'clientVersion',
  'secFetchSite',
  'secFetchMode',
  'secFetchDest',
  'priority',
  'referer',
]

/**
 * Resolve the profile directory the loader anchored `baseUrl` at. The settings
 * page persists its fingerprint overrides there (a dedicated JSON file), which
 * the plugin merges over the loader config on the next boot. A dedicated file
 * is used instead of rewriting `cordis.patch.yml`, which is the loader's
 * comment-preserving patch layer.
 */
function profileDirOf(ctx) {
  const candidates = [safeGet(ctx, 'baseUrl'), ctx?.baseUrl, ctx?.root?.baseUrl]
  for (const base of candidates) {
    if (!base) continue
    try {
      const url = base instanceof URL ? base : new URL(String(base))
      if (url.protocol === 'file:') return fileURLToPath(url)
    } catch {
      // Not a URL; fall through to a plain path.
    }
    try {
      const text = String(base)
      if (text.startsWith('file:')) return fileURLToPath(text)
      if (text) return text
    } catch {
      // Ignore and try the next candidate.
    }
  }
  // Last resort: derive the profile directory from DSH_HOME and --profile.
  try {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    const index = process.argv.indexOf('--profile')
    const profile = index >= 0 ? process.argv[index + 1] : undefined
    if (profile) return join(home, 'profiles', profile)
  } catch {
    // Ignore.
  }
  return undefined
}

function readProfileOverrides(dir) {
  if (!dir) return {}
  try {
    const parsed = JSON.parse(readFileSync(join(dir, PROFILE_OVERRIDES_FILE), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const key of FINGERPRINT_KEYS) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) out[key] = parsed[key].trim()
    }
    return out
  } catch {
    return {}
  }
}

function writeProfileOverrides(dir, overrides) {
  if (!dir) {
    throw new ApiError(
      409,
      'The profile directory is unavailable, so the fingerprint cannot be persisted. Edit the plugin config manually.',
      'NO_PROFILE_DIR',
    )
  }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, PROFILE_OVERRIDES_FILE)
  if (!overrides || Object.keys(overrides).length === 0) {
    try {
      unlinkSync(file)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return
  }
  writeFileSync(file, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8')
}

const LOG_FILE = 'my-model.log'
const LOG_MAX_BYTES = 1024 * 1024

/**
 * Wrap the host logger so the plugin's own diagnostics also land in
 * `<profile>/my-model.log`. The desktop app does not persist host stdout, so
 * this file is the reliable place to inspect rate limits, WAF challenges, and
 * fingerprint warnings. Rotates to `.1` once it exceeds 1 MB.
 */
function fileLogger(base, profileDir) {
  if (!profileDir) return base
  const file = join(profileDir, LOG_FILE)
  let prepared = false
  const prepare = () => {
    if (prepared) return
    prepared = true
    try {
      mkdirSync(profileDir, { recursive: true })
      try {
        if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        // Missing or unreadable log file: start fresh.
      }
    } catch {
      // Logging must never break the provider.
    }
  }
  const write = (level, args) => {
    prepare()
    try {
      const text = args
        .map((arg) =>
          typeof arg === 'string'
            ? arg
            : arg instanceof Error
              ? (arg.stack ?? arg.message)
              : JSON.stringify(arg),
        )
        .join(' ')
      appendFileSync(file, `${new Date().toISOString()} [${level}] ${text}\n`)
    } catch {
      // Logging must never break the provider.
    }
    base?.[level]?.(...args)
  }
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
  }
}

function applyFingerprintToClient(client, effective) {
  client.userAgent = effective.userAgent ?? DEFAULT_UA
  client.secChUa = effective.secChUa ?? DEFAULT_SEC_CH_UA
  client.secChUaPlatform = effective.secChUaPlatform ?? DEFAULT_SEC_CH_UA_PLATFORM
  client.secChUaMobile = effective.secChUaMobile ?? DEFAULT_SEC_CH_UA_MOBILE
  client.acceptLanguage = effective.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE
  client.clientVersion = effective.clientVersion ?? DEFAULT_CLIENT_VERSION
  client.secFetchSite = effective.secFetchSite ?? DEFAULT_SEC_FETCH_SITE
  client.secFetchMode = effective.secFetchMode ?? DEFAULT_SEC_FETCH_MODE
  client.secFetchDest = effective.secFetchDest ?? DEFAULT_SEC_FETCH_DEST
  client.priority = effective.priority ?? DEFAULT_PRIORITY
  client.referer = effective.referer ?? `${client.baseURL}/a/chat/`
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
    maxToolChars: Math.max(500, Number(input.maxToolChars) || DEFAULTS.maxToolChars),
    minTurnGapMs: clampNumber(input.minTurnGapMs, DEFAULTS.minTurnGapMs, 0, 60000),
    maxConcurrentTurns: Math.round(clampNumber(input.maxConcurrentTurns, DEFAULTS.maxConcurrentTurns, 1, 4)),
    maxAutoWaitMs: clampNumber(input.maxAutoWaitMs, DEFAULTS.maxAutoWaitMs, 0, 120000),
    cooldownBaseMs,
    maxCooldownMs: clampNumber(input.maxCooldownMs, DEFAULTS.maxCooldownMs, cooldownBaseMs, 600000),
    userAgent: typeof input.userAgent === 'string' && input.userAgent.trim() ? input.userAgent.trim() : undefined,
    secChUa: typeof input.secChUa === 'string' && input.secChUa.trim() ? input.secChUa.trim() : undefined,
    secChUaPlatform:
      typeof input.secChUaPlatform === 'string' && input.secChUaPlatform.trim()
        ? input.secChUaPlatform.trim()
        : undefined,
    secChUaMobile:
      typeof input.secChUaMobile === 'string' && input.secChUaMobile.trim()
        ? input.secChUaMobile.trim()
        : undefined,
    acceptLanguage:
      typeof input.acceptLanguage === 'string' && input.acceptLanguage.trim()
        ? input.acceptLanguage.trim()
        : undefined,
    secFetchSite:
      typeof input.secFetchSite === 'string' && input.secFetchSite.trim()
        ? input.secFetchSite.trim()
        : undefined,
    secFetchMode:
      typeof input.secFetchMode === 'string' && input.secFetchMode.trim()
        ? input.secFetchMode.trim()
        : undefined,
    secFetchDest:
      typeof input.secFetchDest === 'string' && input.secFetchDest.trim()
        ? input.secFetchDest.trim()
        : undefined,
    priority: typeof input.priority === 'string' && input.priority.trim() ? input.priority.trim() : undefined,
    referer: typeof input.referer === 'string' && input.referer.trim() ? input.referer.trim() : undefined,
    clientLocale:
      typeof input.clientLocale === 'string' && input.clientLocale.trim() ? input.clientLocale.trim() : undefined,
    clientPlatform:
      typeof input.clientPlatform === 'string' && input.clientPlatform.trim() ? input.clientPlatform.trim() : undefined,
    clientBundleId:
      typeof input.clientBundleId === 'string' && input.clientBundleId.trim() ? input.clientBundleId.trim() : undefined,
    humanizePacing: input.humanizePacing === false ? false : true,
    turnGapJitter: clampNumber(input.turnGapJitter, DEFAULTS.turnGapJitter, 0, 2),
    humanLongPauseChance: clampNumber(input.humanLongPauseChance, DEFAULTS.humanLongPauseChance, 0, 1),
    humanLongPauseMinMs: clampNumber(input.humanLongPauseMinMs, DEFAULTS.humanLongPauseMinMs, 0, 60000),
    humanLongPauseMaxMs: clampNumber(input.humanLongPauseMaxMs, DEFAULTS.humanLongPauseMaxMs, 0, 120000),
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

/**
 * A cross-site browser request is the CSRF threat here. Modern browsers always
 * send `Sec-Fetch-Site` (and `Origin` on POST), so reject those even when the
 * host's `connection` guard is unavailable. A non-browser local client (curl,
 * tests) sends neither header and is allowed.
 */
function sameOriginRequest(req) {
  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers?.origin
  if (!origin) return true
  const host = req.headers?.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function trusted(ctx, req, res) {
  const connection = safeGet(ctx, 'connection')
  if (connection?.requestRejection) {
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
  // No host guard available: fail closed for cross-site browsers instead of
  // allowing every local caller through.
  if (!sameOriginRequest(req)) {
    res.writeHead(403)
    res.end()
    return false
  }
  return true
}

function createApi(ctx, options, adapter, state, extras = {}) {
  const credentials = () => safeGet(ctx, 'credentials')
  const log = extras.logger ?? ctx.logger

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
      fingerprint: {
        userAgent: adapter.client.userAgent,
        secChUa: adapter.client.secChUa,
        secChUaPlatform: adapter.client.secChUaPlatform,
        secChUaMobile: adapter.client.secChUaMobile,
        acceptLanguage: adapter.client.acceptLanguage,
        clientVersion: adapter.client.clientVersion,
        secFetchSite: adapter.client.secFetchSite,
        secFetchMode: adapter.client.secFetchMode,
        secFetchDest: adapter.client.secFetchDest,
        priority: adapter.client.priority,
        referer: adapter.client.referer,
        overridden: Object.keys(readProfileOverrides(extras.profileDir)).length > 0,
        persistable: Boolean(extras.profileDir),
      },
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
      // Use the live client's fingerprint so a settings-page change is reflected
      // by "Test connection" without a restart.
      clientVersion: adapter.client.clientVersion,
      userAgent: adapter.client.userAgent,
      secChUa: adapter.client.secChUa,
      secChUaPlatform: adapter.client.secChUaPlatform,
      secChUaMobile: adapter.client.secChUaMobile,
      acceptLanguage: adapter.client.acceptLanguage,
      secFetchSite: adapter.client.secFetchSite,
      secFetchMode: adapter.client.secFetchMode,
      secFetchDest: adapter.client.secFetchDest,
      priority: adapter.client.priority,
      referer: adapter.client.referer,
      clientLocale: adapter.client.clientLocale,
      clientPlatform: adapter.client.clientPlatform,
      clientBundleId: adapter.client.clientBundleId,
      token,
      cookies,
      logger: log,
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

  const saveFingerprint = async (req) => {
    const body = await readJson(req)
    const dir = extras.profileDir
    if (!dir) {
      throw new ApiError(
        409,
        'The profile directory is unavailable, so the fingerprint cannot be persisted. Edit the plugin config manually.',
        'NO_PROFILE_DIR',
      )
    }
    const overrides = readProfileOverrides(dir)
    if (body.reset === true) {
      writeProfileOverrides(dir, {})
    } else {
      for (const key of FINGERPRINT_KEYS) {
        if (!(key in body)) continue
        const value = body[key]
        if (value === null || value === undefined || value === '') {
          delete overrides[key]
          continue
        }
        if (typeof value !== 'string') {
          throw new ApiError(400, `${key} must be a string.`, 'BAD_FINGERPRINT')
        }
        const trimmed = value.trim()
        if (trimmed.length > 1024) {
          throw new ApiError(400, `${key} is too long.`, 'FINGERPRINT_TOO_LONG')
        }
        if (/[\r\n]/.test(trimmed)) {
          throw new ApiError(400, `${key} must be one line.`, 'FINGERPRINT_MULTILINE')
        }
        if (trimmed) overrides[key] = trimmed
        else delete overrides[key]
      }
      writeProfileOverrides(dir, overrides)
    }
    // Apply immediately so the next request uses the new profile without a
    // restart; the persisted file makes it survive the next boot.
    const effective = optionsOf({ ...(extras.loaderConfig ?? {}), ...readProfileOverrides(dir) })
    applyFingerprintToClient(adapter.client, effective)
    state.lastTest = null
    return status()
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
      if (path === '/my-model/api/fingerprint' && req.method === 'POST') {
        json(res, 200, await saveFingerprint(req))
        return
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown My Model endpoint.' } })
    } catch (error) {
      if (error instanceof ApiError) {
        json(res, error.status, { error: { code: error.code, message: error.message } })
        return
      }
      log?.warn?.('my-model: settings API failed')
      log?.warn?.(error)
      json(res, 500, { error: { code: 'INTERNAL', message: error?.message ?? String(error) } })
    }
  }
}

export function apply(ctx, config) {
  const loaderConfig = config && typeof config === 'object' ? config : {}
  const profileDir = profileDirOf(ctx)
  const logger = fileLogger(ctx.logger, profileDir)
  logger?.info?.('my-model: logger started')
  if (!profileDir) {
    logger?.warn?.(
      'my-model: could not resolve the profile directory; fingerprint settings from the settings page will not persist (edit the plugin config instead).',
    )
  }
  const startupOverrides = readProfileOverrides(profileDir)
  // Settings-page overrides win over the loader config for the fields they
  // contain, mirroring the host's `base` + user-layer composition.
  const options = optionsOf({ ...loaderConfig, ...startupOverrides })
  // The built-in fingerprint is a snapshot and goes stale as the browser and
  // web client update. When no settings-page overrides exist, surface that the
  // defaults are in use instead of failing silently.
  if (Object.keys(startupOverrides).length === 0 && options.clientVersion === DEFAULTS.clientVersion) {
    logger?.warn?.(
      'my-model: using the built-in browser fingerprint. If your browser or the deployed web client changed, ' +
        'set userAgent, secChUa, secChUaPlatform and clientVersion in the settings page or plugin config.',
    )
  }
  const adapter = new DeepSeekWebAdapter({
    baseURL: options.baseURL,
    timeoutMs: options.timeoutMs,
    clientVersion: options.clientVersion,
    userAgent: options.userAgent,
    secChUa: options.secChUa,
    secChUaPlatform: options.secChUaPlatform,
    secChUaMobile: options.secChUaMobile,
    acceptLanguage: options.acceptLanguage,
    secFetchSite: options.secFetchSite,
    secFetchMode: options.secFetchMode,
    secFetchDest: options.secFetchDest,
    priority: options.priority,
    referer: options.referer,
    clientLocale: options.clientLocale,
    clientPlatform: options.clientPlatform,
    clientBundleId: options.clientBundleId,
    maxPromptChars: options.maxPromptChars,
    maxToolChars: options.maxToolChars,
    logger,
    resolveToken: () => resolveSecret(ctx, options.tokenEnv),
    resolveCookies: () => resolveSecret(ctx, options.cookiesEnv),
    minTurnGapMs: options.minTurnGapMs,
    maxConcurrentTurns: options.maxConcurrentTurns,
    maxAutoWaitMs: options.maxAutoWaitMs,
    cooldownBaseMs: options.cooldownBaseMs,
    maxCooldownMs: options.maxCooldownMs,
    humanizePacing: options.humanizePacing,
    turnGapJitter: options.turnGapJitter,
    humanLongPauseChance: options.humanLongPauseChance,
    humanLongPauseMinMs: options.humanLongPauseMinMs,
    humanLongPauseMaxMs: options.humanLongPauseMaxMs,
  })

  ctx.llm.registerAdapter([PROVIDER], adapter)

  // `webServer` is a sibling fiber that becomes active only after its listen()
  // resolves. Reading it through ctx.get() at apply time can therefore return
  // undefined and silently skip route registration, so wait for the service;
  // in headless profiles that never provide it this callback simply never runs.
  ctx.inject(['webServer'], (httpCtx) => {
    const state = { lastTest: null }
    const handler = createApi(ctx, options, adapter, state, { loaderConfig, profileDir, logger })
    for (const path of [
      '/my-model/api/status',
      '/my-model/api/credentials',
      '/my-model/api/test',
      '/my-model/api/default',
      '/my-model/api/fingerprint',
    ]) {
      httpCtx.effect(() => httpCtx.webServer.register({ kind: 'exact', path, handler }))
    }
  })
}

export { MODELS, PROVIDER, PROVIDER_NAME, normalizeToken }
