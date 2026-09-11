'use strict'

/*
 * DARKNOTE — SESSION REGISTRY
 * ---------------------------
 * The bot can now run MANY WhatsApp sessions at once, each owned by a Telegram
 * account. This file is the single source of truth for which sessions exist,
 * who owns them, and whether a new pairing is allowed.
 *
 * CAPACITY MODEL
 *
 *   maxTelegramAccounts   50   how many distinct Telegram accounts may pair at all
 *   maxSessionsPerAccount  3   how many WhatsApp numbers ONE Telegram account may pair
 *
 * So the absolute ceiling is 50 x 3 = 150 concurrent WhatsApp sessions.
 *
 * Directory layout:
 *
 *   auth/                the original session, always id "main". Never moved.
 *   sessions/<id>/       every session paired from Telegram
 *
 * Registries are written atomically (temp file + rename) and live under
 * database/, which is gitignored - the registry holds phone numbers and must
 * never reach the repository.
 *
 * A corrupt registry is treated as a hard failure rather than silently reset:
 * quietly starting with an empty registry would orphan every paired session and
 * make them look unpaired, which is far worse than refusing to start.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PRIMARY_DIR = path.join(ROOT, 'auth')
const SESSIONS_DIR = path.join(ROOT, 'sessions')
const REGISTRY_FILE = path.join(ROOT, 'database', 'sessions.json')
const PRIMARY_ID = 'main'

const DEFAULTS = { maxTelegramAccounts: 50, maxSessionsPerAccount: 3 }

function limits() {
    let config = {}
    try {
        config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).telegram || {}
    } catch { /* defaults below */ }
    const accounts = Number(config.maxTelegramAccounts)
    const perAccount = Number(config.maxSessionsPerAccount)
    return {
        maxTelegramAccounts: Number.isFinite(accounts) && accounts > 0 ? accounts : DEFAULTS.maxTelegramAccounts,
        maxSessionsPerAccount: Number.isFinite(perAccount) && perAccount > 0 ? perAccount : DEFAULTS.maxSessionsPerAccount
    }
}

/* ------------------------------- registry -------------------------------- */

let cache = null

function emptyRegistry() {
    return { version: 1, sessions: {} }
}

function load() {
    if (cache) return cache
    try {
        if (!fs.existsSync(REGISTRY_FILE)) {
            cache = emptyRegistry()
            return cache
        }
        const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
        if (!raw || typeof raw !== 'object' || typeof raw.sessions !== 'object' || raw.sessions === null) {
            throw new Error('registry has an unexpected shape')
        }
        cache = { version: Number(raw.version) || 1, sessions: raw.sessions }
        return cache
    } catch (error) {
        /*
         * Refusing to continue is deliberate. Starting empty would silently
         * orphan every paired session, and the user would see "not paired"
         * for numbers that are actually linked.
         */
        console.error('[SESSIONS] registry could not be read:', error?.message || error)
        throw new Error(`session registry is unreadable: ${error?.message || error}`)
    }
}

function save() {
    const registry = load()
    try {
        fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true })
        const temp = `${REGISTRY_FILE}.tmp`
        fs.writeFileSync(temp, JSON.stringify(registry, null, 2))
        fs.renameSync(temp, REGISTRY_FILE)
        return true
    } catch (error) {
        console.error('[SESSIONS] registry could not be written:', error?.message || error)
        return false
    }
}

/* -------------------------------- records -------------------------------- */

const clone = record => (record ? { ...record } : null)

function all() {
    return Object.values(load().sessions)
}

function get(id) {
    return clone(load().sessions[id])
}

/** Every session owned by one Telegram account, oldest first. */
function forUser(telegramUserId) {
    return all()
        .filter(record => String(record.telegramUserId) === String(telegramUserId))
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
}

/** Distinct Telegram accounts that currently own at least one session. */
function accountCount() {
    const owners = new Set()
    for (const record of all()) {
        if (record.telegramUserId !== null && record.telegramUserId !== undefined && record.telegramUserId !== '') {
            owners.add(String(record.telegramUserId))
        }
    }
    return owners.size
}

function newId() {
    const registry = load()
    for (let i = 1; i < 10000; i++) {
        const id = `s${i}`
        if (!registry.sessions[id]) return id
    }
    return `s${Date.now().toString(36)}`
}

function sessionDir(id) {
    // The primary session keeps its original folder so the existing pairing is
    // never disturbed; everything else gets its own isolated directory.
    return id === PRIMARY_ID ? PRIMARY_DIR : path.join(SESSIONS_DIR, id)
}

/**
 * Whether this Telegram account may pair another WhatsApp number.
 *
 * Both limits are checked and the SPECIFIC one that blocked it is returned, so
 * the user is told which wall they hit rather than a generic refusal.
 */
