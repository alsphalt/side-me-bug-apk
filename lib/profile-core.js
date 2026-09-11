'use strict'

// Protected profile-picture helper. The command cases only dispatch here so
// the getpp/steal implementation is not kept inline in the main dispatcher.
const { jidNormalizedUser } = require('@whiskeysockets/baileys')

const cleanNumber = (v = '') => String(v).split('@')[0].replace(/\D/g, '')
const normalNumber = (v = '') => {
    let n = String(v).trim().replace(/\D/g, '')
    if (n.startsWith('00')) n = n.slice(2)
    if (/^0\d{9}$/.test(n)) n = `254${n.slice(1)}`
    return n
}

async function resolveTarget(conn, m, args = []) {
    let target = m?.quoted?.sender || m?.mentionedJid?.[0] || m?.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
    if (!target) {
        const n = normalNumber(args[0] || '')
        if (/^\d{8,15}$/.test(n)) target = `${n}@s.whatsapp.net`
    }
    if (!target) return null

    target = conn.decodeJid ? conn.decodeJid(target) : target
    if (target?.endsWith('@lid') && typeof conn.resolveLidEnhanced === 'function') {
        const resolved = await conn.resolveLidEnhanced(target)
        if (resolved && !resolved.endsWith('@lid')) target = resolved
    }
    return jidNormalizedUser(target)
}

async function withTimeout(promise, ms = 12000) {
    let timer
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Profile picture request timed out')), ms) })
        ])
    } finally {
        clearTimeout(timer)
    }
}

async function runProfileCommand(conn, m, command, args, reply, getNumber) {
    const target = await resolveTarget(conn, m, args)
    if (!target) {
        if (command === 'steal') return
        return reply(`❌ Reply to or mention the target.\n\nUsage: ${(require('../config.json').prefix || '.')}${command} @user`)
    }

    const url = await withTimeout(conn.profilePictureUrl(target, 'image').catch(() => null))
    if (!url) {
        if (command === 'steal') return
        return reply('❌ No accessible profile picture was found.')
    }

    const number = cleanNumber(getNumber(target))
    const self = jidNormalizedUser(conn.user?.id || '')
    if (!self) throw new Error('Paired WhatsApp account is unavailable')

    if (command === 'steal') {
        await conn.sendMessage(self, {
            image: { url },
            caption: `DARKNOTE • Profile Picture${number ? `\n+${number}` : ''}`
        })
    } else {
        await conn.sendMessage(m.chat, {
            image: { url },
            caption: number ? `Profile picture • +${number}` : 'Profile picture'
        }, { quoted: m })
    }
}

module.exports = { runProfileCommand }
