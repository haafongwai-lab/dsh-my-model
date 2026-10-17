import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { AdapterError, DeepSeekWebAdapter, DeepSeekWebClient, TurnScheduler } from '../deepseek-web.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The client-version header is configurable so a web-app bump does not require
// a code edit; the referer matches the deployed web app.
{
  const client = new DeepSeekWebClient({ token: 'test', clientVersion: '9.9.9' })
  const headers = client.baseHeaders('test')
  assert.equal(headers['x-client-version'], '9.9.9')
  assert.equal(headers.referer, 'https://chat.deepseek.com/a/chat/')
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

// One turn at a time, with a minimum gap between turn starts.
{
  const scheduler = new TurnScheduler({
    maxConcurrentTurns: 1,
    minTurnGapMs: 60,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 50,
    maxCooldownMs: 500,
    minCooldownMs: 20,
    jitterRatio: 0,
  })
  const started = Date.now()
  const release1 = await scheduler.acquire()
  const second = scheduler.acquire()
  await sleep(15)
  assert.equal(scheduler.active, 1, 'the second turn waits for the first')
  release1()
  const release2 = await second
  const gap = Date.now() - started
  assert.ok(gap >= 55, `turn starts are spaced (waited ${gap}ms)`)
  assert.equal(scheduler.active, 1)
  release2()
  assert.equal(scheduler.active, 0)
}

// A short cooldown is absorbed by waiting inside the turn.
{
  const scheduler = new TurnScheduler({
    minTurnGapMs: 0,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 50,
    maxCooldownMs: 500,
    minCooldownMs: 60,
    jitterRatio: 0,
  })
  scheduler.noteRateLimit(120)
  const started = Date.now()
  const release = await scheduler.acquire()
  const waited = Date.now() - started
  assert.ok(waited >= 100, `cooldown was awaited (${waited}ms)`)
  release()
}

// A long cooldown fails fast with a retry hint instead of blocking the UI.
{
  const scheduler = new TurnScheduler({
    minTurnGapMs: 0,
    maxAutoWaitMs: 20,
    cooldownBaseMs: 100,
    maxCooldownMs: 500,
    minCooldownMs: 10,
    jitterRatio: 0,
  })
  scheduler.noteRateLimit(200)
  let error
  try {
    await scheduler.acquire()
  } catch (caught) {
    error = caught
  }
  assert.ok(error, 'long cooldown rejects')
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.fromGate, true)
  assert.ok(error.providerRetryAfterMs > 100)
  assert.equal(error.failure.code, 'RATE_LIMIT')
  assert.ok(error.failure.providerRetryAfterMs > 100)
}

// A successful turn clears the cooldown.
{
  const scheduler = new TurnScheduler({
    minTurnGapMs: 0,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 100,
    maxCooldownMs: 1000,
    minCooldownMs: 10,
    jitterRatio: 0,
  })
  scheduler.noteRateLimit(100)
  assert.ok(scheduler.cooldownRemainingMs > 0)
  scheduler.noteSuccess()
  assert.equal(scheduler.cooldownRemainingMs, 0)
  const release = await scheduler.acquire()
  release()
}

// HTTP 429 with Retry-After becomes a retryable RATE_LIMIT failure that the
// host can route (the `failure` object is what @deepseek-ai/dsh-llm reads).
{
  const client = new DeepSeekWebClient({ token: 'test' })
  const response = new Response('', { status: 429, headers: { 'retry-after': '2' } })
  const error = client.httpError(response, 'slow down')
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.providerRetryAfterMs, 2000)
  assert.deepEqual(error.failure, {
    message: error.message,
    code: 'RATE_LIMIT',
    status: 429,
    providerRetryAfterMs: 2000,
  })
}

// The JSON envelope path carries Retry-After too.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  const response = jsonResponse({ code: 429, msg: 'Too Many Requests' }, 429, { 'retry-after': '1' })
  await assert.rejects(client.readJson(response), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.providerRetryAfterMs, 1000)
    assert.equal(error.failure.providerRetryAfterMs, 1000)
    return true
  })
}

