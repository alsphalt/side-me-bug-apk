/*
 * DARKNOTE L2 LICENSE
 * Free to use and modify.
 * Please keep this credit notice in redistributed versions.
 * © DARKNOTE L2 • Bigbrother
 */
const fs = require('fs')
const path = require('path')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidNormalizedUser } = require('@whiskeysockets/baileys')
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const readline = require('readline')
const { smsg, makeWASocket: makeWASocketSimple, bind } = require('./lib/msg.js')
const config = require('./config.json')
const { lookupStickerCommand } = require('./lib/sticker-commands.js')
const { captureMessage, handleIncomingProtocolDeletion, bindDeleteEvents } = require('./lib/antidelete.js')
// The single anti-feature security engine. One engine, one participant listener.
const security = require('./lib/security.js')

let handleMessage = require('./BIGBRO.js')
const groupFeatures = require('./lib/group-features.js')

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

const question = (text) => new Promise((resolve) => rl.question(text, resolve))

/*
 * RUNTIME ALIVE owns the socket lifecycle: one socket, one reconnect timer with
 * backoff, honest connection state, crash guards. See lib/runtime.js.
 */
const runtimeMonitor = require('./lib/runtime.js')
let telegram = null
try {
    telegram = require('./lib/telegram.js')
} catch (error) {
    console.error('[TELEGRAM] controller could not be loaded:', error?.message || error)
}

const sessionStore = require('./lib/session.js')

runtimeMonitor.installGuards()
runtimeMonitor.startMonitor()

/*
 * WHO OWNS PAIRING.
 *
 * 'console'  - the original blocking prompt on stdin (default, unchanged).
 * 'telegram' - the Telegram controller drives it; the console prompt is skipped
 *              so startup is never blocked waiting on input nobody can see.
 *
 * Set from startTelegram() when the controller reports it is online.
 */
let pairingOwner = 'console'

/**
 * Ask WhatsApp for a pairing code on an OPEN socket.
 *
 * Split out because both the console flow and the Telegram /pair flow need the
 * identical request - one implementation, so the two can never drift apart.
 */
async function requestCode(conn, phone) {
    if (!conn || typeof conn.requestPairingCode !== 'function') {
        throw new Error('this socket cannot request a pairing code')
    }
    const requested = String(config.pairingCode || 'DARKNOTE').replace(/\s+/g, '').slice(0, 8).toUpperCase() || 'DARKNOTE'
    // The handshake needs the socket to be fully open before it will accept the
    // request; asking too early is the usual cause of a silent failure.
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
        if (conn.ws?.readyState === 1 || conn.__darknoteConnectionState === 'open') break
        await new Promise(resolve => setTimeout(resolve, 300))
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
    return conn.requestPairingCode(phone, requested)
}

/** Wait until a live socket exists, so pairing never races startup. */
async function waitForSocket(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const conn = runtimeMonitor.currentSocket()
        if (conn) return conn
        await new Promise(resolve => setTimeout(resolve, 300))
    }
    return null
}

/**
 * Pair a number, reusing the bot's ONE socket.
 *
 * No second socket is ever created here. When an existing pairing has to be
 * replaced the current socket is closed and the session folder is deleted, then
 * the normal startup path builds a fresh unregistered socket - which, because
 * `pairingOwner` is 'telegram', skips the console prompt and waits to be asked
 * for a code. The code is then requested on that same socket.
 *
 * Returns { ok, code } or { ok: false, reason } - never throws, so the Telegram
 * controller can always report something honest.
 */
