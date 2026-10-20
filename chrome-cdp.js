/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Why this exists: chatgpt.com sits behind Cloudflare bot management, which
 * scores the TLS/JA3 fingerprint and the HTTP version. Node's `fetch` cannot
 * change either, so a request that is otherwise perfectly authenticated gets
 * `403 {"detail":"Unusual activity has been detected from your device."}`.
 * Running the same `fetch` **inside the user's own logged-in Chrome page** makes
 * the request genuinely the browser's: same TLS stack, same HTTP/2 connection,
 * same cookies, same client hints.
 *
 * Scope is deliberately small — loopback only, page targets only, two commands
 * (`Runtime.evaluate`, `Runtime.addBinding`) plus tab discovery. No dependency:
 * Node 22 and Electron both ship a global `WebSocket`.
 */

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9222

export class CdpError extends Error {
  constructor(message, code = 'CDP_ERROR') {
    super(message)
    this.name = 'CdpError'
    this.code = code
  }
}

function baseUrl({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const safeHost = /^[\w.:-]+$/.test(String(host)) ? String(host) : DEFAULT_HOST
  const safePort = Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : DEFAULT_PORT
  return `http://${safeHost}:${safePort}`
}

/** One JSON-RPC connection to a single CDP target. */
class CdpConnection {
  static async open(url, { timeoutMs = 5000 } = {}) {
    if (typeof WebSocket !== 'function') {
      throw new CdpError('This runtime has no WebSocket, so CDP cannot be used.', 'NO_WEBSOCKET')
    }
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close()
        } catch {
          // Ignore: the socket is being discarded anyway.
        }
        reject(new CdpError('Connecting to the Chrome DevTools endpoint timed out.', 'TIMEOUT'))
      }, timeoutMs)
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new CdpError('Connecting to the Chrome DevTools endpoint failed.', 'CONNECT_FAILED'))
        },
        { once: true },
      )
    })
    return new CdpConnection(socket)
  }

  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Set()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.error) {
          pending.reject(
            new CdpError(
              `${message.error.message ?? 'CDP call failed'}${message.error.code ? ` (${message.error.code})` : ''}`,
              'CDP_ERROR',
            ),
          )
        } else {
          pending.resolve(message.result ?? {})
        }
        return
      }
      for (const handler of [...this.handlers]) {
        try {
          handler(message)
        } catch {
          // A listener must never break the connection loop.
        }
      }
    })
    socket.addEventListener('close', () => {
      for (const [, pending] of this.pending) pending.reject(new CdpError('The CDP connection closed.', 'CLOSED'))
      this.pending.clear()
    })
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      // `timeoutMs <= 0` means "no timer": the streaming evaluate call is bounded
      // by the caller's abort signal instead of a fixed deadline.
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new CdpError(`CDP ${method} timed out.`, 'TIMEOUT'))
            }, timeoutMs)
          : null
      this.pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpError(`CDP send failed: ${error?.message ?? String(error)}`, 'SEND_FAILED'))
      }
    })
  }

  onEvent(handler) {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
  }
}

async function getJson(url, timeoutMs = 3000) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new CdpError(
      `Chrome's DevTools endpoint is not reachable at ${url} (${error?.cause?.code ?? error?.message ?? String(error)}). ` +
        'Start Chrome with --remote-debugging-port and keep it running.',
      'UNREACHABLE',
    )
  }
  if (!response.ok) throw new CdpError(`Chrome's DevTools endpoint answered HTTP ${response.status}.`, 'UNREACHABLE')
  try {
    return await response.json()
  } catch {
    throw new CdpError("Chrome's DevTools endpoint returned a non-JSON body.", 'UNREACHABLE')
  }
}

