/**
 * One-click local Chrome for the ChatGPT web transport.
 *
 * The `cdp` transport needs a Chromium window that is (a) started with
 * `--remote-debugging-port`, and (b) signed in to chatgpt.com. Doing that by
 * hand is the step users get wrong — Chrome 136+ refuses remote debugging on the
 * default profile, so a mismatched `--user-data-dir` silently starts a second
 * window that the plugin can never attach to. This module owns the whole
 * operation: find the browser, start it on a dedicated profile, wait until the
 * DevTools endpoint actually answers, and report what happened.
 *
 * Scope is deliberately small: loopback endpoint only, a fixed argument list,
 * no shell. The executable comes from plugin config (`chromePath`) or from the
 * well-known install locations, never from an HTTP request body.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix as posixPath, win32 as win32Path } from 'node:path'
import { probeCdp } from './chrome-cdp.js'

export const LAUNCH_URL = 'https://chatgpt.com/'
export const PROFILE_DIR_NAME = 'dsh-chrome'

export class LaunchError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'LaunchError'
    this.code = code
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) this[key] = value
    }
  }
}

// Paths are built for the target platform rather than the host, so the module
// stays correct (and testable) when it runs somewhere else.
const pathFor = (platform) => (platform === 'win32' ? win32Path : posixPath)

/** Where the dedicated profile lives, per platform. */
export function defaultUserDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = pathFor(platform)
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || p.join(home, 'AppData', 'Local')
    return p.join(base, PROFILE_DIR_NAME)
  }
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', PROFILE_DIR_NAME)
  return p.join(env.XDG_CONFIG_HOME?.trim() || p.join(home, '.config'), PROFILE_DIR_NAME)
}

