'use strict'

const fs = require('fs')
const path = require('path')

const DB_DIR = path.join(__dirname, '..', 'database')
const ACTIVITY_FILE = path.join(DB_DIR, 'group-activity.json')
const SELECTION_TTL = 10 * 60 * 1000

/*
 * Presence collection. An update counts as current for 5 minutes, and the
 * subscription burst is capped and paced so a large group is not fired at the
 * server all at once.
 */
const PRESENCE_WAIT_MS = 3500
const PRESENCE_FRESH_MS = 5 * 60 * 1000
const PRESENCE_SUBSCRIBE_CAP = 80
const PRESENCE_SUBSCRIBE_GAP_MS = 25

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

/** Most recent cached presence entry for a participant, across its JID forms. */
function presenceEntryFor(presence, participant) {
  const ids = [participant?.id, participant?.jid, participant?.lid]
    .filter(Boolean)
    .map(normalize)
    .filter(Boolean)
  const entries = ids.map(id => presence.get(id)).filter(Boolean)
  if (!entries.length) return null
  return entries.sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0]
}

/*
 * Collect presence for a group's participants.
 *
 * WHY THIS EXISTS
 * ---------------
 * getOnlineParticipants() above only reads conn.__darknotePresence, and that
 * cache is filled exclusively by the presence.update event. WhatsApp sends
 * presence.update ONLY for JIDs the client has subscribed to with
 * conn.presenceSubscribe(). This bot subscribed in exactly one place - the
 * /state lookup in lib/user-info.js, for a single person - and never for group
 * members. So the cache was permanently empty and .listonline could only ever
 * answer "No group participants are currently detected as online".
 *
 * Nobody was offline. The bot had simply never asked, which is why "the cache
 * is stale" and "refresh the bot's permissions" are both the wrong diagnosis:
 * there is no stale data to refresh and no permission to grant - only a missing
 * subscription call.
 *
 * The shape mirrors lib/user-info.js resolvePresence: subscribe, wait, read,
 * then report WHICH of those actually happened (the `source`). That is what lets
 * a genuine "everyone reported offline" be told apart from "no update ever
 * arrived" - the difference between a real result and a silent failure.
 */
async function collectPresence(conn, metadata, options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs ?? PRESENCE_WAIT_MS))
  const cap = Math.max(1, Number(options.cap ?? PRESENCE_SUBSCRIBE_CAP))
  const gapMs = Math.max(0, Number(options.gapMs ?? PRESENCE_SUBSCRIBE_GAP_MS))

  const participants = Array.isArray(metadata?.participants) ? metadata.participants : []

  if (typeof conn?.presenceSubscribe !== 'function') {
    return { online: [], offline: [], requested: 0, refused: 0, fresh: 0, capped: false, source: 'unsupported' }
  }

  // Deduplicate by normalised JID so one person is subscribed once, even when a
  // participant carries both a phone JID and a LID.
  const targets = []
  const seen = new Set()
  for (const participant of participants) {
    for (const jid of [participant?.id, participant?.jid, participant?.lid]) {
      const key = normalize(jid)
      if (!key || seen.has(key)) continue
      seen.add(key)
      targets.push(key)
    }
  }

  const subscribeTo = targets.slice(0, cap)
  let refused = 0
  for (const jid of subscribeTo) {
    try {
      await conn.presenceSubscribe(jid)
    } catch (error) {
      refused += 1
      // One line is enough: a refusal is usually systematic, and logging every
      // member of a large group would bury the rest of the console.
      if (refused === 1) console.error('[PRESENCE] presenceSubscribe refused:', error?.message || error)
    }
    // Paced, so a 200-member group is not fired at the server in one burst.
    if (gapMs) await new Promise(resolve => setTimeout(resolve, gapMs))
  }

  // Give the server a moment to push updates before reading the cache.
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs))

  const presence = conn?.__darknotePresence || new Map()
  const online = []
  const offline = []
  let fresh = 0
  for (const participant of participants) {
    const entry = presenceEntryFor(presence, participant)
    if (!entry) continue
    if (Date.now() - Number(entry.at || 0) <= PRESENCE_FRESH_MS) fresh += 1
    if (entry.online) online.push(participant)
    else offline.push(participant)
  }

  /*
   * `source` is the honest summary:
   *   unsupported     - this build exposes no presenceSubscribe at all
   *   subscribe-failed- WhatsApp refused every subscription we attempted
   *   live            - at least one FRESH update arrived
   *   stale           - updates exist, but none of them is recent
   *   no-presence     - nothing arrived for anyone
   */
  let source = 'no-presence'
  if (subscribeTo.length && refused === subscribeTo.length) source = 'subscribe-failed'
  else if (fresh) source = 'live'
  else if (online.length || offline.length) source = 'stale'

  return {
    online,
    offline,
    requested: subscribeTo.length,
    refused,
    fresh,
    capped: targets.length > subscribeTo.length,
    source
  }
}

/**
 * A SPECIFIC explanation for an empty online list.
 *
 * "No group participants are currently detected as online" reads as "everyone is
 * offline", which is usually untrue and hides the real problem. Each source gets
 * its own sentence so the operator can tell a real empty result from a silent
 * failure.
 */
function describeEmptyPresence(result = {}) {
  const requested = Number(result.requested || 0)
  switch (result.source) {
    case 'unsupported':
      return '❌ This Baileys build does not expose presenceSubscribe, so member presence cannot be requested at all.'
    case 'subscribe-failed':
      return `❌ WhatsApp refused every presence subscription (${result.refused}/${requested}). Nothing can be listed until it accepts one.`
    case 'no-presence':
      return `ℹ️ Presence was requested for ${requested} participant entr${requested === 1 ? 'y' : 'ies'} and WhatsApp sent no update for anyone.\n\nThis is not the same as everyone being offline — most accounts do not broadcast presence.`
    case 'stale':
      return `ℹ️ Presence updates exist for this group but none is recent (older than ${Math.round(PRESENCE_FRESH_MS / 60000)} minutes), so nobody can be confirmed online right now.`
    default:
      return 'ℹ️ Presence was received for this group and every member who reported is currently offline.'
  }
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
  collectPresence,
  describeEmptyPresence,
  presenceEntryFor,
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
