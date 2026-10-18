#!/usr/bin/env node
// TLS ClientHello fingerprint probe (offline, dev-only; not shipped).
//
// Measures what the plugin's Node runtime actually puts on the wire:
// a raw ClientHello capture (via a local TCP listener), parsed into JA3
// plus the fields JA3 does not cover (GREASE, key_share, ALPN), then diffed
// against a reference Chrome ClientHello. Also captures a second variant
// with restricted ciphers/curves to show how much of the delta can be
// closed from inside Node.
//
// Run:  node tools/tls-probe.mjs
//
// Reference values (Chrome 155 on Windows 11, x64) below are the canonical
// Chrome JA3 string from JA3DB; update them from a real capture when the
// browser version changes.

import { createServer } from 'node:net'
import { connect } from 'node:tls'
import { createHash } from 'node:crypto'

const REFERENCE_LABEL = 'Chrome 155 / Windows 11 (JA3DB reference)'

// JA3 reference from JA3DB for current Chrome on Windows:
//   version 771, 15 ciphers (incl. GREASE 0x0a0a first), extensions, groups, points
const CHROME_JA3 = {
  version: 771,
  ciphers: [2570, 4865, 4866, 4867, 49195, 49199, 49196, 49200, 52393, 52392, 49171, 49172, 156, 157, 47, 53],
  extensions: [2570, 0, 23, 65281, 10, 11, 35, 16, 5, 13, 18, 51, 45, 43, 27, 17513],
  groups: [29, 23, 24],
  points: [0],
  notes: {
    grease: true,
    keyShareGroups: [29, 23],
    alpn: ['h2', 'http/1.1'],
  },
}

const GREASE = new Set([
  0x0a0a, 2570, 6682, 10794, 14906, 19018, 23130, 27242, 31354, 35466,
  39578, 43690, 47802, 51914, 56026, 60138, 64250,
])

function captureClientHello (tlsOptions) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.once('data', (buf) => {
        try { resolve(socket.remoteAddress ? buf : buf) } finally { socket.destroy(); server.close() }
      })
      socket.on('error', () => {})
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      connect({ port, host: '127.0.0.1', servername: 'chat.deepseek.com', rejectUnauthorized: false, ...tlsOptions }, () => {})
        .on('error', () => {}) // handshake aborts when we drop the listener; the ClientHello is already captured
      setTimeout(() => { server.close() }, 4000)
    })
  })
}

function parseClientHello (buf) {
  if (buf[0] !== 0x16) throw new Error('not a TLS handshake record')
  let p = 5 // record header (type 1 + version 2 + length 2), then handshake type
  if (buf[p] !== 0x01) throw new Error('not a ClientHello')
  p += 4 // handshake type 1 + length 3
  const version = buf.readUInt16BE(p); p += 2
  p += 32 // random
  p += 1 + buf[p] // session id
  const ciphersLen = buf.readUInt16BE(p); p += 2
  const ciphers = []
  for (; p < buf.length && ciphers.length < ciphersLen / 2; p += 2) ciphers.push(buf.readUInt16BE(p))
  p += 1 + buf[p] // compression methods
  const extLen = buf.readUInt16BE(p); p += 2
  const end = p + extLen
  const extensions = []
  let alpn = null, groups = [], sigalgs = [], keyShare = []
  while (p + 4 <= end) {
    const type = buf.readUInt16BE(p); p += 2
    const len = buf.readUInt16BE(p); p += 2
    const body = buf.subarray(p, p + len)
    extensions.push(type)
    if (type === 0x0010) { // ALPN
      const list = []
      let q = 2
      while (q < body.length) {
        const n = body[q]; list.push(body.subarray(q + 1, q + 1 + n).toString()); q += 1 + n
      }
      alpn = list
    } else if (type === 0x000a) { // supported_groups
      const n = body.readUInt16BE(0); const list = []
      for (let q = 0; q < n; q += 2) list.push(body.readUInt16BE(2 + q))
      groups = list
    } else if (type === 0x000d) { // signature_algorithms
      const n = body.readUInt16BE(0); const list = []
      for (let q = 0; q < n; q += 2) list.push(body.readUInt16BE(2 + q))
      sigalgs = list
    } else if (type === 0x0033) { // key_share
      const n = body.readUInt16BE(0); let q = 2
      while (q < body.length) {
        const g = body.readUInt16BE(q); q += 2
        const l = body.readUInt16BE(q); q += 2 + l
        keyShare.push(g)
      }
    }
    p += len
  }
  return { version, ciphers, extensions, alpn, groups, sigalgs, keyShare }
}

