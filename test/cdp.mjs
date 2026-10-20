import assert from 'node:assert/strict'
import { CdpError, COMPOSER_PROMPT_LIMIT, attachPage, fetchInPage, probeCdp, streamInPage } from '../chrome-cdp.js'
import { ChatGptWebClient } from '../chatgpt-web.js'
import { DeepSeekWebClient } from '../deepseek-web.js'

// ---------------------------------------------------------------------------
// A fake DevTools endpoint: loopback HTTP for target discovery, and a fake
// WebSocket that answers JSON-RPC by method name.
// ---------------------------------------------------------------------------
const loopbackCalls = []
let pages = []
let allowNewTab = true

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
    if (!allowNewTab) return new Response('not found', { status: 404 })
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
const cookieCalls = []
const headlessCalls = { userAgent: [], focus: 0, navigate: 0, cookies: 0 }
onSend = (socket, message) => {
  if (message.method === 'Runtime.enable' || message.method === 'Runtime.addBinding') {
    socket.reply(message.id, {})
    return
  }
  if (message.method === 'Network.enable') {
    socket.reply(message.id, {})
    return
  }
  if (message.method === 'Network.setCookie') {
    cookieCalls.push(message.params)
    headlessCalls.cookies += 1
    socket.reply(message.id, { success: true })
    return
  }
  if (message.method === 'Network.getCookies') {
    socket.reply(message.id, { cookies: [{ name: 'cf_clearance', value: 'cookie-from-chrome' }] })
    return
  }
  if (message.method === 'Network.setUserAgentOverride') {
    headlessCalls.userAgent.push(message.params.userAgent)
    socket.reply(message.id, {})
    return
  }
  if (message.method === 'Emulation.setFocusEmulationEnabled') {
    headlessCalls.focus += 1
    socket.reply(message.id, {})
    return
  }
  if (message.method === 'Page.bringToFront') {
    socket.reply(message.id, {})
    return
  }
  if (message.method === 'Page.navigate') {
    headlessCalls.navigate += 1
    socket.reply(message.id, {})
    return
  }
  if (message.method === 'Runtime.evaluate' && message.params.expression === 'location.origin') {
    const page = pages.find((entry) => entry.webSocketDebuggerUrl === socket.url)
    let origin = 'null'
    try {
      origin = new URL(page.url).origin
    } catch {
      // Leave null.
    }
    socket.reply(message.id, { result: { value: origin } })
    return
  }
  if (message.method === 'Runtime.evaluate' && message.params.expression.includes('document.readyState')) {
    socket.reply(message.id, { result: { value: { origin: 'https://chatgpt.com', ready: 'complete' } } })
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
    expressions.some(
      (expression) => expression.includes('selectNodeContents') && expression.includes('execCommand("delete")'),
    ),
    'the composer is cleared before inserting, so drafts never accumulate into a wedging prompt',
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

// An oversized prompt is refused before it reaches the page. A few hundred
// thousand characters in the composer wedges the tab, and the site then saves
// that text as a draft that comes back on every reload.
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
      socket.reply(message.id, {
        result: { value: { status: 200, contentType: 'application/json', text: '{"token":"sent","turnstile":{"required":true}}' } },
      })
      return
    }
    socket.reply(message.id, { result: { value: {} } })
  })

  const client = new ChatGptWebClient({ transport: 'cdp' })
  await assert.rejects(
    (async () => {
      for await (const _chunk of client.conversationStream({
        prompt: 'x'.repeat(COMPOSER_PROMPT_LIMIT + 1),
        modelSlug: 'auto',
        state: {},
      })) {
        // Drain.
      }
    })(),
    (error) => error.code === 'PROMPT_TOO_LONG',
    'an over-limit prompt fails fast instead of wedging the tab',
  )
  assert.ok(
    !expressions.some((expression) => expression.includes('transfer.setData')),
    'nothing is pasted into the page for an over-limit prompt',
  )
}

// A tab that stops answering the debugger is reported and dropped, not retried
// until the harness looks frozen.
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
      socket.reply(message.id, {
        result: { value: { status: 200, contentType: 'application/json', text: '{"token":"sent","turnstile":{"required":true}}' } },
      })
      return
    }
    if (expression.includes('location.assign')) {
      socket.reply(message.id, { result: { value: undefined } })
      return
    }
    if (expression.includes('ready:')) {
      socket.emit('message', {
        data: JSON.stringify({ id: message.id, error: { code: -32603, message: 'Target is not responding' } }),
      })
      return
    }
    socket.reply(message.id, { result: { value: {} } })
  })

  const client = new ChatGptWebClient({ transport: 'cdp' })
  await assert.rejects(
    (async () => {
      for await (const _chunk of client.conversationStream({ prompt: 'hello', modelSlug: 'auto', state: {} })) {
        // Drain.
      }
    })(),
    (error) => error.code === 'TAB_UNRESPONSIVE',
    'three unanswerable probes become a terminal TAB_UNRESPONSIVE error',
  )
  assert.ok(
    !expressions.some((expression) => expression.includes('transfer.setData')),
    'a frozen tab is never typed into',
  )
}

