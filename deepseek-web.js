/**
 * DeepSeek web-chat HTTP adapter.
 *
 * This is not the official DeepSeek API. It drives the same endpoints the
 * chat.deepseek.com browser uses (PoW challenge, chat-session creation, and
 * streaming completion), with the user's own web login token. It therefore
 * follows the web product's availability, quota, and terms.
 */
import { createHash } from 'node:crypto'
import { buildTranscriptPrompt, deltaPrompt, normalizeToken, parseDsmlToolCalls, StreamSieve } from './dsml.js'
import { solvePow } from './pow.js'

export { normalizeToken } from './dsml.js'

export const PROVIDER = 'deepseek-web'
export const PROVIDER_NAME = 'My Model · DeepSeek Web'
export const CHALLENGE_PATH = '/api/v0/chat/create_pow_challenge'
export const SESSION_PATH = '/api/v0/chat_session/create'
export const COMPLETION_PATH = '/api/v0/chat/completion'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

/**
 * Browser-fingerprint defaults, measured on this machine (Chrome 155 /
 * DeepSeek web client 2.5.0). They still go stale as the browser and web client
 * update — a profile that drifts from the live product is a strong upstream
 * risk-control signal. Override `userAgent`, `secChUa`, `secChUaPlatform`,
 * `clientVersion` (and the rest) from the settings page or plugin config. The
 * adapter logs a reminder while the built-in defaults are still in use.
 */
export const DEFAULT_SEC_CH_UA = '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"'
export const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"'
export const DEFAULT_SEC_CH_UA_MOBILE = '?0'
export const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9'
export const DEFAULT_SEC_FETCH_SITE = 'same-origin'
export const DEFAULT_SEC_FETCH_MODE = 'cors'
export const DEFAULT_SEC_FETCH_DEST = 'empty'
export const DEFAULT_PRIORITY = 'u=1, i'
export const DEFAULT_CLIENT_LOCALE = 'zh_CN'
export const DEFAULT_CLIENT_PLATFORM = 'web'
export const DEFAULT_CLIENT_BUNDLE_ID = 'com.deepseek.chat'

/** Keep in sync with the deployed web client; stale values invite risk control. */
export const DEFAULT_CLIENT_VERSION = '2.5.0'

const EFFORTS = [
  { id: 'off', name: 'Off', description: 'Answer without the web reasoning phase.' },
  { id: 'high', name: 'Thinking', description: 'Use the web model reasoning phase before answering.' },
]

export const MODELS = [
  {
    id: 'deepseek-web-chat',
    name: 'DeepSeek Web · Chat',
    description: 'DeepSeek web chat (quick answer). Uses your chat.deepseek.com account.',
    thinking: false,
    search: false,
    defaultEffort: 'off',
  },
  {
    id: 'deepseek-web-thinking',
    name: 'DeepSeek Web · Thinking',
    description: 'DeepSeek web expert mode with the reasoning phase enabled.',
    thinking: true,
    search: false,
    defaultEffort: 'high',
  },
  {
    id: 'deepseek-web-search',
    name: 'DeepSeek Web · Search',
    description: 'DeepSeek web expert mode with web search enabled.',
    thinking: true,
    search: true,
    defaultEffort: 'high',
  },
]

const MODEL_BY_ID = new Map(MODELS.map((model) => [model.id, model]))

/**
 * How long a cached web chat session stays reusable. The web product keeps
 * sessions for much longer; a long TTL means a continuing conversation sends
 * only its new tail instead of rebuilding a fresh session with the full
 * transcript (which costs an extra upstream request and more account quota).
 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * Transient failures worth retrying inside one turn without asking upstream.
 * `STALE_SESSION` is self-inflicted and cheap to heal: the retry drops the
 * cached chat session and starts a fresh one, which is exactly what a session
 * the server already dropped or expired needs.
 */
const INTERNAL_RETRY_CODES = new Set(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STALE_SESSION'])

/**
 * Adapter failure carrying the provider-neutral `code` the Harness routes on.
 *
 * `failure` mirrors the public shape `@deepseek-ai/dsh-llm` normalizes at the
 * adapter boundary. Without it a foreign Error class is classified as UNKNOWN,
 * so the host never applies its retry policy and never sees `Retry-After`.
 * Keep both properties in sync.
 */
export class AdapterError extends Error {
  constructor(message, code, status, options = {}) {
    const text = String(message || 'DeepSeek Web request failed')
    super(text)
    this.name = 'AdapterError'
    this.code = code
    if (status !== undefined) this.status = status
    const failure = { message: text, code }
    if (Number.isInteger(status) && status >= 100 && status <= 599) failure.status = status
    const retryAfterMs = Number(options.providerRetryAfterMs)
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      const delay = Math.min(Math.round(retryAfterMs), 24 * 60 * 60 * 1000)
      this.providerRetryAfterMs = delay
      failure.providerRetryAfterMs = delay
    }
    if (options.fromGate === true) this.fromGate = true
    this.failure = Object.freeze(failure)
  }
}

function retryable(error) {
  return error instanceof AdapterError && INTERNAL_RETRY_CODES.has(error.code)
}

function clampNumber(value, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}

export function retryAfterMsFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return undefined
  let raw
  try {
    raw = headers.get('retry-after')
  } catch {
    return undefined
  }
  if (!raw) return undefined
  const text = String(raw).trim()
  const seconds = Number(text)
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.round(seconds * 1000), 24 * 60 * 60 * 1000)
  const date = Date.parse(text)
  if (Number.isFinite(date)) {
    const delay = date - Date.now()
    if (delay > 0) return Math.min(delay, 24 * 60 * 60 * 1000)
  }
  return undefined
}

function isQuotaText(text) {
  return (
    /(?:quota|usage[\s_-]*limit)[\s_-]*(?:exceeded|exhausted|reached)/i.test(text) ||
    /(?:额度|配额)[^。；;]{0,16}(?:用完|耗尽|不足|已达|达到|上限)/.test(text) ||
    /(?:今日|当天|每日)[^。；;]{0,16}(?:次数|额度|配额)[^。；;]{0,10}(?:上限|用完|耗尽|已尽)/.test(text) ||
    /(?:次数|条数|对话数|消息数)[^。；;]{0,12}(?:已达|达到|超过|用完)[^。；;]{0,8}(?:上限|限制)/.test(text) ||
    /(?:免费|赠送)[^。；;]{0,12}(?:额度|次数)[^。；;]{0,10}(?:用完|耗尽|已尽)/.test(text)
  )
}

function isMutedText(text) {
  return /\b(?:mute[ds]?|ban(?:ned)?)\b|静音|封禁|禁言/i.test(text)
}

function isRateLimitText(text) {
  return /rate[\s_-]*limit|too[\s_-]+many[\s_-]+requests|throttl|频繁|频率|限流|请求过多|访问过快/i.test(text)
}

/**
 * The server refused a completion because the chat session this turn reused is
 * no longer usable (expired, deleted, or invalidated while the user was away or
 * busy in another model). Detectable as `UPSTREAM` today, which is not retried
 * anywhere — so one stale cache entry permanently killed the provider until the
 * adapter was reloaded.
 */