/** Probe the endpoint without attaching to anything. */
export async function probeCdp({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 1500 } = {}) {
  try {
    const version = await getJson(`${baseUrl({ host, port })}/json/version`, timeoutMs)
    return {
      reachable: true,
      browser: typeof version?.Browser === 'string' ? version.Browser : 'Chromium',
      webSocketDebuggerUrl: typeof version?.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : undefined,
    }
  } catch (error) {
    return { reachable: false, message: error?.message ?? String(error) }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until the attached page has committed the requested origin. A newly
 * opened `/json/new` tab is briefly `about:blank`; an in-page fetch from there
 * would be cross-origin and would not carry the DeepSeek cookies.
 */
export async function waitForPageOrigin(connection, origin, { timeoutMs = 5000, intervalMs = 100 } = {}) {
  let wanted
  try {
    wanted = new URL(String(origin)).origin
  } catch {
    return false
  }
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 5000)
  while (Date.now() < deadline) {
    try {
      const result = await connection.send(
        'Runtime.evaluate',
        { expression: 'location.origin', returnByValue: true },
        1500,
      )
      if (result?.result?.value === wanted) return true
    } catch {
      // The execution context can disappear while the document navigates.
    }
    await sleep(Math.max(25, Number(intervalMs) || 100))
  }
  return false
}

/**
 * Find (or open) a page target on `origin` and attach to it.
 * Chrome ≥ 111 requires PUT for `/json/new`; older builds accept GET, so both
 * are attempted.
 */
export async function attachPage({ host = DEFAULT_HOST, port = DEFAULT_PORT, origin, timeoutMs = 5000 } = {}) {
  const endpoint = baseUrl({ host, port })
  const wanted = String(origin || 'https://chatgpt.com').replace(/\/+$/, '')
  let targets = []
  try {
    targets = await getJson(`${endpoint}/json/list`, timeoutMs)
  } catch (error) {
    if (error?.code !== 'UNREACHABLE') throw error
    throw error
  }
  if (!Array.isArray(targets)) throw new CdpError('Chrome returned no target list.', 'BAD_TARGETS')
  let wantedOrigin
  try {
    wantedOrigin = new URL(wanted).origin
  } catch {
    wantedOrigin = undefined
  }
  const sameOrigin = (value) => {
    if (!wantedOrigin) return false
    try {
      return new URL(String(value)).origin === wantedOrigin
    } catch {
      return false
    }
  }
  let target = targets.find((entry) => entry?.type === 'page' && sameOrigin(entry.url))
  if (!target) {
    const openUrl = `${endpoint}/json/new?${encodeURIComponent(wanted + '/')}`
    for (const method of ['PUT', 'GET']) {
      try {
        const response = await fetch(openUrl, { method, signal: AbortSignal.timeout(timeoutMs) })
        if (!response.ok) continue
        const created = await response.json()
        if (created?.webSocketDebuggerUrl) {
          target = created
          break
        }
      } catch {
        // Try the next method.
      }
    }
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new CdpError(
      `Chrome is running, but no tab on ${wanted} could be found or opened. Open ${wanted} in that Chrome window and retry.`,
      'NO_TARGET',
    )
  }
  const connection = await CdpConnection.open(target.webSocketDebuggerUrl, { timeoutMs })
  await connection.send('Runtime.enable')
  let ready = await waitForPageOrigin(connection, wanted, { timeoutMs: Math.min(timeoutMs, 5000) })
  if (!ready) {
    // An existing tab may be on about:blank or another document; nudge it to
    // the requested origin once and wait for the navigation to commit.
    try {
      await connection.send(
        'Runtime.evaluate',
        {
          expression: `location.assign(${JSON.stringify(wanted + '/')}); undefined`,
          returnByValue: true,
        },
        2000,
      )
    } catch {
      // The wait below reports the useful failure.
    }
    ready = await waitForPageOrigin(connection, wanted, { timeoutMs: 5000 })
  }
  if (!ready) {
    try {
      connection.close()
    } catch {
      // Ignore.
    }
    throw new CdpError(
      `The Chrome tab did not reach ${wanted}. Open that page in the debug Chrome window and retry.`,
      'NO_TARGET',
    )
  }
  return { connection, target: { id: target.id, url: target.url, title: target.title } }
}

/**
 * Evaluate a fetch inside the page and collect the response as text.
 * @returns {Promise<{status:number, contentType:string, text:string, headers:Record<string,string>}>}
 */
export async function fetchInPage(connection, path, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  const expression = buildJsonExpression(path, { method, headers, body })
  const result = await connection.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    timeoutMs,
  )
  if (result?.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'the in-page request threw'
    throw new CdpError(`In-page fetch failed: ${String(detail).slice(0, 300)}`, 'EVAL_FAILED')
  }
  const value = result?.result?.value
  if (!value || typeof value !== 'object') throw new CdpError('The in-page request returned nothing.', 'EMPTY_RESULT')
  const responseHeaders = value.headers && typeof value.headers === 'object' ? value.headers : {}
  return {
    status: Number(value.status) || 0,
    contentType: String(value.contentType ?? responseHeaders['content-type'] ?? ''),
    text: String(value.text ?? ''),
    headers: responseHeaders,
  }
}