// The managed headless transport attaches to its own port, starts the browser
// when nothing is listening, aligns the User-Agent (Cloudflare's cf_clearance
// is bound to it) and injects the saved cookies before any request is made.
{
  pages = []
  allowNewTab = false
  headlessCalls.userAgent.length = 0
  headlessCalls.cookies = 0
  headlessCalls.focus = 0
  headlessCalls.navigate = 0
  let starts = 0
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
      socket.reply(message.id, {
        result: { value: { status: 200, contentType: 'application/json', text: '{"token":"sent","turnstile":{"required":true}}' } },
      })
      return
    }
    if (expression.includes('location.assign')) {
      socket.reply(message.id, { result: { value: undefined } })
      return
    }
    if (expression.includes('insertText')) {
      socket.reply(message.id, { result: { value: { ok: true, before: 0, inserted: 'hi', length: 2 } } })
      return
    }
    if (expression.includes('button[type="submit"]')) {
      socket.reply(message.id, { result: { value: { clicked: true } } })
      return
    }
    if (expression.includes('data-dsh-seen')) {
      socket.reply(message.id, { result: { value: { text: 'pong', state: 'complete' } } })
      return
    }
    if (expression.includes('ready:')) {
      socket.reply(message.id, { result: { value: { ready: true, draft: 0, replies: 1 } } })
      return
    }
    socket.reply(message.id, { result: { value: { status: 404, contentType: '', text: '' } } })
  })

  const client = new ChatGptWebClient({
    transport: 'headless',
    cookies: 'cf_clearance=x; __Secure-next-auth.session-token=y',
    ensureHeadless: async () => {
      starts += 1
      allowNewTab = true
      pages = [
        {
          id: 'h1',
          type: 'page',
          url: 'https://chatgpt.com/',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/h1',
        },
      ]
    },
  })
  let text = ''
  for await (const chunk of client.conversationStream({ prompt: 'hi', modelSlug: 'auto', state: {} })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  assert.equal(starts, 1, 'a refused headless port starts the managed browser and retries')
  assert.equal(headlessCalls.userAgent.length, 1, 'the managed browser gets the Chrome User-Agent')
  assert.ok(
    /Chrome\//.test(headlessCalls.userAgent[0]) && !/HeadlessChrome/.test(headlessCalls.userAgent[0]),
    'cf_clearance is bound to the User-Agent, so HeadlessChrome must not be sent',
  )
  assert.equal(headlessCalls.cookies, 2, 'the saved cookies are injected into the headless page')
  assert.equal(headlessCalls.focus, 1, 'focus emulation makes the composer accept typing')
  assert.equal(headlessCalls.navigate, 1, 'the page is reloaded after the UA override')
  assert.equal(text, 'pong', 'the headless composer path returns the reply')
  assert.ok(
    expressions.some((expression) => expression.includes('insertText')),
    'text is inserted with execCommand, which headless Chromium honours',
  )
}

