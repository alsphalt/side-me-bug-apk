'use strict'

/*
 * DARKNOTE AI — conversation memory.
 *
 * ISOLATION IS THE WHOLE POINT.
 *   Direct chat : one bucket per user            ->  d:<number>
 *   Group chat  : one bucket per group           ->  g:<group id>
 * A group bucket records who said what on every turn, so the model can follow
 * a multi-person conversation without one person's history bleeding into
 * another's private chat.
 *
 * Storage lives in database/ai-memory.json, deliberately separate from the
 * legacy database/ai-sessions.json used by the .ai command, so the two systems
 * cannot corrupt each other.
 */

const fs = require('fs')
const path = require('path')

const STORE_DIR = path.join(__dirname, '..', 'database')
const STORE_PATH = path.join(STORE_DIR, 'ai-memory.json')

let cachedStore = null
let writeTimer = null

/* ---------------------------------- keys --------------------------------- */

function normalizeNumber(value) {
    let n = String(value || '').trim().replace(/\D/g, '')
    if (n.startsWith('00')) n = n.slice(2)
    if (/^0\d{9}$/.test(n)) n = `254${n.slice(1)}`
    return n
}

/**
 * Build the isolation key. A group gets a single bucket for the whole group;
 * a direct chat gets a bucket per person. Returns '' when it cannot be resolved,
 * in which case the caller must refuse rather than guess (never mix histories).
 */
function sessionKey(m) {
    const chat = String(m?.chat || m?.key?.remoteJid || '')
    if (!chat) return ''
    const isGroup = m?.isGroup === true || chat.endsWith('@g.us')
    if (isGroup) {
        const group = chat.split('@')[0].split(':')[0].toLowerCase()
        return group ? `g:${group}` : ''
    }
    const user = normalizeNumber(m?.sender || m?.key?.remoteJid)
    return user ? `d:${user}` : ''
}

/* --------------------------------- storage ------------------------------- */

function ensureStore() {
    try { fs.mkdirSync(STORE_DIR, { recursive: true }) } catch { }
}

function loadStore() {
    if (cachedStore) return cachedStore
    ensureStore()
    try {
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
        cachedStore = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
        // A missing or corrupt store must never break the bot. Start clean.
        cachedStore = {}
    }
    return cachedStore
}

/** Debounced, atomic write so a busy group does not thrash the disk. */
function scheduleWrite() {
    if (writeTimer) return
    writeTimer = setTimeout(() => {
        writeTimer = null
        flush()
    }, 800)
    if (typeof writeTimer.unref === 'function') writeTimer.unref()
}