function buildJsonExpression(path, { method, headers, body }) {
  return [
    '(async () => {',
    '  try {',
    `    const response = await fetch(${JSON.stringify(path)}, {`,
    `      method: ${JSON.stringify(method)},`,
    `      headers: ${JSON.stringify(headers)},`,
    '      credentials: "include",',
    body === undefined ? '' : `      body: ${JSON.stringify(JSON.stringify(body))},`,
    '    });',
    '    const headers = {};',
    '    response.headers.forEach((value, key) => { headers[key] = value; });',
    '    const text = await response.text();',
    '    return { status: response.status, contentType: response.headers.get("content-type") || "", text, headers };',
    '  } catch (error) {',
    '    return { status: 0, contentType: "", text: String(error && error.message ? error.message : error), headers: {} };',
    '  }',
    '})()',
  ]
    .filter(Boolean)
    .join('\n')
}

const BINDING_NAME = '__dshCdpChunk'
const DONE_MARK = '\u0000__dsh_cdp_done__'

/**
 * Stream an SSE endpoint from inside the page. Each `data:` line is pushed back
 * over a CDP binding so the adapter keeps its streaming behaviour.
 *
 * `raw` skips JSON decoding and yields each non-empty SSE line (`event:`,
 * `data:`, or a bare JSON line). DeepSeek uses event names, so it needs the raw
 * form; ChatGPT uses the decoded JSON form.
 */
export async function* streamInPage(
  connection,
  path,
  { method = 'POST', headers = {}, body, signal, raw = false } = {},
) {
  const chunks = []
  let notify = null
  let finished = false
  let failure = null
  const wake = () => {
    if (notify) {
      const resolve = notify
      notify = null
      resolve()
    }
  }
  const unsubscribe = connection.onEvent((message) => {
    if (message.method !== 'Runtime.bindingCalled') return
    const params = message.params ?? {}
    if (params.name !== BINDING_NAME) return
    const payload = String(params.payload ?? '')
    if (payload === DONE_MARK) {
      finished = true
      wake()
      return
    }
    chunks.push(payload)
    wake()
  })

  await connection.send('Runtime.addBinding', { name: BINDING_NAME })
  const expression = buildStreamExpression(path, { method, headers, body, raw })
  const evaluation = connection.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    0,
  )
  // `Runtime.evaluate` above has no timeout of its own; the generator below is
  // what bounds the wait (the caller's abort signal or the turn timeout).
  let settled = false
  evaluation.then(
    () => {
      settled = true
      wake()
    },
    (error) => {
      failure = error
      settled = true
      wake()
    },
  )

  try {
    while (true) {
      if (chunks.length > 0) {
        const payload = chunks.shift()
        if (raw) {
          if (payload !== '') yield payload
          continue
        }
        let frame
        try {
          frame = JSON.parse(payload)
        } catch {
          continue
        }
        yield frame
        continue
      }
      if (finished || settled) {
        if (chunks.length === 0) break
        continue
      }
      if (signal?.aborted) throw new CdpError('The in-page request was aborted.', 'ABORTED')
      await new Promise((resolve) => {
        notify = resolve
      })
    }
    const result = await evaluation
    if (result?.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'the in-page request threw'
      throw new CdpError(`In-page stream failed: ${String(detail).slice(0, 300)}`, 'EVAL_FAILED')
    }
    const value = result?.result?.value
    if (value && value.ok === false) {
      throw new CdpError(
        JSON.stringify({
          status: value.status,
          contentType: value.contentType,
          text: value.text ?? '',
          headers: value.headers ?? {},
        }),
        'HTTP_ERROR',
      )
    }
  } finally {
    unsubscribe()
  }
}