// ---------------------------------------------------------------------------
// DeepSeek Web uses the same in-page transport: token from the tab's
// localStorage, raw SSE lines from the page, and cookies copied into the Node
// jar for the fallback path.
// ---------------------------------------------------------------------------
{
  pages = [
    {
      id: 'ds1',
      type: 'page',
      url: 'https://chat.deepseek.com/a/chat/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/ds1',
    },
  ]
  const expressions = []
  scriptedCdp((socket, message) => {
    const expression = message.params.expression
    expressions.push(expression)
    if (expression.includes('localStorage.getItem("userToken")')) {
      socket.reply(message.id, { result: { value: '{"value":"deepseek-tab-token","__version":"0"}' } })
      return
    }
    if (expression.includes('/api/v0/chat/create_pow_challenge')) {
      socket.reply(message.id, {
        result: {
          value: {
            status: 200,
            contentType: 'application/json',
            text: JSON.stringify({ code: 0, data: { biz_data: { challenge: { algorithm: 'sha3', challenge: 'x' } } } }),
            headers: { 'content-type': 'application/json' },
          },
        },
      })
      return
    }
    if (expression.includes('/api/v0/chat/completion')) {
      const frames = [
        { response_message_id: 42 },
        { p: 'response/content', o: 'APPEND', v: 'hello from chrome' },
        { p: 'response/status', v: 'FINISHED' },
      ]
      for (const frame of frames) {
        socket.pushEvent('Runtime.bindingCalled', {
          name: '__dshCdpChunk',
          payload: `data: ${JSON.stringify(frame)}`,
        })
      }
      socket.pushEvent('Runtime.bindingCalled', { name: '__dshCdpChunk', payload: '\u0000__dsh_cdp_done__' })
      socket.reply(message.id, { result: { value: { ok: true, status: 200, contentType: 'text/event-stream' } } })
      return
    }
    socket.reply(message.id, { result: { value: { status: 404, contentType: '', text: '' } } })
  })

  const persisted = []
  const client = new DeepSeekWebClient({
    transport: 'cdp',
    persistToken: (token) => persisted.push(['token', token]),
    persistCookies: (cookies) => persisted.push(['cookies', cookies]),
  })
  client.powHeader = async () => 'pow-from-node'
  const challenge = await client.challenge('/api/v0/chat/completion')
  assert.equal(challenge.algorithm, 'sha3', 'JSON requests also run in the page')
  const chunks = []
  for await (const chunk of client.completionStream({
    sessionId: 'session-1',
    parentMessageId: null,
    prompt: 'hi',
    thinking: false,
    search: false,
    state: {},
  })) {
    chunks.push(chunk)
  }
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, 'hello from chrome')
  assert.equal(client.cdpToken, 'deepseek-tab-token', 'the tab token is read from localStorage')
  assert.equal(
    client.jar.values.get('cf_clearance'),
    'cookie-from-chrome',
    'browser cookies are copied for the Node fallback',
  )
  assert.ok(
    persisted.some(([kind, value]) => kind === 'token' && value === 'deepseek-tab-token'),
    'the browser token is persisted for a later Node fallback',
  )
  assert.ok(
    persisted.some(([kind, value]) => kind === 'cookies' && value.includes('cf_clearance=cookie-from-chrome')),
    'browser cookies are persisted alongside the token',
  )
  const completion = expressions.find((expression) =>
    expression.includes('fetch("https://chat.deepseek.com/api/v0/chat/completion"'),
  )
  assert.ok(completion, 'completion ran inside the chat.deepseek.com page')
  assert.match(completion, /Bearer deepseek-tab-token/)
  assert.match(completion, /x-ds-pow-response/)
  assert.doesNotMatch(completion, /"cookie"/i, 'the page sets its own cookie header')
}

// ---------------------------------------------------------------------------
// Closing Chrome must not break a DeepSeek turn: if the DevTools endpoint is
// unreachable, the same turn is replayed over Node fetch.
// ---------------------------------------------------------------------------
{
  const savedFetch = globalThis.fetch
  const sse = [
    `data: ${JSON.stringify({ response_message_id: 7 })}`,
    '',
    `data: ${JSON.stringify({ p: 'response/content', o: 'APPEND', v: 'hello from node' })}`,
    '',
    `data: ${JSON.stringify({ p: 'response/status', v: 'FINISHED' })}`,
    '',
    '',
  ].join('\n')
  globalThis.fetch = async (url) => {
    const target = new URL(String(url))
    if (target.hostname === '127.0.0.1') {
      throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } })
    }
    assert.equal(target.hostname, 'chat.deepseek.com', 'the fallback goes straight to the upstream')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const warnings = []
  try {
    const client = new DeepSeekWebClient({
      transport: 'cdp',
      token: 'configured-token',
      logger: { warn: (message) => warnings.push(String(message)) },
    })
    client.powHeader = async () => 'pow-from-node'
    const chunks = []
    for await (const chunk of client.completionStream({
      sessionId: 'session-2',
      parentMessageId: null,
      prompt: 'hi',
      thinking: false,
      search: false,
      state: {},
    })) {
      chunks.push(chunk)
    }
    const text = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.text)
      .join('')
    assert.equal(text, 'hello from node')
    assert.ok(
      warnings.some((message) => message.includes('falling back to Node transport')),
      'the fallback is logged so the transport switch is visible',
    )
  } finally {
    globalThis.fetch = savedFetch
  }
}

