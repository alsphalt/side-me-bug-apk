'use strict'

/*
 * DARKNOTE AI — PROVIDER REGISTRY.
 *
 * ============================================================================
 * ADDING A NEW PROVIDER: add one object to PROVIDERS below. That is all.
 * No other file needs to change — the router, health tracker, status command
 * and fallback logic all read from this registry. There is no switch statement
 * anywhere keyed on a provider name.
 * ============================================================================
 *
 * Every value in the "measured" block below is a TEST RESULT against the live
 * API, not an assumption. The endpoint names say "gpt-5", "claude-opus-4.6" and
 * "gemini-3.1-pro", which tells us NOTHING about behaviour, so each was probed.
 *
 * MEASUREMENT DATE: 2026-09-11
 *
 *   provider          transport                 prompt cap   reliability   maths
 *   ---------------------------------------------------------------------------
 *   gpt-5             GET  ?prompt=             302          3/3           391
 *   claude-opus-4.6   GET  ?prompt=             302          3/3           391
 *   gemini-3.1-pro    GET  ?prompt=             302          3/3           391
 *   chat              POST json {question}      ~924         5/5           391
 *   blackbox          GET  ?q=                  302          0/5           n/a
 *
 * KEY FINDINGS
 *
 *  1. THE 302 LIMIT IS A GATEWAY LIMIT, NOT A MODEL LIMIT. gpt-5, Claude Opus
 *     4.6 and Gemini 3.1 Pro ALL reject a 303-character prompt with the
 *     identical HTTP 400 INVALID_PARAMETER. Verified twice.
 *
 *  2. /api/ai/chat DOES NOT SHARE THAT LIMIT. It is a POST endpoint taking
 *     {"question": "..."} and a binary search showed 924 characters accepted.
 *     A 925-character attempt returned a rate-limit notice rather than a length
 *     error, so the true ceiling is approximate, but it is comfortably 3x the
 *     gateway cap. This is the ONLY provider that can carry real conversation
 *     context, so the router sends any prompt over 302 chars straight to it.
 *
 *  3. BLACKBOX IS CURRENTLY BROKEN. It takes q= (not prompt=) and answered
 *     "OK" once, then returned 502 PROVIDER_ERROR or 504 PROVIDER_TIMEOUT on
 *     five consecutive attempts. It is registered, marked UNVERIFIED, and given
 *     the lowest priority so it is only tried when nothing else can serve.
 *
 *  4. /api/ai/chat REPORTS AS THE SAME BACKEND AS gemini-3.1-pro (it self-
 *     identifies as gemini-3.1-pro-preview) but with a far higher prompt cap and
 *     better reliability, so it is treated as its own provider.
 *
 *  5. A TRAP WORTH KNOWING: every error envelope on this platform carries a
 *     human-readable `message` field. Treating `message` as the answer would
 *     show users raw error text. Every extractor below therefore requires
 *     status === true (or a top-level `response`) before reading any text.
 *
 * CAPABILITY HONESTY: no provider here has been verified to accept an image, a
 * file, a web search or a tool call. Those capabilities are declared false and
 * the router will refuse rather than pretend. Quality rankings (which model is
 * "best" at coding) were NOT benchmarked — the priority tables are a documented
 * starting heuristic, tunable in config.json, and are labelled as such.
 */

/* --------------------------- normalised capability ------------------------ */

/** A capability block used when a provider has NOT been verified for anything beyond text. */
function textOnlyCapabilities(overrides = {}) {
    return {
        textChat: true,
        conversationContext: 'inline-text-only',
        imageUnderstanding: false,
        fileAnalysis: false,
        webSearch: false,
        translation: false,
        imageGeneration: false,
        imageEditing: false,
        stickerGeneration: false,
        toolCalling: false,
        streaming: false,
        systemPrompt: false,
        ...overrides
    }
}

/* -------------------------------- extraction ----------------------------- */

/**
 * Standard envelope for the GET ?prompt= family:
 *   { status: true, creator, result: { answer: "..." } }
 * Requires status === true so an error `message` can never be mistaken for text.
 */
