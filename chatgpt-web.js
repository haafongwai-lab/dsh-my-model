/**
 * ChatGPT web-chat HTTP adapter.
 *
 * This is not the official OpenAI API. It drives the same endpoints the
 * chatgpt.com browser uses (session token exchange, the sentinel
 * chat-requirements token with its proof-of-work challenge, and the streaming
 * conversation endpoint), with the user's own web login. It therefore follows
 * the web product's availability, quota, and terms.
 *
 * Two upstream gates are worth knowing about:
 *  - `chat-requirements` may demand a proof of work. That is solvable locally
 *    (sha3-512 over seed+nonce) and is solved here.
 *  - `chat-requirements` may demand a Turnstile token. That cannot be solved
 *    without a browser, so the adapter reports `CHALLENGE_REQUIRED` with the
 *    steps a user can take (complete the challenge in the browser, paste the
 *    site cookies) instead of failing obscurely.
 */
import { randomUUID } from 'node:crypto'
import { buildTranscriptPrompt, deltaPrompt, parseDsmlToolCalls, StreamSieve } from './dsml.js'
import { sha3_512HexPrefix } from './sha3.js'
import {
  CdpError,
  attachPage,
  composerInsert,
  composerNavigate,
  composerProbe,
  composerRead,
  composerSend,
  fetchInPage,
  streamInPage,
} from './chrome-cdp.js'
import {
  AdapterError,
  CookieJar,
  TurnScheduler,
  abortableSleep,
  hashToken,
  retryAfterMsFromHeaders,
} from './deepseek-web.js'

export const PROVIDER = 'chatgpt-web'
export const PROVIDER_NAME = 'My Model · ChatGPT Web'
export const SESSION_PATH = '/api/auth/session'
export const REQUIREMENTS_PATH = '/backend-api/sentinel/chat-requirements'
export const CONVERSATION_PATH = '/backend-api/conversation'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
export const DEFAULT_SEC_CH_UA = '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"'
export const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"'
export const DEFAULT_SEC_CH_UA_MOBILE = '?0'
export const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9'
export const DEFAULT_OAI_LANGUAGE = 'zh-CN'
/** Root parent for a brand-new conversation, as the web client sends it. */
export const ROOT_PARENT_MESSAGE_ID = 'client-created-root'

const EFFORTS = [
  { id: 'off', name: 'Default', description: 'Use the model the web product serves by default.' },
]

/**
 * The web product exposes one model picker, whose slugs change over time, so the
 * slug is configuration rather than a hard-coded list. `auto` is what the web UI
 * sends when the user leaves the picker on its default; the default below pins
 * the current free-tier default (GPT-6 Luna, since 2026-10-08) so the provider is
 * explicit, and the adapter falls back to `auto` if the upstream no longer
 * serves that slug.
 *
 * One entry only: the point is to drive the web product's own default model, not
 * to mirror its picker. Pin a different slug with `chatgptModelSlug` if needed.
 */
export const DEFAULT_MODEL_SLUG = 'gpt-6-luna'

export const MODELS = [
  {
    id: 'chatgpt-web-chat',
    name: 'ChatGPT Web',
    description: 'The chatgpt.com default model, using your own web account (`gpt-6-luna` unless configured otherwise).',
    thinking: false,
    search: false,
    defaultEffort: 'off',
  },
]

const MODEL_BY_ID = new Map(MODELS.map((model) => [model.id, model]))

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** How long an exchanged access token is reused before asking for a fresh one. */
const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000
/**
 * Hashes per slice in the proof-of-work search. Sized so one slice is ~100 ms on
 * the pure-JS digest, which keeps the event loop responsive without making the
 * `setImmediate` handoff itself dominate the cost.
 */
const POW_CHUNK = 4000

