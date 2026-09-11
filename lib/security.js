'use strict'

/*
 * DARKNOTE — security engine for the anti-feature suite.
 *
 * ONE engine. ONE enforcement path. It is deliberately NOT a set of independent
 * listeners: every anti-feature is a row in FEATURES below, and both entry points
 * (a message, or a group participant change) funnel through the same escalation
 * code so a single violation can never produce two warnings, two deletes or two
 * kicks.
 *
 *   messages.upsert            -> handleMessage()     -> messageFeatures()
 *   group-participants.update  -> handleParticipants() -> participantFeatures()
 *                                       |
 *                                  escalate()  warning -> delete -> kick
 *
 * ONCE OFF MEANS OFF. Every check reads the persisted setting at the moment the
 * action would happen, never a value captured earlier, so disabling a feature
 * stops it immediately even if a decision was already in progress.
 *
 * Nothing here acts unless the bot is a group admin, and the owner and the bot
 * itself are always exempt.
 */

const fs = require('fs')
const path = require('path')

const STORE_PATH = path.join(__dirname, '..', 'database', 'anti-strikes.json')
const CONFIG_PATH = path.join(__dirname, '..', 'config.json')

/* Strike thresholds, per group+user. Respects the existing escalation style. */
const STRIKES = { warn: 1, delete: 2, kick: 3 }

/**
 * The suite. `scope` says which entry point owns the feature; `kind` is the
 * participant event it reacts to; `detect` is the message test.
 */
const FEATURES = {
    // --- group participant events -----------------------------------------
    antidemote: { scope: 'participants', events: ['demote'], label: 'Anti-demote', restores: true },
    antikick: { scope: 'participants', events: ['remove'], label: 'Anti-kick', restores: true },
    antiadd: { scope: 'participants', events: ['add'], label: 'Anti-add' },
    antipromote: { scope: 'participants', events: ['promote'], label: 'Anti-promote', restores: true },

    // --- message content ---------------------------------------------------
    antisticker: { scope: 'message', label: 'Anti-sticker', detect: m => mtype(m) === 'stickermessage' },
    antiviewonce: {
        scope: 'message', label: 'Anti-view-once',
        detect: m => /viewonce/i.test(mtype(m)) || Boolean(m?.msg?.viewOnce || m?.message?.viewOnceMessage || m?.message?.viewOnceMessageV2)
    },
    antimedia: {
        scope: 'message', label: 'Anti-media',
        detect: m => ['imagemessage', 'videomessage', 'audiomessage', 'documentmessage', 'ptvmessage'].includes(mtype(m))
    },
    antimentionstatus: {
        scope: 'message', label: 'Anti-mention-status',
        // Uses REAL WhatsApp mention metadata, never a text search for the name.
        detect: (m, ctx) => mentionedJids(m).some(j => sameUser(j, ctx?.selfIds))
    }
}

/* --------------------------------- settings ------------------------------- */

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}
    } catch (error) {
        console.error('[SECURITY] config.json unreadable:', error?.message || error)
        return {}
    }
}

function writeConfig(file) {
    const tmp = `${CONFIG_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2))
    fs.renameSync(tmp, CONFIG_PATH)
}

/** Persisted settings for the whole suite. Everything defaults to OFF. */
function getSettings() {
    const file = readConfig()
    const stored = file.antiFeatures && typeof file.antiFeatures === 'object' ? file.antiFeatures : {}
    const result = { enforcement: { warn: true, delete: true, kick: true } }
    for (const name of Object.keys(FEATURES)) {
        const entry = stored[name]
        result[name] = { enabled: entry?.enabled === true }
    }
    if (stored.enforcement && typeof stored.enforcement === 'object') {
        result.enforcement = { ...result.enforcement, ...stored.enforcement }
    }
    return result
}

/** Persist one feature's state. Survives restart because it is on disk. */
function setFeature(name, enabled) {
    if (!FEATURES[name]) return false
    const file = readConfig()
    if (!file.antiFeatures || typeof file.antiFeatures !== 'object') file.antiFeatures = {}
    file.antiFeatures[name] = { ...(file.antiFeatures[name] || {}), enabled: Boolean(enabled) }
    writeConfig(file)
    return true
}

/** Enable or disable the whole suite at once. */
function setAll(enabled) {
    const file = readConfig()
    if (!file.antiFeatures || typeof file.antiFeatures !== 'object') file.antiFeatures = {}
    for (const name of Object.keys(FEATURES)) {
        file.antiFeatures[name] = { ...(file.antiFeatures[name] || {}), enabled: Boolean(enabled) }
    }
    writeConfig(file)
    return Object.keys(FEATURES)
}

function setEnforcement(level, enabled) {
    const file = readConfig()
    if (!file.antiFeatures || typeof file.antiFeatures !== 'object') file.antiFeatures = {}
    const current = file.antiFeatures.enforcement || {}
    file.antiFeatures.enforcement = { ...current, [level]: Boolean(enabled) }
    writeConfig(file)
    return true
}

/* ---------------------------------- strikes -------------------------------- */

let strikes = null

function loadStrikes() {
    if (strikes) return strikes
    try {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
        strikes = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
        strikes = {}
    }
    return strikes
}

function saveStrikes() {
    try {
        const dir = path.dirname(STORE_PATH)
        fs.mkdirSync(dir, { recursive: true })
        const tmp = `${STORE_PATH}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(loadStrikes(), null, 2))
        fs.renameSync(tmp, STORE_PATH)
    } catch (error) {
        console.error('[SECURITY] could not persist strikes:', error?.message || error)
    }
}

