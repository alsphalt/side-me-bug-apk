'use strict'

/*
 * DARKNOTE — `.state` and `.gppp`
 * -------------------------------
 * Both commands answer the same question in different directions:
 *
 *   .state  what does WhatsApp actually tell us about THIS person?
 *   .gppp   what is the current group's picture?
 *
 * THE HONESTY RULE, which shapes everything here:
 *
 *   Only information the live WhatsApp connection genuinely exposes is shown.
 *   Where the protocol does not expose something, the answer is "Unknown" or
 *   "None" - never a guess dressed up as a fact.
 *
 * Two things are worth stating plainly because they are easy to fake and this
 * module does not:
 *
 *   BLOCKED - WhatsApp lets a client read ITS OWN blocklist. It does NOT tell
 *   you whether the other person blocked you, and there is no honest way to
 *   discover that. So "Blocked" means the BOT has blocked them (readable), and
 *   "Cool" means the bot has not. If the blocklist cannot be read at all, the
 *   answer is "Unknown". Claiming "they blocked you" would be a fabrication.
 *
 *   REVERSE USERNAME - the installed Baileys build does NOT parse WhatsApp
 *   usernames. Its own source says so: USyncContactProtocol.js carries
 *   "TODO: Implement type / username fields (not yet supported)". The lookup
 *   below still checks contact records in case a future build starts populating
 *   one, and otherwise answers "None" rather than inventing a handle.
 */

const display = require('./display')
const { readBlocklist, matches } = require('./block-status')

/* -------------------------------- presence ------------------------------- */

const PRESENCE_WAIT_MS = 1500

function presenceOf(conn, jid) {
    const map = conn?.__darknotePresence
    if (!(map instanceof Map)) return null
    const keys = [display.bare(jid), jid].filter(Boolean)
    for (const key of keys) {
        const entry = map.get(display.bare(key))
        if (entry) return entry
    }
    return null
}

/**
 * Ask WhatsApp for this person's presence, then read whatever it gives us.
 *
 * `presenceSubscribe` is a genuine subscription - it does not bypass anything,
 * it just asks the server to report this contact's presence like any client
 * does. If the subscription is refused, or no presence arrives, the answer is
 * Unknown rather than a guess.
 */
async function resolvePresence(conn, jid) {
    const before = presenceOf(conn, jid)
    // A very recent cached value is good enough and avoids a needless wait.
    if (before && Date.now() - Number(before.at || 0) < 30000) {
        return { state: before.online ? 'Online' : 'Offline', source: 'cached' }
    }

    try {
        if (typeof conn.presenceSubscribe === 'function') await conn.presenceSubscribe(jid)
    } catch (error) {
        console.error('[STATE] presenceSubscribe refused:', error?.message || error)
        return { state: 'Unknown', source: 'subscribe-failed' }
    }

    // Give the server a moment to push an update before reading the cache.
    await new Promise(resolve => setTimeout(resolve, PRESENCE_WAIT_MS))

    const after = presenceOf(conn, jid)
    if (!after) return { state: 'Unknown', source: 'no-presence' }
    if (Date.now() - Number(after.at || 0) > 5 * 60 * 1000) return { state: 'Unknown', source: 'stale' }
    return { state: after.online ? 'Online' : 'Offline', source: 'live' }
}

/* --------------------------------- blocked ------------------------------- */

/**
 * The bot's OWN view of this contact. See the honesty note at the top: this is
 * not, and cannot be, "has this person blocked the bot".
 */
async function resolveBlocked(conn, jid) {
    let entries
    try {
        entries = await readBlocklist(conn)
    } catch (error) {
        console.error('[STATE] blocklist read threw:', error?.message || error)
        return 'Unknown'
    }
    if (!Array.isArray(entries)) return 'Unknown'
    try {
        return matches(entries, { pn: jid, lid: display.isLid(jid) ? jid : '' }) ? 'Blocked' : 'Cool'
    } catch (error) {
        console.error('[STATE] blocklist match failed:', error?.message || error)
        return 'Unknown'
    }
}