function isStaleSessionText(text) {
  const value = String(text ?? '')
  if (!value) return false
  return (
    /(会话|对话)[^\n。；;]{0,12}(不存在|已过期|已经过期|已删除|已失效|失效|无效|异常|不存在)/.test(value) ||
    /(不存在|找不到|无法找到|无效)[^\n。；;]{0,10}(会话|对话|chat[\s_-]?session)/.test(value) ||
    /chat[\s_-]?session[\s_-]?id?[^\n。；;]{0,16}(不存在|无效|错误|异常)/.test(value) ||
    /(?:chat[\s_-]?)?session[^\n]{0,12}(?:not found|not exist|invalid|expired|deleted|不存在)/i.test(value)
  )
}

function staleSessionError(detail, status) {
  const message = String(detail ?? '').slice(0, 300)
  return new AdapterError(
    `DeepSeek Web rejected the cached chat session (${message || 'no detail'}); starting a fresh session.`,
    'STALE_SESSION',
    status,
  )
}

/**
 * How long the host waits before its retry after a transient upstream failure.
 * The plugin's own in-turn retry uses its own backoff; this value only bounds
 * the host-level retry so it never comes back in a hot loop.
 */
const TRANSIENT_RETRY_AFTER_MS = 5000

function transientUpstreamError(detail, status) {
  return new AdapterError(
    `DeepSeek Web is temporarily unavailable: ${String(detail ?? '').slice(0, 300)}`,
    'SERVER',
    status,
    { providerRetryAfterMs: TRANSIENT_RETRY_AFTER_MS },
  )
}

/**
 * The upstream is having a transient moment: overloaded, briefly down, or the
 * classic "service is busy" toast. It arrives as an in-stream error frame (or a
 * JSON error body) with no HTTP status to key on, so it used to fall through to
 * terminal `UPSTREAM` and kill an otherwise healthy turn. One retry after a
 * short wait makes these succeed. Checked only after quota / mute / rate-limit
 * / stale-session classification, so it cannot swallow a terminal cause.
 */
function isTransientUpstreamText(text) {
  const value = String(text ?? '')
  if (!value) return false
  return (
    /服务器?\s*暂时\s*不可用|服务\s*繁忙|服务器\s*繁忙|系统\s*繁忙|系统开小差|暂时无法(?:处理|完成|使用)|请稍后|稍后(?:再试|重试)|访问人数过多|系统(?:错误|异常)/.test(value) ||
    /temporarily\s+unavailable|service\s+(?:is\s+)?(?:unavailable|busy)|server\s+(?:is\s+)?busy|internal\s+server\s+error|overloaded|try\s+again\s+later|please\s+try\s+again/i.test(
      value,
    )
  )
}

/**
 * Some WAFs return a challenge page with HTTP 200 and `text/html` instead of a
 * 4xx. Detect that so it surfaces as `WAF_CHALLENGE` (with the "paste cookies"
 * hint) rather than a generic `UPSTREAM` failure.
 */
function isChallengeBody(text, response) {
  let type = ''
  let server = ''
  try {
    type = String(response.headers.get('content-type') ?? '').toLowerCase()
    server = String(response.headers.get('server') ?? '').toLowerCase()
  } catch {
    type = ''
    server = ''
  }
  const body = String(text ?? '')
  const challenge =
    /captcha|challenge|verify|human|robot|awswaf|cf-|hwwaf|hw-waf|slide|滑块|人机验证|验证码|请完成验证|安全验证|安全检测/i.test(
      body,
    )
  if (!challenge) return false
  // Huawei Cloud WAF (Server: CW, HWWAF* cookies) can serve its challenge as
  // HTML; accept a Huawei hint even when the content type is not text/html.
  if (server === 'cw' || /hwwaf|hw-waf|huawei\s*waf|cloud\s*waf/i.test(body)) return true
  return type.includes('text/html')
}

/**
 * Serializes upstream chat turns for one account and enforces a cooldown after
 * a rate limit. The web product throttles per account, so parallel Harness
 * consumers (main turn, title generation, subagents) are the common source of
 * a burst; one turn at a time plus a small gap avoids most 429s.
 *
 * `acquire()` returns an idempotent release function. A cooldown longer than
 * `maxAutoWaitMs` fails fast with a retry hint instead of blocking the UI.
 */
export class TurnScheduler {
  constructor({
    maxConcurrentTurns = 1,
    minTurnGapMs = 3000,
    maxAutoWaitMs = 20000,
    cooldownBaseMs = 15000,
    maxCooldownMs = 120000,
    minCooldownMs = 1000,
    jitterRatio = 0.2,
    humanizePacing = true,
    turnGapJitter = 0.6,
    humanLongPauseChance = 0.25,
    humanLongPauseMinMs = 5000,
    humanLongPauseMaxMs = 20000,
    random = Math.random,
    // Provider name used in log lines and abort messages, so a second web
    // provider (ChatGPT Web) reports its own name instead of DeepSeek's.
    label = 'DeepSeek Web',
    logger,
  } = {}) {
    this.label = String(label || 'DeepSeek Web')
    this.maxConcurrent = Math.round(clampNumber(maxConcurrentTurns, 1, 8))
    this.minGapMs = clampNumber(minTurnGapMs, 0, 60000)
    this.maxAutoWaitMs = clampNumber(maxAutoWaitMs, 0, 180000)
    this.cooldownBaseMs = clampNumber(cooldownBaseMs, 250, 300000)
    this.minCooldownMs = clampNumber(minCooldownMs, 0, this.cooldownBaseMs)
    this.maxCooldownMs = Math.max(this.cooldownBaseMs, clampNumber(maxCooldownMs, this.cooldownBaseMs, 600000))
    this.jitterRatio = clampNumber(jitterRatio, 0, 1)
    // Human-like pacing (方案A). Jitter the inter-turn gap and insert the odd
    // longer idle so the cadence resembles a person rather than a fixed-rate
    // machine loop. The slot is held during the idle, so concurrency limits
    // still hold.
    this.humanizePacing = humanizePacing !== false
    this.turnGapJitter = clampNumber(turnGapJitter, 0, 2)
    this.humanLongPauseChance = clampNumber(humanLongPauseChance, 0, 1)
    this.humanLongPauseMinMs = clampNumber(humanLongPauseMinMs, 0, 60000)
    this.humanLongPauseMaxMs = Math.max(
      this.humanLongPauseMinMs,
      clampNumber(humanLongPauseMaxMs, this.humanLongPauseMinMs, 120000),
    )
    this.random = random
    this.logger = logger
    this.active = 0
    this.lastStartAt = 0
    this.cooldownUntil = 0
    this.streak = 0
    this.waiters = new Set()
  }

  get cooldownRemainingMs() {
    return Math.max(0, this.cooldownUntil - Date.now())
  }

