'use strict'

/*
 * DARKNOTE — EVIL_PAIN
 * --------------------
 * The mass group-removal sequence. Destructive by design, so it is fenced in on
 * every side:
 *
 *   OWNER ONLY  +  GROUP ONLY  +  BOT MUST BE ADMIN  +  EXPLICIT CONFIRM
 *
 * `evil_pain` on its own NEVER executes anything - it only prints the warning.
 * Only `evil_pain confirm` runs the sequence, and only for an authorised owner.
 *
 * THE SEQUENCE
 *   group picture -> group name -> random description -> final warning
 *   -> remove eligible participants -> bot leaves
 *
 * EVERY step is attempted independently and its REAL outcome is reported. If
 * WhatsApp refuses a step, the refusal is recorded and the run continues where
 * the brief says it should - and the summary says which parts failed rather than
 * claiming a clean sweep.
 *
 * The descriptions are deliberately fictional and atmospheric. Nothing here
 * threatens anybody, and nothing here claims to have removed someone it did not.
 */

const fs = require('fs')
const path = require('path')

const display = require('./display')

const ROOT = path.join(__dirname, '..')
// The brief refers to "pic menu.jpg". This is the asset the project already uses
// for its menu card, so the existing file is reused rather than a new image
// being invented.
const GROUP_PICTURE = path.join(ROOT, 'src', 'img', 'menu.jpg')

/*
 * Five atmospheric descriptions; one is chosen at random per successful run.
 * Fictional and dramatic, with no real-world threat in any of them.
 */
const DESCRIPTIONS = [
    '☬ BIGBROTHER has entered this room. Every move has been witnessed, every silence has been noticed. The shadows are awake.',
    '☬ Welcome to the final warning. The room is silent, the watcher is awake, and BIGBROTHER is watching from the shadows.',
    '☬ This is no longer an ordinary room. The lights are out, the doors are closing, and the BIGBROTHER edition has begun.',
    '☬ You were warned. The shadow is here, the countdown has started, and nothing inside this room is guaranteed to remain.',
    '☬ DARKNOTE has marked this room. Do not mistake the silence for safety. BIGBROTHER sees the final move.'
]

const FINAL_WARNING = [
    '☬ BIGBROTHER FINAL WARNING ☬',
    '',
    'This is the last message.',
    'The BIGBROTHER edition has started.',
    'The group is being closed.',
    '',
    'There will be no second warning.'
].join('\n')

// A short pause between removals so the requests are not fired as one burst.
// This is pacing for the server's sake, NOT a fix for duplicate handling - the
// single-handler guarantee is what prevents duplicates.
const REMOVE_INTERVAL_MS = 400

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

/* ------------------------------ confirmation ----------------------------- */

// Group -> timestamp of the last warning shown, so the warning is not spammed.
const warned = new Map()
// Groups currently mid-sequence. A second `confirm` is refused while this is set.
const running = new Set()

const WARN_TTL_MS = 10 * 60 * 1000

function warningText() {
    return [
        '⚠️ *EVIL_PAIN*',
        '',
        'This removes EVERY member this bot is permitted to remove, then the bot leaves the group.',
        '',
        'It will first change:',
        '• the group picture',
        '• the group name',
        '• the group description',
        '',
        'then send one final warning and start removing participants.',
        '',
        'This cannot be undone.',
        '',
        'To proceed, send:',
        '`evil_pain confirm`'
    ].join('\n')
}

function markWarned(chat) {
    warned.set(chat, Date.now())
    // Bound the map so a long-lived process cannot grow it without limit.
    if (warned.size > 200) {
        const cutoff = Date.now() - WARN_TTL_MS
        for (const [key, at] of warned) if (at < cutoff) warned.delete(key)
    }
}

const isRunning = chat => running.has(chat)

/* ------------------------------- the checks ------------------------------ */

/**
 * Verify every precondition and report the REAL reason when one fails.
 * Returns { ok, reason } - the caller decides what to tell the user.
 */
async function checkRequirements(conn, m) {
    if (!m?.isGroup) return { ok: false, reason: 'group-only' }

    let metadata
    try {
        metadata = await conn.groupMetadata(m.chat)
    } catch (error) {
        console.error('[EVIL_PAIN] groupMetadata failed:', error?.message || error)
        return { ok: false, reason: 'metadata-failed', detail: error?.message }
    }

    const botJid = display.bare(conn.user?.id || '')
    const botNumber = display.number(conn.user?.id || '')
    const self = (metadata.participants || []).find(participant => {
        const ids = [participant?.id, participant?.jid, participant?.lid].filter(Boolean).map(display.bare)
        return ids.includes(botJid) || ids.some(id => display.number(id) === botNumber)
    })

    if (!self) return { ok: false, reason: 'bot-not-in-group' }

    const role = String(self?.admin || self?.role || '').toLowerCase()
    const isAdmin = role === 'admin' || role === 'superadmin' || role === 'administrator' || self?.isAdmin === true
    if (!isAdmin) return { ok: false, reason: 'bot-not-admin' }

    return { ok: true, metadata, participants: metadata.participants || [] }
}

