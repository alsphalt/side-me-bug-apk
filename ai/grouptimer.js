'use strict'

/*
 * DARKNOTE AI — group close / open, including timed.
 *
 *   close            -> only admins may send (announcement)
 *   open             -> everyone may send (not_announcement)
 *   close 10min      -> close now, reopen automatically after 10 minutes
 *   open 10min       -> open now, close automatically after 10 minutes
 *
 * The setting tags are taken from the installed build: groupSettingUpdate is
 * used with 'announcement' for a closed group and 'not_announcement' for an open
 * one, which is what this fork's own README documents.
 *
 * ONE scheduled job per group, keyed by the group JID. A new timed action
 * cancels the previous one before scheduling, so repeated commands can never
 * stack up or fire the opposite state at a stale time. Jobs are marked
 * persistent, so a scheduled reopen survives a bot restart.
 */

const scheduler = require('./scheduler')
const presence = require('./presence')

const taskId = jid => `grouptoggle:${jid}`

const CLOSE = 'announcement'
const OPEN = 'not_announcement'

/** Apply a group setting now. */
async function apply(conn, jid, close) {
    if (typeof conn?.groupSettingUpdate !== 'function') {
        return { ok: false, code: 'API_UNAVAILABLE', reason: 'this build does not expose groupSettingUpdate' }
    }
    try {
        await conn.groupSettingUpdate(jid, close ? CLOSE : OPEN)
        return { ok: true, state: close ? 'closed' : 'open' }
    } catch (error) {
        return { ok: false, code: 'FAILED', reason: error?.message || String(error) }
    }
}

/** Is the bot allowed to change settings in this group? */
async function canControl(conn, jid) {
    try {
        const metadata = await conn.groupMetadata(jid)
        const me = String(conn?.user?.id || '').split('@')[0].split(':')[0]
        const participants = metadata?.participants || []
        const mine = participants.find(p => String(p.id || p.jid || '').split('@')[0].split(':')[0] === me)
        return { ok: Boolean(mine?.admin), metadata }
    } catch (error) {
        return { ok: false, error: error?.message || String(error) }
    }
}

/** Immediate action, cancelling any pending timed flip for this group. */
async function immediate(conn, jid, close) {
    scheduler.cancel(taskId(jid))
    const result = await apply(conn, jid, close)
    if (!result.ok) return result
    return { ...result, scheduled: false }
}

/**
 * Action now, and the opposite state after `ms`.
 * Replaces any previously scheduled flip for this group.
 */
async function timed(conn, jid, close, ms) {
    scheduler.cancel(taskId(jid))
    const result = await apply(conn, jid, close)
    if (!result.ok) return result

    const flipToClose = !close
    scheduler.schedule(taskId(jid), ms, async () => {
        const flipped = await apply(conn, jid, flipToClose)
        console.log(flipped.ok
            ? `[GROUPTIMER] ${jid} automatically ${flipToClose ? 'closed' : 'opened'} after ${presence.formatDuration(ms)}`
            : `[GROUPTIMER] timed flip for ${jid} failed: ${flipped.reason}`)
    }, {
        meta: { jid, flipToClose, ms },
        persistent: true,
        kind: 'grouptoggle'
    })

    return { ...result, scheduled: true, flipAt: Date.now() + ms, ms }
}

/** Cancel a pending flip for this group. */
function cancel(jid) {
    return scheduler.cancel(taskId(jid))
}

function pendingFor(jid) {
    const entry = scheduler.list().find(t => t.id === taskId(jid))
    if (!entry) return null
    return { inMs: entry.inMs, meta: entry.meta }
}

/** Restore scheduled flips after a restart. Called once the connection is open. */
async function restore(conn, tasks = []) {
    let restored = 0
    for (const task of tasks) {
        const jid = task?.meta?.jid
        const flipToClose = task?.meta?.flipToClose
        if (!jid) continue
        const result = await apply(conn, jid, flipToClose)
        console.log(result.ok
            ? `[GROUPTIMER] restored: ${jid} set to ${flipToClose ? 'closed' : 'open'} after a restart`
            : `[GROUPTIMER] restore for ${jid} failed: ${result.reason}`)
        restored += 1
    }
    return restored
}

/**
 * Restore from the scheduler's own persisted task list.
 * Called by the boot sequence after the socket is open.
 */
function pendingTasks() {
    return scheduler.list().filter(t => t.id.startsWith('grouptoggle:'))
}

module.exports = { apply, canControl, immediate, timed, cancel, pendingFor, restore, pendingTasks, taskId, CLOSE, OPEN }
