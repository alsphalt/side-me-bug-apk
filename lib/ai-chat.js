'use strict'

/*
 * DARKNOTE L2 LICENSE
 * AI chat with persistent sessions and memory.
 * © DARKNOTE L2 • Bigbrother
 *
 * Provider: https://www.mzazi.shop/api/ai/gpt-5
 *   GET ?prompt=<text>&apikey=<key>
 *   Success : { "status": true,  "creator": "MZAZI TECH", "result": { "answer": "..." } }
 *   Failure : { "status": false, "error": "PROVIDER_TIMEOUT" | "MISSING_API_KEY" | ..., "message": "..." }
 *
 * MEASURED PROVIDER CONSTRAINT (this is why the design looks the way it does):
 * the endpoint rejects any prompt longer than 300 characters with HTTP 400.
 * This was verified empirically against GET and POST, with the `prompt` and
 * `message` parameter names. Sending the whole transcript is therefore
 * impossible, so "memory" is a BUDGETED CONTEXT BLOCK rebuilt from a
 * persisted session store instead of a replayed conversation.
 *
 * Nothing in this module opens a socket, registers a listener, or duplicates a
 * dispatcher. It is a pure helper layer called from the existing command case.
 */

const fs = require('fs')
const path = require('path')
const https = require('https')

const STORE_DIR = path.join(__dirname, '..', 'database')
const STORE_PATH = path.join(STORE_DIR, 'ai-sessions.json')
const CONFIG_PATH = path.join(__dirname, '..', 'config.json')

// Provider defaults, overridable through config.json -> "ai": { ... }
const DEFAULT_ENDPOINT = 'https://www.mzazi.shop/api/ai/gpt-5'

// The API key is NEVER hardcoded here. It is resolved in one place - ai/config.js -
// from the environment (.env) or config.json, environment first. A key committed
// to source is a leaked key, and this file is in version control.
let sharedAiConfig = null
try {
    sharedAiConfig = require('../ai/config.js')
} catch (error) {
    console.error('[AI] shared config unavailable, falling back to the environment:', error?.message || error)
}

function resolveApiKey() {
    if (sharedAiConfig) {
        try { return String(sharedAiConfig.getAiSettings().apiKey || '').trim() } catch { }
    }
    return String(process.env.MZAZI_API_KEY || process.env.AI_API_KEY || '').trim()
}

// The provider hard-rejects prompts above 300 characters. Keep a safety margin
// so multi-byte characters and encoding never push us over the measured edge.
const PROVIDER_MAX_PROMPT = 300
const PROMPT_BUDGET = 292

const DEFAULT_TIMEOUT_MS = 90000
const DEFAULT_RETRIES = 4
const RETRY_BACKOFF_MS = [1500, 3500, 7000]

// The provider is intermittently unstable: PROVIDER_TIMEOUT and PROVIDER_ERROR
// are observed regularly even for well-formed requests, so both are retried
// regardless of the HTTP status that carried them.
const RETRYABLE_CODES = new Set([
    'PROVIDER_TIMEOUT',
    'PROVIDER_ERROR',
    'UPSTREAM_ERROR',
    'RATE_LIMITED',
    'EMPTY_ANSWER',
    'BAD_RESPONSE'
])
const HISTORY_TURNS = 8
const MAX_FACTS = 8
const MAX_NOTES = 5
const MAX_SESSIONS = 800
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SEGMENT_CHARS = 74
const MAX_REPLY_CHARS = 3800

// One in-flight request per session key. A duplicate update for the same user
// must not fire a second provider call or a second reply.
const inFlight = new Set()

function getConfigFile() {
    try {
        delete require.cache[require.resolve(CONFIG_PATH)]
        return require(CONFIG_PATH)
    } catch (error) {
        console.error('[AI] config read failed:', error?.message || error)
        return {}
    }
}

