'use strict'

/*
 * DARKNOTE AUTO HUMAN REPLY  (`.autohuman on|off`)
 * ------------------------------------------------
 * The bot continues an EXISTING conversation the way the person would.
 *
 * What makes this different from the existing chatbot:
 *
 *   - It is gated by its OWN switch (`autohumanEnabled`), independent of
 *     `.chatbot`. Turning it on does not turn the public chatbot on, and the
 *     public chatbot being off does not stop it.
 *   - It reads a chronological window of the last ~15 messages from BOTH sides
 *     and continues THAT conversation, instead of answering one message in
 *     isolation.
 *   - It is told, in as many words, that it is a person in this chat and not an
 *     assistant, and its output is checked for assistant/customer-service
 *     phrasing before it is allowed to send.
 *
 * It is deliberately NOT wired to its own listener. The dispatcher calls
 * `handle()` from the existing prefix-free branch - i.e. only AFTER every
 * registered command has been ruled out - so a command can never be answered by
 * the AI. See requirement 6.
 *
 * Context is stored through ai/memory.js, keyed per contact by the existing
 * `sessionKey()`. Nothing is shared between two contacts.
 */

const config = require('./config')
const memory = require('./memory')
const provider = require('./provider')
const objectives = require('./objectives')

/* --------------------------- robotic phrasing ---------------------------- */

/*
 * Requirement 2: these must not appear unless the conversation genuinely calls
 * for them. Matched case-insensitively anywhere in the reply, because models
 * like to append a helper question to an otherwise fine sentence.
 */