const INTERNAL_RETRY_CODES = new Set(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STALE_SESSION'])

function retryable(error) {
  return error instanceof AdapterError && INTERNAL_RETRY_CODES.has(error.code)
}

function textOf(value) {
  return String(value ?? '')
}

function isRateLimitText(text) {
  return /rate[\s_-]*limit|too[\s_-]+many[\s_-]+requests|throttl|请求过多|访问过快|限流/i.test(text)
}

function isQuotaText(text) {
  return (
    /(?:usage|message|quota|image)[\s_-]*(?:limit|cap)[\s_-]*(?:reached|exceeded|exhausted)/i.test(text) ||
    /(?:reached|hit|exceeded)[^.]{0,24}(?:usage|message|quota)[\s_-]*(?:limit|cap)/i.test(text) ||
    /(?:额度|配额|次数)[^。；;]{0,16}(?:用完|耗尽|不足|已达|达到|上限)/.test(text)
  )
}

function isStaleSessionText(text) {
  const value = textOf(text)
  if (!value) return false
  return (
    /conversation[^\n.]{0,24}(?:not found|does not exist|invalid|expired|deleted)/i.test(value) ||
    /(?:invalid|unknown)[^\n.]{0,16}conversation[_\s-]?id/i.test(value) ||
    /(?:对话|会话)[^\n。；;]{0,12}(?:不存在|已过期|已删除|已失效|无效)/.test(value)
  )
}

function isChallengeText(text) {
  const value = textOf(text)
  return (
    /turnstile|challenge|verify you are human|just a moment|cf-challenge|cloudflare/i.test(value) ||
    /人机验证|验证码|请完成验证/.test(value)
  )
}

/**
 * The JSON API never answers with markup, so an HTML body means an interstitial
 * (a Cloudflare challenge, a block page, or the site's own error shell) replied
 * instead of the endpoint. Treating that as "bad credential" sends the user to
 * re-paste a token that was never the problem.
 */
function isHtmlBody(text) {
  return /<\s*(?:!doctype|html|head|body)\b/i.test(textOf(text).slice(0, 600))
}

function blockedPageError(status, transport) {
  const where =
    transport === 'cdp'
      ? 'Look at the Chrome window: if chatgpt.com itself shows a verification or "you have been blocked" page there, ' +
        'the network/IP is being blocked — switch network (VPN/proxy exit) or wait for the block to lift.'
      : 'Open chatgpt.com in your browser: if it shows a verification or block page there too, the network/IP is being ' +
        'blocked rather than the credential being wrong.'
  return new AdapterError(
    `ChatGPT Web answered HTTP ${status} with an HTML page instead of JSON, so an interstitial or block page answered ` +
      `instead of the API. ${where}`,
    'WAF_CHALLENGE',
    status,
  )
}

/**
 * The model slug is pinned in the plugin config, and the upstream retires slugs
 * without notice — the GPT-5.5 retirement on 2026-10-14 left every client with a
 * hard-coded slug on "Model not found". Recognising it lets the adapter retry
 * once on `auto` instead of failing the turn.
 */
function isModelNotFoundText(text) {
  const value = textOf(text)
  return (
    /model[^\n.]{0,24}(?:not found|does not exist|doesn't exist|unavailable|not supported)/i.test(value) ||
    /(?:not found|does not exist|can not be found|无法找到)[^\n.]{0,16}model/i.test(value) ||
    /模型[^\n。；;]{0,12}(?:不存在|已下架|已下线|不可用|无法访问)/.test(value)
  )
}

function isDisabledText(text) {
  return /(?:account|workspace)[^\n.]{0,24}(?:deactivated|disabled|suspended|blocked)/i.test(textOf(text))
}

/**
 * OpenAI's bot protection answers `403` with
 * `{"detail":"Unusual activity has been detected from your device. Try again
 * later. (<trace id>)"}`. The credential is valid and the request already passed
 * the sentinel gate, so treating this as a bad token sends the user down the
 * wrong path; it is a device/IP/fingerprint rejection.
 */
function isRiskControlText(text) {
  const value = textOf(text)
  return (
    /unusual activity has been detected/i.test(value) ||
    /(?:suspicious|unusual)[^\n.]{0,32}(?:activity|traffic)[^\n.]{0,32}(?:detected|blocked)/i.test(value)
  )
}

function riskControlError(detail, status) {
  // The detail ends with a support trace id in parentheses, sometimes followed
  // by JSON punctuation, so it is located rather than anchored to the end.
  const matches = [...textOf(detail).matchAll(/\(([0-9a-z-]{8,})\)/gi)]
  const trace = matches.at(-1)?.[1]
  return new AdapterError(
    `ChatGPT Web blocked this device as unusual activity (HTTP ${status}). The credential is not the problem — ` +
      `OpenAI's bot protection flagged the request, so re-pasting a token will not help. Wait for the block to lift ` +
      `(it is time based), then retry from the same network/IP and browser fingerprint as the account's browser; ` +
      `retrying in a loop extends it.${trace ? ` Trace ${trace}.` : ''}`,
    'RISK_CONTROL',
    status,
  )
}

function isTransientUpstreamText(text) {
  return /(?:overloaded|service is busy|temporarily unavailable|try again later|internal server error)/i.test(textOf(text))
}

function staleSessionError(detail, status) {
  const message = textOf(detail).slice(0, 300)
  return new AdapterError(
    `ChatGPT Web rejected the cached conversation (${message || 'no detail'}); starting a fresh one.`,
    'STALE_SESSION',
    status,
  )
}

function challengeError(status) {
  return new AdapterError(
    'ChatGPT Web returned a human-verification challenge (Cloudflare / Turnstile). Open chatgpt.com in your browser, ' +
      'complete the challenge, then paste the site cookies into Settings → My Model → ChatGPT → Cookie.',
    'WAF_CHALLENGE',
    status,
  )
}

function transientUpstreamError(detail, status) {
  return new AdapterError(
    `ChatGPT Web is temporarily unavailable: ${textOf(detail).slice(0, 240)}`,
    'SERVER',
    status,
    { providerRetryAfterMs: 5000 },
  )
}

/** Normalize a pasted access token (`Bearer …`, a JSON blob, or the raw JWT). */
export function normalizeAccessToken(raw) {
  let value = textOf(raw).trim()
  if (!value) return ''
  if (/^bearer\s+/i.test(value)) value = value.replace(/^bearer\s+/i, '').trim()
  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed?.accessToken === 'string') value = parsed.accessToken.trim()
      else if (typeof parsed?.access_token === 'string') value = parsed.access_token.trim()
      else if (typeof parsed?.token === 'string') value = parsed.token.trim()
      else if (typeof parsed?.value === 'string') value = parsed.value.trim()
    } catch {
      // Keep the original text; the server will report an invalid token.
    }
  }
  return value
}

/**
 * The sentinel challenge reports `difficulty` as a hex string such as
 * `"0717f3"`. It is a **threshold, not a mask**: the digest's leading
 * `difficulty.length` hex digits, read as a number, must be less than or equal
 * to the difficulty. Reading it as "digest must start with these nibbles" makes
 * the search impossible (1 in 16^6) — that is what stalled the first attempt at
 * 976 000 hashes; as a threshold the same challenge needs ~36 hashes.
 *
 * A string of zeros ("0000") degenerates to the familiar leading-zero rule, so
 * this single comparison covers both shapes.
 */
export function parseDifficulty(raw) {
  const text = textOf(raw).trim().toLowerCase()
  if (!text || !/^[0-9a-f]+$/.test(text)) return null
  return { text, width: text.length }
}

/**
 * Solve the sentinel proof of work: find a nonce whose sha3-512 digest of
 * `seed + nonce`, truncated to the difficulty's width, is numerically less than
 * or equal to the difficulty (see `parseDifficulty`).
 *
 * This runs in **chunks that yield to the event loop**. A straight loop would
 * block the host's single thread for the whole search — on a machine without a
 * native SHA-3 that is ~24 µs per hash, so an exhausted budget froze the entire
 * Harness for minutes. Yielding keeps the settings page and every other request
 * alive, and the time budget turns "never converges" into a clear, reportable
 * failure instead of a hang.
 *
 * @param {{seed?: string, difficulty?: string|number}} challenge
 * @param {{maxIterations?: number, timeBudgetMs?: number, signal?: AbortSignal, logger?: object}} [options]
 */
