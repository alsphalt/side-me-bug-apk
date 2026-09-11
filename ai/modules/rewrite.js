'use strict'

/*
 * DARKNOTE AI — message rewriting module.
 *
 * VERIFIED STATUS: IMPLEMENTABLE TODAY, NOT WIRED IN.
 * This one needs NO new capability: rewriting a selected message into a
 * different tone (professional / friendly / short / funny / romantic / formal /
 * casual) is ordinary text-to-text work that the existing chat providers can do.
 *
 * It is left off because it needs a TRIGGER DESIGN decision, not a provider:
 * a command, a reply-reaction, or a quoted-message convention. Guessing that
 * would change existing command behaviour, which the brief forbids.
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'rewrite',
    label: 'Message rewriting',
    toggle: 'rewrite',
    capability: 'textChat',
    providerRequirement: 'none beyond ordinary text chat - decision needed on how it is triggered',
    howToEnable: 'Choose the trigger (suggested: .airewrite <tone> as a reply), then call the router with a tone instruction.'
})