function buildStreamExpression(path, { method, headers, body, raw = false }) {
  return [
    '(async () => {',
    `  const send = window[${JSON.stringify(BINDING_NAME)}];`,
    '  const emit = (payload) => { try { send(payload); } catch (_) {} };',
    '  try {',
    `    const response = await fetch(${JSON.stringify(path)}, {`,
    `      method: ${JSON.stringify(method)},`,
    `      headers: ${JSON.stringify(headers)},`,
    '      credentials: "include",',
    body === undefined ? '' : `      body: ${JSON.stringify(JSON.stringify(body))},`,
    '    });',
    '    const contentType = response.headers.get("content-type") || "";',
    '    const headers = {};',
    '    response.headers.forEach((value, key) => { headers[key] = value; });',
    '    if (!response.ok || contentType.indexOf("text/event-stream") < 0) {',
    '      const text = await response.text().catch(() => "");',
    '      return { ok: false, status: response.status, contentType, text: text.slice(0, 400), headers };',
    '    }',
    '    const reader = response.body.getReader();',
    '    const decoder = new TextDecoder();',
    '    let buffer = "";',
    '    for (;;) {',
    '      const { done, value } = await reader.read();',
    '      if (done) break;',
    '      buffer += decoder.decode(value, { stream: true });',
    '      let index;',
    '      while ((index = buffer.indexOf("\\n")) >= 0) {',
    '        const line = buffer.slice(0, index).replace(/\\r$/, "");',
    '        buffer = buffer.slice(index + 1);',
    raw
      ? '        if (line !== "" && line.charAt(0) !== ":") emit(line);'
      : '        if (line.indexOf("data:") === 0) {\n' +
        '          const payload = line.slice(5).trim();\n' +
        '          if (payload && payload !== "[DONE]") emit(payload);\n' +
        '        }',
    '      }',
    '    }',
    `    emit(${JSON.stringify(DONE_MARK)});`,
    '    return { ok: true, status: response.status, contentType, headers };',
    '  } catch (error) {',
    `    emit(${JSON.stringify(DONE_MARK)});`,
    '    return { ok: false, status: 0, contentType: "", text: String(error && error.message ? error.message : error), headers: {} };',
    '  }',
    '})()',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Read the browser's cookies for one origin over CDP. In-page fetches already
 * use them; the Node fallback needs the same set when Chrome is closed.
 * @returns {Promise<string>} a `name=value; …` header, or an empty string.
 */
export async function getCookies(connection, urls) {
  try {
    // Network.getCookies is available without enable in some builds; enabling
    // first makes it reliable across Chromium versions. A failure here only
    // costs the cookie copy, never the request.
    try {
      await connection.send('Network.enable', {}, 1500)
    } catch {
      // Older/limited targets may refuse; try getCookies anyway.
    }
    const result = await connection.send('Network.getCookies', { urls: urls.map(String) }, 1500)
    const cookies = Array.isArray(result?.cookies) ? result.cookies : []
    return cookies
      .filter((cookie) => cookie && typeof cookie.name === 'string')
      .map((cookie) => `${cookie.name}=${cookie.value ?? ''}`)
      .join('; ')
  } catch (error) {
    if (error?.code === 'CLOSED') throw error
    return ''
  }
}

/** Close a page connection (best effort). */
export function detach(connection) {
  try {
    connection?.close()
  } catch {
    // Ignore.
  }
}

/**
 * Composer driving, split into small **synchronous** page operations.
 *
 * Background tabs throttle `setTimeout` aggressively (up to once a minute), so
 * an in-page polling loop never finishes reliably — the first version of this
 * hung until the turn timed out. Node drives the loop instead, and each page
 * call is a short evaluate that cannot be throttled into uselessness.
 *
 * Reading the reply used to look for `[data-message-author-role="assistant"]`
 * and, failing that, for a turn that does *not* start with "你说：". The live
 * page (measured 2026-10-19) matches neither: it carries no role attribute at
 * all, and one `[data-turn-key]` wraps the user message **and** the answer, so
 * the turn-based branch skipped the only turn and returned an empty string
 * forever. ChatGPT answered in the browser while the Harness kept "thinking".
 * Replies are now located by the node the page actually marks as the answer.
 */

/** The node shapes chatgpt.com has used for an assistant reply, newest first. */
const ASSISTANT_SELECTOR = [
  '[data-message-author-role="assistant"]',
  '[data-content-search-unit-key$=":assistant"]',
  '[data-chatgpt-search-unit-key$=":assistant"]',
].join(', ')

const ASSISTANT_SELECTOR_JSON = JSON.stringify(ASSISTANT_SELECTOR)

/**
 * Hard ceiling for one composer turn.
 *
 * A prompt left in the composer is saved as a draft by the site. It comes back
 * on every reload, and at a few hundred thousand characters the page stops
 * answering CDP calls entirely — the tab looks frozen and every evaluate times
 * out. That was the "ChatGPT Web freezes the Harness" failure, so the limit is
 * enforced in two places (here and in `chatgpt-web.js`) and the editor is
 * cleared before every insert.
 */
export const COMPOSER_PROMPT_LIMIT = 120_000

/** Navigate the attached tab to a fresh chat, clearing any leftover draft first. */
export async function composerNavigate(connection, url, { timeoutMs = 10000 } = {}) {
  const target = String(url || 'https://chatgpt.com').replace(/\/+$/, '') + '/'
  const expression = [
    '(() => {',
    '  // A large draft left in the editor makes the navigation itself wedge the tab,',
    '  // so drop it before leaving the current document.',
    '  const composer = document.querySelector("#prompt-textarea") || document.querySelector(\'div[contenteditable="true"]\');',
    '  if (composer) {',
    '    composer.focus();',
    '    const selection = window.getSelection();',
    '    const range = document.createRange();',
    '    range.selectNodeContents(composer);',
    '    selection.removeAllRanges();',
    '    selection.addRange(range);',
    '    document.execCommand("delete");',
    '  }',
    `  location.assign(${JSON.stringify(target)});`,
    '  return undefined;',
    '})()',
  ].join('\n')
  await connection.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }, timeoutMs)
}

