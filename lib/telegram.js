'use strict'

/*
 * DARKNOTE TELEGRAM CONTROL PANEL
 * -------------------------------
 * The Telegram bot is the CONTROL SURFACE for the WhatsApp bot. It is not a
 * replacement for it: the WhatsApp bot keeps running exactly as before, and this
 * adds pairing, status and control on top.
 *
 *   /start            welcome card + inline buttons
 *   /pair             pair THE bot's WhatsApp number (this is the main feature)
 *   /status           live WhatsApp connection + session state
 *   /unpair           remove the pairing (confirmed)
 *   /cancel           abandon a half-finished flow
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW PAIRING WORKS HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * There is exactly ONE WhatsApp session - `auth/` - and ONE socket, owned by
 * index.js. This controller never creates a socket of its own.
 *
 * Instead it asks index.js (through the `bot` API handed to start()) to pair a
 * number. index.js closes any existing socket, clears `auth/` when replacing,
 * lets its normal startup path build a fresh unregistered socket, and requests
 * the pairing code on THAT socket. When the phone completes the link, that same
 * socket becomes the running bot - so a number paired from Telegram is
 * immediately a working DARKNOTE, with no restart and no second connection.
 *
 * SECURITY RULES, all deliberate:
 *
 *   1. THE TOKEN COMES FROM process.env.TELEGRAM_BOT_TOKEN ONLY. It is never
 *      written back, never logged, and scrubbed out of any error text before
 *      that text reaches a user. A missing or rejected token disables the
 *      controller with a log line and never crashes the bot.
 *
 *   2. REPLACING A PAIRING REQUIRES CONFIRMATION. A number being re-paired takes
 *      the bot off its current account, so it is never done on a single command.
 *
 *   3. ONLY THE OWNER MAY PAIR. Pairing controls the bot's own WhatsApp account,
 *      so it is restricted to the configured Telegram owner when one is set.
 *
 *   4. NO FAKE SUCCESS. A code is only ever the one Baileys actually produced,
 *      and a status is only ever what the live connection reports.
 */

const fs = require('fs')
const path = require('path')

const aiConfig = require('../ai/config')

const ROOT = path.join(__dirname, '..')
const API_BASE = 'https://api.telegram.org'
const POLL_TIMEOUT_S = 30

/* --------------------------------- state --------------------------------- */

let polling = false
let stopped = false
let offset = 0
let botUsername = ''
let tokenFingerprint = ''
let pollFailures = 0
/*
 * A 409 Conflict means ANOTHER process is polling this same bot token. Verified
 * against this token by hand: with no local instance running, getUpdates still
 * alternated OK/Conflict, so a competitor really exists elsewhere. It is not
 * something this process can fix, so it is counted and surfaced rather than
 * silently retried forever.
 */
let conflicts = 0
let lastConflictAt = 0

// The index.js API (session + pairing). Injected, never required - requiring it
// would be a circular import and would risk a second copy of the socket logic.
let bot = null

// Telegram user id -> in-progress flow. Keeps one user's half-finished pairing
// from being read as another user's number.
const flows = new Map()

function configFile() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))
    } catch {
        return {}
    }
}

/** 'bot' (default) pairs this bot's number; 'status' disables pairing commands. */
function mode() {
    const value = String(configFile().telegram?.mode || 'bot').toLowerCase()
    return value === 'status' ? 'status' : 'bot'
}

/**
 * The Telegram user allowed to pair. Falls back to "anyone" only when no owner
 * is configured, so a fresh install is usable - but the moment an owner id is
 * set, pairing is locked to them.
 */
function ownerId() {
    const value = configFile().telegram?.ownerId
    return value === undefined || value === null || value === '' ? null : String(value)
}

function isOwner(userId) {
    const owner = ownerId()
    return owner === null || String(userId) === owner
}

function token() {
    aiConfig.loadEnvOnce()
    return String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
}

/** Never log or display the token. This is the only representation allowed out. */
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

const START_KEYBOARD = {
    inline_keyboard: [
        [{ text: '🔗 PAIR WHATSAPP', callback_data: 'pair' }],
        [{ text: '📡 STATUS', callback_data: 'status' }]
    ]
}

