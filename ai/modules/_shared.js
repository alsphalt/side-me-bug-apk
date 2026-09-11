'use strict'

/*
 * DARKNOTE AI — shared base for the future AI modules.
 *
 * Every future module is declared, registered and INERT until two conditions
 * are both true:
 *   1. its toggle is switched on in config.json -> ai.modules
 *   2. a provider that has ACTUALLY BEEN VERIFIED for the required capability
 *      is registered in ai/providers.js
 *
 * Until then a module refuses honestly instead of pretending. This is the
 * mechanism that stops the bot claiming it can read a PDF it cannot read.
 */

/**
 * Build a module descriptor.
 * `capability` must name a real key from a provider's capabilities block.
 */
function defineModule({ id, label, toggle, capability, providerRequirement, howToEnable }) {
    return {
        id,
        label,
        toggle,
        capability,
        providerRequirement,

        /** Is the module switched on? Settings only, no capability check. */
        enabled(settings) {
            return settings?.modules?.[toggle] === true
        },

        /**
         * Is a provider registered that has genuinely been verified for this
         * capability? Read live from the registry so adding a provider with a
         * verified capability enables the module with no code change.
         */
        hasVerifiedProvider(registry) {
            if (!capability) return false
            return registry.listProviders().some(p => {
                if (!p.capabilities || p.capabilities[capability] !== true) return false
                return p.measured?.verifiedOn ? true : false
            })
        },

        /*
         * Is the module actually BUILT? A module that would only need ordinary
         * text chat (rewrite, moderation) has a verified capability the moment
         * the providers are registered, but its behaviour is not written yet.
         * Without this flag those modules reported themselves "available" and
         * a user asking for one would have been told it worked. Nothing may
         * report available until it is genuinely implemented.
         */
        implemented: false,

        /** Full availability test: built AND switched on AND capability verified. */
        available(settings, registry) {
            const on = this.enabled(settings)
            const capable = this.hasVerifiedProvider(registry)
            const built = this.implemented === true
            return {
                available: built && on && capable,
                enabled: on,
                capabilityVerified: capable,
                implemented: built,
                reason: !built
                    ? `${this.label} is not implemented yet`
                    : !on
                        ? `the ${this.label} module is switched off`
                        : !capable
                            ? `no provider has been verified for ${capability}`
                            : 'ready'
            }
        },

        /** One status line for the .aistatus panel. */
        statusLine(settings, registry) {
            const state = this.available(settings, registry)
            const mark = state.available ? '✅' : (state.enabled ? '⚠️' : '⛔')
            return `${mark} ${this.label}: ${state.available ? 'ON' : 'OFF'} — ${state.reason}`
        },

        /** Refusal used when a user actually asks for the feature. */
        refusal(settings, registry) {
            const state = this.available(settings, registry)
            return {
                ok: false,
                code: state.enabled ? 'NO_VERIFIED_PROVIDER' : 'MODULE_DISABLED',
                message: state.enabled
                    ? `I cannot do that yet: no AI provider I can reach has been verified for ${capability}.`
                    : `That feature is available but switched off. Ask the owner to run .${toggle} on.`,
                howToEnable,
                capability
            }
        }
    }
}

module.exports = { defineModule }
