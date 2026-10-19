import { createHash } from 'node:crypto'

/**
 * SHA3-512, two implementations in one module.
 *
 * The sentinel proof of work needs sha3-512 over `seed + nonce`. Node's
 * `crypto.createHash('sha3-512')` is the fast path on a Node host with OpenSSL
 * 1.1.1+, but it is **not** available everywhere this plugin runs: the Harness
 * desktop app runs inside Electron, whose BoringSSL build answers
 * `Digest method not supported` for SHA-3 — the same reason the DeepSeek PoW
 * solver ships a WebAssembly sha3 instead of using `createHash`.
 *
 * So the native hash is used when it exists, and a self-contained Keccak-f[1600]
 * implementation covers every other host. `sha3_512HexJs` is exported so the
 * pure path can be unit-tested against the native one.
 */

/**
 * Iota round constants, as 64-bit values. They are split into 32-bit halves at
 * load time: hand-splitting them (as an earlier revision did) silently drops a
 * nibble — `0x0000000000008082` became `0x00000082` — which produces a
 * plausible but wrong digest. The values are the standard Keccak-f[1600]
 * constants and can be reproduced from the FIPS-202 LFSR if they ever need
 * re-deriving.
 */
const RC_64 = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const RC_LO = RC_64.map((value) => Number(value & 0xffffffffn))
const RC_HI = RC_64.map((value) => Number((value >> 32n) & 0xffffffffn))
/** Rotation offsets rho[x][y], flattened as x + 5*y. */
const RHO = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]

const RATE_BYTES = 72 // (1600 - 2*512) / 8
const OUT_BYTES = 64

// The permutation works on module-level state and scratch arrays. It is
// synchronous and single-threaded, and the PoW search runs it tens of thousands
// of times per turn, so nothing in the hot path allocates.
const S_LO = new Array(25)
const S_HI = new Array(25)
const C_LO = new Array(5)
const C_HI = new Array(5)
const D_LO = new Array(5)
const D_HI = new Array(5)
const B_LO = new Array(25)
const B_HI = new Array(25)
// `rotl` writes its result here instead of returning an array.
let R_LO = 0
let R_HI = 0
let PAD = new Uint8Array(RATE_BYTES * 2)

function toBytes(data) {
  if (data instanceof Uint8Array) return data
  return new TextEncoder().encode(String(data))
}

function rotl(x, y, n) {
  // Rotate the 64-bit lane (lo=x, hi=y) left by n bits. Results land in R_LO /
  // R_HI: returning an array allocated two objects per call, and the PoW search
  // makes 600 of these calls per hash.
  if (n === 0) {
    R_LO = x
    R_HI = y
    return
  }
  // `x >>> 32` is `x` in JS (the shift count is taken mod 32), so a rotation by
  // exactly half a word needs its own branch.
  if (n === 32) {
    R_LO = y
    R_HI = x
    return
  }
  if (n < 32) {
    R_LO = ((x << n) | (y >>> (32 - n))) >>> 0
    R_HI = ((y << n) | (x >>> (32 - n))) >>> 0
    return
  }
  const m = n - 32
  R_LO = ((y << m) | (x >>> (32 - m))) >>> 0
  R_HI = ((x << m) | (y >>> (32 - m))) >>> 0
}

function keccakF() {
  for (let round = 0; round < 24; round += 1) {
    // Theta. Every bitwise result is masked back to unsigned: JS `^`/`&` return
    // signed int32, and a negative lane would serialise as "-…" in the digest.
    for (let x = 0; x < 5; x += 1) {
      C_LO[x] = (S_LO[x] ^ S_LO[x + 5] ^ S_LO[x + 10] ^ S_LO[x + 15] ^ S_LO[x + 20]) >>> 0
      C_HI[x] = (S_HI[x] ^ S_HI[x + 5] ^ S_HI[x + 10] ^ S_HI[x + 15] ^ S_HI[x + 20]) >>> 0
    }
    for (let x = 0; x < 5; x += 1) {
      const xm1 = (x + 4) % 5
      const xp1 = (x + 1) % 5
      rotl(C_LO[xp1], C_HI[xp1], 1)
      D_LO[x] = (C_LO[xm1] ^ R_LO) >>> 0
      D_HI[x] = (C_HI[xm1] ^ R_HI) >>> 0
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        S_LO[x + y] = (S_LO[x + y] ^ D_LO[x]) >>> 0
        S_HI[x + y] = (S_HI[x + y] ^ D_HI[x]) >>> 0
      }
    }
    // Rho + Pi. The lane at (x, y) moves to (y, (2x + 3y) % 5) after rotating.
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const i = x + 5 * y
        const j = y + 5 * ((2 * x + 3 * y) % 5)
        rotl(S_LO[i], S_HI[i], RHO[i])
        B_LO[j] = R_LO
        B_HI[j] = R_HI
      }
    }
    // Chi.
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x += 1) {
        S_LO[x + y] = (B_LO[x + y] ^ ((~B_LO[((x + 1) % 5) + y] >>> 0) & B_LO[((x + 2) % 5) + y])) >>> 0
        S_HI[x + y] = (B_HI[x + y] ^ ((~B_HI[((x + 1) % 5) + y] >>> 0) & B_HI[((x + 2) % 5) + y])) >>> 0
      }
    }
    // Iota.
    S_LO[0] = (S_LO[0] ^ RC_LO[round]) >>> 0
    S_HI[0] = (S_HI[0] ^ RC_HI[round]) >>> 0
  }
}

