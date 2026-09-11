'use strict'

/* DARKNOTE Antidelete integration.
 * Uses one in-memory retention cache per WhatsApp connection/session. Settings
 * are persisted in the existing config.json, keyed by the paired account.
 * Content is retained only after the bot actually receives it and only while
 * an antidelete mode is enabled for that session.
 */
const fs = require('fs')
const path = require('path')
const { downloadContentFromMessage, jidNormalizedUser } = require('@whiskeysockets/baileys')

const CONFIG_PATH = path.join(__dirname, '..', 'config.json')
const config = require(CONFIG_PATH)
const TTL = 24 * 60 * 60 * 1000
const MAX = 500

function sessionKey(conn) {
  // A JID looks like 254107287140:10@s.whatsapp.net. The `:10` device suffix
  // changes on every re-link, and stripping only non-digits kept it, so the
  // stored settings keyed on "25410728714010" instead of the number itself.
  // Any re-pair then silently orphaned the antidelete flags. Strip the device
  // suffix before removing separators so the key is stable.
  const n = String(conn?.user?.id || '').split('@')[0].split(':')[0].replace(/\D/g, '')
  return n || 'unpaired'
}

function normalizeNumber(value) {
  let n = String(value || '').trim().replace(/\D/g, '')
  if (n.startsWith('00')) n = n.slice(2)
  if (/^0\d{9}$/.test(n)) n = `254${n.slice(1)}`
  return n
}

function sessionSettings(conn) {
  if (!config.sessionSettings || typeof config.sessionSettings !== 'object' || Array.isArray(config.sessionSettings)) config.sessionSettings = {}
  const key = sessionKey(conn)
  if (!config.sessionSettings[key] || typeof config.sessionSettings[key] !== 'object' || Array.isArray(config.sessionSettings[key])) {
    config.sessionSettings[key] = { antidelete: false, antidelete2: false, antidelete3: '' }
  }
  return config.sessionSettings[key]
}

