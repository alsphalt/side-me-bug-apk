'use strict'

/*
 * DARKNOTE AI — the central router.
 *
 *   prompt
 *     -> objective detection            (what does the user want?)
 *     -> capability filtering           (who is even able to serve it?)
 *     -> health filtering               (who is usable right now?)
 *     -> priority ranking               (who is best for this objective?)
 *     -> attempt, with fallback         (bounded, no loops)
 *     -> ONE normalised answer
 *
 * DESIGN RULES ENFORCED HERE
 *  - The user never learns which provider served, or that one failed.
 *  - A prompt longer than a provider's measured window is never sent to it.
 *  - A bad API key aborts immediately: it is a shared credential, so retrying a
 *    different provider would fail identically and waste the user's time.
 *  - Total attempts are bounded by BOTH a provider count and an attempt count,
 *    so a fallback chain can never loop (A -> B -> C -> A ...).
 *  - A rate-limited provider is skipped in favour of another, which is exactly
 *    what fallback is for.
 *  - The prompt is identical whichever provider serves it, so conversation
 *    continuity survives a mid-conversation provider switch.
 */

const transport = require('./transport')
const providers = require('./providers')
const health = require('./health')
const objectives = require('./objectives')

const MAX_PROVIDERS_PER_REQUEST = 3
const MAX_ATTEMPTS_PER_REQUEST = 3

/* ------------------------------- ranking --------------------------------- */

function priorityOf(provider, objective) {
    const table = provider.priority || {}
    const value = table[objective]
    if (typeof value === 'number') return value
    return typeof table.default === 'number' ? table.default : 50
}

/**
 * Build the ordered candidate list.
 * Returns { candidates, rejected } where rejected explains every exclusion, so
 * the console can say WHY a provider was skipped without guessing.
 */
function rank(settings, { objective, promptLength, exclude = [], force = '' }) {
    const rejected = []
    const candidates = []
    const disabledList = Array.isArray(settings.disabledProviders) ? settings.disabledProviders : []

    for (const provider of providers.listProviders()) {
        const id = provider.id
        const disabled = disabledList.includes(id) || settings.providers?.[id]?.enabled === false
        if (disabled) { rejected.push({ id, why: 'disabled' }); continue }
        if (exclude.includes(id)) { rejected.push({ id, why: 'excluded' }); continue }

        /*
         * A provider that must bring its own credential cannot serve without it.
         * Excluding it here means a missing key reads as "not configured" rather
         * than as a full round-trip 401 that gets logged as an outage.
         */
        if (provider.requireOwnKey && !String(process.env[provider.apiKeyEnv] || '').trim()) {
            rejected.push({ id, why: `no-credential:${provider.apiKeyEnv}` })
            continue
        }

        const limit = Number(provider.capabilities?.maxPromptChars) || 302
        if (promptLength > limit) { rejected.push({ id, why: `prompt ${promptLength} > limit ${limit}` }); continue }

        if (!health.isAvailable(id, { disabled: false })) {
            rejected.push({ id, why: `health:${health.stateOf(id)}` })
            continue
        }

        let score = priorityOf(provider, objective)
        // An explicitly requested provider wins, but only if it can serve.
        if (force && force === id) score += 1000
        // Providers that have never answered yet are tried after proven ones,
        // unless they are forced. This keeps an untested provider from being
        // preferred over one with a live track record.
        const snap = health.snapshot([id])[0]
        if (snap && !snap.verified) score -= 25
        if (snap && snap.failures > 0) score -= Math.min(20, snap.failures * 5)

        candidates.push({ provider, score })
    }

    candidates.sort((a, b) => b.score - a.score)
    return { candidates: candidates.map(c => c.provider), rejected }
}

/* ------------------------------- attempts -------------------------------- */

