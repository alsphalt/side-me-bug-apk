'use strict'

/*
 * DARKNOTE L2 LICENSE
 * Correct WhatsApp blocklist requests.
 * © DARKNOTE L2 • Bigbrother
 *
 * WHY THIS MODULE EXISTS
 * WhatsApp migrated accounts to LID addressing. The blocklist RPC now has to be
 * sent with the target's LID, plus its phone-number JID when blocking:
 *
 *   block   -> <item action="block"   jid="<lid>" pn_jid="<pn>"/>
 *   unblock -> <item action="unblock" jid="<lid>"/>
 *
 * The installed Baileys build still sends the phone-number JID alone, so
 * WhatsApp answers with an error and the bot reports:
 *
 *   [BLOCK] Error: Error: bad-request
 *
 * `updateBlockStatus()` is not used here. `conn.query` is exposed by the build,
 * so the correctly-shaped request is issued directly.
 *
 * The build has no `signalRepository.lidMapping`, so LIDs are only ever taken
 * from state the running session already holds: the contact directory, the
 * LID->PN map maintained by the message layer, and group metadata. Nothing is
 * guessed, and when no LID can be found the legacy form is still attempted so
 * the real server error is reported instead of a fabricated success.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys')

const BLOCKLIST_XMLNS = 'blocklist'
const WA_NET = 's.whatsapp.net'

const number = (value) => String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '')
const bare = (value) => String(value || '').split(':')[0].trim().toLowerCase()
const isLid = (value) => /@lid$/i.test(String(value || ''))
const isPn = (value) => /@s\.whatsapp\.net$/i.test(String(value || ''))

/** Every PN -> LID relationship the session already knows about. */
function findLids(conn, pnJid) {
    const digits = number(pnJid)
    const found = new Set()
    if (!digits) return []

    const push = (value) => {
        const jid = bare(value)
        if (isLid(jid)) found.add(jid)
    }

    // 1. Contact directory. Either side may be the LID.
    try {
        for (const [key, value] of Object.entries(conn?.contacts || {})) {
            const keyJid = bare(key)
            if (number(key) === digits && isLid(keyJid)) push(keyJid)
            const ids = [value?.id, value?.jid].filter(Boolean)
            if (ids.some(id => number(id) === digits)) {
                push(value?.lid)
                if (isLid(keyJid)) push(keyJid)
            }
        }
    } catch (error) {
        console.error('[BLOCK] contact directory scan failed:', error?.message || error)
    }

    // 2. The LID -> PN map the message layer maintains.
    try {
        const map = conn?.lidToJidMap
        if (map instanceof Map) {
            for (const [lid, pn] of map) if (number(pn) === digits) push(lid)
        } else if (map && typeof map === 'object') {
            for (const [lid, pn] of Object.entries(map)) if (number(pn) === digits) push(lid)
        }
    } catch (error) {
        console.error('[BLOCK] LID map scan failed:', error?.message || error)
    }

    // 3. Group metadata carries both identities for every participant.
    try {
        for (const chat of Object.values(conn?.chats || {})) {
            const participants = chat?.metadata?.participants
            if (!Array.isArray(participants)) continue
            for (const participant of participants) {
                const ids = [participant?.id, participant?.jid, participant?.lid].filter(Boolean)
                if (!ids.some(id => number(id) === digits)) continue
                // In LID-addressed groups participant.id is itself the LID.
                for (const id of ids) push(id)
            }
        }
    } catch (error) {
        console.error('[BLOCK] group metadata scan failed:', error?.message || error)
    }

    return [...found]
}

/**
 * Ask WhatsApp for the LID of a phone number. The installed build implements
 * onWhatsApp() as a USync query that includes the LID protocol and returns
 * `{ jid, exists, lid }`, which is the only reliable way to get a LID for a
 * number the session has not otherwise seen. Without this, a bare number can
 * only be sent in the legacy phone-number form, which WhatsApp rejects.
 */
async function discoverLid(conn, pnJid) {
    if (typeof conn?.onWhatsApp !== 'function') return ''
    const digits = number(pnJid)
    if (!digits) return ''
    try {
        const found = await conn.onWhatsApp(digits)
        if (!Array.isArray(found)) return ''
        for (const entry of found) {
            const raw = entry?.lid
            if (!raw) continue
            const value = String(raw).includes('@') ? String(raw).toLowerCase() : `${String(raw).toLowerCase()}@lid`
            if (isLid(value)) return value
        }
    } catch (error) {
        console.error('[BLOCK] WhatsApp LID lookup failed:', error?.message || error)
    }
    return ''
}