async function pairSession(phone) {
    const digits = String(phone || '').replace(/\D/g, '')
    if (!/^\d{8,15}$/.test(digits)) return { ok: false, reason: 'invalid-number' }

    const replacing = sessionStore.isRegistered()
    try {
        if (replacing) {
            console.log('[SESSION] replacing the existing pairing as requested from Telegram')
            const current = runtimeMonitor.currentSocket()
            if (current) {
                runtimeMonitor.unregister(current)
                // Flagged BEFORE end(), because the close event can fire before
                // the next line runs.
                current.__darknoteRetired = true
                current.__darknoteConnectionState = 'closed'
                try {
                    if (typeof current.end === 'function') current.end(new Error('pairing replaced'))
                    else if (typeof current.ws?.close === 'function') current.ws.close()
                } catch (error) {
                    console.error('[SESSION] could not close the old socket:', error?.message || error)
                }
            }
            runtimeMonitor.cancelReconnect()
            const cleared = sessionStore.reset()
            if (!cleared.ok) return { ok: false, reason: 'reset-failed' }

            // Let the startup path rebuild an unregistered socket.
            connectInFlight = false
            connectToWhatsApp().catch(error =>
                console.error('❌ Connect after re-pair failed:', error?.message || error))
        }

        const conn = await waitForSocket()
        if (!conn) return { ok: false, reason: 'no-socket' }

        const code = await requestCode(conn, digits)
        console.log(`[SESSION] pairing code issued for +${digits}`)
        return { ok: true, code: String(code || ''), replaced: replacing }
    } catch (error) {
        console.error('[SESSION] pairing failed:', error?.stack || error)
        return { ok: false, reason: 'request-failed', detail: error?.message || String(error) }
    }
}

/*
 * What the Telegram controller is allowed to do with the session. Passed in
 * explicitly rather than having telegram.js require this file, which would be a
 * circular import and would let a second copy of the socket logic exist.
 */
const botApi = {
    sessionInfo: () => sessionStore.info(),
    isRegistered: () => sessionStore.isRegistered(),
    describe: () => sessionStore.describe(),
    pair: phone => pairSession(phone),
    // Deletes the stored credentials only. The live socket keeps the session in
    // memory until the next start, which is exactly what telegram.js tells the
    // user rather than implying an immediate disconnect.
    removeSession: () => sessionStore.reset(),
    connectionState: () => runtimeMonitor.telegramState(),
    setPairingOwner: owner => { pairingOwner = owner === 'telegram' ? 'telegram' : 'console' },
    pairingOwner: () => pairingOwner
}

/** Start the Telegram controller, letting it own pairing when it comes online. */
async function startTelegram() {
    if (!telegram) return
    try {
        const result = await telegram.start({ bot: botApi })
        // Only hand pairing to Telegram once it has proved it is actually online.
        // Otherwise a broken token would leave the bot with no way to pair at all.
        if (result?.ok) {
            const changed = botApi.pairingOwner() !== 'telegram'
            botApi.setPairingOwner('telegram')
            // Logged once, not on every reconnect.
            if (changed) console.log('[SESSION] pairing is now handled from Telegram (/pair)')
        } else {
            console.log(`[SESSION] Telegram unavailable (${result?.reason || 'unknown'}); console pairing stays active`)
        }
    } catch (error) {
        console.error('[TELEGRAM] start failed:', error?.message || error)
    }
}

/*
 * Guards against two concurrent connect attempts. The runtime also closes a
 * superseded socket, so this is belt-and-braces rather than the only defence.
 */
let connectInFlight = false

function reload(file) {
    const filePath = path.resolve(file)

    fs.watchFile(filePath, () => {
        fs.unwatchFile(filePath)
        console.log(`Reloaded: ${file}`)

        delete require.cache[require.resolve(file)]

        try {
            if (file.includes('BIGBRO.js')) {
                handleMessage = require('./BIGBRO.js')
            } else if (file.includes('msg.js')) {
                delete require.cache[require.resolve('./lib/msg.js')]
                const msg = require('./lib/msg.js')
                global.smsg = msg.smsg
                global.bind = msg.bind
            }

            reload(file)
        } catch (err) {
            console.log(`❌ Error reload ${file}:`, err)
        }
    })
}

reload('./BIGBRO.js')
reload('./lib/msg.js')

async function connectToWhatsApp() {
    if (connectInFlight) {
        console.log('[RUNTIME] a connect is already in progress; duplicate ignored')
        return
    }
    connectInFlight = true
    try {
        await startSocket()
    } finally {
        connectInFlight = false
    }
}

