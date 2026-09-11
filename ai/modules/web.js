'use strict'

/*
 * DARKNOTE AI — web research module.
 *
 * VERIFIED STATUS: NOT AVAILABLE through a chat provider. None of the five
 * providers exposes a tool/function channel, so none of them can browse. The
 * model will confidently invent current facts, which is worse than refusing.
 *
 * A SEPARATE platform endpoint was verified to work during testing:
 *   GET /api/search/google?q=<query>&apikey=<key>   -> real search results
 * Wiring that in is a deliberate next step, not part of this build. When it is
 * added, this module will collect results and pass them to a chat provider for
 * summarisation only - never ask a chat model to "search".
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'web',
    label: 'Web research',
    toggle: 'web',
    capability: 'webSearch',
    providerRequirement: 'a verified search endpoint, or a provider with tool calling',
    howToEnable: 'Wire /api/search/google (verified working) into this module, then pass its results to a chat provider for the answer.'
})