function getSettings() {
    const file = getConfigFile()
    const ai = file?.ai && typeof file.ai === 'object' ? file.ai : {}
    const endpoint = String(ai.endpoint || DEFAULT_ENDPOINT).trim()
    const apikey = resolveApiKey()
    const timeoutMs = Number(ai.timeoutMs) > 0 ? Number(ai.timeoutMs) : DEFAULT_TIMEOUT_MS
    const retries = Number.isFinite(Number(ai.retries)) ? Math.max(0, Math.min(5, Number(ai.retries))) : DEFAULT_RETRIES
    return {
        enabled: ai.enabled !== false,
        endpoint,
        apikey,
        timeoutMs,
        retries,
        prefix: String(file?.prefix || '.')
    }
}

/* ------------------------------- storage -------------------------------- */

function ensureStore() {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, '{}')
}

function readStore() {
    ensureStore()
    try {
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch (error) {
        // A corrupt store must never take the bot down; start clean instead.
        console.error('[AI] session store was unreadable, rebuilding:', error?.message || error)
        return {}
    }
}

function writeStore(store) {
    ensureStore()
    const tmp = `${STORE_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, STORE_PATH)
}

function normalizeNumber(value) {
    let n = String(value || '').trim().replace(/\D/g, '')
    if (n.startsWith('00')) n = n.slice(2)
    if (/^0\d{9}$/.test(n)) n = `254${n.slice(1)}`
    return n
}

function numberFromJid(jid) {
    return normalizeNumber(String(jid || '').split('@')[0])
}

// Groups keep one memory per member per group; DMs keep one memory per user.
function sessionKey(m) {
    const chat = String(m?.chat || m?.key?.remoteJid || '')
    const sender = normalizeNumber(m?.sender || m?.key?.participant || '')
    if (!sender) return ''
    if (m?.isGroup || chat.endsWith('@g.us')) return `g:${numberFromJid(chat) || 'unknown'}:${sender}`
    return `d:${sender}`
}

function emptySession(key) {
    return { key, createdAt: Date.now(), updatedAt: Date.now(), turns: 0, facts: {}, notes: [], lastUser: '', lastAssistant: '', history: [] }
}

function loadSession(key) {
    const store = readStore()
    const found = store[key]
    if (!found || typeof found !== 'object' || Array.isArray(found)) return emptySession(key)
    return {
        key,
        createdAt: Number(found.createdAt) || Date.now(),
        updatedAt: Number(found.updatedAt) || Date.now(),
        turns: Number(found.turns) || 0,
        facts: found.facts && typeof found.facts === 'object' && !Array.isArray(found.facts) ? found.facts : {},
        notes: Array.isArray(found.notes) ? found.notes.filter(n => typeof n === 'string').slice(-MAX_NOTES) : [],
        lastUser: typeof found.lastUser === 'string' ? found.lastUser : '',
        lastAssistant: typeof found.lastAssistant === 'string' ? found.lastAssistant : '',
        history: Array.isArray(found.history) ? found.history.filter(h => h && typeof h === 'object').slice(-HISTORY_TURNS) : []
    }
}

function saveSession(session) {
    if (!session?.key) return
    const store = readStore()
    session.updatedAt = Date.now()
    store[session.key] = session

    // Bound the store: drop expired sessions first, then the oldest entries.
    const cutoff = Date.now() - SESSION_TTL_MS
    for (const [key, value] of Object.entries(store)) {
        if (!value || typeof value !== 'object') { delete store[key]; continue }
        if (Number(value.updatedAt || 0) < cutoff) delete store[key]
    }
    const keys = Object.keys(store)
    if (keys.length > MAX_SESSIONS) {
        keys.sort((a, b) => Number(store[a]?.updatedAt || 0) - Number(store[b]?.updatedAt || 0))
        for (const key of keys.slice(0, keys.length - MAX_SESSIONS)) delete store[key]
    }

    try { writeStore(store) } catch (error) { console.error('[AI] session save failed:', error?.message || error) }
}

function resetSession(key) {
    if (!key) return false
    const store = readStore()
    if (!(key in store)) return false
    delete store[key]
    try { writeStore(store) } catch (error) { console.error('[AI] session reset failed:', error?.message || error); return false }
    return true
}

/* --------------------------- fact extraction ---------------------------- */

// Captures that are really sentence fragments rather than facts.
const BAD_CAPTURE = /^(?:a|an|the|not|no|so|very|just|really|also|here|there|sorry|still|now|fine|good|ok|okay|sure|doing|going|trying|gonna|happy|sad|tired|busy|back|done)\b/i

// A capture ends where a new clause starts. Without this, "my name is Brian and
// I live in Nairobi" would store the whole tail as the user's name.
const CLAUSE_BREAK = /\s+(?:and\s+)?(?:i|i'm|im|my|we|our|he|she|they|you)\b|\s+(?:because|since|but|so|although|though|however|please|thanks|thank)\b/i

const FACT_RULES = [
    { key: 'work', maxWords: 4, re: /\b(?:i work as|i work at|i work for)\s+([^,.!?]{2,40})/i },
    { key: 'age', maxWords: 1, re: /\b(?:i am|i'm|im|nina)\s+(\d{1,2})\s*(?:years old|yrs old|years|yrs|miaka)\b/i },
    { key: 'location', maxWords: 3, re: /\b(?:i live in|i stay in|i'm from|i am from|i come from|ninaishi|natoka)\s+([^,.!?]{2,40})/i },
    { key: 'likes', maxWords: 5, re: /\b(?:i like|i love|i enjoy|i prefer|napenda)\s+([^,.!?]{2,40})/i },
    { key: 'dislikes', maxWords: 5, re: /\b(?:i hate|i dislike|i don't like|i do not like|sipendi)\s+([^,.!?]{2,40})/i },
    { key: 'name', maxWords: 3, re: /\b(?:my name is|i am called|call me|i'm|im|jina langu ni|naitwa)\s+([^,.!?]{2,40})/i },
    { key: 'language', maxWords: 1, re: /\b(?:speak to me in|reply in|respond in|talk to me in|ongea)\s+(swahili|kiswahili|english|french|spanish|german|arabic|sheng|luo|kikuyu|kalenjin|kamba|luhya|somali)/i }
]

const NOTE_RULE = /\b(?:remember that|remember|kumbuka)\s+([^.!?]{2,70})/i

function trimCapture(value, maxWords = 3) {
    let text = String(value || '').replace(/\s+/g, ' ').trim()
    text = text.replace(/^[:,-]+\s*/, '').replace(/[.,;:!?\s]+$/, '')
    // Drop any trailing clause that is no longer part of the captured fact.
    const breakAt = text.search(CLAUSE_BREAK)
    if (breakAt > 0) text = text.slice(0, breakAt).trim()
    text = text.replace(/[.,;:!?\s]+$/, '')
    if (!text || BAD_CAPTURE.test(text)) return ''
    const words = text.split(' ').filter(Boolean)
    if (words.length > maxWords) text = words.slice(0, maxWords).join(' ')
    return text.slice(0, 40)
}

// Facts are derived only from what the user actually wrote. Nothing is guessed
// and nothing is invented when no rule matches.
function extractFacts(text, session) {
    const value = String(text || '')
    if (!value.trim()) return { changed: false }

    const facts = session.facts && typeof session.facts === 'object' ? session.facts : {}
    let changed = false

    for (const rule of FACT_RULES) {
        const match = value.match(rule.re)
        if (!match) continue
        const capture = trimCapture(match[1], rule.maxWords)
        if (!capture) continue
        if (facts[rule.key] === capture) continue
        facts[rule.key] = capture
        changed = true
    }

    const noteMatch = value.match(NOTE_RULE)
    if (noteMatch) {
        const note = trimCapture(noteMatch[1], 12)
        if (note && !session.notes.includes(note)) {
            session.notes.push(note)
            session.notes = session.notes.slice(-MAX_NOTES)
            changed = true
        }
    }

    // Keep the fact set small so the prompt budget stays usable.
    const keys = Object.keys(facts)
    if (keys.length > MAX_FACTS) {
        for (const key of keys.slice(0, keys.length - MAX_FACTS)) delete facts[key]
        changed = true
    }

    session.facts = facts
    return { changed }
}

function factsToLine(session) {
    const facts = session?.facts && typeof session.facts === 'object' ? session.facts : {}
    const parts = []
    if (facts.name) parts.push(`name=${facts.name}`)
    if (facts.age) parts.push(`age=${facts.age}`)
    if (facts.location) parts.push(`lives=${facts.location}`)
    if (facts.work) parts.push(`work=${facts.work}`)
    if (facts.likes) parts.push(`likes=${facts.likes}`)
    if (facts.dislikes) parts.push(`dislikes=${facts.dislikes}`)
    if (facts.language) parts.push(`language=${facts.language}`)
    for (const note of (session?.notes || []).slice(-2)) parts.push(`note=${note}`)
    if (!parts.length) return ''
    return `Known about user: ${parts.join('; ')}`
}

/* ---------------------------- prompt building --------------------------- */

function shorten(text, max = MAX_SEGMENT_CHARS) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (value.length <= max) return value
    return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Assemble a prompt that always stays inside the provider's measured limit.
 * Priority: the current user message first, then the short fact digest, then
 * the most recent exchange, then whatever older history still fits.
 */
function buildPrompt(session, userText) {
    const label = 'User: '
    const rawMessage = String(userText || '').replace(/\s+/g, ' ').trim()
    const maxMessage = PROMPT_BUDGET - label.length
    const messageTruncated = rawMessage.length > maxMessage
    const message = messageTruncated ? rawMessage.slice(0, maxMessage - 1).trimEnd() : rawMessage

    const segments = []
    const factsLine = factsToLine(session)
    if (factsLine) segments.push(factsLine)
    if (session?.lastUser) segments.push(`Earlier the user said: ${shorten(session.lastUser)}`)
    if (session?.lastAssistant) segments.push(`You answered: ${shorten(session.lastAssistant)}`)
    for (const turn of (session?.history || []).slice(-4, -1)) {
        if (turn?.u) segments.push(`Earlier the user said: ${shorten(turn.u)}`)
        if (turn?.a) segments.push(`You answered: ${shorten(turn.a)}`)
    }

    const kept = []
    let used = label.length + message.length
    for (const segment of segments) {
        const line = shorten(segment)
        if (!line) continue
        if (used + line.length + 1 > PROMPT_BUDGET) continue
        kept.push(line)
        used += line.length + 1
    }

    const prompt = kept.length ? `${kept.join('\n')}\n${label}${message}` : `${label}${message}`
    return { prompt, messageTruncated, used: prompt.length }
}

/* ----------------------------- provider call ---------------------------- */

function httpGetJson(urlString, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false
        const finish = (value) => { if (!settled) { settled = true; resolve(value) } }

        let request
        try {
            request = https.get(urlString, { headers: { accept: 'application/json', 'user-agent': 'DARKNOTE/5.1.0' } }, (response) => {
                const chunks = []
                response.on('data', chunk => chunks.push(chunk))
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8')
                    let json = null
                    try { json = JSON.parse(body) } catch { json = null }
                    finish({ status: Number(response.statusCode) || 0, json, body: body.slice(0, 300) })
                })
                response.on('error', error => finish({ status: 0, error: error?.message || 'response stream error' }))
            })
        } catch (error) {
            return finish({ status: 0, error: error?.message || 'request could not be created' })
        }

        request.setTimeout(timeoutMs, () => {
            try { request.destroy(new Error(`AI request timed out after ${timeoutMs}ms`)) } catch { }
        })
        request.on('error', error => finish({ status: 0, error: error?.message || 'network error' }))
    })
}

async function askOnce(prompt, settings) {
    const url = new URL(settings.endpoint)
    url.searchParams.set('prompt', prompt)
    url.searchParams.set('apikey', settings.apikey)

    const response = await httpGetJson(url.toString(), settings.timeoutMs)

    if (response.status === 401) {
        return { ok: false, retry: false, code: 'INVALID_API_KEY', reason: response.json?.message || 'The AI provider rejected the API key.' }
    }
    if (response.status === 400) {
        return { ok: false, retry: false, code: 'PROMPT_REJECTED', reason: response.json?.message || `The AI provider rejected a ${prompt.length} character prompt.` }
    }
    if (!response.json) {
        const retry = response.status === 0 || response.status >= 500 || /<html/i.test(response.body || '')
        return { ok: false, retry, code: 'BAD_RESPONSE', reason: response.error || `HTTP ${response.status} returned a non-JSON body: ${response.body || '(empty)'}` }
    }

    if (response.json.status === true) {
        const result = response.json.result || {}
        const answer = result.answer ?? result.message ?? result.text ?? response.json.answer
        if (typeof answer === 'string' && answer.trim()) return { ok: true, answer: answer.trim() }
        return { ok: false, retry: true, code: 'EMPTY_ANSWER', reason: 'The AI provider returned an empty answer.' }
    }

    const code = String(response.json.error || `HTTP_${response.status}`)
    const retry = RETRYABLE_CODES.has(code) || response.status === 429 || response.status >= 500
    return { ok: false, retry, code, reason: response.json.message || code }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function ask(prompt, settings) {
    const attempts = Math.max(1, Number(settings.retries) + 1)
    let last = { ok: false, code: 'UNKNOWN', reason: 'The AI request was never attempted.' }

    for (let attempt = 0; attempt < attempts; attempt++) {
        last = await askOnce(prompt, settings)
        if (last.ok) return { ...last, attempts: attempt + 1 }
        if (!last.retry) return { ...last, attempts: attempt + 1 }
        if (attempt < attempts - 1) {
            const backoff = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]
            console.error(`[AI] ${last.code}: ${last.reason} — retrying in ${backoff}ms (attempt ${attempt + 1}/${attempts})`)
            await sleep(backoff)
        }
    }
    return { ...last, attempts }
}

/* ----------------------------- user facing ------------------------------ */

function memorySummary(session) {
    const facts = session?.facts && typeof session.facts === 'object' ? session.facts : {}
    const labels = { name: 'Name', age: 'Age', location: 'Location', work: 'Work', likes: 'Likes', dislikes: 'Dislikes', language: 'Preferred language' }
    const lines = Object.keys(labels).filter(key => facts[key]).map(key => `• ${labels[key]}: ${facts[key]}`)
    for (const note of session?.notes || []) lines.push(`• Note: ${note}`)
    if (!lines.length) lines.push('• No personal details stored yet.')
    return [
        '🧠 *DARKNOTE AI MEMORY*',
        '',
        ...lines,
        '',
        `Turns remembered: ${Number(session?.turns) || 0}`,
        `Session: ${session?.key || 'unknown'}`
    ].join('\n')
}

function userMessageFor(result) {
    switch (result.code) {
        case 'INVALID_API_KEY': return '❌ The AI provider rejected the configured API key.'
        case 'PROMPT_REJECTED': return '❌ The AI provider rejected that request. Try a shorter message.'
        case 'PROVIDER_TIMEOUT': return '⏳ The AI provider timed out. Please try again.'
        case 'EMPTY_ANSWER': return '❌ The AI provider returned an empty answer. Please try again.'
        default: return '❌ The AI service is unavailable right now. Please try again shortly.'
    }
}

function typing(conn, m) {
    try {
        // Presence stays lifecycle-gated by the single existing socket, exactly
        // like the rest of the project. A failure here must never break a reply.
        if (conn?.__darknoteConnectionState !== 'open') return
        if (typeof conn.sendPresenceUpdate !== 'function') return
        const target = m?.chat || m?.key?.remoteJid
        if (!target) return
        Promise.resolve(conn.sendPresenceUpdate('composing', target)).catch(() => { })
    } catch { }
}

/**
 * Main entry point used by the existing command case.
 * Returns a small result object so the caller can log the real reason.
 */
async function handleAiCommand(conn, m, args, reply) {
    const settings = getSettings()
    const prefix = settings.prefix

    if (!settings.enabled) {
        await reply('❌ The AI chat is currently disabled.')
        return { ok: false, code: 'DISABLED' }
    }

    const key = sessionKey(m)
    if (!key) {
        await reply('❌ I could not identify this chat session.')
        return { ok: false, code: 'NO_SESSION' }
    }

    const input = Array.isArray(args) ? args : []
    const first = String(input[0] || '').toLowerCase()

    if (first === 'reset' || first === 'clear' || first === 'forget') {
        const cleared = resetSession(key)
        await reply(cleared ? '🧹 Memory cleared for this session.' : 'ℹ️ There was no stored memory for this session.')
        return { ok: true, code: cleared ? 'RESET' : 'NOTHING_TO_RESET' }
    }

    if (first === 'memory' || first === 'mem' || first === 'history') {
        await reply(memorySummary(loadSession(key)))
        return { ok: true, code: 'MEMORY' }
    }

    let text = input.join(' ').trim()
    if (!text) {
        const quoted = String(m?.quoted?.text || m?.quoted?.caption || '').trim()
        if (quoted) text = quoted
    }

    if (!text) {
        await reply([
            `🤖 *DARKNOTE AI*`,
            '',
            `Usage: ${prefix}ai <message>`,
            `Reply to any message with ${prefix}ai to ask about it.`,
            '',
            `${prefix}aireset — clear this session memory`,
            `${prefix}aimem — show what I remember`
        ].join('\n'))
        return { ok: false, code: 'NO_INPUT' }
    }

    if (text.length > 4000) text = text.slice(0, 4000)

    if (inFlight.has(key)) {
        await reply('⏳ I am still answering your previous message. Please wait a moment.')
        return { ok: false, code: 'BUSY' }
    }

    inFlight.add(key)
    try {
        const session = loadSession(key)
        const { prompt, messageTruncated } = buildPrompt(session, text)

        // Safety net: the provider rejects anything above its measured limit.
        if (prompt.length > PROVIDER_MAX_PROMPT) {
            console.error(`[AI] prompt budget overflow (${prompt.length} chars) — refusing to send`)
            await reply('❌ That message is too long for the AI provider. Please shorten it.')
            return { ok: false, code: 'BUDGET_OVERFLOW' }
        }

        typing(conn, m)
        const result = await ask(prompt, settings)

        if (!result.ok) {
            console.error(`[AI] request failed after ${result.attempts} attempt(s): ${result.code} — ${result.reason}`)
            await reply(userMessageFor(result))
            return { ok: false, code: result.code, reason: result.reason }
        }

        let answer = String(result.answer).trim()
        let answerTruncated = false
        if (answer.length > MAX_REPLY_CHARS) {
            answer = `${answer.slice(0, MAX_REPLY_CHARS).trimEnd()}…`
            answerTruncated = true
        }

        // Persist the turn only after the provider actually answered, so a
        // failed call never pollutes the memory with something that never
        // happened.
        extractFacts(text, session)
        session.turns = (Number(session.turns) || 0) + 1
        session.lastUser = shorten(text, 120)
        session.lastAssistant = shorten(answer, 120)
        session.history.push({ u: shorten(text, 120), a: shorten(answer, 120), t: Date.now() })
        session.history = session.history.slice(-HISTORY_TURNS)
        saveSession(session)

        let out = answer
        if (messageTruncated || answerTruncated) out += '\n\n_✂️ trimmed to fit the AI provider limit_'
        await reply(out)

        return { ok: true, code: 'ANSWER', attempts: result.attempts, promptLength: prompt.length }
    } catch (error) {
        console.error('[AI] unexpected failure:', error?.stack || error)
        await reply('❌ The AI chat hit an unexpected error. Please try again.')
        return { ok: false, code: 'EXCEPTION', reason: error?.message || String(error) }
    } finally {
        inFlight.delete(key)
    }
}

async function handleAiReset(conn, m, reply) {
    const key = sessionKey(m)
    if (!key) {
        await reply('❌ I could not identify this chat session.')
        return { ok: false, code: 'NO_SESSION' }
    }
    const cleared = resetSession(key)
    await reply(cleared ? '🧹 Memory cleared for this session.' : 'ℹ️ There was no stored memory for this session.')
    return { ok: true, code: cleared ? 'RESET' : 'NOTHING_TO_RESET' }
}

async function handleAiMemory(conn, m, reply) {
    const key = sessionKey(m)
    if (!key) {
        await reply('❌ I could not identify this chat session.')
        return { ok: false, code: 'NO_SESSION' }
    }
    await reply(memorySummary(loadSession(key)))
    return { ok: true, code: 'MEMORY' }
}

module.exports = {
    handleAiCommand,
    handleAiReset,
    handleAiMemory,
    // Exported for the audit harness and for reuse by other modules.
    sessionKey,
    buildPrompt,
    extractFacts,
    loadSession,
    saveSession,
    resetSession,
    memorySummary,
    ask,
    getSettings,
    STORE_PATH
}
