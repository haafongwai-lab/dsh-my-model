import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hasNativeSha3, sha3_512Hex, sha3_512HexJs, sha3_512HexPrefix } from '../sha3.js'
import { parseDifficulty, solveProofOfWork } from '../chatgpt-web.js'

// The pure-JS digest is the fallback for hosts whose OpenSSL/BoringSSL has no
// SHA-3 (Electron throws "Digest method not supported"). It must be
// byte-identical to the native one, including multi-block messages — an earlier
// revision matched for short inputs and silently diverged past one block.
const vectors = [
  '',
  'abc',
  'a',
  'The quick brown fox jumps over the lazy dog',
  'x'.repeat(71),
  'x'.repeat(72),
  'y'.repeat(73),
  'z'.repeat(144),
  'z'.repeat(145),
  'z'.repeat(216),
  'z'.repeat(217),
  'seed-value0',
  'pow-seed123',
  'é中文'.repeat(30),
  'a'.repeat(1000),
]
for (const value of vectors) {
  const native = createHash('sha3-512').update(value).digest('hex')
  assert.equal(sha3_512HexJs(value), native, `pure JS digest for length ${value.length}`)
  assert.equal(sha3_512Hex(value), native, `wrapper digest for length ${value.length}`)
  for (const chars of [1, 4, 5, 6, 8, 16, 128]) {
    assert.equal(sha3_512HexPrefix(value, chars), native.slice(0, chars), `prefix ${chars} for length ${value.length}`)
  }
}

// The padded buffer is reused between calls, so a shorter message must not
// inherit bytes from a longer one.
for (let i = 0; i < 200; i += 1) {
  const value = 'q'.repeat(i % 200)
  assert.equal(sha3_512HexJs(value), createHash('sha3-512').update(value).digest('hex'), `sweep length ${value.length}`)
}

// The sentinel difficulty is a hex **threshold**, not a mask: the digest's
// leading `width` hex digits must be <= the difficulty. The value below is the
// one chatgpt.com actually sent ("0717f3"); reading it as a prefix mask made the
// search impossible and burned 976 000 hashes.
assert.deepEqual(parseDifficulty('0717f3'), { text: '0717f3', width: 6 })
assert.deepEqual(parseDifficulty('0000'), { text: '0000', width: 4 })
assert.equal(parseDifficulty(''), null)
assert.equal(parseDifficulty('not-hex'), null)
{
  const difficulty = '0717f3'
  const proof = await solveProofOfWork({ seed: 'sentinel-seed', difficulty })
  assert.equal(proof.algorithm, 'sha3-512')
  assert.equal(proof.difficulty, difficulty)
  const head = createHash('sha3-512').update(`sentinel-seed${proof.nonce}`).digest('hex').slice(0, 6)
  assert.ok(head <= difficulty, `digest head 0x${head} must be <= 0x${difficulty}`)
  assert.ok(proof.attempts < 2000, `threshold search converges quickly (${proof.attempts} hashes)`)
}

// A zeros difficulty degenerates to the leading-zero rule.
{
  const proof = await solveProofOfWork({ seed: 'zero-seed', difficulty: '0000' })
  const head = createHash('sha3-512').update(`zero-seed${proof.nonce}`).digest('hex').slice(0, 4)
  assert.equal(head, '0000')
}

// The search must hand the thread back rather than block it: a timer scheduled
// before a long (unconverging) solve has to fire while the solve is running.
// "000000" needs six exact zeros, so it never converges inside the budget.
{
  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
  }, 5)
  await assert.rejects(
    solveProofOfWork({ seed: 'never-converges', difficulty: '000000' }, { timeBudgetMs: 1200 }),
    (error) => error.code === 'CHALLENGE_UNSOLVED',
  )
  clearInterval(timer)
  assert.ok(ticks > 5, `the event loop kept running during the search (${ticks} ticks)`)
}

console.log(`sha3: ok (native sha3 available: ${hasNativeSha3()})`)