const PAIR_PROMPT = [
    '🔗 *DARKNOTE PAIRING*',
    '',
    'Send the WhatsApp number you want this bot to run on.',
    '',
    'International format, digits only:',
    '2547XXXXXXXX',
    '',
    'Send /cancel to stop.'
].join('\n')

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
        '╰────────────────────╯',
        '',
        'The bot starts running the moment the link completes.'
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

function flow(userId) {
    if (!flows.has(userId)) flows.set(userId, { state: 'idle', phone: '', updatedAt: Date.now() })
    return flows.get(userId)
}

/* ------------------------------ pairing cards ---------------------------- */

/**
 * What to tell the user about the current pairing.
 *
 * Read from the live session via the injected API, so it cannot drift from what
 * the bot actually has on disk.
 */
function sessionLine() {
    if (!bot) return 'Session: unavailable'
    const info = bot.sessionInfo()
    if (!info.exists) return 'Session: none — this bot has no WhatsApp pairing yet'
    if (!info.registered) return 'Session: incomplete (a pairing was started but never finished)'
    return `Session: paired${info.number ? ` as +${info.number}` : ''}`
}

async function sendStatus(userId) {
    const connection = bot ? bot.connectionState() : { state: 'DISCONNECTED', reconnects: 0 }
    const info = bot ? bot.sessionInfo() : { exists: false, registered: false }
    const lines = [
        '*📡 DARKNOTE STATUS*',
        '',
        `WhatsApp: ${STATE_ICON[connection.state] || connection.state}`,
        sessionLine(),
        `Reconnects: ${connection.reconnects || 0}`,
        `Pairing: ${mode() === 'bot' ? 'enabled' : 'disabled'}`
    ]
    if (!info.exists || !info.registered) {
        lines.push('', 'Nothing is paired yet. Send /pair to link a number.')
    }
    if (conflicts) {
        lines.push('', `⚠️ Token conflicts: ${conflicts} — another process is polling this token, so replies may be delayed.`)
    }
    await sendMessage(userId, lines.join('\n'), { reply_markup: START_KEYBOARD })
}

/* -------------------------------- pairing -------------------------------- */

async function handlePairRequest(userId) {
    if (mode() !== 'bot') {
        await sendMessage(userId, 'Pairing is disabled on this deployment.', { reply_markup: START_KEYBOARD })
        return
    }
    if (!isOwner(userId)) {
        await sendMessage(userId, '🔒 Pairing is restricted to the owner of this bot.')
        return
    }
    if (!bot) {
        await sendMessage(userId, '❌ The bot is not ready to pair yet. Try again in a moment.')
        return
    }
    const entry = flow(userId)
    entry.state = 'awaiting_number'
    entry.phone = ''
    entry.updatedAt = Date.now()
    await sendMessage(userId, `${PAIR_PROMPT}\n\n${sessionLine()}`)
}

/**
 * Run the pairing once a number is known.
 *
 * `confirmed` is only set when the user explicitly confirmed a REPLACEMENT. When
 * a working pairing already exists and no confirmation has been given, this
 * stops and asks - it never silently takes the bot off its current account.
 */