/** Best effort { pn, lid } pair for a resolved block target. */
async function resolveIdentity(conn, target) {
    const base = bare(target)
    let lid = isLid(base) ? base : ''
    let pn = isPn(base) ? jidNormalizedUser(base) : ''

    if (lid && !pn && typeof conn?.resolveLidEnhanced === 'function') {
        try {
            const resolved = await conn.resolveLidEnhanced(lid)
            if (isPn(resolved)) pn = jidNormalizedUser(resolved)
        } catch (error) {
            console.error('[BLOCK] LID -> PN resolution failed:', error?.message || error)
        }
    }
    if (pn && !lid) {
        // Session knowledge first (free), then ask WhatsApp directly.
        const candidates = findLids(conn, pn)
        if (candidates.length) lid = candidates[0]
        else lid = await discoverLid(conn, pn)
    }
    return { pn, lid }
}

/** Requests to try, most-correct first (mirrors upstream Baileys). */
function candidatesFor(identity, action) {
    const list = []
    if (action === 'block') {
        if (identity.lid && identity.pn) list.push({ action, jid: identity.lid, pn_jid: identity.pn })
        if (identity.lid) list.push({ action, jid: identity.lid })
        if (identity.pn) list.push({ action, jid: identity.pn })
    } else {
        if (identity.lid) list.push({ action, jid: identity.lid })
        if (identity.pn) list.push({ action, jid: identity.pn })
    }
    return list
}

function serverCodeOf(error) {
    const data = error?.data
    if (typeof data === 'number') return data
    const status = error?.output?.statusCode
    return typeof status === 'number' ? status : null
}

async function setBlockStatus(conn, identity, action) {
    if (typeof conn?.query !== 'function') {
        return { ok: false, code: 'NO_QUERY', reason: 'This Baileys build does not expose the raw query API.' }
    }

    const candidates = candidatesFor(identity, action)
    if (!candidates.length) {
        return { ok: false, code: 'NO_IDENTITY', reason: 'No usable WhatsApp identity was found for that target.' }
    }

    let last = null
    for (let i = 0; i < candidates.length; i++) {
        const attrs = candidates[i]
        try {
            await conn.query({
                tag: 'iq',
                attrs: { xmlns: BLOCKLIST_XMLNS, to: WA_NET, type: 'set' },
                content: [{ tag: 'item', attrs }]
            })
            if (i > 0) console.error(`[BLOCK] succeeded with fallback form ${JSON.stringify(attrs)}`)
            return { ok: true, code: 'APPLIED', attrs, attempt: i + 1 }
        } catch (error) {
            const code = String(error?.message || error || 'unknown error')
            const serverCode = serverCodeOf(error)
            console.error(`[BLOCK] attempt ${i + 1}/${candidates.length} with ${JSON.stringify(attrs)} failed: ${code}${serverCode ? ` (server code ${serverCode})` : ''}`)
            last = { code, serverCode }
        }
    }

    return {
        ok: false,
        code: 'REJECTED',
        reason: last?.code || 'WhatsApp rejected the request',
        serverCode: last?.serverCode ?? null,
        attempted: candidates.length
    }
}

/** Current blocklist, as raw JIDs (either LID or PN form). */
async function readBlocklist(conn) {
    if (typeof conn?.fetchBlocklist !== 'function') return null
    try {
        const list = await conn.fetchBlocklist()
        const entries = Array.isArray(list) ? list : (list?.blocklist || list?.participants || [])
        return entries
            .map(entry => bare(entry?.jid || entry?.id || entry))
            .filter(Boolean)
    } catch (error) {
        console.error('[BLOCK] blocklist read failed:', error?.message || error)
        return null
    }
}

/** The blocklist may key an entry by either identity, so accept both. */
function matches(entries, identity) {
    if (!Array.isArray(entries)) return false
    const pnNumber = number(identity?.pn)
    const lid = bare(identity?.lid)
    return entries.some(entry => {
        const value = bare(entry)
        if (lid && value === lid) return true
        if (pnNumber && number(value) === pnNumber) return true
        return false
    })
}

module.exports = { resolveIdentity, discoverLid, findLids, setBlockStatus, readBlocklist, matches, candidatesFor, number, bare, isLid, isPn }
