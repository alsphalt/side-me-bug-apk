'use strict'

/*
 * DARKNOTE L2 LICENSE
 * Owner configuration commands: .setprefix and .setgcpp
 * © DARKNOTE L2 • Bigbrother
 *
 * Both handlers take the live `config` object from BIGBRO.js and persist
 * changes to the same config.json the rest of the project already uses, so a
 * change applies immediately without a restart and survives one.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const sharp = require('sharp')
const { jidNormalizedUser } = require('@whiskeysockets/baileys')

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')
const MAX_PREFIX_CHARS = 3
// These would collide with the dispatcher's own $ shell and ]> eval shortcuts,
// which are matched before the configurable prefix.
const RESERVED_PREFIXES = new Set(['$', ']'])

function saveConfig(config) {
    const tmp = `${CONFIG_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fs.renameSync(tmp, CONFIG_PATH)
}

function number(value) {
    return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

function sameUser(a, b) {
    if (!a || !b) return false
    const left = jidNormalizedUser(String(a))
    const right = jidNormalizedUser(String(b))
    return left === right || (number(a) && number(a) === number(b))
}

const ADMIN_ROLES = new Set(['admin', 'superadmin', 'administrator'])

function participantOf(metadata, jid) {
    return (metadata?.participants || []).find(p =>
        [p?.id, p?.jid, p?.lid].filter(Boolean).some(id => sameUser(id, jid)))
}

function isGroupAdmin(metadata, jid) {
    const participant = participantOf(metadata, jid)
    if (!participant) return false
    return ADMIN_ROLES.has(String(participant.admin || participant.role || '').toLowerCase()) || participant.isAdmin === true
}

/* ------------------------------ .setprefix ------------------------------ */

function setPrefix(conn, m, args, reply, isOwner, config) {
    const current = String(config?.prefix || '.')

    if (!isOwner(m)) {
        reply('❌ Owner only.')
        return { ok: false, code: 'NOT_OWNER' }
    }

    const raw = (Array.isArray(args) ? args.join(' ') : String(args || '')).trim()

    if (!raw) {
        reply([
            `Current prefix: ${current}`,
            '',
            `Usage: ${current}setprefix <symbol>`,
            `Example: ${current}setprefix !`,
            '',
            `Up to ${MAX_PREFIX_CHARS} characters, no spaces.`
        ].join('\n'))
        return { ok: false, code: 'NO_INPUT', prefix: current }
    }

    if (/\s/.test(raw)) {
        reply('❌ The prefix cannot contain spaces.')
        return { ok: false, code: 'INVALID_HAS_SPACE' }
    }
    if ([...raw].length > MAX_PREFIX_CHARS) {
        reply(`❌ The prefix can be at most ${MAX_PREFIX_CHARS} characters long.`)
        return { ok: false, code: 'INVALID_TOO_LONG' }
    }
    if (RESERVED_PREFIXES.has(raw)) {
        reply(`❌ "${raw}" is reserved by the bot's built-in ${raw === '$' ? 'shell' : 'eval'} shortcut. Choose another prefix.`)
        return { ok: false, code: 'INVALID_RESERVED' }
    }
    if (raw === current) {
        reply(`ℹ️ The prefix is already ${current}`)
        return { ok: false, code: 'UNCHANGED', prefix: current }
    }

    config.prefix = raw
    try {
        saveConfig(config)
    } catch (error) {
        console.error('[SETPREFIX] could not persist the prefix:', error?.stack || error)
        config.prefix = current
        reply('❌ Could not save the new prefix. Please try again.')
        return { ok: false, code: 'SAVE_FAILED', reason: error?.message || String(error) }
    }

    const warning = /[a-z0-9]/i.test(raw)
        ? `\n\n⚠️ "${raw}" is alphanumeric, so any message starting with it will be treated as a command.`
        : ''
    reply(`✅ Prefix changed: ${current} → ${raw}${warning}`)
    return { ok: true, code: 'CHANGED', previous: current, prefix: raw }
}

/* ------------------------------- .setgcpp ------------------------------- */

/** True for an image, including a document sent with an image mimetype. */
function isImageLike(node) {
    if (!node || typeof node !== 'object') return false
    if (node.imageMessage) return true
    const type = String(node.mtype || '').toLowerCase()
    if (type === 'imagemessage') return true
    // A document whose mimetype is an image still needs to work here: some
    // clients send pictures as documents to avoid compression.
    return type === 'documentmessage' && /^image\//i.test(String(node.mimetype || node.mimeType || ''))
}

/**
 * Unwrap a quoted (or attached) image, including view-once, ephemeral and
 * document wrappers.
 *
 * THE BUG THIS FIXES: smsg() assigns `m.quoted = m.quoted[type]`, i.e. the
 * INNER content. So for a reply to an image, `m.quoted` IS the imageMessage
 * itself and there is no nested `m.quoted.imageMessage`. The previous version
 * only looked for a nested one and then fell back to `m.quoted.msg` /
 * `m.quoted.message`, neither of which smsg ever sets, so it always returned
 * null and .setgcpp reported "reply to an image" even when the user had.
 */
