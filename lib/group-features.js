'use strict'

const fs = require('fs')
const path = require('path')

const DB_DIR = path.join(__dirname, '..', 'database')
const ACTIVITY_FILE = path.join(DB_DIR, 'group-activity.json')
const SELECTION_TTL = 10 * 60 * 1000

function ensureDb() {
  fs.mkdirSync(DB_DIR, { recursive: true })
  if (!fs.existsSync(ACTIVITY_FILE)) fs.writeFileSync(ACTIVITY_FILE, '{}')
}

function readDb() {
  ensureDb()
  try {
    const value = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writeDb(db) {
  ensureDb()
  const tmp = `${ACTIVITY_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2))
  fs.renameSync(tmp, ACTIVITY_FILE)
}

function dayKey(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function numberOf(jid = '') {
  return String(jid).split('@')[0].replace(/\D/g, '')
}

function normalize(jid = '') {
  return String(jid || '').split(':')[0].trim().toLowerCase()
}

function recordMessage(m) {
  if (!m?.isGroup || m?.fromMe || !m.sender || !m.chat) return
  const group = normalize(m.chat)
  const sender = normalize(m.sender)
  if (!group || !sender || !group.endsWith('@g.us')) return

  const db = readDb()
  const today = dayKey()
  if (!db[group]) db[group] = {}
  if (!db[group][today]) db[group][today] = {}
  db[group][today][sender] = Number(db[group][today][sender] || 0) + 1

  // Keep a small rolling window so the file never grows forever.
  const dates = Object.keys(db[group]).sort()
  for (const old of dates.slice(0, -8)) delete db[group][old]
  writeDb(db)
}

function getTodayActivity(groupJid) {
  const db = readDb()
  return db[normalize(groupJid)]?.[dayKey()] || {}
}

function getNumber(jid = '') { return numberOf(jid) }

function isOnlinePresence(value) {
  const p = String(value?.lastKnownPresence || value?.presence || value || '').toLowerCase()
  return p === 'available' || p === 'composing' || p === 'recording'
}

function cachePresence(conn, update) {
  if (!conn || !update?.id || !update?.presences) return
  if (!conn.__darknotePresence) conn.__darknotePresence = new Map()
  for (const [jid, value] of Object.entries(update.presences)) {
    conn.__darknotePresence.set(normalize(jid), {
      online: isOnlinePresence(value),
      presence: value?.lastKnownPresence || value?.presence || '',
      at: Date.now()
    })
  }
}

function getOnlineParticipants(conn, metadata) {
  const presence = conn?.__darknotePresence || new Map()
  return (metadata?.participants || []).filter(p => {
    const ids = [p?.id, p?.jid, p?.lid].filter(Boolean)
    return ids.some(id => presence.get(normalize(id))?.online)
  })
}

function getParticipantName(conn, participant) {
  const candidates = [participant?.notify, participant?.name, participant?.verifiedName, participant?.displayName]
  for (const value of candidates) {
    const name = String(value || '').replace(/[\r\n]+/g, ' ').trim()
    if (name) return name.slice(0, 45)
  }
  const ids = [participant?.id, participant?.jid, participant?.lid].filter(Boolean)
  for (const id of ids) {
    const key = normalize(id)
    const contact = conn?.contacts?.[key] || conn?.contacts?.[id]
    const name = String(contact?.notify || contact?.name || contact?.verifiedName || '').replace(/[\r\n]+/g, ' ').trim()
    if (name) return name.slice(0, 45)
  }
  return numberOf(participant?.id || participant?.jid || participant?.lid) || 'WhatsApp member'
}

function participantJid(participant) {
  return participant?.id || participant?.jid || participant?.lid || ''
}

function extractGroupInviteCode(value) {
  const raw = String(value || '').trim()
  const match = raw.match(/(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)
  return match?.[1] || null
}

function extractChannelInviteCode(value) {
  const raw = String(value || '').trim()
  const match = raw.match(/(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i)
  return match?.[1] || null
}

async function resolveGroupInvite(conn, link) {
  const code = extractGroupInviteCode(link)
  if (!code) return null
  if (typeof conn.groupGetInviteInfo !== 'function') throw new Error('This Baileys build does not expose group invite lookup.')
  const info = await conn.groupGetInviteInfo(code)
  const jid = info?.id || info?.jid
  if (!jid) throw new Error('WhatsApp did not return a group JID for that invite link.')
  return { jid, info }
}

async function resolveChannelLink(conn, link) {
  const code = extractChannelInviteCode(link)
  if (!code) return null

  // Different Baileys releases expose newsletter/channel lookup with slightly
  // different signatures. Try the documented forms without joining/following.
  if (typeof conn.newsletterMetadata === 'function') {
    const attempts = [
      () => conn.newsletterMetadata('invite', code),
      () => conn.newsletterMetadata('invite', { key: code }),
      () => conn.newsletterMetadata(code)
    ]
    for (const attempt of attempts) {
      try {
        const result = await attempt()
        const jid = result?.id || result?.jid || result?.newsletterJid
        if (jid) return { jid, info: result }
      } catch {}
    }
  }
  throw new Error('This Baileys build cannot resolve a channel invite link without joining it.')
}

const groupSelections = new Map()
function selectionKey(m) { return `${normalize(m?.sender)}:${normalize(m?.chat)}` }
function saveSelection(m, groups) {
  groupSelections.set(selectionKey(m), { createdAt: Date.now(), groups })
}
function getSelection(m) {
  const value = groupSelections.get(selectionKey(m))
  if (!value || Date.now() - value.createdAt > SELECTION_TTL) {
    groupSelections.delete(selectionKey(m))
    return null
  }
  return value.groups
}

module.exports = {
  dayKey,
  recordMessage,
  getTodayActivity,
  cachePresence,
  getOnlineParticipants,
  getParticipantName,
  participantJid,
  getNumber,
  extractGroupInviteCode,
  extractChannelInviteCode,
  resolveGroupInvite,
  resolveChannelLink,
  saveSelection,
  getSelection
}
