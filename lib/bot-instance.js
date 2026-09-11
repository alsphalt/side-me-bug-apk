'use strict'

/*
 * DARKNOTE — BOT INSTANCE FACTORY
 * -------------------------------
 * Everything that has to happen per WhatsApp socket, in one place, so the bot
 * can run MANY sessions without the setup logic being copied (and drifting).
 *
 *   index.js        starts the primary session ("main" -> auth/)
 *   session-runner  starts every session paired from Telegram
 *
 * Both call createBotInstance(), so a session paired from Telegram gets exactly
 * the same command system, antidelete, anti-feature and AI handlers as the
 * original one.
 *
 * ISOLATION RULES
 *
 *   - One messages.upsert listener and one connection.update listener PER SOCKET,
 *     registered once here and never again. Reconnecting builds a new socket with
 *     a new set of listeners; the old socket is closed and its listeners die with
 *     it. That is what keeps a reconnect from producing duplicate replies.
 *
 *   - Runtime state, reconnect timers, presence intervals and connection flags
 *     are all keyed by session id, so one session can never mark another idle.
 *
 *   - BIGBRO's dispatcher already takes `conn` as an argument, so commands and
 *     AI replies are naturally scoped to the socket that received the message.
 */

const { Boom } = require('@hapi/boom')
const { useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys')
const pino = require('pino')

// Same modules index.js has always used - the factory exists so multi-session
// setup cannot drift from the original single-session setup.
const { smsg, makeWASocket: makeWASocketSimple, bind } = require('./msg.js')
const { lookupStickerCommand } = require('./sticker-commands.js')
const runtimeMonitor = require('./runtime.js')
const config = require('../config.json')
const handleMessage = require('../BIGBRO.js')
const { bindDeleteEvents, captureMessage, handleIncomingProtocolDeletion } = require('./antidelete.js')

const PRESENCE_INTERVAL_MS = 5 * 60 * 1000

/**
 * Create and fully wire one bot instance.
 *
 * @param {object} options
 *   sessionId      stable id used for all runtime state ('main', 's2', ...)
 *   authDir        the multi-file auth directory for this session
 *   requestCode    (conn, phone) => Promise<code>   used only for console pairing
 *   pairingOwner   () => 'telegram' | 'console'
 *   consolePairing true to allow the interactive stdin prompt (main session only)
 *   primary        true only for the main session
 *   onOpen/onClose optional hooks
 */
async function createBotInstance(options) {
    const {
        sessionId,
        authDir,
        requestCode,
        pairingOwner = () => 'console',
        consolePairing = false,
        primary = false,
        onOpen,
        onClose
    } = options

    if (!sessionId) throw new Error('createBotInstance requires a sessionId')
    if (!authDir) throw new Error('createBotInstance requires an authDir')

    runtimeMonitor.markConnecting('opening socket', sessionId)
    const { state, saveCreds } = await useMultiFileAuthState(authDir)

    const conn = makeWASocketSimple({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Safari'),
        auth: state
    })

    // Per-socket connection flag. Helpers read `conn.__darknoteConnectionState`,
    // so it must live on the socket rather than in a module variable - otherwise
    // one session's close would tell every other session it was offline.
    conn.__darknoteSessionId = sessionId
    conn.__darknoteConnectionState = 'connecting'

    // Claim THIS session's slot only. Another session's socket is untouched.
    runtimeMonitor.register(conn, sessionId)

    bind(conn)
    bindDeleteEvents(conn)

    /* ---------------------------- presence ---------------------------- */

    let presenceTimer = null
    const startPresenceUpdates = () => {
        if (presenceTimer) return
        presenceTimer = setInterval(async () => {
            try {
                if (conn.__darknoteConnectionState === 'open' && typeof conn.sendPresenceUpdate === 'function') {
                    await conn.sendPresenceUpdate('available')
                }
            } catch { /* presence is cosmetic; never fatal */ }
        }, PRESENCE_INTERVAL_MS)
        if (typeof presenceTimer.unref === 'function') presenceTimer.unref()
    }
    const stopPresenceUpdates = () => {
        if (!presenceTimer) return
        clearInterval(presenceTimer)
        presenceTimer = null
    }

    /* -------------------------- connection ---------------------------- */

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'close') {
            conn.__darknoteConnectionState = 'closed'
            stopPresenceUpdates()
            /*
             * Only clear the slot if THIS socket still owns it. A stale socket
             * closing after a newer one opened must not unregister the new one.
             */
            if (runtimeMonitor.currentSocket(sessionId) === conn) runtimeMonitor.unregister(sessionId)

            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const reason = lastDisconnect?.error?.message || `status ${statusCode ?? 'unknown'}`
            runtimeMonitor.markClosed(statusCode, reason, sessionId)
            runtimeMonitor.noteError(lastDisconnect?.error || reason, sessionId)

            if (runtimeMonitor.isRecoverable(statusCode, sessionId)) {
                // One timer per session, exponential backoff, never sooner than 2s.
                const delay = runtimeMonitor.scheduleReconnect(() => {
                    if (typeof onClose === 'function') onClose('reconnect')
                }, sessionId)
                console.log(`[${sessionId}] connection closed (${reason}). Reconnecting in ${delay ? Math.round(delay / 1000) + 's' : 'n/a'}.`)
            } else {
                console.log(`[${sessionId}] 🔒 logged out. Automatic reconnect is disabled until it is paired again.`)
                if (typeof onClose === 'function') onClose('logged-out')
            }
            return
        }

        if (connection === 'open') {
            conn.__darknoteConnectionState = 'open'
            runtimeMonitor.markOpen(sessionId)
            runtimeMonitor.cancelReconnect(sessionId)
            startPresenceUpdates()
            console.log(`[${sessionId}] ✅ connected to WhatsApp`)

            /*
             * Scheduler restore and presence cycling are GLOBAL modules holding a
             * single pending-task set and a single interval, so they run for the
             * primary session only. Running them per session would duplicate
             * scheduled group actions. Documented as a limitation.
             */
            if (primary) {
                try {
                    const aiService = require('../ai/index.js')
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
            }

            if (typeof onOpen === 'function') onOpen()
        }
    })

    /* --------------------------- pairing ------------------------------ */

    if (!state.creds.registered) {
        if (pairingOwner() === 'telegram') {
            console.log(`[${sessionId}] not paired — waiting for a Telegram /pair request`)
        } else if (consolePairing) {
            // The original interactive flow, for the primary session when no
            // Telegram controller is available.
            const question = require('readline').createInterface({ input: process.stdin, output: process.stdout })
            const ask = prompt => new Promise(resolve => question.question(prompt, resolve))
            console.log('\n🔗 DARKNOTE L2 WhatsApp Linking')
            console.log('Enter the WhatsApp number that you want to link to this bot.')
            console.log('Use international format without + or spaces. Example: 2547XXXXXXXX')
            let phoneNumber = ''
            while (!phoneNumber) {
                const entered = await ask('📱 WhatsApp number: ')
                phoneNumber = String(entered || '').replace(/\D/g, '')
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
                console.log('════════════════════════════════════\n')
            } catch (error) {
                console.error('❌ Failed to request the WhatsApp pairing code:', error)
                runtimeMonitor.fatal('WhatsApp pairing code could not be requested', error)
                throw error
            } finally {
                question.close()
            }
        } else {
            console.log(`[${sessionId}] not paired — waiting for a pairing request`)
        }
    }

    /* ------------------------- message pipeline ------------------------ */

    /*
     * The ONE messages.upsert listener for this socket. Every message-derived
     * feature hangs off it - there is no second listener anywhere in the project.
     */
    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let m = chatUpdate.messages[0]
            if (!m.message) return
            runtimeMonitor.noteActivity(sessionId)

            if (m.key?.remoteJid === 'status@broadcast') {
                // Status automation stays inside this listener; its action queue
                // enforces the 10-second human-like interval.
                try { handleMessage.enqueueStatusAutomation(conn, m) } catch (error) {
                    console.error('❌ Status automation enqueue error:', error?.message || error)
                }
                return
            }

            // Revoke packets that arrive as protocolMessage through upsert, so
            // antidelete stays compatible without another listener.
            try {
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

            if (config.autoread) {
                try { await conn.readMessages([m.key]) } catch (error) {
                    console.error('❌ Autoread failed:', error?.message || error)
                }
            }

            try { handleMessage.recordGroupActivity(processedMsg) } catch (error) {
                console.error('❌ Group activity tracking error:', error?.message || error)
            }

            try {
                const { handleAntiLink } = require('./protected-antilink.js')
                if (await handleAntiLink(conn, processedMsg)) return
            } catch (error) {
                console.error('❌ AntiLink integration error:', error?.stack || error)
            }

            if (typeof handleMessage.handleAutomaticViewOnce === 'function') {
                await handleMessage.handleAutomaticViewOnce(conn, m)
            }

            // Sticker triggers use the same central dispatcher. An explicit
            // caption command always wins, so nothing executes twice.
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

    /** Tear this instance down without touching any other session. */
    const stop = () => {
        stopPresenceUpdates()
        runtimeMonitor.cancelReconnect(sessionId)
        try {
            if (runtimeMonitor.currentSocket(sessionId) === conn) runtimeMonitor.unregister(sessionId)
            if (typeof conn.end === 'function') conn.end(new Error('instance stopped'))
            else if (typeof conn.ws?.close === 'function') conn.ws.close()
        } catch (error) {
            console.error(`[${sessionId}] stop failed:`, error?.message || error)
        }
    }

    return { conn, state, stop, sessionId, isRegistered: () => state.creds.registered === true }
}

module.exports = { createBotInstance }
