import assert from 'node:assert/strict'
import { DeepSeekWebAdapter, DeepSeekWebClient } from '../deepseek-web.js'

function sseResponse(frames) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(client, input) {
  const chunks = []
  for await (const chunk of client.completionStream(input)) chunks.push(chunk)
  return chunks
}

{
  const client = new DeepSeekWebClient({ token: 'test' })
  client.powHeader = async () => 'pow'
  client.request = async () =>
    sseResponse([
      { response_message_id: 42 },
      { v: { response: { fragments: [{ type: 'THINK', content: 'think ' }] } } },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: 'more' },
      { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE' }] },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: 'Hello ' },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: 'world' },
      { p: 'response/status', v: 'FINISHED' },
    ])
  const state = {}
  const chunks = await collect(client, {
    sessionId: 's1',
    parentMessageId: null,
    prompt: 'hi',
    thinking: true,
    search: false,
    state,
  })
  assert.equal(state.responseMessageId, 42)
  assert.ok(chunks.some((chunk) => chunk.type === 'reasoning-delta' && chunk.text === 'think '))
  assert.ok(chunks.some((chunk) => chunk.type === 'reasoning-delta' && chunk.text === 'more'))
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, 'Hello world')
  const finish = chunks.at(-1)
  assert.deepEqual(finish, { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(chunks.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'reasoning'))
  assert.ok(chunks.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'))
}

{
  const client = new DeepSeekWebClient({ token: 'test' })
  client.powHeader = async () => 'pow'
  client.request = async () =>
    sseResponse([
      { response_message_id: 7 },
      {
        p: 'response/content',
        o: 'APPEND',
        v: 'Before.\n<|DSML|tool_calls>\n  <|DSML|invoke name="read">\n    <|DSML|parameter name="file_path"><![CDATA[a.ts]]></|DSML|parameter>\n  </|DSML|invoke>\n</|DSML|tool_calls>',
      },
      { p: 'response/status', v: 'FINISHED' },
    ])
  const chunks = await collect(client, {
    sessionId: 's2',
    parentMessageId: 7,
    prompt: 'read',
    thinking: false,
    search: false,
    state: {},
  })
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, 'Before.\n')
  const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(toolEnd, 'tool call block emitted')
  assert.equal(toolEnd.block.name, 'read')
  assert.deepEqual(JSON.parse(toolEnd.block.arguments), { file_path: 'a.ts' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
}

// A rejected PoW challenge is retried once with a freshly solved challenge.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  let powCalls = 0
  client.powHeader = async () => {
    powCalls += 1
    return `pow-${powCalls}`
  }
  let calls = 0
  client.request = async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ code: 40002, msg: 'challenge expired' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return sseResponse([
      { response_message_id: 9 },
      { p: 'response/content', o: 'APPEND', v: 'ok' },
      { p: 'response/status', v: 'FINISHED' },
    ])
  }
  const chunks = []
  for await (const chunk of client.completionStream({
    sessionId: 's3',
    parentMessageId: null,
    prompt: 'hi',
    thinking: false,
    search: false,
    state: {},
  })) {
    chunks.push(chunk)
  }
  assert.equal(powCalls, 2, 'a fresh PoW was solved for the retry')
  assert.equal(calls, 2)
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'ok'))
}

// A WAF challenge served as 200 + HTML on the completion endpoint is
// classified as WAF_CHALLENGE, not an empty completion.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  client.powHeader = async () => 'pow'
  client.request = async () =>
    new Response('<html><body>HWWAF 人机验证</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html', server: 'CW' },
    })
  await assert.rejects(
    (async () => {
      for await (const _chunk of client.completionStream({
        sessionId: 's4',
        parentMessageId: null,
        prompt: 'hi',
        thinking: false,
        search: false,
        state: {},
      })) {
        // no chunks expected
      }
    })(),
    (error) => {
      assert.equal(error.code, 'WAF_CHALLENGE')
      return true
    },
  )
}

