/**
 * dsh-keep-awake — host half.
 *
 * Keeps the OS awake while any DSH agent, subagent, or background job runs,
 * then releases the hold after a configurable grace period.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_CONFIG,
  WINDOWS_READY_MARKER,
  mergeConfig,
  normalizeConfig,
  probeActivity,
  retryDelayMs,
  windowsHoldScript,
} from './core.js'

export const name = 'dsh-keep-awake'
// These are the services required for the actual power policy. Web API
// exposure is optional and is installed later through ctx.inject(['connection']).
export const inject = ['settings', 'timer', 'agents', 'jobs']

const SETTINGS_NAMESPACE = 'keep-awake'
const STATE_ROUTE = '/api/dsh-keep-awake/state'
const CONFIG_ROUTE = '/api/dsh-keep-awake/config'
const POLL_MS = 5000
const HELPER_START_TIMEOUT_MS = 15000
const MAX_BODY_BYTES = 64 * 1024
const POWERSHELL_FALLBACK = (process.env.WINDIR
  ? path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

const KeepAwakeSchema = z.object({
  enabled: z.boolean().default(true),
  graceMs: z.number().step(1).min(1000).max(3600000).default(60000),
  preventDisplaySleep: z.boolean().default(false),
  manualHold: z.boolean().default(false),
})

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function dirOf(value) {
  const i = value.lastIndexOf('\\')
  const j = value.lastIndexOf('/')
  const k = Math.max(i, j)
  return k >= 0 ? value.slice(0, k) : '.'
}

/** Synchronous PATH scan. Skips UNC roots so a dead share cannot hang boot. */
function whichSync(name) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    if (dir.startsWith('\\\\') || dir.startsWith('//')) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase())
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* unreadable entry */
      }
    }
  }
  return null
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

async function readJsonRequest(request) {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    const error = new Error('Config updates require application/json.')
    error.status = 415
    throw error
  }
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    const error = new Error('request body exceeds 64 KiB')
    error.status = 413
    throw error
  }
  if (text.length === 0) {
    const error = new Error('request body is required')
    error.status = 400
    throw error
  }
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const error = new Error('request body must be an object')
    error.status = 400
    throw error
  }
  return value
}