/** Install locations, in the order they are worth trying. */
export function chromeCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = pathFor(platform)
  if (platform === 'win32') {
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
      (entry) => typeof entry === 'string' && entry.trim(),
    )
    const windows = []
    for (const base of programFiles) {
      windows.push(p.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      windows.push(p.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      windows.push(p.join(base, 'Chromium', 'Application', 'chrome.exe'))
    }
    return windows
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  // Linux (and anything else POSIX-like): names are resolved against PATH, then
  // the usual absolute locations.
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
  const fromPath = []
  for (const dir of String(env.PATH ?? '').split(p.delimiter)) {
    if (!dir.trim()) continue
    for (const name of names) fromPath.push(p.join(dir.trim(), name))
  }
  return [
    ...fromPath,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]
}

/**
 * The first candidate that exists. A configured path wins even when the
 * well-known list has an entry: the user pointed at it for a reason.
 */
export function findChrome({ configured, platform = process.platform, env = process.env, home = homedir(), exists = existsSync } = {}) {
  if (typeof configured === 'string' && configured.trim()) {
    const path = configured.trim()
    return exists(path) ? path : undefined
  }
  for (const candidate of chromeCandidates({ platform, env, home })) {
    try {
      if (exists(candidate)) return candidate
    } catch {
      // An unreadable candidate is simply not this browser.
    }
  }
  return undefined
}

export function chromeLaunchArgs({ port, profileDir, url = LAUNCH_URL }) {
  return [
    `--remote-debugging-port=${Number(port)}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function probeQuietly(probe, { host, port }) {
  try {
    const result = await probe({ host, port, timeoutMs: 700 })
    return result && typeof result === 'object' ? result : { reachable: false }
  } catch {
    return { reachable: false }
  }
}

/**
 * Start (or detect) the local debug browser.
 *
 * @returns {Promise<{
 *   launched: boolean, alreadyRunning: boolean, executable?: string,
 *   profileDir: string, args: string[], host: string, port: number,
 *   browser?: string, pid?: number, message: string,
 * }>}
 */
export async function launchChrome(options = {}) {
  const {
    port = 9222,
    host = '127.0.0.1',
    configuredExecutable,
    profileDir,
    url = LAUNCH_URL,
    probe = probeCdp,
    spawnImpl = spawn,
    exists = existsSync,
    platform = process.platform,
    env = process.env,
    home = homedir(),
    waitMs = 12000,
    pollMs = 400,
    sleepImpl = sleep,
  } = options

  const numericPort = Number(port)
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new LaunchError('BAD_PORT', `The DevTools port must be an integer between 1 and 65535 (got ${port}).`)
  }
  const dir = profileDir || defaultUserDataDir({ platform, env, home })

  // A listening port means a debug browser is already up; starting a second
  // instance would either hand off to it (and never open a port) or open a
  // second window with a locked profile.
  const before = await probeQuietly(probe, { host, port: numericPort })
  if (before.reachable) {
    return {
      launched: false,
      alreadyRunning: true,
      profileDir: dir,
      args: [],
      host,
      port: numericPort,
      browser: before.browser,
      message: `A Chrome DevTools endpoint is already listening on ${host}:${numericPort}${before.browser ? ` (${before.browser})` : ''}.`,
    }
  }

  const browserPath = findChrome({ configured: configuredExecutable, platform, env, home, exists })
  if (!browserPath) {
    const hint = configuredExecutable
      ? `The configured chromePath does not exist: ${configuredExecutable}.`
      : 'No Chrome, Edge or Chromium installation was found in the usual locations.'
    throw new LaunchError(
      'CHROME_NOT_FOUND',
      `${hint} Set chromePath in the My Model plugin config to the browser executable and retry.`,
      { profileDir: dir },
    )
  }

  const args = chromeLaunchArgs({ port: numericPort, profileDir: dir, url })
  let child
  try {
    child = spawnImpl(browserPath, args, { detached: true, stdio: 'ignore' })
  } catch (error) {
    throw new LaunchError('LAUNCH_FAILED', `Could not start ${browserPath}: ${error?.message ?? String(error)}`, {
      executable: browserPath,
      profileDir: dir,
      args,
    })
  }

  let exit = null
  let spawnError = null
  try {
    child.once?.('exit', (code, signal) => {
      exit = { code, signal }
    })
    child.once?.('error', (error) => {
      spawnError = error
    })
    child.unref?.()
  } catch {
    // A stub without EventEmitter methods is fine (tests).
  }

  const deadline = Date.now() + Math.max(1000, Number(waitMs) || 12000)
  while (Date.now() < deadline) {
    await sleepImpl(Math.max(50, Number(pollMs) || 400))
    if (spawnError) {
      throw new LaunchError('LAUNCH_FAILED', `Could not start ${browserPath}: ${spawnError.message ?? String(spawnError)}`, {
        executable: browserPath,
        profileDir: dir,
        args,
      })
    }
    const after = await probeQuietly(probe, { host, port: numericPort })
    if (after.reachable) {
      return {
        launched: true,
        alreadyRunning: false,
        executable: browserPath,
        profileDir: dir,
        args,
        host,
        port: numericPort,
        browser: after.browser,
        pid: child?.pid,
        message: `Started ${browserPath} on ${host}:${numericPort} with the dedicated profile ${dir}.`,
      }
    }
    // Chrome hands a second launch for the same profile off to the running
    // instance and exits; that instance has no debug port, so this is terminal.
    if (exit) break
  }

  if (exit) {
    throw new LaunchError(
      'CHROME_EXITED',
      `${browserPath} exited (code ${exit.code ?? '?'}) before its DevTools port opened. Another Chrome instance is ` +
        `probably already using the profile ${dir}. Close that window and retry, or set chromeUserDataDir to a ` +
        'different directory.',
      { executable: browserPath, profileDir: dir, args, exitCode: exit.code ?? null },
    )
  }
  throw new LaunchError(
    'CDP_TIMEOUT',
    `${browserPath} was started (pid ${child?.pid ?? '?'}) but ${host}:${numericPort} did not answer within ` +
      `${Math.round((Number(waitMs) || 12000) / 1000)}s. Check the new window: if it is the everyday profile, ` +
      'quit it and retry; the debug port only exists on the dedicated profile.',
    { executable: browserPath, profileDir: dir, args, pid: child?.pid },
  )
}