const strikeKey = (group, user) => `${group}:${user}`

function addStrike(group, user) {
    const store = loadStrikes()
    const key = strikeKey(group, user)
    const count = (Number(store[key]) || 0) + 1
    store[key] = count
    saveStrikes()
    return count
}

function clearStrikes(group, user) {
    const store = loadStrikes()
    delete store[strikeKey(group, user)]
    saveStrikes()
    return true
}

/* ---------------------------------- helpers -------------------------------- */

const digits = v => String(v || '').split('@')[0].split(':')[0].replace(/\D/g, '')
const mtype = m => String(m?.mtype || '').toLowerCase()
const sameUser = (a, b) => { const x = digits(a); return Boolean(x) && new Set(Array.from(b || []).map(digits)).has(x) }

function mentionedJids(m) {
    const direct = m?.mentionedJid
    if (Array.isArray(direct) && direct.length) return direct
    const ctx = m?.msg?.contextInfo || m?.message?.extendedTextMessage?.contextInfo || m?.message?.imageMessage?.contextInfo || m?.message?.videoMessage?.contextInfo
    return Array.isArray(ctx?.mentionedJid) ? ctx.mentionedJid : []
}

/** Is the bot an admin here? Cached briefly; nothing acts without it. */
const adminCache = new Map()
async function botIsAdmin(conn, group) {
    const cached = adminCache.get(group)
    if (cached && Date.now() - cached.at < 60000) return cached.value
    let value = false
    try {
        const metadata = await conn.groupMetadata(group)
        const self = digits(conn?.user?.id)
        const me = (metadata?.participants || []).find(p => digits(p.id || p.jid || p.lid) === self)
        value = Boolean(me?.admin)
    } catch (error) {
        console.error('[SECURITY] could not read group metadata:', error?.message || error)
    }
    adminCache.set(group, { at: Date.now(), value })
    return value
}

/** Group-only, never the owner, never the bot itself. */
function isExempt(conn, ctx, userJid) {
    const user = digits(userJid)
    if (!user) return true
    if (user === digits(conn?.user?.id)) return true
    if (ctx?.selfIds && new Set(Array.from(ctx.selfIds).map(digits)).has(user)) return true
    if (ctx?.isOwner?.(userJid)) return true
    return false
}

/* -------------------------------- enforcement ------------------------------ */

/**
 * The single escalation path.
 * Returns a description of what happened so the caller can log it.
 */
async function escalate(conn, ctx, { group, user, feature, reason }) {
    const settings = getSettings()
    const strike = addStrike(group, user)
    const label = FEATURES[feature]?.label || feature
    const performed = []

    // 1. Warning
    if (settings.enforcement.warn && strike >= STRIKES.warn) {
        try {
            await conn.sendMessage(group, {
                text: `⚠️ *${label}*\n\n@${digits(user)} ${reason}\nStrike ${strike}.`,
                mentions: [user]
            })
            performed.push('warn')
        } catch (error) {
            console.error('[SECURITY] warning failed:', error?.message || error)
        }
    }

    // 2. Delete the offending message, when there is one and it is supported.
    if (settings.enforcement.delete && strike >= STRIKES.delete && ctx?.deleteMessage) {
        try {
            await ctx.deleteMessage()
            performed.push('delete')
        } catch (error) {
            console.error('[SECURITY] delete failed:', error?.message || error)
        }
    }

    // 3. Kick, only once warnings have been ignored and only if permitted.
    if (settings.enforcement.kick && strike >= STRIKES.kick) {
        if (await botIsAdmin(conn, group)) {
            try {
                await conn.groupParticipantsUpdate(group, [user], 'remove')
                performed.push('kick')
                clearStrikes(group, user)
            } catch (error) {
                // WhatsApp refuses to remove an admin, or the bot is not allowed.
                console.error('[SECURITY] kick refused:', error?.message || error)
                performed.push('kick-refused')
            }
        } else {
            performed.push('kick-not-admin')
        }
    }

    return { feature, user, strike, performed, reason }
}

