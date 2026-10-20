/**
 * DSML (DeepSeek Markup Language) helpers.
 *
 * DeepSeek's web chat endpoint has no native tool-calling field. The adapter
 * therefore appends a compact text protocol to the system prompt and parses
 * the model's output back into Harness `tool-call` blocks.
 *
 * The protocol and the parser are adapted from the MIT-licensed
 * `deepseek-web2api-free` project (tool_dsml.py / tool_sieve.py):
 * https://github.com/snake-aabb-wtf/deepseek-web2api-free
 */

const CDATA_OPEN = '<![CDATA['
const CDATA_CLOSE = ']]>'

const TOOL_STARTS = [
  '<|DSML|tool_calls>',
  '|DSML|tool_calls>',
  '<tool_calls>',
  '<tool_call>',
  '<invoke ',
  '<|DSML|invoke ',
  '|DSML|invoke ',
]

const TOOL_PREFIXES = ['<|DSML|', '|DSML|', '<tool_calls', '<tool_call', '<invoke']

function escapeXmlAttr(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function cdata(text) {
  const value = String(text)
  return `<![CDATA[${value.includes(']]>') ? value.replaceAll(']]>', ']]]]><![CDATA[>') : value}]]>`
}

function closingTagBoundary(text, from) {
  const pattern = /<\/(?:\|DSML\|)?(?:parameter|invoke)\s*>/gi
  pattern.lastIndex = from
  const match = pattern.exec(text)
  return match ? match.index : -1
}

function stripDsmlMarkup(text) {
  if (!text) return text
  const parts = []
  let i = 0
  while (i < text.length) {
    if (text.startsWith(CDATA_OPEN, i)) {
      const from = i + CDATA_OPEN.length
      const close = text.indexOf(CDATA_CLOSE, from)
      const boundary = closingTagBoundary(text, from)
      if (close !== -1 && (boundary === -1 || close < boundary)) {
        parts.push(text.slice(i, close + CDATA_CLOSE.length))
        i = close + CDATA_CLOSE.length
        continue
      }
      // Malformed or unclosed CDATA: keep the opener and keep scanning, so a
      // missing ">" never swallows the following parameter into this value.
      parts.push(CDATA_OPEN)
      i = from
      continue
    }
    if (text[i] !== '<') {
      parts.push(text[i])
      i += 1
      continue
    }
    const end = text.indexOf('>', i)
    if (end === -1) {
      parts.push(text.slice(i))
      break
    }
    const inner = text.slice(i + 1, end)
    const rest = inner.startsWith('/') ? inner.slice(1) : inner
    let j = 0
    let dsml = false
    while (j < rest.length) {
      const ch = rest[j]
      if (ch === '|' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        j += 1
        if (ch === '|') dsml = true
      } else if (rest.slice(j, j + 4).toLowerCase() === 'dsml') {
        j += 4
        dsml = true
      } else {
        break
      }
    }
    if (dsml) {
      let nameEnd = j
      while (nameEnd < rest.length && /[A-Za-z0-9_]/.test(rest[nameEnd])) nameEnd += 1
      const tagName = rest.slice(j, nameEnd).toLowerCase()
      if (tagName === 'tool_calls' || tagName === 'invoke' || tagName === 'parameter') {
        parts.push((inner.startsWith('/') ? '</' : '<') + rest.slice(j) + '>')
        i = end + 1
        continue
      }
    }
    parts.push(text.slice(i, end + 1))
    i = end + 1
  }
  return parts.join('')
}

function extractCdata(text) {
  let value = text.trim()
  if (!value.startsWith(CDATA_OPEN)) return value
  value = value.slice(CDATA_OPEN.length)
  if (value.endsWith(CDATA_CLOSE)) return value.slice(0, -CDATA_CLOSE.length)
  // Tolerate a model that closes CDATA with "]]" instead of "]]>".
  if (value.endsWith(']]')) return value.slice(0, -2)
  return value
}

function autoType(value) {
  const lower = value.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null' || lower === 'none') return null
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10)
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value)
  return value
}

