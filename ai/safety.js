'use strict'

/*
 * DARKNOTE AI — abuse safety for the AI path.
 *
 * INDEPENDENT of the group antilink/anticall moderation, which is untouched.
 * This only ever runs on direct AI conversations.
 *
 * Escalation, as specified:
 *   1st abusive message  -> a calm warning
 *   2nd                  -> a firmer warning
 *   3rd                  -> blocked from the AI, and the existing DARKNOTE block
 *                           system is applied to the number
 *
 * DELIBERATELY CONSERVATIVE. Profanity alone is NOT abuse. People swear, joke,
 * quote lyrics and tease. A single ambiguous word must never trigger anything,
 * so a message only counts when it is DIRECTED at the assistant and is
 * genuinely hostile. Two independent signals are required: a hostile pattern
 * aimed at the bot, or a sustained insult run.
 */

const DIRECTED_AT_BOT = /\b(you|u|wewe|bot|darknote|ai|assistant)\b/i

// Insults that are hostile on their own, but only count when aimed at the bot.
const INSULTS = /\b(stupid|idiot|dumb|useless|worthless|moron|imbecile|shut up|f+u+c+k+ (you|u|off)|screw you|mf|m[fv]|son of a|(?:go )?kill yourself|kys|mshenzi|mjinga|mbwa wewe|pumbavu|shenzi)\b/i

// Threats and dehumanising language are hostile regardless of the target word.
const SEVERE = /\b(kill you|kill yourself|kys|i will (?:hurt|find|kill) you|die slow|f+u+c+k+ you|f+u+c+k+ u)\b/i

// Clear non-abuse: someone venting at a situation, or swearing in general.
const NOT_AT_BOT = /\b(my (?:boss|ex|teacher|mum|mom|dad|phone|car|job)|this (?:thing|code|bug|app|phone)|the (?:weather|traffic|exam)|f+u+c+k+ this (?:bug|code|job)|sorry for (?:my )?(?:language|french))\b/i

// Being rude ABOUT a problem, not AT the assistant.
const FRUSTRATION = /\b(why (?:won'?t|doesn'?t) (?:this|it) work|this is (?:annoying|frustrating)|so annoying|nimechoka|im tired of this)\b/i

/**
 * Classify a message for abuse.
 * Returns { abuse, severe, reason, confidence } — confidence is intentionally
 * part of the contract so a caller can refuse to act on a weak signal.
 */
function classify(text) {
    const value = String(text || '').trim()
    if (!value) return { abuse: false, severe: false, reason: 'empty', confidence: 0 }

    const severe = SEVERE.test(value)
    if (severe) return { abuse: true, severe: true, reason: 'threat', confidence: 0.95 }

    // Venting about a situation is not abuse, even when it contains swearing.
    if (NOT_AT_BOT.test(value) || FRUSTRATION.test(value)) {
        return { abuse: false, severe: false, reason: 'frustration-not-directed', confidence: 0.7 }
    }

    const insult = INSULTS.test(value)
    const directed = DIRECTED_AT_BOT.test(value)
    if (insult && directed) {
        // A bare "you stupid" is hostile; "you stupid bug" is about the code.
        return { abuse: true, severe: false, reason: 'directed-insult', confidence: 0.8 }
    }
    if (insult && !directed) {
        return { abuse: false, severe: false, reason: 'insult-without-target', confidence: 0.4 }
    }
    return { abuse: false, severe: false, reason: 'clean', confidence: 0.9 }
}

const WARNINGS = {
    1: 'Please keep it respectful. Repeated abuse may lead to a block.',
    2: 'This is the second warning. One more and I will have to block you from using me.'
}

/** The message to send for the next offence, or the block notice. */
function responseFor(count) {
    if (count <= 1) return { action: 'warn', message: WARNINGS[1] }
    if (count === 2) return { action: 'warn-harder', message: WARNINGS[2] }
    return { action: 'block', message: 'I have blocked you from using the AI.' }
}

/**
 * Decide what to do about a message from this user.
 * Applied by the caller so the policy stays in one place.
 */
function review(text, state) {
    const verdict = classify(text)
    const previous = Number(state?.abuseCount) || 0
    if (!verdict.abuse) return { ...verdict, count: previous, action: 'none' }
    const count = previous + 1
    return { ...verdict, count, ...responseFor(count) }
}

module.exports = { classify, review, responseFor, INSULTS, SEVERE, WARNINGS }