// A non-JSON 429 (common for CDN/WAF pages) still classifies as retryable.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  const response = new Response('<html>rate limited</html>', {
    status: 429,
    headers: { 'retry-after': '3' },
  })
  await assert.rejects(client.readJson(response), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.providerRetryAfterMs, 3000)
    return true
  })
}

// Quota exhaustion and a muted account are terminal, not something to retry
// with exponential backoff forever.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  const quota = client.codeError({ code: 50001, msg: '今日免费额度已用完' }, 200)
  assert.equal(quota.code, 'QUOTA')
  const muted = client.codeError({ code: 50002, msg: '账号已被静音，请稍后再试' }, 200)
  assert.equal(muted.code, 'ACCOUNT_MUTED')
  const rate = client.codeError({ code: 50003, msg: '请求过于频繁' }, 200)
  assert.equal(rate.code, 'RATE_LIMIT')
}

// Session creation no longer spends a PoW challenge when the upstream accepts
// a bare request (the deployed web client does).
{
  const client = new DeepSeekWebClient({ token: 'test' })
  const calls = []
  let powCalls = 0
  client.powHeader = async () => {
    powCalls += 1
    return 'pow'
  }
  client.request = async (path, body, options = {}) => {
    calls.push({ path, body, pow: options.headers?.['x-ds-pow-response'] })
    return jsonResponse({ code: 0, data: { biz_data: { id: 'session-1' } } })
  }
  assert.equal(await client.createSession(), 'session-1')
  assert.equal(powCalls, 0, 'the cheap path does not solve a PoW')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/v0/chat_session/create')
  assert.equal(calls[0].pow, undefined)
  assert.equal(client.sessionPoW, false)
}

// A deployment that still requires PoW is detected once, then remembered.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  const calls = []
  let first = true
  client.powHeader = async () => 'pow-token'
  client.request = async (path, body, options = {}) => {
    calls.push(options.headers?.['x-ds-pow-response'])
    if (first) {
      first = false
      return new Response('missing pow', { status: 400 })
    }
    return jsonResponse({ code: 0, data: { biz_data: { id: 'session-2' } } })
  }
  assert.equal(await client.createSession(), 'session-2')
  assert.deepEqual(calls, [undefined, 'pow-token'])
  assert.equal(client.sessionPoW, true)

  calls.length = 0
  assert.equal(await client.createSession(), 'session-2')
  assert.deepEqual(calls, ['pow-token'], 'the fallback is remembered for the process')
}

// A 200 error envelope on the bare path also falls back instead of failing.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  client.powHeader = async () => 'pow-token'
  client.request = async (path, body, options = {}) => {
    if (options.headers?.['x-ds-pow-response']) {
      return jsonResponse({ code: 0, data: { biz_data: { id: 'session-3' } } })
    }
    return jsonResponse({ code: 50000, msg: 'target_path is required' })
  }
  assert.equal(await client.createSession(), 'session-3')
  assert.equal(client.sessionPoW, true)
}

// Rate limits are not retried in a hot loop inside the adapter; the failure is
// handed to the host with an accurate wait.
{
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 0,
    cooldownBaseMs: 40,
    maxCooldownMs: 100,
    jitterRatio: 0,
  })
  let creates = 0
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async createSession() {
      creates += 1
      throw new AdapterError('DeepSeek Web rate limit: slow down', 'RATE_LIMIT', 429)
    },
    async completionStream() {
      throw new Error('unreachable')
    },
  }
  const run = async () => {
    for await (const _chunk of adapter.stream({
      model: 'deepseek-web-chat',
      system: 'You are a test.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      sessionId: 'session-a',
    })) {
      // no chunks expected
    }
  }
  await assert.rejects(run(), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    assert.ok(error.providerRetryAfterMs >= 20, `retry hint ${error.providerRetryAfterMs}`)
    assert.equal(error.failure.code, 'RATE_LIMIT')
    assert.ok(error.failure.providerRetryAfterMs >= 20)
    assert.match(error.message, /Retry in \d+s/i)
    return true
  })
  assert.equal(creates, 1, 'a rate limit must not be retried hot')
}