function canPair(telegramUserId) {
    const { maxTelegramAccounts, maxSessionsPerAccount } = limits()
    const owned = forUser(telegramUserId)

    if (owned.length >= maxSessionsPerAccount) {
        return { ok: false, code: 'per-account-limit', limit: maxSessionsPerAccount, owned: owned.length }
    }

    const isNewAccount = owned.length === 0
    if (isNewAccount && accountCount() >= maxTelegramAccounts) {
        return { ok: false, code: 'account-limit', limit: maxTelegramAccounts, accounts: accountCount() }
    }

    return { ok: true, owned: owned.length, maxSessionsPerAccount }
}

/** Register a placeholder session before its pairing code is requested. */
function create(telegramUserId, phone, label) {
    const registry = load()
    const id = newId()
    const now = Date.now()
    const record = {
        id,
        telegramUserId: String(telegramUserId),
        phone: String(phone || ''),
        label: String(label || '').slice(0, 40),
        dir: id === PRIMARY_ID ? 'auth' : path.join('sessions', id),
        createdAt: now,
        pairedAt: 0,
        lastConnectedAt: 0,
        lastError: ''
    }
    registry.sessions[id] = record
    try {
        fs.mkdirSync(sessionDir(id), { recursive: true })
    } catch (error) {
        delete registry.sessions[id]
        console.error('[SESSIONS] could not create the session directory:', error?.message || error)
        return { ok: false, error: error?.message || String(error) }
    }
    if (!save()) {
        delete registry.sessions[id]
        return { ok: false, error: 'registry write failed' }
    }
    console.log(`[SESSIONS] created ${id} for Telegram ${telegramUserId} (+${phone})`)
    return { ok: true, record: clone(record) }
}

/**
 * Adopt the pre-existing `auth/` session so the original pairing keeps working
 * under the multi-session model instead of becoming invisible to it.
 */
function adoptPrimary() {
    const registry = load()
    if (registry.sessions[PRIMARY_ID]) return registry.sessions[PRIMARY_ID]
    if (!fs.existsSync(PRIMARY_DIR)) return null

    let creds = null
    try {
        creds = JSON.parse(fs.readFileSync(path.join(PRIMARY_DIR, 'creds.json'), 'utf8'))
    } catch { return null }
    if (!creds || creds.registered !== true) return null

    const record = {
        id: PRIMARY_ID,
        telegramUserId: null,        // ownerless: the bot's own original session
        phone: String(creds.me?.id || '').split('@')[0].split(':')[0].replace(/\D/g, ''),
        label: String(creds.me?.name || '').slice(0, 40),
        dir: 'auth',
        createdAt: Date.now(),
        pairedAt: Date.now(),
        lastConnectedAt: 0,
        lastError: ''
    }
    registry.sessions[PRIMARY_ID] = record
    save()
    console.log(`[SESSIONS] adopted the existing auth/ session as "${PRIMARY_ID}" (+${record.phone})`)
    return record
}

function update(id, patch) {
    const registry = load()
    const record = registry.sessions[id]
    if (!record) return null
    Object.assign(record, patch)
    save()
    return clone(record)
}

/**
 * Remove a session and its credentials.
 *
 * The directory is deleted in full: a leftover creds.json is exactly what makes
 * a later re-pair fail confusingly, so a partial clear is worse than none.
 */
function remove(id) {
    const registry = load()
    const record = registry.sessions[id]
    if (!record) return { ok: false, error: 'no such session' }

    delete registry.sessions[id]
    save()

    // The primary folder is recreated rather than removed outright, so a future
    // pairing has somewhere to write.
    try {
        const dir = sessionDir(id)
        if (fs.existsSync(dir)) {
            if (id === PRIMARY_ID) fs.rmSync(path.join(dir, 'creds.json'), { force: true })
            else fs.rmSync(dir, { recursive: true, force: true })
        }
    } catch (error) {
        console.error(`[SESSIONS] could not clear ${id} on disk:`, error?.message || error)
        return { ok: true, warning: error?.message || String(error) }
    }
    console.log(`[SESSIONS] removed ${id}`)
    return { ok: true }
}

/** Registry summary for logs and status. Never includes credentials. */
function summary() {
    const { maxTelegramAccounts, maxSessionsPerAccount } = limits()
    const sessions = all()
    return {
        total: sessions.length,
        accounts: accountCount(),
        maxTelegramAccounts,
        maxSessionsPerAccount,
        ceiling: maxTelegramAccounts * maxSessionsPerAccount,
        connected: sessions.filter(record => record.state === 'CONNECTED').length
    }
}

/** Force a re-read from disk (used by tests and after external edits). */
function reload() {
    cache = null
    return load()
}

module.exports = {
    PRIMARY_ID,
    PRIMARY_DIR,
    SESSIONS_DIR,
    REGISTRY_FILE,
    limits,
    all,
    get,
    forUser,
    accountCount,
    canPair,
    create,
    adoptPrimary,
    update,
    remove,
    summary,
    reload,
    sessionDir,
    save
}