const ROBOTIC_PATTERNS = [
    /how (?:can|may) i (?:help|assist|be of (?:help|service))/i,
    /what can i (?:do|get) for you/i,
    /what would you like me to do/i,
    /what do you want me to do/i,
    /is there anything (?:else )?i can (?:help|do)/i,
    /let me know (?:if|how) (?:you need|i can help)/i,
    /how may i (?:assist|help)/i,
    /i(?:'m| am) here to (?:help|assist)/i,
    /feel free to ask/i,
    /let me know if you (?:have any )?(?:questions|need)/i
]

const ASSTYLE = [
    'I am a person in this chat, not an assistant. Never offer help or ask how you can help.',
    'Do not offer assistance and do not ask what they need. Just carry the conversation.',
    'No customer-service phrasing. No "how can I help". Just reply like a friend would.'
]

/* ------------------------------ qualification ---------------------------- */

function enabled(settings) {
    return Boolean((settings || config.getAiSettings()).autohumanEnabled)
}

const conversationKeyOf = m => {
    const chat = String(m?.chat || m?.key?.remoteJid || '')
    if (!chat) return ''
    return memory.sessionKey(m)
}

/**
 * Decide whether this message is one the auto human reply should answer.
 *
 * Every rejection carries a reason so the caller can log WHY it stayed silent -
 * "the bot ignored me" is almost always a rule, and the rule should be findable.
 */
function evaluate(conn, m, context = {}) {
    const settings = config.getAiSettings()
    if (!settings.autohumanEnabled) return { ok: false, reason: 'autohuman-off' }
    if (!m) return { ok: false, reason: 'no-message' }
    if (m.fromMe) return { ok: false, reason: 'from-me' }

    const chat = String(m.chat || m.key?.remoteJid || '')
    if (!chat) return { ok: false, reason: 'no-chat' }
    if (chat === 'status@broadcast') return { ok: false, reason: 'status' }
    if (String(m.mtype || '').toLowerCase() === 'protocolmessage') return { ok: false, reason: 'protocol' }

    const isGroup = m.isGroup === true || chat.endsWith('@g.us')
    const isPerson = !isGroup && /@(s\.whatsapp\.net|lid)$/i.test(chat)
    if (!isGroup && !isPerson) return { ok: false, reason: 'non-person-chat' }

    /*
     * COMMAND PRIORITY (req 6). The dispatcher only reaches the AI when the body
     * did not start with the prefix, but this is checked again here so the rule
     * holds even if the AI is ever called from somewhere else.
     */
    const text = String(m.text || '').trim()
    const prefix = String(context.prefix || config.prefix || '.')
    if (text.startsWith(prefix)) return { ok: false, reason: 'command' }
    if (m.isButtonResponse) return { ok: false, reason: 'button' }
    if (m.__darknoteSyntheticCommand) return { ok: false, reason: 'synthetic-command' }
    if (!text && !m.quotedText) return { ok: false, reason: 'empty' }

    // Self mode: only the owner may drive anything.
    if (context.mode === 'self' && !context.isOwner) return { ok: false, reason: 'self-mode' }

    /*
     * GROUPS REQUIRE A MENTION. Unmentioned group chatter is not a conversation
     * with the bot, and answering all of it is exactly the spammy behaviour the
     * brief warns against.
     */
    if (isGroup) {
        const chatbot = require('./chatbot')
        let mentioned = false
        try { mentioned = chatbot.isBotMentioned(conn, m) } catch { mentioned = false }
        if (!mentioned) return { ok: false, reason: 'group-not-mentioned' }
        return { ok: true, kind: 'group', key: conversationKeyOf(m) }
    }

    return { ok: true, kind: 'dm', key: conversationKeyOf(m) }
}

/* -------------------------------- prompt --------------------------------- */

/*
 * The window is assembled to FIT. Only one provider on this platform accepts a
 * prompt above 302 characters, so the transcript is added newest-first until the
 * budget is exhausted and the oldest lines are dropped. A very chatty thread
 * therefore loses its oldest context rather than breaking the request.
 */
function buildPrompt(settings, lines, m) {
    const budget = Math.max(400, Math.min(Number(settings.longPromptBudget) || 880, 900))
    const name = String(m?.pushName || m?.sender || '').split(/[\s@]/)[0].slice(0, 20) || 'them'

    const head = `You are DARKNOTE, a real person texting ${name} on WhatsApp. Continue THIS conversation in the same vibe, tone, language, slang and emoji level. You are not an assistant. Never offer help, never ask how you can help, never force a question.`
    const tail = 'Reply with ONLY your next message. No name prefix.'

    const fixed = head.length + tail.length + 2
    let room = budget - fixed
    if (room < 40) room = 40

    // Walk the window backwards, keeping the newest lines that fit.
    const kept = []
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        const who = line.who === 'me' ? 'you' : 'them'
        let rendered = `${who}: ${String(line.t || '').replace(/\s+/g, ' ').trim()}`
        if (rendered.length > 90) rendered = `${rendered.slice(0, 89)}…`
        if (rendered.length + 1 > room) break
        kept.push(rendered)
        room -= rendered.length + 1
    }
    kept.reverse()

    const prompt = `${head}\n${kept.join('\n')}\n${tail}`
    return { prompt, included: kept.length, budget, length: prompt.length }
}

/* ----------------------------- output hygiene ---------------------------- */

function roboticHits(text) {
    const value = String(text || '')
    return ROBOTIC_PATTERNS.filter(re => re.test(value))
}

/**
 * Remove assistant/customer-service sentences.
 *
 * Dropping the sentence is preferred to dropping the whole reply: a model often
 * writes a perfectly good continuation and then bolts a helper question onto the
 * end. Only if nothing conversational survives does this return ''.
 */
function sanitise(text) {
    const value = String(text || '').trim()
    if (!value) return ''
    const parts = value.split(/(?<=[.!?…])\s+|\n+/).map(p => p.trim()).filter(Boolean)
    const kept = parts.filter(part => !roboticHits(part).length)
    return (kept.length ? kept.join(' ') : '').trim()
}

/* --------------------------------- timing -------------------------------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

function presence(conn, chat, state) {
    try {
        if (typeof conn?.sendPresenceUpdate !== 'function') return
        // Never send presence on a socket that is not open - that is the
        // startup race the existing helpers already guard against.
        if (conn.__darknoteConnectionState && conn.__darknoteConnectionState !== 'open') return
        Promise.resolve(conn.sendPresenceUpdate(state, chat)).catch(() => { })
    } catch { /* presence is cosmetic; a failure must never break a reply */ }
}

