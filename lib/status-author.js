'use strict'

/*
 * WHICH JID A STATUS REACTION SHOULD BE ADDRESSED TO
 * --------------------------------------------------
 * A Status arrives with `key.remoteJid = 'status@broadcast'` and its author in
 * `key.participant`. On this account that author is frequently a LID
 * (`39252410810457@lid`) rather than a phone number.
 *
 * A LID is an internal routing identifier, NOT a phone number. The previous code
 * stripped its digits and appended '@s.whatsapp.net', which invents a JID that
 * does not exist. WhatsApp answered `not-acceptable` (an assertSessions failure)
 * and the reaction was lost:
 *
 *   [ARS] broadcast reaction failed, trying the author directly: not-acceptable
 *   [ARS] status action failed: Error: not-acceptable
 *     at assertNodeErrorFree (.../generic-utils.js:57:15)
 *     at async assertSessions (.../messages-send.js:183:28)
 *
 * The same rejection happens when a LID is put in `statusJidList`: the recipient
 * list is used to assert sessions, and there is no session for a LID.
 *
 * So the author is resolved to a real phone-number JID wherever possible, using
 * the SAME resolver the profile-picture and group commands already use
 * (`conn.resolveLidEnhanced`, defined in lib/msg.js). That resolver returns the
 * LID unchanged when it has no mapping, so an unchanged value is treated as
 * "unknown" rather than as a successful resolution. When the mapping is unknown,
 * `pn` stays empty - which tells the caller not to invent a phone JID and not to
 * pass the LID as a recipient.
 */

/**
 * Compare JIDs ignoring the `:device` suffix but keeping the domain, so a LID
 * and a phone JID can never be mistaken for one another.
 */
function normalizeForCompare(value) {
    const text = String(value || '').trim()
    if (!text) return ''
    const at = text.lastIndexOf('@')
    const id = (at === -1 ? text : text.slice(0, at)).split(':')[0]
    if (at === -1) return id
    return `${id}@${text.slice(at + 1)}`
}

const isLid = value => String(value || '').trim().endsWith('@lid')

/**
 * Resolve a Status author.
 *
 * @returns {{raw: string, pn: string, lid: string}}
 *   raw - the participant exactly as it arrived
 *   pn  - a phone-number JID, when one could be resolved ('' otherwise)
 *   lid - the LID, set only when it could NOT be resolved to a phone number
 */
async function resolveStatusAuthor(conn, item) {
    const raw = String(item?.key?.participant || item?.participant || '').trim()
    if (!raw) return { raw: '', pn: '', lid: '' }
    // Already a normal JID: nothing to resolve.
    if (!isLid(raw)) return { raw, pn: raw, lid: '' }

    let resolved = ''
    try {
        if (typeof conn?.resolveLidEnhanced === 'function') {
            resolved = String((await conn.resolveLidEnhanced(raw)) || '').trim()
        }
    } catch (error) {
        // A resolver failure is not fatal here: it just means the author stays
        // unresolved, and the caller is told so through an empty `pn`.
        console.error('[STATUS AUTOMATION] the LID could not be resolved:', error?.message || error)
    }

    // The resolver returns the LID unchanged when it has no mapping, so an
    // unresolved result must not be mistaken for a phone number.
    if (resolved && !isLid(resolved)) return { raw, pn: resolved, lid: '' }
    return { raw, pn: '', lid: raw }
}

/**
 * Is this the paired account's own Status?
 *
 * Both sides are normalised before comparison, and the account's LID is checked
 * as well as its phone JID - otherwise a Status posted from the paired account
 * under its LID would look like someone else's and get reacted to.
 */
function isOwnStatus(conn, author) {
    const self = [conn?.user?.id, conn?.user?.lid]
        .filter(Boolean)
        .map(normalizeForCompare)
        .filter(Boolean)
    if (!self.length) return false
    const ids = [author?.raw, author?.pn]
        .filter(Boolean)
        .map(normalizeForCompare)
        .filter(Boolean)
    return self.some(value => ids.includes(value))
}

module.exports = { resolveStatusAuthor, normalizeForCompare, isOwnStatus, isLid }
