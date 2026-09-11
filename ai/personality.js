'use strict'

/*
 * DARKNOTE AI — personality and prompt assembly.
 *
 * THE CENTRAL CONSTRAINT. Most providers on this platform reject any prompt
 * above 302 characters (a measured GATEWAY limit, see config.js). So the persona
 * cannot be a long system prompt. The prompt is built from a PRIORITY LIST of
 * very short fragments, and a fragment is only included if it still fits. The
 * user's actual message is reserved first and is never dropped.
 *
 * The budget is now dynamic: when a message is long enough that only the
 * high-limit provider can serve it, the caller passes a bigger budget and the
 * conversation summary plus recent history become affordable. Short messages
 * keep the tight budget so they stay servable by every provider.
 *
 * Priority (highest first):
 *   1. the user's message itself        (mandatory, reserved first)
 *   2. natural-person style line
 *   3. language / style directive
 *   4. AI disclosure (only when asked)
 *   5. "do not repeat yourself" (only for explain-differently)
 *   6. quoted-message context
 *   7. stored facts about the user
 *   8. rolling conversation summary
 *   9. the previous exchange
 *  10. emoji guidance
 *  11. detail allowance for genuinely long questions
 *
 * Nothing here invents context. A fragment with no data is simply absent.
 */

const language = require('./language')
const timing = require('./timing')

/*
 * The identity line is deliberate. Without it, a provider will happily sign
 * itself "As an AI language model" or name its own backend, which breaks the
 * requirement that users experience ONE assistant called DARKNOTE and never see
 * which API answered. It is one short line because the prompt budget is tight.
 */
const CORE = 'You are DARKNOTE. Chat naturally, match their tone and length.'
const DETAIL_OK = 'They asked something involved, so a fuller answer is fine.'
const AI_HONEST = 'You are DARKNOTE, an AI assistant. Be honest about that.'

const ASKS_IDENTITY = /\b(who are you|what are you|are you (?:a )?(?:human|real|person|bot|robot|ai)|are you real|we\s+ni\s+nani|unaitwa nani|ni\s+nani)\b/i

/** Collapse to a single clean line, optionally capped with an ellipsis. */
function oneLine(value, max = 400) {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    if (text.length <= max) return text
    return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Assemble a prompt that is guaranteed to fit the given budget.
 * Returns { prompt, length, budget, overBudget, included, dropped, ... }.
 */
function buildPrompt(context, settings, options = {}) {
    const budget = Math.max(80, Math.min(
        Number(options.budget) || Number(settings?.promptBudget) || 296,
        Number(settings?.longPromptBudget) || 880
    ))

    const message = oneLine(context?.message, 1200)
    const lang = language.detect(message)
    const kind = timing.classify(message)
    const emoji = language.emojiLevel(message)

    const speaker = context?.speaker ? String(context.speaker).split(/[\s(]/)[0].slice(0, 18) : ''
    const useLanguage = context?.useLanguage !== false
    const useEmoji = context?.useEmoji !== false

    // Reserve room for the mandatory line. This is a bigger share for a big
    // budget, so a long message keeps most of its own text.
    const messageCap = Math.max(40, Math.floor(budget * 0.6))
    let trimmedMessage = message
    if (trimmedMessage.length > messageCap) trimmedMessage = `${trimmedMessage.slice(0, messageCap - 1).trimEnd()}…`
    const label = `${speaker || 'User'}: `
    const messageLine = `${label}${trimmedMessage}`
    const promptLine = messageLine.length <= budget
        ? messageLine
        : `${label}${message.slice(0, Math.max(1, budget - label.length - 1)).trimEnd()}…`

    const facts = context?.factsLine || ''
    const quoted = context?.quoted ? oneLine(context.quoted, 70) : ''
    const summary = context?.summary ? oneLine(context.summary, 110) : ''
    const lastUser = context?.lastUser ? oneLine(context.lastUser, 44) : ''
    const lastAssistant = context?.lastAssistant ? oneLine(context.lastAssistant, 44) : ''
    const noRepeat = context?.noRepeat ? oneLine(context.noRepeat, 60) : ''

    const candidates = [
        CORE,
        useLanguage ? lang.instruction : '',
        ASKS_IDENTITY.test(message) ? AI_HONEST : '',
        noRepeat ? `They want it explained differently. Do NOT repeat: "${noRepeat}"` : '',
        quoted ? `They replied to: "${quoted}"` : '',
        context?.silenceNote ? oneLine(context.silenceNote, 58) : '',
        facts,
        summary ? `So far: ${summary}` : '',
        (lastUser && lastAssistant) ? `Earlier they said "${lastUser}" and you said "${lastAssistant}"` : '',
        (useEmoji && emoji.level === 'heavy') ? 'Match their emoji energy.' : '',
        kind === 'long' ? DETAIL_OK : ''
    ].filter(Boolean)

    let room = budget - promptLine.length - 1
    const kept = []
    const dropped = []
    for (const candidate of candidates) {
        if (candidate.length + 1 > room) { dropped.push(candidate); continue }
        kept.push(candidate)
        room -= candidate.length + 1
    }

    const prompt = kept.length ? `${kept.join('\n')}\n${promptLine}` : promptLine

    return {
        prompt,
        length: prompt.length,
        budget,
        overBudget: prompt.length > budget,
        messageTruncated: trimmedMessage !== message,
        language: lang.code,
        languageLabel: lang.label,
        kind,
        emojiLevel: emoji.level,
        included: kept.length,
        dropped: dropped.length
    }
}

/** A stable, friendly display name for the typing indicator. */
function displayName() {
    return 'DARKNOTE'
}

/**
 * Prompt used to build a rolling summary of older turns.
 * Deliberately tiny, because the summary must itself fit in a prompt later.
 */
function summaryPrompt(existingSummary, lines) {
    const body = [
        existingSummary ? `Existing summary: ${existingSummary}` : '',
        lines.join(' | ')
    ].filter(Boolean).join('\n')
    return `Summarise this chat in under 100 characters, facts only, no preamble:\n${body}`
}

module.exports = { buildPrompt, oneLine, displayName, summaryPrompt, CORE, ASKING_IDENTITY: ASKS_IDENTITY }