/* -------------------------------- the work ------------------------------- */

/*
 * One in-flight reply per contact. A second message from the same person while
 * the first reply is still being generated must not start a second generation,
 * or the person receives two answers to one thought.
 */
const inFlight = new Map()

async function run(conn, m, settings, key) {
    const chat = String(m.chat)
    const started = Date.now()
    let typingOn = false
    try {
        // 1. MARK AS READ (req 5). Only when configured, and only for a real
        //    person chat where a read receipt is meaningful.
        if (settings.autohumanReadReceipt) {
            try {
                if (typeof conn.readMessages === 'function' && m.key) await conn.readMessages([m.key])
            } catch (error) {
                console.error('[AUTOHUMAN] read receipt failed:', error?.message || error)
            }
        }

        // 2. CONTEXT - the last N messages from both sides, for THIS contact only.
        const lines = memory.recentTranscript(key, settings.autohumanContextMessages)

        // 3. ANALYSE WINDOW (~3s). Deliberately before the request so the
        //    pause is real and the bot is not blocked: this function runs in its
        //    own async task per contact.
        presence(conn, chat, 'composing')
        typingOn = true
        await sleep(settings.autohumanAnalyseMs)

        // 4. GENERATE (~4s floor). The API call happens inside this window; if
        //    it is slower, the real time is used rather than pretending.
        const built = buildPrompt(settings, lines, m)
        const genStart = Date.now()
        let result = await provider.ask(built.prompt, settings, {
            objective: objectives.OBJECTIVES.LONG_CONTEXT,
            originalMessage: m.text
        })
        const genElapsed = Date.now() - genStart
        if (genElapsed < settings.autohumanGenerateMs) await sleep(settings.autohumanGenerateMs - genElapsed)

        if (!result?.ok || !result.answer) {
            // HONEST FAILURE: stop typing, log the real code, send nothing. No
            // fake reply, no silent swallow.
            console.error(`[AUTOHUMAN] generation failed: ${result?.code || 'unknown'} ${result?.reason || ''}`)
            return { ok: false, reason: result?.code || 'generation-failed' }
        }

        // 5. NO ROBOTIC ASSISTANT QUESTIONS (req 2).
        let answer = String(result.answer).trim()
        answer = answer.replace(/^```[\s\S]*?```$/, '').trim()
        if (roboticHits(answer).length) {
            const before = answer
            const repaired = sanitise(answer)
            console.log(`[AUTOHUMAN] robotic phrasing detected, retrying once (${roboticHits(answer).length} hit)`)
            const retry = await provider.ask(
                `${built.prompt}\n\nDo NOT say anything like "${String(before).slice(0, 60)}". ${ASSTYLE[0]}`,
                settings,
                { objective: objectives.OBJECTIVES.LONG_CONTEXT, originalMessage: m.text }
            )
            const retryText = retry?.ok ? String(retry.answer).trim() : ''
            const cleaned = retryText ? sanitise(retryText) : ''
            answer = cleaned || repaired
            if (!answer) {
                // Everything the model produced was assistant-speak. Sending a
                // canned line would be exactly what the brief forbids, so this
                // stays silent and logs the real reason.
                console.error('[AUTOHUMAN] every generated sentence was assistant-style; staying silent rather than sending one.')
                return { ok: false, reason: 'robotic-output' }
            }
        }
        if (answer.length > settings.maxReplyChars) answer = `${answer.slice(0, settings.maxReplyChars).trimEnd()}…`
        if (!answer) return { ok: false, reason: 'empty-answer' }

        // 6. PRE-SEND PAUSE (~2s) so the reply does not land the instant the API
        //    returns. This is what makes the pacing read as human.
        await sleep(settings.autohumanPreSendMs)

        // 7. STOP TYPING, THEN SEND.
        presence(conn, chat, 'paused')
        typingOn = false
        await conn.sendMessage(chat, { text: answer }, { quoted: m })

        /*
         * Record OUR side only.
         *
         * The incoming message was already appended by handle(), BEFORE the
         * prompt was built - that is what puts the message being answered into
         * the context window. Appending it again here stored every incoming
         * message twice, so the 15-message window covered half as much real
         * conversation as it claimed and the prompt budget was spent on
         * duplicates.
         */
        memory.appendTranscript(key, { who: 'me', text: answer }, settings)

        console.log(`[AUTOHUMAN] replied to ${key} in ${Date.now() - started}ms via ${result.provider} (${built.included} msg context)`)
        return { ok: true, provider: result.provider, ms: Date.now() - started }
    } catch (error) {
        // A failure here must never take the bot down.
        console.error('[AUTOHUMAN] failed:', error?.stack || error)
        return { ok: false, reason: 'exception' }
    } finally {
        /*
         * ALWAYS stop the composer, however this turn ended.
         *
         * This lives in `finally` rather than in the success path because the
         * failure paths return EARLY - a provider error or an all-assistant-style
         * answer returns from inside `try` without ever reaching the send step.
         * Stopping typing only on success left "typing..." showing indefinitely,
         * which looks broken to the person waiting.
         */
        if (typingOn) presence(conn, chat, 'paused')
        inFlight.delete(key)
    }
}