function describeFailure(classification, status, error) {
    if (error) return { code: 'NETWORK', retryable: true, reason: error }
    if (classification.authError) return { code: 'INVALID_API_KEY', retryable: false, reason: classification.reason }
    if (classification.promptTooLong) return { code: 'PROMPT_REJECTED', retryable: false, reason: classification.reason }
    if (classification.rateLimited) return { code: 'RATE_LIMITED', retryable: true, reason: classification.reason }
    if (classification.serverError) {
        const timeout = status === 504 || /timeout/i.test(classification.code)
        return { code: timeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR', retryable: true, reason: classification.reason, timeout }
    }
    return { code: classification.code || `HTTP_${status}`, retryable: status === 0 || status >= 500, reason: classification.reason }
}

/**
 * Which key does this provider use?
 *
 * A provider may declare its own environment variable via `apiKeyEnv`, so a
 * provider that was handed its own credential uses that one. Everything else
 * falls back to the shared key, which means adding a provider never requires
 * inventing a new secret. The value is only ever read from the environment -
 * never from source, never logged.
 */
function resolveKey(provider, settings) {
    const envName = provider?.apiKeyEnv
    if (envName) {
        const value = String(process.env[envName] || '').trim()
        if (value) return value
        /*
         * No key of its own. A provider flagged `requireOwnKey` must not fall
         * back to the shared credential - that would send the wrong company's
         * key to a different API and report the resulting 401 as an outage.
         * Returning '' leaves the Authorization header empty, and rank() has
         * already excluded such a provider anyway.
         */
        if (provider.requireOwnKey) return ''
    }
    return settings.apiKey
}

async function attempt(provider, prompt, settings) {
    health.beginAttempt(provider.id)
    try {
        const built = provider.buildRequest(prompt, { ...settings, apiKey: resolveKey(provider, settings) })
        const response = await transport.request({
            url: built.url,
            method: built.method || 'GET',
            headers: built.headers || {},
            body: built.body ?? null,
            timeoutMs: settings.timeoutMs
        })

        const answer = provider.extract(response.json)

        if (answer) {
            health.markSuccess(provider.id, response.ms)
            return { ok: true, answer, provider: provider.id, latencyMs: response.ms }
        }

        const classification = provider.classify(response.status, response.json, response.body || response.error || '')
        const failure = describeFailure(classification, response.status, response.status === 0 ? response.error : '')
        health.markFailure(provider.id, failure.timeout ? 'timeout' : 'error', failure.reason, settings)
        return { ok: false, ...failure, provider: provider.id, status: response.status }
    } catch (error) {
        // Transport never throws, but never let an unexpected throw escape either.
        health.markFailure(provider.id, 'error', error?.message || 'unexpected error', settings)
        return { ok: false, code: 'NETWORK', retryable: true, reason: error?.message || 'unexpected error', provider: provider.id }
    } finally {
        health.endAttempt(provider.id)
    }
}

/* --------------------------------- ask ----------------------------------- */

/**
 * Route a prompt to the best available provider, falling back on failure.
 * Always resolves, never throws, never leaks which provider failed.
 */
async function ask(prompt, settings, options = {}) {
    const text = String(prompt || '')
    const objective = options.objective
        || objectives.detect(options.originalMessage || text, { promptLength: text.length, requested: options.forceProvider }).objective

    /*
     * WHICH PROVIDER IS PREFERRED.
     *
     * `options.forceProvider` wins when a caller names one explicitly. Failing
     * that, `settings.provider` is honoured: it is the value the owner sets in
     * config.json, and it was previously read NOWHERE in the codebase, so
     * choosing a provider there had no effect at all. 'router' - and an empty or
     * unrecognised value - keeps the original behaviour of ranking the whole pool.
     *
     * Forcing only adds a large ranking bonus (see rank()). A forced provider
     * that is unhealthy, or whose prompt window cannot fit the request, is still
     * skipped in favour of the rest of the pool, so this cannot turn a working
     * setup into a hard failure.
     */
    const configured = String(settings.provider || '').trim().toLowerCase()
    const forced = options.forceProvider
        || (configured && configured !== 'router' && providers.getProvider(configured) ? configured : '')

    const { candidates, rejected } = rank(settings, {
        objective,
        promptLength: text.length,
        exclude: options.excludeProviders || [],
        force: forced
    })

    if (!candidates.length) {
        const why = rejected.map(r => `${r.id}:${r.why}`).join(', ') || 'no providers registered'
        return {
            ok: false,
            code: 'NO_PROVIDER',
            objective,
            attempts: 0,
            reason: `No provider could serve this request (${why}).`,
            rejected
        }
    }

    const providerCap = Math.max(1, Math.min(MAX_PROVIDERS_PER_REQUEST, Number(settings.maxFallbacks) + 1 || MAX_PROVIDERS_PER_REQUEST))
    const attemptCap = Math.max(1, Math.min(MAX_ATTEMPTS_PER_REQUEST, Number(settings.maxAttempts) || MAX_ATTEMPTS_PER_REQUEST))
    const chain = candidates.slice(0, providerCap)

    const tried = []
    for (const provider of chain) {
        if (tried.length >= attemptCap) break
        tried.push(provider.id)

        const result = await attempt(provider, text, settings)
        if (result.ok) {
            return {
                ok: true,
                answer: result.answer,
                provider: result.provider,
                objective,
                attempts: tried.length,
                usedFallback: tried.length > 1,
                latencyMs: result.latencyMs
            }
        }

        /*
         * A SHARED credential being wrong stops the chain: every provider behind
         * the same key would fail identically, so retrying only burns the user's
         * time and produces a second, identical error.
         *
         * A provider that declares its OWN key (`apiKeyEnv`) is a different case.
         * Its credential is not the pool's, so a rejection says nothing about the
         * others and the chain must continue. Without this distinction a bad
         * OpenAI key would kill the mzazi fallbacks too - and vice versa - even
         * though the two credentials are unrelated.
         */
        const usesSharedKey = !provider.apiKeyEnv
        if (result.code === 'INVALID_API_KEY' && usesSharedKey) {
            return { ok: false, code: 'INVALID_API_KEY', objective, attempts: tried.length, reason: result.reason, tried }
        }

        console.error(`[AI] provider ${provider.id} failed (${result.code}): ${result.reason} — trying the next provider`)
    }

    const last = tried[tried.length - 1]
    return {
        ok: false,
        code: 'ALL_PROVIDERS_FAILED',
        objective,
        attempts: tried.length,
        reason: `Every suitable provider failed (tried: ${tried.join(', ')}).`,
        tried,
        lastProvider: last
    }
}

/**
 * Ask again using a DIFFERENT provider to the one that answered last time.
 * Used for a repeated question so the user does not get the identical answer
 * back from the identical model.
 */
async function askDifferent(prompt, settings, avoidProvider, options = {}) {
    const exclude = avoidProvider ? [avoidProvider] : []
    const first = await ask(prompt, settings, { ...options, excludeProviders: exclude })
    if (first.ok) return { ...first, varying: true }
    // If excluding it left nothing usable, fall back to the normal route so a
    // repeated question still gets an answer rather than an error.
    if (first.code === 'NO_PROVIDER' && exclude.length) {
        const retry = await ask(prompt, settings, options)
        return { ...retry, varying: false, note: 'only one provider was available' }
    }
    return first
}

/** Short, natural, user-facing text. Never a stack trace, never a provider name. */
function userMessageFor(result) {
    switch (result?.code) {
        case 'NO_API_KEY': return 'AI is not configured yet.'
        case 'INVALID_API_KEY': return 'My AI connection is misconfigured, sorry.'
        case 'PROMPT_REJECTED': return 'That message is a bit long for me. Can you shorten it?'
        case 'PROVIDER_TIMEOUT': return 'I took too long thinking about that one. Try again?'
        case 'RATE_LIMITED': return 'I am being asked a lot right now. Give me a few seconds and try again.'
        case 'EMPTY_ANSWER': return 'I drew a blank there. Say that again?'
        case 'NO_PROVIDER': return 'I cannot help with that one right now.'
        case 'ALL_PROVIDERS_FAILED': return 'My AI is having a moment. Try again shortly.'
        default: return 'My AI is having a moment. Try again shortly.'
    }
}

function capabilityMatrix() {
    return providers.listProviders().map(p => ({
        id: p.id,
        label: p.label,
        limit: p.capabilities?.maxPromptChars || 302,
        measured: p.measured,
        capabilities: p.capabilities,
        priority: p.priority
    }))
}

module.exports = {
    ask,
    askDifferent,
    rank,
    userMessageFor,
    capabilityMatrix,
    MAX_PROVIDERS_PER_REQUEST,
    MAX_ATTEMPTS_PER_REQUEST
}
