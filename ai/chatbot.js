'use strict'

/*
 * DARKNOTE AI — chatbot orchestrator.
 *
 * The ONLY place that decides whether the bot speaks on its own. Called from the
 * existing central dispatcher, after the command path has already declined the
 * message, so it can never intercept a registered command, no second
 * messages.upsert listener exists, and exactly one path can answer a message.
 *
 * Turn pipeline:
 *   gate -> rate limit -> build context (summary + facts + last turn)
 *        -> route to the best provider, with fallback
 *        -> typing held throughout, always cleared
 *        -> reply -> remember -> maybe summarise in the background
 *
 * Rules implemented:
 *   DM      : answer any non-command message while the chatbot is ON
 *   Group   : answer ONLY on real WhatsApp mention metadata, or the explicit
 *             `darknote` trigger
 *   Combine : messages sent close together become ONE reply (toggleable)
 *   Repeats : a repeated question is served by a DIFFERENT provider
 *   Explain : "explain again" never repeats the previous wording
 *   Errors  : never crash, never leak a stack trace, always clear typing
 */

const config = require('./config')
const provider = require('./provider')
const memory = require('./memory')
const personality = require('./personality')
const timing = require('./timing')
const ratelimit = require('./ratelimit')
const reactions = require('./reactions')
const objectives = require('./objectives')
const owner = require('./owner')
// Aliased: `state` is already the name of this file's presence argument.
const convState = require('./state')
const safety = require('./safety')
const scheduler = require('./scheduler')
const language = require('./language')

/* A bare acknowledgement. These do not always deserve a written answer. */
const SHORT_ACK = /^(ok|okay|k|kk|alright|aight|sawa|sawa sawa|poa|freshi|👍|👌|yes|yeah|yep|no|nah|nope|sure|fine|cool|noted|nice|haha|hehe|lol|thanks|thank you|asante|bye|goodnight|good night)[\s!.,?]*$/i

