'use strict'

/*
 * The ChatGPT (OpenAI) provider: request shape, response envelope and error
 * classification. These are pure functions, so no network is involved.
 */

const providers = require('../ai/providers')

module.exports = function providersSuite({ section, ok, eq }) {
    section('ai/providers -- GPT-5.3 Chat (the owner\'s configured model)')

    const gpt53 = providers.getProvider('gpt-5.3-chat')
    ok('the gpt-5.3-chat provider is registered', Boolean(gpt53))
    if (gpt53) {
        eq('it routes to the mzazi gpt-5.3-chat endpoint', gpt53.endpointPath, '/api/ai/gpt-5.3-chat')
        eq('it is a GET provider (the ?prompt= family)', gpt53.method, 'GET')
        eq('it sends the prompt in ?prompt=', gpt53.parameter, 'prompt')
        /*
         * MEASURED, not assumed: 302 characters was accepted and 312 was
         * rejected with INVALID_PARAMETER, so it shares the same gateway cap as
         * the rest of the family. It must not be advertised as a long-context
         * provider, or the router would send it prompts it cannot take.
         */
        eq('its prompt cap is the measured 302', gpt53.capabilities.maxPromptChars, 302)
        eq('it records the measurement date', gpt53.measured.verifiedOn, '2026-09-12')
        eq('it records the measured limit', gpt53.measured.promptLimit, 302)
        ok('longcontext priority is 0 (a 302 cap cannot serve long input)',
            gpt53.priority.longcontext === 0, String(gpt53.priority.longcontext))
        ok('it declares text chat only',
            gpt53.capabilities.textChat === true
            && gpt53.capabilities.imageUnderstanding === false
            && gpt53.capabilities.imageGeneration === false)

        const built = gpt53.buildRequest('what are u doing?', {
            baseUrl: 'https://www.mzazi.shop',
            apiKey: 'mzazi_test'
        })
        eq('the request URL is the pool gateway plus its own path',
            built.url,
            `https://www.mzazi.shop/api/ai/gpt-5.3-chat?prompt=${encodeURIComponent('what are u doing?')}&apikey=mzazi_test`)
        eq('it is a GET', built.method, 'GET')

        section('ai/providers -- GPT-5.3 Chat envelope (measured responses)')

        eq('extracts the answer from the standard envelope',
            providers.extractStandard({ status: true, creator: 'MZAZI TECH', result: { answer: 'PROBE OK' } }),
            'PROBE OK')
        eq('an error envelope is not an answer',
            providers.extractStandard({ status: false, error: 'INVALID_API_KEY', message: 'The provided API key is invalid.' }),
            null)

        const badKey = gpt53.classify(401, { status: false, error: 'INVALID_API_KEY', message: 'The provided API key is invalid.' }, '')
        ok('401 INVALID_API_KEY is an auth error', badKey.authError === true)

        const limited = gpt53.classify(429, { status: false, error: 'RATE_LIMITED', message: 'Rate limit exceeded. Please try again later.' }, '')
        ok('429 RATE_LIMITED is a rate limit', limited.rateLimited === true)
        ok('429 is not treated as an auth error', limited.authError === false)

        const tooLong = gpt53.classify(400, { status: false, error: 'INVALID_PARAMETER', message: 'The prompt is too long.' }, '')
        ok('INVALID_PARAMETER with "too long" is promptTooLong', tooLong.promptTooLong === true)

        const timeout = gpt53.classify(504, { status: false, error: 'PROVIDER_TIMEOUT' }, '')
        ok('504 is a server error', timeout.serverError === true)
    }

    section('ai/providers -- ChatGPT (OpenAI) registration')

    const openai = providers.getProvider('openai')
    ok('the openai provider is registered', Boolean(openai))
    if (!openai) return

    eq('it uses its own base URL, not the shared gateway', openai.baseUrl, 'https://api.openai.com/v1')
    eq('it reads its own credential from OPENAI_API_KEY', openai.apiKeyEnv, 'OPENAI_API_KEY')
    ok('it must never borrow the shared pool key', openai.requireOwnKey === true)
    ok('its URL is safe to log (the key is in a header)', openai.urlIsSecretFree === true)
    ok('it declares text chat only, so no media module is switched on by it',
        openai.capabilities.textChat === true
        && openai.capabilities.imageUnderstanding === false
        && openai.capabilities.imageGeneration === false
        && openai.capabilities.imageEditing === false
        && openai.capabilities.fileAnalysis === false
        && openai.capabilities.toolCalling === false
        && openai.capabilities.streaming === false)

    const built = openai.buildRequest('hello world', { apiKey: 'sk-test-123', model: 'gpt-4o-mini' })
    eq('posts to /chat/completions', built.url, 'https://api.openai.com/v1/chat/completions')
    eq('uses POST', built.method, 'POST')
    eq('sends the key as a Bearer token', built.headers.authorization, 'Bearer sk-test-123')
    eq('sends JSON', built.headers['content-type'], 'application/json')
    eq('body shape', built.body, {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello world' }]
    })

    eq('falls back to the provider default model when unset',
        openai.buildRequest('x', { apiKey: 'sk-test' }).body.model, openai.model)
    eq('ignores a whitespace-only model',
        openai.buildRequest('x', { apiKey: 'sk-test', model: '   ' }).body.model, openai.model)
    eq('uses a custom model when given one',
        openai.buildRequest('x', { apiKey: 'sk-test', model: 'gpt-4o' }).body.model, 'gpt-4o')

    section('ai/providers -- OpenAI response envelope')

    eq('extracts the answer',
        providers.extractOpenAI({ choices: [{ message: { content: 'Hi there' } }] }), 'Hi there')
    eq('trims the answer',
        providers.extractOpenAI({ choices: [{ message: { content: '  Hi  ' } }] }), 'Hi')
    eq('null content is not an answer',
        providers.extractOpenAI({ choices: [{ message: { content: null } }] }), null)
    eq('blank content is not an answer',
        providers.extractOpenAI({ choices: [{ message: { content: '   ' } }] }), null)
    eq('an empty choices list is not an answer', providers.extractOpenAI({ choices: [] }), null)
    eq('a missing choices key is not an answer', providers.extractOpenAI({}), null)
    eq('an error envelope is not an answer',
        providers.extractOpenAI({ error: { message: 'nope' } }), null)
    eq('joins a content-parts array',
        providers.extractOpenAI({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab')

    section('ai/providers -- OpenAI error classification')

    const badKey = providers.classifyOpenAI(401, {
        error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' }
    }, '')
    ok('401 is an auth error', badKey.authError === true)
    ok('401 is not treated as a rate limit', badKey.rateLimited === false)
    eq('401 keeps the provider error code', badKey.code, 'invalid_api_key')

    const forbidden = providers.classifyOpenAI(403, { error: { message: 'Forbidden' } }, '')
    ok('403 is an auth error', forbidden.authError === true)

    const limited = providers.classifyOpenAI(429, {
        error: { message: 'Rate limit reached for gpt-4o-mini', code: 'rate_limit_exceeded' }
    }, '')
    ok('429 is a rate limit', limited.rateLimited === true)
    ok('429 is not an auth error', limited.authError === false)

    const quota = providers.classifyOpenAI(429, {
        error: { message: 'You exceeded your current quota', code: 'insufficient_quota' }
    }, '')
    ok('being out of credit is an auth failure, not a retryable rate limit',
        quota.authError === true && quota.rateLimited === false)

    const tooLong = providers.classifyOpenAI(400, {
        error: { message: "This model's maximum context length is 128000 tokens", code: 'context_length_exceeded' }
    }, '')
    ok('context overflow is promptTooLong', tooLong.promptTooLong === true)
    ok('context overflow is not an auth error', tooLong.authError === false)

    const down = providers.classifyOpenAI(503, {}, 'upstream')
    ok('503 is a server error', down.serverError === true)
    ok('503 is not an auth error', down.authError === false)

    eq('a transport failure reports NETWORK', providers.classifyOpenAI(0, null, 'network error').code, 'NETWORK')

    section('ai/providers -- the existing pool is untouched')

    for (const id of ['chat', 'gpt-5', 'claude-opus-4.6', 'gemini-3.1-pro', 'deepseek-v3.2-thinking']) {
        ok(`${id} is still registered`, Boolean(providers.getProvider(id)))
    }
    ok('the pool providers still use the shared gateway',
        providers.getProvider('gpt-5').buildRequest('x', { baseUrl: 'https://www.mzazi.shop', apiKey: 'k' })
            .url.startsWith('https://www.mzazi.shop'),
        'a pool provider must not inherit the OpenAI base URL')
}