/**
 * Public entry point, called by the dispatcher in place of the chatbot when the
 * auto human reply is on.
 *
 * Returns immediately: the reply is produced in a detached task so one slow
 * contact cannot block the message pipeline for everyone else (req 4).
 */
function handle(conn, m, context = {}) {
    let verdict
    try {
        verdict = evaluate(conn, m, context)
    } catch (error) {
        console.error('[AUTOHUMAN] evaluate failed:', error?.message || error)
        return { ok: false, reason: 'exception' }
    }
    if (!verdict.ok) return verdict

    const key = verdict.key
    if (!key) return { ok: false, reason: 'no-session-key' }
    if (inFlight.has(key)) {
        // Already answering this contact: drop the duplicate rather than queue a
        // second reply to the same thought.
        return { ok: false, reason: 'in-flight' }
    }

    const settings = config.getAiSettings()
    inFlight.set(key, Date.now())

    // Record the incoming line BEFORE generating, so it is part of the context
    // the prompt is built from.
    try {
        memory.appendTranscript(key, { who: 'them', text: m.text }, settings)
    } catch (error) {
        console.error('[AUTOHUMAN] transcript append failed:', error?.message || error)
    }

    Promise.resolve()
        .then(() => run(conn, m, settings, key))
        .catch(error => {
            console.error('[AUTOHUMAN] task failed:', error?.stack || error)
            inFlight.delete(key)
        })

    return { ok: true, reason: 'queued', key }
}

function statusText() {
    const settings = config.getAiSettings()
    return [
        '*🗣 AUTO HUMAN REPLY*',
        '',
        `State: ${settings.autohumanEnabled ? 'ON' : 'OFF'}`,
        `Context window: last ${settings.autohumanContextMessages} messages`,
        `Pacing: ${Math.round((settings.autohumanAnalyseMs + settings.autohumanGenerateMs + settings.autohumanPreSendMs) / 1000)}s target (analyse ${settings.autohumanAnalyseMs / 1000}s + generate ${settings.autohumanGenerateMs / 1000}s + pre-send ${settings.autohumanPreSendMs / 1000}s)`,
        `Read receipts: ${settings.autohumanReadReceipt ? 'ON' : 'OFF'}`,
        `In flight: ${inFlight.size}`
    ].join('\n')
}

module.exports = {
    enabled,
    evaluate,
    handle,
    statusText,
    buildPrompt,
    sanitise,
    roboticHits,
    inFlightCount: () => inFlight.size
}