function flush() {
    if (!cachedStore) return
    try {
        ensureStore()
        const tmp = `${STORE_PATH}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(cachedStore, null, 2))
        fs.renameSync(tmp, STORE_PATH)
    } catch (error) {
        console.error('[AI] memory write failed:', error?.message || error)
    }
}

/* -------------------------------- sessions ------------------------------- */

function emptySession(key) {
    return {
        key,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: 0,
        turnsList: [],
        facts: {},
        lastReply: '',
        // Rolling summary of everything older than the retained window. This is
        // what lets a long conversation survive the provider prompt budget.
        summary: '',
        // The immediately previous exchange, used for repeat detection and for
        // "explain differently", and the provider that answered it so a repeat
        // can deliberately be served by a DIFFERENT provider.
        lastQ: '',
        lastA: '',
        lastProvider: ''
    }
}

function getSession(key) {
    if (!key) return emptySession('')
    const store = loadStore()
    const found = store[key]
    if (!found || typeof found !== 'object' || Array.isArray(found)) return emptySession(key)
    return {
        key,
        createdAt: Number(found.createdAt) || Date.now(),
        updatedAt: Number(found.updatedAt) || Date.now(),
        turns: Number(found.turns) || 0,
        turnsList: Array.isArray(found.turnsList) ? found.turnsList.filter(t => t && typeof t === 'object') : [],
        facts: found.facts && typeof found.facts === 'object' && !Array.isArray(found.facts) ? found.facts : {},
        lastReply: typeof found.lastReply === 'string' ? found.lastReply : '',
        summary: typeof found.summary === 'string' ? found.summary : '',
        lastQ: typeof found.lastQ === 'string' ? found.lastQ : '',
        lastA: typeof found.lastA === 'string' ? found.lastA : '',
        lastProvider: typeof found.lastProvider === 'string' ? found.lastProvider : ''
    }
}

function saveSession(session, settings) {
    if (!session?.key) return
    const store = loadStore()
    session.updatedAt = Date.now()
    /*
     * Retention must be LONGER than the context window. It used to be capped at
     * exactly maxTurns * 2, while the summary trigger required more turns than
     * that - so summarisation could never fire and the summary stayed empty
     * forever. Keep enough raw history to summarise from, and let the prompt
     * builder choose only the most recent turns for the context window.
     */
    const maxTurns = Math.max(1, Number(settings?.maxContextTurns ?? 6))
    session.turnsList = session.turnsList.slice(-Math.max(6, maxTurns * 4))
    store[session.key] = session

    // Bound the store: expire old buckets, then drop the oldest.
    const ttlMs = Math.max(1, Number(settings?.sessionTtlDays ?? 30)) * 24 * 60 * 60 * 1000
    const cutoff = Date.now() - ttlMs
    for (const [key, value] of Object.entries(store)) {
        if (!value || typeof value !== 'object') { delete store[key]; continue }
        if (Number(value.updatedAt || 0) < cutoff) delete store[key]
    }
    const maxSessions = Math.max(10, Number(settings?.maxSessions ?? 800))
    const keys = Object.keys(store)
    if (keys.length > maxSessions) {
        keys.sort((a, b) => Number(store[a]?.updatedAt || 0) - Number(store[b]?.updatedAt || 0))
        for (const key of keys.slice(0, keys.length - maxSessions)) delete store[key]
    }
    scheduleWrite()
}

function appendTurn(key, { user, assistant, speaker }, settings) {
    const session = getSession(key)
    session.turns = (Number(session.turns) || 0) + 1
    session.lastReply = String(assistant || '').slice(0, 240)
    session.turnsList.push({
        u: String(user || '').slice(0, 240),
        a: String(assistant || '').slice(0, 240),
        s: String(speaker || '').slice(0, 40),
        t: Date.now()
    })
    saveSession(session, settings)
    return session
}

function reset(key) {
    if (!key) return false
    const store = loadStore()
    if (!(key in store)) return false
    delete store[key]
    scheduleWrite()
    return true
}

function clearAll() {
    cachedStore = {}
    scheduleWrite()
    return true
}

/** True when this bucket already has an exchange, used for the first-turn delay. */
function hasHistory(key) {
    const session = getSession(key)
    return session.turns > 0 && session.turnsList.length > 0
}

/* ----------------------- tiny user-facing fact store --------------------- */

/*
 * Structured extraction, not open-ended. Deliberately small: the provider caps
 * the prompt at 302 characters, so a long "memory" would crowd out the actual
 * message. Only explicit, unambiguous self-disclosures are stored.
 */
const FACT_RULES = [
    { key: 'name', re: /\b(?:my name is|i am called|call me|jina langu ni|naitwa)\s+([A-Za-z][A-Za-z' -]{1,20})/i },
    { key: 'lives', re: /\b(?:i live in|i stay in|i'm from|i am from|ninaishi|natoka)\s+([A-Za-z][A-Za-z' -]{1,20})/i },
    { key: 'work', re: /\b(?:i work as|i work at|i work for)\s+([A-Za-z][A-Za-z' -]{1,20})/i },
    { key: 'language', re: /\b(?:speak to me in|reply in|respond in|ongea)\s+(sheng|kiswahili|swahili|english)/i }
]
const STOPWORDS = /^(?:a|an|the|and|but|so|not|no|very|just|also|fine|good|ok|okay|doing|going|here|there)\b/i

function cleanFact(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().replace(/[.,;:!?]+$/, '')
    if (!text || STOPWORDS.test(text)) return ''
    return text.split(' ').slice(0, 3).join(' ').slice(0, 24)
}

function learnFacts(key, text, settings) {
    const session = getSession(key)
    let changed = false
    for (const rule of FACT_RULES) {
        const match = String(text || '').match(rule.re)
        if (!match) continue
        const capture = cleanFact(match[1])
        if (!capture || session.facts[rule.key] === capture) continue
        session.facts[rule.key] = capture
        changed = true
    }
    // Cap the fact set so the prompt budget stays usable.
    const keys = Object.keys(session.facts)
    if (keys.length > 5) {
        for (const k of keys.slice(0, keys.length - 5)) { delete session.facts[k]; changed = true }
    }
    if (changed) saveSession(session, settings)
    return session
}

/** One compact line for the prompt, or '' when nothing is known. */
function factsLine(session) {
    const facts = session?.facts || {}
    const parts = []
    if (facts.name) parts.push(`name=${facts.name}`)
    if (facts.lives) parts.push(`lives=${facts.lives}`)
    if (facts.work) parts.push(`work=${facts.work}`)
    if (facts.language) parts.push(`wants=${facts.language}`)
    if (!parts.length) return ''
    return `Known: ${parts.join(', ')}`
}

/** Redacted, human-readable summary for the .aimemory command. */
function describe(key) {
    const session = getSession(key)
    const facts = session.facts || {}
    const lines = []
    if (facts.name) lines.push(`• Name: ${facts.name}`)
    if (facts.lives) lines.push(`• Lives in: ${facts.lives}`)
    if (facts.work) lines.push(`• Work: ${facts.work}`)
    if (facts.language) lines.push(`• Preferred language: ${facts.language}`)
    if (!lines.length) lines.push('• Nothing personal stored yet.')
    return {
        key,
        turns: session.turns,
        stored: Object.keys(facts).length,
        lines
    }
}

/* --------------------------- long-conversation state --------------------- */

/** Store the rolling summary that stands in for turns older than the window. */
function setSummary(key, summary, settings) {
    const session = getSession(key)
    session.summary = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, Number(settings?.summaryMaxChars) || 120)
    saveSession(session, settings)
    return session.summary
}

/**
 * Record a completed exchange. Keeps the previous question/answer and the
 * provider that produced it, which is what makes repeat detection and provider
 * variation possible on the next turn.
 */
function recordExchange(key, { question, answer, provider, speaker }, settings) {
    const session = getSession(key)
    session.lastQ = String(question || '').slice(0, 240)
    session.lastA = String(answer || '').slice(0, 240)
    session.lastProvider = String(provider || '').slice(0, 40)
    session.turns = (Number(session.turns) || 0) + 1
    session.lastReply = String(answer || '').slice(0, 240)
    session.turnsList.push({
        u: String(question || '').slice(0, 240),
        a: String(answer || '').slice(0, 240),
        s: String(speaker || '').slice(0, 40),
        p: String(provider || '').slice(0, 40),
        t: Date.now()
    })
    saveSession(session, settings)
    return session
}

/**
 * True once a conversation is long enough that a summary is worth building.
 * Uses the MONOTONIC turn counter, not the retained list length: the retained
 * list is a moving window, so basing the trigger on it could never cross the
 * threshold. Fires every `window` turns once past the first window.
 */
function needsSummary(key, settings) {
    const session = getSession(key)
    const window = Math.max(1, Number(settings?.maxContextTurns) || 6)
    if (session.turns < window * 2) return false
    if (session.turns % window !== 0) return false
    return session.turnsList.length > window
}

/** The turns that fall outside the retained context window, to be summarised. */
function turnsToSummarise(key, settings) {
    const session = getSession(key)
    const window = Math.max(1, Number(settings?.maxContextTurns) || 6)
    return session.turnsList.slice(0, Math.max(0, session.turnsList.length - window))
}

/* --------------------------- similarity / repeats ------------------------ */

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
    'i', 'you', 'me', 'my', 'your', 'it', 'this', 'that', 'do', 'does', 'can', 'please', 'what', 'how', 'why',
    'na', 'ya', 'wa', 'ni', 'kwa', 'hii', 'hiyo', 'je', 'sasa', 'bro', 'pls'])

function normalise(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w && !STOP.has(w))
}

/** Character trigram set, used as a fuzzy fallback for near-identical wording. */
function trigrams(text) {
    const s = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `
    const out = new Set()
    for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3))
    return out
}

