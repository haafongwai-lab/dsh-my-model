import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  ChatGptWebAdapter,
  ChatGptWebClient,
  MODELS,
  PROVIDER,
  normalizeAccessToken,
  parseDifficulty,
  solveProofOfWork,
} from '../chatgpt-web.js'
import { AdapterError } from '../deepseek-web.js'

// ---------------------------------------------------------------------------
// Credential normalisation and the proof-of-work gate.
// ---------------------------------------------------------------------------
assert.equal(normalizeAccessToken('Bearer abc'), 'abc')
assert.equal(normalizeAccessToken('{"accessToken":"abc"}'), 'abc')
assert.equal(normalizeAccessToken('{"access_token":"abc"}'), 'abc')
assert.equal(normalizeAccessToken('abc'), 'abc')
assert.equal(normalizeAccessToken(''), '')

assert.deepEqual(parseDifficulty('0717f3'), { text: '0717f3', width: 6 })
assert.deepEqual(parseDifficulty('0000'), { text: '0000', width: 4 })
assert.equal(parseDifficulty(''), null)

{
  const proof = await solveProofOfWork({ seed: 'seed-value', difficulty: '0717f3' })
  const head = createHash('sha3-512').update(`seed-value${proof.nonce}`).digest('hex').slice(0, 6)
  assert.ok(head <= '0717f3', 'the solved nonce satisfies the threshold')
  assert.equal(proof.algorithm, 'sha3-512')
  const encoded = Buffer.from(JSON.stringify(proof)).toString('base64')
  assert.equal(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')).nonce, proof.nonce)
  await assert.rejects(
    solveProofOfWork({ seed: 's', difficulty: '0717f3' }, { maxIterations: 0 }),
    (error) => error instanceof AdapterError && /did not converge/.test(error.message),
  )
}

// ---------------------------------------------------------------------------
// A stubbed upstream: session exchange, sentinel (with PoW), SSE conversation.
// ---------------------------------------------------------------------------
const calls = []

function sseResponse(frames) {
  const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).concat(['data: [DONE]\n\n']).join('')
  return new Response(Readable.toWeb(Readable.from([Buffer.from(text)])), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * @param {Record<string, (url:string, init:object, index:number) => object>} routes
 */
function stubFetch(routes) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url))
    const handler = routes[target.pathname]
    assert.ok(handler, `unexpected fetch ${target.pathname}`)
    const index = seen.filter((entry) => entry.path === target.pathname).length
    seen.push({ path: target.pathname, url: target.href, init })
    return handler(target, init, index)
  }
  return seen
}

{
  let requirementsCalls = 0
  const seen = stubFetch({
    '/api/auth/session': () => jsonResponse({ accessToken: 'exchanged-token', user: { email: 'a@b.c' } }),
    '/backend-api/sentinel/chat-requirements': () => {
      requirementsCalls += 1
      if (requirementsCalls === 1) {
        return jsonResponse({ token: 'ignored', proofofwork: { required: true, seed: 'pow-seed', difficulty: 3 } })
      }
      return jsonResponse({ token: 'sentinel-token', turnstile: { required: false } })
    },
    '/backend-api/conversation': (_url, init) => {
      assert.equal(init.headers.authorization, 'Bearer exchanged-token')
      assert.equal(init.headers['openai-sentinel-chat-requirements-token'], 'sentinel-token')
      const payload = JSON.parse(init.body)
      assert.equal(payload.action, 'next')
      assert.equal(payload.messages[0].content.parts[0], 'hello there')
      assert.equal(payload.conversation_mode.kind, 'primary_assistant')
      assert.equal(payload.model, 'gpt-6-luna')
      assert.ok(payload.websocket_request_id)
      return sseResponse([
        {
          conversation_id: 'conv-123',
          message: {
            id: 'msg-1',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['hello there'] },
          },
        },
        {
          message: {
            id: 'msg-2',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Hello'] },
          },
        },
        {
          message: {
            id: 'msg-2',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Hello, how can I help?'] },
          },
        },
      ])
    },
  })

  const client = new ChatGptWebClient({ token: '', cookies: 'oai-did=device-abc; other=1', logger: {} })
  const chunks = []
  const state = {}
  for await (const chunk of client.conversationStream({
    conversationId: null,
    parentMessageId: null,
    prompt: 'hello there',
    modelSlug: 'gpt-6-luna',
    state,
  })) {
    chunks.push(chunk)
  }
  assert.equal(requirementsCalls, 2, 'the proof of work triggers a second requirements call')
  assert.equal(state.conversationId, 'conv-123')
  assert.equal(state.responseMessageId, 'msg-2')
  // Cumulative frames must not be re-emitted in full.
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, 'Hello, how can I help?')
  assert.ok(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'stop'))
  const conversationCall = seen.filter((entry) => entry.path === '/backend-api/conversation').at(-1)
  assert.equal(conversationCall.init.headers['oai-device-id'], 'device-abc')
  assert.equal(JSON.parse(conversationCall.init.body).parent_message_id, 'client-created-root')
  assert.match(conversationCall.init.headers.referer, /^https:\/\/chatgpt\.com\/$/)
}

