import assert from 'node:assert/strict'
import { DeepSeekWebClient } from '../deepseek-web.js'

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

console.log('stream-smoke: ok')
