import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  LaunchError,
  PROFILE_DIR_NAME,
  chromeCandidates,
  chromeLaunchArgs,
  defaultUserDataDir,
  findChrome,
  launchChrome,
} from '../chrome-launch.js'

const win32 = {
  platform: 'win32',
  env: {
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  },
  home: 'C:\\Users\\tester',
}

// --- profile and executable discovery -------------------------------------

assert.equal(
  defaultUserDataDir(win32),
  'C:\\Users\\tester\\AppData\\Local\\dsh-chrome',
  'Windows keeps the dedicated profile under LOCALAPPDATA',
)
assert.equal(
  defaultUserDataDir({ platform: 'darwin', env: {}, home: '/Users/tester' }),
  '/Users/tester/Library/Application Support/dsh-chrome',
)
assert.equal(
  defaultUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/tester/.config2' }, home: '/home/tester' }),
  '/home/tester/.config2/dsh-chrome',
  'XDG_CONFIG_HOME is respected',
)
assert.ok(defaultUserDataDir({ platform: 'linux', env: {}, home: '/home/tester' }).endsWith(`/${PROFILE_DIR_NAME}`))

const windowsCandidates = chromeCandidates(win32)
assert.ok(
  windowsCandidates.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
  'the standard Chrome install is checked first',
)
assert.ok(
  windowsCandidates.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'),
  'Edge is a valid Chromium fallback',
)
const linuxCandidates = chromeCandidates({
  platform: 'linux',
  env: { PATH: '/usr/local/bin:/usr/bin' },
  home: '/home/tester',
})
assert.ok(linuxCandidates.includes('/usr/local/bin/google-chrome'), 'PATH entries are searched on Linux')

assert.equal(
  findChrome({ ...win32, exists: (path) => path === 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' }),
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'the first existing candidate wins',
)
assert.equal(findChrome({ ...win32, exists: () => false }), undefined, 'no candidate means no browser')
assert.equal(
  findChrome({ ...win32, configured: 'D:\\Portable\\chrome.exe', exists: (path) => path === 'D:\\Portable\\chrome.exe' }),
  'D:\\Portable\\chrome.exe',
  'an explicitly configured executable wins',
)
assert.equal(
  findChrome({ ...win32, configured: 'D:\\Missing\\chrome.exe', exists: () => false }),
  undefined,
  'a configured path that does not exist is an error, not a silent fallback',
)

// --- launch arguments ------------------------------------------------------

const args = chromeLaunchArgs({ port: 9333, profileDir: 'C:\\Profiles\\dsh-chrome' })
assert.ok(args.includes('--remote-debugging-port=9333'))
assert.ok(args.includes('--user-data-dir=C:\\Profiles\\dsh-chrome'))
assert.equal(args[args.length - 1], 'https://chatgpt.com/', 'the tab that opens is the one the plugin needs')

// --- one-click launch ------------------------------------------------------

const fakeChild = () => {
  const child = new EventEmitter()
  child.pid = 4242
  child.unref = () => {}
  return child
}

{
  const spawnCalls = []
  const result = await launchChrome({
    port: 9222,
    probe: async () => ({ reachable: true, browser: 'Chrome/155.0.8059.84' }),
    spawnImpl: (...call) => {
      spawnCalls.push(call)
      return fakeChild()
    },
    exists: () => true,
  })
  assert.equal(result.launched, false)
  assert.equal(result.alreadyRunning, true, 'an open debug port is reused instead of starting a second browser')
  assert.equal(result.browser, 'Chrome/155.0.8059.84')
  assert.equal(spawnCalls.length, 0, 'nothing is spawned when the port already answers')
}

{
  let probes = 0
  const spawnCalls = []
  const result = await launchChrome({
    port: 9333,
    profileDir: '/tmp/dsh-chrome',
    configuredExecutable: '/opt/google/chrome',
    platform: 'linux',
    exists: () => true,
    sleepImpl: async () => {},
    probe: async () => {
      probes += 1
      return probes === 1 ? { reachable: false } : { reachable: true, browser: 'Chromium/155' }
    },
    spawnImpl: (...call) => {
      spawnCalls.push(call)
      return fakeChild()
    },
    waitMs: 500,
    pollMs: 1,
  })
  assert.equal(result.launched, true)
  assert.equal(result.alreadyRunning, false)
  assert.equal(result.executable, '/opt/google/chrome')
  assert.equal(result.profileDir, '/tmp/dsh-chrome')
  assert.equal(result.pid, 4242)
  assert.equal(result.browser, 'Chromium/155')
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0][0], '/opt/google/chrome')
  assert.ok(spawnCalls[0][1].includes('--remote-debugging-port=9333'))
  assert.deepEqual(spawnCalls[0][2], { detached: true, stdio: 'ignore' }, 'the browser must outlive the Harness')
}

{
  let error
  try {
    await launchChrome({
      port: 9222,
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\tester',
      exists: () => false,
      probe: async () => ({ reachable: false }),
      spawnImpl: () => fakeChild(),
    })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'CHROME_NOT_FOUND')
  assert.match(error.message, /chromePath/, 'the failure tells the user which config key fixes it')
}

{
  // Chrome hands a second launch for a locked profile to the running instance
  // and exits: the port never opens, and the error must name the profile.
  let error
  try {
    await launchChrome({
      port: 9222,
      profileDir: 'C:\\Users\\tester\\AppData\\Local\\dsh-chrome',
      platform: 'win32',
      configuredExecutable: 'C:\\Chrome\\chrome.exe',
      env: {},
      home: 'C:\\Users\\tester',
      exists: () => true,
      sleepImpl: () => new Promise((resolve) => setTimeout(resolve, 5)),
      probe: async () => ({ reachable: false }),
      spawnImpl: () => {
        const child = fakeChild()
        // Chrome exits asynchronously after handing off to the running instance.
        setImmediate(() => child.emit('exit', 0, null))
        return child
      },
      waitMs: 500,
      pollMs: 1,
    })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'CHROME_EXITED')
  assert.match(error.message, /already using the profile/)
  assert.match(error.message, /chromeUserDataDir/)
}

{
  let error
  try {
    await launchChrome({
      port: 9222,
      platform: 'win32',
      configuredExecutable: 'C:\\Chrome\\chrome.exe',
      env: {},
      home: 'C:\\Users\\tester',
      exists: () => true,
      sleepImpl: async () => {},
      probe: async () => ({ reachable: false }),
      spawnImpl: () => fakeChild(),
      waitMs: 40,
      pollMs: 1,
    })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'CDP_TIMEOUT')
}

{
  let error
  try {
    await launchChrome({
      port: 70000,
      probe: async () => ({ reachable: false }),
      spawnImpl: () => fakeChild(),
    })
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'BAD_PORT')
}

console.log('chrome-launch: ok')