// Reasoning frames and DSML tool calls are handled the same way as DeepSeek.
{
  stubFetch({
    '/backend-api/sentinel/chat-requirements': () => jsonResponse({ token: 'tok' }),
    '/backend-api/conversation': () =>
      sseResponse([
        {
          message: {
            id: 'r-1',
            author: { role: 'assistant' },
            content: { content_type: 'thoughts', parts: ['think'] },
          },
        },
        {
          message: {
            id: 'r-1',
            author: { role: 'assistant' },
            content: { content_type: 'thoughts', parts: ['thinking about it'] },
          },
        },
        {
          message: {
            id: 'r-1',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Working on it.\n\n'] },
          },
        },
        {
          message: {
            id: 'r-1',
            author: { role: 'assistant' },
            content: {
              content_type: 'text',
              parts: ['Working on it.\n\n<|DSML|tool_calls>\n  <|DSML|invoke name="read">\n    <|DSML|parameter name="file_path"><![CDATA[a.ts]]></|DSML|parameter>\n  </|DSML|invoke>\n</|DSML|tool_calls>'],
            },
          },
        },
      ]),
  })

  const client = new ChatGptWebClient({ token: 'direct-token', logger: {} })
  const chunks = []
  for await (const chunk of client.conversationStream({ prompt: 'go', modelSlug: 'auto', state: {} })) {
    chunks.push(chunk)
  }
  const reasoning = chunks
    .filter((chunk) => chunk.type === 'reasoning-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(reasoning, 'thinking about it')
  const toolCall = chunks.find((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(toolCall.name, 'read')
  assert.equal(JSON.parse(toolCall.argumentsDelta).file_path, 'a.ts')
  assert.ok(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'tool-calls'))
}

// An empty completion is a retryable failure, not a silent "done".
{
  stubFetch({
    '/backend-api/sentinel/chat-requirements': () => jsonResponse({ token: 'tok' }),
    '/backend-api/conversation': () => sseResponse([]),
  })
  const client = new ChatGptWebClient({ token: 'direct-token' })
  await assert.rejects(
    (async () => {
      for await (const _chunk of client.conversationStream({ prompt: 'x', modelSlug: 'auto', state: {} })) {
        // no chunks expected
      }
    })(),
    (error) => error instanceof AdapterError && error.code === 'EMPTY_RESPONSE',
  )
}

// ---------------------------------------------------------------------------
// Failure classification.
// ---------------------------------------------------------------------------
{
  const client = new ChatGptWebClient({ token: 'direct-token' })
  const cases = [
    [new Response('', { status: 401 }), '', 'INVALID_CREDENTIAL'],
    [new Response('', { status: 403 }), '', 'INVALID_CREDENTIAL'],
    [new Response('', { status: 429, headers: { 'retry-after': '30' } }), '', 'RATE_LIMIT'],
    [new Response('', { status: 404 }), 'conversation not found', 'STALE_SESSION'],
    [new Response('', { status: 400 }), 'This conversation does not exist', 'STALE_SESSION'],
    [new Response('', { status: 400 }), 'rate limit reached', 'RATE_LIMIT'],
    [new Response('', { status: 400 }), 'You have reached your usage limit', 'QUOTA'],
    [new Response('', { status: 403 }), 'account deactivated', 'ACCOUNT_MUTED'],
    // OpenAI's bot protection answers 403 with this body; the token is fine, so
    // it must not be reported as a credential problem.
    [
      new Response('', { status: 403 }),
      '{"detail":"Unusual activity has been detected from your device. Try again later. (b43ae1c3-80f4-4b99-9d8b-52b8d5ef1943)"}',
      'RISK_CONTROL',
    ],
    [new Response('', { status: 500 }), 'model overloaded, try again later', 'SERVER'],
    [new Response('<html>just a moment</html>', { status: 403 }), '<html>just a moment</html>', 'WAF_CHALLENGE'],
    // An HTML body means an interstitial answered; it must not be reported as a
    // bad credential (a reported regression: the message told the user to
    // re-paste a token that was fine).
    [
      new Response('', { status: 403 }),
      '<html><head><meta name="viewport" content="width=device-width" /></head><body>blocked</body></html>',
      'WAF_CHALLENGE',
    ],
    [new Response('', { status: 400 }), 'turnstile required', 'WAF_CHALLENGE'],
    [new Response('', { status: 400 }), 'random failure', 'UPSTREAM'],
  ]
  for (const [response, body, expected] of cases) {
    assert.equal(client.httpError(response, body).code, expected, `HTTP ${response.status} classification`)
  }
  const rateLimit = client.httpError(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }), 'slow down')
  assert.equal(rateLimit.code, 'RATE_LIMIT')
  assert.equal(rateLimit.providerRetryAfterMs, 30000)
  assert.equal(client.classify('conversation not found').code, 'STALE_SESSION')

  // The risk-control message keeps the upstream trace id and tells the user not
  // to re-paste credentials.
  const risk = client.httpError(
    new Response('', { status: 403 }),
    '{"detail":"Unusual activity has been detected from your device. Try again later. (b43ae1c3-80f4-4b99-9d8b-52b8d5ef1943)"}',
  )
  assert.equal(risk.code, 'RISK_CONTROL')
  assert.match(risk.message, /b43ae1c3-80f4-4b99-9d8b-52b8d5ef1943/)
  assert.match(risk.message, /not the problem/)
  assert.equal(client.classify('Unusual activity has been detected from your device.').code, 'RISK_CONTROL')

  // HTML interstitials are recognised by shape, not by keyword.
  const html = client.httpError(
    new Response('', { status: 403 }),
    '<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body></body></html>',
  )
  assert.equal(html.code, 'WAF_CHALLENGE')
  assert.match(html.message, /HTML page instead of JSON/)
  assert.doesNotMatch(html.message, /paste a fresh/i)
}

