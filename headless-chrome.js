/**
 * Managed headless Chromium for the DeepSeek web transport.
 *
 * The visible local-Chrome transport depends on a window the user can close.
 * This manager keeps a dedicated, headless Chromium process alive on its own
 * profile and debug port, so the DeepSeek adapter can keep making genuinely
 * browser-shaped requests after every visible Chrome window is gone.
 *
 * The process is detached from Harness: it survives a Harness restart, and a
 * later `ensure()` adopts the already-listening debug port instead of starting
 * a duplicate. It is deliberately separate from the visible `dsh-chrome`
 * profile so the two can never fight over Chrome's profile lock.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { probeCdp } from './chrome-cdp.js'
import { defaultUserDataDir, findChrome } from './chrome-launch.js'

export const DEFAULT_HEADLESS_PORT = 9223
export const HEADLESS_PROFILE_SUFFIX = '-headless'
export const HEADLESS_PID_FILE = 'headless.pid'

export class HeadlessChromeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'HeadlessChromeError'
    this.code = code
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined) this[key] = value
    }
  }
}

/** The dedicated profile next to (but distinct from) the visible debug one. */
export function defaultHeadlessUserDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  return `${defaultUserDataDir({ platform, env, home })}${HEADLESS_PROFILE_SUFFIX}`
}

/** Fixed argument list; the executable/profile/URL come from plugin config. */
export function headlessChromeArgs({ port, profileDir, url = 'about:blank', host = '127.0.0.1', userAgent }) {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${Number(port)}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1280,900',
  ]
  // Cloudflare ties cf_clearance to the exact User-Agent. Sending the normal
  // Chrome UA from the very first request avoids the "HeadlessChrome" challenge
  // that a per-page override can only fix after a reload.
  if (typeof userAgent === 'string' && userAgent.trim()) args.push(`--user-agent=${userAgent.trim()}`)
  if (host && host !== '127.0.0.1') args.push(`--remote-debugging-address=${host}`)
  args.push(url)
  return args
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function probeQuietly(probe, { host, port }) {
  return Promise.resolve()
    .then(() => probe({ host, port, timeoutMs: 700 }))
    .then((result) => (result && typeof result === 'object' ? result : { reachable: false }))
    .catch(() => ({ reachable: false }))
}

