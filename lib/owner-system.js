'use strict'

/* Central DARKNOTE owner authorization. The existing database/owner.json is
 * retained, but added owners are now isolated by the paired DARKNOTE session.
 * A legacy flat owner array is migrated to the primary session on first read.
 */
const fs = require('fs')
const path = require('path')
const OWNER_PATH = path.join(__dirname, '..', 'database', 'owner.json')

function normalizeNumber(value) {
    let n = String(value || '').trim().replace(/\D/g, '')
    if (n.startsWith('00')) n = n.slice(2)
    if (/^0\d{9}$/.test(n)) n = `254${n.slice(1)}`
    return n
}
// A JID looks like "254107287140:5@s.whatsapp.net". The ":5" is the device id,
// which changes every time the bot is re-linked, so it must be stripped or the
// owner store key would churn and orphan previously added owners.
function userPart(value) {
    return normalizeNumber(String(value || '').split('@')[0].split(':')[0])
}
function sessionKey(conn) { return pairedNumber(conn) || 'unpaired' }
function primaryCreatorNumber(config) { return normalizeNumber(config?.ownerNumber) }
// The number this bot is actually paired to. It is always an owner, regardless
// of what config.json says, so re-linking to a new number transfers ownership
// without editing the config.
function pairedNumber(conn) { return userPart(conn?.user?.id) }

function readStore(config, conn) {
    try {
        if (!fs.existsSync(OWNER_PATH)) fs.writeFileSync(OWNER_PATH, '{}')
        let raw = JSON.parse(fs.readFileSync(OWNER_PATH, 'utf8'))
        if (Array.isArray(raw)) {
            raw = { [primaryCreatorNumber(config) || 'unpaired']: [...new Set(raw.map(normalizeNumber).filter(n => /^\d{8,15}$/.test(n)))] }
            writeStore(raw)
        }
        if (!raw || typeof raw !== 'object') raw = {}

        // Earlier builds never attached the connection to the message, so the
        // per-session store was written under "unpaired". Fold those entries into
        // the real session key so previously added owners are not lost.
        const key = sessionKey(conn)
        if (key !== 'unpaired' && Array.isArray(raw.unpaired) && raw.unpaired.length) {
            raw[key] = [...new Set([...(Array.isArray(raw[key]) ? raw[key] : []), ...raw.unpaired])]
            delete raw.unpaired
            writeStore(raw)
        }
        return raw
    } catch (error) {
        console.error('[OWNER] Read failed:', error?.message || error)
        return {}
    }
}
function writeStore(store) {
    const tmp = `${OWNER_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, OWNER_PATH)
}
function readOwners(conn, config) {
    const store = readStore(config, conn)
    const key = sessionKey(conn)
    const list = Array.isArray(store[key]) ? store[key] : []
    return [...new Set(list.map(normalizeNumber).filter(n => /^\d{8,15}$/.test(n)))]
}
function writeOwners(list, conn, config) {
    const store = readStore(config, conn)
    const key = sessionKey(conn)
    const clean = [...new Set((Array.isArray(list) ? list : []).map(normalizeNumber).filter(n => /^\d{8,15}$/.test(n)))]
    store[key] = clean
    writeStore(store)
    return clean
}
function isPrimaryCreator(m, config) {
    const sender = normalizeNumber(m?.sender)
    if (!sender) return false
    const conn = m?.__darknoteConn
    if (sender === pairedNumber(conn)) return true
    return sender === primaryCreatorNumber(config)
}
function isOwner(m, config) {
    const sender = normalizeNumber(m?.sender)
    if (!sender) return false
    const conn = m?.__darknoteConn
    // The paired number owns the bot by definition.
    if (sender === pairedNumber(conn)) return true
    return sender === primaryCreatorNumber(config) || readOwners(conn, config).includes(sender)
}
function addOwner(value, config, conn) {
    const number = normalizeNumber(value)
    if (!/^\d{8,15}$/.test(number)) return { ok: false, code: 'invalid' }
    // pairedNumber(), not normalizeNumber(), so the ":<device>" suffix cannot
    // hide the fact that this is the bot's own number.
    const self = pairedNumber(conn)
    if (self && number === self) return { ok: false, code: 'self', number }
    const primary = primaryCreatorNumber(config)
    if (number === primary) return { ok: false, code: 'primary', number }
    const owners = readOwners(conn, config)
    if (owners.includes(number)) return { ok: false, code: 'exists', number }
    owners.push(number)
    writeOwners(owners, conn, config)
    return { ok: true, number }
}
function removeOwner(value, config, conn) {
    const number = normalizeNumber(value)
    if (!/^\d{8,15}$/.test(number)) return { ok: false, code: 'invalid' }
    if (number === primaryCreatorNumber(config)) return { ok: false, code: 'primary', number }
    const owners = readOwners(conn, config)
    if (!owners.includes(number)) return { ok: false, code: 'missing', number }
    writeOwners(owners.filter(n => n !== number), conn, config)
    return { ok: true, number }
}
module.exports = { normalizeNumber, sessionKey, pairedNumber, primaryCreatorNumber, readOwners, writeOwners, isPrimaryCreator, isOwner, addOwner, removeOwner }
