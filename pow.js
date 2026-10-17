/**
 * DeepSeekHashV1 proof-of-work solver.
 *
 * The browser build of chat.deepseek.com ships a small WebAssembly module that
 * searches for the nonce the backend expects in `x-ds-pow-response`. This file
 * is a small ESM port of the MIT-licensed `@rezaparsian/deepseek-pow-solver`
 * package, bundled with its `sha3_wasm_bg.wasm` so the plugin has no runtime
 * dependency to install.
 *
 * Original package: https://www.npmjs.com/package/@rezaparsian/deepseek-pow-solver
 * License: MIT
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let wasmPromise
let wasm
let memoryView
let dataView

function refreshViews() {
  if (memoryView === null || memoryView.buffer !== wasm.memory.buffer) {
    memoryView = new Uint8Array(wasm.memory.buffer)
    dataView = new DataView(wasm.memory.buffer)
  }
}

function writeString(text) {
  const bytes = new TextEncoder().encode(text)
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1) >>> 0
  refreshViews()
  memoryView.set(bytes, ptr)
  return { ptr, len: bytes.length }
}

function solveRaw({ algorithm, challenge, salt, difficulty, expire_at }) {
  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported DeepSeek PoW algorithm: ${algorithm}`)
  }
  const prefix = `${salt}_${expire_at}_`
  const stackPtr = wasm.__wbindgen_add_to_stack_pointer(-16)
  let challengePtr
  let prefixPtr
  try {
    challengePtr = writeString(challenge)
    prefixPtr = writeString(prefix)
    wasm.wasm_solve(
      stackPtr,
      challengePtr.ptr,
      challengePtr.len,
      prefixPtr.ptr,
      prefixPtr.len,
      difficulty,
    )
    refreshViews()
    const status = dataView.getInt32(stackPtr, true)
    const answer = dataView.getFloat64(stackPtr + 8, true)
    if (status === 0) throw new Error('DeepSeek PoW solver found no solution')
    return Math.trunc(answer)
  } finally {
    try {
      if (challengePtr) wasm.__wbindgen_export_2(challengePtr.ptr, challengePtr.len, 1)
      if (prefixPtr) wasm.__wbindgen_export_2(prefixPtr.ptr, prefixPtr.len, 1)
    } catch {
      // Freeing is best-effort; the module remains usable either way.
    }
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}

async function loadWasm() {
  if (wasm !== undefined) return wasm
  if (wasmPromise === undefined) {
    wasmPromise = (async () => {
      const path = fileURLToPath(new URL('./sha3_wasm_bg.wasm', import.meta.url))
      const bytes = readFileSync(path)
      const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} })
      wasm = instance.exports
      memoryView = null
      dataView = null
      refreshViews()
      return wasm
    })()
  }
  return wasmPromise
}

/**
 * Solve one challenge and return the JSON object DeepSeek expects in its
 * `x-ds-pow-response` header (before base64 encoding).
 * @param {object} challenge - `data.biz_data.challenge` from create_pow_challenge.
 * @param {string} [targetPath] - API path the challenge was requested for.
 * @returns {Promise<object>} the payload with `algorithm`, `challenge`, `salt`,
 * `answer`, `signature`, and `target_path`.
 */
export async function solvePow(challenge, targetPath) {
  await loadWasm()
  if (challenge === null || typeof challenge !== 'object') {
    throw new Error('DeepSeek PoW challenge is missing')
  }
  const algorithm = String(challenge.algorithm ?? 'DeepSeekHashV1')
  const answer = solveRaw({
    algorithm,
    challenge: String(challenge.challenge ?? ''),
    salt: String(challenge.salt ?? ''),
    difficulty: Number(challenge.difficulty ?? 0),
    expire_at: Number(challenge.expire_at ?? 0),
  })
  return {
    algorithm,
    challenge: String(challenge.challenge ?? ''),
    salt: String(challenge.salt ?? ''),
    answer,
    signature: String(challenge.signature ?? ''),
    target_path: targetPath ?? String(challenge.target_path ?? '/api/v0/chat/completion'),
  }
}