export class ManagedChrome {
  constructor({
    host = '127.0.0.1',
    port = DEFAULT_HEADLESS_PORT,
    executable,
    profileDir,
    userAgent,
    url = 'about:blank',
    logger,
    probe = probeCdp,
    spawnImpl = spawn,
    exists = existsSync,
    platform = process.platform,
    env = process.env,
    home = homedir(),
    waitMs = 15000,
    pollMs = 300,
    sleepImpl = sleep,
  } = {}) {
    const numericPort = Number(port)
    if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      throw new HeadlessChromeError(
        'BAD_PORT',
        `The headless DevTools port must be an integer between 1 and 65535 (got ${port}).`,
      )
    }
    this.host = host
    this.port = numericPort
    this.executable = typeof executable === 'string' && executable.trim() ? executable.trim() : undefined
    this.profileDir = profileDir || defaultHeadlessUserDataDir({ platform, env, home })
    this.userAgent = typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : undefined
    this.url = url
    this.logger = logger
    this.probe = probe
    this.spawnImpl = spawnImpl
    this.exists = exists
    this.platform = platform
    this.env = env
    this.home = home
    this.waitMs = Math.max(1000, Number(waitMs) || 15000)
    this.pollMs = Math.max(50, Number(pollMs) || 300)
    this.sleepImpl = sleepImpl
    this.child = null
    this.pid = undefined
    this.starting = null
  }

  get pidFile() {
    return join(this.profileDir, HEADLESS_PID_FILE)
  }

  readPid() {
    try {
      const value = Number(readFileSync(this.pidFile, 'utf8').trim())
      return Number.isInteger(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  writePid(pid) {
    try {
      mkdirSync(this.profileDir, { recursive: true })
      writeFileSync(this.pidFile, `${pid}\n`, 'utf8')
    } catch {
      // A PID file is a convenience for stop(); never fail a launch for it.
    }
  }

  removePid() {
    try {
      rmSync(this.pidFile, { force: true })
    } catch {
      // Ignore.
    }
  }

  killTree(pid) {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return
    const target = Number(pid)
    if (this.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(target), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        // Best effort.
      }
      return
    }
    try {
      process.kill(-target, 'SIGTERM')
    } catch {
      try {
        process.kill(target, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }

  /** Probe without starting anything. */
  async status() {
    const probe = await probeQuietly(this.probe, { host: this.host, port: this.port })
    const pid = this.pid ?? this.readPid()
    return {
      host: this.host,
      port: this.port,
      profileDir: this.profileDir,
      executable: this.executable,
      pid,
      reachable: probe.reachable === true,
      running: probe.reachable === true,
      browser: typeof probe.browser === 'string' ? probe.browser : undefined,
      message: probe.message,
    }
  }

  /** Start if necessary; concurrent callers share one launch. */
  async ensure() {
    const current = await this.status()
    if (current.running) return { ...current, alreadyRunning: true }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  async start() {
    const before = await this.status()
    if (before.running) return { ...before, alreadyRunning: true }

    // A PID from a previous Harness run is not trustworthy enough to kill: the
    // OS may have reused it. Drop the stale marker and let the profile-lock
    // handoff fail loudly if that old process is still alive.
    if (this.readPid()) this.removePid()

    const browserPath = findChrome({
      configured: this.executable,
      platform: this.platform,
      env: this.env,
      home: this.home,
      exists: this.exists,
    })
    if (!browserPath) {
      const hint = this.executable
        ? `The configured chromePath does not exist: ${this.executable}.`
        : 'No Chrome, Edge or Chromium installation was found in the usual locations.'
      throw new HeadlessChromeError(
        'CHROME_NOT_FOUND',
        `${hint} Install a Chromium browser or set chromePath in the My Model plugin config.`,
        { profileDir: this.profileDir },
      )
    }
    this.executable = browserPath
    mkdirSync(this.profileDir, { recursive: true })
    const args = headlessChromeArgs({
      port: this.port,
      profileDir: this.profileDir,
      url: this.url,
      host: this.host,
      userAgent: this.userAgent,
    })

    let child
    try {
      child = this.spawnImpl(browserPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      throw new HeadlessChromeError(
        'LAUNCH_FAILED',
        `Could not start ${browserPath}: ${error?.message ?? String(error)}`,
        { executable: browserPath, profileDir: this.profileDir, args },
      )
    }
    this.child = child
    this.pid = child?.pid
    if (this.pid) this.writePid(this.pid)

    let exit = null
    let spawnError = null
    try {
      child.once?.('exit', (code, signal) => {
        exit = { code, signal }
        if (this.child === child) {
          this.child = null
          this.pid = undefined
          this.removePid()
        }
      })
      child.once?.('error', (error) => {
        spawnError = error
      })
      child.unref?.()
    } catch {
      // A stub without EventEmitter methods is fine (tests).
    }

    const deadline = Date.now() + this.waitMs
    while (Date.now() < deadline) {
      await this.sleepImpl(this.pollMs)
      if (spawnError) {
        this.killTree(this.pid)
        this.removePid()
        throw new HeadlessChromeError(
          'LAUNCH_FAILED',
          `Could not start ${browserPath}: ${spawnError.message ?? String(spawnError)}`,
          { executable: browserPath, profileDir: this.profileDir, args },
        )
      }
      const status = await this.status()
      if (status.running) {
        return {
          ...status,
          launched: true,
          alreadyRunning: false,
          executable: browserPath,
          args,
          message: `Started headless ${browserPath} on ${this.host}:${this.port} with profile ${this.profileDir}.`,
        }
      }
      if (exit) break
    }

    this.killTree(this.pid)
    this.removePid()
    this.child = null
    this.pid = undefined
    if (exit) {
      throw new HeadlessChromeError(
        'CHROME_EXITED',
        `${browserPath} exited (code ${exit.code ?? '?'}) before its headless DevTools port opened. ` +
          `Another Chrome instance may be using the profile ${this.profileDir}; set chromeHeadlessUserDataDir ` +
          'to a different directory.',
        { executable: browserPath, profileDir: this.profileDir, args, exitCode: exit.code ?? null },
      )
    }
    throw new HeadlessChromeError(
      'CDP_TIMEOUT',
      `Headless ${browserPath} was started (pid ${this.pid ?? '?'}) but ${this.host}:${this.port} did not answer ` +
        `within ${Math.round(this.waitMs / 1000)}s.`,
      { executable: browserPath, profileDir: this.profileDir, args, pid: this.pid },
    )
  }

  async stop() {
    const pid = this.pid ?? this.readPid()
    this.killTree(pid)
    if (this.child) {
      try {
        this.child.kill?.()
      } catch {
        // Already gone.
      }
    }
    this.child = null
    this.pid = undefined
    this.removePid()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const status = await this.status()
      if (!status.running) return status
      await this.sleepImpl(this.pollMs)
    }
    return this.status()
  }
}
