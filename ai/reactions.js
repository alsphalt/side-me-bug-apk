'use strict'

/*
 * DARKNOTE AI — optional natural reactions.
 *
 * !!! HONEST STATUS: HEURISTIC AND UNVERIFIED !!!
 * This is a local keyword heuristic, NOT a decision made by the model. The
 * provider cannot be asked to choose an emoji reliably: the prompt budget is too
 * small for structured output and the platform gives no reaction channel. So
 * this module is deliberately conservative, defaults to OFF, and is documented
 * as heuristic rather than pretending to be intelligent.
 *
 * ANTI-SPAM RULES (all must pass before a reaction is sent):
 *   1. reactions must be enabled in config
 *   2. the message must be SHORT - a wall of text is not a reaction moment
 *   3. a confident emotional signal must be present
 *   4. a probability gate must pass
 *   5. the per-chat cooldown must have expired
 *   6. never two reactions in a row in the same chat
 */

const crypto = require('crypto')

const SIGNALS = [
    { emoji: '😂', re: /\b(lol|lmao|lmfao|haha+|hehe+|funny|joke|hilarious|kicheko|vicheko|🤣|😂)\b/i },
    { emoji: '❤️', re: /\b(sad|heartbroken|devastated|passed away|died|funeral|grief|msiba|pole sana|😭|😢|💔)\b/i },
    { emoji: '🎉', re: /\b(congratulations|congrats|hongera|we did it|celebrat|graduated|promoted|🎉)\b/i },
    { emoji: '👍', re: /\b(thanks|thank you|asante sana|well done|good job|nice one|shukran|👏)\b/i },
    { emoji: '😮', re: /\b(wow|omg|oh my god|seriously\?|no way|unbelievable|shocking|😮)\b/i }
]

const MAX_REACTION_CHARS = 120
const REACT_PROBABILITY = 0.3
const COOLDOWN_MS = 3 * 60 * 1000
const MIN_MESSAGES_BETWEEN = 4

const chatState = new Map()   // chatKey -> { lastAt, lastWasReaction, sinceReaction }

function rand() {
    try { return crypto.randomInt(0, 1000) / 1000 } catch { return Math.random() }
}

/** Which emoji, if any, fits this message. Returns null when nothing is clear. */
function chooseReaction(text) {
    const value = String(text || '').trim()
    if (!value || value.length > MAX_REACTION_CHARS) return null
    for (const signal of SIGNALS) if (signal.re.test(value)) return signal.emoji
    return null
}

function state(chatKey) {
    if (!chatState.has(chatKey)) chatState.set(chatKey, { lastAt: 0, lastWasReaction: false, sinceReaction: 0 })
    return chatState.get(chatKey)
}

function noteMessage(chatKey) {
    const s = state(chatKey)
    s.sinceReaction += 1
    return s
}

/**
 * Decide whether to react. Also returns whether a text reply can be SKIPPED,
 * which is only allowed for a bare emotional message with nothing to answer.
 */
function shouldReact(chatKey, text, settings, { isFirstTurn = false, probed = false } = {}) {
    if (!settings?.reactionsEnabled) return { react: false, emoji: null, reason: 'disabled' }
    if (isFirstTurn) return { react: false, emoji: null, reason: 'first-turn' }

    const s = probed ? state(chatKey) : noteMessage(chatKey)
    const emoji = chooseReaction(text)
    if (!emoji) return { react: false, emoji: null, reason: 'no-signal' }
    if (s.lastWasReaction) return { react: false, emoji: null, reason: 'no-repeat' }
    if (s.sinceReaction < MIN_MESSAGES_BETWEEN) return { react: false, emoji: null, reason: 'cooldown-count' }
    if (Date.now() - s.lastAt < COOLDOWN_MS) return { react: false, emoji: null, reason: 'cooldown-time' }
    if (rand() > REACT_PROBABILITY) return { react: false, emoji: null, reason: 'probability' }

    return { react: true, emoji, reason: 'ok' }
}

function markReacted(chatKey) {
    const s = state(chatKey)
    s.lastAt = Date.now()
    s.lastWasReaction = true
    s.sinceReaction = 0
    return s
}

function markReplied(chatKey) {
    const s = state(chatKey)
    s.lastWasReaction = false
    return s
}

/** Is the message ONLY an emotion, with nothing that needs a written answer? */
function reactionIsEnough(text) {
    const value = String(text || '').trim()
    if (!value || value.length > 40) return false
    // No question and no request means a reaction can carry the whole reply.
    return !/[?]/.test(value) && !/\b(explain|help|how|why|what|when|where|who|please|tell|show|can you)\b/i.test(value)
}

function stats() {
    return { trackedChats: chatState.size }
}

module.exports = { chooseReaction, shouldReact, markReacted, markReplied, reactionIsEnough, stats, SIGNALS }
