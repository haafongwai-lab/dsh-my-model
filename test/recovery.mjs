import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { AdapterError, DeepSeekWebAdapter, DeepSeekWebClient } from '../deepseek-web.js'

const drain = async (adapter, options) => {
  for await (const _chunk of adapter.stream(options)) {
    // draining the generator
  }
}

// A chat session the server already dropped or expired used to surface as a
// generic UPSTREAM failure, which nothing retries — one stale cache entry
// killed the provider until the adapter was reloaded. It must now be
// recognised and healed inside the same turn.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  const stale = [
    '会话不存在',
    '该对话已过期',
    'chat session not found',
    'The chat_session_id is invalid',
    'session expired',
  ]
  for (const message of stale) {
    const fromJson = client.codeError({ code: 400, msg: message })
    assert.equal(fromJson.code, 'STALE_SESSION', `JSON body: ${message}`)
    const fromHttp = client.httpError(new Response(message, { status: 400 }), message)
    assert.equal(fromHttp.code, 'STALE_SESSION', `HTTP body: ${message}`)
  }
  // Unrelated upstream failures must keep their meaning.
  assert.equal(client.codeError({ code: 400, msg: 'parameter error' }).code, 'UPSTREAM')
  assert.equal(client.codeError({ code: 40003, msg: 'invalid token' }).code, 'INVALID_CREDENTIAL')
  assert.equal(client.httpError(new Response('rate limit reached', { status: 429 }), 'rate limit reached').code, 'RATE_LIMIT')
  assert.equal(client.httpError(new Response('account muted', { status: 403 }), 'account muted').code, 'ACCOUNT_MUTED')
}

// The retry drops the cached session and asks for a fresh one, so a turn that
// ran while the user was away (or busy in another model) recovers on its own.
{
  const warnings = []
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 0,
    cooldownBaseMs: 50,
    maxCooldownMs: 500,
    jitterRatio: 0,
    humanizePacing: false,
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  const tokenHash = createHash('sha256').update('test').digest('hex').slice(0, 16)
  const cacheKey = `session-recover|deepseek-web-chat|${tokenHash}`

  let creates = 0
  let completions = 0
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async createSession() {
      creates += 1
      return `web-session-fresh-${creates}`
    },
    async *completionStream(input) {
      completions += 1
      if (completions === 1) {
        throw new AdapterError(
          'DeepSeek Web rejected the cached chat session (会话不存在); starting a fresh session.',
          'STALE_SESSION',
          400,
        )
      }
      input.state.responseMessageId = 9
      yield { type: 'text-delta', index: 1, text: 'recovered' }
    },
  }
  const streamOptions = {
    model: 'deepseek-web-chat',
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    sessionId: 'session-recover',
  }
  const chunks = []
  for await (const chunk of adapter.stream(streamOptions)) {
    chunks.push(chunk)
  }
  assert.equal(creates, 2, 'the retry creates a fresh session instead of reusing the stale one')
  assert.equal(adapter.sessions.get(cacheKey)?.sessionId, 'web-session-fresh-2', 'the stale entry is replaced')
  assert.ok(chunks.some((chunk) => chunk.text === 'recovered'))
  assert.equal(adapter.lastFailure, null, 'a recovered turn clears the reported failure')
  assert.ok(
    warnings.some((message) => message.includes('after STALE_SESSION')),
    'the recovery is logged',
  )
  // The healthy replacement is reused by the next turn.
  await drain(adapter, streamOptions)
  assert.equal(creates, 2, 'the fresh session is reused afterwards')
}

// Switching providers (official API <-> web) must not drop a web conversation:
// each web model keeps its own cached session, and switching back reuses it
// instead of starting over.
{
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 0,
    jitterRatio: 0,
    humanizePacing: false,
  })
  let creates = 0
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async createSession() {
      creates += 1
      return `web-session-${creates}`
    },
    async *completionStream(input) {
      input.state.responseMessageId = 1
      yield { type: 'text-delta', index: 1, text: 'ok' }
    },
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const options = (model) => ({
    model,
    system: 'You are a test.',
    messages,
    tools: [],
    sessionId: 'session-switch',
  })
  await drain(adapter, options('deepseek-web-chat'))
  await drain(adapter, options('deepseek-web-search'))
  await drain(adapter, options('deepseek-web-chat'))
  assert.equal(creates, 2, 'switching back reuses the cached session instead of creating a third')
  assert.equal(adapter.sessions.size, 2, 'one cache entry per web model')
}

// Every stopping cause is logged and reported to the settings page — including
// a rate limit that survives the retry budget, which used to be silent.
{
  const warnings = []
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 100000,
    cooldownBaseMs: 50,
    maxCooldownMs: 500,
    jitterRatio: 0,
    humanizePacing: false,
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  let creates = 0
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async createSession() {
      creates += 1
      return `web-session-${creates}`
    },
    async *completionStream() {
      throw new AdapterError('DeepSeek Web rate limit: slow down', 'RATE_LIMIT', 429)
    },
  }
  const streamOptions = {
    model: 'deepseek-web-chat',
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    sessionId: 'session-ratelimit',
  }
  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream(streamOptions)) {
        // nothing expected
      }
    })(),
    (error) => {
      assert.equal(error.code, 'RATE_LIMIT')
      return true
    },
  )
  assert.ok(
    warnings.some((message) => message.includes('terminal failure RATE_LIMIT')),
    'a terminal rate limit is logged',
  )
  assert.equal(adapter.lastFailure?.code, 'RATE_LIMIT')
  assert.ok(adapter.lastFailure?.message.includes('slow down'))
  assert.ok(Number.isFinite(adapter.lastFailure?.at))
}

console.log('recovery: ok')