function ja3Of (info) {
  const raw = [info.version, info.ciphers.join('-'), info.extensions.join('-'), info.groups.join('-'), [0].join('-')].join(',')
  return { raw, md5: createHash('md5').update(raw).digest('hex') }
}

function report (label, info) {
  const ja3 = ja3Of(info)
  const chromeJa3Raw = [
    CHROME_JA3.version,
    CHROME_JA3.ciphers.join('-'),
    CHROME_JA3.extensions.join('-'),
    CHROME_JA3.groups.join('-'),
    CHROME_JA3.points.join('-'),
  ].join(',')
  console.log(`\n=== ${label} ===`)
  console.log(`record version : ${info.version}`)
  console.log(`ALPN offered   : ${info.alpn ? info.alpn.join(', ') : '(none)'}`)
  console.log(`ciphers        : ${info.ciphers.length}${info.ciphers.includes(2570) ? ' (GREASE present)' : ''}`)
  console.log(`  offered      : ${info.ciphers.map((c) => '0x' + c.toString(16).padStart(4, '0')).join(' ')}`)
  console.log(`groups         : ${info.groups.length}${info.groups.some((g) => GREASE.has(g)) ? ' (GREASE present)' : ''}`)
  console.log(`key_share      : ${info.keyShare.join(', ') || '(none)'}`)
  console.log(`extensions     : ${info.extensions.length}`)
  console.log(`  order        : ${info.extensions.map((e) => '0x' + e.toString(16).padStart(4, '0')).join(' ')}`)
  console.log(`sigalgs        : ${info.sigalgs.length}`)
  console.log(`JA3            : ${ja3.raw}`)
  console.log(`JA3 md5        : ${ja3.md5}`)
  const extA = info.extensions
  console.log(`--- delta vs ${REFERENCE_LABEL} ---`)
  console.log(`reference JA3  : ${chromeJa3Raw}`)
  console.log(`cipher count   : node ${info.ciphers.length} vs chrome ${CHROME_JA3.ciphers.length}`)
  const sameOrder = JSON.stringify(extA) === JSON.stringify(CHROME_JA3.extensions)
  console.log(`exact ext order match : ${sameOrder}`)
  console.log(`GREASE in ext  : ${extA.some((e) => GREASE.has(e)) ? 'yes' : 'no (chrome: yes)'}`)
  console.log(`GREASE cipher  : ${info.ciphers.some((c) => GREASE.has(c)) ? 'yes' : 'no (chrome: yes)'}`)
  const ksOk = CHROME_JA3.notes.keyShareGroups.every((g) => info.keyShare.includes(g))
  console.log(`key_share sets : node ${info.keyShare.length} entries vs chrome ${CHROME_JA3.notes.keyShareGroups.length} (chrome 29,23 both present: ${ksOk})`)
}

const nodeDefault = parseClientHello(await captureClientHello())
report('Node default (what the plugin sends today)', nodeDefault)

const restricted = parseClientHello(await captureClientHello({
  ciphers: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256',
  ecdhCurve: 'X25519:P-256:P-384',
  ALPNProtocols: ['http/1.1'],
}))
report('Node with ciphers/curves restricted (max in-process lever)', restricted)

console.log('\nInterpretation: everything above the ALPN line is decided by Node/OpenSSL')
console.log('and cannot be reordered, GREASE-injected, or key-share-tuned from JS.')
console.log('The remaining browser deltas live in extension shape, not just values.')