// A Turnstile-only gate is reported as an actionable challenge, not an upstream error.
{
  stubFetch({
    '/backend-api/sentinel/chat-requirements': () =>
      jsonResponse({ turnstile: { required: true }, proofofwork: { required: false } }),
  })
  const client = new ChatGptWebClient({ token: 'direct-token' })
  await assert.rejects(
    () => client.chatRequirements(),
    (error) =>
      error instanceof AdapterError &&
      error.code === 'CHALLENGE_REQUIRED' &&
      /Cookie/.test(error.message),
  )
}

// ---------------------------------------------------------------------------
// Adapter surface: models, session reuse, and in-turn recovery.
// ---------------------------------------------------------------------------
{
  const adapter = new ChatGptWebAdapter({ resolveToken: async () => 'test' })
  const models = await adapter.listModels()
  assert.equal(models.length, MODELS.length)
  assert.ok(models.every((model) => model.provider === PROVIDER))
  assert.equal((await adapter.resolveModel(PROVIDER, 'chatgpt-web-chat')).id, 'chatgpt-web-chat')
  const prepared = await adapter.prepareCall(PROVIDER, 'chatgpt-web-chat')
  assert.equal(typeof prepared.stream, 'function')

  // First turn opens a conversation; the second reuses it with only the tail.
  const seenPlans = []
  let turn = 0
  adapter.client = {
    async currentToken() {
      return 'test'
    },
    async *conversationStream(input) {
      seenPlans.push(input)
      turn += 1
      input.state.conversationId = 'conv-x'
      input.state.responseMessageId = turn === 1 ? 'm1' : 'm2'
      yield { type: 'text-delta', index: 1, text: `turn ${turn}` }
    },
  }
  const options = {
    model: 'chatgpt-web-chat',
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    sessionId: 'session-1',
  }
  for await (const _chunk of adapter.stream(options)) {
    // drain
  }
  assert.equal(seenPlans.at(-1)?.conversationId, null, 'the first turn has no conversation yet')
  for await (const _chunk of adapter.stream(options)) {
    // drain
  }
  const second = seenPlans.at(-1)
  assert.equal(second.conversationId, 'conv-x', 'the second turn reuses the conversation')
  assert.equal(second.parentMessageId, 'm1', 'the second turn continues from the last message')
  assert.match(second.prompt, /hi/, 'the reused turn sends the transcript tail')

  // A conversation the server dropped is recreated inside the same turn.
  const recovery = new ChatGptWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 0,
    humanizePacing: false,
  })
  const warnings = []
  recovery.logger = { warn: (message) => warnings.push(String(message)) }
  let attempts = 0
  recovery.client = {
    async currentToken() {
      return 'test'
    },
    async *conversationStream(input) {
      attempts += 1
      if (attempts === 1) {
        throw new AdapterError('ChatGPT Web rejected the cached conversation (not found)', 'STALE_SESSION', 404)
      }
      input.state.conversationId = 'conv-fresh'
      input.state.responseMessageId = 'm9'
      yield { type: 'text-delta', index: 1, text: 'recovered' }
    },
  }
  const chunks = []
  for await (const chunk of recovery.stream(options)) {
    chunks.push(chunk)
  }
  assert.equal(attempts, 2, 'the stale conversation is retried once')
  assert.ok(chunks.some((chunk) => chunk.text === 'recovered'))
  assert.ok(warnings.some((message) => message.includes('after STALE_SESSION')), 'the recovery is logged')
  assert.equal(recovery.lastFailure, null, 'a recovered turn clears the reported failure')
}

