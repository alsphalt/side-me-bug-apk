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

let reconnectTimeout = null
let isReconnecting = false

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
    if (isReconnecting) return
    isReconnecting = true

    const { state, saveCreds } = await useMultiFileAuthState('auth')

    const conn = makeWASocketSimple({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Safari'),
        auth: state
    })

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
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log('Connection closed. Reconnecting:', shouldReconnect)

            if (shouldReconnect) {
                if (reconnectTimeout) clearTimeout(reconnectTimeout)

                reconnectTimeout = setTimeout(() => {
                    isReconnecting = false
                    connectToWhatsApp().catch((error) => console.error('❌ Reconnect failed:', error))
                }, 5000)
            } else {
                console.log('🔒 Logged out. Automatic reconnect is disabled.')
                isReconnecting = false
            }
        } else if (connection === 'open') {
            connectionState = 'open'
            conn.__darknoteConnectionState = 'open'
            console.log('✅ Connected to WhatsApp')
            startPresenceUpdates()
            isReconnecting = false

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

            if (reconnectTimeout) clearTimeout(reconnectTimeout)
        }
    })

    if (!state.creds.registered) {
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
            // The installed Baileys fork (levvleys) accepts a custom pairing code
            // as the second argument of requestPairingCode() and this companion
            // asserts it during the link_code_companion_reg handshake, so the
            // code shown here is the one the phone must be given. The phone's
            // entry field takes 8 characters, hence the fixed length.
            // Override with config.json -> "pairingCode"; defaults to DARKNOTE.
            const requested = String(config.pairingCode || 'DARKNOTE').replace(/\s+/g, '').slice(0, 8).toUpperCase() || 'DARKNOTE'
            await new Promise(resolve => setTimeout(resolve, 3000))
            const code = await conn.requestPairingCode(phoneNumber, requested)
            console.log('\n════════════════════════════════════')
            console.log(`🔐 DARKNOTE PAIRING CODE: ${code}`)
            console.log('Open WhatsApp → Linked Devices → Link a device → Link with phone number.')
            console.log('Enter the code shown above on the phone you want to link.')
            console.log('════════════════════════════════════\n')
        } catch (error) {
            console.error('❌ Failed to request the WhatsApp pairing code:', error)
            isReconnecting = false
            throw error
        }
    }

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let m = chatUpdate.messages[0]
            if (!m.message) return
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

connectToWhatsApp()