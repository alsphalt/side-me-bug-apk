'use strict'

/* DARKNOTE protected media module.
 * Deliberately transformed: string literals are reconstructed at runtime and
 * command flow is dispatched through a compact state machine. This is source
 * protection, not cryptographic secrecy.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const sharp = require('sharp')
const { jidNormalizedUser, downloadContentFromMessage } = require('@whiskeysockets/baileys')
const { fileTypeFromBuffer } = require('file-type')
const { stickerToImage, stickerToVideo } = require('./StickerMaker.js')

const _s = (x) => Buffer.from(x, 'hex').toString('utf8')
const _k = Object.freeze({
  c: _s('636f6e766572'), p: _s('7070'), v: _s('7676'), w: _s('767632'),
  r: _s('7265706c79'), i: _s('696d616765'), o: _s('6f726967696e'),
  t: _s('74657874'), u: _s('75726c'), s: _s('737469636b6572'),
  m: _s('6d696d6574797065'), q: _s('71756f746564'), d: _s('646f63756d656e74'),
  y: _s('766964656f'), a: _s('617564696f'), e: _s('65787069726564')
})

const _clean = (v) => String(v || '').replace(/[^0-9]/g, '')
const _msg = (m) => {
  const q = m?.quoted
  if (!q) return null
  let x = q.msg || q.message || q
  for (let n = 0; n < 6 && x; n++) {
    if (x.imageMessage || x.videoMessage || x.audioMessage || x.documentMessage) return x
    if (x.viewOnceMessageV2?.message) { x = x.viewOnceMessageV2.message; continue }
    if (x.viewOnceMessage?.message) { x = x.viewOnceMessage.message; continue }
    if (x.ephemeralMessage?.message) { x = x.ephemeralMessage.message; continue }
    if (x.documentWithCaptionMessage?.message) { x = x.documentWithCaptionMessage.message; continue }
    break
  }
  if (q.mtype === 'imageMessage') return q.msg || q.message?.imageMessage || q
  if (q.mtype === 'videoMessage') return q.msg || q.message?.videoMessage || q
  if (q.mtype === 'stickerMessage') return q.msg || q.message?.stickerMessage || q
  return null
}

async function _buf(media, kind) {
  const stream = await downloadContentFromMessage(media, kind)
  const out = []
  for await (const c of stream) out.push(c)
  const b = Buffer.concat(out)
  if (!b.length) throw new Error(_s('4d6564696120646f776e6c6f61642072657475726e6564206e6f2064617461'))
  return b
}

async function setReaction(conn, m, text) {
  try {
    if (!m?.key || typeof conn?.sendMessage !== 'function') return false
    await conn.sendMessage(m.chat, { react: { text: String(text || ''), key: m.key } })
    return true
  } catch (error) {
    console.error('[CONVER] reaction failed:', error?.message || error)
    return false
  }
}

async function runConver(conn, m, reply) {
  const q = m?.quoted
  const sticker = q && (q.mtype === 'stickerMessage' || q.mimetype === 'image/webp' || q.msg?.mimetype === 'image/webp' || q.message?.stickerMessage)
  if (!sticker) return reply(`❌ Reply to a sticker with ${m?.prefix || '.'}conver.`)
  await setReaction(conn, m, '⏳')
  try {
    const media = q.msg || q.message?.stickerMessage || q
    const data = await _buf(media, 'sticker')
    let animated = media?.isAnimated === true
    if (!animated) {
      try { animated = Number((await sharp(data).metadata()).pages || 1) > 1 } catch {}
    }
    if (animated) {
      const video = await stickerToVideo(data)
      await conn.sendMessage(m.chat, { video, mimetype: 'video/mp4', caption: 'DARKNOTE • Animated sticker converted to video' }, { quoted: m })
    } else {
      const image = await stickerToImage(data)
      await conn.sendMessage(m.chat, { image, mimetype: 'image/png', caption: 'DARKNOTE • Sticker converted to image' }, { quoted: m })
    }
    await setReaction(conn, m, '')
  } catch (e) {
    console.error('[CONVER] conversion failed:', e?.stack || e)
    await setReaction(conn, m, '')
    return reply('❌ Failed to convert that sticker.')
  }
}

async function runPp(conn, m, reply) {
  const q = _msg(m)
  if (!q || (q.mtype !== 'imageMessage' && !q.imageMessage)) return reply(`❌ Reply to an image with ${m?.prefix || '.'}pp.`)
  let file = ''
  try {
    const data = await _buf(q.imageMessage || q, 'image')
    const tmp = path.join(__dirname, '..', 'tmp')
    await fs.promises.mkdir(tmp, { recursive: true })
    file = path.join(tmp, `pp-${crypto.randomBytes(8).toString('hex')}.jpg`)
    const out = await sharp(data).rotate().resize(640, 640, { fit: 'cover', position: 'centre' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()
    await fs.promises.writeFile(file, out)
    const self = jidNormalizedUser(conn.user?.id || '')
    if (!self || typeof conn.updateProfilePicture !== 'function') throw new Error('Profile picture update is unavailable')
    await conn.updateProfilePicture(self, { url: file })
    await reply('✅ DARKNOTE profile picture updated.')
  } catch (e) {
    console.error('[PP] profile update failed:', e?.stack || e)
    return reply('❌ Failed to update the profile picture.')
  } finally {
    if (file) { try { await fs.promises.rm(file, { force: true }) } catch {} }
  }
}

async function runVv(conn, m, command, reply) {
  const ctx = m.message?.extendedTextMessage?.contextInfo || m.msg?.contextInfo || {}
  let current = ctx.quotedMessage
  if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message
  else if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message
  else if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message
  const type = Object.keys(current || {}).find(k => /^(image|video|audio|document)Message$/.test(k))
  if (!type) {
    if (command === _k.w) return
    return reply(`❌ Reply to a view-once image, video, audio, or document.\n\nUsage: ${m?.prefix || '.'}${command}`)
  }
  try {
    const media = current[type]
    const stream = await downloadContentFromMessage(media, type.replace('Message', '').toLowerCase())
    const parts = []
    for await (const chunk of stream) parts.push(chunk)
    const data = Buffer.concat(parts)
    if (!data.length) throw new Error('View-once media is empty')
    const dest = command === _k.w ? jidNormalizedUser(conn.user?.id || '') : m.chat
    if (!dest) throw new Error('Destination is unavailable')
    const opt = command === _k.v ? { quoted: m } : undefined
    const map = {
      imageMessage: { image: data, caption: media.caption || undefined },
      videoMessage: { video: data, mimetype: media.mimetype || 'video/mp4', caption: media.caption || undefined },
      audioMessage: { audio: data, mimetype: media.mimetype || 'audio/mpeg', ptt: !!media.ptt },
      documentMessage: { document: data, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName || 'DARKNOTE-file' }
    }
    await conn.sendMessage(dest, map[type], opt)
  } catch (e) {
    console.error(`[${String(command).toUpperCase()}] error:`, e?.stack || e)
    if (command === _k.v) return reply('❌ Failed to retrieve that view-once message.')
  }
}

async function dispatchMedia(conn, m, command, reply) {
  const c = String(command || '').toLowerCase()
  let state = 0
  while (state !== 9) {
    switch (state) {
      case 0: state = c === _k.c ? 1 : c === _k.p ? 2 : (c === _k.v || c === _k.w) ? 3 : 9; break
      case 1: await runConver(conn, m, reply); state = 9; break
      case 2: await runPp(conn, m, reply); state = 9; break
      case 3: await runVv(conn, m, c, reply); state = 9; break
      default: state = 9
    }
  }
}

module.exports = { dispatchMedia }
