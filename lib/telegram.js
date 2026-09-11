'use strict'

/*
 * DARKNOTE TELEGRAM CONTROL PANEL
 * -------------------------------
 * A control surface for the WhatsApp bot. It is NOT a replacement for it: the
 * WhatsApp bot keeps running exactly as before, and this only adds pairing and
 * status on top.
 *
 *   /start            welcome card + "PAIR WHATSAPP" inline button
 *   /pair             asks for a number, then runs the REAL Baileys pairing flow
 *   /status           reports the live WhatsApp connection state
 *   /unpair           destroys this user's paired session
 *
 * DESIGN RULES, all deliberate:
 *
 *   1. THE TOKEN COMES FROM process.env.TELEGRAM_BOT_TOKEN ONLY. It is read via
 *      the existing .env loader, never written back, never logged, and scrubbed
 *      out of any error text before that text reaches a user. A missing token
 *      disables the controller with a log line - it never crashes the bot.
 *
 *   2. SESSIONS ARE ISOLATED. Every Telegram user gets their own auth directory
 *      and their own socket, tracked in their own record. No handler ever reads
 *      another user's record.
 *
 *   3. THE MAIN BOT'S SOCKET IS NEVER TOUCHED. Pairing sockets are kept out of
 *      the Runtime Alive socket slot, so starting a pairing can never close or
 *      supersede the running WhatsApp bot.
 *
 *   4. NO FAKE SUCCESS. A pairing code is only ever the one the Baileys flow
 *      actually produced. If the flow fails, the real reason is logged and a
 *      plain explanation goes to the user.
 */

const fs = require('fs')
const path = require('path')
const pino = require('pino')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')

const aiConfig = require('../ai/config')
const runtime = require('./runtime')

const ROOT = path.join(__dirname, '..')
const API_BASE = 'https://api.telegram.org'
const POLL_TIMEOUT_S = 30
const PAIRING_SESSION_PREFIX = 'auth_tg_'

/* --------------------------------- state --------------------------------- */

let polling = false
let stopped = false
let offset = 0
let botUsername = ''
let tokenFingerprint = ''
let pollFailures = 0
/*
 * A 409 Conflict means ANOTHER process is polling this same bot token. Verified
 * by hand against this token: with no local instance running, getUpdates still
 * alternated OK/Conflict, so a competitor really exists elsewhere. It is not
 * something this process can fix, so it is counted and surfaced rather than
 * silently retried forever.
 */
let conflicts = 0
let lastConflictAt = 0

// Telegram user id -> pairing record. One record per user, never shared.
const sessions = new Map()

function configFile() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
    } catch {
        return {}
    }
}

function maxSessions() {
    const cfg = configFile()
    const value = Number(cfg.telegram?.maxSessions)
    return Number.isFinite(value) && value > 0 ? value : 3
}

function token() {
    aiConfig.loadEnvOnce()
    return String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
}

/**
 * Never log or display the token. This is the only representation of it that is
 * ever allowed into a log line, an error message or a reply.
 */
function fingerprint(value) {
    const t = String(value || '')
    if (t.length < 8) return 'token:short'
    return `token:***${t.slice(-4)}`
}