  /** Wait for a free slot, the inter-turn gap, and any active cooldown. */
  async acquire(signal) {
    while (true) {
      if (signal?.aborted) throw new AdapterError(`${this.label} request aborted`, 'ABORTED')
      const now = Date.now()
      const remaining = this.cooldownUntil - now
      if (remaining > this.maxAutoWaitMs) {
        throw new AdapterError(
          `${this.label} is rate limiting this account; retry in ${Math.ceil(remaining / 1000)}s.`,
          'RATE_LIMIT',
          undefined,
          { providerRetryAfterMs: remaining, fromGate: true },
        )
      }
      // One-sided jitter: never start a turn faster than minGapMs (a shorter gap
      // would increase burst risk), only add a random delay on top of it.
      const gap = this.humanizePacing
        ? this.minGapMs * (1 + this.random() * this.turnGapJitter)
        : this.minGapMs
      const startAt = Math.max(this.lastStartAt + gap, this.cooldownUntil)
      if (this.active < this.maxConcurrent && now >= startAt) {
        this.active += 1
        this.lastStartAt = now
        // Occasionally hold the slot for a longer idle before the turn starts
        // so the request cadence looks less like a fixed-rate loop. Only applied
        // when a slot is actually being granted, never during a rate-limit
        // cooldown, and the slot stays held so concurrency is still respected.
        if (this.humanizePacing && this.random() < this.humanLongPauseChance) {
          const pause =
            this.humanLongPauseMinMs +
            this.random() * Math.max(0, this.humanLongPauseMaxMs - this.humanLongPauseMinMs)
          this.logger?.debug?.(`my-model: pacing pause ${Math.round(pause / 1000)}s before next turn`)
          await this.wait(pause, signal)
        }
        let released = false
        return () => {
          if (released) return
          released = true
          this.active -= 1
          this.wake()
        }
      }
      // A slot release wakes this wait immediately. When the block is purely
      // concurrency (startAt already passed), use a long safety timer instead
      // of a short one so a minutes-long stream does not busy-poll.
      const waitMs = this.active >= this.maxConcurrent ? 60000 : Math.max(10, startAt - now)
      await this.wait(waitMs, signal)
    }
  }

