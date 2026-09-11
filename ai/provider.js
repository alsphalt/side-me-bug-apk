'use strict'

/*
 * DARKNOTE AI — provider compatibility layer.
 *
 * This file used to hold the single-provider adapter. It is now a thin facade
 * over the multi-provider router, kept so that existing callers
 * (ai/chatbot.js, lib/ai-chat.js) do not have to change their import.
 *
 * The real work lives in:
 *   ai/providers.js  — the registry: one object per provider, add a provider here
 *   ai/router.js     — objective routing, ranking, fallback
 *   ai/health.js     — provider health and cooldown
 *   ai/transport.js  — HTTP
 *
 * Nothing here is provider-specific any more.
 */

const router = require('./router')
const providers = require('./providers')
const health = require('./health')
const objectives = require('./objectives')

/*
 * The canonical capability statement for the WHOLE provider pool.
 *
 * These are measured results, not assumptions. Where no provider has been
 * verified for a capability, the value is false and the router refuses, rather
 * than pretending and failing in front of a user.
 */
const POOL_CAPABILITIES = {
    textChat: true,
    conversationContext: 'inline-text-only',
    longConversations: true,          // via /api/ai/chat, up to ~924 chars
    maxPromptChars: 924,              // the best any provider here can take
    gatewayMaxPromptChars: 302,       // the cap shared by the ?prompt= family
    fileAnalysis: false,
    imageUnderstanding: false,
    webSearch: false,
    translation: false,               // a SEPARATE platform endpoint exists, not a chat capability
    structuredOutput: 'soft',
    imageGeneration: false,           // a SEPARATE endpoint exists (/api/fluxv2), not a chat capability
    imageEditing: false,
    stickerGeneration: false,         // possible locally with sharp, not via these providers
    toolCalling: false,
    streaming: false,
    systemPrompt: false,              // silently ignored
    historyParameter: false,          // silently ignored
    multiProviderRouting: true,
    providerFallback: true,
    providerHealthTracking: true,
    notes: [
        '302 characters is a GATEWAY limit shared by every ?prompt= provider, not a model limit.',
        '/api/ai/chat (POST {question}) accepts ~924 characters and is the only long-context provider.',
        'system= and history= parameters are accepted and silently ignored, so context must be inline text.',
        'Image understanding cannot be faked: verification showed the model cannot view images or fetch links.',
        'Image generation and translation exist as separate platform endpoints, not as chat capabilities.'
    ]
}

/** Backwards-compatible alias used by older callers and tests. */
const MZAZI_CAPABILITIES = POOL_CAPABILITIES

/** Capabilities of the whole pool. */
function capabilities() {
    return POOL_CAPABILITIES
}

/** Per-provider capability rows, for the status command. */
function capabilityMatrix() {
    return router.capabilityMatrix()
}

/**
 * Route a prompt. Same signature and same result shape as the old
 * single-provider ask(), plus provider/objective/usedFallback metadata.
 */
function ask(prompt, settings, options = {}) {
    return router.ask(prompt, settings, options)
}

/** Ask again via a different provider. Used for repeated questions. */
function askDifferent(prompt, settings, avoidProvider, options = {}) {
    return router.askDifferent(prompt, settings, avoidProvider, options)
}

/** Single attempt against one named provider. Kept for diagnostics and tests. */
async function askOnce(prompt, settings, providerId) {
    const provider = providers.getProvider(providerId) || providers.PROVIDERS[0]
    const outcome = await router.ask(prompt, { ...settings, disabledProviders: providers.providerIds().filter(id => id !== provider.id) })
    return { ok: outcome.ok, answer: outcome.answer, provider: provider.id, code: outcome.code, reason: outcome.reason, attempts: outcome.attempts }
}

/** Short, natural, user-facing failure text. */
function userMessageFor(result) {
    return router.userMessageFor(result)
}

/** Live health snapshot for every registered provider. */
function healthSnapshot() {
    return health.snapshot(providers.providerIds())
}

module.exports = {
    ask,
    askDifferent,
    askOnce,
    userMessageFor,
    capabilities,
    capabilityMatrix,
    healthSnapshot,
    POOL_CAPABILITIES,
    MZAZI_CAPABILITIES,
    objectives,
    // re-exported so a caller needing the registry does not import three files
    registry: providers,
    router,
    health
}