/* ------------------------------- entry points ------------------------------ */

/**
 * Message-based features. Called from the existing dispatcher, so there is no
 * second messages.upsert listener anywhere.
 */
async function handleMessage(conn, m, ctx = {}) {
    try {
        if (!m?.isGroup) return null
        if (m.key?.fromMe) return null
        const settings = getSettings()
        const results = []
        for (const [name, feature] of Object.entries(FEATURES)) {
            if (feature.scope !== 'message') continue
            if (!settings[name]?.enabled) continue
            if (isExempt(conn, ctx, m.sender)) continue
            let hit = false
            try {
                hit = Boolean(feature.detect(m, { ...ctx, selfIds: ctx.selfIds || [] }))
            } catch (error) {
                console.error(`[SECURITY] ${name} detection failed:`, error?.message || error)
                continue
            }
            if (!hit) continue
            results.push(await escalate(conn, { ...ctx, deleteMessage: ctx.deleteMessage }, {
                group: m.chat, user: m.sender, feature: name, reason: 'that content is not allowed here.'
            }))
            break   // ONE feature per message: never two warnings for one offence
        }
        return results.length ? results : null
    } catch (error) {
        console.error('[SECURITY] handleMessage failed:', error?.message || error)
        return null
    }
}

/**
 * Participant-based features. Called from the ONE group-participants.update
 * listener in index.js.
 */
async function handleParticipants(conn, update, ctx = {}) {
    try {
        const group = update?.id
        const action = String(update?.action || '')
        if (!group || !action) return null
        const settings = getSettings()
        const results = []

        for (const [name, feature] of Object.entries(FEATURES)) {
            if (feature.scope !== 'participants') continue
            if (!settings[name]?.enabled) continue
            if (!feature.events.includes(action)) continue

            const actor = update.author || update.actor || null
            // The bot changing things itself, or the owner, is never a violation.
            if (actor && isExempt(conn, ctx, actor)) continue

            for (const participant of update.participants || []) {
                const user = digits(participant)
                if (!user || user === digits(conn?.user?.id)) continue

                results.push(await escalate(conn, ctx, {
                    group, user: actor || user, feature: name,
                    reason: `unauthorised ${action} of @${user}.`
                }))

                // Best effort restoration. Reported honestly when WhatsApp refuses.
                if (feature.restores && await botIsAdmin(conn, group)) {
                    try {
                        if (action === 'demote') await conn.groupParticipantsUpdate(group, [user], 'promote')
                        if (action === 'promote') await conn.groupParticipantsUpdate(group, [user], 'demote')
                        if (action === 'remove') await conn.groupParticipantsUpdate(group, [user], 'add')
                        results[results.length - 1].restored = true
                    } catch (error) {
                        results[results.length - 1].restored = false
                        results[results.length - 1].restoreError = error?.message || String(error)
                        console.error(`[SECURITY] ${name} restore refused:`, error?.message || error)
                    }
                }
            }
            break   // one participant feature per event
        }
        return results.length ? results : null
    } catch (error) {
        console.error('[SECURITY] handleParticipants failed:', error?.message || error)
        return null
    }
}

function describe() {
    const settings = getSettings()
    return Object.entries(FEATURES).map(([name, feature]) => ({
        name, label: feature.label, scope: feature.scope, enabled: settings[name].enabled
    }))
}

function enabledNames() {
    const settings = getSettings()
    return Object.keys(FEATURES).filter(n => settings[n].enabled)
}

module.exports = {
    FEATURES, getSettings, setFeature, setAll, setEnforcement, describe, enabledNames,
    handleMessage, handleParticipants, escalate, addStrike, clearStrikes, STRIKES, STORE_PATH
}
