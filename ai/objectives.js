'use strict'

/*
 * DARKNOTE AI — objective detection.
 *
 * Works out WHAT the user wants before any provider is chosen. This is the
 * difference between "send every message to one API" and routing: a greeting, a
 * debugging question and an explanation should not necessarily go to the same
 * model.
 *
 * Capability-driven objectives are also detected here (image, file, web, image
 * generation) but ONLY so the router can refuse honestly. Nothing in this file
 * claims a provider can do them.
 */

const OBJECTIVES = {
    CASUAL: 'casual',
    GENERAL: 'general',
    REASONING: 'reasoning',
    CODING: 'coding',
    TRANSLATION: 'translation',
    LONG_CONTEXT: 'longcontext',
    VISION: 'vision',
    FILES: 'files',
    WEB: 'web',
    IMAGE_GEN: 'image'
}

const PATTERNS = {
    coding: /\b(code|coding|program|script|function|bug|debug|error|exception|stack ?trace|syntax|compile|runtime|api|endpoint|regex|javascript|typescript|python|node|nodejs|npm|git|commit|deploy|server|database|sql|query|html|css|react|json|array|object|variable|loop|async|promise|class|import|module|segfault|crash(?:ing|es)?)\b/i,
    reasoning: /\b(explain (?:in detail|deeply|thoroughly)|why\b|compare|contrast|analys[ez]|evaluate|prove|derive|strategy|trade-?offs?|implications|in depth|deep dive|reason(?:ing)?|logic|argument|critique|assess|step by step)\b/i,
    translation: /\b(translate|translation|tafsiri|in (?:swahili|kiswahili|french|spanish|german|arabic|chinese)|kwa (?:kiswahili|kiingereza)|meaning of .* in)\b/i,
    vision: /\b(what(?:'s| is) in (?:this|the) (?:image|picture|photo|screenshot)|describe (?:this|the) (?:image|picture|photo|screenshot)|analyse? (?:this|the) (?:image|picture|photo)|look at (?:this|the) (?:image|photo)|read (?:this|the) (?:image|screenshot))\b/i,
    files: /\b(analyse?|analyze|summar(?:y|ise|ize)|explain|read) (?:this|the) (?:pdf|document|doc|docx|file|attachment|spreadsheet|csv)\b/i,
    web: /\b(latest|today'?s|current(?:ly)?|news about|search (?:the )?(?:web|internet|online)|look ?up online|recent(?:ly)?|as of (?:now|today)|up-?to-?date|live (?:score|price|rate))\b/i,
    imagegen: /\b(create|generate|make|draw|design|render) (?:me )?(?:an? )?(?:image|picture|photo|illustration|logo|artwork|poster)\b/i
}

// A greeting with nothing else in it. "hey what is up" is covered by the
// isShort + not-a-question rule below rather than by this pattern.
const CASUAL = /^(hi|hey|hello|yo|sup|hiya|morning|evening|niaje|sasa|mambo|vipi|uko aje|habari|poa|freshi|hi there|hey there|good (?:morning|evening|afternoon)|how are you|how you doing|howzit|sema|what(?:'s| is) up|whats up|unaendelea aje)[\s!.?]*$/i

// A short message is only "casual" if it is not actually asking something.
const QUESTION_START = /^(what|why|how|who|whose|when|where|which|explain|tell|define|describe|can you|could you|would you|is|are|does|do|did|should|naomba|nini|kwanini|vipi)\b/i

const tokenize = text => String(text || '').toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Classify the objective.
 * `promptLength` matters because the gateway caps most providers at 302 chars,
 * so a long prompt can only be served by a provider with a bigger window.
 */
function detect(message, { promptLength = 0, requested = '' } = {}) {
    const text = String(message || '').trim()
    const signals = []

    // An explicit provider request only overrides ranking, never capability.
    if (requested) signals.push(`requested:${requested}`)

    const words = tokenize(text)
    const isShort = text.length <= 40 && words.length <= 7

    let objective = OBJECTIVES.GENERAL
    let confidence = 0.4

    if (PATTERNS.vision.test(text)) { objective = OBJECTIVES.VISION; confidence = 0.9; signals.push('vision-intent') }
    else if (PATTERNS.files.test(text)) { objective = OBJECTIVES.FILES; confidence = 0.85; signals.push('file-intent') }
    else if (PATTERNS.imagegen.test(text)) { objective = OBJECTIVES.IMAGE_GEN; confidence = 0.85; signals.push('imagegen-intent') }
    else if (PATTERNS.coding.test(text)) { objective = OBJECTIVES.CODING; confidence = 0.8; signals.push('coding-terms') }
    else if (PATTERNS.translation.test(text)) { objective = OBJECTIVES.TRANSLATION; confidence = 0.8; signals.push('translation-terms') }
    // Time-sensitive wording must be able to SET the objective, so that the
    // router can refuse honestly. Previously it only recorded a signal, which
    // meant "what is the latest news about X" was answered as a general question
    // with no live data behind it.
    else if (PATTERNS.web.test(text)) { objective = OBJECTIVES.WEB; confidence = 0.8; signals.push('time-sensitive-wording') }
    else if (PATTERNS.reasoning.test(text)) { objective = OBJECTIVES.REASONING; confidence = 0.75; signals.push('reasoning-terms') }
    else {
        // No strong topical signal. Only now decide between a greeting and a
        // real question: a short "What is Bitcoin?" is a question, not smalltalk.
        const isQuestion = /\?/.test(text) || QUESTION_START.test(text)
        if (CASUAL.test(text) || (isShort && !isQuestion)) {
            objective = OBJECTIVES.CASUAL
            confidence = 0.7
            signals.push('greeting-or-short')
        }
    }

    // A prompt larger than the gateway cap can ONLY be served by a provider
    // with a larger window, so that fact outranks the topical objective.
    if (promptLength > 302) {
        objective = OBJECTIVES.LONG_CONTEXT
        confidence = 1
        signals.push(`prompt:${promptLength}>302`)
    }

    return { objective, confidence, signals }
}

/** True when the objective is one no verified provider can serve yet. */
function requiresUnverifiedCapability(objective) {
    return [OBJECTIVES.VISION, OBJECTIVES.FILES, OBJECTIVES.WEB, OBJECTIVES.IMAGE_GEN].includes(objective)
}

/** A short explanation used when refusing an unsupported objective. */
function unsupportedReason(objective) {
    switch (objective) {
        case OBJECTIVES.VISION: return 'image understanding'
        case OBJECTIVES.FILES: return 'file analysis'
        case OBJECTIVES.WEB: return 'live web research'
        case OBJECTIVES.IMAGE_GEN: return 'image generation'
        default: return 'that capability'
    }
}

module.exports = { OBJECTIVES, detect, requiresUnverifiedCapability, unsupportedReason, PATTERNS }
