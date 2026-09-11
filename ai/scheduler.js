'use strict'

/*
 * DARKNOTE AI — one safe scheduler for every delayed action.
 *
 * ONE registry, keyed by task id. Scheduling the same id again REPLACES the
 * previous timer instead of adding a second one, so a repeated `online 5min` or
 * `close 10min` can never stack up duplicate loops. That is the single rule that
 * prevents the "thousands of unmanaged timers" failure mode.
 *
 * Used by: the online presence cycle, group close/open schedules, the
 * "user went quiet" follow-up, and long-silence resume.
 *
 * Persistent tasks (online, close, open) are written to disk so they can be
 * restored after a restart; transient ones (a pending reply) are not.
 */

const fs = require('fs')
const path = require('path')

const STORE_PATH = path.join(__dirname, '..', 'database', 'ai-timers.json')

const timers = new Map()   // id -> { id, handle, fireAt, meta, repeatMs, persistent }
const intervals = new Map()

let restoreHandler = null

/* --------------------------------- storage ------------------------------- */

function readStore() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {}
        }
    } catch { }
    return {}
}

function writeStore() {
    try {
        const tasks = {}
        for (const [, entry] of timers) {
            if (!entry.persistent) continue
            tasks[entry.id] = { fireAt: entry.fireAt, meta: entry.meta, kind: entry.kind }
        }
        const dir = path.dirname(STORE_PATH)
        fs.mkdirSync(dir, { recursive: true })
        const tmp = `${STORE_PATH}.tmp`
        fs.writeFileSync(tmp, JSON.stringify({ tasks, savedAt: Date.now() }, null, 2))
        fs.renameSync(tmp, STORE_PATH)
    } catch (error) {
        console.error('[SCHEDULER] could not persist timers:', error?.message || error)
    }
}

/* --------------------------------- core ---------------------------------- */

/**
 * Schedule a one-shot task. Scheduling an id that already exists cancels the
 * previous timer first, so there is never more than one live timer per id.
 */
function schedule(id, delayMs, fn, { meta = {}, persistent = false, kind = 'once' } = {}) {
    cancel(id)
    const wait = Math.max(0, Number(delayMs) || 0)
    const handle = setTimeout(() => {
        timers.delete(id)
        if (persistent) writeStore()
        try {
            fn()
        } catch (error) {
            console.error(`[SCHEDULER] task ${id} threw:`, error?.stack || error)
        }
    }, wait)
    if (typeof handle.unref === 'function') handle.unref()
    timers.set(id, { id, handle, fireAt: Date.now() + wait, meta, persistent, kind })
    if (persistent) writeStore()
    return { id, fireAt: Date.now() + wait }
}

/** Repeating task with a fixed period, still one per id. */
function repeat(id, periodMs, fn, { meta = {}, persistent = false, kind = 'repeat' } = {}) {
    cancel(id)
    const period = Math.max(1000, Number(periodMs) || 1000)
    const handle = setInterval(() => {
        try {
            fn()
        } catch (error) {
            console.error(`[SCHEDULER] repeating task ${id} threw:`, error?.stack || error)
        }
    }, period)
    if (typeof handle.unref === 'function') handle.unref()
    intervals.set(id, { id, handle, period, meta, persistent, kind })
    timers.set(id, { id, handle: null, fireAt: Date.now() + period, meta, persistent, kind })
    if (persistent) writeStore()
    return { id, period }
}

/**
 * Remove a task.
 *
 * A PERSISTENT task must also be rewritten to disk, otherwise the cancelled job
 * stays in ai-timers.json and comes back to life on the next restart. That
 * happened during testing: a cancelled group flip was restored on boot and tried
 * to fire for a group it should have forgotten.
 */
function cancel(id) {
    const existing = timers.get(id)
    const wasPersistent = Boolean(existing?.persistent)
    if (existing?.handle) clearTimeout(existing.handle)
    timers.delete(id)
    const interval = intervals.get(id)
    if (interval?.handle) clearInterval(interval.handle)
    intervals.delete(id)
    if (wasPersistent || interval) writeStore()
    return Boolean(existing || interval)
}

function has(id) {
    return timers.has(id) || intervals.has(id)
}



function list() {
    return [...timers.values()].map(t => ({ id: t.id, fireAt: t.fireAt, inMs: Math.max(0, t.fireAt - Date.now()), kind: t.kind, meta: t.meta }))
}

function cancelByPrefix(prefix) {
    let count = 0
    for (const id of [...timers.keys()]) if (id.startsWith(prefix)) { cancel(id); count++ }
    return count
}

function clearAll() {
    for (const id of [...timers.keys()]) cancel(id)
    return true
}

/**
 * Restore persistent tasks after a restart.
 * `handler(task)` is called for each; a task already past its fire time is run
 * immediately. Expired schedules are dropped rather than fired late.
 */
function restore(handler) {
    restoreHandler = handler
    const tasks = readStore()
    const now = Date.now()
    let restored = 0
    for (const [id, task] of Object.entries(tasks)) {
        const fireAt = Number(task?.fireAt) || 0
        const meta = task?.meta || {}
        const kind = task?.kind || 'once'
        const overdue = now - fireAt
        // Drop anything more than a day stale: firing it late would be wrong.
        if (!fireAt || overdue > 24 * 60 * 60 * 1000) continue
        const delay = Math.max(0, fireAt - now)
        schedule(id, delay, () => {
            try {
                handler({ id, meta, kind })
            } catch (error) {
                console.error(`[SCHEDULER] restore handler for ${id} threw:`, error?.stack || error)
            }
        }, { meta, persistent: true, kind })
        restored += 1
    }
    console.log(`[SCHEDULER] restored ${restored} persistent task(s)`)
    return restored
}

function stats() {
    return { oneShot: timers.size, repeating: intervals.size }
}

module.exports = { schedule, repeat, cancel, has, list, cancelByPrefix, clearAll, restore, stats, STORE_PATH }