/* ---------------------------- reverse username --------------------------- */

/**
 * Only ever returns a real handle. Returns '' when the build exposes nothing,
 * which is the current, measured situation.
 */
function resolveUsername(conn, jid) {
    const keys = [display.bare(jid), jid].filter(Boolean)
    for (const key of keys) {
        const contact = conn?.contacts?.[display.bare(key)] || conn?.contacts?.[key]
        const candidate = contact?.username || contact?.usernames?.[0]?.username
        const value = display.clean(candidate, 40).replace(/^@/, '')
        // Reject anything that is really an identifier rather than a handle.
        if (value && !display.containsJid(value) && !/^\d{6,}$/.test(value)) return value
    }
    return ''
}

/* --------------------------------- .state -------------------------------- */

/**
 * Build the state box for one person.
 *
 * Every field states where its value came from, and any field WhatsApp does not
 * expose is reported as Unknown/None instead of being filled in.
 */
async function stateText(conn, jid) {
    const digits = display.number(jid)
    if (!digits) return { ok: false, reason: 'no-target' }

    // Prefer a phone-number JID for lookups; a LID still works for most fields.
    const lookupJid = display.isPn(jid) ? display.bare(jid) : (await resolveToPn(conn, jid)) || display.bare(jid)

    const name = display.displayName(conn, { id: lookupJid, lid: display.isLid(jid) ? display.bare(jid) : undefined }, lookupJid)
    const presence = await resolvePresence(conn, lookupJid)
    const blocked = await resolveBlocked(conn, lookupJid)
    const username = resolveUsername(conn, lookupJid)

    return {
        ok: true,
        fields: [
            { label: 'Number', value: `+${digits}` },
            { label: 'Status', value: presence.state },
            { label: 'Blocked', value: blocked },
            { label: 'WhatsApp Name', value: name },
            { label: 'Reverse Username', value: username || 'None' }
        ],
        meta: { presenceSource: presence.source }
    }
}

/** Turn a LID into its phone-number JID when the session already knows it. */
async function resolveToPn(conn, jid) {
    if (display.isPn(jid)) return display.bare(jid)
    try {
        if (typeof conn?.resolveLidEnhanced === 'function') {
            const resolved = await conn.resolveLidEnhanced(display.bare(jid))
            if (resolved && display.isPn(resolved)) return display.bare(resolved)
        }
    } catch (error) {
        console.error('[STATE] LID resolution failed:', error?.message || error)
    }
    return ''
}

function renderState(state) {
    return display.fieldBox('STATE', state.fields)
}

/* --------------------------------- .gppp --------------------------------- */

/**
 * Fetch the group's current picture as bytes.
 *
 * The WhatsApp CDN URL is NEVER shown to the user and never logged - only the
 * bytes are used, and they are sent as a normal image reply.
 */
async function groupPicture(conn, chat) {
    if (!chat || !String(chat).endsWith('@g.us')) return { ok: false, reason: 'not-a-group' }
    if (typeof conn.profilePictureUrl !== 'function') return { ok: false, reason: 'unsupported' }

    let url = ''
    try {
        url = await conn.profilePictureUrl(chat, 'image')
    } catch (error) {
        // A group with no picture makes this endpoint throw; that is a normal
        // answer, not an error worth alerting about.
        console.log('[GPPP] no group picture available:', error?.message || error)
        return { ok: false, reason: 'no-picture' }
    }
    if (!url) return { ok: false, reason: 'no-picture' }

    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        if (!buffer.length) throw new Error('empty picture')
        return { ok: true, buffer, type: response.headers.get('content-type') || 'image/jpeg' }
    } catch (error) {
        console.error('[GPPP] picture download failed:', error?.message || error)
        return { ok: false, reason: 'download-failed' }
    }
}

module.exports = {
    stateText,
    renderState,
    groupPicture,
    resolvePresence,
    resolveBlocked,
    resolveUsername,
    resolveToPn
}