/** Absorb and permute `data` into the module state, then squeeze the digest. */
function hashState(data) {
  const bytes = toBytes(data)
  const length = bytes.length
  const padLength = RATE_BYTES - (length % RATE_BYTES)
  const total = length + padLength
  if (PAD.length < total) PAD = new Uint8Array(total * 2)
  const padded = PAD
  padded.set(bytes)
  // The buffer is reused between calls, so the padding region has to be cleared
  // explicitly: a shorter message would otherwise hash leftovers of a longer one.
  padded.fill(0, length, total)
  padded[length] = 0x06 // SHA-3 domain separation + pad start
  padded[total - 1] |= 0x80

  for (let i = 0; i < 25; i += 1) {
    S_LO[i] = 0
    S_HI[i] = 0
  }
  for (let offset = 0; offset < total; offset += RATE_BYTES) {
    for (let i = 0; i < RATE_BYTES; i += 8) {
      const lane = i / 8
      const base = offset + i
      // Absorb XORs each block into the state; overwriting it is only
      // equivalent for the first block.
      S_LO[lane] =
        (S_LO[lane] ^ (padded[base] | (padded[base + 1] << 8) | (padded[base + 2] << 16) | (padded[base + 3] << 24))) >>> 0
      S_HI[lane] =
        (S_HI[lane] ^
          (padded[base + 4] | (padded[base + 5] << 8) | (padded[base + 6] << 16) | (padded[base + 7] << 24))) >>> 0
    }
    keccakF()
  }
}

const NIBBLES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f']

/**
 * Serialise the state as hex. Lane `n` holds digest bytes 8n..8n+7 with byte 0
 * in the least significant position, so each 32-bit word is emitted least
 * significant byte first — printing the words with `padStart` alone reverses
 * every quartet and silently produces a wrong digest.
 */
function stateHex(chars) {
  let out = ''
  for (let lane = 0; lane < 8 && out.length < chars; lane += 1) {
    for (const word of [S_LO[lane], S_HI[lane]]) {
      const value = word >>> 0
      const digits = [
        NIBBLES[(value >>> 28) & 0xf],
        NIBBLES[(value >>> 24) & 0xf],
        NIBBLES[(value >>> 20) & 0xf],
        NIBBLES[(value >>> 16) & 0xf],
        NIBBLES[(value >>> 12) & 0xf],
        NIBBLES[(value >>> 8) & 0xf],
        NIBBLES[(value >>> 4) & 0xf],
        NIBBLES[value & 0xf],
      ]
      out += digits[6] + digits[7] + digits[4] + digits[5] + digits[2] + digits[3] + digits[0] + digits[1]
      if (out.length >= chars) return out.slice(0, chars)
    }
  }
  return out
}

/** Pure-JavaScript SHA3-512 hex digest. */
export function sha3_512HexJs(data) {
  hashState(data)
  return stateHex(OUT_BYTES * 2)
}

/**
 * The first `chars` hex digits of the digest. The proof-of-work check only
 * looks at the leading zeros, so this skips serialising the other 112.
 */
export function sha3_512HexPrefix(data, chars) {
  const width = Math.max(1, Math.min(OUT_BYTES * 2, Math.round(chars) || 1))
  if (hasNativeSha3()) return nativeHash('sha3-512').update(data).digest('hex').slice(0, width)
  hashState(data)
  return stateHex(width)
}

let nativeHash = null
let nativeChecked = false

/** True when the host's `createHash` supports sha3-512. */
export function hasNativeSha3() {
  if (!nativeChecked) {
    nativeChecked = true
    try {
      const digest = createHash('sha3-512').update('probe').digest('hex')
      nativeHash = digest.length === 128 ? createHash : null
    } catch {
      // Electron/BoringSSL and FIPS-restricted builds land here.
      nativeHash = null
    }
  }
  return nativeHash !== null
}

/**
 * SHA3-512 hex digest, native when the host supports it and pure JS otherwise.
 * Pass `chars` to get only a prefix of the digest.
 */
export function sha3_512Hex(data, chars) {
  return sha3_512HexPrefix(data, chars ?? OUT_BYTES * 2)
}