/** Strip anything that looks like a bot token out of text bound for a user. */
function scrub(text) {
    return String(text || '')
        .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '***')
        .replace(/(authorization|token|apikey|api_key)["'\s:=]+[^\s"',]+/gi, '$1=***')
}

/* ------------------------------- transport ------------------------------- */

async function callApi(method, payload) {
    const value = token()
    if (!value) throw new Error('TELEGRAM_BOT_TOKEN is not set')
    const response = await fetch(`${API_BASE}/bot${value}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
        signal: AbortSignal.timeout((POLL_TIMEOUT_S + 15) * 1000)
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok === false) {
        // The description is Telegram's own text and never contains our token.
        const description = scrub(body.description || `HTTP ${response.status}`)
        const error = new Error(`${method} failed: ${description}`)
        error.status = response.status
        error.telegramDescription = description
        throw error
    }
    return body.result
}

function sendMessage(chatId, text, extra = {}) {
    return callApi('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...extra
    })
}

function answerCallback(id, text = '') {
    return callApi('answerCallbackQuery', { callback_query_id: id, text }).catch(() => { })
}

/* ---------------------------------- copy --------------------------------- */

const WELCOME = [
    '╭────────────────────╮',
    '│ ✞ DARKNOTE',
    '│',
    '│ Welcome to DARKNOTE.',
    '│ Your WhatsApp connection',
    '│ starts here.',
    '│',
    '│ Connect. Pair. Control.',
    '╰────────────────────╯'
].join('\n')

const PAIR_PROMPT = [
    '🔗 *DARKNOTE PAIRING*',
    '',
    'Send your WhatsApp number in international format.',
    '',
    'Example:',
    '+2547XXXXXXXX',
    '',
    'Send /cancel to stop.'
].join('\n')

const START_KEYBOARD = {
    inline_keyboard: [
        [{ text: '🔗 PAIR WHATSAPP', callback_data: 'pair' }],
        [{ text: '📡 STATUS', callback_data: 'status' }]
    ]
}

function pairingCard(code) {
    return [
        '╭────────────────────╮',
        '│ 🔐 PAIRING CODE',
        '│',
        `│ ${code}`,
        '│',
        '│ Open WhatsApp →',
        '│ Linked Devices →',
        '│ Link a Device →',
        '│ Link with phone number',
        '│',
        '│ Enter the code shown above.',
        '╰────────────────────╯'
    ].join('\n')
}

const STATE_ICON = {
    CONNECTED: '🟢 CONNECTED',
    CONNECTING: '🟡 CONNECTING',
    DISCONNECTED: '🔴 DISCONNECTED',
    AUTH_REQUIRED: '⚠️ AUTHENTICATION REQUIRED'
}

/* -------------------------------- helpers -------------------------------- */

/** Normalise a number to international digits, or return '' when unusable. */
function normalizePhone(value) {
    let digits = String(value || '').replace(/[^\d+]/g, '').replace(/\+/g, '')
    if (digits.startsWith('00')) digits = digits.slice(2)
    if (!/^\d{8,15}$/.test(digits)) return ''
    return digits
}

function sessionDir(userId) {
    return path.join(ROOT, `${PAIRING_SESSION_PREFIX}${String(userId).replace(/[^\d]/g, '')}`)
}

function existingSessionCount() {
    try {
        return fs.readdirSync(ROOT).filter(entry =>
            entry.startsWith(PAIRING_SESSION_PREFIX) &&
            fs.statSync(path.join(ROOT, entry)).isDirectory()
        ).length
    } catch {
        return 0
    }
}

function record(userId) {
    if (!sessions.has(userId)) {
        sessions.set(userId, {
            userId,
            state: 'idle',
            phone: '',
            dir: sessionDir(userId),
            code: '',
            socket: null,
            connection: 'DISCONNECTED',
            lastError: '',
            updatedAt: Date.now()
        })
    }
    return sessions.get(userId)
}

/* ------------------------------- pairing --------------------------------- */

/** Clean up a user's socket without touching anyone else's. */
function closeSocket(entry) {
    const socket = entry?.socket
    entry.socket = null
    if (!socket) return
    try {
        if (typeof socket.end === 'function') socket.end(new Error('pairing closed by DARKNOTE'))
        else if (typeof socket.ws?.close === 'function') socket.ws.close()
    } catch (error) {
        console.error('[TELEGRAM] closing a pairing socket failed:', error?.message || error)
    }
}

async function sendStatus(userId) {
    const global = runtime.telegramState()
    const entry = sessions.get(userId)
    const lines = [
        '*📡 DARKNOTE STATUS*',
        '',
        `WhatsApp (main bot): ${STATE_ICON[global.state] || global.state}`,
        `Reconnects: ${global.reconnects}`,
        `Last activity: ${global.lastActivity ? new Date(global.lastActivity).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'none yet'}`
    ]
    // A user only ever sees their OWN pairing record.
    if (entry) {
        lines.push('', `Your paired session: ${STATE_ICON[entry.connection] || entry.connection}`)
        if (entry.phone) lines.push(`Number: +${entry.phone}`)
        if (entry.lastError) lines.push(`Last error: ${scrub(entry.lastError)}`)
    }
    await sendMessage(userId, lines.join('\n'), { reply_markup: START_KEYBOARD })
}

/**
 * Run the real Baileys pairing flow for one Telegram user.
 *
 * Returns the code the phone must enter. The code is produced by the library's
 * own pairing handshake - this function never invents one.
 */
async function pairFor(userId, phone) {
    const entry = record(userId)
    if (entry.socket) closeSocket(entry)

    entry.state = 'pairing'
    entry.phone = phone
    entry.code = ''
    entry.lastError = ''
    entry.connection = 'CONNECTING'
    entry.updatedAt = Date.now()

    fs.mkdirSync(entry.dir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(entry.dir)

    const socket = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        // Desktop browser identity: WhatsApp refuses to link from mobile ones.
        browser: Browsers.ubuntu('Chrome'),
        auth: state
    })
    entry.socket = socket

    socket.ev.on('creds.update', saveCreds)

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update
        if (connection === 'open') {
            entry.connection = 'CONNECTED'
            entry.state = 'paired'
            entry.updatedAt = Date.now()
            runtime.noteActivity()
            console.log(`[TELEGRAM] user ${userId} session connected`)
            await sendMessage(userId, [
                '╭────────────────────╮',
                '│ ✅ PAIRED',
                '│',
                `│ +${phone}`,
                '│ is now linked.',
                '╰────────────────────╯'
            ].join('\n')).catch(() => { })
            return
        }
        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            entry.updatedAt = Date.now()
            if (statusCode === DisconnectReason.loggedOut) {
                entry.connection = 'AUTH_REQUIRED'
                entry.state = 'failed'
                entry.lastError = 'WhatsApp rejected the link (logged out)'
                console.error(`[TELEGRAM] user ${userId} pairing rejected: loggedOut`)
                await sendMessage(userId, '⚠️ That link was rejected by WhatsApp. Send /pair to try again.').catch(() => { })
            } else if (entry.state === 'pairing') {
                // Closed before finishing. Report honestly rather than claiming
                // the code worked.
                entry.connection = 'DISCONNECTED'
                entry.lastError = `connection closed during pairing (code ${statusCode ?? 'unknown'})`
                console.error(`[TELEGRAM] user ${userId} pairing socket closed early: ${entry.lastError}`)
            } else {
                entry.connection = 'DISCONNECTED'
            }
        }
    })

    // The library needs a moment to complete the handshake before it will
    // accept a pairing request.
    await new Promise(resolve => setTimeout(resolve, 3000))

    // A falsy pairKey makes the library generate a random Crockford code, so
    // each pairing gets its own genuine 8-character code.
    const raw = await socket.requestPairingCode(phone, '')
    const code = String(raw || '')
    if (!/^[A-Z0-9]{6,10}$/i.test(code)) {
        throw new Error(`pairing code was not produced (got ${code ? `${code.length} chars` : 'nothing'})`)
    }
    entry.code = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
    entry.state = 'awaiting_code'
    entry.updatedAt = Date.now()
    return entry.code
}

/* ------------------------------- handlers -------------------------------- */

async function handlePairRequest(userId) {
    const entry = sessions.get(userId)
    // Count this user's own session as already existing.
    if (!entry && existingSessionCount() >= maxSessions()) {
        await sendMessage(userId, `🔒 The session limit (${maxSessions()}) has been reached. Ask the owner to remove a session before pairing another number.`, { reply_markup: START_KEYBOARD })
        return
    }
    const user = record(userId)
    user.state = 'awaiting_number'
    user.updatedAt = Date.now()
    await sendMessage(userId, PAIR_PROMPT)
}

async function handleNumber(userId, text) {
    const entry = record(userId)
    const phone = normalizePhone(text)
    if (!phone) {
        await sendMessage(userId, '❌ That is not a valid WhatsApp number.\n\nSend it in international format, e.g. +2547XXXXXXXX, or /cancel.')
        return
    }
    entry.state = 'pairing'
    await sendMessage(userId, `⏳ Creating a pairing code for +${phone}...`)
    try {
        const code = await pairFor(userId, phone)
        await sendMessage(userId, pairingCard(code))
    } catch (error) {
        entry.state = 'failed'
        entry.connection = 'DISCONNECTED'
        entry.lastError = error?.message || String(error)
        // Full technical detail to the panel logs; only a clean sentence to the
        // user, with no token and no stack trace.
        console.error(`[TELEGRAM] pairing failed for user ${userId}:`, error?.stack || error)
        await sendMessage(userId, [
            '❌ Pairing failed.',
            '',
            `Reason: ${scrub(error?.message || 'the pairing request could not be completed')}`,
            '',
            'Send /pair to try again.'
        ].join('\n'))
    }
}

async function handleUnpair(userId) {
    const entry = sessions.get(userId)
    if (entry) closeSocket(entry)
    sessions.delete(userId)
    try {
        fs.rmSync(sessionDir(userId), { recursive: true, force: true })
    } catch (error) {
        console.error(`[TELEGRAM] could not remove session dir for ${userId}:`, error?.message || error)
    }
    await sendMessage(userId, '🧹 Your paired session has been removed. Send /pair to link a number again.', { reply_markup: START_KEYBOARD })
}

async function routeCommand(userId, text) {
    const command = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '')
    const entry = sessions.get(userId)

    if (command === '/start' || command === '/help') {
        await sendMessage(userId, WELCOME, { reply_markup: START_KEYBOARD })
        return true
    }
    if (command === '/pair') {
        await handlePairRequest(userId)
        return true
    }
    if (command === '/status') {
        await sendStatus(userId)
        return true
    }
    if (command === '/unpair') {
        await handleUnpair(userId)
        return true
    }
    if (command === '/cancel') {
        if (entry) { closeSocket(entry); entry.state = 'idle' }
        await sendMessage(userId, 'Cancelled.', { reply_markup: START_KEYBOARD })
        return true
    }

    if (command.startsWith('/')) {
        await sendMessage(userId, 'Unknown command.\n\nStart with /start', { reply_markup: START_KEYBOARD })
        return true
    }

    // Free text is only meaningful while a number is expected.
    if (entry?.state === 'awaiting_number') {
        await handleNumber(userId, text)
        return true
    }
    return false
}

/* --------------------------------- polling ------------------------------- */

async function handleUpdate(update) {
    try {
        if (update.callback_query) {
            const userId = update.callback_query.from?.id
            const data = String(update.callback_query.data || '')
            await answerCallback(update.callback_query.id)
            if (!userId) return
            if (data === 'pair') await handlePairRequest(userId)
            else if (data === 'status') await sendStatus(userId)
            return
        }
        const message = update.message
        if (!message || !message.from?.id) return
        // Group chats are not supported on purpose: a pairing code must never be
        // posted somewhere another person can read it.
        if (message.chat?.type !== 'private') {
            await sendMessage(message.chat.id, 'DARKNOTE pairing works in a private chat only.')
            return
        }
        await routeCommand(message.from.id, message.text || '')
    } catch (error) {
        console.error('[TELEGRAM] update handling failed:', error?.stack || error)
    }
}

async function pollLoop() {
    while (!stopped) {
        try {
            const updates = await callApi('getUpdates', {
                offset,
                timeout: POLL_TIMEOUT_S,
                allowed_updates: ['message', 'callback_query']
            })
            pollFailures = 0
            if (Array.isArray(updates)) {
                for (const update of updates) {
                    offset = Math.max(offset, Number(update.update_id) + 1)
                    await handleUpdate(update)
                }
            }
        } catch (error) {
            if (stopped) return
            /*
             * 401 means the token is wrong or revoked. Retrying forever would
             * spin against a server that will keep refusing, so the controller
             * stops and says exactly what to fix.
             */
            if (error?.status === 401) {
                console.error('[TELEGRAM] token rejected by Telegram (401). Controller stopped. Check TELEGRAM_BOT_TOKEN in .env.')
                polling = false
                return
            }
            const isConflict = error?.status === 409 || /conflict/i.test(String(error?.message || ''))
            if (isConflict) {
                conflicts += 1
                lastConflictAt = Date.now()
                // Logged once, then every 10th, so a persistent conflict informs
                // without flooding the panel.
                if (conflicts === 1 || conflicts % 10 === 0) {
                    console.error(`[TELEGRAM] another instance is polling this bot token (409 conflict, ${conflicts} so far). Updates cannot be received while both run. Stop the other instance, or use a token only this bot uses.`)
                }
            }

            pollFailures += 1
            // Backoff, capped at 30s, so neither a network blip nor a token
            // conflict can become a hot loop.
            const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(pollFailures, 5)))
            if (!isConflict) {
                console.error(`[TELEGRAM] poll failed (${scrub(error?.message || error)}); retrying in ${Math.round(delay / 1000)}s`)
            }
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }
}

/**
 * Start the controller. Safe to call more than once - the second call is a
 * no-op, so a WhatsApp reconnect can never spawn a second Telegram poller.
 */
async function start() {
    if (polling) return { ok: true, reason: 'already-running' }

    const value = token()
    if (!value) {
        console.log('[TELEGRAM] controller disabled: TELEGRAM_BOT_TOKEN is not set')
        return { ok: false, reason: 'no-token' }
    }
    if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(value)) {
        console.error('[TELEGRAM] controller disabled: TELEGRAM_BOT_TOKEN is malformed')
        return { ok: false, reason: 'malformed-token' }
    }

    tokenFingerprint = fingerprint(value)
    try {
        const me = await callApi('getMe', {})
        botUsername = me?.username || ''
        console.log(`[TELEGRAM] controller online as @${botUsername || 'unknown'} (${tokenFingerprint})`)
    } catch (error) {
        console.error(`[TELEGRAM] controller disabled: ${scrub(error?.message || error)}`)
        return { ok: false, reason: 'getMe-failed' }
    }

    polling = true
    stopped = false
    // Detached on purpose: the controller must never block bot startup, and its
    // failures are contained by the loop above.
    Promise.resolve().then(pollLoop).catch(error => {
        console.error('[TELEGRAM] poll loop crashed:', error?.stack || error)
        polling = false
    })
    return { ok: true, reason: 'started' }
}

function stop() {
    stopped = true
    polling = false
    for (const [, entry] of sessions) closeSocket(entry)
    return true
}

function statusText() {
    const lines = [
        '*TELEGRAM CONTROLLER*',
        `Bot: @${botUsername || 'not connected'}`,
        `Polling: ${polling ? 'RUNNING' : 'STOPPED'}`,
        `Token: ${tokenFingerprint || (token() ? 'not verified' : 'not set')}`,
        `Sessions in use: ${existingSessionCount()}/${maxSessions()}`,
        `Active pairing flows: ${sessions.size}`,
        conflicts
            ? `⚠️ Token conflicts: ${conflicts} (another bot instance is polling this token - updates are interrupted). Last ${new Date(lastConflictAt).toISOString().slice(11, 19)} UTC`
            : 'Token conflicts: none'
    ]
    return lines.join('\n')
}

module.exports = {
    start,
    stop,
    statusText,
    sendMessage,
    sendStatus,
    normalizePhone,
    scrub,
    sessions,
    handleUpdate,
    routeCommand,
    maxSessions
}