const VIBES = [
    { vibe: 'joking', re: /\b(lol|lmao|haha|hehe|funny|joke|kicheko|🤣|😂|prank)\b/i },
    { vibe: 'sad', re: /\b(sad|depressed|heartbroken|grief|died|passed away|msiba|crying|😭|😢|💔|lonely)\b/i },
    { vibe: 'angry', re: /\b(angry|furious|pissed|annoyed|mad at|hate|f+u+c+k+|stupid|nimekasirika)\b/i },
    { vibe: 'stressed', re: /\b(stressed|overwhelmed|anxious|worried|exhausted|nimechoka|pressure|deadline)\b/i },
    { vibe: 'excited', re: /\b(excited|can'?t wait|amazing|awesome|finally|🎉|🔥|so good)\b/i },
    { vibe: 'romantic', re: /\b(love you|i love|miss you|my love|nakupenda|babe|sweetheart)\b/i },
    { vibe: 'confused', re: /\b(confused|don'?t understand|sielewi|lost|makes no sense|huh)\b/i },
    { vibe: 'serious', re: /\b(serious|important|urgent|must|need to|deadline|emergency)\b/i }
]

/** Coarse mood of a message, used to keep the reply in key. */
function vibeOf(text) {
    const value = String(text || '')
    for (const entry of VIBES) if (entry.re.test(value)) return entry.vibe
    return 'casual'
}

function isShortAck(text) {
    return SHORT_ACK.test(String(text || '').trim())
}

/** A light, in-key emoji for acknowledging a bare "ok" without writing a reply. */
function ackEmoji(vibe) {
    switch (vibe) {
        case 'joking': return '😂'
        case 'sad': return '❤️'
        case 'excited': return '🔥'
        case 'stressed': return '🫂'
        case 'angry': return '🫂'
        case 'confused': return '🤔'
        default: return '👍'
    }
}

/**
 * After the AI replies, the person may simply go quiet. Once the configured
 * chatbot delay passes, ONE natural continuation is sent - only once, only in a
 * public DM, and only if the last message in the conversation is still the AI's.
 * A user reply cancels it, which is why the pending flag is cleared on every
 * incoming message.
 */
function followUpWindow(settings) {
    return settings.chatbotDelayMode === 'long' ? settings.chatbotDelayLongMs : settings.chatbotDelayShortMs
}

async function followUpText(record, settings) {
    const context = [
        record.topic ? `topic: ${record.topic}` : '',
        record.lastUserText ? `they said: ${String(record.lastUserText).slice(0, 60)}` : '',
        record.lastAiText ? `you said: ${String(record.lastAiText).slice(0, 60)}` : ''
    ].filter(Boolean).join(' | ')
    const prompt = `You are DARKNOTE. The person went quiet mid-conversation. Send ONE short natural follow-up. No greeting, no "are you there", under 90 chars. Context: ${context}`
    try {
        const result = await provider.ask(prompt, settings, { objective: objectives.OBJECTIVES.CASUAL })
        if (result.ok && result.answer) return String(result.answer).replace(/\s+/g, ' ').slice(0, 200)
    } catch (error) {
        logErr('follow-up generation failed:', error?.message || error)
    }
    return 'Looks like you are busy 😅 no rush.'
}

function scheduleFollowUp(conn, batch, stateKey, settings) {
    if (!stateKey) return
    // Owner conversations and groups are never nudged: the owner is mid-task,
    // and in a group an unprompted message would look like spam.
    if (batch.isOwner || batch.isGroup) return
    if (!settings.chatbotEnabled) return
    const max = Number(settings.followUpMaxPerSilence) || 0
    if (max <= 0) return
    if (convState.get(stateKey).followUpCount >= max) return

    const wait = followUpWindow(settings)
    const id = `followup:${stateKey}`
    scheduler.cancel(id)
    scheduler.schedule(id, wait, async () => {
        try {
            const record = convState.get(stateKey)
            if (!record.pendingSince) return          // they replied; nothing to do
            if (record.followUpCount >= max) return   // never repeatedly
            convState.markFollowUp(stateKey)
            const text = await followUpText(record, settings)
            if (settings.typingEnabled) {
                presence(conn, batch.chat, 'composing')
                await new Promise(r => setTimeout(r, 1200))
                presence(conn, batch.chat, 'paused')
            }
            await conn.sendMessage(batch.chat, { text }, {}).catch(() => { })
            log(`${stateKey}: sent a follow-up after ${Math.round(wait / 1000)}s of silence`)
        } catch (error) {
            logErr('follow-up failed:', error?.message || error)
        }
    }, { meta: { stateKey }, persistent: false, kind: 'followup' })
    log(`${stateKey}: follow-up armed for ${Math.round(wait / 1000)}s`)
}

/** Did this message arrive after a long silence? Used to resume the topic. */
function silenceNoteFor(stateKey, settings) {
    const record = convState.get(stateKey)
    if (!record.lastAiAt) return ''
    const gap = Date.now() - record.lastAiAt
    if (gap < settings.longSilenceMs) return ''
    const hours = Math.round(gap / (60 * 60 * 1000))
    return `They were gone about ${hours}h. Pick the old topic back up naturally.`
}

const MAX_TYPING_MS = 90 * 1000
const LONG_BUDGET_THRESHOLD = 200

const batches = new Map()             // batchId -> batch
const openByConversation = new Map()  // conversation key -> batchId (merge target)

/* --------------------------------- helpers ------------------------------- */

const log = (...args) => console.log('[AI]', ...args)
const logErr = (...args) => console.error('[AI]', ...args)

/** Real WhatsApp mention metadata, not a text search for the word. */
function mentionedJids(m) {
    const direct = m?.mentionedJid
    if (Array.isArray(direct) && direct.length) return direct
    const contexts = [
        m?.msg?.contextInfo,
        m?.message?.extendedTextMessage?.contextInfo,
        m?.message?.imageMessage?.contextInfo,
        m?.message?.videoMessage?.contextInfo,
        m?.message?.documentMessage?.contextInfo,
        m?.message?.audioMessage?.contextInfo
    ]
    for (const ctx of contexts) {
        const list = ctx?.mentionedJid
        if (Array.isArray(list) && list.length) return list
    }
    return []
}

/** All identifiers that mean "this bot", so a mention matches whichever is used. */
function selfIdentifiers(conn) {
    const out = new Set()
    for (const value of [conn?.user?.id, conn?.user?.lid, conn?.user?.jid, conn?.user?.phoneNumber, conn?.user?.LID]) {
        if (!value) continue
        const bare = String(value).split('@')[0].split(':')[0].replace(/\D/g, '')
        if (bare) out.add(bare)
    }
    return out
}

function isBotMentioned(conn, m) {
    const mentions = mentionedJids(m)
    if (!mentions.length) return false
    const self = selfIdentifiers(conn)
    if (!self.size) return false
    for (const jid of mentions) {
        const bare = String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '')
        if (bare && self.has(bare)) return true
    }
    return false
}

function hasExplicitTrigger(text) {
    return /^darknote\b/i.test(String(text || '').trim())
}

function stripTrigger(text) {
    return String(text || '').trim().replace(/^darknote\b[,:]?\s*/i, '').trim()
}

function speakerName(conn, m) {
    const candidates = [
        m?.pushName,
        m?.verifiedName,
        conn?.contacts?.[m?.sender]?.notify,
        conn?.contacts?.[String(m?.sender || '').split('@')[0]]?.notify
    ]
    for (const value of candidates) {
        const name = String(value || '').replace(/[\r\n]+/g, ' ').trim()
        if (name) return name.slice(0, 24)
    }
    return ''
}

function quotedText(m) {
    const quoted = m?.quoted
    if (!quoted) return ''
    const text = quoted.text || quoted.caption || ''
    if (text) return String(text)
    if (quoted.mtype) return `[${String(quoted.mtype).replace(/Message$/, '')}]`
    return ''
}

/* ------------------------------ eligibility ------------------------------ */

/**
 * Decide whether this message should reach the chatbot at all.
 * Never mutates anything; safe to call speculatively.
 */
function evaluate(conn, m, context = {}) {
    const settings = config.getAiSettings()

    /*
     * OWNER AI IS A SEPARATE CAPABILITY, checked BEFORE the public switches.
     * The paired account can always talk to DARKNOTE, even with the public
     * chatbot off. Identity comes from the live session (conn.user), never from
     * a config value, so a forged or stale number cannot promote anyone.
     */
    const ownerTurn = owner.isSessionOwner(conn, m)
    if (!settings.chatbotEnabled && !ownerTurn) return { ok: false, reason: 'chatbot-off' }
    if (!m) return { ok: false, reason: 'no-message' }
    if (m.fromMe) return { ok: false, reason: 'from-me' }
    if (m.key?.remoteJid === 'status@broadcast') return { ok: false, reason: 'status' }
    if (String(m.mtype || '').toLowerCase() === 'protocolmessage') return { ok: false, reason: 'protocol' }

    const chat = String(m.chat || '')
    if (!chat || chat === 'status@broadcast') return { ok: false, reason: 'no-chat' }

    const text = String(m.text || '').trim()
    const isGroup = m.isGroup === true || chat.endsWith('@g.us')

    // STRICT CHAT ALLOWLIST. Only a real person or a real group may talk to the
    // bot. A newsletter (@newsletter) is a one-way broadcast channel, and
    // broadcast lists / other system JIDs are not conversations at all.
    // Live testing caught the bot auto-replying inside a newsletter.
    if (!isGroup && !/@(s\.whatsapp\.net|lid)$/i.test(chat)) {
        return { ok: false, reason: 'non-person-chat' }
    }

    // Self mode keeps the existing rule: only the owner may trigger anything.
    // An owner turn is always allowed, because owner AI is its own capability.
    if (context.mode === 'self' && !context.isOwner && !ownerTurn) return { ok: false, reason: 'self-mode' }

    if (isGroup) {
        if (!settings.groupEnabled) return { ok: false, reason: 'group-disabled' }
        const mentioned = isBotMentioned(conn, m)
        const explicit = hasExplicitTrigger(text)
        // Groups always require a real mention or the explicit trigger, for the
        // owner too: otherwise the bot would answer everything the owner says
        // inside a group.
        if (!mentioned && !explicit) return { ok: false, reason: 'group-not-mentioned' }
        if (!text && !quotedText(m)) return { ok: false, reason: 'empty' }
        return { ok: true, kind: 'group', owner: ownerTurn, text: explicit && !mentioned ? stripTrigger(text) || quotedText(m) : text, mentioned, explicit }
    }

    // DM: the public switch gates normal users, never the paired owner.
    if (!settings.dmEnabled && !ownerTurn) return { ok: false, reason: 'dm-disabled' }
    if (!text && !quotedText(m)) return { ok: false, reason: 'empty' }
    return { ok: true, kind: 'dm', owner: ownerTurn, text: text || quotedText(m), mentioned: false, explicit: false }
}

/* -------------------------------- presence ------------------------------- */

function presence(conn, chat, state) {
    try {
        if (typeof conn?.sendPresenceUpdate !== 'function') return
        if (conn.__darknoteConnectionState && conn.__darknoteConnectionState !== 'open') return
        Promise.resolve(conn.sendPresenceUpdate(state, chat)).catch(() => { })
    } catch { }
}

/* ---------------------------------- batch -------------------------------- */

function conversationKey(m) {
    const chat = String(m.chat || '')
    if (m.isGroup || chat.endsWith('@g.us')) return `g:${chat}`
    return `d:${chat}`
}

let batchSeq = 0

/**
 * Queue an eligible message. When combining is on, messages that arrive close
 * together are merged and answered ONCE, which is what stops duplicate replies
 * to "what do you think" followed immediately by "about this?".
 */
function enqueue(conn, m, context = {}) {
    const settings = config.getAiSettings()
    const convKey = conversationKey(m)
    const combine = settings.combineEnabled !== false

    if (combine) {
        const openId = openByConversation.get(convKey)
        const existing = openId ? batches.get(openId) : null
        if (existing) {
            const text = String(m.text || '').trim()
            if (text) existing.parts.push({ text, speaker: speakerName(conn, m), quoted: quotedText(m), at: Date.now() })
            existing.lastMessage = m
            log(`merged into pending batch (${existing.parts.length} parts) for ${convKey}`)
            return { ok: true, code: 'MERGED' }
        }
    }

    const isGroup = m.isGroup === true || String(m.chat || '').endsWith('@g.us')
    const sessionKey = memory.sessionKey(m)
    const isFirstTurn = !memory.hasHistory(sessionKey)
    // Owner conversations use the shorter owner windows; public replies use the
    // range selected on the setup card.
    const isOwner = owner.isSessionOwner(conn, m)
    const delay = timing.delayFor({ text: m.text, isGroup, isFirstTurn, settings, isOwner })

    const id = `b${++batchSeq}`
    const batch = {
        id,
        chat: m.chat,
        convKey,
        sessionKey,
        anchor: m,
        lastMessage: m,
        isGroup,
        isOwner,
        context,
        isFirstTurn,
        parts: [{ text: String(m.text || '').trim(), speaker: speakerName(conn, m), quoted: quotedText(m), at: Date.now() }],
        timer: null,
        typingTimer: null,
        typingStop: 0,
        typingStopped: false,
        startedAt: Date.now()
    }
    batches.set(id, batch)
    openByConversation.set(convKey, id)

    log(`${isGroup ? 'GROUP' : (isOwner ? 'OWNER-DM' : 'DM')} accepted for ${convKey} | kind=${timing.classify(m.text)} | delay=${Math.round(delay / 100) / 10}s | firstTurn=${isFirstTurn}`)

    if (settings.typingEnabled) {
        presence(conn, batch.chat, 'composing')
        batch.typingStop = Date.now() + MAX_TYPING_MS
        batch.typingTimer = setInterval(() => {
            if (Date.now() > batch.typingStop) { clearInterval(batch.typingTimer); return }
            presence(conn, batch.chat, 'composing')
        }, 8000)
        if (typeof batch.typingTimer.unref === 'function') batch.typingTimer.unref()
    }

    batch.timer = setTimeout(() => { void flush(conn, id) }, delay)
    if (typeof batch.timer.unref === 'function') batch.timer.unref()
    return { ok: true, code: 'QUEUED', delay }
}

/**
 * Clear the typing indicator. Idempotent: the success path and the finally
 * block both call this, and sending "paused" twice is noise on the wire.
 */
function stopTyping(conn, batch, settings) {
    try {
        if (!batch) return
        if (batch.typingTimer) { clearInterval(batch.typingTimer); batch.typingTimer = null }
        if (batch.typingStopped) return
        batch.typingStopped = true
        if (settings?.typingEnabled && batch.chat) presence(conn, batch.chat, 'paused')
    } catch { }
}

function releaseBatch(batch) {
    batches.delete(batch.id)
    if (openByConversation.get(batch.convKey) === batch.id) openByConversation.delete(batch.convKey)
}

async function send(conn, batch, text, options = {}) {
    const value = String(text || '').trim()
    if (!value) return false
    const settings = config.getAiSettings()
    const capped = value.length > settings.maxReplyChars
        ? `${value.slice(0, settings.maxReplyChars).trimEnd()}…`
        : value
    await conn.sendMessage(batch.chat, { text: capped }, { quoted: batch.anchor, ...options })
    return true
}

/**
 * Build the prompt for this batch, choosing a budget wide enough to keep the
 * whole question. A long question can only be served by the high-limit
 * provider, which is why the caller falls back to the tight budget when the
 * router reports that no provider can take the wide prompt.
 */
function buildFor(conn, batch, settings, session, budget) {
    const combined = batch.parts.map(p => p.text).filter(Boolean).join(' ').trim()
    const capped = combined.length > settings.maxMessageChars ? combined.slice(0, settings.maxMessageChars) : combined
    const lastTurn = session.turnsList?.[session.turnsList.length - 1]
    const speaker = batch.parts.find(p => p.speaker)?.speaker || ''
    const quoted = settings.replyContextEnabled === false ? '' : (batch.parts.find(p => p.quoted)?.quoted || '')
    const repeat = memory.isRepeat(batch.sessionKey, capped, settings)
    const differently = memory.isExplainDifferently(capped)

    const built = personality.buildPrompt({
        message: capped,
        speaker: settings.nameEnabled === false ? '' : speaker,
        quoted,
        factsLine: settings.memoryEnabled ? memory.factsLine(session) : '',
        summary: settings.memoryEnabled ? session.summary : '',
        lastUser: settings.memoryEnabled ? (lastTurn?.u || '') : '',
        lastAssistant: settings.memoryEnabled ? (lastTurn?.a || '') : '',
        noRepeat: differently ? memory.previousAnswer(batch.sessionKey) : '',
        silenceNote: silenceNoteFor(convState.keyFor(batch.anchor), settings),
        useLanguage: settings.languageEnabled !== false,
        useEmoji: settings.emojiEnabled !== false
    }, settings, { budget })

    return { built, capped, repeat, differently }
}

/* ---------------------------------- flush -------------------------------- */

/** Answer a batch. Any failure here is contained; the bot itself must survive. */
async function flush(conn, batchId) {
    const batch = batches.get(batchId)
    if (!batch) return
    releaseBatch(batch)

    const settings = config.getAiSettings()
    try { if (batch.timer) clearTimeout(batch.timer) } catch { }

    const token = ratelimit.beginInFlight(batch.convKey)
    if (!token) {
        stopTyping(conn, batch, settings)
        log(`skipped ${batch.convKey}: another reply is already in flight`)
        return
    }

    try {
        const combinedText = batch.parts.map(p => p.text).filter(Boolean).join(' ').trim()
        const stateKey = convState.keyFor(batch.anchor)

        /* --- conversation state ------------------------------------------- */
        if (stateKey) {
            const detected = language.detect(combinedText)
            convState.noteUser(batch.anchor, combinedText, { language: detected.code, vibe: vibeOf(combinedText) })
            if (convState.get(stateKey).blocked) {
                stopTyping(conn, batch, settings)
                log(`${stateKey} is blocked from the AI; staying silent`)
                return
            }
        }

        /* --- abuse safety, its own escalation independent of moderation ---- */
        if (stateKey && settings.abuseSafetyEnabled) {
            const verdict = safety.review(combinedText, convState.get(stateKey))
            if (verdict.action !== 'none') {
                convState.noteAbuse(stateKey, { warned: true })
                stopTyping(conn, batch, settings)
                if (verdict.action === 'block') {
                    convState.markBlocked(stateKey, true)
                    try {
                        await conn.updateBlockStatus(batch.anchor.sender, 'block')
                    } catch (error) {
                        logErr('could not apply the WhatsApp block:', error?.message || error)
                    }
                }
                await send(conn, batch, verdict.message).catch(() => { })
                log(`abuse escalation ${verdict.count}/3 -> ${verdict.action} (${verdict.reason})`)
                return
            }
        }

        /*
         * A bare acknowledgement ("ok", "k", "sawa") in an ongoing conversation
         * does not always deserve a written reply. Sometimes a reaction or
         * silence IS the natural answer. Only applies to a single short ack with
         * prior history; anything longer, or with a question, is answered
         * normally.
         */
        if (stateKey && isShortAck(combinedText) && batch.parts.length === 1 && convState.get(stateKey).lastAiAt) {
            const record = convState.get(stateKey)
            const roll = Math.random()
            if (settings.shortAckReaction && roll < 0.45) {
                try {
                    await conn.sendMessage(batch.chat, { react: { text: ackEmoji(record.vibe), key: batch.anchor.key } })
                    convState.noteAssistant(stateKey, '[reacted]', 'none')
                    stopTyping(conn, batch, settings)
                    log(`${stateKey}: short acknowledgement -> reaction only`)
                    return
                } catch (error) {
                    logErr('ack reaction failed, falling through to a reply:', error?.message || error)
                }
            }
            if (settings.shortAckSilence && roll < 0.6) {
                convState.noteAssistant(stateKey, '[stayed silent]', 'none')
                stopTyping(conn, batch, settings)
                log(`${stateKey}: short acknowledgement -> stayed silent`)
                return
            }
        }

        /* --- abuse protection --------------------------------------------- */
        const senderKey = `user:${memory.normalizeNumber(batch.anchor?.sender) || batch.convKey}`
        const userLimit = ratelimit.checkLimit(senderKey, settings.userPerMinute)
        if (!userLimit.allowed) {
            stopTyping(conn, batch, settings)
            log(`rate limited ${senderKey}, retry in ${Math.round(userLimit.retryAfterMs / 1000)}s`)
            await send(conn, batch, 'Slow down a moment, I am still catching up 🙂').catch(() => { })
            return
        }
        if (batch.isGroup) {
            const groupLimit = ratelimit.checkLimit(`group:${batch.chat}`, settings.groupPerMinute)
            if (!groupLimit.allowed) {
                stopTyping(conn, batch, settings)
                log(`rate limited group ${batch.chat}`)
                return
            }
        }

        const sessionKey = batch.sessionKey
        if (!sessionKey) {
            stopTyping(conn, batch, settings)
            logErr('could not resolve an isolated session key; refusing to reply')
            return
        }

        const session = settings.memoryEnabled ? memory.getSession(sessionKey) : { facts: {}, turnsList: [], summary: '' }

        /* --- choose a prompt budget --------------------------------------- */
        const probe = buildFor(conn, batch, settings, session, settings.longPromptBudget)
        const wantsLong = probe.capped.length > LONG_BUDGET_THRESHOLD
        let { built, capped, repeat, differently } = probe

        if (!wantsLong && built.length > settings.promptBudget) {
            // Short question that still overflowed: fall back to the tight budget.
            ;({ built, capped, repeat, differently } = buildFor(conn, batch, settings, session, settings.promptBudget))
        }

        if (built.overBudget) {
            stopTyping(conn, batch, settings)
            logErr(`prompt overflow (${built.length}/${built.budget}) — refusing to send`)
            await send(conn, batch, 'That one is a bit much for me, can you trim it down?').catch(() => { })
            return
        }

        const objective = objectives.detect(capped, { promptLength: built.prompt.length }).objective
        log(`${sessionKey} | lang=${built.language} kind=${built.kind} objective=${objective} prompt=${built.length}/${built.budget} fragments=${built.included} dropped=${built.dropped}${repeat.repeat ? ` REPEAT(${repeat.score})` : ''}${differently ? ' EXPLAIN-DIFFERENTLY' : ''}`)

        /* --- route -------------------------------------------------------- */
        let result
        if (repeat.repeat || differently) {
            // A repeated question, or a request to explain it another way, is
            // deliberately served by a DIFFERENT provider than last time so the
            // wording genuinely changes instead of arriving back identically.
            const why = repeat.repeat ? `repeat (${repeat.score})` : 'explain-differently'
            log(`${why} — asking a different provider than ${session.lastProvider || 'last'}`)
            result = await provider.askDifferent(built.prompt, settings, session.lastProvider, { objective })
            if (result.ok && result.varying === false) log('only one provider was usable, so the same one answered')
        } else {
            result = await provider.ask(built.prompt, settings, { objective })
        }

        // A wide prompt may have no eligible provider (e.g. the only long-context
        // provider is in cooldown). Degrade to the tight budget rather than fail.
        if (!result.ok && result.code === 'NO_PROVIDER' && built.budget > settings.promptBudget) {
            log('no provider for the wide prompt — retrying with the tight budget')
            const tight = buildFor(conn, batch, settings, session, settings.promptBudget)
            built = tight.built
            result = await provider.ask(built.prompt, settings, { objective })
        }

        if (ratelimit.isCancelled(token)) {
            stopTyping(conn, batch, settings)
            log(`${sessionKey}: reply discarded, a newer request superseded it`)
            return
        }

        if (!result.ok) {
            logErr(`routing failed after ${result.attempts} attempt(s): ${result.code} — ${result.reason}`)
            stopTyping(conn, batch, settings)
            await send(conn, batch, provider.userMessageFor(result)).catch(() => { })
            return
        }

        log(`${sessionKey}: answered by ${result.provider}${result.usedFallback ? ' (after fallback)' : ''} in ${result.latencyMs || '?'}ms, ${String(result.answer).length} chars`)

        /* --- optional reaction -------------------------------------------- */
        let reacted = false
        if (settings.reactionsEnabled) {
            const decision = reactions.shouldReact(batch.convKey, capped, settings, { isFirstTurn: batch.isFirstTurn })
            if (decision.react) {
                try {
                    await conn.sendMessage(batch.chat, { react: { text: decision.emoji, key: batch.anchor.key } })
                    reactions.markReacted(batch.convKey)
                    reacted = true
                    log(`reacted with ${decision.emoji}`)
                    // A bare emotional statement can be answered by the reaction alone.
                    if (reactions.reactionIsEnough(capped)) {
                        stopTyping(conn, batch, settings)
                        if (settings.memoryEnabled) memory.recordExchange(sessionKey, { question: capped, answer: `[reacted ${decision.emoji}]`, provider: result.provider, speaker: batch.parts.find(p => p.speaker)?.speaker || '' }, settings)
                        return
                    }
                } catch (error) {
                    logErr('reaction failed (ignored):', error?.message || error)
                }
            }
        }
        if (!reacted) reactions.markReplied(batch.convKey)

        // Stop typing BEFORE the message lands, as required.
        stopTyping(conn, batch, settings)

        const sent = await send(conn, batch, result.answer)
        if (!sent) return

        // Conversation state, then arm the single continuation nudge.
        if (stateKey) {
            convState.noteAssistant(stateKey, result.answer, result.provider, { topic: capped.slice(0, 120) })
            scheduleFollowUp(conn, batch, stateKey, settings)
        }

        if (settings.memoryEnabled) {
            memory.learnFacts(sessionKey, capped, settings)
            memory.recordExchange(sessionKey, {
                question: capped,
                answer: result.answer,
                provider: result.provider,
                speaker: batch.parts.find(p => p.speaker)?.speaker || ''
            }, settings)
            void maybeSummarise(sessionKey, settings)
        }
    } catch (error) {
        // Nothing above may take the bot down, and typing must always stop.
        logErr('chatbot failure:', error?.stack || error)
        stopTyping(conn, batch, settings)
        try { await send(conn, batch, 'Something went wrong on my side there. Try again?') } catch { }
    } finally {
        stopTyping(conn, batch, settings)
        ratelimit.endInFlight(batch.convKey, token)
    }
}

/**
 * Fold old turns into a rolling summary once a conversation gets long enough.
 * Fire-and-forget: a failure here is logged and ignored, never surfaced.
 */
async function maybeSummarise(sessionKey, settings) {
    try {
        if (!settings.memoryEnabled) return
        if (!memory.needsSummary(sessionKey, settings)) return
        const old = memory.turnsToSummarise(sessionKey, settings)
        if (!old.length) return
        const session = memory.getSession(sessionKey)
        const lines = old.slice(-6).map(t => `they: ${String(t.u || '').slice(0, 40)} / you: ${String(t.a || '').slice(0, 40)}`)
        const prompt = personality.summaryPrompt(session.summary, lines)
        const result = await provider.ask(prompt, settings, { objective: objectives.OBJECTIVES.LONG_CONTEXT })
        if (!result.ok) { logErr(`summary skipped: ${result.code}`); return }
        const summary = String(result.answer).replace(/^["'\s]+|["'\s]+$/g, '').slice(0, settings.summaryMaxChars)
        memory.setSummary(sessionKey, summary, settings)
        log(`${sessionKey}: summary updated (${summary.length} chars) via ${result.provider}`)
    } catch (error) {
        logErr('summary failed (ignored):', error?.message || error)
    }
}

/** Cancel and forget every pending batch. Used on shutdown/reconnect. */
function clearAllBatches() {
    for (const [, batch] of batches) {
        try { if (batch.timer) clearTimeout(batch.timer) } catch { }
        try { if (batch.typingTimer) clearInterval(batch.typingTimer) } catch { }
    }
    batches.clear()
    openByConversation.clear()
    return true
}

/** Public entry point used by the dispatcher. */
async function handle(conn, m, context = {}) {
    try {
        const verdict = evaluate(conn, m, context)
        if (!verdict.ok) {
            if (!['chatbot-off', 'group-not-mentioned', 'from-me', 'no-message'].includes(verdict.reason)) {
                log(`ignored ${m?.chat || '?'}: ${verdict.reason}`)
            }
            return verdict
        }
        if (verdict.text && verdict.text !== m.text) m = { ...m, text: verdict.text }
        enqueue(conn, m, context)
        return verdict
    } catch (error) {
        logErr('handle() failed:', error?.message || error)
        return { ok: false, reason: 'exception' }
    }
}

function pendingCount() {
    return batches.size
}

module.exports = {
    handle,
    evaluate,
    enqueue,
    isBotMentioned,
    mentionedJids,
    selfIdentifiers,
    clearAllBatches,
    pendingCount,
    conversationKey
}