  /**
   * Record one upstream rate limit and return the cooldown delay applied.
   * `Retry-After` wins when present; otherwise the delay doubles per
   * consecutive failure, with symmetric jitter and a hard cap.
   */
  noteRateLimit(retryAfterMs) {
    const upstream = Number(retryAfterMs)
    const hasUpstream = Number.isFinite(upstream) && upstream > 0
    let delay = hasUpstream
      ? Math.max(this.minCooldownMs, upstream)
      : this.cooldownBaseMs * 2 ** Math.min(this.streak, 8)
    if (!hasUpstream) {
      delay *= 1 - this.jitterRatio + 2 * this.jitterRatio * this.random()
    }
    delay = Math.min(Math.max(this.minCooldownMs, delay), this.maxCooldownMs)
    this.streak += 1
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay)
    this.logger?.warn?.(
      `my-model: ${this.label} rate limited; cooling down for ${Math.ceil(delay / 1000)}s (attempt ${this.streak})`,
    )
    this.wake()
    return this.cooldownRemainingMs
  }

  /** A successful completion clears the exponential cooldown. */
  noteSuccess() {
    this.streak = 0
    this.cooldownUntil = 0
    this.wake()
  }

  wake() {
    for (const wake of [...this.waiters]) wake()
  }

  wait(ms, signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (error) => {
        if (settled) return
        settled = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const wake = () => finish()
      const onAbort = () => finish(new AdapterError(`${this.label} request aborted`, 'ABORTED'))
      const timer = setTimeout(wake, Math.max(1, ms))
      this.waiters.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

export function abortableSleep(ms, signal, label = 'DeepSeek Web') {
  if (!(ms > 0)) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new AdapterError(`${label} request aborted`, 'ABORTED'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AdapterError(`${label} request aborted`, 'ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function rateLimitWithDelay(error, delayMs) {
  if (!(error instanceof AdapterError)) return error
  const retryAfterMs = error.providerRetryAfterMs ?? delayMs
  if (!(Number(retryAfterMs) > 0)) return error
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  const message = /retry in \d+s/i.test(error.message) ? error.message : `${error.message} Retry in ${seconds}s.`
  return new AdapterError(message, 'RATE_LIMIT', error.status, { providerRetryAfterMs: retryAfterMs })
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

export class CookieJar {
  constructor(seed = '') {
    this.values = new Map()
    this.seed(seed)
  }

  seed(text) {
    if (!text) return
    for (const part of String(text).split(';')) {
      const piece = part.trim()
      if (!piece || !piece.includes('=')) continue
      const index = piece.indexOf('=')
      const name = piece.slice(0, index).trim()
      const value = piece.slice(index + 1).trim()
      if (name) this.values.set(name, value)
    }
  }

  absorb(response) {
    let lines = []
    try {
      if (typeof response.headers.getSetCookie === 'function') lines = response.headers.getSetCookie()
      else {
        const raw = response.headers.get('set-cookie')
        if (raw) lines = [raw]
      }
    } catch {
      return
    }
    for (const line of lines) {
      const [pair] = String(line).split(';')
      if (!pair || !pair.includes('=')) continue
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (name) this.values.set(name, value)
    }
  }

  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  clear() {
    this.values.clear()
  }
}

/**
 * Minimal client for the web chat endpoints. One instance is shared by the
 * adapter so the PoW module and response cookies stay warm.
 */
export class DeepSeekWebClient {
  constructor({
    baseURL = 'https://chat.deepseek.com',
    timeoutMs = 300000,
    clientVersion,
    userAgent,
    secChUa,
    secChUaPlatform,
    secChUaMobile,
    acceptLanguage,
    secFetchSite,
    secFetchMode,
    secFetchDest,
    priority,
    referer,
    clientLocale,
    clientPlatform,
    clientBundleId,
    token,
    cookies,
    resolveToken,
    resolveCookies,
    logger,
  } = {}) {
    this.baseURL = String(baseURL || 'https://chat.deepseek.com').replace(/\/+$/, '')
    this.timeoutMs = Math.max(15000, Number(timeoutMs) || 300000)
    this.clientVersion =
      typeof clientVersion === 'string' && clientVersion.trim() ? clientVersion.trim() : DEFAULT_CLIENT_VERSION
    // Browser-fingerprint fields. Kept configurable so the request profile can
    // be matched to the browser that issued the login token; a profile that
    // drifts from the live web client invites upstream risk control.
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : DEFAULT_UA
    this.secChUa = typeof secChUa === 'string' && secChUa.trim() ? secChUa.trim() : DEFAULT_SEC_CH_UA
    this.secChUaPlatform =
      typeof secChUaPlatform === 'string' && secChUaPlatform.trim()
        ? secChUaPlatform.trim()
        : DEFAULT_SEC_CH_UA_PLATFORM
    this.secChUaMobile =
      typeof secChUaMobile === 'string' && secChUaMobile.trim() ? secChUaMobile.trim() : DEFAULT_SEC_CH_UA_MOBILE
    this.acceptLanguage =
      typeof acceptLanguage === 'string' && acceptLanguage.trim()
        ? acceptLanguage.trim()
        : DEFAULT_ACCEPT_LANGUAGE
    // Browser fetch-metadata / priority headers, captured from a real
    // same-origin fetch on chat.deepseek.com. Configurable for future changes.
    this.secFetchSite =
      typeof secFetchSite === 'string' && secFetchSite.trim() ? secFetchSite.trim() : DEFAULT_SEC_FETCH_SITE
    this.secFetchMode =
      typeof secFetchMode === 'string' && secFetchMode.trim() ? secFetchMode.trim() : DEFAULT_SEC_FETCH_MODE
    this.secFetchDest =
      typeof secFetchDest === 'string' && secFetchDest.trim() ? secFetchDest.trim() : DEFAULT_SEC_FETCH_DEST
    this.priority = typeof priority === 'string' && priority.trim() ? priority.trim() : DEFAULT_PRIORITY
    this.referer = typeof referer === 'string' && referer.trim() ? referer.trim() : `${this.baseURL}/a/chat/`
    this.clientLocale =
      typeof clientLocale === 'string' && clientLocale.trim() ? clientLocale.trim() : DEFAULT_CLIENT_LOCALE
    this.clientPlatform =
      typeof clientPlatform === 'string' && clientPlatform.trim() ? clientPlatform.trim() : DEFAULT_CLIENT_PLATFORM
    this.clientBundleId =
      typeof clientBundleId === 'string' && clientBundleId.trim() ? clientBundleId.trim() : DEFAULT_CLIENT_BUNDLE_ID
    this.token = token
    this.cookies = cookies
    this.resolveToken = resolveToken
    this.resolveCookies = resolveCookies
    this.logger = logger
    this.jar = new CookieJar()
    this.lastToken = undefined
    this.lastCookies = undefined
    // Undefined probes the cheap path first; true/false remembers what the
    // upstream actually required, so a probe failure costs one request once.
    this.sessionPoW = undefined
  }

  async currentToken() {
    const value = this.token !== undefined ? this.token : await this.resolveToken?.()
    const normalized = normalizeToken(value)
    if (!normalized) {
      throw new AdapterError(
        'No DeepSeek web token is configured. Open Settings → My Model and paste your chat.deepseek.com userToken.',
        'MISSING_CREDENTIAL',
      )
    }
    return normalized
  }

  async currentCookies() {
    return this.cookies !== undefined ? this.cookies : (await this.resolveCookies?.()) ?? ''
  }

  async prepareAuth() {
    const token = await this.currentToken()
    const cookies = String((await this.currentCookies()) ?? '')
    if (token !== this.lastToken) {
      this.jar.clear()
      this.jar.seed(cookies)
      this.lastToken = token
      this.lastCookies = cookies
    } else if (cookies !== this.lastCookies) {
      this.jar.seed(cookies)
      this.lastCookies = cookies
    }
    return token
  }

  baseHeaders(token, accept) {
    const timezoneOffset = String(-new Date().getTimezoneOffset() * 60)
    const headers = {
      accept: accept ?? 'application/json',
      'accept-language': this.acceptLanguage,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: this.baseURL,
      referer: this.referer,
      'sec-fetch-site': this.secFetchSite,
      'sec-fetch-mode': this.secFetchMode,
      'sec-fetch-dest': this.secFetchDest,
      priority: this.priority,
      'user-agent': this.userAgent,
      'x-client-version': this.clientVersion,
      'x-client-platform': this.clientPlatform,
      'x-client-locale': this.clientLocale,
      'x-client-timezone-offset': timezoneOffset,
      'x-client-bundle-id': this.clientBundleId,
      'sec-ch-ua': this.secChUa,
      'sec-ch-ua-mobile': this.secChUaMobile,
      'sec-ch-ua-platform': this.secChUaPlatform,
    }
    const cookie = this.jar.header()
    if (cookie) headers.cookie = cookie
    return headers
  }

  async request(path, body, { signal, accept, headers: extraHeaders, method = 'POST' } = {}) {
    const token = await this.prepareAuth()
    const headers = { ...this.baseHeaders(token, accept), ...(extraHeaders ?? {}) }
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response
    try {
      response = await fetch(`${this.baseURL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        redirect: 'follow',
      })
    } catch (error) {
      if (signal?.aborted) throw new AdapterError('DeepSeek Web request aborted', 'ABORTED')
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new AdapterError('DeepSeek Web request timed out', 'TIMEOUT')
      }
      throw new AdapterError(`DeepSeek Web transport failed: ${error?.message ?? String(error)}`, 'TRANSPORT')
    }
    this.jar.absorb(response)
    return response
  }

  async readJson(response) {
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw new AdapterError(`DeepSeek Web response could not be read: ${error?.message ?? String(error)}`, 'TRANSPORT')
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      const status = response.status
      if (isChallengeBody(text, response)) {
        throw new AdapterError(
          'DeepSeek Web returned a human-verification challenge. Open chat.deepseek.com in your browser, complete the challenge, then paste the site cookies into Settings → My Model → Cookie.',
          'WAF_CHALLENGE',
          status,
        )
      }
      const code =
        status === 429
          ? 'RATE_LIMIT'
          : status === 401 || status === 403
            ? 'INVALID_CREDENTIAL'
            : status >= 500
              ? 'SERVER'
              : 'UPSTREAM'
      throw new AdapterError(
        `DeepSeek Web returned a non-JSON response (HTTP ${status}): ${text.slice(0, 240)}`,
        code,
        status,
        { providerRetryAfterMs: retryAfterMsFromHeaders(response.headers) },
      )
    }
    if (json && typeof json.code === 'number' && json.code !== 0) {
      throw this.codeError(json, response.status, response.headers)
    }
    return json
  }

  codeError(json, status, headers) {
    const code = json?.code
    const message = String(json?.msg ?? json?.message ?? json?.data?.biz_msg ?? 'DeepSeek Web rejected the request')
    const bizCode = json?.data?.biz_code
    if (code === 429 || isRateLimitText(message)) {
      return new AdapterError(
        `DeepSeek Web rate limit: ${message}`,
        'RATE_LIMIT',
        status,
        { providerRetryAfterMs: retryAfterMsFromHeaders(headers) },
      )
    }
    if (isQuotaText(message)) {
      return new AdapterError(`DeepSeek Web quota is exhausted: ${message}`, 'QUOTA', status)
    }
    if (bizCode === 5 || isMutedText(message)) {
      return new AdapterError(`DeepSeek Web account is muted: ${message}`, 'ACCOUNT_MUTED', status)
    }
    if (code === 40003 || code === 40001 || status === 401 || status === 403) {
      return new AdapterError(
        `DeepSeek Web rejected the token (${message}). Log in to chat.deepseek.com again and paste a fresh userToken. If the web account was muted, the rejection persists until the mute lifts — re-login alone will not fix that.`,
        'INVALID_CREDENTIAL',
        status,
      )
    }
    if (isStaleSessionText(message)) return staleSessionError(message, status)
    if (isTransientUpstreamText(message)) return transientUpstreamError(message, status)
    return new AdapterError(`DeepSeek Web error ${code ?? ''}: ${message}`, 'UPSTREAM', status)
  }

  httpError(response, body) {
    const wafAction = String(response.headers.get('x-amzn-waf-action') ?? '').toLowerCase()
    const cfMitigated = String(response.headers.get('cf-mitigated') ?? '').toLowerCase()
    if (
      wafAction === 'captcha' ||
      wafAction === 'challenge' ||
      cfMitigated === 'challenge' ||
      isChallengeBody(body, response)
    ) {
      return new AdapterError(
        'DeepSeek Web returned a human-verification challenge. Open chat.deepseek.com in your browser, complete the challenge, then paste the site cookies into Settings → My Model → Cookie.',
        'WAF_CHALLENGE',
        response.status,
      )
    }
    const status = response.status
    const detail = String(body ?? '').slice(0, 300)
    const retryAfterMs = retryAfterMsFromHeaders(response.headers)
    if (status === 429) {
      return new AdapterError(
        `DeepSeek Web rate limited this account (HTTP 429). ${detail}`,
        'RATE_LIMIT',
        status,
        { providerRetryAfterMs: retryAfterMs },
      )
    }
    if (isQuotaText(detail)) {
      return new AdapterError(`DeepSeek Web quota is exhausted. ${detail}`, 'QUOTA', status)
    }
    if (isMutedText(detail)) {
      return new AdapterError(`DeepSeek Web account is muted. ${detail}`, 'ACCOUNT_MUTED', status)
    }
    if (isRateLimitText(detail)) {
      return new AdapterError(
        `DeepSeek Web rate limited this account (HTTP ${status}). ${detail}`,
        'RATE_LIMIT',
        status,
        { providerRetryAfterMs: retryAfterMs },
      )
    }
    if (status === 401 || status === 403) {
      return new AdapterError(
        `DeepSeek Web rejected the token (HTTP ${status}). Log in again and paste a fresh userToken. If the web account was muted, the rejection persists until the mute lifts — re-login alone will not fix that. ${detail}`,
        'INVALID_CREDENTIAL',
        status,
      )
    }
    if (isStaleSessionText(detail)) return staleSessionError(detail, status)
    if (status >= 500) return new AdapterError(`DeepSeek Web server error (HTTP ${status}). ${detail}`, 'SERVER', status)
    if (isTransientUpstreamText(detail)) return transientUpstreamError(detail, status)
    return new AdapterError(`DeepSeek Web request failed (HTTP ${status}). ${detail}`, 'UPSTREAM', status)
  }

  async challenge(targetPath) {
    const response = await this.request(CHALLENGE_PATH, { target_path: targetPath }, { accept: 'application/json' })
    if (!response.ok) throw this.httpError(response, await response.text().catch(() => ''))
    const json = await this.readJson(response)
    const challenge = json?.data?.biz_data?.challenge
    if (!challenge || typeof challenge !== 'object') {
      throw new AdapterError('DeepSeek Web returned an empty PoW challenge', 'UPSTREAM', response.status)
    }
    return challenge
  }

  async powHeader(targetPath = COMPLETION_PATH) {
    const challenge = await this.challenge(targetPath)
    const payload = await solvePow(challenge, targetPath)
    return Buffer.from(JSON.stringify(payload)).toString('base64')
  }

  /**
   * Create one web chat session.
   *
   * The deployed clients create a session with a bare `{}` request; the PoW
   * challenge is only bound to the completion call. An older deployment may
   * still require the `x-ds-pow-response` header here, so the first cheap
   * attempt falls back once and the result is remembered for the process.
   * This removes one upstream request from every new conversation.
   */
  async createSession() {
    if (this.sessionPoW === true) {
      return this.finishSessionCreate(await this.requestSessionWithPow())
    }

    const response = await this.request(SESSION_PATH, {}, { accept: 'application/json' })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      if (response.status !== 400 && response.status !== 403 && response.status !== 422) {
        throw this.httpError(response, detail)
      }
      this.sessionPoW = true
    } else {
      try {
        const id = await this.finishSessionCreate(response)
        this.sessionPoW = false
        return id
      } catch (error) {
        // A 200 envelope can still say the bare request was malformed; fall
        // back to the PoW path once instead of failing the whole turn.
        if (!(error instanceof AdapterError) || error.code !== 'UPSTREAM') throw error
        this.sessionPoW = true
        this.logger?.warn?.('my-model: bare chat session create was rejected; switching to the PoW path')
      }
    }

    return this.finishSessionCreate(await this.requestSessionWithPow())
  }

  async finishSessionCreate(response) {
    if (!response.ok) throw this.httpError(response, await response.text().catch(() => ''))
    const json = await this.readJson(response)
    const biz = json?.data?.biz_data
    const id = biz?.id ?? biz?.chat_session?.id
    if (!id) throw new AdapterError('DeepSeek Web did not return a chat session id', 'UPSTREAM', response.status)
    return String(id)
  }

  async requestSessionWithPow() {
    const pow = await this.powHeader(COMPLETION_PATH)
    return this.request(
      SESSION_PATH,
      { target_path: COMPLETION_PATH },
      { accept: 'application/json', headers: { 'x-ds-pow-response': pow } },
    )
  }

  /**
   * Validate the token and PoW machinery without creating a visible chat.
   * @returns {Promise<{latencyMs:number, algorithm:string}>}
   */
  async testAuth() {
    const started = Date.now()
    const challenge = await this.challenge(COMPLETION_PATH)
    const payload = await solvePow(challenge, COMPLETION_PATH)
    return { latencyMs: Date.now() - started, algorithm: payload.algorithm }
  }

  async *readSse(response, signal, state = {}) {
    if (!response.body) throw new AdapterError('DeepSeek Web returned no response body', 'UPSTREAM', response.status)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = 'message'
    try {
      while (true) {
        if (signal?.aborted) throw new AdapterError('DeepSeek Web request aborted', 'ABORTED')
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line === '') {
            event = 'message'
            continue
          }
          if (line.startsWith('event:')) {
            event = line.slice(6).trim()
            continue
          }
          if (line.startsWith('data:')) {
            const dataText = line.slice(5).trim()
            if (!dataText) continue
            let data
            try {
              data = JSON.parse(dataText)
            } catch {
              continue
            }
            yield* this.decodeData(data, event, state)
            event = 'message'
            continue
          }
          let data
          try {
            data = JSON.parse(line)
          } catch {
            // SSE comments / keep-alives are ignored.
            continue
          }
          yield* this.decodeData(data, event, state)
          event = 'message'
        }
      }
      // Flush any trailing multi-byte sequence before handling the last frame.
      buffer += decoder.decode()
      if (buffer.trim()) {
        let data
        try {
          data = JSON.parse(buffer.trim())
        } catch {
          // Ignore a truncated trailing frame.
          data = undefined
        }
        if (data !== undefined) yield* this.decodeData(data, event, state)
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // The stream may already be closed.
      }
    }
  }

  *decodeData(data, event, state = {}) {
    // Record the frame shape (capped) so a turn that ends with no tool call
    // and no usable answer can be root-caused from the plugin log instead of
    // a screenshot. Nothing is logged unless the turn looks suspicious.
    if (Array.isArray(state.rawFrames) && state.rawFrames.length < 40 && data && typeof data === 'object') {
      state.rawFrames.push(JSON.stringify(data).slice(0, 200))
    }
    if (!data || typeof data !== 'object') return
    if (typeof data.code === 'number' && data.code !== 0) throw this.codeError(data)
    const bizCode = data.data?.biz_code
    if (bizCode === 5) throw this.codeError(data)
    if (data.type === 'error' || data.v?.type === 'error') {
      const detail = String(data.content ?? data.msg ?? data.v?.content ?? data.v?.msg ?? 'unknown error')
      if (isQuotaText(detail)) throw new AdapterError(`DeepSeek Web quota is exhausted: ${detail}`, 'QUOTA')
      if (isMutedText(detail)) throw new AdapterError(`DeepSeek Web account is muted: ${detail}`, 'ACCOUNT_MUTED')
      if (isRateLimitText(detail)) throw new AdapterError(`DeepSeek Web rate limit: ${detail}`, 'RATE_LIMIT')
      if (isStaleSessionText(detail)) throw staleSessionError(detail)
      if (isTransientUpstreamText(detail)) throw transientUpstreamError(detail)
      throw new AdapterError(`DeepSeek Web upstream error: ${detail}`, 'UPSTREAM')
    }
    if (event === 'toast' || event === 'hint') {
      const detail = data.content ?? data.msg ?? data.v?.content ?? data.v?.msg
      const reason = data.finish_reason ?? data.v?.finish_reason
      if (detail || reason) {
        const message = String(detail ?? reason)
        if (isQuotaText(message)) throw new AdapterError(`DeepSeek Web quota is exhausted: ${message}`, 'QUOTA')
        if (isMutedText(message)) throw new AdapterError(`DeepSeek Web account is muted: ${message}`, 'ACCOUNT_MUTED')
        if (String(reason) === 'rate_limit_reached' || isRateLimitText(message)) {
          throw new AdapterError(`DeepSeek Web rate limit: ${message}`, 'RATE_LIMIT')
        }
        if (isStaleSessionText(message)) throw staleSessionError(message)
        if (isTransientUpstreamText(message)) throw transientUpstreamError(message)
        throw new AdapterError(`DeepSeek Web rejected the message: ${message}`, 'UPSTREAM')
      }
    }
    if (typeof data.response_message_id === 'number') {
      yield { type: 'ready', id: data.response_message_id }
      return
    }
    const v = data.v
    if (v && typeof v === 'object' && v.response) {
      const response = v.response
      if (typeof response.message_id === 'number') yield { type: 'ready', id: response.message_id }
      const fragments = Array.isArray(response.fragments) ? response.fragments : []
      if (fragments.length > 0) {
        for (const fragment of fragments) {
          const thinking = fragment?.type === 'THINK'
          const text = fragment?.content
          if (typeof text === 'string' && text) yield { type: thinking ? 'reasoning' : 'text', text }
        }
        const last = fragments[fragments.length - 1]
        state.fragmentType = last?.type === 'THINK' ? 'reasoning' : 'text'
      } else if (typeof response.content === 'string' && response.content) {
        state.fragmentType = 'text'
        yield { type: 'text', text: response.content }
      }
      return
    }
    const p = typeof data.p === 'string' ? data.p : ''
    const o = typeof data.o === 'string' ? data.o : ''
    if (p === 'response/fragments' && o === 'APPEND') {
      if (Array.isArray(v) && v[0]) state.fragmentType = v[0].type === 'THINK' ? 'reasoning' : 'text'
      return
    }
    if (p === 'response/fragments/-1/content' && (o === 'APPEND' || o === '')) {
      if (typeof v === 'string' && v) yield { type: state.fragmentType === 'reasoning' ? 'reasoning' : 'text', text: v }
      return
    }
    if (p === 'response/status') {
      yield { type: 'status', status: String(v ?? '') }
      return
    }
    if (p === 'response/content' && o === 'APPEND') {
      state.fragmentType = 'text'
      if (typeof v === 'string' && v) yield { type: 'text', text: v }
      return
    }
    if ('v' in data && !('p' in data) && !('o' in data)) {
      if (typeof v === 'string' && v) yield { type: state.fragmentType === 'reasoning' ? 'reasoning' : 'text', text: v }
    }
  }

  /**
   * Send one completion request, re-solving the PoW challenge once if the
   * upstream rejects it. A challenge can expire between fetch and use on a slow
   * connection; one retry turns that into a success instead of a failed turn.
   */
  async completionRequest(body, signal) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pow = await this.powHeader(COMPLETION_PATH)
      const response = await this.request(COMPLETION_PATH, body, {
        accept: 'text/event-stream',
        signal,
        headers: { 'x-ds-pow-response': pow },
      })
      if (response.ok) return response
      const detail = await response.text().catch(() => '')
      if (attempt === 0 && this.isPowError(response, detail)) {
        this.logger?.warn?.('my-model: PoW challenge rejected; solving a fresh one and retrying')
        continue
      }
      throw this.httpError(response, detail)
    }
    throw new AdapterError('DeepSeek Web PoW retry exhausted', 'UPSTREAM')
  }

  isPowError(response, detail) {
    if (![400, 403, 422].includes(response.status)) return false
    return /pow|challenge|signature|verif|expir/i.test(String(detail))
  }

  /**
   * Stream one completion as text/reasoning/tool-call chunks in the Harness
   * `StreamChunk` protocol.
   * @param {object} input
   * @param {string} input.sessionId - DeepSeek web chat session id.
   * @param {number|null} input.parentMessageId - previous upstream message id.
   * @param {string} input.prompt - the prompt text for this turn.
   * @param {boolean} input.thinking - enable expert/thinking mode.
   * @param {boolean} input.search - enable web search.
   * @param {AbortSignal} [input.signal]
   * @param {{responseMessageId?: number|null}} input.state
   */
  async *completionStream({ sessionId, parentMessageId, prompt, thinking, search, signal, state }) {
    state ??= {}
    // Per-stream fragment-type state. Kept local so two overlapping streams
    // cannot corrupt each other's reasoning/text classification. `rawFrames`
    // is a capped diagnostic ring for the plugin log.
    const streamState = { rawFrames: [] }
    const body = {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId ?? null,
      model_type: thinking ? 'expert' : 'default',
      prompt,
      ref_file_ids: [],
      stream: true,
      thinking_enabled: Boolean(thinking),
      search_enabled: Boolean(search),
      preempt: false,
    }
    const response = await this.completionRequest(body, signal)

    // A WAF can answer a 200 with an HTML challenge instead of an SSE stream;
    // surface that as WAF_CHALLENGE rather than an empty-completion failure.
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.includes('text/event-stream')) {
      const detail = await response.text().catch(() => '')
      if (isChallengeBody(detail, response)) {
        throw new AdapterError(
          'DeepSeek Web returned a human-verification challenge. Open chat.deepseek.com in your browser, complete the challenge, then paste the site cookies into Settings → My Model → Cookie.',
          'WAF_CHALLENGE',
          response.status,
        )
      }
      throw new AdapterError(
        `DeepSeek Web returned ${contentType || 'an unknown content type'} instead of an event stream: ${detail.slice(0, 200)}`,
        'UPSTREAM',
        response.status,
      )
    }

    let reasoningOpen = false
    let textOpen = false
    let reasoning = ''
    let text = ''
    const sieve = new StreamSieve()
    const toolCalls = []

    const emitText = async function* (value) {
      if (!value) return
      text += value
      if (!textOpen) {
        textOpen = true
        yield { type: 'block-start', index: 1, blockType: 'text' }
      }
      yield { type: 'text-delta', index: 1, text: value }
    }

    try {
      for await (const event of this.readSse(response, signal, streamState)) {
        if (event.type === 'ready') {
          state.responseMessageId = event.id
          continue
        }
        if (event.type === 'status') {
          if (event.status === 'FINISHED') break
          continue
        }
        if (event.type === 'reasoning' && event.text) {
          reasoning += event.text
          if (!reasoningOpen) {
            reasoningOpen = true
            yield { type: 'block-start', index: 0, blockType: 'reasoning' }
          }
          yield { type: 'reasoning-delta', index: 0, text: event.text }
          continue
        }
        if (event.type === 'text' && event.text) {
          for (const item of sieve.feed(event.text)) {
            if (item.type === 'text') {
              yield* emitText(item.text)
            } else if (item.type === 'tools') {
              toolCalls.push(...item.calls)
            }
          }
          if (toolCalls.length > 0) break
        }
      }
      // Always drain the sieve, even after a FINISHED status: the status can
      // break the read loop while a DSML block is still mid-capture, and
      // dropping it would silently truncate the answer or lose a tool call
      // that sits at the very end of the turn.
      for (const item of sieve.flush()) {
        if (item.type === 'text') yield* emitText(item.text)
        else if (item.type === 'tools') toolCalls.push(...item.calls)
      }

      // A thinking-mode stream can end with the whole turn routed into the
      // reasoning channel and an empty answer — the fragment-type switch was
      // missed, or the model drafted everything inside its head. Without this
      // the turn "completes" with a blank answer and no action taken, which
      // looks exactly like the plugin doing nothing. Recover the tool calls
      // from the reasoning so the requested action still runs. The reasoning
      // text itself is already visible to the user, so it is not re-emitted.
      if (!text.trim() && reasoning.trim() && toolCalls.length === 0) {
        const recovered = parseDsmlToolCalls(reasoning)
        if (recovered.calls.length > 0) {
          this.logger?.warn?.(
            `my-model: answer channel was empty; recovered ${recovered.calls.length} tool call(s) from the reasoning channel`,
          )
          toolCalls.push(...recovered.calls)
        }
      }

      // A call can also leak into the answer as raw markup when the streaming
      // sieve could not recognise the fence spelling the model used (a spaced
      // `<| DSML | invoke …>` variant, for example). The markup is already
      // visible to the user, but running the action still beats delivering
      // protocol text and no result.
      if (toolCalls.length === 0 && /<\|?\s*DSML|invoke\s+name\s*=|<!\[CDATA\[/i.test(text)) {
        const recovered = parseDsmlToolCalls(text)
        if (recovered.calls.length > 0) {
          this.logger?.warn?.(
            `my-model: answer carried unparsed DSML markup; recovered ${recovered.calls.length} tool call(s) from the answer text`,
          )
          toolCalls.push(...recovered.calls)
        }
      }

      // Diagnostic: a turn that ends with neither a tool call nor usable text
      // is otherwise invisible — the UI just shows "已完成" with an empty
      // answer. Record the frame shape so the next occurrence is root-caused
      // from the log, not from a screenshot.
      if (toolCalls.length === 0 && (!text.trim() || /<\|?\s*DSML|invoke\s+name\s*=|<!\[CDATA\[/i.test(text))) {
        const frames = JSON.stringify((streamState.rawFrames ?? []).slice(0, 30))
        this.logger?.warn?.(
          `my-model: suspicious completion: no tool call, answer ${text.length} chars` +
            `${text.trim() ? `: ${text.slice(0, 160)}` : ' (empty)'}; frames: ${frames}`,
        )
      }

      if (reasoningOpen) {
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
      }
      if (textOpen) {
        yield { type: 'block-end', index: 1, block: { type: 'text', text } }
      }

      if (toolCalls.length > 0) {
        let index = 2
        for (const call of toolCalls) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index,
            id: call.id,
            name: call.name,
            argumentsDelta: call.arguments,
          }
          yield {
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
          }
          index += 1
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      if (!text.trim() && !reasoning.trim()) {
        throw new AdapterError('DeepSeek Web returned an empty completion', 'EMPTY_RESPONSE')
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      try {
        await response.body?.cancel()
      } catch {
        // Already closed or partially consumed.
      }
    }
  }
}

function modelInfo(id) {
  const model = MODEL_BY_ID.get(id)
  if (!model) throw new AdapterError(`unknown DeepSeek Web model "${id}"`, 'INVALID_MODEL')
  return {
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    description: model.description,
    inputModalities: ['text'],
    context: { contextWindow: 1_000_000 },
    defaultMaxTokens: 8192,
    reasoning: {
      efforts: EFFORTS.map((effort) => ({ ...effort })),
      defaultEffort: model.defaultEffort,
    },
  }
}

/**
 * Harness `LlmAdapter` implementation for the DeepSeek web endpoints.
 * Duck-typed so the plugin needs no import of the host's private LlmAdapter
 * class; the service only calls the documented methods.
 */
export class DeepSeekWebAdapter {
  constructor({
    resolveToken,
    resolveCookies,
    baseURL,
    timeoutMs,
    clientVersion,
    userAgent,
    secChUa,
    secChUaPlatform,
    secChUaMobile,
    acceptLanguage,
    secFetchSite,
    secFetchMode,
    secFetchDest,
    priority,
    referer,
    clientLocale,
    clientPlatform,
    clientBundleId,
    maxPromptChars,
    maxToolChars,
    logger,
    maxConcurrentTurns,
    minTurnGapMs,
    maxAutoWaitMs,
    cooldownBaseMs,
    maxCooldownMs,
    jitterRatio,
    humanizePacing,
    turnGapJitter,
    humanLongPauseChance,
    humanLongPauseMinMs,
    humanLongPauseMaxMs,
  } = {}) {
    this.client = new DeepSeekWebClient({
      baseURL,
      timeoutMs,
      clientVersion,
      userAgent,
      secChUa,
      secChUaPlatform,
      secChUaMobile,
      acceptLanguage,
      secFetchSite,
      secFetchMode,
      secFetchDest,
      priority,
      referer,
      clientLocale,
      clientPlatform,
      clientBundleId,
      resolveToken,
      resolveCookies,
      logger,
    })
    this.maxPromptChars = Math.max(20000, Number(maxPromptChars) || 1_000_000)
    this.maxToolChars = Math.max(500, Number(maxToolChars) || 8000)
    this.logger = logger
    this.sessions = new Map()
    // Last reason a turn stopped, surfaced by the settings page so a silent
    // disconnect has a visible cause. Cleared by the next successful turn.
    this.lastFailure = null
    this.gate = new TurnScheduler({
      maxConcurrentTurns,
      minTurnGapMs,
      maxAutoWaitMs,
      cooldownBaseMs,
      maxCooldownMs,
      jitterRatio,
      humanizePacing,
      turnGapJitter,
      humanLongPauseChance,
      humanLongPauseMinMs,
      humanLongPauseMaxMs,
      logger,
    })
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  providerRetryPolicy() {
    // The harness runs this policy on the agent loop, so RATE_LIMIT is retried
    // after the delay the adapter reports in `providerRetryAfterMs` (never in
    // a hot 900 ms loop). The cap matches the scheduler's maximum cooldown.
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      initialDelayMs: 2000,
      maxDelayMs: 120000,
      jitterRatio: 0.25,
    }
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget() {
    return { width: 1024, height: 1024, maxBytes: 20 * 1024 * 1024 }
  }

  async listModels() {
    return MODELS.map((model) => modelInfo(model.id))
  }

  async resolveModel(_provider, model) {
    return modelInfo(model)
  }

  async prepareCall(_provider, model) {
    const info = modelInfo(model)
    return { model: info, stream: (options) => this.stream(options) }
  }

  thinkFor(model, effort) {
    if (effort === 'off') return false
    if (effort === undefined || effort === null) return model.thinking
    return true
  }

  async planSession(cacheKey, fullPrompt, allowCache) {
    const cached = allowCache && cacheKey ? this.sessions.get(cacheKey) : undefined
    if (cached && Date.now() - cached.at < SESSION_TTL_MS) {
      const tail = deltaPrompt(cached.prompt, fullPrompt)
      if (tail !== null) {
        return {
          sessionId: cached.sessionId,
          promptText: tail,
          parentMessageId: cached.responseMessageId ?? null,
          fullPrompt,
          cacheKey,
          reused: true,
        }
      }
    }
    const sessionId = await this.client.createSession()
    return { sessionId, promptText: fullPrompt, parentMessageId: null, fullPrompt, cacheKey, reused: false }
  }

  remember(cacheKey, plan, responseMessageId) {
    if (!cacheKey || !plan?.sessionId || responseMessageId === null || responseMessageId === undefined) return
    // Refresh insertion order so the eviction below is LRU, not FIFO: touching
    // an existing key must move it to the newest position.
    this.sessions.delete(cacheKey)
    this.sessions.set(cacheKey, {
      sessionId: plan.sessionId,
      prompt: plan.fullPrompt,
      responseMessageId,
      at: Date.now(),
    })
    while (this.sessions.size > 64) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
  }

  async *stream(options) {
    const model = MODEL_BY_ID.get(options.model)
    if (!model) throw new AdapterError(`unknown DeepSeek Web model "${options.model}"`, 'INVALID_MODEL')
    const token = await this.client.currentToken()
    const thinking = this.thinkFor(model, options.reasoningEffort)
    const prompt = buildTranscriptPrompt({
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      maxChars: this.maxPromptChars,
      maxToolChars: this.maxToolChars,
    })
    if (!prompt.trim()) throw new AdapterError('DeepSeek Web prompt is empty', 'INVALID_REQUEST')
    // A web thread's model is fixed when it is created, so a mid-session model
    // switch starts a fresh web session instead of mixing incompatible modes.
    const cacheKey = options.sessionId
      ? `${options.sessionId}|${options.model}|${hashToken(token)}`
      : undefined

    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let release
      let emitted = false
      let plan
      try {
        // Serialize whole turns (session create + PoW + stream) for this
        // account. A second Harness consumer waits instead of tripping the
        // upstream limiter; a long cooldown exits with a retry hint instead
        // of hanging the UI.
        release = await this.gate.acquire(options.signal)
        plan = await this.planSession(cacheKey, prompt, attempt === 0)
        const state = { responseMessageId: null }
        for await (const chunk of this.client.completionStream({
          sessionId: plan.sessionId,
          parentMessageId: plan.parentMessageId,
          prompt: plan.promptText,
          thinking,
          search: Boolean(model.search),
          signal: options.signal,
          state,
        })) {
          emitted = true
          yield chunk
        }
        if (state.responseMessageId === null || state.responseMessageId === undefined) {
          if (cacheKey) this.sessions.delete(cacheKey)
        } else {
          this.remember(cacheKey, plan, state.responseMessageId)
        }
        this.gate.noteSuccess()
        // A completed turn clears the failure the settings page reports, so the
        // "last failure" line only ever names a reason that is still relevant.
        this.lastFailure = null
        return
      } catch (error) {
        lastError = error
        // Only invalidate a session this attempt actually used or created. A
        // turn rejected by the cooldown gate must not throw away a healthy
        // session, or the retry would rebuild the full transcript.
        if (cacheKey && plan) this.sessions.delete(cacheKey)
        const upstreamRateLimit =
          error instanceof AdapterError && error.code === 'RATE_LIMIT' && error.fromGate !== true
        const cooldownMs = upstreamRateLimit ? this.gate.noteRateLimit(error.providerRetryAfterMs) : undefined
        const retryableFailure = retryable(error) || upstreamRateLimit
        const stopping =
          options.signal?.aborted === true ||
          emitted ||
          attempt === 1 ||
          !retryableFailure ||
          error?.fromGate === true
        if (stopping) {
          // Log every stopping cause so the plugin log shows why the turn ended.
          // A rate limit that survives the retry budget is just as much a reason
          // as a mute or a rejected token.
          if (error instanceof AdapterError && error.code !== 'ABORTED') {
            this.logger?.warn?.(`my-model: terminal failure ${error.code}: ${error.message}`)
            this.lastFailure = {
              code: error.code,
              message: String(error.message).slice(0, 300),
              at: Date.now(),
            }
          }
          // Once output has started, a host-level retry would duplicate text;
          // report a terminal stream interruption instead.
          if (emitted && error?.code !== 'ABORTED') throw this.streamInterrupted(error)
          if (upstreamRateLimit) throw rateLimitWithDelay(error, cooldownMs)
          throw error
        }
        if (upstreamRateLimit) {
          if (cooldownMs > this.gate.maxAutoWaitMs) throw rateLimitWithDelay(error, cooldownMs)
          this.logger?.warn?.(
            `my-model: DeepSeek Web rate limited; waiting ${Math.ceil(cooldownMs / 1000)}s before retrying`,
          )
        } else {
          // Do not hold the account slot while backing off: another queued
          // turn may use it, and this attempt will reacquire afterwards.
          release?.()
          release = undefined
          const delay = Math.min(5000, 1200 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
          this.logger?.warn?.(`my-model: retrying DeepSeek Web call after ${error.code}: ${error.message}`)
          await abortableSleep(delay, options.signal)
        }
      } finally {
        release?.()
      }
    }
    throw lastError
  }

  streamInterrupted(error) {
    const status = error instanceof AdapterError ? error.status : undefined
    return new AdapterError(
      `${error?.message ?? String(error)} (the response stream had already started; retry the turn manually)`,
      'STREAM_INTERRUPTED',
      status,
    )
  }
}
