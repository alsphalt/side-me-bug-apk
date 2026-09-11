'use strict'

/*
 * DARKNOTE AI — provider health.
 *
 * Tracks how each provider is actually behaving and pushes a misbehaving one
 * into a temporary COOLDOWN instead of deleting it. A provider is never
 * permanently disabled by a transient failure; the cooldown expires and it is
 * tried again, with the wait growing on repeated failure so a dead provider
 * stops costing us requests.
 *
 * States:
 *   READY      last attempt succeeded (or no attempt yet and it is registered)
 *   UNVERIFIED never produced a successful answer since this process started
 *   BUSY       a request is currently in flight
 *   FAILED     the last attempt returned an error
 *   TIMEOUT    the last attempt timed out
 *   COOLDOWN   temporarily benched after repeated failures
 *   DISABLED   switched off in configuration
 */

const crypto = require('crypto')

const STATE = {
    READY: 'READY',
    UNVERIFIED: 'UNVERIFIED',
    BUSY: 'BUSY',
    FAILED: 'FAILED',
    TIMEOUT: 'TIMEOUT',
    COOLDOWN: 'COOLDOWN',
    DISABLED: 'DISABLED'
}

const DEFAULT_POLICY = {
    failureThreshold: 3,      // consecutive failures before a cooldown
    baseCooldownMs: 60 * 1000,
    maxCooldownMs: 15 * 60 * 1000
}

const records = new Map()   // providerId -> record
const inFlightCount = new Map()

function now() { return Date.now() }

function record(id) {
    if (!records.has(id)) {
        records.set(id, {
            id,
            state: STATE.UNVERIFIED,
            verified: false,
            consecutiveFailures: 0,
            totalSuccess: 0,
            totalFailure: 0,
            cooldownUntil: 0,
            cooldownStep: 0,
            lastError: '',
            lastLatencyMs: 0,
            lastSuccessAt: 0,
            lastAttemptAt: 0
        })
    }
    return records.get(id)
}

/** Register providers up front so the status command can show them as UNVERIFIED. */
function register(ids) {
    for (const id of ids) record(id)
}

function policy(settings) {
    return {
        failureThreshold: Math.max(1, Number(settings?.healthFailureThreshold) || DEFAULT_POLICY.failureThreshold),
        baseCooldownMs: Math.max(1000, Number(settings?.healthBaseCooldownMs) || DEFAULT_POLICY.baseCooldownMs),
        maxCooldownMs: Math.max(1000, Number(settings?.healthMaxCooldownMs) || DEFAULT_POLICY.maxCooldownMs)
    }
}

function beginAttempt(id) {
    const r = record(id)
    r.lastAttemptAt = now()
    inFlightCount.set(id, (inFlightCount.get(id) || 0) + 1)
    if (r.state !== STATE.COOLDOWN) r.state = STATE.BUSY
}

function endAttempt(id) {
    const next = Math.max(0, (inFlightCount.get(id) || 1) - 1)
    if (next === 0) inFlightCount.delete(id)
    else inFlightCount.set(id, next)
}

function markSuccess(id, latencyMs = 0) {
    const r = record(id)
    r.state = STATE.READY
    r.verified = true
    r.consecutiveFailures = 0
    r.cooldownStep = 0
    r.cooldownUntil = 0
    r.lastError = ''
    r.lastLatencyMs = latencyMs
    r.lastSuccessAt = now()
    r.totalSuccess += 1
}

/**
 * Record a failure. `kind` is 'timeout' or anything else.
 * Returns the resulting state.
 */
function markFailure(id, kind, reason, settings) {
    const r = record(id)
    r.consecutiveFailures += 1
    r.totalFailure += 1
    r.lastError = String(reason || '').slice(0, 160)
    r.state = kind === 'timeout' ? STATE.TIMEOUT : STATE.FAILED
    r.verified = r.verified === true

    const { failureThreshold, baseCooldownMs, maxCooldownMs } = policy(settings)
    if (r.consecutiveFailures >= failureThreshold) {
        r.cooldownStep += 1
        const wait = Math.min(maxCooldownMs, baseCooldownMs * Math.pow(2, r.cooldownStep - 1))
        r.cooldownUntil = now() + wait
        r.state = STATE.COOLDOWN
    }
    return r.state
}

/** Expire a finished cooldown so the provider becomes eligible again. */
function refresh(id) {
    const r = record(id)
    if (r.state === STATE.COOLDOWN && r.cooldownUntil && now() >= r.cooldownUntil) {
        r.state = r.verified ? STATE.READY : STATE.UNVERIFIED
        r.cooldownUntil = 0
        // Keep the failure count so an immediate relapse escalates faster, but
        // halve it so one lucky success is not required to recover.
        r.consecutiveFailures = Math.floor(r.consecutiveFailures / 2)
    }
    return r
}

/** Can this provider be attempted right now? */
function isAvailable(id, { disabled = false } = {}) {
    if (disabled) return false
    const r = refresh(id)
    if (r.state === STATE.COOLDOWN) return false
    return true
}

function stateOf(id, { disabled = false } = {}) {
    if (disabled) return STATE.DISABLED
    return refresh(id).state
}

function snapshot(ids) {
    return ids.map(id => {
        const r = refresh(id)
        return {
            id: r.id,
            state: r.state,
            verified: r.verified,
            successes: r.totalSuccess,
            failures: r.totalFailure,
            cooldownRemainingMs: r.cooldownUntil ? Math.max(0, r.cooldownUntil - now()) : 0,
            lastError: r.lastError,
            lastLatencyMs: r.lastLatencyMs
        }
    })
}

/** Force a provider back into rotation, e.g. after a config change. */
function reset(id) {
    if (id) records.delete(id)
    else records.clear()
    return true
}

module.exports = {
    STATE,
    register,
    beginAttempt,
    endAttempt,
    markSuccess,
    markFailure,
    isAvailable,
    stateOf,
    snapshot,
    reset,
    refresh
}
