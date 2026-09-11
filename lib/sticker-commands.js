'use strict'

/* Persistent sticker -> command trigger layer. Fingerprints use WhatsApp's
 * own fileSha256 when present and fall back to a SHA-256 of the actual media.
 */
const crypto = require('crypto')
const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const config = require('../config.json')
const { normalizeName, isRegisteredOrAlias, resolveCommand, saveConfig } = require('./command-system.js')

function unwrapSticker(value) {
    let current = value
    for (let i = 0; i < 5 && current; i++) {
        if (current.stickerMessage) return current.stickerMessage
        if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue }
        if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue }
        if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue }
        break
    }
    return null
}

function getStickerMessage(m) {
    if (!m) return null
    if (m.mtype === 'stickerMessage') return m.msg || m.message?.stickerMessage || null
    if (m.message?.stickerMessage) return m.message.stickerMessage
    if (m.quoted?.mtype === 'stickerMessage') return m.quoted.msg || m.quoted.message?.stickerMessage || m.quoted
    return unwrapSticker(m.quoted?.message || m.quoted) || unwrapSticker(m.message)
}

async function downloadSticker(sticker) {
    const stream = await downloadContentFromMessage(sticker, 'sticker')
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    if (!buffer.length) throw new Error('Sticker media is empty')
    return buffer
}

async function fingerprintSticker(sticker) {
    const ownHash = sticker?.fileSha256
    if (ownHash) {
        const raw = Buffer.isBuffer(ownHash) ? ownHash : Buffer.from(ownHash)
        if (raw.length) return `wa:${raw.toString('base64')}`
    }
    const data = await downloadSticker(sticker)
    return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`
}

function sessionKey(conn) {
    // Strip the device suffix (:10) before removing separators - it changes on
    // every re-link, which used to orphan the stored sticker triggers.
    const id = String(conn?.user?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '')
    return id || 'unpaired'
}

function loadMap(conn) {
    if (!config.stickerCommands || typeof config.stickerCommands !== 'object' || Array.isArray(config.stickerCommands)) config.stickerCommands = {}
    const key = sessionKey(conn)
    if (!config.stickerCommands[key] || typeof config.stickerCommands[key] !== 'object' || Array.isArray(config.stickerCommands[key])) config.stickerCommands[key] = {}
    return config.stickerCommands[key]
}

function setStickerCommand(sticker, command, conn) {
    const name = normalizeName(command)
    if (!name) return { ok: false, message: '❌ Provide a command after .stckcmd.' }
    if (!isRegisteredOrAlias(name, conn)) return { ok: false, message: `❌ The command *${name}* is not registered in DARKNOTE.` }
    const map = loadMap(conn)
    return fingerprintSticker(sticker).then((fingerprint) => {
        map[fingerprint] = name
        saveConfig()
        return { ok: true, command: name, fingerprint }
    })
}

async function lookupStickerCommand(m, conn) {
    const sticker = getStickerMessage(m)
    if (!sticker) return null
    try {
        const fingerprint = await fingerprintSticker(sticker)
        const map = loadMap(conn)
        const command = normalizeName(map[fingerprint])
        if (!command) return null
        const resolved = resolveCommand(command, conn)
        if (!resolved) return null
        return { command: resolved, fingerprint }
    } catch (error) {
        console.error('[STICKER CMD] fingerprint failed:', error?.stack || error)
        return null
    }
}

module.exports = { getStickerMessage, fingerprintSticker, setStickerCommand, lookupStickerCommand }
