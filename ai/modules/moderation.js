'use strict'

/*
 * DARKNOTE AI — moderation assistant module.
 *
 * VERIFIED STATUS: IMPLEMENTABLE TODAY, NOT WIRED IN - AND DELIBERATELY NOT
 * AUTO-ENABLED. Detecting spam, harassment, dangerous content and unwanted links
 * is ordinary text classification the existing providers can attempt.
 *
 * Two reasons it stays off:
 *   1. A POLICY DECISION is required: what gets deleted, who gets warned, who
 *      gets muted, and what is appealed. Silently moderating a live group would
 *      change existing behaviour, which the brief forbids.
 *   2. Accuracy is not free. A false positive on "harassment" can remove a
 *      legitimate message. It needs thresholds the owner sets knowingly.
 *
 * The existing antilink and anticall features are UNTOUCHED and keep working.
 */

const { defineModule } = require('./_shared')

module.exports = defineModule({
    id: 'moderation',
    label: 'Moderation',
    toggle: 'moderation',
    capability: 'textChat',
    providerRequirement: 'none beyond text classification - policy and thresholds needed first',
    howToEnable: 'Decide the action per category (warn / delete / mute) and set thresholds before enabling.'
})