// A transient upstream toast ("服务器暂时不可用") arrives as an in-stream error
// frame with no HTTP status to key on. It must be classified SERVER
// (retryable with a bounded delay), not terminal UPSTREAM.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  client.powHeader = async () => 'pow'
  client.request = async () => sseResponse([{ type: 'error', content: '服务器暂时不可用' }])
  await assert.rejects(
    (async () => {
      for await (const _chunk of client.completionStream({
        sessionId: 's5',
        parentMessageId: null,
        prompt: 'hi',
        thinking: false,
        search: false,
        state: {},
      })) {
        // no chunks expected
      }
    })(),
    (error) => {
      assert.equal(error.code, 'SERVER')
      assert.equal(error.providerRetryAfterMs, 5000)
      assert.ok(error.message.includes('temporarily unavailable'))
      return true
    },
  )
}

// End to end: a transient error frame on the first completion attempt is
// retried in-turn and the second attempt succeeds, without duplicating output.
{
  const warnings = []
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 50,
    maxCooldownMs: 200,
    jitterRatio: 0,
    humanizePacing: false,
    logger: { warn: (message) => warnings.push(String(message)), debug: () => {} },
  })
  adapter.client.powHeader = async () => 'pow'
  let calls = 0
  adapter.client.request = async (_path, _body, options) => {
    if (options?.accept === 'text/event-stream') {
      calls += 1
      if (calls === 1) return sseResponse([{ type: 'error', content: '服务器暂时不可用' }])
      return sseResponse([
        { response_message_id: 9 },
        { p: 'response/content', o: 'APPEND', v: 'recovered' },
        { p: 'response/status', v: 'FINISHED' },
      ])
    }
    return new Response(JSON.stringify({ code: 0, data: { biz_data: { id: 'sess-transient' } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'deepseek-web-chat',
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    sessionId: 'session-transient',
  })) {
    chunks.push(chunk)
  }
  assert.equal(calls, 2, 'the transient failure was retried once')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'recovered'))
  assert.ok(
    warnings.some((message) => message.includes('retrying DeepSeek Web call after SERVER')),
    'the retry is visible in the plugin log',
  )
  assert.ok(
    !warnings.some((message) => message.includes('terminal failure')),
    'a recovered transient failure is not a terminal failure',
  )
}