/**
 * Whether the composer is ready after a navigation, plus what the page shows.
 * `draft` is the current composer length: the caller uses it to detect a page
 * that restored an oversized draft and to confirm a click actually submitted.
 */
export async function composerProbe(connection, { timeoutMs = 5000 } = {}) {
  const expression = [
    '(() => {',
    "  const composer = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable=\"true\"]');",
    '  return {',
    '    ready: Boolean(composer),',
    '    href: location.href,',
    '    draft: composer ? String(composer.innerText || "").length : 0,',
    `    replies: document.querySelectorAll(${ASSISTANT_SELECTOR_JSON}).length,`,
    "    streaming: Boolean(document.querySelector('[data-testid=\"stop-button\"]')),",
    '  };',
    '})()',
  ].join('\n')
  const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs)
  checkEvaluate(result)
  return result.result.value ?? { ready: false, replies: 0, streaming: false, draft: 0 }
}

/**
 * Replace the composer's contents with `prompt` (no send). Whatever a previous
 * turn, or the site's restored draft, left behind is deleted first; otherwise
 * prompts accumulate until the page dies.
 */
export async function composerInsert(connection, { prompt, timeoutMs = 20000 } = {}) {
  const text = String(prompt ?? '')
  if (text.length > COMPOSER_PROMPT_LIMIT) {
    return {
      ok: false,
      code: 'PROMPT_TOO_LONG',
      message: `the prompt is ${text.length} characters, over the ${COMPOSER_PROMPT_LIMIT}-character page limit`,
    }
  }
  const expression = [
    '(async () => {',
    '  const composer = document.querySelector("#prompt-textarea") || document.querySelector(\'div[contenteditable="true"]\');',
    '  if (!composer) return { ok: false, message: "composer not found — open chatgpt.com in that tab and wait for it to load" };',
    '  const before = String(composer.innerText || "").length;',
    '  // Mark the replies that already exist, so an older answer (a lingering',
    '  // conversation, a page that has not finished navigating) is never mistaken',
    '  // for the answer to this turn.',
    `  const replies = [...document.querySelectorAll(${ASSISTANT_SELECTOR_JSON})];`,
    '  for (const node of replies) node.setAttribute("data-dsh-seen", "1");',
    '  const count = replies.length;',
    '  // Replace the composer contents instead of appending to them. A draft from',
    '  // an earlier turn is large enough to wedge the page when it is navigated',
    '  // away, so never leave one behind.',
    '  composer.focus();',
    '  const selection = window.getSelection();',
    '  const range = document.createRange();',
    '  range.selectNodeContents(composer);',
    '  selection.removeAllRanges();',
    '  selection.addRange(range);',
    '  document.execCommand("delete");',
    '  // ProseMirror rebuilds the empty paragraph on the next tick; pasting in the',
    '  // same task is silently dropped.',
    '  await new Promise((resolve) => setTimeout(resolve, 100));',
    '  // Clearing can make the editor re-render, so re-query it before pasting;',
    '  // the old node may be detached by now.',
    '  const editor = document.querySelector("#prompt-textarea") || document.querySelector(\'div[contenteditable="true"]\');',
    '  if (!editor) return { ok: false, message: "the composer disappeared after clearing it" };',
    '  const leftover = String(editor.innerText || "").length;',
    '  if (leftover > 2) {',
    '    return { ok: false, message: "the composer still holds text after clearing it", leftover };',
    '  }',
    '  editor.focus();',
    '  // Put the caret back at the end: after deleting a select-all range the editor',
    '  // has no insertion point, and the synthetic paste would be ignored.',
    '  const caret = window.getSelection();',
    '  const end = document.createRange();',
    '  end.selectNodeContents(editor);',
    '  end.collapse(false);',
    '  caret.removeAllRanges();',
    '  caret.addRange(end);',
    '  const transfer = new DataTransfer();',
    `  transfer.setData("text/plain", ${JSON.stringify(text)});`,
    '  // `insertText` behaves like real typing and works in headless Chromium,',
    '  // where a synthetic paste event is ignored. Keep paste as a fallback for',
    '  // editors that do not implement execCommand.',
    '  try { document.execCommand("insertText", false, ' + JSON.stringify(text) + '); } catch { /* fall through */ }',
    '  let inserted = String(editor.innerText || "").trim();',
    '  if (!inserted) {',
    '    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));',
    '    inserted = String(editor.innerText || "").trim();',
    '  }',
    '  if (!inserted) return { ok: false, message: "the composer did not accept the text" };',
    '  return { ok: true, before, cleared: leftover, count, expected: ' + text.length + ', length: inserted.length, inserted: inserted.slice(0, 60) };',
    '})()',
  ].join('\n')
  const result = await connection.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, userGesture: true, awaitPromise: true },
    timeoutMs,
  )
  checkEvaluate(result)
  return result.result.value
}

