'use strict'

/*
 * DARKNOTE AI — owner identity.
 *
 * THE OWNER IS DERIVED FROM THE PAIRED SESSION, NOT FROM CONFIGURATION.
 *
 * The requirement is explicit: another person's JID must never be treated as the
 * owner. So the only accepted sources are the identifiers of the account the bot
 * is actually connected as — conn.user.id, its LID and its phone number. A
 * number typed into config.json (ownerNumber) is deliberately NOT trusted here,
 * because it can be edited, spoofed or left stale, and a mistake would hand a
 * stranger privileged access.
 *
 * This is what makes OWNER AI a genuinely separate capability: it is decided per
 * message from the live session, and it is never gated by whether the public
 * chatbot switch is on.
 */

/** Digits only, device suffix and domain stripped. */
function bareDigits(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

/** Every identifier the paired account is known by. */
function sessionOwnerIds(conn) {
    const ids = new Set()
    const candidates = [
        conn?.user?.id,
        conn?.user?.lid,
        conn?.user?.LID,
        conn?.user?.jid,
        conn?.user?.phoneNumber,
        conn?.authState?.creds?.me?.id,
        conn?.authState?.creds?.me?.lid
    ]
    for (const candidate of candidates) {
        const digits = bareDigits(candidate)
        if (digits) ids.add(digits)
    }
    return ids
}

/**
 * Is the sender of this message the paired account itself?
 * Compares only against live session identifiers, so a forged config value
 * cannot promote anyone.
 */
function isSessionOwner(conn, m) {
    const ids = sessionOwnerIds(conn)
    if (!ids.size) return false
    const sender = bareDigits(m?.sender || m?.key?.participant || m?.key?.remoteJid)
    if (!sender) return false
    return ids.has(sender)
}

/**
 * Are we in a direct chat with the owner?
 * The owner talks to the bot by messaging the bot's own number, which arrives as
 * a normal DM from their JID.
 */
function isOwnerDirectChat(conn, m) {
    const chat = String(m?.chat || m?.key?.remoteJid || '')
    if (!chat || chat.endsWith('@g.us') || chat.endsWith('@newsletter')) return false
    return isSessionOwner(conn, m)
}

/** Human-readable owner id for logs only — never sent to a user. */
function describeOwner(conn) {
    const ids = [...sessionOwnerIds(conn)]
    return ids.length ? ids[0] : 'unknown'
}

module.exports = { sessionOwnerIds, isSessionOwner, isOwnerDirectChat, describeOwner, bareDigits }
