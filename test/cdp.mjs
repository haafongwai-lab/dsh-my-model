import assert from 'node:assert/strict'
import { CdpError, attachPage, fetchInPage, probeCdp, streamInPage } from '../chrome-cdp.js'
import { ChatGptWebClient } from '../chatgpt-web.js'

// ---------------------------------------------------------------------------
// A fake DevTools endpoint: loopback HTTP for target discovery, and a fake
// WebSocket that answers JSON-RPC by method name.
// ---------------------------------------------------------------------------
const loopbackCalls = []
let pages = []

globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url))
  assert.equal(target.hostname, '127.0.0.1', 'the CDP client must only talk to loopback')
  loopbackCalls.push({ path: target.pathname, method: init.method ?? 'GET' })
  if (target.pathname === '/json/version') {
    return new Response(JSON.stringify({ Browser: 'Chrome/155.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (target.pathname === '/json/list') {
    return new Response(JSON.stringify(pages), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (target.pathname === '/json/new') {
    const created = {
      id: 'new-tab',
      type: 'page',
      url: decodeURIComponent(target.search.slice(1)),
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/new-tab',
    }
    pages = [...pages, created]
    return new Response(JSON.stringify(created), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('not found', { status: 404 })
}

const sockets = []
let onSend = null

class FakeSocket {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    sockets.push(this)
    setTimeout(() => this.emit('open', {}), 0)
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }

  send(text) {
    const message = JSON.parse(text)
    onSend?.(this, message)
  }

  close() {
    this.closed = true
    this.emit('close', {})
  }

  reply(id, result) {
    this.emit('message', { data: JSON.stringify({ id, result }) })
  }

  pushEvent(method, params) {
    this.emit('message', { data: JSON.stringify({ method, params }) })
  }
}
globalThis.WebSocket = FakeSocket

/** Answer Runtime.enable/addBinding and hand evaluate to the test. */
let evaluateHandler = () => {}
onSend = (socket, message) => {
  if (message.method === 'Runtime.enable' || message.method === 'Runtime.addBinding') {
    socket.reply(message.id, {})
    return
  }
  if (message.method === 'Runtime.evaluate') evaluateHandler(socket, message)
}

function scriptedCdp(handler) {
  evaluateHandler = handler
}

// ---------------------------------------------------------------------------
// Discovery and attachment.
// ---------------------------------------------------------------------------
pages = [{ id: 'p1', type: 'page', url: 'https://chatgpt.com/c/abc', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1' }]
{
  const probe = await probeCdp({ port: 9222 })
  assert.equal(probe.reachable, true)
  assert.match(probe.browser, /Chrome/)

  const { connection, target } = await attachPage({ origin: 'https://chatgpt.com' })
  assert.equal(target.id, 'p1', 'an existing chatgpt.com tab is reused')
  assert.equal(sockets.at(-1).url, 'ws://127.0.0.1:9222/devtools/page/p1')
  connection.close()
}

// No matching tab: one is opened with PUT (Chrome ≥ 111).
{
  pages = [{ id: 'other', type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/other' }]
  loopbackCalls.length = 0
  const { connection, target } = await attachPage({ origin: 'https://chatgpt.com' })
  assert.equal(target.id, 'new-tab')
  assert.ok(loopbackCalls.some((call) => call.path === '/json/new' && call.method === 'PUT'), 'the tab is opened with PUT')
  connection.close()
}

// An unreachable endpoint is reported, not thrown as a random transport error.
{
  const saved = globalThis.fetch
  globalThis.fetch = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } })
  }
  const probe = await probeCdp({ port: 9222, timeoutMs: 200 })
  assert.equal(probe.reachable, false)
  assert.match(probe.message, /not reachable/)
  await assert.rejects(
    attachPage({ origin: 'https://chatgpt.com', timeoutMs: 200 }),
    (error) => error instanceof CdpError && error.code === 'UNREACHABLE',
  )
  globalThis.fetch = saved
}

// ---------------------------------------------------------------------------
// In-page requests.
// ---------------------------------------------------------------------------
{
  pages = [{ id: 'p1', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1' }]
  let seenExpression = ''
  scriptedCdp((socket, message) => {
    seenExpression = message.params.expression
    socket.reply(message.id, {
      result: { value: { status: 200, contentType: 'application/json', text: '{"accessToken":"abc"}' } },
    })
  })
  const { connection } = await attachPage({ origin: 'https://chatgpt.com' })
  const result = await fetchInPage(connection, '/api/auth/session', { method: 'GET' })
  assert.equal(result.status, 200)
  assert.equal(JSON.parse(result.text).accessToken, 'abc')
  assert.match(seenExpression, /credentials: "include"/, 'the in-page fetch sends the tab cookies')
  assert.match(seenExpression, /\/api\/auth\/session/)
  connection.close()
}

// Streaming: binding payloads become decoded frames, and the done marker ends it.
{
  let evaluateParams = null
  scriptedCdp((socket, message) => {
    evaluateParams = message.params
    socket.pushEvent('Runtime.bindingCalled', {
      name: '__dshCdpChunk',
      payload: JSON.stringify({ message: { id: 'm1', content: { content_type: 'text', parts: ['hi'] } } }),
    })
    socket.pushEvent('Runtime.bindingCalled', { name: '__dshCdpChunk', payload: '\u0000__dsh_cdp_done__' })
    socket.reply(message.id, { result: { value: { ok: true, status: 200 } } })
  })
  const { connection } = await attachPage({ origin: 'https://chatgpt.com' })
  const frames = []
  for await (const frame of streamInPage(connection, '/backend-api/conversation', { body: { action: 'next' } })) {
    frames.push(frame)
  }
  assert.equal(frames.length, 1)
  assert.equal(frames[0].message.id, 'm1')
  assert.match(evaluateParams.expression, /text\/event-stream/)
  assert.match(evaluateParams.expression, /emit\(/)
  connection.close()
}

// A non-2xx answer from the page surfaces as HTTP_ERROR with the status/body.
{
  scriptedCdp((socket, message) => {
    socket.reply(message.id, {
      result: { value: { ok: false, status: 403, contentType: 'application/json', text: '{"detail":"nope"}' } },
    })
  })
  const { connection } = await attachPage({ origin: 'https://chatgpt.com' })
  await assert.rejects(
    (async () => {
      for await (const _frame of streamInPage(connection, '/backend-api/conversation', { body: {} })) {
        // nothing expected
      }
    })(),
    (error) => error.code === 'HTTP_ERROR' && /403/.test(error.message),
  )
  connection.close()
}

// ---------------------------------------------------------------------------
// The client uses CDP for every chatgpt.com call when the transport is 'cdp'.
// ---------------------------------------------------------------------------
{
  pages = [{ id: 'p1', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1' }]
  const expressions = []
  scriptedCdp((socket, message) => {
    const expression = message.params.expression
    expressions.push(expression)
    if (expression.includes('/api/auth/session')) {
      socket.reply(message.id, {
        result: { value: { status: 200, contentType: 'application/json', text: '{"accessToken":"tok"}' } },
      })
      return
    }
    if (expression.includes('/sentinel/chat-requirements')) {
      socket.reply(message.id, { result: { value: { status: 200, contentType: 'application/json', text: '{"token":"sent"}' } } })
      return
    }
    if (expression.includes('/backend-api/conversation')) {
      socket.pushEvent('Runtime.bindingCalled', {
        name: '__dshCdpChunk',
        payload: JSON.stringify({
          conversation_id: 'conv-1',
          message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['hello'] } },
        }),
      })
      socket.pushEvent('Runtime.bindingCalled', { name: '__dshCdpChunk', payload: '\u0000__dsh_cdp_done__' })
      socket.reply(message.id, { result: { value: { ok: true, status: 200 } } })
      return
    }
    socket.reply(message.id, { result: { value: { status: 404, contentType: '', text: '' } } })
  })

  const client = new ChatGptWebClient({ transport: 'cdp', cookies: 'unused=1' })
  const state = {}
  const chunks = []
  for await (const chunk of client.conversationStream({ prompt: 'hi', modelSlug: 'gpt-6-luna', state })) {
    chunks.push(chunk)
  }
  assert.equal(state.conversationId, 'conv-1')
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, 'hello')
  assert.ok(
    expressions.some((expression) => expression.includes('/backend-api/conversation')),
    'the conversation request ran in the page',
  )
  assert.ok(
    expressions.every((expression) => !expression.includes('https://chatgpt.com')),
    'in-page requests stay same-origin (relative paths)',
  )
  // The backend authenticates by this header, not by the tab's cookies: without
  // it the sentinel answers `persona: "chatgpt-noauth"` and the turn is rejected.
  const authenticated = expressions.filter((expression) => expression.includes('/sentinel/') || expression.includes('/conversation'))
  assert.ok(
    authenticated.every((expression) => /authorization"?\s*:\s*"Bearer tok"/.test(expression)),
    'sentinel and conversation requests carry the bearer token',
  )
}

// When the sentinel demands Turnstile, the CDP transport sends through the
// page's own composer instead of replaying the API call (which cannot carry the
// proof). The three in-page calls (insert/send/read) are driven by Node, and
// cumulative DOM text is diffed into deltas like the SSE path.
{
  pages = [{ id: 'p1', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1' }]
  const expressions = []
  let turnCount = 5
  let replyText = ''
  scriptedCdp((socket, message) => {
    const expression = message.params.expression
    expressions.push(expression)
    if (expression.includes('/api/auth/session')) {
      socket.reply(message.id, {
        result: { value: { status: 200, contentType: 'application/json', text: '{"accessToken":"tok"}' } },
      })
      return
    }
    if (expression.includes('/sentinel/chat-requirements')) {
      socket.reply(message.id, {
        result: { value: { status: 200, contentType: 'application/json', text: '{"token":"sent","turnstile":{"required":true}}' } },
      })
      return
    }
    if (expression.includes('location.assign')) {
      // composer navigate to a fresh chat
      socket.reply(message.id, { result: { value: undefined } })
      return
    }
    if (expression.includes('transfer.setData')) {
      // composer insert
      turnCount += 1
      socket.reply(message.id, {
        result: { value: { ok: true, before: turnCount - 1, inserted: 'say pong' } },
      })
      return
    }
    if (expression.includes('button[type="submit"]')) {
      // composer send: the reply appears after it
      replyText = 'pong'
      socket.reply(message.id, { result: { value: { clicked: true } } })
      return
    }
    if (expression.includes('data-dsh-seen')) {
      // composer read: replies the insert did not mark as pre-existing
      socket.reply(message.id, { result: { value: { text: replyText, state: 'complete' } } })
      return
    }
    if (expression.includes('ready:')) {
      // composer probe
      socket.reply(message.id, { result: { value: { ready: true, replies: replyText ? 1 : 0, streaming: false } } })
      return
    }
    socket.reply(message.id, { result: { value: { status: 404, contentType: '', text: '' } } })
  })

  const client = new ChatGptWebClient({ transport: 'cdp' })
  const chunks = []
  for await (const chunk of client.conversationStream({ prompt: 'say pong', modelSlug: 'gpt-6-luna', state: {} })) {
    chunks.push(chunk)
  }
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, 'pong', 'cumulative DOM text is emitted as deltas')
  assert.ok(chunks.some((chunk) => chunk.type === 'finish' && chunk.reason.kind === 'stop'))
  assert.ok(
    expressions.some((expression) => expression.includes('transfer.setData')),
    'the page composer was driven',
  )
  assert.ok(
    expressions.some((expression) => expression.includes('data-content-search-unit-key')),
    'the reply is read from the node the live page marks as the assistant answer',
  )
  assert.ok(
    expressions.some((expression) => expression.includes('data-dsh-seen')),
    'pre-existing replies are marked so an old answer is never read as the new one',
  )
  assert.ok(
    !expressions.some((expression) => expression.includes('/backend-api/conversation')),
    'no API conversation replay when Turnstile is required',
  )
}

console.log('cdp: ok')
