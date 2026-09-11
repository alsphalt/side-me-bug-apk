'use strict'

/*
 * Routing behaviour the ChatGPT switch depends on.
 *
 * rank() is not exported, so provider *selection* is observed through
 * ask() with a stubbed transport. That is more honest than re-implementing the
 * ranking here: the assertions describe which provider the router would really
 * call, and every case is decided before any network access.
 */

const transportPath = require.resolve('../ai/transport')
const routerPath = require.resolve('../ai/router')

const realTransport = require(transportPath)

/** Install a fake transport and return a router that uses it. */
function makeRouter(requestFn) {
    require.cache[transportPath].exports = { request: requestFn }
    delete require.cache[routerPath]
    return require(routerPath)
}

function poolAnswer() {
    return { status: 200, json: { status: true, result: { answer: 'pool answer' } }, ms: 5 }
}

function openAiAnswer(text = 'openai answer') {
    return { status: 200, json: { choices: [{ message: { content: text } }] }, ms: 5 }
}

module.exports = async function routerSuite({ section, ok }) {
    const settings = {
        provider: 'openai',
        baseUrl: 'https://www.mzazi.shop',
        apiKey: 'mzazi-pool-key',
        maxFallbacks: 2,
        maxAttempts: 3,
        timeoutMs: 5000,
        disabledProviders: [],
        providers: {}
    }

    try {
        section('ai/router -- the configured provider is honoured')

        {
            const calls = []
            const router = makeRouter(async request => {
                calls.push(request)
                return /api\.openai\.com/.test(request.url) ? openAiAnswer() : poolAnswer()
            })

            process.env.OPENAI_API_KEY = 'sk-test-key'
            const result = await router.ask('hello there', settings, {})

            ok('provider=openai is actually used', result.ok && result.provider === 'openai', JSON.stringify(result))
            ok('the request went to the OpenAI chat endpoint',
                /^https:\/\/api\.openai\.com\/v1\/chat\/completions$/.test(calls[0]?.url || ''), calls[0]?.url)
            ok('it carried the OpenAI key, not the pool key',
                calls[0]?.headers?.authorization === 'Bearer sk-test-key', calls[0]?.headers?.authorization)
            ok('it posted a chat-completions body',
                calls[0]?.body?.messages?.[0]?.content === 'hello there', JSON.stringify(calls[0]?.body))
        }

        section('ai/router -- the configured model is the one that answers')

        {
            /*
             * This mirrors the owner's real configuration: config.json sets
             * ai.provider to 'gpt-5.3-chat'. Pool providers authenticate with the
             * shared MZAZI_API_KEY in the query string, so the request must carry
             * that key and no Bearer header.
             */
            const calls = []
            const router = makeRouter(async request => {
                calls.push(request)
                return /gpt-5\.3-chat/.test(request.url)
                    ? { status: 200, json: { status: true, creator: 'MZAZI TECH', result: { answer: 'OK' } }, ms: 700 }
                    : poolAnswer()
            })

            const result = await router.ask('hello there', { ...settings, provider: 'gpt-5.3-chat' }, {})

            ok('gpt-5.3-chat answers', result.ok === true && result.provider === 'gpt-5.3-chat', JSON.stringify(result))
            ok('the request went to the mzazi gpt-5.3-chat endpoint',
                /^https:\/\/www\.mzazi\.shop\/api\/ai\/gpt-5\.3-chat\?/.test(calls[0]?.url || ''), calls[0]?.url)
            ok('the shared key travelled in the query string',
                String(calls[0]?.url || '').includes('apikey=mzazi-pool-key'), String(calls[0]?.url))
            ok('no Authorization header was sent (this family uses ?apikey=)',
                !calls[0]?.headers?.authorization)
        }

        section('ai/router -- the configured provider really is forced')

        {
            /*
             * Asserting this with OpenAI would prove nothing: OpenAI sits at the
             * top of every priority table, so it wins an ordinary ranking anyway.
             * `blackbox` sits at the BOTTOM of every table (casual 5, and it is
             * unverified so it also loses the readiness bonus), so it can only be
             * selected first if settings.provider is genuinely being honoured.
             * That is the bug this covers - the key was read nowhere at all.
             */
            const router = makeRouter(async request => (
                /api\.openai\.com/.test(request.url) ? openAiAnswer() : poolAnswer()
            ))

            process.env.OPENAI_API_KEY = 'sk-test-key'
            const forcedLow = await router.ask('hello there', { ...settings, provider: 'blackbox' }, {})
            ok('a configured bottom-priority provider is chosen',
                forcedLow.provider === 'blackbox', String(forcedLow.provider))

            // With the default, the ranking runs free and OpenAI leads on priority.
            const pooled = await router.ask('hello there', { ...settings, provider: 'router' }, {})
            ok('provider=router still answers', pooled.ok === true, JSON.stringify(pooled))
            ok('provider=router applies no forcing (OpenAI leads on priority alone)',
                pooled.provider === 'openai', String(pooled.provider))

            // An unknown or empty value must not break routing.
            const unknown = await router.ask('hello there', { ...settings, provider: 'not-a-provider' }, {})
            ok('an unrecognised provider name falls back to the normal ranking',
                unknown.ok === true, JSON.stringify(unknown))
        }

        section('ai/router -- a rejected OpenAI key must not kill the pool')

        {
            /*
             * The two credentials are unrelated, so an OpenAI 401 says nothing
             * about the mzazi providers. Before this fix the router aborted the
             * whole chain on INVALID_API_KEY, assuming one shared credential.
             */
            const calls = []
            const router = makeRouter(async request => {
                calls.push(request)
                if (/api\.openai\.com/.test(request.url)) {
                    return {
                        status: 401,
                        json: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } },
                        ms: 5
                    }
                }
                return poolAnswer()
            })

            process.env.OPENAI_API_KEY = 'sk-bad-key'
            const result = await router.ask('hello there', settings, {})

            ok('the request falls through to the pool', result.ok === true, JSON.stringify(result))
            ok('a pool provider served the answer', result.provider !== 'openai', String(result.provider))
            ok('more than one provider was tried', (result.attempts || 0) > 1, String(result.attempts))
            ok('it was not reported as a fatal credential error',
                result.code !== 'INVALID_API_KEY', String(result.code))
            ok('the OpenAI endpoint really was tried first',
                /api\.openai\.com/.test(calls[0]?.url || ''), calls[0]?.url)
        }

        section('ai/router -- an unhealthy forced provider is not fatal')

        {
            const router = makeRouter(async request => (
                /api\.openai\.com/.test(request.url) ? { status: 500, json: {}, ms: 5 } : poolAnswer()
            ))

            process.env.OPENAI_API_KEY = 'sk-test-key'
            const result = await router.ask('hello there', settings, {})

            ok('forcing a failing provider still yields an answer',
                result.ok === true, JSON.stringify(result))
            ok('the pool served it', result.provider !== 'openai', String(result.provider))
        }

        section('ai/router -- no OpenAI key means it is skipped, not attempted')

        {
            const calls = []
            const router = makeRouter(async request => {
                calls.push(request)
                return /api\.openai\.com/.test(request.url) ? openAiAnswer() : poolAnswer()
            })

            delete process.env.OPENAI_API_KEY
            const result = await router.ask('hello there', settings, {})

            ok('it answers from the pool', result.ok === true, JSON.stringify(result))
            ok('no request was ever sent to OpenAI',
                !calls.some(call => /api\.openai\.com/.test(call.url)),
                'a provider that requires its own key must be skipped when the key is absent')
        }
    } finally {
        // Leave the module cache exactly as it was found.
        require.cache[transportPath].exports = realTransport
        delete require.cache[routerPath]
        delete process.env.OPENAI_API_KEY
    }
}