// ---------------------------------------------------------------------------
// Headless mode: the managed Chromium is seeded with the stored token/cookies
// and the request never falls back to Node.
// ---------------------------------------------------------------------------
{
  allowNewTab = true
  pages = [
    {
      id: 'hl1',
      type: 'page',
      url: 'https://chat.deepseek.com/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/hl1',
    },
  ]
  cookieCalls.length = 0
  let seededToken = ''
  scriptedCdp((socket, message) => {
    const expression = message.params.expression
    if (expression.includes('localStorage.setItem("userToken"')) {
      seededToken = expression
      socket.reply(message.id, { result: { value: undefined } })
      return
    }
    if (expression.includes('/api/v0/chat/create_pow_challenge')) {
      socket.reply(message.id, {
        result: {
          value: {
            status: 200,
            contentType: 'application/json',
            text: JSON.stringify({ code: 0, data: { biz_data: { challenge: { algorithm: 'sha3', challenge: 'x' } } } }),
            headers: { 'content-type': 'application/json' },
          },
        },
      })
      return
    }
    if (expression.includes('fetch("https://chat.deepseek.com/api/v0/chat/completion"')) {
      for (const frame of [
        { response_message_id: 43 },
        { p: 'response/content', o: 'APPEND', v: 'headless hello' },
        { p: 'response/status', v: 'FINISHED' },
      ]) {
        socket.pushEvent('Runtime.bindingCalled', {
          name: '__dshCdpChunk',
          payload: `data: ${JSON.stringify(frame)}`,
        })
      }
      socket.pushEvent('Runtime.bindingCalled', { name: '__dshCdpChunk', payload: '\u0000__dsh_cdp_done__' })
      socket.reply(message.id, { result: { value: { ok: true, status: 200, contentType: 'text/event-stream' } } })
      return
    }
    socket.reply(message.id, { result: { value: { status: 404, contentType: '', text: '' } } })
  })

  const client = new DeepSeekWebClient({
    transport: 'headless',
    token: 'headless-token',
    cookies: 'cf_clearance=from-config',
  })
  client.powHeader = async () => 'pow'
  const challenge = await client.challenge('/api/v0/chat/completion')
  assert.equal(challenge.algorithm, 'sha3')
  const chunks = []
  for await (const chunk of client.completionStream({
    sessionId: 'headless-session',
    parentMessageId: null,
    prompt: 'hi',
    thinking: false,
    search: false,
    state: {},
  })) {
    chunks.push(chunk)
  }
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(text, 'headless hello')
  assert.ok(
    cookieCalls.some((cookie) => cookie.name === 'cf_clearance' && cookie.value === 'from-config'),
    'stored cookies are injected into the headless profile',
  )
  assert.match(seededToken, /headless-token/, 'the token is seeded into the tab localStorage')
}

// The first attach fails, ensureHeadless() starts the browser, and the same
// request succeeds without touching Node fetch.
{
  allowNewTab = false
  pages = [
    {
      id: 'other',
      type: 'page',
      url: 'https://example.com/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/other',
    },
  ]
  let ensureCalls = 0
  scriptedCdp((socket, message) => {
    if (message.params.expression.includes('/api/v0/chat/create_pow_challenge')) {
      socket.reply(message.id, {
        result: {
          value: {
            status: 200,
            contentType: 'application/json',
            text: JSON.stringify({ code: 0, data: { biz_data: { challenge: { algorithm: 'sha3', challenge: 'x' } } } }),
            headers: { 'content-type': 'application/json' },
          },
        },
      })
      return
    }
    socket.reply(message.id, { result: { value: undefined } })
  })
  const client = new DeepSeekWebClient({
    transport: 'headless',
    token: 'headless-token',
    ensureHeadless: async () => {
      ensureCalls += 1
      allowNewTab = true
      pages = [
        {
          id: 'hl2',
          type: 'page',
          url: 'https://chat.deepseek.com/',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/hl2',
        },
      ]
      return { running: true }
    },
  })
  client.powHeader = async () => 'pow'
  const challenge = await client.challenge('/api/v0/chat/completion')
  assert.equal(challenge.algorithm, 'sha3')
  assert.equal(ensureCalls, 1, 'the managed browser is started on demand')
  allowNewTab = true
}

// If the managed browser cannot start, headless mode fails; it must not quietly
// switch to Node fetch.
{
  allowNewTab = false
  pages = [{ id: 'other', type: 'page', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/other' }]
  const client = new DeepSeekWebClient({
    transport: 'headless',
    token: 'headless-token',
    ensureHeadless: async () => {
      throw new Error('no browser installed')
    },
  })
  client.powHeader = async () => 'pow'
  await assert.rejects(
    client.challenge('/api/v0/chat/completion'),
    (error) => error.code === 'HEADLESS_UNAVAILABLE' && /no browser installed/.test(error.message),
  )
  allowNewTab = true
}

console.log('cdp: ok')