/**
 * Click the send button. The live page has used several shapes for it over
 * time, and the old `[data-testid="send-button"]` lookup alone silently found
 * nothing; locate it by test id, accessible label, or the form's submit button.
 */
export async function composerSend(connection, { timeoutMs = 5000 } = {}) {
  const expression = [
    '(() => {',
    '  const composer = document.querySelector(\'div[contenteditable="true"]\');',
    '  const form = composer ? composer.closest("form") : document;',
    '  const button = document.querySelector(\'[data-testid="send-button"]\') ||',
    '    document.querySelector(\'button[aria-label="发送"], button[aria-label="Send"], button[aria-label="Send message"]\') ||',
    '    (form ? form.querySelector(\'button[type="submit"]\') : null);',
    '  if (!button) return { clicked: false, reason: "no send button" };',
    '  if (button.disabled) return { clicked: false, disabled: true, reason: "send button is disabled" };',
    '  button.click();',
    '  return { clicked: true, label: button.getAttribute("aria-label") || button.getAttribute("data-testid") || "submit" };',
    '})()',
  ].join('\n')
  const result = await connection.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, userGesture: true },
    timeoutMs,
  )
  checkEvaluate(result)
  return result.result.value
}

/**
 * Read the latest assistant reply created after `before` (the reply count that
 * `composerInsert` captured). `composerInsert` marks the replies that already
 * existed, so a fresh conversation (whose counter can be *lower* than the old
 * one) is never confused with the previous transcript. Returns the reply text,
 * a `state` hint (`pending` | `streaming` | `complete` | null) and the raw
 * counters, so the caller can stop on completion and also fail fast when
 * nothing ever appears.
 *
 * The prefix "ChatGPT 说：" is UI chrome, not answer text, and is stripped — as
 * is a bare "Thinking…" placeholder, which is not a reply either.
 */
