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

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Keep in sync with the deployed web client; stale values invite risk control. */
export const DEFAULT_CLIENT_VERSION = '2.4.0'

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

/** Transient failures worth retrying inside one turn without asking upstream. */
const INTERNAL_RETRY_CODES = new Set(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'])

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

function retryAfterMsFromHeaders(headers) {
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
    minTurnGapMs = 1200,
    maxAutoWaitMs = 20000,
    cooldownBaseMs = 15000,
    maxCooldownMs = 120000,
    minCooldownMs = 1000,
    jitterRatio = 0.2,
    random = Math.random,
    logger,
  } = {}) {
    this.maxConcurrent = Math.round(clampNumber(maxConcurrentTurns, 1, 8))
    this.minGapMs = clampNumber(minTurnGapMs, 0, 60000)
    this.maxAutoWaitMs = clampNumber(maxAutoWaitMs, 0, 180000)
    this.cooldownBaseMs = clampNumber(cooldownBaseMs, 250, 300000)
    this.minCooldownMs = clampNumber(minCooldownMs, 0, this.cooldownBaseMs)
    this.maxCooldownMs = Math.max(this.cooldownBaseMs, clampNumber(maxCooldownMs, this.cooldownBaseMs, 600000))
    this.jitterRatio = clampNumber(jitterRatio, 0, 1)
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
      if (signal?.aborted) throw new AdapterError('DeepSeek Web request aborted', 'ABORTED')
      const now = Date.now()
      const remaining = this.cooldownUntil - now
      if (remaining > this.maxAutoWaitMs) {
        throw new AdapterError(
          `DeepSeek Web is rate limiting this account; retry in ${Math.ceil(remaining / 1000)}s.`,
          'RATE_LIMIT',
          undefined,
          { providerRetryAfterMs: remaining, fromGate: true },
        )
      }
      const startAt = Math.max(this.lastStartAt + this.minGapMs, this.cooldownUntil)
      if (this.active < this.maxConcurrent && now >= startAt) {
        this.active += 1
        this.lastStartAt = now
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
      `my-model: DeepSeek Web rate limited; cooling down for ${Math.ceil(delay / 1000)}s (attempt ${this.streak})`,
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
      const onAbort = () => finish(new AdapterError('DeepSeek Web request aborted', 'ABORTED'))
      const timer = setTimeout(wake, Math.max(1, ms))
      this.waiters.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function abortableSleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(new AdapterError('DeepSeek Web request aborted', 'ABORTED'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AdapterError('DeepSeek Web request aborted', 'ABORTED'))
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

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

class CookieJar {
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
      'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: this.baseURL,
      referer: `${this.baseURL}/a/chat/`,
      'user-agent': DEFAULT_UA,
      'x-client-version': this.clientVersion,
      'x-client-platform': 'web',
      'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': timezoneOffset,
      'x-client-bundle-id': 'com.deepseek.chat',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
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
        `DeepSeek Web rejected the token (${message}). Log in to chat.deepseek.com again and paste a fresh userToken.`,
        'INVALID_CREDENTIAL',
        status,
      )
    }
    return new AdapterError(`DeepSeek Web error ${code ?? ''}: ${message}`, 'UPSTREAM', status)
  }

  httpError(response, body) {
    const wafAction = String(response.headers.get('x-amzn-waf-action') ?? '').toLowerCase()
    const cfMitigated = String(response.headers.get('cf-mitigated') ?? '').toLowerCase()
    if (wafAction === 'captcha' || wafAction === 'challenge' || cfMitigated === 'challenge') {
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
        `DeepSeek Web rejected the token (HTTP ${status}). Log in again and paste a fresh userToken. ${detail}`,
        'INVALID_CREDENTIAL',
        status,
      )
    }
    if (status >= 500) return new AdapterError(`DeepSeek Web server error (HTTP ${status}). ${detail}`, 'SERVER', status)
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

  async *readSse(response, signal) {
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
            yield* this.decodeData(data, event)
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
          yield* this.decodeData(data, event)
          event = 'message'
        }
      }
      if (buffer.trim()) {
        let data
        try {
          data = JSON.parse(buffer.trim())
        } catch {
          // Ignore a truncated trailing frame.
          data = undefined
        }
        if (data !== undefined) yield* this.decodeData(data, event)
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // The stream may already be closed.
      }
    }
  }

  *decodeData(data, event) {
    if (!data || typeof data !== 'object') return
    if (typeof data.code === 'number' && data.code !== 0) throw this.codeError(data)
    const bizCode = data.data?.biz_code
    if (bizCode === 5) throw this.codeError(data)
    if (data.type === 'error' || data.v?.type === 'error') {
      const detail = String(data.content ?? data.msg ?? data.v?.content ?? data.v?.msg ?? 'unknown error')
      if (isQuotaText(detail)) throw new AdapterError(`DeepSeek Web quota is exhausted: ${detail}`, 'QUOTA')
      if (isMutedText(detail)) throw new AdapterError(`DeepSeek Web account is muted: ${detail}`, 'ACCOUNT_MUTED')
      if (isRateLimitText(detail)) throw new AdapterError(`DeepSeek Web rate limit: ${detail}`, 'RATE_LIMIT')
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
        this.lastFragmentType = last?.type === 'THINK' ? 'reasoning' : 'text'
      } else if (typeof response.content === 'string' && response.content) {
        this.lastFragmentType = 'text'
        yield { type: 'text', text: response.content }
      }
      return
    }
    const p = typeof data.p === 'string' ? data.p : ''
    const o = typeof data.o === 'string' ? data.o : ''
    if (p === 'response/fragments' && o === 'APPEND') {
      if (Array.isArray(v) && v[0]) this.lastFragmentType = v[0].type === 'THINK' ? 'reasoning' : 'text'
      return
    }
    if (p === 'response/fragments/-1/content' && (o === 'APPEND' || o === '')) {
      if (typeof v === 'string' && v) yield { type: this.lastFragmentType === 'reasoning' ? 'reasoning' : 'text', text: v }
      return
    }
    if (p === 'response/status') {
      yield { type: 'status', status: String(v ?? '') }
      return
    }
    if (p === 'response/content' && o === 'APPEND') {
      this.lastFragmentType = 'text'
      if (typeof v === 'string' && v) yield { type: 'text', text: v }
      return
    }
    if ('v' in data && !('p' in data) && !('o' in data)) {
      if (typeof v === 'string' && v) yield { type: this.lastFragmentType === 'reasoning' ? 'reasoning' : 'text', text: v }
    }
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
    this.lastFragmentType = null
    const pow = await this.powHeader(COMPLETION_PATH)
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
    const response = await this.request(COMPLETION_PATH, body, {
      accept: 'text/event-stream',
      signal,
      headers: { 'x-ds-pow-response': pow },
    })
    if (!response.ok) throw this.httpError(response, await response.text().catch(() => ''))

    let reasoningOpen = false
    let textOpen = false
    let reasoning = ''
    let text = ''
    const sieve = new StreamSieve()
    const toolCalls = []
    let finished = false

    const emitText = async function* (client, value) {
      if (!value) return
      text += value
      if (!textOpen) {
        textOpen = true
        yield { type: 'block-start', index: 1, blockType: 'text' }
      }
      yield { type: 'text-delta', index: 1, text: value }
    }

    try {
      for await (const event of this.readSse(response, signal)) {
        if (event.type === 'ready') {
          state.responseMessageId = event.id
          continue
        }
        if (event.type === 'status') {
          if (event.status === 'FINISHED') {
            finished = true
            break
          }
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
              yield* emitText(this, item.text)
            } else if (item.type === 'tools') {
              toolCalls.push(...item.calls)
            }
          }
          if (toolCalls.length > 0) break
        }
      }
      if (!finished) {
        for (const item of sieve.flush()) {
          if (item.type === 'text') yield* emitText(this, item.text)
          else if (item.type === 'tools') toolCalls.push(...item.calls)
        }
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
    maxPromptChars,
    logger,
    maxConcurrentTurns,
    minTurnGapMs,
    maxAutoWaitMs,
    cooldownBaseMs,
    maxCooldownMs,
    jitterRatio,
  } = {}) {
    this.client = new DeepSeekWebClient({ baseURL, timeoutMs, clientVersion, resolveToken, resolveCookies, logger })
    this.maxPromptChars = Math.max(20000, Number(maxPromptChars) || 1_000_000)
    this.logger = logger
    this.sessions = new Map()
    this.gate = new TurnScheduler({
      maxConcurrentTurns,
      minTurnGapMs,
      maxAutoWaitMs,
      cooldownBaseMs,
      maxCooldownMs,
      jitterRatio,
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