// An exchanged token can expire while the cookie blob stays valid: the client
// exchanges once more and retries instead of failing the turn.
{
  let sessions = 0
  let conversations = 0
  stubFetch({
    '/api/auth/session': () => {
      sessions += 1
      return jsonResponse({ accessToken: sessions === 1 ? 'stale-token' : 'fresh-token' })
    },
    '/backend-api/sentinel/chat-requirements': () => jsonResponse({ token: 'sentinel' }),
    '/backend-api/conversation': (_url, init) => {
      conversations += 1
      if (conversations === 1) {
        assert.equal(init.headers.authorization, 'Bearer stale-token')
        return new Response('', { status: 401 })
      }
      assert.equal(init.headers.authorization, 'Bearer fresh-token')
      return sseResponse([
        { message: { id: 'm', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['ok'] } } },
      ])
    },
  })
  const client = new ChatGptWebClient({ cookies: '__Secure-next-auth.session-token=live' })
  const chunks = []
  for await (const chunk of client.conversationStream({ prompt: 'hello', modelSlug: 'auto', state: {} })) {
    chunks.push(chunk)
  }
  assert.equal(conversations, 2, 'the expired token is exchanged once and the request retried')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'ok'))
}

// Test connection with a pasted accessToken must not require a cookie blob:
// no session exchange, just the sentinel probe.
{
  let sessions = 0
  stubFetch({
    '/api/auth/session': () => {
      sessions += 1
      return jsonResponse({})
    },
    '/backend-api/sentinel/chat-requirements': () => jsonResponse({ token: 'tok', turnstile: { required: false } }),
  })
  const client = new ChatGptWebClient({ token: 'Bearer direct-token' })
  const result = await client.testAuth()
  assert.equal(sessions, 0, 'a pasted token does not hit /api/auth/session')
  assert.ok(result.latencyMs >= 0)
  assert.equal(result.email, undefined)
}

// Cookies that are no longer signed in are reported as a credential problem.
{
  stubFetch({ '/api/auth/session': () => jsonResponse({}) })
  const client = new ChatGptWebClient({ cookies: 'stale=1' })
  await assert.rejects(
    () => client.testAuth(),
    (error) => error instanceof AdapterError && error.code === 'INVALID_CREDENTIAL',
  )
}

// A retired model slug (the 2026-10-14 GPT-5.5 class of problem) falls back to
// `auto` inside the same turn instead of failing it.
{
  const models = []
  const warnings = []
  stubFetch({
    '/backend-api/sentinel/chat-requirements': () => jsonResponse({ token: 'tok' }),
    '/backend-api/conversation': (_url, init) => {
      const slug = JSON.parse(init.body).model
      models.push(slug)
      if (slug !== 'auto') {
        return new Response('The model does not exist or you do not have access to it.', { status: 400 })
      }
      return sseResponse([
        { message: { id: 'm', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['ok'] } } },
      ])
    },
  })
  const adapter = new ChatGptWebAdapter({
    resolveToken: async () => 'direct-token',
    modelSlug: 'gpt-6-luna',
    minTurnGapMs: 0,
    maxAutoWaitMs: 0,
    humanizePacing: false,
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'chatgpt-web-chat',
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
  })) {
    chunks.push(chunk)
  }
  assert.deepEqual(models, ['gpt-6-luna', 'auto'], 'the pinned slug is retried once on auto')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'ok'))
  assert.ok(
    warnings.some((message) => message.includes('retrying once with the web default')),
    'the fallback is logged',
  )
  assert.equal(adapter.lastFailure, null, 'a recovered turn clears the reported failure')

  // A slug that is gone even under auto stays terminal.
  stubFetch({
    '/backend-api/sentinel/chat-requirements': () => jsonResponse({ token: 'tok' }),
    '/backend-api/conversation': () =>
      new Response('The model does not exist or you do not have access to it.', { status: 400 }),
  })
  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream({
        model: 'chatgpt-web-chat',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
      })) {
        // nothing expected
      }
    })(),
    (error) => error.code === 'MODEL_NOT_FOUND',
  )
}

// After a challenge that could not be solved, the client must fail fast instead
// of spending the whole CPU budget again on every turn.
{
  const client = new ChatGptWebClient({ token: 'direct-token' })
  client.powBlockedUntil = Date.now() + 60_000
  await assert.rejects(
    () => client.chatRequirements(),
    (error) => error instanceof AdapterError && error.code === 'CHALLENGE_UNSOLVED' && /skipping the attempt/.test(error.message),
  )
}

console.log('chatgpt-smoke: ok')
