'use strict'

/*
 * DARKNOTE — MAIN SESSION
 * -----------------------
 * The bot has exactly ONE WhatsApp session, in `auth/`. This module is the only
 * thing that reads, describes or deletes it, so the Telegram controller and the
 * startup path cannot disagree about whether the bot is paired.
 *
 * It deliberately does NOT create sockets. Socket ownership stays in index.js
 * where the single-socket rule is enforced; this file only answers "what is the
 * state of auth/" and "remove it safely".
 */

const fs = require('fs')
const path = require('path')

const AUTH_DIR = path.join(__dirname, '..', 'auth')
const CREDS_FILE = path.join(AUTH_DIR, 'creds.json')

/** The raw credential blob, or null when it does not exist / cannot be read. */
function readCreds() {
    try {
        if (!fs.existsSync(CREDS_FILE)) return null
        const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
        return raw && typeof raw === 'object' ? raw : null
    } catch (error) {
        console.error('[SESSION] creds.json could not be read:', error?.message || error)
        return null
    }
}

/**
 * "Registered" means WhatsApp has actually completed the link handshake.
 *
 * A creds.json without `registered: true` is a half-written pairing attempt, and
 * treating it as paired would make the bot look linked when it is not.
 */
function isRegistered() {
    const creds = readCreds()
    return Boolean(creds && creds.registered === true)
}

const number = value => String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '')

/** Everything a status reply needs, in one honest object. */
function info() {
    const creds = readCreds()
    if (!creds) {
        return { exists: false, registered: false, number: '', name: '', platform: '', pairedAt: '' }
    }
    const me = creds.me || {}
    return {
        exists: true,
        registered: creds.registered === true,
        number: number(me.id),
        // `name` here is the account's own name as WhatsApp reports it.
        name: String(me.name || me.verifiedName || '').slice(0, 40),
        platform: String(me.platform || ''),
        pairedAt: creds.registrationId ? '' : ''
    }
}

/**
 * Delete the session.
 *
 * Used only when the owner has explicitly confirmed a re-pair. The directory is
 * removed in full - a leftover `creds.json` is exactly what would make a
 * subsequent pairing fail in a confusing way, so a partial clear is worse than
 * none.
 */
function reset() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return { ok: true, alreadyEmpty: true }
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        console.log('[SESSION] session cleared (owner-confirmed re-pair)')
        return { ok: true }
    } catch (error) {
        console.error('[SESSION] could not clear the session:', error?.message || error)
        return { ok: false, error: error?.message || String(error) }
    }
}

/** A one-line description for logs. Never includes credential material. */
function describe() {
    const state = info()
    if (!state.exists) return 'no session'
    if (!state.registered) return 'session folder exists but is NOT registered'
    return `paired${state.number ? ` as +${state.number}` : ''}`
}

module.exports = {
    AUTH_DIR,
    CREDS_FILE,
    readCreds,
    isRegistered,
    info,
    reset,
    describe
}
