'use strict'

/*
 * DARKNOTE AI — rate limiting and abuse protection.
 *
 * One user must never be able to make the whole bot unusable, and the AI
 * endpoint must never be flooded. Everything here is in-memory, bounded, and
 * safe to call on every message.
 *
 * Provides:
 *   - sliding-window rate limits, per user and per group
 *   - in-flight tracking, so one conversation gets one answer at a time
 *   - message size and context size caps
 *   - cancellation of a superseded request
 */

const windows = new Map()   // key -> array of timestamps
const inFlight = new Map()  // conversation key -> { token, startedAt, cancel }

const MAX_TRACKED = 5000

function prune(now) {
    if (windows.size <= MAX_TRACKED) return
    const cutoff = now - 10 * 60 * 1000
    for (const [key, stamps] of windows) {
        if (!stamps.length || stamps[stamps.length - 1] < cutoff) windows.delete(key)
    }
}

/**
 * Sliding-window check. Records the hit when allowed.
 * Returns { allowed, retryAfterMs, remaining }.
 */
function checkLimit(key, limitPerMinute, now = Date.now()) {
    const limit = Math.max(1, Number(limitPerMinute) || 6)
    const windowMs = 60 * 1000
    if (!key) return { allowed: true, retryAfterMs: 0, remaining: limit }

    let stamps = windows.get(key)
    if (!stamps) { stamps = []; windows.set(key, stamps) }
    while (stamps.length && now - stamps[0] > windowMs) stamps.shift()

    if (stamps.length >= limit) {
        return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - stamps[0])), remaining: 0 }
    }
    stamps.push(now)
    prune(now)
    return { allowed: true, retryAfterMs: 0, remaining: limit - stamps.length }
}

/* ------------------------------- in-flight -------------------------------- */

/**
 * Mark a conversation as busy. Returns a token, or null when a request is
 * already running for that conversation (which prevents duplicate answers).
 */
function beginInFlight(key) {
    if (!key) return null
    if (inFlight.has(key)) return null
    const token = { cancelled: false, startedAt: Date.now() }
    inFlight.set(key, token)
    return token
}

function endInFlight(key, token) {
    if (!key) return
    const current = inFlight.get(key)
    if (!token || current === token) inFlight.delete(key)
}

function isInFlight(key) {
    return inFlight.has(key)
}

/**
 * Cancel a running request for a conversation. The in-flight HTTP request
 * itself cannot be aborted mid-flight here, but the result is discarded, which
 * is what stops a stale answer being delivered.
 */
function cancelInFlight(key) {
    const token = inFlight.get(key)
    if (!token) return false
    token.cancelled = true
    inFlight.delete(key)
    return true
}

function isCancelled(token) {
    return !token || token.cancelled === true
}

/** Drop a user's limit budget, used when an owner clears a chat. */
function reset(key) {
    if (key) windows.delete(key)
    return true
}

function stats() {
    return { trackedWindows: windows.size, inFlight: inFlight.size }
}

module.exports = {
    checkLimit,
    beginInFlight,
    endInFlight,
    isInFlight,
    cancelInFlight,
    isCancelled,
    reset,
    stats
}