async function pairNow(userId, phone, confirmed) {
    /*
     * AUTHORISATION CHOKE POINT.
     *
     * This check lives HERE, not only in handlePairRequest, because `/pair
     * <number>` reaches pairing by a different route (handleNumber). Guarding
     * only the interactive path let anyone who supplied the number inline pair
     * the bot's WhatsApp account. Every path into pairing now passes through
     * this function, so the guard cannot be bypassed.
     */
    if (mode() !== 'bot') {
        await sendMessage(userId, 'Pairing is disabled on this deployment.', { reply_markup: START_KEYBOARD })
        return
    }
    if (!isOwner(userId)) {
        console.warn(`[TELEGRAM] pairing refused for non-owner ${userId}`)
        await sendMessage(userId, '🔒 Pairing is restricted to the owner of this bot.')
        return
    }
    if (!bot) {
        await sendMessage(userId, '❌ The bot is not ready to pair yet. Try again in a moment.')
        return
    }

    const entry = flow(userId)
    const info = bot.sessionInfo()

    if (info.registered && !confirmed) {
        entry.state = 'awaiting_confirm'
        entry.phone = phone
        entry.updatedAt = Date.now()
        await sendMessage(userId, [
            '⚠️ *THIS BOT IS ALREADY PAIRED*',
            '',
            sessionLine(),
            '',
            `Pairing +${phone} will disconnect the bot from its current number and replace it.`,
            '',
            'To go ahead, send:',
            '`/pair confirm`',
            '',
            'Send /cancel to keep the current pairing.'
        ].join('\n'))
        return
    }

    entry.state = 'pairing'
    entry.updatedAt = Date.now()
    await sendMessage(userId, `⏳ Requesting a pairing code for +${phone}...`)

    try {
        const result = await bot.pair(phone)
        if (!result?.ok) {
            entry.state = 'idle'
            const reasons = {
                'invalid-number': 'That number is not valid.',
                'reset-failed': 'I could not clear the previous pairing.',
                'no-socket': 'The WhatsApp socket is not ready. Try again in a moment.',
                'request-failed': 'WhatsApp refused the pairing request.'
            }
            await sendMessage(userId, [
                '❌ Pairing failed.',
                '',
                reasons[result?.reason] || 'The pairing request could not be completed.',
                '',
                'Send /pair to try again.'
            ].join('\n'))
            return
        }
        entry.state = 'awaiting_code'
        entry.code = String(result.code || '')
        // The code is whatever Baileys produced. It is never invented.
        await sendMessage(userId, pairingCard(result.code))
    } catch (error) {
        entry.state = 'idle'
        // Full detail to the panel log; only a clean sentence to the user.
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

async function handleNumber(userId, text) {
    const phone = normalizePhone(text)
    if (!phone) {
        await sendMessage(userId, '❌ That is not a valid WhatsApp number.\n\nSend it as digits in international format, e.g. 2547XXXXXXXX, or /cancel.')
        return
    }
    await pairNow(userId, phone, false)
}

async function handleUnpair(userId, confirmed) {
    const entry = flow(userId)
    const info = bot.sessionInfo()
    if (!info.exists) {
        await sendMessage(userId, 'ℹ️ There is no pairing to remove.', { reply_markup: START_KEYBOARD })
        return
    }
    if (!confirmed) {
        entry.state = 'awaiting_unpair_confirm'
        await sendMessage(userId, [
            '⚠️ *REMOVE THE PAIRING?*',
            '',
            sessionLine(),
            '',
            'The bot will stop working and the WhatsApp account must be linked again from scratch.',
            '',
            'To go ahead, send:',
            '`/unpair confirm`'
        ].join('\n'))
        return
    }
    /*
     * Removing the credentials only takes effect on the next start: the live
     * socket still holds the session in memory. That is stated plainly rather
     * than pretending the bot has already disconnected.
     */
    const removal = bot.removeSession()
    if (!removal?.ok) {
        await sendMessage(userId, `❌ I could not remove the pairing: ${scrub(removal?.error || 'unknown error')}`)
        return
    }
    entry.state = 'idle'
    await sendMessage(userId, [
        '🧹 *PAIRING REMOVED*',
        '',
        'The stored session has been deleted.',
        '',
        'The bot keeps running on the current socket until it restarts — after that it will need a new /pair.'
    ].join('\n'), { reply_markup: START_KEYBOARD })
}

/* ------------------------------- handlers -------------------------------- */

async function routeCommand(userId, text) {
    const raw = String(text || '').trim()
    const command = raw.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '')
    const arg = raw.split(/\s+/)[1]?.toLowerCase() || ''
    const entry = flow(userId)

    if (command === '/start' || command === '/help') {
        await sendMessage(userId, WELCOME, { reply_markup: START_KEYBOARD })
        return true
    }
    if (command === '/pair') {
        // `/pair <number>` pairs directly; `/pair confirm` completes a replacement.
        if (arg === 'confirm') {
            if (entry.state !== 'awaiting_confirm' || !entry.phone) {
                await sendMessage(userId, 'Nothing is waiting for confirmation.\n\nSend /pair to start.')
                return true
            }
            const phone = entry.phone
            entry.phone = ''
            await pairNow(userId, phone, true)
            return true
        }
        const inline = String(raw).split(/\s+/).slice(1).join(' ')
        if (inline) {
            await handleNumber(userId, inline)
            return true
        }
        await handlePairRequest(userId)
        return true
    }
    if (command === '/status') {
        await sendStatus(userId)
        return true
    }
    /*
     * Reports the caller's own Telegram id.
     *
     * Needed because locking pairing down requires knowing that id, and there is
     * no other way to find it. It only ever reveals the CALLER's id - never
     * another user's - so it cannot be used to enumerate anything.
     */
    if (command === '/whoami') {
        const owner = ownerId()
        await sendMessage(userId, [
            '*YOUR TELEGRAM ID*',
            '',
            `\`${userId}\``,
            '',
            owner === null
                ? 'Pairing is currently OPEN — anyone who finds this bot can pair a number to it.'
                : `Pairing is locked to \`${owner}\`.`,
            '',
            'To lock it to yourself, set this in config.json:',
            '`telegram.ownerId` → `' + userId + '`'
        ].join('\n'))
        return true
    }
    if (command === '/unpair') {
        if (!isOwner(userId)) {
            await sendMessage(userId, '🔒 Restricted to the owner of this bot.')
            return true
        }
        await handleUnpair(userId, arg === 'confirm')
        return true
    }
    if (command === '/cancel') {
        if (entry) { entry.state = 'idle'; entry.phone = '' }
        await sendMessage(userId, 'Cancelled.', { reply_markup: START_KEYBOARD })
        return true
    }
    if (command.startsWith('/')) {
        await sendMessage(userId, 'Unknown command.\n\nStart with /start', { reply_markup: START_KEYBOARD })
        return true
    }

    // Free text only means something mid-flow.
    if (entry?.state === 'awaiting_number') {
        await handleNumber(userId, raw)
        return true
    }
    if (entry?.state === 'awaiting_confirm') {
        await sendMessage(userId, 'Send `/pair confirm` to replace the current pairing, or /cancel to keep it.')
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
        // A pairing code must never be posted where another person can read it.
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
             * 401 means the token is wrong or revoked. Retrying forever would spin
             * against a server that keeps refusing, so the controller stops and
             * says exactly what to fix.
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
 * Start the controller.
 *
 * Safe to call more than once - the second call is a no-op, so a WhatsApp
 * reconnect can never spawn a second Telegram poller.
 *
 * @param {{ bot?: object }} options  the index.js session/pairing API
 */
async function start(options = {}) {
    if (options.bot) bot = options.bot
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

    /*
     * Warn loudly when pairing is open, because in that state anyone who finds
     * the bot can link their own WhatsApp to it and take it over. Usable by
     * default, but never silently insecure.
     */
    if (ownerId() === null) {
        console.warn('[TELEGRAM] pairing is OPEN to any Telegram user. Send /whoami to the bot, then set config.json -> telegram.ownerId to lock it to yourself.')
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
    return true
}

function statusText() {
    const connection = bot ? bot.connectionState() : { state: 'DISCONNECTED' }
    return [
        '*TELEGRAM CONTROLLER*',
        `Bot: @${botUsername || 'not connected'}`,
        `Polling: ${polling ? 'RUNNING' : 'STOPPED'}`,
        `Token: ${tokenFingerprint || (token() ? 'not verified' : 'not set')}`,
        `Mode: ${mode()}`,
        bot ? sessionLine() : 'Session: unavailable',
        `WhatsApp: ${connection.state}`,
        conflicts
            ? `⚠️ Token conflicts: ${conflicts} (another bot instance is polling this token — updates are interrupted)`
            : 'Token conflicts: none'
    ].join('\n')
}

module.exports = {
    start,
    stop,
    statusText,
    sendMessage,
    sendStatus,
    normalizePhone,
    scrub,
    routeCommand,
    handleUpdate,
    handlePairRequest,
    handleUnpair,
    sessionLine,
    mode,
    isOwner,
    flows
}
