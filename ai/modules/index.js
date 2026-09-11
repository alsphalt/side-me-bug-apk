'use strict'

/*
 * DARKNOTE AI — FUTURE MODULE REGISTRY.
 *
 * Ten modules are declared here and every one of them is INERT:
 *
 *   assistant     NOT AVAILABLE  no provider has tool/function calling
 *   moderation    IMPLEMENTABLE  needs a policy decision before it may act
 *   rewrite       IMPLEMENTABLE  needs a trigger design decision
 *   translate     PARTIAL        /api/tools/translate verified working, not wired
 *   files         NOT AVAILABLE  no provider accepts a file, and the gateway cap blocks it
 *   web           PARTIAL        /api/search/google verified working, not wired
 *   vision        NOT AVAILABLE  the model cannot see images (measured)
 *   image         PARTIAL        /api/fluxv2 verified working, not wired
 *   sticker       LOCAL ONLY     needs sharp, not an AI provider
 *   imagesearch   NOT WIRED      needs a permitted image API with attribution
 *
 * Nothing here fakes a capability. `available()` is the single gate, and it
 * requires BOTH the toggle to be on AND a provider to have been verified for the
 * capability with a recorded verification date. A module therefore switches
 * itself on automatically the moment a suitable provider is registered - no code
 * change required.
 *
 * THESE ARE HANDLERS, NOT CONVERSATIONAL PATHS. They must never be reached from
 * the chatbot's automatic reply path; they answer only when explicitly asked.
 */

const registry = require('../providers')
const config = require('../config')

const modules = [
    require('./assistant'),
    require('./moderation'),
    require('./rewrite'),
    require('./translate'),
    require('./files'),
    require('./web'),
    require('./vision'),
    require('./image'),
    require('./sticker'),
    require('./imagesearch')
]

const byId = new Map(modules.map(m => [m.id, m]))

function get(id) {
    return byId.get(String(id || '').toLowerCase()) || null
}

function list() {
    return modules.slice()
}

/** Full status, used by the .aistatus panel. */
function statusLines(settings = config.getAiSettings()) {
    return modules.map(m => m.statusLine(settings, registry))
}

function summary(settings = config.getAiSettings()) {
    const rows = modules.map(m => m.available(settings, registry))
    return {
        total: rows.length,
        enabled: rows.filter(r => r.enabled).length,
        available: rows.filter(r => r.available).length,
        implemented: rows.filter(r => r.implemented).length,
        // Switched on but unusable, which is the state a user must be warned about.
        blocked: rows.filter(r => r.enabled && !r.available).length
    }
}

/**
 * Attempt to use a module. Always answers honestly: either the module is really
 * available, or the caller gets a refusal that says exactly why.
 */
function run(id, settings = config.getAiSettings()) {
    const module = get(id)
    if (!module) return { ok: false, code: 'UNKNOWN_MODULE', message: `No such AI module: ${id}` }
    const state = module.available(settings, registry)
    if (!state.available) return module.refusal(settings, registry)
    return { ok: true, code: 'AVAILABLE', module: module.id, message: `The ${module.label} module is available.` }
}

module.exports = { get, list, statusLines, summary, run, modules }