/* ------------------------------- the steps ------------------------------- */

/**
 * Apply the three group-profile changes. Each is independent: a failure is
 * recorded and the run continues, because a refused profile picture is no reason
 * to abandon the rest of a confirmed operation.
 */
async function applyProfile(conn, chat, ownerName, results) {
    // 1. GROUP PICTURE
    try {
        if (!fs.existsSync(GROUP_PICTURE)) throw new Error(`asset missing at ${GROUP_PICTURE}`)
        const buffer = fs.readFileSync(GROUP_PICTURE)
        if (!buffer.length) throw new Error('asset is empty')
        if (typeof conn.updateProfilePicture !== 'function') throw new Error('updateProfilePicture unavailable in this Baileys build')
        await conn.updateProfilePicture(chat, buffer)
        results.steps.push({ step: 'picture', ok: true })
        console.log('[EVIL_PAIN] group picture updated')
    } catch (error) {
        results.steps.push({ step: 'picture', ok: false, error: error?.message || String(error) })
        console.error('[EVIL_PAIN] picture update failed:', error?.message || error)
    }

    // 2. GROUP NAME
    const subject = `BIGBROTHER edition by ${ownerName} hell ooo`
    try {
        await conn.groupUpdateSubject(chat, subject)
        results.steps.push({ step: 'subject', ok: true, value: subject })
        console.log(`[EVIL_PAIN] group name set to "${subject}"`)
    } catch (error) {
        results.steps.push({ step: 'subject', ok: false, error: error?.message || String(error) })
        console.error('[EVIL_PAIN] subject update failed:', error?.message || error)
    }

    // 3. GROUP DESCRIPTION - ONE of the five, chosen at random per run.
    const description = DESCRIPTIONS[Math.floor(Math.random() * DESCRIPTIONS.length)]
    try {
        await conn.groupUpdateDescription(chat, description)
        results.steps.push({ step: 'description', ok: true, value: description })
        console.log('[EVIL_PAIN] group description updated')
    } catch (error) {
        results.steps.push({ step: 'description', ok: false, error: error?.message || String(error) })
        console.error('[EVIL_PAIN] description update failed:', error?.message || error)
    }

    return description
}

/**
 * Remove every participant the bot is permitted to remove.
 *
 * ONE AT A TIME. A participant WhatsApp refuses (the creator, a protected
 * account, or anyone the bot may not touch) is recorded as a failure and the
 * loop moves on - no retry loop, no abort, and above all no counting a refused
 * removal as a success.
 */
async function removeParticipants(conn, chat, participants, results) {
    const botJid = display.bare(conn.user?.id || '')
    const botNumber = display.number(conn.user?.id || '')
    const targets = []

    for (const participant of participants) {
        const jid = display.mentionJid(participant)
        if (!jid) continue
        const key = display.bare(jid)
        // The bot cannot remove itself; it leaves at the end instead.
        if (key === botJid || display.number(key) === botNumber) {
            results.skipped.push({ jid, name: display.displayName(conn, participant), reason: 'this is the bot itself' })
            continue
        }
        targets.push({ jid, name: display.displayName(conn, participant) })
    }

    console.log(`[EVIL_PAIN] attempting removal of ${targets.length} participant(s)`)

    for (const target of targets) {
        try {
            const response = await conn.groupParticipantsUpdate(chat, [target.jid], 'remove')
            /*
             * An empty or error-shaped response means WhatsApp did not accept the
             * change even though the call did not throw. Treating that as success
             * is exactly the false reporting the brief forbids, so it is checked.
             */
            const entry = Array.isArray(response) ? response.find(item => item?.jid) : response
            const status = String(entry?.status || entry?.content?.attrs?.error || '').toLowerCase()
            if (status && /error|forbidden|not-authorized|401|403/.test(status)) {
                results.failed.push({ ...target, reason: `server returned ${status}` })
            } else {
                results.removed.push(target)
            }
        } catch (error) {
            results.failed.push({ ...target, reason: error?.message || String(error) })
        }
        await sleep(REMOVE_INTERVAL_MS)
    }
}

/* --------------------------------- run ----------------------------------- */

/**
 * Execute the confirmed sequence.
 *
 * Never throws: every outcome is in the returned summary, so the caller can
 * report exactly what happened.
 */
