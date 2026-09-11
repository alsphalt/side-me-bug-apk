'use strict'

/*
 * DARKNOTE AI — conversation state.
 *
 * One record per JID, persisted so it survives a restart. This is the layer that
 * lets the bot behave like it is following a conversation rather than answering
 * isolated messages: it knows what it said last, when, whether a reply is still
 * pending, what the topic is, what mood the person is in, and which provider
 * answered last.
 *
 * Keyed by JID so one person's state can never be read by another. The key also
 * records its own scope so a group and a DM with the same participant number can
 * never collide.
 */

const fs = require('fs')
const path = require('path')

const STORE_PATH = path.join(__dirname, '..', 'database', 'ai-state.json')
const MAX_RECORDS = 1200
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const PROVIDER_HISTORY_MAX = 8

let cache = null
let writeTimer = null

function load() {
    if (cache) return cache
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
        cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
        cache = {}
    }
    return cache
}

function flush() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
    try {
        const store = load()
        // Bound the store, dropping the least recently touched records.
        const entries = Object.entries(store)
        if (entries.length > MAX_RECORDS) {
            entries.sort((a, b) => (Number(b[1]?.touchedAt) || 0) - (Number(a[1]?.touchedAt) || 0))
            cache = Object.fromEntries(entries.slice(0, MAX_RECORDS))
        }
        const dir = path.dirname(STORE_PATH)
        fs.mkdirSync(dir, { recursive: true })
        const tmp = `${STORE_PATH}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2))
        fs.renameSync(tmp, STORE_PATH)
    } catch (error) {
        console.error('[AI-STATE] could not persist:', error?.message || error)
    }
}

function save() {
    if (writeTimer) return
    // Debounced: a burst of messages must not cause a burst of disk writes.
    writeTimer = setTimeout(() => { writeTimer = null; flush() }, 1500)
    if (typeof writeTimer.unref === 'function') writeTimer.unref()
}

function emptyRecord(key, scope) {
    return {
        key,
        scope,
        touchedAt: Date.now(),
        createdAt: Date.now(),
        // conversation
        lastUserText: '',
        lastUserAt: 0,
        lastAiText: '',
        lastAiAt: 0,
        lastProvider: '',
        providerHistory: [],
        // pending / silence
        pendingSince: 0,
        followUpSentAt: 0,
        followUpCount: 0,
        silenceNoticed: false,
        // understanding
        topic: '',
        language: '',
        vibe: '',
        turnCount: 0,
        // safety
        abuseCount: 0,
        lastWarnAt: 0,
        blocked: false,
        lastTimerId: ''
    }
}

function keyFor(m) {
    const chat = String(m?.chat || m?.key?.remoteJid || '')
    if (!chat) return ''
    if (chat.endsWith('@g.us') || m?.isGroup) return `group:${chat}`
    if (chat === 'status@broadcast') return ''
    return `dm:${chat}`
}

function scopeFor(key) {
    if (key.startsWith('group:')) return 'group'
    return 'dm'
}

function get(key) {
    if (!key) return emptyRecord('', 'dm')
    const store = load()
    const found = store[key]
    if (!found || typeof found !== 'object' || Array.isArray(found)) return emptyRecord(key, scopeFor(key))
    if (found.touchedAt && Date.now() - found.touchedAt > TTL_MS) return emptyRecord(key, scopeFor(key))
    return { ...emptyRecord(key, scopeFor(key)), ...found, key, scope: scopeFor(key) }
}

function put(record) {
    if (!record?.key) return null
    const store = load()
    record.touchedAt = Date.now()
    if (Array.isArray(record.providerHistory)) record.providerHistory = record.providerHistory.slice(-PROVIDER_HISTORY_MAX)
    store[record.key] = record
    save()
    return record
}

function update(key, patch) {
    const record = { ...get(key), ...patch, key }
    return put(record)
}

/** Record an incoming user message. */
function noteUser(m, text, { language = '', vibe = '' } = {}) {
    const key = keyFor(m)
    if (!key) return null
    const record = get(key)
    record.lastUserText = String(text || '').slice(0, 500)
    record.lastUserAt = Date.now()
    record.turnCount = (Number(record.turnCount) || 0) + 1
    // Any new message from the user clears the "we are waiting" state and any
    // scheduled nudge, which is what stops a follow-up landing after they reply.
    record.pendingSince = 0
    record.followUpSentAt = 0
    record.silenceNoticed = false
    if (language) record.language = language
    if (vibe) record.vibe = vibe
    return put(record)
}

/** Record an outgoing AI message and the provider that produced it. */
function noteAssistant(key, text, provider, { topic = '' } = {}) {
    if (!key) return null
    const record = get(key)
    record.lastAiText = String(text || '').slice(0, 500)
    record.lastAiAt = Date.now()
    record.lastProvider = String(provider || '')
    if (provider) {
        const history = Array.isArray(record.providerHistory) ? record.providerHistory.slice() : []
        history.push(String(provider))
        record.providerHistory = history.slice(-PROVIDER_HISTORY_MAX)
    }
    if (topic) record.topic = String(topic).slice(0, 200)
    record.pendingSince = Date.now()
    return put(record)
}

function markFollowUp(key) {
    const record = get(key)
    record.followUpSentAt = Date.now()
    record.followUpCount = (Number(record.followUpCount) || 0) + 1
    record.pendingSince = 0
    return put(record)
}

function clearPending(key) {
    const record = get(key)
    record.pendingSince = 0
    record.followUpSentAt = 0
    return put(record)
}

function noteAbuse(key, { warned = false } = {}) {
    const record = get(key)
    record.abuseCount = (Number(record.abuseCount) || 0) + 1
    if (warned) record.lastWarnAt = Date.now()
    return put(record)
}

function markBlocked(key, blocked = true) {
    const record = get(key)
    record.blocked = Boolean(blocked)
    return put(record)
}

function reset(key) {
    const store = load()
    delete store[key]
    save()
    return true
}

/** A compact snapshot for logs and the status command. No user text in logs. */
function describe(key) {
    const record = get(key)
    return {
        key: record.key,
        scope: record.scope,
        turns: record.turnCount,
        lastProvider: record.lastProvider,
        providersUsed: record.providerHistory?.length || 0,
        pending: record.pendingSince ? 'yes' : 'no',
        followUps: record.followUpCount,
        abuseCount: record.abuseCount,
        blocked: record.blocked,
        language: record.language,
        vibe: record.vibe,
        topic: record.topic
    }
}

function stats() {
    const store = load()
    return { records: Object.keys(store).length, path: STORE_PATH }
}

module.exports = {
    keyFor, get, update, put, noteUser, noteAssistant, markFollowUp, clearPending,
    noteAbuse, markBlocked, reset, describe, stats, flush, STORE_PATH
}
