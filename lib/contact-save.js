'use strict'

/* DARKNOTE surgical .contact / .save support.
 * Reuses the existing connection, number normalization and config persistence.
 * Baileys does not expose a general phone-address-book "save contact" RPC, so
 * .save persists the requested number/name mapping in DARKNOTE's existing
 * config store and updates the live contact cache. No fake WhatsApp success is
 * reported as a native phone-address-book save.
 */
const fs = require('fs')
const path = require('path')
const ownerSystem = require('./owner-system.js')

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')
const config = require(CONFIG_PATH)

function sessionKey(conn) {
    return ownerSystem.sessionKey(conn)
}

function normalizeNumber(value) {
    return ownerSystem.normalizeNumber(value)
}

function isNumber(value) {
    return /^\d{8,15}$/.test(normalizeNumber(value))
}

function cleanJid(value, conn) {
    let jid = String(value || '').trim()
    if (!jid) return ''
    try { jid = conn?.decodeJid ? conn.decodeJid(jid) : jid } catch {}
    return jid
}

async function resolveUserJid(value, conn) {
    let jid = cleanJid(value, conn)
    if (!jid) return ''
    if (/@lid$/i.test(jid) && typeof conn?.resolveLidEnhanced === 'function') {
        try { jid = cleanJid(await conn.resolveLidEnhanced(jid), conn) } catch {}
    }
    if (!/@s\.whatsapp\.net$/i.test(jid)) {
        const number = normalizeNumber(jid)
        if (!isNumber(number)) return ''
        jid = `${number}@s.whatsapp.net`
    }
    if (typeof conn?.onWhatsApp === 'function') {
        try {
            const found = await conn.onWhatsApp(numberFromJid(jid))
            if (Array.isArray(found) && found.length === 0) return ''
            const resolved = found?.find(x => x?.jid)?.jid
            if (resolved) jid = cleanJid(resolved, conn)
        } catch (error) {
            // Validation failure is handled by the caller; do not fabricate a JID.
            if (!/@s\.whatsapp\.net$/i.test(jid)) return ''
        }
    }
    return /@s\.whatsapp\.net$/i.test(jid) ? jid : ''
}

function numberFromJid(jid) {
    return normalizeNumber(String(jid || '').split('@')[0])
}

function saveConfig() {
    const tmp = `${CONFIG_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fs.renameSync(tmp, CONFIG_PATH)
}

function getSessionStore(conn) {
    if (!config.sessionSettings || typeof config.sessionSettings !== 'object' || Array.isArray(config.sessionSettings)) config.sessionSettings = {}
    const key = sessionKey(conn)
    if (!config.sessionSettings[key] || typeof config.sessionSettings[key] !== 'object' || Array.isArray(config.sessionSettings[key])) {
        config.sessionSettings[key] = {}
    }
    const store = config.sessionSettings[key]
    if (!store.savedContacts || typeof store.savedContacts !== 'object' || Array.isArray(store.savedContacts)) store.savedContacts = {}
    return store
}

function updateLiveContact(conn, jid, name) {
    if (!conn) return
    conn.contacts = conn.contacts || {}
    conn.chats = conn.chats || {}
    const existingContact = conn.contacts[jid] || { id: jid }
    conn.contacts[jid] = { ...existingContact, id: jid, name, notify: name }
    const existingChat = conn.chats[jid] || { id: jid }
    conn.chats[jid] = { ...existingChat, id: jid, name, notify: name }
}

async function resolveContactTarget(m, args, conn) {
    const first = String(args?.[0] || '').trim()
    const numberLike = /^[+]?\d[\d\s().-]*$/.test(first) || /^00\d+$/.test(first)
    const explicit = args?.length >= 2 && numberLike
    if (explicit) {
        const number = normalizeNumber(first)
        if (!isNumber(number)) return { ok: false, code: 'invalid-number' }
        const jid = await resolveUserJid(`${number}@s.whatsapp.net`, conn)
        return jid ? { ok: true, jid, number } : { ok: false, code: 'not-whatsapp' }
    }

    if (m?.quoted?.sender) {
        const jid = await resolveUserJid(m.quoted.sender, conn)
        return jid ? { ok: true, jid, number: numberFromJid(jid) } : { ok: false, code: 'invalid-quoted' }
    }

    if (!m?.isGroup && /@s\.whatsapp\.net$/i.test(String(m?.chat || ''))) {
        const jid = await resolveUserJid(m.chat, conn)
        const self = normalizeNumber(conn?.user?.id)
        const number = jid ? numberFromJid(jid) : ''
        if (jid && number !== self) return { ok: true, jid, number }
    }

    return { ok: false, code: 'no-target' }
}

async function sendContactText(conn, jid, text, options = {}) {
    if (!conn || typeof conn.sendMessage !== 'function') throw new Error('WhatsApp connection is unavailable')
    const result = await conn.sendMessage(jid, { text }, options)
    if (!result) throw new Error('WhatsApp did not confirm the message send')
    return result
}

async function saveContact(conn, jid, name) {
    const number = numberFromJid(jid)
    if (!number || !name) throw new Error('Invalid contact data')
    const store = getSessionStore(conn)
    store.savedContacts[number] = { number, jid: `${number}@s.whatsapp.net`, name, updatedAt: new Date().toISOString() }
    saveConfig()
    updateLiveContact(conn, `${number}@s.whatsapp.net`, name)
    return { number, name, persisted: true, nativePhoneBook: false }
}

module.exports = {
    normalizeNumber,
    isNumber,
    resolveUserJid,
    resolveContactTarget,
    sendContactText,
    saveContact,
    numberFromJid
}