function resolveImageMessage(m) {
    // 1. Replying to an image. m.quoted is the image content itself.
    if (m?.quoted) {
        if (m.quoted.imageMessage) return m.quoted.imageMessage
        if (isImageLike(m.quoted)) return m.quoted
    }

    // 2. Sending an image with the command as its caption. m.msg is the content.
    if (m?.msg && typeof m.msg === 'object' && m.msg.imageMessage) return m.msg.imageMessage
    if (m?.msg && isImageLike({ ...m.msg, mtype: m?.mtype })) return m.msg
    if (m?.message?.imageMessage) return m.message.imageMessage

    // 3. Walk the raw tree, unwrapping view-once / ephemeral / with-caption.
    const roots = [m?.message, m?.quoted?.message, m?.msg?.message]
    for (const root of roots) {
        let node = root
        for (let depth = 0; depth < 5 && node; depth++) {
            if (node.imageMessage) return node.imageMessage
            if (node.viewOnceMessageV2?.message) { node = node.viewOnceMessageV2.message; continue }
            if (node.viewOnceMessage?.message) { node = node.viewOnceMessage.message; continue }
            if (node.ephemeralMessage?.message) { node = node.ephemeralMessage.message; continue }
            if (node.documentWithCaptionMessage?.message) { node = node.documentWithCaptionMessage.message; continue }
            if (node.documentMessage && /^image\//i.test(String(node.documentMessage.mimetype || ''))) return node.documentMessage
            break
        }
    }
    return null
}

/**
 * Download the resolved image from whichever source it actually came from.
 *
 * The resolved node tells us: if it IS m.quoted, the picture is the quoted
 * media; if it is m.msg, the picture belongs to the message being sent. The old
 * version always tried the quoted download first, so replying to an unrelated
 * message while sending an image as a caption would fetch the wrong media.
 */
async function downloadImage(m, imageMessage) {
    const fromOwnMessage = imageMessage
        && (imageMessage === m?.msg
            || imageMessage === m?.message?.imageMessage
            || imageMessage === m?.msg?.imageMessage)

    const attempts = []
    if (fromOwnMessage) {
        if (typeof m?.download === 'function') attempts.push(() => m.download())
        if (m?.quoted && typeof m.quoted.download === 'function') attempts.push(() => m.quoted.download())
    } else {
        if (m?.quoted && typeof m.quoted.download === 'function') attempts.push(() => m.quoted.download())
        if (typeof m?.download === 'function') attempts.push(() => m.download())
    }

    for (const attempt of attempts) {
        try {
            const buffer = await attempt()
            if (Buffer.isBuffer(buffer) && buffer.length) return buffer
        } catch (error) {
            console.error('[SETGCPP] a download source failed, trying the next:', error?.message || error)
        }
    }

    // Last resort: the shared Baileys downloader, for unwrapped view-once media.
    const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
    const stream = await downloadContentFromMessage(imageMessage, 'image')
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    if (!buffer.length) throw new Error('The image download returned no data')
    return buffer
}

async function setGroupPhoto(conn, m, args, reply, isOwner, config) {
    if (!m?.isGroup) {
        reply('❌ This command can only be used in a group.')
        return { ok: false, code: 'NOT_GROUP' }
    }

    const prefix = String(config?.prefix || '.')
    const imageMessage = resolveImageMessage(m)
    if (!imageMessage) {
        reply(`❌ Reply to an image with ${prefix}setgcpp, or send an image with ${prefix}setgcpp as its caption.`)
        return { ok: false, code: 'NO_IMAGE' }
    }

    let metadata
    try {
        metadata = await conn.groupMetadata(m.chat)
    } catch (error) {
        console.error('[SETGCPP] could not read the group:', error?.stack || error)
        reply('❌ Unable to read this group.')
        return { ok: false, code: 'METADATA_FAILED', reason: error?.message || String(error) }
    }

    const senderIsAdmin = isGroupAdmin(metadata, m.sender)
    if (!isOwner(m) && !senderIsAdmin) {
        reply('❌ Only group admins (or the bot owner) can change the group photo.')
        return { ok: false, code: 'NOT_PERMITTED' }
    }
    if (!isGroupAdmin(metadata, conn.user?.id || '')) {
        reply('❌ DARKNOTE must be a group admin to change the group photo.')
        return { ok: false, code: 'BOT_NOT_ADMIN' }
    }
    if (typeof conn.updateProfilePicture !== 'function') {
        reply('❌ This Baileys build does not expose the group photo API.')
        return { ok: false, code: 'API_UNAVAILABLE' }
    }

    let file = ''
    try {
        const buffer = await downloadImage(m, imageMessage)
        if (!buffer?.length) throw new Error('The image is empty')

        const tmpDir = path.join(__dirname, '..', 'tmp')
        await fs.promises.mkdir(tmpDir, { recursive: true })
        file = path.join(tmpDir, `gcpp-${crypto.randomBytes(8).toString('hex')}.jpg`)

        const processed = await sharp(buffer)
            .rotate()
            .resize(640, 640, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
            .toBuffer()
        await fs.promises.writeFile(file, processed)

        await conn.updateProfilePicture(m.chat, { url: file })
        reply('✅ Group photo updated.')
        return { ok: true, code: 'UPDATED' }
    } catch (error) {
        console.error('[SETGCPP] failed:', error?.stack || error)
        const reason = String(error?.message || error || 'unknown error')
        reply(`❌ Failed to update the group photo.\n\n${reason.slice(0, 200)}`)
        return { ok: false, code: 'FAILED', reason }
    } finally {
        if (file) {
            try { await fs.promises.rm(file, { force: true }) } catch { }
        }
    }
}

module.exports = { setPrefix, setGroupPhoto, resolveImageMessage, isImageLike, CONFIG_PATH, MAX_PREFIX_CHARS }
