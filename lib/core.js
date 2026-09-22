export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  graceMs: 60000,
  preventDisplaySleep: false,
  manualHold: false,
})

export const WINDOWS_READY_MARKER = 'DSH_KEEP_AWAKE_READY'

export function normalizeConfig(value) {
  const v = typeof value === 'object' && value !== null ? value : {}
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_CONFIG.enabled,
    graceMs: Number.isFinite(v.graceMs)
      ? Math.min(3600000, Math.max(1000, Math.round(v.graceMs)))
      : DEFAULT_CONFIG.graceMs,
    preventDisplaySleep: typeof v.preventDisplaySleep === 'boolean'
      ? v.preventDisplaySleep
      : DEFAULT_CONFIG.preventDisplaySleep,
    manualHold: typeof v.manualHold === 'boolean' ? v.manualHold : DEFAULT_CONFIG.manualHold,
  }
}

export function mergeConfig(current, patch) {
  const safePatch = typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? patch : {}
  return normalizeConfig({ ...normalizeConfig(current), ...safePatch })
}

export function isLiveJobStatus(status) {
  return status === 'running' || status === 'stopping'
}

/**
 * Probe the current DSH activity using the current jobs API. A thrown probe is
 * intentionally propagated so the host can fail closed instead of treating an
 * unknown state as idle.
 */
export function probeActivity(agents, jobs) {
  const liveAgents = agents.list()
  let runningAgents = 0
  for (const agent of liveAgents) {
    if (agent?.status === 'running') runningAgents++
  }

  const seen = new Map()
  const addJobs = (list) => {
    for (const job of list) seen.set(String(job.id), job)
  }

  // Current JobRegistry.list(caller?) returns unowned jobs when caller is
  // omitted and caller-owned + unowned jobs for a session id. Enumerating all
  // live agents therefore produces a process-wide snapshot.
  addJobs(jobs.list())
  const modernJobsApi = jobs?.events !== undefined && typeof jobs.events?.subscribe === 'function'
  for (const agent of liveAgents) addJobs(jobs.list(modernJobsApi ? agent.id : agent))

  let liveJobs = 0
  for (const job of seen.values()) {
    if (isLiveJobStatus(job?.status)) liveJobs++
  }
  return { runningAgents, liveJobs }
}

export function retryDelayMs(attempt) {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  return Math.min(5000, 500 * (2 ** Math.min(n, 4)))
}

/** Build the long-lived Windows helper script. */
export function windowsHoldScript(flags) {
  const requested = flags === 3 ? 3 : 1
  return (
    "$src = @'\n" +
    'using System;\n' +
    'using System.Runtime.InteropServices;\n' +
    'using System.Threading;\n' +
    'public class DshKa {\n' +
    '  [DllImport("kernel32.dll", SetLastError = true)]\n' +
    '  public static extern uint SetThreadExecutionState(uint flags);\n' +
    '  public static void Hold(uint flags) {\n' +
    '    uint previous = SetThreadExecutionState(0x80000000u | flags);\n' +
    '    if (previous == 0) throw new InvalidOperationException("SetThreadExecutionState failed");\n' +
    `    Console.Out.WriteLine("${WINDOWS_READY_MARKER}");\n` +
    '    Console.Out.Flush();\n' +
    '    Thread.Sleep(Timeout.Infinite);\n' +
    '  }\n' +
    '}\n' +
    "'@\n" +
    'Add-Type -TypeDefinition $src\n' +
    `[void][DshKa]::Hold(${requested})`
  )
}