function saveConfig() {
  const tmp = `${CONFIG_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
  fs.renameSync(tmp, CONFIG_PATH)
}

function getSettings(conn) {
  const s = sessionSettings(conn)
  return { antidelete: !!s.antidelete, antidelete2: !!s.antidelete2, antidelete3: normalizeNumber(s.antidelete3) }
}

function configure(conn, mode, value) {
  const s = sessionSettings(conn)
  if (mode === 'antidelete') {
    s.antidelete = value === true
  } else if (mode === 'antidelete2') {
    s.antidelete2 = value === true
  } else if (mode === 'antidelete3') {
    const n = normalizeNumber(value)
    if (!/^\d{8,15}$/.test(n)) return { ok: false, code: 'invalid' }
    const self = normalizeNumber(conn?.user?.id)
    if (self && n === self) return { ok: false, code: 'self' }
    s.antidelete3 = n
  }
  saveConfig()
  return { ok: true, settings: getSettings(conn) }
}

function disable3(conn) {
  const s = sessionSettings(conn)
  s.antidelete3 = ''
  saveConfig()
  return getSettings(conn)
}

function cacheFor(conn) {
  if (!conn.__darknoteAntideleteCache) conn.__darknoteAntideleteCache = new Map()
  return conn.__darknoteAntideleteCache
}

function unwrapMessage(message) {
  let current = message
  for (let i = 0; i < 8 && current; i++) {
    if (current.viewOnceMessageV2?.message) { current = current.viewOnceMessageV2.message; continue }
    if (current.viewOnceMessage?.message) { current = current.viewOnceMessage.message; continue }
    if (current.ephemeralMessage?.message) { current = current.ephemeralMessage.message; continue }
    if (current.documentWithCaptionMessage?.message) { current = current.documentWithCaptionMessage.message; continue }
    return current
  }
  return current
}

function pickContent(message) {
  const x = unwrapMessage(message)
  if (!x || typeof x !== 'object') return null
  const type = Object.keys(x).find(k => /Message$/.test(k) || k === 'conversation' || k === 'extendedTextMessage')
  if (!type) return null
  if (type === 'conversation') return { type: 'text', source: x.conversation || '' }
  if (type === 'extendedTextMessage') return { type: 'text', source: x.extendedTextMessage?.text || '' }
  const media = x[type]
  if (!media) return null
  if (type === 'imageMessage') return { type, source: media, mediaType: 'image' }
  if (type === 'videoMessage') return { type, source: media, mediaType: 'video' }
  if (type === 'audioMessage') return { type, source: media, mediaType: 'audio' }
  if (type === 'documentMessage') return { type, source: media, mediaType: 'document' }
  if (type === 'stickerMessage') return { type, source: media, mediaType: 'sticker' }
  return null
}

async function downloadMedia(media, type) {
  const stream = await downloadContentFromMessage(media, type)
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const buffer = Buffer.concat(chunks)
  if (!buffer.length) throw new Error('retained media download returned no data')
  return buffer
}

function mediaTypeForMessage(type) {
  return type.replace(/Message$/, '').toLowerCase()
}

async function captureMessage(conn, message) {
  const settings = getSettings(conn)
  if (!settings.antidelete && !settings.antidelete2 && !settings.antidelete3) return
  if (!message?.key?.id || message.key.remoteJid === 'status@broadcast') return

  const cache = cacheFor(conn)
  const key = `${String(message.key.remoteJid || '')}:${String(message.key.id || '')}`
  const picked = pickContent(message.message)
  if (!picked) return

  const entry = {
    key: message.key,
    chat: String(message.key.remoteJid || ''),
    sender: String(message.key.participant || message.key.remoteJid || ''),
    timestamp: Date.now(),
    type: picked.type,
    text: picked.type === 'text' ? String(picked.source || '') : '',
    raw: message.message,
    media: null,
    mediaMeta: null
  }

  if (picked.mediaType) {
    try {
      entry.media = await downloadMedia(picked.source, mediaTypeForMessage(picked.type))
      entry.mediaMeta = {
        mimetype: picked.source.mimetype,
        fileName: picked.source.fileName,
        caption: picked.source.caption,
        ptt: picked.source.ptt
      }
    } catch (error) {
      // Keep the raw received payload. A later delete event can still use
      // WhatsApp's retained message representation if it remains available.
      console.error('[ANTIDELETE] media retention failed:', error?.message || error)
    }
  }

  cache.set(key, entry)
  while (cache.size > MAX) cache.delete(cache.keys().next().value)
  cleanupCache(conn)
}

function cleanupCache(conn) {
  const cache = cacheFor(conn)
  const cutoff = Date.now() - TTL
  for (const [key, entry] of cache) if (!entry || entry.timestamp < cutoff) cache.delete(key)
}

function findEntry(conn, key) {
  const cache = cacheFor(conn)
  cleanupCache(conn)
  const id = String(key?.id || '')
  const chat = String(key?.remoteJid || '')
  return cache.get(`${chat}:${id}`) || null
}

function normalizedTarget(value) {
  const n = normalizeNumber(value)
  return /^\d{8,15}$/.test(n) ? `${n}@s.whatsapp.net` : ''
}

function isDeletedUpdate(update) {
  if (!update) return false
  const stub = update.messageStubType ?? update.update?.messageStubType
  if (stub === 68 || String(stub || '').toUpperCase() === 'REVOKE') return true
  if (update.update?.protocolMessage?.type === 0 || String(update.update?.protocolMessage?.type || '').toUpperCase() === 'REVOKE') return true
  if (update.update?.message === null && (stub || update.update?.status === 'deleted')) return true
  return false
}

function deletionKeys(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload.flatMap(x => deletionKeys(x))
  if (Array.isArray(payload.keys)) return payload.keys.filter(Boolean)
  if (payload.key) return [payload.key]
  if (payload.update?.key) return [payload.update.key]
  if (payload.update?.protocolMessage?.key) return [payload.update.protocolMessage.key]
  if (payload.message?.protocolMessage?.key) return [payload.message.protocolMessage.key]
  return []
}

function makeSendPayload(entry) {
  if (entry.type === 'text') return { text: entry.text }
  const meta = entry.mediaMeta || {}
  if (!entry.media) return null
  if (entry.type === 'imageMessage') return { image: entry.media, mimetype: meta.mimetype || 'image/jpeg', caption: meta.caption || undefined }
  if (entry.type === 'videoMessage') return { video: entry.media, mimetype: meta.mimetype || 'video/mp4', caption: meta.caption || undefined }
  if (entry.type === 'audioMessage') return { audio: entry.media, mimetype: meta.mimetype || 'audio/mpeg', ptt: !!meta.ptt }
  if (entry.type === 'documentMessage') return { document: entry.media, mimetype: meta.mimetype || 'application/octet-stream', fileName: meta.fileName || 'DARKNOTE-file' }
  if (entry.type === 'stickerMessage') return { sticker: entry.media }
  return null
}

async function sendRecovered(conn, dest, entry, forward) {
  if (!dest) throw new Error('invalid antidelete destination')

  if (forward && typeof conn.copyNForward === 'function' && entry.raw) {
    try {
      await conn.copyNForward(dest, { key: entry.key, message: entry.raw }, true)
      return
    } catch (error) {
      console.error('[ANTIDELETE] native forward unavailable, sending retained content:', error?.message || error)
    }
  }

  const payload = makeSendPayload(entry)
  if (!payload) throw new Error('retained content is unavailable')
  // The fallback copy is marked forwarded too, so relayed content is visibly a
  // forward even when this build cannot use copyNForward.
  await conn.sendMessage(dest, payload, { contextInfo: { isForwarded: true, forwardingScore: 1 } })
}

async function handleDeletion(conn, key) {
  const dedupe = conn.__darknoteAntideleteDeleted || (conn.__darknoteAntideleteDeleted = new Map())
  const dedupeKey = `${String(key?.remoteJid || '')}:${String(key?.id || '')}`
  if (dedupe.has(dedupeKey)) return false
  dedupe.set(dedupeKey, Date.now())
  for (const [k, t] of dedupe) if (Date.now() - t > 10 * 60 * 1000) dedupe.delete(k)
  const settings = getSettings(conn)
  if (!settings.antidelete && !settings.antidelete2 && !settings.antidelete3) return false
  const entry = findEntry(conn, key)
  if (!entry) {
    console.log('[ANTIDELETE] deleted message was not retained; recovery skipped')
    return false
  }

  // Opt-in: when antideleteSkipOwner is true, deletions performed by the paired
  // account itself are ignored, so antidelete only reports what OTHER people
  // deleted, in both direct chats and groups. Default is false so the owner can
  // test the feature by deleting their own message.
  // `key.fromMe` is the reliable signal here: for the owner's own outgoing DM the
  // stored `sender` resolves to the OTHER party, not to the owner.
  if (config.antideleteSkipOwner === true) {
    const self = normalizeNumber(conn?.user?.id)
    const sender = normalizeNumber(entry.sender)
    if (entry.key?.fromMe === true || (self && sender && self === sender)) {
      console.log('[ANTIDELETE] skipped: the deleted message was sent by the paired account')
      return false
    }
  }

  // The modes are independent. antidelete reposts into the chat where the
  // deletion happened; antidelete2 forwards a copy to the paired number's own
  // chat; antidelete3 forwards to a configured number. The old else-if chain
  // meant turning antidelete on silently disabled antidelete2.
  const deliveries = []
  if (settings.antidelete) deliveries.push({ dest: entry.chat, mode: 'normal' })
  if (settings.antidelete2) deliveries.push({ dest: jidNormalizedUser(conn.user?.id || ''), mode: 'silent-self' })
  if (settings.antidelete3) deliveries.push({ dest: normalizedTarget(settings.antidelete3), mode: 'silent-custom' })
  const usable = deliveries.filter(delivery => Boolean(delivery.dest))
  if (!usable.length) return false

  let delivered = false
  for (const delivery of usable) {
    // Every antidelete response is forwarded, so the recipient can see it is a
    // relayed copy of somebody else's message rather than the bot's own words.
    try {
      await sendRecovered(conn, delivery.dest, entry, true)
      console.log(`[ANTIDELETE] ${delivery.mode} delivered`)
      delivered = true
    } catch (error) {
      console.error(`[ANTIDELETE] ${delivery.mode} delivery failed:`, error?.stack || error)
    }
  }
  return delivered
}

async function handleIncomingProtocolDeletion(conn, message) {
  const protocol = message?.message?.protocolMessage
  if (!protocol) return false

  // WhatsApp revoke packets can arrive as a protocolMessage inside the
  // existing messages.upsert pipeline on some Baileys forks. Do not depend
  // exclusively on messages.update/messages.delete for those builds.
  const type = protocol.type
  const isRevoke = type === 0 || type === 'REVOKE' || String(type).toUpperCase() === 'REVOKE'
  if (!isRevoke) return false

  const key = protocol.key
  if (!key?.id || !key?.remoteJid) return false
  return handleDeletion(conn, key)
}

function bindDeleteEvents(conn) {
  if (conn.__darknoteAntideleteBound) return
  conn.__darknoteAntideleteBound = true

  if (conn.ev?.on) {
    conn.ev.on('messages.delete', async payload => {
      try {
        for (const key of deletionKeys(payload)) await handleDeletion(conn, key)
      } catch (error) {
        console.error('[ANTIDELETE] delete-event error:', error?.stack || error)
      }
    })

    conn.ev.on('messages.update', async updates => {
      try {
        const list = Array.isArray(updates) ? updates : [updates]
        for (const update of list) {
          if (!isDeletedUpdate(update)) continue
          const keys = deletionKeys(update)
          for (const key of keys) await handleDeletion(conn, key)
        }
      } catch (error) {
        console.error('[ANTIDELETE] update-event error:', error?.stack || error)
      }
    })
  }
}

module.exports = {
  sessionKey,
  getSettings,
  configure,
  disable3,
  captureMessage,
  handleIncomingProtocolDeletion,
  bindDeleteEvents,
  handleDeletion,
  normalizeNumber
}