export async function apply(ctx) {
  const jobs = ctx.get('jobs')
  const agents = ctx.get('agents')
  const settings = ctx.get('settings')

  const lerr = (msg) => {
    try {
      ctx.logger?.warn?.(msg)
    } catch {
      /* logger optional */
    }
  }

  const platform = process.platform
  const config = { ...DEFAULT_CONFIG }
  const activity = {
    runningAgents: 0,
    liveJobs: 0,
    probeHealthy: false,
    probeError: 'activity has not been probed yet',
    lastSuccessfulProbeAt: null,
  }
  const helper = {
    state: 'off',
    proc: null,
    pid: null,
    error: null,
    powershell: undefined,
    startingSince: 0,
    stopRequested: false,
    startTimeout: null,
    retryTimer: null,
    retryAttempt: 0,
  }
  let graceTimer = null
  let graceUntil = 0
  let stopped = false

  function resolvePowershell() {
    if (helper.powershell !== undefined) return helper.powershell
    const found = existsSync(POWERSHELL_FALLBACK) ? POWERSHELL_FALLBACK : whichSync('powershell')
    helper.powershell = found
    if (found === null) lerr('powershell not found (known path + PATH scan)')
    return found
  }

  function buildArgv() {
    if (platform === 'win32') {
      const exe = resolvePowershell()
      if (exe === null) throw new Error('powershell not found')
      const flags = config.preventDisplaySleep ? 3 : 1
      return [exe, '-NoProfile', '-NonInteractive', '-Command', windowsHoldScript(flags)]
    }
    if (platform === 'darwin') {
      return config.preventDisplaySleep
        ? ['/usr/bin/env', 'caffeinate', '-d', '-i', '-s']
        : ['/usr/bin/env', 'caffeinate', '-i', '-s']
    }
    if (platform === 'linux') {
      return [
        '/usr/bin/env', 'systemd-inhibit', '--what=idle', '--who=dsh-keep-awake',
        '--why=DSH agents running', '--mode=block', 'sleep', '100000000',
      ]
    }
    return null
  }

  // Unknown activity is treated as busy. A transient registry failure should
  // never turn into a false "idle" and put an active coding task to sleep.
  const shouldHold = () => config.enabled && (
    config.manualHold ||
    !activity.probeHealthy ||
    activity.runningAgents > 0 ||
    activity.liveJobs > 0
  )
  const helperNeeded = () => shouldHold() || graceTimer !== null

  function snapshot() {
    return {
      platform,
      enabled: config.enabled,
      graceMs: config.graceMs,
      preventDisplaySleep: config.preventDisplaySleep,
      manualHold: config.manualHold,
      runningAgents: activity.runningAgents,
      liveJobs: activity.liveJobs,
      probeHealthy: activity.probeHealthy,
      probeError: activity.probeError,
      lastSuccessfulProbeAt: activity.lastSuccessfulProbeAt,
      active: shouldHold(),
      graceRemainingMs: graceTimer !== null ? Math.max(0, graceUntil - Date.now()) : 0,
      helperState: helper.state,
      helperPid: helper.pid,
      helperError: helper.error,
      helperRetryAttempt: helper.retryAttempt,
      holdingWakeLock: helper.state === 'on',
    }
  }

  function cancelGrace() {
    if (graceTimer !== null) {
      graceTimer()
      graceTimer = null
    }
    graceUntil = 0
  }

  function cancelRetry() {
    if (helper.retryTimer !== null) {
      helper.retryTimer()
      helper.retryTimer = null
    }
  }

  function cancelStartTimeout() {
    if (helper.startTimeout !== null) {
      helper.startTimeout()
      helper.startTimeout = null
    }
  }

  function terminateProcess(proc) {
    if (proc === null) return
    try {
      if (platform !== 'win32' && typeof proc.pid === 'number') {
        try {
          process.kill(-proc.pid, 'SIGTERM')
        } catch {
          proc.kill('SIGTERM')
        }
      } else {
        proc.kill()
      }
    } catch {
      /* already gone */
    }
  }

  function stopHelper() {
    cancelRetry()
    cancelStartTimeout()
    helper.stopRequested = true
    const proc = helper.proc
    helper.proc = null
    helper.pid = null
    helper.state = 'off'
    helper.startingSince = 0
    helper.error = null
    terminateProcess(proc)
  }

  function scheduleHelperRetry() {
    if (stopped || !helperNeeded() || helper.retryTimer !== null) return
    const delay = retryDelayMs(helper.retryAttempt)
    helper.retryAttempt += 1
    helper.retryTimer = ctx.timeout(() => {
      helper.retryTimer = null
      if (stopped || !helperNeeded()) return
      startHelper()
    }, delay)
  }

  function markHelperFailure(proc, message) {
    if (stopped || (proc !== null && helper.proc !== proc)) return
    cancelStartTimeout()
    if (proc !== null && helper.proc === proc) helper.proc = null
    helper.pid = null
    helper.state = 'error'
    helper.startingSince = 0
    helper.error = message
    lerr('helper failed: ' + message)
    if (proc !== null) terminateProcess(proc)
    scheduleHelperRetry()
  }

  function markHelperReady(proc) {
    if (stopped || helper.proc !== proc) return
    cancelStartTimeout()
    helper.state = 'on'
    helper.startingSince = 0
    helper.error = null
    helper.retryAttempt = 0
  }

  function startHelper() {
    if (stopped || helper.state === 'starting' || helper.state === 'on') return
    cancelRetry()
    helper.stopRequested = false
    helper.state = 'starting'
    helper.startingSince = Date.now()
    helper.error = null

    let argv
    try {
      argv = buildArgv()
      if (argv === null) throw new Error('no helper for platform ' + platform)
    } catch (error) {
      helper.state = 'error'
      helper.startingSince = 0
      helper.error = errorMessage(error)
      lerr('helper argv failed: ' + helper.error)
      scheduleHelperRetry()
      return
    }

    let proc
    try {
      proc = spawn(argv[0], argv.slice(1), {
        cwd: platform === 'win32' ? dirOf(argv[0]) : '/',
        stdio: ['ignore', platform === 'win32' ? 'pipe' : 'ignore', 'pipe'],
        env: process.env,
        detached: platform !== 'win32',
      })
    } catch (error) {
      helper.state = 'error'
      helper.startingSince = 0
      helper.error = errorMessage(error)
      lerr('helper spawn failed: ' + helper.error)
      scheduleHelperRetry()
      return
    }

    helper.proc = proc
    helper.pid = proc.pid ?? null
    let errTail = ''
    proc.stderr?.on('data', (chunk) => {
      errTail = (errTail + chunk.toString()).slice(-2048)
    })

    if (platform === 'win32') {
      let outTail = ''
      proc.stdout?.on('data', (chunk) => {
        if (helper.proc !== proc) return
        outTail = (outTail + chunk.toString()).slice(-512)
        if (outTail.includes(WINDOWS_READY_MARKER)) markHelperReady(proc)
      })
      helper.startTimeout = ctx.timeout(() => {
        helper.startTimeout = null
        if (helper.proc === proc && helper.state === 'starting') {
          markHelperFailure(proc, 'helper did not confirm wake lock within ' + HELPER_START_TIMEOUT_MS + 'ms')
        }
      }, HELPER_START_TIMEOUT_MS)
    } else {
      markHelperReady(proc)
    }

    proc.on('error', (error) => {
      if (stopped || helper.proc !== proc) return
      markHelperFailure(proc, errorMessage(error))
    })
    proc.on('exit', (code, signal) => {
      if (stopped || helper.proc !== proc) return
      const tail = errTail.trim()
      const reason = tail !== '' ? tail.slice(-500) : 'exit ' + (signal ?? String(code))
      markHelperFailure(proc, reason)
    })

    if (helper.stopRequested) {
      helper.proc = null
      helper.pid = null
      helper.state = 'off'
      cancelStartTimeout()
      terminateProcess(proc)
    }
  }

  function evaluate() {
    if (shouldHold()) {
      cancelGrace()
      if (helper.state === 'off' || helper.state === 'error') startHelper()
      return
    }

    if (helper.state !== 'on' && helper.state !== 'starting' && helper.state !== 'error') {
      cancelRetry()
      return
    }

    if (graceTimer !== null) return
    const wait = config.enabled ? config.graceMs : 0
    if (wait <= 0) {
      cancelGrace()
      stopHelper()
      return
    }

    graceUntil = Date.now() + wait
    graceTimer = ctx.timeout(() => {
      graceTimer = null
      graceUntil = 0
      if (!shouldHold()) stopHelper()
      else evaluate()
    }, wait)
  }

  function resync() {
    try {
      const next = probeActivity(agents, jobs)
      activity.runningAgents = next.runningAgents
      activity.liveJobs = next.liveJobs
      activity.probeHealthy = true
      activity.probeError = null
      activity.lastSuccessfulProbeAt = Date.now()
    } catch (error) {
      // Preserve the last successful counters and make uncertainty itself a
      // wake condition. That is the safe failure mode for a sleep inhibitor.
      activity.probeHealthy = false
      activity.probeError = errorMessage(error)
      lerr('activity probe failed; keeping system awake: ' + activity.probeError)
    }
    evaluate()
  }

  function applyConfig(next) {
    const beforeDisplay = config.preventDisplaySleep
    Object.assign(config, normalizeConfig(next))
    const displayModeChanged = beforeDisplay !== config.preventDisplaySleep

    // SetThreadExecutionState flags are fixed for the lifetime of the helper.
    // Restart immediately while active so changing "keep display on" is not a
    // UI-only change that waits for the next task.
    if (displayModeChanged && shouldHold() && (helper.state === 'on' || helper.state === 'starting')) {
      stopHelper()
      startHelper()
    }
    resync()
  }

  let settingsScope = null
  try {
    settingsScope = settings.register(SETTINGS_NAMESPACE, KeepAwakeSchema, { applies: 'live' })
    Object.assign(config, normalizeConfig(settingsScope.get()))
    ctx.on('settings/updated', (ns, next) => {
      if (ns !== SETTINGS_NAMESPACE) return
      applyConfig(next)
    })
  } catch (error) {
    lerr('settings registration failed: ' + errorMessage(error))
  }

  // Route through Connection, not raw webServer. Connection owns the browser
  // launch-token/cookie authentication and trusted-host fence, so this works
  // correctly behind Tailscale Serve and other trusted reverse proxies.
  ctx.inject(['connection'], (apiCtx) => {
    apiCtx.effect(() => apiCtx.connection.fetch.register({
      path: STATE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => {
        resync()
        return Promise.resolve(jsonResponse(snapshot()))
      },
    }), 'dsh-keep-awake: authenticated state route')

    apiCtx.effect(() => apiCtx.connection.fetch.register({
      path: CONFIG_ROUTE,
      methods: ['PUT'],
      requestBody: 'buffered',
      async fetch(request) {
        try {
          const body = await readJsonRequest(request)
          if (typeof body.section !== 'object' || body.section === null || Array.isArray(body.section)) {
            const error = new Error('config update requires a section object')
            error.status = 400
            throw error
          }
          const section = mergeConfig(config, body.section)
          if (settingsScope !== null) await settingsScope.replace(section)
          applyConfig(section)
          return jsonResponse(snapshot())
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 400
          return jsonResponse({ error: errorMessage(error) }, status)
        }
      },
    }), 'dsh-keep-awake: authenticated config route')
  })

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.interval(resync, POLL_MS))
    disposers.push(ctx.on('agent/status', resync))
    disposers.push(ctx.on('agent/created', resync))
    disposers.push(ctx.on('agent/disposed', resync))
    disposers.push(ctx.on('subagent/start', resync))
    disposers.push(ctx.on('subagent/end', resync))

    // Harness >= 0.1.7 exposes the unified JobEvents stream. Keep a fallback
    // for earlier registry implementations so the plugin degrades gracefully.
    if (jobs?.events !== undefined && typeof jobs.events.subscribe === 'function') {
      disposers.push(jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (event.type !== 'output' && event.type !== 'progress') resync()
      }))
    } else if (typeof jobs?.onJobsChanged === 'function') {
      disposers.push(jobs.onJobsChanged(resync))
    }

    if (platform === 'win32') resolvePowershell()
    resync()

    return () => {
      stopped = true
      for (const dispose of disposers) dispose()
      cancelGrace()
      cancelRetry()
      stopHelper()
    }
  })
}