export async function composerRead(connection, before, { timeoutMs = 5000 } = {}) {
  const expression = [
    '(() => {',
    `  const before = ${Number(before) || 0};`,
    `  const all = [...document.querySelectorAll(${ASSISTANT_SELECTOR_JSON})];`,
    '  const fresh = all.filter((node) => !node.hasAttribute("data-dsh-seen"));',
    "  const streaming = Boolean(document.querySelector('[data-testid=\"stop-button\"]'));",
    '  const latest = fresh[fresh.length - 1];',
    '  const counts = { before, replies: all.length, fresh: fresh.length, streaming };',
    '  if (!latest) {',
    '    return { text: "", state: streaming ? "streaming" : "pending", ...counts };',
    '  }',
    '  const text = String(latest.innerText || "")',
    '    .replace(/^\\s*(?:ChatGPT|Assistant|助手)\\s*(?:说|said)?\\s*[:：]\\s*/i, "")',
    '    .replace(/^\\s*(?:正在思考|正在回应|Thinking|Responding|Pro thinking)[^\\n]*\\n*/i, "")',
    '    .trim();',
    '  const owner = latest.closest("[data-talvt-turn-state]");',
    '  const declared = owner ? owner.getAttribute("data-talvt-turn-state") : null;',
    '  const state = streaming ? "streaming" : declared === "complete" ? "complete" : null;',
    '  return { text, state, declared, ...counts };',
    '})()',
  ].join('\n')
  const result = await connection.send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs)
  checkEvaluate(result)
  return result.result.value
}

function checkEvaluate(result) {
  if (result?.exceptionDetails) {
    const detail =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'the in-page script threw'
    throw new CdpError(`In-page composer failed: ${String(detail).slice(0, 300)}`, 'UI_FAILED')
  }
  if (!result?.result?.value || typeof result.result.value !== 'object') {
    throw new CdpError('The in-page composer call returned nothing.', 'UI_FAILED')
  }
}

export const CDP_DEFAULTS = { host: DEFAULT_HOST, port: DEFAULT_PORT }