function jaccard(a, b) {
    if (!a.size || !b.size) return 0
    let shared = 0
    for (const v of a) if (b.has(v)) shared++
    return shared / (a.size + b.size - shared)
}

/**
 * Similarity in 0..1 between two messages.
 * Combines a token-set comparison with a character-trigram comparison so that
 * both "what is bitcoin" vs "what's bitcoin?" and "explain bitcoin" vs
 * "bitcoin explained" score highly, while genuinely different questions do not.
 * This is a cheap local approximation of semantic similarity, not an embedding.
 */
function similarity(a, b) {
    const ta = normalise(a)
    const tb = normalise(b)
    if (!ta.length || !tb.length) return 0
    if (ta.join(' ') === tb.join(' ')) return 1
    const tokenScore = jaccard(new Set(ta), new Set(tb))
    const triScore = jaccard(trigrams(ta.join(' ')), trigrams(tb.join(' ')))
    return Math.min(1, tokenScore * 0.65 + triScore * 0.35)
}

/**
 * Is this message a repeat of something recently asked in this conversation?
 * Returns { repeat, score, matched }.
 */
function isRepeat(key, question, settings) {
    const threshold = Number(settings?.repeatSimilarityThreshold) || 0.72
    const session = getSession(key)
    const recent = [session.lastQ, ...session.turnsList.slice(-4).map(t => t.u)].filter(Boolean)
    let best = 0
    let matched = ''
    for (const previous of recent) {
        const score = similarity(question, previous)
        if (score > best) { best = score; matched = previous }
    }
    return { repeat: best >= threshold, score: Number(best.toFixed(3)), matched: best >= threshold ? matched : '' }
}