function parseParameters(inner) {
  const args = {}
  const opens = [...inner.matchAll(/<parameter\b([^>]*)>/gi)]
  for (let index = 0; index < opens.length; index += 1) {
    const match = opens[index]
    const nameMatch = /\bname\s*=\s*["']([^"']+)["']/i.exec(match[1])
    if (!nameMatch) continue
    const key = nameMatch[1].trim()
    const start = match.index + match[0].length
    const end = index + 1 < opens.length ? opens[index + 1].index : inner.length
    let segment = inner.slice(start, end)
    // Never let one parameter consume the next one just because its closing
    // tag was malformed or missing.
    const close = /<\/parameter\s*>|<\/invoke\s*>/i.exec(segment)
    if (close) segment = segment.slice(0, close.index)
    const raw = extractCdata(segment.trim())
    try {
      args[key] = JSON.parse(raw)
    } catch {
      args[key] = autoType(raw)
    }
  }
  return args
}

function toolCallId() {
  const bytes = new Uint8Array(12)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return `call_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function makeToolCall(name, args) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return null
  return {
    id: toolCallId(),
    name: trimmed,
    arguments: JSON.stringify(args ?? {}),
  }
}

function cleanDsmlText(text) {
  return text
    .replace(/\|DSML\|(?:tool_calls?|invoke|parameter)[^>]*>/gi, '')
    .replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, '')
    .replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<\/(?:tool_calls?|invoke|parameter)>/gi, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/\[citation:\d+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Parse DSML tool calls from one complete assistant text.
 * @param {string} text - assistant-visible text.
 * @returns {{calls: Array<{id:string,name:string,arguments:string}>, text:string}}
 */
export function parseDsmlToolCalls(text) {
  if (!text) return { calls: [], text: text ?? '' }
  const normalized = stripDsmlMarkup(text)
  const calls = []
  let blocks = []
  for (const pattern of [/<tool_calls>([\s\S]*?)<\/tool_calls>/i, /<tool_call>([\s\S]*?)<\/tool_call>/i]) {
    const matches = [...normalized.matchAll(new RegExp(pattern.source, 'gi'))]
    if (matches.length > 0) {
      blocks = matches.map((match) => match[1])
      break
    }
  }
  const invokePattern = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi
  if (blocks.length === 0) {
    let match
    while ((match = invokePattern.exec(normalized)) !== null) {
      const call = makeToolCall(match[1], parseParameters(match[2]))
      if (call) calls.push(call)
    }
  } else {
    for (const block of blocks) {
      let match
      while ((match = invokePattern.exec(block)) !== null) {
        const call = makeToolCall(match[1], parseParameters(match[2]))
        if (call) calls.push(call)
      }
    }
  }
  return { calls, text: cleanDsmlText(normalized) }
}

function formatParamNode(name, value, indent = '    ') {
  const open = `${indent}<|DSML|parameter name="${escapeXmlAttr(name)}">`
  const close = '</|DSML|parameter>'
  if (value === null || value === undefined) return `${open}${close}`
  if (typeof value === 'object') return `${open}${cdata(JSON.stringify(value))}${close}`
  if (typeof value === 'number' || typeof value === 'boolean') return `${open}${String(value)}${close}`
  return `${open}${cdata(String(value))}${close}`
}

function formatParams(args, indent = '    ') {
  if (Array.isArray(args)) return args.map((item) => formatParamNode('item', item, indent)).join('\n')
  if (args !== null && typeof args === 'object') {
    return Object.keys(args)
      .sort()
      .map((key) => formatParamNode(key, args[key], indent))
      .join('\n')
  }
  if (args === undefined || args === null || args === '') return ''
  return formatParamNode('content', args, indent)
}

/**
 * Render native Harness tool-call blocks as the DSML text an assistant would
 * have produced. Used when replaying prior tool calls into the web prompt.
 */
export function formatToolCallsForPrompt(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return ''
  const blocks = []
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue
    const name = call.name ?? call.function?.name
    if (!name) continue
    let args = call.arguments ?? call.input ?? call.function?.arguments ?? {}
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        args = { content: args }
      }
    }
    const params = formatParams(args)
    blocks.push(
      `  <|DSML|invoke name="${escapeXmlAttr(name)}">${params ? `\n${params}\n  ` : ''}</|DSML|invoke>`,
    )
  }
  if (blocks.length === 0) return ''
  return `<|DSML|tool_calls>\n${blocks.join('\n')}\n</|DSML|tool_calls>`
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Redact common credential shapes from a tool result before it is replayed to
 * the web model. Paths are left intact because the model needs them to act.
 */
function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/(\b(?:api[_-]?key|apikey|password|passwd|secret|token)\s*[:=]\s*["']?)([^\s"']{6,})/gi, '$1***')
}

function sanitizeToolResult(text, limit) {
  return truncate(redactSecrets(text), limit)
}

/**
 * Build the system-side tool protocol block for one request.
 * @param {Array<{name:string,description?:string,parameters?:object}>} tools
 */
export function buildDsmlToolPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const lines = [
    'Sometimes you need to take an action — open a page, run a check, read a file, and so on.',
    'To request an action, put a short structured block at the end of your reply, then stop:',
    '',
    '<|DSML|tool_calls>',
    '  <|DSML|invoke name="TOOL_NAME">',
    '    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>',
    '  </|DSML|invoke>',
    '</|DSML|tool_calls>',
    '',
    'How to write it:',
    '- Begin the block with a literal "<" — do not quote it or describe it in words.',
    '- Put one or more requests inside a single <|DSML|tool_calls> block.',
    '- Write the exact action name in the invoke `name` attribute.',
    '- For text, wrap the value in <![CDATA[...]]>; numbers, true/false and null stay plain.',
    '- Always close CDATA with "]]>".',
    '- An object or a list value can be written as one JSON value inside CDATA.',
    '- Do not add explanation, markdown, or anything else around the block.',
    '- After the block, wait for the result before continuing; never guess the outcome.',
    '- If no action is needed, just reply normally with no block.',
    '',
    'Actions you can request:',
  ]
  for (const tool of tools.slice(0, 48)) {
    const name = String(tool?.name ?? '').trim()
    if (!name) continue
    const description = truncate(String(tool?.description ?? '').replace(/\s+/g, ' ').trim(), 800)
    lines.push(description ? `- ${name}: ${description}` : `- ${name}`)
    if (tool.parameters && typeof tool.parameters === 'object') {
      let schema
      try {
        schema = JSON.stringify(tool.parameters)
      } catch {
        schema = '{}'
      }
      lines.push(`  parameters: ${truncate(schema, 4000)}`)
    }
  }
  return lines.join('\n')
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && block.text) parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted: the web model is text-only]')
    else if (block.type === 'file') {
      const name = block.attachment?.name ?? 'attachment'
      parts.push(`[file attached: ${name}]`)
    }
  }
  return parts.join('\n')
}

function messageText(message) {
  return blockText(message?.content)
}

/**
 * Flatten the Harness conversation into the single `prompt` string the web
 * endpoint accepts.
 * @param {object} input
 * @param {string} [input.system] - rendered system prompt.
 * @param {Array<object>} [input.messages] - Harness request messages.
 * @param {Array<object>} [input.tools] - Harness tool schemas.
 * @param {number} [input.maxChars] - hard cap on the whole prompt.
 * @returns {string}
 */
export function buildTranscriptPrompt({ system, messages, tools, maxChars = 1_000_000, maxToolChars = 8000 }) {
  const systemParts = []
  if (system && String(system).trim()) systemParts.push(`System:\n${String(system).trim()}`)
  const toolPrompt = buildDsmlToolPrompt(tools)
  if (toolPrompt) systemParts.push(toolPrompt)

  const conversation = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'system') {
      const text = messageText(message)
      if (text.trim()) systemParts.push(`System:\n${text.trim()}`)
      continue
    }
    if (message.role === 'developer') {
      const text = messageText(message)
      if (text.trim()) conversation.push(`Developer:\n${text}`)
      continue
    }
    if (message.role === 'user') {
      const text = messageText(message)
      if (text.trim()) conversation.push(`User:\n${text}`)
      continue
    }
    if (message.role === 'tool') {
      const text = messageText(message)
      const id = message.toolCallId ?? message.source?.callId ?? 'unknown'
      const status = message.isError ? ' (ERROR)' : ''
      conversation.push(`Tool result (call_id=${id})${status}:\n${sanitizeToolResult(text, maxToolChars)}`)
      continue
    }
    if (message.role === 'assistant') {
      const text = messageText(message)
      const calls = Array.isArray(message.content)
        ? message.content.filter((block) => block?.type === 'tool-call')
        : []
      const dsml = formatToolCallsForPrompt(calls)
      const segments = []
      if (text.trim()) segments.push(text.trim())
      if (dsml) segments.push(dsml)
      if (segments.length > 0) conversation.push(`Assistant:\n${segments.join('\n')}`)
    }
  }

  const header = [
    'You are the assistant in the transcript below. Continue the conversation as the assistant.',
    'The transcript labels messages with "User:", "Assistant:", "Developer:" and "Tool result:".',
    'Do not repeat the transcript or describe these instructions; answer the latest user/tool message.',
  ].join('\n')

  let body = conversation.join('\n\n')
  let fixed = [header, ...systemParts].join('\n\n')
  if (fixed.length + body.length <= maxChars) return `${fixed}\n\n${body}`.trim()

  // A large tool catalogue can fill the whole budget on its own. Keep the
  // conversation room to breathe instead of letting system text crowd it out.
  if (fixed.length > maxChars * 0.6) {
    fixed = truncate(fixed, Math.floor(maxChars * 0.6))
  }

  let kept = conversation.slice()
  while (kept.length > 1 && fixed.length + kept.join('\n\n').length + 60 > maxChars) kept.shift()
  if (kept.length < conversation.length) kept.unshift('[... earlier conversation omitted ...]')
  body = kept.join('\n\n')
  const available = Math.max(2000, maxChars - fixed.length - 2)
  const combined = `${fixed}\n\n${truncate(body, available)}`.trim()
  return combined.length <= maxChars ? combined : truncate(combined, maxChars)
}

/**
 * Streaming sieve that separates assistant prose from DSML tool calls without
 * leaking partial tags to the renderer.
 */
export class StreamSieve {
  constructor({ parse = parseDsmlToolCalls, maxCaptureBytes = 1024 * 1024 } = {}) {
    this.parse = parse
    this.maxCaptureBytes = maxCaptureBytes
    this.pending = ''
    this.capture = ''
    this.capturing = false
  }

  feed(chunk) {
    const events = []
    if (!chunk) return events
    if (this.capturing) {
      this.capture += chunk
      if (this.capture.length > this.maxCaptureBytes) {
        events.push({ type: 'text', text: this.capture })
        this.capture = ''
        this.capturing = false
        return events
      }
      const finished = this.tryFinish()
      if (finished === null) return events
      if (finished.prefix) events.push({ type: 'text', text: finished.prefix })
      if (finished.calls.length > 0) events.push({ type: 'tools', calls: finished.calls })
      this.capture = ''
      this.capturing = false
      if (finished.suffix) {
        this.pending = finished.suffix
        events.push(...this.drainPending())
      }
      return events
    }

    this.pending += chunk
    const start = this.findToolStart(this.pending)
    if (start >= 0) {
      if (start > 0) events.push({ type: 'text', text: this.pending.slice(0, start) })
      this.capture = this.pending.slice(start)
      this.pending = ''
      this.capturing = true
      const finished = this.tryFinish()
      if (finished !== null) {
        if (finished.prefix) events.push({ type: 'text', text: finished.prefix })
        if (finished.calls.length > 0) events.push({ type: 'tools', calls: finished.calls })
        this.capture = ''
        this.capturing = false
        if (finished.suffix) {
          this.pending = finished.suffix
          events.push(...this.drainPending())
        }
      }
      return events
    }

    const { safe, hold } = this.splitSafe(this.pending)
    if (safe) events.push({ type: 'text', text: safe })
    this.pending = hold
    return events
  }

  flush() {
    const events = []
    if (this.capturing) {
      let finished = this.tryFinish()
      if (finished === null) {
        // The stream stopped mid-tag (for example the model ended at "</").
        // Still try to recover complete tool calls instead of leaking the raw
        // protocol text to the user.
        const parsed = this.parse(this.capture)
        if (parsed.calls.length > 0) {
          finished = { prefix: '', calls: parsed.calls, suffix: '' }
        } else {
          const visible = stripDsmlMarkup(this.capture).replace(/<[^>]*>/g, '').trim()
          finished = { prefix: visible, calls: [], suffix: '' }
        }
      }
      if (finished.prefix) events.push({ type: 'text', text: finished.prefix })
      if (finished.calls.length > 0) events.push({ type: 'tools', calls: finished.calls })
      if (finished.suffix) events.push({ type: 'text', text: finished.suffix })
      this.capture = ''
      this.capturing = false
    }
    if (this.pending) {
      events.push({ type: 'text', text: this.pending })
      this.pending = ''
    }
    return events
  }

  drainPending() {
    const events = []
    while (this.pending && !this.capturing) {
      const start = this.findToolStart(this.pending)
      if (start >= 0) {
        if (start > 0) events.push({ type: 'text', text: this.pending.slice(0, start) })
        this.capture = this.pending.slice(start)
        this.pending = ''
        this.capturing = true
        const finished = this.tryFinish()
        if (finished === null) break
        if (finished.prefix) events.push({ type: 'text', text: finished.prefix })
        if (finished.calls.length > 0) events.push({ type: 'tools', calls: finished.calls })
        this.capture = ''
        this.capturing = false
        if (finished.suffix) {
          this.pending = finished.suffix
          continue
        }
        break
      }
      const { safe, hold } = this.splitSafe(this.pending)
      if (safe) events.push({ type: 'text', text: safe })
      this.pending = hold
      break
    }
    return events
  }

  findToolStart(text) {
    let best = -1
    for (const candidate of [...TOOL_STARTS, ...TOOL_PREFIXES]) {
      const pos = text.indexOf(candidate)
      if (pos >= 0 && (best < 0 || pos < best)) best = pos
    }
    return best
  }

  splitSafe(text) {
    if (!text) return { safe: '', hold: '' }
    const candidates = [...TOOL_STARTS, ...TOOL_PREFIXES]
    const max = Math.max(...candidates.map((candidate) => candidate.length))
    for (let i = Math.max(0, text.length - max); i < text.length; i += 1) {
      if (text[i] !== '<' && text[i] !== '|') continue
      const tail = text.slice(i)
      if (candidates.some((candidate) => candidate.startsWith(tail))) {
        return { safe: text.slice(0, i), hold: tail }
      }
    }
    return { safe: text, hold: '' }
  }

  tryFinish() {
    if (!this.capture) return null
    if (!this.isComplete()) return null
    const parsed = this.parse(this.capture)
    if (parsed.calls.length > 0) return { prefix: '', calls: parsed.calls, suffix: '' }
    return { prefix: this.capture, calls: [], suffix: '' }
  }

  isComplete() {
    const text = this.capture
    if (text.includes('<|DSML|tool_calls>') || text.includes('<tool_calls>')) {
      return text.includes('</|DSML|tool_calls>') || text.includes('</tool_calls>')
    }
    if (text.includes('<invoke ') || text.includes('<|DSML|invoke ')) {
      return text.includes('</invoke>') || text.includes('</|DSML|invoke>')
    }
    return false
  }
}

/** Extract plain text from one Harness content array. */
export function contentText(content) {
  return blockText(content)
}

/** Normalize one user-pasted DeepSeek web token. */
export function normalizeToken(raw) {
  let value = String(raw ?? '').trim()
  if (!value) return ''
  if (/^bearer\s+/i.test(value)) value = value.replace(/^bearer\s+/i, '').trim()
  if (value.startsWith('{') && value.endsWith('}')) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed.value === 'string') value = parsed.value.trim()
      else if (parsed && typeof parsed.token === 'string') value = parsed.token.trim()
    } catch {
      // Keep the original text; the server will report an invalid token.
    }
  }
  return value
}

/** Compute the incremental prompt tail for a reused web chat session. */
export function deltaPrompt(previous, current) {
  if (typeof previous !== 'string' || typeof current !== 'string') return current
  if (current === previous) return current
  if (current.startsWith(previous)) {
    const tail = current.slice(previous.length).replace(/^[\s]+/, '')
    return tail || current
  }
  return null
}