// A transient error frame arriving after output has started stays terminal:
// retrying would duplicate visible text on screen.
{
  const adapter = new DeepSeekWebAdapter({
    resolveToken: async () => 'test',
    minTurnGapMs: 0,
    maxAutoWaitMs: 1000,
    cooldownBaseMs: 50,
    maxCooldownMs: 200,
    jitterRatio: 0,
    humanizePacing: false,
  })
  adapter.client.powHeader = async () => 'pow'
  let calls = 0
  adapter.client.request = async (_path, _body, options) => {
    if (options?.accept === 'text/event-stream') {
      calls += 1
      return sseResponse([
        { response_message_id: 9 },
        { p: 'response/content', o: 'APPEND', v: 'partial' },
        { type: 'error', content: '服务器暂时不可用' },
      ])
    }
    return new Response(JSON.stringify({ code: 0, data: { biz_data: { id: 'sess-partial' } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const chunks = []
  await assert.rejects(
    (async () => {
      for await (const chunk of adapter.stream({
        model: 'deepseek-web-chat',
        system: 'You are a test.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        sessionId: 'session-partial',
      })) {
        chunks.push(chunk)
      }
    })(),
    (error) => {
      assert.equal(error.code, 'STREAM_INTERRUPTED')
      return true
    },
  )
  assert.equal(calls, 1, 'no retry once output has started')
}

// Screenshot-reported failure (2026-10-18): a thinking turn whose content was
// routed entirely into the reasoning channel — the answer channel came up
// empty, no tool ran, and the turn still ended with `finish: stop`, so the
// user got nothing after 39 s. The recovery promotes DSML tool calls found in
// the reasoning so the requested action still executes.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  client.powHeader = async () => 'pow'
  client.request = async () =>
    sseResponse([
      { response_message_id: 11 },
      { p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK' }] },
      {
        p: 'response/fragments/-1/content',
        o: 'APPEND',
        v: 'Let me draft the plan. <|DSML|calls><|DSML|invoke name="pwsh"><|DSML|parameter name="command" string="true">Get-ChildItem</|DSML|parameter></|DSML|invoke></|DSML|calls>',
      },
      { p: 'response/status', v: 'FINISHED' },
    ])
  const chunks = await collect(client, {
    sessionId: 's6',
    parentMessageId: null,
    prompt: 'hi',
    thinking: true,
    search: false,
    state: {},
  })
  const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.ok(toolEnd, 'the tool call from the reasoning channel was recovered')
  assert.equal(toolEnd.block.name, 'pwsh')
  assert.deepEqual(JSON.parse(toolEnd.block.arguments), { command: 'Get-ChildItem' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.ok(
    !chunks.some((chunk) => chunk.type === 'text-delta'),
    'the reasoning text is not re-emitted as answer text',
  )
}

// The recovery must not fire when the answer channel produced text: a model
// may discuss a hypothetical tool call in its thinking without executing it.
{
  const client = new DeepSeekWebClient({ token: 'test' })
  client.powHeader = async () => 'pow'
  client.request = async () =>
    sseResponse([
      { response_message_id: 12 },
      { v: { response: { fragments: [{ type: 'THINK', content: 'I could run pwsh, but the answer is clear. <|DSML|invoke name="pwsh"><|DSML|parameter name="command" string="true">rm -rf /</|DSML|parameter></|DSML|invoke>' }] } } },
      { p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE' }] },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: 'No action needed.' },
      { p: 'response/status', v: 'FINISHED' },
    ])
  const chunks = await collect(client, {
    sessionId: 's7',
    parentMessageId: null,
    prompt: 'hi',
    thinking: true,
    search: false,
    state: {},
  })
  assert.ok(
    !chunks.some((chunk) => chunk.block?.type === 'tool-call'),
    'a call mentioned only in reasoning is not executed when an answer exists',
  )
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(text, 'No action needed.')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
}

// Reasoning without any DSML and an empty answer keeps the old behavior: the
// turn still completes (the reasoning is visible), no phantom tool call — and
// the suspicious-completion diagnostic records the frames for the log.
{
  const warnings = []
  const client = new DeepSeekWebClient({
    token: 'test',
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  client.powHeader = async () => 'pow'
  client.request = async () =>
    sseResponse([
      { response_message_id: 13 },
      { p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK' }] },
      { p: 'response/fragments/-1/content', o: 'APPEND', v: 'just thinking, no call' },
      { p: 'response/status', v: 'FINISHED' },
    ])
  const chunks = await collect(client, {
    sessionId: 's8',
    parentMessageId: null,
    prompt: 'hi',
    thinking: true,
    search: false,
    state: {},
  })
  assert.ok(!chunks.some((chunk) => chunk.block?.type === 'tool-call'))
  assert.ok(chunks.some((chunk) => chunk.type === 'reasoning-delta' && chunk.text === 'just thinking, no call'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.ok(
    warnings.some((message) => message.includes('suspicious completion') && message.includes('frames:')),
    'the frame shape is recorded for diagnosis',
  )
}

// A fence spelling the streaming sieve does not recognise (spaced
// `<| DSML | invoke …>`) leaks into the answer as raw markup. The call is
// parsed back out of the answer text so the action still runs.
{
  const warnings = []
  const client = new DeepSeekWebClient({
    token: 'test',
    logger: { warn: (message) => warnings.push(String(message)) },
  })
  client.powHeader = async () => 'pow'
  client.request = async () =>
    sseResponse([
      { response_message_id: 14 },
      {
        p: 'response/content',
        o: 'APPEND',
        v: 'Listing files. <| DSML | invoke name="pwsh"><| DSML | parameter name="command" string="true">Get-ChildItem</| DSML | parameter></| DSML | invoke>',
      },
      { p: 'response/status', v: 'FINISHED' },
    ])
  const chunks = await collect(client, {
    sessionId: 's9',
    parentMessageId: null,
    prompt: 'hi',
    thinking: false,
    search: false,
    state: {},
  })
  const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.ok(toolEnd, 'the call was recovered from the leaked answer text')
  assert.equal(toolEnd.block.name, 'pwsh')
  assert.deepEqual(JSON.parse(toolEnd.block.arguments), { command: 'Get-ChildItem' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  assert.ok(
    warnings.some((message) => message.includes('recovered 1 tool call(s) from the answer text')),
    'the leak is reported',
  )
}

console.log('stream-smoke: ok')
