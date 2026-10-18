import assert from 'node:assert/strict'
import { solvePow } from '../pow.js'
import {
  buildTranscriptPrompt,
  deltaPrompt,
  normalizeToken,
  parseDsmlToolCalls,
  StreamSieve,
} from '../dsml.js'
import { DeepSeekWebAdapter, MODELS, PROVIDER } from '../deepseek-web.js'

const sample = `I'll inspect the file.

<|DSML|tool_calls>
  <|DSML|invoke name="read">
    <|DSML|parameter name="file_path"><![CDATA[src/index.ts]]></|DSML|parameter>
    <|DSML|parameter name="offset">12</|DSML|parameter>
    <|DSML|parameter name="limit">40</|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`

const parsed = parseDsmlToolCalls(sample)
assert.equal(parsed.calls.length, 1, 'one tool call')
assert.equal(parsed.calls[0].name, 'read')
assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { file_path: 'src/index.ts', offset: 12, limit: 40 })
assert.equal(parsed.text, "I'll inspect the file.", 'markup removed from visible text')

const bare = parseDsmlToolCalls('<|DSML|invoke name="bash"><|DSML|parameter name="command"><![CDATA[echo hi]]></|DSML|parameter></|DSML|invoke>')
assert.equal(bare.calls.length, 1)
assert.equal(JSON.parse(bare.calls[0].arguments).command, 'echo hi')

// DeepSeek web sometimes drops the ">" of a "]]>" CDATA close. That used to
// make one parameter swallow the next one's markup.
const malformedCdata = parseDsmlToolCalls(`<|DSML|tool_calls>
  <|DSML|invoke name="pwsh">
    <|DSML|parameter name="description"><![CDATA[Check token]]</|DSML|parameter>
    <|DSML|parameter name="command"><![CDATA[Get-ChildItem]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`)
assert.equal(malformedCdata.calls.length, 1)
assert.deepEqual(JSON.parse(malformedCdata.calls[0].arguments), {
  description: 'Check token',
  command: 'Get-ChildItem',
})

// Extra attributes on <parameter> must not hide the argument.
const extraAttr = parseDsmlToolCalls(
  '<|DSML|invoke name="pwsh"><|DSML|parameter name="command" string="true"><![CDATA[echo hi]]></|DSML|parameter></|DSML|invoke>',
)
assert.equal(extraAttr.calls.length, 1)
assert.equal(JSON.parse(extraAttr.calls[0].arguments).command, 'echo hi')

// A response truncated mid-closing-tag must still yield its completed call
// instead of dumping raw protocol markup into the chat.
const truncated = new StreamSieve()
const truncatedTools = []
let truncatedText = ''
const truncatedChunk = `|DSML|tool_calls>
  <|DSML|invoke name="read">
    <|DSML|parameter name="file_path"><![CDATA[a.ts]]></|DSML|parameter>
  </|DSML|invoke>
</`
for (const event of truncated.feed(truncatedChunk)) {
  if (event.type === 'text') truncatedText += event.text
  if (event.type === 'tools') truncatedTools.push(...event.calls)
}
for (const event of truncated.flush()) {
  if (event.type === 'text') truncatedText += event.text
  if (event.type === 'tools') truncatedTools.push(...event.calls)
}
assert.equal(truncatedTools.length, 1, 'truncated block still yields its tool call')
assert.equal(truncatedText, '', 'no raw protocol markup leaks to the user')

const sieve = new StreamSieve()
let text = ''
const tools = []
const chunks = [
  'Hello ',
  '<|DSML|tool_',
  'calls>\n  <|DSML|invoke name="read">\n    <|DSML|parameter name="file_path"><![CDATA[a.ts]]></|DSML|parameter>\n  </|DSML|invoke>\n</|DSML|tool_calls>',
]
for (const chunk of chunks) {
  for (const event of sieve.feed(chunk)) {
    if (event.type === 'text') text += event.text
    if (event.type === 'tools') tools.push(...event.calls)
  }
}
for (const event of sieve.flush()) {
  if (event.type === 'text') text += event.text
  if (event.type === 'tools') tools.push(...event.calls)
}
assert.equal(text, 'Hello ', 'prose is emitted without leaked tags')
assert.equal(tools.length, 1, 'streamed tool call parsed')
assert.equal(JSON.parse(tools[0].arguments).file_path, 'a.ts')

const plain = new StreamSieve()
let plainText = ''
for (const chunk of ['A ', 'plain ', 'answer.']) {
  for (const event of plain.feed(chunk)) if (event.type === 'text') plainText += event.text
}
for (const event of plain.flush()) if (event.type === 'text') plainText += event.text
assert.equal(plainText, 'A plain answer.')

const prompt = buildTranscriptPrompt({
  system: 'You are a test agent.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Read a.ts' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call1', name: 'read', arguments: '{"file_path":"a.ts"}' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call1' }, toolCallId: 'call1', content: [{ type: 'text', text: 'file body' }] },
  ],
  tools: [
    {
      name: 'read',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    },
  ],
})
assert.match(prompt, /Actions you can request:/)
assert.match(prompt, /Tool result \(call_id=call1\):/)
assert.match(prompt, /<\|DSML\|tool_calls>/)
assert.match(prompt, /file body/)

// Tool results are truncated and secret-redacted before replay.
const secretPrompt = buildTranscriptPrompt({
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'run' }] },
    {
      role: 'tool',
      toolCallId: 'call2',
      content: [{ type: 'text', text: `api_key=supersecretvalue123\n${'x'.repeat(5000)}` }],
    },
  ],
  tools: [],
  maxToolChars: 1000,
})
assert.doesNotMatch(secretPrompt, /supersecretvalue123/)
assert.match(secretPrompt, /api_key=\*\*\*/)
assert.ok(secretPrompt.length < 2000, 'tool result is truncated')

assert.equal(deltaPrompt('User: a', 'User: a\n\nUser: b'), 'User: b')
assert.equal(deltaPrompt('User: a', 'User: a'), 'User: a')
assert.equal(deltaPrompt('User: a', 'User: z'), null)

assert.equal(normalizeToken('Bearer abc'), 'abc')
assert.equal(normalizeToken('{"value":"abc","__version":"0"}'), 'abc')
assert.equal(normalizeToken('abc'), 'abc')

const pow = await solvePow(
  {
    algorithm: 'DeepSeekHashV1',
    challenge: '17f75b5e0984f15fc0b8def0c77b48ee4b41b1865f5e8217971722f7870ad4cb',
    salt: 'cba9b8a9bf8368b6341c',
    signature: 'b9f07214b4519ac8a6b976e22a3c2228e30b0738009e21122135539e69862f6a',
    difficulty: 144000,
    expire_at: 1785354733914,
  },
  '/api/v0/chat/completion',
)
assert.equal(pow.algorithm, 'DeepSeekHashV1')
assert.equal(typeof pow.answer, 'number')
assert.equal(pow.target_path, '/api/v0/chat/completion')

const adapter = new DeepSeekWebAdapter({ resolveToken: async () => 'test-token' })
const models = await adapter.listModels()
assert.equal(models.length, MODELS.length)
assert.ok(models.every((model) => model.provider === PROVIDER))
assert.ok(models.every((model) => model.context.contextWindow === 1_000_000), 'web models report a 1M-token context')
assert.equal(adapter.maxPromptChars, 1_000_000, 'prompt budget matches the reported context')
const prepared = await adapter.prepareCall(PROVIDER, 'deepseek-web-thinking')
assert.equal(prepared.model.reasoning.defaultEffort, 'high')
assert.equal(typeof prepared.stream, 'function')

console.log('selftest: ok')