async function startSocket() {
    runtimeMonitor.markConnecting('opening socket')
    const { state, saveCreds } = await useMultiFileAuthState('auth')

    const conn = makeWASocketSimple({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Safari'),
        auth: state
    })

    /*
     * Claim the single socket slot. If a previous socket somehow survived, it is
     * closed here BEFORE this one is used, which is what prevents two live
     * WhatsApp connections on one session (duplicate replies, duplicate
     * receipts, and eventually a forced logout).
     */
    runtimeMonitor.register(conn)

    bind(conn)
    bindDeleteEvents(conn)

    /*
     * THE ONLY group-participants.update listener in the project.
     *
     * antidemote / antikick / antiadd / antipromote are NOT separate listeners -
     * they are rows in lib/security.js and this single event funnels into that
     * one engine, so a single change of group membership can never produce two
     * warnings, two kicks or two restores.
     */
    if (!conn.__darknoteSecurityBound && conn.ev?.on) {
        conn.__darknoteSecurityBound = true
        conn.ev.on('group-participants.update', async (update) => {
            try {
                const results = await security.handleParticipants(conn, update, {
                    selfIds: [conn.user?.id, conn.user?.lid].filter(Boolean)
                })
                for (const result of results || []) {
                    console.log(`[SECURITY] ${result.feature} -> ${result.performed.join('+')} (strike ${result.strike})${result.restored === false ? ' restore refused' : result.restored ? ' restored' : ''}`)
                }
            } catch (error) {
                console.error('[SECURITY] participant handling failed:', error?.stack || error)
            }
        })
    }

    // Shared lifecycle flag used by helper code. No helper may attempt a
    // presence request until this socket reports connection='open'.
    conn.__darknoteConnectionState = 'connecting'

    // Keep the paired DARKNOTE account visibly online, but only while the
    // current socket is actually open. This avoids the startup race where the
    // first presence update was sent before WhatsApp finished opening.
    let connectionState = 'connecting'
    const socketReady = () => {
        if (connectionState !== 'open' || conn.__darknoteConnectionState !== 'open') return false
        const readyState = conn.ws?.readyState
        return readyState === undefined || readyState === 1
    }
    const setDarknoteOnline = async () => {
        if (!socketReady()) return false
        try {
            await conn.sendPresenceUpdate('available')
            return true
        } catch (error) {
            // A socket can close between the readiness check and the request.
            // Treat that known lifecycle race as a skipped presence update,
            // not as a bot error. Other failures remain visible in the panel.
            const message = String(error?.message || error || '')
            if (!socketReady() || /connection\s+closed|socket\s+closed/i.test(message)) return false
            console.error('❌ Presence update failed:', message)
            return false
        }
    }
    const startPresenceUpdates = () => {
        if (conn.__darknotePresenceInterval) return
        void setDarknoteOnline()
        conn.__darknotePresenceInterval = setInterval(() => { void setDarknoteOnline() }, 20000)
    }
    const stopPresenceUpdates = () => {
        if (conn.__darknotePresenceInterval) {
            clearInterval(conn.__darknotePresenceInterval)
            conn.__darknotePresenceInterval = null
        }
    }


    // Presence is cached for listonline. This does not create another message
    // pipeline; it only records WhatsApp's presence.update events.
    conn.ev.on('presence.update', (update) => {
        try { groupFeatures.cachePresence(conn, update) } catch (error) { console.error('❌ Presence cache error:', error?.message || error) }
    })

    conn.ev.on('call', async (calls) => {
        if (!config.anticall || !Array.isArray(calls)) return
        for (const call of calls) {
            try {
                if (call?.status === 'offer' && call?.id && call?.from) {
                    await conn.rejectCall(call.id, call.from)
                    console.log(`📵 DARKNOTE rejected incoming call from ${call.from}`)
                }
            } catch (error) {
                console.error('❌ AntiCall error:', error?.stack || error)
            }
        }
    })


    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'close') {
            connectionState = 'closed'
            conn.__darknoteConnectionState = 'closed'
            stopPresenceUpdates()

            /*
             * RETIRED SOCKET — do not reconnect.
             *
             * When a pairing is replaced the old socket is closed ON PURPOSE, and
             * its close event fires asynchronously - AFTER the replacement has
             * already asked for a cancel. Without this flag that late close
             * scheduled a fresh reconnect for a session that had just been
             * cleared, producing a second unregistered socket racing the new
             * pairing. That is exactly the duplicate-connection situation the
             * single-socket rule exists to prevent.
             */
            if (conn.__darknoteRetired) {
                console.log('Old socket retired for re-pairing; no reconnect scheduled.')
                return
            }
            // Only THIS socket may clear the shared flag. A stale socket closing
            // after a newer one opened must not tell helpers the bot is offline.
            if (runtimeMonitor.currentSocket() === conn) runtimeMonitor.unregister(conn)
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const reason = lastDisconnect?.error?.message || `status ${statusCode ?? 'unknown'}`
            runtimeMonitor.markClosed(statusCode, reason)
            runtimeMonitor.noteError(lastDisconnect?.error || reason)

            if (runtimeMonitor.isRecoverable(statusCode)) {
                // One timer, exponential backoff, never sooner than 2s: a dead
                // network cannot become a tight reconnect loop.
                const delay = runtimeMonitor.scheduleReconnect(() =>
                    connectToWhatsApp().catch((error) => console.error('❌ Reconnect failed:', error?.message || error))
                )
                console.log(`Connection closed (${reason}). Reconnecting in ${delay ? Math.round(delay / 1000) + 's' : 'n/a'}.`)
            } else {
                console.log('🔒 Logged out. Automatic reconnect is disabled until the session is paired again.')
            }
        } else if (connection === 'open') {
            connectionState = 'open'
            conn.__darknoteConnectionState = 'open'
            console.log('✅ Connected to WhatsApp')
            runtimeMonitor.markOpen()
            runtimeMonitor.cancelReconnect()
            startPresenceUpdates()

            // Restore anything the previous run left scheduled. Done once the
            // socket is genuinely open, because every restore sends a presence
            // update or a group setting change.
            try {
                const aiService = require('./ai/index.js')
                aiService.scheduler.restore((task) => {
                    if (String(task.id).startsWith('grouptoggle:')) {
                        aiService.grouptimer.restore(conn, [task]).catch(error => {
                            console.error('[SCHEDULER] group restore failed:', error?.message || error)
                        })
                    }
                })
                aiService.presence.resume(conn)
            } catch (error) {
                console.error('❌ Could not restore AI schedules:', error?.message || error)
            }

            /*
             * The controller is already running (started before the first
             * connect, so it could own pairing). Calling start() again is
             * idempotent and returns "already-running", which keeps a reconnect
             * from ever spawning a second Telegram poller - it is only here to
             * recover a controller that failed at boot.
             */
            startTelegram()
        }
    })

    /*
     * PAIRING.
     *
     * Exactly one of two paths runs:
     *
     *   - Telegram is driving pairing (`pairingOwner === 'telegram'`). The console
     *     prompt is SKIPPED, because a blocking readline prompt would hold up
     *     startup and nobody would see it in a panel. This socket is left open and
     *     unregistered, and Telegram asks for a code on it when /pair arrives.
     *
     *   - Nothing else is driving it, so the original console flow runs unchanged.
     *
     * Only one socket ever exists for `auth/`, so Telegram pairing and the console
     * flow can never fight over the same session.
     */
    if (!state.creds.registered) {
        if (pairingOwner === 'telegram') {
            console.log('[SESSION] not paired — waiting for a Telegram /pair request')
        } else {
            console.log('\n🔗 DARKNOTE L2 WhatsApp Linking')
            console.log('Enter the WhatsApp number that you want to link to this bot.')
            console.log('Use international format without + or spaces. Example: 2547XXXXXXXX')

            let phoneNumber = ''
            while (!phoneNumber) {
                const enteredNumber = await question('📱 WhatsApp number: ')
                phoneNumber = String(enteredNumber || '').replace(/\D/g, '')

                if (!/^\d{8,15}$/.test(phoneNumber)) {
                    console.log('❌ Invalid number. Enter 8–15 digits in international format.')
                    phoneNumber = ''
                }
            }

            try {
                const code = await requestCode(conn, phoneNumber)
                console.log('\n════════════════════════════════════')
                console.log(`🔐 DARKNOTE PAIRING CODE: ${code}`)
                console.log('Open WhatsApp → Linked Devices → Link a device → Link with phone number.')
                console.log('Enter the code shown above on the phone you want to link.')
                console.log('════════════════════════════════════\n')
            } catch (error) {
                console.error('❌ Failed to request the WhatsApp pairing code:', error)
                // The session is unusable and retrying would loop forever against a
                // server that keeps refusing, so this is the fatal path: report the
                // real cause and let the panel supervisor restart the process.
                runtimeMonitor.fatal('WhatsApp pairing code could not be requested', error)
                throw error
            }
        }
    }

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let m = chatUpdate.messages[0]
            if (!m.message) return
            // Feeds the Runtime Alive "last activity" figure. Cheap, and the only
            // thing it affects is the health line.
            runtimeMonitor.noteActivity()
            if (m.key?.remoteJid === 'status@broadcast') {
                // Status automation intentionally stays inside the existing
                // messages.upsert listener. The action queue enforces the
                // requested 10-second human-like interval.
                try { handleMessage.enqueueStatusAutomation(conn, m) } catch (error) {
                    console.error('❌ Status automation enqueue error:', error?.message || error)
                }
                return
            }

            // Retain only content actually received by this exact session when
            // one of the persistent antidelete modes is enabled. This stays in
            // the existing single messages.upsert pipeline.
            try {
                // Some Baileys forks surface WhatsApp revoke packets as a
                // protocolMessage through the existing upsert pipeline rather
                // than emitting messages.update. Handle that packet here so
                // antidelete remains compatible without adding another
                // messages.upsert listener.
                await handleIncomingProtocolDeletion(conn, m)
            } catch (error) {
                console.error('❌ Antidelete revoke detection error:', error?.message || error)
            }

            try { await captureMessage(conn, m) } catch (error) {
                console.error('❌ Antidelete retention error:', error?.message || error)
            }

            let processedMsg
            try {
                processedMsg = await smsg(conn, m)
            } catch (err) {
                console.error('❌ smsg error:', err.message)
                return
            }

            if (!processedMsg) return
            processedMsg.__darknoteConn = conn

            // Auto read receipts - toggled with `.autoread on|off`.
            if (config.autoread) {
                try { await conn.readMessages([m.key]) } catch (error) {
                    console.error('❌ Autoread failed:', error?.message || error)
                }
            }

            // Record one daily message count per group member for listactive
            // and listinactive. Bot/self messages are excluded by the helper.
            try { handleMessage.recordGroupActivity(processedMsg) } catch (error) {
                console.error('❌ Group activity tracking error:', error?.message || error)
            }

            // AntiLink remains inside the existing single messages.upsert pipeline.
            try {
                const { handleAntiLink } = require('./lib/protected-antilink.js')
                if (await handleAntiLink(conn, processedMsg)) return
            } catch (error) {
                console.error('❌ AntiLink integration error:', error?.stack || error)
            }

            if (typeof handleMessage.handleAutomaticViewOnce === 'function') {
                await handleMessage.handleAutomaticViewOnce(conn, m)
            }

            // Sticker triggers use the same central command dispatcher. An
            // explicit caption command on a sticker always wins over a sticker
            // trigger, so a configured sticker never causes double execution.
            if (!processedMsg.fromMe && processedMsg.mtype === 'stickerMessage') {
                const explicit = String(processedMsg.text || '').trim()
                const hasExplicitCommand = explicit.startsWith(config.prefix || '.')
                if (!hasExplicitCommand) {
                    const trigger = await lookupStickerCommand(processedMsg, conn)
                    if (trigger?.command) {
                        processedMsg.__darknoteSyntheticCommand = `${config.prefix || '.'}${trigger.command}`
                        await handleMessage(conn, processedMsg)
                        return
                    }
                }
            }

            // Auto presence - toggled with `.autotyping on|off` / `.autorecoding on|off`.
            // Sent around the handler so the indicator is on screen exactly while
            // the bot is building its reply, then cleared again.
            const presence = config.autorecoding ? 'recording' : (config.autotyping ? 'composing' : '')
            if (presence) {
                try { await conn.sendPresenceUpdate(presence, processedMsg.chat) } catch (error) {
                    console.error('❌ Presence update failed:', error?.message || error)
                }
            }

            await handleMessage(conn, processedMsg)

            if (presence) {
                try { await conn.sendPresenceUpdate('paused', processedMsg.chat) } catch (error) {
                    console.error('❌ Presence reset failed:', error?.message || error)
                }
            }
        } catch (err) {
            console.error('❌ messages.upsert error:', err)
        }
    })


    conn.ev.on('creds.update', saveCreds)
}

/*
 * BOOT ORDER MATTERS.
 *
 * The Telegram controller is started FIRST, so that when the socket reaches its
 * pairing branch it already knows whether Telegram owns pairing. Starting it
 * afterwards would mean an unpaired bot dropped into the blocking console
 * prompt and Telegram /pair could never be reached.
 *
 * If Telegram cannot start (no token, rejected token), pairingOwner stays
 * 'console' and the original pairing flow runs exactly as before.
 */
;(async () => {
    await startTelegram()
    connectToWhatsApp().catch(error => {
        console.error('❌ Initial connect failed:', error?.message || error)
    })
})()