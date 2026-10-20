import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadlessChromeError, ManagedChrome, headlessChromeArgs } from '../headless-chrome.js'

const profileDir = mkdtempSync(join(tmpdir(), 'my-model-headless-'))
const sleep = async () => {}

// Fixed launch shape: headless, dedicated profile/port, no visible window.
{
  const args = headlessChromeArgs({
    port: 9333,
    profileDir,
    url: 'https://chat.deepseek.com/',
  })
  assert.ok(args.includes('--headless=new'))
  assert.ok(args.includes('--remote-debugging-port=9333'))
  assert.ok(args.includes(`--user-data-dir=${profileDir}`))
  assert.equal(args.at(-1), 'https://chat.deepseek.com/')
  // Cloudflare binds cf_clearance to the UA, so a managed browser that serves
  // chatgpt.com must send normal Chrome's string from the first request.
  const withUa = headlessChromeArgs({
    port: 9333,
    profileDir,
    userAgent: 'Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36',
  })
  assert.ok(withUa.includes('--user-agent=Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36'))
}

// Start once, then reuse the live process (no duplicate Chrome).
{
  let reachable = false
  let spawnCalls = 0
  const child = { pid: 4321, once() {}, unref() {}, kill() {} }
  const manager = new ManagedChrome({
    port: 9333,
    profileDir,
    executable: 'C:\\Chrome\\chrome.exe',
    exists: () => true,
    platform: 'win32',
    probe: async () => ({ reachable, browser: 'Chrome/155.0.0.0' }),
    spawnImpl: (_path, args) => {
      spawnCalls += 1
      assert.ok(args.includes('--headless=new'))
      reachable = true
      return child
    },
    sleepImpl: sleep,
    waitMs: 3000,
    pollMs: 10,
  })
  const first = await manager.ensure()
  assert.equal(first.running, true)
  assert.equal(first.launched, true)
  assert.equal(first.pid, 4321)
  assert.equal(spawnCalls, 1)
  assert.equal(existsSync(join(profileDir, 'headless.pid')), true)
  assert.equal(readFileSync(join(profileDir, 'headless.pid'), 'utf8').trim(), '4321')

  const second = await manager.ensure()
  assert.equal(second.running, true)
  assert.equal(spawnCalls, 1, 'an already-running instance is adopted, not duplicated')

  // Avoid taskkill/process.kill on the fake PID: model the process exit instead.
  manager.killTree = () => {
    reachable = false
  }
  const stopped = await manager.stop()
  assert.equal(stopped.running, false)
  assert.equal(existsSync(join(profileDir, 'headless.pid')), false)
}

// A reachable endpoint from a previous Harness run is adopted without spawning.
{
  let spawnCalls = 0
  const manager = new ManagedChrome({
    port: 9334,
    profileDir,
    executable: 'C:\\Chrome\\chrome.exe',
    exists: () => true,
    platform: 'win32',
    probe: async () => ({ reachable: true, browser: 'Chrome/155.0.0.0' }),
    spawnImpl: () => {
      spawnCalls += 1
      throw new Error('should not spawn')
    },
    sleepImpl: sleep,
  })
  const result = await manager.ensure()
  assert.equal(result.running, true)
  assert.equal(result.alreadyRunning, true)
  assert.equal(spawnCalls, 0)
}

// No browser installed is a terminal, named failure (no Node/provider fallback).
{
  const manager = new ManagedChrome({
    port: 9335,
    profileDir,
    executable: 'C:\\missing\\chrome.exe',
    exists: () => false,
    platform: 'win32',
    probe: async () => ({ reachable: false }),
    sleepImpl: sleep,
  })
  await assert.rejects(
    manager.ensure(),
    (error) => error instanceof HeadlessChromeError && error.code === 'CHROME_NOT_FOUND',
  )
}

// Invalid config fails before spawning anything.
assert.throws(
  () => new ManagedChrome({ port: 0 }),
  (error) => error instanceof HeadlessChromeError && error.code === 'BAD_PORT',
)

// A browser that exits before opening its port is reported, not silently
// retried forever.
{
  let exitHandler
  let reachable = false
  const child = {
    pid: 9876,
    once(type, handler) {
      if (type === 'exit') exitHandler = handler
    },
    unref() {},
    kill() {},
  }
  const manager = new ManagedChrome({
    port: 9336,
    profileDir,
    executable: 'C:\\Chrome\\chrome.exe',
    exists: () => true,
    platform: 'win32',
    probe: async () => ({ reachable }),
    spawnImpl: () => {
      setImmediate(() => exitHandler?.(0, null))
      return child
    },
    sleepImpl: async () => {
      // Let the exit event fire, then keep the probe unreachable.
      await new Promise((resolve) => setImmediate(resolve))
    },
    waitMs: 1000,
    pollMs: 5,
  })
  manager.killTree = () => {}
  await assert.rejects(
    manager.ensure(),
    (error) => error instanceof HeadlessChromeError && error.code === 'CHROME_EXITED',
  )
}

rmSync(profileDir, { recursive: true, force: true })
console.log('headless-chrome: ok')