/* --------------------------- explain differently ------------------------- */

const EXPLAIN_DIFFERENTLY = /\b(explain (?:it )?(?:again|differently|simply|in simple terms|like i(?:'m| am) five)|i (?:don'?t|do not) (?:understand|get it)|i'?m (?:confused|lost)|try another way|another way|make it (?:simpler|easier)|simpler please|simplify (?:that|it)|in simple terms|eleza tena|sielewi|rahisi zaidi|fafanua (?:tena|vizuri))\b/i

/**
 * Does the user want the SAME thing explained a different way?
 * When true the router may switch provider and the prompt tells the model not
 * to repeat the previous wording.
 */
function isExplainDifferently(text) {
    return EXPLAIN_DIFFERENTLY.test(String(text || ''))
}

/** The previous answer, trimmed for use as a "do not repeat this" instruction. */
function previousAnswer(key, max = 60) {
    const session = getSession(key)
    const answer = String(session.lastA || '').replace(/\s+/g, ' ').trim()
    return answer.length > max ? `${answer.slice(0, max - 1).trimEnd()}…` : answer
}

module.exports = {
    sessionKey,
    getSession,
    saveSession,
    appendTurn,
    reset,
    clearAll,
    hasHistory,
    learnFacts,
    factsLine,
    describe,
    normalizeNumber,
    flush,
    // long conversation
    setSummary,
    recordExchange,
    needsSummary,
    turnsToSummarise,
    // repeat + variation
    similarity,
    isRepeat,
    isExplainDifferently,
    previousAnswer,
    STORE_PATH
}