function extractStandard(json) {
    if (!json || json.status !== true) return null
    const result = json.result
    if (typeof result === 'string' && result.trim()) return result.trim()
    if (result && typeof result === 'object') {
        for (const key of ['answer', 'message', 'text', 'content', 'output']) {
            if (typeof result[key] === 'string' && result[key].trim()) return result[key].trim()
        }
    }
    return null
}

/**
 * /api/ai/chat envelope, which is NOT wrapped:
 *   { "response": "..." }
 * and on failure: { "error": "Please ask a question first." }
 */
function extractChat(json) {
    if (!json) return null
    if (typeof json.response === 'string' && json.response.trim()) return json.response.trim()
    if (typeof json.answer === 'string' && json.answer.trim()) return json.answer.trim()
    return null
}

/* ------------------------------- error codes ----------------------------- */

const RATE_LIMIT_PATTERNS = [/too many requests/i, /please wait a moment/i, /rate limit/i]

function classifyStandard(status, json, raw) {
    const error = String(json?.error || '')
    const message = String(json?.message || '')
    return {
        authError: error === 'MISSING_API_KEY' || error === 'INVALID_API_KEY',
        promptTooLong: error === 'INVALID_PARAMETER' && /too long/i.test(message),
        missingParameter: error === 'MISSING_PARAMETER',
        rateLimited: status === 429 || RATE_LIMIT_PATTERNS.some(re => re.test(message) || re.test(raw)),
        serverError: status >= 500 || error === 'PROVIDER_ERROR' || error === 'PROVIDER_TIMEOUT' || error === 'UPSTREAM_ERROR' || /unavailable/i.test(message),
        code: error || (status ? `HTTP_${status}` : 'NETWORK'),
        reason: message || error || (status ? `HTTP ${status}` : 'network error')
    }
}

function classifyChat(status, json, raw) {
    const error = String(json?.error || '')
    return {
        authError: /api key/i.test(error),
        promptTooLong: /too long/i.test(error),
        missingParameter: /ask a question/i.test(error),
        rateLimited: status === 429 || RATE_LIMIT_PATTERNS.some(re => re.test(error) || re.test(raw)),
        serverError: status >= 500 || error.length > 0,
        code: error || (status ? `HTTP_${status}` : 'NETWORK'),
        reason: error || (status ? `HTTP ${status}` : 'network error')
    }
}

/* -------------------------- OpenAI (ChatGPT) ----------------------------- */

/**
 * ChatGPT envelope:
 *   { choices: [ { message: { role: 'assistant', content: "..." } } ] }
 *
 * A non-empty string is REQUIRED. A refusal arrives as a normal 200 with the
 * refusal in content, and a content-filtered or tool-call-only response arrives
 * as a 200 with `content: null`. Returning null in those cases makes the router
 * treat the attempt as failed and fall back, which is correct - the alternative
 * is sending the user an empty WhatsApp message.
 */
function extractOpenAI(json) {
    if (!json) return null
    const choice = Array.isArray(json.choices) ? json.choices[0] : null
    const content = choice?.message?.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    // Some deployments return an array of content parts instead of a plain string.
    if (Array.isArray(content)) {
        const joined = content
            .map(part => (typeof part?.text === 'string' ? part.text : ''))
            .join('')
            .trim()
        if (joined) return joined
    }
    return null
}

/**
 * ChatGPT error envelope:
 *   { error: { message: "...", type: "...", code: "..." } }
 *
 * `insufficient_quota` is deliberately NOT classified as a rate limit. It means
 * the account is out of credit, so retrying changes nothing; it is reported as an
 * auth failure so the router stops asking instead of burning the attempt budget
 * on a dead credential.
 */
function classifyOpenAI(status, json, raw) {
    const error = json?.error && typeof json.error === 'object' ? json.error : {}
    const code = String(error.code || error.type || '')
    const message = String(
        error.message
        || (typeof json?.error === 'string' ? json.error : '')
        || raw
        || ''
    )
    const outOfCredit = code === 'insufficient_quota' || /exceeded your current quota|check your plan and billing/i.test(message)
    return {
        authError: status === 401 || status === 403 || code === 'invalid_api_key' || outOfCredit,
        promptTooLong: code === 'context_length_exceeded' || /maximum context length|too many tokens/i.test(message),
        missingParameter: code === 'missing_required_parameter' || (status === 400 && /missing/i.test(message)),
        rateLimited: !outOfCredit && (status === 429 || code === 'rate_limit_exceeded' || /rate limit/i.test(message)),
        serverError: status >= 500 || code === 'server_error',
        code: code || (status ? `HTTP_${status}` : 'NETWORK'),
        reason: message.slice(0, 200) || (status ? `HTTP ${status}` : 'network error')
    }
}