// Adapter-level integration: two Harness consumers share one account slot.
{
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxConcurrentTurns: 1,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 100,
    maxCooldownMs: 500,
    jitterRatio: 0,
  })
  let sessions = 0
  let active = 0
  let maxActive = 0
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async createSession() {
      sessions += 1
      return `session-${sessions}`
    },
    async *completionStream({ state }) {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        state.responseMessageId = 1
        yield { type: 'text-delta', index: 1, text: 'ok' }
        await sleep(30)
      } finally {
        active -= 1
      }
    },
  }
  const run = async (sessionId) => {
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'deepseek-web-chat',
      system: 'You are a test.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      sessionId,
    })) {
      chunks.push(chunk)
    }
    return chunks
  }
  const [first, second] = await Promise.all([run('session-one'), run('session-two')])
  assert.ok(first.length > 0 && second.length > 0)
  assert.equal(maxActive, 1, 'the adapter serializes turns for the account')
}

// A short rate-limit cooldown is absorbed inside the turn instead of surfacing
// a failure to the host.
{
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 50,
    maxCooldownMs: 500,
    jitterRatio: 0,
  })
  let creates = 0
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async createSession() {
      creates += 1
      if (creates === 1) throw new AdapterError('DeepSeek Web rate limit: slow down', 'RATE_LIMIT')
      return 'session-retry'
    },
    async *completionStream({ state }) {
      state.responseMessageId = 1
      yield { type: 'text-delta', index: 1, text: 'ok' }
    },
  }
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'deepseek-web-chat',
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    sessionId: 'session-retry',
  })) {
    chunks.push(chunk)
  }
  assert.equal(creates, 2, 'the short cooldown is retried inside the turn')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'ok'))
  assert.equal(adapter.gate.cooldownRemainingMs, 0, 'success clears the cooldown')
}

// A turn rejected by the cooldown gate must keep the healthy cached session,
// otherwise the host's retry would rebuild the full transcript.
{
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 0,
    cooldownBaseMs: 100,
    maxCooldownMs: 500,
    jitterRatio: 0,
  })
  adapter.client = {
    async currentToken() {
      return 'test'
    },
  }
  const tokenHash = createHash('sha256').update('test').digest('hex').slice(0, 16)
  const cacheKey = `session-keep|deepseek-web-chat|${tokenHash}`
  adapter.sessions.set(cacheKey, {
    sessionId: 'web-session-keep',
    prompt: 'old prompt',
    responseMessageId: 7,
    at: Date.now(),
  })
  adapter.gate.noteRateLimit(200)
  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream({
        model: 'deepseek-web-chat',
        system: 'You are a test.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        sessionId: 'session-keep',
      })) {
        // no chunks expected
      }
    })(),
    (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      return true
    },
  )
  assert.ok(adapter.sessions.has(cacheKey), 'a gate rejection keeps the cached web session')
}

// A failure after output started is terminal and must not be retried by the
// host (that would duplicate visible text); the cooldown still applies.
{
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 100,
    maxCooldownMs: 500,
    jitterRatio: 0,
  })
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async createSession() {
      return 'session-b'
    },
    async *completionStream() {
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: 'partial' }
      throw new AdapterError('DeepSeek Web rate limit: slow down', 'RATE_LIMIT')
    },
  }
  const chunks = []
  await assert.rejects(
    (async () => {
      for await (const chunk of adapter.stream({
        model: 'deepseek-web-chat',
        system: 'You are a test.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        sessionId: 'session-c',
      })) {
        chunks.push(chunk)
      }
    })(),
    (error) => {
      assert.equal(error.code, 'STREAM_INTERRUPTED')
      assert.equal(error.failure.code, 'STREAM_INTERRUPTED')
      return true
    },
  )
  assert.equal(chunks.length, 2)
  assert.ok(adapter.gate.cooldownRemainingMs > 0, 'a partial failure still cools down the next turn')
}

console.log('rate-limit: ok')
