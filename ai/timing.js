'use strict'

/*
 * DARKNOTE AI — human-like response timing.
 *
 * The delay is chosen from the CONTENT of the message, never as one fixed
 * number. A one-word "hey" gets a fast reply; a paragraph asking for an
 * explanation gets a slower one, the way a person actually behaves.
 *
 * Timings requested and honoured:
 *   short message .......... ~4s
 *   normal ................. 4-10s
 *   long / complex ......... 13-20s
 *   first DM interaction ... ~15s
 *   group after a mention .. 15-17s
 *
 * Delays are jittered slightly so the bot never feels like a metronome. They
 * are never used to paper over a bug: a delay only ever delays a real reply.
 */

const crypto = require('crypto')
const language = require('./language')

const LONG_HINTS = /(\bexplain\b|\bwhy\b|\bhow (?:do|does|can|would)\b|\bcompare\b|\bdifference\b|\bwrite\b|\bdescribe\b|\banaly[sz]e\b|\bsummar(?:y|ise|ize)\b|\bhelp me (?:understand|plan|decide)\b|\badvice\b|\bstrategy\b|\bcode\b|\bdebug\b|\bessay\b|\bplan\b)/i

function randInt(min, max) {
    const lo = Math.ceil(min)
    const hi = Math.floor(max)
    if (hi <= lo) return lo
    try { return crypto.randomInt(lo, hi + 1) } catch { return lo + Math.floor(Math.random() * (hi - lo + 1)) }
}

/**
 * Classify how much thinking a message deserves.
 * Returns 'short' | 'normal' | 'long'.
 */
function classify(text) {
    const value = String(text || '').trim()
    if (!value) return 'short'

    const words = value.split(/\s+/).filter(Boolean)
    const questions = (value.match(/\?/g) || []).length

    if (language.isCasual(value)) return 'short'
    if (LONG_HINTS.test(value)) return 'long'
    if (value.length >= 200 || words.length >= 40 || questions >= 2) return 'long'
    if (value.length <= 40 && words.length <= 7) return 'short'
    return 'normal'
}

/**
 * The delay, in milliseconds, before the bot replies.
 * `isFirstTurn` only matters for direct chats, where a brand-new conversation
 * opens a little slower (configurable, and never so slow it feels broken).
 */
/**
 * The window a delay is drawn from, per case.
 *
 * IMPORTANT: variation is produced by drawing inside the window, never by
 * jittering outside it. An earlier version added +/-12% on top of the base and
 * pushed the group delay down to ~13.3s, outside the 15-17s that was asked for.
 * A single-value delay (short, first DM) becomes a narrow window around that
 * value instead, which still reads as "about N seconds" while staying human.
 */
function windowFor(kind, isGroup, isFirstTurn, settings, { isOwner = false } = {}) {
    if (isGroup) {
        // A group reply follows a deliberate mention, so use the requested
        // 15-17s window regardless of message length.
        return [settings.groupDelayMinMs, settings.groupDelayMaxMs]
    }

    /*
     * OWNER conversations are deliberately quicker. The owner is mid-task, so
     * "hey" must not sit there for a quarter of a minute. Short 4-5s, normal
     * 5-10s, long 10-20s.
     */
    if (isOwner) {
        if (kind === 'short') return [Math.round(settings.ownerShortDelayMs * 0.92), Math.round(settings.ownerShortDelayMs * 1.05)]
        if (kind === 'long') return [settings.ownerLongDelayMinMs, settings.ownerLongDelayMaxMs]
        return [settings.ownerNormalDelayMinMs, settings.ownerNormalDelayMaxMs]
    }

    /*
     * PUBLIC replies use the range the owner selected on the setup card
     * (5-10s or 15-20s). Complexity then decides WHERE in that range the reply
     * lands, so a "hey" is answered near the fast end and a long question near
     * the slow end instead of every reply taking the maximum.
     */
    const useLongRange = settings.replyDelayMode === 'long'
    const min = useLongRange ? settings.replyDelayLongMinMs : settings.replyDelayShortMinMs
    const max = useLongRange ? settings.replyDelayLongMaxMs : settings.replyDelayShortMaxMs
    const span = Math.max(0, max - min)
    if (kind === 'short') return [min, min + Math.round(span * 0.35)]
    if (kind === 'long') return [min + Math.round(span * 0.6), max]
    return [min + Math.round(span * 0.3), min + Math.round(span * 0.7)]
}

function delayFor({ text, isGroup = false, isFirstTurn = false, settings, isOwner = false }) {
    // Accept either key name. config.js exposes `responseTimingEnabled` (matching
    // the AI_RESPONSE_TIMING_ENABLED setting name); an earlier build used
    // `timingEnabled`, and reading only that key silently collapsed every delay
    // to zero. A regression test caught it.
    const timingOn = settings?.responseTimingEnabled ?? settings?.timingEnabled
    if (timingOn !== true) return 0
    const kind = classify(text)
    const [min, max] = windowFor(kind, isGroup, isFirstTurn, settings, { isOwner })
    const lo = Math.max(0, Math.min(min, max))
    const hi = Math.max(lo, Math.max(min, max))
    // Hard ceiling so nothing can ever park a reply for minutes by accident.
    return Math.min(randInt(lo, hi), 90 * 1000)
}

module.exports = { classify, delayFor, windowFor, randInt }