/* ======================================================================== */
/*                              THE REGISTRY                                 */
/* ======================================================================== */

const PROVIDERS = [
    {
        /*
         * CHATGPT (OpenAI) — the owner's own OpenAI account.
         *
         * This is the ONLY provider in this file that is not the mzazi gateway,
         * and it differs in three ways that are handled explicitly:
         *
         *   1. ITS OWN BASE URL. Every other provider appends its path to the
         *      shared `settings.baseUrl`. That value is the mzazi gateway, so
         *      reusing it here would post an OpenAI path to mzazi. `baseUrl` on
         *      the provider object wins, and the shared value is left alone, so
         *      the rest of the pool keeps working as a fallback.
         *
         *   2. ITS OWN KEY (apiKeyEnv). The pool shares one mzazi credential;
         *      this one uses OPENAI_API_KEY. The router therefore must NOT abort
         *      the whole fallback chain when THIS provider's key is rejected, so
         *      it aborts only for providers with no apiKeyEnv of their own.
         *
         *   3. A KEY IN A HEADER, NOT A URL. Every ?prompt= provider puts the key
         *      in the query string, which is why they all set
         *      `urlIsSecretFree: false`. Here the key travels in the
         *      Authorization header, so the URL is safe.
         *
         * NOT MEASURED. No request has ever been made against this endpoint from
         * this repo, because it needs a credential the code does not have. The
         * limits below are conservative budgeting figures, NOT probe results, and
         * they are recorded as such rather than being given a fake verification
         * date. Nothing in this file should claim otherwise until the owner's key
         * is in place and a probe has actually run.
         */
        id: 'openai',
        label: 'ChatGPT (OpenAI)',
        // Its own gateway. Do not fall back to settings.baseUrl (see note 1).
        baseUrl: 'https://api.openai.com/v1',
        endpointPath: '/chat/completions',
        method: 'POST',
        authStyle: 'bearer',
        parameter: 'prompt',
        envelope: 'openai',
        apiKeyEnv: 'OPENAI_API_KEY',
        /*
         * This provider must NEVER borrow the shared pool key. Sending a mzazi
         * credential to api.openai.com is a guaranteed 401, which would look
         * like an OpenAI outage and would log a misleading auth error. Without a
         * key of its own it is simply not a candidate.
         */
        requireOwnKey: true,
        // Used when config.json -> ai.model is empty.
        model: 'gpt-4o-mini',
        // This endpoint has no 302-character gateway, unlike the ?prompt= family.
        measured: {
            promptLimit: null,
            reliability: 'unverified',
            latencyMs: 'unknown',
            verifiedOn: '',
            notes: 'NOT MEASURED - needs the owner\'s OPENAI_API_KEY. maxPromptChars is a conservative budget (~3k tokens), not a measured gateway cap.'
        },
        capabilities: textOnlyCapabilities({ maxPromptChars: 12000 }),
        /*
         * Highest priority in every objective while the owner has deliberately
         * selected this provider. The ranking is a heuristic, not a benchmark -
         * what is deliberate here is that choosing "openai" in config.json
         * actually means ChatGPT is used, rather than being one voice in a pool.
         */
        priority: { casual: 100, general: 100, reasoning: 100, coding: 100, translation: 95, longcontext: 100, default: 100 },
        buildRequest(prompt, settings) {
            return {
                url: `${this.baseUrl}${this.endpointPath}`,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${settings.apiKey}`
                },
                body: {
                    model: String(settings.model || '').trim() || this.model,
                    messages: [{ role: 'user', content: prompt }]
                }
            }
        },
        extract: extractOpenAI,
        classify: classifyOpenAI,
        // The key is in the Authorization header, so logging this URL leaks nothing.
        urlIsSecretFree: true
    },
    {
        id: 'chat',
        label: 'Chat',
        endpointPath: '/api/ai/chat',
        method: 'POST',
        authStyle: 'body',
        parameter: 'question',
        envelope: 'chat',
        measured: {
            promptLimit: 924,
            reliability: '5/5',
            latencyMs: '1.4-2.5s',
            verifiedOn: '2026-09-11',
            notes: 'Only provider that accepts long prompts. Self-reports as gemini-3.1-pro-preview.'
        },
        capabilities: textOnlyCapabilities({
            conversationContext: 'full-transcript-up-to-limit',
            longConversations: true,
            maxPromptChars: 924
        }),
        // Preferred for anything conversational or context-heavy, and the only
        // option once a prompt exceeds the 302 gateway cap.
        priority: { casual: 10, general: 70, reasoning: 60, coding: 60, translation: 60, longcontext: 100, default: 60 },
        buildRequest(prompt, settings) {
            return {
                url: `${settings.baseUrl}${this.endpointPath}`,
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: { question: prompt, apikey: settings.apiKey }
            }
        },
        extract: extractChat,
        classify: classifyChat,
        // The key travels in the body here, so the URL is safe to log.
        urlIsSecretFree: true
    },
    {
        id: 'claude-opus-4.6',
        label: 'Claude Opus 4.6',
        endpointPath: '/api/ai/claude-opus-4.6',
        method: 'GET',
        authStyle: 'query',
        parameter: 'prompt',
        envelope: 'standard',
        measured: { promptLimit: 302, reliability: '3/3', latencyMs: '1.6-3.1s', verifiedOn: '2026-09-11' },
        capabilities: textOnlyCapabilities({ maxPromptChars: 302 }),
        // Strongest reasoning/coding claim is a HEURISTIC, not a benchmark.
        priority: { casual: 50, general: 100, reasoning: 100, coding: 100, translation: 90, longcontext: 0, default: 90 },
        buildRequest(prompt, settings) {
            return { url: `${settings.baseUrl}${this.endpointPath}?prompt=${encodeURIComponent(prompt)}&apikey=${encodeURIComponent(settings.apiKey)}`, method: 'GET' }
        },
        extract: extractStandard,
        classify: classifyStandard,
        urlIsSecretFree: false
    },
    {
        id: 'gpt-5',
        label: 'GPT-5',
        endpointPath: '/api/ai/gpt-5',
        method: 'GET',
        authStyle: 'query',
        parameter: 'prompt',
        envelope: 'standard',
        measured: { promptLimit: 302, reliability: '3/3', latencyMs: '2.1-2.5s', verifiedOn: '2026-09-11' },
        capabilities: textOnlyCapabilities({ maxPromptChars: 302 }),
        priority: { casual: 60, general: 95, reasoning: 95, coding: 95, translation: 85, longcontext: 0, default: 85 },
        buildRequest(prompt, settings) {
            return { url: `${settings.baseUrl}${this.endpointPath}?prompt=${encodeURIComponent(prompt)}&apikey=${encodeURIComponent(settings.apiKey)}`, method: 'GET' }
        },
        extract: extractStandard,
        classify: classifyStandard,
        urlIsSecretFree: false
    },
    {
        id: 'gemini-3.1-pro',
        label: 'Gemini 3.1 Pro',
        endpointPath: '/api/ai/gemini-3.1-pro',
        method: 'GET',
        authStyle: 'query',
        parameter: 'prompt',
        envelope: 'standard',
        measured: { promptLimit: 302, reliability: '3/3', latencyMs: '1.5-2.0s', verifiedOn: '2026-09-11' },
        capabilities: textOnlyCapabilities({ maxPromptChars: 302 }),
        priority: { casual: 70, general: 90, reasoning: 85, coding: 80, translation: 80, longcontext: 0, default: 80 },
        buildRequest(prompt, settings) {
            return { url: `${settings.baseUrl}${this.endpointPath}?prompt=${encodeURIComponent(prompt)}&apikey=${encodeURIComponent(settings.apiKey)}`, method: 'GET' }
        },
        extract: extractStandard,
        classify: classifyStandard,
        urlIsSecretFree: false
    },
    {
        id: 'blackbox',
        label: 'Blackbox',
        endpointPath: '/api/ai/blackbox',
        method: 'GET',
        authStyle: 'query',
        // NOTE THE DIFFERENT PARAMETER NAME - using "prompt" returns
        // MISSING_PARAMETER and looks like an outage when it is a param mistake.
        parameter: 'q',
        envelope: 'standard',
        measured: {
            promptLimit: 302,
            reliability: '0/5',
            latencyMs: '1.1-7.3s',
            verifiedOn: '2026-09-11',
            notes: 'Answering "OK" once then 502/504 on five consecutive attempts. Registered but untrusted.'
        },
        capabilities: textOnlyCapabilities({ maxPromptChars: 302 }),
        // Lowest priority: only tried when every other provider is unavailable.
        priority: { casual: 5, general: 10, reasoning: 10, coding: 10, translation: 10, longcontext: 0, default: 10 },
        buildRequest(prompt, settings) {
            return { url: `${settings.baseUrl}${this.endpointPath}?q=${encodeURIComponent(prompt)}&apikey=${encodeURIComponent(settings.apiKey)}`, method: 'GET' }
        },
        extract: extractStandard,
        classify: classifyStandard,
        urlIsSecretFree: false
    },
    {
        /*
         * Added on request. MEASURED on 2026-09-12 and it is the most reliable
         * provider in the pool: 4/4 clean answers, 1.2-2.4s, and it handled
         * Kiswahili/Sheng and emotional tone naturally.
         *
         * HONEST NOTE ON THE NAME: despite "thinking", the response carries NO
         * reasoning trace - `result` has exactly one key, `answer`. The older
         * /api/ai/deepseek endpoint did expose its reasoning, so this one is not
         * assumed to just because of the name. Nothing here reads a trace field.
         */
        id: 'deepseek-v3.2-thinking',
        label: 'DeepSeek V3.2 Thinking',
        endpointPath: '/api/ai/deepseek-v3.2-thinking',
        method: 'GET',
        authStyle: 'query',
        parameter: 'prompt',
        envelope: 'standard',
        // This provider was handed its own credential, so it uses that one and
        // falls back to the shared key if the variable is ever removed.
        apiKeyEnv: 'MZAZI_API_KEY_DEEPSEEK',
        measured: {
            promptLimit: 302,
            reliability: '4/4',
            latencyMs: '1.2-2.4s',
            verifiedOn: '2026-09-12',
            notes: 'Most reliable provider tested. No reasoning trace exposed despite the name.'
        },
        capabilities: textOnlyCapabilities({ maxPromptChars: 302 }),
        // Priority is a tunable heuristic, NOT a benchmark. What IS measured is
        // the 4/4 reliability and the low latency, which is why it sits at the
        // top of the reasoning and general tiers alongside Claude and GPT-5.
        priority: { casual: 62, general: 96, reasoning: 100, coding: 90, translation: 86, longcontext: 0, default: 88 },
        buildRequest(prompt, settings) {
            return { url: `${settings.baseUrl}${this.endpointPath}?prompt=${encodeURIComponent(prompt)}&apikey=${encodeURIComponent(settings.apiKey)}`, method: 'GET' }
        },
        extract: extractStandard,
        classify: classifyStandard,
        urlIsSecretFree: false
    }
]

const byId = new Map(PROVIDERS.map(p => [p.id, p]))

function getProvider(id) {
    return byId.get(String(id || '').toLowerCase()) || null
}

/** Every provider id, in registry (config-file) order. */
function providerIds() {
    return PROVIDERS.map(p => p.id)
}

/** Providers from the registry, optionally filtered. */
function listProviders(predicate) {
    return PROVIDERS.filter(p => (typeof predicate === 'function' ? predicate(p) : true))
}

module.exports = {
    PROVIDERS,
    getProvider,
    providerIds,
    listProviders,
    textOnlyCapabilities,
    extractStandard,
    extractChat,
    extractOpenAI,
    classifyStandard,
    classifyChat,
    classifyOpenAI
}
