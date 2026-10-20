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
import {
  ChatGptWebAdapter,
  ChatGptWebClient,
  DEFAULT_UA as CHATGPT_DEFAULT_UA,
  MODELS as CHATGPT_MODELS,
  PROVIDER as CHATGPT_PROVIDER,
  PROVIDER_NAME as CHATGPT_PROVIDER_NAME,
  normalizeAccessToken,
} from './chatgpt-web.js'
import { attachPage, getCookies, probeCdp } from './chrome-cdp.js'
import { LaunchError, launchChrome } from './chrome-launch.js'
import { HeadlessChromeError, ManagedChrome, defaultHeadlessUserDataDir } from './headless-chrome.js'

export const name = 'my-model'
export const inject = ['llm']

const DEFAULTS = {
  baseURL: 'https://chat.deepseek.com',
  clientVersion: DEFAULT_CLIENT_VERSION,
  tokenEnv: 'DEEPSEEK_WEB_TOKEN',
  cookiesEnv: 'DEEPSEEK_WEB_COOKIES',
  // ChatGPT web account. Credentials live in the same store under their own
  // keys so the two web accounts never overwrite each other.
  chatgptBaseURL: 'https://chatgpt.com',
  chatgptTokenEnv: 'CHATGPT_WEB_TOKEN',
  chatgptCookiesEnv: 'CHATGPT_WEB_COOKIES',
  chatgptModelSlug: 'gpt-6-luna',
  chatgptLanguage: 'zh-CN',
  // 'node' sends the request with fetch; 'cdp' runs it inside the user's own
  // Chrome page so the TLS/HTTP2 fingerprint is the browser's; 'headless' runs
  // the same page in a managed, always-on headless Chromium.
  chatgptTransport: 'node',
  chatgptCdpPort: 9222,
  chatgptCdpHost: '127.0.0.1',
  // A second managed Chromium for ChatGPT keeps its profile and login separate
  // from the DeepSeek one (and from the visible debug browser).
  chatgptHeadlessPort: 9224,
  chatgptHeadlessHost: '127.0.0.1',
  chatgptHeadlessUserDataDir: '',
  // DeepSeek web transport. 'cdp' runs the request in a chat.deepseek.com tab
  // and automatically falls back to Node when that Chrome window is closed.
  // 'headless' runs it in a managed, always-on headless Chromium and never
  // falls back to Node.
  deepseekTransport: 'node',
  deepseekCdpPort: 9222,
  deepseekCdpHost: '127.0.0.1',
  deepseekHeadlessPort: 9223,
  deepseekHeadlessHost: '127.0.0.1',
  // One-click launcher: which executable to start and where its dedicated
  // profile lives. Empty means "find the browser automatically" and
  // "<LOCALAPPDATA>/dsh-chrome".
  chromePath: '',
  chromeUserDataDir: '',
  chromeHeadlessUserDataDir: '',
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
/**
 * ChatGPT transport settings live in their own file so the fingerprint overrides
 * stay a pure fingerprint record (the settings page merges that file into the
 * loader config field by field).
 */
const CHATGPT_SETTINGS_FILE = '.my-model-chatgpt.json'
const DEEPSEEK_SETTINGS_FILE = '.my-model-deepseek.json'
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

/** Read the persisted ChatGPT transport choice (missing file = defaults). */
function readChatgptSettings(dir) {
  if (!dir) return {}
  try {
    const parsed = JSON.parse(readFileSync(join(dir, CHATGPT_SETTINGS_FILE), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    if (parsed.transport === 'cdp' || parsed.transport === 'node' || parsed.transport === 'headless') {
      out.chatgptTransport = parsed.transport
    }
    const port = Number(parsed.cdpPort)
    if (Number.isInteger(port) && port > 0 && port < 65536) out.chatgptCdpPort = port
    const headlessPort = Number(parsed.headlessPort)
    if (Number.isInteger(headlessPort) && headlessPort > 0 && headlessPort < 65536) {
      out.chatgptHeadlessPort = headlessPort
    }
    return out
  } catch {
    return {}
  }
}

function writeChatgptSettings(dir, value) {
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CHATGPT_SETTINGS_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch {
    // Persisting the transport is a convenience; never fail the request for it.
  }
}

/** Read the persisted DeepSeek transport choice (missing file = defaults). */
function readDeepseekSettings(dir) {
  if (!dir) return {}
  try {
    const parsed = JSON.parse(readFileSync(join(dir, DEEPSEEK_SETTINGS_FILE), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    if (parsed.transport === 'cdp' || parsed.transport === 'node' || parsed.transport === 'headless') {
      out.deepseekTransport = parsed.transport
    }
    const port = Number(parsed.cdpPort)
    if (Number.isInteger(port) && port > 0 && port < 65536) out.deepseekCdpPort = port
    const headlessPort = Number(parsed.headlessPort)
    if (Number.isInteger(headlessPort) && headlessPort > 0 && headlessPort < 65536) {
      out.deepseekHeadlessPort = headlessPort
    }
    return out
  } catch {
    return {}
  }
}

function writeDeepseekSettings(dir, value) {
  if (!dir) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, DEEPSEEK_SETTINGS_FILE), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch {
    // Persisting the transport is a convenience; never fail the request for it.
  }
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

/**
 * The browser-identity fields shared by both web providers. The DeepSeek-only
 * fields (`clientVersion`, fetch metadata, referer) are left to
 * `applyFingerprintToClient`; ChatGPT sends a different header set.
 */
function applySharedFingerprint(client, effective) {
  client.userAgent = effective.userAgent ?? DEFAULT_UA
  client.secChUa = effective.secChUa ?? DEFAULT_SEC_CH_UA
  client.secChUaPlatform = effective.secChUaPlatform ?? DEFAULT_SEC_CH_UA_PLATFORM
  client.secChUaMobile = effective.secChUaMobile ?? DEFAULT_SEC_CH_UA_MOBILE
  client.acceptLanguage = effective.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE
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
    chatgptBaseURL:
      typeof input.chatgptBaseURL === 'string' && input.chatgptBaseURL.trim()
        ? input.chatgptBaseURL.trim()
        : DEFAULTS.chatgptBaseURL,
    chatgptTokenEnv:
      typeof input.chatgptTokenEnv === 'string' && input.chatgptTokenEnv.trim()
        ? input.chatgptTokenEnv.trim()
        : DEFAULTS.chatgptTokenEnv,
    chatgptCookiesEnv:
      typeof input.chatgptCookiesEnv === 'string' && input.chatgptCookiesEnv.trim()
        ? input.chatgptCookiesEnv.trim()
        : DEFAULTS.chatgptCookiesEnv,
    chatgptModelSlug:
      typeof input.chatgptModelSlug === 'string' && input.chatgptModelSlug.trim()
        ? input.chatgptModelSlug.trim()
        : DEFAULTS.chatgptModelSlug,
    chatgptLanguage:
      typeof input.chatgptLanguage === 'string' && input.chatgptLanguage.trim()
        ? input.chatgptLanguage.trim()
        : DEFAULTS.chatgptLanguage,
    chatgptTransport:
      input.chatgptTransport === 'cdp' || input.chatgptTransport === 'headless'
        ? input.chatgptTransport
        : 'node',
    chatgptCdpPort: Math.round(clampNumber(input.chatgptCdpPort, DEFAULTS.chatgptCdpPort, 1, 65535)),
    chatgptCdpHost:
      typeof input.chatgptCdpHost === 'string' && input.chatgptCdpHost.trim()
        ? input.chatgptCdpHost.trim()
        : DEFAULTS.chatgptCdpHost,
    chatgptHeadlessPort: Math.round(
      clampNumber(input.chatgptHeadlessPort, DEFAULTS.chatgptHeadlessPort, 1, 65535),
    ),
    chatgptHeadlessHost:
      typeof input.chatgptHeadlessHost === 'string' && input.chatgptHeadlessHost.trim()
        ? input.chatgptHeadlessHost.trim()
        : DEFAULTS.chatgptHeadlessHost,
    chatgptHeadlessUserDataDir:
      typeof input.chatgptHeadlessUserDataDir === 'string' && input.chatgptHeadlessUserDataDir.trim()
        ? input.chatgptHeadlessUserDataDir.trim()
        : '',
    deepseekTransport:
      input.deepseekTransport === 'cdp' || input.deepseekTransport === 'headless'
        ? input.deepseekTransport
        : 'node',
    deepseekCdpPort: Math.round(clampNumber(input.deepseekCdpPort, DEFAULTS.deepseekCdpPort, 1, 65535)),
    deepseekCdpHost:
      typeof input.deepseekCdpHost === 'string' && input.deepseekCdpHost.trim()
        ? input.deepseekCdpHost.trim()
        : DEFAULTS.deepseekCdpHost,
    deepseekHeadlessPort: Math.round(
      clampNumber(input.deepseekHeadlessPort, DEFAULTS.deepseekHeadlessPort, 1, 65535),
    ),
    deepseekHeadlessHost:
      typeof input.deepseekHeadlessHost === 'string' && input.deepseekHeadlessHost.trim()
        ? input.deepseekHeadlessHost.trim()
        : DEFAULTS.deepseekHeadlessHost,
    chromePath: typeof input.chromePath === 'string' && input.chromePath.trim() ? input.chromePath.trim() : '',
    chromeUserDataDir:
      typeof input.chromeUserDataDir === 'string' && input.chromeUserDataDir.trim()
        ? input.chromeUserDataDir.trim()
        : '',
    chromeHeadlessUserDataDir:
      typeof input.chromeHeadlessUserDataDir === 'string' && input.chromeHeadlessUserDataDir.trim()
        ? input.chromeHeadlessUserDataDir.trim()
        : '',
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
  const chatgpt = extras.chatgpt ?? {}
  const headless = extras.headless
  const chatgptHeadless = extras.chatgptHeadless
  // The visible Chrome endpoint survives transport switches; the headless
  // manager owns its own port/host.
  let deepseekVisiblePort = options.deepseekCdpPort
  let deepseekVisibleHost = options.deepseekCdpHost
  let chatgptVisiblePort = options.chatgptCdpPort
  let chatgptVisibleHost = options.chatgptCdpHost

  /**
   * Status of one web account. Shared by the DeepSeek and ChatGPT cards so the
   * settings page gets the same shape for both (and never a secret value).
   */
  const accountStatus = async ({
    provider,
    name,
    models,
    adapter: accountAdapter,
    tokenEnv,
    cookiesEnv,
    baseURL,
    state: accountState,
  }) => {
    const token = await describeSecret(ctx, tokenEnv)
    const cookies = await describeSecret(ctx, cookiesEnv)
    let providerActive = false
    let routableModels = []
    try {
      providerActive = ctx.llm.listProviders().some((entry) => entry.id === provider)
      if (providerActive) routableModels = (await ctx.llm.listModels(provider)).map((model) => model.id)
    } catch {
      providerActive = false
    }
    return {
      provider: { id: provider, name, active: providerActive },
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        thinking: model.thinking,
        search: model.search,
        routable: routableModels.includes(model.id),
      })),
      token,
      cookies,
      tokenEnv,
      cookiesEnv,
      baseURL,
      lastTest: accountState?.lastTest ?? null,
      lastFailure: accountAdapter?.lastFailure ?? null,
    }
  }

  /**
   * Whether a Chromium DevTools endpoint is listening, plus which browser it is.
   * Cheap on loopback (a refused connection returns immediately).
   */
  const cdpStatusFor = async (client, fallbackPort, fallbackHost) => {
    const port = client?.cdpPort ?? fallbackPort
    const host = client?.cdpHost ?? fallbackHost
    const probe = await probeCdp({ host, port, timeoutMs: 800 })
    return { host, port, ...probe }
  }

  const status = async () => {
    const primary = await accountStatus({
      provider: PROVIDER,
      name: PROVIDER_NAME,
      models: MODELS,
      adapter,
      tokenEnv: options.tokenEnv,
      cookiesEnv: options.cookiesEnv,
      baseURL: options.baseURL,
      state,
    })
    const defaultModel = safeGet(ctx, 'agentDefaultModel')
    let defaultSelection = null
    try {
      defaultSelection = defaultModel?.currentSelection?.() ?? null
    } catch {
      defaultSelection = null
    }
    const chatgptAccount = chatgpt.adapter
      ? await accountStatus({
          provider: CHATGPT_PROVIDER,
          name: CHATGPT_PROVIDER_NAME,
          models: CHATGPT_MODELS,
          adapter: chatgpt.adapter,
          tokenEnv: options.chatgptTokenEnv,
          cookiesEnv: options.chatgptCookiesEnv,
          baseURL: options.chatgptBaseURL,
          state: chatgpt.state,
        })
      : null
    return {
      ok: true,
      ...primary,
      transport: adapter.client.transport,
      cdp: await cdpStatusFor(adapter.client, options.deepseekCdpPort, options.deepseekCdpHost),
      headless: headless ? await headless.status() : null,
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
      ...(chatgptAccount
        ? {
            chatgpt: {
              ...chatgptAccount,
              modelSlug: options.chatgptModelSlug,
              transport: chatgpt.adapter?.client?.transport ?? options.chatgptTransport,
              cdp: await cdpStatusFor(undefined, chatgptVisiblePort, chatgptVisibleHost),
              headless: chatgptHeadless ? await chatgptHeadless.status() : null,
            },
          }
        : {}),
    }
  }

  /**
   * Store one account's token/cookie pair. Shared by both web providers; the
   * token normalizer and the messages differ, the validation does not.
   */
  const saveCredentialsFor = async (req, { tokenEnv, cookiesEnv, normalize, state: accountState, tokenLabel }) => {
    const store = credentials()
    if (!store) throw new ApiError(409, 'The Harness credential service is unavailable in this profile.', 'NO_CREDENTIALS')
    const body = await readJson(req)
    if (body.clear === true) {
      await store.unset(tokenEnv)
      await store.unset(cookiesEnv)
      accountState.lastTest = null
      return
    }
    let changed = false
    if (typeof body.token === 'string') {
      const token = normalize(body.token)
      if (!token) throw new ApiError(400, 'The token is empty.', 'EMPTY_TOKEN')
      if (token.length > 16384) throw new ApiError(400, 'The token is too long.', 'TOKEN_TOO_LONG')
      if (/[\r\n]/.test(token)) throw new ApiError(400, 'The token must be one line.', 'TOKEN_MULTILINE')
      await store.set(tokenEnv, token)
      changed = true
    }
    if (typeof body.cookies === 'string') {
      const cookies = body.cookies.trim()
      if (cookies.length > 65536) throw new ApiError(400, 'The cookie text is too long.', 'COOKIES_TOO_LONG')
      if (cookies) await store.set(cookiesEnv, cookies)
      else await store.unset(cookiesEnv)
      changed = true
    }
    if (!changed) {
      throw new ApiError(400, `Nothing to save; send a ${tokenLabel} token or a cookie value.`, 'NOTHING_TO_SAVE')
    }
    accountState.lastTest = null
  }

  const saveCredentials = async (req) => {
    await saveCredentialsFor(req, {
      tokenEnv: options.tokenEnv,
      cookiesEnv: options.cookiesEnv,
      normalize: normalizeToken,
      state,
      tokenLabel: 'DeepSeek web',
    })
    return status()
  }

  const saveChatgptCredentials = async (req) => {
    if (!chatgpt.adapter) throw new ApiError(409, 'The ChatGPT provider is not active in this profile.', 'NO_PROVIDER')
    await saveCredentialsFor(req, {
      tokenEnv: options.chatgptTokenEnv,
      cookiesEnv: options.chatgptCookiesEnv,
      normalize: normalizeAccessToken,
      state: chatgpt.state,
      tokenLabel: 'ChatGPT web',
    })
    return status()
  }

  const test = async (req) => {
    const body = await readJson(req)
    const usingCdp = adapter.client.transport === 'cdp'
    const usingHeadless = adapter.client.transport === 'headless'
    const token = body.token
      ? normalizeToken(body.token)
      : await resolveSecret(ctx, options.tokenEnv)
    const testToken = token || adapter.client.cdpToken
    if (!testToken && !usingCdp) {
      throw new ApiError(400, 'Paste a DeepSeek web token first.', 'MISSING_CREDENTIAL')
    }
    const cookies =
      typeof body.cookies === 'string' && body.cookies.trim()
        ? body.cookies.trim()
        : ((await resolveSecret(ctx, options.cookiesEnv)) ?? '') || adapter.client.jar.header()
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
      // Exercise the same transport the turns will use; CDP falls back to Node
      // when Chrome is closed, while headless starts its managed browser.
      transport: usingHeadless ? 'headless' : usingCdp ? 'cdp' : 'node',
      cdpPort: adapter.client.cdpPort,
      cdpHost: adapter.client.cdpHost,
      ensureHeadless: () => headless?.ensure(),
      token: testToken,
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

  /**
   * Verify the ChatGPT path without sending a chat message: the session endpoint
   * proves the login, and the sentinel call proves the proof-of-work gate can be
   * passed. Over CDP there is nothing to paste — the browser tab holds the
   * session — so the credential requirement only applies to the Node transport.
   */
  const testChatgpt = async (req) => {
    if (!chatgpt.adapter) throw new ApiError(409, 'The ChatGPT provider is not active in this profile.', 'NO_PROVIDER')
    const live = chatgpt.adapter.client
    const usingCdp = live.usesCdp()
    const usingHeadless = live.transport === 'headless'
    const body = await readJson(req)
    const token =
      typeof body.token === 'string' && body.token.trim()
        ? normalizeAccessToken(body.token)
        : await resolveSecret(ctx, options.chatgptTokenEnv)
    const cookies =
      typeof body.cookies === 'string' && body.cookies.trim()
        ? body.cookies.trim()
        : ((await resolveSecret(ctx, options.chatgptCookiesEnv)) ?? '')
    if (!usingCdp && !token && !cookies) {
      throw new ApiError(
        400,
        'Paste a ChatGPT accessToken, or the chatgpt.com cookie string, first.',
        'MISSING_CREDENTIAL',
      )
    }
    const client = new ChatGptWebClient({
      baseURL: options.chatgptBaseURL,
      timeoutMs: Math.min(options.timeoutMs, 60000),
      userAgent: live.userAgent,
      secChUa: live.secChUa,
      secChUaPlatform: live.secChUaPlatform,
      secChUaMobile: live.secChUaMobile,
      acceptLanguage: live.acceptLanguage,
      oaiLanguage: live.oaiLanguage,
      token,
      cookies,
      logger: log,
      // The test must exercise the transport the turns will use, otherwise a
      // green result says nothing about the path that actually runs.
      transport: live.transport,
      cdpPort: live.cdpPort,
      cdpHost: live.cdpHost,
      ensureHeadless: () => chatgptHeadless?.ensure(),
    })
    try {
      const result = await client.testAuth()
      const who = result.email
        ? `Signed in as ${result.email}${result.planType ? ` (${result.planType})` : ''}`
        : 'Session accepted'
      chatgpt.state.lastTest = {
        ok: true,
        at: new Date().toISOString(),
        latencyMs: result.latencyMs,
        message: result.turnstileRequired
          ? usingHeadless
            ? `${who}; this account requires a Turnstile proof, so chat turns are sent through the managed ` +
              'headless Chromium page composer.'
            : usingCdp
              ? `${who}; this account requires a Turnstile proof, so chat turns are sent through the open page's composer. ` +
                'Keep that Chrome window open while the Harness works.'
              : `${who}; this account requires a Turnstile proof, which only the page's own JavaScript can produce. ` +
                'Switch to the local Chrome or managed headless transport and retry.'
          : `${who}; the sentinel token was obtained.`,
        turnstileRequired: Boolean(result.turnstileRequired),
      }
    } catch (error) {
      chatgpt.state.lastTest = {
        ok: false,
        at: new Date().toISOString(),
        message: error?.message ?? String(error),
      }
      throw new ApiError(400, error?.message ?? String(error), error?.code ?? 'TEST_FAILED')
    }
    return { ok: true, lastTest: chatgpt.state.lastTest, status: await status() }
  }

  const providerOfModel = (model) => {
    if (MODELS.some((entry) => entry.id === model)) return PROVIDER
    if (CHATGPT_MODELS.some((entry) => entry.id === model)) return CHATGPT_PROVIDER
    return undefined
  }

  /**
   * Switch how ChatGPT requests leave the machine:
   *  - `node`     — fetch from the host (fails Cloudflare's device check in practice)
   *  - `cdp`      — run the fetch inside the user's own Chrome tab
   *  - `headless` — run the same page in the managed, always-on headless Chromium
   * The choice is applied immediately and persisted per profile.
   */
  const setChatgptTransport = async (req) => {
    if (!chatgpt.adapter) throw new ApiError(409, 'The ChatGPT provider is not active in this profile.', 'NO_PROVIDER')
    const body = await readJson(req)
    const transport = body.transport
    if (transport !== 'node' && transport !== 'cdp' && transport !== 'headless') {
      throw new ApiError(400, 'transport must be "node", "cdp" or "headless".', 'BAD_TRANSPORT')
    }
    if (transport === 'headless' && !chatgptHeadless) {
      throw new ApiError(409, 'The headless Chromium manager is unavailable.', 'NO_HEADLESS')
    }
    const client = chatgpt.adapter.client
    if (body.port !== undefined) {
      const port = Number(body.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ApiError(400, 'port must be an integer between 1 and 65535.', 'BAD_PORT')
      }
      if (transport === 'headless') chatgptHeadless.port = port
      else {
        chatgptVisiblePort = port
        client.cdpPort = port
      }
    }
    if (transport === 'headless') {
      chatgptHeadless.port = chatgptHeadless.port ?? options.chatgptHeadlessPort
      client.cdpPort = chatgptHeadless.port
      client.cdpHost = chatgptHeadless.host
    } else {
      client.cdpPort = chatgptVisiblePort
      client.cdpHost = chatgptVisibleHost
    }
    client.setTransport(transport)
    writeChatgptSettings(extras.profileDir, {
      transport,
      cdpPort: chatgptVisiblePort,
      headlessPort: chatgptHeadless?.port ?? options.chatgptHeadlessPort,
    })
    chatgpt.state.lastTest = null
    return status()
  }

  /**
   * Start the local debug browser and switch ChatGPT to the transport that uses
   * it — the two manual steps from the transport instructions, in one click.
   * The executable and profile come from plugin config or the well-known
   * locations; the request body may only choose an already validated port.
   */
  const launchChatgptChrome = async (req) => {
    if (!chatgpt.adapter) throw new ApiError(409, 'The ChatGPT provider is not active in this profile.', 'NO_PROVIDER')
    const body = await readJson(req)
    const client = chatgpt.adapter.client
    const port = body.port === undefined ? Number(chatgptVisiblePort) : Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError(400, 'port must be an integer between 1 and 65535.', 'BAD_PORT')
    }
    let launch
    try {
      launch = await launchChrome({
        port,
        host: chatgptVisibleHost,
        configuredExecutable: options.chromePath || undefined,
        profileDir: options.chromeUserDataDir || undefined,
      })
    } catch (error) {
      if (error instanceof LaunchError) {
        log?.warn?.(`my-model: could not start local Chrome (${error.code}): ${error.message}`)
        throw new ApiError(400, error.message, error.code)
      }
      throw error
    }
    // The debug browser is only useful to the transport that talks to it, and
    // the user asked for one click — so save that choice too.
    client.setTransport('cdp')
    client.cdpPort = port
    client.cdpHost = chatgptVisibleHost
    chatgptVisiblePort = port
    writeChatgptSettings(extras.profileDir, {
      transport: 'cdp',
      cdpPort: port,
      headlessPort: chatgptHeadless?.port ?? options.chatgptHeadlessPort,
    })
    chatgpt.state.lastTest = null
    log?.info?.(`my-model: ${launch.message}`)
    return { ok: true, launch, status: await status() }
  }

  /**
   * Copy the chatgpt.com cookies from the visible debug Chrome into the
   * credential store. The headless profile is separate, and Cloudflare's
   * cf_clearance only works with a matching User-Agent, which the client sets
   * from the same fingerprint — so a copied blob is enough to sign in.
   */
  const importVisibleChatgptCookies = async () => {
    const store = credentials()
    if (!store?.set) return false
    let attached
    try {
      attached = await attachPage({
        host: chatgptVisibleHost,
        port: chatgptVisiblePort,
        origin: options.chatgptBaseURL,
        timeoutMs: 4000,
      })
    } catch {
      return false
    }
    try {
      const header = await getCookies(attached.connection, [`${options.chatgptBaseURL}/`])
      if (!header) return false
      await store.set(options.chatgptCookiesEnv, header)
      return true
    } finally {
      try {
        attached.connection.close()
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * Start (or adopt) the always-on headless Chromium for ChatGPT and switch to
   * it. Its profile is separate from the visible browser, so the login is
   * seeded from the visible tab when one is available, or from the saved cookie
   * string otherwise.
   */
  const startChatgptHeadless = async () => {
    if (!chatgptHeadless) throw new ApiError(409, 'The headless Chromium manager is unavailable.', 'NO_HEADLESS')
    let result
    try {
      result = await chatgptHeadless.ensure()
    } catch (error) {
      if (error instanceof HeadlessChromeError) {
        log?.warn?.(`my-model: headless Chromium failed (${error.code}): ${error.message}`)
        throw new ApiError(400, error.message, error.code)
      }
      throw error
    }
    let importedCookies = false
    try {
      importedCookies = await importVisibleChatgptCookies()
    } catch (error) {
      log?.warn?.(`my-model: could not copy chatgpt.com cookies from local Chrome: ${error?.message ?? String(error)}`)
    }
    const client = chatgpt.adapter.client
    client.cdpPort = chatgptHeadless.port
    client.cdpHost = chatgptHeadless.host
    client.setTransport('headless')
    writeChatgptSettings(extras.profileDir, {
      transport: 'headless',
      cdpPort: chatgptVisiblePort,
      headlessPort: chatgptHeadless.port,
    })
    chatgpt.state.lastTest = null
    log?.info?.(`my-model: ${result.message ?? 'headless Chromium ready'}${importedCookies ? ' (chatgpt.com cookies imported)' : ''}`)
    return { ok: true, headless: { ...result, importedCookies }, status: await status() }
  }

  /**
   * Switch how DeepSeek Web requests leave the machine:
   *  - `node`     — fetch from the host
   *  - `cdp`      — run the fetch inside a visible Chrome tab, with a Node fallback
   *  - `headless` — run the fetch inside the managed, always-on headless Chromium
   *                 (no Node fallback)
   * The choice is applied immediately and persisted per profile.
   */
  const setDeepseekTransport = async (req) => {
    const body = await readJson(req)
    const transport = body.transport
    if (transport !== 'node' && transport !== 'cdp' && transport !== 'headless') {
      throw new ApiError(400, 'transport must be "node", "cdp" or "headless".', 'BAD_TRANSPORT')
    }
    const client = adapter.client
    client.setTransport(transport)
    if (transport === 'headless') {
      client.cdpPort = headless?.port ?? options.deepseekHeadlessPort
      client.cdpHost = headless?.host ?? options.deepseekHeadlessHost
    } else if (transport === 'cdp') {
      client.cdpPort = deepseekVisiblePort
      client.cdpHost = deepseekVisibleHost
    }
    if (body.port !== undefined) {
      const port = Number(body.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ApiError(400, 'port must be an integer between 1 and 65535.', 'BAD_PORT')
      }
      if (transport === 'cdp') {
        deepseekVisiblePort = port
        client.cdpPort = port
      }
    }
    writeDeepseekSettings(extras.profileDir, {
      transport,
      cdpPort: deepseekVisiblePort,
      headlessPort: headless?.port ?? options.deepseekHeadlessPort,
    })
    state.lastTest = null
    return status()
  }

  /**
   * Start the local debug browser for DeepSeek and switch the transport. The
   * executable/profile come from plugin config; the request may only choose a
   * validated port.
   */
  const launchDeepseekChrome = async (req) => {
    const body = await readJson(req)
    const client = adapter.client
    const port = body.port === undefined ? Number(deepseekVisiblePort) : Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError(400, 'port must be an integer between 1 and 65535.', 'BAD_PORT')
    }
    let launch
    try {
      launch = await launchChrome({
        port,
        host: deepseekVisibleHost,
        configuredExecutable: options.chromePath || undefined,
        profileDir: options.chromeUserDataDir || undefined,
        url: `${options.baseURL}/`,
      })
    } catch (error) {
      if (error instanceof LaunchError) {
        log?.warn?.(`my-model: could not start local Chrome for DeepSeek (${error.code}): ${error.message}`)
        throw new ApiError(400, error.message, error.code)
      }
      throw error
    }
    // If the debug browser was already running (for example for ChatGPT), the
    // launcher does not open another window. Open/find the DeepSeek tab here so
    // the user has somewhere to sign in.
    try {
      const attached = await attachPage({ host: deepseekVisibleHost, port, origin: options.baseURL })
      attached.connection.close()
    } catch (error) {
      log?.warn?.(`my-model: Chrome started but no chat.deepseek.com tab could be opened: ${error.message}`)
    }
    deepseekVisiblePort = port
    client.setTransport('cdp')
    client.cdpPort = port
    client.cdpHost = deepseekVisibleHost
    writeDeepseekSettings(extras.profileDir, {
      transport: 'cdp',
      cdpPort: port,
      headlessPort: headless?.port ?? options.deepseekHeadlessPort,
    })
    state.lastTest = null
    log?.info?.(`my-model: ${launch.message}`)
    return { ok: true, launch, status: await status() }
  }

  /**
   * Start (or adopt) the always-on headless Chromium and switch DeepSeek to it.
   * Unlike the visible transport this one never falls back to Node.
   */
  const startDeepseekHeadless = async () => {
    if (!headless) throw new ApiError(409, 'The headless Chromium manager is unavailable.', 'NO_HEADLESS')
    let result
    try {
      result = await headless.ensure()
    } catch (error) {
      if (error instanceof HeadlessChromeError) {
        log?.warn?.(`my-model: headless Chromium failed (${error.code}): ${error.message}`)
        throw new ApiError(400, error.message, error.code)
      }
      throw error
    }
    const client = adapter.client
    client.setTransport('headless')
    client.cdpPort = headless.port
    client.cdpHost = headless.host
    writeDeepseekSettings(extras.profileDir, {
      transport: 'headless',
      cdpPort: deepseekVisiblePort,
      headlessPort: headless.port,
    })
    state.lastTest = null
    log?.info?.(`my-model: ${result.message ?? 'headless Chromium ready'}`)
    return { ok: true, headless: result, status: await status() }
  }

  const setDefault = async (req) => {
    const body = await readJson(req)
    const model = String(body.model ?? '')
    const provider = providerOfModel(model)
    if (!provider) {
      throw new ApiError(400, `Unknown model "${model}".`, 'UNKNOWN_MODEL')
    }
    const service = safeGet(ctx, 'agentDefaultModel')
    if (!service?.saveSelection) {
      throw new ApiError(409, 'The default-model service is unavailable in this profile.', 'NO_DEFAULT_MODEL')
    }
    await service.saveSelection({ provider, model })
    let current = null
    try {
      current = service.currentSelection()
    } catch {
      current = null
    }
    return {
      ok: true,
      defaultSelection: current,
      changed: current?.provider === provider && current?.model === model,
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
    if (chatgpt.adapter) applySharedFingerprint(chatgpt.adapter.client, effective)
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
      if (path === '/my-model/api/deepseek/transport' && req.method === 'POST') {
        json(res, 200, await setDeepseekTransport(req))
        return
      }
      if (path === '/my-model/api/deepseek/launch' && req.method === 'POST') {
        json(res, 200, await launchDeepseekChrome(req))
        return
      }
      if (path === '/my-model/api/deepseek/headless' && req.method === 'POST') {
        json(res, 200, await startDeepseekHeadless(req))
        return
      }
      if (path === '/my-model/api/chatgpt/status' && req.method === 'GET') {
        json(res, 200, await status())
        return
      }
      if (path === '/my-model/api/chatgpt/credentials' && req.method === 'POST') {
        json(res, 200, await saveChatgptCredentials(req))
        return
      }
      if (path === '/my-model/api/chatgpt/test' && req.method === 'POST') {
        json(res, 200, await testChatgpt(req))
        return
      }
      if (path === '/my-model/api/chatgpt/transport' && req.method === 'POST') {
        json(res, 200, await setChatgptTransport(req))
        return
      }
      if (path === '/my-model/api/chatgpt/headless' && req.method === 'POST') {
        json(res, 200, await startChatgptHeadless())
        return
      }
      if (path === '/my-model/api/chatgpt/launch' && req.method === 'POST') {
        json(res, 200, await launchChatgptChrome(req))
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
  const options = optionsOf({
    ...loaderConfig,
    ...startupOverrides,
    ...readChatgptSettings(profileDir),
    ...readDeepseekSettings(profileDir),
  })
  // A Chrome tab is a legitimate credential source: persist the token/cookies
  // it yields so a later Node fallback (even after a Harness restart) still
  // works when the browser is closed.
  const persistSecret = async (ref, value) => {
    const store = safeGet(ctx, 'credentials')
    if (!store?.set || typeof value !== 'string' || value.length === 0) return
    try {
      await store.set(ref, value)
    } catch {
      // A read-only credential store must not break a turn.
    }
  }
  // The built-in fingerprint is a snapshot and goes stale as the browser and
  // web client update. When no settings-page overrides exist, surface that the
  // defaults are in use instead of failing silently.
  if (Object.keys(startupOverrides).length === 0 && options.clientVersion === DEFAULTS.clientVersion) {
    logger?.warn?.(
      'my-model: using the built-in browser fingerprint. If your browser or the deployed web client changed, ' +
        'set userAgent, secChUa, secChUaPlatform and clientVersion in the settings page or plugin config.',
    )
  }
  // A separate, always-on Chromium for the Node-free DeepSeek transport. It has
  // its own profile and port so it can coexist with the visible debug browser.
  const headless = new ManagedChrome({
    host: options.deepseekHeadlessHost,
    port: options.deepseekHeadlessPort,
    executable: options.chromePath || undefined,
    profileDir: options.chromeHeadlessUserDataDir || undefined,
    url: `${options.baseURL}/`,
    logger,
  })
  const deepseekBrowserPort =
    options.deepseekTransport === 'headless' ? options.deepseekHeadlessPort : options.deepseekCdpPort
  const deepseekBrowserHost =
    options.deepseekTransport === 'headless' ? options.deepseekHeadlessHost : options.deepseekCdpHost
  const chatgptBrowserPort =
    options.chatgptTransport === 'headless' ? options.chatgptHeadlessPort : options.chatgptCdpPort
  const chatgptBrowserHost =
    options.chatgptTransport === 'headless' ? options.chatgptHeadlessHost : options.chatgptCdpHost
  // ChatGPT gets its own always-on Chromium: the headless profile holds a
  // chatgpt.com login, which must not be mixed with the DeepSeek profile.
  const chatgptHeadless = new ManagedChrome({
    host: options.chatgptHeadlessHost,
    port: options.chatgptHeadlessPort,
    executable: options.chromePath || undefined,
    profileDir:
      options.chatgptHeadlessUserDataDir ||
      `${options.chromeHeadlessUserDataDir || defaultHeadlessUserDataDir()}-chatgpt`,
    // Starting with the Chrome UA means the first navigation does not present
    // "HeadlessChrome" to Cloudflare; the per-page override is a second line of
    // defence for an already-running instance.
    userAgent: options.userAgent || CHATGPT_DEFAULT_UA,
    url: `${options.chatgptBaseURL}/`,
    logger,
  })
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
    transport: options.deepseekTransport,
    cdpPort: deepseekBrowserPort,
    cdpHost: deepseekBrowserHost,
    ensureHeadless: () => headless.ensure(),
    maxPromptChars: options.maxPromptChars,
    maxToolChars: options.maxToolChars,
    logger,
    resolveToken: () => resolveSecret(ctx, options.tokenEnv),
    resolveCookies: () => resolveSecret(ctx, options.cookiesEnv),
    persistToken: (token) => persistSecret(options.tokenEnv, token),
    persistCookies: (cookies) => persistSecret(options.cookiesEnv, cookies),
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

  const chatgptAdapter = new ChatGptWebAdapter({
    baseURL: options.chatgptBaseURL,
    timeoutMs: options.timeoutMs,
    modelSlug: options.chatgptModelSlug,
    transport: options.chatgptTransport,
    cdpPort: chatgptBrowserPort,
    cdpHost: chatgptBrowserHost,
    ensureHeadless: () => chatgptHeadless.ensure(),
    userAgent: options.userAgent,
    secChUa: options.secChUa,
    secChUaPlatform: options.secChUaPlatform,
    secChUaMobile: options.secChUaMobile,
    acceptLanguage: options.acceptLanguage,
    oaiLanguage: options.chatgptLanguage,
    maxPromptChars: options.maxPromptChars,
    maxToolChars: options.maxToolChars,
    logger,
    resolveToken: () => resolveSecret(ctx, options.chatgptTokenEnv),
    resolveCookies: () => resolveSecret(ctx, options.chatgptCookiesEnv),
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
  ctx.llm.registerAdapter([CHATGPT_PROVIDER], chatgptAdapter)

  // `webServer` is a sibling fiber that becomes active only after its listen()
  // resolves. Reading it through ctx.get() at apply time can therefore return
  // undefined and silently skip route registration, so wait for the service;
  // in headless profiles that never provide it this callback simply never runs.
  ctx.inject(['webServer'], (httpCtx) => {
    const state = { lastTest: null }
    const chatgptState = { lastTest: null }
    const handler = createApi(ctx, options, adapter, state, {
      loaderConfig,
      profileDir,
      logger,
      chatgpt: { adapter: chatgptAdapter, state: chatgptState },
      headless,
      chatgptHeadless,
    })
    for (const path of [
      '/my-model/api/status',
      '/my-model/api/credentials',
      '/my-model/api/test',
      '/my-model/api/default',
      '/my-model/api/fingerprint',
      '/my-model/api/deepseek/transport',
      '/my-model/api/deepseek/launch',
      '/my-model/api/deepseek/headless',
      '/my-model/api/chatgpt/status',
      '/my-model/api/chatgpt/credentials',
      '/my-model/api/chatgpt/test',
      '/my-model/api/chatgpt/transport',
      '/my-model/api/chatgpt/headless',
      '/my-model/api/chatgpt/launch',
    ]) {
      httpCtx.effect(() => httpCtx.webServer.register({ kind: 'exact', path, handler }))
    }
  })
}

export { MODELS, PROVIDER, PROVIDER_NAME, normalizeToken }