export async function solveProofOfWork(
  { seed, difficulty } = {},
  { maxIterations = 5_000_000, timeBudgetMs = 20000, signal, logger } = {},
) {
  const target = parseDifficulty(difficulty)
  const prefix = textOf(seed)
  if (!target) {
    throw new AdapterError(
      `ChatGPT Web sent a proof-of-work challenge with an unrecognised difficulty ${JSON.stringify(difficulty)}.`,
      'UPSTREAM',
    )
  }
  if (!prefix) throw new AdapterError('ChatGPT Web sent a proof-of-work challenge without a seed.', 'UPSTREAM')
  // Equal-length lowercase hex strings compare like the numbers they encode, so
  // the check needs no big-integer arithmetic.
  const { text: threshold, width } = target
  const started = Date.now()
  const deadline = started + Math.max(1000, timeBudgetMs)
  let nonce = 0
  while (nonce < maxIterations) {
    const chunkEnd = Math.min(nonce + POW_CHUNK, maxIterations)
    for (; nonce < chunkEnd; nonce += 1) {
      if (sha3_512HexPrefix(`${prefix}${nonce}`, width) <= threshold) {
        return {
          algorithm: 'sha3-512',
          difficulty,
          nonce,
          attempts: nonce + 1,
          elapsedMs: Date.now() - started,
        }
      }
    }
    if (signal?.aborted) throw new AdapterError('ChatGPT Web request aborted', 'ABORTED')
    if (Date.now() > deadline) {
      logger?.warn?.(
        `my-model: ChatGPT PoW gave up after ${nonce} hashes in ${Date.now() - started}ms ` +
          `(difficulty ${JSON.stringify(difficulty)}, threshold 0x${threshold}, seed length ${prefix.length})`,
      )
      throw new AdapterError(
        `ChatGPT Web proof of work did not converge (difficulty ${JSON.stringify(difficulty)}, ` +
          `${nonce} hashes in ${Date.now() - started}ms). The challenge may have changed shape; ` +
          `the plugin log records the seed length and threshold.`,
        'CHALLENGE_UNSOLVED',
      )
    }
    // Hand the thread back so the host can serve other requests and repaint.
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new AdapterError(
    `ChatGPT Web proof of work did not converge within ${maxIterations} hashes.`,
    'CHALLENGE_UNSOLVED',
  )
}

/** A Response-shaped object for `httpError`, which only reads status/headers. */
function responseLike(status, headers = {}) {
  const lower = {}
  for (const [key, value] of Object.entries(headers)) lower[String(key).toLowerCase()] = value
  return { status, headers: { get: (name) => lower[String(name).toLowerCase()] ?? null } }
}

const CDP_HINTS = {
  UNREACHABLE:
    ' Start Chrome with --remote-debugging-port=9222 --user-data-dir=<a dedicated profile>, sign in to chatgpt.com ' +
    'in that window, and keep it running.',
  NO_TARGET: ' Open chatgpt.com in that Chrome window and retry.',
  NO_WEBSOCKET: ' This runtime has no WebSocket, so the CDP transport cannot be used.',
}

/** Turn a CDP failure into a provider-neutral AdapterError. */
function cdpErrorToAdapter(error) {
  if (error instanceof AdapterError) return error
  if (!(error instanceof CdpError)) return error
  const code =
    error.code === 'TIMEOUT'
      ? 'TIMEOUT'
      : error.code === 'ABORTED'
        ? 'ABORTED'
        : error.code === 'NO_TARGET'
          ? 'CDP_NO_TARGET'
          : error.code === 'UNREACHABLE' || error.code === 'NO_WEBSOCKET'
            ? 'CDP_UNAVAILABLE'
            : 'TRANSPORT'
  return new AdapterError(`Chrome CDP: ${error.message}${CDP_HINTS[error.code] ?? ''}`, code)
}

/**
 * Minimal client for the chatgpt.com web endpoints. One instance is shared by
 * the adapter so the cookie jar and the exchanged access token stay warm.
 */
export class ChatGptWebClient {
  constructor({
    baseURL = 'https://chatgpt.com',
    timeoutMs = 300000,
    userAgent,
    secChUa,
    secChUaPlatform,
    secChUaMobile,
    acceptLanguage,
    oaiLanguage,
    token,
    cookies,
    resolveToken,
    resolveCookies,
    logger,
    // 'node' sends the request with fetch; 'cdp' runs it inside the user's own
    // Chrome page, which is the only way to satisfy Cloudflare's device check.
    transport,
    cdpPort,
    cdpHost,
  } = {}) {
    this.baseURL = String(baseURL || 'https://chatgpt.com').replace(/\/+$/, '')
    this.timeoutMs = Math.max(15000, Number(timeoutMs) || 300000)
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
    this.oaiLanguage =
      typeof oaiLanguage === 'string' && oaiLanguage.trim() ? oaiLanguage.trim() : DEFAULT_OAI_LANGUAGE
    this.token = token
    this.cookies = cookies
    this.resolveToken = resolveToken
    this.resolveCookies = resolveCookies
    this.logger = logger
    this.jar = new CookieJar()
    this.deviceId = randomUUID()
    this.lastCookies = undefined
    this.accessToken = null
    this.accessTokenAt = 0
    // Set when a proof-of-work challenge could not be solved. Retrying it on
    // every turn would burn the whole CPU budget again for the same answer, so
    // the client backs off and fails fast until the cooldown expires.
    this.powBlockedUntil = 0
    this.transport = transport === 'cdp' ? 'cdp' : 'node'
    this.cdpPort = Number.isInteger(Number(cdpPort)) && Number(cdpPort) > 0 ? Number(cdpPort) : 9222
    this.cdpHost = typeof cdpHost === 'string' && cdpHost.trim() ? cdpHost.trim() : '127.0.0.1'
    this.cdpConnection = null
    this.cdpAttaching = null
    this.cdpTarget = null
  }

  /** Switch transport at runtime (the settings page does this). */
  setTransport(transport) {
    const next = transport === 'cdp' ? 'cdp' : 'node'
    if (next !== this.transport) {
      this.transport = next
      this.dropCdp()
    }
    return this.transport
  }

  dropCdp() {
    try {
      this.cdpConnection?.close()
    } catch {
      // Already closed.
    }
    this.cdpConnection = null
    this.cdpTarget = null
  }

  /** Attach to a page on this origin, reusing the connection across calls. */
  async cdpPage() {
    if (this.cdpConnection) return this.cdpConnection
    if (!this.cdpAttaching) {
      this.cdpAttaching = attachPage({ host: this.cdpHost, port: this.cdpPort, origin: this.baseURL })
        .then(({ connection, target }) => {
          this.cdpConnection = connection
          this.cdpTarget = target
          this.logger?.info?.(`my-model: attached to Chrome tab ${target.id ?? '?'} (${target.url ?? '?'})`)
          return connection
        })
        .finally(() => {
          this.cdpAttaching = null
        })
    }
    return this.cdpAttaching
  }

  /** The pasted token, if any (no exchange involved). */
  async resolveDirectToken() {
    const value = this.token !== undefined ? this.token : await this.resolveToken?.()
    return normalizeAccessToken(value)
  }

  async currentCookies() {
    return this.cookies !== undefined ? this.cookies : ((await this.resolveCookies?.()) ?? '')
  }

  async hasCookies() {
    return Boolean(textOf(await this.currentCookies()).trim())
  }

  /**
   * Seed the cookie jar from the configured cookie blob. Re-seeding also drops
   * a token that was exchanged from a different blob.
   */
  async prepareCookies() {
    const cookies = textOf(await this.currentCookies())
    if (cookies !== this.lastCookies) {
      this.jar.seed(cookies)
      this.lastCookies = cookies
      this.accessToken = null
      this.accessTokenAt = 0
    }
    return cookies
  }

  /**
   * Resolve the bearer token. Over CDP the browser tab is the source of truth, so
   * a pasted token is ignored there (a stale one would shadow a healthy session).
   * Otherwise a pasted access token wins, and the cookie blob is exchanged at
   * `/api/auth/session` when there is none.
   */
  async currentToken({ force = false } = {}) {
    await this.prepareCookies()
    const direct = this.transport === 'cdp' ? '' : await this.resolveDirectToken()
    if (direct) return direct
    if (!force && this.accessToken && Date.now() - this.accessTokenAt < ACCESS_TOKEN_TTL_MS) {
      return this.accessToken
    }
    const session = await this.sessionInfo()
    const token = normalizeAccessToken(session?.accessToken)
    if (!token) {
      throw new AdapterError(
        this.transport === 'cdp'
          ? 'No ChatGPT session: the attached Chrome tab is not signed in. Open chatgpt.com in that window, sign in, and retry.'
          : 'No ChatGPT web credential is configured (or the cookies are no longer signed in). Open Settings → My Model → ' +
            'ChatGPT and paste the `accessToken` from chatgpt.com/api/auth/session, or a fresh cookie string.',
        'MISSING_CREDENTIAL',
      )
    }
    this.accessToken = token
    this.accessTokenAt = Date.now()
    return token
  }

  baseHeaders(token, accept) {
    const headers = {
      accept: accept ?? 'application/json',
      'accept-language': this.acceptLanguage,
      'content-type': 'application/json',
      'oai-device-id': this.jar.values.get('oai-did') || this.deviceId,
      'oai-language': this.oaiLanguage,
      origin: this.baseURL,
      referer: `${this.baseURL}/`,
      'sec-ch-ua': this.secChUa,
      'sec-ch-ua-mobile': this.secChUaMobile,
      'sec-ch-ua-platform': this.secChUaPlatform,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': this.userAgent,
    }
    if (token) headers.authorization = `Bearer ${token}`
    const cookie = this.jar.header()
    if (cookie) headers.cookie = cookie
    return headers
  }

  async send(path, { method = 'GET', body, accept, headers: extraHeaders, signal } = {}, token) {
    const headers = { ...this.baseHeaders(token, accept), ...(extraHeaders ?? {}) }
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await fetch(`${this.baseURL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        redirect: 'follow',
      })
      this.jar.absorb(response)
      return response
    } catch (error) {
      if (signal?.aborted) throw new AdapterError('ChatGPT Web request aborted', 'ABORTED')
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new AdapterError('ChatGPT Web request timed out', 'TIMEOUT')
      }
      throw new AdapterError(`ChatGPT Web transport failed: ${error?.message ?? String(error)}`, 'TRANSPORT')
    }
  }

  async request(path, { signal, auth = true, ...rest } = {}) {
    const direct = await this.resolveDirectToken()
    // An exchanged token can expire while the cookie blob stays valid, so
    // /api/auth/session is called first and the jar is seeded even when the
    // request itself carries no authorization header.
    if (!direct || !auth) await this.prepareCookies()
    let token = auth ? await this.currentToken() : undefined
    const response = await this.send(path, rest, token)
    if (response.status === 401 && auth && !direct && (await this.hasCookies())) {
      this.accessToken = null
      this.accessTokenAt = 0
      token = await this.currentToken()
      return this.send(path, rest, token)
    }
    return response
  }

  async readJson(response) {
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw new AdapterError(`ChatGPT Web response could not be read: ${error?.message ?? String(error)}`, 'TRANSPORT')
    }
    try {
      return JSON.parse(text)
    } catch {
      if (isChallengeText(text) || String(response.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') {
        throw challengeError(response.status)
      }
      throw this.httpError(response, text)
    }
  }

  /** `GET /api/auth/session` — the web app's own "who am I / what token" call. */
  async sessionInfo({ signal } = {}) {
    if (this.transport === 'cdp') {
      const result = await this.cdpJson(SESSION_PATH, { method: 'GET', signal })
      if (result.status < 200 || result.status >= 300) throw this.httpError(responseLike(result.status), result.text)
      let json
      try {
        json = JSON.parse(result.text)
      } catch {
        throw this.httpError(responseLike(result.status, { 'content-type': result.contentType }), result.text)
      }
      if (!json || typeof json !== 'object') {
        throw new AdapterError('ChatGPT Web returned an empty session payload.', 'INVALID_CREDENTIAL', result.status)
      }
      return json
    }
    const response = await this.request(SESSION_PATH, { method: 'GET', auth: false, signal })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw this.httpError(response, detail)
    }
    const json = await this.readJson(response)
    if (!json || typeof json !== 'object') {
      throw new AdapterError('ChatGPT Web returned an empty session payload.', 'INVALID_CREDENTIAL', response.status)
    }
    return json
  }

  /** One in-page JSON request (CDP transport). */
  async cdpJson(path, { method = 'GET', headers = {}, body, signal } = {}) {
    const page = await this.cdpPage().catch((error) => {
      throw cdpErrorToAdapter(error)
    })
    try {
      return await fetchInPage(page, path, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
        body,
        timeoutMs: Math.min(this.timeoutMs, 60000),
      })
    } catch (error) {
      if (error?.code === 'CLOSED') this.dropCdp()
      throw cdpErrorToAdapter(error)
    }
  }

  /**
   * Fetch (and if needed solve) the sentinel token required on the conversation
   * request. Two round trips when proof of work is demanded.
   */
  async chatRequirements({ signal } = {}) {
    if (this.powBlockedUntil > Date.now()) {
      const seconds = Math.ceil((this.powBlockedUntil - Date.now()) / 1000)
      throw new AdapterError(
        `ChatGPT Web proof of work could not be solved recently; skipping the attempt for ${seconds}s. ` +
          `See my-model.log for the difficulty and target that were rejected.`,
        'CHALLENGE_UNSOLVED',
      )
    }
    const first = await this.requirementsCall({}, signal)
    let token = first?.token
    let turnstileRequired = Boolean(first?.turnstile?.required)
    const pow = first?.proofofwork
    if (pow?.required) {
      let proof
      try {
        proof = await solveProofOfWork(pow, { signal, logger: this.logger })
      } catch (error) {
        if (error?.code === 'CHALLENGE_UNSOLVED') this.powBlockedUntil = Date.now() + 5 * 60 * 1000
        throw error
      }
      this.logger?.debug?.(
        `my-model: ChatGPT PoW solved in ${proof.elapsedMs}ms (${proof.attempts} hashes, difficulty ${JSON.stringify(pow.difficulty)})`,
      )
      // Only the fields the challenge asks for go on the wire; the timing stays
      // in the log.
      const encoded = Buffer.from(
        JSON.stringify({
          algorithm: proof.algorithm,
          difficulty: proof.difficulty,
          nonce: proof.nonce,
          attempts: proof.attempts,
        }),
      ).toString('base64')
      const second = await this.requirementsCall({ p: encoded }, signal)
      if (second?.token) token = second.token
      if (second?.turnstile?.required) turnstileRequired = true
    }
    if (!token) {
      const turnstile = Boolean(first?.turnstile?.required)
      if (turnstile) {
        throw new AdapterError(
          'ChatGPT Web requires a Turnstile challenge that cannot be solved outside a browser. Open chatgpt.com, ' +
            'complete the check, then paste the site cookies (including cf_clearance) into Settings → My Model → ChatGPT → Cookie.',
          'CHALLENGE_REQUIRED',
        )
      }
      throw new AdapterError('ChatGPT Web did not return a sentinel token.', 'UPSTREAM')
    }
    return { token, turnstileRequired }
  }

  async requirementsCall(body, signal) {
    if (this.transport === 'cdp') {
      // The backend identifies the caller by this header, not by the tab's
      // cookies: without it the sentinel answers `persona: "chatgpt-noauth"` and
      // the conversation call is rejected later.
      const token = await this.currentToken()
      const result = await this.cdpJson(REQUIREMENTS_PATH, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: body ?? {},
        signal,
      })
      if (result.status < 200 || result.status >= 300) throw this.httpError(responseLike(result.status), result.text)
      try {
        const json = JSON.parse(result.text)
        return json && typeof json === 'object' ? json : {}
      } catch {
        throw this.httpError(responseLike(result.status, { 'content-type': result.contentType }), result.text)
      }
    }
    const response = await this.request(REQUIREMENTS_PATH, {
      method: 'POST',
      body,
      accept: 'application/json',
      signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw this.httpError(response, detail)
    }
    const json = await this.readJson(response)
    return json && typeof json === 'object' ? json : {}
  }

  /** Verify the credential and the sentinel path without sending a chat message. */
  async testAuth() {
    const started = Date.now()
    const direct = this.transport === 'cdp' ? '' : await this.resolveDirectToken()
    let session = {}
    if (direct) {
      // A pasted accessToken needs no exchange; the cookie blob may be absent.
      this.accessToken = null
      this.accessTokenAt = 0
    } else {
      session = await this.sessionInfo()
      const token = normalizeAccessToken(session?.accessToken)
      if (!token) {
        throw new AdapterError(
          this.transport === 'cdp'
            ? 'The Chrome tab is not signed in to chatgpt.com. Sign in there and retry — in CDP mode nothing has to be pasted here.'
            : 'The cookies are not signed in to chatgpt.com. Log in again and paste a fresh cookie string or accessToken.',
          'INVALID_CREDENTIAL',
        )
      }
      this.accessToken = token
      this.accessTokenAt = Date.now()
    }
    const requirements = await this.chatRequirements()
    return {
      latencyMs: Date.now() - started,
      email: typeof session?.user?.email === 'string' ? session.user.email : undefined,
      planType: session?.account?.plan_type ?? session?.user?.plan_type,
      turnstileRequired: Boolean(requirements.turnstileRequired),
    }
  }

  async *readSse(response, signal) {
    if (!response.body) throw new AdapterError('ChatGPT Web returned no response body', 'UPSTREAM', response.status)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        if (signal?.aborted) throw new AdapterError('ChatGPT Web request aborted', 'ABORTED')
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (!line.startsWith('data:')) continue
          const dataText = line.slice(5).trim()
          if (!dataText || dataText === '[DONE]') continue
          let data
          try {
            data = JSON.parse(dataText)
          } catch {
            continue
          }
          yield data
        }
      }
      buffer += decoder.decode()
      const tail = buffer.trim()
      if (tail.startsWith('data:')) {
        const dataText = tail.slice(5).trim()
        if (dataText && dataText !== '[DONE]') {
          try {
            yield JSON.parse(dataText)
          } catch {
            // Ignore a truncated trailing frame.
          }
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // The stream may already be closed.
      }
    }
  }

  /**
   * Stream one conversation turn as text/reasoning/tool-call chunks in the
   * Harness `StreamChunk` protocol.
   *
   * ChatGPT streams the *whole* assistant message again on every frame, so the
   * text is diffed against what was already emitted for that message id.
   */
  async *conversationStream({ conversationId, parentMessageId, prompt, modelSlug, signal, state }) {
    state ??= {}
    const { token: requirementsToken, turnstileRequired } = await this.chatRequirements({ signal })
    // A Turnstile proof can only be produced by the site's own JavaScript while
    // it sends a message, so the API replay cannot pass that gate. Over CDP the
    // page itself can: drive its composer and read the reply back.
    const viaComposer = turnstileRequired && this.transport === 'cdp'
    if (turnstileRequired && !viaComposer) {
      throw new AdapterError(
        'ChatGPT Web requires a Turnstile proof for this account, and only the site’s own JavaScript can produce one. ' +
          'Switch the ChatGPT transport to local Chrome (Settings → My Model → ChatGPT), or use the official OpenAI ' +
          'API for this account.',
        'CHALLENGE_REQUIRED',
      )
    }
    if (viaComposer) {
      this.logger?.info?.(
        'my-model: this account requires Turnstile; sending through the page composer instead of the API',
      )
    }
    const body = {
      action: 'next',
      messages: [
        {
          id: randomUUID(),
          author: { role: 'user' },
          content: { content_type: 'text', parts: [prompt] },
          metadata: {},
        },
      ],
      parent_message_id: parentMessageId || ROOT_PARENT_MESSAGE_ID,
      model: modelSlug || 'auto',
      conversation_mode: { kind: 'primary_assistant' },
      timezone_offset_min: -new Date().getTimezoneOffset(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      history_and_training_disabled: false,
      force_paragen: false,
      force_paragen_model_slug: '',
      force_rate_limit: false,
      reset_rate_limits: false,
      suggestions: [],
      supported_encodings: [],
      system_hints: [],
      client_prepare_state: 'sent',
      fork_from_shared_post: false,
      websocket_request_id: randomUUID(),
    }
    if (conversationId) body.conversation_id = conversationId

    const response =
      viaComposer || this.transport === 'cdp'
        ? null
        : await this.request(CONVERSATION_PATH, {
            method: 'POST',
            body,
            accept: 'text/event-stream',
            signal,
            headers: { 'openai-sentinel-chat-requirements-token': requirementsToken },
          })
    if (response) {
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw this.httpError(response, detail)
      }
      const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
      if (!contentType.includes('text/event-stream')) {
        const detail = await response.text().catch(() => '')
        if (
          isChallengeText(detail) ||
          String(response.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge'
        ) {
          throw challengeError(response.status)
        }
        throw new AdapterError(
          `ChatGPT Web returned ${contentType || 'an unknown content type'} instead of an event stream: ${detail.slice(0, 200)}`,
          'UPSTREAM',
          response.status,
        )
      }
    }

    const emitted = state.emitted ?? (state.emitted = new Map())
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
      for await (const data of this.frames({ response, body, signal, requirementsToken, prompt, viaComposer })) {
        if (!data || typeof data !== 'object') continue
        if (typeof data.conversation_id === 'string' && data.conversation_id) {
          state.conversationId = data.conversation_id
        }
        if (data.error) {
          const detail =
            typeof data.error === 'string'
              ? data.error
              : textOf(data.error.message ?? data.error.code ?? JSON.stringify(data.error))
          throw this.classify(detail)
        }
        const message = data.message
        if (!message || typeof message !== 'object') continue
        if (message.metadata?.is_visually_hidden_from_conversation === true) continue
        if (message.author?.role !== 'assistant') continue
        if (typeof message.id === 'string' && message.id) state.responseMessageId = message.id
        const contentTypeOfMessage = message.content?.content_type
        const isReasoning = contentTypeOfMessage === 'thoughts' || contentTypeOfMessage === 'reasoning'
        const parts = Array.isArray(message.content?.parts) ? message.content.parts : []
        const full = parts.filter((part) => typeof part === 'string').join('')
        if (!full) continue
        const key = `${message.id ?? 'unknown'}:${isReasoning ? 'r' : 't'}`
        const previous = emitted.get(key) ?? ''
        if (full === previous) continue
        let delta
        if (full.startsWith(previous)) {
          delta = full.slice(previous.length)
        } else {
          // The message was rewritten mid-stream. Emitting the whole text again
          // would duplicate visible output, so only the unseen tail is sent.
          this.logger?.warn?.('my-model: ChatGPT rewrote an in-flight message; sending only the unseen tail')
          delta = full.slice(previous.length)
        }
        emitted.set(key, full)
        if (!delta) continue
        if (isReasoning) {
          reasoning += delta
          if (!reasoningOpen) {
            reasoningOpen = true
            yield { type: 'block-start', index: 0, blockType: 'reasoning' }
          }
          yield { type: 'reasoning-delta', index: 0, text: delta }
          continue
        }
        for (const item of sieve.feed(delta)) {
          if (item.type === 'text') yield* emitText(item.text)
          else if (item.type === 'tools') toolCalls.push(...item.calls)
        }
        if (toolCalls.length > 0) break
      }

      for (const item of sieve.flush()) {
        if (item.type === 'text') yield* emitText(item.text)
        else if (item.type === 'tools') toolCalls.push(...item.calls)
      }

      if (!text.trim() && reasoning.trim() && toolCalls.length === 0) {
        const recovered = parseDsmlToolCalls(reasoning)
        if (recovered.calls.length > 0) {
          this.logger?.warn?.(
            `my-model: ChatGPT answer channel was empty; recovered ${recovered.calls.length} tool call(s) from the reasoning channel`,
          )
          toolCalls.push(...recovered.calls)
        }
      }

      if (toolCalls.length === 0 && /<\|?\s*DSML|invoke\s+name\s*=|<!\[CDATA\[/i.test(text)) {
        const recovered = parseDsmlToolCalls(text)
        if (recovered.calls.length > 0) {
          this.logger?.warn?.(
            `my-model: ChatGPT answer carried unparsed DSML markup; recovered ${recovered.calls.length} tool call(s)`,
          )
          toolCalls.push(...recovered.calls)
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
        throw new AdapterError('ChatGPT Web returned an empty completion', 'EMPTY_RESPONSE')
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      try {
        await response?.body?.cancel()
      } catch {
        // Already closed or partially consumed.
      }
    }
  }

  /**
   * Decoded SSE frames for this turn, from whichever transport runs.
   * The composer path synthesises the same frame shape, so the decoding,
   * cumulative-diffing and tool-call logic below stays shared.
   * @param {{response: Response|null, body: object, signal?: AbortSignal, requirementsToken: string, prompt?: string, viaComposer?: boolean}} input
   */
  async *frames({ response, body, signal, requirementsToken, prompt, viaComposer }) {
    if (viaComposer) {
      const page = await this.cdpPage().catch((error) => {
        throw cdpErrorToAdapter(error)
      })
      const run = async (expression) => {
        try {
          return await expression()
        } catch (error) {
          if (error?.code === 'CLOSED') this.dropCdp()
          throw cdpErrorToAdapter(error)
        }
      }
      // 0) Start from a fresh chat so the turn never lands in a conversation the
      // user is looking at.
      await run(() => composerNavigate(page, this.baseURL))
      let ready = null
      let onFreshChat = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        if (signal?.aborted) throw new AdapterError('ChatGPT Web request aborted', 'ABORTED')
        ready = await run(() => composerProbe(page))
        // The old document keeps its composer while a navigation commits, so
        // "composer present" alone would type the prompt into the conversation
        // the plugin is leaving. A conversation URL means the new chat has not
        // arrived yet.
        onFreshChat = !/\/c\/[0-9a-f-]{8,}/i.test(String(ready?.href ?? ''))
        if (ready?.ready && onFreshChat) break
      }
      if (!ready?.ready || !onFreshChat) {
        throw new AdapterError(
          `ChatGPT Web page: a fresh composer did not load within 20s (at ${ready?.href ?? 'an unknown URL'}). ` +
            'Is the tab signed in to chatgpt.com?',
          'UPSTREAM',
        )
      }
      // 1) Insert the text (fast, synchronous in-page call).
      const prepared = await run(() => composerInsert(page, { prompt: String(prompt ?? '') }))
      if (!prepared?.ok) {
        throw new AdapterError(`ChatGPT Web page: ${prepared?.message ?? 'the prompt could not be entered.'}`, 'UPSTREAM')
      }
      // 2) Click send once the button renders (React re-renders it into place).
      let clicked = false
      for (let attempt = 0; attempt < 10 && !clicked; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        if (signal?.aborted) throw new AdapterError('ChatGPT Web request aborted', 'ABORTED')
        const sent = await run(() => composerSend(page))
        clicked = sent.clicked === true
      }
      if (!clicked) {
        throw new AdapterError(
          'ChatGPT Web page: the send button never appeared. Is the tab on a chat and not showing an error?',
          'UPSTREAM',
        )
      }
      // 3) Poll the DOM for the reply. Node owns the loop, so background-tab
      // timer throttling cannot stall it.
      let last = ''
      let stable = 0
      let sawText = false
      let lastRead = null
      const startedAt = Date.now()
      const deadline = startedAt + 180000
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new AdapterError('ChatGPT Web request aborted', 'ABORTED')
        await new Promise((resolve) => setTimeout(resolve, 700))
        const read = await run(() => composerRead(page, prepared.before))
        lastRead = read
        const text = String(read?.text ?? '')
        if (text && !sawText) {
          sawText = true
          this.logger?.debug?.('my-model: the page started answering; relaying its reply from the DOM')
        }
        if (text && text !== last) {
          last = text
          stable = 0
          yield {
            message: {
              id: 'ui-assistant',
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: [text] },
            },
          }
        } else if (text) {
          stable += 700
        }
        const complete = read?.state === 'complete'
        if (text && (complete || stable >= 2500)) break
        if (!text && read?.state === 'pending' && Date.now() - startedAt > 30000) {
          // The click was accepted but the page never created an answer: a login
          // wall, an error banner, or a quota notice is the usual cause, and no
          // amount of polling will change it.
          throw new AdapterError(
            'ChatGPT Web page: the message was sent but no answer started within 30s ' +
              `(replies=${read?.replies ?? '?'}, pre-existing=${prepared.before}). Check the Chrome tab: a sign-in ` +
              'wall, an error banner, or a quota notice there stops the page from answering.',
            'UPSTREAM',
          )
        }
      }
      if (!last) {
        throw new AdapterError(
          `ChatGPT Web page: the reply did not arrive in time (replies=${lastRead?.replies ?? '?'}, ` +
            `state=${lastRead?.state ?? 'unknown'}).`,
          'TIMEOUT',
        )
      }
      return
    }
    if (this.transport === 'cdp') {
      const page = await this.cdpPage().catch((error) => {
        throw cdpErrorToAdapter(error)
      })
      const token = await this.currentToken()
      try {
        yield* streamInPage(page, CONVERSATION_PATH, {
          method: 'POST',
          headers: {
            accept: 'text/event-stream',
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'openai-sentinel-chat-requirements-token': requirementsToken,
          },
          body,
          signal,
        })
      } catch (error) {
        if (error?.code === 'HTTP_ERROR') {
          let detail = { status: 0, contentType: '', text: error.message }
          try {
            detail = JSON.parse(error.message)
          } catch {
            // Keep the raw text.
          }
          throw this.httpError(responseLike(detail.status, { 'content-type': detail.contentType }), detail.text)
        }
        if (error?.code === 'CLOSED') this.dropCdp()
        throw cdpErrorToAdapter(error)
      }
      return
    }
    yield* this.readSse(response, signal)
  }

  /** Map an upstream message to the provider-neutral failure codes. */
  classify(detail, status) {
    const message = textOf(detail).slice(0, 300)
    if (isStaleSessionText(message)) return staleSessionError(message, status)
    if (isRiskControlText(message)) return riskControlError(message, status)
    if (isModelNotFoundText(message)) {
      return new AdapterError(`ChatGPT Web does not serve this model: ${message}`, 'MODEL_NOT_FOUND', status)
    }
    if (isChallengeText(message)) return challengeError(status)
    if (isRateLimitText(message)) {
      return new AdapterError(`ChatGPT Web rate limit: ${message}`, 'RATE_LIMIT', status)
    }
    if (isQuotaText(message)) return new AdapterError(`ChatGPT Web quota is exhausted: ${message}`, 'QUOTA', status)
    if (isDisabledText(message)) {
      return new AdapterError(`ChatGPT Web account is unavailable: ${message}`, 'ACCOUNT_MUTED', status)
    }
    if (isTransientUpstreamText(message)) return transientUpstreamError(message, status)
    return new AdapterError(`ChatGPT Web upstream error: ${message}`, 'UPSTREAM', status)
  }

  httpError(response, body) {
    const status = response.status
    const detail = textOf(body).slice(0, 300)
    const retryAfterMs = retryAfterMsFromHeaders(response.headers)
    const cfMitigated = String(response.headers.get('cf-mitigated') ?? '').toLowerCase()
    if (cfMitigated === 'challenge' || (status === 403 && isChallengeText(detail))) {
      return challengeError(status)
    }
    // Checked before the credential branches: an HTML body means an interstitial
    // answered, and this 403 says nothing about the token.
    if (isHtmlBody(detail)) {
      this.logger?.warn?.(
        `my-model: ChatGPT returned HTML instead of JSON (HTTP ${status}, cf-ray ${response.headers.get('cf-ray') ?? 'n/a'}): ${detail.slice(0, 300)}`,
      )
      return blockedPageError(status, this.transport)
    }
    // Checked before the credential branches: this 403 means "we do not trust
    // this device", not "this token is wrong".
    if (isRiskControlText(detail)) {
      this.logger?.warn?.(
        `my-model: ChatGPT risk control rejected the request (HTTP ${status}, cf-ray ${response.headers.get('cf-ray') ?? 'n/a'})`,
      )
      return riskControlError(detail, status)
    }
    if (status === 401) {
      return new AdapterError(
        `ChatGPT Web rejected the credential (HTTP 401). Log in to chatgpt.com again and paste a fresh ` +
          `accessToken or cookie string. ${detail}`,
        'INVALID_CREDENTIAL',
        status,
      )
    }
    // A 403 is a credential rejection unless the body names a disabled account.
    if (status === 403) {
      if (isDisabledText(detail)) {
        return new AdapterError(
          `ChatGPT Web account is unavailable: ${detail}`,
          'ACCOUNT_MUTED',
          status,
        )
      }
      return new AdapterError(
        `ChatGPT Web rejected the credential (HTTP 403). Log in to chatgpt.com again and paste a fresh ` +
          `accessToken or cookie string. ${detail}`,
        'INVALID_CREDENTIAL',
        status,
      )
    }
    if (status === 429) {
      return new AdapterError(
        `ChatGPT Web rate limited this account (HTTP 429). ${detail}`,
        'RATE_LIMIT',
        status,
        { providerRetryAfterMs: retryAfterMs },
      )
    }
    const classified = this.classify(detail, status)
    if (classified.code !== 'UPSTREAM') {
      if (classified.code === 'RATE_LIMIT' && retryAfterMs) {
        return new AdapterError(classified.message, 'RATE_LIMIT', status, { providerRetryAfterMs: retryAfterMs })
      }
      return classified
    }
    if (status >= 500) {
      return new AdapterError(`ChatGPT Web server error (HTTP ${status}). ${detail}`, 'SERVER', status)
    }
    return new AdapterError(`ChatGPT Web request failed (HTTP ${status}). ${detail}`, 'UPSTREAM', status)
  }
}

function modelInfo(id) {
  const model = MODEL_BY_ID.get(id)
  if (!model) throw new AdapterError(`unknown ChatGPT Web model "${id}"`, 'INVALID_MODEL')
  return {
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    description: model.description,
    inputModalities: ['text'],
    context: { contextWindow: 400_000 },
    defaultMaxTokens: 8192,
    reasoning: {
      efforts: EFFORTS.map((effort) => ({ ...effort })),
      defaultEffort: model.defaultEffort,
    },
  }
}

/**
 * Harness `LlmAdapter` implementation for the ChatGPT web endpoints.
 * Duck-typed like the DeepSeek adapter, so the plugin needs no import of the
 * host's private LlmAdapter class.
 */
export class ChatGptWebAdapter {
  constructor({
    resolveToken,
    resolveCookies,
    baseURL,
    timeoutMs,
    modelSlug,
    userAgent,
    secChUa,
    secChUaPlatform,
    secChUaMobile,
    acceptLanguage,
    oaiLanguage,
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
    this.client = new ChatGptWebClient({
      baseURL,
      timeoutMs,
      userAgent,
      secChUa,
      secChUaPlatform,
      secChUaMobile,
      acceptLanguage,
      oaiLanguage,
      resolveToken,
      resolveCookies,
      logger,
    })
    this.modelSlug = typeof modelSlug === 'string' && modelSlug.trim() ? modelSlug.trim() : DEFAULT_MODEL_SLUG
    this.maxPromptChars = Math.max(20000, Number(maxPromptChars) || 400_000)
    this.maxToolChars = Math.max(500, Number(maxToolChars) || 8000)
    this.logger = logger
    this.sessions = new Map()
    this.lastFailure = null
    this.gate = new TurnScheduler({
      label: 'ChatGPT Web',
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
    // A new ChatGPT conversation has no server-side session yet: the first
    // request creates it and the response carries its id.
    return { sessionId: null, promptText: fullPrompt, parentMessageId: null, fullPrompt, cacheKey, reused: false }
  }

  remember(cacheKey, plan, state) {
    const sessionId = state?.conversationId
    const responseMessageId = state?.responseMessageId
    if (!cacheKey || !sessionId || responseMessageId === null || responseMessageId === undefined) return
    this.sessions.delete(cacheKey)
    this.sessions.set(cacheKey, {
      sessionId,
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
    if (!model) throw new AdapterError(`unknown ChatGPT Web model "${options.model}"`, 'INVALID_MODEL')
    const token = await this.client.currentToken()
    const prompt = buildTranscriptPrompt({
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      maxChars: this.maxPromptChars,
      maxToolChars: this.maxToolChars,
    })
    if (!prompt.trim()) throw new AdapterError('ChatGPT Web prompt is empty', 'INVALID_REQUEST')
    const cacheKey = options.sessionId
      ? `${options.sessionId}|${options.model}|${hashToken(token)}`
      : undefined
    // The pinned slug may be retired by the upstream; when that happens the turn
    // is retried once on `auto`, which the web UI itself falls back to.
    let modelSlug = this.modelSlug

    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let release
      let emitted = false
      let plan
      try {
        release = await this.gate.acquire(options.signal)
        plan = await this.planSession(cacheKey, prompt, attempt === 0)
        const state = { conversationId: null, responseMessageId: null, emitted: new Map() }
        for await (const chunk of this.client.conversationStream({
          conversationId: plan.sessionId,
          parentMessageId: plan.parentMessageId,
          prompt: plan.promptText,
          modelSlug,
          signal: options.signal,
          state,
        })) {
          emitted = true
          yield chunk
        }
        if (state.responseMessageId === null || state.responseMessageId === undefined) {
          if (cacheKey) this.sessions.delete(cacheKey)
        } else {
          this.remember(cacheKey, plan, state)
        }
        this.gate.noteSuccess()
        this.lastFailure = null
        return
      } catch (error) {
        lastError = error
        if (cacheKey && plan) this.sessions.delete(cacheKey)
        const upstreamRateLimit =
          error instanceof AdapterError && error.code === 'RATE_LIMIT' && error.fromGate !== true
        const cooldownMs = upstreamRateLimit ? this.gate.noteRateLimit(error.providerRetryAfterMs) : undefined
        const fallbackToAuto = error?.code === 'MODEL_NOT_FOUND' && modelSlug !== 'auto'
        const retryableFailure = retryable(error) || upstreamRateLimit || fallbackToAuto
        const stopping =
          options.signal?.aborted === true ||
          emitted ||
          attempt === 1 ||
          !retryableFailure ||
          error?.fromGate === true
        if (stopping) {
          if (error instanceof AdapterError && error.code !== 'ABORTED') {
            this.logger?.warn?.(`my-model: terminal failure ${error.code}: ${error.message}`)
            this.lastFailure = {
              code: error.code,
              message: String(error.message).slice(0, 300),
              at: Date.now(),
            }
          }
          if (emitted && error?.code !== 'ABORTED') throw this.streamInterrupted(error)
          if (upstreamRateLimit && cooldownMs > 0) {
            const seconds = Math.max(1, Math.ceil(cooldownMs / 1000))
            throw new AdapterError(
              /retry in \d+s/i.test(error.message) ? error.message : `${error.message} Retry in ${seconds}s.`,
              'RATE_LIMIT',
              error.status,
              { providerRetryAfterMs: cooldownMs },
            )
          }
          throw error
        }
        if (fallbackToAuto) {
          this.logger?.warn?.(
            `my-model: ChatGPT Web does not serve "${modelSlug}"; retrying once with the web default (auto)`,
          )
          modelSlug = 'auto'
        }
        if (upstreamRateLimit) {
          if (cooldownMs > this.gate.maxAutoWaitMs) {
            const seconds = Math.max(1, Math.ceil(cooldownMs / 1000))
            throw new AdapterError(`${error.message} Retry in ${seconds}s.`, 'RATE_LIMIT', error.status, {
              providerRetryAfterMs: cooldownMs,
            })
          }
          this.logger?.warn?.(
            `my-model: ChatGPT Web rate limited; waiting ${Math.ceil(cooldownMs / 1000)}s before retrying`,
          )
        } else {
          release?.()
          release = undefined
          const delay = Math.min(5000, 1200 * 2 ** attempt) * (0.8 + Math.random() * 0.4)
          this.logger?.warn?.(`my-model: retrying ChatGPT Web call after ${error.code}: ${error.message}`)
          await abortableSleep(delay, options.signal, 'ChatGPT Web')
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

export { MODELS as CHATGPT_MODELS }
