'use strict'

/*
 * DARKNOTE DISPLAY LAYER
 * ----------------------
 * One place that decides what a person is CALLED in a visible response, so no
 * command has to invent its own rule and none of them can leak a raw JID.
 *
 * THE RULE
 *   Visible text shows the WhatsApp display name. The raw JID goes into the
 *   `mentions` array and NOWHERE else. Nothing user-facing ever contains
 *   "@s.whatsapp.net", a device suffix, or a bare number standing in for a name.
 *
 * ── Why the mention token is still an "@<number>" ──────────────────────────
 * WhatsApp renders a clickable mention by scanning the message TEXT for an
 * "@<number>" token that matches an entry in mentionedJid, and then DISPLAYS the
 * contact's own name in its place. That substitution is done by WhatsApp itself.
 *
 * So the token is the only way to get a genuinely clickable mention, and it is
 * also why the user never sees a number: WhatsApp swaps it for "@John". Writing
 * "@John" literally would produce blue-looking text that is NOT a real mention,
 * which is why it is not done here.
 *
 * What WAS wrong before is different: the old formatter printed the name AND the
 * number together - "John (@254712345678)" - so the raw number was sitting in
 * the message as plain text. That is the leak this file removes.
 */

const JID_SUFFIX = /@(s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)$/i

/* ------------------------------- primitives ------------------------------ */

function clean(value, max = 60) {
    return String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
}

