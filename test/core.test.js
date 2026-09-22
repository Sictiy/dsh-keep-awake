import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WINDOWS_READY_MARKER,
  mergeConfig,
  normalizeConfig,
  probeActivity,
  retryDelayMs,
  windowsHoldScript,
} from '../lib/core.js'

test('mergeConfig preserves fields omitted by a patch', () => {
  const current = {
    enabled: false,
    graceMs: 300000,
    preventDisplaySleep: false,
    manualHold: true,
  }
  assert.deepEqual(mergeConfig(current, { preventDisplaySleep: true }), {
    enabled: false,
    graceMs: 300000,
    preventDisplaySleep: true,
    manualHold: true,
  })
})

test('normalizeConfig clamps grace and restores invalid values', () => {
  assert.equal(normalizeConfig({ graceMs: 0 }).graceMs, 1000)
  assert.equal(normalizeConfig({ graceMs: 99999999 }).graceMs, 3600000)
  assert.equal(normalizeConfig({ graceMs: Number.NaN }).graceMs, 60000)
})

test('probeActivity uses session ids with the current JobRegistry API and deduplicates unowned jobs', () => {
  const agents = {
    list: () => [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'idle' },
    ],
  }
  const calls = []
  const unowned = { id: 'u', status: 'running' }
  const jobs = {
    events: { subscribe() {} },
    list(owner) {
      calls.push(owner)
      if (owner === undefined) return [unowned]
      if (owner === 'a') return [unowned, { id: 'a-job', status: 'stopping' }]
      if (owner === 'b') return [unowned, { id: 'b-job', status: 'completed' }]
      throw new Error('expected a session id')
    },
  }
  assert.deepEqual(probeActivity(agents, jobs), { runningAgents: 1, liveJobs: 2 })
  assert.deepEqual(calls, [undefined, 'a', 'b'])
})

test('probeActivity retains the legacy agent-object listing convention when no JobEvents API exists', () => {
  const agent = { id: 'legacy-a', status: 'running' }
  const agents = { list: () => [agent] }
  const calls = []
  const jobs = {
    list(owner) {
      calls.push(owner)
      if (owner === undefined) return []
      assert.equal(owner, agent)
      return [{ id: 'legacy-job', status: 'running' }]
    },
  }
  assert.deepEqual(probeActivity(agents, jobs), { runningAgents: 1, liveJobs: 1 })
  assert.equal(calls[1], agent)
})

test('probeActivity propagates registry failures so the host can fail closed', () => {
  const agents = { list: () => { throw new Error('registry unavailable') } }
  const jobs = { list: () => [] }
  assert.throws(() => probeActivity(agents, jobs), /registry unavailable/)
})

test('retry backoff is bounded', () => {
  assert.equal(retryDelayMs(0), 500)
  assert.equal(retryDelayMs(1), 1000)
  assert.equal(retryDelayMs(4), 5000)
  assert.equal(retryDelayMs(99), 5000)
})

test('Windows helper checks SetThreadExecutionState and confirms readiness', () => {
  const script = windowsHoldScript(3)
  assert.match(script, /previous == 0/)
  assert.match(script, new RegExp(WINDOWS_READY_MARKER))
  assert.match(script, /Hold\(3\)/)
})