async function execute(conn, m, ownerName, options = {}) {
    const chat = String(m.chat)
    if (running.has(chat)) {
        return { ok: false, reason: 'already-running' }
    }
    running.add(chat)
    // Used for messages that must reach the group BEFORE the bot leaves it.
    const notify = typeof options.notify === 'function' ? options.notify : null

    const started = Date.now()
    const results = { ok: true, steps: [], removed: [], failed: [], skipped: [], left: false, description: '' }

    try {
        const check = await checkRequirements(conn, m)
        if (!check.ok) {
            results.ok = false
            results.reason = check.reason
            results.detail = check.detail
            return results
        }

        // Profile changes first, exactly as the brief orders them.
        results.description = await applyProfile(conn, chat, ownerName, results)

        // ONE final warning, sent once, before any removal.
        try {
            await conn.sendMessage(chat, { text: FINAL_WARNING })
            results.steps.push({ step: 'warning', ok: true })
        } catch (error) {
            results.steps.push({ step: 'warning', ok: false, error: error?.message || String(error) })
            console.error('[EVIL_PAIN] final warning failed:', error?.message || error)
        }

        // The participant list is fetched IMMEDIATELY before removal, as required,
        // so anyone who left during the profile changes is not targeted.
        let participants = []
        try {
            const fresh = await conn.groupMetadata(chat)
            participants = fresh?.participants || []
        } catch (error) {
            results.steps.push({ step: 'participants', ok: false, error: error?.message || String(error) })
            console.error('[EVIL_PAIN] could not refresh participants:', error?.message || error)
            participants = check.participants
        }

        await removeParticipants(conn, chat, participants, results)

        /*
         * The truthful summary is sent BEFORE the bot leaves, because a bot that
         * has left the group cannot report anything back. Leaving first would
         * make the real outcome undeliverable, which is how a failure would end
         * up looking like a success.
         */
        if (notify) {
            try {
                await notify(summarise(results, { preLeave: true }))
            } catch (error) {
                console.error('[EVIL_PAIN] summary could not be delivered:', error?.message || error)
            }
        }

        // Finally, the bot leaves.
        try {
            await conn.groupLeave(chat)
            results.left = true
            results.steps.push({ step: 'leave', ok: true })
            console.log('[EVIL_PAIN] bot left the group')
        } catch (error) {
            results.steps.push({ step: 'leave', ok: false, error: error?.message || String(error) })
            console.error('[EVIL_PAIN] groupLeave failed:', error?.message || error)
            // The bot is still in the group, so this failure CAN be reported.
            if (notify) {
                try {
                    await notify(`❌ I could not leave the group: ${display.stripJids(error?.message || 'unknown error')}`)
                } catch (inner) {
                    console.error('[EVIL_PAIN] leave failure could not be reported:', inner?.message || inner)
                }
            }
        }

        results.ms = Date.now() - started
        console.log(`[EVIL_PAIN] finished: ${results.removed.length} removed, ${results.failed.length} refused, left=${results.left}`)
        return results
    } catch (error) {
        console.error('[EVIL_PAIN] unexpected failure:', error?.stack || error)
        results.ok = false
        results.reason = 'unexpected'
        results.detail = error?.message || String(error)
        return results
    } finally {
        running.delete(chat)
    }
}

/**
 * A truthful summary. Failed steps are named; nothing is dressed up.
 *
 * `preLeave` matters: this message is sent BEFORE the bot leaves, so the leave
 * has not happened yet. Printing "Bot left the group: no" at that point would be
 * misleading - it reads as a failure when the leave is simply still to come. In
 * pre-leave form the leave line is replaced with a statement of what happens
 * next, and a genuine leave failure is reported separately afterwards (the bot
 * is still in the group, so that message can actually be delivered).
 */
function summarise(results, options = {}) {
    const preLeave = options.preLeave === true
    const failedSteps = results.steps.filter(step => !step.ok)
    const lines = [
        '☬ *EVIL_PAIN COMPLETE*',
        '',
        `Removed: ${results.removed.length}`,
        `Refused by WhatsApp: ${results.failed.length}`,
        `Skipped: ${results.skipped.length}`,
        preLeave
            ? 'Leaving the group now.'
            : `Bot left the group: ${results.left ? 'yes' : 'no'}`
    ]

    if (failedSteps.length) {
        lines.push('', '*Steps that failed:*')
        for (const step of failedSteps) lines.push(`• ${step.step}: ${display.stripJids(step.error || 'failed')}`)
    }
    if (results.failed.length) {
        lines.push('', '*Participants WhatsApp would not remove:*')
        for (const item of results.failed.slice(0, 15)) lines.push(`• ${item.name}`)
        if (results.failed.length > 15) lines.push(`…and ${results.failed.length - 15} more`)
    }
    return lines.join('\n')
}

function reasonText(reason) {
    return {
        'group-only': '❌ This command only works inside a group.',
        'metadata-failed': "❌ I couldn't read this group's information. Please try again.",
        'bot-not-in-group': '❌ The bot is not a participant in this group.',
        'bot-not-admin': '❌ The bot must be a group admin before this can run.',
        'already-running': '⏳ This is already running in this group.'
    }[reason] || '❌ This operation cannot run here.'
}

module.exports = {
    execute,
    checkRequirements,
    summarise,
    warningText,
    reasonText,
    markWarned,
    isRunning,
    DESCRIPTIONS,
    FINAL_WARNING,
    GROUP_PICTURE,
    running
}