/** Digits only, no device suffix, no domain. */
function number(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

/** A JID with no device suffix, lower-cased. */
function bare(value) {
    return String(value || '').split(':')[0].trim().toLowerCase()
}

const isPn = value => /@s\.whatsapp\.net$/i.test(String(value || ''))
const isLid = value => /@lid$/i.test(String(value || ''))

/**
 * Anything that even LOOKS like a JID or a long digit run.
 *
 * Used as a final guard on assembled text: if a JID ever reaches a visible
 * string, this catches it before it is sent, whichever code path produced it.
 */
const JID_LIKE = /@(s\.whatsapp\.net|lid|g\.us)\b|\b\d{8,}@/i

function containsJid(text) {
    return JID_LIKE.test(String(text || ''))
}

/**
 * The last line of defence. Strips a JID-shaped token out of text bound for a
 * user and leaves the readable part behind.
 */
function stripJids(text) {
    return String(text || '')
        .replace(new RegExp(`\\d{6,}${JID_SUFFIX.source}`, 'gi'), '')
        .replace(/@s\.whatsapp\.net/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/* ------------------------------ name lookup ------------------------------ */

/**
 * The JID a mention must use. Real phone-number JIDs are preferred because they
 * are what WhatsApp renders reliably; a LID is accepted as a fallback since it
 * is still a real account identifier.
 */
function mentionJid(participant) {
    const raw = [participant?.id, participant?.jid, participant?.phoneNumber, participant?.lid]
        .map(value => String(value || '').trim())
        .filter(Boolean)
    for (const value of raw) if (isPn(value)) return bare(value)
    for (const value of raw) if (isLid(value)) return bare(value)
    for (const value of raw) if (/^\d{8,15}$/.test(value)) return `${value}@s.whatsapp.net`
    const fallback = raw[0] || ''
    return fallback.includes('@') ? bare(fallback) : ''
}

/**
 * The WhatsApp-provided name for a person.
 *
 * ORDER MATTERS AND IS THE POINT OF THIS FUNCTION.
 *
 *   notify       - the PUSH NAME the person sets on their own account. This is
 *                  the one the brief calls the "WhatsApp display name".
 *   verifiedName - set for business accounts.
 *   name         - from a group participant record; server-provided.
 *   contacts[].notify - the same push name, held in the contact directory.
 *   contacts[].name   - LAST RESORT ONLY. This is the address-book name, i.e.
 *                  the nickname the bot's owner saved. The brief is explicit
 *                  that a saved nickname ("My Love") must never replace the real
 *                  display name, so it is consulted only after every
 *                  server-provided source has been exhausted.
 */
function displayName(conn, participant, jidOverride) {
    const jid = jidOverride || mentionJid(participant) || String(participant?.id || '')

    for (const candidate of [participant?.notify, participant?.verifiedName, participant?.name, participant?.displayName]) {
        const name = clean(candidate)
        if (name && !containsJid(name)) return name
    }

    const keys = [bare(jid), String(jid || ''), participant?.lid, participant?.id].filter(Boolean)
    for (const key of keys) {
        const contact = conn?.contacts?.[bare(key)] || conn?.contacts?.[key]
        const name = clean(contact?.notify || contact?.verifiedName)
        if (name && !containsJid(name)) return name
    }
    const chat = conn?.chats?.[bare(jid)] || conn?.chats?.[jid]
    const chatName = clean(chat?.notify || chat?.name)
    if (chatName && !containsJid(chatName)) return chatName

    // Saved address-book name: accepted only here, after all of the above.
    for (const key of keys) {
        const contact = conn?.contacts?.[bare(key)] || conn?.contacts?.[key]
        const name = clean(contact?.name)
        if (name && !containsJid(name)) return name
    }

    // Nothing server-provided exists. A readable number is a safe fallback and
    // still contains no JID.
    const digits = number(jid)
    return digits ? `+${digits}` : 'WhatsApp member'
}

/**
 * The push name of whoever sent this message, for text the owner types.
 * Falls back to the session's own contact record, then a readable number.
 */
function senderName(conn, m) {
    const raw = m?.pushName || m?.senderPushName || m?.verifiedName
    const direct = clean(raw)
    if (direct && !containsJid(direct)) return direct

    const sender = bare(m?.sender)
    const contact = conn?.contacts?.[sender]
    const fromContact = clean(contact?.notify || contact?.verifiedName)
    if (fromContact && !containsJid(fromContact)) return fromContact

    const digits = number(m?.sender)
    return digits ? `+${digits}` : 'the owner'
}

/* ------------------------------ mention lists ---------------------------- */

/**
 * Resolve every participant to { jid, name, token, isAdmin }.
 *
 * `token` is what goes in the text: "@<number>" for a real mention, else
 * "@<name>" so the line is still readable when no mention is possible.
 */
function resolveMembers(conn, participants, options = {}) {
    const {
        excludeJids = [],
        adminOnly = false,
        creatorOnly = false
    } = options

    /*
     * Exclusions are matched by BARE JID *and* by NUMBER.
     *
     * A caller naturally passes whatever identity it holds - sometimes
     * "254107287140", sometimes "254107287140@s.whatsapp.net", sometimes with a
     * ":<device>" suffix. Comparing only bare JIDs silently failed to exclude the
     * bot when a bare number was supplied, and the bot ended up tagging itself.
     * Matching on the digits as well makes every form work.
     */
    const skipJids = new Set()
    const skipNumbers = new Set()
    for (const value of excludeJids) {
        const jid = bare(value)
        if (!jid) continue
        skipJids.add(jid)
        const digits = number(jid)
        if (digits) skipNumbers.add(digits)
    }
    const isExcluded = value => {
        const jid = bare(value)
        if (!jid) return false
        if (skipJids.has(jid)) return true
        const digits = number(jid)
        return Boolean(digits && skipNumbers.has(digits))
    }

    const seen = new Set()
    const members = []

    for (const participant of participants || []) {
        const jid = mentionJid(participant)
        const key = bare(jid)
        if (!key || seen.has(key)) continue
        // Every identity the participant carries is checked, so a LID/PN pair
        // cannot slip past the exclusion.
        if (isExcluded(jid) || isExcluded(participant?.id) || isExcluded(participant?.lid)) continue

        const role = String(participant?.admin || participant?.role || '').toLowerCase()
        const isCreator = role === 'superadmin' || participant?.isSuperAdmin === true || participant?.isCreator === true
        const isAdmin = isCreator || role === 'admin' || role === 'administrator' || participant?.isAdmin === true

        if (creatorOnly && !isCreator) continue
        if (adminOnly && !isAdmin) continue

        seen.add(key)
        const name = displayName(conn, participant, jid)
        // A phone-number JID gets a real mention token; a LID-only member would
        // render as an opaque digit string, so their name is shown instead.
        const token = isPn(jid) ? `@${number(jid)}` : `@${name}`
        members.push({ jid, name, token, isAdmin, isCreator })
    }

    return members
}

const mentionsOf = members => members.map(member => member.jid).filter(Boolean)

/* ------------------------------- the box --------------------------------- */

/*
 * The existing DARKNOTE normal-response wrapper. These commands use plain text
 * boxes on purpose: no cards, no carousel, no pagination, no buttons.
 */
function box(title, lines, footer = 'BIGBROTHER') {
    const body = (lines || []).filter(Boolean).map(line => `│ ${line}`)
    return [
        `╭─「 DARKNOTE ${String(title || '').toUpperCase()} 」`,
        '│',
        ...body,
        '│',
        `╰─「 ${footer} 」`
    ].join('\n')
}

/**
 * A vertical member list.
 *
 * One member per line, in the order given. No numbering brackets, no
 * "(number)", no truncation into pages.
 */
function memberBox(title, members, options = {}) {
    const max = Math.max(1, Number(options.max) || 200)
    const shown = members.slice(0, max)
    const lines = shown.map(member => {
        const marks = []
        if (member.isCreator) marks.push('👑')
        else if (member.isAdmin) marks.push('🛡️')
        // The token renders as the person's name in WhatsApp; the marks are
        // plain emoji and carry no identifier.
        return `${member.token}${marks.length ? ` ${marks.join('')}` : ''}`
    })

    if (members.length > shown.length) lines.push(`…and ${members.length - shown.length} more`)
    if (options.summary) lines.push('', options.summary)

    return box(title, lines, options.footer || 'BIGBROTHER')
}

/** A generic labelled field box (used by .state). */
function fieldBox(title, pairs, footer = 'BIGBROTHER') {
    const lines = pairs
        .filter(pair => pair && pair.value !== undefined && pair.value !== null)
        .map(pair => `${String(pair.label).padEnd(16)}: ${stripJids(pair.value)}`)
    return box(title, lines, footer)
}

module.exports = {
    clean,
    number,
    bare,
    isPn,
    isLid,
    containsJid,
    stripJids,
    mentionJid,
    displayName,
    senderName,
    resolveMembers,
    mentionsOf,
    box,
    memberBox,
    fieldBox
}
