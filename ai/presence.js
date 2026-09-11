'use strict'

/*
 * DARKNOTE AI — advanced online presence.
 *
 * `online`             -> appear online immediately
 * `online 70sec`       -> ONLINE 70s, OFFLINE 70s, ONLINE 70s, ... until stopped
 * `online 5min` / `2hrs`
 * `online off`         -> stop the cycle
 *
 * SAFETY: the whole cycle runs on ONE scheduler id, so issuing the command again
 * REPLACES the running cycle instead of starting a second one. There is no way
 * to accumulate duplicate loops. The setting is written to config.json, so after
 * a restart the cycle is restored from configuration rather than from a stale
 * timer snapshot - and only if it was actually on.
 */

const scheduler = require('./scheduler')
const config = require('./config')

const TASK_ID = 'presence:online-cycle'

const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 }

/**
 * Parse a duration such as 70sec, 30s, 5min, 2hrs.
 * Returns milliseconds, or null when the text is not a valid duration.
 */
function parseDuration(text) {
    const value = String(text || '').trim().toLowerCase().replace(/\s+/g, '')
    if (!value) return null
    const match = value.match(/^(\d+(?:\.\d+)?)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/)
    if (!match) return null
    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount <= 0) return null
    const unit = match[2][0]
    const ms = Math.round(amount * UNIT_MS[unit])
    // Guard rails: below 5s it is a presence flood, above 24h it is pointless.
    if (ms < 5000) return { error: 'the shortest cycle is 5 seconds' }
    if (ms > 24 * 60 * 60 * 1000) return { error: 'the longest cycle is 24 hours' }
    return { ms }
}

function formatDuration(ms) {
    if (!ms) return '0s'
    if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}hrs`
    if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}min`
    return `${Math.round(ms / 1000)}sec`
}

function setPresence(conn, state) {
    try {
        if (typeof conn?.sendPresenceUpdate !== 'function') return false
        Promise.resolve(conn.sendPresenceUpdate(state)).catch(() => { })
        return true
    } catch {
        return false
    }
}

/** One step of the alternation, rescheduling itself. One timer id, always. */
function step(conn, ms, nextState) {
    setPresence(conn, nextState)
    scheduler.schedule(TASK_ID, ms, () => {
        step(conn, ms, nextState === 'available' ? 'unavailable' : 'available')
    }, { meta: { ms, state: nextState }, persistent: false, kind: 'presence' })
}

/** Start (or restart) the cycle. First action is immediate, as specified. */
function start(conn, ms) {
    scheduler.cancel(TASK_ID)
    setPresence(conn, 'available')
    scheduler.schedule(TASK_ID, ms, () => {
        step(conn, ms, 'unavailable')
    }, { meta: { ms, state: 'available' }, persistent: false, kind: 'presence' })
    config.writeAiSetting('onlineCycleMs', ms)
    config.writeAiSetting('onlineCycleEnabled', true)
    return { ms }
}

/** Show online once, with no cycle. */
function once(conn) {
    scheduler.cancel(TASK_ID)
    setPresence(conn, 'available')
    config.writeAiSetting('onlineCycleEnabled', false)
    config.writeAiSetting('onlineCycleMs', 0)
    return true
}

function stop(conn) {
    const existed = scheduler.cancel(TASK_ID)
    setPresence(conn, 'unavailable')
    config.writeAiSetting('onlineCycleEnabled', false)
    config.writeAiSetting('onlineCycleMs', 0)
    return existed
}

function status() {
    const settings = config.getAiSettings()
    const running = scheduler.has(TASK_ID)
    return {
        running,
        enabled: settings.onlineCycleEnabled === true,
        ms: Number(settings.onlineCycleMs) || 0,
        label: settings.onlineCycleMs ? formatDuration(Number(settings.onlineCycleMs)) : ''
    }
}

/**
 * Restore after a restart. Called once the connection is open.
 * Only restarts when the cycle was genuinely left on.
 */
function resume(conn) {
    const settings = config.getAiSettings()
    if (settings.onlineCycleEnabled !== true) return false
    const ms = Number(settings.onlineCycleMs) || 0
    if (ms < 5000) return false
    scheduler.cancel(TASK_ID)
    step(conn, ms, 'available')
    console.log(`[PRESENCE] online cycle restored (${formatDuration(ms)})`)
    return true
}

module.exports = { parseDuration, formatDuration, start, once, stop, status, resume, TASK_ID }
